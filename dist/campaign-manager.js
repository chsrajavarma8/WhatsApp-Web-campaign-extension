/**
 * Campaign state model and the sequential sending engine.
 *
 * The runner is dependency-injected ({store, driver, sleep, now, heartbeat})
 * so it can be unit-tested without Chrome (see tests/run-tests.mjs).
 * It processes ONE contact at a time; there is never more than one chat
 * being opened or sent to concurrently.
 */
import {
  STATUS, CAMPAIGN_STATE, DEFAULT_SETTINGS, SETTING_BOUNDS, ERR, FATAL_ERRORS,
  INFRA_ERRORS, MAX_CONSECUTIVE_INFRA_ERRORS, MAX_LOG_ENTRIES, MIN_GAP_MS,
} from './constants.js';
import { initialStatus, normalizePhone, NOTE_TEXT } from './contacts.js';
import { personalize } from './message-template.js';

const { RUNNING, PAUSED, STOPPED, COMPLETED, IDLE } = CAMPAIGN_STATE;

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const truncate = (s, n = 160) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

/* ------------------------------------------------------------------ */
/* Pure helpers (shared with the UI)                                   */
/* ------------------------------------------------------------------ */

export function createEmptyCampaign() {
  return {
    id: uid(),
    name: 'Untitled campaign',
    status: IDLE,
    contacts: [],
    source: { fileName: '', headers: [], nameColumn: null, phoneColumn: null, defaultCountryCode: '', skipDuplicates: true },
    template: '',
    settings: { ...DEFAULT_SETTINGS },
    currentContactId: null,
    waitingUntil: null,
    // Pacing memory, persisted so a restarted worker keeps honouring the interval.
    pace: { lastStartedAt: 0, lastFinishedAt: 0, lastSent: false, skip: false },
    sessionSent: 0,
    lastError: '',
    startedAt: null,
    finishedAt: null,
    updatedAt: Date.now(),
    log: [],
  };
}

/** Fills in fields missing from older saved campaigns. */
export function normalizeCampaign(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyCampaign();
  const base = createEmptyCampaign();
  return {
    ...base,
    ...raw,
    source: { ...base.source, ...(raw.source || {}) },
    settings: sanitizeSettings({ ...base.settings, ...(raw.settings || {}) }),
    pace: { ...base.pace, ...(raw.pace || {}) },
    contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
    log: Array.isArray(raw.log) ? raw.log : [],
  };
}

export function sanitizeSettings(input = {}) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [key, [min, max]] of Object.entries(SETTING_BOUNDS)) {
    const n = Number(input[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULT_SETTINGS[key];
  }
  out.focusWhatsAppTab = input.focusWhatsAppTab === undefined ? DEFAULT_SETTINGS.focusWhatsAppTab : !!input.focusWhatsAppTab;
  out.openMode = input.openMode === 'reload' ? 'reload' : 'fast';
  return out;
}

/**
 * Earliest time (ms) the next contact may be opened, or 0 for "now".
 * The pace is measured start-to-start, so "1 message every 60s" really is one
 * per minute. Contacts that never reached a chat (invalid number, skipped,
 * interrupted) only need the short minimum gap.
 */
export function nextDueAt(campaign) {
  const p = campaign?.pace;
  if (!p?.lastFinishedAt || p.skip) return 0;
  const minGap = p.lastFinishedAt + MIN_GAP_MS;
  if (!p.lastSent) return minGap;
  return Math.max(p.lastStartedAt + (campaign.settings?.delayBetween ?? 0) * 1000, minGap);
}

/** Rough seconds one contact takes to open and send, excluding the pace wait. */
export function estimatedWorkSeconds(settings) {
  return (settings?.delayBeforeOpen ?? 0) + (settings?.delayBeforeSend ?? 0) + 8;
}

/**
 * Estimated completion time (ms) for the remaining eligible contacts, or null.
 * Ignores the per-session limit (the UI mentions it separately).
 */
export function estimateFinish(campaign, now = Date.now()) {
  const remaining = (campaign?.contacts ?? []).filter(isEligible).length;
  if (!remaining) return null;
  const work = estimatedWorkSeconds(campaign.settings) * 1000;
  const step = Math.max((campaign.settings?.delayBetween ?? 0) * 1000, work + MIN_GAP_MS);
  return Math.max(now, nextDueAt(campaign)) + (remaining - 1) * step + work;
}

/** Human-readable duration: 45s, 3m 05s, 1h 20m. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

/** "every 30 sec" / "every 15 min" / "every 1 h 30 min" for a pace in seconds. */
export function describePace(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s} sec`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} sec` : `${s / 60} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} hour${h > 1 ? 's' : ''}`;
}

export const isEligible = (contact) =>
  contact.status === STATUS.PENDING || contact.status === STATUS.PAUSED || contact.status === STATUS.PROCESSING;

export function computeStats(campaign) {
  const contacts = campaign?.contacts ?? [];
  const s = { total: contacts.length, sent: 0, pending: 0, failed: 0, invalid: 0, skipped: 0 };
  for (const c of contacts) {
    if (c.status === STATUS.SENT) s.sent++;
    else if (c.status === STATUS.FAILED) s.failed++;
    else if (c.status === STATUS.INVALID) s.invalid++;
    else if (c.status === STATUS.SKIPPED) s.skipped++;
    else s.pending++;
  }
  s.processed = s.total - s.pending;
  s.percent = s.total ? Math.round((s.processed / s.total) * 100) : 0;
  return s;
}

export function resetContactsProgress(contacts) {
  return contacts.map((c) => ({ ...c, status: initialStatus(c), error: '', note: '', notOnWhatsApp: false, message: '', timestamp: null, attempts: 0 }));
}

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

export class CampaignRunner {
  /**
   * @param {object} deps
   * @param {{getCampaign:Function, saveCampaign:Function}} deps.store
   * @param {{sendMessage:Function}} deps.driver  WhatsApp driver (see whatsapp-tab.js)
   * @param {(ms:number)=>Promise<void>} [deps.sleep]
   * @param {()=>number} [deps.now]
   * @param {()=>void} [deps.heartbeat] keeps the MV3 service worker alive during long waits
   * @param {(ts:number)=>void} [deps.onWaiting] called when a pacing wait starts (schedules a wake-up alarm)
   */
  constructor({ store, driver, sleep, now, heartbeat, onWaiting }) {
    this.store = store;
    this.driver = driver;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now || (() => Date.now());
    this.heartbeat = heartbeat || (() => {});
    this.onWaiting = onWaiting || (() => {});
    this.campaign = null;
    this._loopPromise = null;
    this._testInProgress = false;
    this._consecutiveInfraErrors = 0;
  }

  async init() {
    this.campaign = normalizeCampaign(await this.store.getCampaign());
    return this.campaign;
  }

  getState() {
    return this.campaign;
  }

  /** Returns a promise that settles when the current run loop exits (for tests). */
  whenIdle() {
    return this._loopPromise || Promise.resolve();
  }

  /**
   * Called once when the service worker boots.
   * @param {{browserRestarted:boolean}} opts
   */
  async recover({ browserRestarted }) {
    const c = this.campaign;
    let changed = false;
    for (const contact of c.contacts) {
      if (contact.status === STATUS.PROCESSING) {
        contact.status = c.status === RUNNING && !browserRestarted ? STATUS.PENDING : STATUS.PAUSED;
        changed = true;
      }
    }
    c.currentContactId = null;
    c.waitingUntil = null;
    if (c.status === RUNNING) {
      if (browserRestarted) {
        c.status = PAUSED;
        c.lastError = 'The browser or extension was restarted. Press Resume to continue the campaign.';
        this._log({ level: 'warn', text: c.lastError });
        await this._save();
        return;
      }
      this._log({ level: 'info', text: 'Background worker restarted; continuing the campaign.' });
      await this._save();
      this._kick();
      return;
    }
    if (changed) await this._save();
  }

  /* ------------------------- setup ------------------------------ */

  async loadContacts({ contacts, source, name }) {
    this._assertNotRunning('loading a new contact list');
    this._assertNoTest();
    const c = this.campaign;
    c.contacts = contacts;
    c.source = { ...c.source, ...(source || {}) };
    if (name) c.name = name;
    this._resetProgressFields();
    c.log = [];
    this._log({ level: 'info', text: `Loaded ${contacts.length} rows${c.source.fileName ? ` from ${c.source.fileName}` : ''}.` });
    await this._save();
    return c;
  }

  async updateSetup(patch = {}) {
    const c = this.campaign;
    if (patch.settings) c.settings = sanitizeSettings({ ...c.settings, ...patch.settings });
    if (patch.name !== undefined || patch.template !== undefined) {
      this._assertNotRunning('editing the campaign');
      if (patch.name !== undefined) c.name = String(patch.name).slice(0, 120) || 'Untitled campaign';
      if (patch.template !== undefined) c.template = String(patch.template);
    }
    await this._save();
    return c;
  }

  async setExcluded(ids, excluded) {
    const c = this.campaign;
    const editable = new Set([STATUS.PENDING, STATUS.SKIPPED, STATUS.PAUSED]);
    let changed = 0;
    for (const id of ids) {
      const contact = c.contacts.find((x) => x.id === id);
      if (!contact || contact.invalid || contact.isEmpty || !editable.has(contact.status)) continue;
      if (c.status === RUNNING && c.currentContactId === contact.id) continue;
      contact.excluded = !!excluded;
      contact.status = excluded ? STATUS.SKIPPED : STATUS.PENDING;
      changed++;
    }
    if (changed) await this._save();
    return { changed };
  }

  async loadDraft(draftCampaign) {
    this._assertNotRunning('loading a draft');
    this._assertNoTest();
    const loaded = normalizeCampaign(structuredClone(draftCampaign));
    loaded.status = loaded.status === RUNNING ? PAUSED : loaded.status;
    loaded.currentContactId = null;
    loaded.waitingUntil = null;
    for (const contact of loaded.contacts) if (contact.status === STATUS.PROCESSING) contact.status = STATUS.PAUSED;
    this.campaign = loaded;
    this._log({ level: 'info', text: `Draft "${loaded.name}" loaded.` });
    await this._save();
    return loaded;
  }

  async clearLog() {
    this.campaign.log = [];
    await this._save();
  }

  /* ------------------------- controls --------------------------- */

  async start() {
    const c = this.campaign;
    if (c.status === RUNNING) return c;
    this._assertNoTest();
    this._assertReadyToSend();
    c.status = RUNNING;
    c.sessionSent = 0;
    c.lastError = '';
    c.startedAt = c.startedAt || this.now();
    c.finishedAt = null;
    this._consecutiveInfraErrors = 0;
    this.driver.resetFastMode?.(); // give fast (no-reload) mode a fresh chance each run
    const remaining = c.contacts.filter(isEligible).length;
    this._log({ level: 'info', text: `Campaign started: ${remaining} contacts to message.` });
    await this._save();
    this._kick();
    return c;
  }

  async pause() {
    const c = this.campaign;
    if (c.status !== RUNNING) return c;
    c.status = PAUSED;
    c.waitingUntil = null;
    this._log({ level: 'info', text: 'Campaign paused.' });
    await this._save();
    return c;
  }

  async resume() {
    const c = this.campaign;
    if (c.status === RUNNING) return c;
    if (c.status !== PAUSED && c.status !== STOPPED) throw new Error('There is no paused campaign to resume.');
    this._assertNoTest();
    this._assertReadyToSend();
    c.status = RUNNING;
    c.sessionSent = 0;
    c.lastError = '';
    this._consecutiveInfraErrors = 0;
    this.driver.resetFastMode?.(); // give fast (no-reload) mode a fresh chance each run
    this._log({ level: 'info', text: 'Campaign resumed.' });
    await this._save();
    this._kick();
    return c;
  }

  /** Ends the current pacing wait so the next contact is opened right away. */
  async skipWait() {
    const c = this.campaign;
    if (c.status !== RUNNING || !c.waitingUntil) throw new Error('There is no wait to skip right now.');
    c.pace.skip = true;
    this._log({ level: 'info', text: 'Wait skipped: sending the next message now.' });
    await this._save();
    return c;
  }

  async stop() {
    const c = this.campaign;
    if (c.status !== RUNNING && c.status !== PAUSED) return c;
    c.status = STOPPED;
    c.waitingUntil = null;
    for (const contact of c.contacts) {
      if (contact.status === STATUS.PAUSED) contact.status = STATUS.PENDING;
    }
    this._log({ level: 'info', text: 'Campaign stopped. Unsent contacts remain Pending.' });
    await this._save();
    return c;
  }

  async reset() {
    this._assertNotRunning('resetting');
    this._assertNoTest();
    const c = this.campaign;
    c.contacts = resetContactsProgress(c.contacts);
    this._resetProgressFields();
    c.log = [];
    this._log({ level: 'info', text: 'Campaign reset. All statuses cleared.' });
    await this._save();
    return c;
  }

  async retryFailed() {
    this._assertNotRunning('retrying failed contacts');
    const c = this.campaign;
    let count = 0;
    for (const contact of c.contacts) {
      if (contact.status === STATUS.FAILED) {
        contact.status = STATUS.PENDING;
        contact.error = '';
        count++;
      }
    }
    if (!count) throw new Error('There are no failed contacts to retry.');
    if (c.status === COMPLETED) c.status = STOPPED;
    this._log({ level: 'info', text: `${count} failed contacts queued for retry. Press Start/Resume to send.` });
    await this._save();
    return { count };
  }

  /**
   * Sends one message without starting the campaign.
   * @param {{contactId:string, phone?:string, message?:string}} opts
   */
  async sendTest({ contactId, phone, message }) {
    const c = this.campaign;
    if (c.status === RUNNING) throw new Error('Pause the campaign before sending a test message.');
    this._assertNoTest();
    const contact = c.contacts.find((x) => x.id === contactId) || null;

    let targetPhone = contact?.phone || '';
    if (phone) {
      const p = normalizePhone(phone, c.source.defaultCountryCode);
      if (!p.valid) throw new Error(`Test number is invalid: ${p.message}`);
      targetPhone = p.phone;
    }
    if (!targetPhone) throw new Error('Choose a contact with a valid number, or enter a test number.');

    const text = (message ?? (contact ? personalize(c.template, contact).text : c.template)).trim();
    if (!text) throw new Error('The message is empty.');

    this._testInProgress = true;
    let result;
    try {
      result = await this.driver.sendMessage({
        phone: targetPhone,
        message: text,
        settings: c.settings,
        shouldContinue: () => true,
        wait: async (seconds) => {
          await this.sleep(seconds * 1000);
          return true;
        },
      });
    } catch (err) {
      result = { ok: false, code: ERR.UNKNOWN, error: err?.message || String(err) };
    } finally {
      this._testInProgress = false;
    }

    this._log({
      level: result.ok ? 'success' : 'error',
      test: true,
      contactId: contact?.id || null,
      name: contact?.name || '',
      phone: targetPhone,
      message: truncate(text),
      status: result.ok ? 'Test sent' : 'Test failed',
      error: result.ok ? '' : result.error || result.code,
      text: result.ok ? `Test message sent to ${targetPhone}.` : `Test message to ${targetPhone} failed: ${result.error || result.code}`,
    });
    await this._save();
    return { ...result, phone: targetPhone };
  }

  /* ------------------------- internals -------------------------- */

  _assertNotRunning(action) {
    if (this.campaign.status === RUNNING) throw new Error(`Pause or stop the campaign before ${action}.`);
  }

  _assertNoTest() {
    if (this._testInProgress) throw new Error('A test message is being sent. Please wait for it to finish.');
  }

  _assertReadyToSend() {
    const c = this.campaign;
    if (!c.contacts.length) throw new Error('Upload a CSV contact list first.');
    if (!c.template.trim()) throw new Error('Write a message before starting.');
    if (!c.contacts.some(isEligible)) {
      throw new Error('No pending contacts left. Use "Retry Failed" or "Reset Campaign" to send again.');
    }
  }

  _resetProgressFields() {
    const c = this.campaign;
    c.status = IDLE;
    c.sessionSent = 0;
    c.lastError = '';
    c.currentContactId = null;
    c.waitingUntil = null;
    c.pace = { lastStartedAt: 0, lastFinishedAt: 0, lastSent: false, skip: false };
    c.startedAt = null;
    c.finishedAt = null;
  }

  async _save() {
    this.campaign.updatedAt = this.now();
    await this.store.saveCampaign(this.campaign);
  }

  _log(entry) {
    const log = this.campaign.log;
    log.push({ id: uid(), ts: this.now(), level: 'info', ...entry });
    if (log.length > MAX_LOG_ENTRIES) log.splice(0, log.length - MAX_LOG_ENTRIES);
  }

  _kick() {
    if (this._loopPromise) return;
    this._loopPromise = this._loop()
      .catch(async (err) => {
        const c = this.campaign;
        c.status = PAUSED;
        c.lastError = `Unexpected error: ${err?.message || err}`;
        this._log({ level: 'error', text: c.lastError });
        await this._save().catch(() => {});
      })
      .finally(() => {
        this._loopPromise = null;
        // A Resume may have arrived just as the previous loop was exiting.
        if (this.campaign.status === RUNNING) this._kick();
      });
  }

  /** Waits `seconds`, returning false early if the campaign leaves RUNNING. */
  _wait(seconds) {
    const end = this.now() + Math.max(0, seconds) * 1000;
    return this._waitUntil(() => end);
  }

  /**
   * Waits until the time returned by `getEnd()` (re-read every tick, so pace
   * changes and "skip wait" apply immediately). Returns false if the campaign
   * leaves RUNNING.
   */
  async _waitUntil(getEnd) {
    let lastBeat = this.now();
    while (this.now() < getEnd()) {
      if (this.campaign.status !== RUNNING) return false;
      await this.sleep(Math.max(1, Math.min(500, getEnd() - this.now())));
      if (this.now() - lastBeat >= 15000) {
        this.heartbeat();
        lastBeat = this.now();
      }
    }
    return this.campaign.status === RUNNING;
  }

  async _loop() {
    const c = this.campaign;
    while (this.campaign === c && c.status === RUNNING) {
      const max = c.settings.maxPerSession;
      if (max > 0 && c.sessionSent >= max) {
        c.status = PAUSED;
        this._log({ level: 'warn', text: `Session limit of ${max} messages reached. Campaign paused; press Resume to continue.` });
        await this._save();
        break;
      }

      const contact = c.contacts.find(isEligible);
      if (!contact) {
        const s = computeStats(c);
        c.status = COMPLETED;
        c.finishedAt = this.now();
        c.currentContactId = null;
        this._log({
          level: 'success',
          text: `Campaign completed: ${s.sent} sent, ${s.failed} failed, ${s.invalid} invalid, ${s.skipped} skipped.`,
        });
        await this._save();
        break;
      }

      // Honour the pace before opening the next chat (also after a worker restart or Resume).
      if (nextDueAt(c) > this.now()) {
        c.waitingUntil = nextDueAt(c);
        await this._save();
        this.onWaiting(c.waitingUntil);
        const ok = await this._waitUntil(() => {
          const due = nextDueAt(c);
          if (due !== c.waitingUntil) {
            c.waitingUntil = due; // pace changed or wait skipped: show the new countdown
            this._save().catch(() => {});
          }
          return due;
        });
        c.waitingUntil = null;
        await this._save();
        if (!ok) break;
        continue; // re-check limits and pick the contact again (exclusions may have changed)
      }

      const startedAt = this.now();
      c.pace.skip = false;
      await this._processContact(contact);
      c.pace = {
        lastStartedAt: startedAt,
        lastFinishedAt: this.now(),
        // Anything that may have reached a chat counts toward the pace.
        lastSent: contact.status === STATUS.SENT || contact.status === STATUS.FAILED,
        skip: false,
      };
      await this._save();
      if (c.status !== RUNNING) break;
    }
  }

  async _processContact(contact) {
    const c = this.campaign;
    contact.status = STATUS.PROCESSING;
    contact.error = '';
    contact.note = '';
    contact.notOnWhatsApp = false;
    contact.attempts = (contact.attempts || 0) + 1;
    c.currentContactId = contact.id;
    const { text, missing, unknown } = personalize(c.template, contact);
    contact.message = text;
    await this._save();

    if (!text) return this._finish(contact, STATUS.FAILED, 'Message is empty after personalization.');
    if (!(await this._wait(c.settings.delayBeforeOpen))) return this._interrupted(contact);

    let result;
    try {
      result = await this.driver.sendMessage({
        phone: contact.phone,
        message: text,
        settings: c.settings,
        shouldContinue: () => this.campaign.status === RUNNING,
        wait: (seconds) => this._wait(seconds),
      });
    } catch (err) {
      result = { ok: false, code: ERR.UNKNOWN, error: err?.message || String(err) };
    }

    if (result?.aborted) return this._interrupted(contact);

    const notes = [];
    if (missing.length) notes.push(`Empty values: ${missing.join(', ')}`);
    if (unknown.length) notes.push(`Unknown placeholders: ${unknown.join(', ')}`);

    if (result?.ok) {
      this._consecutiveInfraErrors = 0;
      c.sessionSent++;
      contact.openedWith = result.method || '';
      if (result.verified === false) notes.push('Chat title did not match the number; please verify');
      if (result.pendingDelivery) notes.push('Queued in WhatsApp (clock icon) when recorded');
      return this._finish(contact, STATUS.SENT, '', notes.join('; '));
    }

    const code = result?.code || ERR.UNKNOWN;
    const error = result?.error || 'Unknown error';

    if (FATAL_ERRORS.includes(code)) {
      contact.status = STATUS.PENDING;
      contact.attempts = Math.max(0, contact.attempts - 1);
      c.status = PAUSED;
      c.currentContactId = null;
      c.lastError = error;
      this._log({ level: 'error', contactId: contact.id, name: contact.name, phone: contact.phone, status: 'Campaign paused', error, text: `Campaign paused: ${error}` });
      await this._save();
      return;
    }

    if (INFRA_ERRORS.includes(code)) this._consecutiveInfraErrors++;
    else this._consecutiveInfraErrors = 0;

    if (code === ERR.INVALID_NUMBER) {
      // WhatsApp rejected the number: record a clear note in its own column.
      contact.notOnWhatsApp = true;
      await this._finish(contact, STATUS.INVALID, error, [NOTE_TEXT.not_on_whatsapp, ...notes].join('; '));
    } else {
      await this._finish(contact, STATUS.FAILED, error, notes.join('; '));
    }

    if (this._consecutiveInfraErrors >= MAX_CONSECUTIVE_INFRA_ERRORS && c.status === RUNNING) {
      c.status = PAUSED;
      c.lastError = `${this._consecutiveInfraErrors} messages in a row failed (${error}). WhatsApp Web may be slow or its layout may have changed. Check the WhatsApp tab, then Resume.`;
      this._consecutiveInfraErrors = 0;
      this._log({ level: 'error', text: c.lastError });
      await this._save();
    }
  }

  async _interrupted(contact) {
    const c = this.campaign;
    contact.status = c.status === PAUSED ? STATUS.PAUSED : STATUS.PENDING;
    contact.attempts = Math.max(0, (contact.attempts || 1) - 1);
    c.currentContactId = null;
    this._log({ level: 'info', contactId: contact.id, name: contact.name, phone: contact.phone, text: `Stopped before sending to ${contact.name || contact.phone}.` });
    await this._save();
  }

  async _finish(contact, status, error, note = '') {
    const c = this.campaign;
    contact.status = status;
    contact.error = error || '';
    contact.note = note;
    contact.timestamp = this.now();
    c.currentContactId = null;
    this._log({
      level: status === STATUS.SENT ? 'success' : 'error',
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone,
      message: truncate(contact.message),
      status,
      error: contact.error,
      note,
      text: status === STATUS.SENT
        ? `Sent to ${contact.name || contact.phone}${contact.openedWith === 'fast' ? ' (opened without reload)' : contact.openedWith === 'reload' ? ' (opened with page reload)' : ''}.`
        : `${status}: ${contact.name || contact.phone}: ${contact.error}`,
    });
    await this._save();
  }
}
