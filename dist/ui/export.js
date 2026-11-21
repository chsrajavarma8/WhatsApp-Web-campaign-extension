/** CSV export of campaign results and the activity log (generated locally). */
import { personalize } from '../message-template.js';
import { STATUS } from '../constants.js';
import { contactNote } from '../contacts.js';

/** Excel treats cells starting with these characters as formulas. */
const FORMULA_START = /^[=+\-@\t\r]/;

function escapeCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  return lines.join('\r\n');
}

function stamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function resultRows(campaign) {
  return (campaign?.contacts ?? []).map((c) => ({
    Row: c.row,
    Name: c.name,
    Phone: c.phone || c.rawPhone,
    Message: c.message || (c.status === STATUS.PENDING ? personalize(campaign.template, c).text : ''),
    Status: c.status,
    Timestamp: stamp(c.timestamp),
    Note: contactNote(c),
    Error: c.error || '',
  }));
}

export function logRows(campaign) {
  return (campaign?.log ?? []).map((e) => ({
    Timestamp: stamp(e.ts),
    Level: e.level,
    Type: e.test ? 'Test' : e.contactId ? 'Contact' : 'Campaign',
    Name: e.name || '',
    Phone: e.phone || '',
    Message: e.message || '',
    Status: e.status || '',
    Note: e.note || '',
    Error: e.error || '',
    Details: e.text || '',
  }));
}

export function downloadText(filename, text, mime = 'text/csv;charset=utf-8') {
  // BOM so Excel opens UTF-8 (Unicode names) correctly.
  const blob = new Blob(['﻿', text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const safeName = (s) => String(s || 'campaign').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);

export function exportResults(campaign) {
  const headers = ['Row', 'Name', 'Phone', 'Message', 'Status', 'Note', 'Timestamp', 'Error'];
  downloadText(`${safeName(campaign.name)}-results-${stamp(Date.now()).replace(/[: ]/g, '-')}.csv`, toCsv(headers, resultRows(campaign)));
}

export function exportLog(campaign) {
  const headers = ['Timestamp', 'Level', 'Type', 'Name', 'Phone', 'Message', 'Status', 'Note', 'Error', 'Details'];
  downloadText(`${safeName(campaign.name)}-log-${stamp(Date.now()).replace(/[: ]/g, '-')}.csv`, toCsv(headers, logRows(campaign)));
}
