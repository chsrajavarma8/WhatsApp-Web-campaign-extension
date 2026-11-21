/** Promise wrapper around messages to the background service worker. */
import { MSG } from '../constants.js';

export async function call(type, payload = {}) {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type, ...payload });
  } catch (err) {
    throw new Error(`Extension background is unavailable: ${err?.message || err}`);
  }
  if (!res) throw new Error('No response from the extension background.');
  if (!res.ok) throw new Error(res.error || 'Unknown error');
  return res;
}

export const api = {
  getState: () => call(MSG.GET_STATE).then((r) => r.campaign),
  loadContacts: (contacts, source, name) => call(MSG.LOAD_CONTACTS, { contacts, source, name }),
  updateSetup: (patch) => call(MSG.UPDATE_SETUP, { patch }),
  setExcluded: (ids, excluded) => call(MSG.SET_EXCLUDED, { ids, excluded }),
  start: () => call(MSG.START),
  pause: () => call(MSG.PAUSE),
  resume: () => call(MSG.RESUME),
  stop: () => call(MSG.STOP),
  skipWait: () => call(MSG.SKIP_WAIT),
  reset: () => call(MSG.RESET),
  retryFailed: () => call(MSG.RETRY_FAILED),
  sendTest: (opts) => call(MSG.SEND_TEST, opts).then((r) => r.result),
  checkWhatsApp: () => call(MSG.CHECK_WHATSAPP).then((r) => r.status),
  openWhatsApp: () => call(MSG.OPEN_WHATSAPP),
  reloadWhatsApp: () => call(MSG.RELOAD_WHATSAPP),
  loadDraft: (campaign) => call(MSG.LOAD_DRAFT, { campaign }),
  clearLog: () => call(MSG.CLEAR_LOG),
};
