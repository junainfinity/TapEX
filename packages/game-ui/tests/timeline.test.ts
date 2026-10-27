import { describe, expect, it } from 'vitest';
import { getMarket } from '@maya/config';
import { parseDecimal, type PriceSample } from '@maya/contracts';
import { advancePlayhead, curvePrice, displayPriceAt, linearPriceAt } from '../src/timeline.js';

const epoch = 1_700_000_000_000;
const market = getMarket('btc-usd');
function observations(prices: readonly number[], times = prices.map((_, index) => index * 1000)): readonly PriceSample[] {
  return Object.freeze(prices.map((price, index) => Object.freeze({
    sampleId: `timeline-${times[index]}`,
    marketId: market.id,
    pairId: market.pairId,
    feedId: market.feedId,
    sourceTimeMs: epoch + times[index]!,
    receivedAtMs: epoch + times[index]! + 400,
    price: Object.freeze(parseDecimal(String(price))),
  })));
}

describe('observed-only presentation playhead', () => {
  it('initializes behind the clock and never ahead of the latest observation', () => {
    expect(advancePlayhead(0, epoch, epoch + 550, 16)).toBe(epoch - 950);
    expect(advancePlayhead(0, epoch - 5000, epoch + 550, 16)).toBe(epoch - 5000);
  });

  it('advances every frame under regular 1 Hz observations without once-per-second jumps', () => {
    const frameMs = 1000 / 60;
    let current = epoch - 1500;
    for (let frame = 1; frame <= 3600; frame++) {
      const elapsed = frame * frameMs;
      const latest = epoch + Math.floor(elapsed / 1000) * 1000;
      const next = advancePlayhead(current, latest, epoch + elapsed, frameMs);
      expect(next).toBeLessThanOrEqual(latest);
      expect(next - current).toBeGreaterThanOrEqual(frameMs * .85 - .001);
      expect(next - current).toBeLessThanOrEqual(frameMs * 1.15 + .001);
      current = next;
    }
    expect(epoch + 60_000 - current).toBeGreaterThan(1400);
    expect(epoch + 60_000 - current).toBeLessThan(1600);
  });

  it('holds at the final observed timestamp throughout a feed stall', () => {
    let current = epoch - 950;
    for (let frame = 1; frame <= 600; frame++) {
      const next = advancePlayhead(current, epoch, epoch + 550 + frame * 16, 16);
      expect(next).toBeGreaterThanOrEqual(current);
      expect(next).toBeLessThanOrEqual(epoch);
      current = next;
    }
    expect(current).toBe(epoch);
    expect(advancePlayhead(current, epoch, epoch + 60_000, 16)).toBe(epoch);
  });

  it('caps a delayed frame, ignores negative elapsed time, and catches up safely after a long absence', () => {
    expect(advancePlayhead(epoch, epoch + 2000, epoch + 2000, -20)).toBe(epoch);
    expect(advancePlayhead(epoch, epoch + 2000, epoch + 2000, 4000) - epoch).toBeLessThanOrEqual(115);
    const caughtUp = advancePlayhead(epoch, epoch + 60_000, epoch + 60_550, 60_000);
    expect(caughtUp).toBe(epoch + 59_050);
    expect(caughtUp).toBeLessThanOrEqual(epoch + 60_000);
  });

  it('cannot remain beyond the latest available observation when history contracts', () => {
    expect(advancePlayhead(epoch + 1000, epoch, epoch + 3000, 16)).toBe(epoch);
  });

  it('brakes progressively when observed headroom runs low without extrapolating', () => {
    let current = epoch - 400;
    let previousStep = Infinity;
    for (let frame = 1; frame <= 90; frame++) {
      const next = advancePlayhead(current, epoch, epoch + 1800 + frame * 16, 16);
      const step = next - current;
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(previousStep);
      expect(next).toBeLessThan(epoch);
      previousStep = step;
      current = next;
    }
    expect(epoch - current).toBeLessThan(20);
  });

  it('avoids recurring freezes under the captured live poll jitter with less than 3 seconds of total lag', () => {
    // Source-arrival shape from the 2026-09-20 live Docker audit: ~1,283 ms
    // response intervals and alternating +1 s / +2 s observation advances.
    // Columns: time since capture start, latest source offset, source-clock age.
    const arrivals = [
      [0, 0, 2182], [116.7, 1000, 1299], [1400.2, 3000, 583],
      [2683.6, 4000, 865], [3950.3, 5000, 1134], [5233.7, 7000, 415],
      [6517.1, 8000, 701], [7800.4, 9000, 1011], [9083.9, 10000, 1266],
      [10367.3, 12000, 547], [11634.1, 13000, 816], [12934.2, 14000, 1114],
      [14267.7, 16000, 449], [15551.1, 17000, 731], [16817.8, 18000, 1021],
      [18101.3, 19000, 1282], [19384.7, 21000, 566],
    ] as const;
    let current = epoch, arrivalIndex = 0;
    const frameMs = 1000 / 60;
    let verifiedFrames = 0;
    for (let frame = 1; frame <= 1200; frame++) {
      const elapsed = frame * frameMs;
      while (arrivals[arrivalIndex + 1] && arrivals[arrivalIndex + 1]![0] <= elapsed) arrivalIndex++;
      const [arrivedAt, sourceOffset, age] = arrivals[arrivalIndex]!;
      const latest = epoch + sourceOffset;
      const clock = latest + age + elapsed - arrivedAt;
      const next = advancePlayhead(current, latest, clock, frameMs);
      expect(next).toBeLessThanOrEqual(latest);
      expect(next).toBeGreaterThanOrEqual(current);
      expect(next - current).toBeLessThanOrEqual(frameMs * 1.15 + .001);
      expect(clock - next).toBeLessThan(3000);
      // Capture began already starved at the latest observation. No algorithm
      // can move from there before another observation arrives without guessing.
      if (arrivalIndex > 0) { expect(next).toBeGreaterThan(current); verifiedFrames++; }
      current = next;
    }
    expect(verifiedFrames).toBeGreaterThan(1190);
  });
});

describe('v2 authoritative visible path', () => {
  it('renders the final interval crossing that sampled settlement previously missed', () => {
    const samples=observations([80428.64,80433.38581199]);
    const touch=epoch+1000*(80430-80428.64)/(80433.38581199-80428.64);
    expect(touch).toBeLessThan(epoch+1000);
    // Epoch timestamps lose sub-millisecond precision as browser Numbers.
    // Settlement uses rational arithmetic; this checks sub-microdollar pixels.
    expect(linearPriceAt(samples,touch)).toBeCloseTo(80430,6);
    expect(linearPriceAt(samples,epoch+500)).toBeCloseTo((80428.64+80433.38581199)/2,7);
  });
  it('uses exact straight connectors without overshoot, extrapolation, or missing-gap fabrication', () => {
    const samples=observations([100,120,90],[0,1000,4000]);
    expect(linearPriceAt(samples,epoch-500)).toBe(100);
    expect(linearPriceAt(samples,epoch+250)).toBe(105);
    expect(linearPriceAt(samples,epoch+500)).toBe(110);
    expect(linearPriceAt(samples,epoch+1000)).toBe(120);
    expect(linearPriceAt(samples,epoch+2500)).toBe(120);
    expect(linearPriceAt(samples,epoch+5000)).toBe(90);
    expect(linearPriceAt([],epoch)).toBe(0);
    expect(linearPriceAt(observations([105]),epoch+5000)).toBe(105);
  });
});

describe('price curve from observations', () => {
  it('passes through every observed price, handles empty/single samples, and clamps outside history', () => {
    const samples = observations([100, 103, 101, 106]);
    samples.forEach((sample, index) => expect(displayPriceAt(samples, sample.sourceTimeMs)).toBe([100, 103, 101, 106][index]));
    expect(displayPriceAt([], epoch)).toBe(0);
    expect(displayPriceAt(observations([102]), epoch + 60_000)).toBe(102);
    expect(displayPriceAt(samples, epoch - 60_000)).toBe(100);
    expect(displayPriceAt(samples, epoch + 60_000)).toBe(106);
    expect(curvePrice(samples, 0, -5)).toBe(100);
    expect(curvePrice(samples, 0, 5)).toBe(103);
  });

  it('never overshoots either endpoint or reverses within an observed segment', () => {
    const profiles = [
      [100, 100, 100, 100],
      [100, 110, 109, 109.5],
      [110, 100, 101, 100.5],
      [100, 101, 200, 201],
      [201, 200, 101, 100],
      Array.from({ length: 80 }, (_, i) => 60000 + Math.sin(i * 1.71) * (i % 7 + .01)),
    ];
    for (const prices of profiles) {
      const samples = observations(prices);
      for (let index = 0; index < prices.length - 1; index++) {
        const start = prices[index]!, end = prices[index + 1]!;
        let previous = start;
        for (let step = 0; step <= 100; step++) {
          const price = curvePrice(samples, index, step / 100);
          expect(Number.isFinite(price)).toBe(true);
          expect(price).toBeGreaterThanOrEqual(Math.min(start, end) - 1e-8);
          expect(price).toBeLessThanOrEqual(Math.max(start, end) + 1e-8);
          if (end >= start) expect(price).toBeGreaterThanOrEqual(previous - 1e-8);
          else expect(price).toBeLessThanOrEqual(previous + 1e-8);
          previous = price;
        }
      }
    }
  });

  it('eases both sides to zero velocity at local reversals', () => {
    for (const prices of [[100, 110, 109], [110, 100, 101]]) {
      const samples = observations(prices);
      const epsilon = 1e-5;
      const before = (curvePrice(samples, 0, 1) - curvePrice(samples, 0, 1 - epsilon)) / epsilon;
      const after = (curvePrice(samples, 1, epsilon) - curvePrice(samples, 1, 0)) / epsilon;
      expect(Math.abs(before)).toBeLessThan(.001);
      expect(Math.abs(after)).toBeLessThan(.001);
    }
  });

  it('does not draw synthetic motion across missing observation intervals', () => {
    const samples = observations([100, 102, 115, 113], [0, 1000, 6000, 7000]);
    expect(displayPriceAt(samples, epoch + 1000)).toBe(102);
    for (const offset of [1001, 1500, 3000, 5999]) expect(displayPriceAt(samples, epoch + offset)).toBe(102);
    expect(displayPriceAt(samples, epoch + 6000)).toBe(115);
    expect(displayPriceAt(samples, epoch + 7000)).toBe(113);
  });

  it('uses revised observed prices immediately without retaining or mutating an earlier trace', () => {
    const first = observations([100, 102, 101]);
    const revised = observations([100, 110, 101]);
    const original = JSON.stringify(first);
    expect(displayPriceAt(first, epoch + 1000)).toBe(102);
    expect(displayPriceAt(revised, epoch + 1000)).toBe(110);
    expect(displayPriceAt(revised, epoch + 500)).toBeGreaterThan(displayPriceAt(first, epoch + 500));
    expect(displayPriceAt(first, epoch + 1000)).toBe(102);
    expect(JSON.stringify(first)).toBe(original);
  });
});
