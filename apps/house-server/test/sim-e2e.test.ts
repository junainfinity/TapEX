import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFENSES, DEFENSES_OFF } from '@maya/house';
import { ADVERSARIAL_STRATEGIES, HONEST_STRATEGIES } from '../src/sim/strategies.js';
import { defaultSimOptions, parseSimArgs, runSimulation } from '../src/run-sim.js';
import { renderMarkdown, usdEstimate } from '../src/report.js';
import { tempDir, walk, writeMarketLog } from './helpers.js';

const START = 1_790_010_000; // on a whole hour, UTC
const HOURS = 2;

const WARM_S = 7.5 * 3600;
/**
 * Synthetic Gaussian walks: 7.5 h of history (the startup refit calibrates the table to this process;
 * the published tables are fitted to real BTC/ETH microstructure and misprice a pure random walk)
 * followed by the replay period with one 25 s outage.
 */
function syntheticLog(): string {
  const root = tempDir('house-sim-log-');
  const seconds = HOURS * 3600 + WARM_S + 300;
  const gap: [number, number][] = [[START + 3000, START + 3025]]; // a 25 s outage: stale-feed breaker and refunds
  writeMarketLog(root, {
    'btc-usd': walk({ t0: START - WARM_S, seconds, start: 64_000, sigma: 3e-5, seed: 101, gaps: gap }),
    'eth-usd': walk({ t0: START - WARM_S, seconds, start: 2_600, sigma: 4e-5, seed: 202, gaps: gap }),
  });
  return root;
}

describe('offline end-to-end simulation', () => {
  it('replays 2 h with 500 players through the real engine: exact reconciliation and every invariant', async () => {
    const root = syntheticLog();
    const out = tempDir('house-sim-out-');
    // The Stage A engine (SPEC-10 defenses off, SPEC-12 promo tiers off: the single launch boost): this run documents the
    // latency-arbitrage exposure the defenses address. The promo tiers have their own simulation test (promo-sim.test.ts).
    const { report, outDir } = await runSimulation(defaultSimOptions({
      name: 'e2e', fromMs: START * 1000, hours: HOURS, players: 500, refitOnStart: true, trainHours: 7, write: true, outDir: out, marketDataDir: root, seed: 'e2e', houseFundOpen: 2_000_000,
      defenses: DEFENSES_OFF, profile: 'none', promo: null,
    }));
    expect(outDir).toBe(out);
    expect(existsSync(resolve(out, 'report.json'))).toBe(true);
    expect(existsSync(resolve(out, 'report.md'))).toBe(true);
    const inv = report.invariants as Record<string, unknown>;
    expect(inv).toMatchObject({ ledgerSumZero: true, negativeAccounts: [], simIdentity: true, escrowMatchesOpenStakes: true, solvencyViolations: 0, equityNonNegative: true, allHold: true });
    expect(BigInt(inv['minEquityCenti'] as string)).toBeGreaterThan(0n);
    expect(report.reconciliation).toMatchObject({ match: true, deltaWei: '0' });
    expect(report.reconciliation['dust']).toHaveLength(11); // every on-chain deposit carried 1234 wei of dust
    // 500 crowd players + 11 on-chain players + the extra accounts the splitter opened.
    const splitterExtra = Number(report.strategies['splitter']?.['accounts'] ?? 0) - Number(report.strategies['splitter']?.['players'] ?? 0);
    expect(report.headline).toMatchObject({ registeredPlayers: 511 + splitterExtra, reconciliation: 'exact match', invariants: 'all hold' });
    expect(report.headline['betsAccepted']).toBeGreaterThan(5000);
    const pnl = report.pnl as Record<string, string | number>;
    expect(pnl['openLegsAtEnd']).toBe(0);
    // No treasury moves in the run: the house result is exactly the settled GGR.
    expect(pnl['totalPnlCenti']).toBe(pnl['settledGgrCenti']);
    expect(BigInt(pnl['equityEndCenti'] as string) - BigInt(pnl['equityStartCenti'] as string)).toBe(BigInt(pnl['totalPnlCenti'] as string));
    expect(Object.keys(report.strategies).sort()).toEqual(['casual', 'chaser', 'grinder', 'sniper1s', 'sniper2s', 'splitter', 'streaker', 'whale']);
    const onchain = report.onchain as { bets: number; receipts: { kind: string }[]; errors: string[] };
    expect(onchain.errors).toEqual([]);
    expect(onchain.bets).toBeGreaterThan(50);
    expect(onchain.receipts.filter(r => r.kind === 'deposit')).toHaveLength(11);
    expect(onchain.receipts.filter(r => r.kind === 'withdraw').length).toBeGreaterThanOrEqual(11);
    expect(onchain.receipts.filter(r => r.kind === 'attest').length).toBeGreaterThanOrEqual(HOURS * 6);
    // The outage tripped and recovered the feed breakers and forced refunds.
    expect(report.breakerEvents.some(b => String(b['action']).startsWith('breaker:feedStale:tripped'))).toBe(true);
    expect(report.rtp.byPhase.find(r => r.key === 'launch')!.refunds).toBeGreaterThan(0);
    expect(report.phases[0]).toMatchObject({ phase: 'launch' });
    // The startup refit replaced both published tables and the refitted pricing is calibrated to the process.
    expect(report.refits).toHaveLength(1);
    expect((report.refits[0] as { state: string }).state).toBe('done');
    // Uninformed strategies realize the model's expected RTP; the sniper's one second of foresight shows up as excess return.
    let settled = 0n, returned = 0n, expectedReturn = 0, variance = 0;
    for (const [k, v] of Object.entries(report.strategies)) {
      if ((ADVERSARIAL_STRATEGIES as readonly string[]).includes(k)) continue;
      settled += BigInt(v['settledStakeCenti'] as string); returned += BigInt(v['returnedCenti'] as string);
      expectedReturn += (v['expectedRtp'] as number) * Number(v['settledStakeCenti']);
      variance += (((v['expectedHigh'] as number) - (v['expectedRtp'] as number)) / 2 * Number(v['settledStakeCenti'])) ** 2;
    }
    const realized = Number(returned) / Number(settled), expected = expectedReturn / Number(settled);
    expect(expected).toBeGreaterThan(0.93); expect(expected).toBeLessThan(0.97); // launch edge 3 %
    const se = Math.sqrt(variance) / Number(settled);
    expect(se).toBeGreaterThan(0); expect(se).toBeLessThan(0.05);
    expect(Math.abs(realized - expected)).toBeLessThan(4 * se);
    const sniper = report.strategies['sniper1s']!;
    expect(sniper['rtp'] as number).toBeGreaterThan(sniper['expectedRtp'] as number);
    const md = renderMarkdown(report);
    expect(md).toMatch(/## Launch vs standard phase/);
    expect(md).toMatch(/estimate/);
    expect(md).toMatch(/exact match/);
  }, 180_000);

  it('is deterministic for a seed and feed', async () => {
    const root = syntheticLog();
    const run = async () => (await runSimulation(defaultSimOptions({ name: 'det', fromMs: START * 1000, hours: 0.5, players: 120, refitOnStart: false, write: false, marketDataDir: root, seed: 'det', houseFundOpen: 500_000 }))).report;
    const a = await run(), b = await run();
    expect(b.headline).toEqual(a.headline);
    expect(b.pnl).toEqual(a.pnl);
    expect(b.strategies).toEqual(a.strategies);
  }, 180_000);
});

describe('offline simulation with the SPEC-10 defenses', () => {
  it('holds resolve within the bound, adversaries are caught, honest play stays fluid, and the ledger still reconciles exactly', async () => {
    const root = syntheticLog();
    const base = { fromMs: START * 1000, hours: HOURS, players: 500, refitOnStart: true, trainHours: 7, write: false, marketDataDir: root, seed: 'e2e-def', houseFundOpen: 2_000_000, mix: { sniper1s: 0.1, sniper2s: 0.05, splitter: 0.05 } };
    const none = (await runSimulation(defaultSimOptions({ ...base, name: 'def-none', defenses: DEFENSES_OFF, profile: 'none' }))).report;
    const all = (await runSimulation(defaultSimOptions({ ...base, name: 'def-all', defenses: DEFAULT_DEFENSES, profile: 'all' }))).report;
    for (const r of [none, all]) {
      expect(r.reconciliation).toMatchObject({ match: true, deltaWei: '0' });
      expect((r.invariants as Record<string, unknown>)['allHold']).toBe(true);
    }
    type Agg = { housePnlCenti: string; rejectionRate: number; attempts: number };
    const dn = none.defenses as { adversarial: Agg; hold: { created: number } };
    const da = all.defenses as { adversarial: Agg; honest: Agg; hold: { created: number; accepted: number; latencyMs: { p95: number } }; profile: string };
    expect(dn.hold.created).toBe(0);
    expect(da.profile).toBe('all');
    expect(da.hold.created).toBeGreaterThan(1000);
    expect(da.hold.accepted).toBeGreaterThan(0);
    expect(da.hold.latencyMs.p95).toBeLessThanOrEqual(DEFAULT_DEFENSES.hold.maxHoldMs);
    // The house loses far less to players with foresight, and catches them from latency evidence.
    expect(BigInt(da.adversarial.housePnlCenti)).toBeGreaterThan(BigInt(dn.adversarial.housePnlCenti));
    const flagged = ADVERSARIAL_STRATEGIES.reduce((s, k) => s + Number(all.strategies[k]?.['monitorFlagged'] ?? 0), 0);
    expect(flagged).toBeGreaterThan(0);
    // Honest players still get most placements through (bounded for this small synthetic sample).
    expect(da.honest.attempts).toBeGreaterThan(1000);
    expect(da.honest.rejectionRate).toBeLessThan(0.2);
    for (const k of HONEST_STRATEGIES) expect(all.strategies[k]?.['blocked'] ?? 0).toBe(0);
    expect(renderMarkdown(all)).toMatch(/## Defenses \(SPEC-10\)/);
  }, 240_000);
});

describe('simulation CLI and report helpers', () => {
  it('parses options strictly', () => {
    expect(parseSimArgs(['--hours', '3', '--players', '100', '--name', 'x', '--no-onchain'])).toMatchObject({ ok: true, options: { hours: 3, players: 100, name: 'x', onchainPlayers: false } });
    expect(parseSimArgs(['--hours', '0'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--network', 'mainnet'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--name', '../escape'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--bogus'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--from', 'yesterday'])).toMatchObject({ ok: false });
  });
  it('parses defense profiles, tuning and mixes, and defaults to every defense on', () => {
    expect(parseSimArgs([])).toMatchObject({ ok: true, options: { profile: 'all', defenses: DEFAULT_DEFENSES, operatorBlockMin: 0 } });
    const none = parseSimArgs(['--defenses', 'none']);
    expect(none).toMatchObject({ ok: true, options: { profile: 'none', defenses: DEFENSES_OFF, operatorBlockMin: 15 } });
    const one = parseSimArgs(['--defenses', 'none,hold,lead5']);
    expect(one.ok && one.options.defenses).toMatchObject({ hold: { enabled: true }, minLeadS: 5, ramp: { enabled: false }, toxicity: { enabled: false } });
    const minus = parseSimArgs(['--defenses', 'all,-controller', '--tune', 'hold.tolRel=0.3', '--tune', 'controller.overrides.2-5=0.01']);
    expect(minus.ok && minus.options.defenses).toMatchObject({ controller: { enabled: false, overrides: { '2-5': 0.01 } }, hold: { enabled: true, tolRel: 0.3 } });
    expect(minus.ok && minus.options.profile).toBe('all,-controller + hold.tolRel=0.3 controller.overrides.2-5=0.01');
    expect(parseSimArgs(['--defenses', 'all,bogus'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--tune', 'hold.nope=1'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--tune', 'hold.tolRel=-1'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--mix', '{"sniper2s":0.02}'])).toMatchObject({ ok: true, options: { mix: { sniper2s: 0.02 } } });
    expect(parseSimArgs(['--mix', '{"sniper2s":-1}'])).toMatchObject({ ok: false });
  });
  it('converts Centi to USD at 0.138 exactly', () => {
    expect(usdEstimate(100n)).toBe('$0.14'); // 1 OPEN = $0.138
    expect(usdEstimate(10_000_000n)).toBe('$13,800.00');
    expect(usdEstimate(-5_886_835n)).toBe('-$8,123.83');
    expect(usdEstimate(0n)).toBe('$0.00');
  });
});

const REAL_LOG = resolve(import.meta.dirname, '..', '..', '..', '..', 'market-data');
describe.skipIf(!existsSync(REAL_LOG))('simulation on the recorded market log', () => {
  it('replays 1 h of recorded prices with 300 players and reconciles exactly', async () => {
    const { report } = await runSimulation(defaultSimOptions({ name: 'real', hours: 1, players: 300, refitOnStart: false, write: false, marketDataDir: REAL_LOG, seed: 'real' }));
    expect(report.reconciliation).toMatchObject({ match: true });
    expect((report.invariants as Record<string, unknown>)['allHold']).toBe(true);
    expect(report.headline['betsAccepted']).toBeGreaterThan(1000);
  }, 180_000);
});
