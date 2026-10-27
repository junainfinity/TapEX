// Fits the empirical touch-probability table `maya-calibrated-v3` from the Maya market log and
// reports out-of-sample returns to player (RTP): a fixed split and a rolling walk-forward that
// refits every few hours, as the live house would. A backtest is not a guarantee: it covers one
// market regime and uniform betting.
//
//   node tooling/calibrate/fit.mjs <market-data dir> [--out packages/house/data] [--sigma h10]
//        [--train-hours 36] [--refit-hours 6] [--edge 0.08] [--z 0.5]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BAND, OFFSETS, WINDOWS, WINDOW_S, loadPath, loadQuoteRows, realizedVol, touches } from './market-log.mjs';

export const SPEC = Object.freeze({
  modelId: 'maya-calibrated-v3', ruleVersion: 'maya-observed-linear-v2',
  tauMin: 3, tauMax: 32, bMax: 3, sigmaBins: 12, fracBins: 5, prior: Number(process.env.MAYA_PRIOR ?? 10),
});
const TAUS = SPEC.tauMax - SPEC.tauMin + 1, B = SPEC.bMax + 1, S = SPEC.sigmaBins, F = SPEC.fracBins;
const L0 = TAUS * B, L1 = L0 * S, L2 = L1 * F;

/** Volatility estimators, all per √s on log prices. h10 = 10 s displacements over the last 10 min. */
export const SIGMA_MODES = {
  ewma: 'recorded 16 s EWMA of 1 s returns (the current game model)',
  rv300: '300 s realized vol of 1 s returns',
  h10: 'RMS of 10 s log displacements over the trailing 600 s, divided by √10',
  h10blend: 'sqrt(0.5*h10^2 + 0.5*ewma^2)',
};
function sigmaFns(path) {
  const rv = realizedVol(path, 300, 60);
  const h10 = displacementVol(path, 10, 600, 30);
  return {
    ewma: (row) => row.sigma, rv300: (row) => fallback(rv(row.t), row.sigma), h10: (row) => fallback(h10(row.t), row.sigma),
    h10blend: (row) => Math.sqrt(0.5 * fallback(h10(row.t), row.sigma) ** 2 + 0.5 * row.sigma ** 2),
  };
}
const fallback = (v, f) => (Number.isFinite(v) && v > 0 ? v : f);
function displacementVol(path, lag, windowS, minCount) {
  let t0 = Infinity, t1 = -Infinity; for (const t of path.keys()) { if (t < t0) t0 = t; if (t > t1) t1 = t; }
  const n = t1 - t0 + 1; const sq = new Float64Array(n + 1), cnt = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) {
    const t = t0 + i - 1, a = path.get(t - lag), b = path.get(t);
    const r = a !== undefined && b !== undefined ? Math.log(b / a) : NaN;
    sq[i] = sq[i - 1] + (Number.isFinite(r) ? r * r : 0); cnt[i] = cnt[i - 1] + (Number.isFinite(r) ? 1 : 0);
  }
  return (t) => {
    const hi = Math.min(n, t - t0 + 1), lo = Math.max(0, hi - windowS); if (hi <= 0) return NaN;
    const c = cnt[hi] - cnt[lo]; return c >= minCount ? Math.sqrt((sq[hi] - sq[lo]) / c / lag) : NaN;
  };
}

/** Everything expensive (labels, features) computed once per market. */
export function prepare(root, market) {
  const h = BAND[market]; const path = loadPath(root, market); const rows = loadQuoteRows(root, market);
  let lastT = 0; for (const k of path.keys()) if (k > lastT) lastT = k;
  const usable = rows.filter((r) => r.start + WINDOW_S * WINDOWS + 1 <= lastT && r.sigma > 0);
  const labels = usable.map((r) => {
    const out = new Int8Array(42);
    for (let w = 0; w < WINDOWS; w++) for (let bi = 0; bi < 7; bi++) {
      const s = r.start + WINDOW_S * w; const L = (r.bucket + OFFSETS[bi]) * h; out[w * 7 + bi] = touches(path, s, s + WINDOW_S, L, L + h);
    }
    return out;
  });
  return { market, h, path, rows: usable, labels, sigma: sigmaFns(path) };
}

function binOf(edges, v) { let i = 0; while (i < edges.length && v >= edges[i]) i++; return i; }
/** Table key for one cell; shared definition with packages/house (golden rows pin it). */
export function cellKey({ s, frac, tau, b }, edges) {
  if (tau < SPEC.tauMin || tau > SPEC.tauMax || Math.abs(b) > SPEC.bMax) return -1;
  const bAbs = Math.abs(b); const f = b < 0 ? 1 - frac : frac;
  return ((((tau - SPEC.tauMin) * B + bAbs) * S + binOf(edges, s)) * F) + Math.min(F - 1, Math.floor(Math.min(0.999999, Math.max(0, f)) * F));
}
function cellFeatures(data, mode, i) {
  const r = data.rows[i]; const sig = data.sigma[mode](r);
  return { s: (sig * r.spot) / data.h, frac: r.spot / data.h - r.bucket };
}

export function fit(data, mode, idx) {
  const sv = idx.map((i) => cellFeatures(data, mode, i).s).sort((a, b) => a - b);
  const edges = Array.from({ length: S - 1 }, (_, k) => sv[Math.floor(((k + 1) / S) * sv.length)]);
  const c = { h0: new Float64Array(L0), n0: new Float64Array(L0), h1: new Float64Array(L1), n1: new Float64Array(L1), h2: new Float64Array(L2), n2: new Float64Array(L2) };
  for (const i of idx) {
    const r = data.rows[i]; const f = cellFeatures(data, mode, i);
    for (let w = 0; w < WINDOWS; w++) for (let bi = 0; bi < 7; bi++) {
      const hit = data.labels[i][w * 7 + bi]; if (hit < 0) continue;
      const k2 = cellKey({ ...f, tau: r.start + WINDOW_S * w - r.t, b: OFFSETS[bi] }, edges); if (k2 < 0) continue;
      const k1 = Math.floor(k2 / F), k0 = Math.floor(k1 / S);
      c.n0[k0]++; c.h0[k0] += hit; c.n1[k1]++; c.h1[k1] += hit; c.n2[k2]++; c.h2[k2] += hit;
    }
  }
  return { edges, counts: c };
}

/** Smoothed fair probability (hierarchical prior), monotone in band distance, plus its std error. */
export function smooth(counts) {
  const p = new Float64Array(L2), se = new Float64Array(L2);
  for (let k2 = 0; k2 < L2; k2++) {
    const k1 = Math.floor(k2 / F), k0 = Math.floor(k1 / S);
    const p0 = counts.n0[k0] ? counts.h0[k0] / counts.n0[k0] : 0.5;
    const p1 = (counts.h1[k1] + SPEC.prior * p0) / (counts.n1[k1] + SPEC.prior);
    p[k2] = (counts.h2[k2] + SPEC.prior * p1) / (counts.n2[k2] + SPEC.prior);
  }
  for (let tau = 0; tau < TAUS; tau++) for (let s = 0; s < S; s++) for (let f = 0; f < F; f++) for (let b = 1; b < B; b++) {
    const k = ((tau * B + b) * S + s) * F + f, prev = ((tau * B + b - 1) * S + s) * F + f; if (p[k] > p[prev]) p[k] = p[prev];
  }
  for (let k = 0; k < L2; k++) se[k] = Math.sqrt((p[k] * (1 - p[k])) / (counts.n2[k] + SPEC.prior));
  return { p, se };
}
/** Offered gross multiplier ×100 (includes stake), or -1 when the cell is not offered. */
export function multiplierX100(p, se, pricing) {
  const q = Math.min(1, p + pricing.z * se);
  if (!(q > 0)) return -1;
  const m = Math.floor((100 * (1 - pricing.edge)) / q + 1e-9);
  if (m < pricing.minX100) return -1;
  // Above the cap a square is either hidden (fair to players) or shown at the cap (house keeps the gap).
  return m > pricing.capX100 ? (pricing.aboveCap === 'cap' ? pricing.capX100 : -1) : m;
}

const MULT = [[101, 200], [200, 500], [500, 1000], [1000, 2000], [2000, 5001]];
const blank = () => ({ bets: 0, paid: 0, hits: 0, pSum: 0 });
function score(data, mode, model, idx, pricing, acc) {
  const sm = model.smoothed ??= smooth(model.counts);
  for (const i of idx) {
    const r = data.rows[i]; const f = cellFeatures(data, mode, i);
    for (let w = 0; w < WINDOWS; w++) for (let bi = 0; bi < 7; bi++) {
      const hit = data.labels[i][w * 7 + bi]; if (hit < 0) continue;
      const k = cellKey({ ...f, tau: r.start + WINDOW_S * w - r.t, b: OFFSETS[bi] }, model.edges); if (k < 0) continue;
      acc.cells++; const old = r.mult[w * 7 + bi]; if (old > 0) add(acc.recorded, old, hit, 0);
      const x = multiplierX100(sm.p[k], sm.se[k], pricing); if (x < 0) continue;
      acc.offered++; add(acc.all, x, hit, sm.p[k]); add(acc.byMult[MULT.findIndex(([a, z]) => x >= a && x < z)], x, hit, sm.p[k]);
      add(acc.byBand[Math.abs(OFFSETS[bi])], x, hit, sm.p[k]);
    }
  }
}
function add(a, x100, hit, p) { a.bets++; a.pSum += p; if (hit) { a.hits++; a.paid += x100 / 100; } }
const newAcc = () => ({ all: blank(), recorded: blank(), byMult: MULT.map(blank), byBand: Array.from({ length: B }, blank), cells: 0, offered: 0 });
const sum = (a) => ({ bets: a.bets, rtp: +(a.paid / a.bets).toFixed(4), hitRate: +(a.hits / a.bets).toFixed(4), meanFairP: +(a.pSum / a.bets).toFixed(4) });
function summarize(acc) {
  return { offeredShare: +(acc.offered / acc.cells).toFixed(4), rtp: sum(acc.all), recordedModelRtp: sum(acc.recorded).rtp,
    byMultiplier: acc.byMult.map((a, i) => ({ rangeX: MULT[i].map((x) => x / 100).join('-'), share: +(a.bets / acc.all.bets).toFixed(4), ...sum(a) })),
    byBandDistance: acc.byBand.map((a, i) => ({ bandsAway: i, ...sum(a) })) };
}

/** Rolling walk-forward: train on the trailing `trainHours`, price the next `refitHours`, repeat. */
export function walkForward(data, mode, pricing, trainHours, refitHours) {
  const acc = newAcc(); const t0 = data.rows[0].t, tEnd = data.rows.at(-1).t; let folds = 0;
  for (let cut = t0 + trainHours * 3600; cut < tEnd; cut += refitHours * 3600) {
    const trainIdx = [], testIdx = [];
    data.rows.forEach((r, i) => { if (r.t >= cut - trainHours * 3600 && r.t < cut - 40) trainIdx.push(i); else if (r.t >= cut && r.t < cut + refitHours * 3600) testIdx.push(i); });
    if (!testIdx.length) continue;
    score(data, mode, fit(data, mode, trainIdx), testIdx, pricing, acc); folds++;
  }
  return { folds, ...summarize(acc) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (name, fallbackValue) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallbackValue; };
  const root = args[0] && !args[0].startsWith('--') ? args[0] : '../market-data';
  const outDir = opt('out', 'packages/house/data');
  const modes = opt('sigma', 'h10').split(',');
  const pricing = { edge: Number(opt('edge', '0.08')), z: Number(opt('z', '0')), minX100: 101, capX100: Number(opt('cap', '5000')), aboveCap: opt('above-cap', 'hide') };
  const trainHours = Number(opt('train-hours', '36')), refitHours = Number(opt('refit-hours', '6'));
  mkdirSync(outDir, { recursive: true });
  const report = { spec: SPEC, pricing, trainHours, refitHours, markets: {} };
  for (const market of ['btc-usd', 'eth-usd']) {
    const data = prepare(root, market); report.markets[market] = {};
    for (const mode of modes) report.markets[market][mode] = walkForward(data, mode, pricing, trainHours, refitHours);
    // Publish a table fitted on the most recent `trainHours`, as the live house would run it.
    const mode = modes[0]; const tEnd = data.rows.at(-1).t;
    const idx = data.rows.flatMap((r, i) => (r.t >= tEnd - trainHours * 3600 ? [i] : []));
    const model = fit(data, mode, idx); const sm = smooth(model.counts);
    const golden = []; for (let i = idx[0]; i < data.rows.length && golden.length < 48; i += 977) {
      const r = data.rows[i]; const f = cellFeatures(data, mode, i); const w = golden.length % WINDOWS, bi = golden.length % 7;
      const k = cellKey({ ...f, tau: r.start + WINDOW_S * w - r.t, b: OFFSETS[bi] }, model.edges); if (k < 0) continue;
      golden.push({ s: f.s, frac: f.frac, tau: r.start + WINDOW_S * w - r.t, b: OFFSETS[bi], key: k, p: sm.p[k], se: sm.se[k], x100: multiplierX100(sm.p[k], sm.se[k], pricing) });
    }
    writeFileSync(join(outDir, `${SPEC.modelId}-${market}.json`), JSON.stringify({ ...SPEC, sigmaMode: mode, sigmaDefinition: SIGMA_MODES[mode], pricing, market, bandHeight: data.h,
      trainedFrom: new Date(data.rows[idx[0]].t * 1000).toISOString(), trainedThrough: new Date(tEnd * 1000).toISOString(),
      source: 'Maya market log: Lynx public buffer, first-seen 1 s prices', sigmaEdges: model.edges, counts: Object.fromEntries(Object.entries(model.counts).map(([k, v]) => [k, [...v]])), golden }));
  }
  console.log(JSON.stringify(report, null, 1));
}
