import { observedSampleId, type DecimalValue, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import type { PathView } from '@maya/house';

/** A pinned first-seen observation (maya-observed-linear-v2 evidence). */
export interface PinnedSample {
  readonly marketId: MarketId;
  readonly t: number;
  readonly sourceTimeMs: number;
  readonly priceText: string;
  readonly price: DecimalValue;
  readonly value: number;
  readonly receivedAtMs: number;
  readonly sampleId: string;
}

export type PinResult = { readonly pinned: true; readonly sample: PinnedSample } | { readonly pinned: false; readonly conflict: boolean };

/**
 * First-seen 1 s path for one market. The first value stored for a second is final: later
 * revisions are ignored (and counted when they disagree), exactly as the game settles.
 */
export class PathStore implements PathView {
  readonly market: MarketId;
  private readonly feedId: string;
  private readonly samples = new Map<number, PinnedSample>();
  /** Plain second → price projection handed to pricing and refit. */
  readonly values = new Map<number, number>();
  private latestT: number | undefined;
  conflicts = 0;

  constructor(market: MarketId) { this.market = market; this.feedId = getMarket(market).feedId; }

  get(t: number): number | undefined { return this.values.get(t); }
  sample(t: number): PinnedSample | undefined { return this.samples.get(t); }
  has(t: number): boolean { return this.samples.has(t); }
  get size(): number { return this.samples.size; }
  latest(): PinnedSample | undefined { return this.latestT === undefined ? undefined : this.samples.get(this.latestT); }

  pin(input: { readonly t: number; readonly priceText: string; readonly price: DecimalValue; readonly value: number; readonly receivedAtMs: number }): PinResult {
    const existing = this.samples.get(input.t);
    if (existing) {
      const conflict = existing.priceText !== input.priceText;
      if (conflict) this.conflicts++;
      return { pinned: false, conflict };
    }
    if (!Number.isSafeInteger(input.t) || input.t <= 0 || !(input.value > 0) || !Number.isFinite(input.value)) return { pinned: false, conflict: false };
    const sourceTimeMs = input.t * 1000;
    const sample: PinnedSample = Object.freeze({
      marketId: this.market, t: input.t, sourceTimeMs, priceText: input.priceText, price: input.price, value: input.value,
      receivedAtMs: input.receivedAtMs, sampleId: observedSampleId({ feedId: this.feedId, sourceTimeMs }),
    });
    this.samples.set(input.t, sample); this.values.set(input.t, input.value);
    if (this.latestT === undefined || input.t > this.latestT) this.latestT = input.t;
    return { pinned: true, sample };
  }

  /** Drop seconds before `floorT` (insertion is near-chronological; stragglers are swept too). */
  prune(floorT: number): void {
    for (const t of this.samples.keys()) {
      if (t >= floorT) continue;
      this.samples.delete(t); this.values.delete(t);
    }
  }
}
