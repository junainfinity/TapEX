/**
 * `?demo` fixture: a deterministic, seeded miniature of the house server that
 * produces every §7 payload and evolves in (injectable) real time.
 *
 * Scripted beats so a reviewer sees the interesting states within minutes:
 *   ~25 s  ETH/USD feed goes stale → feedStale breaker trips (clears ~41 s; repeats every 150 s)
 *   ~45 s  registered players cross 10,000 → launch boost ends, edge 3 % → 8 %
 *   ~70 s  the demo server drops the SSE stream once (then every 300 s) to show auto-reconnect
 *   ~35 s  the adaptive edge controller nudges a range (then every 90 s): audit entry + Defenses nudge feed
 *   ~95 s  a ledger-signer rotation proposed 48 h earlier becomes due (SIGNER_CHANGE_PENDING → SIGNER_CHANGE_DUE)
 *   every 10 min of demo time the ledger signer attests (resets the escape-hatch clock)
 * Bets stream continuously; legs settle at window end. All money is bigint Centi.
 * SPEC-10/11 extras (defenses, vault hardening, proofs) use their own PRNG so the seeded sequence above is unchanged.
 *
 * Addresses here are generated from the seed and are NOT the testnet wallets.
 */
import type {
  AuditEntry, BetLeg, Breaker, ChainState, DefenseConfig, DefensesView, Exposure, LaunchState, LimitsConfig, MarketState, MetricsSeries, Overview, PlayerDetail, PlayerFlag,
  PlayerPage, PlayerRow, PricingConfig, RefitProgress, RtpReport, RtpRow, SimState, StreamEventType, WithdrawalAnomaly,
} from '../types.js';
import { applyDefensePatch, controllerView, defaultDefenses, demoChainAlerts, demoEscape, fakeHash, RANGE_KEYS, type DemoVaultHealth } from './extras.js';

const WEI = 10n ** 16n;
/** Stable pseudo-random unit value from a string (does not consume the seeded PRNG). */
function unit(seed: string): number { return parseInt(fakeHash(seed).slice(2, 10), 16) / 0x1_0000_0000; }
const nonceOf = (seed: string) => BigInt(`0x${fakeHash(seed).slice(2, 64)}`).toString();

export const DEMO_START_MS = Date.UTC(2026, 8, 26, 14, 0, 0);
export const DEMO_TOKEN = 'demo-token';
export const BREAKER_TRIP_S = 25;
export const BREAKER_CLEAR_S = 41;
export const BREAKER_PERIOD_S = 150;
export const STREAM_DROP_S = 70;
export const STREAM_DROP_PERIOD_S = 300;
const HISTORY_MINUTES = 26 * 60;
const RANGES = ['1.01-2', '2-5', '5-10', '10-20', '20-50'] as const;
const STRATEGIES = ['casual', 'chaser', 'grinder', 'streaker', 'sniper1s', 'whale'] as const;
type Strategy = (typeof STRATEGIES)[number];

/** mulberry32: small, fast, deterministic. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (rand: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
const OPEN = (open: number) => BigInt(Math.round(open * 100));
const centi = (v: bigint) => v.toString();

interface MarketSim {
  readonly id: string;
  /** Price in hundredths (cents) as an integer, so the walk never accumulates float error. */
  spot: bigint;
  readonly bandHundredths: bigint;
  readonly sigmaHundredths: number;
  lastPriceMs: number;
  manualPaused: boolean;
  tableId: string;
  previousTableId: string;
  tableBuiltMs: number;
  sigma: number;
}

interface PlayerSim {
  readonly account: string;
  readonly kind: 'onchain' | 'sim';
  readonly strategy?: Strategy;
  balance: bigint;
  handle: bigint;
  returned: bigint;
  pnl: bigint;
  bets: number;
  flagged: boolean;
  blocked: boolean;
  readonly firstSeenMs: number;
  lastWin: boolean;
  readonly legs: DemoLeg[];
  readonly deposits: { id: string; amountCenti: string; ms: number; txHash: string; status: string; dustWei?: string }[];
  readonly withdrawals: { id: string; amountCenti: string; ms: number; txHash?: string; status: string; nonce?: string; expiryMs?: number; claimSource?: string }[];
  readonly flags: PlayerFlag[];
  /** SPEC-10 toxicity evidence. */
  holds: number;
  latencyZ: number;
  excessZ: number;
}

interface DemoLeg {
  readonly legId: string;
  readonly account: string;
  readonly kind: 'onchain' | 'sim';
  readonly market: string;
  readonly start: number;
  readonly end: number;
  readonly bucket: number;
  readonly lower: string;
  readonly upper: string;
  readonly stake: bigint;
  readonly x100: number;
  readonly payout: bigint;
  readonly pTrue: number;
  readonly placedMs: number;
  readonly phase: 'launch' | 'standard';
  readonly range: string;
  status: 'open' | 'won' | 'lost' | 'refunded';
  settledMs?: number;
  streamed: boolean;
}

interface Agg { bets: number; handle: bigint; returned: bigint; expected: number }

export interface DemoEvent { readonly event: StreamEventType; readonly data: unknown }

export type WriteOutcome =
  | { readonly ok: true; readonly ack: Record<string, unknown> }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

export interface DemoWorldOptions {
  readonly seed?: number;
  /** Real-time source in ms (injectable for tests). */
  readonly now?: () => number;
}

function formatHundredths(v: bigint): string {
  const neg = v < 0n; const m = neg ? -v : v;
  return `${neg ? '-' : ''}${m / 100n}.${(m % 100n).toString().padStart(2, '0')}`;
}

function rangeOf(x100: number): string {
  const x = x100 / 100;
  return x < 2 ? '1.01-2' : x < 5 ? '2-5' : x < 10 ? '5-10' : x < 20 ? '10-20' : '20-50';
}

export class DemoWorld {
  private readonly rand: () => number;
  private readonly now: () => number;
  private readonly realStart: number;
  private lastReal: number;
  private clockMs = DEMO_START_MS;
  private elapsedS = 0;
  private legSeq = 0;
  private auditSeq = 0;
  private jobSeq = 0;
  private txSeq = 0;
  private registered = 9_862;
  private registeredFrac = 0;
  private active5m = 1_184;
  private equity = OPEN(3_184_512.37);
  private handle24h: bigint;
  private ggr24h: bigint;
  private betsThisMinute = 0;
  private betsPerMin = 1_020;
  private rejected = 0;
  private lastSecond = 0;
  private breakerOn = false;
  private boostEndedAnnounced = false;
  private nextMetricMs: number;
  private readonly markets: MarketSim[];
  private readonly roster: PlayerSim[] = [];
  private readonly byAccount = new Map<string, PlayerSim>();
  private readonly openLegs: DemoLeg[] = [];
  private readonly settledLegs: DemoLeg[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly breakers: Breaker[];
  private readonly agg = new Map<string, Agg>();
  private readonly refits = new Map<string, { progress: number; startedS: number; done: boolean }>();
  private lastRefitMs = DEMO_START_MS - 5.5 * 3_600_000;
  private manualGlobal = false;
  private readonly history: { t: number[]; equity: bigint[]; ggr: bigint[]; handle: bigint[]; rtp: (number | null)[]; openLiability: bigint[]; players: number[]; betsPerMin: number[] };
  readonly launch: { enabled: boolean; edge: number; untilPlayers: number };
  readonly pricing: { standardEdge: number; capX100: number; aboveCap: 'hide' | 'cap'; impactK: number; z: number };
  readonly limits: { cellFraction: number; columnFraction: number; globalFraction: number; accountFraction: number; maxStakePerBetCenti: bigint; maxStakePerCellCenti: bigint };
  readonly sim: SimState & { running: boolean; speed: number; arrivalsPerMin: number };
  private readonly chainState: {
    vault: string; token: string; operator: string; signer: string; paused: boolean;
    houseFunded: bigint; deposits: bigint; withdrawals: bigint; houseWithdrawn: bigint;
    operatorToken: bigint; operatorEthWei: bigint; attestSeq: number; attestAsOf: number; attestLiabilities: bigint; attestRoot: string; attestTx: string; attestBlock: number;
    depositsSinceAttest: bigint; claimedSinceAttest: bigint; head: number;
  };
  // ---------- SPEC-10 defenses and SPEC-11 vault hardening ----------
  private readonly rand2: () => number;
  private defenses: DefenseConfig = defaultDefenses();
  private readonly hold = { created: 184_220, accepted: 169_470, rejected: 14_750, byDetail: { ok: 169_470, 'fair-value': 12_190, timeout: 2_060, ramp: 410, 'flag-variant': 64, blocked: 26 } as Record<string, number>, recentCreated: 61_000, recentRejected: 4_880 };
  private flowHandle1h = 9.1e7;
  private flowFlagged1h = 1.4e6;
  private flowHandleAll = 2.9e9;
  private flowFlaggedAll = 3.6e7;
  private readonly controller: { key: string; adjust: number; bets: number; handle: bigint; returned: number; target: number; se: number; lastChangeMs?: number }[];
  private nextNudgeS = 35;
  private nudgeCursor = 0;
  private nextAutoAttestMs = DEMO_START_MS + 6 * 60_000;
  private readonly vault2: {
    serverSigner: string; pendingSigner: { address: string; etaMs: number } | null; excessWei: bigint; lastAttestationAtMs: number; houseWithdrawnToday: bigint;
    anomalies: WithdrawalAnomaly[]; indexedWithdrawals: number;
  };
  private activeAlerts = new Map<string, string>();

  constructor(options: DemoWorldOptions = {}) {
    this.rand = prng(options.seed ?? 20260926);
    this.now = options.now ?? (() => Date.now());
    this.realStart = this.now();
    this.lastReal = this.realStart;
    this.launch = { enabled: true, edge: 0.03, untilPlayers: 10_000 };
    this.pricing = { standardEdge: 0.08, capX100: 5000, aboveCap: 'hide', impactK: 0.5, z: 1 };
    this.limits = { cellFraction: 0.001, columnFraction: 0.005, globalFraction: 0.02, accountFraction: 0.002, maxStakePerBetCenti: OPEN(2_500), maxStakePerCellCenti: OPEN(10_000) };
    this.sim = { running: true, speed: 1, arrivalsPerMin: 190 };
    const r = this.rand;
    this.markets = [
      { id: 'btc-usd', spot: 6_401_250n, bandHundredths: 1_000n, sigmaHundredths: 260, lastPriceMs: DEMO_START_MS, manualPaused: false, tableId: 'maya-calibrated-v3-btc-usd@2026-09-26T08:30Z', previousTableId: 'maya-calibrated-v3-btc-usd@2026-09-26T02:30Z', tableBuiltMs: DEMO_START_MS - 5.5 * 3_600_000, sigma: 0.00041 },
      { id: 'eth-usd', spot: 245_125n, bandHundredths: 50n, sigmaHundredths: 14, lastPriceMs: DEMO_START_MS, manualPaused: false, tableId: 'maya-calibrated-v3-eth-usd@2026-09-26T08:30Z', previousTableId: 'maya-calibrated-v3-eth-usd@2026-09-26T02:30Z', tableBuiltMs: DEMO_START_MS - 5.5 * 3_600_000, sigma: 0.00058 },
    ];
    this.breakers = [
      { id: 'feedStale', market: 'btc-usd', state: 'ok', since: DEMO_START_MS - 86_000_000, reason: '' },
      { id: 'feedStale', market: 'eth-usd', state: 'ok', since: DEMO_START_MS - 52_000_000, reason: '' },
      { id: 'drawdown', state: 'ok', since: DEMO_START_MS - 90_000_000, reason: '' },
      { id: 'equityFloor', state: 'ok', since: DEMO_START_MS - 90_000_000, reason: '' },
      { id: 'manual', state: 'ok', since: DEMO_START_MS - 20_000_000, reason: '' },
    ];
    this.chainState = {
      vault: `0x${hex(r, 40)}`, token: `0x${hex(r, 40)}`, operator: `0x${hex(r, 40)}`, signer: `0x${hex(r, 40)}`, paused: false,
      houseFunded: OPEN(3_000_000), deposits: 0n, withdrawals: 0n, houseWithdrawn: 0n,
      operatorToken: OPEN(1_000_000_000 - 3_000_000), operatorEthWei: 421_337_000_000_000_000n,
      attestSeq: 142, attestAsOf: DEMO_START_MS - 4 * 60_000, attestLiabilities: 0n, attestRoot: `0x${hex(r, 64)}`, attestTx: `0x${hex(r, 64)}`, attestBlock: 18_442_907,
      depositsSinceAttest: 0n, claimedSinceAttest: 0n, head: 18_443_031,
    };
    this.seedPlayers();
    this.seedAggregates();
    this.history = this.buildHistory();
    const last = this.history.t.length - 1;
    this.handle24h = this.history.handle[last]!;
    this.ggr24h = this.history.ggr[last]!;
    this.nextMetricMs = DEMO_START_MS + 60_000;
    this.seedAudit();
    this.chainState.attestLiabilities = this.onchainLiabilities();
    // SPEC-10/11 extras: a separate PRNG so the Stage A seeded sequence (and its tests) is unchanged.
    this.rand2 = prng(((options.seed ?? 20260926) ^ 0x5eed5eed) >>> 0);
    const r2 = this.rand2;
    this.controller = [
      { key: '1.01-2', adjust: 0.01, bets: 41_200, handle: OPEN(741_600), returned: 0.9712, target: 0.97, se: 0.0031, lastChangeMs: DEMO_START_MS - 50 * 60_000 },
      { key: '2-5', adjust: 0, bets: 23_800, handle: OPEN(261_800), returned: 0.9655, target: 0.97, se: 0.0072 },
      { key: '5-10', adjust: 0.02, bets: 9_600, handle: OPEN(67_200), returned: 1.0041, target: 0.97, se: 0.017, lastChangeMs: DEMO_START_MS - 20 * 60_000 },
      { key: '10-20', adjust: 0, bets: 4_100, handle: OPEN(20_500), returned: 0.9302, target: 0.97, se: 0.039 },
      { key: '20-50', adjust: 0, bets: 1_240, handle: OPEN(3_720), returned: 1.0977, target: 0.97, se: 0.087 },
      { key: '50-100', adjust: 0, bets: 0, handle: 0n, returned: 0, target: 0.97, se: 0 },
    ];
    const firstOnchain = this.roster.find(p => p.kind === 'onchain')!;
    this.vault2 = {
      serverSigner: this.chainState.signer,
      // Proposed 48 h before the demo started minus 95 s: it becomes due ~95 s into the demo.
      pendingSigner: { address: `0x${hex(r2, 40)}`, etaMs: DEMO_START_MS + 95_000 },
      excessWei: OPEN(1_234.56) * WEI + 42n,
      lastAttestationAtMs: this.chainState.attestAsOf,
      houseWithdrawnToday: 0n,
      anomalies: [{
        key: `${firstOnchain.account}:${nonceOf('demo-anomaly')}`, player: firstOnchain.account, nonce: nonceOf('demo-anomaly'), amountWei: (OPEN(20) * WEI).toString(),
        txHash: fakeHash('demo-anomaly-tx'), outcome: 'claimed-after-release', voucherId: 'V000009', ms: DEMO_START_MS - 3 * 3_600_000,
      }],
      indexedWithdrawals: 3,
    };
    this.journal({ kind: 'admin', actor: 'admin', action: 'vault-signer-propose', target: 'vault', before: { pendingSigner: null }, after: { pendingSigner: this.vault2.pendingSigner?.address ?? null }, reason: 'Rotate the ledger-signer key to the new HSM-backed signer', result: 'ok' });
    this.audit[this.audit.length - 1] = { ...this.audit[this.audit.length - 1]!, ms: DEMO_START_MS + 95_000 - 172_800_000 };
    this.activeAlerts = new Map(this.vaultAlerts().map(a => [a.code, a.level]));
  }

  private vaultHealth(): DemoVaultHealth {
    return {
      nowMs: Math.floor(this.clockMs), ledgerSigner: this.chainState.signer, serverSigner: this.vault2.serverSigner, pendingSigner: this.vault2.pendingSigner,
      lastAttestationAtMs: this.vault2.lastAttestationAtMs, escapeDelayMs: 7 * 86_400_000, maxAttestationAgeMs: 600_000, attestEveryMs: 600_000, escapeMode: false,
    };
  }
  private vaultAlerts() { return demoChainAlerts(this.vaultHealth()); }

  /** SSE alerts on new or escalated vault conditions, and `<CODE>_RESOLVED` when one clears (the server's health check). */
  private checkVaultAlerts(events: DemoEvent[]): void {
    const now = this.vaultAlerts();
    const next = new Map(now.map(a => [a.code, a.level]));
    for (const a of now) if (this.activeAlerts.get(a.code) !== a.level) events.push({ event: 'alert', data: { level: a.level, message: a.message, ms: this.clockMs, code: a.code } });
    for (const [code] of this.activeAlerts) if (!next.has(code)) events.push({ event: 'alert', data: { level: 'info', message: `Resolved: ${code.toLowerCase().replace(/_/g, ' ')}`, ms: this.clockMs, code: `${code}_RESOLVED` } });
    this.activeAlerts = next;
  }

  private attestNow(actor: string, reason: string, journal = true): { seq: number; txHash: string } {
    const c = this.chainState;
    const before = { seq: c.attestSeq };
    c.attestSeq += 1; c.attestAsOf = Math.floor(this.clockMs); c.attestLiabilities = this.onchainLiabilities();
    c.attestRoot = fakeHash(`root:${c.attestSeq}`); c.attestTx = fakeHash(`attest:${c.attestSeq}`); c.attestBlock = c.head + Math.floor(this.elapsedS / 2);
    c.depositsSinceAttest = 0n; c.claimedSinceAttest = 0n;
    this.vault2.lastAttestationAtMs = c.attestAsOf;
    if (journal) this.journal({ kind: actor === 'admin (demo)' ? 'admin' : 'system', actor, action: 'treasury-attest', target: 'vault', before, after: { seq: c.attestSeq }, reason, result: 'ok' });
    return { seq: c.attestSeq, txHash: c.attestTx };
  }

  /** Scripted adaptive-edge nudge: move one range toward its gap by one step, journaled like the server's controller. */
  private nudgeController(events: DemoEvent[]): void {
    const cfg = this.defenses.controller;
    if (!cfg.enabled) return;
    for (let tries = 0; tries < 4; tries++) {
      const slot = this.controller[this.nudgeCursor++ % 4]!;
      if (cfg.overrides[slot.key] !== undefined || slot.bets < cfg.minBets) continue;
      const gap = slot.returned - slot.target;
      const step = Math.min(cfg.maxStepPerEval, 0.01) * (gap > 0 ? 1 : -1);
      const after = Math.round(Math.min(cfg.maxAdjust, Math.max(cfg.minAdjust, slot.adjust + step)) * 1e6) / 1e6;
      if (after === slot.adjust) continue;
      const before = slot.adjust;
      slot.adjust = after; slot.lastChangeMs = Math.floor(this.clockMs);
      slot.returned = Math.round((slot.returned - step * 0.6) * 10_000) / 10_000;
      const entry = this.journal({ kind: 'system', actor: 'edge-controller', action: 'controller-adjust', target: slot.key, before, after, result: 'ok',
        reason: `realized RTP ${(slot.returned * 100 + step * 60).toFixed(2)}% vs target ${(slot.target * 100).toFixed(2)}% over ${slot.bets} non-flagged bets (SE ${(slot.se * 100).toFixed(2)} pts)` });
      events.push({ event: 'admin-action', data: entry });
      return;
    }
  }

  // ---------- seeding ----------

  private seedPlayers(): void {
    const r = this.rand;
    for (let i = 0; i < 11; i++) {
      const account = `0x${hex(r, 40)}`; // bare lower-case address, as the house server names on-chain accounts
      const deposit = OPEN(2_000 + Math.round(r() * 9_000));
      const bets = 30 + Math.floor(r() * 400);
      const handle = OPEN(bets * (10 + r() * 60));
      const rtp = 0.9 + r() * 0.12;
      const returned = BigInt(Math.round(Number(handle) * rtp));
      const withdrawn = i % 4 === 0 ? OPEN(500 + Math.round(r() * 1_500)) : 0n;
      const balance = deposit + returned - handle - withdrawn;
      const p = this.addPlayer({ account, kind: 'onchain', balance: balance > 0n ? balance : OPEN(50), handle, returned, pnl: returned - handle, bets, flagged: false, blocked: false, firstSeenMs: DEMO_START_MS - Math.floor(r() * 5 * 86_400_000) });
      p.deposits.push({ id: `dep-${i}`, amountCenti: centi(deposit), ms: p.firstSeenMs + 60_000, txHash: `0x${hex(r, 64)}`, status: 'credited', ...(i === 3 ? { dustWei: '7300000000000' } : {}) });
      this.chainState.deposits += deposit;
      if (withdrawn > 0n) {
        p.withdrawals.push({ id: `wd-${i}`, amountCenti: centi(withdrawn), ms: p.firstSeenMs + 3_600_000 * 20, txHash: `0x${hex(r, 64)}`, status: 'claimed', nonce: nonceOf(`wd-${i}`), expiryMs: p.firstSeenMs + 3_600_000 * 21, claimSource: 'event' });
        this.chainState.withdrawals += withdrawn;
      }
    }
    const weights: [Strategy, number][] = [['casual', 0.55], ['chaser', 0.12], ['grinder', 0.15], ['streaker', 0.1], ['sniper1s', 0.03], ['whale', 0.05]];
    for (let i = 1; i <= 480; i++) {
      let x = r(); let strategy: Strategy = 'casual';
      for (const [s, w] of weights) { if (x < w) { strategy = s; break; } x -= w; }
      const avgStake = { casual: 6, chaser: 3, grinder: 22, streaker: 9, sniper1s: 30, whale: 900 }[strategy];
      const bets = Math.floor(20 + r() * (strategy === 'grinder' ? 4_000 : 1_200));
      const handle = OPEN(bets * avgStake * (0.6 + r() * 0.8));
      const rtp = strategy === 'sniper1s' ? 1.05 + r() * 0.08 : 0.88 + r() * 0.14;
      const returned = BigInt(Math.round(Number(handle) * rtp));
      const balance = OPEN(200 + r() * 4_000);
      this.addPlayer({ account: `sim:${String(i).padStart(5, '0')}`, kind: 'sim', strategy, balance, handle, returned, pnl: returned - handle, bets, flagged: strategy === 'sniper1s' && i % 2 === 0, blocked: strategy === 'sniper1s' && i % 7 === 0, firstSeenMs: DEMO_START_MS - Math.floor(r() * 26 * 3_600_000) });
    }
  }

  private addPlayer(p: Omit<PlayerSim, 'legs' | 'deposits' | 'withdrawals' | 'flags' | 'lastWin' | 'holds' | 'latencyZ' | 'excessZ'>): PlayerSim {
    // Toxicity evidence from a hash of the account (the seeded PRNG sequence stays untouched).
    const u1 = unit(`${p.account}:latency`); const u2 = unit(`${p.account}:excess`); const sniper = p.strategy === 'sniper1s';
    const full: PlayerSim = { ...p, lastWin: false, legs: [], deposits: [], withdrawals: [], flags: [], holds: p.bets + Math.round(p.bets * 0.09), latencyZ: sniper ? 3 + u1 * 4 : (u1 - 0.5) * 3, excessZ: sniper ? 2 + u2 * 3 : (u2 - 0.5) * 2.4 };
    if (full.flagged) full.flags.push({ ms: DEMO_START_MS - 7_200_000, actor: 'toxicity-monitor', action: 'flag', reason: 'Win rate on 1-window squares 3.1σ above expectation' });
    if (full.blocked) full.flags.push({ ms: DEMO_START_MS - 3_600_000, actor: 'admin', action: 'block', reason: 'Confirmed latency arbitrage pattern (sniper)' });
    this.roster.push(full);
    this.byAccount.set(full.account, full);
    return full;
  }

  private seedAggregates(): void {
    const launch: Record<string, [number, number]> = { '1.01-2': [412_000, 0.9702], '2-5': [238_000, 0.9688], '5-10': [96_000, 0.9731], '10-20': [41_000, 0.9245], '20-50': [12_400, 1.0412] };
    const avgStake: Record<string, number> = { '1.01-2': 18, '2-5': 11, '5-10': 7, '10-20': 5, '20-50': 3 };
    for (const range of RANGES) {
      const [bets, rtp] = launch[range]!;
      const handle = OPEN(bets * avgStake[range]!);
      this.agg.set(`${range}|launch`, { bets, handle, returned: BigInt(Math.round(Number(handle) * rtp)), expected: 0.97 });
      this.agg.set(`${range}|standard`, { bets: 0, handle: 0n, returned: 0n, expected: 0.92 });
    }
  }

  private buildHistory() {
    const r = prng(7);
    const n = HISTORY_MINUTES;
    const t: number[] = []; const players: number[] = []; const bpm: number[] = []; const handleMin: bigint[] = []; const ggrMin: bigint[] = [];
    for (let i = 0; i < n; i++) {
      const ms = DEMO_START_MS - (n - i) * 60_000;
      t.push(ms);
      const logistic = (k: number) => 1 / (1 + Math.exp(-(k - n * 0.55) / (n * 0.14)));
      players.push(Math.round(1_400 + (this.registered - 1_400) * (logistic(i) / logistic(n - 1))));
      const hour = new Date(ms).getUTCHours();
      const diurnal = 0.75 + 0.25 * Math.sin(((hour - 8) / 24) * Math.PI * 2);
      const b = Math.max(40, Math.round((260 + 900 * (players[i]! / 10_000)) * diurnal * (0.9 + r() * 0.2)));
      bpm.push(b);
      const h = OPEN(b * (12 + r() * 5));
      handleMin.push(h);
      const edge = 0.03 + (r() - 0.5) * 0.05;
      ggrMin.push(BigInt(Math.round(Number(h) * edge)));
    }
    const handle: bigint[] = []; const ggr: bigint[] = []; const rtp: (number | null)[] = [];
    let hSum = 0n; let gSum = 0n;
    for (let i = 0; i < n; i++) {
      hSum += handleMin[i]!; gSum += ggrMin[i]!;
      if (i >= 1440) { hSum -= handleMin[i - 1440]!; gSum -= ggrMin[i - 1440]!; }
      handle.push(hSum); ggr.push(gSum);
      rtp.push(hSum > 0n ? 1 - Number(gSum * 1_000_000n / hSum) / 1_000_000 : null);
    }
    const equity: bigint[] = new Array(n);
    let e = this.equity;
    for (let i = n - 1; i >= 0; i--) { equity[i] = e; e -= ggrMin[i]!; }
    const openLiability = equity.map((eq, i) => eq * BigInt(Math.round(this.limits.globalFraction * 1e6)) / 1_000_000n * BigInt(Math.round((0.22 + 0.2 * (bpm[i]! / 1_300) + r() * 0.06) * 1000)) / 1000n);
    return { t, equity, ggr, handle, rtp, openLiability, players, betsPerMin: bpm };
  }

  private seedAudit(): void {
    const base = DEMO_START_MS;
    const add = (e: Omit<AuditEntry, 'id'>) => this.audit.push({ id: `a-${++this.auditSeq}`, ...e });
    add({ ms: base - 20 * 3_600_000, kind: 'admin', actor: 'admin', action: 'limits', target: 'limits', before: { cellFraction: 0.0015 }, after: { cellFraction: 0.001 }, reason: 'Tighten per-cell after whale clustering on 20-50× squares', result: 'ok' });
    add({ ms: base - 14.4 * 3_600_000, kind: 'breaker', actor: 'system', action: 'breaker feedStale', target: 'eth-usd', before: 'ok', after: 'tripped', reason: 'No fresh price for 8.1 s' });
    add({ ms: base - 14.39 * 3_600_000, kind: 'breaker', actor: 'system', action: 'breaker feedStale', target: 'eth-usd', before: 'tripped', after: 'ok', reason: 'Feed fresh again' });
    add({ ms: base - 9 * 3_600_000, kind: 'admin', actor: 'admin', action: 'pricing', target: 'pricing', before: { impactK: 0.35 }, after: { impactK: 0.5 }, reason: 'Crowded cells were still paying the full multiplier', result: 'ok' });
    add({ ms: base - 5.5 * 3_600_000, kind: 'system', actor: 'system', action: 'refit', target: 'tables', before: 'maya-calibrated-v3-*@02:30Z', after: 'maya-calibrated-v3-*@08:30Z', reason: 'Scheduled 6 h refit (36 h window)', result: 'ok' });
    add({ ms: base - 3_600_000, kind: 'admin', actor: 'admin', action: 'player block', target: 'sim:00007', before: 'active', after: 'blocked', reason: 'Confirmed latency arbitrage pattern (sniper)', result: 'ok' });
    add({ ms: base - 4 * 60_000, kind: 'system', actor: 'ledger-signer', action: 'attest', target: 'vault', before: { seq: 141 }, after: { seq: 142 }, reason: 'Periodic attestation (10 min)', result: 'ok' });
  }

  // ---------- time ----------

  /** Server clock in ms. */
  clock(): number { return this.clockMs; }
  /** Seconds of demo time elapsed. */
  get elapsedSeconds(): number { return this.elapsedS; }
  get realElapsedSeconds(): number { return (this.now() - this.realStart) / 1000; }

  private currentEdge(): number {
    const base = this.launch.enabled && this.registered < this.launch.untilPlayers ? this.launch.edge : this.pricing.standardEdge;
    return base;
  }
  private boostActive(): boolean { return this.launch.enabled && this.registered < this.launch.untilPlayers; }

  /** Advance the simulation to the current real time; returns stream events produced. */
  step(): DemoEvent[] {
    const real = this.now();
    const dtMs = Math.max(0, Math.min(5_000, real - this.lastReal));
    this.lastReal = real;
    const events: DemoEvent[] = [];
    if (dtMs === 0) return events;
    const simDt = dtMs * this.sim.speed;
    // Trailing-hour windows (hold outcomes, toxic-flow share) decay with demo time.
    const decay = Math.exp(-simDt / 3_600_000);
    this.hold.recentCreated *= decay; this.hold.recentRejected *= decay; this.flowHandle1h *= decay; this.flowFlagged1h *= decay;
    this.clockMs += simDt;
    this.elapsedS += simDt / 1000;
    // Prices: one step per whole simulated second.
    const second = Math.floor(this.elapsedS);
    for (let s = this.lastSecond + 1; s <= second; s++) this.tickSecond(s, events);
    this.lastSecond = Math.max(this.lastSecond, second);
    this.placeBets(simDt, events);
    this.settle(events);
    this.progressRefits(events);
    while (this.clockMs >= this.nextMetricMs) { this.appendMetric(this.nextMetricMs); this.nextMetricMs += 60_000; }
    return events;
  }

  private tickSecond(s: number, events: DemoEvent[]): void {
    // Overview events are paced by the server loop (1 per real second), not per simulated second.
    const r = this.rand;
    const inStale = this.inBreakerWindow(s);
    for (const m of this.markets) {
      if (m.id === 'eth-usd' && inStale) continue; // feed stale: no fresh first-seen price
      const shock = BigInt(Math.round((r() + r() + r() - 1.5) * 2 * m.sigmaHundredths));
      m.spot += shock;
      m.lastPriceMs = this.clockMs - Math.floor(r() * 400);
      m.sigma = Math.max(0.0001, m.sigma * (0.98 + r() * 0.04));
    }
    const eth = this.breakers.find(b => b.id === 'feedStale' && b.market === 'eth-usd')!;
    const eMarket = this.markets[1]!;
    if (inStale && !this.breakerOn && this.clockMs - eMarket.lastPriceMs > 7_000) {
      this.breakerOn = true;
      const next: Breaker = { ...eth, state: 'tripped', since: this.clockMs, reason: `No fresh price for ${((this.clockMs - eMarket.lastPriceMs) / 1000).toFixed(1)} s` };
      this.replaceBreaker(next);
      events.push({ event: 'breaker', data: next }, { event: 'alert', data: { level: 'warning', message: 'ETH/USD feed stale: quoting paused for ETH/USD.', ms: this.clockMs, code: 'FEED_STALE' } });
      this.journal({ kind: 'breaker', actor: 'system', action: 'breaker feedStale', target: 'eth-usd', before: 'ok', after: 'tripped', reason: next.reason });
    } else if (!inStale && this.breakerOn) {
      this.breakerOn = false;
      const next: Breaker = { ...eth, state: 'ok', since: this.clockMs, reason: 'Feed fresh again' };
      this.replaceBreaker(next);
      events.push({ event: 'breaker', data: next }, { event: 'alert', data: { level: 'info', message: 'ETH/USD feed recovered: quoting resumed.', ms: this.clockMs, code: 'FEED_OK' } });
      this.journal({ kind: 'breaker', actor: 'system', action: 'breaker feedStale', target: 'eth-usd', before: 'tripped', after: 'ok', reason: next.reason });
    }
    // SPEC-10/11 beats: controller nudges, periodic attestation, vault-alert transitions.
    if (s >= this.nextNudgeS) { this.nextNudgeS += 90; this.nudgeController(events); }
    if (this.clockMs >= this.nextAutoAttestMs) {
      this.nextAutoAttestMs = Math.floor(this.clockMs) + 600_000;
      this.attestNow('ledger-signer', 'Periodic attestation (10 min)');
      events.push({ event: 'admin-action', data: this.audit[this.audit.length - 1] });
    }
    this.checkVaultAlerts(events);
    // Arrivals: fast until the launch threshold, then the organic rate.
    const perSecond = this.sim.running ? (this.registered < 10_000 ? 3.2 : this.sim.arrivalsPerMin / 60) : 0;
    this.registeredFrac += perSecond * (0.6 + r() * 0.8);
    const whole = Math.floor(this.registeredFrac);
    this.registeredFrac -= whole;
    const wasActive = this.boostActive();
    this.registered += whole;
    this.active5m = Math.round(this.active5m * 0.995 + (this.sim.running ? 7 : 1) + r() * 3);
    if (wasActive && !this.boostActive() && !this.boostEndedAnnounced) {
      this.boostEndedAnnounced = true;
      const msg = `Launch boost ended at ${this.registered.toLocaleString('en-US')} registered players: edge ${(this.launch.edge * 100).toFixed(0)}% → ${(this.pricing.standardEdge * 100).toFixed(0)}% on new quotes.`;
      events.push({ event: 'alert', data: { level: 'info', message: msg, ms: this.clockMs, code: 'LAUNCH_BOOST_ENDED' } });
      const entry = this.journal({ kind: 'system', actor: 'system', action: 'launch boost ended', target: 'launch', before: { active: true, edge: this.launch.edge }, after: { active: false, edge: this.pricing.standardEdge }, reason: `registeredPlayers reached untilPlayers (${this.launch.untilPlayers.toLocaleString('en-US')})` });
      events.push({ event: 'admin-action', data: entry });
    }
  }

  private inBreakerWindow(s: number): boolean {
    const phase = s % BREAKER_PERIOD_S;
    return phase >= BREAKER_TRIP_S - 8 && phase < BREAKER_CLEAR_S;
  }

  private replaceBreaker(next: Breaker): void {
    const i = this.breakers.findIndex(b => b.id === next.id && b.market === next.market);
    if (i >= 0) this.breakers[i] = next;
  }

  private marketPaused(m: MarketSim): boolean {
    const stale = this.breakers.some(b => b.id === 'feedStale' && b.market === m.id && b.state !== 'ok');
    return m.manualPaused || this.manualGlobal || stale;
  }

  /** Touch probability model for the demo quote grid. */
  private pTouch(bOffset: number, w: number): number {
    const d = Math.max(0, Math.abs(bOffset) - 0.5);
    return Math.min(0.95, Math.max(0.02, 0.93 * Math.exp(-d / (0.45 + 0.12 * w))));
  }

  private quoteX100(bOffset: number, w: number, cellLiability: bigint): number | null {
    const p = this.pTouch(bOffset, w);
    const limit = this.cellLimit();
    const share = limit > 0n ? Number(cellLiability * 1_000n / limit) / 1_000 : 0;
    const q = Math.min(1, p * (1 + this.pricing.impactK * share * 0.6));
    const edge = this.currentEdge();
    let x = Math.floor((100 * (1 - edge)) / q);
    if (x < 101) return null;
    if (x > this.pricing.capX100) { if (this.pricing.aboveCap === 'hide') return null; x = this.pricing.capX100; }
    return x;
  }

  private cellLimit(): bigint { return this.equity * BigInt(Math.round(this.limits.cellFraction * 1e7)) / 10_000_000n; }
  private columnLimit(): bigint { return this.equity * BigInt(Math.round(this.limits.columnFraction * 1e7)) / 10_000_000n; }
  private globalLimit(): bigint { return this.equity * BigInt(Math.round(this.limits.globalFraction * 1e7)) / 10_000_000n; }
  private accountLimit(): bigint { return this.equity * BigInt(Math.round(this.limits.accountFraction * 1e7)) / 10_000_000n; }

  private liabilityWhere(pred: (l: DemoLeg) => boolean): bigint {
    let sum = 0n;
    for (const l of this.openLegs) if (pred(l)) sum += l.payout - l.stake;
    return sum;
  }

  private windowStarts(): number[] {
    const tSec = this.clockMs / 1000;
    const start0 = Math.ceil((tSec + 3) / 5) * 5;
    return [0, 1, 2, 3, 4, 5].map(w => (start0 + 5 * w) * 1000);
  }

  private bucketOf(m: MarketSim): number { return Number(m.spot / m.bandHundredths); }

  private pickPlayer(): PlayerSim | null {
    const r = this.rand;
    if (r() < 0.05) return this.roster[Math.floor(r() * 11)]!;
    if (!this.sim.running) return null;
    const p = this.roster[11 + Math.floor(r() * (this.roster.length - 11))]!;
    return p;
  }

  private placeBets(simDtMs: number, events: DemoEvent[]): void {
    const r = this.rand;
    const rate = (this.sim.running ? 17 : 0.9) * (0.8 + 0.4 * r());
    let n = 0;
    const expected = (rate * simDtMs) / 1000;
    n = Math.floor(expected) + (r() < expected - Math.floor(expected) ? 1 : 0);
    let streamedThisStep = 0;
    const maxStream = Math.max(1, Math.round((12 * simDtMs) / 1000));
    for (let i = 0; i < n; i++) {
      const player = this.pickPlayer();
      if (!player || player.blocked) continue;
      const market = r() < 0.6 ? this.markets[0]! : this.markets[1]!;
      if (this.marketPaused(market)) continue;
      const strategy: Strategy | 'onchain' = player.kind === 'onchain' ? 'onchain' : player.strategy ?? 'casual';
      const abs = strategy === 'grinder' ? 0 : strategy === 'chaser' ? 2 + Math.floor(r() * 2) : strategy === 'sniper1s' ? 1 + Math.floor(r() * 2) : Math.min(3, Math.floor(-Math.log(1 - r()) * 1.4));
      const bOffset = abs === 0 ? 0 : r() < 0.5 ? -abs : abs;
      const w = strategy === 'sniper1s' ? 0 : Math.min(5, Math.floor(-Math.log(1 - r()) * 1.6));
      const starts = this.windowStarts();
      const start = starts[w]!;
      const bucket = this.bucketOf(market) + bOffset;
      const cellLiab = this.liabilityWhere(l => l.market === market.id && l.start === start && l.bucket === bucket);
      const x100 = this.quoteX100(bOffset, w, cellLiab);
      if (x100 === null) continue;
      const median = { casual: 6, chaser: 3, grinder: 22, streaker: 9, sniper1s: 30, whale: 900, onchain: 25 }[strategy];
      let stakeOpen = median * Math.exp((r() + r() + r() - 1.5) * 0.9);
      if (strategy === 'streaker' && player.lastWin) stakeOpen *= 2;
      let stake = OPEN(Math.max(0.1, stakeOpen));
      if (stake > this.limits.maxStakePerBetCenti) stake = this.limits.maxStakePerBetCenti;
      if (stake > player.balance) { if (player.kind === 'sim') player.balance += OPEN(500); else continue; }
      const payout = stake * BigInt(x100) / 100n;
      const liability = payout - stake;
      const column = this.liabilityWhere(l => l.market === market.id && l.start === start);
      const global = this.liabilityWhere(() => true);
      const account = this.liabilityWhere(l => l.account === player.account);
      if (cellLiab + liability > this.cellLimit() || column + liability > this.columnLimit() || global + liability > this.globalLimit() || account + liability > this.accountLimit()) { this.rejected++; continue; }
      const p = this.pTouch(bOffset, w);
      const pTrue = strategy === 'sniper1s' ? Math.min(0.98, p * 1.3) : p;
      const lowerH = BigInt(bucket) * market.bandHundredths;
      const leg: DemoLeg = {
        legId: `L${(++this.legSeq).toString().padStart(7, '0')}`, account: player.account, kind: player.kind, market: market.id, start, end: start + 5_000, bucket,
        lower: formatHundredths(lowerH), upper: formatHundredths(lowerH + market.bandHundredths),
        stake, x100, payout, pTrue, placedMs: this.clockMs, phase: this.boostActive() ? 'launch' : 'standard', range: rangeOf(x100), status: 'open', streamed: false,
      };
      this.openLegs.push(leg);
      player.legs.push(leg);
      if (player.legs.length > 200) player.legs.shift();
      player.balance -= stake; player.handle += stake; player.bets += 1;
      this.countHold(player, stake, events);
      this.handle24h += stake;
      this.betsThisMinute += 1;
      if (streamedThisStep < maxStream && (player.kind === 'onchain' || r() < 0.7)) {
        leg.streamed = true; streamedThisStep++;
        events.push({ event: 'bet', data: this.legView(leg) });
      }
    }
  }

  /** SPEC-10: every accepted bet went through the acceptance hold; ~8.5 % more were rejected at resolution. */
  private countHold(player: PlayerSim, stake: bigint, events: DemoEvent[]): void {
    const s = Number(stake);
    this.flowHandle1h += s; this.flowHandleAll += s;
    if (player.flagged) { this.flowFlagged1h += s; this.flowFlaggedAll += s; }
    if (!this.defenses.hold.enabled) return;
    const h = this.hold;
    h.created++; h.accepted++; h.recentCreated++; h.byDetail['ok'] = (h.byDetail['ok'] ?? 0) + 1; player.holds++;
    const u = this.rand2();
    if (u < 0.085) {
      const detail = u < 0.068 ? 'fair-value' : u < 0.081 ? 'timeout' : 'ramp';
      h.created++; h.rejected++; h.recentCreated++; h.recentRejected++; h.byDetail[detail] = (h.byDetail[detail] ?? 0) + 1; player.holds++;
    }
    // The graduated monitor flags latency arbitrageurs on hold evidence.
    if (player.strategy === 'sniper1s' && !player.flagged && this.defenses.toxicity.enabled && this.rand2() < 0.004) {
      const reason = `latency evidence z=${player.latencyZ.toFixed(2)} over ${player.holds} held placements; flow surcharge ${this.defenses.toxicity.surchargeEdge}`;
      player.flagged = true;
      player.flags.push({ ms: this.clockMs, actor: 'toxicity-monitor', action: 'flag', reason });
      const entry = this.journal({ kind: 'system', actor: 'toxicity-monitor', action: 'player-flag', target: player.account, before: { flagged: false, blocked: player.blocked }, after: { flagged: true, blocked: player.blocked }, reason, result: 'ok' });
      events.push({ event: 'admin-action', data: entry }, { event: 'alert', data: { level: 'warning', message: `Toxicity monitor surcharged ${player.account} (latency z=${player.latencyZ.toFixed(2)})`, ms: this.clockMs, code: 'TOXIC_FLOW' } });
    }
  }

  private settle(events: DemoEvent[]): void {
    const r = this.rand;
    for (let i = this.openLegs.length - 1; i >= 0; i--) {
      const leg = this.openLegs[i]!;
      if (leg.end + 1_000 > this.clockMs) continue;
      this.openLegs.splice(i, 1);
      const player = this.byAccount.get(leg.account)!;
      const won = r() < leg.pTrue;
      leg.status = won ? 'won' : 'lost';
      leg.settledMs = this.clockMs;
      const agg = this.agg.get(`${leg.range}|${leg.phase}`)!;
      agg.bets += 1; agg.handle += leg.stake;
      if (won) {
        player.balance += leg.payout; player.returned += leg.payout; player.pnl += leg.payout - leg.stake; player.lastWin = true;
        this.equity -= leg.payout - leg.stake; this.ggr24h -= leg.payout - leg.stake;
        agg.returned += leg.payout;
      } else {
        player.pnl -= leg.stake; player.lastWin = false;
        this.equity += leg.stake; this.ggr24h += leg.stake;
      }
      this.settledLegs.push(leg);
      if (this.settledLegs.length > 5_000) this.settledLegs.shift();
      if (leg.streamed) events.push({ event: 'settlement', data: this.legView(leg) });
    }
  }

  private progressRefits(events: DemoEvent[]): void {
    for (const [jobId, job] of this.refits) {
      if (job.done) continue;
      const progress = Math.min(1, (this.elapsedS - job.startedS) / 6);
      if (progress - job.progress < 0.1 && progress < 1) continue;
      job.progress = progress;
      if (progress >= 1) {
        job.done = true;
        const stamp = new Date(this.clockMs).toISOString().slice(0, 16);
        for (const m of this.markets) { m.previousTableId = m.tableId; m.tableId = `maya-calibrated-v3-${m.id.toLowerCase().replace('/', '-')}@${stamp}Z`; m.tableBuiltMs = this.clockMs; }
        this.lastRefitMs = this.clockMs;
        const done: RefitProgress = { jobId, progress: 1, state: 'done', tableId: this.markets[0]!.tableId, message: 'Both markets refit from the trailing 36 h path; previous tables kept for issued quotes.' };
        events.push({ event: 'refit', data: done });
        events.push({ event: 'admin-action', data: this.journal({ kind: 'system', actor: 'system', action: 'refit complete', target: jobId, before: this.markets.map(m => m.previousTableId), after: this.markets.map(m => m.tableId), reason: 'Refit requested by admin', result: 'ok' }) });
      } else {
        events.push({ event: 'refit', data: { jobId, progress, state: 'running', message: `Labelling synthetic quote instants (${Math.round(progress * 100)}%)` } satisfies RefitProgress });
      }
    }
  }

  private appendMetric(ms: number): void {
    const h = this.history;
    h.t.push(ms); h.equity.push(this.equity); h.ggr.push(this.ggr24h); h.handle.push(this.handle24h);
    h.rtp.push(this.handle24h > 0n ? 1 - Number(this.ggr24h * 1_000_000n / this.handle24h) / 1_000_000 : null);
    h.openLiability.push(this.liabilityWhere(() => true)); h.players.push(this.registered);
    this.betsPerMin = this.betsThisMinute > 0 ? this.betsThisMinute : this.betsPerMin;
    h.betsPerMin.push(this.betsPerMin);
    this.betsThisMinute = 0;
  }

  /** Scripted stream drops: true once per drop window (the server closes open streams). */
  shouldDropStream(previousElapsedS: number): boolean {
    const now = this.elapsedS;
    const crossed = (k: number) => previousElapsedS < k && now >= k;
    for (let k = STREAM_DROP_S; k <= now + 1; k += STREAM_DROP_PERIOD_S) if (crossed(k)) return true;
    return false;
  }

  private journal(e: Omit<AuditEntry, 'id' | 'ms'>): AuditEntry {
    const entry: AuditEntry = { id: `a-${++this.auditSeq}`, ms: this.clockMs, ...e };
    this.audit.push(entry);
    return entry;
  }

  private onchainLiabilities(): bigint {
    let sum = 0n;
    for (const p of this.roster) if (p.kind === 'onchain') sum += p.balance > 0n ? p.balance : 0n;
    for (const l of this.openLegs) if (l.kind === 'onchain') sum += l.payout;
    return sum;
  }

  // ---------- read models ----------

  private legView(l: DemoLeg): BetLeg {
    return {
      legId: l.legId, account: l.account, kind: l.kind, market: l.market, start: l.start, end: l.end, bandIndex: l.bucket, lower: l.lower, upper: l.upper,
      stakeCenti: centi(l.stake), x100: l.x100, payoutCenti: centi(l.payout), status: l.status, placedMs: l.placedMs,
      ...(l.settledMs === undefined ? {} : { settledMs: l.settledMs }), phase: l.phase,
      heldMs: 200 + Math.round(unit(l.legId) * 1_300), ...(this.byAccount.get(l.account)?.strategy ? { strategy: this.byAccount.get(l.account)!.strategy! } : {}),
    };
  }

  private launchView(): LaunchState {
    return { enabled: this.launch.enabled, active: this.boostActive(), edge: this.launch.edge, untilPlayers: this.launch.untilPlayers, standardEdge: this.pricing.standardEdge };
  }

  private pricingView(): PricingConfig { return { ...this.pricing }; }
  private limitsView(): LimitsConfig { return { ...this.limits, maxStakePerBetCenti: centi(this.limits.maxStakePerBetCenti), maxStakePerCellCenti: centi(this.limits.maxStakePerCellCenti) }; }

  private marketView(m: MarketSim): MarketState {
    return { id: m.id, enabled: true, paused: this.marketPaused(m), lastPriceMs: m.lastPriceMs, spot: formatHundredths(m.spot), sigma: m.sigma, tableId: m.tableId };
  }

  overview(): Overview {
    const openLiability = this.liabilityWhere(() => true);
    const globalLimit = this.globalLimit();
    let maxColumn = 0; let maxCell = 0;
    const cols = new Map<string, bigint>(); const cells = new Map<string, bigint>();
    for (const l of this.openLegs) {
      const ck = `${l.market}|${l.start}`; cols.set(ck, (cols.get(ck) ?? 0n) + l.payout - l.stake);
      const k = `${ck}|${l.bucket}`; cells.set(k, (cells.get(k) ?? 0n) + l.payout - l.stake);
    }
    const colLimit = this.columnLimit(); const cellLimit = this.cellLimit();
    for (const v of cols.values()) maxColumn = Math.max(maxColumn, colLimit > 0n ? Number(v * 10_000n / colLimit) / 10_000 : 0);
    for (const v of cells.values()) maxCell = Math.max(maxCell, cellLimit > 0n ? Number(v * 10_000n / cellLimit) / 10_000 : 0);
    const playerBalances = this.roster.reduce((s, p) => s + (p.balance > 0n ? p.balance : 0n), 0n);
    return {
      network: 'base-sepolia', chainId: 84532, operator: this.chainState.operator, vault: this.chainState.vault, token: this.chainState.token,
      feedMode: 'replay', speed: this.sim.speed, clockMs: Math.floor(this.clockMs),
      equityCenti: centi(this.equity), playerBalancesCenti: centi(playerBalances), openLiabilityCenti: centi(openLiability),
      limitUsage: { global: globalLimit > 0n ? Number(openLiability * 10_000n / globalLimit) / 10_000 : 0, maxColumn, maxCell },
      registeredPlayers: this.registered, activePlayers5m: this.active5m,
      launch: this.launchView(),
      breakers: this.breakers.map(b => ({ ...b })),
      markets: this.markets.map(m => this.marketView(m)),
      handle24hCenti: centi(this.handle24h), ggr24hCenti: centi(this.ggr24h),
      rtp24h: this.handle24h > 0n ? 1 - Number(this.ggr24h * 1_000_000n / this.handle24h) / 1_000_000 : Number.NaN,
      betsPerMin: this.betsPerMin,
      pricing: this.pricingView(), limits: this.limitsView(), sim: { ...this.sim },
      ...this.defenseOverview(),
    };
  }

  private holdLatency(): { p50: number; p95: number; max: number; n: number } {
    const cap = this.defenses.hold.maxHoldMs;
    return { p50: Math.min(cap, 740 + Math.round(unit(`p50:${this.hold.created}`) * 60)), p95: Math.min(cap, 1_490 + Math.round(unit(`p95:${this.hold.created}`) * 10)), max: cap + 130, n: Math.min(50_000, this.hold.accepted + this.hold.rejected) };
  }

  /** SPEC-10/11 overview additions, shaped exactly like the house server's. */
  private defenseOverview(): Partial<Overview> {
    const d = this.defenses;
    return {
      ledgerSigner: this.chainState.signer,
      holdPending: d.hold.enabled ? 14 + Math.floor(unit(`pending:${Math.floor(this.elapsedS)}`) * 18) : 0,
      holdRejectRate: d.hold.enabled && this.hold.recentCreated > 0 ? this.hold.recentRejected / this.hold.recentCreated : null,
      holdLatencyP95Ms: d.hold.enabled ? this.holdLatency().p95 : null,
      toxicFlowShare: this.flowHandle1h > 0 ? this.flowFlagged1h / this.flowHandle1h : null,
      defenses: { hold: d.hold.enabled, quoteValidity: d.quoteValidity.enabled, minLeadS: d.minLeadS, ramp: d.ramp.enabled, toxicity: d.toxicity.enabled ? 'graduated' : 'monitor', controller: d.controller.enabled, reference: false },
      controller: { enabled: d.controller.enabled, ranges: controllerView(this.controllerWithTargets(), d).map(r => ({ key: r.key, adjust: r.adjust, effective: r.effective, ...(r.override !== undefined ? { override: r.override } : {}), realized: r.realized, target: r.target, bets: r.bets })) },
      chainAlerts: this.vaultAlerts().map(a => ({ code: a.code, level: a.level, message: a.message })),
    };
  }

  /** Targets follow the policy edge (launch boost vs standard). */
  private controllerWithTargets() {
    const target = 1 - this.currentEdge();
    return this.controller.map(c => ({ ...c, target }));
  }

  /** GET /admin-api/defenses. */
  defensesView(): DefensesView {
    const d = this.defenses;
    const flagged = this.roster.filter(p => p.flagged); const blocked = this.roster.filter(p => p.blocked);
    const byMonitor = (list: PlayerSim[], action: string) => list.filter(p => [...p.flags].reverse().find(f => f.action === action)?.actor === 'toxicity-monitor').length;
    const h = this.hold;
    return {
      config: JSON.parse(JSON.stringify(d)) as DefenseConfig,
      hold: { enabled: d.hold.enabled, pending: this.defenseOverview().holdPending ?? 0, created: h.created, accepted: h.accepted, rejected: h.rejected, byDetail: { ...h.byDetail },
        rejectRate1h: h.recentCreated > 0 ? h.recentRejected / h.recentCreated : null, rejectRateAll: h.accepted + h.rejected > 0 ? h.rejected / (h.accepted + h.rejected) : null, latencyMs: this.holdLatency() },
      ramp: { accountLimitCenti: centi(this.accountLimit()) },
      toxicity: {
        mode: d.toxicity.enabled ? 'graduated' : 'monitor', flowEdge: d.toxicity.enabled && flagged.length ? d.toxicity.surchargeEdge : 0, flagged: flagged.length, flaggedByMonitor: byMonitor(flagged, 'flag'),
        blocked: blocked.length, blockedByMonitor: byMonitor(blocked, 'block'), toxicFlowShare1h: this.flowHandle1h > 0 ? this.flowFlagged1h / this.flowHandle1h : null, toxicFlowShareAll: this.flowHandleAll > 0 ? this.flowFlaggedAll / this.flowHandleAll : null,
      },
      controller: { enabled: d.controller.enabled, nextEvalMs: d.controller.enabled ? DEMO_START_MS + this.nextNudgeS * 1000 : null, ranges: controllerView(this.controllerWithTargets(), d) },
      reference: { enabled: d.reference.enabled, moveSigma: d.reference.moveSigma, invalidations: 0, lastObservationMs: null },
      // Replay mode: the server runs without a sub-second reference feed (MAYA_REFERENCE_FEED=hermes needs MAYA_FEED=live).
      referenceFeed: null,
      clockMs: Math.floor(this.clockMs),
    };
  }

  /** GET /v1/account/:address/proof (public player route): the leaf under the attestation the vault holds. */
  proof(address: string): { status: number; body: Record<string, unknown> } {
    const a = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(a)) return { status: 400, body: { error: { code: 'INVALID_ACCOUNT', message: 'address must be a 0x address' } } };
    const c = this.chainState;
    const player = this.roster.find(p => p.kind === 'onchain' && p.account === a);
    const balanceWei = player && player.balance > 0n ? player.balance * WEI : 0n;
    const escape = demoEscape(this.vaultHealth(), 0n, 0n);
    const attestation = { seq: String(c.attestSeq), root: c.attestRoot.toLowerCase(), asOf: String(Math.floor(c.attestAsOf / 1000)), asOfMs: c.attestAsOf, liabilitiesWei: (c.attestLiabilities * WEI).toString(), source: 'vault', txHash: c.attestTx };
    const head = { account: a, chainId: 84532, vault: c.vault };
    if (balanceWei === 0n) return { status: 200, body: { ...head, attestation, included: false, balanceWei: '0', proof: [], currentOwedWei: '0', claim: { function: 'claimEscape(uint256,bytes32[])', attestedBalance: '0', proof: [] }, escape, note: 'No leaf for this account in the attested tree: claim with attestedBalance 0 and an empty proof.' } };
    const proof = [0, 1, 2, 3].map(i => fakeHash(`${a}:${c.attestSeq}:${i}`));
    return { status: 200, body: { ...head, attestation, included: true, balanceWei: balanceWei.toString(), proof, currentOwedWei: balanceWei.toString(), claim: { function: 'claimEscape(uint256,bytes32[])', attestedBalance: balanceWei.toString(), proof }, escape } };
  }

  metrics(from: number, to: number, step: number): MetricsSeries {
    const h = this.history;
    const stepMs = Math.max(60_000, step);
    const out: MetricsSeries & { t: number[]; equity: string[]; ggr: string[]; handle: string[]; rtp: (number | null)[]; openLiability: string[]; players: number[]; betsPerMin: number[] } =
      { t: [], equity: [], ggr: [], handle: [], rtp: [], openLiability: [], players: [], betsPerMin: [] };
    let nextT = from;
    for (let i = 0; i < h.t.length; i++) {
      const t = h.t[i]!;
      if (t < from || t > to || t < nextT) continue;
      nextT = t + stepMs;
      out.t.push(t); out.equity.push(centi(h.equity[i]!)); out.ggr.push(centi(h.ggr[i]!)); out.handle.push(centi(h.handle[i]!));
      out.rtp.push(h.rtp[i]!); out.openLiability.push(centi(h.openLiability[i]!)); out.players.push(h.players[i]!); out.betsPerMin.push(h.betsPerMin[i]!);
    }
    // Live head so the right edge matches the tiles.
    const now = Math.floor(this.clockMs);
    if (now <= to + 60_000 && (out.t.length === 0 || now > out.t[out.t.length - 1]!)) {
      out.t.push(now); out.equity.push(centi(this.equity)); out.ggr.push(centi(this.ggr24h)); out.handle.push(centi(this.handle24h));
      out.rtp.push(this.handle24h > 0n ? 1 - Number(this.ggr24h * 1_000_000n / this.handle24h) / 1_000_000 : null);
      out.openLiability.push(centi(this.liabilityWhere(() => true))); out.players.push(this.registered); out.betsPerMin.push(this.betsPerMin);
    }
    return out;
  }

  rtp(): RtpReport {
    const row = (key: string, a: Agg, phase?: 'launch' | 'standard'): RtpRow => ({
      key, ...(phase ? { phase } : {}), bets: a.bets, handleCenti: centi(a.handle), returnedCenti: centi(a.returned), expected: a.expected,
      realized: a.handle > 0n ? Number(a.returned * 1_000_000n / a.handle) / 1_000_000 : null,
    });
    const byRange: RtpRow[] = [];
    for (const range of RANGES) for (const phase of ['launch', 'standard'] as const) byRange.push(row(range, this.agg.get(`${range}|${phase}`)!, phase));
    const phaseTotal = (phase: 'launch' | 'standard'): Agg => {
      const t: Agg = { bets: 0, handle: 0n, returned: 0n, expected: phase === 'launch' ? 0.97 : 0.92 };
      for (const range of RANGES) { const a = this.agg.get(`${range}|${phase}`)!; t.bets += a.bets; t.handle += a.handle; t.returned += a.returned; }
      return t;
    };
    const launch = phaseTotal('launch'); const standard = phaseTotal('standard');
    const all: Agg = { bets: launch.bets + standard.bets, handle: launch.handle + standard.handle, returned: launch.returned + standard.returned, expected: 0 };
    all.expected = all.handle > 0n ? (0.97 * Number(launch.handle) + 0.92 * Number(standard.handle)) / Number(all.handle) : 0.97;
    const split = (share: bigint, name: string, tweak: bigint): RtpRow => {
      const a: Agg = { bets: Math.round(all.bets * Number(share) / 100), handle: all.handle * share / 100n, returned: all.returned * share / 100n + tweak, expected: all.expected };
      return row(name, a);
    };
    const r = prng(99);
    const calibration = Array.from({ length: 10 }, (_, i) => { const predicted = 0.05 + i * 0.1; return { predicted, observed: Math.min(0.99, Math.max(0.01, predicted + (r() - 0.5) * 0.02 + (i === 1 ? 0.012 : 0))), n: Math.round(40_000 * Math.exp(-i * 0.25)) }; });
    return {
      byRange, byPhase: [row('launch', launch), row('standard', standard)], byMarket: [split(60n, 'btc-usd', OPEN(-1_240)), split(40n, 'eth-usd', OPEN(980))],
      calibration,
      tables: this.markets.map(m => ({ market: m.id, tableId: m.tableId, builtMs: m.tableBuiltMs, previousTableId: m.previousTableId })),
      lastRefitMs: this.lastRefitMs,
    };
  }

  exposure(marketId: string): Exposure | null {
    const m = this.markets.find(x => x.id === marketId);
    if (!m) return null;
    const windows = this.windowStarts();
    const bucket = this.bucketOf(m);
    const bands = [-3, -2, -1, 0, 1, 2, 3].map(b => { const lo = BigInt(bucket + b) * m.bandHundredths; return { index: bucket + b, lower: formatHundredths(lo), upper: formatHundredths(lo + m.bandHundredths) }; });
    const limit = this.cellLimit();
    const cells = [];
    for (const [w, start] of windows.entries()) {
      for (const band of bands) {
        const legs = this.openLegs.filter(l => l.market === m.id && l.start === start && l.bucket === band.index);
        const liability = legs.reduce((s, l) => s + l.payout - l.stake, 0n);
        const x100 = this.marketPaused(m) ? null : this.quoteX100(band.index - bucket, w, liability);
        cells.push({ start, bandIndex: band.index, x100, liabilityCenti: centi(liability), limitCenti: centi(limit), legs: legs.length });
      }
    }
    return { market: m.id, windows, bands, cells, columnLimitCenti: centi(this.columnLimit()) };
  }

  private playerRow(p: PlayerSim): PlayerRow {
    return {
      account: p.account, kind: p.kind, ...(p.strategy ? { strategy: p.strategy } : {}), balanceCenti: centi(p.balance), handleCenti: centi(p.handle), pnlCenti: centi(p.pnl),
      bets: p.bets, rtp: p.handle > 0n ? Number(p.returned * 1_000_000n / p.handle) / 1_000_000 : null, flagged: p.flagged, blocked: p.blocked, firstSeenMs: p.firstSeenMs,
      holds: p.holds, latencyZ: Math.round(p.latencyZ * 1000) / 1000, excessReturnZ: Math.round(p.excessZ * 1000) / 1000,
    };
  }

  players(query: { sort?: string | null; limit?: number; cursor?: string | null; q?: string | null; kind?: string | null }): PlayerPage {
    const q = (query.q ?? '').trim().toLowerCase();
    let rows = this.roster.filter(p => (!query.kind || p.kind === query.kind) && (!q || p.account.toLowerCase().includes(q) || (p.strategy ?? '').includes(q) || (q === 'onchain' && p.kind === 'onchain')));
    const sort = query.sort ?? '-handle';
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    const value = (p: PlayerSim): number | bigint => key === 'balance' ? p.balance : key === 'pnl' ? p.pnl : key === 'bets' ? p.bets : key === 'rtp' ? (p.handle > 0n ? Number(p.returned * 1_000_000n / p.handle) : -1) : key === 'firstSeen' ? p.firstSeenMs : p.handle;
    rows = [...rows].sort((a, b) => { const x = value(a); const y = value(b); const c = x < y ? -1 : x > y ? 1 : a.account.localeCompare(b.account); return desc ? -c : c; });
    const offset = query.cursor ? Number(query.cursor) || 0 : 0;
    const limit = Math.max(1, Math.min(500, query.limit ?? 100));
    const page = rows.slice(offset, offset + limit);
    return { rows: page.map(p => this.playerRow(p)), nextCursor: offset + limit < rows.length ? String(offset + limit) : null, total: rows.length };
  }

  player(account: string): PlayerDetail | null {
    const p = this.byAccount.get(account) ?? this.byAccount.get(account.toLowerCase());
    if (!p) return null;
    return { player: this.playerRow(p), bets: p.legs.map(l => this.legView(l)), deposits: [...p.deposits], withdrawals: [...p.withdrawals], flags: [...p.flags] };
  }

  bets(query: { limit?: number; account?: string | null; market?: string | null; status?: string | null; start?: string | null; bandIndex?: string | null }): { rows: BetLeg[] } {
    // start + bandIndex: the house-server cell filter (exposure drill-down).
    const start = query.start ? Number(query.start) : null; const band = query.bandIndex ? Number(query.bandIndex) : null;
    const all = [...this.openLegs, ...this.settledLegs.slice(-2_000)].filter(l => (!query.account || l.account === query.account) && (!query.market || l.market === query.market) && (!query.status || l.status === query.status)
      && (start === null || l.start === start) && (band === null || l.bucket === band));
    all.sort((a, b) => b.placedMs - a.placedMs);
    return { rows: all.slice(0, Math.max(1, Math.min(1_000, query.limit ?? 100))).map(l => this.legView(l)) };
  }

  /** Vault obligations, the SPEC §5 surplus, and what withdrawHouse accepts now (10 % buffer, daily house cap). */
  private houseLimits(): { assets: bigint; surplus: bigint; withdrawable: bigint } {
    const c = this.chainState;
    const assets = c.deposits + c.houseFunded - c.withdrawals - c.houseWithdrawn;
    const obligations = c.attestLiabilities + c.depositsSinceAttest - c.claimedSinceAttest;
    const surplus = assets - obligations > 0n ? assets - obligations : 0n;
    const buffer = (obligations * 1_000n + 9_999n) / 10_000n;
    const byBuffer = surplus - buffer > 0n ? surplus - buffer : 0n;
    const byCap = OPEN(10_000_000) - this.vault2.houseWithdrawnToday;
    return { assets, surplus, withdrawable: byBuffer < byCap ? byBuffer : byCap };
  }

  chain(): ChainState {
    const c = this.chainState;
    const { assets, surplus, withdrawable } = this.houseLimits();
    const pending = this.roster.filter(p => p.kind === 'onchain').slice(0, 2);
    const health = this.vaultHealth();
    const p = this.vault2.pendingSigner;
    const dust = 7_300_000_000_000n;
    return {
      network: 'base-sepolia', chainId: 84532,
      vault: {
        address: c.vault, token: c.token, paused: c.paused, assetsCenti: centi(assets), houseFundedCenti: centi(c.houseFunded), totalPlayerDepositsCenti: centi(c.deposits),
        totalPlayerWithdrawalsCenti: centi(c.withdrawals), houseWithdrawnCenti: centi(c.houseWithdrawn), surplusCenti: centi(surplus),
        maxVoucherAmountCenti: centi(OPEN(25_000)), dailyOutflowCapCenti: centi(OPEN(250_000)), maxAttestationAgeSec: 600, ledgerSigner: c.signer,
        serverSigner: this.vault2.serverSigner, signerMismatch: c.signer.toLowerCase() !== this.vault2.serverSigner.toLowerCase(),
        pendingSigner: p ? { address: p.address, etaMs: p.etaMs, due: this.clockMs >= p.etaMs } : null,
        signerChangeDelaySec: 172_800, pendingSignerChangeDelay: null, houseBufferBps: 1_000, houseDailyCapCenti: centi(OPEN(10_000_000)), pendingHouseLimits: null,
        houseWithdrawableCenti: centi(withdrawable), excessWei: this.vault2.excessWei.toString(), excessCenti: centi(this.vault2.excessWei / WEI),
        escape: demoEscape(health, 0n, 0n),
      },
      lastAttestation: {
        seq: c.attestSeq, asOfMs: c.attestAsOf, liabilitiesCenti: centi(c.attestLiabilities), ledgerRoot: c.attestRoot, txHash: c.attestTx, blockNumber: c.attestBlock,
        tree: { leaves: 11, leafTotalWei: (c.attestLiabilities * WEI).toString(), treeFile: `attest-${c.attestSeq}-${c.attestRoot}.json`, treeSha256: fakeHash(`tree:${c.attestSeq}`).slice(2) },
      },
      operator: { address: c.operator, ethWei: c.operatorEthWei.toString(), tokenCenti: centi(c.operatorToken) },
      pendingVouchers: { count: pending.length, totalCenti: centi(OPEN(150) + OPEN(75.5)), items: [
        { account: pending[0]!.account, amountCenti: centi(OPEN(150)), nonce: nonceOf('voucher-17'), expiryMs: Math.floor(this.clockMs) + 1_140_000, voucherId: 'V000017', status: 'pending', submittedTxHash: fakeHash('redeem-17') },
        { account: pending[1]!.account, amountCenti: centi(OPEN(75.5)), nonce: nonceOf('voucher-18'), expiryMs: Math.floor(this.clockMs) + 2_460_000, voucherId: 'V000018', status: 'pending' },
      ] },
      indexer: { lagBlocks: 1 + (Math.floor(this.elapsedS / 7) % 2), lastBlock: c.head + Math.floor(this.elapsedS / 2) - 1, headBlock: c.head + Math.floor(this.elapsedS / 2), confirmations: 2 },
      alerts: demoChainAlerts(health),
      withdrawals: { indexed: this.vault2.indexedWithdrawals, anomalies: [...this.vault2.anomalies] },
      reconciliation: { match: true, vaultAssetsWei: (assets * WEI + dust).toString(), ledgerAssetsWei: (assets * WEI + dust).toString(), deltaWei: '0', dustWei: dust.toString() },
    };
  }

  auditLog(limit: number): AuditEntry[] {
    return [...this.audit].sort((a, b) => b.ms - a.ms).slice(0, Math.max(1, Math.min(2_000, limit)));
  }

  // ---------- writes ----------

  write(method: string, path: string, body: Record<string, unknown>): { outcome: WriteOutcome; events: DemoEvent[] } {
    const events: DemoEvent[] = [];
    const fail = (status: number, code: string, message: string) => ({ outcome: { ok: false as const, status, code, message }, events });
    const reason = typeof body['reason'] === 'string' ? body['reason'].trim() : '';
    if (!reason) return fail(400, 'REASON_REQUIRED', 'Every admin action requires a reason.');
    const confirm = typeof body['confirm'] === 'string' ? body['confirm'] : undefined;
    const needConfirm = (name: string) => (confirm === name ? null : fail(400, 'CONFIRM_REQUIRED', `This action is dangerous: send confirm: "${name}".`));
    const done = (action: string, target: string, before: unknown, after: unknown, extra: Record<string, unknown> = {}) => {
      const entry = this.journal({ kind: 'admin', actor: 'admin (demo)', action, target, before, after, reason, result: 'ok' });
      events.push({ event: 'admin-action', data: entry }, { event: 'overview', data: this.overview() });
      return { outcome: { ok: true as const, ack: { ok: true, action, auditId: entry.id, before, after, ...extra } }, events };
    };
    const num = (key: string) => (typeof body[key] === 'number' && Number.isFinite(body[key]) ? (body[key] as number) : undefined);
    const tx = () => `0x${(++this.txSeq).toString(16).padStart(8, '0')}${hex(this.rand, 56)}`;
    let m: RegExpExecArray | null;

    if (method === 'POST' && (m = /^\/markets\/([^/]+)\/(pause|resume)$/.exec(path))) {
      const market = this.markets.find(x => x.id === decodeURIComponent(m![1]!));
      if (!market) return fail(404, 'UNKNOWN_MARKET', `No market ${decodeURIComponent(m[1]!)}.`);
      const before = { paused: market.manualPaused };
      market.manualPaused = m[2] === 'pause';
      return done(`market ${m[2]}`, market.id, before, { paused: market.manualPaused });
    }
    if (method === 'POST' && path === '/pause-all') {
      const c = needConfirm('pause-all'); if (c) return c;
      const before = { manualGlobal: this.manualGlobal };
      this.manualGlobal = true;
      this.replaceBreaker({ id: 'manual', state: 'paused', since: this.clockMs, reason: reason.slice(0, 80) });
      events.push({ event: 'breaker', data: this.breakers.find(b => b.id === 'manual' && !b.market) });
      return done('pause-all', 'all markets', before, { manualGlobal: true });
    }
    if (method === 'POST' && path === '/resume-all') {
      const before = { manualGlobal: this.manualGlobal, marketPauses: this.markets.filter(x => x.manualPaused).map(x => x.id) };
      this.manualGlobal = false;
      for (const x of this.markets) x.manualPaused = false;
      this.replaceBreaker({ id: 'manual', state: 'ok', since: this.clockMs, reason: 'Resumed by admin' });
      events.push({ event: 'breaker', data: this.breakers.find(b => b.id === 'manual' && !b.market) });
      return done('resume-all', 'all markets', before, { manualGlobal: false, marketPauses: [] });
    }
    if (method === 'PUT' && path === '/pricing') {
      const edge = num('standardEdge'); const cap = num('capX100'); const impact = num('impactK'); const z = num('z');
      if (edge !== undefined && (edge < 0.01 || edge > 0.25)) return fail(422, 'VALIDATION', 'standardEdge must be between 0.01 and 0.25.');
      if (cap !== undefined && (!Number.isInteger(cap) || cap < 200 || cap > 10_000)) return fail(422, 'VALIDATION', 'capX100 must be an integer between 200 and 10000.');
      if (body['aboveCap'] !== undefined && body['aboveCap'] !== 'hide' && body['aboveCap'] !== 'cap') return fail(422, 'VALIDATION', 'aboveCap must be "hide" or "cap".');
      if (edge !== undefined && Math.abs(edge - this.pricing.standardEdge) > 0.02 + 1e-12) { const c = needConfirm('edge-change'); if (c) return c; }
      const before = this.pricingView();
      if (edge !== undefined) this.pricing.standardEdge = edge;
      if (cap !== undefined) this.pricing.capX100 = cap;
      if (body['aboveCap'] === 'hide' || body['aboveCap'] === 'cap') this.pricing.aboveCap = body['aboveCap'];
      if (impact !== undefined) this.pricing.impactK = impact;
      if (z !== undefined) this.pricing.z = z;
      return done('pricing', 'pricing', before, this.pricingView());
    }
    if (method === 'PUT' && path === '/launch') {
      const edge = num('edge'); const until = num('untilPlayers');
      if (edge !== undefined && (edge < 0.01 || edge > 0.25)) return fail(422, 'VALIDATION', 'edge must be between 0.01 and 0.25.');
      if (until !== undefined && (!Number.isInteger(until) || until < 0)) return fail(422, 'VALIDATION', 'untilPlayers must be a non-negative integer.');
      const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : this.launch.enabled;
      const beforeEdge = this.currentEdge();
      const afterEdge = enabled && this.registered < (until ?? this.launch.untilPlayers) ? (edge ?? this.launch.edge) : this.pricing.standardEdge;
      if ((edge !== undefined && Math.abs(edge - this.launch.edge) > 0.02 + 1e-12) || Math.abs(afterEdge - beforeEdge) > 0.02 + 1e-12) { const c = needConfirm('edge-change'); if (c) return c; }
      const before = this.launchView();
      this.launch.enabled = enabled;
      if (edge !== undefined) this.launch.edge = edge;
      if (until !== undefined) this.launch.untilPlayers = until;
      if (this.boostActive()) this.boostEndedAnnounced = false;
      return done('launch', 'launch', before, this.launchView());
    }
    if (method === 'PUT' && path === '/limits') {
      const before = this.limitsView();
      const next = { ...this.limits };
      for (const key of ['cellFraction', 'columnFraction', 'globalFraction', 'accountFraction'] as const) {
        const v = num(key);
        if (v !== undefined) { if (v <= 0 || v > 0.5) return fail(422, 'VALIDATION', `${key} must be in (0, 0.5].`); next[key] = v; }
      }
      for (const key of ['maxStakePerBetCenti', 'maxStakePerCellCenti'] as const) {
        const v = body[key];
        if (v !== undefined) { if (typeof v !== 'string' || !/^\d+$/.test(v) || v === '0') return fail(422, 'VALIDATION', `${key} must be a positive Centi string.`); next[key] = BigInt(v); }
      }
      if (next.cellFraction > next.columnFraction || next.columnFraction > next.globalFraction || next.accountFraction > next.globalFraction) return fail(422, 'LIMIT_HIERARCHY', 'Limits must nest: cell ≤ column ≤ global and account ≤ global.');
      Object.assign(this.limits, next);
      return done('limits', 'limits', before, this.limitsView());
    }
    if (method === 'POST' && path === '/refit') {
      if ([...this.refits.values()].some(j => !j.done)) return fail(409, 'REFIT_RUNNING', 'A refit is already running.');
      const jobId = `refit-${String(++this.jobSeq).padStart(4, '0')}`;
      this.refits.set(jobId, { progress: 0, startedS: this.elapsedS, done: false });
      events.push({ event: 'refit', data: { jobId, progress: 0, state: 'queued', message: 'Queued' } satisfies RefitProgress });
      return done('refit', 'tables', this.markets.map(x => x.tableId), 'running', { jobId });
    }
    if (method === 'POST' && (m = /^\/players\/([^/]+)\/(flag|unflag|block|unblock)$/.exec(path))) {
      const account = decodeURIComponent(m[1]!);
      const p = this.byAccount.get(account);
      if (!p) return fail(404, 'UNKNOWN_ACCOUNT', `No account ${account}.`);
      const action = m[2]!;
      const before = { flagged: p.flagged, blocked: p.blocked };
      if (action === 'flag') p.flagged = true; else if (action === 'unflag') p.flagged = false; else if (action === 'block') p.blocked = true; else p.blocked = false;
      p.flags.push({ ms: this.clockMs, actor: 'admin (demo)', action, reason });
      return done(`player ${action}`, account, before, { flagged: p.flagged, blocked: p.blocked });
    }
    if (method === 'POST' && path === '/treasury/fund') {
      const amount = typeof body['amountCenti'] === 'string' && /^\d+$/.test(body['amountCenti']) ? BigInt(body['amountCenti']) : null;
      if (amount === null || amount === 0n) return fail(422, 'VALIDATION', 'amountCenti must be a positive Centi string.');
      if (amount > this.chainState.operatorToken) return fail(409, 'INSUFFICIENT_BALANCE', 'The operator does not hold enough tOPEN.');
      const before = { houseFundedCenti: centi(this.chainState.houseFunded) };
      this.chainState.operatorToken -= amount; this.chainState.houseFunded += amount; this.equity += amount;
      return done('treasury fund', 'vault', before, { houseFundedCenti: centi(this.chainState.houseFunded) }, { txHash: tx() });
    }
    if (method === 'POST' && path === '/treasury/withdraw-surplus') {
      const c = needConfirm('withdraw-surplus'); if (c) return c;
      const amount = typeof body['amountCenti'] === 'string' && /^\d+$/.test(body['amountCenti']) ? BigInt(body['amountCenti']) : null;
      if (amount === null || amount === 0n) return fail(422, 'VALIDATION', 'amountCenti must be a positive Centi string.');
      // Like the house server, a stale attestation is refreshed first (its own transaction) instead of refusing.
      const attest = this.clockMs - this.chainState.attestAsOf > 600_000 ? this.attestNow('admin (demo)', `pre-withdrawal attestation: ${reason}`) : null;
      const limits = this.houseLimits();
      if (amount > limits.surplus) return fail(409, 'INSUFFICIENT_SURPLUS', `Amount exceeds houseSurplus() (${centi(limits.surplus)} Centi).`);
      if (amount > limits.withdrawable) return fail(409, 'EXCEEDS_HOUSE_WITHDRAWABLE', `The vault lets the house withdraw at most ${centi(limits.withdrawable)} Centi now (a 1000 bps buffer on obligations stays, and the daily house cap applies)`);
      const before = { surplusCenti: centi(limits.surplus) };
      this.chainState.houseWithdrawn += amount; this.chainState.operatorToken += amount; this.equity -= amount; this.vault2.houseWithdrawnToday += amount;
      return done('withdraw-surplus', 'vault', before, { surplusCenti: this.chain().vault.surplusCenti }, { txHash: tx(), ...(attest ? { attestTxHash: attest.txHash } : {}) });
    }
    if (method === 'POST' && path === '/treasury/attest') {
      const before = { seq: this.chainState.attestSeq };
      const a = this.attestNow('admin (demo)', reason, false); // done() journals this write
      return done('attest', 'vault', before, { seq: a.seq }, { txHash: a.txHash });
    }
    if (method === 'PUT' && path === '/defenses') {
      const learned = Object.fromEntries(this.controller.map(s => [s.key, s.adjust]));
      const r = applyDefensePatch(this.defenses, body, learned, confirm);
      if (!r.ok) return fail(r.status, r.code, r.message);
      const before = this.defenses;
      this.defenses = r.config;
      return done('defenses', 'defenses', before, r.config, { disabled: r.disabled });
    }
    const address = (key: string) => (typeof body[key] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body[key]) ? (body[key] as string).toLowerCase() : null);
    const signerView = () => ({ ledgerSigner: this.chainState.signer, serverSigner: this.vault2.serverSigner, pendingSigner: this.vault2.pendingSigner ? { address: this.vault2.pendingSigner.address, etaMs: this.vault2.pendingSigner.etaMs } : null });
    if (method === 'POST' && path === '/vault/signer/propose') {
      const next = address('address');
      if (!next) return fail(400, 'VALIDATION_ERROR', 'address must be a 0x address');
      const c = needConfirm('signer-propose'); if (c) return c;
      if (/^0x0{40}$/.test(next)) return fail(400, 'VALIDATION_ERROR', 'The signer cannot be the zero address');
      if (next === this.chainState.operator.toLowerCase()) return fail(400, 'SIGNER_IS_OWNER', 'The ledger signer must differ from the vault owner');
      if (next === this.chainState.signer.toLowerCase()) return fail(409, 'SIGNER_UNCHANGED', `${next} is already the ledger signer`);
      const before = signerView();
      this.vault2.pendingSigner = { address: next, etaMs: Math.floor(this.clockMs) + 172_800_000 };
      return done('vault-signer-propose', 'vault', before, signerView(), { txHash: tx() });
    }
    if (method === 'POST' && path === '/vault/signer/accept') {
      const c = needConfirm('signer-accept'); if (c) return c;
      const pending = this.vault2.pendingSigner;
      if (!pending) return fail(409, 'NO_PENDING_SIGNER', 'No ledger-signer rotation is pending');
      if (this.clockMs < pending.etaMs) return fail(409, 'TIMELOCK_NOT_ELAPSED', `TimelockNotElapsed(${Math.floor(pending.etaMs / 1000)}, ${Math.floor(this.clockMs / 1000)})`);
      const before = signerView();
      this.chainState.signer = pending.address; this.vault2.pendingSigner = null;
      const lost = this.chainState.signer !== this.vault2.serverSigner.toLowerCase();
      return done('vault-signer-accept', 'vault', before, signerView(), { txHash: tx(), invalidatedVouchers: 2, ...(lost ? { warning: 'This process no longer holds the ledger-signer key: vouchers and attestations fail with SIGNER_MISMATCH until it restarts with the new key. Outstanding vouchers are invalid and return to balances once they expire.' } : {}) });
    }
    if (method === 'POST' && path === '/vault/signer/cancel') {
      if (!this.vault2.pendingSigner) return fail(409, 'NO_PENDING_SIGNER', 'No ledger-signer rotation is pending');
      const before = signerView();
      this.vault2.pendingSigner = null;
      return done('vault-signer-cancel', 'vault', before, signerView(), { txHash: tx() });
    }
    if (method === 'POST' && path === '/vault/sweep-excess') {
      const to = address('to');
      if (!to) return fail(400, 'VALIDATION_ERROR', 'to must be a 0x address');
      const c = needConfirm('sweep-excess'); if (c) return c;
      if (/^0x0{40}$/.test(to) || to === this.chainState.vault.toLowerCase()) return fail(400, 'VALIDATION_ERROR', 'to cannot be the zero address or the vault');
      if (this.vault2.excessWei === 0n) return fail(409, 'NOTHING_TO_SWEEP', 'The vault holds no tokens above its accounted assets');
      const amountWei = this.vault2.excessWei;
      const before = { excessWei: amountWei.toString() };
      this.vault2.excessWei = 0n;
      return done('vault-sweep-excess', 'vault', before, { excessWei: '0', sweptWei: amountWei.toString(), to }, { txHash: tx(), amountWei: amountWei.toString() });
    }
    if (method === 'POST' && (path === '/vault/pause' || path === '/vault/unpause')) {
      if (path === '/vault/pause') { const c = needConfirm('vault-pause'); if (c) return c; }
      const before = { paused: this.chainState.paused };
      this.chainState.paused = path === '/vault/pause';
      return done(path === '/vault/pause' ? 'vault pause' : 'vault unpause', 'vault', before, { paused: this.chainState.paused }, { txHash: tx() });
    }
    if (method === 'POST' && path === '/sim') {
      const speed = num('speed'); const arrivals = num('arrivalsPerMin');
      // Demo server-side bound the console does not know about, so an inline server error can be seen.
      if (speed !== undefined && (speed < 0.1 || speed > 50)) return fail(422, 'VALIDATION', 'speed must be between 0.1 and 50 on the demo server.');
      if (arrivals !== undefined && (arrivals < 0 || arrivals > 5_000)) return fail(422, 'VALIDATION', 'arrivalsPerMin must be between 0 and 5000.');
      const before = { ...this.sim };
      if (typeof body['running'] === 'boolean') this.sim.running = body['running'];
      if (speed !== undefined) this.sim.speed = speed;
      if (arrivals !== undefined) this.sim.arrivalsPerMin = arrivals;
      return done('sim', 'simulation', before, { ...this.sim });
    }
    return fail(404, 'NOT_FOUND', `No admin route ${method} ${path}.`);
  }
}
