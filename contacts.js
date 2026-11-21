/**
 * Turns parsed CSV records into campaign contacts: column detection,
 * phone normalization/validation, duplicate and empty-row detection.
 */
import { STATUS } from './constants.js';
import { normalizeKey } from './message-template.js';

export const NAME_ALIASES = [
  'name', 'full name', 'contact name', 'customer name', 'client name',
  'contact', 'person', 'first name', 'display name',
];
export const PHONE_ALIASES = [
  'phone', 'mobile', 'number', 'whatsapp number', 'whatsapp', 'whatsapp no',
  'phone number', 'mobile number', 'contact number', 'cell', 'cell phone',
  'telephone', 'tel', 'mobile no', 'phone no', 'msisdn', 'wa number',
];

const NAME_WORDS = ['name'];
const PHONE_WORDS = ['phone', 'mobile', 'whatsapp', 'number', 'cell', 'tel', 'msisdn'];

function wordsOf(header) {
  return String(header).normalize('NFKC').toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
}

function findColumn(headers, aliases, words, exclude) {
  const candidates = headers.filter((h) => h !== exclude);
  for (const alias of aliases) {
    const hit = candidates.find((h) => normalizeKey(h) === normalizeKey(alias));
    if (hit) return hit;
  }
  for (const word of words) {
    const hit = candidates.find((h) => wordsOf(h).includes(word));
    if (hit) return hit;
  }
  return null;
}

/** Guesses the phone column from values when no header matches. */
function guessPhoneColumnByValues(headers, records, exclude) {
  const sample = records.filter((r) => !r.isEmpty).slice(0, 50);
  if (!sample.length) return null;
  let best = null;
  let bestRatio = 0;
  for (const h of headers) {
    if (h === exclude) continue;
    const hits = sample.filter((r) => /^\+?[\d\s\-().]{8,20}$/.test(r.values[h] || '')).length;
    const ratio = hits / sample.length;
    if (ratio > bestRatio) {
      best = h;
      bestRatio = ratio;
    }
  }
  return bestRatio >= 0.6 ? best : null;
}

/** Detects Name and Phone columns (case-insensitive, common variations). */
export function detectColumns(headers, records = []) {
  let phoneColumn = findColumn(headers, PHONE_ALIASES, PHONE_WORDS, null);
  const nameColumn = findColumn(headers, NAME_ALIASES, NAME_WORDS, phoneColumn);
  if (!phoneColumn) phoneColumn = guessPhoneColumnByValues(headers, records, nameColumn);
  return { nameColumn, phoneColumn };
}

/**
 * Normalizes a phone number to WhatsApp's digits-only international format.
 * @returns {{valid: boolean, phone: string, reason?: string, message?: string}}
 */
export function normalizePhone(raw, defaultCountryCode = '') {
  const original = String(raw ?? '').trim();
  const invalid = (reason, message) => ({ valid: false, phone: '', reason, message });

  if (!original) return invalid('missing', 'Phone number is missing');
  if (/^\d(\.\d+)?e\+?\d+$/i.test(original.replace(/,/g, ''))) {
    return invalid(
      'scientific',
      'Number is in scientific notation (e.g. 9.19E+11). Format the column as Text in Excel and export again.'
    );
  }

  let s = original.replace(/\s*(ext\.?|x)\s*\d+$/i, '').replace(/\(0\)/g, '');
  if (/[a-z]/i.test(s)) return invalid('letters', 'Phone number contains letters');

  let international = /^\s*\+/.test(s);
  let digits = s.replace(/\D/g, '');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }

  const cc = String(defaultCountryCode ?? '').replace(/\D/g, '');
  if (!international && cc) {
    if (digits.startsWith('0')) digits = cc + digits.replace(/^0+/, '');
    else if (digits.length <= 10) digits = cc + digits;
  }

  if (digits.length < 8 || digits.length > 15) {
    return invalid('length', `Must be 8–15 digits including the country code (got ${digits.length})`);
  }
  if (digits.startsWith('0')) {
    return invalid('no_country_code', 'Starts with 0. Include the country code (e.g. 91…) or set a default country code');
  }
  return { valid: true, phone: digits };
}

/** Status a contact should have before any sending happens. */
export function initialStatus(contact) {
  if (contact.invalid) return STATUS.INVALID;
  if (contact.isEmpty || contact.excluded) return STATUS.SKIPPED;
  return STATUS.PENDING;
}

/**
 * Builds contacts from parsed CSV records.
 * Every record becomes a contact (including problem rows) so the preview can
 * show exactly what will and won't be sent.
 */
export function buildContacts(records, { nameColumn, phoneColumn, defaultCountryCode = '', skipDuplicates = true } = {}) {
  const seen = new Map();
  return records.map((rec) => {
    const values = rec.values || {};
    const name = nameColumn ? String(values[nameColumn] ?? '').trim() : '';
    const rawPhone = phoneColumn ? String(values[phoneColumn] ?? '').trim() : '';
    const issues = [];
    let invalid = false;
    let duplicate = false;
    let phone = '';

    if (rec.isEmpty) {
      issues.push({ code: 'empty_row', message: 'Empty row' });
    } else {
      const p = normalizePhone(rawPhone, defaultCountryCode);
      if (!p.valid) {
        invalid = true;
        issues.push({ code: p.reason === 'missing' ? 'missing_phone' : 'invalid_phone', message: p.message });
      } else {
        phone = p.phone;
        if (seen.has(phone)) {
          duplicate = true;
          issues.push({ code: 'duplicate', message: `Duplicate of row ${seen.get(phone)}` });
        } else {
          seen.set(phone, rec.rowNumber);
        }
      }
      if (!name) issues.push({ code: 'missing_name', message: 'Name is missing' });
    }

    const contact = {
      id: `c${rec.rowNumber}`,
      row: rec.rowNumber,
      name,
      phone,
      rawPhone,
      fields: { ...values },
      isEmpty: !!rec.isEmpty,
      invalid,
      duplicate,
      issues,
      excluded: !!rec.isEmpty || (duplicate && skipDuplicates),
      status: STATUS.PENDING,
      error: '',
      message: '',
      timestamp: null,
      attempts: 0,
    };
    contact.status = initialStatus(contact);
    return contact;
  });
}

/** Rebuilds contacts (e.g. after the user changes the column mapping). */
export function rebuildContacts(contacts, options) {
  const records = contacts.map((c) => ({ rowNumber: c.row, values: c.fields, isEmpty: c.isEmpty }));
  return buildContacts(records, options);
}

/** Plain-language note for the "Note" column (table + export). */
export const NOTE_TEXT = Object.freeze({
  missing_phone: 'Phone number missing in CSV',
  not_on_whatsapp: 'Number not on WhatsApp',
});

/**
 * Builds the note shown in the separate Note column: why a number can't be
 * messaged (missing / invalid / not on WhatsApp / duplicate) plus any
 * send-time remarks.
 */
export function contactNote(contact) {
  const parts = [];
  for (const issue of contact.issues || []) {
    if (issue.code === 'missing_phone') parts.push(NOTE_TEXT.missing_phone);
    else parts.push(issue.message);
  }
  if (contact.notOnWhatsApp) parts.push(NOTE_TEXT.not_on_whatsapp);
  if (contact.note) parts.push(contact.note);
  return [...new Set(parts.filter(Boolean))].join('; ');
}

/** Counts validation issues for the summary chips. */
export function summarizeIssues(contacts) {
  const summary = { empty_row: 0, missing_phone: 0, invalid_phone: 0, duplicate: 0, missing_name: 0 };
  for (const c of contacts) for (const i of c.issues) summary[i.code] = (summary[i.code] || 0) + 1;
  return summary;
}
