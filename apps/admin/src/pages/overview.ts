/** Overview: health strip, KPI tiles, equity/GGR/liability/throughput small multiples, live bet ticker. */
import { indexAtOrBefore, Poller, thin, type AppContext, type Page } from '../app.js';
import { TimeChart } from '../charts/timeseries.js';
import { effectiveEdge } from '../controls.js';
import { formatAge, formatDateTime, formatInt, formatPct, formatPts, formatTime, marketLabel, marketShort, networkLabel, shortAddress, squareLabel } from '../format.js';
import { isOverviewStale } from '../banners.js';
import { chainSummary } from '../chain-health.js';
import { breakerSeverity, feedHealth, isBreakerActive, launchProgress, worst } from '../health.js';
import { centiDelta, centiToNumber, formatOpen, formatOpenCompact, formatUsdEstimate, formatX100, parseCenti } from '../money.js';
import type { BetLeg, ChainState, DefensesView, MetricsSeries } from '../types.js';
import { chartCard, dataTable, deltaText, deltaTone, meter, segmented, tile, usdNote, type ChartCard } from '../ui/components.js';
import { h, replace, setText, statusIcon, statusLabel, type StatusKind } from '../ui/dom.js';
import { equityTileValue } from '../view-models.js';

type RangeKey = '1h' | '6h' | '24h';
const RANGES: Record<RangeKey, { ms: number; step: number; label: string }> = {
  '1h': { ms: 3_600_000, step: 60_000, label: '1 h' },
  '6h': { ms: 21_600_000, step: 300_000, label: '6 h' },
  '24h': { ms: 86_400_000, step: 900_000, label: '24 h' },
};
const TICKER_ROWS = 10;

interface HealthCell { el: HTMLElement; value: HTMLElement; detail: HTMLElement; set(kind: StatusKind, value: string, detail: string): void }

function healthCell(label: string): HealthCell {
  const value = h('div', { class: 'value' });
  const detail = h('div', { class: 'detail' });
  const el = h('section', { class: 'health-item', attrs: { 'aria-label': label } }, h('div', { class: 'label', text: label }), value, detail);
  let last = '';
  return {
    el, value, detail,
    set(kind, v, d) {
      const key = `${kind}|${v}`;
      if (key !== last) { last = key; replace(value, statusLabel(kind, v)); }
      setText(detail, d);
      detail.title = d;
    },
  };
}

export function createOverviewPage(ctx: AppContext): Page {
  const { api, store, settings } = ctx;
  let range: RangeKey = '6h';
  let metrics: MetricsSeries | null = null;
  let chain: ChainState | null = null;
  let defenses: DefensesView | null = null;
  let tickerPaused = false;
  let waitingForClock = false;
  const unsubs: (() => void)[] = [];

  // Health strip
  const feedCell = healthCell('Feed');
  const chainCell = healthCell('Chain');
  const breakerCell = healthCell('Breakers');
  const streamCell = healthCell('Live stream');
  const defenseCell = healthCell('Defenses');
  const boostFill = h('div', { class: 'fill', style: { width: '0%' } });
  const boostBar = h('div', { class: 'progress', attrs: { role: 'progressbar', 'aria-label': 'Launch boost progress', 'aria-valuemin': 0, 'aria-valuemax': 100 } }, boostFill);
  const boostCount = h('span', { class: 'boost-count', text: '—' });
  const boostState = h('span');
  const boostDetail = h('div', { class: 'detail' });
  const boost = h('section', { class: 'health-item boost', attrs: { 'aria-label': 'Launch boost' } },
    h('div', { class: 'boost-row' }, h('span', { class: 'label', text: 'Launch boost' }), boostState), h('div', { class: 'boost-row' }, boostCount), boostBar, boostDetail);

  // KPI tiles
  const tEquity = tile('House equity · OPEN', 'Equity trend');
  tEquity.el.classList.add('tile-exact');
  const tGgr = tile('GGR · 24 h', 'GGR trend');
  const tHandle = tile('Handle · 24 h', 'Handle trend');
  const tRtp = tile('Realized RTP · 24 h', 'RTP trend');
  const tLiability = tile('Open liability', 'Open liability trend');
  const tPlayers = tile('Players', 'Registered players trend');
  const tBets = tile('Bets / min', 'Bets per minute trend');
  const tHold = tile('Hold latency p95');
  const tToxic = tile('Toxic-flow share · 1 h');
  const liabilityMeter = meter('Global limit used');
  liabilityMeter.el.style.width = '100%';

  // Charts: four single-series small multiples sharing a cursor (never a dual axis).
  const chartDefs = [
    { key: 'equity', title: 'House equity', sub: 'OPEN', money: true },
    { key: 'ggr', title: 'GGR (24 h rolling)', sub: 'OPEN · house gross gaming revenue', money: true },
    { key: 'openLiability', title: 'Open liability', sub: 'OPEN · Σ (payout − stake) over open legs', money: true },
    { key: 'betsPerMin', title: 'Bets per minute', sub: 'accepted legs', money: false },
  ] as const;
  const cards: Record<string, { card: ChartCard; chart: TimeChart }> = {};
  const chartGrid = h('div', { class: 'grid-2' });
  for (const def of chartDefs) {
    const card = chartCard(def.title, def.sub);
    const chart = new TimeChart(card.body, {
      name: def.title, height: 180, syncKey: 'overview',
      yFormat: def.money ? v => formatOpenCompact(BigInt(Math.round(v * 100)), { unit: false }) : v => formatInt(v),
      zeroBased: def.key !== 'equity',
    });
    cards[def.key] = { card, chart };
    chartGrid.append(card.el);
  }

  // Live ticker
  const tickerList = h('div', { class: 'ticker', attrs: { role: 'log', 'aria-label': 'Live bets', 'aria-live': 'off' } });
  const pauseBtn = h('button', { class: 'btn small', attrs: { type: 'button', 'aria-pressed': 'false' }, text: 'Pause' });
  pauseBtn.addEventListener('click', () => {
    tickerPaused = !tickerPaused;
    pauseBtn.setAttribute('aria-pressed', String(tickerPaused));
    pauseBtn.textContent = tickerPaused ? 'Resume' : 'Pause';
    if (!tickerPaused) renderTicker();
  });
  const tickerNote = h('span', { class: 'sub', text: 'sampled ≤ 20/s · stakes in OPEN' });
  const tickerCard = h('section', { class: 'card', attrs: { 'aria-labelledby': 'ticker-title' } },
    h('div', { class: 'card-head' }, h('div', { class: 'card-title' }, h('h2', { id: 'ticker-title', text: 'Live bets' }), tickerNote), pauseBtn),
    tickerList);

  const rangeControl = segmented<RangeKey>('Chart range', (Object.keys(RANGES) as RangeKey[]).map(k => ({ value: k, label: RANGES[k].label })), range, value => { range = value; void loadMetrics(); });
  const usd = h('p', { class: 'muted', text: usdNote(settings) });
  const lede = h('p', { class: 'lede', text: 'Waiting for the first overview…' });
  // Shown when no overview has arrived for a while: the tiles and health strip grey out and say since when.
  // The announced text is stable (as-of time, poll error); the ticking age is visual only, so screen readers are not re-alerted every second.
  const staleText = h('span');
  const staleAge = h('span', { class: 'tabular', attrs: { 'aria-hidden': 'true' } });
  const staleNote = h('div', { class: 'stale-note', hidden: true, attrs: { role: 'alert' } }, statusIcon('critical'), h('span', {}, staleText, ' ', staleAge));
  const healthStrip = h('div', { class: 'health' }, feedCell.el, chainCell.el, breakerCell.el, defenseCell.el, streamCell.el, boost);
  const tilesGrid = h('div', { class: 'tiles' }, tEquity.el, tGgr.el, tHandle.el, tRtp.el, tLiability.el, tPlayers.el, tBets.el, tHold.el, tToxic.el);

  const el = h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', { text: 'Overview' }), lede), h('div', { class: 'page-head-actions' }, h('span', { class: 'muted', text: 'Charts' }), rangeControl)),
    staleNote,
    healthStrip,
    tilesGrid,
    h('div', { class: 'split' }, chartGrid, tickerCard),
    usd);

  function metricAt(series: readonly string[], ago: number): string | null {
    if (!metrics || metrics.t.length === 0) return null;
    const last = metrics.t[metrics.t.length - 1]!;
    const i = indexAtOrBefore(metrics.t, last - ago);
    return i >= 0 ? series[i] ?? null : null;
  }

  function renderOverview(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    if (waitingForClock) { waitingForClock = false; metricsPoller.kick(); }
    setText(lede, `${networkLabel(o.network, o.chainId)} · ${o.feedMode === 'replay' ? `replay ×${o.speed}` : 'live feed'} · server clock ${formatDateTime(o.clockMs)}`);
    renderFreshness();
    // Breakers
    const active = o.breakers.filter(isBreakerActive);
    breakerCell.set(active.length === 0 ? 'good' : active.some(b => breakerSeverity(b) === 'critical') ? 'critical' : 'warning',
      active.length === 0 ? 'All clear' : `${active.length} active`, active.length === 0 ? `${o.breakers.length} monitored` : active.map(b => `${b.id}${b.market ? ` ${b.market}` : ''}`).join(', '));
    // Launch boost
    const lp = launchProgress(o.launch, o.registeredPlayers);
    boostFill.style.width = `${(lp.share * 100).toFixed(2)}%`;
    boostBar.classList.toggle('done', lp.state !== 'active');
    boostBar.setAttribute('aria-valuenow', (lp.share * 100).toFixed(1));
    boostBar.setAttribute('aria-valuetext', lp.label);
    setText(boostCount, lp.label);
    setText(boostDetail, lp.detail);
    const stateKey = lp.state;
    if (boostState.dataset['state'] !== stateKey) {
      boostState.dataset['state'] = stateKey;
      replace(boostState, stateKey === 'active' ? h('span', { class: 'badge info', text: 'Active' }) : stateKey === 'ended' ? h('span', { class: 'badge good', text: 'Ended' }) : h('span', { class: 'badge', text: 'Off' }));
    }
    // KPI tiles
    const hour = 3_600_000;
    const equityThen = metrics ? metricAt(metrics.equity, hour) : null;
    const eqDelta = equityThen ? centiDelta(o.equityCenti, equityThen) : null;
    // Exact to the cent: a compact figure hid real moves (99,999,801.94 read as 99.9M).
    const equity = equityTileValue(o.equityCenti);
    tEquity.update({
      value: equity.value, title: equity.title,
      sub: settings.showUsd ? `${formatUsdEstimate(o.equityCenti, settings.refPrice)} est.` : `player balances ${formatOpenCompact(o.playerBalancesCenti)}`,
      delta: eqDelta === null ? null : { text: deltaText(eqDelta), tone: deltaTone(eqDelta, true), label: `${deltaText(eqDelta)} versus 1 hour ago` },
      spark: metrics ? thin(metrics.equity.map(centiToNumber), 40) : [],
    });
    const ggrThen = metrics ? metricAt(metrics.ggr, hour) : null;
    const ggrDelta = ggrThen ? centiDelta(o.ggr24hCenti, ggrThen) : null;
    tGgr.update({
      value: formatOpenCompact(o.ggr24hCenti, { signed: true }), title: formatOpen(o.ggr24hCenti, { signed: true }),
      sub: settings.showUsd ? `${formatUsdEstimate(o.ggr24hCenti, settings.refPrice)} est.` : 'house win, 24 h',
      delta: ggrDelta === null ? null : { text: deltaText(ggrDelta), tone: deltaTone(ggrDelta, true), label: `${deltaText(ggrDelta)} versus 1 hour ago` },
      spark: metrics ? thin(metrics.ggr.map(centiToNumber), 40) : [],
    });
    const handleThen = metrics ? metricAt(metrics.handle, hour) : null;
    const handleDelta = handleThen ? centiDelta(o.handle24hCenti, handleThen) : null;
    tHandle.update({
      value: formatOpenCompact(o.handle24hCenti), title: formatOpen(o.handle24hCenti),
      sub: settings.showUsd ? `${formatUsdEstimate(o.handle24hCenti, settings.refPrice)} est.` : 'total stakes, 24 h',
      delta: handleDelta === null ? null : { text: deltaText(handleDelta), tone: deltaTone(handleDelta, true), label: `${deltaText(handleDelta)} versus 1 hour ago` },
      spark: metrics ? thin(metrics.handle.map(centiToNumber), 40) : [],
    });
    const edge = effectiveEdge(o.launch, o.registeredPlayers);
    const target = 1 - edge;
    const rtpGap = Number.isFinite(o.rtp24h) ? o.rtp24h - target : null;
    tRtp.update({
      value: formatPct(o.rtp24h), sub: `target ${formatPct(target)} (edge ${formatPct(edge, 1)})`,
      delta: rtpGap === null ? null : { text: `${formatPts(rtpGap)} vs target`, tone: Math.abs(rtpGap) < 0.0005 ? 'flat' : rtpGap > 0 ? 'bad' : 'good', label: `${formatPts(rtpGap)} versus target RTP` },
      spark: metrics ? thin([...metrics.rtp], 40) : [],
    });
    const limitCenti = o.limits ? (parseCenti(o.equityCenti) ?? 0n) * BigInt(Math.round(o.limits.globalFraction * 1_000_000)) / 1_000_000n : null;
    tLiability.update({
      value: formatOpenCompact(o.openLiabilityCenti), title: formatOpen(o.openLiabilityCenti),
      sub: limitCenti === null ? `cell max ${formatPct(o.limitUsage.maxCell, 0)} · column max ${formatPct(o.limitUsage.maxColumn, 0)}` : `global limit ${formatOpenCompact(limitCenti)}`,
      delta: null, foot: liabilityMeter.el,
    });
    liabilityMeter.update(o.limitUsage.global);
    const playersThen = metrics && metrics.players.length ? metrics.players[Math.max(0, indexAtOrBefore(metrics.t, metrics.t[metrics.t.length - 1]! - hour))] : undefined;
    const playersDelta = playersThen ? (o.registeredPlayers - playersThen) / playersThen : null;
    tPlayers.update({
      value: formatInt(o.registeredPlayers), sub: `${formatInt(o.activePlayers5m)} active in last 5 min`,
      delta: playersDelta === null ? null : { text: deltaText(playersDelta), tone: deltaTone(playersDelta, true), label: `${deltaText(playersDelta)} versus 1 hour ago` },
      spark: metrics ? thin(metrics.players, 40) : [],
    });
    tBets.update({ value: formatInt(o.betsPerMin), sub: `${formatInt(o.betsPerMin * 60)} / h at this pace`, delta: null, spark: metrics ? thin(metrics.betsPerMin, 40) : [] });
    renderDefenses();
  }

  /** SPEC-10: acceptance hold latency and toxic-flow share (overview fields, live every 1 s; the hold cap comes from GET /defenses). */
  function renderDefenses(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    const cap = defenses?.config.hold.maxHoldMs;
    const p95 = o.holdLatencyP95Ms;
    const holdOn = o.defenses?.hold;
    if (p95 === undefined && holdOn === undefined) {
      tHold.update({ value: '—', sub: 'not reported by this server' });
      tToxic.update({ value: '—', sub: 'not reported by this server' });
      defenseCell.set('neutral', 'Not reported', 'server predates SPEC-10');
      return;
    }
    const atCap = p95 !== null && p95 !== undefined && cap !== undefined && p95 >= cap;
    tHold.update({
      value: p95 === null || p95 === undefined ? '—' : `${(p95 / 1000).toFixed(2)} s`,
      sub: `${holdOn === false ? 'hold off' : `reject ${formatPct(o.holdRejectRate ?? null, 1)} (1 h)`} · ${formatInt(o.holdPending ?? 0)} held`,
      delta: p95 === null || p95 === undefined || cap === undefined ? null : { text: `${atCap ? 'at' : 'under'} cap ${(cap / 1000).toFixed(1)} s`, tone: atCap ? 'bad' : 'good', label: atCap ? 'p95 hold latency is at the maximum hold' : 'p95 hold latency is under the maximum hold' },
    });
    const flagged = defenses ? `${formatInt(defenses.toxicity.flagged)} flagged · ${formatInt(defenses.toxicity.blocked)} blocked` : 'share of handle from flagged accounts';
    tToxic.update({ value: formatPct(o.toxicFlowShare ?? null, 1), sub: flagged });
    const d = o.defenses;
    if (!d) { defenseCell.set('neutral', 'Not reported', ''); return; }
    const off = [!d.hold && 'hold', !d.quoteValidity && 'quote validity', !d.ramp && 'ramp', d.toxicity !== 'graduated' && 'toxicity', !d.controller && 'controller'].filter((x): x is string => typeof x === 'string');
    const level: StatusKind = !d.hold ? 'critical' : off.length ? 'warning' : 'good';
    defenseCell.set(level, off.length ? `${off.length} off` : 'All on', off.length ? `off: ${off.join(', ')}` : `lead ${d.minLeadS} s · reject ${formatPct(o.holdRejectRate ?? null, 0)} · toxic ${formatPct(o.toxicFlowShare ?? null, 1)}`);
  }

  /**
   * Feed ages and staleness, every second: between overviews the freshest price keeps ageing (uncapped
   * clock), and when nothing has arrived for a while the tiles and health strip grey out with an "as of".
   */
  function renderFreshness(): void {
    const o = store.snapshot.overview;
    if (!o) return;
    const feeds = feedHealth(o.markets, store.feedNow());
    const feedLevel = worst(feeds.map(f => f.level));
    feedCell.set(feedLevel, o.feedMode === 'replay' ? `Replay ×${o.speed}` : 'Live', feeds.map(f => `${marketShort(f.market)} ${f.ageMs === null ? '—' : formatAge(f.ageMs)}`).join(' · '));
    const age = store.overviewAgeMs();
    const stale = isOverviewStale(age);
    healthStrip.classList.toggle('stale', stale);
    tilesGrid.classList.toggle('stale', stale);
    staleNote.hidden = !stale;
    if (stale) {
      setText(staleText, `Stale: no update from the server. Figures below are as of ${formatDateTime(o.clockMs)} (server clock).${store.snapshot.pollError ? ` Last poll: ${store.snapshot.pollError.code} ${store.snapshot.pollError.message}.` : ''}`);
      setText(staleAge, `Nothing received for ${formatAge(age)}.`);
    }
  }

  function renderStream(): void {
    const s = store.snapshot.stream;
    const last = store.snapshot.lastEventMs;
    const since = last ? `last event ${formatAge(Date.now() - last)} ago` : 'no events yet';
    switch (s.status) {
      case 'open': streamCell.set('good', 'Live', since); break;
      case 'connecting': streamCell.set('warning', 'Connecting', `attempt ${s.attempt}`); break;
      case 'reconnecting': streamCell.set('warning', 'Reconnecting', `in ${formatAge(Math.max(0, s.retryAt - Date.now()))} · ${s.lastError}`); break;
      case 'unauthorized': streamCell.set('critical', 'Unauthorized', 'token rejected'); break;
      default: streamCell.set('neutral', 'Stopped', since);
    }
  }

  function renderChain(): void {
    if (!chain) { chainCell.set('neutral', 'Loading', ''); return; }
    // An unreadable vault (the server's placeholder) is critical, never "vault open".
    const summary = chainSummary(chain);
    chainCell.set(summary.level, summary.value, summary.detail);
  }

  function tickerRow(bet: BetLeg, fresh: boolean): HTMLElement {
    const status: [StatusKind, string] = bet.status === 'won' ? ['info', `Won ${formatOpen(bet.payoutCenti, { unit: false })}`] : bet.status === 'lost' ? ['neutral', 'Lost'] : bet.status === 'refunded' ? ['warning', 'Refunded'] : ['neutral', 'Open'];
    const account = h('button', { class: 'btn ghost small', style: { padding: '0 4px', height: "20px", 'justify-content': 'flex-start', 'max-width': '100%' }, attrs: { type: 'button', title: `Open ${bet.account}` }, text: `${bet.kind === 'onchain' ? '◆ ' : ''}${shortAddress(bet.account)}` });
    account.addEventListener('click', () => ctx.openPlayer(bet.account));
    return h('div', { class: `ticker-row${fresh ? ' fresh' : ''}` },
      h('span', { text: formatTime(bet.placedMs) }),
      h('div', { class: 'who' }, account, h('span', { class: 'sq', title: `Window starts ${formatTime(bet.start)} UTC`, text: squareLabel(bet.start, bet.bandIndex, bet.lower, bet.placedMs) })),
      h('span', { title: marketLabel(bet.market), text: marketShort(bet.market) }),
      h('span', { class: 'r', text: formatOpen(bet.stakeCenti, { unit: false }) }),
      h('span', { class: 'r', text: formatX100(bet.x100) }),
      statusLabel(status[0], status[1]));
  }

  let lastTopLeg = '';
  function renderTicker(): void {
    if (tickerPaused) return;
    const bets = store.snapshot.bets.slice(0, TICKER_ROWS);
    const top = bets[0]?.legId ?? '';
    const freshCount = lastTopLeg ? Math.max(0, bets.findIndex(b => b.legId === lastTopLeg)) : 0;
    lastTopLeg = top;
    replace(tickerList,
      h('div', { class: 'ticker-row head', attrs: { 'aria-hidden': 'true' } }, h('span', { text: 'Time' }), h('span', { text: 'Player · square' }), h('span', { text: 'Mkt' }), h('span', { class: 'r', text: 'Stake' }), h('span', { class: 'r', text: 'Mult.' }), h('span', { text: 'Status' })),
      ...bets.map((b, i) => tickerRow(b, i < freshCount)),
      bets.length === 0 ? h('div', { class: 'empty', text: 'Waiting for bets on the live stream…' }) : null);
  }

  function renderCharts(): void {
    const m = metrics;
    for (const def of chartDefs) {
      const entry = cards[def.key]!;
      if (!m) continue;
      if (def.money) {
        const series = m[def.key] as readonly string[];
        entry.chart.setData({ t: m.t, values: series.map(centiToNumber), label: i => formatOpen(series[i] ?? '') });
        entry.card.setTable(() => metricsTable(m.t, series.map(v => formatOpen(v)), def.title));
      } else {
        const series = m.betsPerMin;
        entry.chart.setData({ t: m.t, values: [...series], label: i => `${formatInt(series[i] ?? Number.NaN)} bets/min` });
        entry.card.setTable(() => metricsTable(m.t, series.map(v => formatInt(v)), def.title));
      }
    }
  }

  function metricsTable(t: readonly number[], values: readonly string[], title: string): HTMLElement {
    const rows = t.map((ms, i) => ({ ms, v: values[i] ?? '—' })).reverse();
    return h('div', { class: 'table-wrap', style: { 'max-height': '240px' } }, dataTable({ caption: title, columns: [
      { key: 't', label: 'Time (UTC)', render: r => formatDateTime(r.ms) },
      { key: 'v', label: title, num: true, render: r => r.v },
    ], rows }));
  }

  async function loadMetrics(): Promise<void> {
    const o = store.snapshot.overview;
    // The metrics window is anchored to the server clock (historical in replay mode), never the browser clock.
    if (!o) { waitingForClock = true; return; }
    const to = o.clockMs;
    const spec = RANGES[range];
    for (const def of chartDefs) cards[def.key]!.card.setLoading(true);
    const result = await api.metrics({ from: to - spec.ms, to, step: spec.step });
    for (const def of chartDefs) {
      const card = cards[def.key]!.card;
      card.setLoading(false);
      card.setError(result.ok ? null : result.error);
    }
    if (result.ok) { metrics = result.data; renderCharts(); renderOverview(); }
  }

  async function loadChain(): Promise<void> {
    const result = await api.chain();
    if (result.ok) { chain = result.data; store.setChain(result.data); renderChain(); }
    else chainCell.set('critical', 'Unavailable', `${result.error.code}: ${result.error.message}`);
  }

  async function loadDefenses(): Promise<void> {
    const result = await api.defenses();
    // Optional detail (cap, flagged counts): the tiles fall back to the overview fields without it.
    if (result.ok) { defenses = result.data; renderDefenses(); }
  }

  const metricsPoller = new Poller(loadMetrics, ctx.demo ? 10_000 : 30_000);
  const chainPoller = new Poller(loadChain, 15_000);
  const defensesPoller = new Poller(loadDefenses, 15_000);
  let streamTimer: ReturnType<typeof setInterval> | null = null;

  return {
    el,
    mount() {
      // A new server run replaces the metrics window and the chain state; the store already reset the ticker and audit.
      const onRun = () => { metrics = null; chain = null; renderChain(); metricsPoller.kick(); chainPoller.kick(); };
      unsubs.push(store.on('overview', renderOverview), store.on('bets', renderTicker), store.on('stream', renderStream), store.on('run', onRun), settings.on(() => { setText(usd, usdNote(settings)); renderOverview(); }));
      renderOverview(); renderTicker(); renderStream(); renderChain();
      metricsPoller.start(); chainPoller.start(); defensesPoller.start();
      streamTimer = setInterval(() => { renderStream(); renderFreshness(); }, 1000);
    },
    unmount() {
      for (const u of unsubs.splice(0)) u();
      metricsPoller.stop(); chainPoller.stop(); defensesPoller.stop();
      if (streamTimer) clearInterval(streamTimer);
    },
  };
}

