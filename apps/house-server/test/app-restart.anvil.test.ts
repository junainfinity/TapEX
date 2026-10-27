// MC-1 on the real vault: a restart that opens a new journal next to a vault with player history must not start
// (it would show every player a zero balance and attest the zero root). With MAYA_ALLOW_FRESH_LEDGER the fresh
// ledger rescans the vault from its deployment block (the indexer cursor is per run) and rebuilds balances; with
// the owning journal the restart resumes as before. Runs only with MAYA_APP_ANVIL_URL on a dedicated anvil node
// (chainId 31337), e.g.
//   docker run -d --rm --name maya-anvil-restart -p 8558:8545 ghcr.io/foundry-rs/foundry:stable "anvil --host 0.0.0.0 --chain-id 31337"
//   MAYA_APP_ANVIL_URL=http://127.0.0.1:8558 pnpm --filter @maya/house-server exec vitest run test/app-restart.anvil.test.ts
// Keys are the deterministic test fixtures of test/chain (never .secrets).
import path from 'node:path';
import { DEFENSES_OFF } from '@maya/house';
import { afterAll, describe, expect, it } from 'vitest';
import { FreshLedgerError, HouseApp } from '../src/app.js';
import { chainCursorDir, engineConfig } from '../src/bootstrap.js';
import { deployContracts } from '../src/chain/deploy.js';
import { createChain, type LiveChain } from '../src/chain/live-chain.js';
import type { EngineEvent } from '../src/engine/types.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { InlineRefitRunner } from '../src/refit/runner.js';
import { ARTIFACTS_DIR, cleanupTemps, tempDir, waitFor, writeTestWallets } from './chain/fixtures.js';
import { HISTORY, T0, logRows, tables, walk } from './helpers.js';

const ANVIL = process.env['MAYA_APP_ANVIL_URL']?.trim() ?? '';
const E18 = 10n ** 18n;

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

const up = await reachable();
if (!up) console.warn(`[app restart] MAYA_APP_ANVIL_URL ${ANVIL ? `(${ANVIL}) not reachable with chainId 31337` : 'not set'}; skipping`);

describe.skipIf(!up)('restart next to the real vault (anvil)', { timeout: 180_000 }, () => {
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  const apps: HouseApp[] = [];
  afterAll(async () => { for (const a of apps) await a.stop().catch(() => undefined); cleanupTemps(); });

  it('refuses a fresh journal, rebuilds from a full rescan when explicitly allowed, and resumes with the owning journal', async () => {
    const dir = tempDir('maya-app-restart-');
    const secretsPath = writeTestWallets(dir, undefined, `maya-app-restart:${Date.now()}`);
    const deploymentsDir = path.join(dir, 'deployments');
    const dataDir = path.join(dir, 'data'); // MAYA_DATA_DIR (the persistent house-data volume in compose.live.yaml)
    await deployContracts({ network: 'local', rpcUrl: ANVIL, secretsPath, deploymentsDir, artifactsDir: ARTIFACTS_DIR, fundHouseWei: 1_000_000n * E18, playerEthWei: E18, playerTokensWei: 10_000n * E18, signerEthWei: E18, log });

    const boot = (runId: string, options: { records?: readonly EngineEvent[]; journal?: MemoryJournal; allowFreshLedger?: boolean } = {}) => {
      // main.ts: one indexer cursor directory per run.
      const chain: LiveChain = createChain('local', { rpcUrl: ANVIL, secretsPath, deploymentsDir, dataDir: chainCursorDir(dataDir, runId, true), pollIntervalMs: 100, log });
      const future = walk({ t0: T0, seconds: 1800, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 31 });
      const feed = new ReplayFeed([{ market: 'btc-usd', rows: logRows(new Map([...HISTORY, ...future]), 600) }], { markets: ['btc-usd'], fromMs: T0 * 1000, warmupS: 1200, speed: 20 });
      const app = new HouseApp({
        engineConfig: engineConfig(['btc-usd'], { defenses: DEFENSES_OFF }), chain, feed, journal: options.journal ?? new MemoryJournal(), tables, refitRunner: new InlineRefitRunner(), runId, bootId: `${runId}-${apps.length}`,
        refit: { trainHours: 36, refitHours: 1000, minRows: 600, onStart: false, minWarmHours: 6 }, attestEveryMs: 0, chainClock: 'wall', chainHealthEveryMs: 0, voucherSweepEveryMs: 0,
        attestationDir: path.join(dataDir, 'attestations'), warmup: feed.history('btc-usd'), bootFeed: { mode: 'replay', fromMs: T0 * 1000 },
        ...(options.records ? { records: options.records } : {}), ...(options.allowFreshLedger ? { allowFreshLedger: true } : {}),
      });
      apps.push(app);
      return { app, chain };
    };

    // Run A: a player deposits 400 tOPEN, is credited, and the vault holds an attested root that includes them.
    const journalA = new MemoryJournal();
    const a = boot('run-a', { journal: journalA });
    await a.app.start();
    const p1 = a.chain.players().map(p => ({ role: p.role, address: p.address.toLowerCase() }))[0]!;
    await a.chain.playerDeposit(p1.role, 400n * E18);
    await waitFor(() => (a.app.engine.balanceOf(p1.address) === 40_000n ? true : null), { what: 'deposit credited in run A', timeoutMs: 20_000 });
    expect((await a.app.attestNow({ actor: 'system', reason: 'periodic attestation in run A' })).ok).toBe(true);
    await a.app.stop();

    // Restart with a new run id (fresh journal) and the same MAYA_DATA_DIR: refused before any chain event is applied.
    const b = boot('run-b');
    const refused = await b.app.start().then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(FreshLedgerError);
    expect(refused).toMatchObject({ code: 'FRESH_LEDGER_ON_VAULT_HISTORY' });
    expect(b.app.engine.balanceOf(p1.address)).toBe(0n);
    expect(b.app.engine.lastAttestation).toBeUndefined();

    // Explicit override: the per-run cursor makes the fresh ledger rescan from the deployment block and credit the deposit.
    const c = boot('run-c', { allowFreshLedger: true });
    await c.app.start();
    await waitFor(() => (c.app.engine.balanceOf(p1.address) === 40_000n ? true : null), { what: 'deposit re-credited by the rescan', timeoutMs: 20_000 });
    expect(c.app.engine.reconcile(await c.chain.vaultState()).match).toBe(true);
    await c.app.stop();

    // The owning journal resumes: balance kept, reconciled.
    const d = boot('run-a', { records: journalA.records<EngineEvent>() });
    await d.app.start();
    expect(d.app.engine.balanceOf(p1.address)).toBe(40_000n);
    const head = BigInt(await rpc('eth_blockNumber') as string);
    await waitFor(() => ((d.chain.watermark()?.number ?? -1n) >= head ? true : null), { what: 'resumed indexer at head', timeoutMs: 20_000 });
    expect(d.app.engine.reconcile(await d.chain.vaultState()).match).toBe(true);
    expect(d.app.engine.balanceOf(p1.address)).toBe(40_000n);
  });
});
