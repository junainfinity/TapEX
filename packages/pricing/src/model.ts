/** Adapted from Lynx SDK 0.0.1-alpha.1; see ../LICENSE-LYNX and ../NOTICE.md. */
import { sampledBandProbability } from './sampled-probability.js';
import { linearBandProbability } from './linear-probability.js';
export interface ProbabilityTableJSON {
  version: string;
  zCenterAxis: number[];
  zHeightAxis: number[];
  rAxis: number[];
  uAxis: number[];
  table: number[];
}
export interface ModelInputs {
  spot: number;
  lower: number;
  upper: number;
  timeToStartS: number;
  widthS: number;
  sigmaPerSqrtSec: number;
  settleDtS: number;
  houseEdge: number;
  minimumGross: number;
}
export type PreviewResult =
  | { available: true; probability: number; grossX100: string; coordinates: readonly number[] }
  | { available: false; reason: 'invalid-input' | 'invalid-volatility' | 'out-of-domain' | 'unreachable' | 'below-minimum' | 'unsafe-numeric-range'; coordinates?: readonly number[] };

function axis(value: unknown, name: string): asserts value is number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 200 || value.some((n, i) => !Number.isFinite(n) || (i > 0 && n <= value[i - 1]))) throw new Error(`Invalid model ${name}`);
}
export function validateProbabilityTable(value: unknown): ProbabilityTableJSON {
  if (!value || typeof value !== 'object') throw new Error('Missing model table');
  const v = value as ProbabilityTableJSON;
  if (String(v.version) !== '2') throw new Error('Unsupported model table version');
  for (const key of ['zCenterAxis', 'zHeightAxis', 'rAxis', 'uAxis'] as const) axis(v[key], key);
  const expected = v.zCenterAxis.length * v.zHeightAxis.length * v.rAxis.length * v.uAxis.length;
  if (!Array.isArray(v.table) || v.table.length !== expected || expected > 1_000_000 || v.table.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error('Invalid model table probabilities/dimensions');
  return v;
}
function bracket(a: readonly number[], x: number): [number, number, number] {
  let hi = 1;
  while (hi < a.length - 1 && a[hi]! <= x) hi++;
  const lo = hi - 1;
  return [lo, hi, (x - a[lo]!) / (a[hi]! - a[lo]!)];
}
/** Explicit domain guards deliberately replace the upstream SDK's silent clamps. */
export class TouchProbabilityModel {
  readonly data: ProbabilityTableJSON;
  constructor(data: unknown) { this.data = validateProbabilityTable(data); }
  lookup(coordinates: readonly number[]): number | null {
    const d = this.data;
    const axes = [d.zCenterAxis, d.zHeightAxis, d.rAxis, d.uAxis];
    if (coordinates.length !== 4 || coordinates.some((v, i) => !Number.isFinite(v) || v < axes[i]![0]! || v > axes[i]!.at(-1)!)) return null;
    const bs = axes.map((a, i) => bracket(a, coordinates[i]!));
    let probability = 0;
    for (let mask = 0; mask < 16; mask++) {
      let index = 0;
      let weight = 1;
      for (let dim = 0; dim < 4; dim++) {
        const upper = (mask >> dim) & 1;
        const [lo, hi, t] = bs[dim]!;
        index = index * axes[dim]!.length + (upper ? hi : lo);
        weight *= upper ? t : 1 - t;
      }
      if (weight !== 0) probability += weight * d.table[index]!;
    }
    // Only a tiny arithmetic residue is normalized; input coordinates are never clamped.
    if (probability > 1 && probability <= 1 + 1e-14) return 1;
    if (probability < 0 && probability >= -1e-14) return 0;
    return probability;
  }
  preview(p: ModelInputs): PreviewResult {
    if (!Object.values(p).every(Number.isFinite) || p.spot <= 0 || p.lower <= 0 || p.upper <= p.lower || p.timeToStartS <= 0 || p.widthS <= 0 || p.settleDtS <= 0 || p.houseEdge < 0 || p.houseEdge >= 1 || p.minimumGross < 1) return { available: false, reason: 'invalid-input' };
    if (p.sigmaPerSqrtSec <= 0) return { available: false, reason: 'invalid-volatility' };
    const scale = p.sigmaPerSqrtSec * Math.sqrt(p.timeToStartS);
    const zl = Math.log(p.lower / p.spot) / scale;
    const zu = Math.log(p.upper / p.spot) / scale;
    const coordinates = [(zl + zu) / 2, (zu - zl) / 2, (p.timeToStartS + p.widthS) / p.timeToStartS, Math.sqrt(p.settleDtS / p.widthS)];
    const probability = this.lookup(coordinates);
    if (probability === null) return { available: false, reason: 'out-of-domain', coordinates };
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) return { available: false, reason: 'invalid-input', coordinates };
    if (probability === 0) return { available: false, reason: 'unreachable', coordinates };
    const gross = floorGrossHundredths(probability, p.houseEdge);
    if (gross < BigInt(Math.ceil(p.minimumGross * 100))) return { available: false, reason: 'below-minimum', coordinates };
    if (gross > BigInt(Number.MAX_SAFE_INTEGER)) return { available: false, reason: 'unsafe-numeric-range', coordinates };
    return { available: true, probability, grossX100: gross.toString(), coordinates };
  }
  /** Maya's exact five-observation event; published table is a domain reference only. */
  previewSampled(p: ModelInputs): PreviewResult { return this.previewPath(p,false); }
  previewLinear(p: ModelInputs): PreviewResult { return this.previewPath(p,true); }
  private previewPath(p:ModelInputs,linear:boolean):PreviewResult {
    if (!Object.values(p).every(Number.isFinite) || p.spot <= 0 || p.lower <= 0 || p.upper <= p.lower || p.timeToStartS <= 0 || p.widthS !== 5 || p.settleDtS !== 1 || p.houseEdge < 0 || p.houseEdge >= 1 || p.minimumGross < 1) return { available: false, reason: 'invalid-input' };
    if (p.sigmaPerSqrtSec <= 0) return { available: false, reason: 'invalid-volatility' };
    const scale = p.sigmaPerSqrtSec * Math.sqrt(p.timeToStartS);
    const zLower = Math.log(p.lower / p.spot) / scale;
    const zUpper = Math.log(p.upper / p.spot) / scale;
    const monitoredSpan = linear?p.widthS:p.widthS-p.settleDtS;
    const coordinates = [(zLower + zUpper) / 2, (zUpper - zLower) / 2, (p.timeToStartS + monitoredSpan) / p.timeToStartS, Math.sqrt(p.settleDtS / monitoredSpan)];
    if (this.lookup(coordinates) === null) return { available: false, reason: 'out-of-domain', coordinates };
    let probability: number;
    try { probability = (linear?linearBandProbability:sampledBandProbability)({ zLower, zUpper, timeToStartS: p.timeToStartS, windowS: p.widthS, observationIntervalS: p.settleDtS }).probability; }
    catch { return { available: false, reason: 'unsafe-numeric-range', coordinates }; }
    if (probability <= 0) return { available: false, reason: 'unreachable', coordinates };
    const gross = floorGrossHundredths(probability, p.houseEdge);
    if (gross < BigInt(Math.ceil(p.minimumGross * 100))) return { available: false, reason: 'below-minimum', coordinates };
    if (gross > BigInt(Number.MAX_SAFE_INTEGER)) return { available: false, reason: 'unsafe-numeric-range', coordinates };
    return { available: true, probability, grossX100: gross.toString(), coordinates };
  }
}

function ratio(n: number): [bigint, bigint] {
  const match = String(n).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error('Cannot represent positive model number');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0) - fraction.length;
  const numerator = BigInt(match[1]! + fraction);
  return exponent >= 0 ? [numerator * 10n ** BigInt(exponent), 1n] : [numerator, 10n ** BigInt(-exponent)];
}
/** Decimal-rational floor of the computed probability, with no hidden display precision. */
export function floorGrossHundredths(probability: number, edge: number): bigint {
  if (!(probability > 0 && probability <= 1 && edge >= 0 && edge < 1)) throw new Error('Invalid probability or edge');
  const [pn, pd] = ratio(probability);
  const [en, ed] = ratio(edge);
  return ((ed - en) * pd * 100n) / (ed * pn);
}
export function ewmaSigma(samples: readonly { sourceTimeMs: number; value: number }[], lambda = 0.94): number {
  if (!(lambda >= 0 && lambda < 1)) throw new Error('Invalid EWMA lambda');
  let variance = 0;
  let initialized = false;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const current = samples[i]!;
    const dt = (current.sourceTimeMs - prev.sourceTimeMs) / 1000;
    if (!(dt > 0 && prev.value > 0 && current.value > 0)) continue;
    const r = Math.log(current.value / prev.value);
    const perSecond = r * r / dt;
    variance = initialized ? lambda * variance + (1 - lambda) * perSecond : perSecond;
    initialized = true;
  }
  return Math.sqrt(variance);
}
