import type { ClockSnapshot } from '@maya/contracts';

/** UTC intervals from an upstream HTTP Date; never align 'now' to a price sample. */
export class SourceClock {
  private low = 0;
  private high = 0;
  private atMono = 0;
  private anchored = false;
  private incompatible = false;
  private invalidated = false;
  constructor(private readonly monotonic: () => number = () => performance.now()) {}
  invalidate(): void { this.invalidated = true; }
  observe(date: string, upstreamRttMs: number, upstreamAgeMs: number, requestRttMs: number): void {
    const dateMs = Date.parse(date);
    if (!Number.isFinite(dateMs) || ![upstreamRttMs, upstreamAgeMs, requestRttMs].every((n) => Number.isFinite(n) && n >= 0) || requestRttMs > 5000 || upstreamRttMs > 5000 || upstreamAgeMs > 5000) throw new Error('Clock evidence is unavailable or too uncertain');
    const now = this.monotonic();
    const low = dateMs + upstreamAgeMs;
    const high = dateMs + 1000 + upstreamRttMs + upstreamAgeMs + requestRttMs;
    if (this.anchored && now - this.atMono < 6000) {
      const previousLow = this.low + now - this.atMono;
      const previousHigh = this.high + now - this.atMono;
      const nextLow = Math.max(low, previousLow);
      const nextHigh = Math.min(high, previousHigh);
      if (nextLow <= nextHigh) { this.low = nextLow; this.high = nextHigh; this.incompatible = false; }
      else { this.low = low; this.high = high; this.incompatible = true; }
    } else { this.low = low; this.high = high; this.incompatible = false; }
    this.atMono = now; this.anchored = true; this.invalidated = false;
  }
  getClock(): ClockSnapshot {
    const age = this.monotonic() - this.atMono;
    return { nowMs: this.anchored ? Math.floor((this.low + this.high) / 2 + age) : Date.now(), uncertaintyMs: this.anchored ? Math.ceil((this.high - this.low) / 2) : Infinity, ready: this.anchored && !this.invalidated && !this.incompatible && age >= 0 && age <= 6000 && this.high - this.low <= 3000 };
  }
}
