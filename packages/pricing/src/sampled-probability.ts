/**
 * Deterministic first-hit Gaussian quadrature for a zero-drift log-price model.
 * Observations are exactly start, start+dt, ... strictly before end.
 * No simulated path or random win/loss is generated in the playable application.
 */
const rules = new Map<number, { nodes: Float64Array; weights: Float64Array }>();
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);
function normalDensity(x: number, variance: number): number { return INV_SQRT_2PI / Math.sqrt(variance) * Math.exp(-x * x / (2 * variance)); }
export function gaussLegendre(order: number): { nodes: Float64Array; weights: Float64Array } {
  const previous = rules.get(order); if (previous) return previous;
  const nodes = new Float64Array(order), weights = new Float64Array(order);
  for (let i = 0; i < Math.ceil(order / 2); i++) {
    let z = Math.cos(Math.PI * (i + .75) / (order + .5)), derivative = 0;
    for (let iteration = 0; iteration < 40; iteration++) {
      let p0 = 1, p1 = z;
      for (let degree = 2; degree <= order; degree++) { const p2 = ((2 * degree - 1) * z * p1 - (degree - 1) * p0) / degree; p0 = p1; p1 = p2; }
      derivative = order * (z * p1 - p0) / (z * z - 1);
      const next = z - p1 / derivative;
      if (Math.abs(next - z) < 1e-15) { z = next; break; }
      z = next;
    }
    const weight = 2 / ((1 - z * z) * derivative * derivative);
    nodes[i] = -z; nodes[order - 1 - i] = z;
    weights[i] = weight; weights[order - 1 - i] = weight;
  }
  const result = { nodes, weights }; rules.set(order, result); return result;
}

export interface SampledProbabilityInput {
  zLower: number;
  zUpper: number;
  timeToStartS: number;
  windowS: number;
  observationIntervalS: number;
  /** Developer convergence checking only; production chooses a bounded adaptive order. */
  order?: number;
}
export interface SampledProbabilityResult { probability: number; quadratureOrder: number; observationCount: number; maxNegativeDensity: number }

export function sampledBandProbability(p: SampledProbabilityInput): SampledProbabilityResult {
  if (![p.zLower, p.zUpper, p.timeToStartS, p.windowS, p.observationIntervalS].every(Number.isFinite) || p.zUpper < p.zLower || p.timeToStartS <= 0 || p.windowS <= 0 || p.observationIntervalS <= 0) throw new Error('Invalid sampled model input');
  const observationCount = p.windowS / p.observationIntervalS;
  if (!Number.isInteger(observationCount) || observationCount < 1 || observationCount > 10) throw new Error('Unsupported observation phase/count');
  if (p.zUpper === p.zLower) return { probability: 0, quadratureOrder: 0, observationCount, maxNegativeDensity: 0 };
  const deltaVariance = p.observationIntervalS / p.timeToStartS;
  const width = p.zUpper - p.zLower;
  // Resolution grows with band width measured in one-step standard deviations.
  // The 1.6 factor fixes the broad-band / long-horizon convergence failure found
  // by the independent domain-grid check; production remains bounded at 384.
  const order = p.order ?? Math.min(384, Math.max(32, Math.ceil(32 + 1.6 * width / Math.sqrt(deltaVariance))));
  if (!Number.isInteger(order) || order < 16 || order > 768) throw new Error('Unsupported quadrature order');
  const rule = gaussLegendre(order);
  const half = width / 2, center = (p.zUpper + p.zLower) / 2;
  const x = Float64Array.from(rule.nodes, (n) => center + half * n);
  const w = Float64Array.from(rule.weights, (weight) => half * weight);
  // First-hit renewal identity: unconditional in-band density at j minus each
  // disjoint earlier first-hit density propagated freely from i to j.
  const kernels: Float64Array[] = [];
  for (let lag = 1; lag < observationCount; lag++) {
    const kernel = new Float64Array(order * order);
    for (let y = 0; y < order; y++) for (let xx = 0; xx < order; xx++) kernel[y * order + xx] = w[xx]! * normalDensity(x[y]! - x[xx]!, lag * deltaVariance);
    kernels.push(kernel);
  }
  const firstHit: Float64Array[] = [];
  let probability = 0, maxNegativeDensity = 0;
  for (let observation = 0; observation < observationCount; observation++) {
    const density = new Float64Array(order);
    for (let y = 0; y < order; y++) {
      let value = normalDensity(x[y]!, 1 + observation * deltaVariance);
      for (let earlier = 0; earlier < observation; earlier++) {
        const kernel = kernels[observation - earlier - 1]!;
        const old = firstHit[earlier]!;
        let removed = 0;
        for (let xx = 0; xx < order; xx++) removed += old[xx]! * kernel[y * order + xx]!;
        value -= removed;
      }
      maxNegativeDensity = Math.max(maxNegativeDensity, -value);
      if (value < -1e-8) throw new Error('Sampled probability quadrature did not converge');
      density[y] = Math.max(0, value);
      probability += density[y]! * w[y]!;
    }
    firstHit.push(density);
  }
  if (!Number.isFinite(probability) || probability < -1e-8 || probability > 1 + 1e-8) throw new Error('Sampled probability is outside [0,1]');
  return { probability: Math.max(0, Math.min(1, probability)), quadratureOrder: order, observationCount, maxNegativeDensity };
}
