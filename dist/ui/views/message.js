/** Message composer with placeholder chips, validation and live preview. */
import { CAMPAIGN_STATE, STATUS } from '../../constants.js';
import { personalize, extractPlaceholders, availablePlaceholders, normalizeKey } from '../../message-template.js';
import { store } from '../../storage.js';
import { api } from '../api.js';
import { h, setChildren, debounce, guard, toast, promptDialog, confirmDialog } from '../dom.js';

let els = null;
let saveTemplateDebounced = null;
let lastSaved = null;
const MAX_LEN = 4096;

export function init(root, ctx) {
  saveTemplateDebounced = debounce((value) => {
    lastSaved = value;
    return guard(() => api.updateSetup({ template: value }));
  }, 500);

  const textarea = h('textarea', {
    class: 'input composer',
    rows: 10,
    maxlength: MAX_LEN,
    placeholder: 'Hello {Name}, we have a special offer available in {City}!',
    oninput: (e) => {
      ctx.state.campaign.template = e.target.value; // optimistic local update
      saveTemplateDebounced(e.target.value);
      renderDynamic(ctx);
    },
    onblur: () => {
      if (!textarea.readOnly && textarea.value !== lastSaved) saveTemplateDebounced.flush(textarea.value);
    },
  });

  els = {
    textarea,
    chips: h('div', { class: 'chips' }),
    meta: h('div', { class: 'composer-meta' }),
    warnings: h('div', {}),
    templateSelect: h('select', { class: 'input input-sm', onchange: (e) => loadTemplate(ctx, e.target) }),
    lockNotice: h('div', { class: 'notice notice-info', hidden: true }, 'The campaign is running. Pause it to edit the message.'),
    previewHead: h('div', { class: 'preview-head' }),
    preview: h('div', { class: 'bubble bubble-lg' }),
    previewNotes: h('div', {}),
  };

  root.append(
    h('div', { class: 'grid-2 grid-composer' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h3', { class: 'card-title' }, 'Message'),
          h('div', { class: 'btn-row' },
            els.templateSelect,
            h('button', { class: 'btn btn-ghost btn-sm', onclick: () => saveAsTemplate(ctx) }, 'Save as template'))),
        els.lockNotice,
        h('p', { class: 'muted small' }, 'Click a placeholder to insert it. Use {Column|fallback} for a default when a value is empty, e.g. {City|your city}.'),
        els.chips,
        textarea,
        els.meta,
        els.warnings),
      h('div', { class: 'card' },
        h('h3', { class: 'card-title' }, 'Live preview'),
        els.previewHead,
        h('div', { class: 'phone-frame' }, els.preview),
        els.previewNotes))
  );
}

function insertAtCursor(ta, text) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  ta.value = value.slice(0, s) + text + value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function loadTemplate(ctx, select) {
  const t = ctx.state.templates.find((x) => x.id === select.value);
  select.value = '';
  if (!t) return;
  if (ctx.state.campaign.status === CAMPAIGN_STATE.RUNNING) return toast('Pause the campaign to change the message.', 'error');
  if (els.textarea.value.trim() && els.textarea.value !== t.body) {
    const ok = await confirmDialog({ title: 'Replace message?', message: `Replace the current message with the template "${t.name}"?`, confirmLabel: 'Replace' });
    if (!ok) return;
  }
  els.textarea.value = t.body;
  els.textarea.dispatchEvent(new Event('input', { bubbles: true }));
  saveTemplateDebounced.flush(t.body);
  toast(`Template "${t.name}" loaded`, 'success');
}

async function saveAsTemplate(ctx) {
  const body = els.textarea.value;
  if (!body.trim()) return toast('Write a message first.', 'error');
  const name = await promptDialog({ title: 'Save as template', label: 'Template name', placeholder: 'e.g. Festive offer' });
  if (!name) return;
  await guard(() => store.saveTemplate({ name, body }), `Template "${name}" saved`);
}

/** Things that change on every keystroke. */
function renderDynamic(ctx) {
  const c = ctx.state.campaign;
  const template = els.textarea.value;
  const columnKeys = new Set([...c.source.headers, 'Name', 'First Name', 'Phone'].map(normalizeKey));

  // Meta: length + placeholders used.
  const used = extractPlaceholders(template);
  setChildren(els.meta, 
    h('span', { class: template.length > MAX_LEN * 0.9 ? 'text-danger' : 'muted' }, `${template.length} / ${MAX_LEN} characters`),
    used.length ? h('span', { class: 'muted' }, `Placeholders: ${used.map((p) => `{${p}}`).join(', ')}`) : null
  );

  // Warnings: unknown placeholders + contacts with empty values.
  const warnings = [];
  const unknown = c.contacts.length ? used.filter((p) => !columnKeys.has(normalizeKey(p))) : [];
  if (unknown.length) {
    warnings.push(h('div', { class: 'notice notice-warning' }, `Not found in your CSV columns: ${unknown.map((p) => `{${p}}`).join(', ')}. These will be sent as typed. Check the spelling.`));
  }
  if (c.contacts.length && used.length) {
    const sendable = c.contacts.filter((x) => x.status === STATUS.PENDING || x.status === STATUS.PAUSED);
    const missingCounts = {};
    for (const x of sendable) for (const m of personalize(template, x).missing) missingCounts[m] = (missingCounts[m] || 0) + 1;
    const parts = Object.entries(missingCounts).map(([k, n]) => `{${k}} is empty for ${n} contact${n > 1 ? 's' : ''}`);
    if (parts.length) warnings.push(h('div', { class: 'notice notice-info' }, `${parts.join('; ')}. Empty values are removed; add a fallback like {${Object.keys(missingCounts)[0]}|friend}.`));
  }
  if (!c.contacts.length) warnings.push(h('div', { class: 'notice notice-info' }, 'Upload contacts to see personalized previews and available placeholders.'));
  setChildren(els.warnings, ...warnings);

  renderPreview(ctx, template);
}

function renderPreview(ctx, template) {
  const c = ctx.state.campaign;
  const contact = ctx.selectedContact();
  const list = c.contacts.filter((x) => !x.isEmpty);
  const idx = contact ? list.indexOf(contact) : -1;

  setChildren(els.previewHead, 
    h('button', { class: 'btn btn-ghost btn-sm', disabled: idx <= 0, onclick: () => ctx.select(list[idx - 1].id), 'aria-label': 'Previous contact' }, '‹'),
    h('div', { class: 'preview-contact' },
      contact ? [h('strong', {}, contact.name || '(no name)'), h('span', { class: 'muted mono' }, contact.phone ? ` +${contact.phone}` : ' no valid number')] : h('span', { class: 'muted' }, 'No contact selected')),
    h('button', { class: 'btn btn-ghost btn-sm', disabled: idx < 0 || idx >= list.length - 1, onclick: () => ctx.select(list[idx + 1].id), 'aria-label': 'Next contact' }, '›')
  );

  if (!template.trim()) {
    setChildren(els.preview, h('span', { class: 'muted' }, 'Your message preview appears here.'));
    setChildren(els.previewNotes);
    return;
  }
  const r = contact ? personalize(template, contact) : { text: template, missing: [], unknown: [] };
  setChildren(els.preview, r.text || h('span', { class: 'muted' }, '(empty after personalization)'));
  setChildren(els.previewNotes, 
    r.missing.length ? h('p', { class: 'small text-warning' }, `Empty for this contact: ${r.missing.join(', ')}`) : null,
    h('p', { class: 'muted small' }, 'Tip: click a row in Contacts or use ‹ › to preview other contacts.')
  );
}

export function render(root, ctx) {
  const c = ctx.state.campaign;
  const running = c.status === CAMPAIGN_STATE.RUNNING;

  if (document.activeElement !== els.textarea && els.textarea.value !== c.template) els.textarea.value = c.template;
  els.textarea.readOnly = running;
  els.lockNotice.hidden = !running;

  const placeholders = availablePlaceholders(c.source.headers.filter((hd) => hd !== c.source.phoneColumn), { hasName: true });
  setChildren(els.chips, 
    ...placeholders.map((p) => h('button', { class: 'chip chip-placeholder', disabled: running, title: `Insert {${p}}`, onclick: () => insertAtCursor(els.textarea, `{${p}}`) }, `{${p}}`))
  );

  setChildren(els.templateSelect, 
    h('option', { value: '' }, ctx.state.templates.length ? 'Load template…' : 'No templates yet'),
    ...ctx.state.templates.map((t) => h('option', { value: t.id }, t.name))
  );
  els.templateSelect.disabled = running || !ctx.state.templates.length;

  renderDynamic(ctx);
}
