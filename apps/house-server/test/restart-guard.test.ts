// MC-1: a restart must never open an empty ledger next to a vault that holds player money.
//  - main.ts resumes the run recorded in the data dir when MAYA_RUN_ID is not set (compose restarts);
//  - HouseApp.start() refuses a fresh ledger on a vault with player history (or an unreadable vault) unless
//    MAYA_ALLOW_FRESH_LEDGER, in which case balances are rebuilt from chain events;
//  - the live indexer cursor is keyed by run, so a fresh ledger rescans from the deployment block;
//  - a ledger/vault mismatch raises a critical alert.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FreshLedgerError, HouseApp } from '../src/app.js';
import { activeRunPath, chainCursorDir, journalPath, persistActiveRun, readActiveRun, resolveRunId } from '../src/bootstrap.js';
import type { EngineEvent, EngineNotice } from '../src/engine/types.js';
import { MemoryJournal } from '../src/ledger/journal.js';
import { main, type MainHandle } from '../src/main.js';
import { OfflineChain } from '../src/offline-chain.js';
import { admin, startTestApp, type TestApp } from './app-helpers.js';
import { HISTORY, T0, tempDir, walk, writeMarketLog } from './helpers.js';

const E18 = 10n ** 18n;
const open: TestApp[] = [];
const handles: MainHandle[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close().catch(() => undefined);
  for (const h of handles.splice(0)) await h.stop().catch(() => undefined);
});

describe('fresh ledger on a vault with player history (HouseApp.start)', () => {
  it('refuses to start, journals nothing but its boot record, and keeps refusing on the next attempt', async () => {
    const statePath = join(tempDir('restart-guard-'), 'offline-chain.json');
    const a = await startTestApp({ chain: { statePath }, bootId: 'rga' }); open.push(a);
    const p = a.chain.players()[0]!;
    const account = p.address.toLowerCase();
    await a.chain.playerDeposit(p.role, 400n * E18);
    expect(a.app.engine.balanceOf(account)).toBe(40_000n);
    const attested = await a.app.attestNow({ actor: 'system', reason: 'periodic attestation before restart' });
    expect(attested.ok).toBe(true);
    await a.close(); open.length = 0;

    // The restart lost its journal (a new run id): the vault still holds the player's 400 tOPEN and a root that includes them.
    const journal = new MemoryJournal();
    const outcome = await startTestApp({ chain: { statePath }, journal, bootId: 'rgb' }).then(
      t => { open.push(t); return { started: true, balanceCenti: t.app.engine.balanceOf(account).toString() }; },
      (error: unknown) => ({ started: false, error }));
    // Before the fix this started with the player at balance 0 (and attested the zero root within one interval).
    expect(outcome).toMatchObject({ started: false, error: { code: 'FRESH_LEDGER_ON_VAULT_HISTORY' } });
    const refused = (outcome as { error: unknown }).error;
    expect(refused).toBeInstanceOf(FreshLedgerError);
    expect((refused as Error).message).toMatch(/deposits 400000000000000000000 wei/);
    expect((refused as Error).message).toMatch(/MAYA_RUN_ID/);
    // Nothing reached the refused ledger: no deposit credit, no treasury sync, no attestation.
    const types = journal.records<EngineEvent>().map(r => r.type);
    expect(types).not.toContain('deposit');
    expect(types).not.toContain('treasury');
    expect(types).not.toContain('attest');

    // Restarting with what that attempt journaled (same run id) still has no ledger history: refused again.
    const again = await startTestApp({ chain: { statePath }, records: journal.records<EngineEvent>(), bootId: 'rgc' }).then(() => undefined, (error: unknown) => error);
    expect(again).toMatchObject({ code: 'FRESH_LEDGER_ON_VAULT_HISTORY' });
  });

  it('resumes normally with the journal that owns the vault (same run)', async () => {
    const statePath = join(tempDir('restart-guard-'), 'offline-chain.json');
    const journal = new MemoryJournal();
    const a = await startTestApp({ chain: { statePath }, journal, bootId: 'rsa' }); open.push(a);
    const p = a.chain.players()[0]!;
    await a.chain.playerDeposit(p.role, 250n * E18);
    await a.close(); open.length = 0;
    const b = await startTestApp({ chain: { statePath }, records: journal.records<EngineEvent>(), bootId: 'rsb' }); open.push(b);
    expect(b.app.engine.balanceOf(p.address.toLowerCase())).toBe(25_000n);
    expect(b.app.engine.reconcile(await b.chain.vaultState()).match).toBe(true);
  });

  it('with allowFreshLedger, rebuilds player balances from chain events and reconciles', async () => {
    const statePath = join(tempDir('restart-guard-'), 'offline-chain.json');
    const a = await startTestApp({ chain: { statePath }, bootId: 'rfa' }); open.push(a);
    const p = a.chain.players()[0]!;
    await a.chain.playerDeposit(p.role, 400n * E18);
    await a.close(); open.length = 0;
    const b = await startTestApp({ chain: { statePath }, bootId: 'rfb', app: { allowFreshLedger: true } }); open.push(b);
    expect(b.app.engine.balanceOf(p.address.toLowerCase())).toBe(40_000n);
    expect(b.app.engine.reconcile(await b.chain.vaultState()).match).toBe(true);
  });

  it('refuses a fresh ledger when the vault cannot be read to rule out player history', async () => {
    const t = await startTestApp({ bootId: 'rgu' });
    await t.close();
    const chain = new OfflineChain({ now: () => t.app.feed.nowMs(), seed: 'api-test', syncEvents: true });
    chain.vaultState = async () => { throw new Error('RPC down'); };
    const app = new HouseApp({ ...t.app.options, chain, journal: new MemoryJournal(), records: [], bootId: 'rgw' });
    await expect(app.start()).rejects.toMatchObject({ name: 'FreshLedgerError', code: 'FRESH_LEDGER_UNVERIFIED' });
  });
});

describe('run id persistence and the live cursor directory (bootstrap)', () => {
  it('resumes the recorded run without MAYA_RUN_ID, lets MAYA_RUN_ID win, and fails closed on an unreadable record', () => {
    const dir = tempDir('run-id-');
    const first = resolveRunId({ dataDir: dir, network: 'base-sepolia', journal: true, nowMs: Date.UTC(2026, 8, 26) });
    expect(first.source).toBe('new');
    persistActiveRun(dir, 'base-sepolia', first.runId);
    expect(readActiveRun(dir, 'base-sepolia')).toBe(first.runId);
    expect(resolveRunId({ dataDir: dir, network: 'base-sepolia', journal: true })).toEqual({ runId: first.runId, source: 'persisted' });
    // Per network: a local run does not resume the Base Sepolia journal.
    expect(resolveRunId({ dataDir: dir, network: 'local', journal: true }).source).toBe('new');
    expect(resolveRunId({ explicit: 'ops-run-7', dataDir: dir, network: 'base-sepolia', journal: true })).toEqual({ runId: 'ops-run-7', source: 'env' });
    // Without a journal there is nothing to resume.
    expect(resolveRunId({ dataDir: dir, network: 'base-sepolia', journal: false }).source).toBe('new');
    writeFileSync(activeRunPath(dir, 'base-sepolia'), '{"version":1,"network":"base-sepolia"');
    expect(() => resolveRunId({ dataDir: dir, network: 'base-sepolia', journal: true })).toThrow(/unreadable/);
    writeFileSync(activeRunPath(dir, 'base-sepolia'), '{"version":1,"network":"local","runId":"x"}');
    expect(() => readActiveRun(dir, 'base-sepolia')).toThrow(/does not name a base-sepolia run/);
  });

  it('keys the live indexer cursor by run, so a new journal rescans the vault from its deployment block', () => {
    expect(chainCursorDir('/data', 'run-a', true)).toBe(join('/data', 'runs', 'run-a'));
    expect(chainCursorDir('/data', 'run-b', true)).not.toBe(chainCursorDir('/data', 'run-a', true));
    expect(chainCursorDir('/data', 'run-a', false)).toBeNull();
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolve(port)); });
  });
}

describe('main(): restart without MAYA_RUN_ID (compose.live.yaml keeps /data, sets no run id)', { timeout: 60_000 }, () => {
  it('resumes the same run and journal, keeps player balances, and refuses to start when that journal is gone', async () => {
    const root = tempDir('main-restart-');
    const market = join(root, 'market-data');
    writeMarketLog(market, { 'btc-usd': new Map([...HISTORY, ...walk({ t0: T0, seconds: 1800, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 31 })]) });
    const env = {
      MAYA_NETWORK: 'offline', MAYA_FEED: 'replay', MAYA_MARKETS: 'btc-usd', MAYA_MARKET_DATA: market, MAYA_DATA_DIR: join(root, 'data'), MAYA_SECRETS_DIR: join(root, 'secrets'),
      MAYA_ADMIN_PORT: String(await freePort()), MAYA_HOST: '127.0.0.1', MAYA_SIM_PLAYERS: '0', MAYA_ONCHAIN_BETS: 'false', MAYA_REFIT_ON_START: 'false',
      MAYA_REPLAY_FROM: new Date(T0 * 1000).toISOString(), MAYA_REPLAY_SPEED: '1', MAYA_HOUSE_FUND_OPEN: '1000000',
    };
    const lines: string[] = [];
    const log = (line: string) => { lines.push(line); };
    const first = await main(env, { signals: false, log });
    if (!first) throw new Error('main did not start');
    handles.push(first);
    const chain = first.app.chain as OfflineChain;
    const p = chain.players()[0]!;
    const account = p.address.toLowerCase();
    await chain.playerDeposit(p.role, 400n * E18);
    expect(first.app.engine.balanceOf(account)).toBe(40_000n);
    await first.stop(); handles.length = 0;

    const second = await main({ ...env, MAYA_ADMIN_PORT: String(await freePort()) }, { signals: false, log });
    if (!second) throw new Error('main did not restart');
    handles.push(second);
    expect(second.runId).toBe(first.runId);
    expect(lines.some(l => l.includes(`run ${first.runId} [resumed from the data dir]`))).toBe(true);
    expect(second.app.engine.balanceOf(account)).toBe(40_000n);
    expect(second.app.engine.reconcile(await second.app.chain.vaultState()).match).toBe(true);
    const snap = second.app.engine.attestationSnapshot();
    expect(snap.entries).toEqual([{ account, balanceWei: 400n * E18 }]);
    await second.stop(); handles.length = 0;

    // The journal is lost but the vault (here: the persisted offline vault of the run) still holds the deposit: refuse.
    const jp = journalPath(join(root, 'data'), first.runId);
    expect(existsSync(jp)).toBe(true);
    rmSync(jp);
    const refused = await main({ ...env, MAYA_ADMIN_PORT: String(await freePort()) }, { signals: false, log }).then(h => { if (h) handles.push(h); return h; }, (error: unknown) => error);
    expect(refused).toBeInstanceOf(FreshLedgerError);
    expect(JSON.parse(readFileSync(activeRunPath(join(root, 'data'), 'offline'), 'utf8'))).toMatchObject({ version: 1, network: 'offline', runId: first.runId });
  });
});

describe('ledger/vault reconciliation alert (chain health check)', () => {
  it('raises a critical LEDGER_VAULT_MISMATCH alert when vault assets differ from the ledger, and resolves it when they match again', async () => {
    const t = await startTestApp({ bootId: 'rca' }); open.push(t);
    const alerts: Extract<EngineNotice, { type: 'alert' }>['data'][] = [];
    t.app.engine.on(n => { if (n.type === 'alert') alerts.push(n.data); });
    await t.app.checkChainHealth();
    expect(alerts.filter(a => a.code === 'LEDGER_VAULT_MISMATCH')).toHaveLength(0);
    // Money reaches the vault behind the ledger's back (e.g. a treasury flow whose journal entry was lost).
    await t.chain.fundHouse(5n * E18);
    await t.app.checkChainHealth();
    expect(alerts.find(a => a.code === 'LEDGER_VAULT_MISMATCH')).toMatchObject({ level: 'critical', message: expect.stringContaining('5000000000000000000 wei') });
    expect(t.app.chainAlertsNow.map(a => a.code)).toContain('LEDGER_VAULT_MISMATCH');
    const view = await admin(t, 'GET', '/chain');
    expect(view.body.alerts.map((a: { code: string }) => a.code)).toContain('LEDGER_VAULT_MISMATCH');
    // Booking the flow makes the ledger match again: the alert resolves.
    t.app.engine.recordTreasury('fund', '500');
    await t.app.checkChainHealth();
    expect(alerts.at(-1)).toMatchObject({ code: 'LEDGER_VAULT_MISMATCH_RESOLVED', level: 'info' });
    expect(t.app.chainAlertsNow.map(a => a.code)).not.toContain('LEDGER_VAULT_MISMATCH');
  });
});
