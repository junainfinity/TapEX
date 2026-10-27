import { describe, expect, it } from 'vitest';
import { DEMO_CONFIG } from '@maya/config';
import { formatCents } from '@maya/contracts';
import { PAPER_PRESENTATION, phoneAccountMarkup, phoneBarMarkup, phoneDialogMarkup, rootMarkup } from '../src/presentation.js';
import { PAPER_GOLDEN } from './paper-golden.js';

describe('paper presentation is the pre-Stage-B demo, string for string', () => {
  it('reproduces the original board, help and phone markup exactly', () => {
    expect(rootMarkup(PAPER_PRESENTATION)).toBe(PAPER_GOLDEN.root);
    expect(PAPER_PRESENTATION.helpHtml).toBe(PAPER_GOLDEN.help);
    expect(phoneAccountMarkup(PAPER_PRESENTATION)).toBe(PAPER_GOLDEN.phoneAccount);
    expect(phoneBarMarkup(PAPER_PRESENTATION)).toBe(PAPER_GOLDEN.phoneBar);
    expect(phoneDialogMarkup(PAPER_PRESENTATION)).toBe(PAPER_GOLDEN.phoneDialog);
  });
  it('keeps the paper stakes, money format, ten-play limit and stake label', () => {
    expect(PAPER_PRESENTATION.stakes).toBe(DEMO_CONFIG.stakeMenuCents);
    expect(PAPER_PRESENTATION.initialStake).toBe(DEMO_CONFIG.initialStakeCents);
    expect(PAPER_PRESENTATION.playLimit).toBe(10);
    for (const v of ['0', '10', '100', '123456', '-250']) expect(PAPER_PRESENTATION.formatMoney(v)).toBe(formatCents(v));
    // The original stake control rendered '$' + cents / 100.
    for (const v of DEMO_CONFIG.stakeMenuCents) expect(PAPER_PRESENTATION.formatStake(v)).toBe('$' + Number(v) / 100);
  });
});
