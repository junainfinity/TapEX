import { integer } from '@maya/contracts';

/** Ledger unit: centi-OPEN as a decimal integer string. 1 Centi = 0.01 OPEN = 10^16 wei. */
export type Centi = string;
/** Gross multiplier ×100, including the stake (101 = 1.01×). */
export type X100 = number | bigint | string;

export const OPEN_DECIMALS = 18;
export const CENTI_WEI = 10n ** 16n;

export function parseCenti(value: Centi, allowNegative = false): bigint { return integer(value, allowNegative); }
export function toCenti(value: bigint): Centi {
  if (typeof value !== 'bigint') throw new TypeError('Expected bigint Centi amount');
  return value.toString();
}

/** Exact ledger → chain conversion. */
export function toWei(centi: Centi): bigint { return parseCenti(centi) * CENTI_WEI; }

/**
 * Exact chain → ledger conversion. The ledger credits the floor; the remainder is dust that the
 * caller keeps and reports (it is never rounded away or credited twice).
 */
export function fromWei(wei: bigint): { readonly centi: Centi; readonly dustWei: bigint } {
  if (typeof wei !== 'bigint' || wei < 0n) throw new RangeError('Wei amount must be a non-negative bigint');
  return Object.freeze({ centi: (wei / CENTI_WEI).toString(), dustWei: wei % CENTI_WEI });
}

/** On-chain value represented by a ledger amount plus retained dust; reconciliation must match exactly. */
export function totalWei(centi: Centi, dustWei = 0n): bigint {
  if (typeof dustWei !== 'bigint' || dustWei < 0n) throw new RangeError('Dust must be a non-negative bigint');
  return toWei(centi) + dustWei;
}

export function parseX100(value: X100): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new RangeError('Multiplier ×100 must be a safe integer'); n = BigInt(value); }
  else n = integer(value);
  if (n < 100n) throw new RangeError('Gross multiplier must be at least 1.00×');
  return n;
}

/** Gross return credited on a win: floor(stake × x100 / 100). */
export function payoutCenti(stakeCenti: Centi, x100: X100): Centi {
  return ((parseCenti(stakeCenti) * parseX100(x100)) / 100n).toString();
}

/** House liability of one leg: payout − stake. */
export function liabilityCenti(stakeCenti: Centi, x100: X100): Centi {
  const stake = parseCenti(stakeCenti);
  return ((stake * parseX100(x100)) / 100n - stake).toString();
}

/**
 * Largest stake whose liability floor(S·(x100−100)/100) stays ≤ headroom. Returns 0n when even a
 * one-centi stake would breach (or headroom is negative).
 */
export function maxStakeForLiability(headroomCenti: bigint, x100: X100): bigint {
  const m = parseX100(x100);
  if (headroomCenti < 0n) return 0n;
  if (m === 100n) throw new RangeError('A 1.00× multiplier carries no liability; stake is unbounded by liability');
  return ((headroomCenti + 1n) * 100n - 1n) / (m - 100n);
}

export function formatOpen(centi: Centi, symbol = 'OPEN'): string {
  const amount = parseCenti(centi, true); const abs = amount < 0n ? -amount : amount;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0n ? '-' : ''}${whole}.${(abs % 100n).toString().padStart(2, '0')} ${symbol}`;
}

export interface Rational { readonly n: bigint; readonly d: bigint }
/**
 * Exact rational of a configured non-negative fraction, read from its shortest round-trip decimal
 * (0.001 → 1/1000), so limits and thresholds never inherit binary float error.
 */
export function rationalOf(value: number): Rational {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Fraction must be a finite non-negative number');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new RangeError('Cannot represent fraction exactly');
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt(match[1]! + fraction);
  return exponent >= 0 ? { n: digits * 10n ** BigInt(exponent), d: 1n } : { n: digits, d: 10n ** BigInt(-exponent) };
}

/** floor(amount × fraction), exact; negative amounts floor toward −∞. */
export function mulFloor(amount: bigint, fraction: number): bigint {
  const { n, d } = rationalOf(fraction);
  const product = amount * n;
  const q = product / d;
  return product < 0n && product % d !== 0n ? q - 1n : q;
}

/** part / whole > fraction, exact. `whole` must be positive. */
export function exceedsFraction(part: bigint, whole: bigint, fraction: number): boolean {
  if (whole <= 0n) throw new RangeError('Whole must be positive');
  const { n, d } = rationalOf(fraction);
  return part * d > whole * n;
}
