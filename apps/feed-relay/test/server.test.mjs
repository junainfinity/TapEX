import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRelayServer, createSource } from '../src/server.mjs';
import { createReplaySource } from '../src/replay.mjs';
async function listening(t, options) {
  const server = createRelayServer(options); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();}); return `http://127.0.0.1:${server.address().port}`;
}
const klines = (startMs, closes) => JSON.stringify(closes.map((c,i)=>[startMs+i*1000,c,c,c,c,'1',startMs+i*1000+999,'1',1,'0','0','0']));

test('R1 default source is offline replay; no network fetch is ever made', async t => {
  const fetchImpl = async () => { throw new Error('network must not be used'); };
  const wall = Date.parse('2026-10-26T12:00:10Z');
  const base = await listening(t, { fetchImpl, wallNow: () => wall });
  const health = await (await fetch(`${base}/health`)).json(); assert.equal(health.source, 'replay');
  const r = await fetch(`${base}/api/prices/1`); assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-maya-feed-source'), 'replay'); assert.equal(r.headers.get('x-maya-upstream-date'), new Date(wall).toUTCString());
  const body = JSON.parse(await r.text());
  assert.equal(body.chain, 'bsc'); assert.equal(body.pair, 1); assert.equal(body.count, body.prices.length); assert.equal(body.prices.at(-1).t, wall / 1000 - 1);
  for (let i = 1; i < body.prices.length; i++) assert.equal(body.prices[i].t - body.prices[i-1].t, 1);
});
test('R2 replay advances with wall clock and loops without a jump', async () => {
  const rec = { intervalS: 1, prices: ['1', '2', '3', '4'] }; let wall = 1_000_000;
  const src = createReplaySource({ wallNow: () => wall, recordings: { 1: rec, 2: rec } });
  const seq = []; for (let s = 0; s < 8; s++) { wall = (1000 + s) * 1000 + 1000; const b = JSON.parse((await src.prices(1)).bytes.toString()); seq.push(b.prices.at(-1).p); }
  for (let i = 1; i < seq.length; i++) assert.equal(Math.abs(seq[i] - seq[i-1]), 1);
});
test('R3 config and domain table are bundled and pass client shape checks', async t => {
  const base = await listening(t, {});
  const c = await (await fetch(`${base}/api/config`)).json();
  assert.equal(c.chain, 'bsc'); assert.ok(c.boxSecondsWidths.includes(5)); assert.equal(c.pricing.formulaVersion, '3.0.0'); assert.equal(c.pairs['2'].symbol, 'ETH/USD');
  const tbl = await (await fetch(`${base}/api/table`)).json();
  assert.equal(tbl.version, '2'); assert.equal(tbl.table.length, tbl.zCenterAxis.length*tbl.zHeightAxis.length*tbl.rAxis.length*tbl.uAxis.length);
});
test('R4 fixed allowlist / GET only', async t => {
  const base = await listening(t, {});
  assert.equal((await fetch(`${base}/api/prices/1?url=evil`)).status, 404); assert.equal((await fetch(`${base}/api/prices/3`)).status, 404);
  assert.equal((await fetch(`${base}/api/prices/1`, { method: 'POST' })).status, 405);
  assert.throws(() => createSource('lynx'), /Unknown FEED_SOURCE/);
});
test('B1 binance live adapter (mocked) maps klines to the price buffer with upstream Date and caches 600 ms', async t => {
  let calls = 0, mono = 0; const urls = [];
  const fetchImpl = async url => { calls++; urls.push(url); return new Response(klines(1792000000000, ['65000.12000000', '65001.00000000', '64999.50000000']), { headers: { date: 'Mon, 26 Oct 2026 06:30:00 GMT' } }); };
  const base = await listening(t, { source: 'binance', fetchImpl, now: () => mono });
  const a = await fetch(`${base}/api/prices/2`); assert.equal(a.status, 200);
  assert.match(urls[0], /symbol=ETHUSDT&interval=1s/); assert.equal(a.headers.get('x-maya-upstream-date'), 'Mon, 26 Oct 2026 06:30:00 GMT');
  const text = await a.text(); assert.match(text, /"prices":\[\{"p":65000\.12,"t":1792000000\},\{"p":65001,"t":1792000001\}/);
  assert.equal(JSON.parse(text).pair, 2);
  mono = 300; const b = await fetch(`${base}/api/prices/2`); assert.equal(b.headers.get('x-maya-upstream-age-ms'), '300'); assert.equal(calls, 1);
  mono = 601; await fetch(`${base}/api/prices/2`); assert.equal(calls, 2);
});
test('B2 binance rate limit surfaces as 503 with bounded retry backoff', async t => {
  let calls = 0, mono = 0;
  const base = await listening(t, { source: 'binance', now: () => mono, fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '4' } }); } });
  const a = await fetch(`${base}/api/prices/1`); assert.equal(a.status, 503); assert.equal(a.headers.get('x-maya-upstream-status'), '429'); assert.equal(a.headers.get('retry-after'), '4');
  mono = 2000; await fetch(`${base}/api/prices/1`); assert.equal(calls, 1); mono = 4001; await fetch(`${base}/api/prices/1`); assert.equal(calls, 2);
});
test('B3 binance missing Date header fails closed; concurrent readers share one request', async t => {
  let calls = 0, release; const wait = new Promise(r => release = r);
  const base = await listening(t, { source: 'binance', fetchImpl: async () => { calls++; await wait; return new Response(klines(0, ['1', '2'])); } });
  const reqs = [fetch(`${base}/api/prices/1`), fetch(`${base}/api/prices/1`)]; await new Promise(r => setTimeout(r, 20)); release();
  const [x] = await Promise.all(reqs); assert.equal(calls, 1); assert.equal(x.status, 503); assert.match((await x.json()).detail, /Date header/);
});
