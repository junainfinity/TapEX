import { describe, expect, it } from 'vitest';
import { OBSERVED_PATH_RULE_VERSION, cellId, createCell, decimalToNumber, parseDecimal } from '@maya/contracts';
import {
  Breakers, DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_RISK_LIMITS, LiabilityBook, buildQuoteGrid, h10Sigma, legExposure, limitAmounts, lookup,
  maxStakeForLiability, offerX100, priceImpact, type OfferedGridCell, type QuoteGrid, type QuoteGridInput,
} from '../src/index.js';
import { randomWalk, table } from './fixtures.js';

const T0 = 1_790_000_000;
const path = randomWalk({ t0: T0, seconds: 1200, start: 60_000, sigma: 3e-5, tick: 0.01, seed: 42 });
const T = T0 + 1199; // tau0 = 6
const E = 100_000_000n; // 1,000,000 OPEN → cell limit 100,000 Centi
const spotAt = (t: number) => parseDecimal(String(path.get(t)!));
function input(overrides: Partial<QuoteGridInput> = {}): QuoteGridInput {
  return { market: 'btc-usd', t: T, spot: overrides.spot ?? spotAt(overrides.t ?? T), path, table: table('btc-usd'), pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE, registeredPlayers: 0, limits: DEFAULT_RISK_LIMITS, book: new LiabilityBook(), equityCenti: E, ...overrides };
}
const offered = (grid: QuoteGrid): OfferedGridCell[] => grid.cells.filter((c): c is OfferedGridCell => c.available);

/** Independent recomputation of every cell from the inputs. */
function expectConsistent(grid: QuoteGrid, i: QuoteGridInput): void {
  expect(grid.cells).toHaveLength(42);
  const amounts = limitAmounts(i.equityCenti, i.limits);
  for (const c of grid.cells) {
    if (grid.reason) { expect(c).toMatchObject({ available: false, reason: grid.reason }); continue; }
    const fair = lookup(i.table, { s: grid.s!, frac: grid.frac!, tau: c.tau, b: c.bandOffset });
    if (!fair) { expect(c).toMatchObject({ available: false, reason: 'out-of-domain' }); expect(c.p).toBeUndefined(); continue; }
    const cellL = i.book.cellLiability(c.cell.cellId);
    const impact = priceImpact(i.pricing.impactK, cellL, i.limits.cellFraction, i.equityCenti);
    const offer = offerX100(fair.p, fair.se, { ...i.pricing, edge: grid.edge.edge }, impact);
    expect(c).toMatchObject({ key: fair.key, p: fair.p, se: fair.se, impact, liabilityCenti: cellL.toString(), limitCenti: amounts.cell.toString() });
    if (!offer.ok) { expect(c).toMatchObject({ available: false, reason: offer.reason }); continue; }
    const headroom = [amounts.cell - cellL, amounts.column - i.book.columnLiability(i.market, c.cell.startMs), amounts.global - i.book.globalLiability()].reduce((a, b) => (b < a ? b : a));
    let max = maxStakeForLiability(headroom, offer.x100);
    if (i.limits.maxStakePerBetCenti && BigInt(i.limits.maxStakePerBetCenti) < max) max = BigInt(i.limits.maxStakePerBetCenti);
    if (i.limits.maxStakePerCellCenti && BigInt(i.limits.maxStakePerCellCenti) - i.book.cellStake(c.cell.cellId) < max) max = BigInt(i.limits.maxStakePerCellCenti) - i.book.cellStake(c.cell.cellId);
    if (max < 1n) expect(c).toMatchObject({ available: false, reason: 'liability-limit' });
    else expect(c).toMatchObject({ available: true, x100: offer.x100, capped: offer.capped, maxStakeCenti: max.toString() });
  }
}

describe('quote grid', () => {
  it('builds 42 immutable cells with exact terms on the §3 window/band grid', () => {
    const i = input(); const grid = buildQuoteGrid(i);
    expect(grid.reason).toBeUndefined();
    expect(grid).toMatchObject({ market: 'btc-usd', t: T, tableId: table('btc-usd').id, start0: T + 6, sigmaSource: 'h10', equityCenti: E.toString() });
    expect(grid.sigma).toBe(h10Sigma(path, T));
    const spot = path.get(T)!; const bucket = Math.floor(spot / 10);
    expect(grid.bucket).toBe(String(bucket));
    expect(grid.s).toBe((grid.sigma! * spot) / 10);
    expect(grid.frac).toBe(spot / 10 - bucket);
    grid.cells.forEach((c, index) => {
      const w = Math.floor(index / 7), b = (index % 7) - 3;
      expect(c).toMatchObject({ index, window: w, bandOffset: b, tau: 6 + 5 * w, legs: 0 });
      expect(c.cell.startMs).toBe((T + 6 + 5 * w) * 1000);
      expect(c.cell.endMs).toBe(c.cell.startMs + 5000);
      expect(decimalToNumber(c.cell.lowerPrice)).toBe((bucket + b) * 10);
      expect(decimalToNumber(c.cell.upperPrice)).toBe((bucket + b + 1) * 10);
      expect(c.cell.ruleVersion).toBe(OBSERVED_PATH_RULE_VERSION);
      expect(c.cell.cellId).toBe(cellId(c.cell));
      expect(c.cell).toEqual(createCell('btc-usd', c.cell.startMs, c.cell.lowerPrice, c.cell.upperPrice, OBSERVED_PATH_RULE_VERSION));
      expect(Object.isFrozen(c) && Object.isFrozen(c.cell)).toBe(true);
    });
    expect(Object.isFrozen(grid) && Object.isFrozen(grid.cells) && Object.isFrozen(grid.spot) && Object.isFrozen(grid.edge)).toBe(true);
    expect(offered(grid).length).toBeGreaterThanOrEqual(25);
    expect(grid.edge).toEqual({ edge: 0.03, phase: 'launch', base: 0.03, flow: 0, widen: 0 });
    expectConsistent(grid, i);
    expect(buildQuoteGrid(input())).toEqual(grid);
  });

  it('refuses the tau-3 window the published table never observed', () => {
    const t = T0 + 1197; const i = input({ t }); const grid = buildQuoteGrid(i);
    expect(grid.start0 - t).toBe(3);
    for (const c of grid.cells.slice(0, 7)) expect(c).toMatchObject({ tau: 3, available: false, reason: 'out-of-domain' });
    expect(grid.cells.slice(7).some((c) => c.available)).toBe(true);
    expectConsistent(grid, i);
  });

  it('launch boost: 3% edge below 10,000 players, 8% from exactly 10,000', () => {
    const launch = buildQuoteGrid(input({ registeredPlayers: 9_999 })), standard = buildQuoteGrid(input({ registeredPlayers: 10_000 }));
    expect(launch.edge.edge).toBe(0.03); expect(standard.edge).toMatchObject({ edge: 0.08, phase: 'standard' });
    let lower = 0;
    for (const [k, c] of standard.cells.entries()) {
      const l = launch.cells[k]!;
      if (c.available && l.available) { expect(c.x100).toBeLessThanOrEqual(l.x100); if (c.x100 < l.x100) lower++; }
      if (c.available && !l.available) expect(l.reason).toBe('hidden-above-cap');
    }
    expect(lower).toBeGreaterThan(20);
    expectConsistent(standard, input({ registeredPlayers: 10_000 }));
  });

  it('adds the flow surcharge for flagged accounts and the drawdown widening from the breaker gate', () => {
    const schedule = { ...DEFAULT_EDGE_SCHEDULE, flowEdge: 0.05 };
    expect(buildQuoteGrid(input({ schedule, flagged: true, registeredPlayers: 20_000 })).edge).toMatchObject({ edge: 0.08 + 0.05, flow: 0.05 });
    expect(buildQuoteGrid(input({ schedule, registeredPlayers: 20_000 })).edge.edge).toBe(0.08);
    const breakers = new Breakers(['btc-usd', 'eth-usd']);
    breakers.observeEquity(E, 0); breakers.observeFeed('btc-usd', T * 1000, T * 1000);
    breakers.observeEquity(E - E / 40n, 1000); // 2.5% drop → widened
    const i = input({ gate: breakers.quoting('btc-usd') }); const grid = buildQuoteGrid(i);
    expect(grid.edge).toMatchObject({ edge: 0.03 + 0.02, widen: 0.02 });
    expectConsistent(grid, i);
  });

  it('fails closed on breakers, equity, staleness, history and model mismatch', () => {
    const reasons: [Partial<QuoteGridInput>, string][] = [
      [{ equityCenti: 0n }, 'equity-floor'],
      [{ equityCenti: -5n }, 'equity-floor'],
      [{ gate: { allowed: false, reason: 'market-paused', breaker: 'manual' } }, 'market-paused'],
      [{ gate: { allowed: false, reason: 'stale-source', breaker: 'feedStale' } }, 'stale-source'],
      [{ gate: { allowed: false, reason: 'equity-floor', breaker: 'equityFloor' } }, 'equity-floor'],
      [{ nowMs: T * 1000 + 7001 }, 'stale-source'],
      [{ path: new Map([[T, path.get(T)!]]) }, 'insufficient-history'],
      [{ path: new Map(Array.from({ length: 700 }, (_, k) => [T - k, 60_000] as const)), spot: parseDecimal('60000') }, 'invalid-volatility'],
      [{ table: table('eth-usd') }, 'model-incompatible'],
      [{ table: table('eth-usd'), gate: { allowed: false, reason: 'market-paused', breaker: 'manual' } }, 'model-incompatible'],
      [{ pricing: { ...DEFAULT_PRICING_CONFIG, capX100: 50 } }, 'model-incompatible'],
      [{ limits: { ...DEFAULT_RISK_LIMITS, cellFraction: 0 } }, 'model-incompatible'],
      [{ equityCenti: 0n, gate: { allowed: false, reason: 'stale-source', breaker: 'feedStale' } }, 'equity-floor'],
    ];
    for (const [overrides, reason] of reasons) {
      const i = input(overrides); const grid = buildQuoteGrid(i);
      expect(grid.reason, JSON.stringify(Object.keys(overrides))).toBe(reason);
      expect(grid.cells).toHaveLength(42);
      for (const c of grid.cells) expect(c).toMatchObject({ available: false, reason });
    }
    expect(buildQuoteGrid(input({ nowMs: T * 1000 + 7000 })).reason).toBeUndefined();
    for (const spot of ['0', '-1']) expect(buildQuoteGrid(input({ spot: parseDecimal(spot) }))).toMatchObject({ reason: 'model-incompatible', cells: [] });
    expect(buildQuoteGrid(input({ t: 1.5, spot: spotAt(T) }))).toMatchObject({ reason: 'model-incompatible', cells: [] });
  });

  it('crowded cells pay less next time and stop at the cell limit', () => {
    const empty = buildQuoteGrid(input());
    const best = offered(empty).reduce((a, b) => (b.x100 > a.x100 ? b : a));
    expect(best.x100).toBeGreaterThanOrEqual(300);
    const limit = limitAmounts(E, DEFAULT_RISK_LIMITS).cell;
    const book = new LiabilityBook();
    book.apply(legExposure({ legId: 'half', account: 'player:a', cell: best.cell, stakeCenti: (limit / 2n).toString(), x100: 200 }));
    const i = input({ book }); const half = buildQuoteGrid(i);
    const crowded = half.cells[best.index]!;
    expect(crowded.impact).toBeCloseTo(DEFAULT_PRICING_CONFIG.impactK / 2, 12);
    expect(crowded.available).toBe(true);
    if (!crowded.available) return;
    expect(crowded.x100).toBeLessThan(best.x100);
    expect(crowded).toMatchObject({ liabilityCenti: (limit / 2n).toString(), limitCenti: limit.toString(), legs: 1 });
    // The advertised max stake is exactly what the book will accept for a fresh account.
    const at = (stake: bigint) => legExposure({ legId: `s${stake}`, account: 'player:new', cell: crowded.cell, stakeCenti: stake.toString(), x100: crowded.x100 });
    expect(book.canAccept(at(BigInt(crowded.maxStakeCenti)), E, DEFAULT_RISK_LIMITS).ok).toBe(true);
    expect(book.canAccept(at(BigInt(crowded.maxStakeCenti) + 1n), E, DEFAULT_RISK_LIMITS)).toMatchObject({ ok: false, limit: 'cell' });
    expectConsistent(half, i);
    // Other cells are untouched.
    for (const c of half.cells) if (c.index !== best.index) expect(c).toEqual(empty.cells[c.index]);
    book.apply(legExposure({ legId: 'rest', account: 'player:b', cell: best.cell, stakeCenti: (limit - limit / 2n).toString(), x100: 200 }));
    const full = buildQuoteGrid(input({ book }));
    expect(full.cells[best.index]).toMatchObject({ available: false, reason: 'liability-limit', liabilityCenti: limit.toString(), legs: 2 });
    expectConsistent(full, input({ book }));
  });

  it('column and global limits close every cell they cover', () => {
    const grid = buildQuoteGrid(input()); const limits = limitAmounts(E, DEFAULT_RISK_LIMITS);
    const column = grid.cells[14]!.cell; // window 2
    const far = (startMs: number) => createCell('btc-usd', startMs, parseDecimal('1000'), parseDecimal('1010'), OBSERVED_PATH_RULE_VERSION);
    const columnBook = new LiabilityBook();
    columnBook.apply(legExposure({ legId: 'col', account: 'player:c', cell: far(column.startMs), stakeCenti: (limits.column + 1n).toString(), x100: 200 }));
    const byColumn = buildQuoteGrid(input({ book: columnBook }));
    for (const c of byColumn.cells) {
      if (c.window === 2) expect(c.available ? 'offered' : c.reason).not.toBe('offered');
      if (c.window === 2 && grid.cells[c.index]!.available) expect(c).toMatchObject({ reason: 'liability-limit' });
      if (c.window !== 2) expect(c).toEqual(grid.cells[c.index]);
    }
    const globalBook = new LiabilityBook();
    globalBook.apply(legExposure({ legId: 'glob', account: 'player:g', cell: far(column.startMs + 3_600_000), stakeCenti: (limits.global + 1n).toString(), x100: 200 }));
    const byGlobal = buildQuoteGrid(input({ book: globalBook }));
    expect(offered(byGlobal)).toHaveLength(0);
    for (const c of byGlobal.cells) if (grid.cells[c.index]!.available) expect(c).toMatchObject({ reason: 'liability-limit' });
    expectConsistent(byColumn, input({ book: columnBook }));
    expectConsistent(byGlobal, input({ book: globalBook }));
  });

  it('stake caps bound the advertised max stake', () => {
    const limits = { ...DEFAULT_RISK_LIMITS, maxStakePerBetCenti: '700', maxStakePerCellCenti: '1000' };
    const book = new LiabilityBook(); const base = buildQuoteGrid(input());
    const target = offered(base)[0]!;
    book.apply(legExposure({ legId: 'x', account: 'player:x', cell: target.cell, stakeCenti: '400', x100: target.x100 }));
    const i = input({ limits, book }); const grid = buildQuoteGrid(i);
    for (const c of offered(grid)) expect(BigInt(c.maxStakeCenti) <= 700n).toBe(true);
    expect(grid.cells[target.index]).toMatchObject({ available: true, maxStakeCenti: '600' });
    expectConsistent(grid, i);
  });

  it('cap policy hides or caps long shots; the minimum closes near-certain cells', () => {
    const hide = input({ pricing: { ...DEFAULT_PRICING_CONFIG, capX100: 250 } });
    const hidden = buildQuoteGrid(hide);
    expect(hidden.cells.filter((c) => !c.available && c.reason === 'hidden-above-cap').length).toBeGreaterThan(5);
    expectConsistent(hidden, hide);
    const cap = input({ pricing: { ...DEFAULT_PRICING_CONFIG, capX100: 250, aboveCap: 'cap' } });
    const capped = buildQuoteGrid(cap);
    const cappedCells = offered(capped).filter((c) => c.capped);
    expect(cappedCells.length).toBeGreaterThan(5);
    for (const c of cappedCells) expect(c.x100).toBe(250);
    expectConsistent(capped, cap);
    const strict = input({ pricing: { ...DEFAULT_PRICING_CONFIG, z: 60 } });
    const closed = buildQuoteGrid(strict);
    expect(closed.cells.filter((c) => !c.available && c.reason === 'below-minimum').length).toBeGreaterThan(10);
    expectConsistent(closed, strict);
  });
});
