/**
 * Shared constants used by the background worker and the extension pages.
 * (The content script cannot import ES modules, so it duplicates the few
 * message-type strings it needs — see content.js.)
 */

/** Messages sent from popup/dashboard to the background service worker. */
export const MSG = Object.freeze({
  GET_STATE: 'GET_STATE',
  LOAD_CONTACTS: 'LOAD_CONTACTS',
  UPDATE_SETUP: 'UPDATE_SETUP',
  SET_EXCLUDED: 'SET_EXCLUDED',
  START: 'START',
  PAUSE: 'PAUSE',
  RESUME: 'RESUME',
  STOP: 'STOP',
  RESET: 'RESET',
  RETRY_FAILED: 'RETRY_FAILED',
  SEND_TEST: 'SEND_TEST',
  CHECK_WHATSAPP: 'CHECK_WHATSAPP',
  OPEN_WHATSAPP: 'OPEN_WHATSAPP',
  RELOAD_WHATSAPP: 'RELOAD_WHATSAPP',
  LOAD_DRAFT: 'LOAD_DRAFT',
  CLEAR_LOG: 'CLEAR_LOG',
  SKIP_WAIT: 'SKIP_WAIT',
});

/** Messages sent from the background worker to the WhatsApp Web content script. */
export const CS_MSG = Object.freeze({
  PING: 'WA_PING',
  PREPARE: 'WA_PREPARE',
  SEND_NOW: 'WA_SEND_NOW',
  OPEN_CHAT: 'WA_OPEN_CHAT',
});

/** Per-contact statuses (displayed verbatim in the UI and exports). */
export const STATUS = Object.freeze({
  PENDING: 'Pending',
  PROCESSING: 'Processing',
  SENT: 'Sent',
  FAILED: 'Failed',
  INVALID: 'Invalid Number',
  SKIPPED: 'Skipped',
  PAUSED: 'Paused',
});

/** Campaign lifecycle states. */
export const CAMPAIGN_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
});

/** Error codes returned by the WhatsApp driver / content script. */
export const ERR = Object.freeze({
  NO_TAB: 'NO_TAB',
  TAB_CLOSED: 'TAB_CLOSED',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  OFFLINE: 'OFFLINE',
  WA_LOAD_TIMEOUT: 'WA_LOAD_TIMEOUT',
  INVALID_NUMBER: 'INVALID_NUMBER',
  CHAT_OPEN_FAILED: 'CHAT_OPEN_FAILED',
  CHAT_OPEN_TIMEOUT: 'CHAT_OPEN_TIMEOUT',
  COMPOSER_UNAVAILABLE: 'COMPOSER_UNAVAILABLE',
  COMPOSER_INSERT_FAILED: 'COMPOSER_INSERT_FAILED',
  SEND_FAILED: 'SEND_FAILED',
  NO_RESPONSE: 'NO_RESPONSE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Errors that are not the contact's fault: the campaign is paused (and the
 * contact returned to Pending) so the user can fix the problem and resume.
 */
export const FATAL_ERRORS = Object.freeze([
  ERR.NO_TAB,
  ERR.TAB_CLOSED,
  ERR.NOT_LOGGED_IN,
  ERR.OFFLINE,
  ERR.WA_LOAD_TIMEOUT,
]);

/** Errors that suggest WhatsApp Web is unresponsive or its UI changed. */
export const INFRA_ERRORS = Object.freeze([
  ERR.CHAT_OPEN_TIMEOUT,
  ERR.COMPOSER_UNAVAILABLE,
  ERR.COMPOSER_INSERT_FAILED,
  ERR.SEND_FAILED,
  ERR.NO_RESPONSE,
]);

/** Pause automatically after this many consecutive infrastructure errors. */
export const MAX_CONSECUTIVE_INFRA_ERRORS = 3;

/** Campaign settings defaults (seconds unless noted). */
export const DEFAULT_SETTINGS = Object.freeze({
  // Pace: time from the start of one message to the start of the next ("1 message every N seconds").
  delayBetween: 60,
  delayBeforeOpen: 2,
  delayBeforeSend: 2,
  maxPerSession: 50,
  chatLoadTimeout: 45,
  focusWhatsAppTab: true,
  // 'fast' = open chats inside the loaded page (falls back to reload); 'reload' = reload every time.
  openMode: 'fast',
});

/** Validation bounds for settings: [min, max]. */
export const SETTING_BOUNDS = Object.freeze({
  delayBetween: [10, 7200],
  delayBeforeOpen: [0, 300],
  delayBeforeSend: [0, 300],
  maxPerSession: [1, 1000],
  chatLoadTimeout: [15, 180],
});

/** Shortest gap after any contact, even when the pace interval has already elapsed (ms). */
export const MIN_GAP_MS = 5000;

/** Pace presets offered in Settings (seconds between the starts of consecutive messages). */
export const PACE_PRESETS = Object.freeze([
  { seconds: 30, label: '30 sec' },
  { seconds: 60, label: '1 min' },
  { seconds: 120, label: '2 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 600, label: '10 min' },
  { seconds: 900, label: '15 min' },
  { seconds: 1800, label: '30 min' },
  { seconds: 3600, label: '1 hour' },
]);

export const MAX_LOG_ENTRIES = 5000;

export const WA_ORIGIN = 'https://web.whatsapp.com';

export const DEFAULT_TEMPLATES = Object.freeze([
  { name: 'Thank you', body: 'Hello {Name}, thank you for connecting with us!' },
  { name: 'Appointment confirmation', body: 'Hi {Name}, your appointment is confirmed for {Date|the scheduled date}.' },
  { name: 'Order update', body: 'Dear {Name}, we have an update regarding your order {OrderID}.' },
]);
