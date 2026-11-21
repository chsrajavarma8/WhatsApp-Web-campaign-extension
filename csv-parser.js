/**
 * RFC 4180-compatible CSV parser.
 *
 * Supports: quoted fields, escaped quotes (""), embedded newlines and
 * delimiters inside quotes, CRLF/LF/CR line endings, UTF-8 BOM, and
 * auto-detection of comma / semicolon / tab / pipe delimiters
 * (semicolons are common in European Excel exports).
 */

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

export class CsvParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Picks the delimiter that occurs most often in the header line (outside quotes). */
export function detectDelimiter(text) {
  const counts = {};
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    if (!inQuotes && CANDIDATE_DELIMITERS.includes(ch)) counts[ch] = (counts[ch] || 0) + 1;
  }
  let best = ',';
  let bestCount = 0;
  for (const d of CANDIDATE_DELIMITERS) {
    if ((counts[d] || 0) > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

/** Splits CSV text into an array of rows, each an array of raw cell strings. */
export function tokenize(text, delimiter = ',') {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      // Opening quote (leading whitespace before a quote is ignored).
      field = '';
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      continue;
    }
    // Includes stray quotes inside unquoted fields, which are kept literally.
    field += ch;
    i++;
  }

  if (inQuotes) {
    throw new CsvParseError('Unterminated quoted field. Check the file for a missing closing quote (").');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Trims headers, names blank ones, and de-duplicates (case-insensitively). */
export function makeUniqueHeaders(cells) {
  const used = new Set();
  return cells.map((cell, idx) => {
    let base = String(cell ?? '').trim() || `Column ${idx + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) name = `${base} (${n++})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Parses CSV text.
 * @returns {{headers: string[], records: {rowNumber:number, values:Object<string,string>, isEmpty:boolean, extraCells:boolean}[], delimiter: string}}
 */
export function parseCSV(text, options = {}) {
  if (typeof text !== 'string') throw new CsvParseError('Expected CSV text.');
  const clean = text.replace(/^﻿/, '');
  if (!clean.trim()) throw new CsvParseError('The file is empty.');

  const delimiter = options.delimiter || detectDelimiter(clean);
  const rows = tokenize(clean, delimiter);

  const headerIndex = rows.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIndex < 0) throw new CsvParseError('No header row found.');
  const headers = makeUniqueHeaders(rows[headerIndex]);

  const records = [];
  let dataRow = 0;
  for (let r = headerIndex + 1; r < rows.length; r++) {
    const cells = rows[r];
    dataRow++;
    const values = {};
    headers.forEach((h, idx) => {
      values[h] = String(cells[idx] ?? '').trim();
    });
    records.push({
      rowNumber: dataRow,
      values,
      isEmpty: cells.every((c) => c.trim() === ''),
      extraCells: cells.length > headers.length && cells.slice(headers.length).some((c) => c.trim() !== ''),
    });
  }
  // Trailing blank lines are noise, not "empty rows" worth reporting.
  while (records.length && records[records.length - 1].isEmpty) records.pop();

  if (records.length === 0) throw new CsvParseError('The file has a header row but no data rows.');
  return { headers, records, delimiter };
}

/**
 * Reads a File as text in the browser. Falls back to Windows-1252 when the
 * file is not valid UTF-8 (typical of older Excel "CSV" exports).
 */
export async function readFileAsText(file) {
  const read = (encoding) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new CsvParseError('Could not read the file.'));
      reader.readAsText(file, encoding);
    });
  const utf8 = await read('utf-8');
  if (utf8.includes('�')) {
    try {
      return await read('windows-1252');
    } catch {
      return utf8;
    }
  }
  return utf8;
}
