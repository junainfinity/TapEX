/** Odds & RTP: realized vs target by multiplier range and phase, calibration drift, tables and refit. */
import { Poller, type AppContext, type Page } from '../app.js';
import { driftChart, reliabilityChart, rtpBarChart, type DriftRow, type RtpBarGroup } from '../charts/svg-charts.js';
import { onThemeChange, token } from '../charts/theme.js';
import { refitPlan } from '../controls.js';
import { formatDateTime, formatInt, formatPct, formatPts, marketLabel } from '../format.js';
import { formatOpen } from '../money.js';
import { driftLevel, driftZ, rtpBand, rtpTarget } from '../rtp-stats.js';
import type { RtpReport, RtpRow } from '../types.js';
import { chartCard, dataTable, errorNotice, legend } from '../ui/components.js';
import { h, replace, statusLabel, type StatusKind } from '../ui/dom.js';

const PHASE_NAMES: Record<string, string> = { launch: 'Launch boost', standard: 'Standard' };
const rangeLabel = (key: string) => `${key.replace('-', '–')}×`;
/** A range or phase with no bets has no target (the server sends expected 0): say so instead of "0.00%". */
const targetText = (r: RtpRow) => { const t = rtpTarget(r); return t === null ? 'no bets' : formatPct(t); };

function levelKind(z: number | null): StatusKind {
  const level = driftLevel(z);
  return level === 'drift' ? 'critical' : level === 'watch' ? 'warning' : z === null ? 'neutral' : 'good';
}
function levelText(z: number | null): string {
  const level = driftLevel(z);
  return z === null ? 'Too few bets' : level === 'drift' ? 'Drift' : level === 'watch' ? 'Watch' : 'Within band';
}

export function createOddsPage(ctx: AppContext): Page {
  const { api, store } = ctx;
  let report: RtpReport | null = null;
  let tablesKey = '';
  const unsubs: (() => void)[] = [];

  const refitBtn = h('button', { class: 'btn primary', attrs: { type: 'button' }, text: 'Refit now' });
  const tablesHost = h('div', { class: 'stack' });
  const refitHost = h('div', { class: 'refit-progress', attrs: { 'aria-live': 'polite' } });
  const tablesCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'tables-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'tables-title', text: 'Pricing tables' }), h('span', { class: 'sub', text: 'maya-calibrated-v3 · refit every 6 h or on command; issued quotes never change' })), refitBtn),
    tablesHost, refitHost);

  const barsCard = chartCard('Realized vs target RTP by multiplier range', 'bars = realized · black tick = target · gray band = target ± 2 SE');
  const driftCard = chartCard('Calibration drift', 'realized − expected in standard errors; beyond ±2 SE is worth a look, beyond ±3 SE is drift');
  const reliabilityCard = chartCard('Reliability', 'predicted touch probability vs observed hit rate');
  reliabilityCard.el.hidden = true;
  const phaseHost = h('div', { class: 'table-wrap' });
  const marketHost = h('div', { class: 'table-wrap' });
  const errorHost = h('div');

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Odds & RTP' }), h('p', { class: 'lede', text: 'Is the house paying what the tables priced? Realized RTP is judged against its sampling noise, which grows with the multiplier.' }))),
    errorHost,
    tablesCard,
    barsCard.el,
    h('div', { class: 'grid-2' },
      h('section', { class: 'card', attrs: { 'aria-labelledby': 'phase-title' } }, h('div', { class: 'card-head' }, h('h2', { id: 'phase-title', text: 'By phase' })), phaseHost),
      h('section', { class: 'card', attrs: { 'aria-labelledby': 'market-title' } }, h('div', { class: 'card-head' }, h('h2', { id: 'market-title', text: 'By market' })), marketHost)),
    driftCard.el,
    reliabilityCard.el);

  refitBtn.addEventListener('click', () => {
    const o = store.snapshot.overview;
    const tables = report?.tables?.length ? report.tables : (o?.markets ?? []).map(m => ({ market: m.id, tableId: m.tableId }));
    void ctx.act(refitPlan(tables), () => poller.kick());
  });

  function renderTables(): void {
    const o = store.snapshot.overview;
    const rows = report?.tables?.length ? report.tables.map(t => ({ market: t.market, tableId: t.tableId, builtMs: t.builtMs, previous: t.previousTableId }))
      : (o?.markets ?? []).map(m => ({ market: m.id, tableId: m.tableId, builtMs: undefined as number | undefined, previous: undefined as string | undefined }));
    replace(tablesHost, h('div', { class: 'table-wrap' }, dataTable({
      caption: 'Current pricing tables', rows, empty: 'No table information yet.',
      columns: [
        { key: 'market', label: 'Market', render: r => r.market },
        { key: 'table', label: 'Current table', render: r => h('code', { text: r.tableId }) },
        { key: 'built', label: 'Built (UTC)', render: r => formatDateTime(r.builtMs) },
        { key: 'prev', label: 'Kept for issued quotes', render: r => r.previous ? h('code', { text: r.previous }) : '—' },
      ],
    })), report?.lastRefitMs ? h('span', { class: 'muted', text: `Last refit ${formatDateTime(report.lastRefitMs)}` }) : null);
  }

  function renderRefits(): void {
    const jobs = [...store.snapshot.refits.values()].slice(-4).reverse();
    replace(refitHost, ...jobs.map(job => {
      const kind: StatusKind = job.state === 'done' ? 'good' : job.state === 'failed' ? 'critical' : 'info';
      const fill = h('div', { class: 'fill', style: { width: `${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%` } });
      return h('div', { class: 'stack', style: { gap: '4px' } },
        h('div', { class: 'row' }, statusLabel(kind, `Refit ${job.jobId}${job.market ? ` · ${marketLabel(job.market)}` : ''}: ${job.state}`), h('span', { class: 'muted tabular', text: formatPct(job.progress, 0) }), job.tableId ? h('code', { text: job.tableId }) : null),
        h('div', { class: `progress${job.state === 'done' ? ' done' : ''}`, attrs: { role: 'progressbar', 'aria-label': `Refit ${job.jobId}`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(job.progress * 100) } }, fill),
        job.message ? h('span', { class: 'muted', text: job.message }) : null);
    }));
  }

  function barGroups(rows: readonly RtpRow[]): { groups: RtpBarGroup[]; phases: string[] } {
    const keys = [...new Set(rows.map(r => r.key))];
    const phases = [...new Set(rows.map(r => r.phase ?? 'all'))].sort((a, b) => (a === 'launch' ? -1 : b === 'launch' ? 1 : 0));
    const groups = keys.map(key => ({
      key, label: rangeLabel(key),
      bars: rows.filter(r => r.key === key).map(r => {
        const band = rtpBand(r);
        const series = Math.min(1, Math.max(0, phases.indexOf(r.phase ?? 'all'))) as 0 | 1;
        return { series, seriesName: PHASE_NAMES[r.phase ?? ''] ?? 'All phases', realized: r.realized, expected: rtpTarget(r), low: band?.low ?? null, high: band?.high ?? null, bets: r.bets };
      }),
    }));
    return { groups, phases };
  }

  function renderBars(): void {
    if (!report) return;
    const rows = report.byRange;
    const { groups, phases } = barGroups(rows);
    const width = Math.max(320, barsCard.body.clientWidth || 800);
    replace(barsCard.body, rows.length ? rtpBarChart(groups, width) : h('div', { class: 'empty', text: 'No settled bets yet.' }));
    barsCard.setLegend(legend([
      ...phases.slice(0, 2).map((p, i) => ({ label: PHASE_NAMES[p] ?? 'All phases', color: token(i === 0 ? 'series-1' : 'series-2'), kind: 'swatch' as const })),
      { label: 'Target (expected RTP)', color: token('ink'), kind: 'line' },
      { label: 'Target band ± 2 SE', kind: 'band' },
    ]));
    barsCard.setTable(() => h('div', { class: 'table-wrap' }, dataTable({
      caption: 'RTP by multiplier range and phase', rows,
      columns: [
        { key: 'range', label: 'Range', render: r => rangeLabel(r.key) },
        { key: 'phase', label: 'Phase', render: r => PHASE_NAMES[r.phase ?? ''] ?? 'All' },
        { key: 'bets', label: 'Bets', num: true, render: r => formatInt(r.bets) },
        { key: 'handle', label: 'Handle', num: true, render: r => r.handleCenti ? formatOpen(r.handleCenti) : '—' },
        { key: 'expected', label: 'Target', num: true, render: r => targetText(r) },
        { key: 'band', label: 'Band', num: true, render: r => { const b = rtpBand(r); return b ? `${formatPct(b.low, 1)} – ${formatPct(b.high, 1)}${b.source === 'approx' ? ' ≈' : ''}` : '—'; } },
        { key: 'realized', label: 'Realized', num: true, render: r => formatPct(r.realized) },
      ],
    })));
  }

  function summaryTable(rows: readonly RtpRow[], caption: string, labelFor: (r: RtpRow) => string): HTMLElement {
    return dataTable({
      caption, rows, empty: 'No data yet.',
      columns: [
        { key: 'key', label: caption.includes('phase') ? 'Phase' : 'Market', render: labelFor },
        { key: 'bets', label: 'Bets', num: true, render: r => formatInt(r.bets) },
        { key: 'handle', label: 'Handle', num: true, render: r => r.handleCenti ? formatOpen(r.handleCenti) : '—' },
        { key: 'expected', label: 'Target', num: true, render: r => targetText(r) },
        { key: 'realized', label: 'Realized', num: true, render: r => formatPct(r.realized) },
        { key: 'gap', label: 'Gap', num: true, render: r => { const t = rtpTarget(r); return r.realized === null || t === null ? '—' : formatPts(r.realized - t); } },
      ],
    });
  }

  function renderDrift(): void {
    if (!report) return;
    const rows: DriftRow[] = report.byRange.map(r => {
      const z = driftZ(r, rtpBand(r));
      return { label: `${rangeLabel(r.key)}${r.phase ? ` · ${PHASE_NAMES[r.phase]}` : ''}`, z, realized: r.realized, expected: rtpTarget(r), bets: r.bets, level: levelKind(z) };
    });
    const width = Math.max(320, driftCard.body.clientWidth || 800);
    replace(driftCard.body, rows.length ? driftChart(rows, width) : h('div', { class: 'empty', text: 'No settled bets yet.' }));
    driftCard.setLegend(legend([
      { label: 'House favoured (realized below target)', color: token('diverge-neg'), kind: 'swatch' },
      { label: 'Players favoured (realized above target)', color: token('diverge-pos'), kind: 'swatch' },
    ]));
    driftCard.setTable(() => h('div', { class: 'table-wrap' }, dataTable({
      caption: 'Calibration drift', rows,
      columns: [
        { key: 'label', label: 'Range · phase', render: r => r.label },
        { key: 'z', label: 'Drift (SE)', num: true, render: r => (r.z === null ? '—' : `${r.z >= 0 ? '+' : '−'}${Math.abs(r.z).toFixed(2)}`) },
        { key: 'status', label: 'Status', render: r => statusLabel(r.level, levelText(r.z)) },
        { key: 'bets', label: 'Bets', num: true, render: r => formatInt(r.bets) },
      ],
    })));
    if (report.calibration && report.calibration.length > 0) {
      reliabilityCard.el.hidden = false;
      const points = report.calibration;
      replace(reliabilityCard.body, reliabilityChart(points, Math.max(320, reliabilityCard.body.clientWidth || 600), 400));
      reliabilityCard.setLegend(legend([{ label: 'Table bucket (predicted vs observed)', color: token('series-1'), kind: 'swatch' }, { label: 'Perfect calibration (diagonal)', color: token('ink-3'), kind: 'line' }]));
      reliabilityCard.setTable(() => h('div', { class: 'table-wrap' }, dataTable({
        caption: 'Reliability', rows: points,
        columns: [
          { key: 'p', label: 'Predicted', num: true, render: p => formatPct(p.predicted, 1) },
          { key: 'o', label: 'Observed', num: true, render: p => formatPct(p.observed, 1) },
          { key: 'n', label: 'Samples', num: true, render: p => formatInt(p.n) },
        ],
      })));
    }
  }

  function render(): void {
    renderTables();
    if (!report) return;
    renderBars();
    renderDrift();
    replace(phaseHost, summaryTable(report.byPhase, 'RTP by phase', r => PHASE_NAMES[r.key] ?? r.key));
    replace(marketHost, summaryTable(report.byMarket, 'RTP by market', r => r.key));
  }

  async function load(): Promise<void> {
    barsCard.setLoading(true);
    const result = await api.rtp();
    barsCard.setLoading(false);
    replace(errorHost, result.ok ? null : errorNotice(result.error));
    if (result.ok) { report = result.data; render(); }
  }

  const poller = new Poller(load, ctx.demo ? 5_000 : 15_000);
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const onResize = () => { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); };

  return {
    el,
    mount() {
      unsubs.push(store.on('refit', () => { renderRefits(); const last = [...store.snapshot.refits.values()].pop(); if (last?.state === 'done') poller.kick(); }), store.on('overview', () => { if (report?.tables?.length) return; const key = (store.snapshot.overview?.markets ?? []).map(m => m.tableId).join('|'); if (key !== tablesKey) { tablesKey = key; renderTables(); } }), onThemeChange(render));
      window.addEventListener('resize', onResize);
      render(); renderRefits();
      poller.start();
    },
    unmount() {
      for (const u of unsubs.splice(0)) u();
      window.removeEventListener('resize', onResize);
      poller.stop();
    },
  };
}
