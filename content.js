/**
 * Content script for https://web.whatsapp.com/*
 *
 * Responds to three commands from the background worker:
 *   WA_PING      -> {pageId, loginState, online}
 *   WA_PREPARE   -> wait for the chat opened via /send?phone=…, verify the
 *                   recipient where possible, ensure the composer holds the text
 *   WA_SEND_NOW  -> click Send and confirm the message left the composer
 *
 * It never reads chats, contacts or messages beyond what is needed to
 * confirm the send, and it sends nothing anywhere except back to the
 * extension's own background worker.
 */
(() => {
  if (window.__waCampaignSenderLoaded) return;
  window.__waCampaignSenderLoaded = true;

  const D = window.WADom;
  const PAGE_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const fail = (code, error) => ({ ok: false, code, error });

  function verifyRecipient(phone) {
    const title = D.getChatTitle();
    const digits = title.replace(/\D/g, '');
    // Unsaved numbers show the number as the title; saved contacts show a name.
    if (digits.length >= 7) return { verified: phone.endsWith(digits.slice(-7)), chatTitle: title };
    return { verified: null, chatTitle: title };
  }

  /** Returns a failure object, or null when WhatsApp is loaded and logged in. */
  async function waitForLogin(timeoutMs) {
    const loginState = await D.waitFor(() => {
      const s = D.getLoginState();
      return s === 'loading' ? null : s;
    }, timeoutMs);
    if (!loginState) return fail('WA_LOAD_TIMEOUT', 'WhatsApp Web did not finish loading.');
    if (loginState === 'qr') return fail('NOT_LOGGED_IN', 'WhatsApp Web is not logged in. Scan the QR code, then resume.');
    return null;
  }

  /** Reload path: the page was opened at /send?phone=…&text=… */
  async function prepare({ phone, message, timeoutMs }) {
    const loginFail = await waitForLogin(timeoutMs);
    if (loginFail) return loginFail;
    const chatFail = await waitForChat(timeoutMs);
    if (chatFail) return chatFail;
    return ensureComposerText(phone, message);
  }

  /**
   * Fast path: open the chat inside the already-loaded page by clicking a
   * wa.me link, the same thing that happens when you click a number link in
   * a message. Returns code FAST_UNSUPPORTED whenever it can't be sure, so
   * the background falls back to the reload method.
   */
  async function openChatFast({ phone, message, timeoutMs }) {
    const unsupported = (why) => fail('FAST_UNSUPPORTED', why);
    const loginFail = await waitForLogin(Math.min(timeoutMs, 10000));
    if (loginFail) return loginFail;

    // 1) Close the open chat, so whatever chat appears next can only be the new one.
    if (D.getPopup()) return unsupported('A WhatsApp popup is open.');
    if (D.queryFirst(window.WA_SELECTORS.mainPanel)) {
      D.pressEscape();
      const closed = await D.waitFor(() => !D.queryFirst(window.WA_SELECTORS.mainPanel), 3000);
      if (!closed) return unsupported('Could not close the current chat.');
    }

    // 2) Click a wa.me link inside the app and check that WhatsApp handled it.
    const handled = D.clickInAppLink(`https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(message)}`);
    if (!handled) return unsupported('WhatsApp did not handle the in-app chat link.');

    // 3) Same checks as the reload path; a slow/missing chat falls back to reload.
    const chatFail = await waitForChat(Math.min(timeoutMs, 15000));
    if (chatFail) return chatFail.code === 'CHAT_OPEN_TIMEOUT' ? unsupported('Chat did not open without reload.') : chatFail;
    return ensureComposerText(phone, message);
  }

  /** Waits for the chat composer, or a popup (e.g. number not on WhatsApp). Returns failure or null. */
  async function waitForChat(timeoutMs) {
    let otherPopupSince = 0;
    const outcome = await D.waitFor(() => {
      if (D.getComposer()) return { type: 'chat' };
      const popup = D.getPopup();
      if (!popup) {
        otherPopupSince = 0;
        return null;
      }
      if (popup.kind === 'invalid' && popup.hasButton) return { type: 'invalid', popup };
      if (popup.kind === 'other' && popup.hasButton) {
        // An unrecognized popup with a button that stays up is treated as an error.
        otherPopupSince = otherPopupSince || Date.now();
        if (Date.now() - otherPopupSince > 4000) return { type: 'error', popup };
      }
      return null;
    }, timeoutMs);

    if (!outcome) {
      if (D.getLoginState() === 'qr') return fail('NOT_LOGGED_IN', 'WhatsApp Web logged out.');
      if (!navigator.onLine) return fail('OFFLINE', 'Internet connection unavailable.');
      return fail('CHAT_OPEN_TIMEOUT', `Chat did not open within ${Math.round(timeoutMs / 1000)}s.`);
    }
    if (outcome.type === 'invalid') {
      const text = outcome.popup.text.replace(/\s+/g, ' ').slice(0, 200);
      D.dismissPopup(outcome.popup);
      return fail('INVALID_NUMBER', `Number not on WhatsApp or invalid (${text})`);
    }
    if (outcome.type === 'error') {
      const text = outcome.popup.text.replace(/\s+/g, ' ').slice(0, 200);
      D.dismissPopup(outcome.popup);
      return fail('CHAT_OPEN_FAILED', `WhatsApp showed: ${text}`);
    }
    return null;
  }

  /** Makes sure the composer holds exactly `message` (pre-fill or insert). */
  async function ensureComposerText(phone, message) {
    // Give the link pre-fill a moment to populate the composer.
    await D.sleep(800);
    const composer = D.getComposer();
    if (!composer) return fail('COMPOSER_UNAVAILABLE', 'Message box not found in the opened chat.');

    if (!D.sameText(D.readText(composer), message)) {
      D.clearComposer(composer);
      await D.sleep(150);
      const ok = await D.insertText(composer, message);
      if (!ok) return fail('COMPOSER_INSERT_FAILED', 'Could not place the message in the message box.');
    }
    return { ok: true, ...verifyRecipient(phone) };
  }

  async function sendNow({ message }) {
    const composer = D.getComposer();
    if (!composer) return fail('COMPOSER_UNAVAILABLE', 'Message box disappeared before sending.');
    if (!D.sameText(D.readText(composer), message)) {
      const ok = await D.insertText(composer, message);
      if (!ok) return fail('COMPOSER_INSERT_FAILED', 'Message box content changed and could not be restored.');
    }

    const before = D.countOutgoing();
    const button = await D.waitFor(() => D.findSendButton(), 5000);
    if (button) button.click();
    else D.pressEnter(composer);

    const left = await D.waitFor(() => {
      const c = D.getComposer();
      const cleared = !c || D.readText(c).trim() === '';
      return D.countOutgoing() > before || cleared ? true : null;
    }, 15000);
    if (!left) return fail('SEND_FAILED', 'Send was clicked but the message stayed in the message box.');

    // Wait (best effort) for the clock icon to turn into a tick.
    await D.waitFor(() => D.countOutgoing() > before, 5000);
    const delivered = await D.waitFor(() => !D.lastOutgoingIsPending(), 15000, 500);
    return { ok: true, pendingDelivery: !delivered };
  }

  const handlers = {
    WA_PING: () => ({ ok: true, pageId: PAGE_ID, loginState: D.getLoginState(), online: navigator.onLine }),
    WA_PREPARE: prepare,
    WA_OPEN_CHAT: openChatFast,
    WA_SEND_NOW: sendNow,
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const handler = handlers[msg?.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(msg))
      .then(sendResponse, (err) => sendResponse(fail('UNKNOWN', err?.message || String(err))));
    return true;
  });
})();
