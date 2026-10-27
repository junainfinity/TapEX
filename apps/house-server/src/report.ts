import { formatOpen } from '@maya/house';
import type { RtpRow } from './metrics/metrics.js';
import { renderPromoSection } from './promo-report.js';

/** Reference $OPEN price for USD estimates (labelled estimate everywhere it appears). */
export const REFERENCE_USD_PER_OPEN = 0.138;
const USD_NUM = 138n, USD_DEN = 1000n;

/** Exact Centi → USD cents at the reference price, rounded half away from zero, formatted "$1,234.56". */
export function usdEstimate(centi: bigint): string {
  const num = centi * USD_NUM; // US cents × 1000 / 1000
  const neg = num < 0n; const abs = neg ? -num : num;
  const cents = (abs + USD_DEN / 2n) / USD_DEN;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg && cents > 0n ? '-' : ''}$${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const pct = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(digits)}%`);
export const open = (centi: string | bigint): string => formatOpen(typeof centi === 'bigint' ? centi.toString() : centi);

export interface SimReport {
  readonly name: string;
  readonly generatedAt: string;
  readonly run: Record<string, unknown>;
  readonly config: Record<string, unknown>;
  readonly headline: Record<string, unknown>;
  readonly phases: readonly Record<string, unknown>[];
  readonly pnl: Record<string, unknown>;
  readonly rtp: { readonly byRange: readonly RtpRow[]; readonly byMarket: readonly RtpRow[]; readonly byPhase: readonly RtpRow[]; readonly byKind: readonly RtpRow[]; readonly calibration: readonly unknown[] };
  readonly drawdown: Record<string, unknown>;
  readonly limits: Record<string, unknown>;
  readonly breakerEvents: readonly Record<string, unknown>[];
  readonly adminActions: readonly Record<string, unknown>[];
  readonly toxicity: Record<string, unknown>;
  readonly strategies: Record<string, Record<string, unknown>>;
  readonly onchain: Record<string, unknown>;
  readonly reconciliation: Record<string, unknown>;
  readonly invariants: Record<string, unknown>;
  readonly refits: readonly unknown[];
  readonly rejections: Record<string, number>;
  readonly series: readonly Record<string, unknown>[];
  /** SPEC-10: defense profile and config, honest/adversarial aggregates, hold, toxicity and controller outcomes. */
  readonly defenses: Record<string, unknown>;
  /** SPEC-12: per-tier outcomes (absent for runs with the legacy launch boost). */
  readonly promo?: Record<string, unknown>;
}

function table(headers: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

export function renderMarkdown(r: SimReport): string {
  const h = r.headline as Record<string, string | number | boolean>;
  const pnl = r.pnl as Record<string, string>;
  const recon = r.reconciliation as Record<string, unknown>;
  const inv = r.invariants as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`# Maya-Live house simulation: ${r.name}`, '');
  lines.push(`Generated ${r.generatedAt}. Replay ${String(r.run['from'])} → ${String(r.run['to'])} (${String(r.run['hours'])} h of recorded prices, ${String(r.run['markets'])}), network \`${String(r.run['network'])}\`, wall time ${String(r.run['wallSeconds'])} s.`, '');
  lines.push('Everything below is produced by the real house engine (quotes, placement, limits, breakers, exact settlement). Synthetic players bet with off-chain `sim-credit`, kept apart from on-chain funds. USD figures use a reference price of 0.138 USD per OPEN and are **estimates**.', '');
  lines.push('## Headline', '');
  lines.push(table(['Metric', 'Value'], [
    ['Players registered', String(h['registeredPlayers'])], ['Bets accepted', String(h['betsAccepted'])], ['Handle (settled)', String(h['handle'])],
    ['House P&L', `${String(h['housePnl'])} (${String(h['housePnlUsd'])} USD, estimate)`], ['Realized RTP', String(h['realizedRtp'])], ['Expected RTP (model)', String(h['expectedRtp'])],
    ['Launch boost ended', String(h['launchEnded'])], ['Max 1 h drawdown', String(h['maxDrawdown1h'])], ['Max peak-to-trough', String(h['maxPeakToTrough'])],
    ['Breaker events', String(h['breakerEvents'])], ['Reconciliation (vault vs ledger)', String(h['reconciliation'])], ['Invariants', String(h['invariants'])],
  ]), '');
  if (r.promo) renderPromoSection(lines, r.promo);
  lines.push('## Launch vs standard phase', '');
  if (r.promo) lines.push('With promo tiers, *launch* here means "a promo tier was current" (launch, growth or scale) and *standard* that every tier had ended; see the promo section above for each tier.', '');
  lines.push(table(['Phase', 'From', 'To', 'Players at start', 'Bets', 'Handle', 'House GGR', 'GGR USD (est.)', 'Realized RTP', 'Expected RTP'], r.phases.map(p => [
    String(p['phase']), String(p['from']), String(p['to']), String(p['playersAtStart']), String(p['bets']), open(String(p['handleCenti'])), open(String(p['ggrCenti'])), String(p['ggrUsd']), pct(p['realized'] as number | null), pct(p['expected'] as number),
  ])), '');
  lines.push('## House P&L', '');
  lines.push(table(['Component', 'OPEN', 'USD (estimate)'], [
    ['Against sim players (sim-credit)', open(pnl['simPnlCenti']!), usdEstimate(BigInt(pnl['simPnlCenti']!))],
    ['Against on-chain players (tOPEN)', open(pnl['onchainPnlCenti']!), usdEstimate(BigInt(pnl['onchainPnlCenti']!))],
    ['Total', open(pnl['totalPnlCenti']!), usdEstimate(BigInt(pnl['totalPnlCenti']!))],
    ['of which against adversarial players (sniper1s, sniper2s, splitter)', open(pnl['sniperHousePnlCenti'] ?? '0'), usdEstimate(BigInt(pnl['sniperHousePnlCenti'] ?? '0'))],
    ['Total excluding adversarial players', open(pnl['excludingSniperPnlCenti'] ?? '0'), usdEstimate(BigInt(pnl['excludingSniperPnlCenti'] ?? '0'))],
  ]), '');
  lines.push(`House equity (risk base E): ${open(pnl['equityStartCenti']!)} → ${open(pnl['equityEndCenti']!)}. On-chain bankroll: ${open(pnl['bankrollStartCenti']!)} → ${open(pnl['bankrollEndCenti']!)}.`, '');
  lines.push('## RTP by multiplier range', '');
  lines.push(table(['Range', 'Phase', 'Bets', 'Handle', 'Realized', 'Expected', 'Expected band (±2 SE)'], r.rtp.byRange.filter(x => x.bets > 0).map(x => [x.key, x.phase ?? '', x.bets, open(x.handleCenti), pct(x.realized), pct(x.expected), `${pct(x.expectedLow)} – ${pct(x.expectedHigh)}`])), '');
  lines.push(table(['Market', 'Bets', 'Handle', 'Realized', 'Expected'], r.rtp.byMarket.map(x => [x.key, x.bets, open(x.handleCenti), pct(x.realized), pct(x.expected)])), '');
  lines.push('## Player outcomes by strategy', '');
  lines.push('RTP is realized return / settled stake. *Model* is the calibrated fair value of each leg (Σ p × multiplier); *policy* is what the pricing policy promises (1 − phase edge − drawdown widening, before the flow surcharge and the adaptive edge). Rejections count every placement that did not become a bet, immediate or at the end of an acceptance hold.', '');
  lines.push(table(['Strategy', 'Players (accounts)', 'Bets', 'Handle', 'House P&L', 'RTP', 'Model', 'Policy', 'Rejected', 'Held → rejected', 'Hold p95', 'Flagged / blocked', 'Top rejections'], Object.entries(r.strategies).map(([k, s]) => [
    k, `${String(s['players'])} (${String(s['accounts'] ?? s['players'])})`, String(s['bets']), open(String(s['handleCenti'])), open(String(s['housePnlCenti'])), pct(s['rtp'] as number | null), pct(s['expectedRtp'] as number | null), pct(s['policyTarget'] as number | null),
    pct(s['rejectionRate'] as number | null, 1), `${String(s['held'] ?? 0)} → ${String(s['heldRejected'] ?? 0)}`, (s['holdLatencyMs'] as { p95?: number | null } | undefined)?.p95 != null ? `${String((s['holdLatencyMs'] as { p95: number }).p95)} ms` : '—',
    `${String(s['flagged'] ?? 0)} / ${String(s['blocked'] ?? 0)}`,
    Object.entries((s['rejections'] ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([rr, n]) => `${rr} ${n}`).join(', ') || '—',
  ])), '');
  const d = (r.defenses ?? {}) as Record<string, unknown>;
  const honest = (d['honest'] ?? {}) as Record<string, unknown>, adv = (d['adversarial'] ?? {}) as Record<string, unknown>;
  if (honest['attempts'] !== undefined) {
    lines.push(`Honest crowd (${(honest['strategies'] as string[]).join(', ')}): RTP ${pct(honest['rtp'] as number | null)} vs model ${pct(honest['expectedRtp'] as number | null)} and policy ${pct(honest['policyTarget'] as number | null)} (±${pct(honest['rtpSe'] as number | null)} SE); ${pct(honest['rejectionRate'] as number | null, 2)} of ${String(honest['attempts'])} placements rejected.`, '');
    lines.push(`Adversarial players (${(adv['strategies'] as string[]).join(', ')}, who see the next first-seen price(s) before the house): RTP ${pct(adv['rtp'] as number | null)}, house P&L ${open(String(adv['housePnlCenti'] ?? '0'))}, ${pct(adv['rejectionRate'] as number | null, 1)} of ${String(adv['attempts'])} placements rejected.`, '');
  }
  const tox = r.toxicity as { flagged: number; blockedByOperator: number; blockedByStrategy: Record<string, number>; operatorBlockMin: number };
  const toxCfg = (r.config['toxicity'] ?? {}) as Record<string, unknown>;
  if (toxCfg['mode'] === 'graduated') lines.push(`Graduated toxicity (flag with a ${String(toxCfg['surchargeEdge'])} flow surcharge at excess-return z > ${String(toxCfg['surchargeZ'])} after ≥ ${String(toxCfg['minBets'])} settled bets and ≥ ${String(toxCfg['minWins'])} wins; block at z > ${String(toxCfg['blockZ'])} after ≥ ${String(toxCfg['blockMinBets'])}; lift at z < ${String(toxCfg['unflagZ'])}) flagged ${tox.flagged} accounts; latency evidence flags at z > ${String(toxCfg['holdZ'])} after ≥ ${String(toxCfg['holdMinN'])} held placements and blocks at z > ${String(toxCfg['holdBlockZ'])} after ≥ ${String(toxCfg['holdBlockMinN'])}. Operator blocking ${tox.operatorBlockMin > 0 ? `after ${tox.operatorBlockMin} feed-minutes` : 'disabled (the engine blocks on its own evidence)'}.`, '');
  else lines.push(`Toxicity monitor (excess-return z > 4 after 50 settled bets) flagged ${tox.flagged} accounts; the simulated operator blocked ${tox.blockedByOperator} of them ${tox.operatorBlockMin > 0 ? `${tox.operatorBlockMin} feed-minutes after each flag` : '(operator blocking disabled)'}${Object.keys(tox.blockedByStrategy).length ? ` (${Object.entries(tox.blockedByStrategy).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}. The flow surcharge stays at its default of 0.`, '');
  renderDefenses(lines, d);
  lines.push('## Risk: drawdown, limits, breakers', '');
  const dd = r.drawdown as Record<string, string>;
  lines.push(`Max 1 h drawdown ${String(dd['max1h'])}; max peak-to-trough ${open(dd['maxPeakToTroughCenti']!)} (${String(dd['maxPeakToTroughPct'])}).`, '');
  const lim = r.limits as { peak: Record<string, number>; rejections: Record<string, number> };
  lines.push(table(['Limit', 'Peak usage'], Object.entries(lim.peak).map(([k, v]) => [k, pct(v)])), '');
  lines.push(`Liability-limit rejections: ${Object.entries(lim.rejections).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`, '');
  lines.push(`Breaker transitions: ${r.breakerEvents.length}.`, '');
  if (r.breakerEvents.length) lines.push(table(['Time', 'Breaker', 'Target', 'From → to', 'Reason'], r.breakerEvents.slice(0, 40).map(b => [String(b['time']), String(b['action']), String(b['target'] ?? ''), `${String(b['before'])} → ${String(b['after'])}`, String(b['reason'] ?? '')])), '');
  if (r.breakerEvents.length > 40) lines.push(`(${r.breakerEvents.length - 40} more in report.json)`, '');
  if (r.adminActions.length) lines.push('Admin actions during the run:', '', table(['Time', 'Actor', 'Action', 'Reason'], r.adminActions.map(a => [String(a['time']), String(a['actor']), String(a['action']), String(a['reason'] ?? '')])), '');
  lines.push('## On-chain players and receipts', '');
  const oc = r.onchain as { players: number; bets: number; receipts: Record<string, unknown>[]; errors: string[]; note: string; handleCenti: string; pnlCenti: string };
  lines.push(`${oc.players} on-chain players placed ${oc.bets} bets (handle ${open(oc.handleCenti)}, player P&L ${open(oc.pnlCenti)}). ${oc.note}`, '');
  if (oc.receipts.length) lines.push(table(['Kind', 'Role', 'Amount', 'Tx hash', 'Block', 'Explorer'], oc.receipts.slice(0, 60).map(x => [String(x['kind']), String(x['role'] ?? ''), x['amountCenti'] ? open(String(x['amountCenti'])) : '', String(x['txHash']), String(x['blockNumber'] ?? ''), String(x['explorerUrl'] ?? '—')])), '');
  if (oc.errors.length) lines.push(`Errors: ${oc.errors.join('; ')}`, '');
  lines.push('## Final reconciliation', '');
  lines.push(`Vault assets ${String(recon['vaultAssetsWei'])} wei; ledger ${String(recon['ledgerAssetsWei'])} wei; delta ${String(recon['deltaWei'])} wei → **${recon['match'] ? 'exact match' : 'MISMATCH'}**. Dust retained: ${String(recon['dustWei'])} wei${(recon['dust'] as unknown[] | undefined)?.length ? ` (${(recon['dust'] as unknown[]).length} deposits)` : ''}.`, '');
  const sim = recon['simCredit'] as Record<string, string> | undefined;
  if (sim) lines.push(`Sim credit (off-chain, separate): issued ${open(sim['issuedCenti']!)} = sim balances ${open(sim['balancesCenti']!)} + sim escrow ${open(sim['escrowCenti']!)} + house result vs sim ${open(sim['housePnlCenti']!)} → ${sim['identity'] === 'true' ? 'holds' : 'BROKEN'}.`, '');
  lines.push(`Invariants: ledger sums to zero ${String(inv['ledgerSumZero'])}; negative accounts ${JSON.stringify(inv['negativeAccounts'])}; escrow = open stakes ${String(inv['escrowMatchesOpenStakes'])}; solvency violations ${String(inv['solvencyViolations'])}; minimum equity ${open(String(inv['minEquityCenti']))}.`, '');
  lines.push('## Refits', '');
  lines.push(r.refits.length ? table(['Job', 'State', 'Results'], (r.refits as { jobId: string; state: string; results: { market: string; ok: boolean; tableId?: string; detail?: string }[] }[]).map(j => [j.jobId, j.state, j.results.map(x => `${x.market}: ${x.ok ? x.tableId : x.detail}`).join('; ')])) : 'No refits ran.', '');
  return lines.join('\n') + '\n';
}

/** Human description of the hold tolerance (scale, width, flagged width, trust ramp). */
function holdTolerance(h: import('@maya/house').HoldConfig): string {
  const width = (w: number) => (h.tolScale === 'logit' ? `±${w} log-odds` : `±max(${h.tolAbs}, ${w} × p)`);
  const ramp = h.newAccountHolds > 0 ? `, ${width(h.newAccountTolRel)} for an account's first ${h.newAccountHolds} holds or while its latency z > ${h.newAccountMaxZ}` : '';
  return `${width(h.tolRel)}${ramp}, ${width(h.flaggedTolRel)} once flagged on latency evidence`;
}

function renderDefenses(lines: string[], d: Record<string, unknown>): void {
  if (!d['config']) return;
  const c = d['config'] as import('@maya/house').DefenseConfig;
  lines.push('## Defenses (SPEC-10)', '');
  lines.push(`Profile \`${String(d['profile'])}\`: acceptance hold ${c.hold.enabled ? `on (≤ ${c.hold.maxHoldMs} ms, symmetric tolerance ${holdTolerance(c.hold)}, timeout → ${c.hold.onTimeout})` : 'off'}; quote validity ${c.quoteValidity.enabled ? `next sample + ${c.quoteValidity.graceMs} ms (≤ ${c.quoteValidity.maxTtlMs} ms)` : 'off (fixed 1.8 s TTL)'}; minimum lead ${c.minLeadS} s; account ramp ${c.ramp.enabled ? `on (${c.ramp.startCenti} Centi + ${c.ramp.perSettledBetCenti} per settled bet + ${c.ramp.handleFraction} × settled handle)` : 'off'}; graduated toxicity ${c.toxicity.enabled ? 'on' : 'off'}; adaptive edge ${c.controller.enabled ? `on (window ${c.controller.windowMs / 3_600_000} h, every ${c.controller.evalEveryMs / 60_000} min, ≤ ${c.controller.maxStepPerHour} per hour, bounds ${c.controller.minAdjust}…${c.controller.maxAdjust})` : 'off'}.`, '');
  const hold = (d['hold'] ?? {}) as Record<string, unknown>;
  if (Number(hold['created'] ?? 0) > 0) {
    const lat = (hold['latencyMs'] ?? {}) as Record<string, number | null>;
    const byDetail = Object.entries((hold['byDetail'] ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`Acceptance hold: ${String(hold['created'])} placements held, ${String(hold['accepted'])} accepted, ${String(hold['rejected'])} rejected (${pct(hold['rejectRateAll'] as number | null, 2)}); latency p50 ${String(lat['p50'])} ms, p95 ${String(lat['p95'])} ms, max ${String(lat['max'])} ms (feed clock, 250 ms engine steps). Outcomes: ${byDetail}.`, '');
  }
  const moves = (d['holdMoves'] ?? {}) as Record<string, Record<string, unknown>>;
  const moveRows = Object.entries(moves).filter(([, m]) => Number(m['n'] ?? 0) > 0);
  if (moveRows.length) {
    lines.push('Relative fair-value move over the hold, |p_fresh / p_quote − 1| (share beyond candidate tolerances):', '');
    lines.push(table(['Strategy', 'Holds', 'Mean signed', 'p50', 'p90', 'p95', 'p99', '> 3%', '> 5%', '> 8%', '> 10%', '> 15%'], moveRows.map(([k, m]) => {
      const b = (m['beyond'] ?? {}) as Record<string, number>;
      return [k, String(m['n']), pct(m['meanSigned'] as number), pct(m['p50'] as number), pct(m['p90'] as number), pct(m['p95'] as number), pct(m['p99'] as number), pct(b['0.03']), pct(b['0.05']), pct(b['0.08']), pct(b['0.1']), pct(b['0.15'])];
    })), '');
  }
  const ctl = (d['controller'] ?? {}) as { enabled?: boolean; ranges?: readonly Record<string, unknown>[] };
  if (ctl.ranges?.length) {
    lines.push(`Adaptive edge (${ctl.enabled ? 'enabled' : 'disabled'}), end-of-run state over the rolling window of non-flagged flow:`, '');
    lines.push(table(['Range', 'Adjustment', 'Override', 'Window bets', 'Realized', 'Target', 'SE'], ctl.ranges.filter(x => Number(x['bets']) > 0 || Number(x['adjust']) !== 0).map(x => [String(x['key']), `${(Number(x['effective']) * 100).toFixed(2)} pts`, x['override'] !== undefined ? `${(Number(x['override']) * 100).toFixed(2)} pts` : '—', String(x['bets']), pct(x['realized'] as number | null), pct(x['target'] as number | null), pct(x['se'] as number | null)])), '');
    const movesList = (d['controllerMoves'] ?? []) as readonly Record<string, unknown>[];
    lines.push(`${movesList.length} controller adjustments were journaled${movesList.length ? ` (first ${String(movesList[0]!['time'])} ${String(movesList[0]!['range'])} ${String(movesList[0]!['before'])} → ${String(movesList[0]!['after'])}; last ${String(movesList.at(-1)!['time'])} ${String(movesList.at(-1)!['range'])} → ${String(movesList.at(-1)!['after'])})` : ''}.`, '');
  }
  const tox = (d['toxicity'] ?? {}) as Record<string, unknown>;
  if (tox['toxicFlowShareAll'] !== undefined) lines.push(`Toxic-flow share (handle from flagged accounts): ${pct(tox['toxicFlowShareAll'] as number | null)} over the run; ${String(tox['flaggedByMonitor'] ?? 0)} accounts flagged and ${String(tox['blockedByMonitor'] ?? 0)} blocked by the monitor at the end.`, '');
}
