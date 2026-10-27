/** Audit log: every admin action and breaker transition, live-updating, searchable and filterable. */
import { Poller, type AppContext, type Page } from '../app.js';
import { formatDateTime, formatDisplayValue, formatInt, formatValue } from '../format.js';
import type { AuditEntry } from '../types.js';
import { dataTable, errorNotice, searchBox } from '../ui/components.js';
import { h, replace, setText, statusLabel } from '../ui/dom.js';

type KindFilter = 'all' | 'admin' | 'breaker' | 'system';

export function matchesAudit(entry: AuditEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.actor, entry.action, entry.target ?? '', entry.reason ?? '', entry.result ?? '', formatValue(entry.before), formatValue(entry.after), formatDisplayValue(entry.before), formatDisplayValue(entry.after)].some(v => v.toLowerCase().includes(q));
}

/** Money keys read in OPEN (not raw Centi / wei); the cell title keeps the raw JSON. */
function short(value: unknown): string {
  const text = formatDisplayValue(value);
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

export function createAuditPage(ctx: AppContext): Page {
  const { api, store } = ctx;
  let query = '';
  let kind: KindFilter = 'all';
  const unsubs: (() => void)[] = [];

  const search = searchBox('Search audit log', 'Search action, actor, reason…', value => { query = value; render(); });
  const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter by kind' } });
  for (const [value, label] of [['all', 'All'], ['admin', 'Admin actions'], ['breaker', 'Breakers'], ['system', 'System']] as const) {
    const chip = h('button', { class: 'chip', attrs: { type: 'button', 'aria-pressed': String(value === kind) }, text: label });
    chip.addEventListener('click', () => { kind = value; for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip)); render(); });
    chips.append(chip);
  }
  const countEl = h('span', { class: 'muted tabular' });
  const tableHost = h('div', { class: 'table-wrap', style: { 'max-height': 'calc(100vh - 260px)' } });
  const errorHost = h('div');

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Audit log' }), h('p', { class: 'lede', text: 'The journal of admin actions (actor, before → after, reason) and breaker transitions. New entries stream in live.' }))),
    h('div', { class: 'row' }, search.el, chips, h('span', { class: 'spacer' }), countEl),
    errorHost, tableHost);

  function render(): void {
    const all = store.snapshot.audit;
    const rows = all.filter(e => (kind === 'all' || e.kind === kind) && matchesAudit(e, query));
    setText(countEl, `${formatInt(rows.length)} of ${formatInt(all.length)} entries`);
    replace(tableHost, dataTable<AuditEntry>({
      caption: 'Audit log', rows, empty: query ? `No entries match “${query}”.` : 'No entries yet.',
      columns: [
        { key: 'ms', label: 'Time (UTC)', render: e => h('span', { class: 'tabular', text: formatDateTime(e.ms) }) },
        { key: 'kind', label: 'Kind', render: e => (e.kind === 'breaker' ? statusLabel('warning', 'Breaker') : e.kind === 'system' ? statusLabel('info', 'System') : statusLabel('neutral', 'Admin')) },
        { key: 'actor', label: 'Actor', render: e => e.actor },
        { key: 'action', label: 'Action', render: e => h('code', { text: e.action }) },
        { key: 'target', label: 'Target', render: e => e.target ?? '—' },
        { key: 'change', label: 'Before → after', wrap: true, render: e => (e.before === undefined && e.after === undefined ? '—' : h('span', { class: 'tabular', title: `Raw: ${formatValue(e.before)} → ${formatValue(e.after)}` }, h('span', { class: 'muted', text: short(e.before) }), ' → ', h('strong', { text: short(e.after) }))) },
        { key: 'reason', label: 'Reason', wrap: true, render: e => e.reason ?? '—' },
        { key: 'result', label: 'Result', render: e => e.result ?? '—' },
      ],
    }));
  }

  async function load(): Promise<void> {
    const result = await api.audit(500);
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (result.ok) store.seedAudit(result.data);
  }

  const poller = new Poller(load, 30_000);
  return {
    el,
    mount() { unsubs.push(store.on('audit', render), store.on('run', () => poller.kick())); render(); poller.start(); },
    unmount() { for (const u of unsubs.splice(0)) u(); poller.stop(); },
    focusSearch() { search.input.focus(); search.input.select(); },
  };
}
