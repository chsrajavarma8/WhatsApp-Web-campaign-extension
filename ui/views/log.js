/** Activity log with filtering and CSV export. */
import { api } from '../api.js';
import { h, setChildren, guard, confirmDialog, formatTime } from '../dom.js';
import { exportResults, exportLog } from '../export.js';

const PAGE_SIZE = 100;
const view = { level: 'all', search: '', page: 0 };
let els = null;

export function init(root, ctx) {
  els = {
    level: h('select', { class: 'input', onchange: (e) => { view.level = e.target.value; view.page = 0; render(null, ctx); } },
      h('option', { value: 'all' }, 'All entries'),
      h('option', { value: 'success' }, 'Sent'),
      h('option', { value: 'error' }, 'Errors'),
      h('option', { value: 'warn' }, 'Warnings'),
      h('option', { value: 'info' }, 'Info'),
      h('option', { value: 'test' }, 'Test messages')),
    search: h('input', { class: 'input', type: 'search', placeholder: 'Search name, phone, error…', oninput: (e) => { view.search = e.target.value.trim().toLowerCase(); view.page = 0; render(null, ctx); } }),
    table: h('div', { class: 'table-wrap' }),
    pager: h('div', { class: 'pager' }),
    clearBtn: h('button', {
      class: 'btn btn-ghost btn-sm text-danger',
      onclick: async () => {
        if (await confirmDialog({ title: 'Clear activity log?', message: 'Contact statuses are kept; only the log entries are removed.', confirmLabel: 'Clear log', danger: true })) {
          await guard(() => api.clearLog(), 'Log cleared');
        }
      },
    }, 'Clear log'),
  };

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', { class: 'card-title' }, 'Activity log'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => exportResults(ctx.state.campaign) }, 'Export results CSV'),
          h('button', { class: 'btn btn-secondary btn-sm', onclick: () => exportLog(ctx.state.campaign) }, 'Export log CSV'),
          els.clearBtn)),
      h('div', { class: 'toolbar' }, els.search, els.level),
      els.table,
      els.pager)
  );
}

function matches(e) {
  if (view.level === 'test' && !e.test) return false;
  if (view.level !== 'all' && view.level !== 'test' && e.level !== view.level) return false;
  if (view.search && !`${e.name || ''} ${e.phone || ''} ${e.error || ''} ${e.text || ''} ${e.message || ''}`.toLowerCase().includes(view.search)) return false;
  return true;
}

export function render(root, ctx) {
  const entries = ctx.state.campaign.log.filter(matches).reverse();
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  view.page = Math.min(view.page, pages - 1);
  const slice = entries.slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE);
  els.clearBtn.disabled = !ctx.state.campaign.log.length;

  setChildren(els.table, 
    h('table', { class: 'table table-log' },
      h('thead', {}, h('tr', {}, ['Date & time', 'Contact', 'Phone', 'Status', 'Message', 'Details'].map((t) => h('th', {}, t)))),
      h('tbody', {},
        slice.length
          ? slice.map((e) =>
              h('tr', { class: `log-${e.level}` },
                h('td', { class: 'nowrap' }, formatTime(e.ts)),
                h('td', {}, e.name || (e.contactId || e.test ? h('em', { class: 'muted' }, 'no name') : h('span', { class: 'muted' }, 'Campaign'))),
                h('td', { class: 'mono' }, e.phone ? `+${e.phone}` : ''),
                h('td', {}, e.status ? h('span', { class: `log-status log-status-${e.level}` }, e.test ? `🧪 ${e.status}` : e.status) : ''),
                h('td', { class: 'preview-cell', title: e.message || '' }, e.message || ''),
                h('td', {}, e.error ? h('span', { class: 'text-danger' }, e.error) : e.text || '', e.note ? h('div', { class: 'muted small' }, e.note) : null)))
          : h('tr', {}, h('td', { colspan: 6, class: 'empty' }, 'No log entries.'))))
  );

  setChildren(els.pager, 
    h('span', { class: 'muted' }, `${entries.length} entries`),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn-ghost btn-sm', disabled: view.page === 0, onclick: () => { view.page--; render(null, ctx); } }, '‹ Newer'),
      h('span', { class: 'muted' }, `Page ${view.page + 1} / ${pages}`),
      h('button', { class: 'btn btn-ghost btn-sm', disabled: view.page >= pages - 1, onclick: () => { view.page++; render(null, ctx); } }, 'Older ›'))
  );
}
