import type { MarketId } from '@maya/contracts';
import { MULTIPLIER_RANGES, rangeKeyOf, type MultiplierRange } from '@maya/house';

export type Phase = 'launch' | 'standard';

export type { MultiplierRange };
/** §7 ranges (x100, lower inclusive, upper exclusive); 50× itself belongs to 20-50. One source with the edge controller. */
export const RTP_RANGES: readonly MultiplierRange[] = MULTIPLIER_RANGES;
export function rangeOf(x100: number): string { return rangeKeyOf(x100); }

export interface RtpRow {
  readonly key: string;
  readonly phase?: Phase;
  readonly bets: number;
  readonly handleCenti: string;
  readonly returnedCenti: string;
  readonly expected: number;
  readonly realized: number | null;
  readonly expectedLow: number;
  readonly expectedHigh: number;
  readonly wins: number;
  readonly refunds: number;
  /** RTP the pricing policy promised these legs: stake-weighted 1 − (phase edge + drawdown widening). */
  readonly policyTarget?: number | null;
}

/** Settled (won/lost) aggregates; refunds are counted apart and excluded from RTP. */
export class RtpAgg {
  bets = 0;
  handle = 0n;
  returned = 0n;
  expectedReturn = 0;
  variance = 0;
  wins = 0;
  refunds = 0;
  refundedStake = 0n;
  policyReturn = 0;
  add(stake: bigint, x100: number, p: number, credit: bigint, status: 'won' | 'lost' | 'refunded', policyRtp?: number): void {
    if (status === 'refunded') { this.refunds++; this.refundedStake += stake; return; }
    const s = Number(stake), m = x100 / 100;
    this.bets++; this.handle += stake; this.returned += credit;
    if (status === 'won') this.wins++;
    this.expectedReturn += s * m * p;
    this.variance += s * s * m * m * p * (1 - p);
    this.policyReturn += s * (policyRtp ?? m * p);
  }
  /** Expected RTP uses the calibrated fair p of each leg; the band is ±2 standard errors. */
  row(key: string, extra: { readonly phase?: Phase } = {}): RtpRow {
    const h = Number(this.handle);
    const expected = h > 0 ? this.expectedReturn / h : 0;
    const se = h > 0 ? Math.sqrt(this.variance) / h : 0;
    return {
      key, ...extra, bets: this.bets, handleCenti: this.handle.toString(), returnedCenti: this.returned.toString(),
      expected, realized: h > 0 ? Number(this.returned) / h : null, expectedLow: Math.max(0, expected - 2 * se), expectedHigh: expected + 2 * se,
      wins: this.wins, refunds: this.refunds, policyTarget: h > 0 ? this.policyReturn / h : null,
    };
  }
}

/** Fixed-capacity ring buffer. */
export class Ring<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;
  constructor(readonly capacity: number) { this.items = new Array<T | undefined>(capacity); }
  push(item: T): void {
    this.items[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) this.count++; else this.head = (this.head + 1) % this.capacity;
  }
  get size(): number { return this.count; }
  at(i: number): T | undefined { return i < 0 || i >= this.count ? undefined : this.items[(this.head + i) % this.capacity]; }
  toArray(): T[] { const out: T[] = []; for (let i = 0; i < this.count; i++) out.push(this.items[(this.head + i) % this.capacity]!); return out; }
  last(): T | undefined { return this.count ? this.at(this.count - 1) : undefined; }
}

interface MinuteSlot { minute: number; handle: bigint; settled: bigint; returned: bigint; bets: number }
const DAY_MINUTES = 1440;

/** Rolling 24 h handle / GGR / RTP from per-minute slots (the clock only moves forward). */
export class Rolling24h {
  private readonly slots: MinuteSlot[] = Array.from({ length: DAY_MINUTES }, () => ({ minute: -1, handle: 0n, settled: 0n, returned: 0n, bets: 0 }));
  handle = 0n; settled = 0n; returned = 0n; bets = 0;
  private slot(ms: number): MinuteSlot | undefined {
    const minute = Math.floor(ms / 60_000);
    const s = this.slots[((minute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES]!;
    if (s.minute !== minute) {
      if (s.minute > minute) return undefined; // older than the window
      this.clear(s); s.minute = minute;
    }
    return s;
  }
  private clear(s: MinuteSlot): void {
    this.handle -= s.handle; this.settled -= s.settled; this.returned -= s.returned; this.bets -= s.bets;
    s.minute = -1; s.handle = 0n; s.settled = 0n; s.returned = 0n; s.bets = 0;
  }
  addBet(ms: number, stake: bigint): void { const s = this.slot(ms); if (!s) return; s.handle += stake; s.bets++; this.handle += stake; this.bets++; }
  addSettle(ms: number, stake: bigint, credit: bigint): void { const s = this.slot(ms); if (!s) return; s.settled += stake; s.returned += credit; this.settled += stake; this.returned += credit; }
  /** Expire slots older than 24 h before `ms`. */
  roll(ms: number): void {
    const now = Math.floor(ms / 60_000);
    for (const s of this.slots) if (s.minute >= 0 && s.minute <= now - DAY_MINUTES) this.clear(s);
  }
  get ggr(): bigint { return this.settled - this.returned; }
  get rtp(): number | null { return this.settled > 0n ? Number(this.returned) / Number(this.settled) : null; }
}

/** Accepted bets in the trailing 60 s (per-second slots). */
export class PerMinuteCounter {
  private readonly slots = new Array<number>(60).fill(0);
  private readonly secs = new Array<number>(60).fill(-1);
  add(ms: number): void {
    const sec = Math.floor(ms / 1000); const i = ((sec % 60) + 60) % 60;
    if (this.secs[i] !== sec) { this.secs[i] = sec; this.slots[i] = 0; }
    this.slots[i] = this.slots[i]! + 1;
  }
  count(ms: number): number {
    const sec = Math.floor(ms / 1000); let n = 0;
    for (let i = 0; i < 60; i++) if (this.secs[i]! > sec - 60 && this.secs[i]! <= sec) n += this.slots[i]!;
    return n;
  }
}

export interface SeriesPoint {
  readonly t: number;
  readonly equity: bigint;
  readonly ggr: bigint;
  readonly handle: bigint;
  readonly rtp: number | null;
  readonly openLiability: bigint;
  readonly players: number;
  readonly betsPerMin: number;
}

export interface CalibrationBin { predicted: number; wins: number; n: number }

export interface SettledLegFacts {
  readonly x100: number;
  readonly p: number;
  readonly phase: Phase;
  readonly market: MarketId;
  readonly kind: string;
  readonly strategy?: string | undefined;
  readonly stake: bigint;
  /** 1 − policy edge of the leg (absent for legs journaled before SPEC-10). */
  readonly policyRtp?: number | undefined;
  /** SPEC-12 promo tier and pricing of the leg (absent for legacy launch-boost legs). */
  readonly tier?: string | undefined;
  readonly boosted?: boolean | undefined;
}

/** Derived house metrics. Everything except the sampled series is rebuilt from journal events. */
export class HouseMetrics {
  readonly total = new RtpAgg();
  readonly byRangePhase = new Map<string, RtpAgg>();
  readonly byMarket = new Map<MarketId, RtpAgg>();
  readonly byPhase = new Map<Phase, RtpAgg>();
  readonly byKind = new Map<string, RtpAgg>();
  readonly byStrategy = new Map<string, RtpAgg>();
  /** SPEC-12: by tier (`<tier>|boosted` or `<tier>|standard` pricing) and by range within tier (`<range>|<tier>|<pricing>`). */
  readonly byTier = new Map<string, RtpAgg>();
  readonly byRangeTier = new Map<string, RtpAgg>();
  readonly rolling = new Rolling24h();
  readonly perMinute = new PerMinuteCounter();
  readonly calibration: CalibrationBin[] = Array.from({ length: 10 }, () => ({ predicted: 0, wins: 0, n: 0 }));
  readonly series: Ring<SeriesPoint>;
  acceptedBets = 0;
  acceptedHandle = 0n;
  private lastSampleMs = Number.NEGATIVE_INFINITY;

  constructor(readonly sampleEveryMs = 60_000, capacity = 20_160) { this.series = new Ring(capacity); }

  onBet(ms: number, stake: bigint): void {
    this.acceptedBets++; this.acceptedHandle += stake;
    this.rolling.addBet(ms, stake); this.perMinute.add(ms);
  }

  onSettle(ms: number, leg: SettledLegFacts, status: 'won' | 'lost' | 'refunded', credit: bigint): void {
    const aggs = [this.total, get(this.byRangePhase, `${rangeOf(leg.x100)}|${leg.phase}`), get(this.byMarket, leg.market), get(this.byPhase, leg.phase), get(this.byKind, leg.kind)];
    if (leg.strategy) aggs.push(get(this.byStrategy, leg.strategy));
    if (leg.tier !== undefined) {
      const pricing = leg.boosted ? 'boosted' : 'standard';
      aggs.push(get(this.byTier, `${leg.tier}|${pricing}`), get(this.byRangeTier, `${rangeOf(leg.x100)}|${leg.tier}|${pricing}`));
    }
    for (const agg of aggs) agg.add(leg.stake, leg.x100, leg.p, credit, status, leg.policyRtp);
    if (status === 'refunded') return;
    this.rolling.addSettle(ms, leg.stake, credit);
    const bin = this.calibration[Math.min(9, Math.max(0, Math.floor(leg.p * 10)))]!;
    bin.n++; bin.predicted += leg.p; if (status === 'won') bin.wins++;
  }

  /** Append a series point once `sampleEveryMs` has elapsed since the last one. */
  maybeSample(ms: number, point: () => Pick<SeriesPoint, 'equity' | 'openLiability' | 'players'>): void {
    if (ms - this.lastSampleMs < this.sampleEveryMs) return;
    this.lastSampleMs = ms;
    this.rolling.roll(ms);
    this.series.push({ t: ms, ggr: this.rolling.ggr, handle: this.rolling.handle, rtp: this.rolling.rtp, betsPerMin: this.perMinute.count(ms), ...point() });
  }

  /** SPEC-12 RTP by tier and pricing, and by multiplier range within each tier (rows with bets only). */
  rtpByTier(): { byTier: (RtpRow & { tier: string; pricing: string })[]; byRangeTier: (RtpRow & { tier: string; pricing: string })[] } {
    const split = (key: string) => key.split('|');
    const byTier = [...this.byTier].map(([k, v]) => { const [tier, pricing] = split(k) as [string, string]; return { ...v.row(k), tier, pricing }; });
    const byRangeTier = [...this.byRangeTier].map(([k, v]) => { const [range, tier, pricing] = split(k) as [string, string, string]; return { ...v.row(range), tier, pricing }; });
    const order = (t: string) => ['launch', 'growth', 'scale', 'standard'].indexOf(t);
    const rangeOrder = (r: string) => RTP_RANGES.findIndex(x => x.key === r);
    byTier.sort((a, b) => order(a.tier) - order(b.tier) || (a.pricing < b.pricing ? -1 : 1));
    byRangeTier.sort((a, b) => order(a.tier) - order(b.tier) || (a.pricing < b.pricing ? -1 : a.pricing > b.pricing ? 1 : 0) || rangeOrder(a.key) - rangeOrder(b.key));
    return { byTier, byRangeTier };
  }

  rtpReport(): { byRange: RtpRow[]; byMarket: RtpRow[]; byPhase: RtpRow[]; calibration: { predicted: number; observed: number; n: number }[] } {
    const byRange: RtpRow[] = [];
    for (const r of RTP_RANGES) for (const phase of ['launch', 'standard'] as const) {
      const agg = this.byRangePhase.get(`${r.key}|${phase}`);
      if (!agg && r.key === '50-100') continue;
      byRange.push((agg ?? new RtpAgg()).row(r.key, { phase }));
    }
    return {
      byRange,
      byMarket: [...this.byMarket].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => v.row(k)),
      byPhase: (['launch', 'standard'] as const).map(p => (this.byPhase.get(p) ?? new RtpAgg()).row(p, { phase: p })),
      calibration: this.calibration.filter(b => b.n > 0).map(b => ({ predicted: b.predicted / b.n, observed: b.wins / b.n, n: b.n })),
    };
  }
}
function get<K>(map: Map<K, RtpAgg>, key: K): RtpAgg { let v = map.get(key); if (!v) { v = new RtpAgg(); map.set(key, v); } return v; }

/** Counts in per-minute slots over a trailing window (the clock only moves forward). */
export class MinuteWindow<K extends string> {
  private readonly slots: { minute: number; counts: Map<K, number> }[];
  constructor(private readonly minutes = 60) { this.slots = Array.from({ length: minutes }, () => ({ minute: -1, counts: new Map() })); }
  add(ms: number, key: K, amount = 1): void {
    const minute = Math.floor(ms / 60_000);
    const s = this.slots[((minute % this.minutes) + this.minutes) % this.minutes]!;
    if (s.minute !== minute) { if (s.minute > minute) return; s.minute = minute; s.counts.clear(); }
    s.counts.set(key, (s.counts.get(key) ?? 0) + amount);
  }
  sum(ms: number, key: K): number {
    const now = Math.floor(ms / 60_000); let n = 0;
    for (const s of this.slots) if (s.minute > now - this.minutes && s.minute <= now) n += s.counts.get(key) ?? 0;
    return n;
  }
}

/** Acceptance-hold outcomes and latency (derived from journaled hold events, so a rebuild reproduces them). */
export class HoldStats {
  created = 0;
  accepted = 0;
  rejected = 0;
  readonly byDetail = new Map<string, number>();
  private readonly latencies = new Ring<number>(50_000);
  private readonly recent = new MinuteWindow<'created' | 'rejected'>(60);
  onCreate(ms: number): void { this.created++; this.recent.add(ms, 'created'); }
  onResolve(ms: number, accepted: boolean, detail: string, latencyMs: number): void {
    if (accepted) this.accepted++; else { this.rejected++; this.recent.add(ms, 'rejected'); }
    this.byDetail.set(detail, (this.byDetail.get(detail) ?? 0) + 1);
    this.latencies.push(latencyMs);
  }
  private latencyCache: { at: number; value: { p50: number | null; p95: number | null; max: number | null; n: number } } | undefined;
  /** Latency quantiles over the most recent 50,000 resolutions (ms); recomputed only when resolutions were added. */
  latency(): { p50: number | null; p95: number | null; max: number | null; n: number } {
    const done = this.accepted + this.rejected;
    if (this.latencyCache?.at === done) return this.latencyCache.value;
    const xs = this.latencies.toArray().sort((a, b) => a - b);
    const q = (f: number) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]!;
    const value = xs.length ? { p50: q(0.5), p95: q(0.95), max: xs.at(-1)!, n: xs.length } : { p50: null, p95: null, max: null, n: 0 };
    this.latencyCache = { at: done, value };
    return value;
  }
  rejectRate1h(ms: number): number | null { const c = this.recent.sum(ms, 'created'); return c > 0 ? this.recent.sum(ms, 'rejected') / c : null; }
  rejectRateAll(): number | null { const done = this.accepted + this.rejected; return done > 0 ? this.rejected / done : null; }
  snapshot(): Record<string, unknown> { return { created: this.created, accepted: this.accepted, rejected: this.rejected, byDetail: Object.fromEntries([...this.byDetail].sort(([a], [b]) => (a < b ? -1 : 1))) }; }
}

/** Handle placed by flagged accounts, trailing hour and cumulative (the toxic-flow share). */
export class FlowShare {
  handle = 0n;
  flaggedHandle = 0n;
  private readonly recent = new MinuteWindow<'all' | 'flagged'>(60);
  add(ms: number, stake: bigint, flagged: boolean): void {
    this.handle += stake; if (flagged) this.flaggedHandle += stake;
    this.recent.add(ms, 'all', Number(stake)); if (flagged) this.recent.add(ms, 'flagged', Number(stake));
  }
  share1h(ms: number): number | null { const all = this.recent.sum(ms, 'all'); return all > 0 ? this.recent.sum(ms, 'flagged') / all : null; }
  shareAll(): number | null { return this.handle > 0n ? Number(this.flaggedHandle) / Number(this.handle) : null; }
}
