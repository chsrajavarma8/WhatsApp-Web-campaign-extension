/**
 * ALL WhatsApp Web DOM selectors live here.
 *
 * WhatsApp Web changes its markup from time to time. If sending breaks,
 * this is the first (and usually only) file to update. Each entry is a
 * list of fallbacks tried in order; the first visible match wins.
 * Prefer stable hooks (aria-label, data-icon, data-tab, ids) over class names.
 */
window.WA_SELECTORS = Object.freeze({
  /** Present only when the user is logged in and the chat list rendered. */
  loggedIn: [
    '#pane-side',
    '#side',
    'div[aria-label="Chat list"]',
    '[data-testid="chat-list"]',
    'div[role="grid"][aria-label]',
  ],

  /** Login screen QR code. */
  qrCode: [
    'canvas[aria-label*="scan" i]',
    'div[data-ref] canvas',
    '[data-testid="qrcode"]',
    'div[data-ref]',
  ],

  /** The conversation panel (only exists once a chat is open). */
  mainPanel: ['#main'],

  /** Header title of the open chat (contact name or number). */
  chatTitle: [
    '#main header span[dir="auto"][title]',
    '#main header span[dir="auto"]',
    '#main header [title]',
  ],

  /** Message composer (a contenteditable Lexical editor). */
  composer: [
    '#main footer div[contenteditable="true"][role="textbox"]',
    '#main footer div[contenteditable="true"][data-tab]',
    '#main footer div[contenteditable="true"]',
    'div[contenteditable="true"][data-tab="10"]',
  ],

  /** Send button (or its icon; the closest button is clicked). */
  sendButton: [
    '#main footer button[aria-label="Send"]',
    '#main footer [data-testid="send"]',
    '#main footer span[data-icon="send"]',
    '#main footer span[data-icon="wds-ic-send-filled"]',
    '#main footer button[data-tab="11"]',
  ],

  /** Modal popups, e.g. "Phone number shared via url is invalid." */
  popup: [
    'div[data-animate-modal-popup="true"]',
    '[data-testid="popup-contents"]',
    'div[role="dialog"]',
  ],

  /** Where the temporary wa.me link is placed for fast (no-reload) chat opening. */
  linkHost: ['#app', '#side', 'body'],

  /** Outgoing message bubbles in the open chat. */
  outgoingMessage: ['#main div.message-out', '#main [data-testid="msg-container"] .message-out'],

  /** Clock icon on an outgoing bubble while it's still queued. */
  pendingIcon: ['span[data-icon="msg-time"]', '[data-testid="msg-time"]'],
});

/**
 * Text fragments used to classify popups. Lower-case; matched with includes().
 * Add translations here if your WhatsApp is in another language.
 */
window.WA_TEXT_HINTS = Object.freeze({
  invalidNumber: [
    'invalid', 'not on whatsapp', "isn't on whatsapp", 'is not on whatsapp',
    'no es válido', 'inválido', 'ungültig', 'non valido', 'invalide', 'tidak valid',
    'अमान्य', 'غير صالح', 'недействителен',
  ],
  loading: ['starting chat', 'loading', 'iniciando', 'cargando', 'chat wird', 'चैट शुरू'],
});
