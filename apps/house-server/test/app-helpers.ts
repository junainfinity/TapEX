import type { AddressInfo } from 'node:net';
import { DEFENSES_OFF, type DefenseConfig, type PromoConfig } from '@maya/house';
import type { Server } from 'node:http';
import { createHouseServer } from '../src/api/server.js';
import { PlayerAuth, type AuthOptions } from '../src/api/auth.js';
import type { DevWallet } from '../src/api/dev-wallet.js';
import { SseHub } from '../src/api/sse.js';
import { HouseApp, type AppOptions } from '../src/app.js';
import { engineConfig, streamPayload } from '../src/bootstrap.js';
import type { EngineConfig } from '../src/engine/engine.js';
import type { EngineEvent } from '../src/engine/types.js';
import { ReplayFeed } from '../src/feed/replay.js';
import { MemoryJournal, type JournalSink } from '../src/ledger/journal.js';
import { OfflineChain, type OfflineChainOptions } from '../src/offline-chain.js';
import { InlineRefitRunner } from '../src/refit/runner.js';
import { HISTORY, T0, logRows, tables, walk } from './helpers.js';

export const TOKEN = 'test-admin-token-0123456789abcdef0123456789abcdef';

export interface TestApp<J extends JournalSink = MemoryJournal> {
  readonly app: HouseApp;
  readonly chain: OfflineChain;
  readonly journal: J;
  readonly server: Server;
  readonly base: string;
  readonly sse: SseHub;
  /** The SIWE session store when started with `auth`. */
  readonly auth?: PlayerAuth;
  advance(seconds: number): void;
  close(): Promise<void>;
}

export interface TestAppOptions {
  readonly sim?: number;
  readonly defenses?: DefenseConfig;
  /** SPEC-12 promo tiers. Stage A API tests run with the legacy launch boost (null) unless a test passes a promo config. */
  readonly promo?: PromoConfig | null;
  /** Serve the unauthenticated external-wallet withdrawal routes (MAYA_OPEN_PLAYER_API=testnet-unsafe). */
  readonly openPlayerApi?: boolean;
  /** Extra OfflineChain options (e.g. a statePath to persist it, a shorter escapeDelayS). */
  readonly chain?: Partial<OfflineChainOptions>;
  /** Journal sink and records to rebuild from (restart tests). */
  readonly journal?: JournalSink;
  readonly records?: readonly EngineEvent[];
  readonly attestationDir?: string;
  readonly bootId?: string;
  readonly app?: Partial<Pick<AppOptions, 'attestEveryMs' | 'voucherSweepEveryMs' | 'voucherExpiryMarginS' | 'chainHealthEveryMs' | 'allowFreshLedger'>>;
  /** Engine config overrides (e.g. a short voucherTtlS). */
  readonly engine?: Partial<EngineConfig>;
  /** Mutable offset added to the offline chain's clock only (moves chain time past timelocks without replaying days of feed). */
  readonly chainClockOffset?: { ms: number };
  /** Stage B: serve the player API with SIWE sessions (as main.ts does); sign-ins register the player. */
  readonly auth?: Omit<AuthOptions, 'onSignIn'>;
  /** Stage B: public RPC URL reported by GET /v1/chain-config. */
  readonly publicRpcUrl?: string;
  /** DEV ONLY: mount the test-wallet signer route with this signer. */
  readonly devWallet?: DevWallet;
}

/** A full HouseApp on a synthetic replay + offline chain, served on an ephemeral localhost port. */
/** Stage A API tests run with the SPEC-10 defenses off; pass `defenses` to exercise them. */
export async function startTestApp<J extends JournalSink = MemoryJournal>(options: TestAppOptions & { readonly journal?: J } = {}): Promise<TestApp<J>> {
  const future = walk({ t0: T0, seconds: 1800, start: Number(HISTORY.get(T0 - 1)), sigma: 3e-5, seed: 31 });
  const rows = logRows(new Map([...HISTORY, ...future]), 600);
  const feed = new ReplayFeed([{ market: 'btc-usd', rows }], { markets: ['btc-usd'], fromMs: T0 * 1000, warmupS: 1200, speed: 20 });
  const lastAt = options.records?.at(-1)?.atMs;
  if (lastAt !== undefined && lastAt > T0 * 1000) feed.advance(lastAt - 1);
  const offset = options.chainClockOffset;
  const chain = new OfflineChain({ now: () => feed.nowMs() + (offset?.ms ?? 0), seed: 'api-test', syncEvents: true, initialHouseFundWei: 1_000_000n * 10n ** 18n, ...options.chain });
  const journal = (options.journal ?? new MemoryJournal()) as J;
  const app = new HouseApp({
    engineConfig: { ...engineConfig(['btc-usd'], { defenses: options.defenses ?? DEFENSES_OFF, promo: options.promo ?? null }), ...options.engine }, chain, feed, journal, tables, refitRunner: new InlineRefitRunner(), runId: 'api-test', bootId: options.bootId ?? 'api1',
    refit: { trainHours: 36, refitHours: 1000, minRows: 600, onStart: false, minWarmHours: 6 }, attestEveryMs: 0, chainClock: 'feed',
    ...(options.sim ? { sim: { players: options.sim, arrivalsPerMin: 60, seed: 'api' } } : {}),
    ...(options.records ? { records: options.records } : {}), ...(options.attestationDir ? { attestationDir: options.attestationDir } : {}), ...options.app,
    warmup: feed.history('btc-usd'), bootFeed: { mode: 'replay', fromMs: T0 * 1000 },
  });
  await app.start();
  const sse = new SseHub({ overview: () => app.overview() });
  app.engine.on(n => { const p = streamPayload(app.engine, n); sse.publish(p.event, p.data); });
  const playerAuth = options.auth ? new PlayerAuth({ ...options.auth, onSignIn: account => { app.engine.register(account, 'sign-in'); } }) : undefined;
  const server = createHouseServer({
    app, adminToken: TOKEN, sse, log: () => undefined, ...(options.openPlayerApi ? { openPlayerApi: true } : {}),
    ...(playerAuth ? { auth: playerAuth } : {}), ...(options.publicRpcUrl ? { publicRpcUrl: options.publicRpcUrl } : {}), ...(options.devWallet ? { devWallet: options.devWallet } : {}),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const advance = (seconds: number) => { const end = app.engine.nowMs + seconds * 1000; while (app.engine.nowMs < end) app.tick(app.engine.nowMs + 250); };
  advance(1);
  return {
    app, chain, journal, server, base, sse, advance, ...(playerAuth ? { auth: playerAuth } : {}),
    close: async () => { sse.close(); await new Promise<void>(r => server.close(() => r())); await app.stop(); },
  };
}

export const auth = { Authorization: `Bearer ${TOKEN}` };
export async function api(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { /* keep text */ }
  return { status: res.status, body: parsed, headers: res.headers };
}
export const admin = (t: Pick<TestApp<JournalSink>, 'base'>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => api(t.base, method, `/admin-api${path}`, body, { ...auth, ...headers });
