import { describe, expect, it } from 'vitest';
import { getMarket } from '@maya/config';
import { HermesSseReference, SseDecoder, hermesStreamUrl, parseHermesEvent, type ReferencePrice } from '../src/feed/reference.js';
import { loadConfig } from '../src/config.js';

const BTC = getMarket('btc-usd').feedId.replace(/^0x/, '');
const ETH = getMarket('eth-usd').feedId.replace(/^0x/, '');
const ids = new Map([[BTC, 'btc-usd' as const], [ETH, 'eth-usd' as const]]);
const event = (entries: readonly unknown[]) => JSON.stringify({ binary: { encoding: 'hex', data: ['00'] }, parsed: entries });
const entry = (id: string, price: string, expo: number, publishTime: number, conf = '1000000') => ({ id, price: { price, conf, expo, publish_time: publishTime }, ema_price: { price, conf, expo, publish_time: publishTime }, metadata: { slot: 1 } });

describe('Pyth Hermes parsing', () => {
  it('builds the stream URL from the configured Pyth feed ids', () => {
    const url = hermesStreamUrl('https://hermes.example/', ['btc-usd', 'eth-usd']);
    expect(url).toBe(`https://hermes.example/v2/updates/price/stream?ids[]=${BTC}&ids[]=${ETH}&parsed=true&allow_unordered=false&benchmarks_only=false`);
  });

  it('scales integer mantissas by expo and skips unknown, malformed or non-positive entries', () => {
    const prices = parseHermesEvent(event([
      entry(BTC, '6512345678901', -8, 1_790_000_000), entry(`0x${ETH}`, '251234000000', -8, 1_790_000_001, '5000000'),
      entry('ff'.repeat(32), '1', 0, 1), entry(BTC, '12.5', -8, 1), entry(BTC, '-5', -8, 1), { id: BTC, price: { price: '1', expo: 'x', publish_time: 1 } }, null,
    ]), ids, 42);
    expect(prices).toEqual([
      { market: 'btc-usd', value: 6512345678901 * 1e-8, publishTimeMs: 1_790_000_000_000, receivedAtMs: 42, conf: 1_000_000 * 1e-8 },
      { market: 'eth-usd', value: 251234000000 * 1e-8, publishTimeMs: 1_790_000_001_000, receivedAtMs: 42, conf: 5_000_000 * 1e-8 },
    ]);
    expect(parseHermesEvent('{"parsed":"nope"}', ids, 1)).toEqual([]);
    expect(() => parseHermesEvent('x'.repeat(300_000), ids, 1)).toThrow(/size bound/);
  });

  it('decodes text/event-stream across chunk boundaries, CRLF, comments and multi-line data', () => {
    const d = new SseDecoder();
    expect(d.push(': keep-alive\n\ndata: {"a"')).toEqual([]);
    expect(d.push(':1}\r\n\r\nevent: price_update\ndata: line1\ndata: line2\n')).toEqual([{ event: 'message', data: '{"a":1}' }]);
    expect(d.push('\n')).toEqual([{ event: 'price_update', data: 'line1\nline2' }]);
  });
});

/** A fetch whose response body streams the given chunks, then closes (or errors). */
function fakeFetch(streams: readonly (readonly string[])[], calls: string[]): (input: string, init?: RequestInit) => Promise<Response> {
  let n = 0;
  return async (input: string, init?: RequestInit) => {
    calls.push(input);
    const chunks = streams[Math.min(n++, streams.length - 1)]!;
    const encoder = new TextEncoder();
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (init?.signal?.aborted) { controller.error(new Error('aborted')); return; }
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

describe('Hermes SSE reference feed', () => {
  it('emits parsed prices, never steps back in publisher time, reconnects after the stream closes and stops cleanly', async () => {
    const calls: string[] = [];
    const s1 = [`data: ${event([entry(BTC, '6500000000000', -8, 100)])}\n\n`, `data: ${event([entry(BTC, '6499000000000', -8, 99), entry(ETH, '250000000000', -8, 100)])}\n`, '\n'];
    const s2 = ['data: not json\n\n', `data: ${event([entry(BTC, '6501000000000', -8, 101)])}\n\n`];
    const feed = new HermesSseReference({ markets: ['btc-usd', 'eth-usd'], baseUrl: 'https://hermes.test', fetch: fakeFetch([s1, s2], calls), backoffMs: 5, maxBackoffMs: 10, now: () => 7 });
    const seen: ReferencePrice[] = [];
    feed.onPrice(p => seen.push(p));
    await feed.start();
    const deadline = Date.now() + 2000;
    while (seen.length < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
    await feed.stop();
    expect(seen.map(p => [p.market, p.value, p.publishTimeMs])).toEqual([['btc-usd', 65000, 100_000], ['eth-usd', 2500, 100_000], ['btc-usd', 65010, 101_000]]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toBe(hermesStreamUrl('https://hermes.test', ['btc-usd', 'eth-usd']));
    const status = feed.status();
    expect(status).toMatchObject({ source: 'pyth-hermes-sse', prices: 3, lastMessageMs: 7 });
    expect(status.reconnects).toBeGreaterThanOrEqual(1);
    expect(status.markets).toEqual([{ market: 'btc-usd', lastPublishMs: 101_000, value: 65010 }, { market: 'eth-usd', lastPublishMs: 100_000, value: 2500 }]);
    expect(status.lastError).toBeDefined();
  });

  it('is configured for live mode only', () => {
    expect(loadConfig({ MAYA_FEED: 'live' })).toMatchObject({ ok: true, config: { referenceFeed: 'hermes', hermesUrl: 'https://hermes.pyth.network' } });
    expect(loadConfig({})).toMatchObject({ ok: true, config: { referenceFeed: 'off' } });
    expect(loadConfig({ MAYA_FEED: 'live', MAYA_REFERENCE_FEED: 'off' })).toMatchObject({ ok: true, config: { referenceFeed: 'off' } });
    const bad = loadConfig({ MAYA_REFERENCE_FEED: 'hermes' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/not used in replay/);
  });
});
