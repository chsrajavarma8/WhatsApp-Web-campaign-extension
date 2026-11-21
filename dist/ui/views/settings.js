/** Campaign settings: sending pace (presets + custom), delays, session limit, chat opening mode. */
import { DEFAULT_SETTINGS, SETTING_BOUNDS, PACE_PRESETS } from '../../constants.js';
import { computeStats, describePace, formatDuration, estimatedWorkSeconds } from '../../campaign-manager.js';
import { api } from '../api.js';
import { h, icon, cardHead, setChildren, guard, formatNumber } from '../dom.js';

const FIELDS = [
  { key: 'delayBeforeOpen', label: 'Delay before opening a chat', unit: 'seconds', hint: 'Pause before the next chat is opened.' },
  { key: 'delayBeforeSend', label: 'Delay before sending', unit: 'seconds', hint: 'Time the message sits in the box before Send is pressed, so you can watch it.' },
  { key: 'maxPerSession', label: 'Maximum messages per session', unit: 'messages', hint: 'The campaign pauses after this many messages. Press Resume to continue.' },
  { key: 'chatLoadTimeout', label: 'Chat load timeout', unit: 'seconds', hint: 'How long to wait for WhatsApp Web and the chat to load before marking a contact as failed.' },
];

const UNITS = [
  { value: 1, label: 'seconds' },
  { value: 60, label: 'minutes' },
  { value: 3600, label: 'hours' },
];

let inputs = null;
let focusInput = null;
let modeSelect = null;
let pace = null; // { tiles: Map<seconds, el>, customTile, customValue, customUnit, summary }

export function init(root, ctx) {
  /* ---------------- pace card ---------------- */
  const [paceMin, paceMax] = SETTING_BOUNDS.delayBetween;
  pace = { tiles: new Map() };
  const tiles = PACE_PRESETS.map((p) => {
    const tile = h('button', { type: 'button', class: 'pace-tile', 'aria-pressed': 'false', onclick: () => setPace(p.seconds) },
      h('strong', {}, p.label),
      h('span', {}, perHour(p.seconds)));
    pace.tiles.set(p.seconds, tile);
    return tile;
  });

  pace.customValue = h('input', { class: 'input', type: 'number', min: 1, step: 1, 'aria-label': 'Custom pace value' });
  pace.customUnit = h('select', { class: 'input', 'aria-label': 'Custom pace unit' }, UNITS.map((u) => h('option', { value: u.value }, u.label)));
  const applyCustom = () => {
    const seconds = Math.round(Number(pace.customValue.value) * Number(pace.customUnit.value));
    if (!Number.isFinite(seconds) || seconds < paceMin || seconds > paceMax) {
      pace.customValue.setCustomValidity(`Choose between ${describePace(paceMin)} and ${describePace(paceMax)}.`);
      pace.customValue.reportValidity();
      return;
    }
    pace.customValue.setCustomValidity('');
    setPace(seconds);
  };
  pace.customValue.addEventListener('input', () => pace.customValue.setCustomValidity(''));
  pace.customValue.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyCustom(); } });
  pace.customTile = h('div', { class: 'pace-custom' },
    h('span', { class: 'field-label' }, 'Custom: 1 message every'),
    h('div', { class: 'pace-custom-row' }, pace.customValue, pace.customUnit,
      h('button', { type: 'button', class: 'btn btn-primary', onclick: applyCustom }, 'Apply')));
  pace.summary = h('div', { class: 'pace-summary' });

  const paceCard = h('div', { class: 'card' },
    cardHead('gauge', 'Sending pace', 'How often a message is sent. Measured from the start of one message to the start of the next. Changes apply immediately, even while a campaign is running.'),
    h('div', { class: 'pace-grid' }, tiles),
    pace.customTile,
    pace.summary);

  /* ---------------- other settings ---------------- */
  inputs = {};
  const rows = FIELDS.map((f) => {
    const [min, max] = SETTING_BOUNDS[f.key];
    inputs[f.key] = h('input', { class: 'input', type: 'number', min, max, step: 1, required: true });
    return h('label', { class: 'field' },
      h('span', { class: 'field-label' }, f.label),
      h('div', { class: 'input-unit' }, inputs[f.key], h('span', {}, f.unit)),
      h('span', { class: 'field-hint' }, `${f.hint} (${min}–${max})`));
  });
  focusInput = h('input', { type: 'checkbox' });
  modeSelect = h('select', { class: 'input' },
    h('option', { value: 'fast' }, 'Fast: open chats without reloading WhatsApp (automatic fallback to reload)'),
    h('option', { value: 'reload' }, 'Reliable: reload WhatsApp Web for every contact'));
  rows.unshift(h('label', { class: 'field field-wide' },
    h('span', { class: 'field-label' }, 'How to open each chat'),
    modeSelect,
    h('span', { class: 'field-hint' }, 'Fast mode opens the chat inside the already-loaded page, like clicking a number link. If WhatsApp does not support it, that contact is opened with a reload, and after 2 misses the rest of the run uses reload. The Activity Log shows which method was used.')));

  const form = h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    cardHead('clock', 'Timing and limits', 'Fine-tune each step of sending a message.'),
    h('div', { class: 'form-grid' }, rows),
    h('label', { class: 'check-row' }, focusInput, h('span', {}, 'Bring the WhatsApp tab to the front while sending (more reliable; browsers slow down background tabs)')),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { fill(DEFAULT_SETTINGS); save(DEFAULT_SETTINGS.delayBetween); } }, 'Restore defaults'))
  );

  root.append(
    paceCard,
    form,
    h('div', { class: 'card notice-card' },
      cardHead('shield', 'Responsible use'),
      h('ul', { class: 'plain-list' },
        h('li', {}, 'Only message people who have agreed to hear from you. Unwanted messages get reported and can get your WhatsApp account banned.'),
        h('li', {}, 'Messages are sent one at a time through the normal WhatsApp Web interface, at the pace you set here. A slower pace is gentler on recipients and on your account.'),
        h('li', {}, 'This extension does not and will not bypass WhatsApp limits, restrictions or spam protection.'),
        h('li', {}, 'For large-scale or marketing messaging, use the official WhatsApp Business Platform.')))
  );
}

function perHour(seconds) {
  const n = 3600 / seconds;
  return n >= 1 ? `≈ ${formatNumber(Math.round(n))} per hour` : `≈ ${formatNumber(Math.round(n * 24))} per day`;
}

async function setPace(seconds) {
  await guard(() => api.updateSetup({ settings: { delayBetween: seconds } }), `Pace set: 1 message every ${describePace(seconds)}`);
}

function renderPace(ctx) {
  const c = ctx.state.campaign;
  const seconds = c.settings.delayBetween;
  let matched = false;
  for (const [s, tile] of pace.tiles) {
    const on = s === seconds;
    matched ||= on;
    tile.classList.toggle('active', on);
    tile.setAttribute('aria-pressed', String(on));
  }
  pace.customTile.classList.toggle('active', !matched);
  if (![pace.customValue, pace.customUnit].includes(document.activeElement)) {
    const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
    pace.customUnit.value = String(unit);
    pace.customValue.value = String(seconds / unit);
  }

  // Real per-message time can't be shorter than the work of opening + sending.
  const effective = Math.max(seconds, estimatedWorkSeconds(c.settings) + 5);
  const pending = computeStats(c).pending;
  const items = [
    h('span', {}, icon('gauge', 15), h('strong', {}, `1 every ${describePace(seconds)}`)),
    h('span', {}, icon('clock', 15), perHour(effective)),
  ];
  if (pending) items.push(h('span', {}, icon('flag', 15), `${formatNumber(pending)} pending ≈ ${formatDuration(Math.max(0, pending - 1) * effective * 1000 + estimatedWorkSeconds(c.settings) * 1000)}`));
  const notes = [];
  if (seconds < estimatedWorkSeconds(c.settings) + 5) {
    notes.push(h('p', { class: 'field-hint' }, `Opening and sending each message takes about ${estimatedWorkSeconds(c.settings)}s, so the real pace will be a little slower than this.`));
  }
  if (seconds >= 900) {
    notes.push(h('p', { class: 'field-hint' }, 'Long waits are fine: keep Chrome and the WhatsApp Web tab open (the computer must stay awake). If the browser is closed, the campaign pauses; press Resume and it continues at the same pace.'));
  }
  setChildren(pace.summary, h('div', { class: 'pace-summary-row' }, items), ...notes);
}

function fill(settings) {
  for (const f of FIELDS) inputs[f.key].value = settings[f.key];
  focusInput.checked = !!settings.focusWhatsAppTab;
  modeSelect.value = settings.openMode === 'reload' ? 'reload' : 'fast';
}

async function save(delayBetween) {
  const settings = { focusWhatsAppTab: focusInput.checked, openMode: modeSelect.value };
  if (delayBetween) settings.delayBetween = delayBetween;
  for (const f of FIELDS) {
    const input = inputs[f.key];
    if (!input.checkValidity()) {
      input.reportValidity();
      return;
    }
    settings[f.key] = Number(input.value);
  }
  await guard(() => api.updateSetup({ settings }), 'Settings saved');
}

export function render(root, ctx) {
  renderPace(ctx);
  const formHasFocus = [...Object.values(inputs), modeSelect, focusInput].includes(document.activeElement);
  if (!formHasFocus) fill(ctx.state.campaign.settings);
}
