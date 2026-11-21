/** Overview: live status hero (countdown, pace, ETA), statistics, progress, checklist, activity. */
import { CAMPAIGN_STATE, STATUS } from '../../constants.js';
import { computeStats, isEligible, estimateFinish, describePace, formatDuration, nextDueAt } from '../../campaign-manager.js';
import { api } from '../api.js';
import { h, svg, icon, cardHead, setChildren, debounce, guard, formatNumber, formatTime, formatClock, statusBadge } from '../dom.js';
import { exportResults } from '../export.js';

const { RUNNING, PAUSED, STOPPED, COMPLETED, IDLE } = CAMPAIGN_STATE;
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

let els = null;
let tickTimer = null;

export function init(root, ctx) {
  const nameInput = h('input', {
    class: 'hero-name',
    type: 'text',
    maxlength: 120,
    placeholder: 'Campaign name',
    'aria-label': 'Campaign name',
    oninput: debounce((e) => guard(() => api.updateSetup({ name: e.target.value })), 600),
  });

  const ringArc = svg('circle', { class: 'ring-arc', cx: 60, cy: 60, r: RING_R, 'stroke-dasharray': RING_C, 'stroke-dashoffset': RING_C });
  els = {
    nameInput,
    ringArc,
    ringMain: h('strong', { class: 'ring-main' }),
    ringSub: h('span', { class: 'ring-sub' }),
    ring: null,
    heroLines: h('div', { class: 'hero-lines' }),
    heroActions: h('div', { class: 'hero-actions' }),
    stats: h('div', { class: 'stats-grid' }),
    progress: h('div', { class: 'card' }),
    current: h('div', { class: 'card' }),
    checklist: h('div', { class: 'card' }),
    actions: h('div', { class: 'card' }),
    activity: h('div', { class: 'card' }),
  };
  els.ring = h('div', { class: 'ring' },
    svg('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true' },
      svg('circle', { class: 'ring-track', cx: 60, cy: 60, r: RING_R }), ringArc),
    h('div', { class: 'ring-label' }, els.ringMain, els.ringSub));

  root.append(
    h('div', { class: 'card hero' },
      els.ring,
      h('div', { class: 'hero-body' },
        h('div', { class: 'hero-title-row' }, nameInput),
        els.heroLines),
      els.heroActions),
    els.stats,
    h('div', { class: 'grid-2' }, els.progress, els.current),
    h('div', { class: 'grid-2' }, els.checklist, h('div', { class: 'stack' }, els.actions, els.activity))
  );

  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (!root.hidden) renderLive(ctx);
  }, 1000);
}

/* ------------------------------------------------------------------ */

function statCard(label, value, tone, iconName, total) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return h('div', { class: `stat stat-${tone}` },
    h('div', { class: 'stat-top' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-icon' }, icon(iconName, 16))),
    h('strong', { class: 'stat-value' }, formatNumber(value)),
    total != null ? h('span', { class: 'stat-sub' }, `${pct}% of contacts`) : h('span', { class: 'stat-sub' }, 'in this campaign'));
}

function setRing(fraction, main, sub, tone) {
  const f = Math.min(1, Math.max(0, fraction));
  els.ringArc.setAttribute('stroke-dashoffset', String(RING_C * (1 - f)));
  els.ring.className = `ring ring-${tone}`;
  els.ringMain.textContent = main;
  els.ringSub.textContent = sub;
}

/** Everything that changes every second: ring, countdown, ETA, current contact. */
function renderLive(ctx) {
  const c = ctx.state.campaign;
  if (!c || !els) return;
  const now = Date.now();
  const s = computeStats(c);
  const current = c.contacts.find((x) => x.id === c.currentContactId);
  const next = c.contacts.find((x) => isEligible(x) && x.id !== c.currentContactId);
  const waiting = c.status === RUNNING && c.waitingUntil && !current;

  // ---- ring ----
  if (waiting) {
    const span = Math.max(1, c.waitingUntil - (c.pace?.lastFinishedAt || now));
    setRing((c.waitingUntil - now) / span, formatClock(c.waitingUntil - now), 'until next', 'wait');
  } else if (current) {
    setRing(1, 'Sending', current.name || `+${current.phone}`, 'busy');
  } else {
    setRing(s.percent / 100, `${s.percent}%`, c.status === COMPLETED ? 'complete' : 'processed', c.status === COMPLETED ? 'done' : 'idle');
  }

  // ---- hero lines ----
  const lines = [];
  lines.push(h('button', { class: 'pace-chip', title: 'Change the sending pace', onclick: () => ctx.go('settings') },
    icon('gauge', 15), `1 message every ${describePace(c.settings.delayBetween)}`, h('span', { class: 'pace-chip-edit' }, 'Change')));

  const eta = s.pending ? estimateFinish(c, now) : null;
  if (eta && c.status !== COMPLETED) {
    const limited = s.pending > c.settings.maxPerSession;
    lines.push(h('p', { class: 'hero-line' }, icon('flag', 15),
      h('span', {}, `${c.status === RUNNING ? 'Estimated finish' : 'If started now, finishes'} `, h('strong', {}, timeOfDay(eta)),
        ` · ${formatDuration(eta - now)} for ${formatNumber(s.pending)} contact${s.pending === 1 ? '' : 's'}`,
        limited ? h('span', { class: 'muted' }, ` (pauses every ${c.settings.maxPerSession} messages)`) : null)));
  } else if (c.status === COMPLETED) {
    lines.push(h('p', { class: 'hero-line' }, icon('check', 15), `Finished ${formatTime(c.finishedAt)}`));
  }

  if (waiting && next) {
    lines.push(h('p', { class: 'hero-line' }, icon('send', 15), h('span', {}, 'Next: ', h('strong', {}, next.name || 'contact'), h('span', { class: 'muted mono' }, ` +${next.phone}`), ` at ${timeOfDay(c.waitingUntil, true)}`)));
  } else if (c.status === PAUSED && s.pending) {
    const due = nextDueAt(c);
    lines.push(h('p', { class: 'hero-line muted' }, icon('clock', 15),
      due > now ? `Paused. After Resume, the next message waits until ${timeOfDay(due, true)} to keep your pace.` : 'Paused. Press Resume to continue.'));
  } else if (c.status === IDLE && !c.contacts.length) {
    lines.push(h('p', { class: 'hero-line muted' }, icon('users', 15), 'Upload a contact list to get started.'));
  }
  setChildren(els.heroLines, ...lines);

  // ---- hero actions ----
  const acts = [];
  if (waiting) {
    acts.push(h('button', { class: 'btn btn-secondary', title: 'End this wait and send the next message now', onclick: () => guard(() => api.skipWait(), 'Sending next message now') }, icon('skip', 15), 'Send next now'));
  }
  setChildren(els.heroActions, ...acts);

  renderCurrent(c, current, next, waiting, now);
}

function renderCurrent(c, current, next, waiting, now) {
  const body = [cardHead('send', 'Current contact', current ? 'Being sent right now' : waiting ? 'Waiting for the next slot' : null)];
  if (current) {
    body.push(
      h('div', { class: 'current-contact' },
        h('div', { class: 'avatar' }, (current.name || '#').slice(0, 1).toUpperCase()),
        h('div', { class: 'grow' }, h('strong', {}, current.name || '(no name)'), h('div', { class: 'muted mono' }, `+${current.phone}`)),
        statusBadge(STATUS.PROCESSING)),
      h('div', { class: 'bubble' }, current.message || '…'));
  } else if (waiting) {
    body.push(
      h('div', { class: 'countdown' },
        h('strong', {}, formatClock(c.waitingUntil - now)),
        h('span', { class: 'muted' }, `until the next message (pace: 1 every ${describePace(c.settings.delayBetween)})`)),
      next ? h('div', { class: 'current-contact' },
        h('div', { class: 'avatar avatar-muted' }, (next.name || '#').slice(0, 1).toUpperCase()),
        h('div', { class: 'grow' }, h('strong', {}, next.name || '(no name)'), h('div', { class: 'muted mono' }, `+${next.phone}`)),
        statusBadge(STATUS.PENDING)) : null);
  } else {
    const text = {
      [IDLE]: 'The campaign has not started yet.',
      [PAUSED]: 'The campaign is paused.',
      [STOPPED]: 'The campaign is stopped. Press Start to continue with pending contacts.',
      [COMPLETED]: `Completed ${formatTime(c.finishedAt)}.`,
      [RUNNING]: 'Preparing…',
    }[c.status];
    body.push(h('div', { class: 'empty-inline' }, icon(c.status === COMPLETED ? 'check' : 'clock', 22), h('p', { class: 'muted' }, text)));
  }
  setChildren(els.current, ...body);
}

/** "3:45 PM" today, or "Mon 3:45 PM" on another day. */
function timeOfDay(ts, withSeconds = false) {
  const d = new Date(ts);
  const opts = { hour: 'numeric', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) };
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], opts) : d.toLocaleString([], { weekday: 'short', ...opts });
}

/* ------------------------------------------------------------------ */

export function render(root, ctx) {
  const c = ctx.state.campaign;
  const s = computeStats(c);
  const running = c.status === RUNNING;

  if (document.activeElement !== els.nameInput) els.nameInput.value = c.name;
  els.nameInput.disabled = running;

  setChildren(els.stats,
    statCard('Total contacts', s.total, 'neutral', 'users'),
    statCard('Sent', s.sent, 'success', 'check', s.total),
    statCard('Pending', s.pending, 'info', 'clock', s.total),
    statCard('Failed', s.failed, 'danger', 'x', s.total),
    statCard('Invalid numbers', s.invalid, 'warning', 'phoneOff', s.total),
    statCard('Skipped', s.skipped, 'muted', 'skip', s.total));

  const seg = (n, cls, label) => (n ? h('div', { class: `seg ${cls}`, style: { width: `${(n / Math.max(1, s.total)) * 100}%` }, title: `${label}: ${n}` }) : null);
  const legend = (cls, label, n) => h('span', { class: 'legend-item' }, h('span', { class: `legend-dot ${cls}` }), `${label} ${formatNumber(n)}`);
  setChildren(els.progress,
    cardHead('chart', 'Campaign progress', `Processed ${formatNumber(s.processed)} of ${formatNumber(s.total)}`, h('strong', { class: 'big-percent' }, `${s.percent}%`)),
    h('div', { class: 'progress progress-seg', role: 'progressbar', 'aria-valuenow': s.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      seg(s.sent, 'seg-sent', 'Sent'), seg(s.failed, 'seg-failed', 'Failed'), seg(s.invalid, 'seg-invalid', 'Invalid'), seg(s.skipped, 'seg-skipped', 'Skipped')),
    h('div', { class: 'legend' }, legend('seg-sent', 'Sent', s.sent), legend('seg-failed', 'Failed', s.failed), legend('seg-invalid', 'Invalid', s.invalid), legend('seg-skipped', 'Skipped', s.skipped), legend('seg-pending', 'Pending', s.pending)),
    c.startedAt ? h('p', { class: 'muted small' }, `Started ${formatTime(c.startedAt)}${running ? ` · ${c.sessionSent}/${c.settings.maxPerSession} sent this session` : ''}`) : null);

  const wa = ctx.state.wa;
  const eligible = c.contacts.filter(isEligible).length;
  const item = (done, label, detail, view) =>
    h('li', { class: done ? 'done' : '' },
      h('span', { class: 'check-icon' }, done ? icon('check', 13) : ''),
      h('div', {}, h('strong', {}, label), h('div', { class: 'muted small' }, detail)),
      view ? h('button', { class: 'btn btn-ghost btn-sm', onclick: () => ctx.go(view) }, 'Open') : null);
  const steps = [
    [wa?.state === 'ready', 'WhatsApp Web connected', wa?.label || 'Checking…', null],
    [c.contacts.length > 0, 'Contacts uploaded', c.contacts.length ? `${c.contacts.length} rows · ${eligible} ready to send` : 'Upload a CSV with Name and Phone columns', 'contacts'],
    [!!c.template.trim(), 'Message written', c.template.trim() ? c.template.slice(0, 70) + (c.template.length > 70 ? '…' : '') : 'Write your message with {Name} placeholders', 'message'],
    [true, 'Sending pace chosen', `1 message every ${describePace(c.settings.delayBetween)} · max ${c.settings.maxPerSession} per session`, 'settings'],
    [c.log.some((e) => e.test && e.level === 'success'), 'Test message sent (recommended)', 'Send one message to yourself first', 'test'],
  ];
  const doneCount = steps.filter((x) => x[0]).length;
  setChildren(els.checklist,
    cardHead('list', 'Setup checklist', `${doneCount} of ${steps.length} done`),
    h('ul', { class: 'checklist' }, steps.map((x) => item(...x))));

  setChildren(els.actions,
    cardHead('bolt', 'Quick actions'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-secondary', disabled: running || s.failed === 0, onclick: () => guard(() => api.retryFailed().then((r) => r.count), 'Failed contacts queued for retry') }, `Retry failed (${s.failed})`),
      h('button', { class: 'btn btn-secondary', disabled: !c.contacts.length, onclick: () => exportResults(c) }, 'Export results CSV'),
      h('button', { class: 'btn btn-ghost', onclick: () => ctx.go('log') }, 'View full log')));

  const recent = c.log.slice(-8).reverse();
  setChildren(els.activity,
    cardHead('activity', 'Recent activity'),
    recent.length
      ? h('ul', { class: 'activity' }, recent.map((e) => h('li', { class: `activity-${e.level}` }, h('span', { class: 'activity-time' }, formatTime(e.ts, false)), h('span', {}, e.text))))
      : h('p', { class: 'muted' }, 'No activity yet.'));

  renderLive(ctx);
}
