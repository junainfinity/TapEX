import { describe, expect, it } from 'vitest';
import { createAlertThrottle, toastText } from './alert-throttle.js';
import { attestationHealth, chainNowMs, escapeHealth, signerHealth, worstAlertLevel } from './chain-health.js';
import { houseWithdrawableCenti, signerAcceptPlan, signerCancelPlan, signerProposePlan, sweepExcessPlan, prepareSubmission } from './controls.js';
import { chainFixture, OPERATOR, VAULT } from './test-fixtures.js';
import type { EscapeState } from './types.js';

const DAY = 86_400_000;
const T0 = 1_790_000_000_000;
const escape = (overrides: Partial<EscapeState> = {}): EscapeState => ({
  mode: false, available: false, lastAttestationAtMs: T0, escapeDelaySec: 7 * 86_400, availableAtMs: T0 + 7 * DAY, secondsUntilAvailable: 7 * 86_400, poolWei: '0', claimedWei: '0', ...overrides,
});
const SIGNER = '0x5555555555555555555555555555555555555555';
const NEXT = '0x6666666666666666666666666666666666666666';
const REASON = 'Planned key rotation to the new signer';

describe('escape-hatch clock (thresholds of src/chain-alerts.ts)', () => {
  it('is healthy below 50 %, warns from 50 %, critical from 75 %, then available', () => {
    expect(escapeHealth(escape(), T0 + DAY).level).toBe('good');
    expect(escapeHealth(escape(), T0 + 3.5 * DAY)).toMatchObject({ level: 'warning', fraction: 0.5 });
    expect(escapeHealth(escape(), T0 + 5.25 * DAY).level).toBe('critical');
    expect(escapeHealth(escape(), T0 + 7 * DAY)).toMatchObject({ level: 'critical', leftMs: 0, label: expect.stringContaining('available') });
    expect(escapeHealth(escape({ available: true }), T0 + DAY).label).toContain('available');
    expect(escapeHealth(escape({ mode: true }), T0).label).toContain('irreversible');
    expect(escapeHealth(escape(), T0 + DAY).leftMs).toBe(6 * DAY);
  });
});

describe('attestation freshness and signer state', () => {
  it('compares the attestation age with the vault maxAttestationAge', () => {
    const fresh = chainFixture({ vault: { maxAttestationAgeSec: 600 }, lastAttestation: { seq: 1, asOfMs: T0, liabilitiesCenti: '0', ledgerRoot: '0x' } });
    expect(attestationHealth(fresh, T0 + 60_000).level).toBe('good');
    expect(attestationHealth(fresh, T0 + 500_000).label).toContain('Ageing');
    expect(attestationHealth(fresh, T0 + 600_001).label).toContain('Stale');
    expect(attestationHealth(chainFixture({ lastAttestation: null }), T0)).toMatchObject({ level: 'warning', ageMs: null });
  });

  it('ranks signer mismatch and a due rotation above a pending one', () => {
    expect(signerHealth(chainFixture({ vault: { ledgerSigner: SIGNER, serverSigner: SIGNER, signerMismatch: false, pendingSigner: null } })).level).toBe('good');
    expect(signerHealth(chainFixture({ vault: { ledgerSigner: SIGNER, pendingSigner: { address: NEXT, etaMs: T0, due: false } } })).level).toBe('warning');
    expect(signerHealth(chainFixture({ vault: { ledgerSigner: SIGNER, pendingSigner: { address: NEXT, etaMs: T0, due: true } } })).level).toBe('critical');
    expect(signerHealth(chainFixture({ vault: { ledgerSigner: NEXT, serverSigner: SIGNER, signerMismatch: true } })).label).toContain('mismatch');
    expect(worstAlertLevel([{ level: 'warning' }, { level: 'critical' }])).toBe('critical');
    expect(worstAlertLevel([])).toBeNull();
  });

  it('uses the feed clock for the offline vault and the demo, wall time for live chains', () => {
    expect(chainNowMs('offline', false, 1_000, 9_999)).toBe(1_000);
    expect(chainNowMs('base-sepolia', true, 1_000, 9_999)).toBe(1_000);
    expect(chainNowMs('base-sepolia', false, 1_000, 9_999)).toBe(9_999);
    expect(chainNowMs('offline', false, null, 9_999)).toBe(9_999);
  });
});

describe('vault plans (SPEC-11)', () => {
  const chain = chainFixture({ vault: { ledgerSigner: SIGNER, serverSigner: SIGNER, signerChangeDelaySec: 172_800, pendingSigner: null, excessWei: '1234560000000000000042' } });

  it('propose: validates the address and demands signer-propose', () => {
    expect(signerProposePlan(chain, '0x123', OPERATOR)).toMatchObject({ ok: false, errors: { address: expect.stringContaining('0x address') } });
    expect(signerProposePlan(chain, `0x${'0'.repeat(40)}`, OPERATOR)).toMatchObject({ ok: false, errors: { address: expect.stringContaining('zero') } });
    expect(signerProposePlan(chain, OPERATOR, OPERATOR)).toMatchObject({ ok: false, errors: { address: expect.stringContaining('owner') } });
    expect(signerProposePlan(chain, SIGNER.toUpperCase().replace('0X', '0x'), OPERATOR)).toMatchObject({ ok: false, errors: { address: expect.stringContaining('already') } });
    const r = signerProposePlan(chain, NEXT, OPERATOR);
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.confirmName).toBe('signer-propose');
    expect(r.plan.warnings.join(' ')).toMatch(/2 d 0 h/);
    expect(prepareSubmission(r.plan, REASON, 'signer-propose')).toEqual({ ok: true, request: { method: 'POST', path: '/vault/signer/propose', body: { address: NEXT, reason: REASON, confirm: 'signer-propose' } } });
    expect(prepareSubmission(r.plan, REASON, 'signer_propose')).toMatchObject({ ok: false, errors: { confirm: expect.any(String) } });
  });

  it('accept only once due (the vault would revert TimelockNotElapsed); cancel needs a reason only', () => {
    expect(signerAcceptPlan(chain)).toMatchObject({ ok: false });
    const pending = chainFixture({ vault: { ledgerSigner: SIGNER, pendingSigner: { address: NEXT, etaMs: T0, due: false } } });
    expect(signerAcceptPlan(pending)).toMatchObject({ ok: false, errors: { _form: expect.stringContaining('TimelockNotElapsed') } });
    const due = chainFixture({ vault: { ledgerSigner: SIGNER, pendingSigner: { address: NEXT, etaMs: T0, due: true } } });
    const accept = signerAcceptPlan(due);
    if (!accept.ok) throw new Error('expected a plan');
    expect(accept.plan.confirmName).toBe('signer-accept');
    expect(accept.plan.warnings.join(' ')).toMatch(/2 outstanding vouchers become unredeemable/);
    const cancel = signerCancelPlan(pending);
    if (!cancel.ok) throw new Error('expected a plan');
    expect(cancel.plan.confirmName).toBeNull();
    expect(prepareSubmission(cancel.plan, REASON, '')).toMatchObject({ ok: true, request: { path: '/vault/signer/cancel', body: { reason: REASON } } });
  });

  it('sweep: excess shown exactly (with wei dust), recipient validated, nothing-to-sweep refused', () => {
    const r = sweepExcessPlan(chain, OPERATOR);
    if (!r.ok) throw new Error('expected a plan');
    expect(r.plan.confirmName).toBe('sweep-excess');
    expect(r.plan.changes[0]).toMatchObject({ before: '1,234.56 OPEN + 42 wei', after: '0.00 OPEN' });
    expect(sweepExcessPlan(chain, VAULT)).toMatchObject({ ok: false, errors: { to: expect.stringContaining('vault') } });
    expect(sweepExcessPlan(chainFixture({ vault: { excessWei: '0' } }), OPERATOR)).toMatchObject({ ok: false, errors: { to: expect.stringContaining('Nothing to sweep') } });
    expect(sweepExcessPlan(chainFixture(), OPERATOR)).toMatchObject({ ok: false, errors: { to: expect.stringContaining('does not report') } });
  });

  it('house withdrawable is the smaller of the surplus and the vault figure', () => {
    expect(houseWithdrawableCenti(chainFixture())).toBe(60_000_000n);
    expect(houseWithdrawableCenti(chainFixture({ vault: { houseWithdrawableCenti: '54000000' } }))).toBe(54_000_000n);
    expect(houseWithdrawableCenti(chainFixture({ vault: { houseWithdrawableCenti: '70000000' } }))).toBe(60_000_000n);
  });
});

describe('alert toasts are coalesced per code', () => {
  it('shows the first alert of a code, folds repeats inside the window, then reports the fold count', () => {
    let t = 0;
    const throttle = createAlertThrottle(60_000, () => t);
    const a = { level: 'warning' as const, message: 'Toxicity monitor surcharged sim:1', ms: 0, code: 'TOXIC_FLOW' };
    expect(throttle(a)).toEqual({ show: true, folded: 0 });
    t = 1_000; expect(throttle(a)).toEqual({ show: false, folded: 1 });
    t = 2_000; expect(throttle({ ...a, code: 'BREAKER_DRAWDOWN', level: 'critical' as const })).toEqual({ show: true, folded: 0 });
    t = 3_000; expect(throttle(a).show).toBe(false);
    t = 61_000; const next = throttle(a);
    expect(next).toEqual({ show: true, folded: 2 });
    expect(toastText(a, next.folded)).toContain('+2 more TOXIC_FLOW alerts');
    expect(toastText(a, 0)).toBe(a.message);
  });
});
