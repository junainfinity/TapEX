import { describe, expect, it } from 'vitest';
import { ADAPTIVE_CONFIG, DEMO_CONFIG, MARKETS, clampZoom, getMarket, resolveLayout, stepStake, stepZoom, validateDemoConfig } from '../src/index.js';

describe('locked anonymous paper settings', () => {
  it('validates the canonical configuration and public feed identities', () => {
    expect(() => validateDemoConfig()).not.toThrow();
    expect(MARKETS.map(m => [m.id, m.pairId, m.symbol])).toEqual([['btc-usd', 1, 'BTC/USD'], ['eth-usd', 2, 'ETH/USD']]);
    expect(MARKETS.every(m => /^0x[\da-f]{64}$/.test(m.feedId))).toBe(true);
    expect(getMarket('eth-usd').bandHeight).toEqual({ coefficient: '5', exponent: -1 });
    expect(() => getMarket('btc-eth')).toThrow();
    expect(DEMO_CONFIG.consultationUrl).toBe('https://quantellics.com');
  });
  it('has shared stake endpoints and bounded selection without a bet', () => {
    expect(DEMO_CONFIG.stakeMenuCents).toEqual(['10', '50', '100', '500', '1000']);
    expect(stepStake('10', 'down')).toBe('10');
    expect(stepStake('1000', 'up')).toBe('1000');
    expect(stepStake('50', 'up')).toBe('100');
    expect(() => stepStake('2500', 'up')).toThrow();
    expect(DEMO_CONFIG.maxAcceptedStakePerCellCents).toBe('5000');
    expect(DEMO_CONFIG.startingBalanceCents).toBe('100000');
    expect(DEMO_CONFIG.maxNewBetsPerPage).toBe(10);
  });
  it('retains continuous zoom and exact factors at the endpoints', () => {
    expect(DEMO_CONFIG.zoom.initial).toBe(0.6);
    expect(stepZoom(0.6, 'in')).toBeCloseTo(0.66);
    expect(stepZoom(0.6, 'out')).toBeCloseTo(0.54);
    expect(stepZoom(0.9, 'in')).toBe(0.9);
    expect(stepZoom(0.345, 'out')).toBe(0.345);
    expect(clampZoom(0.4321)).toBe(0.4321);
    expect(() => clampZoom(NaN)).toThrow();
  });
  it('rejects malformed incoming configuration before use', () => {
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, stakeMenuCents: ['10', '10'] } as never)).toThrow();
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, consultationUrl: 'javascript:alert(1)' } as never)).toThrow();
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, zoom: { min: 1, initial: 0.6, max: 0.9 } } as never)).toThrow();
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, stakeMenuCents: ['10', '20', '100', '500', '1000'] } as never)).toThrow();
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, zoom: { ...DEMO_CONFIG.zoom, min: 0.2 } } as never)).toThrow();
    expect(() => validateDemoConfig({ ...DEMO_CONFIG, markets: MARKETS.map(m => ({ ...m, bandHeight: { coefficient: '1', exponent: 0 } })) } as never)).toThrow();
  });
});

describe('ordered adaptive profile predicates', () => {
  it.each([
    [767, 900, false, 'mobile'], [768, 900, false, 'tablet'], [1199, 900, false, 'tablet'], [1200, 900, false, 'desktop'],
    [1439, 900, true, 'tablet'], [1440, 900, true, 'desktop'], [1600, 499, false, 'mobile'], [1600, 500, false, 'desktop'],
    [844, 390, true, 'mobile'], [1366, 1024, true, 'tablet']
  ] as const)('%s×%s coarse=%s selects %s', (width, height, coarsePointer, expected) => expect(resolveLayout({ width, height, coarsePointer })).toBe(expected));
  it('separates measurable host size and controls from rendering quality', () => {
    expect(ADAPTIVE_CONFIG.mobile.anchorFraction).toBe(0.18);
    expect(ADAPTIVE_CONFIG.desktop.rightGutter).toBe(48);
    expect(ADAPTIVE_CONFIG.minControlTarget).toBe(44);
    expect(() => resolveLayout({ width: 0, height: 100, coarsePointer: false })).toThrow();
  });
});
