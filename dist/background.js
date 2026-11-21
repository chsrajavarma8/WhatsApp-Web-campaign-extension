/**
 * Background service worker: the single owner of campaign state.
 * Popup and dashboard send commands here; they observe progress through
 * chrome.storage.onChanged (key "campaign").
 */
import { CampaignRunner } from './campaign-manager.js';
import { createWhatsAppDriver } from './whatsapp-tab.js';
import { store } from './storage.js';
import { MSG, DEFAULT_TEMPLATES } from './constants.js';

const WAKE_ALARM = 'campaign-wake';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driver = createWhatsAppDriver({ sleep });
const runner = new CampaignRunner({
  store,
  driver,
  sleep,
  // Any extension API call resets the MV3 idle timer during long waits.
  heartbeat: () => chrome.runtime.getPlatformInfo().catch(() => {}),
  // Backup for long pacing waits (e.g. 30 min): if Chrome ever stops the worker,
  // this alarm wakes it at the due time and recover() continues the campaign.
  onWaiting: (when) => chrome.alarms.create(WAKE_ALARM, { when: Math.max(when, Date.now() + 30000) }),
});

// chrome.storage.session is cleared when the browser (or extension) restarts,
// which tells a cold start apart from a mere service-worker wake-up.
const ready = (async () => {
  await runner.init();
  const { runnerSession } = await chrome.storage.session.get('runnerSession');
  await runner.recover({ browserRestarted: !runnerSession });
  await chrome.storage.session.set({ runnerSession: true });
})();

chrome.runtime.onInstalled.addListener(() => {
  store.seedTemplates(DEFAULT_TEMPLATES).catch((e) => console.error('Template seeding failed', e));
});

// Waking the worker is all the alarm needs to do: the `ready` boot sequence resumes the loop.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WAKE_ALARM) ready.catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => driver.forgetTab(tabId));

const handlers = {
  [MSG.GET_STATE]: () => ({ campaign: runner.getState() }),
  [MSG.LOAD_CONTACTS]: (m) => runner.loadContacts(m).then((campaign) => ({ campaign })),
  [MSG.UPDATE_SETUP]: (m) => runner.updateSetup(m.patch).then((campaign) => ({ campaign })),
  [MSG.SET_EXCLUDED]: (m) => runner.setExcluded(m.ids || [], m.excluded),
  [MSG.START]: () => runner.start().then(() => ({})),
  [MSG.PAUSE]: () => runner.pause().then(() => ({})),
  [MSG.RESUME]: () => runner.resume().then(() => ({})),
  [MSG.STOP]: () => runner.stop().then(() => ({})),
  [MSG.SKIP_WAIT]: () => runner.skipWait().then(() => ({})),
  [MSG.RESET]: () => runner.reset().then(() => ({})),
  [MSG.RETRY_FAILED]: () => runner.retryFailed(),
  [MSG.SEND_TEST]: (m) => runner.sendTest(m).then((result) => ({ result })),
  [MSG.CHECK_WHATSAPP]: () => driver.getStatus().then((status) => ({ status })),
  [MSG.OPEN_WHATSAPP]: () => driver.openWhatsApp(),
  [MSG.RELOAD_WHATSAPP]: () => driver.reloadWhatsApp(),
  [MSG.LOAD_DRAFT]: (m) => runner.loadDraft(m.campaign).then((campaign) => ({ campaign })),
  [MSG.CLEAR_LOG]: () => runner.clearLog().then(() => ({})),
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept commands from this extension's own pages (not content scripts).
  if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith('https://')) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  ready
    .then(() => handler(message))
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // async response
});
