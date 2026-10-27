import { describe, expect, it } from 'vitest';
import { formatOpen, formatOpenShort, livePresentation, LIVE_STAKES_CENTI } from '../src/live/presentation.js';
import { phoneDialogMarkup, rootMarkup } from '../src/presentation.js';

describe('live presentation', () => {
  it('formats exact OPEN amounts from Centi', () => {
    expect(formatOpen('0')).toBe('0.00 OPEN');
    expect(formatOpen('123456789')).toBe('1,234,567.89 OPEN');
    expect(formatOpen('-5')).toBe('-0.05 OPEN');
    expect(formatOpenShort('100')).toBe('1 OPEN');
    expect(formatOpenShort('250')).toBe('2.5 OPEN');
    expect(formatOpenShort('1005')).toBe('10.05 OPEN');
  });
  it('has no play limit, OPEN stakes above the house minimum, and TESTNET labelling', () => {
    const p = livePresentation();
    expect(p.mode).toBe('live');
    expect(p.playLimit).toBeNull();
    for (const s of LIVE_STAKES_CENTI) expect(BigInt(s)).toBeGreaterThanOrEqual(10n); // house minimum stake 10 Centi
    const root = rootMarkup(p);
    expect(root).toContain('MAYA <span>TESTNET</span>');
    expect(root).toContain('data-action="refill"');
    expect(root).toContain('data-action="withdraw"');
    expect(root).not.toContain('Paper');
    expect(root).not.toContain('allowance');
    const phone = phoneDialogMarkup(p);
    expect(phone).toContain('tOPEN is a test mock of $OPEN');
    expect(phone).not.toContain('data-phone-reload');
    expect(p.helpHtml).toContain('TESTNET');
  });
});
