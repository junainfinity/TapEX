import { describe, expect, it } from 'vitest';
import type { ChainWithdrawal } from '../../src/chain-port.js';
import { buildBalanceTree } from '../../src/chain/merkle.js';
import { OfflineChain } from '../../src/offline-chain.js';

const WEI = 10n ** 18n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROOT0 = `0x${'00'.repeat(32)}`;

function chain(nowMs = 1_790_000_000_000) {
  let now = nowMs;
  const c = new OfflineChain({ now: () => now, seed: 'hardening', syncEvents: true, initialHouseFundWei: 1_000_000n * WEI });
  return { c, tick: (ms: number) => { now += ms; }, nowS: () => BigInt(Math.floor(now / 1000)) };
}

describe('OfflineChain mirrors SPEC-11 vault hardening', () => {
  it('reports the hardened configuration in vaultState', async () => {
    const { c, nowS } = chain();
    const s = await c.vaultState();
    expect(s).toMatchObject({
      ledgerSigner: c.addresses().ledgerSigner, pendingSigner: null, signerChangeDelay: 172_800n, pendingSignerChangeDelay: null,
      maxAttestationAge: 600n, houseBufferBps: 1_000n, houseDailyCap: 10_000_000n * WEI, pendingHouseLimits: null, excessWei: 0n,
      accountDailyOutflowCapWei: 250_000n * WEI, pendingLimits: null,
      escape: { mode: false, lastAttestationAt: nowS(), escapeDelay: 604_800n, availableAt: nowS() + 604_800n, poolWei: 0n, claimedWei: 0n, signerSince: nowS(), surplusWei: 0n },
    });
    expect(s.houseWithdrawableWei).toBe(1_000_000n * WEI);
    expect(() => new OfflineChain({ seed: 'x', escapeDelayS: 3n * 86_400n - 1n })).toThrow(/InvalidEscapeDelay/);
  });

  it('rotates the ledger signer only after the timelock; the old key then neither signs nor attests', async () => {
    const { c, tick, nowS } = chain();
    const original = c.addresses().ledgerSigner;
    const next = '0x00000000000000000000000000000000000000aa';
    await expect(c.proposeLedgerSigner('0x0000000000000000000000000000000000000000')).rejects.toThrow(/ZeroAddress/);
    await expect(c.proposeLedgerSigner(c.addresses().operator)).rejects.toThrow(/SignerIsOwner/);
    await expect(c.proposeLedgerSigner(original)).rejects.toThrow(/SignerUnchanged/);
    await expect(c.acceptLedgerSigner()).rejects.toThrow(/NoPendingLedgerSigner/);
    await expect(c.cancelLedgerSigner()).rejects.toThrow(/NoPendingLedgerSigner/);

    await c.playerDeposit('player-1', 100n * WEI);
    const account = c.players()[0]!.address;
    const early = { account, amountWei: WEI, nonce: 1n, expiry: nowS() + 5n * 86_400n };
    const earlySig = await c.signWithdrawal(early);

    await c.proposeLedgerSigner(next);
    expect((await c.vaultState()).pendingSigner).toEqual({ address: next, eta: nowS() + 172_800n, expiresAt: nowS() + 172_800n + 604_800n });
    tick(48 * HOUR - 1000);
    await expect(c.acceptLedgerSigner()).rejects.toThrow(/TimelockNotElapsed/);
    tick(1000);
    await c.acceptLedgerSigner();
    expect(c.addresses().ledgerSigner).toBe(next);
    expect((await c.vaultState())).toMatchObject({ ledgerSigner: next, pendingSigner: null });
    await expect(c.signWithdrawal(early)).rejects.toThrow(/SignerMismatch/);
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 1n })).rejects.toThrow(/NotLedgerSigner/);
    await expect(c.playerWithdraw('player-1', { ...early, signature: earlySig })).rejects.toThrow(/InvalidSignature/);

    // Rotating back re-validates the outstanding voucher (the same key signs again), as on-chain.
    await c.proposeLedgerSigner(original);
    await c.cancelLedgerSigner();
    await expect(c.acceptLedgerSigner()).rejects.toThrow(/NoPendingLedgerSigner/);
    await c.proposeLedgerSigner(original);
    tick(48 * HOUR);
    await c.acceptLedgerSigner();
    await c.playerWithdraw('player-1', { ...early, signature: earlySig });
    expect(await c.nonceUsed(account, 1n)).toBe(true);
  });

  it('applies signer-delay increases at once and timelocks decreases', async () => {
    const { c, tick, nowS } = chain();
    await expect(c.setSignerChangeDelay(3_599n)).rejects.toThrow(/InvalidSignerChangeDelay/);
    await expect(c.setSignerChangeDelay(604_800n)).rejects.toThrow(/InvalidSignerChangeDelay/); // not below the escape delay
    await c.setSignerChangeDelay(259_200n);
    expect(c.signerChangeDelay).toBe(259_200n);
    await c.setSignerChangeDelay(3_600n);
    expect((await c.vaultState()).pendingSignerChangeDelay).toEqual({ delay: 3_600n, eta: nowS() + 259_200n, expiresAt: nowS() + 259_200n + 604_800n });
    await expect(c.acceptSignerChangeDelay()).rejects.toThrow(/TimelockNotElapsed/);
    tick(3 * DAY);
    await c.acceptSignerChangeDelay();
    expect(c.signerChangeDelay).toBe(3_600n);
    await expect(c.acceptSignerChangeDelay()).rejects.toThrow(/NoPendingSignerChangeDelay/);
    await c.setSignerChangeDelay(7_200n);
    await expect(c.cancelSignerChangeDelay()).rejects.toThrow(/NoPendingSignerChangeDelay/);
  });

  it('keeps the house buffer, the daily house cap and the timelock on loosening', async () => {
    const { c, tick, nowS } = chain();
    await c.playerDeposit('player-1', 1_000n * WEI);
    tick(2000);
    await c.attest({ liabilitiesWei: 1_000n * WEI, ledgerRoot: ROOT0, asOf: nowS(), seq: 1n });
    const operator = c.addresses().operator;
    expect(c.houseBuffer()).toBe(100n * WEI);
    expect(c.houseWithdrawable()).toBe(1_000_000n * WEI - 100n * WEI);
    await expect(c.withdrawHouse(1_000_000n * WEI, operator)).rejects.toThrow(/ExceedsHouseWithdrawable/);
    await expect(c.withdrawHouse(1_000_000n * WEI + 1n, operator)).rejects.toThrow(/ExceedsHouseSurplus/);

    await c.setHouseLimits(2_000n, 300_000n * WEI); // tightening: at once
    expect(c.houseDailyCap).toBe(300_000n * WEI);
    await c.withdrawHouse(250_000n * WEI, operator);
    await expect(c.withdrawHouse(50_001n * WEI, operator)).rejects.toThrow(/HouseDailyCapExceeded/);

    await c.setHouseLimits(0n, 300_000n * WEI); // loosening: scheduled
    expect(c.houseBufferBps).toBe(2_000n);
    expect((await c.vaultState()).pendingHouseLimits).toEqual({ houseBufferBps: 0n, houseDailyCap: 300_000n * WEI, eta: nowS() + 172_800n, expiresAt: nowS() + 172_800n + 604_800n });
    await expect(c.acceptHouseLimits()).rejects.toThrow(/TimelockNotElapsed/);
    await c.cancelHouseLimits();
    await expect(c.acceptHouseLimits()).rejects.toThrow(/NoPendingHouseLimits/);
    await expect(c.cancelHouseLimits()).rejects.toThrow(/NoPendingHouseLimits/);
    await c.setHouseLimits(0n, 300_000n * WEI);
    tick(48 * HOUR);
    await c.acceptHouseLimits();
    expect(c.houseBufferBps).toBe(0n);
    await expect(c.setHouseLimits(10_001n, WEI)).rejects.toThrow(/InvalidHouseLimits/);
    await expect(c.setHouseLimits(0n, 0n)).rejects.toThrow(/InvalidHouseLimits/);
    await expect(c.withdrawHouse(WEI, '0x0000000000000000000000000000000000000000')).rejects.toThrow(/ZeroAddress/);
    await expect(c.withdrawHouse(WEI, c.addresses().vault)).rejects.toThrow(/InvalidRecipient/);
  });

  it('sweeps only stray tokens', async () => {
    const { c } = chain();
    const operator = c.addresses().operator;
    await expect(c.sweepExcess(operator)).rejects.toThrow(/NothingToSweep/);
    c.donate(operator, 42n * WEI);
    expect((await c.vaultState()).excessWei).toBe(42n * WEI);
    const before = (await c.vaultState()).assetsWei;
    const result = await c.sweepExcess(operator);
    expect(result.amountWei).toBe(42n * WEI);
    expect((await c.vaultState())).toMatchObject({ assetsWei: before, excessWei: 0n });
    await expect(c.sweepExcess(c.addresses().vault)).rejects.toThrow(/InvalidRecipient/);
  });

  it('emits Withdrawn events keyed by player and nonce', async () => {
    const { c, nowS } = chain();
    const seen: ChainWithdrawal[] = [];
    c.onWithdrawn(w => seen.push(w));
    await c.playerDeposit('player-2', 50n * WEI);
    const account = c.players()[1]!.address;
    const v = { account, amountWei: 20n * WEI, nonce: 9n, expiry: nowS() + 60n };
    const tx = await c.playerWithdraw('player-2', { ...v, signature: await c.signWithdrawal(v) });
    expect(seen).toEqual([{ player: account, amountWei: 20n * WEI, nonce: 9n, txHash: tx.txHash, logIndex: 0, blockNumber: expect.any(BigInt) }]);
    expect(await c.nonceUsed(account.toUpperCase().replace('0X', '0x'), 9n)).toBe(true);
    expect(await c.nonceUsed(account, 10n)).toBe(false);
  });

  it('runs the escape hatch: refuses while fresh, freezes the root, pays proofs net of later flows exactly once', async () => {
    const { c, tick, nowS } = chain();
    const [p1, p2, p3] = c.players();
    await c.playerDeposit('player-1', 300n * WEI);
    await c.playerDeposit('player-2', 200n * WEI);
    tick(10_000);
    const tree = buildBalanceTree([{ account: p1!.address, balanceWei: 250n * WEI }, { account: p2!.address, balanceWei: 260n * WEI }]);
    await c.attest({ liabilitiesWei: 510n * WEI, ledgerRoot: tree.root, asOf: nowS(), seq: 1n });
    tick(10_000);
    await c.playerDeposit('player-3', 100n * WEI);
    const v = { account: p1!.address, amountWei: 50n * WEI, nonce: 1n, expiry: nowS() + 600n };
    await c.playerWithdraw('player-1', { ...v, signature: await c.signWithdrawal(v) });

    await expect(c.playerClaimEscape('player-1', 250n * WEI, tree.proofFor(p1!.address))).rejects.toThrow(/EscapeModeInactive/);
    tick(7 * DAY - 20_000);
    await expect(c.triggerEscape()).rejects.toThrow(/EscapeNotYetAvailable/);
    tick(10_000);
    await c.triggerEscape();
    await expect(c.triggerEscape()).rejects.toThrow(/EscapeModeActive/);
    expect((await c.vaultState()).escape).toMatchObject({ mode: true, poolWei: 610n * WEI, claimedWei: 0n });
    await expect(c.playerDeposit('player-1', WEI)).rejects.toThrow(/EscapeModeActive/);
    await expect(c.fundHouse(WEI)).rejects.toThrow(/EscapeModeActive/);
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 2n })).rejects.toThrow(/EscapeModeActive/);
    await expect(c.withdrawHouse(WEI, c.addresses().operator)).rejects.toThrow(/EscapeModeActive/);

    expect(await c.escapeEntitlement(p1!.address, 250n * WEI)).toBe(200n * WEI);
    await expect(c.playerClaimEscape('player-1', 251n * WEI, tree.proofFor(p1!.address))).rejects.toThrow(/InvalidProof/);
    await expect(c.playerClaimEscape('player-1', 260n * WEI, tree.proofFor(p2!.address))).rejects.toThrow(/InvalidProof/);
    expect((await c.playerClaimEscape('player-1', 250n * WEI, tree.proofFor(p1!.address))).paidWei).toBe(200n * WEI);
    await expect(c.playerClaimEscape('player-1', 250n * WEI, tree.proofFor(p1!.address))).rejects.toThrow(/NothingToClaim/);
    expect((await c.playerClaimEscape('player-2', 260n * WEI, tree.proofFor(p2!.address))).paidWei).toBe(260n * WEI);
    expect((await c.playerClaimEscape('player-3', 0n, [])).paidWei).toBe(100n * WEI);
    expect(c.escapeClaimedByAccount(p3!.address)).toBe(100n * WEI);
    const s = await c.vaultState();
    expect(s.escape.claimedWei).toBe(560n * WEI);
    expect(s.assetsWei).toBe(s.totalDepositsWei + s.houseFundedWei - s.totalWithdrawalsWei - s.houseWithdrawnWei);
    expect((await c.balances(c.addresses().vault)).tokenWei).toBe(s.assetsWei);
  });

  it('caps escape claims at the attested liabilities when a root overstates balances', async () => {
    const { c, tick, nowS } = chain();
    const [p1, p2] = c.players();
    await c.playerDeposit('player-1', 100n * WEI);
    await c.playerDeposit('player-2', 100n * WEI);
    tick(2000);
    const tree = buildBalanceTree([{ account: p1!.address, balanceWei: 300n * WEI }, { account: p2!.address, balanceWei: 300n * WEI }]);
    await c.attest({ liabilitiesWei: 200n * WEI, ledgerRoot: tree.root, asOf: nowS(), seq: 1n });
    tick(7 * DAY);
    await c.triggerEscape();
    expect((await c.playerClaimEscape('player-1', 300n * WEI, tree.proofFor(p1!.address))).paidWei).toBe(200n * WEI);
    await expect(c.playerClaimEscape('player-2', 300n * WEI, tree.proofFor(p2!.address))).rejects.toThrow(/EscapePoolExhausted/);
  });

  it('before any attestation, escape pays each account its net deposits', async () => {
    const { c, tick } = chain();
    await c.playerDeposit('player-1', 70n * WEI);
    tick(7 * DAY);
    await c.triggerEscape();
    await expect(c.playerClaimEscape('player-1', 70n * WEI, [])).rejects.toThrow(/InvalidProof/);
    expect((await c.playerClaimEscape('player-1', 0n, [])).paidWei).toBe(70n * WEI);
    await expect(c.playerClaimEscape('player-2', 0n, [])).rejects.toThrow(/NothingToClaim/);
  });

  // ---------------------------------------------------------------- contracts-security review fixes (mirrored)

  it('CS-H1: bounds the seq step so no key can freeze its root forever', async () => {
    const { c, nowS } = chain();
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 2n ** 64n - 1n })).rejects.toThrow(/SeqStepTooLarge/);
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 1_000_001n })).rejects.toThrow(/SeqStepTooLarge/);
    await c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 1_000_000n }); // exactly one step
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 2_000_001n })).rejects.toThrow(/SeqStepTooLarge/);
    await c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 1_000_001n });
    expect((await c.vaultState()).lastAttestation?.seq).toBe(1_000_001n);
  });

  it('CS-H1: a newly accepted signer gets a full escape window', async () => {
    const { c, tick, nowS } = chain();
    await c.attest({ liabilitiesWei: 0n, ledgerRoot: ROOT0, asOf: nowS(), seq: 1n });
    const attestedAt = nowS();
    tick(4 * DAY);
    await c.proposeLedgerSigner('0x00000000000000000000000000000000000000aa');
    tick(2 * DAY);
    await c.acceptLedgerSigner();
    const s = await c.vaultState();
    expect(s.escape).toMatchObject({ lastAttestationAt: attestedAt, signerSince: attestedAt + 6n * 86_400n, availableAt: attestedAt + 13n * 86_400n });
    tick(DAY); // the last root is 7 days old, but the new signer has had only 1 day
    await expect(c.triggerEscape()).rejects.toThrow(/EscapeNotYetAvailable/);
    tick(6 * DAY);
    await c.triggerEscape();
    expect(c.escapeMode).toBe(true);
  });

  it('CS-M1: recovers the bankroll no escape claim can reach, and nothing claimable', async () => {
    const { c, tick } = chain();
    const operator = c.addresses().operator;
    await expect(c.recoverEscapeSurplus(operator)).rejects.toThrow(/EscapeModeInactive/);
    await c.playerDeposit('player-1', 1_000n * WEI);
    await c.playerDeposit('player-2', 2_000n * WEI);
    tick(7 * DAY); // never attested: anyone may trigger
    await c.triggerEscape();
    expect((await c.vaultState()).escape).toMatchObject({ poolWei: 3_000n * WEI, surplusWei: 1_000_000n * WEI });
    await expect(c.recoverEscapeSurplus('0x0000000000000000000000000000000000000000')).rejects.toThrow(/ZeroAddress/);
    await expect(c.recoverEscapeSurplus(c.addresses().vault)).rejects.toThrow(/InvalidRecipient/);
    const before = (await c.balances(operator)).tokenWei;
    expect((await c.recoverEscapeSurplus(operator)).amountWei).toBe(1_000_000n * WEI);
    expect((await c.balances(operator)).tokenWei - before).toBe(1_000_000n * WEI);
    await expect(c.recoverEscapeSurplus(operator)).rejects.toThrow(/NothingToRecover/);
    const s = await c.vaultState();
    expect(s).toMatchObject({ assetsWei: 3_000n * WEI, houseWithdrawnWei: 1_000_000n * WEI, escape: { surplusWei: 0n } });
    expect(s.assetsWei).toBe(s.totalDepositsWei + s.houseFundedWei - s.totalWithdrawalsWei - s.houseWithdrawnWei);
    expect((await c.playerClaimEscape('player-1', 0n, [])).paidWei).toBe(1_000n * WEI);
    expect((await c.playerClaimEscape('player-2', 0n, [])).paidWei).toBe(2_000n * WEI);
    expect((await c.balances(c.addresses().vault)).tokenWei).toBe(0n);
  });

  it('CS-M2: one account cannot use more than its share of the daily cap', async () => {
    let now = 1_790_000_000_000;
    const c = new OfflineChain({ now: () => now, seed: 'share', syncEvents: true, playerFundingWei: 1_000n * WEI, maxVoucherAmountWei: 100n * WEI, dailyOutflowCapWei: 1_000n * WEI, accountDailyOutflowCapWei: 250n * WEI });
    const [p1, p2] = c.players();
    await c.playerDeposit('player-1', 900n * WEI);
    await c.playerDeposit('player-2', 100n * WEI);
    const nowS = () => BigInt(Math.floor(now / 1000));
    const voucher = async (role: string, account: string, amountWei: bigint, nonce: bigint) => {
      const v = { account, amountWei, nonce, expiry: nowS() + 2n * 86_400n };
      return { ...v, signature: await c.signWithdrawal(v) };
    };
    await c.playerWithdraw('player-1', await voucher('player-1', p1!.address, 100n * WEI, 1n));
    await c.playerWithdraw('player-1', await voucher('player-1', p1!.address, 100n * WEI, 2n));
    expect(await c.remainingAccountDailyOutflow(p1!.address)).toBe(50n * WEI);
    const third = await voucher('player-1', p1!.address, 100n * WEI, 3n);
    await expect(c.playerWithdraw('player-1', third)).rejects.toThrow(/AccountDailyOutflowCapExceeded/);
    expect(await c.nonceUsed(p1!.address, 3n)).toBe(false);
    await c.playerWithdraw('player-2', await voucher('player-2', p2!.address, 100n * WEI, 1n)); // its own share
    now += 86_400_000; // next UTC day: a fresh share
    await c.playerWithdraw('player-1', third);
    expect(await c.remainingAccountDailyOutflow(p1!.address)).toBe(150n * WEI);
    expect(() => new OfflineChain({ seed: 'bad', maxVoucherAmountWei: 100n * WEI, dailyOutflowCapWei: 1_000n * WEI, accountDailyOutflowCapWei: 50n * WEI })).toThrow(/InvalidLimits/);
    expect(new OfflineChain({ seed: 'small', maxVoucherAmountWei: 10n * WEI, dailyOutflowCapWei: 100n * WEI }).accountDailyOutflowCap).toBe(100n * WEI); // default clamped to the cap
  });

  it('CS-L1: raising a player limit or the attestation age waits the timelock; lowering is instant', async () => {
    const { c, tick, nowS } = chain();
    const limits = { maxVoucherAmountWei: 100_000n * WEI, dailyOutflowCapWei: 1_000_000n * WEI, accountDailyOutflowCapWei: 250_000n * WEI, maxAttestationAge: 600n };
    await c.setLimits({ ...limits, maxAttestationAge: 300n }); // lower: at once
    expect(c.maxAttestationAge).toBe(300n);
    await c.setLimits({ ...limits, maxAttestationAge: 86_400n }); // raise: scheduled
    expect(c.maxAttestationAge).toBe(300n);
    expect((await c.vaultState()).pendingLimits).toEqual({ ...limits, maxAttestationAge: 86_400n, eta: nowS() + 172_800n, expiresAt: nowS() + 172_800n + 604_800n });
    await expect(c.acceptLimits()).rejects.toThrow(/TimelockNotElapsed/);
    await c.cancelLimits();
    await expect(c.acceptLimits()).rejects.toThrow(/NoPendingLimits/);
    await expect(c.cancelLimits()).rejects.toThrow(/NoPendingLimits/);
    await c.setLimits({ ...limits, accountDailyOutflowCapWei: 400_000n * WEI });
    tick(48 * HOUR);
    await c.acceptLimits();
    expect(c.accountDailyOutflowCap).toBe(400_000n * WEI);
    await expect(c.setLimits({ ...limits, accountDailyOutflowCapWei: 50_000n * WEI })).rejects.toThrow(/InvalidLimits/); // below maxVoucher
    await expect(c.setLimits({ ...limits, maxAttestationAge: 86_401n })).rejects.toThrow(/InvalidLimits/);
  });

  it('CS-L2: a proposal expires 7 days after its eta and must be proposed again', async () => {
    const { c, tick } = chain();
    await c.proposeLedgerSigner('0x00000000000000000000000000000000000000aa');
    await c.setHouseLimits(0n, 10_000_000n * WEI);
    await c.setSignerChangeDelay(3_600n);
    await c.setLimits({ maxVoucherAmountWei: 100_000n * WEI, dailyOutflowCapWei: 1_000_000n * WEI, accountDailyOutflowCapWei: 250_000n * WEI, maxAttestationAge: 3_600n });
    tick(48 * HOUR + 7 * DAY + 1000);
    await expect(c.acceptLedgerSigner()).rejects.toThrow(/ProposalExpired/);
    await expect(c.acceptHouseLimits()).rejects.toThrow(/ProposalExpired/);
    await expect(c.acceptSignerChangeDelay()).rejects.toThrow(/ProposalExpired/);
    await expect(c.acceptLimits()).rejects.toThrow(/ProposalExpired/);
    await c.proposeLedgerSigner('0x00000000000000000000000000000000000000aa'); // fresh notice
    tick(48 * HOUR + 7 * DAY); // the last second of the grace period
    await c.acceptLedgerSigner();
    expect(c.addresses().ledgerSigner).toBe('0x00000000000000000000000000000000000000aa');
  });

  it('persists the new vault state and restores older state files with defaults', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'maya-offline-fix-'));
    try {
      let now = 1_790_000_000_000;
      const statePath = join(dir, 'vault.json');
      const make = () => new OfflineChain({ now: () => now, seed: 'persist-fix', syncEvents: true, initialHouseFundWei: 1_000n * WEI, statePath });
      const a = make();
      await a.playerDeposit('player-1', 300n * WEI);
      const v = { account: a.players()[0]!.address, amountWei: 100n * WEI, nonce: 1n, expiry: BigInt(Math.floor(now / 1000)) + 600n };
      await a.playerWithdraw('player-1', { ...v, signature: await a.signWithdrawal(v) });
      await a.setLimits({ maxVoucherAmountWei: 100_000n * WEI, dailyOutflowCapWei: 1_000_000n * WEI, accountDailyOutflowCapWei: 300_000n * WEI, maxAttestationAge: 600n });
      now += 3_600_000;
      await a.proposeLedgerSigner('0x00000000000000000000000000000000000000aa');
      now += 48 * 3_600_000;
      await a.acceptLedgerSigner();
      const b = make();
      expect(await b.vaultState()).toEqual(await a.vaultState());
      expect(await b.remainingAccountDailyOutflow(v.account)).toBe(await a.remainingAccountDailyOutflow(v.account));

      // A file written before these fields existed still loads (defaults: 250k share, signer since deployment).
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown> & { limits: Record<string, unknown> };
      delete raw['accountOutflowByDay']; delete raw['pendingLimits']; delete raw['ledgerSignerSinceS']; delete raw.limits['accountDailyOutflowCap'];
      writeFileSync(statePath, JSON.stringify(raw));
      const old = make();
      const s = await old.vaultState();
      expect(s).toMatchObject({ accountDailyOutflowCapWei: 250_000n * WEI, pendingLimits: null, escape: { signerSince: old.deployedAtS } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
