/**
 * Background-side driver for the WhatsApp Web tab.
 *
 * Opening a chat uses WhatsApp's public click-to-chat URL
 * (https://web.whatsapp.com/send?phone=...&text=...), which works for any
 * number, including ones that are not saved contacts. That navigation reloads the
 * page, so orchestration lives here and the content script only handles one
 * page at a time:
 *
 *   navigate -> wait for new page's content script -> WA_PREPARE (wait for
 *   chat + verify composer text) -> delay -> WA_SEND_NOW (click send + confirm)
 */
import { CS_MSG, ERR, WA_ORIGIN } from './constants.js';

const WA_URL_PATTERN = `${WA_ORIGIN}/*`;

function withTimeout(promise, ms, code = ERR.NO_RESPONSE) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error('Timed out waiting for the WhatsApp tab to respond.');
        e.code = code;
        reject(e);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const fail = (code, error) => ({ ok: false, code, error });

/** After this many consecutive fast-mode misses, use reload for the rest of the session. */
const FAST_MAX_MISSES = 2;

export function createWhatsAppDriver({ chromeApi = globalThis.chrome, sleep, isOnline } = {}) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const online = isOnline || (() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  let lastTabId = null;
  // Fast (no-reload) mode is switched off for this session after repeated misses.
  const fast = { misses: 0, disabled: false };

  async function tabExists(tabId) {
    try {
      return !!(await chromeApi.tabs.get(tabId));
    } catch {
      return false;
    }
  }

  async function findTab() {
    if (lastTabId != null) {
      try {
        const t = await chromeApi.tabs.get(lastTabId);
        const url = t?.url || t?.pendingUrl || '';
        if (url.startsWith(WA_ORIGIN)) return t;
      } catch {
        /* tab is gone */
      }
      lastTabId = null;
    }
    const tabs = await chromeApi.tabs.query({ url: WA_URL_PATTERN });
    if (!tabs.length) return null;
    const tab = tabs.find((t) => t.active) || tabs[0];
    lastTabId = tab.id;
    return tab;
  }

  async function ping(tabId, timeoutMs = 2500) {
    try {
      return await withTimeout(chromeApi.tabs.sendMessage(tabId, { type: CS_MSG.PING }), timeoutMs);
    } catch {
      return null;
    }
  }

  async function mapError(err, tabId) {
    if (!(await tabExists(tabId))) return fail(ERR.TAB_CLOSED, 'The WhatsApp Web tab was closed.');
    if (!online()) return fail(ERR.OFFLINE, 'Internet connection unavailable.');
    if (err?.code === ERR.NO_RESPONSE) return fail(ERR.NO_RESPONSE, err.message);
    return fail(ERR.NO_RESPONSE, `Lost contact with the WhatsApp tab (${err?.message || err}).`);
  }

  /** Reports whether WhatsApp Web is open, loaded and logged in. */
  async function getStatus() {
    if (!online()) return { state: 'offline', label: 'No internet connection' };
    const tab = await findTab();
    if (!tab) return { state: 'no_tab', label: 'WhatsApp Web is not open' };
    const p = await ping(tab.id);
    if (!p) return { state: 'no_script', tabId: tab.id, label: 'Reload the WhatsApp tab to connect the extension' };
    if (p.loginState === 'logged_in') return { state: 'ready', tabId: tab.id, label: 'Connected and logged in' };
    if (p.loginState === 'qr') return { state: 'not_logged_in', tabId: tab.id, label: 'Scan the QR code to log in' };
    return { state: 'loading', tabId: tab.id, label: 'WhatsApp Web is loading…' };
  }

  async function openWhatsApp() {
    const tab = await findTab();
    if (tab) {
      await chromeApi.tabs.update(tab.id, { active: true });
      if (tab.windowId != null && chromeApi.windows?.update) {
        await chromeApi.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      return { tabId: tab.id, created: false };
    }
    const created = await chromeApi.tabs.create({ url: `${WA_ORIGIN}/` });
    lastTabId = created.id;
    return { tabId: created.id, created: true };
  }

  async function reloadWhatsApp() {
    const tab = await findTab();
    if (!tab) throw new Error('WhatsApp Web is not open.');
    await chromeApi.tabs.reload(tab.id);
    return { tabId: tab.id };
  }

  /**
   * Opens the chat for `phone` and sends `message`.
   * @returns {Promise<{ok:boolean, code?:string, error?:string, aborted?:boolean, verified?:boolean|null, pendingDelivery?:boolean}>}
   */
  async function sendMessage({ phone, message, settings, shouldContinue, wait }) {
    const timeoutMs = (settings?.chatLoadTimeout ?? 45) * 1000;

    if (!online()) return fail(ERR.OFFLINE, 'Internet connection unavailable.');
    const tab = await findTab();
    if (!tab) return fail(ERR.NO_TAB, 'WhatsApp Web is not open. Open web.whatsapp.com and log in.');

    const before = await ping(tab.id);
    if (before?.loginState === 'qr') return fail(ERR.NOT_LOGGED_IN, 'WhatsApp Web is not logged in. Scan the QR code, then resume.');
    if (!shouldContinue()) return { aborted: true };

    // 1) Fast path: open the chat inside the loaded page (no reload).
    let prep = null;
    let method = 'reload';
    if (settings?.openMode !== 'reload' && !fast.disabled && before?.loginState === 'logged_in') {
      if (settings?.focusWhatsAppTab) await chromeApi.tabs.update(tab.id, { active: true }).catch(() => {});
      try {
        prep = await withTimeout(
          chromeApi.tabs.sendMessage(tab.id, { type: CS_MSG.OPEN_CHAT, phone, message, timeoutMs }),
          timeoutMs + 15000
        );
      } catch (err) {
        return mapError(err, tab.id);
      }
      if (prep?.code === 'FAST_UNSUPPORTED') {
        fast.misses++;
        if (fast.misses >= FAST_MAX_MISSES) fast.disabled = true;
        prep = null; // fall back to reload below
      } else {
        fast.misses = 0;
        method = 'fast';
      }
    }

    if (!prep) {
      prep = await openChatWithReload({ tab, before, phone, message, settings, timeoutMs });
      if (prep.aborted) return prep;
    }
    if (!prep?.ok) return fail(prep?.code || ERR.UNKNOWN, prep?.error || 'No response from the WhatsApp tab.');

    if (!shouldContinue()) return { aborted: true };
    if (!(await wait(settings?.delayBeforeSend ?? 0))) return { aborted: true };

    let sent;
    try {
      sent = await withTimeout(chromeApi.tabs.sendMessage(tab.id, { type: CS_MSG.SEND_NOW, message }), 45000);
    } catch (err) {
      return mapError(err, tab.id);
    }
    if (!sent?.ok) return fail(sent?.code || ERR.SEND_FAILED, sent?.error || 'Message could not be sent.');

    return { ok: true, method, verified: prep.verified, chatTitle: prep.chatTitle, pendingDelivery: !!sent.pendingDelivery };
  }

  /** Reload path: navigate to the click-to-chat URL and prepare the chat on the fresh page. */
  async function openChatWithReload({ tab, before, phone, message, settings, timeoutMs }) {
    const url = `${WA_ORIGIN}/send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}`;
    try {
      await chromeApi.tabs.update(tab.id, settings?.focusWhatsAppTab ? { url, active: true } : { url });
    } catch {
      return fail(ERR.TAB_CLOSED, 'The WhatsApp Web tab was closed.');
    }

    // Wait for the *new* page's content script (a fresh pageId) to answer.
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      await pause(700);
      if (!(await tabExists(tab.id))) return fail(ERR.TAB_CLOSED, 'The WhatsApp Web tab was closed.');
      const p = await ping(tab.id, 1500);
      if (p && (!before || p.pageId !== before.pageId)) {
        page = p;
        break;
      }
    }
    if (!page) {
      if (!online()) return fail(ERR.OFFLINE, 'Internet connection unavailable.');
      return fail(ERR.WA_LOAD_TIMEOUT, `WhatsApp Web did not load within ${timeoutMs / 1000}s.`);
    }

    try {
      const prep = await withTimeout(
        chromeApi.tabs.sendMessage(tab.id, { type: CS_MSG.PREPARE, phone, message, timeoutMs }),
        timeoutMs * 2 + 10000
      );
      return prep || fail(ERR.NO_RESPONSE, 'No response from the WhatsApp tab.');
    } catch (err) {
      return mapError(err, tab.id);
    }
  }

  return {
    getStatus,
    openWhatsApp,
    reloadWhatsApp,
    sendMessage,
    resetFastMode() {
      fast.misses = 0;
      fast.disabled = false;
    },
    forgetTab(tabId) {
      if (tabId === lastTabId) lastTabId = null;
    },
  };
}
