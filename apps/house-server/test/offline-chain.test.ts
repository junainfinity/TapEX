import { describe, expect, it } from 'vitest';
import type { ChainDeposit } from '../src/chain-port.js';
import { OfflineChain } from '../src/offline-chain.js';

const WEI = 10n ** 18n;
function chain(nowMs = 1_790_000_000_000) {
  let now = nowMs;
  const c = new OfflineChain({ now: () => now, seed: 'unit', syncEvents: true, initialHouseFundWei: 1_000_000n * WEI });
  return { c, tick: (ms: number) => { now += ms; }, nowS: () => BigInt(Math.floor(now / 1000)) };
}

describe('OfflineChain (MayaHouseVault semantics)', () => {
  it('funds the house at deploy, gives each of the 11 players tOPEN, and emits deposits with ids and tx hashes', async () => {
    const { c } = chain();
    expect(c.players().map(p => p.role)).toEqual(Array.from({ length: 11 }, (_, i) => `player-${i + 1}`));
    const seen: ChainDeposit[] = [];
    c.onDeposit(d => seen.push(d));
    const tx = await c.playerDeposit('player-3', 250n * WEI + 5n);
    expect(seen).toEqual([{ player: c.players()[2]!.address, amountWei: 250n * WEI + 5n, depositId: 1n, txHash: tx.txHash, logIndex: 0, blockNumber: expect.any(BigInt) }]);
    const s = await c.vaultState();
    expect(s).toMatchObject({ houseFundedWei: 1_000_000n * WEI, totalDepositsWei: 250n * WEI + 5n, assetsWei: 1_000_250n * WEI + 5n, paused: false, lastAttestation: null });
    expect((await c.balances(c.players()[2]!.address)).tokenWei).toBe(10_000n * WEI - 250n * WEI - 5n);
  });

  it('pays signed vouchers once, bound to account, amount, nonce and expiry, within the daily cap', async () => {
    const { c, tick, nowS } = chain();
    await c.playerDeposit('player-1', 1000n * WEI);
    const account = c.players()[0]!.address;
    const v = { account, amountWei: 100n * WEI, nonce: 7n, expiry: nowS() + 600n };
    const signature = await c.signWithdrawal(v);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    await expect(c.playerWithdraw('player-2', { ...v, signature })).rejects.toThrow(/InvalidSignature/);
    await expect(c.playerWithdraw('player-1', { ...v, amountWei: v.amountWei + 1n, signature })).rejects.toThrow(/InvalidSignature/);
    await c.playerWithdraw('player-1', { ...v, signature });
    await expect(c.playerWithdraw('player-1', { ...v, signature })).rejects.toThrow(/NonceAlreadyUsed/);
    expect(await c.nonceUsed(account, 7n)).toBe(true);
    const late = { ...v, nonce: 8n, expiry: nowS() + 1n };
    const lateSig = await c.signWithdrawal(late);
    tick(5000);
    await expect(c.playerWithdraw('player-1', { ...late, signature: lateSig })).rejects.toThrow(/VoucherExpired/);
    c.dailyOutflowCap = 150n * WEI;
    const big = { ...v, nonce: 9n, amountWei: 60n * WEI, expiry: nowS() + 600n };
    await expect(c.playerWithdraw('player-1', { ...big, signature: await c.signWithdrawal(big) })).rejects.toThrow(/DailyOutflowCapExceeded/);
    expect((await c.vaultState()).totalWithdrawalsWei).toBe(100n * WEI);
  });

  it('gates house withdrawals by a fresh attestation and the surplus, counting deposits at or after asOf as owed', async () => {
    const { c, tick, nowS } = chain();
    await c.playerDeposit('player-1', 1000n * WEI);
    const operator = c.addresses().operator;
    await expect(c.withdrawHouse(1n, operator)).rejects.toThrow(/NoAttestation/);
    tick(2000); // the deposit is mined strictly before asOf, so the ledger's liabilities cover it
    await expect(c.attest({ liabilitiesWei: 1000n * WEI, ledgerRoot: '0x' + '0'.repeat(64), asOf: nowS() + 10n, seq: 1n })).rejects.toThrow(/AttestationFromFuture/);
    const asOf = nowS();
    await c.attest({ liabilitiesWei: 1000n * WEI, ledgerRoot: '0x' + '0'.repeat(64), asOf, seq: 1n });
    await expect(c.attest({ liabilitiesWei: 0n, ledgerRoot: '0x' + '0'.repeat(64), asOf, seq: 1n })).rejects.toThrow(/NonIncreasingSeq/);
    expect(c.houseSurplus()).toBe(1_000_000n * WEI);
    await c.playerDeposit('player-2', 500n * WEI); // mined at asOf: still owed on top of liabilities
    expect(c.houseSurplus()).toBe(1_000_000n * WEI);
    await expect(c.withdrawHouse(1_000_000n * WEI + 1n, operator)).rejects.toThrow(/ExceedsHouseSurplus/);
    await c.withdrawHouse(400_000n * WEI, operator);
    expect((await c.vaultState())).toMatchObject({ houseWithdrawnWei: 400_000n * WEI, assetsWei: 601_500n * WEI });
    tick(3_601_000);
    await expect(c.withdrawHouse(1n, operator)).rejects.toThrow(/AttestationTooOld/);
    await c.pauseVault();
    await expect(c.playerDeposit('player-1', 1n)).rejects.toThrow(/EnforcedPause/);
    await expect(c.pauseVault()).rejects.toThrow(/EnforcedPause/);
    await c.unpauseVault();
  });
});
