/**
 * Tiny DOM toolkit for the extension pages.
 * All user/CSV data is inserted as text nodes (never innerHTML) so contact
 * names or messages can't inject markup.
 */
import { STATUS } from '../constants.js';

const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'indeterminate', 'hidden']);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Like el.replaceChildren(), but skips null/false/undefined (which replaceChildren would print as text). */
export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Like h() for SVG elements (attributes only, no event props). */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

/** 24x24 line icons (stroke = currentColor). */
const ICONS = {
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  x: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM15 9l-6 6M9 9l6 6',
  skip: 'M5 4l10 8-10 8V4zM19 5v14',
  phoneOff: 'M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3 4.2 2 2 0 0 1 5 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8.9 9.7M22 2 2 22',
  gauge: 'M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0',
  chart: 'M3 3v18h18M7 15l4-4 3 3 6-6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  check: 'M20 6 9 17l-5-5',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  zap: 'M5 12h14M12 5l7 7-7 7',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

export function icon(name, size = 18) {
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' },
    svg('path', { d: ICONS[name] || ICONS.list }));
}

/** Card header: icon tile + title (+ optional subtitle and right-side content). */
export function cardHead(iconName, title, subtitle, ...right) {
  return h('div', { class: 'card-head' },
    h('div', { class: 'card-head-main' },
      h('span', { class: 'card-icon' }, icon(iconName)),
      h('div', {}, h('h3', { class: 'card-title' }, title), subtitle ? h('p', { class: 'card-sub' }, subtitle) : null)),
    right.length ? h('div', { class: 'card-head-right' }, right) : null);
}

/** Countdown text: 0:45, 14:59, 1:02:03. */
export function formatClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    return fn(...args);
  };
  return wrapped;
}

export function formatTime(ts, withDate = true) {
  if (!ts) return '';
  const d = new Date(ts);
  return withDate ? d.toLocaleString() : d.toLocaleTimeString();
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

const STATUS_CLASS = {
  [STATUS.PENDING]: 'pending',
  [STATUS.PROCESSING]: 'processing',
  [STATUS.SENT]: 'sent',
  [STATUS.FAILED]: 'failed',
  [STATUS.INVALID]: 'invalid',
  [STATUS.SKIPPED]: 'skipped',
  [STATUS.PAUSED]: 'paused',
};

export function statusBadge(status, title) {
  return h('span', { class: `badge badge-${STATUS_CLASS[status] || 'pending'}`, title: title || null }, status);
}

/* ---------------- toasts ---------------- */

export function toast(message, type = 'info', ms = 4000) {
  let host = $('#toasts');
  if (!host) {
    host = h('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${type}`, role: 'status' }, message);
  host.append(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** Runs an async action, showing a toast on error. Returns the result or undefined. */
export async function guard(fn, successMessage) {
  try {
    const r = await fn();
    if (successMessage) toast(successMessage, 'success');
    return r;
  } catch (err) {
    toast(err?.message || String(err), 'error', 6000);
    return undefined;
  }
}

/* ---------------- modals ---------------- */

/**
 * Opens a modal. Resolves with the clicked action's value (or the value its
 * onClick returned), or null when dismissed. onClick may return false to keep
 * the modal open.
 */
export function openModal({ title, body, actions = [], wide = false }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' });
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    function close(value) {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    const buttons = actions.map((a) =>
      h(
        'button',
        {
          class: `btn ${a.variant || 'btn-secondary'}`,
          'data-role': a.role || null,
          disabled: a.disabled || false,
          onclick: async () => {
            if (!a.onClick) return close(a.value ?? null);
            const r = await a.onClick();
            if (r === false) return;
            close(r === undefined ? a.value ?? null : r);
          },
        },
        a.label
      )
    );
    const dialog = h(
      'div',
      { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-header' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, '×')),
      h('div', { class: 'modal-body' }, body),
      buttons.length ? h('div', { class: 'modal-actions' }, buttons) : null
    );
    overlay.append(dialog);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    (dialog.querySelector('input:not([type=checkbox]), textarea') || dialog.querySelector('.btn-primary, .btn-danger'))?.focus();
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, requireCheck = '' }) {
  const body = h('div', {}, typeof message === 'string' ? h('p', {}, message) : message);
  let check;
  if (requireCheck) {
    check = h('input', { type: 'checkbox' });
    body.append(h('label', { class: 'check-row' }, check, h('span', {}, requireCheck)));
  }
  const promise = openModal({
    title,
    body,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary', value: true, role: 'confirm', disabled: !!requireCheck },
    ],
  });
  if (check) {
    const btn = document.querySelector('.modal [data-role="confirm"]');
    check.addEventListener('change', () => {
      btn.disabled = !check.checked;
    });
  }
  return promise.then((v) => v === true);
}

export function promptDialog({ title, label, value = '', multiline = false, placeholder = '', confirmLabel = 'Save' }) {
  const input = multiline
    ? h('textarea', { class: 'input', rows: 8, placeholder, value })
    : h('input', { class: 'input', type: 'text', placeholder, value });
  const body = h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input);
  return openModal({
    title,
    body,
    actions: [
      { label: 'Cancel', value: null },
      {
        label: confirmLabel,
        variant: 'btn-primary',
        onClick: () => {
          const v = input.value.trim();
          if (!v) {
            input.classList.add('input-error');
            input.focus();
            return false;
          }
          return v;
        },
      },
    ],
  });
}
