/** Deterministic PRNG (mulberry32) with the few distributions the crowd simulator needs. */
export class Prng {
  private state: number;
  constructor(seed: number | string) {
    let s = typeof seed === 'number' ? seed >>> 0 : 0;
    if (typeof seed === 'string') for (let i = 0; i < seed.length; i++) s = Math.imul(s ^ seed.charCodeAt(i), 2654435761) >>> 0;
    this.state = s || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  int(lo: number, hi: number): number { return Math.floor(this.uniform(lo, hi + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  /** Exponential with the given mean. */
  exp(mean: number): number { return -Math.log(1 - this.next()) * mean; }
  /** Log-uniform on [lo, hi]. */
  logUniform(lo: number, hi: number): number { return Math.exp(this.uniform(Math.log(lo), Math.log(hi))); }
  /** Poisson (Knuth for small means, normal approximation above 30). */
  poisson(mean: number): number {
    if (!(mean > 0)) return 0;
    if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
    const limit = Math.exp(-mean); let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > limit);
    return k - 1;
  }
  normal(): number { const u = Math.max(this.next(), 1e-12), v = this.next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  pick<T>(items: readonly T[]): T | undefined { return items.length ? items[Math.floor(this.next() * items.length)] : undefined; }
  weighted<T extends string>(weights: Readonly<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) { r -= w; if (r < 0) return k; }
    return entries.at(-1)![0];
  }
}
