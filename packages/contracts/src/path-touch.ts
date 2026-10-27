import type { CellTerms, PriceSample, SettlementPolicy } from './contracts.js';
import { assertTimestamp, sampleId } from './identities.js';
import { normalizeDecimal } from './units.js';

export const OBSERVED_PATH_RULE_VERSION = 'maya-observed-linear-v2';
export const OBSERVED_SAMPLE_PREFIX = 'maya-observed-v2:';
export const OBSERVED_PATH_POLICY: SettlementPolicy = Object.freeze({
  policyId: OBSERVED_PATH_RULE_VERSION,
  expectedSampleIntervalMs: 1000,
  lateArrivalGraceMs: 1000,
  recoveryDeadlineMs: 30_000,
});
export function observedSampleId(sample: Pick<PriceSample, 'feedId' | 'sourceTimeMs'>): string {
  return OBSERVED_SAMPLE_PREFIX + sampleId(sample.feedId, sample.sourceTimeMs);
}
export interface ExactFraction { readonly numerator: string; readonly denominator: string }
export interface PathTouch {
  /** Approximate milliseconds for rendering only. Exact collision decisions use the fractions below. */
  readonly firstTouchTimeMs: number;
  readonly time: ExactFraction;
  readonly price: ExactFraction;
}
type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d: bigint): Fraction { return d < 0n ? { n: -n, d: -d } : { n, d }; }
function compare(a: Fraction, b: Fraction): number { const delta = a.n * b.d - b.n * a.d; return delta < 0n ? -1 : delta > 0n ? 1 : 0; }
function exact(value: Fraction): ExactFraction {
  let a = value.n < 0n ? -value.n : value.n, b = value.d;
  while (b) { const rest = a % b; a = b; b = rest; }
  const divisor = a || 1n;
  return Object.freeze({ numerator: (value.n / divisor).toString(), denominator: (value.d / divisor).toString() });
}

/** First intersection of an observed linear segment with inclusive prices and [start,end) time. */
export function segmentTouchesCell(
  a: Pick<PriceSample, 'marketId' | 'sourceTimeMs' | 'price'>,
  b: Pick<PriceSample, 'marketId' | 'sourceTimeMs' | 'price'>,
  cell: CellTerms,
  maxGapMs = 1000,
): PathTouch | undefined {
  assertTimestamp(a.sourceTimeMs); assertTimestamp(b.sourceTimeMs);
  assertTimestamp(cell.startMs); assertTimestamp(cell.endMs);
  const span = b.sourceTimeMs - a.sourceTimeMs;
  if (!Number.isSafeInteger(maxGapMs) || maxGapMs <= 0 || a.marketId !== cell.marketId || b.marketId !== cell.marketId || span <= 0 || span > maxGapMs || cell.endMs <= cell.startMs || b.sourceTimeMs < cell.startMs || a.sourceTimeMs >= cell.endMs) return undefined;
  const values = [a.price, b.price, cell.lowerPrice, cell.upperPrice].map(normalizeDecimal);
  const exponent = Math.min(...values.map(value => value.exponent));
  const [start, end, lower, upper] = values.map(value => BigInt(value.coefficient) * 10n ** BigInt(value.exponent - exponent)) as [bigint, bigint, bigint, bigint];
  if (lower > upper) return undefined;
  const delta = end - start;
  const duration = BigInt(span);
  let enter: Fraction = { n: 0n, d: 1n }, exit: Fraction = { n: 1n, d: 1n };
  const startTime = fraction(BigInt(cell.startMs - a.sourceTimeMs), duration);
  const endTime = fraction(BigInt(cell.endMs - a.sourceTimeMs), duration);
  if (compare(startTime, enter) > 0) enter = startTime;
  if (compare(endTime, exit) < 0) exit = endTime;
  if (delta === 0n) { if (start < lower || start > upper) return undefined; }
  else {
    const one = fraction(lower - start, delta), two = fraction(upper - start, delta);
    const priceEnter = compare(one, two) < 0 ? one : two;
    const priceExit = compare(one, two) < 0 ? two : one;
    if (compare(priceEnter, enter) > 0) enter = priceEnter;
    if (compare(priceExit, exit) < 0) exit = priceExit;
  }
  if (compare(enter, exit) > 0 || compare(enter, endTime) >= 0) return undefined;
  const time = fraction(BigInt(a.sourceTimeMs) * enter.d + duration * enter.n, enter.d);
  let price = fraction(start * enter.d + delta * enter.n, enter.d);
  price = exponent >= 0 ? fraction(price.n * 10n ** BigInt(exponent), price.d) : fraction(price.n, price.d * 10n ** BigInt(-exponent));
  const firstTouchTimeMs = Number(time.n / time.d) + Number((time.n % time.d) * 1_000_000n / time.d) / 1_000_000;
  return Object.freeze({ firstTouchTimeMs, time: exact(time), price: exact(price) });
}
