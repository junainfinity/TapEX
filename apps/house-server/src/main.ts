import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadOrCreateAdminToken } from './api/admin-token.js';
import { createHouseServer } from './api/server.js';
import { PlayerAuth } from './api/auth.js';
import { devWalletAllowed, loadDevWallet, type DevWallet } from './api/dev-wallet.js';
import { SseHub } from './api/sse.js';
import { FreshLedgerError, HouseApp } from './app.js';
import { chainCursorDir, defaultReplayFrom, engineConfig, journalFeed, journalPath, loadLiveChain, loadReplay, persistActiveRun, resolveRunId, streamPayload } from './bootstrap.js';
import type { ChainPort } from './chain-port.js';
import { loadConfig } from './config.js';
import type { EngineEvent } from './engine/types.js';
import { LiveFeed } from './feed/live.js';
import { HermesSseReference } from './feed/reference.js';
import type { Feed } from './feed/types.js';
import { FileJournal, NullJournal, readJournal, repairJournalTail } from './ledger/journal.js';
import { OfflineChain } from './offline-chain.js';
import { WorkerRefitRunner } from './refit/runner.js';
import { TableRegistry } from './refit/tables.js';
import { ReplayFeed } from './feed/replay.js';

const defaultLog = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** A running server (returned for tests and embedding; the CLI entry keeps it until SIGINT/SIGTERM). */
export interface MainHandle { readonly app: HouseApp; readonly server: Server; readonly runId: string; stop(): Promise<void> }
export interface MainOptions {
  /** Install SIGINT/SIGTERM handlers that stop the server and exit the process (default true). */
  readonly signals?: boolean;
  readonly log?: (line: string) => void;
}

export async function main(env: Readonly<Record<string, string | undefined>> = process.env, options: MainOptions = {}): Promise<MainHandle | undefined> {
  const log = options.log ?? defaultLog;
  const loaded = loadConfig(env);
  if (!loaded.ok) { for (const e of loaded.errors) console.error(`config: ${e}`); process.exitCode = 1; return undefined; }
  const config = loaded.config;
  // MAYA_RUN_ID, else the run recorded as active in the data dir: a restart resumes the journal that owns the vault's
  // player balances. Recorded before the journal opens, so every journal written under a run id is the active one.
  const run = resolveRunId({ explicit: config.runId, dataDir: config.dataDir, network: config.network, journal: config.journal });
  const runId = run.runId;
  if (config.journal) persistActiveRun(config.dataDir, config.network, runId);
  const path = journalPath(config.dataDir, runId);
  let records: EngineEvent[] = [];
  if (config.journal) {
    const removed = repairJournalTail(path);
    if (removed) log(`house: dropped a torn final journal line (${removed} bytes)`);
    records = readJournal<EngineEvent>(path).records;
  }
  const prior = journalFeed(records);
  log(`house: run ${runId} [${run.source === 'env' ? 'MAYA_RUN_ID' : run.source === 'persisted' ? 'resumed from the data dir' : 'new'}] (${records.length ? `rebuilding from ${records.length} journal records` : 'fresh journal'}) → ${config.journal ? path : 'journal disabled'}`);

  const tables = new TableRegistry(config.dataDir);
  tables.loadPublished(config.markets);

  let feed: Feed;
  let warmup: ReturnType<ReplayFeed['history']>[number][] = [];
  let peek: ((m: import('@maya/contracts').MarketId, t: number) => number | undefined) | undefined;
  if (config.feed === 'replay') {
    const fromMs = prior?.fromMs ?? config.replayFromMs ?? defaultReplayFrom(config.marketDataDir, config.markets, config.refitOnStart ? config.trainHours : 0.2);
    const toMs = prior?.toMs ?? config.replayToMs;
    const warmupS = (config.refitOnStart ? config.trainHours * 3600 : 0) + 700;
    const replay = loadReplay(config.marketDataDir, config.markets, fromMs, toMs, warmupS, config.replaySpeed);
    warmup = config.markets.flatMap(m => replay.history(m));
    const lastAt = records.at(-1)?.atMs;
    if (lastAt !== undefined && lastAt > fromMs) replay.advance(lastAt - 1);
    peek = (m, t) => replay.peek(m, t);
    feed = replay;
    log(`house: replay ${new Date(fromMs).toISOString()} → ${new Date(replay.endMs).toISOString()} at ${config.replaySpeed}× (${replay.remaining} samples, ${warmup.length} warm-up seconds)`);
  } else {
    feed = new LiveFeed({ relayUrl: config.relayUrl, markets: config.markets });
    log(`house: live feed from ${config.relayUrl}`);
  }

  let chain: ChainPort;
  if (config.network === 'offline') {
    // With the journal on, the offline vault persists next to it so a restart rebuilds a ledger that reconciles.
    const statePath = config.journal ? join(config.dataDir, `offline-chain-${runId}.json`) : undefined;
    const offline = new OfflineChain({ now: () => feed.nowMs(), initialHouseFundWei: BigInt(Math.round(config.houseFundOpen)) * 10n ** 18n, syncEvents: true, seed: runId, ...(statePath ? { statePath } : {}) });
    chain = offline;
    if (offline.restored) log(`house: offline chain restored from ${statePath}`);
    else if (records.length) log('house: warning: no saved offline chain state for this journal; a rebuilt ledger will not reconcile with a fresh offline vault');
  } else {
    chain = await loadLiveChain(config.network, { repoRoot: config.repoRoot, dataDir: chainCursorDir(config.dataDir, runId, config.journal), log, rpcUrl: config.rpcUrl });
  }
  const attestationDir = config.journal ? join(config.dataDir, 'attestations', `${chain.chainId}-${chain.addresses().vault.toLowerCase()}`) : undefined;

  const app = new HouseApp({
    engineConfig: engineConfig(config.markets, { guardSigma: config.guardSigma, minStakeCenti: config.minStakeCenti, trainHours: config.trainHours }),
    chain, feed, journal: config.journal ? new FileJournal(path) : new NullJournal(), records, tables,
    refitRunner: new WorkerRefitRunner(), runId, bootId: randomBytes(4).toString('hex'), log,
    refit: { trainHours: config.trainHours, refitHours: config.refitHours, minRows: 600, onStart: config.refitOnStart, minWarmHours: 6 },
    attestEveryMs: config.attestEveryMs, chainClock: config.network === 'offline' ? 'feed' : 'wall',
    ...(config.feed === 'replay' && config.simPlayers > 0 ? { sim: { players: config.simPlayers, arrivalsPerMin: config.simArrivalsPerMin ?? Math.max(1, Math.round(config.simPlayers / (24 * 60))), seed: config.simSeed, ...(peek ? { peek } : {}) } } : {}),
    ...(config.onchainBets ? { onchain: { depositWei: BigInt(Math.round(config.onchainDepositOpen)) * 10n ** 18n, betsPerMin: 2, topUpBelowCenti: 10_000n, seed: `${config.simSeed}:onchain` } } : {}),
    ...(attestationDir ? { attestationDir } : {}),
    warmup, bootFeed: { mode: config.feed, ...(config.feed === 'replay' ? { fromMs: (feed as ReplayFeed).fromMs, ...(config.replayToMs !== undefined ? { toMs: config.replayToMs } : {}) } : {}), network: chain.network, chainId: chain.chainId },
    ...(config.feed === 'live' && config.referenceFeed === 'hermes' ? { reference: new HermesSseReference({ baseUrl: config.hermesUrl, markets: config.markets, log }) } : {}),
    ...(config.allowFreshLedger ? { allowFreshLedger: true } : {}),
  });
  if (config.feed === 'live' && config.referenceFeed === 'hermes') log(`house: reference feed Pyth Hermes SSE (${config.hermesUrl}) for early quote invalidation`);
  try { await app.start(); } catch (error) { await app.stop().catch(() => undefined); throw error; }
  void app.setupOnchainPlayers().catch(error => log(`house: on-chain player setup failed: ${String(error)}`));

  const admin = loadOrCreateAdminToken(config.secretsDir, log);
  const sse = new SseHub({ overview: () => app.overview() });
  app.engine.on(n => { const p = streamPayload(app.engine, n); sse.publish(p.event, p.data); });
  const openPlayerApi = config.openPlayerApi === 'testnet-unsafe';
  if (openPlayerApi) log('house: WARNING MAYA_OPEN_PLAYER_API=testnet-unsafe (dev override): account-scoped player routes also act for a client-named account when a request carries no SIWE session; testnet only');
  // Stage B: SIWE sessions. Account-scoped player routes take the account from the session (src/api/auth-routes.ts).
  const serverRpcUrl = config.network === 'offline' ? undefined : config.rpcUrl ?? (config.network === 'local' ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org');
  const auth = new PlayerAuth({
    publicOrigin: config.publicOrigin, chainId: chain.chainId > 0 ? chain.chainId : 31337, rpcUrl: serverRpcUrl,
    onSignIn: account => { const r = app.engine.register(account, 'sign-in'); if (!r.ok) log(`house: sign-in registration refused for ${account} (${r.code})`); },
  });
  const publicRpcUrl = config.publicRpcUrl ?? (config.network === 'local' ? serverRpcUrl : config.network === 'base-sepolia' ? 'https://sepolia.base.org' : undefined);
  log(`house: player sessions (SIWE) for ${auth.publicOrigin} on chain ${auth.chainId}`);
  let devWallet: DevWallet | undefined;
  if (devWalletAllowed(config).ok) {
    devWallet = await loadDevWallet({ repoRoot: config.repoRoot, rpcUrl: serverRpcUrl!, siweDomain: auth.domain, defaultRole: config.devTestWalletRole });
    log(`house: WARNING DEV ONLY test wallet at POST /v1/dev/wallet/* (default ${config.devTestWalletRole}; local chain ${devWallet.chainId}, loopback only)`);
  }
  const server = createHouseServer({ app, adminToken: admin.token, sse, log, openPlayerApi, auth, ...(publicRpcUrl ? { publicRpcUrl } : {}), ...(devWallet ? { devWallet } : {}) });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.adminPort, config.host, () => resolve()); });
  log(`house: listening on http://${config.host}:${config.adminPort} (player /v1, admin /admin-api)`);
  sse.start();
  app.startLoop();

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= (async () => {
    sse.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.stop();
    log('house: stopped; journal flushed');
  })());
  if (options.signals !== false) {
    for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { log(`house: ${s} received, stopping`); void stop().then(() => process.exit(0)); });
  }
  return { app, server, runId, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    if (error instanceof FreshLedgerError) console.error(`house: refusing to start (${error.code}): ${error.message}`);
    else console.error(`house: fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
