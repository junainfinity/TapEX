import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainDeposit, ChainWithdrawal } from '../src/chain-port.js';
import type { EngineEvent } from '../src/engine/types.js';
import { FileJournal, MemoryJournal, readJournal, type JournalSink } from '../src/ledger/journal.js';
import { OfflineChain } from '../src/offline-chain.js';
import { admin, api, startTestApp, type TestApp } from './app-helpers.js';
import { tempDir } from './helpers.js';

const WEI = 10n ** 18n;

describe('OfflineChain persistence', () => {
  it('restores the full vault and token state, continues block numbers, and re-delivers recorded events to the first subscribers', async () => {
    const dir = tempDir('offline-chain-');
    const statePath = join(dir, 'offline-chain.json');
    let now = 1_790_000_000_000;
    const make = () => new OfflineChain({ now: () => now, seed: 'persist', syncEvents: true, initialHouseFundWei: 1_000_000n * WEI, statePath });
    const a = make();
    expect(a.restored).toBe(false);
    expect(existsSync(statePath)).toBe(true);
    const [p1, p2] = a.players();
    const nowS = () => BigInt(Math.floor(now / 1000));
    await a.playerDeposit(p1!.role, 700n * WEI + 13n);
    await a.playerDeposit(p2!.role, 300n * WEI);
    const v = { account: p1!.address, amountWei: 50n * WEI, nonce: 99n, expiry: nowS() + 600n };
    await a.playerWithdraw(p1!.role, { ...v, signature: await a.signWithdrawal(v) });
    now += 2000;
    await a.attest({ liabilitiesWei: 950n * WEI + 13n, ledgerRoot: '0x' + '12'.repeat(32), asOf: nowS() - 1n, seq: 1n });
    await a.withdrawHouse(1000n * WEI, a.addresses().operator);
    await a.fundHouse(5n * WEI);
    await a.setHouseLimits(2000n, 5_000_000n * WEI);
    await a.proposeLedgerSigner('0x' + '5a'.repeat(20));
    a.donate(a.addresses().operator, 3n);
    await a.pauseVault();
    const state = await a.vaultState();

    const b = make();
    expect(b.restored).toBe(true);
    expect(await b.vaultState()).toEqual(state);
    expect(await b.nonceUsed(p1!.address, 99n)).toBe(true);
    expect(await b.balances(p1!.address)).toEqual(await a.balances(p1!.address));
    expect(await b.escapeEntitlement(p1!.address, 10n)).toBe(await a.escapeEntitlement(p1!.address, 10n));
    expect(b.receipts.map(r => r.txHash)).toEqual(a.receipts.map(r => r.txHash));
    const deposits: ChainDeposit[] = [], withdrawals: ChainWithdrawal[] = [];
    b.onDeposit(d => deposits.push(d));
    b.onWithdrawn(w => withdrawals.push(w));
    expect(deposits.map(d => [d.player, d.amountWei, d.depositId])).toEqual([[p1!.address, 700n * WEI + 13n, 1n], [p2!.address, 300n * WEI, 2n]]);
    expect(withdrawals.map(w => [w.player, w.amountWei, w.nonce])).toEqual([[p1!.address, 50n * WEI, 99n]]);
    b.onDeposit(() => { throw new Error('a second subscriber gets live events only'); });
    // State keeps evolving from where it stopped: the paused vault, the used nonce, the next block.
    await expect(b.playerWithdraw(p1!.role, { ...v, signature: await b.signWithdrawal(v) })).rejects.toThrow(/EnforcedPause/);
    await b.unpauseVault();
    await expect(b.playerWithdraw(p1!.role, { ...v, signature: await b.signWithdrawal(v) })).rejects.toThrow(/NonceAlreadyUsed/);
    expect(b.receipts.at(-1)!.blockNumber).toBe(a.receipts.at(-1)!.blockNumber + 1n);

    expect(() => new OfflineChain({ now: () => now, seed: 'other', statePath })).toThrow(/DeploymentMismatch/);
    expect(() => new OfflineChain({ now: () => now, statePath: join(dir, 'x.json') })).toThrow(/SeedRequired/);
    const memoryOnly = new OfflineChain({ now: () => now, seed: 'mem' });
    await memoryOnly.playerDeposit(memoryOnly.players()[0]!.role, WEI);
    expect(existsSync(join(dir, 'x.json'))).toBe(false);
  });
});

describe('offline restart: journal rebuild reconciles against the persisted vault', () => {
  let t: TestApp<JournalSink> | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('rebuilds the ledger, re-credits a deposit whose journal entry was lost in a crash, keeps vouchers and proofs, and reconciles exactly', async () => {
    const dir = tempDir('offline-restart-');
    const statePath = join(dir, 'offline-chain-api-test.json');
    const journalPath = join(dir, 'journal-api-test.jsonl');
    const attestationDir = join(dir, 'attestations');
    const a = await startTestApp({ journal: new FileJournal(journalPath), chain: { statePath }, attestationDir, openPlayerApi: true });
    t = a;
    const [p1, p2] = a.chain.players();
    await a.chain.playerDeposit(p1!.role, 600n * WEI + 21n);
    await a.chain.playerDeposit(p2!.role, 200n * WEI);
    a.advance(3);
    const grid = (await api(a.base, 'GET', `/v1/quotes?market=btc-usd&account=${p1!.address}`)).body;
    const cell = grid.cells.find((c: { available: boolean; window: number }) => c.available && c.window >= 3);
    expect((await api(a.base, 'POST', '/v1/bets', { requestId: 'restart-bet', account: p1!.address, quoteId: cell.quoteId, revision: 1, cellId: cell.cellId, stakeCenti: '1500' })).body.status).toBe('accepted');
    const redeemed = (await api(a.base, 'POST', '/v1/withdrawals', { requestId: 'restart-wd-1', account: p1!.address, amountCenti: '5000' })).body;
    await a.chain.playerWithdraw(p1!.role, { amountWei: BigInt(redeemed.amountWei), nonce: BigInt(redeemed.nonce), expiry: BigInt(redeemed.expiry), signature: redeemed.signature });
    const outstanding = (await api(a.base, 'POST', '/v1/withdrawals', { requestId: 'restart-wd-2', account: p2!.address, amountCenti: '2000' })).body;
    a.advance(2);
    const attest = await admin(a, 'POST', '/treasury/attest', { reason: 'attest before restart' });
    expect(attest.body.ok).toBe(true);
    a.advance(40);
    expect(a.app.engine.openLegCount).toBe(0); // the bet settled before the restart
    // Crash window: this deposit is mined and persisted by the vault, but its journal line never reaches disk.
    await a.chain.playerDeposit(p2!.role, 50n * WEI + 1n);
    const before = { snapshot: a.app.engine.stateSnapshot() as Record<string, unknown>, vault: await a.chain.vaultState() };
    expect(a.app.engine.reconcile(before.vault)).toMatchObject({ match: true });
    await a.close(); t = undefined;

    const all = readJournal<EngineEvent>(journalPath).records;
    const lost = all.findLastIndex(r => r.type === 'deposit');
    expect(all[lost]).toMatchObject({ type: 'deposit', account: p2!.address, amountWei: (50n * WEI + 1n).toString() });
    expect(lost).toBe(all.length - 1);
    const records = all.slice(0, lost);

    const b = await startTestApp({ records, journal: new MemoryJournal(), chain: { statePath }, attestationDir, openPlayerApi: true, bootId: 'api2' });
    t = b;
    expect(b.chain.restored).toBe(true);
    const e = b.app.engine;
    expect(e.reconcile(await b.chain.vaultState())).toMatchObject({ match: true, deltaWei: '0' });
    expect(e.balanceOf(p2!.address)).toBe(20_000n - 2000n + 5000n);
    expect(e.player(p2!.address)!.deposits).toHaveLength(2);
    expect(e.voucherByRequest('restart-wd-1')).toMatchObject({ status: 'claimed', claimSource: 'event' });
    expect(e.voucherByRequest('restart-wd-2')).toMatchObject({ status: 'pending', nonce: outstanding.nonce });
    const { ledger: ledgerBefore } = before.snapshot as { ledger: Record<string, string> };
    expect((e.stateSnapshot() as { ledger: Record<string, string> }).ledger).toEqual(ledgerBefore);
    // The redeemed voucher's event is re-delivered by the restored chain and ignored as a duplicate.
    expect(e.unmatchedWithdrawals()).toEqual([]);
    // The outstanding voucher still pays after the restart and is claimed by its event.
    await b.chain.playerWithdraw(p2!.role, { amountWei: BigInt(outstanding.amountWei), nonce: BigInt(outstanding.nonce), expiry: BigInt(outstanding.expiry), signature: outstanding.signature });
    expect(e.voucherByRequest('restart-wd-2')?.status).toBe('claimed');
    expect(e.reconcile(await b.chain.vaultState())).toMatchObject({ match: true });
    // Proofs for the attested root are served from the persisted tree.
    const proof = await api(b.base, 'GET', `/v1/account/${p1!.address}/proof`);
    expect(proof).toMatchObject({ status: 200, body: { included: true, attestation: { seq: '1', root: attest.body.after.ledgerRoot } } });
    // The next attestation continues the sequence.
    expect((await admin(b, 'POST', '/treasury/attest', { reason: 'attest after restart' })).body).toMatchObject({ ok: true, after: { seq: '2' } });
  });
});
