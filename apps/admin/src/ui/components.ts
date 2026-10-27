/** Reusable console widgets: stat tiles, meters, chart cards with table twins, tables, drawer, toasts. */
import { evictIndex } from '../alert-throttle.js';
import { sparkline } from '../charts/sparkline.js';
import { formatPct } from '../format.js';
import { formatOpen, formatOpenCompact, formatUsdEstimate } from '../money.js';
import type { Settings } from '../settings.js';
import type { ApiErrorBody, Centi } from '../types.js';
import { h, replace, setText, statusIcon, statusLabel, svg, uid, type Child, type StatusKind } from './dom.js';

export type Tone = 'good' | 'bad' | 'flat';

export interface TileUpdate {
  readonly value: string;
  readonly title?: string;
  readonly sub?: string;
  readonly delta?: { readonly text: string; readonly tone: Tone; readonly label: string } | null;
  readonly spark?: readonly (number | null)[];
  readonly foot?: Node | null;
}

export interface Tile { readonly el: HTMLElement; update(u: TileUpdate): void }

export function tile(label: string, sparkLabel = ''): Tile {
  const value = h('div', { class: 'tile-value', text: '—' });
  const sub = h('div', { class: 'tile-sub', text: '' });
  const delta = h('span', { class: 'delta flat', text: '' });
  const sparkHost = h('div', { class: 'spark-host', style: { width: '88px', height: '28px' } });
  const extra = h('div', { class: 'tile-extra' });
  const el = h('section', { class: 'tile', attrs: { 'aria-label': label } },
    h('div', { class: 'tile-label', text: label }), value, sub, h('div', { class: 'tile-foot' }, h('div', {}, delta, extra), sparkHost));
  let lastSpark = '';
  return {
    el,
    update(u) {
      setText(value, u.value);
      value.title = u.title ?? u.value;
      setText(sub, u.sub ?? '');
      if (u.delta) {
        setText(delta, u.delta.text);
        delta.className = `delta ${u.delta.tone}`;
        delta.setAttribute('aria-label', u.delta.label);
        delta.title = u.delta.label;
      } else setText(delta, '');
      if (u.foot !== undefined) replace(extra, u.foot);
      sparkHost.hidden = !u.spark;
      if (u.spark) {
        const key = u.spark.join(',');
        if (key !== lastSpark) { lastSpark = key; replace(sparkHost, sparkline(u.spark, 88, 28, sparkLabel)); }
      }
    },
  };
}

/** Delta tone = direction × whether up is good for the house. */
export function deltaTone(delta: number | null, upIsGood: boolean): Tone {
  if (delta === null || Math.abs(delta) < 0.0005) return 'flat';
  return (delta > 0) === upIsGood ? 'good' : 'bad';
}

export function deltaText(delta: number | null): string {
  if (delta === null) return '';
  const arrow = Math.abs(delta) < 0.0005 ? '→' : delta > 0 ? '↑' : '↓';
  return `${arrow} ${formatPct(Math.abs(delta), 1)}`;
}

export interface Meter { readonly el: HTMLElement; update(share: number | null, detail?: string): void }

export function meter(label: string, warnAt = 0.75, critAt = 0.9): Meter {
  const fill = h('div', { class: 'meter-fill', style: { width: '0%' } });
  const pct = h('span', { class: 'tabular', text: '—' });
  const state = h('span', { class: 'meter-state' });
  const detailEl = h('span', { class: 'muted' });
  const el = h('div', { class: 'meter', attrs: { role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 100 } },
    h('div', { class: 'meter-label' }, h('span', { text: label }), h('span', { class: 'row' }, state, pct)),
    h('div', { class: 'meter-track' }, fill), detailEl);
  let lastLevel = '';
  return {
    el,
    update(share, detail) {
      const s = share === null || !Number.isFinite(share) ? null : Math.max(0, share);
      const level = s === null ? 'none' : s > critAt ? 'critical' : s > warnAt ? 'warning' : 'ok';
      el.dataset['level'] = level;
      fill.style.width = `${Math.min(100, (s ?? 0) * 100).toFixed(1)}%`;
      setText(pct, s === null ? '—' : formatPct(s, 1));
      el.setAttribute('aria-valuenow', s === null ? '0' : (s * 100).toFixed(1));
      el.setAttribute('aria-valuetext', s === null ? 'unknown' : `${formatPct(s, 1)}${level === 'critical' ? ', near limit' : level === 'warning' ? ', elevated' : ''}`);
      if (level !== lastLevel) {
        lastLevel = level;
        replace(state, level === 'critical' ? statusLabel('critical', 'Near limit') : level === 'warning' ? statusLabel('warning', 'Elevated') : null);
      }
      setText(detailEl, detail ?? '');
    },
  };
}

/** OPEN amount with the optional USD estimate, labelled as an estimate at the stated price. */
export function money(centi: Centi | bigint, settings: Settings, options: { compact?: boolean; signed?: boolean } = {}): HTMLSpanElement {
  const text = options.compact ? formatOpenCompact(centi, { signed: options.signed ?? false }) : formatOpen(centi, { signed: options.signed ?? false });
  const el = h('span', { class: 'money tabular', text, title: formatOpen(centi, { signed: options.signed ?? false }) });
  if (!settings.showUsd) return el;
  return h('span', { class: 'money-wrap' }, el, ' ', h('span', { class: 'est', text: `${formatUsdEstimate(centi, settings.refPrice)} est.`, title: `Estimate at the admin-set reference price of $${settings.refPrice.text} per OPEN` }));
}

export function usdNote(settings: Settings): string {
  return settings.showUsd ? `USD figures are estimates at $${settings.refPrice.text}/OPEN (admin-set reference price).` : '';
}

export interface ChartCard {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  setTable(render: () => HTMLElement): void;
  setLoading(loading: boolean): void;
  setError(error: ApiErrorBody | null): void;
  setLegend(legend: Node | null): void;
}

/** Every chart ships with a table-view twin toggled from its header. */
export function chartCard(title: string, sub: string, tools: readonly Child[] = []): ChartCard {
  const body = h('div', { class: 'chart-host loading-frame' });
  const tableHost = h('div', { class: 'table-host', hidden: true });
  const errorHost = h('div', { class: 'error-host' });
  const legendHost = h('div', { class: 'legend-host' });
  let renderTable: (() => HTMLElement) | null = null;
  const toggle = h('button', { class: 'btn small ghost', attrs: { type: 'button', 'aria-pressed': 'false', 'aria-label': `Show ${title} as a table` }, text: 'Table' });
  toggle.addEventListener('click', () => {
    const showTable = toggle.getAttribute('aria-pressed') !== 'true';
    toggle.setAttribute('aria-pressed', String(showTable));
    toggle.textContent = showTable ? 'Chart' : 'Table';
    body.hidden = showTable;
    tableHost.hidden = !showTable;
    if (showTable && renderTable) replace(tableHost, renderTable());
  });
  const headingId = uid('chart');
  const el = h('section', { class: 'card chart-card', attrs: { 'aria-labelledby': headingId } },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-title' }, h('h2', { id: headingId, text: title }), sub ? h('span', { class: 'sub', text: sub }) : null),
      h('div', { class: 'chart-tools' }, ...tools, toggle)),
    legendHost, errorHost, body, tableHost);
  return {
    el, body,
    setTable(render) { renderTable = render; if (!tableHost.hidden) replace(tableHost, render()); },
    setLoading(loading) { body.dataset['loading'] = String(loading); },
    setError(error) { replace(errorHost, error ? errorNotice(error) : null); },
    setLegend(legend) { replace(legendHost, legend); },
  };
}

export function legend(items: readonly { readonly label: string; readonly color?: string; readonly kind: 'swatch' | 'line' | 'band' }[]): HTMLElement {
  return h('div', { class: 'legend', attrs: { role: 'list' } }, ...items.map(item =>
    h('span', { class: 'legend-item', attrs: { role: 'listitem' } },
      h('span', { class: item.kind === 'swatch' ? 'legend-swatch' : item.kind === 'line' ? 'legend-line' : 'legend-band', style: item.color ? { background: item.color } : {} }),
      h('span', { text: item.label }))));
}

export function errorNotice(error: ApiErrorBody): HTMLElement {
  return h('div', { class: 'server-error', attrs: { role: 'alert' } }, statusIcon('critical'),
    h('div', {}, h('code', { text: error.code }), ' ', h('span', { text: error.message }), error.status ? h('span', { class: 'muted', text: ` (HTTP ${error.status})` }) : null));
}

export interface Column<T> {
  readonly key: string;
  readonly label: string;
  readonly num?: boolean;
  readonly sortable?: boolean;
  readonly wrap?: boolean;
  readonly render: (row: T) => Child;
}

export interface SortState { readonly key: string; readonly dir: 'asc' | 'desc' }

export interface TableOptions<T> {
  readonly caption: string;
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly sort?: SortState | null;
  readonly onSort?: (key: string) => void;
  readonly onRowClick?: (row: T) => void;
  readonly rowKey?: (row: T) => string;
  readonly selectedKey?: string | null;
  readonly empty?: string;
}

export function dataTable<T>(options: TableOptions<T>): HTMLTableElement {
  const head = h('tr', {}, ...options.columns.map(col => {
    const sorted = options.sort?.key === col.key ? (options.sort.dir === 'asc' ? 'ascending' : 'descending') : null;
    const th = h('th', { class: col.num ? 'num' : '', attrs: { scope: 'col', 'aria-sort': sorted ?? (col.sortable ? 'none' : null) } });
    if (col.sortable && options.onSort) {
      th.append(h('button', { class: 'sort', attrs: { type: 'button' }, text: col.label, on: { click: () => options.onSort?.(col.key) } }));
    } else th.textContent = col.label;
    return th;
  }));
  const body = h('tbody');
  if (options.rows.length === 0) {
    body.append(h('tr', {}, h('td', { class: 'empty', attrs: { colspan: options.columns.length }, text: options.empty ?? 'Nothing to show.' })));
  }
  for (const row of options.rows) {
    const key = options.rowKey?.(row);
    const tr = h('tr', { class: options.onRowClick ? 'clickable' : '', attrs: { 'aria-selected': options.onRowClick ? String(key !== undefined && key === options.selectedKey) : null, tabindex: options.onRowClick ? 0 : null } },
      ...options.columns.map(col => h('td', { class: `${col.num ? 'num' : ''} ${col.wrap ? 'wrap' : ''}`.trim() }, col.render(row))));
    if (options.onRowClick) {
      tr.addEventListener('click', () => options.onRowClick?.(row));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); options.onRowClick?.(row); } });
    }
    body.append(tr);
  }
  return h('table', { class: 'data' }, h('caption', { class: 'sr-only', text: options.caption }), h('thead', {}, head), body);
}

export interface Drawer { readonly el: HTMLElement; readonly body: HTMLElement; open(title: string, subtitle?: Child): void; close(): void; readonly isOpen: boolean }

export function drawer(onClose?: () => void): Drawer {
  const titleEl = h('h2', { id: uid('drawer-title') });
  const subEl = h('div', { class: 'muted' });
  const body = h('div', { class: 'drawer-body' });
  const closeBtn = h('button', { class: 'btn ghost small', attrs: { type: 'button', 'aria-label': 'Close panel' }, text: 'Close (Esc)' });
  const el = h('aside', { class: 'drawer', hidden: true, attrs: { role: 'complementary', 'aria-labelledby': titleEl.id } },
    h('div', { class: 'drawer-head' }, h('div', { class: 'stack', style: { gap: '2px', flex: '1', 'min-width': '0' } }, titleEl, subEl), closeBtn), body);
  let returnFocus: Element | null = null;
  const api: Drawer = {
    el, body,
    get isOpen() { return !el.hidden; },
    open(title, subtitle) {
      if (el.hidden) returnFocus = document.activeElement;
      setText(titleEl, title);
      replace(subEl, subtitle ?? null);
      el.hidden = false;
      closeBtn.focus({ preventScroll: true });
    },
    close() {
      if (el.hidden) return;
      el.hidden = true;
      onClose?.();
      if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
    },
  };
  closeBtn.addEventListener('click', () => api.close());
  el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } });
  return api;
}

const toastHost = (): HTMLElement => {
  let host = document.querySelector<HTMLElement>('.toasts');
  if (!host) { host = h('div', { class: 'toasts', attrs: { role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' } }); document.body.append(host); }
  return host;
};

export const MAX_TOASTS = 4;

/**
 * `key`: a toast with the same key replaces the previous one (one visible toast per alert code).
 * Over the limit, the oldest non-critical toast goes first, so acks and routine alerts never evict a
 * sticky critical toast. Critical toasts are announced assertively (role=alert). Every SSE alert also
 * stays in the header's alerts panel, so an expired toast is never the only record.
 */
export function toast(message: string, kind: StatusKind = 'info', timeoutMs = 6000, key?: string): void {
  const host = toastHost();
  if (key !== undefined) for (const old of host.querySelectorAll<HTMLElement>('.toast')) if (old.dataset['key'] === key) old.remove();
  const close = h('button', { class: 'btn ghost small icon-only', attrs: { type: 'button', 'aria-label': 'Dismiss notification' }, text: '×' });
  const el = h('div', {
    class: `toast ${kind === 'critical' ? 'critical' : kind === 'warning' ? 'warning' : kind === 'good' ? 'good' : ''}`,
    dataset: { kind, ...(key !== undefined ? { key } : {}) },
    attrs: kind === 'critical' ? { role: 'alert', 'aria-live': 'assertive' } : { role: 'status' },
  }, h('span', { class: `status status-${kind}` }, statusIcon(kind)), h('div', { class: 'toast-body', text: message }), close);
  close.addEventListener('click', () => el.remove());
  host.prepend(el);
  while (host.children.length > MAX_TOASTS) {
    const toasts = [...host.children] as HTMLElement[];
    toasts[evictIndex(toasts.map(t => t.dataset['kind'] ?? 'info'))]?.remove();
  }
  if (timeoutMs > 0) setTimeout(() => el.remove(), timeoutMs);
}

export function segmented<T extends string>(label: string, options: readonly { readonly value: T; readonly label: string }[], value: T, onChange: (value: T) => void): HTMLElement {
  const group = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': label } });
  const buttons = options.map(opt => {
    const b = h('button', { attrs: { type: 'button', 'aria-pressed': String(opt.value === value) }, text: opt.label });
    b.addEventListener('click', () => { for (const other of buttons) other.setAttribute('aria-pressed', String(other === b)); onChange(opt.value); });
    return b;
  });
  group.append(...buttons);
  return group;
}

export function searchBox(label: string, placeholder: string, onInput: (value: string) => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'input search', attrs: { type: 'search', 'aria-label': label, placeholder, autocomplete: 'off', spellcheck: 'false' } });
  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(() => onInput(input.value), 220); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; onInput(''); } });
  const icon = svg('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    svg('circle', { cx: 7, cy: 7, r: 4.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }),
    svg('path', { d: 'M10.5 10.5L14 14', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round' }));
  return { el: h('div', { class: 'search-wrap' }, icon, input, h('span', { class: 'kbd', attrs: { 'aria-hidden': 'true' }, text: '/' })), input };
}

export function kv(pairs: readonly (readonly [string, Child])[]): HTMLDListElement {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) dl.append(h('dt', { text: k }), h('dd', {}, v));
  return dl;
}

export function statusText(kind: StatusKind, label: string): HTMLSpanElement {
  return statusLabel(kind, label);
}
