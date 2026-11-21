/** Contacts: CSV upload, column mapping, validation summary, preview table. */
import { CAMPAIGN_STATE, STATUS } from '../../constants.js';
import { parseCSV, readFileAsText } from '../../csv-parser.js';
import { detectColumns, buildContacts, rebuildContacts, summarizeIssues, contactNote } from '../../contacts.js';
import { personalize } from '../../message-template.js';
import { computeStats } from '../../campaign-manager.js';
import { api } from '../api.js';
import { h, setChildren, guard, toast, confirmDialog, statusBadge, formatTime } from '../dom.js';
import { downloadText } from '../export.js';

const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SAMPLE_CSV = 'Name,Phone,City,OrderID,Date\r\nRahul,919876543210,Hyderabad,A-1001,12 Dec\r\nPriya,918765432109,Bangalore,A-1002,13 Dec\r\n';

let els = null;
const view = { page: 0, filter: 'all', search: '' };

export function init(root, ctx) {
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv,.txt', hidden: true, onchange: (e) => handleFile(ctx, e.target.files[0], e.target) });
  const dropzone = h('label', { class: 'dropzone', tabindex: 0 },
    fileInput,
    h('div', { class: 'dropzone-icon' }, '⇪'),
    h('strong', {}, 'Drop your CSV file here or click to browse'),
    h('span', { class: 'muted' }, 'Needs a Name and a Phone column (any capitalization). Extra columns become placeholders.'));
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFile(ctx, e.dataTransfer.files[0]);
  });

  els = {
    dropzone,
    fileInfo: h('div', { class: 'file-info' }),
    mapping: h('div', { class: 'card', hidden: true }),
    nameSelect: h('select', { class: 'input', onchange: () => remap(ctx) }),
    phoneSelect: h('select', { class: 'input', onchange: () => remap(ctx) }),
    ccInput: h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 4, placeholder: 'e.g. 91', onchange: () => remap(ctx) }),
    dupCheck: h('input', { type: 'checkbox', onchange: () => remap(ctx) }),
    summary: h('div', { class: 'chips' }),
    tableCard: h('div', { class: 'card', hidden: true }),
    search: h('input', { class: 'input', type: 'search', placeholder: 'Search name or phone…', oninput: (e) => { view.search = e.target.value.trim().toLowerCase(); view.page = 0; renderTable(ctx); } }),
    filter: h('select', { class: 'input', onchange: (e) => { view.filter = e.target.value; view.page = 0; renderTable(ctx); } },
      h('option', { value: 'all' }, 'All statuses'),
      Object.values(STATUS).map((s) => h('option', { value: s }, s)),
      h('option', { value: 'issues' }, 'Rows with warnings')),
    bulk: h('div', { class: 'btn-row' }),
    table: h('div', { class: 'table-wrap' }),
    pager: h('div', { class: 'pager' }),
  };

  els.mapping.append(
    h('h3', { class: 'card-title' }, 'Column mapping'),
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name column'), els.nameSelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Phone column'), els.phoneSelect),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Default country code'), els.ccInput,
        h('span', { class: 'field-hint' }, 'Added to numbers without one (e.g. 9876543210 → 919876543210).')),
      h('label', { class: 'check-row' }, els.dupCheck, h('span', {}, 'Skip duplicate numbers automatically'))),
    els.summary
  );

  els.tableCard.append(
    h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, 'Contact preview'), els.bulk),
    h('div', { class: 'toolbar' }, els.search, els.filter),
    els.table,
    els.pager
  );

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', { class: 'card-title' }, 'Upload contacts'),
        h('button', { class: 'btn btn-ghost btn-sm', onclick: () => downloadText('sample-contacts.csv', SAMPLE_CSV) }, 'Download sample CSV')),
      dropzone,
      els.fileInfo),
    els.mapping,
    els.tableCard
  );
}

async function handleFile(ctx, file, input) {
  if (input) input.value = ''; // allow re-selecting the same file
  if (!file) return;
  const c = ctx.state.campaign;
  if (c.status === CAMPAIGN_STATE.RUNNING) return toast('Pause or stop the campaign before uploading a new file.', 'error');
  if (file.size > MAX_FILE_BYTES) return toast('File is too large (max 5 MB).', 'error');
  if (!/\.(csv|txt)$/i.test(file.name) && file.type && !/csv|text/.test(file.type)) {
    return toast('Please choose a .csv file. In Excel use File → Save As → CSV UTF-8.', 'error', 7000);
  }
  if (c.contacts.length && computeStats(c).sent > 0) {
    const ok = await confirmDialog({
      title: 'Replace current contacts?',
      message: 'This campaign already has sent messages. Loading a new file replaces the contacts and clears progress and the log. Export results first if you need them.',
      confirmLabel: 'Replace',
      danger: true,
    });
    if (!ok) return;
  }

  let parsed;
  try {
    parsed = parseCSV(await readFileAsText(file));
  } catch (err) {
    setChildren(els.fileInfo, h('div', { class: 'notice notice-error' }, `Could not read "${file.name}": ${err.message}`));
    return toast(`CSV error: ${err.message}`, 'error', 7000);
  }

  const { nameColumn, phoneColumn } = detectColumns(parsed.headers, parsed.records);
  const source = {
    fileName: file.name,
    headers: parsed.headers,
    nameColumn,
    phoneColumn,
    delimiter: parsed.delimiter,
    defaultCountryCode: c.source.defaultCountryCode || '',
    skipDuplicates: c.source.skipDuplicates ?? true,
    loadedAt: Date.now(),
  };
  const contacts = buildContacts(parsed.records, source);
  const name = !c.name || c.name === 'Untitled campaign' ? file.name.replace(/\.[^.]+$/, '') : undefined;
  const ok = await guard(() => api.loadContacts(contacts, source, name));
  if (!ok) return;
  view.page = 0;
  ctx.select(contacts.find((x) => x.status === STATUS.PENDING)?.id || null);
  toast(`Loaded ${contacts.length} rows from ${file.name}`, 'success');
  if (!phoneColumn) toast('Could not detect the phone column. Choose it under Column mapping.', 'warning', 7000);
  else if (!nameColumn) toast('Could not detect a name column. Choose it under Column mapping (optional).', 'warning', 7000);
}

async function remap(ctx) {
  const c = ctx.state.campaign;
  if (c.status === CAMPAIGN_STATE.RUNNING) {
    toast('Pause or stop the campaign before changing the mapping.', 'error');
    return render(null, ctx);
  }
  if (computeStats(c).sent > 0) {
    const ok = await confirmDialog({
      title: 'Re-apply mapping?',
      message: 'Changing the mapping rebuilds the contact list and clears progress for this campaign.',
      confirmLabel: 'Continue',
      danger: true,
    });
    if (!ok) return render(null, ctx);
  }
  const source = {
    ...c.source,
    nameColumn: els.nameSelect.value || null,
    phoneColumn: els.phoneSelect.value || null,
    defaultCountryCode: els.ccInput.value.replace(/\D/g, ''),
    skipDuplicates: els.dupCheck.checked,
  };
  const contacts = rebuildContacts(c.contacts, source);
  await guard(() => api.loadContacts(contacts, source), 'Mapping applied');
}

function fillSelect(select, headers, value, allowNone) {
  const opts = [];
  if (allowNone) opts.push(h('option', { value: '' }, '(none)'));
  else if (!value) opts.push(h('option', { value: '' }, 'Select a column…'));
  for (const hd of headers) opts.push(h('option', { value: hd, selected: hd === value }, hd));
  setChildren(select, ...opts);
  select.value = value || '';
}

export function render(root, ctx) {
  const c = ctx.state.campaign;
  const has = c.contacts.length > 0;
  const locked = c.status === CAMPAIGN_STATE.RUNNING;

  els.dropzone.classList.toggle('disabled', locked);
  setChildren(els.fileInfo, 
    has ? h('div', { class: 'file-pill' }, h('strong', {}, c.source.fileName || 'Contacts'), h('span', { class: 'muted' }, ` · ${c.contacts.length} rows · ${c.source.headers.length} columns${c.source.loadedAt ? ` · loaded ${formatTime(c.source.loadedAt)}` : ''}`)) : ''
  );

  els.mapping.hidden = !has;
  els.tableCard.hidden = !has;
  if (!has) return;

  if (!els.mapping.contains(document.activeElement)) {
    fillSelect(els.nameSelect, c.source.headers, c.source.nameColumn, true);
    fillSelect(els.phoneSelect, c.source.headers, c.source.phoneColumn, false);
    els.ccInput.value = c.source.defaultCountryCode || '';
    els.dupCheck.checked = c.source.skipDuplicates !== false;
  }
  for (const el of [els.nameSelect, els.phoneSelect, els.ccInput, els.dupCheck]) el.disabled = locked;

  const sum = summarizeIssues(c.contacts);
  const chip = (n, label, tone, filter) =>
    h('button', { class: `chip chip-${tone}${n ? '' : ' chip-zero'}`, onclick: () => { view.filter = filter; els.filter.value = filter; view.page = 0; renderTable(ctx); } }, `${n} ${label}`);
  setChildren(els.summary, 
    chip(c.contacts.filter((x) => x.status === STATUS.PENDING).length, 'ready to send', 'success', STATUS.PENDING),
    chip(sum.invalid_phone + sum.missing_phone, 'invalid / missing numbers', 'danger', STATUS.INVALID),
    chip(sum.duplicate, 'duplicates', 'warning', 'issues'),
    chip(sum.missing_name, 'missing names', 'warning', 'issues'),
    chip(sum.empty_row, 'empty rows', 'muted', STATUS.SKIPPED)
  );

  const includeIds = c.contacts.filter((x) => x.status === STATUS.SKIPPED && !x.invalid && !x.isEmpty).map((x) => x.id);
  const warnIds = c.contacts.filter((x) => x.status === STATUS.PENDING && x.issues.length).map((x) => x.id);
  setChildren(els.bulk, 
    h('button', { class: 'btn btn-ghost btn-sm', disabled: !includeIds.length, onclick: () => guard(() => api.setExcluded(includeIds, false), `${includeIds.length} contacts included`) }, `Include all valid (${includeIds.length})`),
    h('button', { class: 'btn btn-ghost btn-sm', disabled: !warnIds.length, onclick: () => guard(() => api.setExcluded(warnIds, true), `${warnIds.length} contacts skipped`) }, `Skip rows with warnings (${warnIds.length})`)
  );

  renderTable(ctx);
}

function filtered(c) {
  return c.contacts.filter((x) => {
    if (view.filter === 'issues' && !x.issues.length) return false;
    if (view.filter !== 'all' && view.filter !== 'issues' && x.status !== view.filter) return false;
    if (view.search && !`${x.name} ${x.phone} ${x.rawPhone}`.toLowerCase().includes(view.search)) return false;
    return true;
  });
}

function renderTable(ctx) {
  const c = ctx.state.campaign;
  const rows = filtered(c);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  view.page = Math.min(view.page, pages - 1);
  const slice = rows.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
  const editable = new Set([STATUS.PENDING, STATUS.SKIPPED, STATUS.PAUSED]);

  const body = slice.map((x) => {
    const canToggle = !x.invalid && !x.isEmpty && editable.has(x.status) && !(c.status === CAMPAIGN_STATE.RUNNING && c.currentContactId === x.id);
    const preview = x.message || (x.isEmpty || x.invalid ? '' : personalize(c.template, x).text);
    const note = contactNote(x);
    const noteIsError = x.notOnWhatsApp || x.invalid || x.issues.some((i) => i.code === 'missing_phone');
    return h('tr', {
        class: [x.id === ctx.state.selectedId ? 'selected' : '', x.status === STATUS.PROCESSING ? 'processing' : ''].join(' '),
        onclick: (e) => { if (e.target.tagName !== 'INPUT') ctx.select(x.id); },
      },
      h('td', {}, h('input', {
        type: 'checkbox', checked: x.status !== STATUS.SKIPPED && !x.invalid && !x.isEmpty, disabled: !canToggle,
        title: canToggle ? 'Include in campaign' : 'Cannot change this row',
        'aria-label': `Include ${x.name || 'row ' + x.row}`,
        onchange: (e) => guard(() => api.setExcluded([x.id], !e.target.checked)),
      })),
      h('td', { class: 'muted' }, x.row),
      h('td', {}, x.name || h('em', { class: 'muted' }, 'No name')),
      h('td', { class: 'mono' }, x.phone ? `+${x.phone}` : h('span', { class: 'muted' }, x.rawPhone || '-')),
      h('td', { class: 'preview-cell', title: preview }, preview || h('span', { class: 'muted' }, c.template ? '-' : 'Write a message first')),
      h('td', {}, statusBadge(x.status, x.error || null), x.status === STATUS.FAILED && x.error ? h('div', { class: 'issue-text' }, x.error) : null),
      h('td', { class: 'note-cell' }, note ? h('span', { class: noteIsError ? 'note-error' : 'note-warn' }, note) : h('span', { class: 'muted' }, '-'))
    );
  });

  setChildren(els.table, 
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['', '#', 'Name', 'Phone', 'Message preview', 'Status', 'Note'].map((t) => h('th', {}, t)))),
      h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colspan: 7, class: 'empty' }, 'No contacts match this filter.'))))
  );

  setChildren(els.pager, 
    h('span', { class: 'muted' }, `${rows.length} rows${rows.length !== c.contacts.length ? ` (of ${c.contacts.length})` : ''}`),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ghost btn-sm', disabled: view.page === 0, onclick: () => { view.page--; renderTable(ctx); } }, '‹ Prev'),
      h('span', { class: 'muted' }, `Page ${view.page + 1} / ${pages}`),
      h('button', { class: 'btn btn-ghost btn-sm', disabled: view.page >= pages - 1, onclick: () => { view.page++; renderTable(ctx); } }, 'Next ›'))
  );
}
