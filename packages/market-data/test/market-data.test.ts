import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
// Fixtures: the self-generated CC0 config and domain table served by the feed relay (see apps/feed-relay/data/PROVENANCE.md).
const DATA = new URL('../../../apps/feed-relay/data/', import.meta.url);
import { getMarket } from '@maya/config';
import { decimalToString } from '@maya/contracts';
import { LynxMarketData, SourceClock, parseLosslessJson, parsePriceBuffer, LIVE_POLICY } from '../src/index.js';
const config = readFileSync(new URL('maya-config.json', DATA), 'utf8');
const table = readFileSync(new URL('maya-domain-table.json', DATA), 'utf8');
const epoch = 1_700_000_000;
function buffer(pair: 1 | 2, latest = epoch, changes: Record<number, string> = {}) {
  const market = getMarket(pair === 1 ? 'btc-usd' : 'eth-usd');
  const rows = Array.from({ length: 71 }, (_, i) => { const t = latest - 70 + i; return `{"t":${t},"p":${changes[t] ?? (pair === 1 ? '60000.123456789123456789' : '2500.123456789123456789')}}`; });
  return `{"chain":"bsc","pair":${pair},"feedId":"${market.feedId}","count":71,"prices":[${rows.join(',')}]}`;
}
const clients: LynxMarketData[] = [];
afterEach(() => { clients.forEach((c) => c.stop()); clients.length = 0; vi.unstubAllGlobals(); });
function harness() {
  let mono = 0, latest = epoch, changes: Record<number, string> = {}, missing = false, wrongAuthority = false;
  const response = (route: string) => new Response(route.endsWith('/config') ? config : route.endsWith('/table') ? table : buffer(route.endsWith('/1') && !wrongAuthority ? 1 : 2, latest, changes), { headers: missing ? {} : { 'x-maya-upstream-date': new Date(latest * 1000).toUTCString(), 'x-maya-upstream-rtt-ms': '100', 'x-maya-upstream-age-ms': '0' } });
  const feed = new LynxMarketData({ fetchImpl: (async (route) => response(String(route))) as typeof fetch, monotonic: () => mono }); clients.push(feed);
  return { feed, advance: (ms: number) => { mono += ms; latest += Math.floor(ms / 1000); }, change: (t: number, price: string) => { changes[t] = price; }, omitHeaders: () => { missing = true; }, spoofAuthority: () => { wrongAuthority = true; } };
}
describe('display preview isolation', () => {
  it('adds the three freshest observed seconds without exposing them to authoritative samples', async () => {
    const h = harness(); await h.feed.start();
    for (const market of ['btc-usd', 'eth-usd'] as const) {
      const confirmed = h.feed.getSamples(market);
      const display = h.feed.getDisplaySamples(market);
      expect(display).toHaveLength(71);
      expect(display.slice(0, confirmed.length)).toEqual(confirmed);
      expect(display.slice(-3).map((sample) => sample.sourceTimeMs)).toEqual([epoch - 2, epoch - 1, epoch].map((t) => t * 1000));
      expect(h.feed.getSamples(market)).toEqual(confirmed);
      expect(display[0]).toBe(confirmed[0]);
    }
  });
  it('shows the newest received revision, including a return to a previously observed price', async () => {
    const h = harness(); await h.feed.start();
    const confirmed = h.feed.getSamples('btc-usd');
    const original = decimalToString(h.feed.getDisplaySamples('btc-usd').at(-1)!.price);
    h.advance(100); h.change(epoch, '60001'); await h.feed.pollMarket('btc-usd');
    const revised = h.feed.getDisplaySamples('btc-usd').at(-1)!;
    expect(decimalToString(revised.price)).toBe('60001');
    h.advance(100); h.change(epoch, original); await h.feed.pollMarket('btc-usd');
    const returned = h.feed.getDisplaySamples('btc-usd').at(-1)!;
    expect(decimalToString(returned.price)).toBe(original);
    expect(returned.receivedAtMs).toBeGreaterThan(revised.receivedAtMs);
    expect(h.feed.getSamples('btc-usd')).toEqual(confirmed);
    expect(h.feed.getConflictingSampleIds('btc-usd')).toEqual([]);
  });
  it('breaks equal receipt-time ties by actual latest observation', async () => {
    const h = harness(); await h.feed.start();
    const original = decimalToString(h.feed.getDisplaySamples('btc-usd').at(-1)!.price);
    h.change(epoch, '60001'); await h.feed.pollMarket('btc-usd');
    h.change(epoch, original); await h.feed.pollMarket('btc-usd');
    expect(decimalToString(h.feed.getDisplaySamples('btc-usd').at(-1)!.price)).toBe(original);
  });
  it('keeps confirmed history authoritative and excludes later finalized contradictions from both traces', async () => {
    const h = harness(); await h.feed.start();
    h.change(epoch, '60001'); await h.feed.pollMarket('btc-usd');
    h.advance(3000); await h.feed.pollMarket('btc-usd');
    const finalized = h.feed.getSamples('btc-usd').find((sample) => sample.sourceTimeMs === epoch * 1000)!;
    expect(decimalToString(finalized.price)).toBe('60001');
    h.advance(100); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getDisplaySamples('btc-usd').find((sample) => sample.sampleId === finalized.sampleId)).toBe(finalized);
    h.change(epoch, '60002'); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getHealth('btc-usd').status).toBe('unavailable');
    expect(h.feed.getConflictingSampleIds('btc-usd')).toContain(finalized.sampleId);
    expect(h.feed.getSamples('btc-usd').some((sample) => sample.sampleId === finalized.sampleId)).toBe(false);
    expect(h.feed.getDisplaySamples('btc-usd').some((sample) => sample.sampleId === finalized.sampleId)).toBe(false);
    expect(h.feed.getCoverage('btc-usd', epoch * 1000, (epoch + 1) * 1000).status).toBe('recovering');
  });
  it('does not publish provisional prices from a mismatched market authority', async () => {
    const h = harness(); await h.feed.start();
    const display = h.feed.getDisplaySamples('btc-usd');
    const confirmed = h.feed.getSamples('btc-usd');
    h.advance(1000); h.spoofAuthority(); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getHealth('btc-usd')).toMatchObject({ status: 'recovering', reason: 'Price buffer authority mismatch' });
    expect(h.feed.getDisplaySamples('btc-usd')).toEqual(display);
    expect(h.feed.getSamples('btc-usd')).toEqual(confirmed);
  });
});
describe('N2 source precision and authority', () => {
  it('N2-D1 preserves decimal digits that JSON Number would lose', () => {
    const samples = parsePriceBuffer(buffer(1), getMarket('btc-usd'), 1);
    expect(decimalToString(samples[0]!.price)).toBe('60000.123456789123456789');
    expect(Object.isFrozen(samples[0]!.price)).toBe(true);
  });
  it('N2-D2 rejects authority mismatch, duplicate keys and malformed JSON', () => {
    expect(() => parsePriceBuffer(buffer(1), getMarket('eth-usd'), 1)).toThrow('authority');
    for (const json of ['{"a":1,"a":2}', '{"a":01}', '[1,]', '1 true']) expect(() => parseLosslessJson(json)).toThrow();
  });
  it('N2-D3 clock is independent of price samples, expires and invalidates synchronously', () => {
    let mono = 0; const clock = new SourceClock(() => mono);
    expect(clock.getClock().ready).toBe(false);
    clock.observe(new Date(epoch * 1000).toUTCString(), 100, 0, 0);
    expect(clock.getClock()).toEqual({ nowMs: epoch * 1000 + 550, uncertaintyMs: 550, ready: true });
    clock.invalidate(); expect(clock.getClock().ready).toBe(false);
    clock.observe(new Date(epoch * 1000).toUTCString(), 100, 0, 0); mono = 6001;
    expect(clock.getClock().ready).toBe(false);
  });
  it('N2-D4 invalid clock evidence cannot establish readiness', () => {
    const c = new SourceClock(); expect(() => c.observe('invalid', 0, 0, 0)).toThrow();
    expect(() => c.observe(new Date().toUTCString(), 6000, 0, 0)).toThrow();
  });
});
describe('N2 stabilized buffers and recovery', () => {
  it('N2-D5 subscribes both pairs and emits only the measured stable frontier', async () => {
    const h = harness(); await h.feed.start();
    for (const market of ['btc-usd', 'eth-usd'] as const) { expect(h.feed.getHealth(market).status).toBe('ready'); expect(h.feed.getSamples(market)).toHaveLength(68); expect(h.feed.getSamples(market).at(-1)!.sourceTimeMs).toBe((epoch - 3) * 1000); }
    expect(h.feed.getSettlementPolicy().policyId).toBe(LIVE_POLICY.policyId);
  });
  it('N2-D6 newest revised observations remain provisional; finalized contradictions quarantine', async () => {
    const h = harness(); await h.feed.start(); h.change(epoch - 1, '60001'); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getConflictingSampleIds('btc-usd')).toHaveLength(0);
    h.change(epoch - 5, '60002'); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getConflictingSampleIds('btc-usd')).toHaveLength(1);
    expect(h.feed.getHealth('btc-usd').status).toBe('unavailable');
    const coverage = h.feed.getCoverage('btc-usd', (epoch - 10) * 1000, (epoch - 5) * 1000 + 1000);
    expect(coverage.status).toBe('recovering'); expect(coverage.conflictSampleIds).toHaveLength(1);
  });
  it('N2-D7 exact five-slot half-open coverage waits for watermark and never invents missing observations', async () => {
    const h = harness(); await h.feed.start();
    expect(h.feed.getCoverage('btc-usd', (epoch - 10) * 1000, (epoch - 5) * 1000).status).toBe('complete');
    expect(h.feed.getCoverage('btc-usd', (epoch - 5) * 1000, epoch * 1000).status).toBe('recovering');
    h.advance(31000); expect(h.feed.getCoverage('btc-usd', (epoch - 5) * 1000, epoch * 1000).status).toBe('unrecoverable');
  });
  it('N2-D8 missing timing metadata pauses instead of treating absent values as zero', async () => {
    const h = harness(); await h.feed.start(); h.omitHeaders(); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getHealth('btc-usd').status).toBe('recovering');
  });
  it('N2-D9 page revalidation gates immediately and only recovers on fresh evidence', async () => {
    const h = harness(); await h.feed.start(); h.advance(1000);
    const pending = h.feed.revalidate(); expect(h.feed.getClock().ready).toBe(false);
    await pending; expect(h.feed.getClock().ready).toBe(true);
  });
  it('N2-D10 default fetch preserves native global receiver (browser integration regression)', async () => {
    vi.stubGlobal('fetch', function (this: unknown, route: string) {
      if (this !== globalThis) throw new Error('Illegal invocation');
      return Promise.resolve(new Response(route.endsWith('/config') ? config : route.endsWith('/table') ? table : buffer(route.endsWith('/1') ? 1 : 2), { headers: { 'x-maya-upstream-date': new Date(epoch * 1000).toUTCString(), 'x-maya-upstream-rtt-ms': '100', 'x-maya-upstream-age-ms': '0' } }));
    });
    const c = new LynxMarketData({ monotonic: () => 0 }); clients.push(c); await c.start();
    expect(c.getHealth('btc-usd').status).toBe('ready');
  });
  it('N2-D11 old requests cannot restore readiness during a visibility revalidation', async () => {
    let blocked = false, release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const c = new LynxMarketData({ monotonic: () => 0, fetchImpl: (async (url) => {
      const route = String(url); if (blocked && route.endsWith('/1')) await pending;
      return new Response(route.endsWith('/config') ? config : route.endsWith('/table') ? table : buffer(route.endsWith('/1') ? 1 : 2), { headers: { 'x-maya-upstream-date': new Date(epoch * 1000).toUTCString(), 'x-maya-upstream-rtt-ms': '100', 'x-maya-upstream-age-ms': '0' } });
    }) as typeof fetch }); clients.push(c); await c.start();
    blocked = true; const old = c.pollMarket('btc-usd'); const resumed = c.revalidate();
    expect(c.getClock().ready).toBe(false); blocked = false; release!(); await old; await resumed;
    expect(c.getClock().ready).toBe(true); expect(c.getHealth('eth-usd').status).toBe('ready');
  });
  it('N2-D12 unresolved windows retain exact evidence beyond ordinary history retention', async () => {
    const h = harness(); await h.feed.start();
    h.feed.retainWindows([{ marketId: 'btc-usd', startMs: (epoch - 10) * 1000, endMs: (epoch - 5) * 1000 }]);
    h.advance(200000); await h.feed.pollMarket('btc-usd');
    expect(h.feed.getSamples('btc-usd', (epoch - 10) * 1000, (epoch - 5) * 1000)).toHaveLength(5);
    expect(h.feed.getSamples('btc-usd', (epoch - 20) * 1000, (epoch - 15) * 1000)).toHaveLength(0);
  });
});
