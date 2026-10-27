import { bucketIndex, decimalToNumber, parseDecimal, type DecimalValue, type PriceSample } from '@maya/contracts';

/** First-seen 1 s price path keyed by integer Unix seconds. A `Map<number, number>` satisfies it. */
export interface PathView { get(t: number): number | undefined }

export const WINDOW_S = 5;
export const WINDOWS = 6;
export const BAND_OFFSETS = Object.freeze([-3, -2, -1, 0, 1, 2, 3] as const);
export const GRID_CELLS = WINDOWS * BAND_OFFSETS.length;
export const MIN_LEAD_S = 3;
export const H10 = Object.freeze({ lag: 10, windowS: 600, minPairs: 30 });
/**
 * Fallback estimator: the recorded game model's EWMA (λ 0.94, ≈16 s effective horizon) over the
 * trailing 68 one-second samples, exactly as PaperQuoteBook and the recorder computed it.
 */
export const EWMA = Object.freeze({ lambda: 0.94, samples: 68 });

/**
 * h10 volatility per √s: RMS of ln(P(t')/P(t'−10)) over t' ∈ (t−600, t], divided by √10.
 * Undefined with fewer than 30 pairs.
 */
export function h10Sigma(path: PathView, t: number): number | undefined {
  if (!Number.isSafeInteger(t)) return undefined;
  let sum = 0, count = 0;
  for (let u = t - H10.windowS + 1; u <= t; u++) {
    const b = path.get(u); if (b === undefined) continue;
    const a = path.get(u - H10.lag); if (a === undefined) continue;
    const r = Math.log(b / a);
    if (Number.isFinite(r)) { sum += r * r; count++; }
  }
  return count >= H10.minPairs ? Math.sqrt(sum / count / H10.lag) : undefined;
}

/** Same semantics as packages/pricing/src/model.ts `ewmaSigma` (reimplemented: @maya/house may not depend on @maya/pricing). */
export function ewmaSigma(samples: readonly { readonly sourceTimeMs: number; readonly value: number }[], lambda: number = EWMA.lambda): number {
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

/**
 * `ewmaSigma` over the path samples in [t − samples + 1, t] without allocating (bit-identical
 * arithmetic). Undefined when that window holds no usable return.
 */
export function ewmaSigmaAt(path: PathView, t: number, samples: number = EWMA.samples, lambda: number = EWMA.lambda): number | undefined {
  if (!Number.isSafeInteger(t) || !(lambda >= 0 && lambda < 1)) return undefined;
  let variance = 0, initialized = false, prevT = 0, prevValue: number | undefined;
  for (let u = t - samples + 1; u <= t; u++) {
    const value = path.get(u); if (value === undefined) continue;
    if (prevValue !== undefined) {
      const dt = (u * 1000 - prevT * 1000) / 1000;
      if (dt > 0 && prevValue > 0 && value > 0) {
        const r = Math.log(value / prevValue);
        const perSecond = r * r / dt;
        variance = initialized ? lambda * variance + (1 - lambda) * perSecond : perSecond;
        initialized = true;
      }
    }
    prevT = u; prevValue = value;
  }
  return initialized ? Math.sqrt(variance) : undefined;
}

export type SigmaSource = 'h10' | 'ewma';
export type SigmaEstimate =
  | { readonly ok: true; readonly sigma: number; readonly source: SigmaSource }
  | { readonly ok: false; readonly reason: 'insufficient-history' | 'invalid-volatility' };

/** fit.mjs fallback rule: h10 when finite and positive, else the EWMA; neither positive → no quote. */
export function quoteSigma(path: PathView, t: number): SigmaEstimate {
  const h10 = h10Sigma(path, t);
  if (h10 !== undefined && Number.isFinite(h10) && h10 > 0) return { ok: true, sigma: h10, source: 'h10' };
  const ewma = ewmaSigmaAt(path, t);
  if (ewma !== undefined && Number.isFinite(ewma) && ewma > 0) return { ok: true, sigma: ewma, source: 'ewma' };
  return { ok: false, reason: h10 === undefined && ewma === undefined ? 'insufficient-history' : 'invalid-volatility' };
}

/**
 * Exact band index of a model price. The price is read through its shortest round-trip decimal,
 * which is the recorded decimal for any feed price with ≤ 15 significant digits.
 */
export function exactBucket(spot: number | DecimalValue, bandHeight: DecimalValue): bigint {
  if (typeof spot === 'number') {
    if (!Number.isFinite(spot)) throw new RangeError('Spot must be finite');
    return bucketIndex(parseDecimal(String(spot)), bandHeight);
  }
  return bucketIndex(spot, bandHeight);
}

export interface ScaledFeatures { readonly s: number; readonly frac: number; readonly bucket: number }
/** s = sigma × spot / h; frac = spot / h − bucket (float, as fit.mjs; cellKey clamps frac). */
export function scaledFeatures(sigma: number, spot: number, bandHeight: number, bucket: number): ScaledFeatures {
  return { s: (sigma * spot) / bandHeight, frac: spot / bandHeight - bucket, bucket };
}

export interface GridWindow { readonly w: number; readonly start: number; readonly end: number; readonly tau: number }
/** start0 = ceil((t + 3) / 5) × 5; window w covers [start0 + 5w, start0 + 5w + 5); tau = start − t. */
export function windowGrid(t: number): { readonly start0: number; readonly windows: readonly GridWindow[] } {
  if (!Number.isSafeInteger(t)) throw new RangeError('Quote instant must be an integer second');
  const start0 = Math.ceil((t + MIN_LEAD_S) / WINDOW_S) * WINDOW_S;
  const windows = Array.from({ length: WINDOWS }, (_, w) => {
    const start = start0 + WINDOW_S * w;
    return Object.freeze({ w, start, end: start + WINDOW_S, tau: start - t });
  });
  return Object.freeze({ start0, windows: Object.freeze(windows) });
}

/**
 * First-seen path from validated samples: the first value stored for each whole second wins and
 * later revisions are ignored, as the game and settlement do.
 */
export function pathFromSamples(samples: Iterable<Pick<PriceSample, 'sourceTimeMs' | 'price'>>): Map<number, number> {
  const path = new Map<number, number>();
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.sourceTimeMs) || sample.sourceTimeMs % 1000 !== 0) continue;
    const t = sample.sourceTimeMs / 1000;
    if (path.has(t)) continue;
    const price = decimalToNumber(sample.price);
    if (Number.isFinite(price) && price > 0) path.set(t, price);
  }
  return path;
}
