/** Template management: create, edit, delete, load, preview. */
import { CAMPAIGN_STATE } from '../../constants.js';
import { personalize } from '../../message-template.js';
import { store } from '../../storage.js';
import { api } from '../api.js';
import { h, setChildren, guard, toast, openModal, confirmDialog, formatTime } from '../dom.js';

let list = null;

export function init(root, ctx) {
  list = h('div', { class: 'template-grid' });
  root.append(
    h('div', { class: 'card card-flat' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, 'Message templates'), h('p', { class: 'muted small' }, 'Reusable messages. Placeholders like {Name} are filled per contact.')),
        h('button', { class: 'btn btn-primary', onclick: () => editTemplate(ctx, null) }, '+ New template'))),
    list
  );
}

async function editTemplate(ctx, template) {
  const name = h('input', { class: 'input', type: 'text', maxlength: 80, value: template?.name || '', placeholder: 'Template name' });
  const body = h('textarea', { class: 'input', rows: 8, maxlength: 4096, value: template?.body || '', placeholder: 'Hi {Name}, …' });
  const preview = h('div', { class: 'bubble' });
  const update = () => {
    const contact = ctx.selectedContact();
    preview.textContent = body.value.trim() ? (contact ? personalize(body.value, contact).text : body.value) : 'Preview…';
  };
  body.addEventListener('input', update);
  update();

  const saved = await openModal({
    title: template ? 'Edit template' : 'New template',
    wide: true,
    body: h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Message'), body),
      h('div', {}, h('span', { class: 'field-label' }, 'Preview (selected contact)'), preview)),
    actions: [
      { label: 'Cancel', value: null },
      {
        label: 'Save template',
        variant: 'btn-primary',
        onClick: async () => {
          if (!name.value.trim()) { name.classList.add('input-error'); name.focus(); return false; }
          if (!body.value.trim()) { body.classList.add('input-error'); body.focus(); return false; }
          const saved = await guard(() => store.saveTemplate({ id: template?.id, name: name.value, body: body.value }));
          return saved || false; // keep the dialog open if saving failed
        },
      },
    ],
  });
  if (saved) toast(`Template "${saved.name}" saved`, 'success');
}

function previewTemplate(ctx, t) {
  const c = ctx.state.campaign;
  const samples = c.contacts.filter((x) => !x.isEmpty && !x.invalid).slice(0, 3);
  openModal({
    title: `Preview: ${t.name}`,
    wide: true,
    body: h('div', { class: 'stack' },
      samples.length
        ? samples.map((x) => h('div', {}, h('div', { class: 'muted small' }, `${x.name || '(no name)'} · +${x.phone}`), h('div', { class: 'bubble' }, personalize(t.body, x).text)))
        : [h('p', { class: 'muted small' }, 'Upload contacts to see personalized previews. Raw template:'), h('div', { class: 'bubble' }, t.body)]),
    actions: [{ label: 'Close', value: null }],
  });
}

async function loadTemplate(ctx, t) {
  const c = ctx.state.campaign;
  if (c.status === CAMPAIGN_STATE.RUNNING) return toast('Pause the campaign to change the message.', 'error');
  if (c.template.trim() && c.template !== t.body) {
    const ok = await confirmDialog({ title: 'Load template?', message: `Replace the current campaign message with "${t.name}"?`, confirmLabel: 'Load' });
    if (!ok) return;
  }
  const r = await guard(() => api.updateSetup({ template: t.body }));
  if (r) {
    toast(`Template "${t.name}" loaded into the composer`, 'success');
    ctx.go('message');
  }
}

async function deleteTemplate(t) {
  const ok = await confirmDialog({ title: 'Delete template?', message: `Delete "${t.name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true });
  if (ok) await guard(() => store.deleteTemplate(t.id), 'Template deleted');
}

export function render(root, ctx) {
  const templates = ctx.state.templates;
  if (!templates.length) {
    setChildren(list, h('div', { class: 'empty-state' }, h('strong', {}, 'No templates yet'), h('p', { class: 'muted' }, 'Create one here, or use "Save as template" in the Message section.')));
    return;
  }
  setChildren(list, 
    ...templates.map((t) =>
      h('div', { class: 'card template-card' },
        h('div', { class: 'card-head' }, h('strong', {}, t.name), h('span', { class: 'muted small' }, formatTime(t.updatedAt))),
        h('p', { class: 'template-body' }, t.body),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => loadTemplate(ctx, t) }, 'Load'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => previewTemplate(ctx, t) }, 'Preview'),
          h('button', { class: 'btn btn-ghost btn-sm', onclick: () => editTemplate(ctx, t) }, 'Edit'),
          h('button', { class: 'btn btn-ghost btn-sm text-danger', onclick: () => deleteTemplate(t) }, 'Delete'))))
  );
}
