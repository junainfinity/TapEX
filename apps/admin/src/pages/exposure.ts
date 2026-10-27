/** Exposure: live liability heatmap per market, column totals, limit gauges, cell drill-down to legs. */
import { Poller, type AppContext, type Page } from '../app.js';
import { buildHeatModel, HeatmapView, HEAT_THRESHOLDS, shareLabel, type HeatCellModel, type HeatModel } from '../charts/heatmap.js';
import { onThemeChange, token } from '../charts/theme.js';
import { formatInt, formatPct, formatTime, marketLabel, shortAddress } from '../format.js';
import { formatOpen, formatX100 } from '../money.js';
import type { BetLeg, Exposure } from '../types.js';
import { chartCard, dataTable, errorNotice, meter, segmented } from '../ui/components.js';
import { h, replace, setText, statusLabel } from '../ui/dom.js';

export function createExposurePage(ctx: AppContext): Page {
  const { api, store } = ctx;
  let market: string | null = null;
  let exposure: Exposure | null = null;
  let model: HeatModel | null = null;
  let selectedKey: string | null = null;
  let selectedSnapshot: { cell: HeatCellModel; bandLabel: string } | null = null;
  const view = new HeatmapView({ onSelect: key => selectCell(key) });
  let legs: readonly BetLeg[] | null = null;
  const unsubs: (() => void)[] = [];

  const marketHost = h('div');
  const gGlobal = meter('Global liability vs limit');
  const gColumn = meter('Busiest column vs column limit');
  const gCell = meter('Busiest cell vs cell limit');
  const totalEl = h('div', { class: 'tabular', style: { 'font-size': '1.43rem', 'font-weight': '600' }, text: '—' });
  const gauges = h('section', { class: 'card', attrs: { 'aria-labelledby': 'gauges-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'gauges-title', text: 'Limit usage' }), h('span', { class: 'sub', text: 'all markets · fractions of live house equity' }))),
    h('div', { class: 'grid-3', style: { 'align-items': 'end' } },
      h('div', { class: 'stack', style: { gap: '4px' } }, h('span', { class: 'muted', text: 'Open liability (all markets)' }), totalEl),
      gGlobal.el, h('div', { class: 'stack' }, gColumn.el, gCell.el)));

  const heatCard = chartCard('Liability heatmap', 'share of each cell limit · click or press Enter on a cell for its legs');
  const scale = h('div', { class: 'scale-legend' });
  const legsTitle = h('h2', { id: 'legs-title', text: 'Cell legs' });
  const legsSub = h('span', { class: 'sub', text: 'Select a cell in the heatmap.' });
  const legsHost = h('div', { class: 'table-wrap heat-legs' });
  const legsCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'legs-title' } }, h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, legsTitle, legsSub)), legsHost);
  const errorHost = h('div');

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Exposure' }), h('p', { class: 'lede', text: 'Where the house is exposed right now: open liability (payout − stake) on the live quote grid.' })), h('div', { class: 'page-head-actions' }, marketHost)),
    gauges, errorHost, heatCard.el, legsCard);

  function renderScale(): void {
    const cuts = HEAT_THRESHOLDS.map(t => Math.round(t * 100));
    replace(scale,
      h('span', { text: 'Share of cell limit' }),
      h('span', { class: 'steps', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'step', style: { background: token('surface-2') }, title: 'no liability' }), ...[1, 2, 3, 4, 5, 6].map(i => h('span', { class: 'step', style: { background: token(`seq-${i}`) } }))),
      h('span', { class: 'tabular', text: ['empty', `>0–${cuts[0]}%`, ...cuts.slice(1).map((c, i) => `${cuts[i]}–${c}%`), `>${cuts[cuts.length - 1]}%`].join(' · ') }),
      h('span', { class: 'status status-warning' }, h('span', { attrs: { 'aria-hidden': 'true' }, text: '▲' }), h('span', { text: '> 90 % near limit' })));
    heatCard.setLegend(scale);
  }

  function renderMarkets(): void {
    const markets = store.snapshot.overview?.markets ?? [];
    if (markets.length === 0) return;
    if (!market || !markets.some(m => m.id === market)) market = markets[0]!.id;
    const key = markets.map(m => m.id).join('|');
    if (marketHost.dataset['key'] === key) return;
    marketHost.dataset['key'] = key;
    replace(marketHost, segmented('Market', markets.map(m => ({ value: m.id, label: marketLabel(m.id) })), market, value => { market = value; selectedKey = null; selectedSnapshot = null; legs = null; exposure = null; renderLegs(); poller.kick(); }));
  }

  function renderGauges(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    setText(totalEl, formatOpen(o.openLiabilityCenti));
    gGlobal.update(o.limitUsage.global, o.limits ? `limit ${formatPct(o.limits.globalFraction, 1)} of equity` : undefined);
    gColumn.update(o.limitUsage.maxColumn);
    gCell.update(o.limitUsage.maxCell);
  }

  function selectCell(key: string): void {
    const cell = model?.cells.get(key);
    if (!model || !cell) return;
    selectedKey = key;
    selectedSnapshot = { cell, bandLabel: model.bands.find(b => b.index === cell.bandIndex)?.label ?? String(cell.bandIndex) };
    renderHeat();
    void loadLegs();
  }

  function renderHeat(): void {
    if (!exposure) { replace(heatCard.body, h('div', { class: 'empty', text: 'Loading the quote grid…' })); return; }
    model = buildHeatModel(exposure);
    const width = Math.max(480, heatCard.body.clientWidth || 900);
    view.update(model, width, selectedKey);
    if (view.el.parentElement !== heatCard.body) replace(heatCard.body, view.el);
    const m = model;
    heatCard.setTable(() => h('div', { class: 'table-wrap' }, dataTable({
      caption: `Exposure for ${exposure?.market ? marketLabel(exposure.market) : ''}`,
      rows: [...m.cells.values()].sort((a, b) => a.start - b.start || b.bandIndex - a.bandIndex),
      columns: [
        { key: 'w', label: 'Window (UTC)', render: c => formatTime(c.start) },
        { key: 'b', label: 'Band', render: c => m.bands.find(b => b.index === c.bandIndex)?.label ?? String(c.bandIndex) },
        { key: 'x', label: 'Quote', num: true, render: c => (c.x100 === null ? 'not offered' : formatX100(c.x100)) },
        { key: 'l', label: 'Liability', num: true, render: c => formatOpen(c.liabilityCenti) },
        { key: 'lim', label: 'Cell limit', num: true, render: c => formatOpen(c.limitCenti) },
        { key: 's', label: 'Share', num: true, render: c => formatPct(c.share, 1) },
        { key: 'legs', label: 'Legs', num: true, render: c => formatInt(c.legs) },
      ],
    })));
  }

  function renderLegs(): void {
    if (!selectedKey || !selectedSnapshot) { setText(legsTitle, 'Cell legs'); setText(legsSub, 'Select a cell in the heatmap (click, or Enter on a focused cell).'); replace(legsHost, h('div', { class: 'empty', text: 'No cell selected.' })); return; }
    const live = model?.cells.get(selectedKey);
    const cell = live ?? selectedSnapshot.cell;
    setText(legsTitle, `Legs · ${market ? marketLabel(market) : ''} · window ${formatTime(cell.start)} UTC · ${selectedSnapshot.bandLabel}`);
    setText(legsSub, live
      ? `${formatOpen(cell.liabilityCenti)} liability of ${formatOpen(cell.limitCenti)} limit (${shareLabel(cell.share)}) · ${formatInt(cell.legs)} open legs`
      : `This window has started and left the quote grid; legs as of selection, with their result once settled (after ${formatTime(cell.start + 5_000)} UTC).`);
    if (legs === null) { replace(legsHost, h('div', { class: 'empty', text: 'Loading legs…' })); return; }
    replace(legsHost, dataTable({
      caption: 'Legs in the selected cell', rows: legs, rowKey: l => l.legId, empty: 'No legs in this cell.',
      onRowClick: l => ctx.openPlayer(l.account),
      columns: [
        { key: 'placed', label: 'Placed (UTC)', render: l => formatTime(l.placedMs) },
        { key: 'account', label: 'Player', render: l => `${l.kind === 'onchain' ? '◆ ' : ''}${shortAddress(l.account)}` },
        { key: 'stake', label: 'Stake', num: true, render: l => formatOpen(l.stakeCenti) },
        { key: 'x', label: 'Mult.', num: true, render: l => formatX100(l.x100) },
        { key: 'payout', label: 'Payout if won', num: true, render: l => formatOpen(l.payoutCenti) },
        { key: 'liab', label: 'Liability', num: true, render: l => formatOpen((BigInt(l.payoutCenti) - BigInt(l.stakeCenti)).toString()) },
        { key: 'status', label: 'Result', render: l => (l.status === 'open' ? statusLabel('neutral', 'Open') : l.status === 'won' ? statusLabel('info', 'Won') : l.status === 'refunded' ? statusLabel('warning', 'Refunded') : statusLabel('neutral', 'Lost')) },
        { key: 'phase', label: 'Phase', render: l => l.phase ?? '—' },
      ],
    }));
  }

  async function loadLegs(): Promise<void> {
    if (!selectedKey || !market) return;
    const key = selectedKey;
    const [startText, bandText] = key.split(':');
    const start = Number(startText); const band = Number(bandText);
    legs = null;
    renderLegs();
    // Filter on the server (start + bandIndex): a busy market has more than one page of legs. No status filter, so the
    // drill-down still lists the cell after its window settles (at replay speed that is often within seconds).
    const result = await api.bets({ market, start, bandIndex: band, limit: 500 });
    if (selectedKey !== key) return;
    if (!result.ok) { replace(legsHost, errorNotice(result.error)); return; }
    legs = result.data.rows.filter(l => l.start === start && l.bandIndex === band);
    renderLegs();
  }

  async function load(): Promise<void> {
    renderMarkets();
    if (!market) return;
    heatCard.setLoading(true);
    const requested = market;
    const result = await api.exposure(requested);
    heatCard.setLoading(false);
    if (requested !== market) return;
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (!result.ok) return;
    exposure = result.data;
    renderHeat();
    if (selectedKey) renderLegs();
  }

  const poller = new Poller(load, ctx.demo ? 1_500 : 2_000);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(renderHeat, 150); };

  return {
    el,
    mount() {
      unsubs.push(store.on('overview', () => { const hadMarket = market !== null; renderMarkets(); renderGauges(); if (!hadMarket && market !== null) poller.kick(); }), onThemeChange(() => { renderScale(); renderHeat(); }));
      window.addEventListener('resize', onResize);
      renderMarkets(); renderGauges(); renderScale(); renderHeat(); renderLegs();
      poller.start();
    },
    unmount() {
      for (const u of unsubs.splice(0)) u();
      window.removeEventListener('resize', onResize);
      poller.stop();
    },
  };
}
