import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMO, scalePromoThresholds } from '@maya/house';
import { renderMarkdown } from '../src/report.js';
import { defaultSimOptions, parseSimArgs, runSimulation } from '../src/run-sim.js';
import { Prng } from '../src/sim/prng.js';
import { ALL_STRATEGIES, DEFAULT_MIX, FARMER, PROMO_STRATEGIES, STRATEGIES, chooseCell } from '../src/sim/strategies.js';
import { HISTORY, T0, deliver, makeEngine, tempDir, walk, writeMarketLog } from './helpers.js';

const START = 1_790_010_000; // on a whole hour, UTC
const HOURS = 2;
const WARM_S = 7.5 * 3600;
function syntheticLog(): string {
  const root = tempDir('house-promo-log-');
  const seconds = HOURS * 3600 + WARM_S + 300;
  writeMarketLog(root, {
    'btc-usd': walk({ t0: START - WARM_S, seconds, start: 64_000, sigma: 3e-5, seed: 303 }),
    'eth-usd': walk({ t0: START - WARM_S, seconds, start: 2_600, sigma: 4e-5, seed: 404 }),
  });
  return root;
}

describe('farmer strategy (SPEC-12 §7)', () => {
  it('is a promo strategy outside the Stage A and SPEC-10 lists, off by default, and picks the lowest-odds square at its maximum stake', () => {
    expect(PROMO_STRATEGIES).toEqual(['farmer']);
    expect(STRATEGIES).not.toContain('farmer');
    expect(ALL_STRATEGIES).toContain('farmer');
    expect(DEFAULT_MIX.farmer).toBe(0);
    expect(FARMER.maxAccounts).toBeGreaterThan(1);
    const { engine } = makeEngine({ config: { promo: DEFAULT_PROMO } });
    deliver(engine, 'btc-usd', T0, HISTORY.get(T0 - 1)!);
    const grid = engine.latestGrid('btc-usd')!;
    const choice = chooseCell('farmer', { grid, prng: new Prng(1), streak: 0 })!;
    const lowest = Math.min(...grid.quotes.filter(q => q !== null).map(q => q!.x100));
    expect(choice.quote.x100).toBe(lowest);
    expect(choice.quote.x100).toBeGreaterThanOrEqual(125);
    expect(choice.stakeFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it('parses the promo options: tiers by default, off, legacy, a scaled run flagged in its label', () => {
    expect(parseSimArgs([])).toMatchObject({ ok: true, options: { promo: DEFAULT_PROMO, promoLabel: 'tiers (operator defaults)' } });
    const off = parseSimArgs(['--promo', 'off']);
    expect(off.ok && off.options.promo).toMatchObject({ enabled: false });
    expect(parseSimArgs(['--promo', 'legacy'])).toMatchObject({ ok: true, options: { promo: null, promoLabel: 'legacy launch boost' } });
    const scaled = parseSimArgs(['--promo-scale', '0.01,0.1']);
    expect(scaled.ok && scaled.options.promo!.tiers.map(t => t.untilPlayers)).toEqual([100, 1_000, 10_000]);
    expect(scaled.ok && scaled.options.promoLabel).toMatch(/SCALED/);
    expect(scaled.ok && scaled.options.promoScale).toEqual({ players: 0.01, turnover: 0.1 });
    expect(parseSimArgs(['--promo', 'bonus'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--promo-scale', '2,0.1'])).toMatchObject({ ok: false });
    expect(parseSimArgs(['--promo', 'legacy', '--promo-scale', '0.1,0.1'])).toMatchObject({ ok: false });
  });
});

describe('offline simulation with promo tiers (SPEC-12)', () => {
  it('runs every tier with farmers: per-tier report, min-win floors respected, farmers bounded by their caps, exact reconciliation', async () => {
    const root = syntheticLog();
    // Scaled thresholds (simulation only) so launch, growth, scale and standard all occur within 2 h of 400 players.
    const promo = scalePromoThresholds(DEFAULT_PROMO, 0.002, 0.0005);
    const { report } = await runSimulation(defaultSimOptions({
      name: 'promo', fromMs: START * 1000, hours: HOURS, players: 400, refitOnStart: true, trainHours: 7, write: false, marketDataDir: root, seed: 'promo-e2e', houseFundOpen: 2_000_000,
      mix: { farmer: 0.1 }, promo, promoLabel: 'tiers SCALED for the test', promoScale: { players: 0.002, turnover: 0.0005 },
    }));
    expect(report.reconciliation).toMatchObject({ match: true, deltaWei: '0' });
    expect((report.invariants as Record<string, unknown>)['allHold']).toBe(true);
    const p = report.promo!;
    expect(p).toMatchObject({ scaled: true, warning: expect.stringMatching(/SCALED/) });
    const tiers = p['tiers'] as Record<string, any>[];
    expect(tiers.map(t => t['id'])).toEqual(['launch', 'growth', 'scale', 'standard']);
    for (const t of tiers) expect(t['reached']).toBe(true);
    for (const t of tiers.slice(0, 3)) {
      expect(BigInt(t['boostedTurnoverCenti'])).toBeGreaterThan(0n);
      expect(t['accounts']['overCap']).toBe(0);
      expect(BigInt(t['accounts']['maxBoostedCenti'])).toBeLessThanOrEqual(BigInt(t['perAccountBoostCapCenti']));
      expect(t['lowestBoostedX100']).toBeGreaterThanOrEqual(t['minWinX100']);
      expect(t['boosted']['budget']).toBe(t['lossBudget']);
    }
    expect(BigInt(tiers[3]!['boostedTurnoverCenti'])).toBe(0n);
    // Tier spans chain: each tier starts where the previous one ended.
    for (let i = 1; i < 4; i++) { expect(tiers[i]!['from']).toBe(tiers[i - 1]!['to']); expect(tiers[i]!['playersStart']).toBe(tiers[i - 1]!['playersEnd']); expect(tiers[i]!['turnoverStartCenti']).toBe(tiers[i - 1]!['turnoverEndCenti']); }
    expect(p['minWin']).toMatchObject({ respected: true, belowMinWin: 0 });
    expect((p['minWin'] as { boostedLegs: number }).boostedLegs).toBeGreaterThan(100);
    const farmers = p['farmers'] as Record<string, any>;
    expect(farmers['players']).toBeGreaterThan(5);
    expect(farmers['accounts']).toBeGreaterThan(farmers['players']);
    expect(farmers['anyAccountOverCap']).toBe(false);
    expect(BigInt(farmers['boostedTurnoverCenti'])).toBeGreaterThan(0n);
    // Per-tier turnover sums to the run's turnover (every leg is attributed to the tier it was quoted in).
    expect(tiers.reduce((s, t) => s + BigInt(t['turnoverCenti']), 0n)).toBe(BigInt((p['totals'] as Record<string, string>)['turnoverCenti']));
    expect(report.strategies['farmer']).toBeDefined();
    const md = renderMarkdown(report);
    expect(md).toMatch(/## Promo tiers \(SPEC-12\)/);
    expect(md).toMatch(/THRESHOLDS SCALED/);
    expect(md).toMatch(/### Farmers/);
  }, 240_000);
});
