import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { MarketId } from '@maya/contracts';
import { CENTI_WEI, DEFAULT_DEFENSES, DEFAULT_PROMO, DEFENSES_OFF, DEFENSE_NAMES, freezeDefenses, freezePromo, fromWei, scalePromoThresholds, validateDefenses, validatePromo, type DefenseConfig, type PromoConfig } from '@maya/house';
import { buildPromoReport } from './promo-report.js';
import { toJson } from './api/http.js';
import { HouseApp } from './app.js';
import { defaultReplayFrom, engineConfig, journalPath, loadLiveChain, loadReplay, newRunId } from './bootstrap.js';
import type { ChainNetwork, ChainPort } from './chain-port.js';
import { defaultRepoRoot } from './config.js';
import { FileJournal, NullJournal } from './ledger/journal.js';
import { TOXICITY_ACTOR } from './engine/engine.js';
import { ACCOUNTS } from './ledger/ledger.js';
import { RtpAgg } from './metrics/metrics.js';
import { OfflineChain } from './offline-chain.js';
import { InlineRefitRunner } from './refit/runner.js';
import { TableRegistry } from './refit/tables.js';
import { REFERENCE_USD_PER_OPEN, pct, renderMarkdown, usdEstimate, type SimReport } from './report.js';
import { ADVERSARIAL_STRATEGIES, HONEST_STRATEGIES, type Strategy } from './sim/strategies.js';
import { isoSeconds } from './util.js';

export interface SimRunOptions {
  readonly name: string;
  readonly fromMs?: number;
  readonly hours: number;
  readonly players: number;
  /** Share of the run over which players arrive (0.6 puts the 10,000th of 12,000 at mid-run). */
  readonly arrivalFraction: number;
  readonly seed: string;
  readonly network: ChainNetwork;
  readonly houseFundOpen: number;
  readonly refitOnStart: boolean;
  readonly trainHours: number;
  readonly refitHours: number;
  readonly journal: boolean;
  readonly outDir?: string;
  readonly write: boolean;
  /** A simulated operator resumes a drawdown pause after this many feed minutes (0 = never). */
  readonly operatorResumeMin: number;
  /** A simulated operator blocks accounts the toxicity monitor flagged, after this review delay in feed minutes (0 = never). */
  readonly operatorBlockMin: number;
  readonly onchainDepositOpen: number;
  readonly onchainPlayers: boolean;
  readonly marketDataDir: string;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly markets: readonly MarketId[];
  readonly attestEveryMin: number;
  readonly mix?: Partial<Record<Strategy, number>>;
  readonly log?: (line: string) => void;
  /** Also write legs.csv.gz (every settled leg: strategy, p at issue, p at the end of the hold, x100, stake, credit) for offline analysis. */
  readonly dumpLegs?: boolean;
  /** SPEC-10 defenses for this run and the profile name that produced them (ablation label). */
  readonly defenses: DefenseConfig;
  readonly profile: string;
  /** SPEC-12 promo tiers for this run (null: the legacy single launch boost) and a label saying how they were chosen. */
  readonly promo: PromoConfig | null;
  readonly promoLabel: string;
  /** Set when the thresholds were scaled for a compressed run (reported and flagged in every output). */
  readonly promoScale?: { readonly players: number; readonly turnover: number };
}

/**
 * Defense profile: comma-separated tokens applied left to right. `none` (Stage A) and `all`
 * (production defaults) reset; `hold`, `validity`, `ramp`, `toxicity`, `controller`, `reference`
 * enable one defense with its default parameters (`-name` disables it); `leadN` sets the minimum
 * lead to N seconds. Starts from `none`.
 */
export function defenseProfile(spec: string): { ok: true; config: DefenseConfig } | { ok: false; message: string } {
  let c: DefenseConfig = DEFENSES_OFF;
  const alias: Record<string, (typeof DEFENSE_NAMES)[number]> = { validity: 'quoteValidity', quotevalidity: 'quoteValidity' };
  for (const raw of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const token = raw.toLowerCase();
    if (token === 'none') { c = DEFENSES_OFF; continue; }
    if (token === 'all') { c = DEFAULT_DEFENSES; continue; }
    const lead = /^lead(\d{1,2})$/.exec(token);
    if (lead) { c = freezeDefenses({ ...c, minLeadS: Number(lead[1]) }); continue; }
    const off = token.startsWith('-');
    const name = alias[off ? token.slice(1) : token] ?? (off ? token.slice(1) : token);
    if (!(DEFENSE_NAMES as readonly string[]).includes(name)) return { ok: false, message: `unknown defense token ${raw} (use none, all, hold, validity, ramp, toxicity, controller, reference, leadN, -name)` };
    const key = name as (typeof DEFENSE_NAMES)[number];
    c = freezeDefenses({ ...c, [key]: { ...(off ? c[key] : DEFAULT_DEFENSES[key]), enabled: !off } } as DefenseConfig);
  }
  const error = validateDefenses(c);
  return error ? { ok: false, message: error } : { ok: true, config: c };
}

/** Set one parameter by dotted path (e.g. hold.tolRel=0.04, controller.overrides.2-5=0.01); values are JSON or bare strings. */
export function tuneDefenses(config: DefenseConfig, assignment: string): { ok: true; config: DefenseConfig } | { ok: false; message: string } {
  const eq = assignment.indexOf('=');
  if (eq <= 0) return { ok: false, message: `--tune expects path=value (got ${assignment})` };
  const path = assignment.slice(0, eq).split('.'), rawValue = assignment.slice(eq + 1);
  let value: unknown; try { value = JSON.parse(rawValue); } catch { value = rawValue; }
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let node: Record<string, unknown> = copy;
  for (const [i, part] of path.entries()) {
    if (i === path.length - 1) { if (!(part in node) && !(path[i - 1] === 'overrides')) return { ok: false, message: `unknown defense parameter ${path.join('.')}` }; node[part] = value; break; }
    const next = node[part];
    if (!next || typeof next !== 'object') return { ok: false, message: `unknown defense section ${path.slice(0, i + 1).join('.')}` };
    node = next as Record<string, unknown>;
  }
  const tuned = freezeDefenses(copy as unknown as DefenseConfig);
  const error = validateDefenses(tuned);
  return error ? { ok: false, message: error } : { ok: true, config: tuned };
}

export function defaultSimOptions(overrides: Partial<SimRunOptions> = {}): SimRunOptions {
  const repoRoot = overrides.repoRoot ?? defaultRepoRoot();
  const defenses = overrides.defenses ?? DEFAULT_DEFENSES;
  return {
    name: 'offline', hours: 24, players: 12_000, arrivalFraction: 0.6, seed: 'maya-live-sim', network: 'offline', houseFundOpen: 5_000_000, refitOnStart: true,
    trainHours: 36, refitHours: 6, journal: false, write: true, operatorResumeMin: 30,
    // The Stage A operator blocks every monitor flag after 15 min; with graduated toxicity the engine blocks on its own evidence.
    operatorBlockMin: defenses.toxicity.enabled ? 0 : 15, onchainDepositOpen: 1000, onchainPlayers: true,
    marketDataDir: resolve(repoRoot, '..', 'market-data'), repoRoot, dataDir: resolve(repoRoot, 'apps', 'house-server', 'data'), markets: ['btc-usd', 'eth-usd'], attestEveryMin: 10,
    profile: overrides.defenses ? 'custom' : 'all',
    ...overrides, defenses,
    // SPEC-12: production promo tiers unless the caller names others (null = the legacy single launch boost).
    promo: overrides.promo === undefined ? DEFAULT_PROMO : overrides.promo,
    promoLabel: overrides.promoLabel ?? (overrides.promo === null ? 'legacy launch boost' : overrides.promo === undefined ? 'tiers (operator defaults)' : 'custom'),
  };
}

/** Output folder for a run: `artifacts/verification/house-sim-<date>-<name>`. */
export function simOutDir(opts: Pick<SimRunOptions, 'outDir' | 'repoRoot' | 'name'>): string {
  return opts.outDir ?? join(opts.repoRoot, 'artifacts', 'verification', `house-sim-${new Date().toISOString().slice(0, 10)}-${opts.name}`);
}

const STEP_MS = 250;

/**
 * Headless simulation: replays a market-log period at maximum speed through the real engine with a
 * synthetic crowd and the on-chain players, then writes SPEC §9 outputs.
 */
export async function runSimulation(opts: SimRunOptions): Promise<{ report: SimReport; app: HouseApp; outDir?: string }> {
  const log = opts.log ?? (() => undefined);
  const wallStart = Date.now();
  const plannedOut = opts.write ? simOutDir(opts) : undefined;
  // Evidence is append-only: never overwrite an existing run folder.
  if (plannedOut && existsSync(plannedOut) && readdirSync(plannedOut).length) throw new Error(`Refusing to overwrite existing run folder ${plannedOut}`);
  const runId = newRunId();
  const warmHours = opts.refitOnStart ? opts.trainHours : 0;
  const fromMs = opts.fromMs ?? defaultReplayFrom(opts.marketDataDir, opts.markets, warmHours);
  const toMs = fromMs + Math.round(opts.hours * 3_600_000);
  const replay = loadReplay(opts.marketDataDir, opts.markets, fromMs, toMs, warmHours * 3600 + 700, 1);
  const warmup = opts.markets.flatMap(m => replay.history(m));
  log(`sim: replay ${isoSeconds(fromMs)} → ${isoSeconds(toMs)}, ${replay.remaining} samples, ${warmup.length} warm-up seconds`);

  let chain: ChainPort;
  if (opts.network === 'offline') chain = new OfflineChain({ now: () => replay.nowMs(), initialHouseFundWei: BigInt(Math.round(opts.houseFundOpen)) * 10n ** 18n, syncEvents: true, seed: `${opts.seed}:${runId}` });
  else chain = await loadLiveChain(opts.network, { repoRoot: opts.repoRoot, dataDir: opts.dataDir, log });
  const tables = new TableRegistry(opts.journal ? opts.dataDir : undefined);
  tables.loadPublished(opts.markets);
  const durationMin = opts.hours * 60;
  const arrivalsPerMin = opts.players > 0 ? opts.players / (durationMin * Math.min(1, Math.max(0.05, opts.arrivalFraction))) : 0;
  const app = new HouseApp({
    engineConfig: { ...engineConfig(opts.markets, { trainHours: opts.trainHours, defenses: opts.defenses, promo: opts.promo }), receiptCapacity: 400_000, settledCapacity: 20_000 },
    chain, feed: replay, journal: opts.journal ? new FileJournal(journalPath(opts.dataDir, `sim-${runId}`)) : new NullJournal(), tables,
    refitRunner: new InlineRefitRunner(), runId, bootId: `sim${runId.slice(-4)}`, log,
    refit: { trainHours: opts.trainHours, refitHours: opts.refitHours, minRows: 600, onStart: opts.refitOnStart, minWarmHours: 6 },
    attestEveryMs: opts.attestEveryMin * 60_000, chainClock: opts.network === 'offline' ? 'feed' : 'wall',
    ...(opts.players > 0 ? { sim: { players: opts.players, arrivalsPerMin, seed: opts.seed, ...(opts.mix ? { mix: opts.mix } : {}), peek: (m, t) => replay.peek(m, t) } } : {}),
    ...(opts.onchainPlayers ? { onchain: { depositWei: BigInt(Math.round(opts.onchainDepositOpen)) * 10n ** 18n + 1234n, betsPerMin: 2, topUpBelowCenti: 10_000n, seed: `${opts.seed}:onchain` } } : {}),
    // Each attested balance tree is kept with the run's evidence (one JSON file per attestation).
    ...(plannedOut ? { attestationDir: join(plannedOut, 'attestations') } : {}),
    warmup, stepMs: STEP_MS, bootFeed: { mode: 'replay', fromMs, toMs, network: chain.network, chainId: chain.chainId },
  });
  const e = app.engine;
  const toReview: { account: string; ms: number }[] = [];
  const legRows: string[] = [];
  if (opts.dumpLegs) e.on(n => {
    if (n.type !== 'settlement' || n.data.status === 'refunded') return;
    const l = n.data;
    legRows.push(`${l.strategy ?? l.kind},${l.p},${l.pFresh ?? ''},${l.x100},${l.stakeCenti},${l.settlement?.creditCenti ?? '0'},${l.phase},${l.policyEdge ?? ''},${l.flagged ? 1 : 0},${l.cell.marketId},${(l.cell.startMs - l.sourceTimeMs) / 1000},${l.tier ?? ''},${l.boosted ? 1 : 0},${l.account},${l.placedMs},${l.bandIndex}`);
  });
  // SPEC-12: every settled leg priced at boosted odds must be at or above its tier's minimum win.
  const minWinCheck = { boostedLegs: 0, belowMinWin: 0, lowestByTier: {} as Record<string, number> };
  if (opts.promo) {
    const promo = opts.promo;
    e.on(n => {
      if (n.type !== 'settlement' || !n.data.boosted || n.data.tier === undefined) return;
      const t = promo.tiers.find(x => x.id === n.data.tier);
      minWinCheck.boostedLegs++;
      if (!t || n.data.x100 < t.minWinX100) minWinCheck.belowMinWin++;
      const low = minWinCheck.lowestByTier[n.data.tier];
      if (low === undefined || n.data.x100 < low) minWinCheck.lowestByTier[n.data.tier] = n.data.x100;
    });
  }
  const blocked: { account: string; flaggedMs: number; blockedMs: number; strategy?: string }[] = [];
  e.on(n => { if (n.type === 'admin-action' && n.data.actor === TOXICITY_ACTOR && n.data.action === 'player-flag' && n.data.target) toReview.push({ account: n.data.target, ms: n.data.ms }); });
  await app.start();
  const drain = async () => { while (app.pending.size) await Promise.all([...app.pending]); };
  await drain();
  await app.setupOnchainPlayers(async () => { await new Promise(r => setTimeout(r, 200)); });
  const equityStart = e.equity(), bankrollStart = e.equityOnchain(), simPnlStart = e.simPnl();
  const onchainHouseStart = e.ledger.balance(ACCOUNTS.equity);

  const peak = { global: 0, maxColumn: 0, maxCell: 0, maxAccount: 0 };
  let peakE = equityStart, maxPtT = 0n, maxPtTFrac = 0, maxDd1h = 0;
  let pausedSince: number | undefined;
  let lastSample = -Infinity, midWithdrawDone = false, steps = 0;
  const stopBetsAt = toMs - 90_000;
  const midAt = fromMs + (toMs - fromMs) / 2;
  while (!replay.done) {
    app.tick(Math.min(e.nowMs + STEP_MS, toMs));
    steps++;
    if (app.pending.size) await drain();
    const now = e.nowMs;
    if (app.bettingOpen && now >= stopBetsAt) app.bettingOpen = false;
    if (!midWithdrawDone && now >= midAt && app.onchain) { midWithdrawDone = true; await app.onchain.withdrawAll(0.3, 'mid'); }
    if (now - lastSample >= 10_000) {
      lastSample = now;
      const u = e.limitUsage();
      for (const k of Object.keys(peak) as (keyof typeof peak)[]) if (Number.isFinite(u[k]) && u[k] > peak[k]) peak[k] = u[k];
      const E = e.equity();
      if (E > peakE) peakE = E;
      if (peakE - E > maxPtT) { maxPtT = peakE - E; maxPtTFrac = Number(maxPtT) / Number(peakE); }
      const dd = e.drawdown1h(); if (dd > maxDd1h) maxDd1h = dd;
      const drawdown = e.breakerStatus().find(b => b.id === 'drawdown');
      if (drawdown?.state === 'paused') {
        pausedSince ??= now;
        if (opts.operatorResumeMin > 0 && now - pausedSince >= opts.operatorResumeMin * 60_000) {
          e.resumeAll({ actor: 'sim-operator', reason: `Simulated operator review: resume after a ${opts.operatorResumeMin} min drawdown pause` });
          pausedSince = undefined;
        }
      } else pausedSince = undefined;
      while (opts.operatorBlockMin > 0 && toReview.length && now - toReview[0]!.ms >= opts.operatorBlockMin * 60_000) {
        const f = toReview.shift()!;
        const r = e.setPlayerFlag(f.account, 'block', { actor: 'sim-operator', reason: `Simulated operator: blocked ${opts.operatorBlockMin} min after the toxicity flag` });
        if (r.ok) { const strategy = e.player(f.account)?.strategy; blocked.push({ account: f.account, flaggedMs: f.ms, blockedMs: now, ...(strategy ? { strategy } : {}) }); }
      }
    }
    if (steps % 20_000 === 0) {
      await new Promise(r => setImmediate(r));
      log(`sim: ${isoSeconds(now)} players ${e.registeredPlayers} bets ${e.metrics.acceptedBets} open ${e.openLegCount} equity ${fromWei(e.equity() * CENTI_WEI).centi}`);
    }
  }
  // Settle what is left (bets stopped 90 s before the end, so every window has its evidence).
  app.tick(toMs);
  await drain();
  if (app.onchain) await app.onchain.withdrawAll(0.5, 'final');
  // Vouchers are claimed by the vault's Withdrawn events; a live chain delivers them after its confirmations.
  const unclaimed = await app.awaitWithdrawalEvents(opts.network === 'offline' ? 0 : 180_000, () => new Promise(r => setTimeout(r, 500)));
  if (unclaimed.length) log(`sim: ${unclaimed.length} submitted voucher(s) still wait for their Withdrawn event: ${unclaimed.join(', ')}`);
  const attest = await app.attestNow({ actor: 'system', reason: 'final attestation for the simulation report' });
  e.flush();

  const vault = await chain.vaultState();
  const reconciliation = e.reconcile(vault);
  const invariants = e.invariants();
  const rtp = e.metrics.rtpReport();
  const total = e.metrics.total;
  const settledHandle = total.handle, returned = total.returned;
  const simPnl = e.simPnl() - simPnlStart;
  const onchainPnl = e.ledger.balance(ACCOUNTS.equity) - onchainHouseStart - netTreasury(e, onchainHouseStart);
  const totalPnl = simPnl + onchainPnl;
  const wallSeconds = Math.round((Date.now() - wallStart) / 100) / 10;
  const launchEnd = e.phaseLog.find(p => p.phase === 'standard');
  const byPhase = (phase: 'launch' | 'standard') => e.metrics.byPhase.get(phase) ?? new RtpAgg();
  const phases = (['launch', 'standard'] as const).map(phase => {
    const agg = byPhase(phase);
    const segment = e.phaseLog.filter(p => p.phase === phase);
    const from = segment[0]?.atMs; const next = from !== undefined ? e.phaseLog.find(p => p.atMs > from && p.phase !== phase)?.atMs : undefined;
    const ggr = agg.handle - agg.returned;
    return {
      phase, from: from !== undefined ? isoSeconds(Math.max(from, fromMs)) : '—', to: from !== undefined ? isoSeconds(next ?? toMs) : '—', playersAtStart: segment[0]?.registered ?? '—',
      bets: agg.bets, handleCenti: agg.handle.toString(), returnedCenti: agg.returned.toString(), ggrCenti: ggr.toString(), ggrUsd: usdEstimate(ggr),
      realized: agg.handle > 0n ? Number(agg.returned) / Number(agg.handle) : null, expected: agg.handle > 0n ? agg.expectedReturn / Number(agg.handle) : 0, refunds: agg.refunds,
    };
  });
  const audit = e.auditAll();
  const breakerEvents = audit.filter(a => a.kind === 'breaker').map(a => ({ time: isoSeconds(a.ms), ms: a.ms, action: a.action, target: a.target, before: a.before, after: a.after, reason: a.reason, actor: a.actor }));
  const adminActions = audit.filter(a => a.kind === 'admin' && a.actor !== 'system').map(a => ({ time: isoSeconds(a.ms), actor: a.actor, action: a.action, reason: a.reason, result: a.result }));
  const mixed: Record<string, Record<string, unknown>> = app.crowd ? app.crowd.outcomes() : {};
  // Report only strategies that took part (a custom mix may drop some).
  const strategies: Record<string, Record<string, unknown>> = Object.fromEntries(Object.entries(mixed).filter(([, v]) => Number(v['players']) > 0));
  for (const [k, v] of Object.entries(strategies)) {
    const row = (e.metrics.byStrategy.get(k) ?? new RtpAgg()).row(k);
    let flaggedN = 0, blockedN = 0, monitorFlagged = 0, monitorBlocked = 0, holdN = 0, zAbove3 = 0, zSum = 0, zCount = 0;
    const flagBets: number[] = [];
    const byEvidence = { flagLatency: 0, flagOutcomes: 0, blockLatency: 0, blockOutcomes: 0, unflag: 0 };
    for (const p of e.players.values()) if (p.strategy === k) {
      if (p.flagged) flaggedN++; if (p.blocked) blockedN++;
      const firstFlag = p.flags.find(f => f.action === 'flag' && f.actor === TOXICITY_ACTOR);
      if (firstFlag) monitorFlagged++;
      if (p.flags.some(f => f.action === 'block' && f.actor === TOXICITY_ACTOR)) monitorBlocked++;
      for (const f of p.flags) if (f.actor === TOXICITY_ACTOR) {
        const latency = f.reason.startsWith('latency evidence');
        if (f.action === 'flag') { if (latency) byEvidence.flagLatency++; else byEvidence.flagOutcomes++; const m = /over (\d+) settled bets/.exec(f.reason); if (m) flagBets.push(Number(m[1])); }
        else if (f.action === 'block') { if (latency) byEvidence.blockLatency++; else byEvidence.blockOutcomes++; }
        else if (f.action === 'unflag') byEvidence.unflag++;
      }
      holdN += p.holdN;
      if (p.holdN >= 10) { const z = e.holdMoveZ(p); zSum += z; zCount++; if (z > 3) zAbove3++; }
    }
    flagBets.sort((a, b) => a - b);
    Object.assign(v, {
      flagged: flaggedN, blocked: blockedN, monitorFlagged, monitorBlocked, monitorByEvidence: byEvidence, medianBetsAtFlag: flagBets.length ? flagBets[Math.floor(flagBets.length / 2)] : null,
      latencyEvidence: { holds: holdN, accountsWith10Holds: zCount, meanZ: zCount ? zSum / zCount : null, accountsZAbove3: zAbove3 },
      expectedRtp: row.expected, expectedLow: row.expectedLow, expectedHigh: row.expectedHigh, policyTarget: row.policyTarget ?? null, settledBets: row.bets, wins: row.wins, refunds: row.refunds,
      rtpSe: row.bets > 0 ? (row.expectedHigh - row.expected) / 2 : null,
    });
  }
  const sumPnl = (keys: readonly string[]) => keys.reduce((s, k) => s + BigInt(String(strategies[k]?.['housePnlCenti'] ?? '0')), 0n);
  const honest = aggregateStrategies(strategies, HONEST_STRATEGIES);
  const adversarial = aggregateStrategies(strategies, ADVERSARIAL_STRATEGIES);
  const defensesView = e.defensesView();
  const holdMoves: Record<string, unknown> = {};
  for (const [k, xs] of e.holdMoves) holdMoves[k] = moveStats(xs);
  const controllerMoves = e.auditAll().filter(a => a.action === 'controller-adjust').map(a => ({ time: isoSeconds(a.ms), range: a.target, before: a.before, after: a.after, reason: a.reason }));
  const rejections: Record<string, number> = {};
  const limitRejections: Record<string, number> = {};
  for (const s of Object.values(strategies)) for (const [k, v] of Object.entries(s['rejections'] as Record<string, number>)) rejections[k] = (rejections[k] ?? 0) + v;
  for (const [k, v] of Object.entries(app.onchain?.stats.rejections ?? {})) rejections[k] = (rejections[k] ?? 0) + (v ?? 0);
  if (rejections['LIABILITY_LIMIT']) limitRejections['total'] = rejections['LIABILITY_LIMIT'];
  let ocBets = 0, ocHandle = 0n, ocSettled = 0n, ocReturned = 0n;
  for (const p of app.onchain?.players ?? []) { const r = e.player(p.address); if (r) { ocBets += r.bets; ocHandle += r.handle; ocSettled += r.settledStake; ocReturned += r.returned; } }
  const receipts = [...(app.onchain?.receipts ?? []), ...app.chainReceipts].sort((a, b) => a.atMs - b.atMs).map(r => ({ ...r, time: isoSeconds(r.atMs) }));
  const dust = [...e.deposits.values()].filter(d => d.dustWei !== '0').map(d => ({ account: d.account, txHash: d.txHash, dustWei: d.dustWei }));
  const simIssued = e.simCreditIssuedCenti;
  const series = downsample(e.metrics.series.toArray(), 300).map(p => ({ t: p.t, time: isoSeconds(p.t), equityCenti: p.equity.toString(), handle24hCenti: p.handle.toString(), ggr24hCenti: p.ggr.toString(), rtp24h: p.rtp, openLiabilityCenti: p.openLiability.toString(), players: p.players, betsPerMin: p.betsPerMin }));
  const invariantsOk = invariants.ledgerSumZero && !invariants.negativeAccounts.length && invariants.simIdentity && invariants.escrowMatchesOpenStakes && invariants.solvencyViolations === 0 && invariants.equityNonNegative;

  const adversarialPnl = sumPnl(ADVERSARIAL_STRATEGIES);
  const report: SimReport = {
    name: opts.name, generatedAt: new Date().toISOString(),
    run: { runId, from: isoSeconds(fromMs), to: isoSeconds(toMs), hours: opts.hours, markets: opts.markets.join(', '), network: chain.network, chainId: chain.chainId, wallSeconds, steps, samplesReplayed: e.journalSeq, quotesIssued: e.quotes.issued },
    config: {
      players: opts.players, arrivalFraction: opts.arrivalFraction, arrivalsPerMin, seed: opts.seed, houseFundOpen: opts.houseFundOpen, refitOnStart: opts.refitOnStart, trainHours: opts.trainHours, refitHours: opts.refitHours,
      operatorResumeMin: opts.operatorResumeMin, operatorBlockMin: opts.operatorBlockMin, toxicity: opts.defenses.toxicity.enabled ? { mode: 'graduated', ...opts.defenses.toxicity } : { mode: 'monitor', minBets: 50, zThreshold: 4 },
      onchainDepositOpen: opts.onchainDepositOpen, pricing: e.pricing, schedule: e.edgeSchedule, limits: e.limits, referenceUsdPerOpen: REFERENCE_USD_PER_OPEN, defenseProfile: opts.profile, defenses: opts.defenses, mix: opts.mix ?? 'default',
      promo: opts.promo, promoLabel: opts.promoLabel, ...(opts.promoScale ? { promoScale: opts.promoScale, promoScaledWarning: 'THRESHOLDS SCALED FOR A COMPRESSED SIMULATION: not the production thresholds' } : {}),
    },
    headline: {
      registeredPlayers: e.registeredPlayers, betsAccepted: e.metrics.acceptedBets, handle: `${fromWei(settledHandle * CENTI_WEI).centi} Centi`, housePnl: formatOpenCenti(totalPnl), housePnlUsd: usdEstimate(totalPnl),
      realizedRtp: pct(total.handle > 0n ? Number(returned) / Number(settledHandle) : null), expectedRtp: pct(total.handle > 0n ? total.expectedReturn / Number(settledHandle) : null),
      launchEnded: launchEnd ? `${isoSeconds(launchEnd.atMs)} at ${launchEnd.registered} players` : 'not reached', maxDrawdown1h: pct(maxDd1h), maxPeakToTrough: `${formatOpenCenti(maxPtT)} (${pct(maxPtTFrac)})`,
      breakerEvents: breakerEvents.length, reconciliation: reconciliation.match ? 'exact match' : `MISMATCH (${reconciliation.deltaWei} wei)`, invariants: invariantsOk ? 'all hold' : 'VIOLATED',
    },
    phases,
    pnl: {
      simPnlCenti: simPnl.toString(), onchainPnlCenti: onchainPnl.toString(), totalPnlCenti: totalPnl.toString(),
      sniperHousePnlCenti: adversarialPnl.toString(), excludingSniperPnlCenti: (totalPnl - adversarialPnl).toString(), totalPnlUsdEstimate: usdEstimate(totalPnl), settledGgrCenti: (settledHandle - returned).toString(),
      adversarialHousePnlCenti: adversarialPnl.toString(), honestHousePnlCenti: sumPnl(HONEST_STRATEGIES).toString(),
      equityStartCenti: equityStart.toString(), equityEndCenti: e.equity().toString(), bankrollStartCenti: bankrollStart.toString(), bankrollEndCenti: e.equityOnchain().toString(), openLegsAtEnd: e.openLegCount,
      usdReference: `${REFERENCE_USD_PER_OPEN} USD per OPEN (estimate)`,
    },
    rtp: { ...rtp, byKind: [...e.metrics.byKind].map(([k, v]) => v.row(k)) },
    drawdown: { max1h: pct(maxDd1h), max1hFraction: maxDd1h, maxPeakToTroughCenti: maxPtT.toString(), maxPeakToTroughPct: pct(maxPtTFrac), minEquityCenti: (e.minEquitySeen ?? 0n).toString() },
    limits: { peak, rejections: limitRejections, limits: e.limits },
    breakerEvents, adminActions: adminActions.filter(a => a.action !== 'player-block'), strategies,
    toxicity: { flagged: [...e.players.values()].filter(p => p.flags.some(f => f.actor === TOXICITY_ACTOR)).length, blockedByOperator: blocked.length, blockedByStrategy: blocked.reduce<Record<string, number>>((m, b) => { m[b.strategy ?? 'onchain'] = (m[b.strategy ?? 'onchain'] ?? 0) + 1; return m; }, {}), operatorBlockMin: opts.operatorBlockMin, sample: blocked.slice(0, 20).map(b => ({ ...b, flagged: isoSeconds(b.flaggedMs), blocked: isoSeconds(b.blockedMs) })) },
    onchain: {
      players: app.onchain?.players.length ?? 0, bets: ocBets, handleCenti: ocHandle.toString(), pnlCenti: (ocReturned - ocSettled).toString(), stats: app.onchain?.stats ?? {}, receipts, errors: app.onchain?.errors ?? [],
      attestation: attest.ok ? { txHash: attest.txHash, after: attest.after } : { error: attest.message },
      withdrawalEvents: { applied: e.chainWithdrawals.size, anomalies: e.unmatchedWithdrawals().length, unclaimedSubmitted: unclaimed.length },
      note: chain.network === 'offline' ? 'Offline chain: in-memory vault; transaction hashes are deterministic placeholders with no explorer.' : `Chain ${chain.network} (${chain.chainId}); explorer links where available.`,
    },
    reconciliation: {
      ...reconciliation, dust, vault: { assetsWei: vault.assetsWei.toString(), houseFundedWei: vault.houseFundedWei.toString(), totalDepositsWei: vault.totalDepositsWei.toString(), totalWithdrawalsWei: vault.totalWithdrawalsWei.toString(), houseWithdrawnWei: vault.houseWithdrawnWei.toString(), surplusWei: vault.surplusWei.toString(), lastAttestation: vault.lastAttestation },
      simCredit: { issuedCenti: simIssued.toString(), balancesCenti: e.ledger.total('sim').toString(), escrowCenti: e.ledger.balance(ACCOUNTS.escrowSim).toString(), housePnlCenti: e.simPnl().toString(), identity: String(invariants.simIdentity) },
    },
    invariants: { ...invariants, minEquityCenti: (e.minEquitySeen ?? 0n).toString(), allHold: invariantsOk },
    refits: [...app.refitJobs.values()], rejections, series,
    ...(opts.promo ? { promo: buildPromoReport(app, { fromMs, toMs, promo: opts.promo, label: opts.promoLabel, ...(opts.promoScale ? { scale: opts.promoScale } : {}), strategies, minWinCheck }) } : {}),
    defenses: {
      profile: opts.profile, config: opts.defenses, honest, adversarial,
      hold: defensesView['hold'], toxicity: defensesView['toxicity'], controller: defensesView['controller'], controllerMoves, holdMoves,
      launchGgrCenti: String(phases.find(p => p.phase === 'launch')?.ggrCenti ?? '0'),
    },
  };
  let outDir: string | undefined;
  if (opts.write) {
    outDir = plannedOut!;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(JSON.parse(toJson(report)), null, 2) + '\n');
    writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));
    if (opts.dumpLegs) writeFileSync(join(outDir, 'legs.csv.gz'), gzipSync(`strategy,p,pFresh,x100,stakeCenti,creditCenti,phase,policyEdge,flagged,market,tau,tier,boosted,account,placedMs,bandIndex\n${legRows.join('\n')}\n`));
  }
  await app.stop();
  return { report, app, ...(outDir ? { outDir } : {}) };
}

/** Treasury moves after the start (fund / withdraw-surplus) are not P&L. */
function netTreasury(engine: HouseApp['engine'], _startBalance: bigint): bigint {
  let net = 0n;
  for (const a of engine.auditAll()) {
    if (a.result !== 'ok') continue;
    const before = (a.before as { houseEquityCenti?: string } | undefined)?.houseEquityCenti, after = (a.after as { houseEquityCenti?: string } | undefined)?.houseEquityCenti;
    if ((a.action === 'treasury-fund' || a.action === 'treasury-withdraw-surplus') && before !== undefined && after !== undefined) net += BigInt(after) - BigInt(before);
  }
  return net;
}

/** Stake-weighted aggregate of a group of strategies (realized, model-expected and policy-target RTP, rejections). */
function aggregateStrategies(strategies: Record<string, Record<string, unknown>>, keys: readonly string[]): Record<string, unknown> {
  let attempts = 0, rejected = 0, held = 0, heldRejected = 0, settled = 0, returned = 0, expected = 0, policy = 0, variance = 0, pnl = 0n;
  const rejections: Record<string, number> = {};
  for (const k of keys) {
    const s = strategies[k];
    if (!s) continue;
    const st = Number(s['settledStakeCenti'] ?? 0);
    attempts += Number(s['attempts'] ?? 0); rejected += Number(s['rejected'] ?? 0); held += Number(s['held'] ?? 0); heldRejected += Number(s['heldRejected'] ?? 0);
    settled += st; returned += Number(s['returnedCenti'] ?? 0); expected += Number(s['expectedRtp'] ?? 0) * st; policy += Number(s['policyTarget'] ?? 0) * st;
    variance += (Number(s['rtpSe'] ?? 0) * st) ** 2; pnl += BigInt(String(s['housePnlCenti'] ?? '0'));
    for (const [r, n] of Object.entries((s['rejections'] ?? {}) as Record<string, number>)) rejections[r] = (rejections[r] ?? 0) + n;
  }
  return {
    strategies: keys.filter(k => strategies[k]), attempts, rejected, rejectionRate: attempts > 0 ? rejected / attempts : null, held, heldRejected, rejections,
    settledStakeCenti: String(Math.round(settled)), housePnlCenti: pnl.toString(),
    rtp: settled > 0 ? returned / settled : null, expectedRtp: settled > 0 ? expected / settled : null, policyTarget: settled > 0 ? policy / settled : null, rtpSe: settled > 0 ? Math.sqrt(variance) / settled : null,
  };
}

/** Distribution of relative fair-value moves over the hold (|p_fresh / p_quote − 1|) and the share beyond candidate tolerances. */
function moveStats(xs: readonly number[]): Record<string, unknown> {
  const abs = xs.map(Math.abs).sort((a, b) => a - b);
  if (!abs.length) return { n: 0 };
  const q = (f: number) => abs[Math.min(abs.length - 1, Math.floor(f * abs.length))]!;
  const beyond = (tol: number) => { let lo = 0, hi = abs.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (abs[mid]! <= tol) lo = mid + 1; else hi = mid; } return (abs.length - lo) / abs.length; };
  const signed = xs.reduce((s, x) => s + x, 0) / xs.length;
  return { n: abs.length, meanSigned: signed, p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), beyond: Object.fromEntries([0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2].map(t => [String(t), beyond(t)])) };
}

function formatOpenCenti(c: bigint): string { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? '-' : ''}${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')} OPEN`; }
function downsample<T>(items: readonly T[], max: number): T[] { if (items.length <= max) return [...items]; const step = items.length / max; return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]!).concat(items.at(-1)!); }

// ------------------------------------------------------------------ CLI

const USAGE = `Usage: node apps/house-server/dist/run-sim.js [options]
  --name <name>              output folder suffix (default offline)
  --from <ISO>               replay start (default: first logged second + train hours)
  --hours <n>                replay length in hours (default 24)
  --players <n>              synthetic players (default 12000; 0 disables the crowd)
  --arrival-fraction <f>     share of the run over which players arrive (default 0.6)
  --seed <text>              PRNG seed (default maya-live-sim)
  --network <n>              offline | local | base-sepolia (default offline)
  --house-fund <OPEN>        offline house bankroll (default 5000000)
  --no-refit-on-start        skip the startup refit (published tables keep tau 3 closed)
  --no-onchain               skip the 11 on-chain players
  --journal                  write the JSONL journal under the data dir
  --dump-legs                also write legs.csv.gz (settled legs incl. p at issue and at the end of the hold)
  --operator-resume-min <m>  simulated operator resumes a drawdown pause after m feed minutes (default 30, 0 = never)
  --operator-block-min <m>   simulated operator blocks toxicity-flagged accounts after m feed minutes (default 15, 0 = never)
  --out <dir>                output directory (refuses an existing non-empty folder)
  --market-data <dir>        market log root
  --defenses <profile>       SPEC-10 defense profile (default all): none | all | comma list of hold, validity,
                             ramp, toxicity, controller, reference, leadN, -name (e.g. "none,hold,lead5")
  --tune <path=value>        set one defense parameter, repeatable (e.g. --tune hold.tolRel=0.04)
  --defense-config <file>    JSON DefenseConfig to start from (then --defenses tokens and --tune apply)
  --mix <json>               strategy weights, e.g. {"sniper2s":0.02,"farmer":0.03}
  --promo <mode>             SPEC-12 promo (default tiers): tiers (operator defaults) | off (promo disabled: standard
                             pricing throughout) | legacy (the old single launch boost)
  --promo-config <file>      JSON PromoConfig to use instead of the defaults
  --promo-scale <p>,<t>      scale tier thresholds: players × p, turnover × t (SIMULATION ONLY; flagged in the report)`;

export function parseSimArgs(argv: readonly string[]): { ok: true; options: SimRunOptions } | { ok: false; message: string } {
  const o: { -readonly [K in keyof SimRunOptions]?: SimRunOptions[K] } & Record<string, unknown> = {};
  let profile: string | undefined;
  let base: DefenseConfig | undefined;
  const tunes: string[] = [];
  let promoMode: 'tiers' | 'off' | 'legacy' = 'tiers';
  let promoBase: PromoConfig | undefined;
  let promoScale: { players: number; turnover: number } | undefined;
  const nums: Record<string, [keyof SimRunOptions, number, number]> = { '--hours': ['hours', 0.05, 240], '--players': ['players', 0, 1_000_000], '--arrival-fraction': ['arrivalFraction', 0.05, 1], '--house-fund': ['houseFundOpen', 1000, 1e12], '--operator-resume-min': ['operatorResumeMin', 0, 10_000], '--operator-block-min': ['operatorBlockMin', 0, 10_000] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); return v; };
    try {
      if (a === '--help' || a === '-h') return { ok: false, message: USAGE };
      else if (a in nums) { const [k, lo, hi] = nums[a]!; const n = Number(value()); if (!Number.isFinite(n) || n < lo || n > hi) return { ok: false, message: `${a} must be within ${lo}–${hi}` }; (o as Record<string, unknown>)[k] = n; }
      else if (a === '--name') { const v = value(); if (!/^[A-Za-z0-9._-]{1,48}$/.test(v)) return { ok: false, message: '--name may only use letters, digits, dot, dash, underscore' }; o.name = v; }
      else if (a === '--from') { const ms = Date.parse(value()); if (!Number.isFinite(ms)) return { ok: false, message: '--from must be an ISO date-time' }; o.fromMs = ms; }
      else if (a === '--seed') o.seed = value();
      else if (a === '--network') { const v = value(); if (v !== 'offline' && v !== 'local' && v !== 'base-sepolia') return { ok: false, message: '--network must be offline, local or base-sepolia' }; o.network = v; }
      else if (a === '--no-refit-on-start') o.refitOnStart = false;
      else if (a === '--no-onchain') o.onchainPlayers = false;
      else if (a === '--journal') o.journal = true;
      else if (a === '--dump-legs') o.dumpLegs = true;
      else if (a === '--out') o.outDir = resolve(value());
      else if (a === '--market-data') o.marketDataDir = resolve(value());
      else if (a === '--defenses') profile = value();
      else if (a === '--tune') tunes.push(value());
      else if (a === '--defense-config') {
        const parsed = JSON.parse(readFileSync(resolve(value()), 'utf8')) as DefenseConfig;
        const error = validateDefenses(parsed);
        if (error) return { ok: false, message: `--defense-config: ${error}` };
        base = freezeDefenses(parsed);
      } else if (a === '--promo') {
        const v = value();
        if (v !== 'tiers' && v !== 'off' && v !== 'legacy') return { ok: false, message: '--promo must be tiers, off or legacy' };
        promoMode = v;
      } else if (a === '--promo-config') {
        const parsed = JSON.parse(readFileSync(resolve(value()), 'utf8')) as PromoConfig;
        const error = validatePromo(parsed);
        if (error) return { ok: false, message: `--promo-config: ${error}` };
        promoBase = freezePromo(parsed);
      } else if (a === '--promo-scale') {
        const m = /^([0-9.]+),([0-9.]+)$/.exec(value());
        const players = m ? Number(m[1]) : NaN, turnover = m ? Number(m[2]) : NaN;
        if (!(players > 0 && players <= 1) || !(turnover > 0 && turnover <= 1)) return { ok: false, message: '--promo-scale expects <players>,<turnover> factors within (0, 1], e.g. 0.01,0.1' };
        promoScale = { players, turnover };
      } else if (a === '--mix') {
        const mix = JSON.parse(value()) as Record<string, unknown>;
        if (!mix || typeof mix !== 'object' || Object.values(mix).some(v => typeof v !== 'number' || !(v >= 0))) return { ok: false, message: '--mix must be a JSON object of non-negative weights' };
        o.mix = mix as Partial<Record<Strategy, number>>;
      }
      else return { ok: false, message: `Unknown option ${a}\n${USAGE}` };
    } catch (error) { return { ok: false, message: (error as Error).message }; }
  }
  let defenses = base ?? DEFAULT_DEFENSES;
  if (profile !== undefined) {
    const p = defenseProfile(profile);
    if (!p.ok) return { ok: false, message: `--defenses: ${p.message}` };
    if (base && !/(^|,)\s*(none|all)\s*(,|$)/i.test(profile)) {
      const merged = mergeProfile(base, profile);
      if (!merged) return { ok: false, message: `--defenses: cannot apply ${profile} on top of --defense-config` };
      defenses = merged;
    } else defenses = p.config;
  }
  for (const t of tunes) { const r = tuneDefenses(defenses, t); if (!r.ok) return { ok: false, message: `--tune: ${r.message}` }; defenses = r.config; }
  const name = profile ?? (base ? 'custom' : 'all');
  if (promoMode === 'legacy' && (promoBase || promoScale)) return { ok: false, message: '--promo legacy cannot be combined with --promo-config or --promo-scale' };
  let promo: PromoConfig | null = promoMode === 'legacy' ? null : promoBase ?? DEFAULT_PROMO;
  if (promo && promoMode === 'off') promo = freezePromo({ ...promo, enabled: false });
  if (promo && promoScale) promo = scalePromoThresholds(promo, promoScale.players, promoScale.turnover);
  const promoLabel = promoMode === 'legacy' ? 'legacy launch boost' : `${promoMode === 'off' ? 'promo disabled' : promoBase ? 'tiers (custom config)' : 'tiers (operator defaults)'}${promoScale ? ` SCALED (players × ${promoScale.players}, turnover × ${promoScale.turnover})` : ''}`;
  return { ok: true, options: defaultSimOptions({ ...o, defenses, profile: tunes.length ? `${name} + ${tunes.join(' ')}` : name, promo, promoLabel, ...(promoScale ? { promoScale } : {}) }) };
}

/** Apply enable/disable tokens on top of a base config (used with --defense-config). */
function mergeProfile(base: DefenseConfig, profile: string): DefenseConfig | undefined {
  let c = base;
  for (const raw of profile.split(',').map(s => s.trim()).filter(Boolean)) {
    const lead = /^lead(\d{1,2})$/i.exec(raw);
    if (lead) { c = freezeDefenses({ ...c, minLeadS: Number(lead[1]) }); continue; }
    const off = raw.startsWith('-'); const token = (off ? raw.slice(1) : raw).toLowerCase();
    const key = (token === 'validity' ? 'quoteValidity' : token) as (typeof DEFENSE_NAMES)[number];
    if (!(DEFENSE_NAMES as readonly string[]).includes(key)) return undefined;
    c = freezeDefenses({ ...c, [key]: { ...c[key], enabled: !off } } as DefenseConfig);
  }
  return validateDefenses(c) ? undefined : c;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseSimArgs(process.argv.slice(2));
  if (!parsed.ok) { console.error(parsed.message); process.exit(parsed.message === USAGE ? 0 : 2); }
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  runSimulation({ ...parsed.options, log }).then(({ report, outDir }) => {
    const d = report.defenses as Record<string, Record<string, unknown>>;
    const promoTiers = (report.promo?.['tiers'] as Record<string, unknown>[] | undefined)?.map(t => ({ tier: t['id'], reached: t['reached'], from: t['from'], to: t['to'], boostedTurnoverCenti: t['boostedTurnoverCenti'], lossRate: (t['boosted'] as Record<string, unknown> | undefined)?.['lossRate'], budget: t['lossBudget'] }));
    console.log(JSON.stringify({ outDir, profile: d['profile'], promo: report.promo?.['label'], headline: report.headline, pnl: report.pnl, phases: report.phases.map(p => ({ phase: p['phase'], bets: p['bets'], ggrCenti: p['ggrCenti'], realized: p['realized'] })), honest: d['honest'], adversarial: d['adversarial'], promoTiers }, null, 2));
  }).catch(error => { console.error(`sim: failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`); process.exit(1); });
}
