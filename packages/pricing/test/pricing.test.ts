import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// Fixtures: the self-generated CC0 config and domain table served by the feed relay (see apps/feed-relay/data/PROVENANCE.md).
const DATA = new URL('../../../apps/feed-relay/data/', import.meta.url);
import { createCell, decimalToNumber, parseDecimal, sampleId, type PriceSample } from '@maya/contracts';
import { DEMO_CONFIG, getMarket } from '@maya/config';
import { PaperQuoteBook, TouchProbabilityModel, sampledBandProbability, ewmaSigma, floorGrossHundredths, type ModelInputs, type PreviewResult } from '../src/index.js';
const table = JSON.parse(readFileSync(new URL('maya-domain-table.json', DATA), 'utf8'));
const input = { spot: 60000, lower: 60000, upper: 60010, timeToStartS: 10, widthS: 5, sigmaPerSqrtSec: .0001, settleDtS: 1, houseEdge: .1, minimumGross: 1.01 };
describe('N2 sampled model / numerical contract', () => {
  it('N2-Q1 exact discrete event has zero-width probability zero; the domain table excludes zero width', () => {
    expect(sampledBandProbability({ zLower: 0, zUpper: 0, timeToStartS: 5, windowS: 5, observationIntervalS: 1 }).probability).toBe(0);
    expect(new TouchProbabilityModel(table).lookup([0, 0, 2, .5])).toBeNull();
  });
  it('N2-Q2 uses five observations and agrees with doubled-order independent resolution', () => {
    for (const T of [6, 40, 120, 400]) for (const height of [.05, .5, 4]) {
      const p = { zLower: -height, zUpper: height, timeToStartS: T, windowS: 5, observationIntervalS: 1 };
      const a = sampledBandProbability(p), b = sampledBandProbability({ ...p, order: a.quadratureOrder * 2 });
      expect(a.observationCount).toBe(5); expect(Math.abs(a.probability - b.probability)).toBeLessThan(1e-6);
    }
  });
  it('N2-Q3 symmetry and monotonic wider-band events', () => {
    const p = { timeToStartS: 10, windowS: 5, observationIntervalS: 1 };
    const a = sampledBandProbability({ ...p, zLower: .5, zUpper: 1.5 }).probability;
    expect(sampledBandProbability({ ...p, zLower: -1.5, zUpper: -.5 }).probability).toBeCloseTo(a, 12);
    expect(sampledBandProbability({ ...p, zLower: .25, zUpper: 1.75 }).probability).toBeGreaterThan(a);
  });
  it('N2-Q4 rejects out-of-domain and zero volatility rather than clamping or flooring', () => {
    const model = new TouchProbabilityModel(table);
    expect(model.lookup([8.00001, 1, 2, .5])).toBeNull();
    expect(model.previewSampled({ ...input, sigmaPerSqrtSec: 0 })).toEqual({ available: false, reason: 'invalid-volatility' });
    expect(model.previewSampled({ ...input, lower: 1, upper: 2 })).toMatchObject({ available: false, reason: 'out-of-domain' });
    expect(ewmaSigma([{ sourceTimeMs: 0, value: 5 }, { sourceTimeMs: 1000, value: 5 }])).toBe(0);
  });
  it('N2-Q5 decimal rational gross rounding has no hidden fraction or epsilon', () => {
    expect(floorGrossHundredths(.3, .1)).toBe(300n);
    expect(floorGrossHundredths(.30000000000000004, .1)).toBe(299n);
    expect(floorGrossHundredths(.9, .1)).toBe(100n);
  });
  it('N2-Q6 rejects corrupt table and unsupported phase', () => {
    expect(() => new TouchProbabilityModel({ ...table, table: [1] })).toThrow();
    expect(() => sampledBandProbability({ zLower: 0, zUpper: 1, timeToStartS: 5, windowS: 5, observationIntervalS: .3 })).toThrow();
    expect(new TouchProbabilityModel(table).previewSampled({ ...input, settleDtS: .05 })).toMatchObject({ available: false, reason: 'invalid-input' });
  });
});
describe('N2 immutable paper quotes', () => {
  const sourceTime = 1_700_000_000_000;
  const market = getMarket('btc-usd');
  const samples: PriceSample[] = Array.from({ length: 68 }, (_, i) => ({ sampleId: sampleId(market.feedId, sourceTime - (67 - i) * 1000), marketId: market.id, feedId: market.feedId, pairId: 1, sourceTimeMs: sourceTime - (67 - i) * 1000, receivedAtMs: sourceTime + 3500, price: parseDecimal(String(60000 + (i % 2) * 5)) }));
  const clock = { nowMs: sourceTime + 3500, uncertaintyMs: 500, ready: true };
  const config = { configId: 'config', formulaVersion: '3.0.0', houseEdge: .1, minPayoutX: 1.01, minDelayMs: 3000 };
  const book = () => { const b = new PaperQuoteBook({ table, tableId: 'table', getConfig: () => config, policyId: 'policy' }); b.updateMarket('btc-usd', samples, { marketId: 'btc-usd', status: 'ready', observedAtMs: clock.nowMs }, clock); return b; };
  it('N2-Q7 same source/cell reuses immutable exact quote and registry identity', () => {
    const b = book(), cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    const a = b.quoteCell(cell), again = b.quoteCell(cell);
    expect(a.available).toBe(true); expect(again).toEqual(a);
    if (a.available) { expect(Object.isFrozen(a.quote)).toBe(true); expect(Object.isFrozen(a.quote.provenance)).toBe(true); expect(b.getQuote(a.quote.quoteId)).toBe(a.quote); expect(a.quote.provenance.modelId).toBe('maya-gaussian-linear-six-v2'); }
  });
  it('N2-Q8 stale clocks, expired quote and wrong geometry cannot become accepted quotes', () => {
    const b = book(), cell = b.candidates('btc-usd')[0]!;
    expect(b.quoteCell(cell, { ...clock, ready: false })).toMatchObject({ available: false, reason: 'clock-uncertain' });
    expect(b.quoteCell(cell, { ...clock, nowMs: sourceTime + 6500 })).toMatchObject({ available: false, reason: 'too-late' });
    const bad = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60020'), DEMO_CONFIG.ruleVersion);
    expect(b.quoteCell(bad)).toMatchObject({ available: false, reason: 'model-incompatible' });
    expect(b.candidates('btc-usd')).toHaveLength(42);
  });
  it('recomputes volatility after a missing historical second is backfilled with an unchanged latest sample and history length', () => {
    const olderTime = sourceTime - 68000;
    const older: PriceSample = { ...samples[0]!, sampleId: sampleId(market.feedId, olderTime), sourceTimeMs: olderTime };
    const beforeBackfill = [older, ...samples.filter((_, index) => index !== 60)];
    expect(beforeBackfill).toHaveLength(samples.length);
    expect(beforeBackfill.at(-1)?.sampleId).toBe(samples.at(-1)?.sampleId);
    const b = new PaperQuoteBook({ table, tableId: 'table', getConfig: () => config, policyId: 'policy' });
    const health = { marketId: market.id, status: 'ready', observedAtMs: clock.nowMs } as const;
    b.updateMarket(market.id, beforeBackfill, health, clock);
    const previousSigma = b.getSigma(market.id);
    const cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    expect(b.quoteCell(cell)).toMatchObject({ available: false, reason: 'insufficient-history' });
    b.updateMarket(market.id, samples, health, clock);
    const expectedSigma = ewmaSigma(samples.map(sample => ({ sourceTimeMs: sample.sourceTimeMs, value: decimalToNumber(sample.price) })));
    expect(Math.abs(previousSigma - expectedSigma)).toBeGreaterThan(1e-8);
    expect(b.getSigma(market.id)).toBe(expectedSigma);
    const expected = new TouchProbabilityModel(table).previewLinear({ ...input, spot: decimalToNumber(samples.at(-1)!.price), sigmaPerSqrtSec: expectedSigma });
    const quote = b.quoteCell(cell);
    expect(expected.available).toBe(true); expect(quote.available).toBe(true);
    if (expected.available && quote.available) expect(quote.quote.grossX100).toBe(expected.grossX100);
  });
  it('keeps an asynchronous pending result uncached and creates no placeholder odds', () => {
    let response: PreviewResult | undefined;
    const requested: ModelInputs[] = [];
    const b = new PaperQuoteBook({ table, tableId: 'table', getConfig: () => config, policyId: 'policy', preview: params => { requested.push(params); return response; } });
    const health = { marketId: market.id, status: 'ready', observedAtMs: clock.nowMs } as const;
    b.updateMarket(market.id, samples, health, clock);
    const cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    expect(b.quoteCell(cell)).toEqual({ available: false, cellId: cell.cellId, reason: 'warming-up' });
    expect(b.quoteCell(cell)).toEqual({ available: false, cellId: cell.cellId, reason: 'warming-up' });
    expect(requested).toHaveLength(2);
    expect(requested[0]).toMatchObject({ spot: 60005, lower: 60000, upper: 60010, timeToStartS: 10, widthS: 5, settleDtS: 1 });
    response = new TouchProbabilityModel(table).previewLinear(requested[0]!);
    const ready = b.quoteCell(cell);
    expect(ready.available).toBe(true);
    expect(b.quoteCell(cell)).toEqual(ready);
    expect(requested).toHaveLength(3);
  });
  it('bridges a normal source advance only through the existing quote’s original expiry', () => {
    const model = new TouchProbabilityModel(table);
    let pending = false;
    const b = new PaperQuoteBook({ table, tableId: 'table', getConfig: () => config, policyId: 'policy', preview: params => pending ? undefined : model.previewLinear(params) });
    const health = { marketId: market.id, status: 'ready', observedAtMs: clock.nowMs } as const;
    b.updateMarket(market.id, samples, health, clock);
    const cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    const first = b.quoteCell(cell); expect(first.available).toBe(true); if (!first.available) return;
    const original = first.quote;
    const nextSample = { ...samples.at(-1)!, sampleId: sampleId(market.feedId, sourceTime + 1000), sourceTimeMs: sourceTime + 1000, receivedAtMs: sourceTime + 4500, price: parseDecimal('60000') };
    const nextClock = { ...clock, nowMs: sourceTime + 4500 };
    pending = true; b.updateMarket(market.id, [...samples.slice(1), nextSample], health, nextClock);
    expect(b.quoteCell(cell)).toEqual(first);
    expect(b.quoteCell(cell, { ...clock, nowMs: original.validUntilMs - clock.uncertaintyMs - 1 })).toEqual(first);
    expect(b.quoteCell(cell, { ...clock, nowMs: original.validUntilMs - clock.uncertaintyMs })).toMatchObject({ available: false, reason: 'warming-up' });
    expect(b.getQuote(original.quoteId)).toBe(original);
    expect(original.validUntilMs).toBe(sourceTime + 5300);
    pending = false;
    const replacement = b.quoteCell(cell, { ...clock, nowMs: sourceTime + 5000 });
    expect(replacement.available).toBe(true);
    if (replacement.available) {
      expect(replacement.quote.quoteId).not.toBe(original.quoteId);
      expect(replacement.quote.provenance.sourceSampleId).toBe(nextSample.sampleId);
      expect(replacement.quote.validUntilMs).toBe(sourceTime + 6300);
    }
    expect(b.getQuote(original.quoteId)).toBe(original);
  });
  it.each(['config', 'policy'] as const)('cannot reuse a previous quote after the %s changes while a result is pending', changedField => {
    const model = new TouchProbabilityModel(table);
    let currentConfig = { ...config }, pending = false;
    const options = { table, tableId: 'table', getConfig: () => currentConfig, policyId: 'policy', preview: (params: ModelInputs) => pending ? undefined : model.previewLinear(params) };
    const b = new PaperQuoteBook(options);
    b.updateMarket(market.id, samples, { marketId: market.id, status: 'ready', observedAtMs: clock.nowMs }, clock);
    const cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    const first = b.quoteCell(cell); expect(first.available).toBe(true);
    pending = true;
    if (changedField === 'config') currentConfig = { ...config, configId: 'new-config', houseEdge: .12 };
    else options.policyId = 'new-policy';
    expect(b.quoteCell(cell)).toMatchObject({ available: false, reason: 'warming-up' });
    if (first.available) expect(b.getQuote(first.quote.quoteId)).toBe(first.quote);
  });
  it('does not bridge a historical backfill with an old quote from an unchanged latest sample', () => {
    const model = new TouchProbabilityModel(table);
    let pending = false;
    const b = new PaperQuoteBook({ table, tableId: 'table', getConfig: () => config, policyId: 'policy', preview: params => pending ? undefined : model.previewLinear(params) });
    const health = { marketId: market.id, status: 'ready', observedAtMs: clock.nowMs } as const;
    b.updateMarket(market.id, samples, health, clock);
    const cell = createCell('btc-usd', sourceTime + 10000, parseDecimal('60000'), parseDecimal('60010'), DEMO_CONFIG.ruleVersion);
    const first = b.quoteCell(cell); expect(first.available).toBe(true);
    pending = true;
    const olderTime = sourceTime - 68000;
    const older = { ...samples[0]!, sampleId: sampleId(market.feedId, olderTime), sourceTimeMs: olderTime };
    b.updateMarket(market.id, [older, ...samples.filter((_, index) => index !== 60)], health, clock);
    b.updateMarket(market.id, samples, health, clock);
    expect(b.quoteCell(cell)).toMatchObject({ available: false, reason: 'warming-up' });
    if (first.available) expect(b.getQuote(first.quote.quoteId)).toBe(first.quote);
  });
});
