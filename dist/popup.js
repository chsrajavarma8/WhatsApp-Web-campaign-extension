/** Popup: compact live status, statistics and controls. Full setup lives in the dashboard. */
import { KEYS, onStorageKeyChanged } from './storage.js';
import { CAMPAIGN_STATE } from './constants.js';
import { computeStats, normalizeCampaign, isEligible, describePace, estimateFinish, formatDuration } from './campaign-manager.js';
import { api } from './ui/api.js';
import { h, icon, setChildren, $, guard, formatNumber, formatClock } from './ui/dom.js';
import { renderControls, STATE_LABEL } from './ui/controls.js';
import { exportResults } from './ui/export.js';

let campaign = null;
let wa = null;

function openDashboard(hash = '') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
  window.close();
}

function renderWa() {
  const tone = !wa ? 'unknown' : wa.state === 'ready' ? 'ok' : wa.state === 'loading' ? 'warn' : 'bad';
  const line = $('#wa-line');
  const parts = [h('span', { class: `dot dot-${tone}` }), wa?.label || 'Checking WhatsApp…'];
  if (wa && wa.state !== 'ready') {
    parts.push(
      h('button', {
        class: 'link-btn',
        onclick: () => guard(() => (wa.state === 'no_script' ? api.reloadWhatsApp() : api.openWhatsApp())),
      }, wa.state === 'no_script' ? 'Reload' : 'Open')
    );
  }
  setChildren(line, ...parts);
}

function stat(label, value, tone) {
  return h('div', { class: `mini-stat mini-${tone}` }, h('strong', {}, formatNumber(value)), h('span', {}, label));
}

function render() {
  const body = $('#popup-body');
  if (!campaign) return;
  const c = campaign;

  if (!c.contacts.length) {
    setChildren(body, 
      h('div', { class: 'empty-state' },
        h('strong', {}, 'No campaign yet'),
        h('p', { class: 'muted' }, 'Open the dashboard to upload a CSV of contacts and write your personalized message.'),
        h('button', { class: 'btn btn-secondary', onclick: () => openDashboard('#contacts') }, 'Upload contacts'))
    );
    return;
  }

  const s = computeStats(c);
  const current = c.contacts.find((x) => x.id === c.currentContactId);
  let currentLine = null;
  if (current) {
    currentLine = h('div', { class: 'current-line' }, h('span', { class: 'pulse' }), h('span', {}, 'Sending to ', h('strong', {}, current.name || `+${current.phone}`), '…'));
  } else if (c.status === CAMPAIGN_STATE.RUNNING && c.waitingUntil) {
    const next = c.contacts.find(isEligible);
    currentLine = h('div', { class: 'current-line current-wait' },
      h('div', { class: 'grow' },
        h('span', { class: 'muted small' }, 'Next message in'),
        h('strong', { class: 'popup-countdown' }, formatClock(c.waitingUntil - Date.now())),
        next ? h('span', { class: 'small truncate' }, `→ ${next.name || '+' + next.phone}`) : null),
      h('button', { class: 'btn btn-secondary btn-sm', title: 'End this wait and send now', onclick: () => guard(() => api.skipWait(), 'Sending next message now') }, icon('skip', 14), 'Send now'));
  }
  const eta = s.pending && c.status !== CAMPAIGN_STATE.COMPLETED ? estimateFinish(c) : null;
  const paceLine = h('button', { class: 'pace-chip pace-chip-sm', title: 'Change pace in Settings', onclick: () => openDashboard('#settings') },
    icon('gauge', 14), `1 every ${describePace(c.settings.delayBetween)}`,
    eta ? h('span', { class: 'muted' }, ` · ~${formatDuration(eta - Date.now())} left`) : null);

  const controls = h('div', { class: 'controls controls-popup' });
  renderControls(controls, c);

  setChildren(body, 
    h('div', { class: 'campaign-head' },
      h('strong', { class: 'truncate', title: c.name }, c.name),
      h('span', { class: `pill pill-${c.status}` }, STATE_LABEL[c.status] || c.status)),
    paceLine,
    h('div', { class: 'progress-head' }, h('span', {}, `Progress: ${s.processed} / ${s.total}`), h('strong', {}, `${s.percent}%`)),
    h('div', { class: 'progress' }, h('div', { class: 'progress-bar', style: { width: `${s.percent}%` } })),
    h('div', { class: 'mini-stats' },
      stat('Sent', s.sent, 'success'),
      stat('Pending', s.pending, 'info'),
      stat('Failed', s.failed, 'danger'),
      stat('Skipped', s.skipped + s.invalid, 'muted')),
    currentLine,
    c.lastError && c.status !== CAMPAIGN_STATE.RUNNING ? h('div', { class: 'notice notice-error small' }, c.lastError) : null,
    controls,
    h('div', { class: 'btn-row popup-links' },
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => exportResults(c) }, 'Export results'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openDashboard('#log') }, 'View log'),
      h('button', { class: 'btn btn-ghost btn-sm', onclick: () => openDashboard('#test') }, 'Test message'))
  );
}

async function pollWa() {
  wa = await api.checkWhatsApp().catch(() => null);
  renderWa();
}

async function boot() {
  $('#open-dashboard').addEventListener('click', () => openDashboard());
  campaign = normalizeCampaign(await api.getState());
  render();
  onStorageKeyChanged(KEYS.CAMPAIGN, (value) => {
    campaign = normalizeCampaign(value);
    render();
  });
  setInterval(render, 1000); // countdown
  pollWa();
  setInterval(pollWa, 4000);
}

boot().catch((err) => {
  setChildren($('#popup-body'), h('div', { class: 'notice notice-error' }, `Could not load: ${err?.message || err}`));
});
