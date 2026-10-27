import { describe, expect, it } from 'vitest';
import { addDecimal, bucketIndex, cellId, compareDecimal, createCell, decimalToNumber, decimalToString, floorDivide, formatCents, formatMultiplier, grossReturn, integer, multiplierHundredths, normalizeDecimal, parseDecimal, priceBucket, sampleId, sampleTouchesCell, windowStart } from '../src/index.js';

describe('exact source prices and canonical identity', () => {
  it('preserves the raw source decimal that binary display floats cannot represent', () => {
    const source = parseDecimal('2573.9578848700003');
    expect(decimalToString(source)).toBe('2573.9578848700003');
    expect(compareDecimal(source, parseDecimal('2573.9578848700002'))).toBe(1);
    expect(JSON.parse(JSON.stringify(source))).toEqual(source);
  });
  it.each(['0.50', '0.5', '5e-1', '50e-2', '+000.5000'])('normalizes %s identically', text => {
    expect(parseDecimal(text)).toEqual({ coefficient: '5', exponent: -1 });
  });
  it('normalizes negative zero and compares across exponents exactly', () => {
    expect(parseDecimal('-0.000')).toEqual(parseDecimal('0'));
    expect(compareDecimal(parseDecimal('1e30'), parseDecimal('999999999999999999999999999999'))).toBe(1);
    expect(decimalToString(addDecimal(parseDecimal('0.1'), parseDecimal('0.2')))).toBe('0.3');
  });
  it.each(['NaN', 'Infinity', '1.2.3', '1e999999', ' 1', '', '.5', '0x10'])('rejects malformed/unbounded input %s', text => expect(() => parseDecimal(text)).toThrow());
  it('rejects malicious or fractional exponent/oversized coefficient without bigint explosions', () => {
    expect(() => normalizeDecimal({ coefficient: '1', exponent: 0.5 })).toThrow();
    expect(() => normalizeDecimal({ coefficient: '1'.repeat(300), exponent: 0 })).toThrow();
    expect(() => integer('1.5')).toThrow();
    expect(() => integer('-1')).toThrow();
  });
  it('floors bucket division on both sides of zero and exact boundaries', () => {
    expect(floorDivide(-1n, 10n)).toBe(-1n);
    expect(floorDivide(-10n, 10n)).toBe(-1n);
    expect(bucketIndex(parseDecimal('2573.9999999999999'), parseDecimal('0.5'))).toBe(5147n);
    expect(bucketIndex(parseDecimal('2574'), parseDecimal('0.50'))).toBe(5148n);
    const bucket = priceBucket(parseDecimal('65009.999'), parseDecimal('10'));
    expect(decimalToString(bucket.lowerPrice)).toBe('65000');
    expect(decimalToString(bucket.upperPrice)).toBe('65010');
    expect(() => bucketIndex(parseDecimal('1'), parseDecimal('0'))).toThrow();
  });
  it('gives equivalent bounds one cap identity across rule revisions', () => {
    const old = createCell('eth-usd', 10000, parseDecimal('2500'), parseDecimal('2500.5'), 'old');
    const newer = createCell('eth-usd', 10000, parseDecimal('250000e-2'), parseDecimal('250050e-2'), 'new');
    expect(old.cellId).toBe(newer.cellId);
    expect(Object.isFrozen(old.lowerPrice)).toBe(true);
    expect(() => createCell('eth-usd', 10001, parseDecimal('1'), parseDecimal('2'))).toThrow();
    expect(() => cellId({ ...old, endMs: old.startMs })).toThrow();
  });
  it('uses source time, exact inclusive price, and market identity for touches', () => {
    const cell = createCell('eth-usd', 10000, parseDecimal('2500'), parseDecimal('2500.5'));
    const sample = { marketId: 'eth-usd' as const, sourceTimeMs: 10000, price: parseDecimal('2500') };
    expect(sampleTouchesCell(sample, cell)).toBe(true);
    expect(sampleTouchesCell({ ...sample, sourceTimeMs: 14999, price: parseDecimal('2500.5') }, cell)).toBe(true);
    expect(sampleTouchesCell({ ...sample, sourceTimeMs: 15000 }, cell)).toBe(false);
    expect(sampleTouchesCell({ ...sample, price: parseDecimal('2500.5000000000001') }, cell)).toBe(false);
    expect(sampleTouchesCell({ ...sample, marketId: 'btc-usd' }, cell)).toBe(false);
    expect(windowStart(14999)).toBe(10000);
    expect(sampleId('0xabc', 10000)).toBe('lynx:bsc:0xabc:10000');
    expect(() => windowStart(NaN)).toThrow();
  });
});

describe('stake debit versus gross return arithmetic', () => {
  it.each([['500', '250', '1250'], ['50', '201', '101'], ['10', '105', '11'], ['10', '104', '10'], ['9007199254740993', '250', '22517998136852483']])('pays %s at %s hundredths as %s cents', (stake, odds, expected) => {
    expect(grossReturn(stake, odds)).toBe(expected);
  });
  it('floors model odds before formatting and final-cent rounding', () => {
    expect(multiplierHundredths(parseDecimal('2.019'))).toBe('201');
    expect(multiplierHundredths(parseDecimal('2.01'))).toBe('201');
    expect(multiplierHundredths(parseDecimal('2.0099999999999999'))).toBe('200');
    expect(formatMultiplier('201')).toBe('2.01×');
    expect(formatCents(grossReturn('50', '201'))).toBe('$1.01');
  });
  it('formats large amounts without loss and explicitly supports negative profit labels', () => {
    expect(formatCents('900719925474099301')).toBe('$9,007,199,254,740,993.01');
    expect(formatCents('-750')).toBe('-$7.50');
    expect(() => grossReturn('-10', '200')).toThrow();
    expect(() => grossReturn('10', '0')).toThrow();
    expect(() => multiplierHundredths(parseDecimal('0.001'))).toThrow();
    expect(decimalToNumber(parseDecimal('0.5'))).toBe(0.5);
  });
});
