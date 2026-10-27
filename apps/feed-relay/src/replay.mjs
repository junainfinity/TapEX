import { readFileSync } from 'node:fs';
import { MARKETS, priceBuffer, BUFFER_SECONDS } from './markets.mjs';

const dataDir = new URL('../data/', import.meta.url);
/** Load a bundled recording: { market, intervalS: 1, prices: ["65000.12", ...] }. */
export function loadRecording(id) {
  const rec = JSON.parse(readFileSync(new URL(`replay-${id}.json`, dataDir), 'utf8'));
  if (rec.intervalS !== 1 || !Array.isArray(rec.prices) || rec.prices.length < 60 || rec.prices.some(p => !/^\d+(\.\d+)?$/.test(p))) throw new Error(`Invalid replay recording ${id}`);
  return rec;
}
/** Offline replay source. Recording is played ping-pong (forward, then reversed) so the loop has no price jump;
 * sample timestamps are the relay's current wall-clock seconds, so the client sees a live-looking 1 s feed. */
export function createReplaySource({ wallNow = () => Date.now(), recordings } = {}) {
  const recs = recordings ?? { 1: loadRecording('btc-usd'), 2: loadRecording('eth-usd') };
  const at = (prices, second) => { const n = prices.length, period = 2 * (n - 1), k = ((second % period) + period) % period; return prices[k < n ? k : period - k]; };
  return {
    name: 'replay',
    async prices(pairId) {
      const market = MARKETS[pairId]; const rec = recs[pairId];
      const nowMs = wallNow(); const last = Math.floor(nowMs / 1000) - 1;
      const rows = []; for (let t = last - BUFFER_SECONDS + 1; t <= last; t++) rows.push({ p: at(rec.prices, t), t });
      return { bytes: Buffer.from(priceBuffer(market, rows)), upstreamDate: new Date(nowMs).toUTCString(), upstreamRttMs: 0 };
    },
  };
}
