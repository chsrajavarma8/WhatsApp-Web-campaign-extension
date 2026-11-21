/**
 * Placeholder handling for personalized messages.
 *
 * Syntax:
 *   {Name}            -> value of the "Name" column (case/space-insensitive)
 *   {Order ID}        -> matches columns "Order ID", "OrderID", "order_id"
 *   {City|your city}  -> fallback text used when the value is empty
 *
 * Built-in placeholders (always available once a CSV is loaded):
 *   {Name}       -> detected name column (even if it is called "Full Name")
 *   {First Name} -> first word of the name
 *   {Phone}      -> phone column value
 *
 * Unknown placeholders are left untouched so the user can spot typos.
 */

const PLACEHOLDER_RE = /\{([^{}|\n]+?)(?:\|([^{}\n]*))?\}/g;

/** "Order ID", "order_id", "OrderID" all normalize to "orderid". */
export function normalizeKey(key) {
  return String(key ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-.]+/g, '');
}

/** Returns unique placeholder names used in the template, in order of appearance. */
export function extractPlaceholders(template) {
  const seen = new Set();
  const out = [];
  for (const m of String(template ?? '').matchAll(PLACEHOLDER_RE)) {
    const name = m[1].trim();
    const key = normalizeKey(name);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** Builds a normalized-key -> value map for a contact (columns override built-ins). */
export function buildValueMap(contact) {
  const map = new Map();
  const name = String(contact?.name ?? '').trim();
  map.set(normalizeKey('Name'), name);
  map.set(normalizeKey('First Name'), name.split(/\s+/)[0] || '');
  map.set(normalizeKey('Phone'), String(contact?.phone ?? ''));
  for (const [k, v] of Object.entries(contact?.fields ?? {})) {
    const key = normalizeKey(k);
    if (!key) continue;
    const value = String(v ?? '');
    // Don't let an empty duplicate column wipe out a populated built-in.
    if (value.trim() === '' && map.has(key) && map.get(key)) continue;
    map.set(key, value);
  }
  return map;
}

/**
 * Renders a template against a value map.
 * @returns {{text: string, missing: string[], unknown: string[]}}
 */
export function renderTemplate(template, valueMap) {
  const missing = [];
  const unknown = [];
  let text = String(template ?? '').replace(PLACEHOLDER_RE, (match, rawName, fallback) => {
    const name = rawName.trim();
    const key = normalizeKey(name);
    if (!key) return match;
    if (!valueMap.has(key)) {
      if (!unknown.includes(name)) unknown.push(name);
      return match;
    }
    const value = String(valueMap.get(key) ?? '').trim();
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    if (!missing.includes(name)) missing.push(name);
    return '';
  });
  if (missing.length) {
    // Tidy up gaps left by empty values: "Hello , welcome" -> "Hello, welcome".
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.!?;:])/g, '$1');
  }
  return { text: text.trim(), missing, unknown };
}

/** Convenience: personalize a template for one contact. */
export function personalize(template, contact) {
  return renderTemplate(template, buildValueMap(contact));
}

/** Placeholders offered as clickable chips for the given CSV columns. */
export function availablePlaceholders(columns, { hasName = true } = {}) {
  const out = [];
  const seen = new Set();
  const add = (label) => {
    const key = normalizeKey(label);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  };
  if (hasName) {
    add('Name');
    add('First Name');
  }
  for (const col of columns ?? []) add(col);
  add('Phone');
  return out;
}
