// Shared readers for the Maya market log (market-data branch) and the fast touch rule used to
// label cells. Settlement in the house simulator uses the exact @maya/contracts implementation;
// tooling/calibrate/check-touch.mjs proves this float version agrees with it.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const BAND = Object.freeze({ 'btc-usd': 10, 'eth-usd': 0.5 });
export const WINDOWS = 6;
export const OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
export const WINDOW_S = 5;

function files(root, kind, market) {
  return readdirSync(root, { recursive: true })
    .filter((f) => f.endsWith('.csv.gz') && f.replaceAll('\\', '/').split('/').pop().startsWith(`${kind}-${market}-`))
    .map((f) => join(root, f)).sort();
}
function rows(file) { return gunzipSync(readFileSync(file)).toString('utf8').trim().split('\n').slice(1); }

/** First-seen price per source second; the game plays on `first` and ignores later revisions. */
export function loadPath(root, market) {
  const path = new Map();
  for (const f of files(root, 'prices', market)) for (const line of rows(f)) {
    const [t, first, final] = line.split(',');
    const p = Number(first || final);
    if (!path.has(+t) && Number.isFinite(p) && p > 0) path.set(+t, p);
  }
  return path;
}

/** One row per quote instant. `mult` holds the recorded model's multiplier ×100 (negative = unavailable). */
export function loadQuoteRows(root, market) {
  const seen = new Set(); const out = [];
  for (const f of files(root, 'odds', market)) for (const line of rows(f)) {
    const c = line.split(','); const t = +c[0];
    if (seen.has(t)) continue; seen.add(t);
    const mult = new Int32Array(42); for (let i = 0; i < 42; i++) mult[i] = Math.round(+c[6 + i]);
    out.push({ t, ageMs: +c[1], spot: +c[2], sigma: +c[3], start: +c[4], bucket: +c[5], mult });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * maya-observed-linear-v2 on 1 s points: straight segments between adjacent seconds, inclusive band
 * [L, U], half-open window [s, e). Returns 1 hit, 0 miss, -1 unresolved (a needed point is missing).
 */
export function touches(path, s, e, L, U) {
  let missing = false;
  for (let k = s - 1; k < e; k++) {
    const pa = path.get(k), pb = path.get(k + 1);
    if (pa === undefined || pb === undefined) { missing = true; continue; }
    let enter = Math.max(0, s - k), exit = Math.min(1, e - k);
    const d = pb - pa;
    if (d === 0) { if (pa < L || pa > U) continue; }
    else { const a = (L - pa) / d, b = (U - pa) / d; enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b)); }
    if (enter <= exit && enter < e - k) return 1;
  }
  return missing ? -1 : 0;
}

/**
 * Realized volatility of 1 s log returns over the trailing `windowS` seconds, per √s.
 * Returns a function t → sigma (NaN when fewer than minCount returns exist).
 */
export function realizedVol(path, windowS = 300, minCount = 60) {
  let t0 = Infinity, t1 = -Infinity; for (const t of path.keys()) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
  const n = t1 - t0 + 1; const sq = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const t = t0 + i - 1, a = path.get(t - 1), b = path.get(t);
    const r = a !== undefined && b !== undefined ? Math.log(b / a) : NaN;
    sq[i] = sq[i - 1] + (Number.isFinite(r) ? r * r : 0); cnt[i] = cnt[i - 1] + (Number.isFinite(r) ? 1 : 0);
  }
  return (t) => {
    const hi = Math.min(n, t - t0 + 1), lo = Math.max(0, hi - windowS);
    if (hi <= 0) return NaN;
    const c = cnt[hi] - cnt[lo]; return c >= minCount ? Math.sqrt((sq[hi] - sq[lo]) / c) : NaN;
  };
}
