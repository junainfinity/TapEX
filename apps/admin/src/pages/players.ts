/** Players: searchable, sortable table with on-chain vs sim split, flags, block/unblock and a drill-down drawer. */
import { type PlayerSortKey } from '../api.js';
import { Poller, type AppContext, type Page } from '../app.js';
import { TimeChart } from '../charts/timeseries.js';
import { playerPlan } from '../controls.js';
import { cumulativePnl } from '../ledger-math.js';
import { explorerUrl, formatDateTime, formatInt, formatPct, formatTime, isEvmAddress, marketShort, shortAddress, squareLabel } from '../format.js';
import { centiToNumber, formatOpen, formatOpenCompact, formatX100, parseCenti } from '../money.js';
import type { ApiErrorBody, BetLeg, DefenseConfig, PlayerDetail, PlayerRow } from '../types.js';
import { dataTable, drawer, errorNotice, kv, money, searchBox, type SortState } from '../ui/components.js';
import { h, replace, setText, statusLabel, type StatusKind } from '../ui/dom.js';
import { proofAddress, proofLookup } from '../ui/proof.js';
import { flagLabel } from '../view-models.js';

type Filter = 'all' | 'onchain' | 'sim' | 'flagged' | 'blocked';
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' }, { value: 'onchain', label: 'On-chain' }, { value: 'sim', label: 'Simulated' }, { value: 'flagged', label: 'Flagged' }, { value: 'blocked', label: 'Blocked' },
];
const PAGE_SIZE = 100;

function signedClass(centi: string): string {
  const v = parseCenti(centi) ?? 0n;
  return v > 0n ? 'delta bad' : v < 0n ? 'delta good' : 'delta flat';
}

/** z-score cell: warning at or above the flag threshold, critical at or above the block threshold (when known). */
function zCell(z: number | null | undefined, flagAt: number | undefined, blockAt: number | undefined): HTMLElement | string {
  if (z === undefined) return '—';
  if (z === null || !Number.isFinite(z)) return h('span', { class: 'muted', text: 'n/a' });
  const rounded = Math.abs(z).toFixed(2);
  const text = `${z < 0 && Number(rounded) !== 0 ? '−' : ''}${rounded}`;
  const kind: StatusKind | null = blockAt !== undefined && z >= blockAt ? 'critical' : flagAt !== undefined && z >= flagAt ? 'warning' : null;
  return kind ? statusLabel(kind, text) : h('span', { class: 'tabular', text });
}

export function createPlayersPage(ctx: AppContext): Page {
  const { api, settings, store } = ctx;
  let rows: PlayerRow[] = [];
  let cursor: string | null = null;
  let total: number | undefined;
  let query = '';
  let sort: SortState = { key: 'handle', dir: 'desc' };
  let filter: Filter = 'all';
  let selected: string | null = null;
  let detail: PlayerDetail | null = null;
  let loadError: ApiErrorBody | null = null;
  let pnlChart: TimeChart | null = null;
  /** Toxicity thresholds from GET /defenses, to mark evidence above the flag level (optional). */
  let toxicity: DefenseConfig['toxicity'] | null = null;

  const search = searchBox('Search players', 'Search address or id…', value => { query = value; void reload(); });
  const chips = h('div', { class: 'chips', attrs: { role: 'group', 'aria-label': 'Filter players' } });
  const countEl = h('span', { class: 'muted tabular' });
  const tableHost = h('div', { class: 'table-wrap loading-frame', style: { 'max-height': 'calc(100vh - 290px)' } });
  const moreBtn = h('button', { class: 'btn', attrs: { type: 'button' }, text: 'Load more', hidden: true });
  const errorHost = h('div');
  const panel = drawer(() => { selected = null; detail = null; pnlChart?.destroy(); pnlChart = null; renderTable(); });

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Players' }), h('p', { class: 'lede', text: '◆ marks on-chain testnet players (real tOPEN deposits); others are simulated and funded by off-chain sim credits.' }))),
    h('div', { class: 'row' }, search.el, chips, h('span', { class: 'spacer' }), countEl),
    errorHost, tableHost, h('div', { class: 'row' }, moreBtn),
    panel.el);

  for (const f of FILTERS) {
    const chip = h('button', { class: 'chip', attrs: { type: 'button', 'aria-pressed': String(f.value === filter) }, text: f.label });
    chip.addEventListener('click', () => {
      const serverSide = (value: Filter) => value === 'onchain' || value === 'sim';
      const reloadNeeded = serverSide(f.value) || serverSide(filter);
      filter = f.value; for (const c of chips.children) c.setAttribute('aria-pressed', String(c === chip));
      // On-chain / Simulated filter on the server (11 on-chain accounts among thousands of sims); Flagged / Blocked filter loaded rows.
      if (reloadNeeded) void reload(); else { renderTable(); void fillFilter(); }
    });
    chips.append(chip);
  }
  moreBtn.addEventListener('click', () => void loadPage(true));

  function visibleRows(): PlayerRow[] {
    return rows.filter(r => filter === 'all' || (filter === 'onchain' ? r.kind === 'onchain' : filter === 'sim' ? r.kind === 'sim' : filter === 'flagged' ? r.flagged : r.blocked));
  }

  function renderTable(): void {
    const visible = visibleRows();
    setText(countEl, `Showing ${formatInt(visible.length)} of ${formatInt(rows.length)} loaded${total !== undefined ? ` · ${formatInt(total)} total` : ''}${filter === 'flagged' || filter === 'blocked' ? ' (filter applies to loaded rows)' : ''}`);
    replace(tableHost, dataTable<PlayerRow>({
      caption: 'Players', rows: visible, rowKey: r => r.account, selectedKey: selected,
      empty: loadError ? 'Could not load players.' : query ? `No players match “${query}”.` : 'No players yet.',
      sort, onSort: key => { sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' }; void reload(); },
      onRowClick: r => void openPlayer(r.account),
      columns: [
        { key: 'account', label: 'Account', render: r => h('span', { class: 'mono', title: r.account, text: `${r.kind === 'onchain' ? '◆ ' : ''}${shortAddress(r.account)}` }) },
        { key: 'kind', label: 'Type', render: r => (r.kind === 'onchain' ? h('span', { class: 'badge info', text: 'On-chain' }) : h('span', { class: 'badge', text: r.strategy ? `Sim · ${r.strategy}` : 'Sim' })) },
        { key: 'balance', label: 'Balance', num: true, sortable: true, render: r => formatOpen(r.balanceCenti) },
        { key: 'handle', label: 'Handle', num: true, sortable: true, render: r => formatOpen(r.handleCenti) },
        { key: 'pnl', label: 'Player P&L', num: true, sortable: true, render: r => h('span', { class: signedClass(r.pnlCenti), text: formatOpen(r.pnlCenti, { signed: true }) }) },
        { key: 'bets', label: 'Bets', num: true, sortable: true, render: r => formatInt(r.bets) },
        { key: 'rtp', label: 'RTP', num: true, sortable: true, render: r => formatPct(r.rtp, 1) },
        { key: 'holds', label: 'Holds', num: true, render: r => (r.holds === undefined ? '—' : formatInt(r.holds)) },
        { key: 'latencyZ', label: 'Latency z', num: true, render: r => zCell(r.latencyZ, toxicity?.holdZ, toxicity?.holdBlockZ) },
        { key: 'excessZ', label: 'Excess-return z', num: true, render: r => zCell(r.excessReturnZ, toxicity?.surchargeZ, toxicity?.blockZ) },
        { key: 'flags', label: 'Status', render: r => h('span', { class: 'row', style: { gap: '4px', 'flex-wrap': 'nowrap' } }, r.blocked ? statusLabel('critical', 'Blocked') : null, r.flagged ? statusLabel('warning', 'Flagged') : null, !r.blocked && !r.flagged ? h('span', { class: 'muted', text: 'Active' }) : null) },
        { key: 'firstSeen', label: 'First seen (UTC)', sortable: true, render: r => formatDateTime(r.firstSeenMs) },
      ],
    }));
    moreBtn.hidden = !cursor;
  }

  async function loadPage(append: boolean): Promise<void> {
    tableHost.dataset['loading'] = 'true';
    const result = await api.players({ sort: sort.key as PlayerSortKey, dir: sort.dir, limit: PAGE_SIZE, cursor: append ? cursor : null, q: query, ...(filter === 'onchain' || filter === 'sim' ? { kind: filter } : {}) });
    tableHost.dataset['loading'] = 'false';
    loadError = result.ok ? null : result.error;
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (!result.ok) { renderTable(); return; }
    rows = append ? [...rows, ...result.data.rows.filter(r => !rows.some(x => x.account === r.account))] : [...result.data.rows];
    cursor = result.data.nextCursor ?? null;
    total = result.data.total;
    renderTable();
  }

  const reload = async () => { await loadPage(false); await fillFilter(); };

  /** Chips filter loaded rows; keep paging (bounded) until the filter has enough matches to be useful. */
  let filling = false;
  async function fillFilter(): Promise<void> {
    if (filling || filter === 'all') return;
    filling = true;
    try {
      for (let pages = 0; pages < 10 && cursor && visibleRows().length < 50 && !loadError; pages++) await loadPage(true);
    } finally { filling = false; }
  }

  function actionButtons(p: PlayerRow): HTMLElement {
    const refresh = () => { void openPlayer(p.account, true); void reload(); };
    const flag = h('button', { class: 'btn', attrs: { type: 'button' }, text: p.flagged ? 'Remove flag' : 'Flag' });
    flag.addEventListener('click', () => void ctx.act(playerPlan(p, p.flagged ? 'unflag' : 'flag'), refresh));
    const block = h('button', { class: p.blocked ? 'btn' : 'btn danger-outline', attrs: { type: 'button' }, text: p.blocked ? 'Unblock' : 'Block' });
    block.addEventListener('click', () => void ctx.act(playerPlan(p, p.blocked ? 'unblock' : 'block'), refresh));
    return h('div', { class: 'row' }, flag, block);
  }

  function renderDetail(): void {
    if (!detail) { replace(panel.body, h('div', { class: 'empty', text: 'Loading player…' })); return; }
    const p = detail.player;
    const addr = p.account.startsWith('player:') ? p.account.slice(7) : p.account;
    const link = isEvmAddress(addr) ? explorerUrl(ctx.chainId(), 'address', addr) : null;
    pnlChart?.destroy(); pnlChart = null;
    const pnl = cumulativePnl(detail.bets);
    const chartHost = h('div', { style: { 'min-height': '160px' } });
    replace(panel.body,
      h('div', { class: 'row' }, p.blocked ? statusLabel('critical', 'Blocked') : statusLabel('good', 'Active'), p.flagged ? statusLabel('warning', flagLabel(p.flagged, detail.flags) ?? 'Flagged') : null, h('span', { class: 'spacer' }), actionButtons(p)),
      kv([
        ['Account', h('span', { class: 'mono', text: p.account })],
        ['Type', p.kind === 'onchain' ? 'On-chain testnet player' : `Simulated${p.strategy ? ` (${p.strategy})` : ''} · sim-credit funds`],
        ['Balance', money(p.balanceCenti, settings)],
        ['Handle', formatOpen(p.handleCenti)],
        ['Player P&L', h('span', { class: signedClass(p.pnlCenti), text: formatOpen(p.pnlCenti, { signed: true }) })],
        ['Bets · RTP', `${formatInt(p.bets)} · ${formatPct(p.rtp, 2)}`],
        ['First seen', formatDateTime(p.firstSeenMs)],
        ...(p.holds !== undefined ? [['Holds placed', formatInt(p.holds)] as [string, string]] : []),
        ...(p.latencyZ !== undefined ? [['Latency evidence', h('span', {}, zCell(p.latencyZ, toxicity?.holdZ, toxicity?.holdBlockZ), h('span', { class: 'muted', text: toxicity ? ` σ (flag ≥ ${toxicity.holdZ}, block ≥ ${toxicity.holdBlockZ})` : ' σ' }))] as [string, HTMLElement]] : []),
        ...(p.excessReturnZ !== undefined ? [['Excess-return evidence', h('span', {}, zCell(p.excessReturnZ, toxicity?.surchargeZ, toxicity?.blockZ), h('span', { class: 'muted', text: toxicity ? ` σ (surcharge ≥ ${toxicity.surchargeZ}, block ≥ ${toxicity.blockZ})` : ' σ' }))] as [string, HTMLElement]] : []),
        ...(link ? [['Explorer', h('a', { attrs: { href: link, target: '_blank', rel: 'noopener noreferrer' }, text: 'View on BaseScan' })] as [string, HTMLElement]] : []),
      ]),
      h('section', { class: 'stack' }, h('h3', { text: 'Cumulative P&L over the bets below (player view)' }), pnl.t.length >= 2 ? chartHost : h('div', { class: 'empty', text: 'Not enough settled bets to chart.' })),
      h('section', { class: 'stack' }, h('h3', { text: `Bet history (${formatInt(detail.bets.length)})` }), h('div', { class: 'table-wrap', style: { 'max-height': '280px' } }, dataTable<BetLeg>({
        caption: 'Bet history', rows: [...detail.bets].sort((a, b) => b.placedMs - a.placedMs), empty: 'No bets.',
        columns: [
          { key: 'placed', label: 'Placed', render: b => formatTime(b.placedMs) },
          { key: 'market', label: 'Mkt', render: b => marketShort(b.market) },
          { key: 'sq', label: 'Square', render: b => squareLabel(b.start, b.bandIndex, b.lower) },
          { key: 'stake', label: 'Stake', num: true, render: b => formatOpen(b.stakeCenti, { unit: false }) },
          { key: 'x', label: 'Mult.', num: true, render: b => formatX100(b.x100) },
          { key: 'status', label: 'Result', render: b => (b.status === 'won' ? statusLabel('info', `Won ${formatOpen(b.payoutCenti, { unit: false })}`) : b.status === 'refunded' ? statusLabel('warning', 'Refunded') : statusLabel('neutral', b.status === 'lost' ? 'Lost' : 'Open')) },
        ],
      }))),
      h('section', { class: 'stack' }, h('h3', { text: 'Deposits' }), h('div', { class: 'table-wrap' }, movementTable(detail.deposits, 'Deposits'))),
      h('section', { class: 'stack' }, h('h3', { text: 'Withdrawal vouchers' }), h('div', { class: 'table-wrap' }, voucherTable(detail.withdrawals))),
      proofSection(addr),
      h('section', { class: 'stack' }, h('h3', { text: 'Flag history' }), h('div', { class: 'table-wrap' }, dataTable({
        caption: 'Flag history', rows: detail.flags, empty: 'No flags or blocks recorded.',
        columns: [
          { key: 'ms', label: 'When (UTC)', render: f => formatDateTime(f.ms) },
          { key: 'action', label: 'Action', render: f => f.action },
          { key: 'actor', label: 'Actor', render: f => f.actor },
          { key: 'reason', label: 'Reason', wrap: true, render: f => f.reason },
        ],
      }))));
    if (pnl.t.length >= 2) {
      requestAnimationFrame(() => {
        pnlChart = new TimeChart(chartHost, { name: 'Player P&L', height: 160, yFormat: v => formatOpenCompact(BigInt(Math.round(v * 100)), { unit: false }) });
        pnlChart.setData({ t: pnl.t, values: pnl.centi.map(centiToNumber), label: i => formatOpen(pnl.centi[i] ?? '', { signed: true }) });
      });
    }
  }

  function movementTable(items: PlayerDetail['deposits'], caption: string): HTMLElement {
    return dataTable({
      caption, rows: items, empty: `No ${caption.toLowerCase()}.`,
      columns: [
        { key: 'ms', label: 'When (UTC)', render: m => formatDateTime(m.ms) },
        { key: 'amount', label: 'Amount', num: true, render: m => formatOpen(m.amountCenti) },
        { key: 'status', label: 'Status', render: m => m.status ?? '—' },
        { key: 'tx', label: 'Transaction', render: m => { if (!m.txHash) return '—'; const url = explorerUrl(ctx.chainId(), 'tx', m.txHash); return url ? h('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' }, text: `${m.txHash.slice(0, 10)}…` }) : h('span', { class: 'mono', text: `${m.txHash.slice(0, 10)}…` }); } },
        { key: 'dust', label: 'Dust (wei)', num: true, render: m => m.dustWei && m.dustWei !== '0' ? m.dustWei : '—' },
      ],
    });
  }

  /** Vouchers with their SPEC-11 lifecycle: signing → pending → claimed (by a Withdrawn event) | expired | cancelled. */
  function voucherTable(items: PlayerDetail['withdrawals']): HTMLElement {
    const kind = (s: string | undefined): StatusKind => (s === 'claimed' ? 'good' : s === 'pending' ? 'info' : s === 'signing' ? 'warning' : s === 'expired' || s === 'cancelled' ? 'neutral' : 'neutral');
    const tx = (hash: string | undefined) => { if (!hash) return '—'; const url = explorerUrl(ctx.chainId(), 'tx', hash); return url ? h('a', { attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' }, text: `${hash.slice(0, 10)}…` }) : h('span', { class: 'mono', title: hash, text: `${hash.slice(0, 10)}…` }); };
    return dataTable({
      caption: 'Withdrawal vouchers', rows: items, empty: 'No withdrawals.',
      columns: [
        { key: 'ms', label: 'Created (UTC)', render: m => formatDateTime(m.ms) },
        { key: 'amount', label: 'Amount', num: true, render: m => formatOpen(m.amountCenti) },
        { key: 'status', label: 'Status', render: m => statusLabel(kind(m.status), m.status ?? '—') },
        { key: 'exp', label: 'Expiry (UTC)', render: m => (m.expiryMs === undefined ? '—' : formatDateTime(m.expiryMs)) },
        { key: 'tx', label: 'Claim tx', render: m => tx(m.txHash ?? m.submittedTxHash) },
        { key: 'note', label: 'Note', wrap: true, render: m => [m.claimSource ? `claimed via ${m.claimSource}` : '', m.claimNote ?? '', m.releaseReason ? `released: ${m.releaseReason}` : ''].filter(Boolean).join(' · ') || '—' },
      ],
    });
  }

  /** On-chain players: look up the escape-hatch proof on demand (public player route). */
  function proofSection(address: string): HTMLElement | null {
    const addr = proofAddress(address);
    if (!addr) return null;
    const lookup = proofLookup(api, { chainId: () => ctx.chainId(), nowMs: () => store.serverNow() ?? Date.now(), compact: true });
    const btn = h('button', { class: 'btn small', style: { 'align-self': 'flex-start' }, attrs: { type: 'button' }, text: 'Look up escape-hatch proof' });
    btn.addEventListener('click', () => { btn.hidden = true; void lookup.lookup(addr); });
    return h('section', { class: 'stack' }, h('h3', { text: 'Escape-hatch proof' }), btn, lookup.el);
  }

  async function loadThresholds(): Promise<void> {
    const r = await api.defenses();
    if (r.ok) toxicity = r.data.config.toxicity;
  }

  async function openPlayer(account: string, keepOpen = false): Promise<void> {
    selected = account;
    if (!keepOpen) { detail = null; renderTable(); }
    panel.open(shortAddress(account), h('span', { class: 'mono', text: account }));
    if (!keepOpen) renderDetail();
    const result = await api.player(account);
    if (selected !== account) return;
    if (!result.ok) { replace(panel.body, errorNotice(result.error)); return; }
    detail = result.data;
    renderDetail();
  }

  const poller = new Poller(async () => { if (!panel.isOpen && document.activeElement !== search.input) await reload(); }, ctx.demo ? 10_000 : 30_000);

  return {
    el,
    mount() { renderTable(); poller.start(); void loadThresholds().then(() => { if (toxicity) renderTable(); }); },
    unmount() { poller.stop(); },
    focusSearch() { search.input.focus(); search.input.select(); },
    dismiss() { if (!panel.isOpen) return false; panel.close(); return true; },
    openAccount(account: string) { void openPlayer(account); },
  } as Page & { openAccount(account: string): void };
}
