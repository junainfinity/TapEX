/**
 * Exact money formatting for the console. Every amount is handled as a bigint
 * number of Centi (1 Centi = 0.01 OPEN); no float ever touches a displayed
 * amount. `centiToNumber` exists only as a chart-coordinate projection.
 */
import type { Centi, Wei } from './types.js';

const CENTI_RE = /^-?\d{1,60}$/;
const WEI_RE = /^\d{1,78}$/;
const MINUS = '−';

/** Parse a Centi string strictly; null for anything that is not a bounded integer string. */
export function parseCenti(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !CENTI_RE.test(value)) return null;
  return BigInt(value);
}

export function isCenti(value: unknown): value is Centi {
  return typeof value === 'string' && CENTI_RE.test(value);
}

export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function signPrefix(value: bigint, signed: boolean): string {
  if (value < 0n) return MINUS;
  return signed && value > 0n ? '+' : '';
}

export interface OpenFormatOptions {
  /** Append the " OPEN" unit (default true). */
  readonly unit?: boolean;
  /** Prefix positive values with "+" (default false). */
  readonly signed?: boolean;
}

/** 123456 -> "1,234.56 OPEN"; -5 -> "−0.05 OPEN". Returns "—" for malformed input. */
export function formatOpen(centi: Centi | bigint, options: OpenFormatOptions = {}): string {
  const value = parseCenti(centi);
  if (value === null) return '—';
  const magnitude = abs(value);
  const body = `${groupThousands((magnitude / 100n).toString())}.${(magnitude % 100n).toString().padStart(2, '0')}`;
  return `${signPrefix(value, options.signed ?? false)}${body}${options.unit === false ? '' : ' OPEN'}`;
}

const COMPACT_UNITS: readonly (readonly [string, bigint])[] = [
  ['B', 100n * 1_000_000_000n],
  ['M', 100n * 1_000_000n],
  ['K', 100n * 1_000n],
];

/**
 * Three significant digits, truncated toward zero so a compact figure never
 * overstates: 1_234_567_89 Centi -> "1.23M OPEN". Below 10,000 OPEN the exact form is used.
 */
export function formatOpenCompact(centi: Centi | bigint, options: OpenFormatOptions = {}): string {
  const value = parseCenti(centi);
  if (value === null) return '—';
  const magnitude = abs(value);
  const suffix = options.unit === false ? '' : ' OPEN';
  if (magnitude < 100n * 10_000n) return formatOpen(value, options);
  for (const [symbol, unit] of COMPACT_UNITS) {
    if (magnitude < unit) continue;
    const thousandths = (magnitude * 1000n) / unit;
    const whole = thousandths / 1000n;
    const wholeDigits = whole.toString().length;
    const decimals = wholeDigits >= 3 ? 0 : 3 - wholeDigits;
    const fraction = decimals === 0 ? '' : `.${(thousandths % 1000n).toString().padStart(3, '0').slice(0, decimals)}`;
    return `${signPrefix(value, options.signed ?? false)}${groupThousands(whole.toString())}${fraction}${symbol}${suffix}`;
  }
  return formatOpen(value, options);
}

export interface RefPrice {
  /** Price as an exact rational numerator / 10^scale USD per OPEN. */
  readonly numerator: bigint;
  readonly scale: number;
  readonly text: string;
}

export const DEFAULT_REF_PRICE_TEXT = '0.138';

/** Parse an admin-set USD reference price ("0.138"); null when invalid or zero. */
export function parseRefPrice(text: string): RefPrice | null {
  const trimmed = text.trim();
  const match = /^(\d{1,6})(?:\.(\d{1,8}))?$/.exec(trimmed);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const numerator = BigInt(`${match[1]}${fraction}`);
  if (numerator === 0n) return null;
  return { numerator, scale: fraction.length, text: trimmed };
}

/** Exact USD cents for an amount at the reference price, rounded half away from zero. */
export function usdCentsAt(centi: Centi | bigint, price: RefPrice): bigint | null {
  const value = parseCenti(centi);
  if (value === null) return null;
  const denominator = 10n ** BigInt(price.scale);
  const product = abs(value) * price.numerator;
  const rounded = (product * 2n + denominator) / (denominator * 2n);
  return value < 0n ? -rounded : rounded;
}

/** "≈ $170.36" — callers must label the figure as an estimate at the stated price. */
export function formatUsdEstimate(centi: Centi | bigint, price: RefPrice): string {
  const cents = usdCentsAt(centi, price);
  if (cents === null) return '—';
  const magnitude = abs(cents);
  return `≈ ${cents < 0n ? MINUS : ''}$${groupThousands((magnitude / 100n).toString())}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

export type OpenAmountResult =
  | { readonly ok: true; readonly centi: bigint }
  | { readonly ok: false; readonly reason: 'EMPTY' | 'INVALID' | 'TOO_PRECISE' | 'ZERO' | 'TOO_LARGE' };

/** Parse an operator-typed OPEN amount ("1,234.5") into exact Centi. */
export function parseOpenAmount(text: string): OpenAmountResult {
  const cleaned = text.trim().replace(/\s+OPEN$/i, '').replace(/[,_\s]/g, '');
  if (cleaned === '') return { ok: false, reason: 'EMPTY' };
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return { ok: false, reason: 'INVALID' };
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > 2) return { ok: false, reason: 'TOO_PRECISE' };
  if (whole.replace(/^0+/, '').length > 15) return { ok: false, reason: 'TOO_LARGE' };
  const centi = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (centi === 0n) return { ok: false, reason: 'ZERO' };
  return { ok: true, centi };
}

export const OPEN_AMOUNT_MESSAGES: Readonly<Record<Exclude<OpenAmountResult, { ok: true }>['reason'], string>> = {
  EMPTY: 'Enter an amount in OPEN.',
  INVALID: 'Use digits with an optional decimal point, e.g. 1,250.50.',
  TOO_PRECISE: 'The smallest unit is 0.01 OPEN (1 Centi).',
  ZERO: 'The amount must be greater than zero.',
  TOO_LARGE: 'The amount is larger than any supply of OPEN.',
};

/** 1 Centi = 10^16 wei (SPEC §2). */
export const CENTI_WEI = 10n ** 16n;

/**
 * Exact OPEN amount from wei (18 decimals): "1,234.56 OPEN", plus " + 7,300 wei" when the amount is not
 * a whole number of Centi (dust is shown, never rounded away).
 */
export function formatWeiOpen(wei: Wei | bigint, options: OpenFormatOptions = {}): string {
  let value: bigint;
  if (typeof wei === 'bigint') value = wei;
  else if (typeof wei === 'string' && WEI_RE.test(wei)) value = BigInt(wei);
  else return '—';
  const dust = value % CENTI_WEI;
  return `${formatOpen(value / CENTI_WEI, options)}${dust > 0n ? ` + ${groupThousands(dust.toString())} wei` : ''}`;
}

/** Wei -> "0.01234 ETH" truncated (never rounded up) to `decimals` places. */
export function formatEth(wei: Wei, decimals = 5): string {
  if (typeof wei !== 'string' || !WEI_RE.test(wei)) return '—';
  const value = BigInt(wei);
  const unit = 10n ** 18n;
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(18, '0').slice(0, decimals);
  return `${groupThousands(whole.toString())}${decimals > 0 ? `.${fraction}` : ''} ETH`;
}

/** 101 -> "1.01×". */
export function formatX100(x100: number | string | null | undefined): string {
  const n = typeof x100 === 'string' && /^\d+$/.test(x100) ? Number(x100) : x100;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return '—';
  return `${Math.trunc(n / 100)}.${String(n % 100).padStart(2, '0')}×`;
}

/** Chart projection only: Centi -> OPEN as a float. Never use for accounting or labels. */
export function centiToNumber(centi: Centi | bigint): number {
  const value = parseCenti(centi);
  return value === null ? Number.NaN : Number(value) / 100;
}

export function sumCenti(values: Iterable<Centi | bigint>): bigint {
  let total = 0n;
  for (const item of values) total += parseCenti(item) ?? 0n;
  return total;
}

/** a / b as a display ratio with 1e-6 resolution computed on bigints; null when b is 0. */
export function centiRatio(a: Centi | bigint, b: Centi | bigint): number | null {
  const numerator = parseCenti(a); const denominator = parseCenti(b);
  if (numerator === null || denominator === null || denominator === 0n) return null;
  return Number((numerator * 1_000_000n) / denominator) / 1_000_000;
}

/** Relative change (now − then) / |then|; null when `then` is zero or malformed. */
export function centiDelta(now: Centi | bigint, then: Centi | bigint): number | null {
  const current = parseCenti(now); const previous = parseCenti(then);
  if (current === null || previous === null || previous === 0n) return null;
  return Number(((current - previous) * 1_000_000n) / abs(previous)) / 1_000_000;
}
