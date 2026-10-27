import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketId } from '@maya/contracts';
import type { ChainNetwork, ChainPort, CreateChain } from './chain-port.js';
import { DEFAULT_ENGINE_LIMITS, type EngineConfig, type HouseEngine } from './engine/engine.js';
import type { BootFeed, EngineEvent, EngineNotice } from './engine/types.js';
import { logCoverage } from './feed/csv.js';
import { ReplayFeed } from './feed/replay.js';
import { DEFAULT_DEFENSES, DEFAULT_EDGE_SCHEDULE, DEFAULT_PRICING_CONFIG, DEFAULT_PROMO, type DefenseConfig, type PromoConfig } from '@maya/house';
import { legJson } from './api/views.js';
import type { StreamEventName } from './api/sse.js';

/** Default run id: UTC timestamp plus 4 random hex digits. */
export function newRunId(nowMs = Date.now()): string {
  return `${new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(2).toString('hex')}`;
}
export function journalPath(dataDir: string, runId: string): string { return join(dataDir, `journal-${runId}.jsonl`); }

const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Where the active run of a network is recorded in the data dir, so a restart without MAYA_RUN_ID resumes its journal. */
export function activeRunPath(dataDir: string, network: ChainNetwork): string { return join(dataDir, `active-run-${network}.json`); }

/** The run recorded as active for `network`, if any. An unreadable record throws (fail closed: never guess a new run). */
export function readActiveRun(dataDir: string, network: ChainNetwork): string | undefined {
  const path = activeRunPath(dataDir, network);
  if (!existsSync(path)) return undefined;
  let parsed: { version?: unknown; network?: unknown; runId?: unknown };
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed; } catch (error) {
    throw new Error(`${path} is unreadable (${error instanceof Error ? error.message : String(error)}); fix it, or set MAYA_RUN_ID to the run to open`);
  }
  if (parsed?.version !== 1 || parsed.network !== network || typeof parsed.runId !== 'string' || !RUN_ID.test(parsed.runId)) {
    throw new Error(`${path} does not name a ${network} run ({ version: 1, network, runId }); fix it, or set MAYA_RUN_ID to the run to open`);
  }
  return parsed.runId;
}

/** Record `runId` as the active run of `network` (written atomically: temp file + rename). */
export function persistActiveRun(dataDir: string, network: ChainNetwork, runId: string, nowMs = Date.now()): void {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id ${runId}`);
  mkdirSync(dataDir, { recursive: true });
  const path = activeRunPath(dataDir, network);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, network, runId, sinceMs: nowMs })}\n`);
  renameSync(tmp, path);
}

export interface RunChoice { readonly runId: string; readonly source: 'env' | 'persisted' | 'new' }

/**
 * The run to open: MAYA_RUN_ID, else the run recorded as active for this network in the data dir (with the journal
 * on), else a new id. A container restart (compose.live.yaml: persistent /data, no MAYA_RUN_ID) therefore resumes the
 * journal that owns the vault's player balances instead of opening an empty one.
 */
export function resolveRunId(options: { readonly explicit?: string | undefined; readonly dataDir: string; readonly network: ChainNetwork; readonly journal: boolean; readonly nowMs?: number }): RunChoice {
  if (options.explicit) return { runId: options.explicit, source: 'env' };
  const persisted = options.journal ? readActiveRun(options.dataDir, options.network) : undefined;
  if (persisted) return { runId: persisted, source: 'persisted' };
  return { runId: newRunId(options.nowMs), source: 'new' };
}

/**
 * Directory for the live chain's indexer cursor: one per run (`<dataDir>/runs/<runId>`), so a new journal always
 * rescans the vault from its deployment block and every deposit is delivered to the ledger that has to credit it.
 * A shared per-chain cursor would let a new run resume after deposits only an earlier journal holds. Without a
 * journal the cursor stays in memory too (null): every start rescans, like its in-memory ledger.
 */
export function chainCursorDir(dataDir: string, runId: string, journal: boolean): string | null {
  return journal ? join(dataDir, 'runs', runId) : null;
}

/**
 * Production engine configuration: SPEC §3/§4 defaults, the SPEC-10 defenses (all on unless overridden) and the SPEC-12
 * promo tiers (the operator's defaults unless overridden; `promo: null` selects the legacy single launch boost, which only
 * the Stage A test suite and old tooling use).
 */
export function engineConfig(markets: readonly MarketId[], options: { guardSigma?: number; minStakeCenti?: string; trainHours?: number; defenses?: DefenseConfig; toxicity?: EngineConfig['toxicity']; promo?: PromoConfig | null } = {}): EngineConfig {
  const promo = options.promo === undefined ? DEFAULT_PROMO : options.promo;
  return {
    markets, pricing: DEFAULT_PRICING_CONFIG, schedule: DEFAULT_EDGE_SCHEDULE, limits: DEFAULT_ENGINE_LIMITS, defenses: options.defenses ?? DEFAULT_DEFENSES,
    ...(promo ? { promo } : {}),
    ...(options.toxicity !== undefined ? { toxicity: options.toxicity } : {}),
    ...(options.guardSigma !== undefined ? { guardSigma: options.guardSigma } : {}),
    ...(options.minStakeCenti !== undefined ? { minStakeCenti: options.minStakeCenti } : {}),
    pathRetentionS: Math.round(((options.trainHours ?? 36) + 1) * 3600),
  };
}

/** Replay start: explicit, else the first logged second plus the refit warm-up, on an hour boundary. */
export function defaultReplayFrom(root: string, markets: readonly MarketId[], warmupHours: number): number {
  let from = 0;
  for (const m of markets) { const c = logCoverage(root, m); if (!c) throw new Error(`No market log for ${m} under ${root}`); from = Math.max(from, c.fromMs); }
  return Math.ceil((from + warmupHours * 3_600_000) / 3_600_000) * 3_600_000;
}

/** The replay settings of the first boot of a journal, so a restart replays the same period. */
export function journalFeed(records: readonly EngineEvent[]): BootFeed | undefined {
  for (const r of records) if (r.type === 'boot' && r.feed) return r.feed;
  return undefined;
}

export function loadReplay(root: string, markets: readonly MarketId[], fromMs: number, toMs: number | undefined, warmupS: number, speed: number): ReplayFeed {
  return ReplayFeed.load(root, { markets, fromMs, ...(toMs !== undefined ? { toMs } : {}), warmupS, speed });
}

/**
 * Load `src/chain` lazily (it pulls in viem) and create the live chain. `dataDir` holds its indexer cursor
 * (`chainCursorDir`: one per run; null keeps it in memory).
 */
export async function loadLiveChain(network: Exclude<ChainNetwork, 'offline'>, options: { repoRoot: string; dataDir: string | null; log: (line: string) => void; rpcUrl?: string | undefined }): Promise<ChainPort> {
  let mod: { createChain?: unknown };
  try { mod = await import('./chain/index.js') as { createChain?: unknown }; }
  catch (error) { throw new Error(`Chain module unavailable (src/chain): ${error instanceof Error ? error.message : String(error)}`); }
  if (typeof mod.createChain !== 'function') throw new Error('src/chain/index.js does not export createChain');
  const create = mod.createChain as CreateChain;
  return await create(network, { repoRoot: options.repoRoot, log: options.log, ...({ dataDir: options.dataDir, ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}) } as object) });
}

/** Engine notice → SSE event name and JSON payload (admin console shapes). */
export function streamPayload(engine: HouseEngine, n: EngineNotice): { event: StreamEventName; data: unknown } {
  switch (n.type) {
    case 'bet': case 'settlement': return { event: n.type, data: legJson(engine, n.data) };
    case 'breaker': return { event: 'breaker', data: { id: n.data.id, ...(n.data.market ? { market: n.data.market } : {}), state: n.data.to, from: n.data.from, since: n.data.atMs, reason: n.data.reason, actor: n.data.actor } };
    default: return { event: n.type, data: n.data };
  }
}
