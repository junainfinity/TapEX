// HouseApp wired to the real MayaHouseVault through LiveChain. Runs only when MAYA_APP_ANVIL_URL names an anvil node
// with chainId 31337. Use a dedicated container: the test moves anvil's clock forward by the escape delay, which would
// break the time assumptions of test/chain/integration.anvil.test.ts (MAYA_RPC_URL) on a shared node. E.g.
//   docker run -d --rm --name maya-anvil-wiring -p 8557:8545 ghcr.io/foundry-rs/foundry:stable "anvil --host 0.0.0.0 --chain-id 31337"
//   MAYA_APP_ANVIL_URL=http://127.0.0.1:8557 pnpm --filter @maya/house-server exec vitest run test/app-live.anvil.test.ts
// Keys are the deterministic test fixtures of test/chain (never .secrets).
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { DEFENSES_OFF } from '@maya/house';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HouseApp } from '../src/app.js';
import { engineConfig } from '../src/bootstrap.js';
import { deployContracts } from '../src/chain/deploy.js';
import { createChain, type LiveChain } from '../src/chain/live-chain.js';
import { verifyBalanceProof } from '../src/chain/merkle.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { InlineRefitRunner } from '../src/refit/runner.js';
import { ARTIFACTS_DIR, cleanupTemps, tempDir, waitFor, writeTestWallets } from './chain/fixtures.js';
import { HISTORY, T0, logRows, tables, walk } from './helpers.js';

const ANVIL = process.env['MAYA_APP_ANVIL_URL']?.trim() ?? '';
const E18 = 10n ** 18n;
const CENTI = 10n ** 16n;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}
async function reachable(): Promise<boolean> {
  if (!ANVIL) return false;
  try { return (await Promise.race([rpc('eth_chainId'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))])) === '0x7a69'; } catch { return false; }
}
async function advance(seconds: number): Promise<void> { await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine'); }

const up = await reachable();
if (!up) console.warn(`[app live] MAYA_APP_ANVIL_URL ${ANVIL ? `(${ANVIL}) not reachable with chainId 31337` : 'not set'}; skipping`);

describe.skipIf(!up)('HouseApp on the real vault (anvil)', { timeout: 180_000 }, () => {
  const salt = `maya-live-app-wiring:${Date.now()}`;
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  let dir: string; let secretsPath: string;
  let chain: LiveChain; let app: HouseApp;

  beforeAll(async () => {
    dir = tempDir('maya-app-anvil-');
    secretsPath = writeTestWallets(dir, undefined, salt);
    const deploymentsDir = path.join(dir, 'deployments');
    await deployContracts({ network: 'local', rpcUrl: ANVIL, secretsPath, deploymentsDir, artifactsDir: ARTIFACTS_DIR, fundHouseWei: 1_000_000n * E18, playerEthWei: E18, playerTokensWei: 10_000n * E18, signerEthWei: E18, log });
    chain = createChain('local', { rpcUrl: ANVIL, secretsPath, deploymentsDir, dataDir: path.join(dir, 'data'), pollIntervalMs: 100, log });
    const future = walk({ t0: T0, seconds: 1800, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 31 });
    const feed = new ReplayFeed([{ market: 'btc-usd', rows: logRows(new Map([...HISTORY, ...future]), 600) }], { markets: ['btc-usd'], fromMs: T0 * 1000, warmupS: 1200, speed: 20 });
    app = new HouseApp({
      engineConfig: engineConfig(['btc-usd'], { defenses: DEFENSES_OFF }), chain, feed, journal: new MemoryJournal(), tables, refitRunner: new InlineRefitRunner(), runId: 'app-anvil', bootId: 'anv1',
      refit: { trainHours: 36, refitHours: 1000, minRows: 600, onStart: false, minWarmHours: 6 }, attestEveryMs: 0, chainClock: 'wall', chainHealthEveryMs: 0,
      attestationDir: path.join(dir, 'attestations'), warmup: feed.history('btc-usd'), bootFeed: { mode: 'replay', fromMs: T0 * 1000 },
    });
    await app.start();
  });
  afterAll(async () => {
    await app?.stop();
    const keys = (JSON.parse(readFileSync(secretsPath, 'utf8')) as { wallets: { privateKey: string }[] }).wallets.map(w => w.privateKey.slice(2).toLowerCase());
    for (const line of logs) for (const k of keys) expect(line.toLowerCase()).not.toContain(k);
    cleanupTemps();
  });

  it('credits deposits, claims a hashed-nonce voucher from its Withdrawn event, attests the balance-tree root and the vault pays escape claims with the served proofs', async () => {
    const e = app.engine;
    const [p1, p2] = chain.players().map(p => ({ role: p.role, address: p.address.toLowerCase() }));
    await chain.playerDeposit(p1!.role, 400n * E18 + 5n);
    await chain.playerDeposit(p2!.role, 150n * E18);
    await waitFor(() => (e.balanceOf(p1!.address) === 40_000n && e.balanceOf(p2!.address) === 15_000n ? true : null), { what: 'deposits credited', timeoutMs: 20_000 });

    // A voucher with a 248-bit nonce, signed by the real ledger-signer key, redeemed by the player's own wallet.
    const issued = await app.issueVoucher('anvil-wd-1', p1!.address, '7500');
    if (!issued.ok) throw new Error(`${issued.code}: ${issued.message}`);
    const v = issued.voucher;
    expect(BigInt(v.nonce)).toBeGreaterThan(2n ** 200n);
    const tx = await chain.playerWithdraw(p1!.role, { amountWei: 7500n * CENTI, nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), signature: v.signature! });
    await waitFor(() => (e.vouchers.get(v.voucherId)?.status === 'claimed' ? true : null), { what: 'Withdrawn event claims the voucher', timeoutMs: 20_000 });
    expect(e.vouchers.get(v.voucherId)).toMatchObject({ txHash: tx.txHash.toLowerCase(), claimSource: 'event' });
    expect(await chain.nonceUsed(p1!.address, BigInt(v.nonce))).toBe(true);
    // p2 keeps an unredeemed voucher: it stays in p2's leaf.
    const open = await app.issueVoucher('anvil-wd-2', p2!.address, '2000');
    expect(open.ok).toBe(true);
    expect(e.reconcile(await chain.vaultState())).toMatchObject({ match: true, dustWei: '5' });

    await advance(1); // no later flow shares the watermark block's timestamp (SPEC-11 §6.5)
    const head = BigInt(await rpc('eth_blockNumber') as string);
    await waitFor(() => ((chain.watermark()?.number ?? -1n) >= head ? true : null), { what: 'indexer at head', timeoutMs: 20_000 });
    const attest = await app.attestNow({ actor: 'system', reason: 'anvil wiring attestation' });
    if (!attest.ok) throw new Error(`${attest.code}: ${attest.message}`);
    const root = (attest.after as { ledgerRoot: string }).ledgerRoot;
    const vault = await chain.vaultState();
    expect(vault.lastAttestation?.ledgerRoot.toLowerCase()).toBe(root);
    await advance(1);

    const proof1 = await app.accountProof(p1!.address);
    expect(proof1.status).toBe(200);
    const b1 = proof1.body as { balanceWei: string; proof: string[]; included: boolean };
    expect(b1).toMatchObject({ included: true, balanceWei: (32_500n * CENTI + 5n).toString() });
    expect(verifyBalanceProof(root, p1!.address, BigInt(b1.balanceWei), b1.proof)).toBe(true);
    const b2 = (await app.accountProof(p2!.address)).body as { balanceWei: string; proof: string[] };
    expect(b2.balanceWei).toBe((15_000n * CENTI).toString());

    // Silence for the escape delay: the real vault verifies the served proofs and pays each leaf once.
    await advance(Number(vault.escape.escapeDelay) + 5);
    await chain.triggerEscape();
    await app.readVault(true);
    const escaped = (await app.accountProof(p1!.address)).body as { escape: { mode: boolean; entitlementWei?: string } };
    expect(escaped.escape).toMatchObject({ mode: true, entitlementWei: b1.balanceWei });
    const paid1 = await chain.playerClaimEscape(p1!.role, BigInt(b1.balanceWei), b1.proof);
    expect(paid1.paidWei).toBe(BigInt(b1.balanceWei));
    const paid2 = await chain.playerClaimEscape(p2!.role, BigInt(b2.balanceWei), b2.proof);
    expect(paid2.paidWei).toBe(BigInt(b2.balanceWei));
    await expect(chain.playerClaimEscape(p1!.role, BigInt(b1.balanceWei), b1.proof)).rejects.toMatchObject({ revert: { name: 'NothingToClaim' } });
  });
});
