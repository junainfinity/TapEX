import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEFENSES, DEFENSES_OFF, freezeDefenses } from '@maya/house';
import { parseAblationArgs, planRuns, renderAblation } from '../src/run-ablation.js';
import { CrowdSim } from '../src/sim/crowd.js';
import { Prng } from '../src/sim/prng.js';
import { ADVERSARIAL_STRATEGIES, DEFAULT_MIX, HONEST_STRATEGIES, SPLITTER, STRATEGIES, chooseCell, foresightOf } from '../src/sim/strategies.js';
import { HISTORY, T0, deliver, makeEngine, offered, tempDir, walk } from './helpers.js';

const FUTURE = walk({ t0: T0, seconds: 1200, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 5 });

describe('simulated strategies', () => {
  it('covers the honest crowd and the three adversaries with the SPEC-10 mix', () => {
    expect([...STRATEGIES].sort()).toEqual([...HONEST_STRATEGIES, ...ADVERSARIAL_STRATEGIES].sort());
    expect(DEFAULT_MIX).toMatchObject({ sniper1s: 0.05, sniper2s: 0.01, splitter: 0.01 });
    expect(ADVERSARIAL_STRATEGIES.map(foresightOf)).toEqual([1, 2, 1]);
    expect(HONEST_STRATEGIES.map(foresightOf)).toEqual([0, 0, 0, 0, 0]);
  });

  it('shows players only standing quotes, and the 2 s sniper looks two seconds ahead', () => {
    const { engine } = makeEngine();
    deliver(engine, 'btc-usd', T0, FUTURE.get(T0)!);
    const grid = engine.latestGrid('btc-usd')!;
    const prng = new Prng(1);
    expect(chooseCell('casual', { grid, prng, streak: 0, stands: () => false })).toBeUndefined();
    const peeks: number[] = [];
    const peek = (_m: string, t: number) => { peeks.push(t - T0); return Number(FUTURE.get(t)); };
    chooseCell('sniper1s', { grid, prng, streak: 0, peek, table: engine.currentTable('btc-usd') });
    chooseCell('sniper2s', { grid, prng, streak: 0, peek, table: engine.currentTable('btc-usd') });
    chooseCell('splitter', { grid, prng, streak: 0, peek, table: engine.currentTable('btc-usd') });
    expect(peeks).toEqual([1, 2, 1]);
  });

  it('the splitter spreads over fresh accounts and every account is followed through its holds', () => {
    const { engine } = makeEngine({ config: { defenses: freezeDefenses({ ...DEFENSES_OFF, hold: { ...DEFAULT_DEFENSES.hold, enabled: true, tolRel: 5 } }) } });
    const crowd = new CrowdSim(engine, { targetPlayers: 3, arrivalsPerMin: 60, seed: 'split', markets: ['btc-usd'], mix: { casual: 0, chaser: 0, grinder: 0, streaker: 0, whale: 0, sniper1s: 0, sniper2s: 0, splitter: 1 }, peek: (_m, t) => (FUTURE.has(t) ? Number(FUTURE.get(t)) : undefined) });
    for (let t = T0; t < T0 + 1100; t++) { deliver(engine, 'btc-usd', t, FUTURE.get(t)!); crowd.step(t * 1000 + 600); }
    const out = crowd.outcomes();
    expect(out.splitter.players).toBe(3);
    expect(out.splitter.accounts).toBeGreaterThan(3);
    expect(out.splitter.accounts).toBeLessThanOrEqual(3 * SPLITTER.maxAccounts);
    expect(out.splitter.held).toBeGreaterThan(0);
    expect(out.splitter.heldAccepted + out.splitter.heldRejected + crowd.heldCount).toBe(out.splitter.held);
    const accounts = [...engine.players.values()].filter(p => p.strategy === 'splitter');
    expect(accounts.length).toBe(out.splitter.accounts);
    for (const a of accounts) expect(a.bets).toBeLessThanOrEqual(SPLITTER.betsPerAccount + 2);
    expect(offered(engine).length).toBeGreaterThan(0);
  });
});

describe('ablation runner', () => {
  it('plans one never-overwritten folder per profile and period and parses its CLI', () => {
    const parsed = parseAblationArgs(['--profile', 'none=none', '--profile', 'all=all|hold.tolRel=0.3', '--concurrency', '2', '--prefix', 'abl-x'], 'E:/repo');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.profiles).toEqual([{ label: 'none', profile: 'none', tunes: [] }, { label: 'all', profile: 'all', tunes: ['hold.tolRel=0.3'] }]);
    expect(parsed.options.periods).toEqual(['2026-09-23T02:00:00Z', '2026-09-24T02:00:00Z']);
    const runs = planRuns(parsed.options);
    expect(runs.map(r => [r.label, r.periodIndex])).toEqual([['none', 1], ['all', 1], ['none', 2], ['all', 2]]);
    expect(runs[0]!.dir.replace(/\\/g, '/')).toBe('E:/repo/artifacts/verification/abl-x-none-p1');
    const defaults = parseAblationArgs([], 'E:/repo');
    expect(defaults.ok && defaults.options.profiles.map(p => p.label)).toEqual(['none', 'hold', 'validity', 'lead4', 'lead5', 'ramp', 'toxicity', 'controller', 'all']);
    expect(defaults.ok && defaults.options.profiles.find(p => p.label === 'lead5')!.profile).toBe('none,lead5');
    expect(parseAblationArgs(['--periods', 'soon'])).toMatchObject({ ok: false });
    expect(parseAblationArgs(['--prefix', '../x'])).toMatchObject({ ok: false });
  });

  it('renders the comparison and the target table from report.json files', () => {
    const root = tempDir('abl-');
    const runs = planRuns({ periods: ['2026-09-23T02:00:00Z'], profiles: [{ label: 'none', profile: 'none', tunes: [] }, { label: 'all', profile: 'all', tunes: [] }], outRoot: root, prefix: 'abl' });
    const strategy = (rtp: number, bets: number) => ({ rtp, bets, policyTarget: 0.95, rtpSe: 0.01 });
    const report = (pnl: string, sniper: number) => ({
      run: {}, config: {}, headline: { reconciliation: 'exact match', invariants: 'all hold' }, invariants: {}, reconciliation: {},
      pnl: { totalPnlCenti: pnl }, phases: [{ phase: 'launch', ggrCenti: '1000' }],
      strategies: { casual: strategy(0.95, 10), chaser: strategy(0.9, 10), grinder: strategy(0.955, 10), streaker: strategy(0.96, 10), whale: strategy(0.95, 10), sniper1s: strategy(sniper, 5), sniper2s: strategy(1.2, 5), splitter: strategy(1.1, 5) },
      defenses: { honest: { rtp: 0.95, policyTarget: 0.95, rejectionRate: 0.05 }, adversarial: { housePnlCenti: '-100' }, hold: { created: 10, latencyMs: { p95: 1500 } } },
    });
    for (const [i, r] of runs.entries()) { mkdirSync(r.dir, { recursive: true }); writeFileSync(join(r.dir, 'report.json'), JSON.stringify(report(i ? '500' : '-500', i ? 0.95 : 1.6))); }
    const md = renderAblation(runs, { periods: ['2026-09-23T02:00:00Z'], hours: 24, profiles: [] });
    expect(md).toMatch(/## Period 1: 2026-09-23T02:00:00Z \+ 24 h/);
    expect(md).toMatch(/\| none \| −0\.0k/);
    expect(md).toMatch(/## Targets with all defenses/);
    expect(md).toMatch(/House P&L > 0 \| 5\.00 OPEN — met/);
    expect(md).toMatch(/sniper1s RTP < 97% \| 95\.00% over 5 bets — met/);
    expect(md).toMatch(/splitter RTP < 97% \| 110\.00% over 5 bets — \*\*not met\*\*/);
    expect(md).toMatch(/chaser RTP within ±1\.5 pts of policy \| 90\.00% vs 95\.00% \(-5\.00 pts/);
  });
});
