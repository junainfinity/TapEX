import { describe, expect, it } from 'vitest';
import { createCell, parseDecimal, type MarketId } from '@maya/contracts';
import { Breakers, DEFAULT_BREAKER_CONFIG, DEFAULT_RISK_LIMITS, LIMIT_ORDER, LiabilityBook, columnKey, legExposure, limitAmounts, validateRiskLimits, type BreakerEvent, type LegExposure, type RiskLimits } from '../src/index.js';
import { rng } from './fixtures.js';

const START = 1_790_000_000_000;
const cells = Array.from({ length: 12 }, (_, i) => createCell(i < 8 ? 'btc-usd' : 'eth-usd', START + (i % 3) * 5000, parseDecimal(String(60_000 + 10 * (i % 4))), parseDecimal(String(60_010 + 10 * (i % 4))), 'maya-observed-linear-v2'));
const accounts = ['player:a', 'player:b', 'player:c', 'player:d', 'player:e'];

function randomLeg(random: () => number, id: number, maxStake = 20_000): LegExposure {
  const cell = cells[Math.floor(random() * cells.length)]!;
  return legExposure({ legId: `leg-${id}`, account: accounts[Math.floor(random() * accounts.length)]!, cell, stakeCenti: String(1 + Math.floor(random() * maxStake)), x100: 101 + Math.floor(random() * 4899) });
}
function aggregates(legs: Iterable<LegExposure>) {
  const cell = new Map<string, bigint>(), column = new Map<string, bigint>(), account = new Map<string, bigint>(); let global = 0n;
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  for (const l of legs) { add(cell, l.cellId, l.liabilityCenti); add(column, columnKey(l.marketId, l.startMs), l.liabilityCenti); add(account, l.account, l.liabilityCenti); global += l.liabilityCenti; }
  return { cell, column, account, global };
}
const maxOf = (m: Map<string, bigint>) => [...m.values()].reduce((a, b) => (b > a ? b : a), 0n);

describe('liability limits', () => {
  it('defaults are §4 fractions of equity and shrink with equity', () => {
    expect(DEFAULT_RISK_LIMITS).toEqual({ cellFraction: 0.001, columnFraction: 0.005, globalFraction: 0.02, accountFraction: 0.002 });
    expect(limitAmounts(100_000_000n, DEFAULT_RISK_LIMITS)).toEqual({ cell: 100_000n, column: 500_000n, account: 200_000n, global: 2_000_000n });
    expect(limitAmounts(999n, DEFAULT_RISK_LIMITS)).toEqual({ cell: 0n, column: 4n, account: 1n, global: 19n });
    expect(limitAmounts(0n, DEFAULT_RISK_LIMITS)).toEqual({ cell: 0n, column: 0n, account: 0n, global: 0n });
    expect(limitAmounts(-5n, DEFAULT_RISK_LIMITS)).toEqual({ cell: 0n, column: 0n, account: 0n, global: 0n });
    const random = rng(4);
    for (let i = 0; i < 5000; i++) {
      const low = BigInt(Math.floor(random() * 1e12)), high = low + BigInt(Math.floor(random() * 1e9));
      const a = limitAmounts(low, DEFAULT_RISK_LIMITS), b = limitAmounts(high, DEFAULT_RISK_LIMITS);
      for (const k of LIMIT_ORDER) expect(a[k] <= b[k]).toBe(true);
    }
  });
  it('validates limits', () => {
    expect(validateRiskLimits(DEFAULT_RISK_LIMITS)).toBeUndefined();
    expect(validateRiskLimits({ ...DEFAULT_RISK_LIMITS, cellFraction: 0 })).toMatch(/cellFraction/);
    expect(validateRiskLimits({ ...DEFAULT_RISK_LIMITS, globalFraction: 1.5 })).toMatch(/globalFraction/);
    expect(validateRiskLimits({ ...DEFAULT_RISK_LIMITS, maxStakePerBetCenti: '0' })).toMatch(/maxStakePerBet/);
    expect(validateRiskLimits({ ...DEFAULT_RISK_LIMITS, maxStakePerCellCenti: '1.5' })).toMatch(/maxStakePerCell/);
    expect(new LiabilityBook().canAccept(legExposure({ legId: 'x', account: 'a', cell: cells[0]!, stakeCenti: '1', x100: 200 }), 1_000_000n, { ...DEFAULT_RISK_LIMITS, cellFraction: -1 })).toEqual({ ok: false, reason: 'INVALID_LIMITS' });
  });
  it('reports which limit failed, checking cell → column → account → global', () => {
    const E = 10_000_000n; // cell 10,000 · column 50,000 · account 20,000 · global 200,000
    const book = new LiabilityBook();
    const leg = (id: string, cell: number, account: string, stake: string, x100: number) => legExposure({ legId: id, account, cell: cells[cell]!, stakeCenti: stake, x100 });
    expect(book.tryAccept(leg('1', 0, 'player:a', '10000', 200), E, DEFAULT_RISK_LIMITS)).toMatchObject({ ok: true });
    expect(book.canAccept(leg('2', 0, 'player:b', '1', 200), E, DEFAULT_RISK_LIMITS)).toEqual({ ok: false, reason: 'LIABILITY_LIMIT', limit: 'cell', currentCenti: 10_000n, addCenti: 1n, limitCenti: 10_000n });
    // Fill the rest of the column through other cells in the same column (cells 3, 6 share start with 0).
    expect(book.tryAccept(leg('3', 3, 'player:b', '10000', 200), E, DEFAULT_RISK_LIMITS).ok).toBe(true);
    expect(book.tryAccept(leg('5', 2, 'player:a', '5000', 200), E, DEFAULT_RISK_LIMITS).ok).toBe(true); // player:a now 15,000
    expect(book.canAccept(leg('4', 3, 'player:a', '1', 200), E, DEFAULT_RISK_LIMITS)).toMatchObject({ limit: 'cell' });
    expect(book.canAccept(leg('4', 1, 'player:a', '10001', 200), E, DEFAULT_RISK_LIMITS)).toMatchObject({ limit: 'cell' });
    expect(book.canAccept(leg('4', 1, 'player:a', '10000', 200), E, DEFAULT_RISK_LIMITS)).toMatchObject({ reason: 'LIABILITY_LIMIT', limit: 'account', currentCenti: 15_000n, limitCenti: 20_000n });
    expect(book.canAccept(leg('4', 1, 'player:a', '5000', 200), E, DEFAULT_RISK_LIMITS).ok).toBe(true);
    expect(book.canAccept(leg('4', 1, 'player:c', '10000', 200), E, DEFAULT_RISK_LIMITS).ok).toBe(true);
    // Column: journal replay can leave a column above a limit that shrank; new legs there are refused.
    const column = new LiabilityBook();
    for (const [i, c] of [0, 3, 6].entries()) for (let j = 0; j < 2; j++) column.apply(leg(`c${i}${j}`, c, `player:${i}${j}`, '5000', 300));
    expect(column.columnLiability('btc-usd', START)).toBe(60_000n);
    expect(column.canAccept(leg('z', 0, 'player:z', '1', 300), E, DEFAULT_RISK_LIMITS)).toMatchObject({ limit: 'cell', currentCenti: 20_000n });
    expect(column.canAccept(leg('z', 0, 'player:z', '1', 300), E, { ...DEFAULT_RISK_LIMITS, cellFraction: 1 })).toMatchObject({ limit: 'column', currentCenti: 60_000n, addCenti: 2n, limitCenti: 50_000n });
    expect(column.canAccept(leg('z', 9, 'player:z', '1', 300), E, DEFAULT_RISK_LIMITS).ok).toBe(true); // same start, other market
    // Global: raise every per-bucket limit so only the global one can bind.
    const wide: RiskLimits = { cellFraction: 1, columnFraction: 1, accountFraction: 1, globalFraction: 0.02 };
    expect(column.canAccept(leg('g', 1, 'player:g', '140001', 200), E, wide)).toMatchObject({ limit: 'global', currentCenti: 60_000n, addCenti: 140_001n, limitCenti: 200_000n });
    expect(column.canAccept(leg('g', 1, 'player:g', '140000', 200), E, wide).ok).toBe(true);
  });
  it('when several limits fail at once, the narrowest bucket is reported first', () => {
    const book = new LiabilityBook(); const E = 10_000_000n;
    const huge = legExposure({ legId: 'h', account: 'player:h', cell: cells[0]!, stakeCenti: '1000000', x100: 200 }); // breaches all four
    expect(book.canAccept(huge, E, DEFAULT_RISK_LIMITS)).toMatchObject({ limit: 'cell' });
    expect(book.canAccept(huge, E, { ...DEFAULT_RISK_LIMITS, cellFraction: 1 })).toMatchObject({ limit: 'column' });
    expect(book.canAccept(huge, E, { ...DEFAULT_RISK_LIMITS, cellFraction: 1, columnFraction: 1 })).toMatchObject({ limit: 'account' });
    expect(book.canAccept(huge, E, { cellFraction: 1, columnFraction: 1, accountFraction: 1, globalFraction: 0.02 })).toMatchObject({ limit: 'global' });
    expect(LIMIT_ORDER).toEqual(['cell', 'column', 'account', 'global']);
  });
  it('enforces stake caps before liability limits', () => {
    const book = new LiabilityBook(); const limits = { ...DEFAULT_RISK_LIMITS, maxStakePerBetCenti: '1000', maxStakePerCellCenti: '1500' };
    const leg = (id: string, stake: string) => legExposure({ legId: id, account: 'player:a', cell: cells[0]!, stakeCenti: stake, x100: 150 });
    expect(book.canAccept(leg('1', '1001'), 10n ** 12n, limits)).toMatchObject({ ok: false, reason: 'STAKE_NOT_ALLOWED', limitCenti: 1000n });
    expect(book.tryAccept(leg('1', '1000'), 10n ** 12n, limits).ok).toBe(true);
    expect(book.canAccept(leg('2', '501'), 10n ** 12n, limits)).toMatchObject({ ok: false, reason: 'CELL_CAP_EXCEEDED', currentCenti: 1000n, limitCenti: 1500n });
    expect(book.canAccept(leg('2', '500'), 10n ** 12n, limits).ok).toBe(true);
  });
  it('is idempotent by leg id and releases exactly', () => {
    const book = new LiabilityBook(); const leg = legExposure({ legId: 'L1', account: 'player:a', cell: cells[2]!, stakeCenti: '500', x100: 250 });
    expect(leg.liabilityCenti).toBe(750n);
    expect(book.apply(leg)).toEqual({ ok: true });
    expect(book.apply(leg)).toEqual({ ok: false, reason: 'DUPLICATE_LEG' });
    expect(book.canAccept(leg, 10n ** 12n, DEFAULT_RISK_LIMITS)).toEqual({ ok: false, reason: 'DUPLICATE_LEG' });
    expect(book.snapshot()).toEqual({ globalCenti: '750', legs: 1, cells: { [cells[2]!.cellId]: '750' }, columns: { [columnKey('btc-usd', cells[2]!.startMs)]: '750' }, accounts: { 'player:a': '750' } });
    expect(book.cellStake(cells[2]!.cellId)).toBe(500n);
    expect(book.legCount(cells[2]!.cellId)).toBe(1);
    expect(book.release('L1')).toEqual({ ok: true, leg });
    expect(book.release('L1')).toEqual({ ok: false, reason: 'UNKNOWN_LEG' });
    expect(book.snapshot()).toEqual({ globalCenti: '0', legs: 0, cells: {}, columns: {}, accounts: {} });
    expect(Object.isFrozen(book.snapshot()) && Object.isFrozen(book.snapshot().cells)).toBe(true);
    expect(book.apply({ ...leg, legId: 'bad', liabilityCenti: -1n })).toEqual({ ok: false, reason: 'INVALID_LEG' });
    expect(book.apply({ ...leg, legId: 'bad', stakeCenti: 0n })).toEqual({ ok: false, reason: 'INVALID_LEG' });
    expect(book.canAccept({ ...leg, legId: '' }, 1n, DEFAULT_RISK_LIMITS)).toEqual({ ok: false, reason: 'INVALID_LEG' });
  });

  it('property: at constant equity no acceptance sequence ever exceeds any limit, and rejections change nothing', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const random = rng(seed); const book = new LiabilityBook(); const open = new Map<string, LegExposure>();
      const E = BigInt(1_000_000 + Math.floor(random() * 50_000_000)); const limits = limitAmounts(E, DEFAULT_RISK_LIMITS);
      let accepted = 0, rejected = 0;
      for (let i = 0; i < 3000; i++) {
        if (random() < 0.15 && open.size) { const id = [...open.keys()][Math.floor(random() * open.size)]!; expect(book.release(id).ok).toBe(true); open.delete(id); continue; }
        const leg = randomLeg(random, i, Number(E / 2000n) + 1); const before = JSON.stringify(book.snapshot());
        const result = book.tryAccept(leg, E, DEFAULT_RISK_LIMITS);
        if (result.ok) { open.set(leg.legId, leg); accepted++; }
        else {
          rejected++; expect(JSON.stringify(book.snapshot())).toBe(before);
          if (result.reason === 'LIABILITY_LIMIT') {
            expect(result.currentCenti + result.addCenti > result.limitCenti).toBe(true);
            // Every limit earlier in the order would have held.
            const agg = aggregates(open.values()); const key = { cell: leg.cellId, column: columnKey(leg.marketId, leg.startMs), account: leg.account };
            for (const kind of LIMIT_ORDER.slice(0, LIMIT_ORDER.indexOf(result.limit))) {
              const cur = kind === 'global' ? agg.global : agg[kind].get(key[kind]) ?? 0n;
              expect(cur + leg.liabilityCenti <= limits[kind]).toBe(true);
            }
          }
        }
        const agg = aggregates(open.values());
        expect(maxOf(agg.cell) <= limits.cell && maxOf(agg.column) <= limits.column && maxOf(agg.account) <= limits.account && agg.global <= limits.global).toBe(true);
        expect(book.globalLiability()).toBe(agg.global);
        // Solvency: open liability never exceeds equity.
        expect(agg.global <= E).toBe(true);
      }
      expect(accepted).toBeGreaterThan(100); expect(rejected).toBeGreaterThan(100);
    }
  });

  it('property: as equity falls every acceptance still lands within the limits at that equity, and acceptance is monotone in equity', () => {
    for (const seed of [7, 8, 9]) {
      const random = rng(seed); const book = new LiabilityBook(); const open = new Map<string, LegExposure>();
      let E = 80_000_000n;
      for (let i = 0; i < 3000; i++) {
        if (random() < 0.3) E = E - E / BigInt(20 + Math.floor(random() * 200)) - BigInt(Math.floor(random() * 1000));
        if (random() < 0.1 && open.size) { const id = [...open.keys()][0]!; book.release(id); open.delete(id); }
        const leg = randomLeg(random, i, 30_000);
        const higher = E + BigInt(Math.floor(random() * 10_000_000));
        const atE = book.canAccept(leg, E, DEFAULT_RISK_LIMITS), atHigher = book.canAccept(leg, higher, DEFAULT_RISK_LIMITS);
        if (atE.ok) expect(atHigher.ok).toBe(true);
        if (book.tryAccept(leg, E, DEFAULT_RISK_LIMITS).ok) {
          open.set(leg.legId, leg);
          const limits = limitAmounts(E, DEFAULT_RISK_LIMITS); const agg = aggregates(open.values());
          expect((agg.cell.get(leg.cellId) ?? 0n) <= limits.cell).toBe(true);
          expect((agg.column.get(columnKey(leg.marketId, leg.startMs)) ?? 0n) <= limits.column).toBe(true);
          expect((agg.account.get(leg.account) ?? 0n) <= limits.account).toBe(true);
          expect(agg.global <= limits.global).toBe(true);
        }
      }
      expect(E < 80_000_000n / 10n).toBe(true);
      // Once equity is gone nothing with liability is accepted.
      expect(book.canAccept(randomLeg(random, 99_999), 0n, DEFAULT_RISK_LIMITS).ok).toBe(false);
    }
  });

  it('reports usage against each limit', () => {
    const book = new LiabilityBook();
    book.apply(legExposure({ legId: 'u', account: 'player:a', cell: cells[0]!, stakeCenti: '1000', x100: 600 }));
    expect(book.usage(10_000_000n, DEFAULT_RISK_LIMITS)).toEqual({ global: 5000 / 200_000, maxColumn: 5000 / 50_000, maxCell: 5000 / 10_000, maxAccount: 5000 / 20_000 });
    expect(book.usage(0n, DEFAULT_RISK_LIMITS).global).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('breakers', () => {
  const markets: MarketId[] = ['btc-usd', 'eth-usd'];
  const admin = (atMs: number, reason = 'ops') => ({ actor: 'admin:bob', atMs, reason });
  const ready = (b: Breakers, now = 0) => { b.observeEquity(1_000_000n, now); for (const m of markets) b.observeFeed(m, now, now); };

  it('starts fail-closed until equity and a first fresh price are observed', () => {
    const b = new Breakers(markets);
    expect(b.quoting('btc-usd')).toEqual({ allowed: false, reason: 'equity-floor', breaker: 'equityFloor' });
    expect(b.observeEquity(1_000_000n, 0)).toMatchObject([{ id: 'equityFloor', from: 'tripped', to: 'ok', actor: 'system' }]);
    expect(b.quoting('btc-usd')).toEqual({ allowed: false, reason: 'stale-source', breaker: 'feedStale' });
    expect(b.observeFeed('btc-usd', 0, 100)).toMatchObject([{ id: 'feedStale', market: 'btc-usd', from: 'tripped', to: 'ok' }]);
    expect(b.quoting('btc-usd')).toEqual({ allowed: true, drawdownWidened: false });
    expect(b.quoting('eth-usd').allowed).toBe(false);
  });
  it('feedStale trips after more than 7 s without a fresh price and recovers automatically', () => {
    const b = new Breakers(markets); ready(b);
    expect(b.observeFeed('btc-usd', 0, 7000)).toEqual([]);
    const [trip] = b.observeFeed('btc-usd', 0, 7001);
    expect(trip).toEqual({ type: 'breaker-transition', id: 'feedStale', market: 'btc-usd', from: 'ok', to: 'tripped', atMs: 7001, reason: 'no fresh price for 7001 ms', actor: 'system' });
    expect(Object.isFrozen(trip)).toBe(true);
    expect(b.observeFeed('btc-usd', 0, 9000)).toEqual([]);
    expect(b.quoting('btc-usd')).toMatchObject({ allowed: false, reason: 'stale-source' });
    expect(b.quoting('eth-usd').allowed).toBe(true);
    expect(b.observeFeed('btc-usd', 9000, 9100)).toMatchObject([{ from: 'tripped', to: 'ok' }]);
    expect(b.observeFeed('btc-usd', undefined, 9200)).toMatchObject([{ to: 'tripped', reason: 'no price' }]);
    expect(b.observeFeed('sol-usd' as MarketId, 0, 0)).toEqual([]);
  });
  it('drawdown: > 2% in 1 h widens, > 5% pauses all; neither recovers without an admin', () => {
    const b = new Breakers(markets); ready(b);
    expect(b.observeEquity(980_000n, 60_000)).toEqual([]); // exactly 2% is not above 2%
    const [widen] = b.observeEquity(979_999n, 120_000);
    expect(widen).toMatchObject({ id: 'drawdown', from: 'ok', to: 'widened', atMs: 120_000, actor: 'system' });
    expect(b.quoting('btc-usd')).toEqual({ allowed: true, drawdownWidened: true });
    expect(b.observeEquity(1_000_000n, 180_000)).toEqual([]);
    expect(b.quoting('eth-usd')).toEqual({ allowed: true, drawdownWidened: true });
    expect(b.observeEquity(950_000n, 240_000)).toEqual([]); // exactly 5%
    expect(b.observeEquity(949_999n, 300_000)).toMatchObject([{ id: 'drawdown', from: 'widened', to: 'paused' }]);
    expect(b.quoting('btc-usd')).toEqual({ allowed: false, reason: 'market-paused', breaker: 'drawdown' });
    expect(b.observeEquity(2_000_000n, 360_000)).toEqual([]);
    expect(b.quoting('eth-usd').allowed).toBe(false);
    expect(b.resumeDrawdown({ actor: 'admin:bob', atMs: 400_000, reason: '' })).toEqual({ ok: false, reason: 'invalid-meta' });
    const resumed = b.resumeDrawdown(admin(400_000, 'reviewed losses'));
    expect(resumed).toEqual({ ok: true, events: [{ type: 'breaker-transition', id: 'drawdown', from: 'paused', to: 'ok', atMs: 400_000, reason: 'reviewed losses', actor: 'admin:bob' }] });
    expect(b.quoting('btc-usd')).toEqual({ allowed: true, drawdownWidened: false });
    expect(b.resumeDrawdown(admin(400_001))).toEqual({ ok: false, reason: 'not-paused' });
    // The window restarted at current equity: a 1% dip from there does nothing.
    expect(b.observeEquity(1_980_000n, 410_000)).toEqual([]);
  });
  it('a single large drop goes straight from ok to paused', () => {
    const b = new Breakers(markets); ready(b);
    expect(b.observeEquity(900_000n, 1000)).toMatchObject([{ id: 'drawdown', from: 'ok', to: 'paused' }]);
  });
  it('measures the drop from the peak within the trailing hour only', () => {
    const run = (lastAt: number) => { const b = new Breakers(markets); ready(b); b.observeEquity(990_000n, 1_800_000); return b.observeEquity(945_000n, lastAt); };
    expect(run(3_600_000 - 1)).toMatchObject([{ to: 'paused' }]); // peak 1,000,000 still inside → 5.5%
    expect(run(3_600_000)).toMatchObject([{ to: 'widened' }]); // peak evicted → 45,000 / 990,000 ≈ 4.5%
  });
  it('treasury flows shift the baseline so funding and surplus withdrawal are not read as P&L', () => {
    const b = new Breakers(markets); ready(b);
    b.recordTreasuryFlow(-500_000n);
    expect(b.observeEquity(500_000n, 1000)).toEqual([]);
    expect(b.drawdown()).toBe(0);
    b.recordTreasuryFlow(1_500_000n);
    expect(b.observeEquity(2_000_000n, 2000)).toEqual([]);
    expect(b.observeEquity(1_950_000n, 3000)).toMatchObject([{ to: 'widened' }]);
    expect(b.drawdown()).toBeCloseTo(0.025, 12);
  });
  it('equity floor quotes nothing below the floor and recovers automatically', () => {
    const b = new Breakers(markets, { ...DEFAULT_BREAKER_CONFIG, equityFloorCenti: '100000' }); ready(b);
    expect(b.observeEquity(99_999n, 1000).map((e) => [e.id, e.to])).toEqual([['equityFloor', 'tripped'], ['drawdown', 'paused']]);
    expect(b.quoting('btc-usd')).toEqual({ allowed: false, reason: 'equity-floor', breaker: 'equityFloor' });
    expect(b.observeEquity(100_000n, 2000)).toMatchObject([{ id: 'equityFloor', to: 'ok' }]);
    expect(b.quoting('btc-usd')).toMatchObject({ allowed: false, breaker: 'drawdown' });
  });
  it('manual pauses per market and globally are admin-only and journaled', () => {
    const b = new Breakers(markets); ready(b);
    const events: BreakerEvent[] = [];
    const take = (r: ReturnType<Breakers['pauseMarket']>) => { expect(r.ok).toBe(true); if (r.ok) events.push(...r.events); };
    take(b.pauseMarket('btc-usd', admin(10, 'suspicious flow')));
    expect(b.quoting('btc-usd')).toEqual({ allowed: false, reason: 'market-paused', breaker: 'manual' });
    expect(b.quoting('eth-usd').allowed).toBe(true);
    expect(b.pauseMarket('btc-usd', admin(11))).toEqual({ ok: false, reason: 'already-paused' });
    expect(b.pauseMarket('sol-usd' as MarketId, admin(11))).toEqual({ ok: false, reason: 'unknown-market' });
    expect(b.pauseMarket('eth-usd', { actor: '', atMs: 11, reason: 'x' })).toEqual({ ok: false, reason: 'invalid-meta' });
    take(b.pauseAll(admin(20, 'incident')));
    expect(b.quoting('eth-usd')).toMatchObject({ allowed: false, reason: 'market-paused' });
    take(b.resumeAll(admin(30, 'resolved')));
    expect(b.quoting('eth-usd').allowed).toBe(true);
    expect(b.quoting('btc-usd').allowed).toBe(false);
    take(b.resumeMarket('btc-usd', admin(40, 'cleared')));
    expect(b.resumeMarket('btc-usd', admin(41))).toEqual({ ok: false, reason: 'not-paused' });
    expect(b.resumeAll(admin(42))).toEqual({ ok: false, reason: 'not-paused' });
    expect(events.map((e) => [e.id, e.market ?? 'all', e.from, e.to, e.actor, e.atMs, e.reason])).toEqual([
      ['manual', 'btc-usd', 'ok', 'paused', 'admin:bob', 10, 'suspicious flow'],
      ['manual', 'all', 'ok', 'paused', 'admin:bob', 20, 'incident'],
      ['manual', 'all', 'paused', 'ok', 'admin:bob', 30, 'resolved'],
      ['manual', 'btc-usd', 'paused', 'ok', 'admin:bob', 40, 'cleared'],
    ]);
  });
  it('resume-all also clears a drawdown pause', () => {
    const b = new Breakers(markets); ready(b); b.observeEquity(900_000n, 10);
    const r = b.resumeAll(admin(20));
    expect(r.ok && r.events.map((e) => [e.id, e.to])).toEqual([['drawdown', 'ok']]);
    expect(b.quoting('btc-usd').allowed).toBe(true);
  });
  it('status lists every breaker for the admin overview', () => {
    const b = new Breakers(markets, DEFAULT_BREAKER_CONFIG, 5); ready(b, 10);
    b.pauseMarket('eth-usd', admin(20, 'maintenance'));
    expect(b.status()).toEqual([
      { id: 'feedStale', market: 'btc-usd', state: 'ok', since: 10, reason: 'fresh price' },
      { id: 'feedStale', market: 'eth-usd', state: 'ok', since: 10, reason: 'fresh price' },
      { id: 'drawdown', state: 'ok', since: 5, reason: '' },
      { id: 'equityFloor', state: 'ok', since: 10, reason: 'equity at or above floor' },
      { id: 'manual', state: 'ok', since: 5, reason: '' },
      { id: 'manual', market: 'btc-usd', state: 'ok', since: 5, reason: '' },
      { id: 'manual', market: 'eth-usd', state: 'paused', since: 20, reason: 'maintenance' },
    ]);
    expect(Object.isFrozen(b.status())).toBe(true);
  });
  it('ignores out-of-order equity observations and rejects invalid config', () => {
    const b = new Breakers(markets); ready(b, 1000);
    expect(b.observeEquity(1n, 500)).toEqual([]);
    expect(b.quoting('btc-usd').allowed).toBe(true);
    expect(() => new Breakers(markets, { ...DEFAULT_BREAKER_CONFIG, drawdownPauseFraction: 0.01 })).toThrow(RangeError);
    expect(() => new Breakers(markets, { ...DEFAULT_BREAKER_CONFIG, feedStaleMs: 0 })).toThrow(RangeError);
  });
});
