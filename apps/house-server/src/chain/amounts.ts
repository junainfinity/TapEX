import { ChainError } from './errors.js';

export const WEI_PER_UNIT = 10n ** 18n;
export const UINT256_MAX = (1n << 256n) - 1n;
export const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Exact decimal → 18-decimal integer (OPEN or ETH → wei). Unlike viem's parseUnits this never
 * rounds: more than 18 fractional digits, signs, exponents or separators are rejected.
 */
export function parseUnits18(text: string, label = 'amount'): bigint {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!match) throw new ChainError('INVALID_ARGUMENT', `${label} must be a non-negative decimal with at most 18 fractional digits, got "${text}"`);
  const wei = BigInt(match[1]!) * WEI_PER_UNIT + BigInt((match[2] ?? '').padEnd(18, '0') || '0');
  if (wei > UINT256_MAX) throw new ChainError('INVALID_ARGUMENT', `${label} exceeds uint256`);
  return wei;
}

/** Exact 18-decimal integer → decimal string without trailing zeros ("1.5", "100", "0.000000000000000001"). */
export function formatUnits18(wei: bigint): string {
  const negative = wei < 0n; const abs = negative ? -wei : wei;
  const whole = abs / WEI_PER_UNIT; const frac = (abs % WEI_PER_UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function assertUint(value: bigint, label: string, { min = 0n, max = UINT256_MAX }: { min?: bigint; max?: bigint } = {}): bigint {
  if (typeof value !== 'bigint') throw new ChainError('INVALID_ARGUMENT', `${label} must be a bigint`);
  if (value < min || value > max) throw new ChainError('INVALID_ARGUMENT', `${label} must be in [${min}, ${max}], got ${value}`);
  return value;
}
