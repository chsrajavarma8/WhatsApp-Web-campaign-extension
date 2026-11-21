/** Campaign drafts: save snapshots of the whole campaign and restore them later. */
import { CAMPAIGN_STATE } from '../../constants.js';
import { computeStats } from '../../campaign-manager.js';
import { store } from '../../storage.js';
import { api } from '../api.js';
import { h, setChildren, guard, confirmDialog, promptDialog, formatTime } from '../dom.js';

let list = null;
let saveBtn = null;

export function init(root, ctx) {
  list = h('div', { class: 'stack' });
  saveBtn = h('button', {
    class: 'btn btn-primary',
    onclick: async () => {
      const c = ctx.state.campaign;
      const name = await promptDialog({ title: 'Save campaign draft', label: 'Draft name', value: c.name });
      if (name) await guard(() => store.saveDraft(name, c), `Draft "${name}" saved`);
    },
  }, 'Save current campaign as draft');

  root.append(
    h('div', { class: 'card card-flat' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h3', { class: 'card-title' }, 'Campaign drafts'),
          h('p', { class: 'muted small' }, 'A draft stores the contacts, message, settings and statuses, so you can come back to a campaign later.')),
        saveBtn)),
    list
  );
}

export function render(root, ctx) {
  const c = ctx.state.campaign;
  const running = c.status === CAMPAIGN_STATE.RUNNING;
  saveBtn.disabled = !c.contacts.length && !c.template.trim();

  const drafts = ctx.state.drafts;
  if (!drafts.length) {
    setChildren(list, h('div', { class: 'empty-state' }, h('strong', {}, 'No drafts saved'), h('p', { class: 'muted' }, 'Save the current campaign to keep a copy you can load later.')));
    return;
  }
  setChildren(list, 
    ...drafts.map((d) => {
      const s = computeStats(d.campaign);
      return h('div', { class: 'card draft-row' },
        h('div', {},
          h('strong', {}, d.name),
          h('div', { class: 'muted small' }, `Saved ${formatTime(d.savedAt)} · ${s.total} contacts · ${s.sent} sent · ${s.pending} pending`),
          d.campaign.template ? h('div', { class: 'muted small truncate' }, d.campaign.template) : null),
        h('div', { class: 'btn-row' },
          h('button', {
            class: 'btn btn-secondary btn-sm',
            disabled: running,
            title: running ? 'Pause the campaign first' : null,
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Load draft?', message: `Replace the current campaign with "${d.name}"? Save the current one as a draft first if you want to keep it.`, confirmLabel: 'Load draft' });
              if (ok) {
                const r = await guard(() => api.loadDraft(d.campaign), `Draft "${d.name}" loaded`);
                if (r) ctx.go('overview');
              }
            },
          }, 'Load'),
          h('button', {
            class: 'btn btn-ghost btn-sm text-danger',
            onclick: async () => {
              if (await confirmDialog({ title: 'Delete draft?', message: `Delete "${d.name}"?`, confirmLabel: 'Delete', danger: true })) {
                await guard(() => store.deleteDraft(d.id), 'Draft deleted');
              }
            },
          }, 'Delete')));
    })
  );
}
