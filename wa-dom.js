/**
 * Low-level WhatsApp Web DOM helpers used by content.js.
 * Uses only selectors from wa-selectors.js and normal user-level
 * interactions (focus, paste/insert text, click).
 */
(() => {
  const S = window.WA_SELECTORS;
  const HINTS = window.WA_TEXT_HINTS;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  /** First visible element matching any selector in the list. */
  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      let nodes;
      try {
        nodes = root.querySelectorAll(sel);
      } catch {
        continue; // invalid selector in this browser version
      }
      for (const n of nodes) if (isVisible(n)) return n;
    }
    return null;
  }

  function queryAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const nodes = [...root.querySelectorAll(sel)];
        if (nodes.length) return nodes;
      } catch {
        /* ignore */
      }
    }
    return [];
  }

  /** Polls `fn` until it returns a truthy value or the timeout elapses. */
  async function waitFor(fn, timeoutMs, intervalMs = 250) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        /* keep polling */
      }
      await sleep(intervalMs);
    }
    return null;
  }

  /** 'logged_in' | 'qr' | 'loading' */
  function getLoginState() {
    if (queryFirst(S.loggedIn)) return 'logged_in';
    if (queryFirst(S.qrCode)) return 'qr';
    return 'loading';
  }

  const getComposer = () => queryFirst(S.composer);

  /** Text content including emoji rendered as <img alt="…">. */
  function readText(el) {
    if (!el) return '';
    let out = '';
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
      else if (node.nodeName === 'IMG') out += node.getAttribute('alt') || '';
      else if (node.nodeName === 'BR') out += '\n';
      else {
        const block = node.nodeName === 'P' || node.nodeName === 'DIV';
        if (block && out && !out.endsWith('\n')) out += '\n';
        node.childNodes.forEach(walk);
      }
    };
    el.childNodes.forEach(walk);
    return out;
  }

  /** Loose comparison that ignores whitespace and emoji rendering differences. */
  function sameText(a, b) {
    const norm = (s) =>
      String(s || '')
        .normalize('NFC')
        .replace(/[\s️‍​]/g, '')
        .replace(/\p{Extended_Pictographic}/gu, '');
    return norm(a) === norm(b);
  }

  function clearComposer(el) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }

  /** Inserts text the way a paste would (keeps line breaks). */
  async function insertText(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(400);
    if (sameText(readText(el), text)) return true;

    // Fallback: execCommand insertText.
    clearComposer(el);
    document.execCommand('insertText', false, text);
    await sleep(400);
    return sameText(readText(el), text);
  }

  function getChatTitle() {
    const el = queryFirst(S.chatTitle);
    return el ? (el.getAttribute('title') || el.textContent || '').trim() : '';
  }

  /** Returns {el, text, hasButton, kind: 'invalid'|'loading'|'other'} for a visible popup. */
  function getPopup() {
    const el = queryFirst(S.popup);
    if (!el) return null;
    const text = (el.innerText || '').trim();
    const lower = text.toLowerCase();
    const hasButton = !!el.querySelector('button, [role="button"]');
    let kind = 'other';
    if (HINTS.invalidNumber.some((h) => lower.includes(h))) kind = 'invalid';
    else if (HINTS.loading.some((h) => lower.includes(h))) kind = 'loading';
    return { el, text, hasButton, kind };
  }

  function dismissPopup(popup) {
    const btn = popup?.el?.querySelector('button, [role="button"]');
    if (btn) btn.click();
  }

  function findSendButton() {
    const el = queryFirst(S.sendButton);
    if (!el) return null;
    return el.closest('button, [role="button"]') || el;
  }

  const countOutgoing = () => queryAll(S.outgoingMessage).length;

  function lastOutgoingIsPending() {
    const all = queryAll(S.outgoingMessage);
    const last = all[all.length - 1];
    return !!(last && queryFirst(S.pendingIcon, last));
  }

  function pressEnter(el) {
    el.focus();
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /** Escape closes the open chat in WhatsApp Web. */
  function pressEscape() {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  /**
   * Clicks a link inside the WhatsApp app so its own router can open the chat.
   * WhatsApp's handlers run before the event reaches window; if none of them
   * called preventDefault, the link wasn't handled, so we cancel it (no
   * navigation away) and return false so the caller can fall back to reload.
   */
  function clickInAppLink(href) {
    const host = queryFirst(S.linkHost) || document.body;
    const a = document.createElement('a');
    a.href = href;
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    a.textContent = href;
    let handled = false;
    const check = (e) => {
      if (e.target !== a) return;
      handled = e.defaultPrevented;
      if (!handled) e.preventDefault();
    };
    window.addEventListener('click', check);
    try {
      host.appendChild(a);
      a.click();
    } finally {
      window.removeEventListener('click', check);
      a.remove();
    }
    return handled;
  }

  window.WADom = Object.freeze({
    pressEscape,
    clickInAppLink,
    sleep,
    isVisible,
    queryFirst,
    waitFor,
    getLoginState,
    getComposer,
    readText,
    sameText,
    clearComposer,
    insertText,
    getChatTitle,
    getPopup,
    dismissPopup,
    findSendButton,
    countOutgoing,
    lastOutgoingIsPending,
    pressEnter,
  });
})();
