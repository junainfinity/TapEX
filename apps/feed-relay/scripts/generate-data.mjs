// Regenerates every bundled file in ../data. All output is self-generated (no third-party data) and dedicated CC0-1.0.
// Usage: node scripts/generate-data.mjs   (deterministic: fixed seeds)
import { writeFileSync } from 'node:fs';
import { MARKETS } from '../src/markets.mjs';
const out = (name, value) => writeFileSync(new URL(`../data/${name}`, import.meta.url), JSON.stringify(value) + '\n');

// 1) Pricing configuration served at /api/config (operator-owned defaults; edit to recalibrate).
out('maya-config.json', {
  source: 'maya-self-generated', licence: 'CC0-1.0', chain: 'bsc', boxSecondsWidths: [5], minDelay: 3,
  pairs: Object.fromEntries(Object.values(MARKETS).map(m => [String(m.pairId), { symbol: m.symbol, feedId: m.feedId }])),
  pricing: { formulaVersion: '3.0.0', houseEdge: 0.1, minPayoutX: 1.01 },
});

// 2) Domain table served at /api/table. The runtime prices with Maya's own path model (pricing/previewLinear);
// this table only bounds the quotable domain. Values: reflection-principle touch approximation.
const lin = (a, b, n) => Array.from({ length: n }, (_, i) => +(a + (b - a) * i / (n - 1)).toFixed(6));
const zCenterAxis = lin(-8, 8, 33), zHeightAxis = lin(0.01, 6, 17), rAxis = lin(1.01, 6, 15), uAxis = lin(0.05, 1, 8);
const phi = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); }
const table = [];
for (const zc of zCenterAxis) for (const zh of zHeightAxis) for (const r of rAxis) for (const u of uAxis) {
  // Reflection-principle touch probability of the nearer band edge by normalised horizon r (u ignored: approximation).
  const dist = Math.max(0, Math.abs(zc) - zh);
  table.push(+Math.min(1, 2 * (1 - phi(dist / Math.sqrt(r)))).toFixed(5));
}
out('maya-domain-table.json', { version: '2', source: 'maya-self-generated', licence: 'CC0-1.0', zCenterAxis, zHeightAxis, rAxis, uAxis, table });

// 3) Replay recordings: seeded synthetic GBM, 1 s steps, 1 hour each.
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function gbm({ seed, start, sigma, n, dp }) {
  const r = rng(seed); let p = start; const prices = [];
  for (let i = 0; i < n; i++) { prices.push(p.toFixed(dp)); const z = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); p *= Math.exp(sigma * z - sigma * sigma / 2); }
  return prices;
}
for (const [id, cfg] of [['btc-usd', { seed: 20261026, start: 65000, sigma: 0.00012, n: 3600, dp: 2 }], ['eth-usd', { seed: 20261027, start: 3000, sigma: 0.00016, n: 3600, dp: 2 }]])
  out(`replay-${id}.json`, { market: id, intervalS: 1, source: 'maya-self-generated synthetic GBM', licence: 'CC0-1.0', generator: 'apps/feed-relay/scripts/generate-data.mjs', params: cfg, prices: gbm(cfg) });
console.log('data regenerated');
