import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createReplaySource } from './replay.mjs';
import { createBinanceSource } from './binance.mjs';

const dataDir = new URL('../data/', import.meta.url);
const staticBytes = { '/api/config': readFileSync(new URL('maya-config.json', dataDir)), '/api/table': readFileSync(new URL('maya-domain-table.json', dataDir)) };
const priceRoutes = Object.freeze({ '/api/prices/1': 1, '/api/prices/2': 2 });
const PRICE_TTL_MS = 600;

export function createSource(mode, options = {}) {
  if (mode === 'replay') return createReplaySource(options);
  if (mode === 'binance') return createBinanceSource(options);
  throw new Error(`Unknown FEED_SOURCE "${mode}" (expected replay | binance)`);
}

/** Fixed GET-only relay. Config and domain table are bundled (self-generated); prices come from the selected source:
 * FEED_SOURCE=replay (default, offline bundled recording) or FEED_SOURCE=binance (public live market data). */
export function createRelayServer({ source = (process.env.FEED_SOURCE ?? 'replay'), fetchImpl, wallNow, now = () => performance.now() } = {}) {
  const feed = typeof source === 'string' ? createSource(source, { ...(fetchImpl ? { fetchImpl } : {}), ...(wallNow ? { wallNow } : {}) }) : source;
  const cache = new Map(), pending = new Map(), failures = new Map();
  async function readPrices(path, pairId) {
    const hit = cache.get(path);
    if (hit && now() - hit.fetchedAtMs < PRICE_TTL_MS) return hit;
    if (pending.has(path)) return pending.get(path);
    const failed = failures.get(path);
    if (failed && now() < failed.retryAtMs) throw failed.error;
    const task = (async () => { const item = { ...(await feed.prices(pairId, now)), fetchedAtMs: now() }; cache.set(path, item); failures.delete(path); return item; })();
    pending.set(path, task);
    try { return await task; }
    catch (error) { failures.set(path, { error, retryAtMs: now() + (error.retryAfter ?? 2) * 1000 }); throw error; }
    finally { pending.delete(path); }
  }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ok', mode: 'public-read-only', source: feed.name })); return; }
    if (staticBytes[req.url]) {
      const bytes = staticBytes[req.url];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'X-Maya-Upstream-Date': new Date().toUTCString(), 'X-Maya-Upstream-Rtt-Ms': '0', 'X-Maya-Upstream-Age-Ms': '0' });
      res.end(bytes); return;
    }
    const pairId = priceRoutes[req.url];
    if (!pairId) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"Unknown public read route"}'); return; }
    try {
      const item = await readPrices(req.url, pairId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': item.bytes.length, 'X-Maya-Feed-Source': feed.name, 'X-Maya-Upstream-Date': item.upstreamDate, 'X-Maya-Upstream-Rtt-Ms': String(Math.round(item.upstreamRttMs)), 'X-Maya-Upstream-Age-Ms': String(Math.max(0, Math.round(now() - item.fetchedAtMs))) });
      res.end(item.bytes);
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(error.retryAfter ?? 2), ...(error.upstreamStatus ? { 'X-Maya-Upstream-Status': String(error.upstreamStatus) } : {}) });
      res.end(JSON.stringify({ error: 'Price source unavailable', source: feed.name, detail: String(error.message ?? error), ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }));
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createRelayServer();
  server.listen(port, '0.0.0.0', () => console.log(`Maya read relay listening on ${port} (FEED_SOURCE=${process.env.FEED_SOURCE ?? 'replay'})`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
}
