import { describe, expect, it } from 'vitest';
import {
  centiDelta, centiRatio, centiToNumber, formatEth, formatOpen, formatOpenCompact, formatUsdEstimate, formatX100, isCenti, parseCenti,
  parseOpenAmount, parseRefPrice, sumCenti, usdCentsAt,
} from './money.js';
import { formatAge, formatDateTime, formatInt, formatPct, formatPrice, formatPts, explorerUrl, shortAddress, squareLabel } from './format.js';

const MINUS = '−';

describe('parseCenti', () => {
  it('accepts bounded integer strings and bigints only', () => {
    expect(parseCenti('0')).toBe(0n);
    expect(parseCenti('-15')).toBe(-15n);
    expect(parseCenti('123456789012345678901234567890')).toBe(123456789012345678901234567890n);
    expect(parseCenti(42n)).toBe(42n);
    for (const bad of ['', '1.5', '1e3', ' 1', '+1', '0x10', 12, null, undefined, '1'.repeat(61)]) expect(parseCenti(bad)).toBeNull();
    expect(isCenti('100')).toBe(true);
    expect(isCenti(100)).toBe(false);
  });
});

describe('formatOpen', () => {
  it('formats Centi exactly with grouping and two decimals', () => {
    expect(formatOpen('123456')).toBe('1,234.56 OPEN');
    expect(formatOpen('0')).toBe('0.00 OPEN');
    expect(formatOpen('5')).toBe('0.05 OPEN');
    expect(formatOpen('100')).toBe('1.00 OPEN');
    expect(formatOpen('-5')).toBe(`${MINUS}0.05 OPEN`);
    expect(formatOpen('-123456789')).toBe(`${MINUS}1,234,567.89 OPEN`);
  });
  it('keeps precision far beyond float range', () => {
    // 2^53 + 1 Centi would round as a float; bigint keeps the final digit.
    expect(formatOpen('9007199254740993')).toBe('90,071,992,547,409.93 OPEN');
    expect(formatOpen('100000000000000000000000000001')).toBe('1,000,000,000,000,000,000,000,000,000.01 OPEN');
  });
  it('supports signed and unit-less output', () => {
    expect(formatOpen('250', { signed: true })).toBe('+2.50 OPEN');
    expect(formatOpen('0', { signed: true })).toBe('0.00 OPEN');
    expect(formatOpen('-250', { signed: true, unit: false })).toBe(`${MINUS}2.50`);
    expect(formatOpen(123n, { unit: false })).toBe('1.23');
  });
  it('renders malformed input as an explicit dash, never as zero', () => {
    expect(formatOpen('12.5')).toBe('—');
    expect(formatOpen('abc')).toBe('—');
  });
});

describe('formatOpenCompact', () => {
  it('uses exact form below 10,000 OPEN', () => {
    expect(formatOpenCompact('999999')).toBe('9,999.99 OPEN');
  });
  it('truncates to three significant digits and never rounds up', () => {
    expect(formatOpenCompact('1000000')).toBe('10.0K OPEN');
    expect(formatOpenCompact('1299999')).toBe('12.9K OPEN');
    expect(formatOpenCompact('12345678')).toBe('123K OPEN');
    expect(formatOpenCompact('123456789')).toBe('1.23M OPEN');
    expect(formatOpenCompact('99999999999')).toBe('999M OPEN');
    expect(formatOpenCompact('250000000000')).toBe('2.50B OPEN');
    expect(formatOpenCompact('-123456789')).toBe(`${MINUS}1.23M OPEN`);
    expect(formatOpenCompact('123456789', { signed: true, unit: false })).toBe('+1.23M');
    expect(formatOpenCompact('12345678900000000')).toBe('123,456B OPEN'); // 123,456.789 B OPEN, truncated
  });
});

describe('USD estimate', () => {
  const price = parseRefPrice('0.138')!;
  it('parses the reference price exactly', () => {
    expect(price).toEqual({ numerator: 138n, scale: 3, text: '0.138' });
    expect(parseRefPrice('1')).toEqual({ numerator: 1n, scale: 0, text: '1' });
    for (const bad of ['', '0', '0.000', '-1', 'abc', '1.123456789', '1e3']) expect(parseRefPrice(bad)).toBeNull();
  });
  it('converts Centi to USD cents with half-away-from-zero rounding', () => {
    // 1,234.56 OPEN × 0.138 = 170.36928 USD -> 17037 cents
    expect(usdCentsAt('123456', price)).toBe(17037n);
    // 0.05 OPEN × 0.138 = 0.0069 USD -> 1 cent (0.69 cents rounds up)
    expect(usdCentsAt('5', price)).toBe(1n);
    // 0.03 OPEN × 0.138 = 0.00414 -> 0 cents
    expect(usdCentsAt('3', price)).toBe(0n);
    expect(usdCentsAt('-123456', price)).toBe(-17037n);
    // exact half: 50 Centi × 0.01 = 0.5 cents -> 1
    expect(usdCentsAt('50', parseRefPrice('0.01')!)).toBe(1n);
    expect(usdCentsAt('bad', price)).toBeNull();
  });
  it('formats with the approximation sign', () => {
    expect(formatUsdEstimate('123456', price)).toBe('≈ $170.37');
    expect(formatUsdEstimate('-100000000', price)).toBe(`≈ ${MINUS}$138,000.00`);
  });
});

describe('parseOpenAmount', () => {
  it('parses operator input into exact Centi', () => {
    expect(parseOpenAmount('1,234.5')).toEqual({ ok: true, centi: 123450n });
    expect(parseOpenAmount(' 25 ')).toEqual({ ok: true, centi: 2500n });
    expect(parseOpenAmount('0.01')).toEqual({ ok: true, centi: 1n });
    expect(parseOpenAmount('1000000 OPEN')).toEqual({ ok: true, centi: 100000000n });
    expect(parseOpenAmount('007.10')).toEqual({ ok: true, centi: 710n });
  });
  it('rejects with a typed reason', () => {
    expect(parseOpenAmount('')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(parseOpenAmount('1.234')).toEqual({ ok: false, reason: 'TOO_PRECISE' });
    expect(parseOpenAmount('0.00')).toEqual({ ok: false, reason: 'ZERO' });
    expect(parseOpenAmount('-5')).toEqual({ ok: false, reason: 'INVALID' });
    expect(parseOpenAmount('1e5')).toEqual({ ok: false, reason: 'INVALID' });
    expect(parseOpenAmount('12.')).toEqual({ ok: false, reason: 'INVALID' });
    expect(parseOpenAmount('1234567890123456')).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });
});

describe('other exact formatters', () => {
  it('formats ETH from wei by truncation', () => {
    expect(formatEth('1234567890123456789')).toBe('1.23456 ETH');
    expect(formatEth('999999999999999999', 3)).toBe('0.999 ETH');
    expect(formatEth('0')).toBe('0.00000 ETH');
    expect(formatEth('12', 0)).toBe('0 ETH');
    expect(formatEth('-1')).toBe('—');
  });
  it('formats x100 multipliers', () => {
    expect(formatX100(101)).toBe('1.01×');
    expect(formatX100(5000)).toBe('50.00×');
    expect(formatX100('250')).toBe('2.50×');
    expect(formatX100(0)).toBe('—');
    expect(formatX100(1.5)).toBe('—');
    expect(formatX100(null)).toBe('—');
  });
  it('sums, ratios and deltas on bigints', () => {
    expect(sumCenti(['100', '250', 5n, 'bad'])).toBe(355n);
    expect(centiRatio('1', '3')).toBeCloseTo(0.333333, 6);
    expect(centiRatio('5', '0')).toBeNull();
    expect(centiDelta('110', '100')).toBe(0.1);
    expect(centiDelta('-50', '-100')).toBe(0.5);
    expect(centiDelta('1', '0')).toBeNull();
    expect(centiToNumber('123456')).toBe(1234.56);
    expect(Number.isNaN(centiToNumber('x'))).toBe(true);
  });
});

describe('non-money formatting', () => {
  it('formats counts, percentages and points', () => {
    expect(formatInt(7412)).toBe('7,412');
    expect(formatInt(-10000)).toBe(`${MINUS}10,000`);
    expect(formatPct(0.9712)).toBe('97.12%');
    expect(formatPct(-0.001, 1)).toBe(`${MINUS}0.1%`);
    expect(formatPct(0.02, 2, true)).toBe('+2.00%');
    expect(formatPct(-0.00001, 2)).toBe('0.00%');
    expect(formatPct(Number.NaN)).toBe('—');
    expect(formatPts(0.05)).toBe('+5.00 pts');
    expect(formatPts(-0.021)).toBe(`${MINUS}2.10 pts`);
    expect(formatPts(0)).toBe('0.00 pts');
  });
  it('formats times in UTC and ages', () => {
    expect(formatDateTime(Date.UTC(2026, 8, 26, 7, 5, 9))).toBe('2026-09-26 07:05:09 UTC');
    expect(formatAge(1300)).toBe('1.3 s');
    expect(formatAge(75_000)).toBe('1 m 15 s');
    expect(formatAge(7_200_000)).toBe('2 h 0 m');
  });
  it('groups price strings and labels squares', () => {
    expect(formatPrice('64010.5')).toBe('64,010.5');
    expect(formatPrice('-1234')).toBe(`${MINUS}1,234`);
    expect(formatPrice('abc')).toBe('abc');
    expect(formatPrice(undefined)).toBe('—');
    const start = Date.UTC(2026, 8, 26, 14, 0, 15);
    expect(squareLabel(start, 6401, '64010.00', start - 6_000)).toBe('64,010 · +6 s');
    expect(squareLabel(start, 4903, '2451.50')).toBe('2,451.50 · 14:00:15');
    expect(squareLabel(start, 4903)).toBe('band #4903 · 14:00:15');
  });
  it('shortens addresses and builds explorer links only on Base Sepolia', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(shortAddress(addr)).toBe('0x1234…5678');
    expect(shortAddress(`player:${addr}`)).toBe('0x1234…5678');
    expect(shortAddress('sim:0042')).toBe('sim:0042');
    expect(explorerUrl(84532, 'address', addr)).toBe(`https://sepolia.basescan.org/address/${addr}`);
    expect(explorerUrl(31337, 'address', addr)).toBeNull();
    expect(explorerUrl(84532, 'tx', addr)).toBeNull();
  });
});
