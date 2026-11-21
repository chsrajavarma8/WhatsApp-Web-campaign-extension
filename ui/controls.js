/**
 * Campaign control buttons + the consent/readiness checks before starting.
 * Shared by the popup and the dashboard.
 */
import { CAMPAIGN_STATE } from '../constants.js';
import { computeStats, describePace, estimateFinish, formatDuration } from '../campaign-manager.js';
import { api } from './api.js';
import { h, setChildren, confirmDialog, guard, toast } from './dom.js';

const { RUNNING, PAUSED, STOPPED, COMPLETED, IDLE } = CAMPAIGN_STATE;

export const CONSENT_TEXT =
  'I confirm every recipient has agreed to receive messages from me, and this campaign complies with WhatsApp\'s Terms of Service and Business/Commerce policies.';

export const STATE_LABEL = {
  [IDLE]: 'Not started',
  [RUNNING]: 'Running',
  [PAUSED]: 'Paused',
  [STOPPED]: 'Stopped',
  [COMPLETED]: 'Completed',
};

/** Makes sure WhatsApp Web is ready; offers to open it if not. Returns boolean. */
export async function ensureWhatsAppReady() {
  const status = await guard(() => api.checkWhatsApp());
  if (!status) return false;
  if (status.state === 'ready') return true;
  if (status.state === 'no_tab') {
    const open = await confirmDialog({
      title: 'WhatsApp Web is not open',
      message: 'Open WhatsApp Web in a tab and log in, then press Start again.',
      confirmLabel: 'Open WhatsApp Web',
    });
    if (open) await guard(() => api.openWhatsApp());
    return false;
  }
  if (status.state === 'no_script') {
    const reload = await confirmDialog({
      title: 'Reload WhatsApp Web',
      message: 'The WhatsApp tab was opened before the extension was installed or updated. Reload it to connect.',
      confirmLabel: 'Reload tab',
    });
    if (reload) await guard(() => api.reloadWhatsApp());
    return false;
  }
  toast(status.label, 'error', 6000);
  return false;
}

const fact = (label, value) => h('div', { class: 'confirm-fact' }, h('span', {}, label), h('strong', {}, value));

async function startOrResume(campaign, isResume) {
  if (!(await ensureWhatsAppReady())) return;
  const stats = computeStats(campaign);
  const ok = await confirmDialog({
    title: isResume ? 'Resume campaign' : 'Start campaign',
    message: h(
      'div',
      {},
      h('div', { class: 'confirm-facts' },
        fact('Contacts', `${stats.pending} pending`),
        fact('Pace', `1 message every ${describePace(campaign.settings.delayBetween)}`),
        fact('Session limit', `${campaign.settings.maxPerSession} messages, then pause`),
        fact('Takes about', formatDuration((estimateFinish(campaign) ?? Date.now()) - Date.now()))),
      h('p', { class: 'muted' }, 'Keep the WhatsApp Web tab open. You can pause or stop at any time.')
    ),
    confirmLabel: isResume ? 'Resume' : 'Start sending',
    requireCheck: CONSENT_TEXT,
  });
  if (!ok) return;
  await guard(() => (isResume ? api.resume() : api.start()), isResume ? 'Campaign resumed' : 'Campaign started');
}

/**
 * Renders the main control buttons for the given campaign state.
 * @param {HTMLElement} container
 * @param {object} campaign
 * @param {{extended?: boolean, onTest?: Function}} opts extended adds Reset/Test buttons
 */
export function renderControls(container, campaign, { extended = false, onTest } = {}) {
  const status = campaign?.status || IDLE;
  const hasContacts = !!campaign?.contacts?.length;
  const buttons = [];

  if (status === RUNNING) {
    buttons.push(h('button', { class: 'btn btn-warning', onclick: () => guard(() => api.pause(), 'Pausing…') }, 'Pause'));
    buttons.push(h('button', { class: 'btn btn-danger-outline', onclick: stopClicked }, 'Stop'));
  } else if (status === PAUSED) {
    buttons.push(h('button', { class: 'btn btn-primary', onclick: () => startOrResume(campaign, true) }, 'Resume'));
    buttons.push(h('button', { class: 'btn btn-danger-outline', onclick: stopClicked }, 'Stop'));
  } else {
    buttons.push(
      h(
        'button',
        { class: 'btn btn-primary', disabled: !hasContacts, title: hasContacts ? null : 'Upload contacts first', onclick: () => startOrResume(campaign, false) },
        status === STOPPED ? 'Start (continue)' : 'Start Sending'
      )
    );
  }

  if (extended) {
    buttons.push(
      h('button', { class: 'btn btn-secondary', disabled: status === RUNNING || !hasContacts, onclick: () => onTest?.() }, 'Send Test Message')
    );
    buttons.push(
      h(
        'button',
        {
          class: 'btn btn-ghost',
          disabled: status === RUNNING || !hasContacts,
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Reset campaign?',
              message: 'All statuses go back to Pending and the activity log is cleared. Contacts and message are kept. Export results first if you need them.',
              confirmLabel: 'Reset',
              danger: true,
            });
            if (ok) await guard(() => api.reset(), 'Campaign reset');
          },
        },
        'Reset Campaign'
      )
    );
  }
  setChildren(container, ...buttons);
}

async function stopClicked() {
  const ok = await confirmDialog({
    title: 'Stop campaign?',
    message: 'Sending stops after the current step. Unsent contacts stay Pending so you can start again later.',
    confirmLabel: 'Stop',
    danger: true,
  });
  if (ok) await guard(() => api.stop(), 'Campaign stopped');
}
