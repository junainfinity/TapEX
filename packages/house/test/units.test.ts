import { describe, expect, it } from 'vitest';
import { CENTI_WEI, OPEN_DECIMALS, exceedsFraction, formatOpen, fromWei, liabilityCenti, maxStakeForLiability, mulFloor, parseX100, payoutCenti, rationalOf, toWei, totalWei } from '../src/index.js';
import { rng } from './fixtures.js';

describe('Centi ↔ wei', () => {
  it('uses 1 Centi = 0.01 OPEN = 10^16 wei', () => {
    expect(OPEN_DECIMALS).toBe(18);
    expect(CENTI_WEI).toBe(10_000_000_000_000_000n);
    expect(toWei('1')).toBe(10n ** 16n);
    expect(toWei('100')).toBe(10n ** 18n);
    expect(toWei('0')).toBe(0n);
    expect(toWei('123456789012345678901234567890')).toBe(123456789012345678901234567890n * 10n ** 16n);
  });
  it('credits the floor and keeps the remainder as dust', () => {
    expect(fromWei(10n ** 18n)).toEqual({ centi: '100', dustWei: 0n });
    expect(fromWei(10n ** 18n + 5n)).toEqual({ centi: '100', dustWei: 5n });
    expect(fromWei(CENTI_WEI - 1n)).toEqual({ centi: '0', dustWei: CENTI_WEI - 1n });
    expect(fromWei(0n)).toEqual({ centi: '0', dustWei: 0n });
    expect(Object.isFrozen(fromWei(1n))).toBe(true);
  });
  it('never loses value: centi and dust always reconstruct the exact wei amount', () => {
    const random = rng(7); let dust = 0n, credited = 0n, deposited = 0n;
    for (let i = 0; i < 5000; i++) {
      const wei = BigInt(Math.floor(random() * 1e9)) * 10n ** BigInt(Math.floor(random() * 12)) + BigInt(Math.floor(random() * 1e6));
      const { centi, dustWei } = fromWei(wei);
      expect(dustWei >= 0n && dustWei < CENTI_WEI).toBe(true);
      expect(toWei(centi) + dustWei).toBe(wei);
      expect(totalWei(centi, dustWei)).toBe(wei);
      credited += BigInt(centi); dust += dustWei; deposited += wei;
    }
    // Aggregated dust is still whole-reportable: sweeping it yields exact centi plus residual dust.
    const swept = fromWei(dust);
    expect(totalWei((credited + BigInt(swept.centi)).toString(), swept.dustWei)).toBe(deposited);
  });
  it('rejects invalid amounts', () => {
    expect(() => fromWei(-1n)).toThrow(RangeError);
    expect(() => fromWei(1 as unknown as bigint)).toThrow(RangeError);
    expect(() => toWei('-1')).toThrow(TypeError);
    expect(() => toWei('1.5')).toThrow(TypeError);
    expect(() => toWei('')).toThrow(TypeError);
    expect(() => totalWei('1', -1n)).toThrow(RangeError);
  });
});

describe('payout and liability', () => {
  it('payout = floor(stake × x100 / 100), gross including stake', () => {
    expect(payoutCenti('100', 101)).toBe('101');
    expect(payoutCenti('100', 5000)).toBe('5000');
    expect(payoutCenti('1', 150)).toBe('1');
    expect(payoutCenti('333', 333)).toBe('1108');
    expect(payoutCenti('999', '184')).toBe('1838');
    expect(payoutCenti('12345678901234567890', 12345n)).toBe(((12345678901234567890n * 12345n) / 100n).toString());
    expect(liabilityCenti('100', 101)).toBe('1');
    expect(liabilityCenti('99', 101)).toBe('0');
    expect(liabilityCenti('1000', 250)).toBe('1500');
  });
  it('rejects multipliers that are not integers ≥ 100', () => {
    for (const bad of [99, 1.5, '-1', '1.2', Number.NaN, 2 ** 60]) expect(() => payoutCenti('100', bad as number)).toThrow();
    expect(parseX100('100')).toBe(100n);
  });
  it('maxStakeForLiability is the exact largest stake within headroom', () => {
    const random = rng(3);
    for (let i = 0; i < 20_000; i++) {
      const headroom = BigInt(Math.floor(random() * 100_000)) - (random() < 0.05 ? 50n : 0n);
      const x100 = 101 + Math.floor(random() * 4900);
      const max = maxStakeForLiability(headroom, x100);
      if (headroom < 0n) { expect(max).toBe(0n); continue; }
      const liability = (stake: bigint) => BigInt(liabilityCenti(stake.toString(), x100));
      expect(liability(max) <= headroom).toBe(true);
      expect(liability(max + 1n) > headroom).toBe(true);
    }
    expect(() => maxStakeForLiability(10n, 100)).toThrow(RangeError);
  });
});

describe('formatOpen', () => {
  it('formats Centi as grouped OPEN', () => {
    expect(formatOpen('123456')).toBe('1,234.56 OPEN');
    expect(formatOpen('5')).toBe('0.05 OPEN');
    expect(formatOpen('0')).toBe('0.00 OPEN');
    expect(formatOpen('-100')).toBe('-1.00 OPEN');
    expect(formatOpen('100000000000')).toBe('1,000,000,000.00 OPEN');
    expect(formatOpen('1234', 'tOPEN')).toBe('12.34 tOPEN');
    expect(() => formatOpen('1.5')).toThrow();
  });
});

describe('exact fractions', () => {
  it('reads configured fractions through their decimal text', () => {
    expect(rationalOf(0.001)).toEqual({ n: 1n, d: 1000n });
    expect(rationalOf(0.02)).toEqual({ n: 2n, d: 100n });
    expect(rationalOf(1e-7)).toEqual({ n: 1n, d: 10_000_000n });
    expect(rationalOf(1)).toEqual({ n: 1n, d: 1n });
    expect(rationalOf(0)).toEqual({ n: 0n, d: 1n });
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => rationalOf(bad)).toThrow(RangeError);
  });
  it('mulFloor and exceedsFraction are exact', () => {
    expect(mulFloor(12_345n, 0.001)).toBe(12n);
    expect(mulFloor(1_000_000n, 0.005)).toBe(5000n);
    expect(mulFloor(-1n, 0.5)).toBe(-1n);
    expect(mulFloor(10n ** 30n, 0.02)).toBe(2n * 10n ** 28n);
    expect(exceedsFraction(2n, 100n, 0.02)).toBe(false);
    expect(exceedsFraction(3n, 100n, 0.02)).toBe(true);
    expect(exceedsFraction(20_001n, 1_000_000n, 0.02)).toBe(true);
    expect(() => exceedsFraction(1n, 0n, 0.02)).toThrow(RangeError);
  });
});
