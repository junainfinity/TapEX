import { describe, expect, it } from 'vitest';
import { indexAtOrBefore, thin } from './app.js';
import { decodeOverview } from './decode.js';
import { buildHeatModel, cellKey, heatBin, shareLabel } from './charts/heatmap.js';
import { sparklinePath } from './charts/sparkline.js';
import { breakerNeedsAdminResume, breakerSeverity, feedHealth, isBreakerActive, launchProgress, worst } from './health.js';
import { cumulativePnl, vaultIdentity } from './ledger-math.js';
import { driftLevel, driftZ, rangeMidMultiplier, rtpBand } from './rtp-stats.js';
import { MAX_BETS, Store } from './store.js';
import { chainFixture, launchFixture, marketFixture, overviewFixture } from './test-fixtures.js';
import type { BetLeg, Exposure } from './types.js';

const leg = (over: Partial<BetLeg>): BetLeg => ({ legId: 'L1', account: 'sim:1', market: 'BTC/USD', start: 1000, bandIndex: 1, stakeCenti: '1000', x100: 250, payoutCenti: '2500', status: 'open', placedMs: 900, ...over });

describe('health classification', () => {
  it('treats only non-ok breaker states as active and grades severity', () => {
    expect(isBreakerActive({ id: 'feedStale', state: 'ok', since: 0, reason: '' })).toBe(false);
    expect(isBreakerActive({ id: 'feedStale', state: 'Cleared', since: 0, reason: '' })).toBe(false);
    expect(isBreakerActive({ id: 'feedStale', state: 'tripped', since: 0, reason: '' })).toBe(true);
    expect(breakerSeverity({ id: 'equityFloor', state: 'tripped', since: 0, reason: '' })).toBe('critical');
    expect(breakerSeverity({ id: 'manual', state: 'paused', since: 0, reason: '' })).toBe('critical');
    expect(breakerSeverity({ id: 'manual', market: 'BTC/USD', state: 'paused', since: 0, reason: '' })).toBe('warning');
    expect(breakerSeverity({ id: 'drawdown', state: 'widened', since: 0, reason: '' })).toBe('warning');
    expect(breakerSeverity({ id: 'drawdown', state: 'paused', since: 0, reason: '' })).toBe('critical');
    expect(breakerNeedsAdminResume({ id: 'drawdown', state: 'paused', since: 0, reason: '' })).toBe(true);
    expect(breakerNeedsAdminResume({ id: 'feedStale', state: 'tripped', since: 0, reason: '' })).toBe(false);
  });

  it('grades feed freshness at 3 s and the 7 s stale threshold', () => {
    const now = 10_000_000;
    const levels = feedHealth([
      marketFixture('BTC/USD', { lastPriceMs: now - 1_000 }),
      marketFixture('ETH/USD', { lastPriceMs: now - 5_000 }),
      marketFixture('SOL/USD', { lastPriceMs: now - 7_500 }),
      marketFixture('XRP/USD', { lastPriceMs: now - 500, paused: true }),
    ], now).map(f => f.level);
    expect(levels).toEqual(['good', 'warning', 'critical', 'warning']);
    expect(feedHealth([marketFixture('BTC/USD')], null)[0]!.level).toBe('neutral');
    expect(worst(['good', 'warning', 'critical', 'info'])).toBe('critical');
  });

  it('reports launch boost progress "7,412 / 10,000 players"', () => {
    expect(launchProgress(launchFixture(), 7_412)).toMatchObject({ label: '7,412 / 10,000 players', state: 'active', share: 0.7412 });
    expect(launchProgress(launchFixture({ active: false }), 10_004)).toMatchObject({ state: 'ended', share: 1 });
    expect(launchProgress(launchFixture({ enabled: false }), 5_000).state).toBe('disabled');
  });
});

describe('RTP statistics', () => {
  it('uses the geometric mean of a multiplier range', () => {
    expect(rangeMidMultiplier('5-10')).toBeCloseTo(Math.sqrt(50), 12);
    expect(rangeMidMultiplier('1.01-2')).toBeCloseTo(Math.sqrt(2.02), 12);
    expect(rangeMidMultiplier('nonsense')).toBeNull();
  });
  it('derives a ±2 SE band and the drift z-score, preferring a server band', () => {
    const row = { key: '10-20', bets: 41_000, expected: 0.97, realized: 0.9245 };
    const band = rtpBand(row)!;
    const m = Math.sqrt(200);
    const se = Math.sqrt((0.97 * m - 0.97 * 0.97) / 41_000);
    expect(band.se).toBeCloseTo(se, 12);
    expect(band.low).toBeCloseTo(0.97 - 2 * se, 12);
    expect(band.source).toBe('approx');
    const z = driftZ(row, band)!;
    expect(z).toBeCloseTo((0.9245 - 0.97) / se, 9);
    expect(driftLevel(z)).toBe('watch');
    expect(driftLevel(3.5)).toBe('drift');
    expect(driftLevel(1)).toBe('ok');
    const server = rtpBand({ ...row, expectedLow: 0.95, expectedHigh: 0.99 })!;
    expect(server).toMatchObject({ low: 0.95, high: 0.99, source: 'server' });
    expect(server.se).toBeCloseTo(0.01, 12);
    expect(rtpBand({ ...row, bets: 0 })).toBeNull();
    expect(driftZ({ ...row, realized: null }, band)).toBeNull();
  });
});

describe('heatmap model', () => {
  it('bins shares into six sequential classes plus empty', () => {
    expect([null, 0, 0.05, 0.1, 0.11, 0.3, 0.6, 0.8, 0.95, 1.4].map(heatBin)).toEqual([0, 0, 1, 1, 2, 3, 4, 5, 6, 6]);
    expect(shareLabel(0.003)).toBe('<1%');
    expect(shareLabel(0)).toBe('0%');
    expect(shareLabel(0.456)).toBe('46%');
  });
  it('builds rows highest band first, exact column totals and column shares', () => {
    const exposure: Exposure = {
      market: 'BTC/USD', windows: [5000, 10000], bands: [{ index: 6400, lower: '64000.00', upper: '64010.00' }, { index: 6401, lower: '64010.00', upper: '64020.00' }],
      cells: [
        { start: 5000, bandIndex: 6400, x100: 150, liabilityCenti: '250', limitCenti: '1000', legs: 2 },
        { start: 5000, bandIndex: 6401, x100: 400, liabilityCenti: '0', limitCenti: '1000', legs: 0 },
        { start: 10000, bandIndex: 6400, x100: null, liabilityCenti: '999', limitCenti: '1000', legs: 5 },
      ],
      columnLimitCenti: '5000',
    };
    const model = buildHeatModel(exposure);
    expect(model.bands.map(b => b.index)).toEqual([6401, 6400]);
    expect(model.bands[0]!.label).toBe('64,010.00 – 64,020.00');
    expect(model.cells.get(cellKey(5000, 6400))).toMatchObject({ share: 0.25, bin: 2 }); // upper bounds are inclusive: 10–25 %
    expect(model.cells.get(cellKey(5000, 6401))).toMatchObject({ share: 0, bin: 0 });
    expect(model.cells.get(cellKey(10000, 6400))).toMatchObject({ share: 0.999, bin: 6, x100: null });
    expect(model.columns).toEqual([
      { start: 5000, liabilityCenti: '250', legs: 2, share: 0.05 },
      { start: 10000, liabilityCenti: '999', legs: 5, share: 0.1998 },
    ]);
    expect(model.totalLiabilityCenti).toBe('1249');
    expect(model.maxShare).toBe(0.999);
  });
});

describe('ledger math', () => {
  it('accumulates player P&L exactly in settlement order', () => {
    const series = cumulativePnl([
      leg({ legId: 'b', status: 'lost', stakeCenti: '300', payoutCenti: '900', settledMs: 20 }),
      leg({ legId: 'a', status: 'won', stakeCenti: '1000', payoutCenti: '2500', settledMs: 10 }),
      leg({ legId: 'c', status: 'refunded', settledMs: 30 }),
      leg({ legId: 'd', status: 'open' }),
    ]);
    expect(series).toEqual({ t: [10, 20, 30], centi: ['1500', '1200', '1200'] });
  });
  it('checks the vault assets identity exactly', () => {
    expect(vaultIdentity(chainFixture())).toEqual({ ok: true, expected: 100000000n, actual: 100000000n });
    const broken = chainFixture({ vault: { assetsCenti: '100000001' } });
    expect(vaultIdentity(broken)).toMatchObject({ ok: false, expected: 100000000n, actual: 100000001n });
  });
});

describe('store', () => {
  const msg = (event: string, data: unknown, id = '1') => ({ event, data: JSON.stringify(data), id });

  it('applies overview, bet and settlement events and ignores unknown events', () => {
    const store = new Store(() => 1_000);
    const seen: string[] = [];
    store.on('bets', () => seen.push('bets'));
    expect(store.ingest(msg('overview', overviewFixture()))).toBe(true);
    expect(store.snapshot.overview?.registeredPlayers).toBe(7412);
    expect(store.ingest(msg('bet', leg({})))).toBe(true);
    expect(store.ingest(msg('bet', leg({})))).toBe(true); // duplicate legId is not added twice
    expect(store.snapshot.bets).toHaveLength(1);
    expect(store.ingest(msg('settlement', leg({ status: 'won', settledMs: 1200 })))).toBe(true);
    expect(store.snapshot.bets[0]!.status).toBe('won');
    expect(store.ingest(msg('heartbeat', { any: 1 }))).toBe(true);
    expect(seen).toEqual(['bets', 'bets']);
  });

  it('keeps the ticker bounded and newest first', () => {
    const store = new Store();
    for (let i = 0; i < MAX_BETS + 25; i++) store.ingest(msg('bet', leg({ legId: `L${i}` })));
    expect(store.snapshot.bets).toHaveLength(MAX_BETS);
    expect(store.snapshot.bets[0]!.legId).toBe(`L${MAX_BETS + 24}`);
  });

  it('counts malformed events, alerts once, and never applies them', () => {
    const store = new Store(() => 5);
    expect(store.ingest(msg('overview', { ...overviewFixture(), equityCenti: 12.5 }))).toBe(false);
    expect(store.ingest({ event: 'bet', data: 'not json', id: '' })).toBe(false);
    expect(store.snapshot.overview).toBeNull();
    expect(store.snapshot.badEvents).toBe(2);
    expect(store.snapshot.alerts).toHaveLength(1);
    expect(store.snapshot.alerts[0]).toMatchObject({ level: 'warning', code: 'BAD_EVENT' });
  });

  it('drops an overview older than the one it has (poll racing the stream)', () => {
    const store = new Store();
    store.ingest(msg('overview', { ...overviewFixture(), clockMs: 2_000 }));
    store.ingest(msg('overview', { ...overviewFixture(), clockMs: 1_000 }));
    expect(store.snapshot.overview?.clockMs).toBe(2_000);
  });

  it('journals breaker transitions into the audit feed and merges seeded entries by id', () => {
    const store = new Store();
    store.ingest(msg('breaker', { id: 'feedStale', market: 'ETH/USD', state: 'tripped', since: 50, reason: 'no price' }));
    store.seedAudit([{ id: 'a-1', ms: 10, kind: 'admin', actor: 'admin', action: 'pricing' }, { id: 'a-1', ms: 10, kind: 'admin', actor: 'admin', action: 'pricing' }]);
    expect(store.snapshot.audit.map(e => e.kind)).toEqual(['breaker', 'admin']);
    expect(store.snapshot.lastBreaker?.state).toBe('tripped');
  });

  it('advances the server clock by elapsed time × replay speed, capped at 5 s', () => {
    let now = 0;
    const store = new Store(() => now);
    store.setOverview(decodeOverview({ ...overviewFixture(), clockMs: 1_000_000, speed: 20, feedMode: 'replay' }));
    now = 100;
    expect(store.serverNow()).toBe(1_002_000);
    now = 60_000;
    expect(store.serverNow()).toBe(1_100_000);
  });
});

describe('small helpers', () => {
  it('thins series and finds indexes by time', () => {
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(thin([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(indexAtOrBefore([10, 20, 30], 25)).toBe(1);
    expect(indexAtOrBefore([10, 20, 30], 5)).toBe(-1);
    expect(indexAtOrBefore([10, 20, 30], 30)).toBe(2);
  });
  it('builds a sparkline path that breaks at gaps and ends at the last point', () => {
    const { d, end } = sparklinePath([1, 2, null, 4], 100, 20, 0);
    expect(d).toBe('M0.0,20.0L33.3,13.3M100.0,0.0');
    expect(end).toEqual({ x: 100, y: 0 });
    expect(sparklinePath([5], 100, 20).d).toBe('');
  });
});
