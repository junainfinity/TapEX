import { createHash } from 'node:crypto';

/** Deep-freeze plain data (objects/arrays); bigint and primitives pass through. */
export function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freezeDeep(item);
  }
  return value;
}

/** Canonical JSON: sorted keys, bigint as decimal string. Used for hashes and state comparison. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}
function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map) return canonical(Object.fromEntries([...value].map(([k, v]) => [String(k), v])));
  if (value instanceof Set) return [...value].map(canonical).sort();
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export const CENTI_RE = /^(0|[1-9]\d{0,29})$/;
export function isCenti(value: unknown): value is string { return typeof value === 'string' && CENTI_RE.test(value); }
export function isPositiveCenti(value: unknown): value is string { return isCenti(value) && value !== '0'; }

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export function isAddress(value: unknown): value is string { return typeof value === 'string' && ADDRESS_RE.test(value); }

/** Request / idempotency identifiers: printable, bounded, no whitespace. */
export const REQUEST_ID_RE = /^[A-Za-z0-9._:~-]{1,128}$/;
export function isRequestId(value: unknown): value is string { return typeof value === 'string' && REQUEST_ID_RE.test(value); }

export function minBig(...values: bigint[]): bigint { return values.reduce((a, b) => (b < a ? b : a)); }
export function maxBig(...values: bigint[]): bigint { return values.reduce((a, b) => (b > a ? b : a)); }
export function absBig(value: bigint): bigint { return value < 0n ? -value : value; }

/** Ratio of two exact amounts as a display number (not for accounting). */
export function ratio(numerator: bigint, denominator: bigint): number | null {
  return denominator === 0n ? null : Number(numerator) / Number(denominator);
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Finite JSON number; non-finite values clamp so JSON never carries null where a number is promised. */
export function finite(value: number, fallback = 0, cap = 1000): number {
  if (Number.isNaN(value)) return fallback;
  if (!Number.isFinite(value)) return value > 0 ? cap : -cap;
  return value;
}

export function isoSeconds(ms: number): string { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
