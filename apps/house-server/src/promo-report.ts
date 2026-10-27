import { TIER_IDS, tierConfig, type PromoAggView, type PromoConfig, type TierId } from '@maya/house';
import type { HouseApp } from './app.js';
import { PROMO_GUARD_ACTOR } from './engine/engine.js';
import { isoSeconds } from './util.js';

/**
 * SPEC-12 simulation report: one row per tier with its time span, players and turnover at start and end, realized
 * house loss against the budget (boosted flow total and clean, and every leg of the tier) with 95 % intervals, RTP by
 * multiplier range, promo cost, cap hits, the farmer outcome, the minimum-win check and the budget-guard decisions.
 */
export interface PromoReportInput {
  readonly fromMs: number;
  readonly toMs: number;
  readonly promo: PromoConfig;
  readonly label: string;
  readonly scale?: { readonly players: number; readonly turnover: number };
  readonly strategies: Record<string, Record<string, unknown>>;
  readonly minWinCheck: { readonly boostedLegs: number; readonly belowMinWin: number; readonly lowestByTier: Readonly<Record<string, number>> };
}

interface Segment { tier: TierId; fromMs: number; toMs: number; playersStart: number; playersEnd: number; turnoverStartCenti: string; turnoverEndCenti: string; startCause: string; endCause: string }

export function buildPromoReport(app: HouseApp, input: PromoReportInput): Record<string, unknown> {
  const e = app.engine;
  const { promo, fromMs, toMs } = input;
  const standardEdge = e.edgeSchedule.standard;
  const minStake = 10n;
  const log = e.tierLog;
  const segments: Segment[] = log.map((entry, i) => {
    const next = log[i + 1];
    return {
      tier: entry.tier, fromMs: Math.max(entry.atMs, fromMs), toMs: next ? next.atMs : toMs, playersStart: entry.players, playersEnd: next ? next.players : e.registeredPlayers,
      turnoverStartCenti: entry.turnoverCenti, turnoverEndCenti: next ? next.turnoverCenti : e.turnover.toString(), startCause: entry.cause, endCause: next ? next.cause : 'run end',
    };
  });
  const byRangeTier = e.metrics.rtpByTier().byRangeTier;
  const byTier = e.metrics.rtpByTier().byTier;
  const audit = e.auditAll();
  const farmerAccounts = [...e.players.values()].filter(p => p.strategy === 'farmer').map(p => p.account);
  const tiers = TIER_IDS.map(id => {
    const t = tierConfig(promo, id);
    const segs = segments.filter(s => s.tier === id);
    const first = segs[0], last = segs.at(-1);
    const book = e.promoLedger.book(id);
    const cap = t ? BigInt(t.perAccountBoostCapCenti) : undefined;
    const counts = e.promoLedger.accountCounts(id, cap, minStake);
    let maxUsed = 0n, overCap = 0;
    for (const used of book.accounts.values()) { if (used > maxUsed) maxUsed = used; if (cap !== undefined && used > cap) overCap++; }
    let farmerBoosted = 0n, farmerCapped = 0, farmerActive = 0;
    for (const a of farmerAccounts) {
      const used = book.accounts.get(a) ?? 0n;
      if (used > 0n) farmerActive++;
      farmerBoosted += used;
      if (cap !== undefined && cap - used < minStake) farmerCapped++;
    }
    const boosted = book.boosted.snapshot(t?.lossBudget), clean = book.boostedClean.snapshot(t?.lossBudget), all = book.all.snapshot(t?.lossBudget);
    const verdict = (v: PromoAggView) => (t && v.lossRate !== null ? { withinBudget: v.lossRate <= t.lossBudget, ciLowBelowBudget: (v.lossRateLow ?? Infinity) <= t.lossBudget, ciHighBelowBudget: (v.lossRateHigh ?? Infinity) <= t.lossBudget } : null);
    const grid = e.promoGridStats.get(id) ?? null;
    return {
      id, label: t?.label ?? promo.standardLabel, reached: segs.length > 0, lossBudget: t?.lossBudget ?? null, minWinX100: t?.minWinX100 ?? null, perAccountBoostCapCenti: t?.perAccountBoostCapCenti ?? null,
      untilPlayers: t?.untilPlayers ?? null, untilTurnoverCenti: t?.untilTurnoverCenti ?? null,
      from: first ? isoSeconds(first.fromMs) : null, to: last ? isoSeconds(last.toMs) : null, hours: segs.reduce((s, x) => s + (x.toMs - x.fromMs) / 3_600_000, 0),
      playersStart: first?.playersStart ?? null, playersEnd: last?.playersEnd ?? null, turnoverStartCenti: first?.turnoverStartCenti ?? null, turnoverEndCenti: last?.turnoverEndCenti ?? null,
      startCause: first?.startCause ?? null, endCause: last?.endCause ?? null, segments: segs.length,
      turnoverCenti: book.turnover.toString(), bets: book.bets, boostedTurnoverCenti: book.boostedTurnover.toString(), boostedBets: book.boostedBets,
      boosted, boostedClean: clean, standardPriced: book.standardPriced.snapshot(), all,
      verdict: { boosted: verdict(boosted), boostedClean: verdict(clean), all: verdict(all) },
      // Expected house P&L at the standard edge − realized, on the settled boosted legs.
      promoCostCenti: (BigInt(Math.round(Number(book.boosted.handle) * standardEdge)) - book.boosted.housePnl).toString(),
      rtpByRange: byRangeTier.filter(r => r.tier === id), rtpByPricing: byTier.filter(r => r.tier === id),
      accounts: { boosted: counts.boosted, capped: counts.capped, overCap, maxBoostedCenti: maxUsed.toString() },
      farmers: { activeAccounts: farmerActive, cappedAccounts: farmerCapped, boostedTurnoverCenti: farmerBoosted.toString() },
      grid: grid ? { ...grid, hiddenShare: grid.priced > 0 ? grid.hiddenMinWin / grid.priced : null } : null,
      lowestBoostedX100: input.minWinCheck.lowestByTier[id] ?? null,
      guard: { final: { ...e.promoLedger.guard(id) }, events: audit.filter(a => a.action.startsWith('promo-guard-') && a.target === id).map(a => ({ time: isoSeconds(a.ms), actor: a.actor, action: a.action, before: a.before, after: a.after, reason: a.reason })) },
    };
  });
  const f = input.strategies['farmer'];
  const farmerCaps = tiers.filter(t => t.id !== 'standard');
  const farmerBoosted = farmerCaps.reduce((s, t) => s + BigInt(t.farmers.boostedTurnoverCenti), 0n);
  const farmerExpectedGain = farmerCaps.reduce((s, t) => s + Number(t.farmers.boostedTurnoverCenti) * (t.lossBudget ?? 0), 0);
  const farmerCapBound = farmerCaps.reduce((s, t) => s + t.farmers.activeAccounts * Number(t.perAccountBoostCapCenti ?? 0) * (t.lossBudget ?? 0), 0);
  const farmers = f ? {
    players: f['players'], accounts: f['accounts'], attempts: f['attempts'], accepted: f['accepted'], rejectionRate: f['rejectionRate'], skipped: f['skipped'],
    handleCenti: f['handleCenti'], boostedTurnoverCenti: farmerBoosted.toString(), settledStakeCenti: f['settledStakeCenti'], returnedCenti: f['returnedCenti'],
    playerPnlCenti: f['playerPnlCenti'], housePnlCenti: f['housePnlCenti'], rtp: f['rtp'], expectedRtp: f['expectedRtp'] ?? null, rtpSe: f['rtpSe'] ?? null,
    profitPerAccountCenti: Number(f['accounts']) > 0 ? String(Math.round(Number(f['playerPnlCenti']) / Number(f['accounts']))) : '0',
    // What the farmers could expect from the boost on the turnover they placed (Σ boosted × lossBudget), and the most the caps
    // allow (Σ over tiers: active farming accounts × cap × lossBudget).
    expectedBoostGainCenti: String(Math.round(farmerExpectedGain)), capBoundCenti: String(Math.round(farmerCapBound)),
    anyAccountOverCap: farmerCaps.some(t => t.accounts.overCap > 0),
    cappedAccountsByTier: Object.fromEntries(farmerCaps.map(t => [t.id, t.farmers.cappedAccounts])),
  } : null;
  const holdByDetail = (e.holdStats.snapshot()['byDetail'] ?? {}) as Record<string, number>;
  return {
    label: input.label, scaled: !!input.scale, ...(input.scale ? { scale: input.scale, warning: 'THRESHOLDS SCALED FOR A COMPRESSED SIMULATION: these are not the production thresholds' } : {}),
    config: promo, standardEdge, tierLog: log.map(x => ({ ...x, time: isoSeconds(Math.max(x.atMs, fromMs)) })), tiers, farmers,
    minWin: { boostedLegs: input.minWinCheck.boostedLegs, belowMinWin: input.minWinCheck.belowMinWin, respected: input.minWinCheck.belowMinWin === 0 },
    capRejections: { holdResolvedBoostCap: holdByDetail['boost-cap'] ?? 0 },
    guardActor: PROMO_GUARD_ACTOR,
    totals: {
      turnoverCenti: e.turnover.toString(),
      boostedTurnoverCenti: tiers.reduce((s, t) => s + BigInt(t.boostedTurnoverCenti), 0n).toString(),
      promoCostCenti: tiers.reduce((s, t) => s + BigInt(t.promoCostCenti), 0n).toString(),
    },
  };
}

const pct = (v: unknown, digits = 2): string => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');
function openStr(centi: unknown): string {
  if (centi === null || centi === undefined) return '—';
  const c = BigInt(String(centi)); const neg = c < 0n; const a = neg ? -c : c;
  return `${neg ? '−' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')}`;
}
function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}
const ci = (v: Record<string, unknown> | undefined): string => (v && typeof v['lossRate'] === 'number' ? `${pct(v['lossRate'])} [${pct(v['lossRateLow'])}, ${pct(v['lossRateHigh'])}]` : '—');

/** Markdown section for a simulation report (appended by report.ts when the run used promo tiers). */
export function renderPromoSection(lines: string[], p: Record<string, unknown>): void {
  const tiers = (p['tiers'] ?? []) as Record<string, unknown>[];
  lines.push('## Promo tiers (SPEC-12)', '');
  if (p['scaled']) lines.push(`> **${String(p['warning'])}** (players × ${String((p['scale'] as Record<string, number>)['players'])}, turnover × ${String((p['scale'] as Record<string, number>)['turnover'])}; budgets, minimum wins and caps unchanged).`, '');
  lines.push(`Mode: ${String(p['label'])}. Turnover = cumulative accepted stake since launch (never reset); a tier ends at its player or turnover threshold, whichever comes first. Loss rates are realized house loss / settled stake with a 95 % interval (±1.96 SE); negative means the house won. *Boosted* = legs priced at the tier's boosted odds (the budget applies to these); *clean* = the boosted legs of accounts the adaptive edge learns from (never flagged, low latency evidence); *all* = every leg quoted while the tier was current (incl. standard-priced legs of capped or flagged accounts).`, '');
  lines.push(table(['Tier', 'From', 'To', 'Hours', 'Players start → end', 'Turnover start → end (OPEN)', 'Ended by'], tiers.filter(t => t['reached']).map(t => [
    String(t['id']), String(t['from']), String(t['to']), (t['hours'] as number).toFixed(2), `${String(t['playersStart'])} → ${String(t['playersEnd'])}`, `${openStr(t['turnoverStartCenti'])} → ${openStr(t['turnoverEndCenti'])}`, String(t['endCause']),
  ])), '');
  const notReached = tiers.filter(t => !t['reached']).map(t => String(t['id']));
  if (notReached.length) lines.push(`Not reached in this run: ${notReached.join(', ')}.`, '');
  lines.push(table(['Tier', 'Budget', 'Tier turnover', 'Boosted turnover', 'Boosted loss [95% CI]', 'Clean loss [95% CI]', 'All-legs loss [95% CI]', 'Within budget (boosted / all)', 'Promo cost (OPEN)'], tiers.filter(t => t['reached']).map(t => {
    const v = t['verdict'] as Record<string, Record<string, boolean> | null>;
    const yes = (x: Record<string, boolean> | null | undefined) => (!x ? '—' : x.withinBudget ? (x.ciHighBelowBudget ? 'yes' : 'yes (CI overlaps)') : x.ciLowBelowBudget ? 'no (CI overlaps)' : 'NO');
    return [String(t['id']), t['lossBudget'] === null ? 'house edge' : pct(t['lossBudget'], 0), openStr(t['turnoverCenti']), openStr(t['boostedTurnoverCenti']), ci(t['boosted'] as Record<string, unknown>), ci(t['boostedClean'] as Record<string, unknown>), ci(t['all'] as Record<string, unknown>), `${yes(v['boosted'])} / ${yes(v['all'])}`, openStr(t['promoCostCenti'])];
  })), '');
  lines.push(table(['Tier', 'Min win', 'Lowest boosted x', 'Grid cells hidden below min win', 'Cap (OPEN)', 'Boosted accounts', 'Capped accounts', 'Over cap', 'Max boosted per account (OPEN)', 'Guard final', 'Guard events'], tiers.filter(t => t['reached'] && t['id'] !== 'standard').map(t => {
    const g = t['grid'] as Record<string, number | null> | null;
    const a = t['accounts'] as Record<string, number | string>;
    const guard = t['guard'] as { final: Record<string, unknown>; events: unknown[] };
    return [String(t['id']), `${((t['minWinX100'] as number) / 100).toFixed(2)}×`, t['lowestBoostedX100'] ? `${((t['lowestBoostedX100'] as number) / 100).toFixed(2)}×` : '—',
      g ? `${g['hiddenMinWin']} of ${g['priced']} (${pct(g['hiddenShare'], 3)})` : '—', openStr(t['perAccountBoostCapCenti']), String(a['boosted']), String(a['capped']), String(a['overCap']), openStr(a['maxBoostedCenti']),
      `adjust ${pct(guard.final['adjust'])}${guard.final['tripped'] ? ', TRIPPED' : ''}`, String(guard.events.length)];
  })), '');
  const mw = p['minWin'] as Record<string, unknown>;
  lines.push(`Minimum-win floors: ${String(mw['boostedLegs'])} settled boosted legs, ${String(mw['belowMinWin'])} below their tier's minimum → **${mw['respected'] ? 'respected' : 'VIOLATED'}**.`, '');
  const fm = p['farmers'] as Record<string, unknown> | null;
  if (fm) {
    lines.push('### Farmers', '');
    lines.push(`${String(fm['players'])} farmers used ${String(fm['accounts'])} accounts: ${String(fm['accepted'])} bets accepted of ${String(fm['attempts'])} placed (${pct(fm['rejectionRate'], 1)} rejected), handle ${openStr(fm['handleCenti'])} OPEN of which ${openStr(fm['boostedTurnoverCenti'])} at boosted odds. Farmer RTP ${pct(fm['rtp'])} (model ${pct(fm['expectedRtp'])} ± ${pct(fm['rtpSe'])} SE); farmer profit ${openStr(fm['playerPnlCenti'])} OPEN (${openStr(fm['profitPerAccountCenti'])} per account) against an expected boost gain of ${openStr(fm['expectedBoostGainCenti'])} and a cap bound of ${openStr(fm['capBoundCenti'])} OPEN (active farming accounts × cap × loss budget). Accounts over their cap: ${fm['anyAccountOverCap'] ? 'SOME (violation)' : 'none'}; capped farmer accounts by tier: ${Object.entries(fm['cappedAccountsByTier'] as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  }
  for (const t of tiers.filter(x => x['reached'])) {
    const rows = (t['rtpByRange'] as Record<string, unknown>[]).filter(r => Number(r['bets']) > 0);
    if (!rows.length) continue;
    lines.push(`RTP by multiplier range, ${String(t['id'])}:`, '');
    lines.push(table(['Pricing', 'Range', 'Bets', 'Handle (OPEN)', 'Realized', 'Model', 'Policy target', 'Model band (±2 SE)'], rows.map(r => [String(r['pricing']), String(r['key']), String(r['bets']), openStr(r['handleCenti']), pct(r['realized']), pct(r['expected']), pct(r['policyTarget']), `${pct(r['expectedLow'])} – ${pct(r['expectedHigh'])}`])), '');
  }
  const events = tiers.flatMap(t => ((t['guard'] as { events: Record<string, unknown>[] }).events));
  if (events.length) {
    lines.push('Budget-guard decisions:', '');
    lines.push(table(['Time', 'Tier action', 'Before', 'After', 'Reason'], events.slice(0, 40).map(ev => [String(ev['time']), String(ev['action']), JSON.stringify(ev['before']), JSON.stringify(ev['after']), String(ev['reason'] ?? '')])), '');
  } else lines.push('Budget guard: no decisions (the realized loss never left the statistical band around the budget).', '');
}
