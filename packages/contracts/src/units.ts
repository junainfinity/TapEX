import type { Cents, DecimalValue, GrossX100 } from './contracts.js';

const MAX_DIGITS = 256;
const MAX_EXPONENT = 256;
function power10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_EXPONENT * 2) throw new RangeError('Decimal exponent outside supported range');
  return 10n ** BigInt(exponent);
}
export function integer(value: string, allowNegative = false): bigint {
  if (typeof value !== 'string' || value.length > MAX_DIGITS + 1 || !(allowNegative ? /^-?\d+$/ : /^\d+$/).test(value)) throw new TypeError('Expected bounded integer string');
  return BigInt(value);
}
export function normalizeDecimal(value: DecimalValue): DecimalValue {
  if (!Number.isSafeInteger(value.exponent) || Math.abs(value.exponent) > MAX_EXPONENT) throw new RangeError('Invalid decimal exponent');
  let coefficient = integer(value.coefficient, true);
  if (coefficient === 0n) return { coefficient: '0', exponent: 0 };
  let exponent = value.exponent;
  while (coefficient % 10n === 0n) { coefficient /= 10n; exponent += 1; }
  if (Math.abs(exponent) > MAX_EXPONENT) throw new RangeError('Normalized decimal exponent outside supported range');
  return { coefficient: coefficient.toString(), exponent };
}
export function parseDecimal(text: string): DecimalValue {
  if (typeof text !== 'string' || text.length > MAX_DIGITS + 16) throw new TypeError('Expected bounded decimal text');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError('Invalid decimal text');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0) - fraction.length;
  return normalizeDecimal({ coefficient: `${match[1] === '-' ? '-' : ''}${match[2]}${fraction}`, exponent });
}
function aligned(a: DecimalValue, b: DecimalValue): [bigint, bigint, number] {
  const left = normalizeDecimal(a); const right = normalizeDecimal(b);
  const exponent = Math.min(left.exponent, right.exponent);
  return [BigInt(left.coefficient) * power10(left.exponent - exponent), BigInt(right.coefficient) * power10(right.exponent - exponent), exponent];
}
export function compareDecimal(a: DecimalValue, b: DecimalValue): -1 | 0 | 1 {
  const [left, right] = aligned(a, b); return left < right ? -1 : left > right ? 1 : 0;
}
export function addDecimal(a: DecimalValue, b: DecimalValue): DecimalValue {
  const [left, right, exponent] = aligned(a, b); return normalizeDecimal({ coefficient: (left + right).toString(), exponent });
}
export function multiplyDecimalInteger(value: DecimalValue, factor: bigint): DecimalValue {
  const normalized = normalizeDecimal(value); return normalizeDecimal({ coefficient: (BigInt(normalized.coefficient) * factor).toString(), exponent: normalized.exponent });
}
/** Floor, including negative values; truncation would pick the wrong negative bucket. */
export function floorDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('Divisor must be positive');
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}
export function bucketIndex(price: DecimalValue, step: DecimalValue): bigint {
  const [numerator, denominator] = aligned(price, step); return floorDivide(numerator, denominator);
}
export function priceBucket(price: DecimalValue, step: DecimalValue): { index: bigint; lowerPrice: DecimalValue; upperPrice: DecimalValue } {
  const index = bucketIndex(price, step);
  return { index, lowerPrice: multiplyDecimalInteger(step, index), upperPrice: multiplyDecimalInteger(step, index + 1n) };
}
export function decimalToString(value: DecimalValue): string {
  const n = normalizeDecimal(value); const negative = n.coefficient.startsWith('-'); const digits = negative ? n.coefficient.slice(1) : n.coefficient;
  const point = digits.length + n.exponent;
  const body = n.exponent >= 0 ? digits + '0'.repeat(n.exponent) : point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${'0'.repeat(-point)}${digits}`;
  return negative ? `-${body}` : body;
}
/** Projection/model conversion only. Settlement must compare exact DecimalValues. */
export function decimalToNumber(value: DecimalValue): number {
  const n = Number(decimalToString(value)); if (!Number.isFinite(n)) throw new RangeError('Decimal does not fit finite projection number'); return n;
}
export function cents(value: string): Cents { return integer(value).toString(); }
export function grossReturn(stakeCents: Cents, grossX100: GrossX100): Cents {
  const stake = integer(stakeCents); const multiplier = integer(grossX100);
  if (multiplier <= 0n) throw new RangeError('Multiplier must be positive');
  return ((stake * multiplier + 50n) / 100n).toString();
}
export function multiplierHundredths(value: DecimalValue): GrossX100 {
  const normalized = normalizeDecimal(value); const coefficient = BigInt(normalized.coefficient);
  if (coefficient <= 0n) throw new RangeError('Multiplier must be positive');
  const shift = normalized.exponent + 2;
  const result = shift >= 0 ? coefficient * power10(shift) : coefficient / power10(-shift);
  if (result <= 0n) throw new RangeError('Multiplier rounds to zero');
  return result.toString();
}
export function formatCents(value: Cents, symbol = '$'): string {
  const amount = integer(value, true); const abs = amount < 0n ? -amount : amount;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${amount < 0n ? '-' : ''}${symbol}${whole}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function formatMultiplier(value: GrossX100): string {
  const n = integer(value); if (n <= 0n) throw new RangeError('Multiplier must be positive');
  return `${n / 100n}.${(n % 100n).toString().padStart(2, '0')}×`;
}
