import { describe, expect, it } from 'vitest';
import {
  attestPlan, buildPatch, CONFIRM_NAMES, displayField, effectiveEdge, fundPlan, launchNeedsConfirm, launchPlan, limitsPlan, marketPlan, parseField,
  pauseAllPlan, playerPlan, prepareSubmission, PRICING_FIELDS, pricingNeedsConfirm, pricingPlan, rawField, resumeAllPlan, simPlan, validateLimitHierarchy,
  vaultPlan, withdrawSurplusPlan, LIMIT_FIELDS, LAUNCH_FIELDS, type ActionPlan,
} from './controls.js';
import { chainFixture, launchFixture, limitsFixture, marketFixture, playerFixture, pricingFixture } from './test-fixtures.js';

const field = (key: string) => [...PRICING_FIELDS, ...LIMIT_FIELDS, ...LAUNCH_FIELDS].find(f => f.key === key)!;
const REASON = 'Incident 2026-09-26: tightening risk';

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

describe('parseField', () => {
  it('parses percentages exactly into fractions', () => {
    expect(parseField(field('standardEdge'), '8')).toEqual({ ok: true, value: 0.08 });
    expect(parseField(field('standardEdge'), '3.5%')).toEqual({ ok: true, value: 0.035 });
    expect(parseField(field('cellFraction'), '0.1')).toEqual({ ok: true, value: 0.001 });
    expect(parseField(field('standardEdge'), '7.3')).toEqual({ ok: true, value: 0.073 });
  });
  it('enforces SPEC ranges: edge 1–25 %, cap 200–10000', () => {
    expect(parseField(field('standardEdge'), '0.5')).toMatchObject({ ok: false });
    expect(parseField(field('standardEdge'), '25')).toEqual({ ok: true, value: 0.25 });
    expect(parseField(field('standardEdge'), '25.01')).toMatchObject({ ok: false, error: expect.stringContaining('maximum is 25.00%') });
    expect(parseField(field('capX100'), '199')).toMatchObject({ ok: false });
    expect(parseField(field('capX100'), '10,000')).toEqual({ ok: true, value: 10000 });
    expect(parseField(field('capX100'), '10001')).toMatchObject({ ok: false });
    expect(parseField(field('capX100'), '250.5')).toMatchObject({ ok: false, error: expect.stringContaining('whole numbers') });
  });
  it('parses enums, booleans and OPEN amounts', () => {
    expect(parseField(field('aboveCap'), 'cap')).toEqual({ ok: true, value: 'cap' });
    expect(parseField(field('aboveCap'), 'clip')).toMatchObject({ ok: false });
    expect(parseField(field('enabled'), 'false')).toEqual({ ok: true, value: false });
    expect(parseField(field('maxStakePerBetCenti'), '1,500.25')).toEqual({ ok: true, value: '150025' });
    expect(parseField(field('maxStakePerBetCenti'), '1.001')).toMatchObject({ ok: false, error: expect.stringContaining('0.01 OPEN') });
    expect(parseField(field('impactK'), '')).toMatchObject({ ok: false });
    expect(parseField(field('impactK'), '-1')).toMatchObject({ ok: false });
  });
  it('round-trips display and raw values', () => {
    expect(displayField(field('standardEdge'), 0.08)).toBe('8.00%');
    expect(displayField(field('cellFraction'), 0.001)).toBe('0.100%');
    expect(displayField(field('capX100'), 5000)).toBe('50.00× (5000)');
    expect(displayField(field('maxStakePerBetCenti'), '100000')).toBe('1,000.00 OPEN');
    expect(displayField(field('enabled'), true)).toBe('On');
    expect(displayField(field('z'), undefined)).toBe('not reported');
    expect(rawField(field('standardEdge'), 0.07)).toBe('7');
    expect(rawField(field('cellFraction'), 0.0015)).toBe('0.15');
    expect(rawField(field('maxStakePerBetCenti'), '150025')).toBe('1500.25');
    const parsed = parseField(field('standardEdge'), rawField(field('standardEdge'), 0.073));
    expect(parsed).toEqual({ ok: true, value: 0.073 });
  });
});

describe('buildPatch', () => {
  it('diffs only changed, non-blank fields with before → after text', () => {
    const result = ok(buildPatch(PRICING_FIELDS, pricingFixture() as unknown as Record<string, unknown>, { standardEdge: '9', capX100: '5000', impactK: '', z: '1.5' }));
    expect(result.patch).toEqual({ standardEdge: 0.09, z: 1.5 });
    expect(result.changes).toEqual([
      { key: 'standardEdge', label: 'Standard edge', before: '8.00%', after: '9.00%', beforeKnown: true },
      { key: 'z', label: 'Uncertainty z', before: '1', after: '1.5', beforeKnown: true },
    ]);
  });
  it('reports "no changes" and per-field errors', () => {
    expect(buildPatch(PRICING_FIELDS, pricingFixture() as unknown as Record<string, unknown>, { standardEdge: '8.00' })).toEqual({ ok: false, errors: { _form: expect.stringContaining('Nothing to change') } });
    const bad = buildPatch(PRICING_FIELDS, undefined, { standardEdge: '40', capX100: 'abc' });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(['capX100', 'standardEdge']);
  });
  it('marks unknown "before" values instead of inventing them', () => {
    const result = ok(buildPatch(PRICING_FIELDS, undefined, { capX100: '4000' }));
    expect(result.changes[0]).toMatchObject({ before: 'not reported', beforeKnown: false, after: '40.00× (4000)' });
  });
  it('compares OPEN amounts exactly', () => {
    expect(buildPatch(LIMIT_FIELDS, limitsFixture() as unknown as Record<string, unknown>, { maxStakePerBetCenti: '1000.00' }).ok).toBe(false);
    expect(ok(buildPatch(LIMIT_FIELDS, limitsFixture() as unknown as Record<string, unknown>, { maxStakePerBetCenti: '1000.01' })).patch).toEqual({ maxStakePerBetCenti: '100001' });
  });
});

describe('danger classification', () => {
  it('pricing: an edge move over 2 pts needs confirmation, 2 pts exactly does not', () => {
    const before = pricingFixture({ standardEdge: 0.08 });
    expect(pricingNeedsConfirm(before, { standardEdge: 0.1 })).toBe(false);
    expect(pricingNeedsConfirm(before, { standardEdge: 0.06 })).toBe(false);
    expect(pricingNeedsConfirm(before, { standardEdge: 0.1001 })).toBe(true);
    expect(pricingNeedsConfirm(before, { standardEdge: 0.05 })).toBe(true);
    expect(pricingNeedsConfirm(before, { capX100: 2000 })).toBe(false);
    expect(pricingNeedsConfirm(undefined, { standardEdge: 0.08 })).toBe(true);
  });
  it('launch: ending the boost early swings the charged edge and needs confirmation', () => {
    const before = launchFixture();
    expect(effectiveEdge(before, 7412)).toBe(0.03);
    expect(effectiveEdge(before, 10_000)).toBe(0.08);
    expect(launchNeedsConfirm(before, 7412, { enabled: false })).toBe(true);
    expect(launchNeedsConfirm(before, 7412, { untilPlayers: 7000 })).toBe(true);
    expect(launchNeedsConfirm(before, 7412, { untilPlayers: 20_000 })).toBe(false);
    expect(launchNeedsConfirm(before, 7412, { edge: 0.05 })).toBe(false);
    expect(launchNeedsConfirm(before, 7412, { edge: 0.06 })).toBe(true);
    // After the boost ended, changing its edge is > 2 pts but does not change the charged edge; still dangerous by the edge rule.
    expect(launchNeedsConfirm(launchFixture({ active: false }), 12_000, { edge: 0.06 })).toBe(true);
    expect(launchNeedsConfirm(undefined, 0, { untilPlayers: 5 })).toBe(true);
  });
  it('limits must nest cell ≤ column ≤ global and account ≤ global', () => {
    expect(validateLimitHierarchy(limitsFixture(), { cellFraction: 0.006 })).toContain('Per-cell');
    expect(validateLimitHierarchy(limitsFixture(), { columnFraction: 0.03 })).toContain('Per-column');
    expect(validateLimitHierarchy(limitsFixture(), { accountFraction: 0.05 })).toContain('Per-account');
    expect(validateLimitHierarchy(limitsFixture(), { maxStakePerBetCenti: '600000' })).toContain('Max stake per bet');
    expect(validateLimitHierarchy(limitsFixture(), { cellFraction: 0.004 })).toBeNull();
    expect(validateLimitHierarchy(undefined, { cellFraction: 0.2 })).toBeNull();
  });
});

describe('action plans', () => {
  it('pricing plan requires typing edge-change for a large edge move', () => {
    const plan = ok(pricingPlan(pricingFixture(), { standardEdge: '12' })).plan;
    expect(plan.confirmName).toBe(CONFIRM_NAMES.edgeChange);
    expect(plan.method).toBe('PUT');
    expect(plan.path).toBe('/pricing');
    expect(plan.changes).toEqual([{ key: 'standardEdge', label: 'Standard edge', before: '8.00%', after: '12.00%', beforeKnown: true }]);
    const small = ok(pricingPlan(pricingFixture(), { standardEdge: '9' })).plan;
    expect(small.confirmName).toBeNull();
  });

  it('launch plan shows the resulting edge on new quotes', () => {
    const plan = ok(launchPlan(launchFixture(), 7412, { enabled: 'false' })).plan;
    expect(plan.changes).toEqual([
      { key: 'enabled', label: 'Launch boost', before: 'On', after: 'Off', beforeKnown: true },
      { key: 'effectiveEdge', label: 'Edge on new quotes', before: '3.00%', after: '8.00%', beforeKnown: true },
    ]);
    expect(plan.confirmName).toBe('edge-change');
    const threshold = ok(launchPlan(launchFixture(), 7412, { untilPlayers: '7000' })).plan;
    expect(threshold.warnings.join(' ')).toContain('ends immediately');
    const extend = ok(launchPlan(launchFixture(), 7412, { untilPlayers: '15000' })).plan;
    expect(extend.confirmName).toBeNull();
  });

  it('limits plan rejects a broken hierarchy with a form error', () => {
    expect(limitsPlan(limitsFixture(), { cellFraction: '1' })).toEqual({ ok: false, errors: { _form: 'Per-cell limit cannot exceed the per-column limit.' } });
    const plan = ok(limitsPlan(limitsFixture(), { globalFraction: '1.5' })).plan;
    expect(plan.warnings.join(' ')).toContain('Tightening global');
    expect(plan.confirmName).toBeNull();
  });

  it('pause-all and vault pause always need typed confirmation; resume does not', () => {
    const markets = [marketFixture('BTC/USD'), marketFixture('ETH/USD', { paused: true })];
    const pause = pauseAllPlan(markets);
    expect(pause.confirmName).toBe('pause-all');
    expect(pause.changes[0]).toMatchObject({ before: 'BTC/USD', after: 'none' });
    expect(resumeAllPlan(markets).confirmName).toBeNull();
    expect(vaultPlan(chainFixture(), 'pause').confirmName).toBe('vault-pause');
    expect(vaultPlan(chainFixture(), 'unpause').confirmName).toBeNull();
    expect(marketPlan(markets[0]!, 'pause')).toMatchObject({ confirmName: null, path: '/markets/BTC%2FUSD/pause' });
    expect(marketPlan(markets[1]!, 'pause').warnings[0]).toContain('already paused');
  });

  it('fund plan validates against the operator balance and projects balances exactly', () => {
    const chain = chainFixture({ operatorTokenCenti: '1000000' });
    expect(fundPlan(chain, '10000.01')).toEqual({ ok: false, errors: { amount: "Exceeds the operator's 10,000.00 OPEN balance." } });
    expect(fundPlan(chain, '0.001')).toMatchObject({ ok: false, errors: { amount: expect.stringContaining('0.01 OPEN') } });
    const plan = ok(fundPlan(chain, '2,500.50')).plan;
    expect(plan.changes).toEqual([
      { key: 'houseFunded', label: 'Vault house funded', before: '800,000.00 OPEN', after: '802,500.50 OPEN', beforeKnown: true },
      { key: 'operatorToken', label: 'Operator tOPEN', before: '10,000.00 OPEN', after: '7,499.50 OPEN', beforeKnown: true },
    ]);
    expect(prepareSubmission(plan, REASON, '')).toEqual({ ok: true, request: { method: 'POST', path: '/treasury/fund', body: { amountCenti: '250050', reason: REASON } } });
  });

  it('withdraw-surplus is capped by the surplus and by what the vault allows now', () => {
    const now = 1_790_000_000_000;
    const chain = chainFixture();
    expect(withdrawSurplusPlan(chain, '600000.01', now)).toMatchObject({ ok: false, errors: { amount: expect.stringContaining('attested surplus') } });
    const plan = ok(withdrawSurplusPlan(chain, '600000', now)).plan;
    expect(plan.confirmName).toBe('withdraw-surplus');
    expect(plan.changes[0]).toMatchObject({ before: '600,000.00 OPEN', after: '0.00 OPEN' });
    // SPEC-11: the obligations buffer and the daily house cap bound withdrawHouse below the surplus.
    const buffered = chainFixture({ vault: { houseWithdrawableCenti: '54000000', houseBufferBps: 1000 } });
    expect(withdrawSurplusPlan(buffered, '540000.01', now)).toMatchObject({ ok: false, errors: { amount: expect.stringContaining('540,000.00 OPEN') } });
    const capped = ok(withdrawSurplusPlan(buffered, '540000', now)).plan;
    expect(capped.changes.find(c => c.key === 'withdrawable')).toMatchObject({ before: '540,000.00 OPEN', after: '0.00 OPEN' });
    const escape = chainFixture({ vault: { escape: { mode: true, available: true, lastAttestationAtMs: now - 8 * 86_400_000, escapeDelaySec: 604_800, availableAtMs: now - 86_400_000, secondsUntilAvailable: 0, poolWei: '1', claimedWei: '0' } } });
    expect(withdrawSurplusPlan(escape, '1', now)).toMatchObject({ ok: false, errors: { amount: expect.stringContaining('escape mode') } });
  });

  it('withdraw-surplus does not block on a stale attestation: the server attests first (house-server treasury rule)', () => {
    const now = 1_790_000_000_000;
    const stale = chainFixture({ lastAttestation: { seq: 3, asOfMs: now - 3_600_001, liabilitiesCenti: '0', ledgerRoot: '0x00' } });
    const stalePlan = ok(withdrawSurplusPlan(stale, '1', now)).plan;
    expect(stalePlan.confirmName).toBe('withdraw-surplus');
    expect(stalePlan.warnings).toEqual(expect.arrayContaining([expect.stringContaining('fresh attestation'), expect.stringContaining('older than the vault allows')]));
    const missing = ok(withdrawSurplusPlan(chainFixture({ lastAttestation: null }), '1', now)).plan;
    expect(missing.warnings).toEqual(expect.arrayContaining([expect.stringContaining('missing')]));
    const fresh = ok(withdrawSurplusPlan(chainFixture(), '1', now)).plan;
    expect(fresh.warnings.some(w => w.includes('older than') || w.includes('missing'))).toBe(false);
  });

  it('player, refit, attest and sim plans describe their state change', () => {
    const player = playerFixture({ flagged: false, blocked: false });
    expect(playerPlan(player, 'flag').changes[0]).toMatchObject({ before: 'Not flagged', after: 'Flagged' });
    expect(playerPlan(player, 'block')).toMatchObject({ path: '/players/player%3A0x4444444444444444444444444444444444444444/block', confirmName: null });
    expect(attestPlan(chainFixture()).changes[0]).toMatchObject({ before: '12', after: '13' });
    expect(ok(simPlan({ running: true, speed: 20, arrivalsPerMin: 300 }, { running: 'false' })).plan.changes[0]).toMatchObject({ before: 'On', after: 'Off' });
  });
});

describe('prepareSubmission', () => {
  const dangerous: ActionPlan = pauseAllPlan([marketFixture('BTC/USD')]);

  it('requires a reason of at least 8 characters', () => {
    expect(prepareSubmission(dangerous, '  short ', 'pause-all')).toMatchObject({ ok: false, errors: { reason: expect.stringContaining('at least 8') } });
    expect(prepareSubmission(dangerous, 'x'.repeat(501), 'pause-all')).toMatchObject({ ok: false, errors: { reason: expect.stringContaining('under 500') } });
  });

  it('requires the exact action name, case-sensitive', () => {
    for (const typed of ['', 'pause all', 'Pause-All', 'pause-all!', 'pause']) {
      expect(prepareSubmission(dangerous, REASON, typed)).toMatchObject({ ok: false, errors: { confirm: 'Type pause-all exactly to confirm.' } });
    }
  });

  it('reports both errors at once', () => {
    const result = prepareSubmission(dangerous, '', 'nope');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.reason).toBeDefined();
    expect(result.errors.confirm).toBeDefined();
  });

  it('builds the request with trimmed reason and the canonical confirm value', () => {
    expect(prepareSubmission(dangerous, `  ${REASON}  `, '  pause-all ')).toEqual({ ok: true, request: { method: 'POST', path: '/pause-all', body: { reason: REASON, confirm: 'pause-all' } } });
  });

  it('never sends confirm for non-dangerous plans', () => {
    const plan = resumeAllPlan([marketFixture('BTC/USD', { paused: true })]);
    expect(prepareSubmission(plan, REASON, 'pause-all')).toEqual({ ok: true, request: { method: 'POST', path: '/resume-all', body: { reason: REASON } } });
  });
});
