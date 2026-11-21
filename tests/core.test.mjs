// Unit tests for CSV parsing, column detection, phone validation and placeholders.
// Run: npm test   (or: node --test tests/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectDelimiter, CsvParseError } from '../csv-parser.js';
import { detectColumns, normalizePhone, buildContacts, rebuildContacts, summarizeIssues } from '../contacts.js';
import { personalize, renderTemplate, buildValueMap, extractPlaceholders, normalizeKey, availablePlaceholders } from '../message-template.js';
import { STATUS } from '../constants.js';

/* ---------------- CSV parser ---------------- */

test('parses a basic CSV', () => {
  const { headers, records } = parseCSV('Name, Phone\nJohn, 919876543210\nSarah, 918765432109\n');
  assert.deepEqual(headers, ['Name', 'Phone']);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].values, { Name: 'John', Phone: '919876543210' });
  assert.equal(records[1].rowNumber, 2);
});

test('handles quotes, embedded commas, newlines and escaped quotes', () => {
  const csv = 'Name,Phone,Note\r\n"Doe, John",919876543210,"Line 1\nLine 2"\r\n"Say ""hi""",918765432109,x\r\n';
  const { records } = parseCSV(csv);
  assert.equal(records[0].values.Name, 'Doe, John');
  assert.equal(records[0].values.Note, 'Line 1\nLine 2');
  assert.equal(records[1].values.Name, 'Say "hi"');
});

test('strips BOM and auto-detects semicolon / tab delimiters', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  const semi = parseCSV('﻿Name;Phone\nAna;34600111222\n');
  assert.deepEqual(semi.headers, ['Name', 'Phone']);
  assert.equal(semi.delimiter, ';');
  assert.equal(semi.records[0].values.Phone, '34600111222');
  const tab = parseCSV('Name\tPhone\nBo\t4915112345678\n');
  assert.equal(tab.records[0].values.Name, 'Bo');
});

test('flags empty rows in the middle and drops trailing blank lines', () => {
  const { records } = parseCSV('Name,Phone\nA,919876543210\n,\nB,918765432109\n\n\n');
  assert.equal(records.length, 3);
  assert.equal(records[1].isEmpty, true);
  assert.equal(records[2].values.Name, 'B');
});

test('makes duplicate and blank headers unique', () => {
  const { headers } = parseCSV('Name,name,,Phone\na,b,c,919876543210');
  assert.deepEqual(headers, ['Name', 'name (2)', 'Column 3', 'Phone']);
});

test('missing trailing cells become empty strings; extra cells are flagged', () => {
  const { records } = parseCSV('Name,Phone,City\nA,919876543210\nB,918765432109,X,EXTRA');
  assert.equal(records[0].values.City, '');
  assert.equal(records[1].extraCells, true);
});

test('throws CsvParseError for empty, header-only and unterminated files', () => {
  assert.throws(() => parseCSV(''), CsvParseError);
  assert.throws(() => parseCSV('   \n  '), CsvParseError);
  assert.throws(() => parseCSV('Name,Phone\n'), /no data rows/);
  assert.throws(() => parseCSV('Name,Phone\n"Open,919876543210'), /Unterminated/);
});

/* ---------------- column detection ---------------- */

test('detects Name / Phone columns regardless of case and common variants', () => {
  const cases = [
    [['Name', 'Phone'], 'Name', 'Phone'],
    [['FULL NAME', 'Mobile'], 'FULL NAME', 'Mobile'],
    [['contact name', 'WhatsApp Number', 'City'], 'contact name', 'WhatsApp Number'],
    [['City', 'Number', 'Name'], 'Name', 'Number'],
    [['Customer Name', 'Phone_Number'], 'Customer Name', 'Phone_Number'],
    [['Contact Name', 'Contact Number'], 'Contact Name', 'Contact Number'],
  ];
  for (const [headers, name, phone] of cases) {
    assert.deepEqual(detectColumns(headers), { nameColumn: name, phoneColumn: phone }, headers.join(','));
  }
});

test('falls back to guessing the phone column from its values', () => {
  const { headers, records } = parseCSV('Person,Digits\nA,919876543210\nB,+91 87654 32109\nC,917654321098');
  assert.deepEqual(detectColumns(headers, records), { nameColumn: 'Person', phoneColumn: 'Digits' });
  const unnamed = parseCSV('Col A,Col B\nA,919876543210\nB,918765432109');
  assert.deepEqual(detectColumns(unnamed.headers, unnamed.records), { nameColumn: null, phoneColumn: 'Col B' });
});

/* ---------------- phone normalization ---------------- */

test('normalizes valid phone formats', () => {
  assert.equal(normalizePhone('+91 98765-43210').phone, '919876543210');
  assert.equal(normalizePhone('(91) 98765 43210').phone, '919876543210');
  assert.equal(normalizePhone('0044 7911 123456').phone, '447911123456');
  assert.equal(normalizePhone('+44 (0)7911 123456').phone, '447911123456');
  assert.equal(normalizePhone('9876543210', '91').phone, '919876543210');
  assert.equal(normalizePhone('09876543210', '+91').phone, '919876543210');
  assert.equal(normalizePhone('919876543210', '91').phone, '919876543210', 'already has country code');
});

test('rejects invalid phone numbers with a reason', () => {
  assert.equal(normalizePhone('').reason, 'missing');
  assert.equal(normalizePhone('9.19877E+11').reason, 'scientific');
  assert.equal(normalizePhone('call me').reason, 'letters');
  assert.equal(normalizePhone('12345').reason, 'length');
  assert.equal(normalizePhone('1234567890123456').reason, 'length');
  assert.equal(normalizePhone('0987654321').reason, 'no_country_code');
});

/* ---------------- contact building ---------------- */

test('builds contacts with validation: invalid, duplicate, missing name, empty row', () => {
  const { headers, records } = parseCSV(
    'Name,Phone\nJohn,919876543210\n,918765432109\nDup,+91 98765 43210\nBad,123\n,\nNoPhone,\n'
  );
  const cols = detectColumns(headers, records);
  const contacts = buildContacts(records, { ...cols, skipDuplicates: true });
  const byRow = Object.fromEntries(contacts.map((c) => [c.row, c]));
  assert.equal(byRow[1].status, STATUS.PENDING);
  assert.equal(byRow[2].status, STATUS.PENDING, 'missing name is a warning, not a blocker');
  assert.ok(byRow[2].issues.some((i) => i.code === 'missing_name'));
  assert.equal(byRow[3].status, STATUS.SKIPPED);
  assert.match(byRow[3].issues[0].message, /Duplicate of row 1/);
  assert.equal(byRow[4].status, STATUS.INVALID);
  assert.equal(byRow[5].status, STATUS.SKIPPED);
  assert.equal(byRow[5].isEmpty, true);
  assert.equal(byRow[6].status, STATUS.INVALID);

  const sum = summarizeIssues(contacts);
  assert.deepEqual([sum.duplicate, sum.invalid_phone, sum.missing_phone, sum.empty_row, sum.missing_name], [1, 1, 1, 1, 1]);

  const keepDup = buildContacts(records, { ...cols, skipDuplicates: false });
  assert.equal(keepDup.find((c) => c.row === 3).status, STATUS.PENDING);
});

test('rebuildContacts with a default country code makes local numbers valid', () => {
  const { records } = parseCSV('Who,Tel\nA,09876543210\n');
  const first = buildContacts(records, { nameColumn: 'Who', phoneColumn: 'Tel' });
  assert.equal(first[0].status, STATUS.INVALID);
  const again = rebuildContacts(first, { nameColumn: 'Who', phoneColumn: 'Tel', defaultCountryCode: '91' });
  assert.equal(again[0].status, STATUS.PENDING);
  assert.equal(again[0].phone, '919876543210');
});

/* ---------------- placeholders ---------------- */

const contactFrom = (fields, nameCol = 'Name', phoneCol = 'Phone') => ({
  name: fields[nameCol] || '',
  phone: fields[phoneCol] || '',
  fields,
});

test('replaces placeholders from CSV columns (spec example)', () => {
  const tpl = 'Hello {Name}, we have a special offer available in {City}!';
  assert.equal(personalize(tpl, contactFrom({ Name: 'Rahul', Phone: '919876543210', City: 'Hyderabad' })).text,
    'Hello Rahul, we have a special offer available in Hyderabad!');
  assert.equal(personalize(tpl, contactFrom({ Name: 'Priya', Phone: '918765432109', City: 'Bangalore' })).text,
    'Hello Priya, we have a special offer available in Bangalore!');
});

test('matching is case-insensitive and tolerant of spaces/underscores', () => {
  const c = contactFrom({ Name: 'Ana', Phone: '1', OrderID: 'A-7', 'Delivery Date': '5 May' });
  assert.equal(personalize('{name} {NAME} {Order ID} {order_id} {deliverydate} { Delivery Date }', c).text, 'Ana Ana A-7 A-7 5 May 5 May');
  assert.equal(normalizeKey('Order ID'), normalizeKey('order-id'));
});

test('{Name} maps to the detected name column even if it is called "Full Name"', () => {
  const c = { name: 'Zoë Kravitz', phone: '1', fields: { 'Full Name': 'Zoë Kravitz' } };
  assert.equal(personalize('Hi {Name} / {First Name} / {Full Name}', c).text, 'Hi Zoë Kravitz / Zoë / Zoë Kravitz');
});

test('missing values: removed with tidy spacing, or use fallback', () => {
  const c = contactFrom({ Name: '', Phone: '1', City: '' });
  const r = personalize('Hello {Name}, welcome to {City|our store}!', c);
  assert.equal(r.text, 'Hello, welcome to our store!');
  assert.deepEqual(r.missing, ['Name']);
});

test('unknown placeholders are left visible and reported', () => {
  const r = personalize('Hi {Name}, code {Coupon}', contactFrom({ Name: 'A', Phone: '1' }));
  assert.equal(r.text, 'Hi A, code {Coupon}');
  assert.deepEqual(r.unknown, ['Coupon']);
});

test('special characters and Unicode in values are inserted literally', () => {
  const c = contactFrom({ Name: 'राहुल', Phone: '1', Note: '$& $1 {City} 100% <b>' , City: '東京 🎉' });
  assert.equal(personalize('{Name}: {Note} | {City}', c).text, 'राहुल: $& $1 {City} 100% <b> | 東京 🎉');
  assert.equal(personalize('Привет, {Name}!', contactFrom({ Name: '李雷', Phone: '1' })).text, 'Привет, 李雷!');
});

test('extra columns are available as placeholders', () => {
  const placeholders = availablePlaceholders(['Name', 'City', 'OrderID', 'Appointment Date']);
  assert.deepEqual(placeholders, ['Name', 'First Name', 'City', 'OrderID', 'Appointment Date', 'Phone']);
  assert.deepEqual(extractPlaceholders('Hi {Name}, {name} {City|x} {Order ID}'), ['Name', 'City', 'Order ID']);
});

test('renderTemplate leaves text without placeholders unchanged', () => {
  const text = 'Plain message with a } brace and { another';
  assert.equal(renderTemplate(text, buildValueMap({ name: 'A', fields: {} })).text, text);
});
