/**
 * Dashboard entry point: routing between views, shared state, and live
 * updates from chrome.storage (the background worker writes the campaign).
 */
import { KEYS, store, onStorageKeyChanged } from './storage.js';
import { CAMPAIGN_STATE, STATUS } from './constants.js';
import { normalizeCampaign } from './campaign-manager.js';
import { api } from './ui/api.js';
import { h, setChildren, $, $$, guard } from './ui/dom.js';
import { renderControls, STATE_LABEL } from './ui/controls.js';
import * as overview from './ui/views/overview.js';
import * as contacts from './ui/views/contacts.js';
import * as message from './ui/views/message.js';
import * as templates from './ui/views/templates.js';
import * as test from './ui/views/test.js';
import * as settings from './ui/views/settings.js';
import * as log from './ui/views/log.js';
import * as drafts from './ui/views/drafts.js';

const VIEWS = {
  overview: { title: 'Overview', mod: overview },
  contacts: { title: 'Contacts', mod: contacts },
  message: { title: 'Message', mod: message },
  templates: { title: 'Templates', mod: templates },
  test: { title: 'Test Mode', mod: test },
  settings: { title: 'Settings', mod: settings },
  log: { title: 'Activity Log', mod: log },
  drafts: { title: 'Drafts', mod: drafts },
};

const state = {
  campaign: null,
  templates: [],
  drafts: [],
  wa: null,
  selectedId: null,
  view: 'overview',
};

const ctx = {
  state,
  /** Selects a contact for previews (Message, Test). */
  select(id) {
    state.selectedId = id;
    renderActive();
  },
  /** The selected contact, or the first sendable one. */
  selectedContact() {
    const list = state.campaign?.contacts || [];
    return (
      list.find((c) => c.id === state.selectedId) ||
      list.find((c) => c.status === STATUS.PENDING) ||
      list.find((c) => !c.isEmpty) ||
      null
    );
  },
  go(view) {
    if (!VIEWS[view]) return;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    state.view = view;
    renderShell();
    renderActive();
    window.scrollTo({ top: 0 });
  },
  rerender: () => renderActive(),
};

function renderShell() {
  for (const btn of $$('.nav-item')) btn.classList.toggle('active', btn.dataset.view === state.view);
  for (const [name] of Object.entries(VIEWS)) $(`#view-${name}`).hidden = name !== state.view;
  $('#view-title').textContent = VIEWS[state.view].title;
  document.title = `${VIEWS[state.view].title} · Campaign Sender`;
}

function renderTopbar() {
  const c = state.campaign;
  const pill = $('#campaign-pill');
  pill.textContent = STATE_LABEL[c.status] || c.status;
  pill.className = `pill pill-${c.status}`;
  renderControls($('#controls'), c, { extended: true, onTest: () => ctx.go('test') });

  const banner = $('#error-banner');
  if (c.lastError && c.status !== CAMPAIGN_STATE.RUNNING) {
    setChildren(banner, 
      h('div', { class: 'notice notice-error banner-row' },
        h('span', {}, h('strong', {}, 'Campaign paused: '), c.lastError),
        h('button', { class: 'btn btn-secondary btn-sm', onclick: () => guard(() => api.openWhatsApp()) }, 'Open WhatsApp Web'))
    );
  } else {
    setChildren(banner);
  }
}

function renderWaStatus() {
  const wa = state.wa;
  const tone = !wa ? 'unknown' : wa.state === 'ready' ? 'ok' : wa.state === 'loading' ? 'warn' : 'bad';
  const actions = [];
  if (wa && (wa.state === 'no_tab' || wa.state === 'not_logged_in' || wa.state === 'loading')) {
    actions.push(h('button', { class: 'btn btn-secondary btn-sm', onclick: () => guard(() => api.openWhatsApp()) }, wa.state === 'no_tab' ? 'Open WhatsApp Web' : 'Show tab'));
  }
  if (wa?.state === 'no_script') {
    actions.push(h('button', { class: 'btn btn-secondary btn-sm', onclick: () => guard(() => api.reloadWhatsApp(), 'Reloading WhatsApp tab…') }, 'Reload tab'));
  }
  setChildren($('#wa-status'), 
    h('div', { class: 'wa-status-row' }, h('span', { class: `dot dot-${tone}` }), h('div', {}, h('strong', {}, 'WhatsApp Web'), h('div', { class: 'muted small' }, wa?.label || 'Checking…'))),
    actions.length ? h('div', { class: 'btn-row' }, actions) : null
  );
}

function renderActive() {
  if (!state.campaign) return;
  renderTopbar();
  const { mod } = VIEWS[state.view];
  mod.render($(`#view-${state.view}`), ctx);
}

async function pollWhatsApp() {
  const status = await api.checkWhatsApp().catch(() => null);
  const changed = JSON.stringify(status) !== JSON.stringify(state.wa);
  state.wa = status;
  if (changed) {
    renderWaStatus();
    if (state.view === 'overview') renderActive();
  }
}

async function boot() {
  const [campaign, tpl, drf] = await Promise.all([api.getState(), store.getTemplates(), store.getDrafts()]);
  state.campaign = normalizeCampaign(campaign);
  state.templates = tpl;
  state.drafts = drf;

  for (const [name, { mod }] of Object.entries(VIEWS)) mod.init($(`#view-${name}`), ctx);

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) ctx.go(btn.dataset.view);
  });
  window.addEventListener('hashchange', () => ctx.go(location.hash.slice(1)));

  onStorageKeyChanged(KEYS.CAMPAIGN, (value) => {
    state.campaign = normalizeCampaign(value);
    renderActive();
  });
  onStorageKeyChanged(KEYS.TEMPLATES, (value) => {
    state.templates = value || [];
    renderActive();
  });
  onStorageKeyChanged(KEYS.DRAFTS, (value) => {
    state.drafts = value || [];
    renderActive();
  });

  const initial = location.hash.slice(1);
  ctx.go(VIEWS[initial] ? initial : state.campaign.contacts.length ? 'overview' : 'contacts');
  renderWaStatus();
  pollWhatsApp();
  setInterval(pollWhatsApp, 5000);
}

boot().catch((err) => {
  setChildren(document.body, 
    h('div', { class: 'fatal' }, h('h2', {}, 'The dashboard could not start'), h('p', {}, err?.message || String(err)), h('p', { class: 'muted' }, 'Try reloading the extension from chrome://extensions.'))
  );
});
