import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttestationStore, treeFileName } from '../src/attestation-store.js';
import { buildBalanceTree, verifyBalanceProof, ZERO_ROOT } from '../src/chain/merkle.js';
import type { EngineEvent } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { admin, api, startTestApp, type TestApp } from './app-helpers.js';
import { HISTORY, T0, deliver, makeEngine, offered, simPlayer, tempDir } from './helpers.js';

const WEI = 10n ** 18n;
const CENTI = 10n ** 16n;
const reason = 'attestation tree test';

describe('balance tree leaves (SPEC-11 §6.2)', () => {
  it('owes each on-chain account balance + unredeemed vouchers + open max payouts + its deposit dust, excludes sim accounts, and never exceeds the liabilities', () => {
    const { engine } = makeEngine({ bankrollCenti: '100000000' });
    engine.recordTreasury('sync', '1', undefined, 999n); // house-side dust: owed to nobody, still attested as a liability
    const a = '0x' + 'a1'.repeat(20), b = '0x' + 'b2'.repeat(20), c = '0x' + 'c3'.repeat(20);
    engine.creditDeposit({ player: a, amountWei: 300n * WEI + 5n, depositId: 1n, txHash: '0x' + '1'.repeat(64), logIndex: 0, blockNumber: 1n });
    engine.creditDeposit({ player: b, amountWei: 40n * WEI, depositId: 2n, txHash: '0x' + '2'.repeat(64), logIndex: 0, blockNumber: 1n });
    engine.register(c, 'sign-in'); // registered, nothing owed: no leaf
    simPlayer(engine, '500000');
    const v = engine.requestWithdrawal('leaf-wd', b, '1500', 2_000_000_000n);
    if (!v.ok) throw new Error(v.code);
    deliver(engine, 'btc-usd', T0, HISTORY.get(T0 - 1)!);
    const q = offered(engine).find(x => x.x100 >= 150)!;
    const bet = engine.placeBet({ requestId: 'leaf-bet', account: a, quoteId: q.quoteId, revision: 1, cellId: q.cellId, stakeCenti: '1000' });
    expect(bet.status).toBe('accepted');
    const payout = bet.status === 'accepted' ? BigInt(bet.leg.payoutCenti) : 0n;

    const snap = engine.attestationSnapshot();
    expect(snap.entries).toEqual([
      { account: a, balanceWei: (30_000n - 1000n + payout) * CENTI + 5n },
      { account: b, balanceWei: 4_000n * CENTI },
    ]);
    expect(snap.leafTotalWei).toBe(snap.liabilitiesWei - 999n);
    expect(snap.ledgerRoot).toBe(buildBalanceTree(snap.entries).root);
    const tree = buildBalanceTree(snap.entries);
    for (const e of snap.entries) expect(verifyBalanceProof(snap.ledgerRoot, e.account, e.balanceWei, tree.proofFor(e.account))).toBe(true);
    expect(verifyBalanceProof(snap.ledgerRoot, a, snap.entries[0]!.balanceWei + 1n, tree.proofFor(a))).toBe(false);
    // An empty ledger attests the zero root.
    expect(makeEngine().engine.attestationSnapshot()).toMatchObject({ ledgerRoot: ZERO_ROOT, entries: [], leafTotalWei: 0n });
  });

  it('persists trees atomically and reloads them only when the stored leaves reproduce the root', () => {
    const dir = tempDir('house-trees-');
    const entries = [{ account: '0x' + '11'.repeat(20), balanceWei: '5' }, { account: '0x' + '22'.repeat(20), balanceWei: '7' }];
    const root = buildBalanceTree(entries.map(e => ({ account: e.account, balanceWei: BigInt(e.balanceWei) }))).root;
    const file = { version: 1 as const, seq: '3', root, requestedAsOf: '100', chainId: 0, vault: '0xv', createdMs: 1, liabilitiesWei: '12', leafTotalWei: '12', entries };
    const saved = new AttestationStore(dir).save(file);
    expect(saved.name).toBe(treeFileName(3n, root));
    expect(existsSync(join(dir, saved.name!))).toBe(true);
    const reloaded = new AttestationStore(dir).find(3n, root)!;
    expect(reloaded.tree.root).toBe(root);
    expect(reloaded.sha256).toBe(saved.sha256);
    expect(new AttestationStore(dir).find(4n, root)).toBeUndefined();
    expect(() => new AttestationStore(dir).save({ ...file, seq: '5', root: ZERO_ROOT.replace(/0$/, '1') })).toThrow(/does not match/);
    expect(new AttestationStore().find(9n, ZERO_ROOT)?.tree.entries).toEqual([]);
  });
});

describe('attestation with the balance-tree root, proofs and the escape hatch (offline vault)', () => {
  let t: TestApp | undefined;
  afterEach(async () => { await t?.close(); t = undefined; });

  it('attests the tree root, serves proofs the vault accepts in escape mode, and keeps serving them after a restart', async () => {
    const dir = tempDir('house-attest-');
    const clock = { ms: 0 };
    const journal = new MemoryJournal();
    t = await startTestApp({ attestationDir: dir, chainClockOffset: clock, chain: { escapeDelayS: 3n * 86_400n }, journal, openPlayerApi: true });
    const [p1, p2, p3] = t.chain.players();
    await t.chain.playerDeposit(p1!.role, 400n * WEI + 3n);
    await t.chain.playerDeposit(p2!.role, 100n * WEI);
    // p2's voucher is signed but never redeemed: it stays in p2's leaf.
    const w = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'tree-wd', account: p2!.address, amountCenti: '2500' });
    expect(w.status).toBe(200);
    t.advance(2);
    const none = await api(t.base, 'GET', `/v1/account/${p1!.address}/proof`);
    expect(none).toMatchObject({ status: 200, body: { attestation: null, included: false, balanceWei: '0', proof: [], escape: { mode: false, available: false } } });

    const att = await admin(t, 'POST', '/treasury/attest', { reason });
    expect(att.body).toMatchObject({ ok: true, after: { seq: '1', leaves: 2 } });
    const root = att.body.after.ledgerRoot as string;
    expect((await t.chain.vaultState()).lastAttestation?.ledgerRoot).toBe(root);
    const rec = journal.records<EngineEvent>().filter((r): r is Extract<EngineEvent, { type: 'attest' }> => r.type === 'attest').at(-1)!;
    expect(rec).toMatchObject({ ledgerRoot: root, leaves: 2, treeFile: treeFileName(1n, root), treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const stored = JSON.parse(readFileSync(join(dir, rec.treeFile!), 'utf8'));
    expect(stored).toMatchObject({ seq: '1', root, entries: [{ account: p1!.address, balanceWei: (40_000n * CENTI + 3n).toString() }, { account: p2!.address, balanceWei: (10_000n * CENTI).toString() }].sort((x, y) => (x.account < y.account ? -1 : 1)) });

    const proof1 = await api(t.base, 'GET', `/v1/account/${p1!.address}/proof`);
    expect(proof1.status).toBe(200);
    expect(proof1.body).toMatchObject({ included: true, balanceWei: (40_000n * CENTI + 3n).toString(), attestation: { seq: '1', root, source: 'vault', txHash: expect.any(String) }, escape: { mode: false, escapeDelaySec: 259_200 } });
    expect(verifyBalanceProof(root, p1!.address, BigInt(proof1.body.balanceWei), proof1.body.proof)).toBe(true);
    expect(proof1.body.currentOwedWei).toBe(proof1.body.balanceWei); // nothing moved since the attestation
    const proof3 = (await api(t.base, 'GET', `/v1/account/${p3!.address}/proof`)).body;
    expect(proof3).toMatchObject({ included: false, balanceWei: '0', proof: [], claim: { attestedBalance: '0', proof: [] } });
    expect((await api(t.base, 'GET', '/v1/account/sim:x/proof')).status).toBe(400);
    const chainView = (await admin(t, 'GET', '/chain')).body;
    expect(chainView.lastAttestation).toMatchObject({ seq: 1, ledgerRoot: root, tree: { leaves: 2, treeFile: treeFileName(1n, root) } });

    // After a restart (fresh process, same attestation directory) the proof is served from disk.
    const again = new AttestationStore(dir).find(1n, root)!;
    expect(again.tree.balanceOf(p1!.address)).toBe(40_000n * CENTI + 3n);

    // The house goes silent for the escape delay: anyone triggers escape mode, each player claims with the served proof.
    clock.ms = 3 * 86_400_000 + 5_000;
    await t.chain.triggerEscape();
    await t.app.readVault(true); // the API caches vault reads for 2 s
    const escaped = (await api(t.base, 'GET', `/v1/account/${p1!.address}/proof`)).body;
    expect(escaped).toMatchObject({ escape: { mode: true, available: true, entitlementWei: (40_000n * CENTI + 3n).toString() } });
    const paid = await t.chain.playerClaimEscape(p1!.role, BigInt(escaped.claim.attestedBalance), escaped.claim.proof);
    expect(paid.paidWei).toBe(40_000n * CENTI + 3n);
    const p2proof = (await api(t.base, 'GET', `/v1/account/${p2!.address}/proof`)).body;
    expect(p2proof.balanceWei).toBe((10_000n * CENTI).toString()); // 7,500 balance + the unredeemed 2,500 voucher
    expect((await t.chain.playerClaimEscape(p2!.role, BigInt(p2proof.balanceWei), p2proof.proof)).paidWei).toBe(10_000n * CENTI);
    await expect(t.chain.playerClaimEscape(p1!.role, BigInt(escaped.claim.attestedBalance), escaped.claim.proof)).rejects.toThrow(/NothingToClaim/);
    // New vouchers are refused once the vault is in escape mode.
    const refused = await api(t.base, 'POST', '/v1/withdrawals', { requestId: 'tree-wd-2', account: p1!.address, amountCenti: '100' });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'VAULT_ESCAPE_MODE' } } });
  });

  it('fails closed when the tree for the vault root is missing', async () => {
    t = await startTestApp();
    const p1 = t.chain.players()[0]!;
    await t.chain.playerDeposit(p1.role, 10n * WEI);
    await t.chain.attest({ liabilitiesWei: 10n * WEI, ledgerRoot: '0x' + 'ab'.repeat(32), asOf: BigInt(Math.floor(t.app.engine.nowMs / 1000)), seq: 1n });
    await t.app.readVault(true);
    const r = await api(t.base, 'GET', `/v1/account/${p1.address}/proof`);
    expect(r).toMatchObject({ status: 503, body: { error: { code: 'PROOF_UNAVAILABLE' }, attestation: { seq: '1', source: 'vault' }, escape: { mode: false } } });
  });
});
