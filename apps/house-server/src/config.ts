import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketId } from '@maya/contracts';
import type { ChainNetwork } from './chain-port.js';

export interface ServerConfig {
  readonly repoRoot: string;
  readonly network: ChainNetwork;
  readonly feed: 'replay' | 'live';
  readonly replaySpeed: number;
  /** Replay start (ms); undefined = first log second + warm-up. */
  readonly replayFromMs?: number;
  readonly replayToMs?: number;
  readonly marketDataDir: string;
  readonly markets: readonly MarketId[];
  readonly simPlayers: number;
  readonly simArrivalsPerMin?: number;
  readonly simSeed: string;
  readonly onchainBets: boolean;
  readonly onchainDepositOpen: number;
  readonly adminPort: number;
  readonly host: string;
  readonly dataDir: string;
  /** MAYA_RUN_ID; without it the run persisted in the data dir (active-run-<network>.json) is resumed, else a new one starts. */
  readonly runId?: string;
  /**
   * MAYA_ALLOW_FRESH_LEDGER: let a journal without ledger history start on a vault that has player history, rebuilding
   * balances from chain events only (default false: the server refuses, since player balances and the next root would be lost).
   */
  readonly allowFreshLedger: boolean;
  readonly relayUrl: string;
  readonly secretsDir: string;
  readonly trainHours: number;
  readonly refitHours: number;
  readonly refitOnStart: boolean;
  readonly attestEveryMs: number;
  readonly guardSigma: number;
  readonly minStakeCenti: string;
  readonly houseFundOpen: number;
  readonly journal: boolean;
  /** SPEC-10 sub-second reference for early quote invalidation: Pyth Hermes SSE in live mode, never in replay. */
  readonly referenceFeed: 'off' | 'hermes';
  readonly hermesUrl: string;
  /**
   * MAYA_OPEN_PLAYER_API: 'off' (default) or 'testnet-unsafe' to serve the unauthenticated external-wallet
   * withdrawal routes (POST/GET /v1/withdrawals). Stage A has no SIWE; SIWE must replace this before any real use.
   */
  readonly openPlayerApi: 'off' | 'testnet-unsafe';
  /**
   * MAYA_RPC_URL: RPC endpoint of the live chain (MAYA_NETWORK=local or base-sepolia), e.g. an anvil on another port.
   * Omitted: the network default (anvil at 127.0.0.1:8545; https://sepolia.base.org). The chain id is still verified.
   */
  readonly rpcUrl?: string;
  /**
   * MAYA_PUBLIC_ORIGIN (default http://127.0.0.1:8180, the compose game): the origin players load the game from. SIWE
   * messages must name its host as domain and a URI on it; POSTs with another Origin are refused; https → Secure cookie.
   */
  readonly publicOrigin: string;
  /** MAYA_PUBLIC_RPC_URL: RPC the browser wallet is told to use (default: base-sepolia's public RPC; local: MAYA_RPC_URL or anvil). */
  readonly publicRpcUrl?: string;
  /**
   * MAYA_DEV_TEST_WALLET=1 (DEV ONLY): serve POST /v1/dev/wallet/* signing with a .secrets test player key for automated
   * browser QA. Refused unless MAYA_NETWORK=local and MAYA_HOST=127.0.0.1. MAYA_DEV_TEST_WALLET_ROLE picks the default key.
   */
  readonly devTestWallet: boolean;
  readonly devTestWalletRole: string;
}

/** Repository root: this file lives in apps/house-server/{src,dist}/. */
export function defaultRepoRoot(): string { return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..'); }

export type ConfigResult = { readonly ok: true; readonly config: ServerConfig } | { readonly ok: false; readonly errors: readonly string[] };

/** SPEC §6 configuration from the environment; every value is validated, errors are collected. */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): ConfigResult {
  const errors: string[] = [];
  const repoRoot = env['MAYA_REPO_ROOT'] ? resolve(env['MAYA_REPO_ROOT']) : defaultRepoRoot();
  const text = (key: string, fallback: string) => (env[key]?.trim() || fallback);
  const num = (key: string, fallback: number, lo: number, hi: number, integer = false): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) { errors.push(`${key} must be ${integer ? 'an integer ' : ''}within ${lo}–${hi} (got ${raw})`); return fallback; }
    return n;
  };
  const time = (key: string): number | undefined => {
    const raw = env[key]?.trim();
    if (!raw) return undefined;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) { errors.push(`${key} must be an ISO date-time (got ${raw})`); return undefined; }
    return ms;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = env[key]?.trim().toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    errors.push(`${key} must be a boolean (got ${raw})`); return fallback;
  };
  const network = text('MAYA_NETWORK', 'offline');
  if (network !== 'offline' && network !== 'local' && network !== 'base-sepolia') errors.push(`MAYA_NETWORK must be offline, local or base-sepolia (got ${network})`);
  const feed = text('MAYA_FEED', 'replay');
  if (feed !== 'replay' && feed !== 'live') errors.push(`MAYA_FEED must be replay or live (got ${feed})`);
  const markets = text('MAYA_MARKETS', 'btc-usd,eth-usd').split(',').map(s => s.trim()).filter(Boolean);
  if (!markets.length || markets.some(m => m !== 'btc-usd' && m !== 'eth-usd') || new Set(markets).size !== markets.length) errors.push('MAYA_MARKETS must list btc-usd and/or eth-usd');
  const minStake = text('MAYA_MIN_STAKE_CENTI', '10');
  if (!/^[1-9]\d{0,12}$/.test(minStake)) errors.push('MAYA_MIN_STAKE_CENTI must be a positive integer');
  const runId = env['MAYA_RUN_ID']?.trim();
  if (runId !== undefined && runId !== '' && !/^[A-Za-z0-9._-]{1,64}$/.test(runId)) errors.push('MAYA_RUN_ID may only contain letters, digits, dot, dash and underscore');
  const arrivals = env['MAYA_SIM_ARRIVALS_PER_MIN']?.trim() ? num('MAYA_SIM_ARRIVALS_PER_MIN', 0, 0, 100_000) : undefined;
  const referenceFeed = text('MAYA_REFERENCE_FEED', feed === 'live' ? 'hermes' : 'off');
  if (referenceFeed !== 'off' && referenceFeed !== 'hermes') errors.push(`MAYA_REFERENCE_FEED must be off or hermes (got ${referenceFeed})`);
  else if (referenceFeed === 'hermes' && feed !== 'live') errors.push('MAYA_REFERENCE_FEED=hermes needs MAYA_FEED=live (the reference is not used in replay)');
  const hermesUrl = text('MAYA_HERMES_URL', 'https://hermes.pyth.network');
  if (!/^https?:\/\/[^\s]+$/.test(hermesUrl)) errors.push('MAYA_HERMES_URL must be an http(s) URL');
  const openPlayerApi = text('MAYA_OPEN_PLAYER_API', 'off');
  if (openPlayerApi !== 'off' && openPlayerApi !== 'testnet-unsafe') errors.push(`MAYA_OPEN_PLAYER_API must be off or testnet-unsafe (got ${openPlayerApi})`);
  const rpcUrl = env['MAYA_RPC_URL']?.trim();
  if (rpcUrl && !/^https?:\/\/[^\s]+$/.test(rpcUrl)) errors.push('MAYA_RPC_URL must be an http(s) URL');
  const publicOrigin = text('MAYA_PUBLIC_ORIGIN', 'http://127.0.0.1:8180').replace(/\/$/, '');
  try { const u = new URL(publicOrigin); if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== publicOrigin) throw new Error('not an origin'); } catch { errors.push(`MAYA_PUBLIC_ORIGIN must be a bare http(s) origin such as https://game.example (got ${publicOrigin})`); }
  const publicRpcUrl = env['MAYA_PUBLIC_RPC_URL']?.trim();
  if (publicRpcUrl && !/^https?:\/\/[^\s]+$/.test(publicRpcUrl)) errors.push('MAYA_PUBLIC_RPC_URL must be an http(s) URL');
  const devTestWallet = bool('MAYA_DEV_TEST_WALLET', false);
  const devTestWalletRole = text('MAYA_DEV_TEST_WALLET_ROLE', 'player-1');
  if (devTestWallet) {
    // DEV ONLY and fail closed: the test wallet signs with .secrets player keys, so it never runs off a local loopback chain.
    if (network !== 'local') errors.push('MAYA_DEV_TEST_WALLET=1 needs MAYA_NETWORK=local (it is never available on base-sepolia or offline)');
    if (text('MAYA_HOST', '127.0.0.1') !== '127.0.0.1') errors.push('MAYA_DEV_TEST_WALLET=1 needs MAYA_HOST=127.0.0.1');
    if (!/^player-[1-9]\d{0,3}$/.test(devTestWalletRole)) errors.push('MAYA_DEV_TEST_WALLET_ROLE must be player-N');
  }
  const config: ServerConfig = {
    repoRoot, network: network as ChainNetwork, feed: feed as 'replay' | 'live',
    replaySpeed: num('MAYA_REPLAY_SPEED', 20, 0.1, 1000),
    ...(time('MAYA_REPLAY_FROM') !== undefined ? { replayFromMs: time('MAYA_REPLAY_FROM')! } : {}),
    ...(time('MAYA_REPLAY_TO') !== undefined ? { replayToMs: time('MAYA_REPLAY_TO')! } : {}),
    marketDataDir: resolve(text('MAYA_MARKET_DATA', resolve(repoRoot, '..', 'market-data'))),
    markets: markets as MarketId[],
    simPlayers: num('MAYA_SIM_PLAYERS', 12_000, 0, 1_000_000, true),
    ...(arrivals !== undefined ? { simArrivalsPerMin: arrivals } : {}),
    simSeed: text('MAYA_SIM_SEED', 'maya-live'),
    onchainBets: bool('MAYA_ONCHAIN_BETS', true),
    onchainDepositOpen: num('MAYA_ONCHAIN_DEPOSIT_OPEN', 1000, 1, 1_000_000),
    adminPort: num('MAYA_ADMIN_PORT', 8790, 1, 65_535, true),
    host: text('MAYA_HOST', '127.0.0.1'),
    dataDir: resolve(text('MAYA_DATA_DIR', resolve(repoRoot, 'apps', 'house-server', 'data'))),
    ...(runId ? { runId } : {}),
    allowFreshLedger: bool('MAYA_ALLOW_FRESH_LEDGER', false),
    relayUrl: text('MAYA_RELAY_URL', 'http://127.0.0.1:8787'),
    secretsDir: resolve(text('MAYA_SECRETS_DIR', resolve(repoRoot, '.secrets'))),
    trainHours: num('MAYA_TRAIN_HOURS', 36, 1, 240),
    refitHours: num('MAYA_REFIT_HOURS', 6, 0.1, 240),
    refitOnStart: bool('MAYA_REFIT_ON_START', true),
    attestEveryMs: num('MAYA_ATTEST_EVERY_MIN', 10, 1, 1440) * 60_000,
    guardSigma: num('MAYA_GUARD_SIGMA', 3, 0.5, 20),
    minStakeCenti: minStake,
    houseFundOpen: num('MAYA_HOUSE_FUND_OPEN', 100_000_000, 0, 1e12),
    journal: bool('MAYA_JOURNAL', true),
    referenceFeed: referenceFeed === 'hermes' ? 'hermes' : 'off', hermesUrl,
    openPlayerApi: openPlayerApi === 'testnet-unsafe' ? 'testnet-unsafe' : 'off',
    ...(rpcUrl ? { rpcUrl } : {}),
    publicOrigin, ...(publicRpcUrl ? { publicRpcUrl } : {}), devTestWallet, devTestWalletRole,
  };
  return errors.length ? { ok: false, errors } : { ok: true, config };
}
