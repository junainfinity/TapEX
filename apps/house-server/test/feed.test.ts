import { describe, expect, it } from 'vitest';
import { getMarket } from '@maya/config';
import { loadMarketRows, logCoverage } from '../src/feed/csv.js';
import { LiveFeed, parseRelayPrices } from '../src/feed/live.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { T0, logRows, tempDir, walk, writeMarketLog } from './helpers.js';

describe('ReplayFeed', () => {
  const path = walk({ t0: T0 - 100, seconds: 400, start: 60_000, sigma: 3e-5, seed: 3, gaps: [[T0 + 50, T0 + 60]] });

  it('delivers first-seen rows at source time + lag, deterministically, with warm-up history and lookahead', () => {
    const make = () => new ReplayFeed([{ market: 'btc-usd', rows: logRows(path, 700) }], { markets: ['btc-usd'], fromMs: T0 * 1000, warmupS: 100 });
    const a = make(), b = make();
    expect(a.history('btc-usd')).toHaveLength(100);
    expect(a.advance(T0 * 1000 + 699)).toEqual([]);
    const first = a.advance(T0 * 1000 + 700);
    expect(first.map(s => [s.t, s.priceText, s.receivedAtMs])).toEqual([[T0, path.get(T0)!, T0 * 1000 + 700]]);
    expect(a.peek('btc-usd', T0 + 1)).toBe(Number(path.get(T0 + 1)));
    const seqA: string[] = [], seqB: string[] = [];
    for (let ms = T0 * 1000 + 950; !a.done; ms += 250) { seqA.push(...a.advance(ms).map(s => `${s.t}@${s.receivedAtMs}`)); }
    b.advance(T0 * 1000 + 700);
    for (let ms = T0 * 1000 + 950; !b.done; ms += 250) { seqB.push(...b.advance(ms).map(s => `${s.t}@${s.receivedAtMs}`)); }
    expect(seqA).toEqual(seqB);
    expect(seqA.some(x => x.startsWith(`${T0 + 55}@`))).toBe(false);
    expect(a.advance(a.nowMs() - 1)).toEqual([]);
  });

  it('reads recorder gz segments, de-duplicating repeated seconds and keeping the first row', () => {
    const root = tempDir();
    writeMarketLog(root, { 'btc-usd': path });
    const rows = loadMarketRows(root, 'btc-usd', (T0 - 100) * 1000, (T0 + 300) * 1000);
    expect(rows.length).toBe(path.size);
    expect(rows[0]).toEqual({ t: T0 - 100, priceText: path.get(T0 - 100)!, lagMs: 800 });
    expect(logCoverage(root, 'btc-usd')?.fromMs).toBe((T0 - 100) * 1000);
    const feed = ReplayFeed.load(root, { markets: ['btc-usd'], fromMs: T0 * 1000, toMs: (T0 + 10) * 1000, warmupS: 50 });
    expect(feed.history('btc-usd')).toHaveLength(50);
    expect(feed.remaining).toBe(10);
  });
});

describe('LiveFeed', () => {
  const market = getMarket('btc-usd');
  const body = (prices: string) => `{"chain":"bsc","pair":1,"feedId":"${market.feedId.toUpperCase().replace('0X', '0x')}","count":3,"prices":[${prices}]}`;

  it('parses the relay payload keeping exact price lexemes', () => {
    const parsed = parseRelayPrices(body(`{"t":${T0 + 1},"p":60000.123456789012},{"t":${T0},"p":59999.1},{"t":${T0 + 2},"p":6.0001e4}`), market);
    expect(parsed.map(p => [p.t, p.priceText])).toEqual([[T0, '59999.1'], [T0 + 1, '60000.123456789012'], [T0 + 2, '6.0001e4']]);
    expect(parsed[1]!.price).toEqual({ coefficient: '60000123456789012', exponent: -12 });
  });

  it('rejects authority and shape mismatches', () => {
    expect(() => parseRelayPrices(body('{"t":1,"p":1},{"t":2,"p":2},{"t":3,"p":3}').replace('"pair":1', '"pair":2'), market)).toThrow(/authority/);
    expect(() => parseRelayPrices(body('{"t":1,"p":1},{"t":2,"p":2}'), market)).toThrow(/size/);
    expect(() => parseRelayPrices(body('{"t":1,"p":"1"},{"t":2,"p":2},{"t":3,"p":3}'), market)).toThrow(/lexeme/);
    expect(() => parseRelayPrices(body('{"t":1,"p":-1},{"t":2,"p":2},{"t":3,"p":3}'), market)).toThrow(/positive/);
    expect(() => parseRelayPrices(body('{"t":1.5,"p":1},{"t":2,"p":2},{"t":3,"p":3}'), market)).toThrow(/integer/);
  });

  it('polls the relay and emits each second once (first-seen pin)', async () => {
    let now = (T0 + 3) * 1000;
    let payload = body(`{"t":${T0},"p":1},{"t":${T0 + 1},"p":2},{"t":${T0 + 2},"p":3}`);
    const urls: string[] = [];
    const feed = new LiveFeed({ relayUrl: 'http://127.0.0.1:8787/', markets: ['btc-usd'], now: () => now, fetch: async (url) => { urls.push(url); return new Response(payload, { status: 200 }); } });
    await feed.pollMarket('btc-usd');
    expect(urls).toEqual(['http://127.0.0.1:8787/api/prices/1']);
    expect(feed.advance().map(s => [s.t, s.priceText])).toEqual([[T0, '1'], [T0 + 1, '2'], [T0 + 2, '3']]);
    payload = body(`{"t":${T0 + 1},"p":9},{"t":${T0 + 2},"p":3},{"t":${T0 + 3},"p":4}`);
    now += 1000;
    await feed.pollMarket('btc-usd');
    expect(feed.advance().map(s => [s.t, s.priceText])).toEqual([[T0 + 3, '4']]);
    const failing = new LiveFeed({ relayUrl: 'http://x', markets: ['btc-usd'], fetch: async () => new Response('{}', { status: 503 }) });
    await failing.pollMarket('btc-usd');
    expect(failing.status().markets[0]!.lastError).toMatch(/503/);
  });
});
