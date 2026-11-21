// Campaign engine tests: sequential sending, error handling, pause/resume,
// persistence across a simulated service-worker restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignRunner, computeStats, createEmptyCampaign } from '../campaign-manager.js';
import { buildContacts } from '../contacts.js';
import { parseCSV } from '../csv-parser.js';
import { STATUS, CAMPAIGN_STATE, ERR } from '../constants.js';

const tick = () => new Promise((r) => setImmediate(r));

function makeClock() {
  const clock = { t: 1_700_000_000_000 };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.t += ms;
    await tick();
  };
  return clock;
}

/** In-memory store that deep-clones (like chrome.storage serialization). */
function makeStore(initial = null) {
  let data = initial ? structuredClone(initial) : null;
  return {
    getCampaign: async () => (data ? structuredClone(data) : null),
    saveCampaign: async (c) => {
      data = structuredClone(c);
    },
    peek: () => data,
  };
}

/**
 * Fake WhatsApp driver. `behavior[phone]` may be an error object to return;
 * `onSent(phone)` lets tests act mid-campaign.
 */
function makeDriver(behavior = {}, onSent = () => {}) {
  const d = { sent: [], active: 0, maxActive: 0 };
  d.sendMessage = async ({ phone, message, settings, shouldContinue, wait }) => {
    d.active++;
    d.maxActive = Math.max(d.maxActive, d.active);
    try {
      await tick();
      if (!shouldContinue()) return { aborted: true };
      if (behavior[phone]) return behavior[phone];
      if (!(await wait(settings.delayBeforeSend))) return { aborted: true };
      d.sent.push({ phone, message });
      await onSent(phone);
      return { ok: true, verified: true };
    } finally {
      d.active--;
    }
  };
  return d;
}

function campaignWith(csv, template = 'Hi {Name} from {City}') {
  const { headers, records } = parseCSV(csv);
  const c = createEmptyCampaign();
  c.contacts = buildContacts(records, { nameColumn: 'Name', phoneColumn: 'Phone' });
  c.source.headers = headers;
  c.template = template;
  c.settings = { ...c.settings, delayBetween: 5, delayBeforeOpen: 1, delayBeforeSend: 1, maxPerSession: 100 };
  return c;
}

const CSV = 'Name,Phone,City\nRahul,919876543210,Hyderabad\nPriya,918765432109,Bangalore\nDavid,917654321098,Chennai\nMeera,916543210987,Pune\n';

async function runnerFor(campaign, driver, clock = makeClock(), store = makeStore(campaign)) {
  const runner = new CampaignRunner({ store, driver, sleep: clock.sleep, now: clock.now });
  await runner.init();
  return { runner, store, clock };
}

test('sends to every contact sequentially with personalized messages', async () => {
  const driver = makeDriver();
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  await runner.start();
  await runner.whenIdle();

  assert.equal(driver.maxActive, 1, 'never more than one send at a time');
  assert.deepEqual(driver.sent.map((s) => s.message), [
    'Hi Rahul from Hyderabad', 'Hi Priya from Bangalore', 'Hi David from Chennai', 'Hi Meera from Pune',
  ]);
  const saved = store.peek();
  assert.equal(saved.status, CAMPAIGN_STATE.COMPLETED);
  assert.ok(saved.contacts.every((c) => c.status === STATUS.SENT && c.timestamp));
  assert.deepEqual(computeStats(saved), { total: 4, sent: 4, pending: 0, failed: 0, invalid: 0, skipped: 0, processed: 4, percent: 100 });
});

test('records per-contact errors and continues with the next contact', async () => {
  const driver = makeDriver({
    '918765432109': { ok: false, code: ERR.INVALID_NUMBER, error: 'Number not on WhatsApp' },
    '917654321098': { ok: false, code: ERR.CHAT_OPEN_FAILED, error: 'Popup' },
  });
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  await runner.start();
  await runner.whenIdle();
  const c = store.peek();
  assert.deepEqual(c.contacts.map((x) => x.status), [STATUS.SENT, STATUS.INVALID, STATUS.FAILED, STATUS.SENT]);
  assert.equal(c.contacts[1].error, 'Number not on WhatsApp');
  assert.equal(c.status, CAMPAIGN_STATE.COMPLETED);
  assert.ok(c.log.some((e) => e.status === STATUS.FAILED && e.error === 'Popup'));
});

test('numbers not on WhatsApp / missing in CSV get a note in a separate column', async () => {
  const { contactNote } = await import('../contacts.js');
  const { resultRows } = await import('../ui/export.js');
  const driver = makeDriver({ '918765432109': { ok: false, code: ERR.INVALID_NUMBER, error: 'Number not on WhatsApp or invalid (popup)' } });
  const campaign = campaignWith('Name,Phone,City\nRahul,919876543210,X\nPriya,918765432109,Y\nNoNumber,,Z\n');
  const { runner, store } = await runnerFor(campaign, driver);
  await runner.start();
  await runner.whenIdle();

  const [sent, notOnWa, missing] = store.peek().contacts;
  assert.equal(notOnWa.status, STATUS.INVALID);
  assert.equal(notOnWa.notOnWhatsApp, true);
  assert.equal(contactNote(notOnWa), 'Number not on WhatsApp');
  assert.equal(missing.status, STATUS.INVALID);
  assert.equal(contactNote(missing), 'Phone number missing in CSV');
  assert.equal(contactNote(sent), '');

  const rows = resultRows(store.peek());
  assert.deepEqual(rows.map((r) => r.Note), ['', 'Number not on WhatsApp', 'Phone number missing in CSV']);
  assert.equal(rows[1].Error, 'Number not on WhatsApp or invalid (popup)', 'technical error kept in its own column');
  assert.equal(store.peek().log.find((e) => e.name === 'Priya').note, 'Number not on WhatsApp');

  // Reset clears the note so a retry starts clean.
  await runner.reset();
  assert.equal(contactNote(store.peek().contacts[1]), '');
});

test('fatal errors pause the campaign and keep the contact pending; resume continues', async () => {
  const behavior = { '918765432109': { ok: false, code: ERR.NOT_LOGGED_IN, error: 'Not logged in' } };
  const driver = makeDriver(behavior);
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  await runner.start();
  await runner.whenIdle();
  let c = store.peek();
  assert.equal(c.status, CAMPAIGN_STATE.PAUSED);
  assert.equal(c.lastError, 'Not logged in');
  assert.equal(c.contacts[1].status, STATUS.PENDING);

  delete behavior['918765432109']; // user logs in again
  await runner.resume();
  await runner.whenIdle();
  c = store.peek();
  assert.equal(c.status, CAMPAIGN_STATE.COMPLETED);
  assert.equal(driver.sent.length, 4);
});

test('pause persists; a new runner (service worker restart) resumes without duplicates', async () => {
  const clock = makeClock();
  let runnerRef;
  const driver = makeDriver({}, async (phone) => {
    if (phone === '918765432109') await runnerRef.pause();
  });
  const store = makeStore(campaignWith(CSV));
  const first = new CampaignRunner({ store, driver, sleep: clock.sleep, now: clock.now });
  runnerRef = first;
  await first.init();
  await first.start();
  await first.whenIdle();

  const persisted = store.peek();
  assert.equal(persisted.status, CAMPAIGN_STATE.PAUSED);
  assert.deepEqual(persisted.contacts.map((x) => x.status), [STATUS.SENT, STATUS.SENT, STATUS.PENDING, STATUS.PENDING]);

  // Brand-new runner reading only from storage.
  const second = new CampaignRunner({ store, driver, sleep: clock.sleep, now: clock.now });
  await second.init();
  await second.recover({ browserRestarted: false });
  assert.equal(second.getState().status, CAMPAIGN_STATE.PAUSED);
  await second.resume();
  await second.whenIdle();

  assert.equal(store.peek().status, CAMPAIGN_STATE.COMPLETED);
  const phones = driver.sent.map((s) => s.phone);
  assert.equal(phones.length, 4);
  assert.equal(new Set(phones).size, 4, 'no contact messaged twice');
});

test('pausing during the pre-send delay marks the contact Paused and does not send it', async () => {
  const clock = makeClock();
  const driver = makeDriver();
  const campaign = campaignWith(CSV);
  campaign.settings.delayBeforeSend = 30;
  const { runner, store } = await runnerFor(campaign, driver, clock);
  await runner.start();
  // Let the first contact reach the 30s pre-send wait, then pause.
  while (clock.t < 1_700_000_000_000 + 5000) await tick();
  await runner.pause();
  await runner.whenIdle();
  const c = store.peek();
  assert.equal(driver.sent.length, 0);
  assert.equal(c.contacts[0].status, STATUS.PAUSED);
  assert.equal(c.status, CAMPAIGN_STATE.PAUSED);

  await runner.resume();
  await runner.whenIdle();
  assert.equal(driver.sent.length, 4);
  assert.equal(driver.sent[0].phone, '919876543210');
});

test('stop returns paused contacts to pending and Start continues', async () => {
  let runnerRef;
  const driver = makeDriver({}, async (phone) => {
    if (phone === '919876543210') await runnerRef.stop();
  });
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  runnerRef = runner;
  await runner.start();
  await runner.whenIdle();
  assert.equal(store.peek().status, CAMPAIGN_STATE.STOPPED);
  assert.equal(computeStats(store.peek()).pending, 3);
  await runner.start();
  await runner.whenIdle();
  assert.equal(store.peek().status, CAMPAIGN_STATE.COMPLETED);
  assert.equal(driver.sent.length, 4);
});

test('max contacts per session pauses the campaign', async () => {
  const driver = makeDriver();
  const campaign = campaignWith(CSV);
  campaign.settings.maxPerSession = 2;
  const { runner, store } = await runnerFor(campaign, driver);
  await runner.start();
  await runner.whenIdle();
  assert.equal(store.peek().status, CAMPAIGN_STATE.PAUSED);
  assert.equal(driver.sent.length, 2);
  assert.ok(store.peek().log.some((e) => /Session limit/.test(e.text)));
  await runner.resume();
  await runner.whenIdle();
  assert.equal(driver.sent.length, 4);
});

test('three consecutive infrastructure errors pause the campaign', async () => {
  const err = { ok: false, code: ERR.CHAT_OPEN_TIMEOUT, error: 'Chat did not open' };
  const driver = makeDriver({ '919876543210': err, '918765432109': err, '917654321098': err });
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  await runner.start();
  await runner.whenIdle();
  const c = store.peek();
  assert.equal(c.status, CAMPAIGN_STATE.PAUSED);
  assert.match(c.lastError, /3 messages in a row failed/);
  assert.equal(c.contacts[3].status, STATUS.PENDING);
});

test('skipped / invalid / excluded contacts are never sent', async () => {
  const driver = makeDriver();
  const campaign = campaignWith('Name,Phone,City\nA,919876543210,X\nB,123,Y\nDup,919876543210,Z\n,\nC,918765432109,W\n');
  const { runner, store } = await runnerFor(campaign, driver);
  await runner.setExcluded(['c5'], true);
  await runner.start();
  await runner.whenIdle();
  assert.deepEqual(driver.sent.map((s) => s.phone), ['919876543210']);
  assert.deepEqual(computeStats(store.peek()), { total: 5, sent: 1, pending: 0, failed: 0, invalid: 1, skipped: 3, processed: 5, percent: 100 });
});

test('retryFailed re-queues only failed contacts; reset clears everything', async () => {
  const behavior = { '918765432109': { ok: false, code: ERR.SEND_FAILED, error: 'x' } };
  const driver = makeDriver(behavior);
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  await runner.start();
  await runner.whenIdle();
  assert.equal(computeStats(store.peek()).failed, 1);

  delete behavior['918765432109'];
  const { count } = await runner.retryFailed();
  assert.equal(count, 1);
  await runner.start();
  await runner.whenIdle();
  assert.equal(computeStats(store.peek()).sent, 4);
  await assert.rejects(() => runner.retryFailed(), /no failed contacts/);

  await runner.reset();
  const c = store.peek();
  assert.equal(c.status, CAMPAIGN_STATE.IDLE);
  assert.ok(c.contacts.every((x) => x.status === STATUS.PENDING && !x.timestamp));
  assert.equal(c.log.length, 1);
});

test('test message does not change contact statuses or start the campaign', async () => {
  const driver = makeDriver();
  const { runner, store } = await runnerFor(campaignWith(CSV), driver);
  const r = await runner.sendTest({ contactId: 'c2', phone: '+44 7911 123456' });
  assert.equal(r.ok, true);
  assert.deepEqual(driver.sent, [{ phone: '447911123456', message: 'Hi Priya from Bangalore' }]);
  const c = store.peek();
  assert.equal(c.status, CAMPAIGN_STATE.IDLE);
  assert.ok(c.contacts.every((x) => x.status === STATUS.PENDING));
  assert.ok(c.log.at(-1).test);
  await assert.rejects(() => runner.sendTest({ contactId: 'c1', phone: '12' }), /invalid/i);
});

test('browser restart while running leaves the campaign paused; SW restart continues', async () => {
  const campaign = campaignWith(CSV);
  campaign.status = CAMPAIGN_STATE.RUNNING;
  campaign.contacts[0].status = STATUS.SENT;
  campaign.contacts[1].status = STATUS.PROCESSING;

  const d1 = makeDriver();
  const a = await runnerFor(structuredClone(campaign), d1);
  await a.runner.recover({ browserRestarted: true });
  assert.equal(a.store.peek().status, CAMPAIGN_STATE.PAUSED);
  assert.equal(a.store.peek().contacts[1].status, STATUS.PAUSED);
  assert.equal(d1.sent.length, 0);

  const d2 = makeDriver();
  const b = await runnerFor(structuredClone(campaign), d2);
  await b.runner.recover({ browserRestarted: false });
  await b.runner.whenIdle();
  assert.equal(b.store.peek().status, CAMPAIGN_STATE.COMPLETED);
  assert.deepEqual(d2.sent.map((s) => s.phone), ['918765432109', '917654321098', '916543210987']);
});

test('start validates contacts, message and pending work', async () => {
  const empty = await runnerFor(createEmptyCampaign(), makeDriver());
  await assert.rejects(() => empty.runner.start(), /Upload a CSV/);

  const noMsg = await runnerFor(campaignWith(CSV, '  '), makeDriver());
  await assert.rejects(() => noMsg.runner.start(), /Write a message/);

  const editing = await runnerFor(campaignWith(CSV), makeDriver());
  await editing.runner.updateSetup({ settings: { delayBetween: 1, maxPerSession: 99999 } });
  assert.equal(editing.runner.getState().settings.delayBetween, 10, 'clamped to minimum');
  assert.equal(editing.runner.getState().settings.maxPerSession, 1000, 'clamped to maximum');
});
