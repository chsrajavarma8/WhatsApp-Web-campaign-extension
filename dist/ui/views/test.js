/** Test mode: send ONE message to a chosen contact or your own number, without starting the campaign. */
import { CAMPAIGN_STATE, STATUS } from '../../constants.js';
import { personalize } from '../../message-template.js';
import { normalizePhone } from '../../contacts.js';
import { api } from '../api.js';
import { h, setChildren, guard, toast, confirmDialog } from '../dom.js';
import { ensureWhatsAppReady } from '../controls.js';

let els = null;
let sending = false;

export function init(root, ctx) {
  els = {
    contactSelect: h('select', { class: 'input', onchange: (e) => ctx.select(e.target.value) }),
    overrideCheck: h('input', { type: 'checkbox', onchange: () => renderPreview(ctx) }),
    overrideInput: h('input', { class: 'input', type: 'tel', placeholder: 'e.g. 919876543210 (your own number)', oninput: () => renderPreview(ctx) }),
    recipient: h('div', { class: 'recipient' }),
    preview: h('div', { class: 'bubble bubble-lg' }),
    sendBtn: h('button', { class: 'btn btn-primary', onclick: () => sendTest(ctx) }, 'Send Test Message'),
    result: h('div', {}),
    lock: h('div', { class: 'notice notice-info', hidden: true }, 'Pause the campaign to send a test message.'),
  };

  root.append(
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' },
        h('h3', { class: 'card-title' }, 'Test mode'),
        h('p', { class: 'muted small' }, 'Sends a single personalized message so you can check how it looks in WhatsApp. It does not start the campaign.'),
        els.lock,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Personalize using contact'), els.contactSelect),
        h('label', { class: 'check-row' }, els.overrideCheck, h('span', {}, 'Send to a different number instead (recommended: your own)')),
        els.overrideInput,
        els.recipient,
        h('div', { class: 'btn-row' }, els.sendBtn),
        els.result),
      h('div', { class: 'card' }, h('h3', { class: 'card-title' }, 'Message preview'), h('div', { class: 'phone-frame' }, els.preview)))
  );
}

function target(ctx) {
  const c = ctx.state.campaign;
  const contact = ctx.selectedContact();
  if (els.overrideCheck.checked) {
    const p = normalizePhone(els.overrideInput.value, c.source.defaultCountryCode);
    return { contact, phone: p.valid ? p.phone : '', error: els.overrideInput.value ? p.message : 'Enter a test number' };
  }
  if (!contact) return { contact, phone: '', error: 'Upload contacts first' };
  if (!contact.phone) return { contact, phone: '', error: 'This contact has no valid number' };
  return { contact, phone: contact.phone, error: '' };
}

function renderPreview(ctx) {
  const c = ctx.state.campaign;
  els.overrideInput.hidden = !els.overrideCheck.checked;
  const t = target(ctx);
  const text = t.contact ? personalize(c.template, t.contact).text : c.template;
  setChildren(els.preview, text || h('span', { class: 'muted' }, 'Write a message first.'));
  setChildren(els.recipient, 
    t.phone
      ? h('span', {}, 'Will send to ', h('strong', { class: 'mono' }, `+${t.phone}`), t.contact && !els.overrideCheck.checked ? ` (${t.contact.name || 'no name'})` : '')
      : h('span', { class: 'text-danger' }, t.error)
  );
  const running = c.status === CAMPAIGN_STATE.RUNNING;
  els.lock.hidden = !running;
  els.sendBtn.disabled = running || sending || !t.phone || !text;
  els.sendBtn.textContent = sending ? 'Sending…' : 'Send Test Message';
}

async function sendTest(ctx) {
  const c = ctx.state.campaign;
  const t = target(ctx);
  const text = t.contact ? personalize(c.template, t.contact).text : c.template;
  if (!t.phone || !text) return;

  const ok = await confirmDialog({
    title: 'Send test message?',
    message: h('div', { class: 'stack' },
      h('p', {}, 'Recipient: ', h('strong', { class: 'mono' }, `+${t.phone}`)),
      h('div', { class: 'bubble' }, text),
      h('p', { class: 'muted small' }, 'The WhatsApp Web tab will open this chat and send the message.')),
    confirmLabel: 'Send test',
    requireCheck: 'I confirm the recipient and message are correct and the recipient expects this message.',
  });
  if (!ok || !(await ensureWhatsAppReady())) return;

  sending = true;
  renderPreview(ctx);
  setChildren(els.result, h('div', { class: 'notice notice-info' }, 'Opening chat and sending…'));
  const result = await guard(() =>
    api.sendTest({ contactId: t.contact?.id, phone: els.overrideCheck.checked ? t.phone : undefined, message: text })
  );
  sending = false;
  renderPreview(ctx);

  if (!result) {
    setChildren(els.result);
    return;
  }
  if (!result.ok) {
    setChildren(els.result, h('div', { class: 'notice notice-error' }, `Test failed: ${result.error || result.code}`));
    return;
  }
  setChildren(els.result, h('div', { class: 'notice notice-success' }, `Test message sent to +${result.phone}.`));
  toast('Test message sent', 'success');

  // Avoid messaging the same person twice when the campaign runs.
  if (!els.overrideCheck.checked && t.contact && t.contact.status === STATUS.PENDING) {
    const skip = await confirmDialog({
      title: 'Skip this contact in the campaign?',
      message: `${t.contact.name || 'This contact'} already received the test message. Skip them when the campaign runs?`,
      confirmLabel: 'Skip contact',
    });
    if (skip) await guard(() => api.setExcluded([t.contact.id], true), 'Contact will be skipped');
  }
}

export function render(root, ctx) {
  const c = ctx.state.campaign;
  const options = c.contacts.filter((x) => !x.isEmpty).slice(0, 2000);
  const selected = ctx.selectedContact();
  setChildren(els.contactSelect, 
    ...(options.length
      ? options.map((x) => h('option', { value: x.id, selected: x.id === selected?.id }, `#${x.row} ${x.name || '(no name)'}: ${x.phone ? '+' + x.phone : 'invalid number'} [${x.status}]`))
      : [h('option', { value: '' }, 'No contacts uploaded')])
  );
  els.contactSelect.disabled = !options.length;
  renderPreview(ctx);
}
