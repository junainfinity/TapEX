import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TouchProbabilityModel, ewmaSigma } from '../dist/model.js';
const dir = resolve(process.argv[2] ?? 'artifacts/verification/n2/live-capture');
const stabilizationS = Number(process.argv[3] ?? 0);
const records = readFileSync(resolve(dir, 'responses.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
const config = JSON.parse(readFileSync(resolve(dir, 'config.json'), 'utf8'));
const model = new TouchProbabilityModel(JSON.parse(readFileSync(resolve(dir, 'table.json'), 'utf8')));
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? null;
const report = { generatedAt: new Date().toISOString(), status: 'observed-capture-only', stabilizationS, config: { formulaVersion: config.pricing.formulaVersion, edge: config.pricing.houseEdge, minDelay: config.minDelay }, markets: {} };
for (const pair of [1, 2]) {
  const observations = records.filter((r) => r.name === `pair-${pair}` && r.status === 200).map((r) => ({ ...r, data: JSON.parse(r.body) }));
  const seen = new Map();
  const finalized = new Map();
  let conflicts = 0, finalizedConflicts = 0;
  const revisionAges = {};
  const lags = [], gaps = [];
  for (const row of observations) {
    const latest = row.data.prices.at(-1);
    lags.push(row.receivedAtMs - latest.t * 1000);
    for (let i = 0; i < row.data.prices.length; i++) {
      const s = row.data.prices[i];
      if (seen.has(s.t) && seen.get(s.t) !== s.p) { conflicts++; const age=latest.t-s.t; revisionAges[age]=(revisionAges[age]??0)+1; }
      seen.set(s.t, s.p);
      if(s.t <= latest.t - stabilizationS){if(finalized.has(s.t)&&finalized.get(s.t)!==s.p)finalizedConflicts++;else finalized.set(s.t,s.p);}
      if (i > 0) gaps.push(s.t - row.data.prices[i - 1].t);
    }
  }
  let instants = 0, healthy = 0, useful = 0, cursor = 0;
  const reasons = {}, rowsAvailable = [];
  const start = observations[0]?.receivedAtMs ?? 0;
  const end = observations.at(-1)?.receivedAtMs ?? start;
  for (let now = start; now <= end; now += 100) {
    while (cursor + 1 < observations.length && observations[cursor + 1].receivedAtMs <= now) cursor++;
    const row = observations[cursor];
    const stablePrices = row.data.prices.filter(s=>s.t<=row.data.prices.at(-1).t-stabilizationS);
    const latest = stablePrices.at(-1);
    instants++;
    // Conservative upstream-Date interval at response receipt, propagated to evaluation.
    const upperNow = Date.parse(row.headers.date) + 1000 + row.rttMs + now - row.receivedAtMs;
    if (upperNow - latest.t * 1000 > (4000+stabilizationS*1000) || upperNow < latest.t * 1000) continue;
    healthy++;
    const step = pair === 1 ? 10 : 0.5;
    const sigma = ewmaSigma(stablePrices.map((s) => ({ sourceTimeMs: s.t * 1000, value: s.p })));
    const first = (Math.floor((upperNow + config.minDelay * 1000) / 5000) + 1) * 5000;
    const center = Math.floor(latest.p / step);
    let available = 0;
    const windows = new Set();
    for (let col = 0; col < 6; col++) for (let offset = -3; offset <= 3; offset++) {
      const startMs = first + col * 5000;
      const result = model.preview({ spot: latest.p, lower: (center + offset) * step, upper: (center + offset + 1) * step, timeToStartS: (startMs - latest.t * 1000) / 1000, widthS: 5, sigmaPerSqrtSec: sigma, settleDtS: 1, houseEdge: config.pricing.houseEdge, minimumGross: config.pricing.minPayoutX });
      if (result.available) { available++; windows.add(col); } else reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
    }
    rowsAvailable.push(available);
    if (available >= 3 && windows.size >= 2) useful++;
  }
  report.markets[pair === 1 ? 'BTC/USD' : 'ETH/USD'] = {
    responses: observations.length, uniqueSourceTimestamps: seen.size, provisionalRevisions: conflicts, revisionAgesS:revisionAges, finalizedConflicts,
    elapsedMs: end - start, httpFailures: records.filter((r) => r.name === `pair-${pair}` && r.status !== 200).length,
    receiptLagMs: { p50: percentile(lags, .5), p95: percentile(lags, .95), max: Math.max(...lags) },
    requestRttMs: { p50: percentile(observations.map((r) => r.rttMs), .5), p95: percentile(observations.map((r) => r.rttMs), .95), max: Math.max(...observations.map((r) => r.rttMs)) },
    sourceGapS: { min: Math.min(...gaps), max: Math.max(...gaps) },
    candidateCoverage: { instants, healthy, useful, ratio: healthy ? useful / healthy : 0, medianEligible: percentile(rowsAvailable, .5), minimumEligible: Math.min(...rowsAvailable), reasons },
  };
}
writeFileSync(resolve(dir, stabilizationS ? `analysis-stabilized-${stabilizationS}s.json` : 'analysis.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
