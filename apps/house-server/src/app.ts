import { randomUUID } from 'node:crypto';
import type { MarketId } from '@maya/contracts';
import { CENTI_WEI, fromWei, toWei } from '@maya/house';
import { AttestationStore, type StoredTree } from './attestation-store.js';
import { chainAlerts, type ChainAlert } from './chain-alerts.js';
import type { ChainPort, ChainTx, VaultOperatorExtras, VaultState } from './chain-port.js';
import { verifyBalanceProof } from './chain/merkle.js';
import { HouseEngine, type EngineConfig } from './engine/engine.js';
import type { AdminMeta, AdminResult, EngineEvent, PendingTreasury, VoucherRecord } from './engine/types.js';
import type { ReferenceFeed } from './feed/reference.js';
import type { Feed, FeedSample } from './feed/types.js';
import type { JournalSink } from './ledger/journal.js';
import type { RefitRunner } from './refit/runner.js';
import { pathPoints } from './refit/runner.js';
import type { TableRegistry } from './refit/tables.js';
import { CrowdSim, type CrowdOptions } from './sim/crowd.js';
import { OnchainPlayers, type ChainReceipt } from './sim/onchain-players.js';
import type { Strategy } from './sim/strategies.js';
import { errorMessage, finite, isAddress, isPositiveCenti, isRequestId } from './util.js';

export interface RefitSettings { readonly trainHours: number; readonly refitHours: number; readonly minRows: number; readonly onStart: boolean; readonly minWarmHours: number }

export interface AppOptions {
  readonly engineConfig: EngineConfig;
  readonly chain: ChainPort;
  readonly feed: Feed;
  readonly journal: JournalSink;
  readonly records?: readonly EngineEvent[];
  readonly tables: TableRegistry;
  readonly refitRunner: RefitRunner;
  readonly runId: string;
  readonly bootId: string;
  readonly log?: (line: string) => void;
  readonly refit: RefitSettings;
  /** 0 disables periodic attestation. */
  readonly attestEveryMs: number;
  /** Offline chains share the feed clock; live chains use the wall clock. */
  readonly chainClock: 'feed' | 'wall';
  readonly sim?: { readonly players: number; readonly arrivalsPerMin: number; readonly seed: string; readonly mix?: Partial<Record<Strategy, number>>; readonly peek?: CrowdOptions['peek'] };
  readonly onchain?: { readonly depositWei: bigint; readonly betsPerMin: number; readonly topUpBelowCenti: bigint; readonly seed: string };
  readonly warmup?: readonly FeedSample[];
  /** Virtual step for replay driving (default 250 ms). */
  readonly stepMs?: number;
  /** SPEC-10 sub-second reference price (live mode only) for early quote invalidation. */
  readonly reference?: ReferenceFeed;
  readonly bootFeed?: import('./engine/types.js').BootFeed;
  /** Where attested balance trees are persisted (one JSON file per attestation); in memory only when omitted. */
  readonly attestationDir?: string;
  /** How often (chain-clock ms) unredeemed vouchers past expiry are checked against the vault (default 60 s; 0 disables). */
  readonly voucherSweepEveryMs?: number;
  /** Seconds past a voucher's expiry before its unused nonce lets the ledger return the amount (default 600). */
  readonly voucherExpiryMarginS?: number;
  /** How often (chain-clock ms) the vault state is checked for operator alerts (default 60 s; 0 disables). */
  readonly chainHealthEveryMs?: number;
  /**
   * Start a fresh ledger (a journal without ledger history) on a vault that already has player history
   * (deposits, withdrawals, an attestation or escape mode). Off by default: that start would drop every player
   * balance and attest an empty root, so `start()` refuses it (FreshLedgerError). Only for a deliberate rebuild
   * from chain events (MAYA_ALLOW_FRESH_LEDGER=1).
   */
  readonly allowFreshLedger?: boolean;
}

/** Journal events that bind a ledger to its vault: a journal with none of them has no ledger history yet. */
const LEDGER_HISTORY: ReadonlySet<string> = new Set<EngineEvent['type']>(['deposit', 'withdrawal', 'treasury', 'treasury-pending', 'attest', 'voucher']);

/** Whether the vault shows player history a fresh ledger would not know about. */
export function vaultHasPlayerHistory(v: Pick<VaultState, 'totalDepositsWei' | 'totalWithdrawalsWei' | 'lastAttestation' | 'escape'>): boolean {
  return v.totalDepositsWei > 0n || v.totalWithdrawalsWei > 0n || v.lastAttestation !== null || v.escape.mode;
}

/**
 * `HouseApp.start()` refused a fresh ledger: the vault has player history (FRESH_LEDGER_ON_VAULT_HISTORY) or could
 * not be read to rule it out (FRESH_LEDGER_UNVERIFIED). Starting anyway would show every player a zero balance and
 * attest liabilities 0 with the zero root, which the vault then counts as house surplus.
 */
export class FreshLedgerError extends Error {
  override readonly name = 'FreshLedgerError';
  constructor(readonly code: 'FRESH_LEDGER_ON_VAULT_HISTORY' | 'FRESH_LEDGER_UNVERIFIED', message: string) { super(message); }
}

/** Chain failures whose outcome is unknown: the transaction may still be mined (receipt timeout, or a broadcast the node could not confirm). */
export function isUnknownOutcome(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 'TX_TIMEOUT' || code === 'TX_SEND_FAILED';
}
function txHashOf(error: unknown): string | undefined {
  const h = (error as { txHash?: unknown } | undefined)?.txHash;
  return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? h : undefined;
}

/** Result of a player-facing chain action (HTTP status on failure). */
export type PlayerResult<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

/** The vault's custom error name behind a chain failure (LiveChain `ChainError.revert`, OfflineChain `code`). */
export function chainErrorName(error: unknown): string | undefined {
  const e = error as { revert?: { name?: unknown }; code?: unknown } | undefined;
  if (typeof e?.revert?.name === 'string') return e.revert.name;
  return typeof e?.code === 'string' ? e.code : undefined;
}

const EIP712_TYPES = Object.freeze({ Withdrawal: Object.freeze([{ name: 'account', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }]) });

export interface RefitJob { readonly jobId: string; state: 'queued' | 'running' | 'done' | 'failed'; readonly startedMs: number; readonly markets: MarketId[]; results: { market: MarketId; ok: boolean; tableId?: string; detail?: string }[] }

/**
 * Composition root: engine + feed + chain + refit + attestation + simulation. Drives the engine one
 * step at a time (replay: fixed virtual steps; live: wall clock) and runs every on-chain action,
 * journaling it through the engine.
 */
export class HouseApp {
  readonly engine: HouseEngine;
  readonly feed: Feed;
  readonly chain: ChainPort;
  readonly crowd: CrowdSim | undefined;
  readonly onchain: OnchainPlayers | undefined;
  readonly chainReceipts: ChainReceipt[] = [];
  readonly refitJobs = new Map<string, RefitJob>();
  readonly pending = new Set<Promise<unknown>>();
  readonly log: (line: string) => void;
  private readonly stepMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribeDeposit: (() => void) | undefined;
  private unsubscribeWithdrawn: (() => void) | undefined;
  private unsubscribeReference: (() => void) | undefined;
  /** Attested balance trees (proofs for the escape hatch). */
  readonly attestations: AttestationStore;
  /** Address of the ledger-signer key this process holds (captured once the chain started and verified it). */
  serverSigner: string | undefined;
  private nextSweepMs: number | undefined;
  private sweeping: Promise<void> | undefined;
  private readonly eventOverdue = new Set<string>();
  private nextHealthMs: number | undefined;
  private healthRunning: Promise<void> | undefined;
  private activeAlerts = new Map<string, ChainAlert>();
  /** Alerts from the latest vault health check. */
  chainAlertsNow: readonly ChainAlert[] = [];
  private readonly signing = new Map<string, Promise<PlayerResult<{ voucher: VoucherRecord }>>>();
  private nextAttestMs: number | undefined;
  private attesting: Promise<AdminResult> | undefined;
  private refitRunning: Promise<void> | undefined;
  private refitSeq = 0;
  private lastRefitClock: number;
  private vaultCache: { state: VaultState; atMs: number } | undefined;
  private started = false;
  /** The treasury operation this process is sending right now (vault-state resolution leaves it alone). */
  private treasuryInFlight: string | undefined;
  private treasuryAlert: ChainAlert | undefined;
  private reconcileStreak = 0;
  private reconcileAlertNow: ChainAlert | undefined;
  readonly startClockMs: number;
  /** Simulated players (crowd and on-chain drivers) only bet while this is set. */
  bettingOpen = true;
  /** Sim players already in the journal (their sessions are not restored after a restart). */
  private simExisting = 0;

  constructor(readonly options: AppOptions) {
    this.log = options.log ?? (() => undefined);
    this.feed = options.feed; this.chain = options.chain;
    this.stepMs = options.stepMs ?? 250;
    this.attestations = new AttestationStore(options.attestationDir);
    this.engine = new HouseEngine({ config: options.engineConfig, journal: options.journal, tables: options.tables, runId: options.runId, bootId: options.bootId, startMs: options.feed.nowMs() });
    this.engine.feedUncertaintyMs = options.feed.uncertaintyMs;
    if (options.warmup?.length) this.log(`house: warmed ${this.engine.warm(options.warmup)} recorded seconds before the replay start`);
    this.engine.open(options.records ?? [], options.bootFeed);
    this.startClockMs = this.engine.nowMs;
    this.lastRefitClock = this.engine.lastRefitMs ?? this.engine.nowMs;
    if (options.sim && options.sim.players > 0) {
      const existing = [...this.engine.players.values()].filter(p => p.kind === 'sim').length;
      this.simExisting = existing;
      this.crowd = new CrowdSim(this.engine, { targetPlayers: Math.max(0, options.sim.players - existing), arrivalsPerMin: options.sim.arrivalsPerMin, seed: `${options.sim.seed}:${existing}`, markets: this.engine.markets, idOffset: existing, ...(options.sim.mix ? { mix: options.sim.mix } : {}), ...(options.sim.peek ? { peek: options.sim.peek } : {}) });
    }
    // Replay speed and crowd settings are journaled state (admin-controllable), seeded once per journal.
    if (this.feed.mode === 'replay' && !options.records?.some(r => r.type === 'sim')) {
      this.engine.applySimSettings({ running: !!this.crowd, speed: this.feed.status().speed, arrivalsPerMin: this.crowd ? options.sim!.arrivalsPerMin : 0 });
    }
    this.applySimSettings();
    if (options.onchain) this.onchain = new OnchainPlayers(this.engine, this.chain, { markets: this.engine.markets, seed: options.onchain.seed, depositWei: options.onchain.depositWei, betsPerMin: options.onchain.betsPerMin, chainNowS: () => this.chainNowS(), log: this.log });
    this.engine.flush();
  }

  /**
   * Chain time in Unix seconds: the offline chain's own clock (the feed clock in production) or the
   * feed clock, and the wall clock for live chains (Base Sepolia block times track it closely).
   */
  chainNowS(): bigint {
    if (this.options.chainClock === 'feed') {
      const own = (this.chain as { chainNowS?: () => bigint }).chainNowS;
      return typeof own === 'function' ? own.call(this.chain) : BigInt(Math.floor(this.engine.nowMs / 1000));
    }
    return BigInt(Math.floor(Date.now() / 1000));
  }

  /**
   * Chain time for decisions the vault re-checks against `block.timestamp` (voucher expiry, the expiry
   * sweep): max(`chainNowS()`, latest block time) when the adapter reports it (LiveChain `chainTime()`).
   * The max keeps expiries valid on a chain that runs ahead of the wall clock (anvil time travel); when
   * the wall clock is ahead of the latest block instead, the next block's timestamp follows it, and the
   * sweep's expiry margin (600 s) covers the difference.
   */
  async chainTimeS(): Promise<bigint> {
    const local = this.chainNowS();
    const read = (this.chain as { chainTime?: () => Promise<bigint> }).chainTime;
    if (this.options.chainClock !== 'wall' || typeof read !== 'function') return local;
    try { const t = await read.call(this.chain); return t > local ? t : local; } catch { return local; }
  }

  /**
   * Connect the chain, refuse a fresh ledger on a vault with player history, credit deposits, sync the house
   * bankroll on a fresh journal and refit if warm.
   */
  async start(): Promise<void> {
    await this.chain.start();
    // LiveChain.start() verified that the vault's signer is the key it holds; OfflineChain reports its key directly.
    const held = (this.chain as { signerKeyAddress?: unknown }).signerKeyAddress;
    this.serverSigner = (typeof held === 'string' ? held : this.chain.addresses().ledgerSigner).toLowerCase();
    // Checked before any chain event reaches the ledger: a refused start journals nothing but its boot record.
    const vault = await this.readVault(true);
    try { this.checkFreshLedger(vault); } catch (error) { await this.chain.stop().catch(() => undefined); throw error; }
    this.unsubscribeDeposit = this.chain.onDeposit(d => {
      const r = this.engine.creditDeposit(d);
      if (!r.ok) this.engine.alert('warning', `Deposit ${d.txHash}:${d.logIndex} rejected: ${r.code}`, 'DEPOSIT_REJECTED');
      this.engine.flush();
    });
    // Redeemed vouchers from any wallet (server-submitted or a player's own MetaMask transaction) are claimed only here.
    this.unsubscribeWithdrawn = this.chain.onWithdrawn(w => {
      const r = this.engine.applyChainWithdrawal(w);
      if (!r.ok) this.engine.alert('critical', `Withdrawal ${w.txHash}:${w.logIndex} could not be applied: ${r.code}`, 'WITHDRAWAL_REJECTED');
      this.vaultCache = undefined;
      this.engine.flush();
    });
    await this.feed.start();
    if (this.options.reference) {
      // The reference only ever stops standing quotes early; it never prices, accepts or settles.
      this.unsubscribeReference = this.options.reference.onPrice(p => { this.engine.observeReference(p.market, p.value, p.publishTimeMs); });
      await this.options.reference.start();
    }
    if (vault) {
      this.engine.setMaxVoucherAmountCenti(fromWei(vault.maxVoucherAmountWei).centi);
      const houseNet = vault.houseFundedWei - vault.houseWithdrawnWei;
      const fresh = !this.options.records?.some(r => r.type === 'treasury');
      if (fresh && houseNet > 0n) {
        const { centi, dustWei } = fromWei(houseNet);
        this.engine.recordTreasury('sync', centi, undefined, dustWei);
        this.engine.recordAudit({ kind: 'system', actor: 'system', action: 'treasury-sync', after: { houseEquityCenti: centi, dustWei: dustWei.toString() }, reason: 'initial sync of on-chain house funding into a fresh ledger' });
      }
    }
    if (this.options.refit.onStart && this.engine.lastRefitMs === undefined) {
      const warmHours = this.warmHours();
      if (warmHours >= this.options.refit.minWarmHours) await this.runRefit('system', 'startup refit on recorded history');
      else this.log(`house: startup refit skipped (${warmHours.toFixed(1)} h of history < ${this.options.refit.minWarmHours} h)`);
    }
    this.nextAttestMs = this.options.attestEveryMs > 0 ? this.attestClock() : undefined;
    this.nextSweepMs = (this.options.voucherSweepEveryMs ?? 60_000) > 0 ? this.attestClock() : undefined;
    this.nextHealthMs = (this.options.chainHealthEveryMs ?? 60_000) > 0 ? this.attestClock() : undefined;
    this.started = true;
    this.engine.flush();
  }

  /**
   * Fail closed on a fresh ledger (no deposit, withdrawal, treasury, voucher or attestation in the journal) when
   * the vault has player history, or cannot be read to rule it out. A restart that lost its run id or journal
   * would otherwise show every player a zero balance, attest the zero root within one attestation interval and
   * let the vault count player deposits as house surplus.
   */
  private checkFreshLedger(vault: VaultState | undefined): void {
    if ((this.options.records ?? []).some(r => LEDGER_HISTORY.has(r.type))) return;
    const where = `vault ${this.chain.addresses().vault} (chain ${this.chain.chainId})`;
    const history = vault ? vaultHasPlayerHistory(vault) : undefined;
    if (this.options.allowFreshLedger) {
      if (history !== false) this.log(`house: WARNING fresh ledger for run ${this.options.runId} on ${where} ${history ? 'with player history' : 'that could not be read'} (MAYA_ALLOW_FRESH_LEDGER): balances are rebuilt from chain events only`);
      return;
    }
    const remedy = 'Restart with the MAYA_RUN_ID (journal) of the run that owns this vault, or set MAYA_ALLOW_FRESH_LEDGER=1 to rebuild player balances from chain events only: bets, open legs and outstanding vouchers of earlier runs are lost, and every earlier redemption is charged to house equity as unmatched.';
    if (!vault) throw new FreshLedgerError('FRESH_LEDGER_UNVERIFIED', `Run ${this.options.runId} has no ledger history and ${where} could not be read to check that it has none either; refusing to start a fresh ledger. Retry once the chain is reachable. ${remedy}`);
    if (history) {
      const att = vault.lastAttestation ? `last attestation seq ${vault.lastAttestation.seq} (${vault.lastAttestation.liabilitiesWei} wei)` : 'no attestation';
      throw new FreshLedgerError('FRESH_LEDGER_ON_VAULT_HISTORY', `Run ${this.options.runId} has no ledger history but ${where} has player history (deposits ${vault.totalDepositsWei} wei, withdrawals ${vault.totalWithdrawalsWei} wei, ${att}${vault.escape.mode ? ', escape mode' : ''}). Starting would drop every player balance and attest an empty root. ${remedy}`);
    }
  }

  private warmHours(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const m of this.engine.markets) {
      const p = this.engine.paths.get(m)!;
      let first = Number.POSITIVE_INFINITY; for (const t of p.values.keys()) { if (t < first) first = t; }
      const latest = p.latest()?.t ?? first;
      min = Math.min(min, Number.isFinite(first) ? (latest - first) / 3600 : 0);
    }
    return Number.isFinite(min) ? min : 0;
  }

  /** On-chain players deposit (when their ledger balance is low) and wait for the credits. */
  async setupOnchainPlayers(pump?: () => Promise<void>): Promise<void> {
    if (!this.onchain || !this.options.onchain) return;
    const low = this.onchain.players.filter(p => this.engine.balanceOf(p.address) < this.options.onchain!.topUpBelowCenti);
    if (!low.length) return;
    await this.onchain.depositAll(120_000, pump);
    for (const e of this.onchain.errors) this.engine.alert('warning', e, 'ONCHAIN_PLAYER');
  }

  private attestClock(): number { return this.options.chainClock === 'feed' ? this.engine.nowMs : Date.now(); }

  /** One engine step: deliver feed samples, settle, quote, refit/attest schedules, simulated players. */
  tick(toMs?: number): void {
    const samples = this.feed.advance(toMs);
    this.engine.step(this.feed.nowMs(), samples);
    const now = this.engine.nowMs;
    if (this.started && !this.refitRunning && now - this.lastRefitClock >= this.options.refit.refitHours * 3_600_000) this.track(this.runRefit('system', 'scheduled rolling refit'));
    if (this.started && this.nextAttestMs !== undefined && !this.attesting && this.attestClock() >= this.nextAttestMs + this.options.attestEveryMs) {
      this.nextAttestMs = this.attestClock();
      this.track(this.attestNow({ actor: 'system', reason: 'periodic attestation' }).then(r => { if (!r.ok) this.engine.alert('warning', `Periodic attestation failed: ${r.message}`, 'ATTEST_FAILED'); }));
    }
    if (this.started && this.nextSweepMs !== undefined && !this.sweeping && this.attestClock() >= this.nextSweepMs) {
      this.nextSweepMs = this.attestClock() + (this.options.voucherSweepEveryMs ?? 60_000);
      if (this.dueVouchers().length) this.track(this.sweepVouchers());
    }
    if (this.started && this.nextHealthMs !== undefined && !this.healthRunning && this.attestClock() >= this.nextHealthMs) {
      this.nextHealthMs = this.attestClock() + (this.options.chainHealthEveryMs ?? 60_000);
      this.track(this.checkChainHealth());
    }
    if (this.bettingOpen) {
      if (this.crowd && this.engine.sim.running) this.crowd.step(now);
      this.onchain?.step(now);
    }
    this.engine.flush();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  /** Real-time loop: replay advances `speed ×` wall time in fixed virtual steps; live follows the wall clock. */
  startLoop(wallMs = 50): void {
    if (this.timer) return;
    let last = Date.now();
    this.timer = setInterval(() => {
      try {
        if (this.feed.mode === 'live') { this.tick(); return; }
        const nowWall = Date.now(); const elapsed = Math.min(1000, nowWall - last); last = nowWall;
        const target = this.engine.nowMs + elapsed * this.engine.sim.speed;
        let guard = 0;
        while (this.engine.nowMs < target && guard++ < 4000) {
          const before = this.engine.nowMs;
          this.tick(Math.min(before + this.stepMs, target));
          if (this.engine.nowMs === before) break;
        }
      } catch (error) {
        this.log(`house: tick failed: ${errorMessage(error)}`);
        this.engine.alert('critical', `Engine tick failed: ${errorMessage(error)}`, 'TICK_FAILED');
      }
    }, wallMs);
  }
  stopLoop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async stop(): Promise<void> {
    this.stopLoop();
    await Promise.allSettled([...this.pending]);
    this.unsubscribeDeposit?.();
    this.unsubscribeWithdrawn?.();
    this.unsubscribeReference?.();
    await this.options.reference?.stop();
    await this.feed.stop();
    await this.chain.stop();
    this.engine.flush();
    this.options.journal.close();
  }

  /** Apply journaled sim settings to the feed and crowd. */
  applySimSettings(): void {
    const s = this.engine.sim;
    if ('speed' in this.feed) (this.feed as { speed: number }).speed = s.speed;
    if (this.crowd) { this.crowd.running = s.running; if (this.crowd.rate !== s.arrivalsPerMin) this.crowd.setArrivalsPerMin(s.arrivalsPerMin, this.engine.nowMs); }
  }

  // ---------------------------------------------------------------- refit

  startRefit(actor: string, reason: string): { jobId: string } {
    const jobId = `R${this.refitSeq + 1}`;
    if (this.refitRunning) return { jobId: [...this.refitJobs.keys()].at(-1) ?? jobId };
    this.track(this.runRefit(actor, reason));
    return { jobId };
  }

  private runRefit(actor: string, reason: string): Promise<void> {
    const jobId = `R${++this.refitSeq}`;
    const job: RefitJob = { jobId, state: 'queued', startedMs: this.engine.nowMs, markets: [...this.engine.markets], results: [] };
    this.refitJobs.set(jobId, job);
    this.lastRefitClock = this.engine.nowMs;
    this.engine.notice({ type: 'refit', data: { jobId, progress: 0, state: 'queued' } });
    const run = (async () => {
      job.state = 'running';
      const markets = this.engine.markets;
      for (const [i, market] of markets.entries()) {
        this.engine.notice({ type: 'refit', data: { jobId, progress: i / markets.length, state: 'running', market } });
        const now = Math.floor(this.engine.nowMs / 1000);
        const points = pathPoints(this.engine.paths.get(market)!.values, now, this.options.refit.trainHours);
        let r;
        try { r = await this.options.refitRunner.run({ market, points, now, trainHours: this.options.refit.trainHours, minRows: this.options.refit.minRows }); }
        catch (error) { r = { ok: false as const, market, reason: 'exception', detail: errorMessage(error) }; }
        if (r.ok) {
          const file = this.options.tables.persist(r.table, r.json);
          this.engine.publishTable(market, r.table, file, r.rows, actor);
          job.results.push({ market, ok: true, tableId: r.table.id });
          this.log(`house: refit ${market} → ${r.table.id} (${r.rows} instants, ${r.observations} labels)`);
        } else {
          job.results.push({ market, ok: false, detail: `${r.reason}: ${r.detail}` });
          this.engine.recordAudit({ kind: 'system', actor, action: 'refit-failed', target: market, reason, result: `${r.reason}: ${r.detail}` });
          this.log(`house: refit ${market} failed: ${r.reason}: ${r.detail}`);
        }
      }
      job.state = job.results.every(r => r.ok) ? 'done' : 'failed';
      const tableIds = job.results.filter(r => r.tableId).map(r => r.tableId).join(', ');
      this.engine.notice({ type: 'refit', data: { jobId, progress: 1, state: job.state, ...(tableIds ? { tableId: tableIds } : {}), message: job.results.map(r => `${r.market}: ${r.ok ? r.tableId : r.detail}`).join('; ') } });
      this.engine.flush();
    })();
    this.refitRunning = run.finally(() => { this.refitRunning = undefined; });
    return this.refitRunning;
  }

  // ---------------------------------------------------------------- chain actions

  async readVault(force = false): Promise<VaultState | undefined> {
    if (!force && this.vaultCache && Date.now() - this.vaultCache.atMs < 2000) return this.vaultCache.state;
    try { const state = await this.chain.vaultState(); this.vaultCache = { state, atMs: Date.now() }; return state; }
    catch (error) { this.log(`house: vault read failed: ${errorMessage(error)}`); return this.vaultCache?.state; }
  }

  /** A fresh vault read (no cached fallback): decisions that book or release money must not rest on a stale state. */
  private async freshVault(): Promise<VaultState | undefined> {
    try { const state = await this.chain.vaultState(); this.vaultCache = { state, atMs: Date.now() }; return state; }
    catch (error) { this.log(`house: vault read failed: ${errorMessage(error)}`); return undefined; }
  }

  /**
   * A chain action that did not succeed. A receipt timeout or an unconfirmed broadcast is not a rejection (SPEC §1.3):
   * the transaction may still be mined, so it answers 504 CHAIN_OUTCOME_UNKNOWN with the tx hash and is audited as
   * `unknown: …`, which tells the operator to check the vault before retrying. Anything else is a failure (502, `failed: …`).
   */
  private chainFailure(action: string, meta: AdminMeta, error: unknown, before: unknown): AdminResult {
    const message = errorMessage(error);
    const txHash = txHashOf(error);
    const unknown = isUnknownOutcome(error);
    this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action, before, reason: meta.reason, result: `${unknown ? 'unknown' : 'failed'}: ${message}`, ...(txHash ? { txHash } : {}) });
    this.engine.flush();
    if (unknown) return { ok: false, status: 504, code: 'CHAIN_OUTCOME_UNKNOWN', message: `Outcome unknown, the transaction may still be mined: check the vault state and the audit log before retrying (${message})`, ...(txHash ? { txHash } : {}) };
    return { ok: false, status: 502, code: 'CHAIN_ERROR', message, ...(txHash ? { txHash } : {}) };
  }

  /**
   * Attest liabilities now. The ledger snapshot, the persisted balance tree and the attest call happen in
   * one synchronous turn (no await between them), so the root covers exactly the chain flows the ledger
   * had applied when a live chain reads its indexer watermark on entry.
   */
  attestNow(meta: AdminMeta): Promise<AdminResult> {
    if (this.attesting) return this.attesting;
    const run = (async (): Promise<AdminResult> => {
      const vault = await this.readVault(true);
      const seq = [vault?.lastAttestation?.seq ?? 0n, this.engine.lastAttestation?.seq ?? 0n].reduce((a, b) => (b > a ? b : a)) + 1n;
      // Requested asOf = chain time, read before the synchronous snapshot turn; a live adapter clamps it down to its indexer
      // watermark. A wall-clock asOf behind block time would place flows the ledger already applied after the cut, so the
      // vault would count them again (escape entitlement, deposits since attest).
      const asOf = await this.chainTimeS();
      const before = this.engine.lastAttestation ? { seq: this.engine.lastAttestation.seq.toString(), liabilitiesWei: this.engine.lastAttestation.liabilitiesWei.toString() } : null;
      let snap: ReturnType<HouseEngine['attestationSnapshot']>;
      let stored: StoredTree;
      try {
        snap = this.engine.attestationSnapshot();
        // Written before the transaction: the vault must never hold a root whose leaves are lost.
        stored = this.attestations.save({
          version: 1, seq: seq.toString(), root: snap.ledgerRoot, requestedAsOf: asOf.toString(), chainId: this.chain.chainId, vault: this.chain.addresses().vault.toLowerCase(), createdMs: this.engine.nowMs,
          liabilitiesWei: snap.liabilitiesWei.toString(), leafTotalWei: snap.leafTotalWei.toString(), entries: snap.entries.map(e => ({ account: e.account, balanceWei: e.balanceWei.toString() })),
        });
      } catch (error) {
        this.engine.alert('critical', `Attestation snapshot failed: ${errorMessage(error)}`, 'ATTEST_SNAPSHOT_FAILED');
        return this.chainFailure('treasury-attest', meta, error, before);
      }
      let tx: { txHash: string; asOf?: bigint; blockNumber?: bigint };
      try { tx = await this.chain.attest({ liabilitiesWei: snap.liabilitiesWei, ledgerRoot: snap.ledgerRoot, asOf, seq }); }
      catch (error) { return this.chainFailure('treasury-attest', meta, error, before); }
      const actualAsOf = typeof tx.asOf === 'bigint' ? tx.asOf : asOf;
      this.engine.recordAttestation(seq, snap.liabilitiesWei, snap.ledgerRoot, actualAsOf, tx.txHash, { leaves: snap.entries.length, leafTotalWei: snap.leafTotalWei, ...(stored.name ? { treeFile: stored.name } : {}), treeSha256: stored.sha256 });
      this.chainReceipts.push({ kind: 'attest', txHash: tx.txHash, ...(tx.blockNumber !== undefined ? { blockNumber: tx.blockNumber.toString() } : {}), amountWei: snap.liabilitiesWei.toString(), explorerUrl: this.chain.explorerUrl('tx', tx.txHash), atMs: this.engine.nowMs });
      const after = { seq: seq.toString(), liabilitiesWei: snap.liabilitiesWei.toString(), liabilitiesCenti: snap.liabilitiesCenti.toString(), ledgerRoot: snap.ledgerRoot, asOf: actualAsOf.toString(), leaves: snap.entries.length, leafTotalWei: snap.leafTotalWei.toString() };
      const entry = this.engine.recordAudit({ kind: meta.actor === 'system' ? 'system' : 'admin', actor: meta.actor, action: 'treasury-attest', before, after, reason: meta.reason, result: 'ok', txHash: tx.txHash });
      this.vaultCache = undefined;
      this.engine.flush();
      return { ok: true, action: 'treasury-attest', auditId: entry.id, before, after, txHash: tx.txHash };
    })();
    this.attesting = run.finally(() => { this.attesting = undefined; });
    return this.attesting;
  }

  // ---------------------------------------------------------------- treasury (fund house, withdraw surplus)

  /**
   * Fund the house (operator → vault). Journaled as a pending operation first; booked from the receipt, or,
   * after an unknown outcome, from the vault's house counters (never credited on a guess).
   */
  async fundHouse(amountCenti: unknown, meta: AdminMeta): Promise<AdminResult> {
    if (!isPositiveCenti(amountCenti)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'amountCenti must be a positive Centi integer string' };
    const blocked = await this.treasuryGate(); if (blocked) return blocked;
    const before = { houseEquityCenti: this.engine.equityOnchain().toString() };
    const op = this.engine.beginTreasury('fund', amountCenti, meta.actor);
    if (!op.ok) return this.treasuryBusy(op.pending);
    this.engine.flush();
    this.treasuryInFlight = op.opId;
    try {
      let tx;
      try { tx = await this.chain.fundHouse(toWei(amountCenti)); } catch (error) { return this.treasuryFailure(op.opId, 'treasury-fund', meta, error, before); }
      this.bookReceipt(op.opId, 'fund', amountCenti, tx.txHash);
      this.chainReceipts.push({ kind: 'fund', amountCenti, txHash: tx.txHash, explorerUrl: this.chain.explorerUrl('tx', tx.txHash), atMs: this.engine.nowMs });
      const after = { houseEquityCenti: this.engine.equityOnchain().toString() };
      const entry = this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action: 'treasury-fund', before, after, reason: meta.reason, result: 'ok', txHash: tx.txHash });
      this.vaultCache = undefined; this.engine.flush();
      return { ok: true, action: 'treasury-fund', auditId: entry.id, before, after, txHash: tx.txHash, opId: op.opId };
    } finally { this.treasuryInFlight = undefined; }
  }

  /**
   * Withdraw house surplus: bounded by free on-chain equity (bankroll minus open on-chain liability and any
   * pending withdrawal), attested immediately before, then bounded again by the vault's surplus and buffer.
   * The amount is reserved in the ledger (journaled) before the first await, so bets accepted while the attest
   * and withdraw transactions are in flight are checked against the equity that remains afterwards. The
   * reservation ends when the withdrawal is booked, or is released when it provably moved nothing; an unknown
   * outcome keeps it reserved until the vault's house counters show what happened.
   */
  async withdrawSurplus(amountCenti: unknown, meta: AdminMeta): Promise<AdminResult> {
    if (!isPositiveCenti(amountCenti)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'amountCenti must be a positive Centi integer string' };
    if (meta.confirm !== 'withdraw-surplus') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'withdraw-surplus requires confirm: "withdraw-surplus"' };
    const blocked = await this.treasuryGate(); if (blocked) return blocked;
    // Synchronous from the free-equity check to the reservation: both see the same ledger.
    const amount = BigInt(amountCenti);
    const free = this.engine.freeOnchainEquity();
    if (amount > free) return { ok: false, status: 409, code: 'EXCEEDS_FREE_EQUITY', message: `At most ${free} Centi of house equity is free of open on-chain liability` };
    const before = { houseEquityCenti: this.engine.equityOnchain().toString() };
    const op = this.engine.beginTreasury('withdraw-surplus', amountCenti, meta.actor);
    if (!op.ok) return this.treasuryBusy(op.pending);
    this.engine.flush();
    this.treasuryInFlight = op.opId;
    try {
      const refuse = (r: AdminResult, why: string): AdminResult => { this.engine.releaseTreasury(op.opId, why, meta.actor); this.engine.flush(); return r; };
      const attest = await this.attestNow({ actor: meta.actor, reason: `pre-withdrawal attestation: ${meta.reason}` });
      if (!attest.ok) return refuse(attest, `pre-withdrawal attestation failed: ${attest.code}`);
      const vault = await this.readVault(true);
      if (vault && toWei(amountCenti) > vault.surplusWei) return refuse({ ok: false, status: 409, code: 'EXCEEDS_SURPLUS', message: `Vault surplus is ${fromWei(vault.surplusWei).centi} Centi` }, 'refused: exceeds the vault surplus');
      // SPEC-11: the vault keeps a buffer of houseBufferBps of its obligations and caps house withdrawals per UTC day.
      if (vault && toWei(amountCenti) > vault.houseWithdrawableWei) return refuse({ ok: false, status: 409, code: 'EXCEEDS_HOUSE_WITHDRAWABLE', message: `The vault lets the house withdraw at most ${fromWei(vault.houseWithdrawableWei).centi} Centi now (a ${vault.houseBufferBps} bps buffer on obligations stays, and the daily house cap applies)` }, 'refused: exceeds the vault house withdrawable');
      let tx;
      try { tx = await this.chain.withdrawHouse(toWei(amountCenti), this.chain.addresses().operator); } catch (error) { return this.treasuryFailure(op.opId, 'treasury-withdraw-surplus', meta, error, before); }
      this.bookReceipt(op.opId, 'withdraw-surplus', amountCenti, tx.txHash);
      this.chainReceipts.push({ kind: 'withdraw-surplus', amountCenti, txHash: tx.txHash, explorerUrl: this.chain.explorerUrl('tx', tx.txHash), atMs: this.engine.nowMs });
      const after = { houseEquityCenti: this.engine.equityOnchain().toString() };
      const entry = this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action: 'treasury-withdraw-surplus', before, after, reason: meta.reason, result: 'ok', txHash: tx.txHash });
      this.vaultCache = undefined; this.engine.flush();
      return { ok: true, action: 'treasury-withdraw-surplus', auditId: entry.id, before, after, txHash: tx.txHash, attestTxHash: attest.txHash, opId: op.opId };
    } finally { this.treasuryInFlight = undefined; }
  }

  /** Book a mined treasury transaction from its receipt, unless vault-state resolution already booked it. */
  private bookReceipt(opId: string, action: 'fund' | 'withdraw-surplus', amountCenti: string, txHash: string): void {
    if (this.engine.pendingTreasury?.opId === opId) this.engine.recordTreasury(action, amountCenti, txHash, 0n, { opId, resolution: 'receipt' });
  }

  /** A treasury chain call failed: an unknown outcome stays pending (and reserved); a definite failure releases the operation. */
  private treasuryFailure(opId: string, action: string, meta: AdminMeta, error: unknown, before: unknown): AdminResult {
    if (isUnknownOutcome(error)) this.engine.markTreasuryUnknown(opId, txHashOf(error), errorMessage(error));
    else this.engine.releaseTreasury(opId, `failed: ${errorMessage(error)}`, meta.actor);
    const failure = this.chainFailure(action, meta, error, before);
    return failure.ok ? failure : { ...failure, opId };
  }

  private treasuryBusy(p: PendingTreasury): AdminResult {
    if (p.opId === this.treasuryInFlight) return { ok: false, status: 409, code: 'TREASURY_IN_PROGRESS', message: `Treasury operation ${p.opId} (${p.action} ${p.amountCenti} Centi) is being sent`, opId: p.opId };
    return {
      ok: false, status: 409, code: 'TREASURY_OUTCOME_PENDING', opId: p.opId, ...(p.txHash ? { txHash: p.txHash } : {}),
      message: `Treasury operation ${p.opId} (${p.action} ${p.amountCenti} Centi${p.txHash ? `, tx ${p.txHash}` : ''}) has no booked outcome yet. It is booked from the vault's house counters once mined; if the vault shows it never was, release it with POST /admin-api/treasury/release-pending.`,
    };
  }

  /**
   * Before a new treasury action: resolve a pending operation from a fresh vault read (only one may be pending,
   * so the vault's house counters identify its outcome); refuse while it stays pending.
   */
  private async treasuryGate(): Promise<AdminResult | undefined> {
    const pending = this.engine.pendingTreasury;
    if (!pending) return undefined;
    if (pending.opId !== this.treasuryInFlight) { const vault = await this.freshVault(); if (vault) this.resolvePendingTreasury(vault); }
    const still = this.engine.pendingTreasury;
    return still ? this.treasuryBusy(still) : undefined;
  }

  /**
   * Book (or keep pending) a pending treasury operation that is not in flight, from vault state. A mined
   * operation is booked with an audit entry; a house-counter mismatch stays pending (fail closed) and is
   * alerted by the chain health check.
   */
  private resolvePendingTreasury(vault: VaultState): ReturnType<HouseEngine['resolveTreasury']> {
    const pending = this.engine.pendingTreasury;
    if (!pending || pending.opId === this.treasuryInFlight) return { status: pending ? 'pending' : 'none', unbookedWei: 0n, ...(pending ? { op: pending } : {}) };
    const r = this.engine.resolveTreasury(vault);
    if (r.status === 'booked' && r.op) {
      const op = r.op;
      if (op.txHash) this.chainReceipts.push({ kind: op.action, amountCenti: op.amountCenti, txHash: op.txHash, explorerUrl: this.chain.explorerUrl('tx', op.txHash), atMs: this.engine.nowMs });
      this.engine.recordAudit({
        kind: 'system', actor: 'treasury-resolver', action: op.action === 'fund' ? 'treasury-fund' : 'treasury-withdraw-surplus', target: op.opId,
        before: { opId: op.opId, state: op.state }, after: { houseEquityCenti: this.engine.equityOnchain().toString(), resolution: 'vault-state' },
        reason: `outcome of ${op.opId} (${op.action} ${op.amountCenti} Centi by ${op.actor}) read from the vault's house counters`, result: 'ok', ...(op.txHash ? { txHash: op.txHash } : {}),
      });
      this.engine.alert('info', `Treasury operation ${op.opId} (${op.action} ${op.amountCenti} Centi) was mined; booked from vault state`, 'TREASURY_RESOLVED');
      this.vaultCache = undefined;
    }
    this.engine.flush();
    return r;
  }

  /**
   * Release a pending treasury operation whose transaction was never mined (confirm "treasury-release"). Allowed
   * only when a fresh vault read shows no unbooked house flow; a mined operation is booked instead.
   */
  async releasePendingTreasury(opId: unknown, meta: AdminMeta): Promise<AdminResult> {
    if (typeof opId !== 'string' || !/^T\d{1,12}$/.test(opId)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'opId must name a treasury operation (T<n>)' };
    if (meta.confirm !== 'treasury-release') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'Releasing a pending treasury operation requires confirm: "treasury-release"' };
    const pending = this.engine.pendingTreasury;
    if (!pending || pending.opId !== opId) return { ok: false, status: 409, code: 'NO_PENDING_TREASURY', message: `No pending treasury operation ${opId}` };
    if (pending.opId === this.treasuryInFlight) return this.treasuryBusy(pending);
    const vault = await this.freshVault();
    if (!vault) return { ok: false, status: 503, code: 'VAULT_UNAVAILABLE', message: 'The vault cannot be read; a pending operation is only released against a fresh vault state' };
    const before = { pending: { ...pending } };
    const r = this.resolvePendingTreasury(vault);
    if (r.status === 'booked') return { ok: false, status: 409, code: 'TREASURY_ALREADY_MINED', message: `The vault shows ${opId} was mined; it has been booked instead`, opId };
    if (r.status === 'mismatch') return { ok: false, status: 409, code: 'TREASURY_UNRECONCILED', message: `The vault's house net differs from the ledger by ${r.unbookedWei} wei, which is not this operation's flow: it cannot be released safely`, opId };
    if (this.engine.pendingTreasury?.opId !== opId) return { ok: false, status: 409, code: 'NO_PENDING_TREASURY', message: `No pending treasury operation ${opId}` };
    this.engine.releaseTreasury(opId, `released by ${meta.actor}: ${meta.reason} (the vault's house counters showed no such flow)`, meta.actor);
    const after = { pending: null, houseEquityCenti: this.engine.equityOnchain().toString() };
    const entry = this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action: 'treasury-release', target: opId, before, after, reason: meta.reason, result: 'ok', ...(pending.txHash ? { txHash: pending.txHash } : {}) });
    this.engine.flush();
    return { ok: true, action: 'treasury-release', auditId: entry.id, before, after, opId };
  }

  /** The pending treasury operation (admin views), with the amount it reserves. */
  treasuryView(): Record<string, unknown> | null {
    const p = this.engine.pendingTreasury;
    return p ? { ...p, reservedCenti: this.engine.treasuryReservedCenti().toString(), inFlight: p.opId === this.treasuryInFlight } : null;
  }

  async vaultPause(pause: boolean, meta: AdminMeta): Promise<AdminResult> {
    const action = pause ? 'vault-pause' : 'vault-unpause';
    if (pause && meta.confirm !== 'vault-pause') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'vault pause requires confirm: "vault-pause"' };
    const vault = await this.readVault(true);
    const before = { paused: vault?.paused ?? null };
    if (vault && vault.paused === pause) return { ok: false, status: 409, code: pause ? 'ALREADY_PAUSED' : 'NOT_PAUSED', message: `Vault is ${pause ? 'already' : 'not'} paused` };
    let tx;
    try { tx = pause ? await this.chain.pauseVault() : await this.chain.unpauseVault(); } catch (error) { return this.chainFailure(action, meta, error, before); }
    const after = { paused: pause };
    const entry = this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action, before, after, reason: meta.reason, result: 'ok', txHash: tx.txHash });
    this.vaultCache = undefined; this.engine.flush();
    return { ok: true, action, auditId: entry.id, before, after, txHash: tx.txHash };
  }

  // ---------------------------------------------------------------- SPEC-11 vault administration

  private signerView(vault: VaultState | undefined): Record<string, unknown> {
    const p = vault?.pendingSigner;
    return { ledgerSigner: vault?.ledgerSigner.toLowerCase() ?? null, serverSigner: this.serverSigner ?? null, pendingSigner: p ? { address: p.address.toLowerCase(), eta: p.eta.toString(), etaMs: Number(p.eta) * 1000 } : null };
  }

  /** A refused vault admin transaction: audited as failed; the vault's own business reverts answer 409 with the error name. */
  private vaultFailure(action: string, meta: AdminMeta, error: unknown, before: unknown): AdminResult {
    const name = chainErrorName(error);
    const failure = this.chainFailure(action, meta, error, before);
    const known = ['TimelockNotElapsed', 'NoPendingLedgerSigner', 'SignerUnchanged', 'SignerIsOwner', 'NothingToSweep', 'InvalidRecipient', 'ZeroAddress', 'EscapeModeActive'];
    if (!failure.ok && name && known.includes(name)) return { ok: false, status: 409, code: name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(), message: failure.message };
    return failure;
  }

  /** Finish a vault admin transaction: audit (before/after, reason, tx), drop the vault cache, re-check alerts. */
  private vaultAdminOk(action: string, meta: AdminMeta, before: unknown, after: unknown, tx: ChainTx, extra: Record<string, unknown> = {}): AdminResult {
    const entry = this.engine.recordAudit({ kind: 'admin', actor: meta.actor, action, before, after, reason: meta.reason, result: 'ok', txHash: tx.txHash });
    this.vaultCache = undefined; this.engine.flush();
    if (this.started) this.track(this.checkChainHealth());
    return { ok: true, action, auditId: entry.id, before, after, txHash: tx.txHash, ...extra };
  }

  /** Start a timelocked ledger-signer rotation (confirm "signer-propose"). */
  async proposeSigner(address: unknown, meta: AdminMeta): Promise<AdminResult> {
    if (!isAddress(address)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'address must be a 0x address' };
    if (meta.confirm !== 'signer-propose') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'A signer rotation requires confirm: "signer-propose"' };
    const next = address.toLowerCase();
    if (/^0x0{40}$/.test(next)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'The signer cannot be the zero address' };
    if (next === this.chain.addresses().operator.toLowerCase()) return { ok: false, status: 400, code: 'SIGNER_IS_OWNER', message: 'The ledger signer must differ from the vault owner' };
    const vault = await this.readVault(true);
    if (vault && vault.ledgerSigner.toLowerCase() === next) return { ok: false, status: 409, code: 'SIGNER_UNCHANGED', message: `${next} is already the ledger signer` };
    const before = this.signerView(vault);
    let tx: ChainTx;
    try { tx = await this.chain.proposeLedgerSigner(next); } catch (error) { return this.vaultFailure('vault-signer-propose', meta, error, before); }
    const after = this.signerView(await this.readVault(true));
    return this.vaultAdminOk('vault-signer-propose', meta, before, after, tx);
  }

  /** Complete the pending rotation once its eta passed (confirm "signer-accept"); outstanding vouchers become invalid. */
  async acceptSigner(meta: AdminMeta): Promise<AdminResult> {
    if (meta.confirm !== 'signer-accept') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'Accepting a signer rotation requires confirm: "signer-accept"' };
    const vault = await this.readVault(true);
    if (vault && !vault.pendingSigner) return { ok: false, status: 409, code: 'NO_PENDING_SIGNER', message: 'No ledger-signer rotation is pending' };
    const before = this.signerView(vault);
    let tx: ChainTx;
    // The eta is checked by the vault against chain time (authoritative); a premature accept reverts TimelockNotElapsed → 409.
    try { tx = await this.chain.acceptLedgerSigner(); } catch (error) { return this.vaultFailure('vault-signer-accept', meta, error, before); }
    const state = await this.readVault(true);
    const after = this.signerView(state);
    const lost = !!state && !!this.serverSigner && state.ledgerSigner.toLowerCase() !== this.serverSigner;
    const outstanding = this.engine.pendingVouchers().length;
    return this.vaultAdminOk('vault-signer-accept', meta, before, after, tx, {
      invalidatedVouchers: outstanding,
      ...(lost ? { warning: 'This process no longer holds the ledger-signer key: vouchers and attestations fail with SIGNER_MISMATCH until it restarts with the new key. Outstanding vouchers are invalid and return to balances once they expire.' } : {}),
    });
  }

  async cancelSigner(meta: AdminMeta): Promise<AdminResult> {
    const vault = await this.readVault(true);
    if (vault && !vault.pendingSigner) return { ok: false, status: 409, code: 'NO_PENDING_SIGNER', message: 'No ledger-signer rotation is pending' };
    const before = this.signerView(vault);
    let tx: ChainTx;
    try { tx = await this.chain.cancelLedgerSigner(); } catch (error) { return this.vaultFailure('vault-signer-cancel', meta, error, before); }
    return this.vaultAdminOk('vault-signer-cancel', meta, before, this.signerView(await this.readVault(true)), tx);
  }

  /** Send stray tokens (vault balance above accounted assets) to `to` (confirm "sweep-excess"). Accounted assets never move. */
  async sweepExcess(to: unknown, meta: AdminMeta): Promise<AdminResult> {
    if (!isAddress(to)) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'to must be a 0x address' };
    if (meta.confirm !== 'sweep-excess') return { ok: false, status: 400, code: 'CONFIRM_REQUIRED', message: 'sweep-excess requires confirm: "sweep-excess"' };
    const recipient = to.toLowerCase();
    if (/^0x0{40}$/.test(recipient) || recipient === this.chain.addresses().vault.toLowerCase()) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'to cannot be the zero address or the vault' };
    const vault = await this.readVault(true);
    if (vault && vault.excessWei === 0n) return { ok: false, status: 409, code: 'NOTHING_TO_SWEEP', message: 'The vault holds no tokens above its accounted assets' };
    const before = { excessWei: vault?.excessWei.toString() ?? null, assetsWei: vault?.assetsWei.toString() ?? null };
    let tx: ChainTx & { amountWei?: bigint };
    try { tx = await this.chain.sweepExcess(recipient); } catch (error) { return this.vaultFailure('vault-sweep-excess', meta, error, before); }
    const state = await this.readVault(true);
    const amountWei = typeof tx.amountWei === 'bigint' ? tx.amountWei : vault?.excessWei;
    const after = { excessWei: state?.excessWei.toString() ?? null, assetsWei: state?.assetsWei.toString() ?? null, sweptWei: amountWei?.toString() ?? null, to: recipient };
    return this.vaultAdminOk('vault-sweep-excess', meta, before, after, tx, { amountWei: amountWei?.toString() ?? null });
  }

  // ---------------------------------------------------------------- voucher lifecycle and chain health

  /**
   * Return unredeemable vouchers to their balances (conservative on gaps): only once chain time is past
   * expiry + margin AND the vault reports the nonce unused. A used nonce means a `Withdrawn` event is on
   * its way (indexer lag or confirmations): the voucher stays a liability and an alert is raised.
   */
  private dueVouchers(nowS = this.chainNowS()): VoucherRecord[] {
    const margin = BigInt(this.options.voucherExpiryMarginS ?? 600);
    return this.engine.pendingVouchers().filter(x => BigInt(x.expiry) + margin < nowS);
  }
  sweepVouchers(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const run = (async () => {
      const nowS = await this.chainTimeS();
      const margin = BigInt(this.options.voucherExpiryMarginS ?? 600);
      for (const v of this.dueVouchers(nowS)) {
        let used: boolean;
        try { used = await this.chain.nonceUsed(v.account, BigInt(v.nonce)); }
        catch (error) { this.log(`house: nonceUsed(${v.account}, ${v.voucherId}) failed: ${errorMessage(error)}`); continue; }
        if (!used) {
          const status = this.engine.vouchers.get(v.voucherId)?.status;
          if (this.engine.expireVoucher(v.voucherId, `expired at ${v.expiry} unredeemed (nonce unused at chain time ${nowS})`)) {
            this.engine.recordAudit({ kind: 'system', actor: 'voucher-sweep', action: 'voucher-expired', target: v.account, before: { voucherId: v.voucherId, status }, after: { status: 'expired', returnedCenti: v.amountCenti }, reason: `voucher expired at ${v.expiry} (+${margin} s margin) with its nonce unused on the vault` });
          }
        } else if (!this.eventOverdue.has(v.voucherId)) {
          this.eventOverdue.add(v.voucherId);
          this.engine.alert('warning', `Voucher ${v.voucherId} of ${v.account} is spent on the vault but its Withdrawn event has not been delivered yet; it stays an outstanding liability`, 'WITHDRAWAL_EVENT_PENDING');
        }
      }
      this.engine.flush();
    })();
    this.sweeping = run.finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  /** Read the vault and raise SSE alerts for new or escalated conditions (pending timelocks, signer mismatch, stale attestations). */
  checkChainHealth(): Promise<void> {
    if (this.healthRunning) return this.healthRunning;
    const run = (async () => {
      // Booking a pending treasury outcome and the ledger/vault reconciliation need a fresh read; the other alerts
      // may fall back to the last cached state.
      const fresh = await this.freshVault();
      const vault = fresh ?? this.vaultCache?.state;
      if (!vault) return;
      if (fresh) {
        const r = this.resolvePendingTreasury(fresh);
        this.treasuryAlert = this.pendingTreasuryAlert(r);
        this.updateReconcile(fresh);
      }
      const alerts = [...this.computeAlerts(vault), ...this.ledgerAlerts()];
      const next = new Map(alerts.map(a => [a.key.split(':')[0]!, a]));
      for (const [family, a] of next) { if (this.activeAlerts.get(family)?.key !== a.key) this.engine.alert(a.level, a.message, a.code); }
      for (const [family, prev] of this.activeAlerts) if (!next.has(family)) this.engine.alert('info', `Resolved: ${prev.message}`, `${prev.code}_RESOLVED`);
      this.activeAlerts = next;
      this.chainAlertsNow = alerts;
    })();
    this.healthRunning = run.finally(() => { this.healthRunning = undefined; });
    return this.healthRunning;
  }
  private computeAlerts(vault: VaultState): ChainAlert[] {
    return chainAlerts(vault, { nowS: this.chainNowS(), ...(this.serverSigner ? { serverSigner: this.serverSigner } : {}), attestEveryS: BigInt(Math.round(this.options.attestEveryMs / 1000)) });
  }

  /** Ledger-side alerts from the latest fresh health check: an unresolved treasury operation and a ledger/vault mismatch. */
  private ledgerAlerts(): ChainAlert[] { return [this.treasuryAlert, this.reconcileAlertNow].filter((a): a is ChainAlert => a !== undefined); }

  private pendingTreasuryAlert(r: ReturnType<HouseEngine['resolveTreasury']>): ChainAlert | undefined {
    const op = this.engine.pendingTreasury;
    if (!op || op.opId === this.treasuryInFlight) return undefined;
    const what = `${op.opId} (${op.action} ${op.amountCenti} Centi by ${op.actor}${op.txHash ? `, tx ${op.txHash}` : ''})`;
    if (r.status === 'mismatch') {
      return { key: `TREASURY_PENDING:${op.opId}:critical`, code: 'TREASURY_UNRECONCILED', level: 'critical', message: `Treasury operation ${what} is unresolved and the vault's house net differs from the ledger by ${r.unbookedWei} wei, which is not its flow; it stays reserved until an operator checks the vault` };
    }
    return { key: `TREASURY_PENDING:${op.opId}:warning`, code: 'TREASURY_OUTCOME_UNKNOWN', level: 'warning', message: `Treasury operation ${what} has an unknown outcome${op.action === 'withdraw-surplus' ? ' and stays reserved against equity' : ''}; it is booked once the vault shows it mined, or released with POST /admin-api/treasury/release-pending if it never was` };
  }

  /**
   * Ledger vs vault reconciliation (exact to the wei). A mismatch is a critical alert: player money the ledger
   * does not hold, or house equity that already left the vault. On live chains a vault read runs ahead of the
   * indexer by its confirmations, so a flow in transit can show for one check; there a mismatch must persist
   * over two consecutive checks. The offline vault delivers its events synchronously, so one check suffices.
   */
  private updateReconcile(vault: VaultState): void {
    const rec = this.engine.reconcile(vault);
    if (rec.match) { this.reconcileStreak = 0; this.reconcileAlertNow = undefined; return; }
    this.reconcileStreak++;
    if (this.reconcileStreak < (this.options.chainClock === 'feed' ? 1 : 2)) return;
    this.reconcileAlertNow = {
      key: 'LEDGER_VAULT_MISMATCH', code: 'LEDGER_VAULT_MISMATCH', level: 'critical',
      message: `Vault assets differ from the ledger by ${rec.deltaWei} wei (vault ${rec.vaultAssetsWei}, ledger ${rec.ledgerAssetsWei}); see /admin-api/chain reconciliation`,
    };
  }

  /** Wait until every voucher whose redemption the server submitted has been claimed by its chain event (live chains lag). */
  async awaitWithdrawalEvents(timeoutMs: number, pump: () => Promise<void> = () => new Promise(r => setTimeout(r, 250))): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const waiting = this.engine.pendingVouchers().filter(v => v.submittedTxHash).map(v => v.voucherId);
      if (!waiting.length || Date.now() > deadline) return waiting;
      await pump();
    }
  }

  // ---------------------------------------------------------------- player-facing chain flows (Stage B: MetaMask)

  /**
   * Reserve `amountCenti` and return a voucher signed by the ledger signer, idempotent by requestId.
   * New vouchers are refused while the vault is paused, in escape mode, or signed by a key this process
   * does not hold (nothing is reserved then).
   */
  async issueVoucher(requestId: string, account: string, amountCenti: string): Promise<PlayerResult<{ voucher: VoucherRecord; created: boolean }>> {
    if (!isRequestId(requestId)) return { ok: false, status: 400, code: 'INVALID_REQUEST', message: 'Malformed requestId' };
    const existing = this.engine.voucherByRequest(requestId);
    if (!existing) {
      const vault = await this.readVault();
      if (vault?.escape.mode) return { ok: false, status: 409, code: 'VAULT_ESCAPE_MODE', message: 'The vault is in escape mode: vouchers are stopped; claim through the escape hatch (GET /v1/account/:address/proof)' };
      if (vault?.paused) return { ok: false, status: 409, code: 'VAULT_PAUSED', message: 'The vault is paused; withdrawals resume when it is unpaused' };
      if (vault && this.serverSigner && vault.ledgerSigner.toLowerCase() !== this.serverSigner) return { ok: false, status: 503, code: 'SIGNER_MISMATCH', message: 'The vault rotated its ledger signer; this server cannot sign vouchers until it restarts with the new key' };
    }
    // Expiry is counted from the chain clock the vault checks (block.timestamp), read before anything is reserved.
    const chainNow = existing ? this.chainNowS() : await this.chainTimeS();
    const r = this.engine.requestWithdrawal(requestId, account, amountCenti, chainNow);
    this.engine.flush();
    if (!r.ok) return { ok: false, status: r.code === 'REQUEST_CONFLICT' ? 409 : r.code === 'INSUFFICIENT_BALANCE' || r.code === 'ABOVE_VOUCHER_MAX' ? 422 : 400, code: r.code, message: r.message };
    if (r.voucher.status !== 'signing') return { ok: true, voucher: r.voucher, created: r.created };
    const signed = await this.signVoucher(r.voucher);
    return signed.ok ? { ok: true, voucher: signed.voucher, created: r.created } : signed;
  }
  private signVoucher(v: VoucherRecord): Promise<PlayerResult<{ voucher: VoucherRecord }>> {
    const inflight = this.signing.get(v.voucherId);
    if (inflight) return inflight;
    const run = (async (): Promise<PlayerResult<{ voucher: VoucherRecord }>> => {
      try {
        const signature = await this.chain.signWithdrawal({ account: v.account, amountWei: toWei(v.amountCenti), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry) });
        this.engine.attachVoucherSignature(v.voucherId, signature);
        this.engine.flush();
        return { ok: true, voucher: this.engine.vouchers.get(v.voucherId)! };
      } catch (error) {
        this.engine.cancelVoucher(v.voucherId, `signing failed: ${errorMessage(error)}`);
        this.engine.flush();
        const mismatch = chainErrorName(error) === 'SIGNER_MISMATCH' || chainErrorName(error) === 'SignerMismatch';
        return { ok: false, status: mismatch ? 503 : 502, code: mismatch ? 'SIGNER_MISMATCH' : 'SIGNING_FAILED', message: 'The voucher could not be signed; the amount was returned to the balance' };
      }
    })();
    this.signing.set(v.voucherId, run);
    void run.finally(() => this.signing.delete(v.voucherId));
    return run;
  }

  /** Voucher JSON for players: what MetaMask needs to call `withdraw(amount, nonce, expiry, signature)`. */
  voucherJson(v: VoucherRecord): Record<string, unknown> {
    const addr = this.chain.addresses();
    const amountWei = toWei(v.amountCenti).toString();
    return {
      voucherId: v.voucherId, requestId: v.requestId, status: v.status, account: v.account, amountCenti: v.amountCenti, amountWei, nonce: v.nonce, expiry: v.expiry, expiryMs: Number(v.expiry) * 1000,
      ...(v.signature && v.status === 'pending' ? { signature: v.signature } : {}), vault: addr.vault, chainId: this.chain.chainId, createdMs: v.createdMs,
      ...(v.submittedTxHash ? { submittedTxHash: v.submittedTxHash } : {}), ...(v.txHash ? { txHash: v.txHash } : {}), ...(v.claimBlock ? { claimBlock: v.claimBlock } : {}), ...(v.claimNote ? { claimNote: v.claimNote } : {}), ...(v.cancelReason ? { releaseReason: v.cancelReason } : {}),
    };
  }
  /** EIP-712 typed data of a voucher (domain, types, message) for wallet-side verification. */
  voucherTypedData(v: VoucherRecord): Record<string, unknown> {
    return {
      domain: { name: 'MayaHouseVault', version: '1', chainId: this.chain.chainId, verifyingContract: this.chain.addresses().vault },
      types: EIP712_TYPES, primaryType: 'Withdrawal', message: { account: v.account, amount: toWei(v.amountCenti).toString(), nonce: v.nonce, expiry: v.expiry },
    };
  }

  withdrawalsView(account: string): Record<string, unknown> {
    const a = account.toLowerCase();
    const player = this.engine.player(a);
    const rows = (player?.vouchers ?? []).map(id => this.engine.vouchers.get(id)!).reverse().map(v => this.voucherJson(v));
    const anomalies = this.engine.unmatchedWithdrawals().filter(w => w.player === a);
    return { account: a, registered: !!player, availableCenti: this.engine.availableBalance(a).toString(), rows, ...(anomalies.length ? { anomalies } : {}), vault: this.chain.addresses().vault, chainId: this.chain.chainId };
  }

  private escapeView(vault: VaultState | undefined): Record<string, unknown> | null {
    if (!vault) return null;
    const e = vault.escape, now = this.chainNowS();
    const left = e.availableAt - now;
    return {
      mode: e.mode, available: e.mode || left <= 0n, lastAttestationAtMs: Number(e.lastAttestationAt) * 1000, escapeDelaySec: Number(e.escapeDelay), availableAtMs: Number(e.availableAt) * 1000,
      secondsUntilAvailable: e.mode || left <= 0n ? 0 : Number(left), poolWei: e.poolWei.toString(), claimedWei: e.claimedWei.toString(),
    };
  }

  /**
   * Merkle proof of `address`'s leaf in the attested balance tree the vault currently holds (the frozen
   * root in escape mode), with the escape-hatch status. Fails closed (503) when that tree is not available.
   */
  async accountProof(address: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const account = address.toLowerCase();
    const vault = await this.readVault();
    const escape = this.escapeView(vault);
    const addr = this.chain.addresses();
    const head = { account, chainId: this.chain.chainId, vault: addr.vault };
    const va = vault?.lastAttestation;
    const la = this.engine.lastAttestation;
    const target = va ? { seq: va.seq, root: va.ledgerRoot, asOf: va.asOf, liabilitiesWei: va.liabilitiesWei, source: 'vault' as const } : la ? { seq: la.seq, root: la.ledgerRoot, asOf: la.asOf, liabilitiesWei: la.liabilitiesWei, source: 'journal' as const } : undefined;
    const owed = this.engine.owedWei(account);
    if (!target) return { status: 200, body: { ...head, attestation: null, included: false, balanceWei: '0', proof: [], currentOwedWei: owed.toString(), escape, note: 'No attestation yet: before the first root every account claims with attestedBalance 0 and no proof (its net deposits).' } };
    const attestation = { seq: target.seq.toString(), root: target.root.toLowerCase(), asOf: target.asOf.toString(), asOfMs: Number(target.asOf) * 1000, liabilitiesWei: target.liabilitiesWei.toString(), source: target.source, ...(la && la.seq === target.seq ? { txHash: la.txHash } : {}) };
    const stored = this.attestations.find(target.seq, target.root);
    if (!stored) return { status: 503, body: { ...head, error: { code: 'PROOF_UNAVAILABLE', message: `The balance tree for attestation ${target.seq} (${target.root}) is not available on this server` }, attestation, escape } };
    const balance = stored.tree.balanceOf(account);
    const proof = balance === undefined ? [] : [...stored.tree.proofFor(account)];
    if (balance !== undefined && !verifyBalanceProof(target.root, account, balance, proof)) return { status: 503, body: { ...head, error: { code: 'PROOF_UNAVAILABLE', message: 'The stored tree does not reproduce the attested root' }, attestation, escape } };
    let entitlementWei: string | undefined;
    const extras = this.chain as Partial<VaultOperatorExtras>;
    if (vault?.escape.mode && typeof extras.escapeEntitlement === 'function') {
      try { entitlementWei = (await extras.escapeEntitlement(account, balance ?? 0n)).toString(); } catch (error) { this.log(`house: escapeEntitlement(${account}) failed: ${errorMessage(error)}`); }
    }
    return {
      status: 200,
      body: {
        ...head, attestation, included: balance !== undefined, balanceWei: (balance ?? 0n).toString(), proof, currentOwedWei: owed.toString(),
        claim: { function: 'claimEscape(uint256,bytes32[])', attestedBalance: (balance ?? 0n).toString(), proof },
        escape: escape ? { ...escape, ...(entitlementWei !== undefined ? { entitlementWei } : {}) } : null,
        ...(balance === undefined ? { note: 'No leaf for this account in the attested tree: claim with attestedBalance 0 and an empty proof.' } : {}),
      },
    };
  }

  // ---------------------------------------------------------------- views

  overview(): Record<string, unknown> {
    const e = this.engine;
    const usage = e.limitUsage();
    const addr = this.chain.addresses();
    const markets = e.markets.map(id => {
      const latest = e.paths.get(id)!.latest();
      const grid = e.latestGrid(id)?.grid;
      return { id, enabled: true, paused: e.marketPaused(id), lastPriceMs: latest?.sourceTimeMs ?? 0, spot: latest?.priceText ?? '', sigma: finite(grid?.sigma ?? 0), tableId: e.tableInfo(id).tableId, quoteReason: grid?.reason ?? null };
    });
    const rolling = e.metrics.rolling; rolling.roll(e.nowMs);
    return {
      network: this.chain.network, chainId: this.chain.chainId, operator: addr.operator, vault: addr.vault, token: addr.token, ledgerSigner: addr.ledgerSigner,
      feedMode: this.feed.mode, speed: this.feed.mode === 'replay' ? e.sim.speed : 1, clockMs: e.nowMs,
      equityCenti: e.equity().toString(), playerBalancesCenti: e.ledger.total('player').toString(), openLiabilityCenti: e.openLiability().toString(),
      limitUsage: { global: finite(usage.global), maxColumn: finite(usage.maxColumn), maxCell: finite(usage.maxCell), maxAccount: finite(usage.maxAccount) },
      registeredPlayers: e.registeredPlayers, activePlayers5m: e.activePlayers(), launch: e.launchView(),
      // SPEC-12: tier, progress and budget used; a tripped per-tier budget breaker is listed with the breakers.
      promo: e.promoOverview(),
      breakers: [...e.breakerStatus(), ...e.promoBreakers()], markets,
      handle24hCenti: rolling.handle.toString(), ggr24hCenti: rolling.ggr.toString(), rtp24h: rolling.rtp, betsPerMin: e.metrics.perMinute.count(e.nowMs),
      pricing: e.pricingView(), limits: { ...e.limits },
      ...(this.feed.mode === 'replay' ? { sim: { ...e.sim } } : {}),
      equityOnchainCenti: e.equityOnchain().toString(), simPnlCenti: e.simPnl().toString(), simBalancesCenti: e.ledger.total('sim').toString(),
      simCreditIssuedCenti: e.simCreditIssuedCenti.toString(), dustWei: e.dustWei.toString(), openLegs: e.openLegCount, drawdown1h: finite(e.drawdown1h()),
      runId: e.runId, journalSeq: e.journalSeq, lastRefitMs: e.lastRefitMs ?? null, simArrived: this.simExisting + (this.crowd?.arrived ?? 0), simTarget: this.options.sim?.players ?? 0,
      feed: this.feed.status(),
      // SPEC-11 vault alerts from the latest health check (pending timelocks, signer mismatch, stale attestations).
      chainAlerts: this.chainAlertsNow.map(a => ({ code: a.code, level: a.level, message: a.message })),
      treasuryPending: this.treasuryView(),
      ...this.defenseOverview(),
    };
  }

  /** SPEC-10 overview additions: hold pressure, toxic-flow share and the adaptive edge per range. */
  private defenseOverview(): Record<string, unknown> {
    const e = this.engine, d = e.defenses;
    const lat = e.holdStats.latency();
    return {
      holdPending: e.holdPending, holdRejectRate: e.holdStats.rejectRate1h(e.nowMs), holdLatencyP95Ms: lat.p95,
      toxicFlowShare: e.flowShare.share1h(e.nowMs),
      defenses: { hold: d.hold.enabled, quoteValidity: d.quoteValidity.enabled, minLeadS: d.minLeadS, ramp: d.ramp.enabled, toxicity: d.toxicity.enabled ? 'graduated' : 'monitor', controller: d.controller.enabled, reference: d.reference.enabled && !!this.options.reference },
      controller: { enabled: d.controller.enabled, ranges: e.controller.state(e.nowMs, d.controller).map(r => ({ key: r.key, adjust: r.adjust, effective: r.effective, ...(r.override !== undefined ? { override: r.override } : {}), realized: r.realized, target: r.target, bets: r.bets })) },
    };
  }

  /** GET /admin-api/defenses: configuration and live defense metrics (engine) plus the reference feed. */
  defensesView(): Record<string, unknown> {
    return { ...this.engine.defensesView(), referenceFeed: this.options.reference ? this.options.reference.status() : null, clockMs: this.engine.nowMs };
  }

  async chainView(): Promise<Record<string, unknown>> {
    const addr = this.chain.addresses();
    const vault = await this.readVault();
    let operator: { ethWei: bigint; tokenWei: bigint } | undefined;
    let operatorError: string | undefined;
    try { operator = await this.chain.balances(addr.operator); } catch (error) { operatorError = errorMessage(error); this.log(`house: operator balance read failed: ${operatorError}`); }
    const centi = (wei: bigint) => fromWei(wei).centi;
    const pending = this.engine.pendingVouchers();
    const last = this.engine.lastAttestation;
    const vaultAtt = vault?.lastAttestation;
    const lastAttestation = vaultAtt ? {
      seq: Number(vaultAtt.seq), asOfMs: Number(vaultAtt.asOf) * 1000, liabilitiesCenti: centi(vaultAtt.liabilitiesWei), ledgerRoot: vaultAtt.ledgerRoot,
      ...(last && last.seq === vaultAtt.seq ? { txHash: last.txHash } : {}),
    } : last ? { seq: Number(last.seq), asOfMs: Number(last.asOf) * 1000, liabilitiesCenti: centi(last.liabilitiesWei), ledgerRoot: last.ledgerRoot, txHash: last.txHash } : null;
    const eta = (s: bigint) => ({ eta: s.toString(), etaMs: Number(s) * 1000 });
    const lastTree = last ? { leaves: last.leaves ?? null, leafTotalWei: last.leafTotalWei?.toString() ?? null, treeFile: last.treeFile ?? null, treeSha256: last.treeSha256 ?? null } : null;
    return {
      network: this.chain.network, chainId: this.chain.chainId,
      vault: vault ? {
        address: addr.vault, token: addr.token, paused: vault.paused, assetsCenti: centi(vault.assetsWei), houseFundedCenti: centi(vault.houseFundedWei),
        totalPlayerDepositsCenti: centi(vault.totalDepositsWei), totalPlayerWithdrawalsCenti: centi(vault.totalWithdrawalsWei), houseWithdrawnCenti: centi(vault.houseWithdrawnWei),
        surplusCenti: centi(vault.surplusWei), maxVoucherAmountCenti: centi(vault.maxVoucherAmountWei), dailyOutflowCapCenti: centi(vault.dailyOutflowCapWei),
        // SPEC-11 hardening
        ledgerSigner: vault.ledgerSigner.toLowerCase(), serverSigner: this.serverSigner ?? null, signerMismatch: !!this.serverSigner && vault.ledgerSigner.toLowerCase() !== this.serverSigner,
        pendingSigner: vault.pendingSigner ? { address: vault.pendingSigner.address.toLowerCase(), ...eta(vault.pendingSigner.eta), due: this.chainNowS() >= vault.pendingSigner.eta } : null,
        signerChangeDelaySec: Number(vault.signerChangeDelay),
        pendingSignerChangeDelay: vault.pendingSignerChangeDelay ? { delaySec: Number(vault.pendingSignerChangeDelay.delay), ...eta(vault.pendingSignerChangeDelay.eta) } : null,
        maxAttestationAgeSec: Number(vault.maxAttestationAge), houseBufferBps: Number(vault.houseBufferBps), houseDailyCapCenti: centi(vault.houseDailyCap),
        pendingHouseLimits: vault.pendingHouseLimits ? { houseBufferBps: Number(vault.pendingHouseLimits.houseBufferBps), houseDailyCapCenti: centi(vault.pendingHouseLimits.houseDailyCap), ...eta(vault.pendingHouseLimits.eta) } : null,
        houseWithdrawableCenti: centi(vault.houseWithdrawableWei), houseWithdrawableWei: vault.houseWithdrawableWei.toString(),
        excessWei: vault.excessWei.toString(), excessCenti: centi(vault.excessWei),
        escape: { ...this.escapeView(vault), poolCenti: centi(vault.escape.poolWei), claimedCenti: centi(vault.escape.claimedWei) },
      } : { address: addr.vault, token: addr.token, paused: false, assetsCenti: '0', houseFundedCenti: '0', totalPlayerDepositsCenti: '0', totalPlayerWithdrawalsCenti: '0', surplusCenti: '0', unavailable: true },
      lastAttestation: lastAttestation ? { ...lastAttestation, ...(last && vaultAtt && last.seq === vaultAtt.seq ? { tree: lastTree } : !vaultAtt ? { tree: lastTree } : {}) } : null,
      alerts: [...(vault ? this.computeAlerts(vault) : []), ...this.ledgerAlerts()].map(a => ({ code: a.code, level: a.level, message: a.message, ...(a.atS ? { atMs: Number(a.atS) * 1000 } : {}) })),
      withdrawals: { indexed: this.engine.chainWithdrawals.size, anomalies: this.engine.unmatchedWithdrawals().slice(-50) },
      // A failed read is reported as unavailable, never as real-looking zeros (a false low-gas warning, a funding plan capped at 0).
      operator: operator ? { address: addr.operator, ethWei: operator.ethWei.toString(), tokenCenti: centi(operator.tokenWei) } : { address: addr.operator, ethWei: null, tokenCenti: null, unavailable: true, error: operatorError ?? 'unavailable' },
      pendingVouchers: { count: pending.length, totalCenti: pending.reduce((s, v) => s + BigInt(v.amountCenti), 0n).toString(), items: pending.slice(0, 100).map(v => ({ voucherId: v.voucherId, account: v.account, amountCenti: v.amountCenti, nonce: v.nonce, expiryMs: Number(v.expiry) * 1000, status: v.status, ...(v.submittedTxHash ? { submittedTxHash: v.submittedTxHash } : {}) })) },
      indexer: { lagBlocks: this.chain.indexerLagBlocks() },
      reconciliation: vault ? this.engine.reconcile(vault) : null,
      // A treasury transaction whose outcome is not booked yet (a pending surplus withdrawal stays reserved against equity).
      treasury: { pending: this.treasuryView(), houseNetBookedWei: this.engine.houseNetBookedWei.toString() },
      explorer: { vault: this.chain.explorerUrl('address', addr.vault), token: this.chain.explorerUrl('address', addr.token), operator: this.chain.explorerUrl('address', addr.operator) },
      receipts: this.chainReceipts.slice(-50),
      centiWei: CENTI_WEI.toString(),
    };
  }
}
