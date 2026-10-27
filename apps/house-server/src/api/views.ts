import type { MarketId } from '@maya/contracts';
import { decimalToString } from '@maya/contracts';
import { maxStakeForLiability, tierConfig } from '@maya/house';
import { excessReturnZ, type HouseEngine, type PlayerRecord } from '../engine/engine.js';
import type { LegStatus, LegView } from '../engine/types.js';
import { HttpError } from './http.js';

/** Admin/player JSON for one leg (apps/admin BetLeg shape plus settlement detail). */
export function legJson(_engine: HouseEngine, leg: LegView): Record<string, unknown> {
  const bounds = { lower: decimalToString(leg.cell.lowerPrice), upper: decimalToString(leg.cell.upperPrice) };
  return {
    legId: leg.legId, requestId: leg.requestId, quoteId: leg.quoteId, account: leg.account, kind: leg.kind, ...(leg.strategy ? { strategy: leg.strategy } : {}),
    market: leg.cell.marketId, cellId: leg.cell.cellId, start: leg.cell.startMs, end: leg.cell.endMs, bandIndex: leg.bandIndex, ...bounds,
    stakeCenti: leg.stakeCenti, x100: leg.x100, payoutCenti: leg.payoutCenti, status: leg.status, placedMs: leg.placedMs, phase: leg.phase, edge: leg.edge, p: leg.p, tableId: leg.tableId,
    ...(leg.requestedMs !== undefined ? { requestedMs: leg.requestedMs, heldMs: leg.placedMs - leg.requestedMs } : {}), ...(leg.pFresh !== undefined ? { pFresh: leg.pFresh } : {}),
    ...(leg.ctlAdjust ? { ctlAdjust: leg.ctlAdjust } : {}), flagged: leg.flagged,
    ...(leg.settlement ? { settledMs: leg.settlement.settledMs, creditCenti: leg.settlement.creditCenti, evidenceSampleIds: leg.settlement.evidenceSampleIds, settlementReason: leg.settlement.reason, ...(leg.settlement.touchTimeMs !== undefined ? { touchTimeMs: leg.settlement.touchTimeMs } : {}) } : {}),
  };
}

export function playerRow(engine: HouseEngine, p: PlayerRecord): Record<string, unknown> {
  return {
    account: p.account, kind: p.kind, ...(p.strategy ? { strategy: p.strategy } : {}), balanceCenti: engine.balanceOf(p.account).toString(),
    handleCenti: p.handle.toString(), pnlCenti: (p.returned - p.settledStake).toString(), bets: p.bets, openBets: p.openBets, wins: p.wins,
    rtp: p.settledStake > 0n ? Number(p.returned) / Number(p.settledStake) : null, flagged: p.flagged, blocked: p.blocked, firstSeenMs: p.firstSeenMs, lastBetMs: p.lastBetMs || null,
    // SPEC-10 evidence the toxicity monitor acts on.
    holds: p.holdsPlaced, latencyZ: p.holdN > 0 ? engine.holdMoveZ(p) : null, excessReturnZ: p.settledBets > 0 ? excessReturnZ(p) : null,
  };
}

const SORTS: Record<string, (e: HouseEngine, p: PlayerRecord) => number | bigint> = {
  balance: (e, p) => e.balanceOf(p.account), handle: (_e, p) => p.handle, pnl: (_e, p) => p.returned - p.settledStake, bets: (_e, p) => p.bets,
  rtp: (_e, p) => (p.settledStake > 0n ? Number(p.returned) / Number(p.settledStake) : -1), firstSeen: (_e, p) => p.firstSeenMs,
};

export function playersPage(engine: HouseEngine, q: URLSearchParams, limit: number): Record<string, unknown> {
  const sortRaw = q.get('sort') ?? '-handle';
  const desc = sortRaw.startsWith('-');
  const key = desc ? sortRaw.slice(1) : sortRaw;
  const by = SORTS[key];
  if (!by) throw new HttpError(400, 'VALIDATION_ERROR', `sort must be one of ${Object.keys(SORTS).join(', ')} (prefix - for descending)`);
  const needle = (q.get('q') ?? '').trim().toLowerCase();
  if (needle.length > 100) throw new HttpError(400, 'VALIDATION_ERROR', 'q is too long');
  const kind = q.get('kind');
  if (kind !== null && kind !== 'onchain' && kind !== 'sim') throw new HttpError(400, 'VALIDATION_ERROR', 'kind must be onchain or sim');
  const cursorRaw = q.get('cursor');
  const offset = cursorRaw ? Number(cursorRaw) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'VALIDATION_ERROR', 'cursor is invalid');
  let rows = [...engine.players.values()];
  if (kind) rows = rows.filter(p => p.kind === kind);
  if (needle) rows = rows.filter(p => p.account.toLowerCase().includes(needle) || (p.strategy ?? '').includes(needle) || p.kind === needle);
  const keyed = rows.map(p => ({ p, k: by(engine, p) }));
  keyed.sort((a, b) => {
    const d = a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
    return (desc ? -d : d) || (a.p.account < b.p.account ? -1 : 1);
  });
  const page = keyed.slice(offset, offset + limit).map(x => playerRow(engine, x.p));
  return { rows: page, total: keyed.length, nextCursor: offset + limit < keyed.length ? String(offset + limit) : null };
}

export function playerDetail(engine: HouseEngine, account: string): Record<string, unknown> | undefined {
  const p = engine.player(account.startsWith('0x') ? account.toLowerCase() : account);
  if (!p) return undefined;
  const bets = [...p.recentLegs].reverse().map(id => engine.legView(id)).filter((l): l is LegView => !!l).map(l => legJson(engine, l));
  return {
    player: playerRow(engine, p), bets,
    deposits: p.deposits.map(d => ({ id: d.key, amountCenti: d.centi, amountWei: d.amountWei, dustWei: d.dustWei, ms: d.ms, txHash: d.txHash, blockNumber: d.blockNumber, status: 'credited' })),
    withdrawals: p.vouchers.map(id => engine.vouchers.get(id)!).map(v => ({ id: v.voucherId, amountCenti: v.amountCenti, ms: v.createdMs, nonce: v.nonce, expiryMs: Number(v.expiry) * 1000, status: v.status, ...(v.txHash ? { txHash: v.txHash } : {}), ...(v.submittedTxHash ? { submittedTxHash: v.submittedTxHash } : {}), ...(v.claimSource ? { claimSource: v.claimSource } : {}), ...(v.claimNote ? { claimNote: v.claimNote } : {}), ...(v.cancelReason ? { releaseReason: v.cancelReason } : {}) })),
    flags: p.flags.map(f => ({ ...f })),
  };
}

const STATUSES: readonly LegStatus[] = ['open', 'won', 'lost', 'refunded'];
export function betsPage(engine: HouseEngine, q: URLSearchParams, limit: number): Record<string, unknown> {
  const status = q.get('status');
  if (status !== null && !STATUSES.includes(status as LegStatus)) throw new HttpError(400, 'VALIDATION_ERROR', 'status must be open, won, lost or refunded');
  const market = q.get('market');
  if (market !== null && !engine.markets.includes(market as MarketId)) throw new HttpError(400, 'VALIDATION_ERROR', 'unknown market');
  const account = q.get('account')?.toLowerCase() ?? null;
  const cursorRaw = q.get('cursor');
  const before = cursorRaw ? Number(cursorRaw) : Number.POSITIVE_INFINITY;
  if (cursorRaw && (!Number.isSafeInteger(before) || before < 0)) throw new HttpError(400, 'VALIDATION_ERROR', 'cursor is invalid');
  const startRaw = q.get('start'), bandRaw = q.get('bandIndex');
  const start = startRaw ? Number(startRaw) : undefined, band = bandRaw ? Number(bandRaw) : undefined;
  if ((startRaw && !Number.isSafeInteger(start)) || (bandRaw && !Number.isSafeInteger(band))) throw new HttpError(400, 'VALIDATION_ERROR', 'start and bandIndex must be integers');
  const match = (l: LegView) => l.seq < before && (!status || l.status === status) && (!market || l.cell.marketId === market) && (!account || l.account.toLowerCase() === account)
    && (start === undefined || l.cell.startMs === start) && (band === undefined || l.bandIndex === band);
  const candidates: LegView[] = [];
  if (!status || status === 'open') for (const l of engine.openLegsList()) { const v = engine.legView(l.legId)!; if (match(v)) candidates.push(v); }
  if (status !== 'open') { const settled = engine.settledLegs(); for (let i = settled.length - 1; i >= 0; i--) { const v = settled[i]!; if (match(v)) candidates.push(v); } }
  candidates.sort((a, b) => b.seq - a.seq);
  const page = candidates.slice(0, limit);
  return { rows: page.map(l => legJson(engine, l)), nextCursor: candidates.length > limit ? String(page.at(-1)!.seq) : null };
}

/** Current grid as a liability heatmap (bands share the legs' absolute band index). */
export function exposureView(engine: HouseEngine, market: MarketId): Record<string, unknown> {
  const pub = engine.latestGrid(market);
  const amounts = engine.limitAmounts();
  if (!pub) return { market, windows: [], bands: [], cells: [], columnLimitCenti: amounts.column.toString(), reason: 'no-quote-yet' };
  const g = pub.grid;
  const windows = [...new Set(g.cells.map(c => c.cell.startMs))];
  const bucket = BigInt(g.bucket);
  const bands = [-3, -2, -1, 0, 1, 2, 3].map(b => { const index = Number(bucket + BigInt(b)); return { index, ...engine.bandBounds(market, index) }; });
  const cells = g.cells.map(c => ({
    start: c.cell.startMs, bandIndex: Number(bucket + BigInt(c.bandOffset)), x100: c.available ? c.x100 : null,
    liabilityCenti: engine.book.cellLiability(c.cell.cellId).toString(), limitCenti: amounts.cell.toString(), legs: engine.book.legCount(c.cell.cellId),
    ...(c.available ? {} : { reason: c.reason }),
  }));
  const columns = windows.map(start => ({ start, liabilityCenti: engine.book.columnLiability(market, start).toString() }));
  return { market, t: g.t, generatedAtMs: pub.generatedAtMs, tableId: g.tableId, windows, bands, cells, columns, columnLimitCenti: amounts.column.toString(), globalLimitCenti: amounts.global.toString(), globalLiabilityCenti: engine.openLiability().toString(), ...(g.reason ? { reason: g.reason } : {}) };
}

/**
 * Player-facing grid; with an account, the account's own grid variant and headroom apply (flagged surcharge grid;
 * SPEC-12: boosted odds while the account's promo allowance lasts, else the standard grid, and a boosted cell's
 * maxStakeCenti never exceeds the remaining allowance).
 */
export function quotesView(engine: HouseEngine, market: MarketId, account?: string): Record<string, unknown> {
  const player = account ? engine.player(account) : undefined;
  const flagged = !!player?.flagged && engine.flowEdgeActive() > 0;
  const pub = engine.promoMode ? engine.gridFor(player?.account, market) : engine.latestGrid(market, flagged);
  if (!pub) return { market, available: false, reason: 'warming-up', cells: [] };
  const g = pub.grid;
  const balance = player ? engine.availableBalance(player.account) : undefined;
  // Account headroom includes the SPEC-10 new-account ramp.
  const accountHeadroom = player ? engine.accountHeadroom(player.account) : undefined;
  const cells = g.cells.map((c, i) => {
    const q = pub.quotes[i];
    const base = { index: c.index, window: c.window, bandOffset: c.bandOffset, tau: c.tau, cellId: c.cell.cellId, start: c.cell.startMs, end: c.cell.endMs, bandIndex: Number(BigInt(g.bucket) + BigInt(c.bandOffset)), lower: decimalToString(c.cell.lowerPrice), upper: decimalToString(c.cell.upperPrice) };
    if (!q) return { ...base, available: false, reason: c.available ? 'too-late' : c.reason };
    if (!engine.quoteStands(q)) return { ...base, available: false, reason: 'expired' };
    let maxStake = BigInt(q.maxStakeCenti);
    if (player) {
      const cellLeft = BigInt(engine.limits.maxStakePerCellCenti) - (player.cellStakes.get(q.cellId) ?? 0n);
      const byAccount = maxStakeForLiability(accountHeadroom!, q.x100);
      const byBoost = engine.boostStakeCap(player.account, q);
      for (const cap of [cellLeft, byAccount, balance!, ...(byBoost !== undefined ? [byBoost] : [])]) if (cap < maxStake) maxStake = cap;
      if (maxStake < 0n) maxStake = 0n;
    }
    return { ...base, available: true, quoteId: q.quoteId, revision: q.revision, x100: q.x100, capped: q.capped, maxStakeCenti: maxStake.toString(), validUntilMs: q.validUntilMs };
  });
  const d = engine.defenses;
  return {
    market, t: g.t, generatedAtMs: pub.generatedAtMs, clockMs: engine.nowMs, tableId: g.tableId, spot: pub.quotes.find(Boolean)?.spotText ?? decimalToString(g.spot), bucket: g.bucket, edge: g.edge.edge, phase: g.edge.phase, flagged, ...(g.reason ? { reason: g.reason } : {}), minStakeCenti: '10',
    ...(engine.promoMode ? promoQuoteFields(engine, pub, player?.account) : {}),
    acceptance: { hold: d.hold.enabled, maxHoldMs: d.hold.enabled ? d.hold.maxHoldMs : 0, minLeadS: d.minLeadS }, cells,
  };
}

/** SPEC-12 fields of a quote view: the tier, whether these odds are boosted, and the account's remaining allowance. */
function promoQuoteFields(engine: HouseEngine, pub: NonNullable<ReturnType<HouseEngine['gridFor']>>, account: string | undefined): Record<string, unknown> {
  const tier = pub.grid.edge.tier ?? engine.currentTier().tier;
  const boosted = pub.grid.edge.boosted ?? false;
  const left = account && boosted ? engine.boostRemaining(account, tier) : null;
  return { tier, pricing: boosted ? 'boosted' : 'standard', variant: pub.variant ?? 'main', minWinX100: boosted && engine.promo ? tierConfig(engine.promo, tier)?.minWinX100 ?? null : null, boostRemainingCenti: left === null ? null : left.toString() };
}

export function metricsView(engine: HouseEngine, q: URLSearchParams): Record<string, unknown> {
  const series = engine.metrics.series.toArray();
  const now = engine.nowMs;
  const num = (key: string, fallback: number) => { const raw = q.get(key); if (raw === null || raw === '') return fallback; const n = Number(raw); if (!Number.isFinite(n)) throw new HttpError(400, 'VALIDATION_ERROR', `${key} must be a number`); return n; };
  const to = num('to', now), from = num('from', to - 86_400_000), step = num('step', 60_000);
  if (!(to > from)) throw new HttpError(400, 'VALIDATION_ERROR', 'to must be after from');
  if (step < 1000) throw new HttpError(400, 'VALIDATION_ERROR', 'step must be at least 1000 ms');
  if ((to - from) / step > 5000) throw new HttpError(400, 'VALIDATION_ERROR', 'at most 5000 points per request');
  const out = { t: [] as number[], equity: [] as string[], ggr: [] as string[], handle: [] as string[], rtp: [] as (number | null)[], openLiability: [] as string[], players: [] as number[], betsPerMin: [] as number[] };
  let j = 0;
  for (let t = from + step; t <= to + 1e-9; t += step) {
    while (j < series.length && series[j]!.t <= t) j++;
    const point = series[j - 1];
    if (!point || point.t <= t - step) continue;
    out.t.push(t); out.equity.push(point.equity.toString()); out.ggr.push(point.ggr.toString()); out.handle.push(point.handle.toString());
    out.rtp.push(point.rtp); out.openLiability.push(point.openLiability.toString()); out.players.push(point.players); out.betsPerMin.push(point.betsPerMin);
  }
  return out;
}
