import { OBSERVED_PATH_POLICY, decimalToString, parseDecimal, type CellTerms, type MarketId } from '@maya/contracts';
import { getMarket } from '@maya/config';
import {
  Breakers, CAP_RANGE, CENTI_WEI, DEFAULT_BREAKER_CONFIG, DEFAULT_DEFENSES, DEFAULT_RISK_LIMITS, EDGE_RANGE, EdgeController, EdgeSchedule, LiabilityBook, RANGE_KEYS, buildQuoteGrid,
  cellFairValue, changeDefenses, freezeDefenses, fromWei, HoldMoveBaseline, holdVerdict, isLaunchActive, legExposure, limitAmounts, maxStakeForLiability, payoutCenti, rampLimitCenti, resolveEdge,
  holdTolRelFor, toxicityDecision, validateDefenses, validateRiskLimits, type BreakerConfig, type BreakerEvent, type BreakerStatus, type CalibratedTable, type DefenseConfig, type DefensePatch,
  type EdgeScheduleChange, type EdgeScheduleConfig, type HousePricingConfig, type LaunchBoost, type LegExposure, type QuotingGate, type RiskLimits,
  PROMO_TIER_IDS, PromoLedger, boostRemainingCenti, changePromo, freezePromo, isPromoTierId, resolveTier, tierConfig, tierPricing, validatePromo,
  type PromoConfig, type PromoGuardChange, type PromoPatch, type PromoTierId, type ResolvedTier, type TierId, type TierPricing,
} from '@maya/house';
import type { ChainDeposit, ChainWithdrawal, VaultState } from '../chain-port.js';
import { buildBalanceTree } from '../chain/merkle.js';
import type { FeedSample } from '../feed/types.js';
import type { JournalSink } from '../ledger/journal.js';
import { ACCOUNTS, Ledger, type LedgerTx } from '../ledger/ledger.js';
import { PathStore } from '../market/path-store.js';
import { FlowShare, HoldStats, HouseMetrics } from '../metrics/metrics.js';
import { FRESHNESS_MS, MIN_LEAD_MS, QUOTE_TTL_MS, QuoteBook, type HouseQuote, type PublishedGrid, type QuoteVariant } from '../quotes/quote-book.js';
import type { TableRegistry } from '../refit/tables.js';
import { freezeDeep, isAddress, isPositiveCenti, isRequestId, sha256Hex, stableStringify } from '../util.js';
import { resolveCell } from './settlement.js';
import type {
  AccountKind, AdminMeta, BootFeed, AdminResult, AuditEntry, BetIntent, ConfigSnapshot, DepositRecord, EngineEvent, EngineNotice, EventInput, FlagAction, HoldDetail, HoldRecord, HoldView,
  HouseRejection, LegRecord, LegSettlement, LegView, PendingTreasury, PendingTreasuryAction, Phase, PlaceResult, PlayerFlagEntry, SimSettings, TreasuryResolution, VoucherRecord,
  WithdrawalOutcome, WithdrawalRecord,
} from './types.js';

export interface EngineLimits extends RiskLimits { readonly maxStakePerBetCenti: string; readonly maxStakePerCellCenti: string }
export const DEFAULT_ENGINE_LIMITS: EngineLimits = Object.freeze({ ...DEFAULT_RISK_LIMITS, maxStakePerBetCenti: '1000000', maxStakePerCellCenti: '5000000' });

export interface EngineConfig {
  readonly markets: readonly MarketId[];
  readonly pricing: HousePricingConfig;
  readonly schedule: EdgeScheduleConfig;
  readonly limits: EngineLimits;
  readonly breakers?: BreakerConfig;
  /** Smallest accepted stake (Centi). */
  readonly minStakeCenti?: string;
  /** Price-move guard: reject when |spot − quoted spot| > guardSigma × sigma × spot × √age. */
  readonly guardSigma?: number;
  readonly quoteTtlMs?: number;
  readonly minLeadMs?: number;
  readonly freshnessMs?: number;
  readonly receiptCapacity?: number;
  readonly rejectionCapacity?: number;
  readonly settledCapacity?: number;
  readonly voucherTtlS?: number;
  readonly pathRetentionS?: number;
  readonly maxVoucherAmountCenti?: string;
  readonly sim?: SimSettings;
  /** Toxicity monitor: auto-flag an account whose excess return z-score exceeds zThreshold after minBets settled bets (false disables). */
  readonly toxicity?: { readonly minBets: number; readonly zThreshold: number } | false;
  /**
   * SPEC-10 defenses (acceptance hold, quote validity, minimum lead, account ramp, graduated
   * toxicity, adaptive edge, reference guard). Omitted means the production defaults (all on); the
   * graduated toxicity policy replaces the Stage A monitor above while enabled.
   */
  readonly defenses?: DefenseConfig;
  /**
   * SPEC-12 promo tiers (launch → growth → scale → standard), replacing the single launch boost of `schedule`.
   * Production (bootstrap.engineConfig) always passes one. Omitted = the legacy launch boost (Stage A behaviour,
   * kept for the Stage A test suite and old tooling). A journal's own promo config wins over this one; a journal
   * written before SPEC-12 is migrated to it at open (journaled `config` + audit).
   */
  readonly promo?: PromoConfig;
}

export interface EngineOptions {
  readonly config: EngineConfig;
  readonly journal: JournalSink;
  readonly tables: TableRegistry;
  readonly runId: string;
  readonly bootId: string;
  readonly startMs?: number;
}

export interface PlayerRecord {
  readonly account: string;
  readonly ledgerAccount: string;
  readonly kind: AccountKind;
  readonly strategy?: string;
  readonly firstSeenMs: number;
  readonly via: string;
  flagged: boolean;
  blocked: boolean;
  handle: bigint;
  settledStake: bigint;
  returned: bigint;
  bets: number;
  openBets: number;
  wins: number;
  lastBetMs: number;
  settledBets: number;
  /** Σ stake·m·p and Σ stake²·m²·p(1−p) over settled legs (toxicity monitor). */
  expectedReturn: number;
  returnVariance: number;
  /** Latency evidence: held placements with a fresh fair value and Σ (clamped move − population mean at the time). */
  holdN: number;
  holdMoveSum: number;
  /** Σ (clamped move − population mean)² (the account's own dispersion, for a robust z). */
  holdMoveSumSq: number;
  /** Held placements ever created for the account (the new-account tolerance ramp counts these). */
  holdsPlaced: number;
  readonly recentLegs: string[];
  readonly deposits: DepositRecord[];
  readonly vouchers: string[];
  readonly flags: PlayerFlagEntry[];
  readonly cellStakes: Map<string, bigint>;
}

/** The latest attestation journaled by this ledger (balance-tree fields absent for Stage A journals). */
export interface AttestationRecord {
  readonly seq: bigint;
  readonly liabilitiesWei: bigint;
  readonly ledgerRoot: string;
  readonly asOf: bigint;
  readonly txHash: string;
  readonly atMs: number;
  readonly leaves?: number;
  readonly leafTotalWei?: bigint;
  readonly treeFile?: string;
  readonly treeSha256?: string;
}

/**
 * Voucher nonce: a uint256 (< 2^248) derived from the run, the process boot that issued it and the voucher
 * id. The vault accepts any unused (account, nonce) once ever, so a fresh journal on a vault that outlives it
 * (Base Sepolia) must not reuse the small counters of an earlier run: a collision would either revert as
 * NonceAlreadyUsed or let an old voucher's `Withdrawn` event claim a new voucher. The boot id covers the
 * same hazard inside one run: if an OS crash ever cut an acknowledged voucher from the journal tail, the
 * rebuilt ledger (a new boot) issues `V<n>` again under a different nonce, never the spent one. The nonce is
 * journaled in the `voucher` event, so a rebuild stays exact. Without `bootId` this is the Stage A formula.
 */
export function voucherNonce(runId: string, voucherId: string, bootId?: string): string {
  const input = bootId === undefined ? `maya-voucher-nonce:${runId}:${voucherId}` : `maya-voucher-nonce:${runId}:${bootId}:${voucherId}`;
  return BigInt(`0x${sha256Hex(input).slice(0, 62)}`).toString();
}

interface Receipt { readonly intentKey: string; readonly legId: string }
interface RejectionReceipt { readonly intentKey: string; readonly result: PlaceResult }
interface CellWatch { readonly cell: CellTerms; readonly legIds: Set<string> }
interface MarketTables { current: CalibratedTable; previousId?: string; builtMs: number; source: 'published' | 'refit' }

export interface PricingView { readonly standardEdge: number; readonly capX100: number; readonly aboveCap: 'hide' | 'cap'; readonly impactK: number; readonly z: number }
export interface LaunchView { readonly enabled: boolean; readonly active: boolean; readonly edge: number; readonly untilPlayers: number; readonly standardEdge: number }

const RECENT_PER_PLAYER = 100;
export const TOXICITY_ACTOR = 'toxicity-monitor';
export const CONTROLLER_ACTOR = 'edge-controller';
/** SPEC-12 actors of system audit entries: the per-tier budget guard and the legacy-journal migration. */
export const PROMO_GUARD_ACTOR = 'promo-guard';
export const PROMO_MIGRATION_ACTOR = 'promo-migration';
/** Confirm phrases of the SPEC-12 admin actions (SPEC §7 convention: the exact action name). */
export const PROMO_CONFIRM = Object.freeze({ endTier: 'promo-end-tier', resume: 'promo-resume', edgeChange: 'edge-change' });

/** Why a promo tier stopped being current (for the tier log). */
function describeTierEnd(config: PromoConfig, from: TierId, players: number, turnover: bigint): string {
  const t = tierConfig(config, from);
  if (!t) return 'configuration change';
  if (!t.enabled) return 'ended early by admin';
  if (players >= t.untilPlayers) return `${t.untilPlayers} registered players reached`;
  if (turnover >= BigInt(t.untilTurnoverCenti)) return `${t.untilTurnoverCenti} Centi turnover reached`;
  return 'configuration change';
}
/** A held placement is never accepted with less than this lead left on its square. */
export const HOLD_ACCEPT_MIN_LEAD_MS = 1000;
const FRESH_LOG = 32;

/** Excess return of an account in standard errors: (returned − expected) / √variance. */
export function excessReturnZ(p: Pick<PlayerRecord, 'returned' | 'expectedReturn' | 'returnVariance'>): number {
  return p.returnVariance > 0 ? (Number(p.returned) - p.expectedReturn) / Math.sqrt(p.returnVariance) : 0;
}
const EDGE_DANGER = 0.02;
const EPS = 1e-9;

function intentKey(i: BetIntent): string { return stableStringify([i.requestId, i.account, i.quoteId, i.revision ?? null, i.cellId, i.stakeCenti]); }
function reject(reason: HouseRejection, message?: string, extra: { limit?: import('@maya/house').LimitKind } = {}): PlaceResult {
  return freezeDeep({ status: 'rejected', reason, ...(message === undefined ? {} : { message }), ...extra });
}
function fail(status: number, code: string, message: string): AdminResult { return { ok: false, status, code, message }; }

/** Public account id → ledger account (`player:<address>` or `sim:<id>`); undefined when malformed. */
export function ledgerAccountOf(account: string): { ledgerAccount: string; kind: AccountKind; account: string } | undefined {
  if (isAddress(account)) { const a = account.toLowerCase(); return { ledgerAccount: `player:${a}`, kind: 'onchain', account: a }; }
  if (/^sim:[A-Za-z0-9._-]{1,64}$/.test(account)) return { ledgerAccount: account, kind: 'sim', account };
  return undefined;
}

/**
 * The house: quotes, placement, settlement, ledger, risk and admin state for one process. Every
 * state change is a journaled event applied through `apply`, so replaying the journal rebuilds
 * exactly the same state. All methods are synchronous; the caller flushes the journal before
 * acknowledging anything.
 */
export class HouseEngine {
  readonly runId: string;
  readonly bootId: string;
  readonly markets: readonly MarketId[];
  readonly ledger = new Ledger();
  readonly book = new LiabilityBook();
  readonly quotes: QuoteBook;
  readonly metrics = new HouseMetrics();
  readonly paths = new Map<MarketId, PathStore>();
  readonly players = new Map<string, PlayerRecord>();
  readonly deposits = new Map<string, DepositRecord>();
  readonly vouchers = new Map<string, VoucherRecord>();
  private readonly vouchersByRequest = new Map<string, string>();
  private readonly tables = new Map<MarketId, MarketTables>();
  private readonly registry: TableRegistry;
  private readonly journal: JournalSink;
  private breakers: Breakers;
  private latchedDrawdown: { state: 'widened' | 'paused'; since: number; reason: string } | undefined;
  private schedule: EdgeSchedule;
  private pricingConfig: HousePricingConfig;
  private limitsConfig: EngineLimits;
  private readonly breakerConfig: BreakerConfig;
  private simSettings: SimSettings;
  private readonly openLegs = new Map<string, LegRecord>();
  private readonly openCells = new Map<string, CellWatch>();
  private readonly settled = new Map<string, LegView>();
  private readonly settledOrder: string[] = [];
  private settledHead = 0;
  private readonly receipts = new Map<string, Receipt>();
  private readonly receiptOrder: string[] = [];
  private receiptHead = 0;
  private readonly rejections = new Map<string, RejectionReceipt>();
  private readonly audit: AuditEntry[] = [];
  private readonly listeners = new Set<(n: EngineNotice) => void>();
  private readonly cfg: Required<Omit<EngineConfig, 'markets' | 'pricing' | 'schedule' | 'limits' | 'breakers' | 'sim' | 'toxicity' | 'defenses' | 'promo'>>;
  private readonly toxicity: { readonly minBets: number; readonly zThreshold: number } | false;
  private seq = 0;
  private legSeq = 0;
  private voucherSeq = 0;
  private treasurySeq = 0;
  private auditSeq = 0;
  private registered = 0;
  private flaggedCount = 0;
  private onchainOpenLiability = 0n;
  private totalDustWei = 0n;
  private simCreditIssued = 0n;
  /** House flows the ledger booked, in wei (Σ fund + sync − withdraw-surplus): the vault's houseFunded − houseWithdrawn when nothing is missing. */
  private houseNetBooked = 0n;
  private pendingOp: PendingTreasury | undefined;
  private replaying = false;
  private clock: number;
  private lastDeadlineSec = -1;
  private lastPathPruneMs = 0;
  private launchActive: boolean | undefined;
  readonly phaseLog: { atMs: number; phase: Phase; registered: number }[] = [];
  lastAttestation: AttestationRecord | undefined;
  /** Vault `Withdrawn` events applied, by `player:nonce` (idempotency and the player/admin views). */
  readonly chainWithdrawals = new Map<string, WithdrawalRecord>();
  private readonly vouchersByNonce = new Map<string, string>();
  lastRefitMs: number | undefined;
  /** Solvency checks evaluated at every acceptance (should stay 0). */
  solvencyViolations = 0;
  minEquitySeen: bigint | undefined;
  private defensesConfig: DefenseConfig;
  /** Adaptive edge per multiplier range (SPEC-10 §6); adjustments are journaled `controller` events. */
  readonly controller = new EdgeController();
  private nextControllerEvalMs: number | undefined;
  readonly holdStats = new HoldStats();
  /** Population baseline of the hold's fair-value move (latency evidence), rebuilt from hold events. */
  readonly holdBaseline = new HoldMoveBaseline();
  readonly flowShare = new FlowShare();
  private readonly holds = new Map<string, HoldRecord>();
  private readonly holdsByMarket = new Map<MarketId, Set<string>>();
  private readonly pendingStake = new Map<string, bigint>();
  private readonly pendingCellStake = new Map<string, bigint>();
  /** Recent (second, first-observed-at) per market: when each newer first-seen sample arrived. */
  private readonly freshLog = new Map<MarketId, { t: number; atMs: number }[]>();
  private readonly referenceInvalid = new Map<MarketId, { t: number; atMs: number }>();
  referenceInvalidations = 0;
  lastReferenceMs: number | undefined;
  /** Relative fair-value move (p_fresh / p_quote − 1) at the end of each fresh-sample hold, per strategy (analysis only). */
  readonly holdMoves = new Map<string, number[]>();
  /** SPEC-12 promo tiers (undefined = legacy launch boost). */
  private promoConfig: PromoConfig | undefined;
  /** Whether the promo config came from the journal (a boot snapshot or a config event) rather than from the process. */
  private promoFromJournal = false;
  /** Per-tier turnover, boosted turnover per account, settled aggregates and budget-guard state (rebuilt from events). */
  readonly promoLedger = new PromoLedger();
  /** Cumulative accepted stake since launch (every leg; never reset): the turnover that ends promo tiers. */
  private turnoverCenti = 0n;
  /** Boosted stake reserved by held placements, by `account|tier`. */
  private readonly pendingBoost = new Map<string, bigint>();
  private currentTierId: TierId | undefined;
  /** Tier transitions (derived from journaled events, so a rebuild reproduces it). */
  readonly tierLog: { atMs: number; tier: TierId; players: number; turnoverCenti: string; cause: string }[] = [];
  private nextPromoEvalMs: number | undefined;
  /** Boosted grid cells priced and hidden below the tier's minimum win, per tier (live quoting only; analysis). */
  readonly promoGridStats = new Map<TierId, { grids: number; priced: number; offered: number; hiddenMinWin: number; lowestX100: number | null }>();

  constructor(options: EngineOptions) {
    const c = options.config;
    this.runId = options.runId; this.bootId = options.bootId; this.markets = Object.freeze([...c.markets]);
    this.journal = options.journal; this.registry = options.tables;
    this.clock = options.startMs ?? 0;
    this.breakerConfig = c.breakers ?? DEFAULT_BREAKER_CONFIG;
    this.breakers = new Breakers(this.markets, this.breakerConfig, this.clock);
    this.schedule = new EdgeSchedule(c.schedule);
    this.pricingConfig = Object.freeze({ ...c.pricing });
    const limitError = validateRiskLimits(c.limits);
    if (limitError) throw new RangeError(limitError);
    this.limitsConfig = Object.freeze({ ...c.limits });
    this.simSettings = Object.freeze({ ...(c.sim ?? { running: false, speed: 1, arrivalsPerMin: 0 }) });
    this.cfg = {
      minStakeCenti: c.minStakeCenti ?? '10', guardSigma: c.guardSigma ?? 3, quoteTtlMs: c.quoteTtlMs ?? QUOTE_TTL_MS, minLeadMs: c.minLeadMs ?? MIN_LEAD_MS,
      freshnessMs: c.freshnessMs ?? FRESHNESS_MS, receiptCapacity: c.receiptCapacity ?? 500_000, rejectionCapacity: c.rejectionCapacity ?? 100_000,
      settledCapacity: c.settledCapacity ?? 50_000, voucherTtlS: c.voucherTtlS ?? 3600, pathRetentionS: c.pathRetentionS ?? 37 * 3600,
      maxVoucherAmountCenti: c.maxVoucherAmountCenti ?? '10000000',
    };
    this.toxicity = c.toxicity === undefined ? { minBets: 50, zThreshold: 4 } : c.toxicity;
    const defenses = c.defenses ?? DEFAULT_DEFENSES;
    const defenseError = validateDefenses(defenses);
    if (defenseError) throw new RangeError(`Invalid defenses: ${defenseError}`);
    this.defensesConfig = freezeDefenses(defenses);
    if (c.promo) {
      const promoError = validatePromo(c.promo);
      if (promoError) throw new RangeError(`Invalid promo: ${promoError}`);
      this.promoConfig = freezePromo(c.promo);
    }
    this.quotes = new QuoteBook();
    for (const m of this.markets) {
      this.paths.set(m, new PathStore(m));
      const table = this.registry.publishedFor(m);
      if (!table) throw new Error(`No published table loaded for ${m}`);
      this.tables.set(m, { current: table, builtMs: 0, source: 'published' });
    }
  }

  // ---------------------------------------------------------------- lifecycle and journal

  /** Rebuild from journal records (if any), then journal a boot record. */
  open(records: readonly EngineEvent[] = [], feed?: BootFeed): void {
    if (records.length) {
      this.replaying = true;
      try { for (const r of records) this.applyRecord(r); } finally { this.replaying = false; }
      this.commit({ type: 'boot', runId: this.runId, bootId: this.bootId, version: 1, markets: this.markets, ...(feed ? { feed } : {}) });
      // SPEC-12 migration: a journal written before the promo tiers priced with the single launch boost. The configured
      // tiers replace it from now on (turnover and players count from the journal's own history), journaled with an audit entry.
      if (this.promoConfig && !this.promoFromJournal) {
        const legacy = this.schedule.config.launch;
        this.commit({ type: 'config', target: 'promo', after: this.promoConfig });
        this.commit({ type: 'audit', entry: this.auditEntry({ kind: 'system', actor: PROMO_MIGRATION_ACTOR, action: 'promo-migrated', before: { launch: { ...legacy } }, after: this.promoConfig,
          reason: `journal predates the SPEC-12 promo tiers: the single launch boost (${legacy.enabled ? `edge ${legacy.edge} until ${legacy.untilPlayers} players` : 'disabled'}) is replaced by the configured tiers; tier progress counts ${this.registered} registered players and ${this.turnoverCenti} Centi of turnover from the journal`, result: 'ok' }) });
      }
      // Quotes do not survive a restart, so a placement still held in the journal can only be rejected.
      for (const h of [...this.holds.values()]) this.commitHoldRejection(h, 'QUOTE_EXPIRED', 'restart', 'The server restarted during the acceptance hold; issued quotes do not survive a restart');
    } else {
      this.commit({ type: 'boot', runId: this.runId, bootId: this.bootId, version: 1, markets: this.markets, config: this.configSnapshot(), ...(feed ? { feed } : {}) });
      for (const m of this.markets) this.commit({ type: 'table', market: m, tableId: this.tables.get(m)!.current.id, source: 'published' });
    }
    this.trackPhase();
    this.nextControllerEvalMs = this.clock + this.defensesConfig.controller.evalEveryMs;
    if (this.promoConfig) this.nextPromoEvalMs = this.clock + this.promoConfig.guard.evalEveryMs;
    this.journal.flush();
  }

  on(listener: (n: EngineNotice) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(n: EngineNotice): void {
    if (this.replaying) return;
    for (const l of this.listeners) { try { l(n); } catch { /* observers never affect committed state */ } }
  }
  /** Forward an app-level notice (refit progress, chain alerts) to stream listeners. */
  notice(n: EngineNotice): void { this.notify(n); }
  /** Pin recorded history before the replay start (warm-up for volatility and refit); not journaled. */
  warm(samples: readonly FeedSample[]): number {
    let n = 0;
    for (const s of samples) { const path = this.paths.get(s.market); if (path?.pin(s).pinned) n++; }
    return n;
  }
  alert(level: 'info' | 'warning' | 'critical', message: string, code?: string): void {
    this.notify({ type: 'alert', data: { level, message, ms: this.clock, ...(code ? { code } : {}) } });
  }

  get nowMs(): number { return this.clock; }
  get journalSeq(): number { return this.seq; }
  flush(): void { this.journal.flush(); }

  private commit(input: EventInput): EngineEvent {
    const record = { ...input, seq: this.seq + 1, atMs: this.clock } as EngineEvent;
    // Decided before apply: a settlement or hold resolution still sees its open leg or hold.
    const durable = this.isDurable(record);
    this.applyRecord(record);
    this.journal.append(record, durable);
    return record;
  }

  /**
   * Whether a record must reach stable storage before the flush that carries it returns (FileJournal fsyncs
   * it): every money move and everything acknowledged to a player, the operator or the chain (deposits,
   * vouchers and their signatures, redemptions, treasury moves, attestations, admin changes, on-chain bets,
   * holds and settlements). Feed samples, tables, controller steps, system audit entries and simulated
   * (sim-credit) flow are not: they are replayable or off-chain, so they are the only tail an OS crash can cut.
   */
  private isDurable(e: EngineEvent): boolean {
    switch (e.type) {
      case 'deposit': case 'voucher': case 'voucher-signed': case 'voucher-cancelled': case 'voucher-claimed': case 'voucher-submitted': case 'voucher-expired':
      case 'withdrawal': case 'treasury': case 'treasury-pending': case 'treasury-unknown': case 'treasury-released': case 'attest':
      case 'config': case 'player-flag': case 'breaker': case 'sim': case 'promo-guard':
        return true;
      case 'audit': return e.entry.kind === 'admin';
      case 'register': return e.kind === 'onchain';
      case 'bet': return e.leg.kind === 'onchain';
      case 'hold': return e.hold.kind === 'onchain';
      case 'hold-resolved': return this.holds.get(e.requestId)?.kind === 'onchain';
      case 'settle': return this.openLegs.get(e.legId)?.kind === 'onchain';
      default: return false;
    }
  }

  private applyRecord(e: EngineEvent): void {
    if (e.seq !== this.seq + 1) throw new Error(`Journal sequence gap at ${e.seq} (expected ${this.seq + 1})`);
    this.seq = e.seq;
    if (e.atMs > this.clock) this.clock = e.atMs;
    switch (e.type) {
      case 'boot': if (e.config) { this.applyConfigSnapshot(e.config); this.trackPhase(); } break;
      case 'sample': this.applySample(e); break;
      case 'table': this.applyTable(e); break;
      case 'register': this.applyRegister(e.account, e.kind, e.via, e.atMs, e.strategy); break;
      case 'deposit': this.applyDeposit(e); break;
      case 'sim-credit': this.post({ kind: 'sim-credit', ref: e.grantId, atMs: e.atMs, postings: [{ account: ACCOUNTS.simCredit, delta: -BigInt(e.amountCenti) }, { account: e.account, delta: BigInt(e.amountCenti) }] }); this.simCreditIssued += BigInt(e.amountCenti); break;
      case 'bet': this.applyBet(e.leg, e.intentKey); break;
      case 'settle': this.applySettle(e); break;
      case 'voucher': this.applyVoucher(e); break;
      case 'voucher-signed': { const v = this.vouchers.get(e.voucherId)!; v.signature = e.signature; v.status = 'pending'; break; }
      case 'voucher-cancelled': this.applyVoucherCancel(e.voucherId, e.reason, e.atMs); break;
      case 'voucher-claimed': this.applyVoucherClaim(e.voucherId, e.txHash, e.atMs); break;
      case 'voucher-submitted': this.vouchers.get(e.voucherId)!.submittedTxHash = e.txHash; break;
      case 'voucher-expired': this.applyVoucherExpired(e.voucherId, e.reason, e.atMs); break;
      case 'withdrawal': this.applyWithdrawal(e); break;
      case 'treasury': this.applyTreasury(e); break;
      case 'treasury-pending': this.treasurySeq = Math.max(this.treasurySeq, Number(e.opId.slice(1)) || 0); this.pendingOp = Object.freeze({ opId: e.opId, action: e.action, amountCenti: e.amountCenti, actor: e.actor, startedMs: e.atMs, state: 'sending' }); break;
      case 'treasury-unknown': if (this.pendingOp?.opId === e.opId) this.pendingOp = Object.freeze({ ...this.pendingOp, state: 'unknown', ...(e.txHash ? { txHash: e.txHash } : {}), note: e.reason }); break;
      case 'treasury-released': if (this.pendingOp?.opId === e.opId) this.pendingOp = undefined; break;
      case 'attest': this.lastAttestation = {
        seq: BigInt(e.attestSeq), liabilitiesWei: BigInt(e.liabilitiesWei), ledgerRoot: e.ledgerRoot, asOf: BigInt(e.asOf), txHash: e.txHash, atMs: e.atMs,
        ...(e.leaves !== undefined ? { leaves: e.leaves } : {}), ...(e.leafTotalWei !== undefined ? { leafTotalWei: BigInt(e.leafTotalWei) } : {}), ...(e.treeFile ? { treeFile: e.treeFile } : {}), ...(e.treeSha256 ? { treeSha256: e.treeSha256 } : {}),
      }; break;
      case 'config': this.applyConfig(e.target, e.after); break;
      case 'player-flag': this.applyFlag(e.account, e.action, e.atMs, e.actor, e.reason); break;
      case 'breaker': this.applyBreaker(e.event); break;
      case 'audit': this.audit.push(e.entry); this.auditSeq = Math.max(this.auditSeq, Number(e.entry.id.slice(1)) || 0); if (this.audit.length > 20_000) this.audit.splice(0, this.audit.length - 20_000); break;
      case 'sim': this.simSettings = Object.freeze({ ...e.settings }); break;
      case 'hold': this.applyHold(e.hold); break;
      case 'hold-resolved': this.applyHoldResolved(e); break;
      case 'controller': this.controller.apply(e.key, e.after, e.atMs); break;
      case 'promo-guard': this.promoLedger.applyGuard(e.change, e.atMs); this.trackPhase(); break;
    }
  }

  private post(tx: LedgerTx): void {
    const r = this.ledger.post(tx);
    if (!r.ok) throw new Error(`Ledger rejected ${tx.kind} ${tx.ref}: ${r.reason}${r.account ? ` (${r.account})` : ''}`);
  }

  // ---------------------------------------------------------------- configuration

  configSnapshot(): ConfigSnapshot { return freezeDeep({ pricing: { ...this.pricingConfig }, schedule: this.schedule.config, limits: { ...this.limitsConfig }, defenses: this.defensesConfig, ...(this.promoConfig ? { promo: this.promoConfig } : {}) }); }
  private applyConfigSnapshot(c: ConfigSnapshot): void {
    this.pricingConfig = Object.freeze({ ...c.pricing });
    this.schedule = new EdgeSchedule(c.schedule);
    this.limitsConfig = Object.freeze({ ...(c.limits as EngineLimits) });
    // Journals from before SPEC-10 carry no defenses: keep the configured (fail-safe) set.
    if (c.defenses) this.defensesConfig = freezeDefenses(c.defenses);
    // Journals from before SPEC-12 carry no promo: the configured tiers replace the launch boost at open (migration).
    if (c.promo) { this.promoConfig = freezePromo(c.promo); this.promoFromJournal = true; }
  }
  private applyConfig(target: 'pricing' | 'schedule' | 'limits' | 'defenses' | 'promo', after: unknown): void {
    if (target === 'pricing') this.pricingConfig = Object.freeze({ ...(after as HousePricingConfig) });
    else if (target === 'schedule') this.schedule = new EdgeSchedule(after as EdgeScheduleConfig);
    else if (target === 'defenses') this.defensesConfig = freezeDefenses(after as DefenseConfig);
    else if (target === 'promo') { this.promoConfig = freezePromo(after as PromoConfig); this.promoFromJournal = true; }
    else this.limitsConfig = Object.freeze({ ...(after as EngineLimits) });
    this.trackPhase();
  }
  get defenses(): DefenseConfig { return this.defensesConfig; }
  /** Surcharge applied to flagged accounts: the schedule's flowEdge or, while graduated toxicity is on, its surcharge edge. */
  flowEdgeActive(): number { const t = this.defensesConfig.toxicity; return Math.max(this.schedule.config.flowEdge, t.enabled ? t.surchargeEdge : 0); }
  /** Minimum lead between the quote instant / request and a square's start (ms). */
  minLeadMs(): number { return Math.max(this.cfg.minLeadMs, this.defensesConfig.minLeadS * 1000); }
  get pricing(): HousePricingConfig { return this.pricingConfig; }
  get limits(): EngineLimits { return this.limitsConfig; }
  get edgeSchedule(): EdgeScheduleConfig { return this.schedule.config; }
  get sim(): SimSettings { return this.simSettings; }
  get registeredPlayers(): number { return this.registered; }
  /** Limits handed to @maya/house: the per-cell stake cap is enforced per account here instead. */
  private houseLimits(): RiskLimits {
    const { maxStakePerCellCenti: _unused, ...rest } = this.limitsConfig;
    return rest;
  }
  pricingView(): PricingView {
    const p = this.pricingConfig;
    return { standardEdge: this.schedule.config.standard, capX100: p.capX100, aboveCap: p.aboveCap, impactK: p.impactK, z: p.z };
  }
  /**
   * The console's launch-boost view. With SPEC-12 promo tiers it is derived for compatibility: enabled = the promo
   * switch, active = a promo tier is current, edge = the current tier's base edge (negative: −lossBudget + guard),
   * untilPlayers = the current (or last) tier's player threshold.
   */
  launchView(): LaunchView {
    const s = this.schedule.config;
    if (this.promoConfig) {
      const r = this.currentTier(), pricing = this.currentPricing();
      const until = r.untilPlayers ?? this.promoConfig.tiers.at(-1)!.untilPlayers;
      return { enabled: this.promoConfig.enabled, active: r.tier !== 'standard', edge: r.tier !== 'standard' ? pricing.baseEdge : s.standard, untilPlayers: until, standardEdge: s.standard };
    }
    return { enabled: s.launch.enabled, active: isLaunchActive(s, this.registered), edge: s.launch.edge, untilPlayers: s.launch.untilPlayers, standardEdge: s.standard };
  }
  private trackPhase(): void {
    // Promo mode: the legacy phase is "a promo tier is current"; tier transitions are logged apart (tierLog).
    const active = this.promoConfig ? this.trackTier() !== 'standard' : isLaunchActive(this.schedule.config, this.registered);
    if (active === this.launchActive) return;
    this.launchActive = active;
    this.phaseLog.push({ atMs: this.clock, phase: active ? 'launch' : 'standard', registered: this.registered });
    if (!active && this.phaseLog.length > 1 && !this.promoConfig) this.alert('info', `Launch boost ended at ${this.registered} registered players`, 'LAUNCH_ENDED');
  }

  // ---------------------------------------------------------------- promo tiers (SPEC-12)

  /** Whether SPEC-12 promo tiers price new quotes (false: the legacy launch boost). */
  get promoMode(): boolean { return this.promoConfig !== undefined; }
  get promo(): PromoConfig | undefined { return this.promoConfig; }
  /** Cumulative accepted stake since launch (never reset). */
  get turnover(): bigint { return this.turnoverCenti; }
  /** The current tier from registered players and cumulative turnover (legacy mode: standard). */
  currentTier(): ResolvedTier {
    if (!this.promoConfig) return { tier: 'standard', label: 'Standard odds', untilPlayers: null, untilTurnoverCenti: null };
    return resolveTier(this.promoConfig, { players: this.registered, turnoverCenti: this.turnoverCenti });
  }
  /** Pricing parameters for new quotes: the current tier's boosted edge, or standard (incl. a tripped budget breaker). */
  currentPricing(): TierPricing {
    const r = this.currentTier();
    return tierPricing(r, this.schedule.config.standard, this.promoLedger.guard(r.tier));
  }
  /** Record a tier transition (called after every state change that can move the tier); returns the current tier. */
  private trackTier(): TierId {
    const r = this.currentTier();
    if (r.tier === this.currentTierId) return r.tier;
    const from = this.currentTierId;
    this.currentTierId = r.tier;
    const cause = from === undefined ? 'start' : !this.promoConfig?.enabled ? 'promo disabled' : describeTierEnd(this.promoConfig, from, this.registered, this.turnoverCenti);
    this.tierLog.push({ atMs: this.clock, tier: r.tier, players: this.registered, turnoverCenti: this.turnoverCenti.toString(), cause });
    if (from !== undefined) this.alert('info', `Promo tier ${from} → ${r.tier} at ${this.registered} registered players and ${this.turnoverCenti} Centi turnover (${cause})`, 'PROMO_TIER_CHANGED');
    return r.tier;
  }
  /** Per-account boost cap of a tier (undefined for standard or legacy mode). */
  boostCapCenti(tier: TierId): bigint | undefined {
    const t = this.promoConfig ? tierConfig(this.promoConfig, tier) : undefined;
    return t ? BigInt(t.perAccountBoostCapCenti) : undefined;
  }
  /** Boosted turnover the account may still place in `tier` (default: the current tier); null when no boost applies. */
  boostRemaining(account: string, tier: TierId = this.currentTier().tier): bigint | null {
    const cap = this.boostCapCenti(tier);
    if (cap === undefined) return null;
    return boostRemainingCenti(cap, this.promoLedger.boostUsed(tier, account), this.pendingBoost.get(`${account}|${tier}`) ?? 0n);
  }
  /**
   * Which grid an account is quoted from. Legacy: the flagged grid for flagged accounts (with a surcharge), else main.
   * Promo: flagged accounts never get boosted odds (the flagged grid, or the standard grid without a surcharge); an
   * account whose boost allowance is below the minimum stake gets the standard grid while main is boosted.
   */
  accountVariant(account: string | undefined): QuoteVariant {
    const p = account ? this.players.get(account) : undefined;
    const surcharged = !!p?.flagged && this.flowEdgeActive() > 0;
    if (!this.promoConfig) return surcharged ? 'flagged' : 'main';
    if (surcharged) return 'flagged';
    const pricing = this.currentPricing();
    if (!pricing.boosted || !p) return 'main';
    if (p.flagged) return 'standard';
    const left = this.boostRemaining(p.account, pricing.tier);
    return left !== null && left < BigInt(this.cfg.minStakeCenti) ? 'standard' : 'main';
  }
  /** The latest grid of `market` the account is quoted from (anonymous callers: main). */
  gridFor(account: string | undefined, market: MarketId): PublishedGrid | undefined {
    const variant = this.accountVariant(account);
    if (variant === 'flagged') return this.quotes.latestGrid(market, true);
    return (variant === 'standard' ? this.quotes.latestVariant(market, 'standard') : undefined) ?? this.quotes.latestGrid(market, false);
  }
  /** Largest stake the account's boost allowance allows on `quote` (undefined when the quote is not boosted). */
  boostStakeCap(account: string, quote: Pick<HouseQuote, 'boosted' | 'tier'>): bigint | undefined {
    if (!quote.boosted || quote.tier === undefined) return undefined;
    return this.boostRemaining(account, quote.tier) ?? 0n;
  }

  // ---------------------------------------------------------------- equity and risk views

  equityOnchain(): bigint { return this.ledger.balance(ACCOUNTS.equity); }
  simPnl(): bigint { return this.ledger.balance(ACCOUNTS.simPnl); }
  /** Live house equity E for limits and breakers: bankroll plus the house result against sim players. */
  equity(): bigint { return this.equityOnchain() + this.simPnl(); }
  /** Amount of a pending surplus withdrawal (reserved until booked or released; 0 otherwise). */
  treasuryReservedCenti(): bigint { return this.pendingOp?.action === 'withdraw-surplus' ? BigInt(this.pendingOp.amountCenti) : 0n; }
  /**
   * Equity the risk engine may commit (liability limits, solvency at acceptance): live equity minus a pending
   * surplus withdrawal, which may already have left (or be about to leave) the vault. Breakers keep
   * `equity()`; the withdrawal reaches them as a treasury flow once booked.
   */
  riskEquity(): bigint { return this.equity() - this.treasuryReservedCenti(); }
  /** Real bankroll free of open on-chain liability and of a pending surplus withdrawal. */
  freeOnchainEquity(): bigint { return this.equityOnchain() - this.treasuryReservedCenti() - this.onchainOpenLiability; }
  /** The house treasury operation whose outcome is not booked yet, if any. */
  get pendingTreasury(): PendingTreasury | undefined { return this.pendingOp; }
  /** House flows booked by this ledger in wei (fund + sync − withdraw-surplus). */
  get houseNetBookedWei(): bigint { return this.houseNetBooked; }
  openLiability(): bigint { return this.book.globalLiability(); }
  get openLegCount(): number { return this.openLegs.size; }
  get dustWei(): bigint { return this.totalDustWei; }
  get simCreditIssuedCenti(): bigint { return this.simCreditIssued; }

  gate(market: MarketId): QuotingGate {
    const g = this.breakers.quoting(market);
    if (!g.allowed || !this.latchedDrawdown) return g;
    return this.latchedDrawdown.state === 'paused' ? { allowed: false, reason: 'market-paused', breaker: 'drawdown' } : { allowed: true, drawdownWidened: true };
  }
  breakerStatus(): readonly BreakerStatus[] {
    return this.breakers.status().map(s => (s.id === 'drawdown' && s.state === 'ok' && this.latchedDrawdown ? { id: s.id, state: this.latchedDrawdown.state, since: this.latchedDrawdown.since, reason: `${this.latchedDrawdown.reason} (restored from journal)` } : s));
  }
  drawdown1h(): number { return this.breakers.drawdown(); }
  marketPaused(market: MarketId): boolean { const g = this.gate(market); return !g.allowed && g.reason === 'market-paused'; }

  // ---------------------------------------------------------------- feed, quotes, settlement

  /**
   * Advance the clock, pin delivered samples, run breakers and settlement, and issue a new quote grid
   * for every market whose latest second advanced. Returns the grids published this step.
   */
  step(nowMs: number, samples: readonly FeedSample[] = []): PublishedGrid[] {
    if (nowMs > this.clock) this.clock = nowMs;
    const fresh = new Set<MarketId>();
    const touched = new Map<MarketId, number[]>();
    for (const s of samples) {
      const path = this.paths.get(s.market);
      if (!path || path.has(s.t)) { if (path) path.pin(s); continue; }
      const prevLatest = path.latest()?.t ?? Number.NEGATIVE_INFINITY;
      this.commit({ type: 'sample', market: s.market, t: s.t, price: s.priceText, receivedAtMs: s.receivedAtMs });
      if (s.t > prevLatest) fresh.add(s.market);
      let list = touched.get(s.market); if (!list) { list = []; touched.set(s.market, list); } list.push(s.t);
    }
    for (const m of this.markets) for (const ev of this.breakers.observeFeed(m, this.paths.get(m)!.latest()?.sourceTimeMs, this.clock)) this.commitBreaker(ev);
    this.observeEquity();
    this.settleTouched(touched);
    const sec = Math.floor(this.clock / 1000);
    if (sec !== this.lastDeadlineSec) { this.lastDeadlineSec = sec; this.settleDeadlines(); }
    const grids: PublishedGrid[] = [];
    for (const m of fresh) { this.noteFresh(m); grids.push(...this.publishGrids(m)); }
    if (this.holds.size) { for (const m of fresh) this.resolveHolds(m); this.expireHolds(); }
    this.maybeEvaluateController();
    this.maybeEvaluatePromoGuard();
    this.quotes.prune(this.clock);
    if (this.clock - this.lastPathPruneMs >= 600_000) { this.lastPathPruneMs = this.clock; this.prunePaths(); }
    this.metrics.maybeSample(this.clock, () => ({ equity: this.equity(), openLiability: this.book.globalLiability(), players: this.registered }));
    return grids;
  }

  private observeEquity(): void {
    const e = this.equity();
    if (this.minEquitySeen === undefined || e < this.minEquitySeen) this.minEquitySeen = e;
    for (const ev of this.breakers.observeEquity(e, this.clock)) this.commitBreaker(ev);
  }

  private commitBreaker(ev: BreakerEvent): void {
    this.commit({ type: 'breaker', event: ev });
    const entry = this.auditEntry({ kind: 'breaker', actor: ev.actor, action: `breaker:${ev.id}:${ev.to}`, ...(ev.market ? { target: ev.market } : {}), before: ev.from, after: ev.to, reason: ev.reason });
    this.commit({ type: 'audit', entry });
    this.notify({ type: 'breaker', data: ev });
    if (ev.to !== 'ok') this.alert(ev.id === 'feedStale' ? 'warning' : 'critical', `${ev.id}${ev.market ? ` ${ev.market}` : ''}: ${ev.reason}`, `BREAKER_${ev.id.toUpperCase()}`);
  }

  private applyBreaker(ev: BreakerEvent): void {
    if (!this.replaying) return;
    // Replay admin transitions through the state machine; automatic feed/equity states recompute live.
    const meta = { actor: ev.actor, atMs: ev.atMs, reason: ev.reason || 'replayed' };
    if (ev.id === 'manual') {
      if (ev.market) void (ev.to === 'paused' ? this.breakers.pauseMarket(ev.market, meta) : this.breakers.resumeMarket(ev.market, meta));
      else void (ev.to === 'paused' ? this.breakers.pauseAll(meta) : this.breakers.resumeAll(meta));
    }
    if (ev.id === 'drawdown') this.latchedDrawdown = ev.to === 'ok' ? undefined : { state: ev.to === 'paused' ? 'paused' : 'widened', since: ev.atMs, reason: ev.reason };
  }

  private applySample(e: Extract<EngineEvent, { type: 'sample' }>): void {
    const path = this.paths.get(e.market);
    if (!path) throw new Error(`Sample for unknown market ${e.market}`);
    const r = path.pin({ t: e.t, priceText: e.price, price: parseDecimal(e.price), value: Number(e.price), receivedAtMs: e.receivedAtMs });
    if (!r.pinned && !this.replaying) throw new Error('Sample already pinned');
  }

  private applyTable(e: Extract<EngineEvent, { type: 'table' }>): void {
    const table = this.registry.resolve(e.tableId, e.file);
    const slot = this.tables.get(e.market);
    if (!slot) return;
    if (!table) { this.alert('critical', `Table ${e.tableId} for ${e.market} could not be reloaded; keeping ${slot.current.id}`, 'TABLE_MISSING'); return; }
    if (table.id === slot.current.id) return;
    this.tables.set(e.market, { current: table, previousId: slot.current.id, builtMs: e.atMs, source: e.source });
    if (e.source === 'refit') this.lastRefitMs = e.atMs;
  }

  tableInfo(market: MarketId): { tableId: string; previousTableId?: string; builtMs: number; source: 'published' | 'refit'; trainedThrough: string } {
    const t = this.tables.get(market)!;
    return { tableId: t.current.id, ...(t.previousId ? { previousTableId: t.previousId } : {}), builtMs: t.builtMs, source: t.source, trainedThrough: t.current.trainedThrough };
  }
  currentTable(market: MarketId): CalibratedTable { return this.tables.get(market)!.current; }

  /** Publish a new table for new quotes; issued quotes keep their terms. */
  publishTable(market: MarketId, table: CalibratedTable, file: string | undefined, rows: number, actor = 'system'): string {
    this.registry.register(table);
    const before = this.tables.get(market)?.current.id;
    this.commit({ type: 'table', market, tableId: table.id, ...(file ? { file } : {}), source: 'refit', rows });
    const entry = this.auditEntry({ kind: 'system', actor, action: 'table-published', target: market, before, after: table.id, result: `${rows} quote instants` });
    this.commit({ type: 'audit', entry });
    this.notify({ type: 'admin-action', data: entry });
    return entry.id;
  }

  private publishGrids(market: MarketId): PublishedGrid[] {
    const path = this.paths.get(market)!;
    const latest = path.latest();
    if (!latest) return [];
    if (this.promoConfig) return this.publishPromoGrids(market, path, latest);
    const flow = this.flowEdgeActive();
    const variants = flow > 0 && this.flaggedCount > 0 ? [false, true] : [false];
    const schedule = flow === this.schedule.config.flowEdge ? this.schedule.config : { ...this.schedule.config, flowEdge: flow };
    const d = this.defensesConfig;
    const rangeAdjust = this.controller.effective(d.controller);
    const ttlMs = d.quoteValidity.enabled ? d.quoteValidity.maxTtlMs : this.cfg.quoteTtlMs;
    return variants.map(flagged => {
      const grid = buildQuoteGrid({
        market, t: latest.t, spot: latest.price, path, table: this.tables.get(market)!.current, pricing: this.pricingConfig, schedule,
        registeredPlayers: this.registered, flagged, limits: this.houseLimits(), book: this.book, equityCenti: this.riskEquity(), gate: this.gate(market),
        nowMs: this.clock, feedStaleMs: this.breakerConfig.feedStaleMs, minLeadS: d.minLeadS, ...(Object.keys(rangeAdjust).length ? { rangeAdjust } : {}),
      });
      return this.quotes.publish(grid, { generatedAtMs: this.clock, sourceSampleId: latest.sampleId, spotText: latest.priceText, flagged, bootId: this.bootId, ttlMs, minLeadMs: this.minLeadMs(), freshnessMs: this.cfg.freshnessMs });
    });
  }

  /**
   * SPEC-12 grids: main (boosted odds while a tier is current and its budget breaker is not tripped, else standard),
   * standard (only while main is boosted: accounts past their boost cap and unsurcharged flagged accounts) and flagged
   * (standard pricing plus the flow surcharge: flagged accounts never get boosted odds). Defenses apply to all of them.
   */
  private publishPromoGrids(market: MarketId, path: PathStore, latest: NonNullable<ReturnType<PathStore['latest']>>): PublishedGrid[] {
    const pricing = this.currentPricing();
    const standardEdge = this.schedule.config.standard;
    const flow = this.flowEdgeActive();
    const d = this.defensesConfig;
    const rangeAdjust = this.controller.effective(d.controller);
    const ttlMs = d.quoteValidity.enabled ? d.quoteValidity.maxTtlMs : this.cfg.quoteTtlMs;
    const variants: { variant: QuoteVariant; boosted: boolean }[] = [{ variant: 'main', boosted: pricing.boosted }];
    if (pricing.boosted) variants.push({ variant: 'standard', boosted: false });
    if (flow > 0 && this.flaggedCount > 0) variants.push({ variant: 'flagged', boosted: false });
    return variants.map(({ variant, boosted }) => {
      const flagged = variant === 'flagged';
      const schedule = flagged && flow !== this.schedule.config.flowEdge ? { ...this.schedule.config, flowEdge: flow } : this.schedule.config;
      const promo = boosted ? { tier: pricing.tier, boosted: true, baseEdge: pricing.baseEdge, minWinX100: pricing.minWinX100! } : { tier: pricing.tier, boosted: false, baseEdge: standardEdge };
      const grid = buildQuoteGrid({
        market, t: latest.t, spot: latest.price, path, table: this.tables.get(market)!.current, pricing: this.pricingConfig, schedule,
        registeredPlayers: this.registered, flagged, limits: this.houseLimits(), book: this.book, equityCenti: this.riskEquity(), gate: this.gate(market),
        nowMs: this.clock, feedStaleMs: this.breakerConfig.feedStaleMs, minLeadS: d.minLeadS, ...(Object.keys(rangeAdjust).length ? { rangeAdjust } : {}), promo,
      });
      if (boosted) this.noteBoostedGrid(pricing.tier, grid);
      return this.quotes.publish(grid, {
        generatedAtMs: this.clock, sourceSampleId: latest.sampleId, spotText: latest.priceText, flagged, variant, bootId: this.bootId, ttlMs, minLeadMs: this.minLeadMs(), freshnessMs: this.cfg.freshnessMs,
        promo: { tier: pricing.tier, boosted, guardAdjust: boosted ? pricing.guardAdjust : 0 },
      });
    });
  }
  /** Analysis only: how many priced cells a boosted grid offers and hides below the tier's minimum win. */
  private noteBoostedGrid(tier: TierId, grid: import('@maya/house').QuoteGrid): void {
    if (grid.reason) return;
    let s = this.promoGridStats.get(tier);
    if (!s) { s = { grids: 0, priced: 0, offered: 0, hiddenMinWin: 0, lowestX100: null }; this.promoGridStats.set(tier, s); }
    s.grids++;
    for (const c of grid.cells) {
      if (c.p === undefined) continue;
      s.priced++;
      if (c.available) { s.offered++; if (s.lowestX100 === null || c.x100 < s.lowestX100) s.lowestX100 = c.x100; }
      else if (c.reason === 'below-minimum') s.hiddenMinWin++;
    }
  }

  /** Remember when a newer first-seen second of `market` was first observed (quote validity). */
  private noteFresh(market: MarketId): void {
    const latest = this.paths.get(market)!.latest();
    if (!latest) return;
    let log = this.freshLog.get(market);
    if (!log) { log = []; this.freshLog.set(market, log); }
    log.push({ t: latest.t, atMs: this.clock });
    if (log.length > FRESH_LOG) log.splice(0, log.length - FRESH_LOG);
  }

  /**
   * Time from which a quote no longer stands (SPEC-10 §2): the first observation of a newer
   * first-seen second plus the grace, or a reference-feed invalidation. Undefined while it stands.
   */
  quoteSupersededAt(quote: Pick<HouseQuote, 'market' | 't'>): number | undefined {
    const v = this.defensesConfig.quoteValidity;
    let at: number | undefined;
    if (v.enabled) {
      const next = this.freshLog.get(quote.market)?.find(f => f.t > quote.t);
      if (next) at = next.atMs + v.graceMs;
      else if ((this.paths.get(quote.market)?.latest()?.t ?? quote.t) > quote.t) at = Number.NEGATIVE_INFINITY; // superseded before the log began
    }
    const ref = this.referenceInvalid.get(quote.market);
    if (ref && ref.t >= quote.t && this.defensesConfig.reference.enabled) at = at === undefined ? ref.atMs : Math.min(at, ref.atMs);
    return at;
  }

  /** Whether a quote can still be accepted now (TTL, lead and supersession). */
  quoteStands(quote: HouseQuote): boolean {
    const now = this.clock + this.feedUncertaintyMs;
    if (now >= quote.validUntilMs || quote.generatedAtMs > now) return false;
    const at = this.quoteSupersededAt(quote);
    return at === undefined || now < at;
  }

  /**
   * Sub-second reference price (e.g. Pyth Hermes) for early invalidation: when it has moved beyond
   * moveSigma·σ·√Δt from the latest first-seen price, that market's standing quotes stop at once.
   * Live mode only; it never prices or settles anything.
   */
  observeReference(market: MarketId, value: number, publishTimeMs: number): boolean {
    this.lastReferenceMs = this.clock;
    const r = this.defensesConfig.reference;
    const latest = this.paths.get(market)?.latest();
    const sigma = this.latestGrid(market)?.grid.sigma;
    if (!r.enabled || !latest || sigma === undefined || !(value > 0) || !Number.isFinite(value) || publishTimeMs < latest.sourceTimeMs) return false;
    const dt = Math.max(1, (publishTimeMs - latest.sourceTimeMs) / 1000);
    if (!(Math.abs(Math.log(value / latest.value)) > r.moveSigma * sigma * Math.sqrt(dt))) return false;
    const prior = this.referenceInvalid.get(market);
    if (prior && prior.t === latest.t) return false;
    this.referenceInvalid.set(market, { t: latest.t, atMs: this.clock });
    this.referenceInvalidations++;
    return true;
  }

  latestGrid(market: MarketId, flagged = false): PublishedGrid | undefined { return this.quotes.latestGrid(market, flagged); }

  private settleTouched(touched: Map<MarketId, number[]>): void {
    if (!touched.size || !this.openCells.size) return;
    for (const watch of [...this.openCells.values()]) {
      const secs = touched.get(watch.cell.marketId);
      if (!secs) continue;
      const lo = watch.cell.startMs / 1000 - 1, hi = watch.cell.endMs / 1000;
      if (secs.some(t => t >= lo && t <= hi)) this.resolveWatch(watch);
    }
  }
  private settleDeadlines(): void {
    const view = this.clock - this.feedUncertaintyMs;
    for (const watch of [...this.openCells.values()]) if (view >= watch.cell.endMs + OBSERVED_PATH_POLICY.lateArrivalGraceMs) this.resolveWatch(watch);
  }
  feedUncertaintyMs = 0;

  private resolveWatch(watch: CellWatch): void {
    const outcome = resolveCell(watch.cell, this.paths.get(watch.cell.marketId)!, { nowMs: this.clock, uncertaintyMs: this.feedUncertaintyMs });
    if (!outcome) return;
    for (const legId of [...watch.legIds]) {
      const leg = this.openLegs.get(legId)!;
      const credit = outcome.status === 'won' ? leg.payoutCenti : outcome.status === 'refunded' ? leg.stakeCenti : '0';
      this.commit({ type: 'settle', legId, status: outcome.status, creditCenti: credit, evidence: outcome.evidenceSampleIds, ...(outcome.status === 'won' ? { touchTimeMs: outcome.touchTimeMs } : {}), reason: outcome.reason });
      const view = this.settled.get(legId);
      if (view) this.notify({ type: 'settlement', data: view });
      this.checkToxicity(leg.account);
    }
  }

  private prunePaths(): void {
    let floorT = Math.floor(this.clock / 1000) - this.cfg.pathRetentionS;
    for (const watch of this.openCells.values()) floorT = Math.min(floorT, watch.cell.startMs / 1000 - 2);
    for (const p of this.paths.values()) p.prune(floorT);
  }

  // ---------------------------------------------------------------- accounts and funding

  player(account: string): PlayerRecord | undefined { return this.players.get(account); }

  private applyRegister(account: string, kind: AccountKind, via: string, atMs: number, strategy?: string): void {
    if (this.players.has(account)) throw new Error(`Account ${account} already registered`);
    const ids = ledgerAccountOf(account);
    if (!ids || ids.kind !== kind) throw new Error(`Invalid account ${account}`);
    this.players.set(account, {
      account, ledgerAccount: ids.ledgerAccount, kind, ...(strategy ? { strategy } : {}), firstSeenMs: atMs, via, flagged: false, blocked: false,
      handle: 0n, settledStake: 0n, returned: 0n, bets: 0, openBets: 0, wins: 0, lastBetMs: 0, settledBets: 0, expectedReturn: 0, returnVariance: 0, holdN: 0, holdMoveSum: 0, holdMoveSumSq: 0, holdsPlaced: 0, recentLegs: [], deposits: [], vouchers: [], flags: [], cellStakes: new Map(),
    });
    this.registered++;
    this.trackPhase();
  }

  /** Register on sign-in (players) or arrival (sim). Idempotent. */
  register(account: string, via: 'sign-in' | 'sim', strategy?: string): { ok: true; account: string; created: boolean } | { ok: false; code: string } {
    const ids = ledgerAccountOf(account);
    if (!ids) return { ok: false, code: 'INVALID_ACCOUNT' };
    if ((via === 'sim') !== (ids.kind === 'sim')) return { ok: false, code: 'INVALID_ACCOUNT' };
    if (this.players.has(ids.account)) return { ok: true, account: ids.account, created: false };
    this.commit({ type: 'register', account: ids.account, kind: ids.kind, via, ...(strategy ? { strategy } : {}) });
    return { ok: true, account: ids.account, created: true };
  }

  /** Credit an on-chain deposit exactly once per `txHash:logIndex`; wei dust is kept and reported. */
  creditDeposit(d: ChainDeposit): { ok: true; duplicate: boolean; record: DepositRecord } | { ok: false; code: string } {
    if (!isAddress(d.player) || typeof d.amountWei !== 'bigint' || d.amountWei <= 0n || !/^0x[0-9a-fA-F]{64}$/.test(d.txHash) || !Number.isSafeInteger(d.logIndex) || d.logIndex < 0) return { ok: false, code: 'INVALID_DEPOSIT' };
    const key = `${d.txHash.toLowerCase()}:${d.logIndex}`;
    const existing = this.deposits.get(key);
    if (existing) return { ok: true, duplicate: true, record: existing };
    const account = d.player.toLowerCase();
    if (!this.players.has(account)) this.commit({ type: 'register', account, kind: 'onchain', via: 'deposit' });
    const { centi, dustWei } = fromWei(d.amountWei);
    this.commit({ type: 'deposit', account, key, amountWei: d.amountWei.toString(), centi, dustWei: dustWei.toString(), depositId: d.depositId.toString(), txHash: d.txHash.toLowerCase(), logIndex: d.logIndex, blockNumber: d.blockNumber.toString() });
    return { ok: true, duplicate: false, record: this.deposits.get(key)! };
  }
  private applyDeposit(e: Extract<EngineEvent, { type: 'deposit' }>): void {
    const player = this.players.get(e.account)!;
    if (BigInt(e.centi) > 0n) this.post({ kind: 'deposit', ref: e.key, atMs: e.atMs, postings: [{ account: ACCOUNTS.vault, delta: -BigInt(e.centi) }, { account: player.ledgerAccount, delta: BigInt(e.centi) }] });
    const record: DepositRecord = freezeDeep({ key: e.key, account: e.account, amountWei: e.amountWei, centi: e.centi, dustWei: e.dustWei, depositId: e.depositId, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, ms: e.atMs });
    this.deposits.set(e.key, record); player.deposits.push(record);
    this.totalDustWei += BigInt(e.dustWei);
  }

  /** Off-chain sim credit for a synthetic player (never mixed with on-chain funds). */
  grantSimCredit(account: string, amountCenti: string, grantId: string): boolean {
    const p = this.players.get(account);
    if (!p || p.kind !== 'sim' || !isPositiveCenti(amountCenti)) return false;
    this.commit({ type: 'sim-credit', account, amountCenti, grantId });
    return true;
  }

  balanceOf(account: string): bigint { const p = this.players.get(account); return p ? this.ledger.balance(p.ledgerAccount) : 0n; }

  // ---------------------------------------------------------------- placement

  /**
   * §1 placement: idempotent by requestId, resolves the stored quote, checks funds, limits and
   * guards. With the acceptance hold on (SPEC-10 §1) a placement that passes answers `pending` and
   * is decided at the next first-seen sample; the same requestId returns the pending (then the
   * final) result.
   */
  placeBet(raw: BetIntent): PlaceResult {
    if (!raw || !isRequestId(raw.requestId) || typeof raw.account !== 'string' || typeof raw.quoteId !== 'string' || raw.quoteId.length > 200 || typeof raw.cellId !== 'string' || raw.cellId.length > 300
      || typeof raw.stakeCenti !== 'string' || (raw.revision !== undefined && !Number.isSafeInteger(raw.revision))) return reject('INVALID_REQUEST', 'Malformed placement intent');
    const ids = ledgerAccountOf(raw.account);
    if (!ids) return reject('INVALID_REQUEST', 'Malformed account');
    const intent: BetIntent = { requestId: raw.requestId, account: ids.account, quoteId: raw.quoteId, ...(raw.revision !== undefined ? { revision: raw.revision } : {}), cellId: raw.cellId, stakeCenti: raw.stakeCenti };
    const key = intentKey(intent);
    const receipt = this.receipts.get(intent.requestId);
    if (receipt) {
      if (receipt.intentKey !== key) return reject('REQUEST_CONFLICT', 'requestId was used for a different intent');
      return freezeDeep({ status: 'accepted', leg: this.legView(receipt.legId)!, newlyCommitted: false });
    }
    const prior = this.rejections.get(intent.requestId);
    if (prior) return prior.intentKey === key ? prior.result : reject('REQUEST_CONFLICT', 'requestId was used for a different intent');
    const held = this.holds.get(intent.requestId);
    if (held) return held.intentKey === key ? this.pendingResult(held, false) : reject('REQUEST_CONFLICT', 'requestId was used for a different intent');
    const result = this.evaluate(intent, key, ids.ledgerAccount, ids.kind);
    if (result.status === 'rejected') this.rememberRejection(intent.requestId, key, result);
    return result;
  }

  private rememberRejection(requestId: string, key: string, result: PlaceResult): void {
    this.rejections.set(requestId, { intentKey: key, result });
    if (this.rejections.size > this.cfg.rejectionCapacity) this.rejections.delete(this.rejections.keys().next().value!);
  }

  /**
   * Flagged accounts must use their own (surcharged) grid, and nobody else may use it. SPEC-12: a flagged account is
   * never accepted at boosted odds (quote identity unchanged: the check only refuses, it never re-prices).
   */
  private variantMismatch(player: PlayerRecord, quote: HouseQuote): string | undefined {
    if (player.flagged && this.flowEdgeActive() > 0 && !quote.flagged) return 'Flagged accounts must use their own quote grid';
    if (!player.flagged && quote.flagged) return 'Quote belongs to the flagged grid';
    if (player.flagged && quote.boosted) return 'Flagged accounts are quoted at standard odds (no promo boost)';
    return undefined;
  }

  /**
   * SPEC-12 per-account boost cap at acceptance: a boosted quote is accepted only while the stake fits the account's
   * remaining allowance in the quote's tier (cap − boosted turnover − stakes reserved by other held placements). The
   * accepted odds are always the quoted ones; past the cap the account is quoted from the standard grid instead.
   * `ownReserved` is the stake this very hold already reserved.
   */
  private boostCapRejection(player: PlayerRecord, quote: HouseQuote, stake: bigint, ownReserved = 0n): string | undefined {
    if (!quote.boosted || quote.tier === undefined) return undefined;
    const left = (this.boostRemaining(player.account, quote.tier) ?? 0n) + ownReserved;
    if (stake <= left) return undefined;
    return left < BigInt(this.cfg.minStakeCenti)
      ? `The ${quote.tier} promo allowance of this account is used up: request quotes again for standard odds`
      : `Stake exceeds the remaining ${quote.tier} promo allowance of ${left} Centi for boosted odds`;
  }

  /** Price-move guard: |spot_now − quoted spot| > guardSigma × sigma × quoted spot × √age, once a newer price exists. */
  private guardMoved(quote: HouseQuote, latest: { readonly t: number; readonly value: number }): boolean {
    if (latest.t <= quote.t) return false;
    const spot = Number(quote.spotText);
    return Math.abs(latest.value - spot) > this.cfg.guardSigma * quote.sigma * spot * Math.sqrt(latest.t - quote.t);
  }

  private evaluate(intent: BetIntent, key: string, ledgerAccount: string, kind: AccountKind): PlaceResult {
    const player = this.players.get(intent.account);
    if (!player) return reject('UNKNOWN_ACCOUNT', 'Account has not signed in or deposited');
    if (player.blocked) return reject('ACCOUNT_BLOCKED', 'Account is blocked from betting');
    if (!/^[1-9]\d{0,29}$/.test(intent.stakeCenti)) return reject('STAKE_NOT_ALLOWED', 'Stake must be a positive integer Centi amount');
    const stake = BigInt(intent.stakeCenti);
    if (stake < BigInt(this.cfg.minStakeCenti)) return reject('STAKE_NOT_ALLOWED', `Minimum stake is ${this.cfg.minStakeCenti} Centi`);
    if (stake > BigInt(this.limitsConfig.maxStakePerBetCenti)) return reject('STAKE_NOT_ALLOWED', `Maximum stake per bet is ${this.limitsConfig.maxStakePerBetCenti} Centi`);
    const quote = this.quotes.get(intent.quoteId);
    if (!quote || quote.cellId !== intent.cellId || (intent.revision !== undefined && intent.revision !== quote.revision)) return reject('QUOTE_CHANGED', 'Quote is unknown or does not match the cell');
    const variant = this.variantMismatch(player, quote);
    if (variant) return reject('QUOTE_CHANGED', variant);
    const boostCap = this.boostCapRejection(player, quote, stake);
    if (boostCap) return reject('STAKE_NOT_ALLOWED', boostCap);
    const now = this.clock, unc = this.feedUncertaintyMs;
    // The square's own lead time is the more specific reason, so it is checked before the quote TTL.
    if (quote.cell.startMs - (now + unc) < this.minLeadMs()) return reject('TOO_LATE', 'The square starts in less than the minimum lead time');
    if (now + unc >= quote.validUntilMs || quote.generatedAtMs > now + unc) return reject('QUOTE_EXPIRED');
    const superseded = this.quoteSupersededAt(quote);
    if (superseded !== undefined && now + unc >= superseded) return reject('QUOTE_EXPIRED', 'A newer price was observed since this quote was issued');
    const gate = this.gate(quote.market);
    if (!gate.allowed) return gate.reason === 'stale-source' ? reject('INPUT_NOT_READY', 'Price feed is stale') : reject('MARKET_PAUSED', `Quoting is paused (${gate.breaker})`);
    const latest = this.paths.get(quote.market)!.latest();
    if (!latest) return reject('INPUT_NOT_READY');
    if (this.guardMoved(quote, latest)) return reject('PRICE_MOVED', 'Price moved beyond the guard since the quote');
    const pending = this.pendingStake.get(intent.account) ?? 0n;
    if (this.ledger.balance(ledgerAccount) - pending < stake) return reject('INSUFFICIENT_BALANCE');
    const cellStake = (player.cellStakes.get(quote.cellId) ?? 0n) + (this.pendingCellStake.get(`${intent.account}|${quote.cellId}`) ?? 0n);
    if (cellStake + stake > BigInt(this.limitsConfig.maxStakePerCellCenti)) return reject('CELL_CAP_EXCEEDED', `Per-square stake cap is ${this.limitsConfig.maxStakePerCellCenti} Centi`);
    const prepared = this.prepareLeg(intent.requestId, intent.account, intent.stakeCenti, ledgerAccount, kind, player, quote, now, {});
    if (!prepared.ok) return prepared.result;
    const hold = this.defensesConfig.hold;
    if (!hold.enabled) return this.commitLeg(prepared.leg, key);
    this.commit({ type: 'hold', hold: {
      requestId: intent.requestId, intentKey: key, account: intent.account, ledgerAccount, kind, quoteId: quote.quoteId, cellId: quote.cellId, market: quote.market,
      stakeCenti: intent.stakeCenti, x100: quote.x100, pQuote: quote.p, requestedMs: now, requestT: latest.t, deadlineMs: now + hold.maxHoldMs,
      ...(quote.boosted && quote.tier !== undefined && isPromoTierId(quote.tier) ? { boostTier: quote.tier } : {}),
    } });
    return this.pendingResult(this.holds.get(intent.requestId)!, true);
  }

  /** Liability limits (with the new-account ramp) and solvency; builds the leg without committing it. */
  private prepareLeg(requestId: string, account: string, stakeCenti: string, ledgerAccount: string, kind: AccountKind, player: PlayerRecord, quote: HouseQuote, now: number,
    extras: Partial<Pick<LegRecord, 'requestedMs' | 'pFresh'>>): { ok: true; leg: LegRecord } | { ok: false; result: PlaceResult; detail: HoldDetail } {
    const legSeq = this.legSeq + 1;
    const legId = `L${legSeq}`;
    const exposure: LegExposure = legExposure({ legId, account: ledgerAccount, cell: quote.cell, stakeCenti, x100: quote.x100 });
    // A pending surplus withdrawal is reserved: bets accepted while its attest/withdraw transactions are in flight
    // must be covered by what stays in the vault afterwards.
    const E = this.riskEquity();
    const check = this.book.canAccept(exposure, E, this.houseLimits());
    if (!check.ok) {
      if (check.reason === 'LIABILITY_LIMIT') return { ok: false, result: reject('LIABILITY_LIMIT', `${check.limit} liability limit reached`, { limit: check.limit }), detail: 'limit' };
      if (check.reason === 'STAKE_NOT_ALLOWED' || check.reason === 'CELL_CAP_EXCEEDED') return { ok: false, result: reject(check.reason), detail: 'limit' };
      return { ok: false, result: reject('STATE_NOT_READY', check.reason), detail: 'limit' };
    }
    const ramp = this.defensesConfig.ramp;
    if (ramp.enabled) {
      const limit = rampLimitCenti(check.limits.account, { settledBets: player.settledBets, settledHandleCenti: player.settledStake }, ramp);
      if (this.book.accountLiability(ledgerAccount) + exposure.liabilityCenti > limit) return { ok: false, result: reject('LIABILITY_LIMIT', `New-account ramp: account liability limit is ${limit} Centi until more bets settle`, { limit: 'account' }), detail: 'ramp' };
    }
    // Invariant 6 at acceptance: equity covers every open liability, and real bankroll covers on-chain legs.
    if (E - this.book.globalLiability() - exposure.liabilityCenti < 0n || (kind === 'onchain' && this.freeOnchainEquity() - exposure.liabilityCenti < 0n)) {
      return { ok: false, result: reject('LIABILITY_LIMIT', 'Solvency limit reached', { limit: 'global' }), detail: 'solvency' };
    }
    const leg: LegRecord = freezeDeep({
      seq: legSeq, legId, requestId, account, ledgerAccount, kind, ...(player.strategy ? { strategy: player.strategy } : {}),
      quoteId: quote.quoteId, revision: quote.revision, cell: quote.cell, bandIndex: quote.bandIndex, x100: quote.x100, stakeCenti,
      payoutCenti: payoutCenti(stakeCenti, quote.x100), liabilityCenti: exposure.liabilityCenti.toString(), placedMs: now, phase: quote.phase, edge: quote.edge,
      p: quote.p, tableId: quote.tableId, sourceTimeMs: quote.sourceTimeMs, flagged: quote.flagged, policyEdge: quote.policyEdge, ctlAdjust: quote.ctlAdjust, ...extras,
      ...(quote.tier !== undefined ? { tier: quote.tier, boosted: quote.boosted ?? false, guardAdjust: quote.guardAdjust ?? 0 } : {}),
    });
    return { ok: true, leg };
  }

  private commitLeg(leg: LegRecord, key: string): PlaceResult {
    this.commit({ type: 'bet', leg, intentKey: key });
    const view = this.legView(leg.legId)!;
    this.notify({ type: 'bet', data: view });
    return freezeDeep({ status: 'accepted', leg: view, newlyCommitted: true });
  }

  // ---------------------------------------------------------------- acceptance hold (SPEC-10 §1)

  private holdView(h: HoldRecord): HoldView {
    return { requestId: h.requestId, account: h.account, quoteId: h.quoteId, cellId: h.cellId, market: h.market, stakeCenti: h.stakeCenti, x100: h.x100, requestedMs: h.requestedMs, holdUntilMs: h.deadlineMs };
  }
  private pendingResult(h: HoldRecord, newlyHeld: boolean): PlaceResult { return freezeDeep({ status: 'pending', hold: this.holdView(h), newlyHeld }); }
  get holdPending(): number { return this.holds.size; }
  pendingHolds(): readonly HoldView[] { return [...this.holds.values()].map(h => this.holdView(h)); }
  /** Ledger balance minus stakes reserved by held placements. */
  availableBalance(account: string): bigint { const p = this.players.get(account); return p ? this.ledger.balance(p.ledgerAccount) - (this.pendingStake.get(account) ?? 0n) : 0n; }
  /** Liability the account may still add: min(account limit, new-account ramp) − open liability. */
  accountHeadroom(account: string): bigint {
    const p = this.players.get(account);
    if (!p) return 0n;
    const limit = rampLimitCenti(this.limitAmounts().account, { settledBets: p.settledBets, settledHandleCenti: p.settledStake }, this.defensesConfig.ramp);
    const left = limit - this.book.accountLiability(p.ledgerAccount);
    return left > 0n ? left : 0n;
  }
  /** Largest stake the account's liability headroom allows at x100. */
  accountMaxStake(account: string, x100: number): bigint { return x100 > 100 ? maxStakeForLiability(this.accountHeadroom(account), x100) : 0n; }

  private applyHold(h: HoldRecord): void {
    if (this.holds.has(h.requestId)) throw new Error(`Duplicate hold ${h.requestId}`);
    this.holds.set(h.requestId, freezeDeep({ ...h }));
    let set = this.holdsByMarket.get(h.market);
    if (!set) { set = new Set(); this.holdsByMarket.set(h.market, set); }
    set.add(h.requestId);
    const stake = BigInt(h.stakeCenti);
    this.pendingStake.set(h.account, (this.pendingStake.get(h.account) ?? 0n) + stake);
    const cellKey = `${h.account}|${h.cellId}`;
    this.pendingCellStake.set(cellKey, (this.pendingCellStake.get(cellKey) ?? 0n) + stake);
    this.holdStats.onCreate(h.requestedMs);
    const owner = this.players.get(h.account);
    if (owner) owner.holdsPlaced++;
    if (h.boostTier) { const key = `${h.account}|${h.boostTier}`; this.pendingBoost.set(key, (this.pendingBoost.get(key) ?? 0n) + stake); }
  }

  private applyHoldResolved(e: Extract<EngineEvent, { type: 'hold-resolved' }>): void {
    const h = this.holds.get(e.requestId);
    if (!h) throw new Error(`Resolution for unknown hold ${e.requestId}`);
    this.holds.delete(e.requestId);
    this.holdsByMarket.get(h.market)?.delete(e.requestId);
    const stake = BigInt(h.stakeCenti);
    const left = (this.pendingStake.get(h.account) ?? 0n) - stake;
    if (left > 0n) this.pendingStake.set(h.account, left); else this.pendingStake.delete(h.account);
    const cellKey = `${h.account}|${h.cellId}`;
    const cellLeft = (this.pendingCellStake.get(cellKey) ?? 0n) - stake;
    if (cellLeft > 0n) this.pendingCellStake.set(cellKey, cellLeft); else this.pendingCellStake.delete(cellKey);
    if (h.boostTier) {
      const key = `${h.account}|${h.boostTier}`;
      const boostLeft = (this.pendingBoost.get(key) ?? 0n) - stake;
      if (boostLeft > 0n) this.pendingBoost.set(key, boostLeft); else this.pendingBoost.delete(key);
    }
    this.holdStats.onResolve(e.atMs, e.outcome === 'accepted', e.detail, e.latencyMs);
    if (e.pFresh !== undefined && h.pQuote > 0) {
      const x = HoldMoveBaseline.clamp(e.pFresh / h.pQuote - 1);
      const player = this.players.get(h.account);
      if (player) { const d = x - this.holdBaseline.mean; player.holdN++; player.holdMoveSum += d; player.holdMoveSumSq += d * d; }
      this.holdBaseline.observe(x);
    }
    if (e.outcome === 'rejected') this.rememberRejection(e.requestId, h.intentKey, reject(e.reason ?? 'QUOTE_EXPIRED', e.message));
  }

  private commitHoldRejection(h: HoldRecord, reason: HouseRejection, detail: HoldDetail, message: string, extra: { pFresh?: number; freshT?: number } = {}): void {
    this.commit({ type: 'hold-resolved', requestId: h.requestId, outcome: 'rejected', detail, reason, message, ...extra, latencyMs: Math.max(0, this.clock - h.requestedMs) });
    // A rejected hold is still latency evidence (live only; replay applies the journaled flags).
    if (extra.pFresh !== undefined && !this.replaying && this.defensesConfig.toxicity.enabled) this.checkGraduatedToxicity(h.account, this.defensesConfig.toxicity);
  }

  /** Every hold on `market` placed before its newest first-seen second is decided now. */
  private resolveHolds(market: MarketId): void {
    const ids = this.holdsByMarket.get(market);
    if (!ids?.size) return;
    const latest = this.paths.get(market)!.latest();
    if (!latest) return;
    const grid = this.latestGrid(market)?.grid;
    const sigma = grid && grid.t === latest.t ? grid.sigma : undefined;
    for (const id of [...ids]) {
      const h = this.holds.get(id)!;
      if (latest.t > h.requestT) this.resolveHold(h, { t: latest.t, ...(sigma !== undefined ? { sigma } : {}) });
    }
  }
  private expireHolds(): void {
    for (const h of [...this.holds.values()]) if (this.clock >= h.deadlineMs) this.resolveHold(h, undefined);
  }

  /**
   * Decide one held placement: re-check the account, market and lead, re-validate the fair
   * probability of the square at the fresh second against the quoted one with the symmetric
   * tolerance, then limits and funds. Accepted at the original quote; every outcome is journaled.
   */
  private resolveHold(h: HoldRecord, fresh: { readonly t: number; readonly sigma?: number } | undefined): void {
    const now = this.clock, unc = this.feedUncertaintyMs;
    const quote = this.quotes.get(h.quoteId);
    const player = this.players.get(h.account)!;
    if (!quote) { this.commitHoldRejection(h, 'QUOTE_EXPIRED', 'quote-gone', 'The quote is no longer available'); return; }
    if (player.blocked) { this.commitHoldRejection(h, 'ACCOUNT_BLOCKED', 'blocked', 'Account is blocked from betting'); return; }
    const variant = this.variantMismatch(player, quote);
    if (variant) { this.commitHoldRejection(h, 'QUOTE_CHANGED', 'flag-variant', variant); return; }
    const boostCap = this.boostCapRejection(player, quote, BigInt(h.stakeCenti), h.boostTier ? BigInt(h.stakeCenti) : 0n);
    if (boostCap) { this.commitHoldRejection(h, 'STAKE_NOT_ALLOWED', 'boost-cap', boostCap); return; }
    if (quote.cell.startMs - (now + unc) < HOLD_ACCEPT_MIN_LEAD_MS) { this.commitHoldRejection(h, 'TOO_LATE', 'late', 'The square starts too soon to accept after the hold'); return; }
    const gate = this.gate(h.market);
    if (!gate.allowed) {
      if (gate.reason === 'stale-source') this.commitHoldRejection(h, 'INPUT_NOT_READY', 'stale', 'Price feed is stale');
      else this.commitHoldRejection(h, 'MARKET_PAUSED', 'paused', `Quoting is paused (${gate.breaker})`);
      return;
    }
    const extras: { pFresh?: number; freshT?: number } = {};
    if (fresh) {
      const path = this.paths.get(h.market)!;
      const latest = path.latest()!;
      extras.freshT = fresh.t;
      // The fair-value re-validation below supersedes the spot price-move guard at the end of a hold.
      const table = this.registry.get(quote.tableId) ?? this.currentTable(h.market);
      const fv = cellFairValue({ market: h.market, t: fresh.t, spot: latest.price, path, table, startMs: quote.cell.startMs, bandIndex: BigInt(quote.bandIndex), ...(fresh.sigma !== undefined ? { sigma: fresh.sigma } : {}) });
      if (fv.ok) {
        extras.pFresh = fv.p;
        const key = player.strategy ?? player.kind;
        let moves = this.holdMoves.get(key);
        if (!moves) { moves = []; this.holdMoves.set(key, moves); }
        if (moves.length < 400_000) moves.push(fv.p / h.pQuote - 1);
      }
      // Symmetric tolerance; tighter while the account shows latency evidence (flagged on it) and, optionally, for its first holds.
      const hold = this.defensesConfig.hold, tox = this.defensesConfig.toxicity;
      const latencyZ = this.holdMoveZ(player);
      const latencyFlagged = player.flagged && tox.enabled && player.holdN >= tox.holdMinN && latencyZ > tox.holdZ;
      const verdict = holdVerdict(h.pQuote, extras.pFresh, { tolScale: hold.tolScale, tolAbs: hold.tolAbs, tolRel: holdTolRelFor(hold, { flagged: latencyFlagged, holds: player.holdsPlaced - 1, latencyZ }) });
      if (!verdict.ok) {
        this.commitHoldRejection(h, 'QUOTE_CHANGED', verdict.reason === 'fair-value-moved' ? 'fair-value' : 'fair-value-unavailable',
          verdict.reason === 'fair-value-moved' ? `Fair value moved from ${h.pQuote.toFixed(4)} to ${extras.pFresh!.toFixed(4)} during the acceptance hold (tolerance ±${verdict.tolerance.toFixed(4)}${hold.tolScale === 'logit' ? ' in log-odds' : ''})` : 'The square could not be re-priced at the fresh price', extras);
        return;
      }
    } else if (this.defensesConfig.hold.onTimeout === 'reject') { this.commitHoldRejection(h, 'QUOTE_EXPIRED', 'timeout', 'No fresh price arrived within the acceptance hold'); return; }
    const stake = BigInt(h.stakeCenti);
    if (this.ledger.balance(h.ledgerAccount) < stake) { this.commitHoldRejection(h, 'INSUFFICIENT_BALANCE', 'balance', 'Balance too low at acceptance', extras); return; }
    if ((player.cellStakes.get(h.cellId) ?? 0n) + stake > BigInt(this.limitsConfig.maxStakePerCellCenti)) { this.commitHoldRejection(h, 'CELL_CAP_EXCEEDED', 'cell-cap', `Per-square stake cap is ${this.limitsConfig.maxStakePerCellCenti} Centi`, extras); return; }
    const prepared = this.prepareLeg(h.requestId, h.account, h.stakeCenti, h.ledgerAccount, h.kind, player, quote, now, { requestedMs: h.requestedMs, ...(extras.pFresh !== undefined ? { pFresh: extras.pFresh } : {}) });
    if (!prepared.ok) {
      const r = prepared.result as Extract<PlaceResult, { status: 'rejected' }>;
      this.commitHoldRejection(h, r.reason, prepared.detail, r.message ?? r.reason, extras);
      return;
    }
    this.commit({ type: 'hold-resolved', requestId: h.requestId, outcome: 'accepted', detail: fresh ? 'ok' : 'timeout-accepted', ...extras, latencyMs: now - h.requestedMs, legId: prepared.leg.legId });
    this.commitLeg(prepared.leg, h.intentKey);
    if (this.defensesConfig.toxicity.enabled) this.checkGraduatedToxicity(h.account, this.defensesConfig.toxicity);
  }

  private applyBet(leg: LegRecord, key: string): void {
    const player = this.players.get(leg.account);
    if (!player) throw new Error(`Bet for unknown account ${leg.account}`);
    const stake = BigInt(leg.stakeCenti), liability = BigInt(leg.liabilityCenti);
    this.post({ kind: 'stake', ref: leg.legId, atMs: leg.placedMs, postings: [{ account: leg.ledgerAccount, delta: -stake }, { account: leg.kind === 'sim' ? ACCOUNTS.escrowSim : ACCOUNTS.escrow, delta: stake }] });
    const applied = this.book.apply({ legId: leg.legId, account: leg.ledgerAccount, marketId: leg.cell.marketId, cellId: leg.cell.cellId, startMs: leg.cell.startMs, stakeCenti: stake, liabilityCenti: liability });
    if (!applied.ok) throw new Error(`Liability book rejected ${leg.legId}: ${applied.reason}`);
    if (leg.kind === 'onchain') this.onchainOpenLiability += liability;
    if (this.riskEquity() < this.book.globalLiability() || this.freeOnchainEquity() < 0n) this.solvencyViolations++;
    this.legSeq = Math.max(this.legSeq, leg.seq);
    this.openLegs.set(leg.legId, leg);
    let watch = this.openCells.get(leg.cell.cellId);
    if (!watch) { watch = { cell: leg.cell, legIds: new Set() }; this.openCells.set(leg.cell.cellId, watch); }
    watch.legIds.add(leg.legId);
    player.handle += stake; player.bets++; player.openBets++; player.lastBetMs = leg.placedMs;
    player.cellStakes.set(leg.cell.cellId, (player.cellStakes.get(leg.cell.cellId) ?? 0n) + stake);
    player.recentLegs.push(leg.legId); if (player.recentLegs.length > RECENT_PER_PLAYER) player.recentLegs.shift();
    this.flowShare.add(leg.placedMs, stake, player.flagged);
    this.receipts.set(leg.requestId, { intentKey: key, legId: leg.legId });
    this.receiptOrder.push(leg.requestId);
    this.evictReceipts();
    this.metrics.onBet(leg.placedMs, stake);
    // SPEC-12: every accepted stake counts towards the turnover that ends promo tiers; boosted stake towards the account's cap.
    this.turnoverCenti += stake;
    if (leg.tier !== undefined) this.promoLedger.onBet({ tier: leg.tier, boosted: leg.boosted ?? false, account: leg.account, stakeCenti: stake, x100: leg.x100, p: leg.p, pAccept: leg.pFresh ?? leg.p, guardAdjust: leg.guardAdjust ?? 0 });
    if (this.promoConfig) this.trackPhase();
  }

  private evictReceipts(): void {
    let guard = this.receiptOrder.length - this.receiptHead;
    while (this.receipts.size > this.cfg.receiptCapacity && guard-- > 0) {
      const id = this.receiptOrder[this.receiptHead++]!;
      const r = this.receipts.get(id);
      if (r && this.openLegs.has(r.legId)) { this.receiptOrder.push(id); continue; }
      this.receipts.delete(id);
    }
    if (this.receiptHead > 100_000) { this.receiptOrder.splice(0, this.receiptHead); this.receiptHead = 0; }
  }

  private applySettle(e: Extract<EngineEvent, { type: 'settle' }>): void {
    const leg = this.openLegs.get(e.legId);
    if (!leg) throw new Error(`Settlement for unknown or settled leg ${e.legId}`);
    const player = this.players.get(leg.account)!;
    const stake = BigInt(leg.stakeCenti), credit = BigInt(e.creditCenti), sim = leg.kind === 'sim';
    const escrow = sim ? ACCOUNTS.escrowSim : ACCOUNTS.escrow, house = sim ? ACCOUNTS.simPnl : ACCOUNTS.equity;
    const expected = e.status === 'won' ? BigInt(leg.payoutCenti) : e.status === 'refunded' ? stake : 0n;
    if (credit !== expected) throw new Error(`Settlement credit mismatch for ${e.legId}`);
    const postings = e.status === 'lost' ? [{ account: escrow, delta: -stake }, { account: house, delta: stake }]
      : e.status === 'refunded' ? [{ account: escrow, delta: -stake }, { account: leg.ledgerAccount, delta: stake }]
        : [{ account: escrow, delta: -stake }, { account: house, delta: stake - credit }, { account: leg.ledgerAccount, delta: credit }];
    this.post({ kind: e.status === 'won' ? 'win' : e.status === 'lost' ? 'loss' : 'refund', ref: e.legId, atMs: e.atMs, postings });
    const released = this.book.release(e.legId);
    if (!released.ok) throw new Error(`Liability book lost ${e.legId}`);
    if (leg.kind === 'onchain') this.onchainOpenLiability -= BigInt(leg.liabilityCenti);
    this.openLegs.delete(e.legId);
    const watch = this.openCells.get(leg.cell.cellId);
    if (watch) { watch.legIds.delete(e.legId); if (!watch.legIds.size) this.openCells.delete(leg.cell.cellId); }
    const left = (player.cellStakes.get(leg.cell.cellId) ?? 0n) - stake;
    if (left > 0n) player.cellStakes.set(leg.cell.cellId, left); else player.cellStakes.delete(leg.cell.cellId);
    player.openBets--;
    // The adaptive edge (and the SPEC-12 clean-flow budget figure) learn only from clean flow: never flagged or blocked,
    // and no latency evidence above cleanHoldZ.
    const clean = !leg.flagged && !player.flagged && !player.blocked && !player.flags.length && this.holdMoveZ(player) <= this.defensesConfig.controller.cleanHoldZ;
    if (e.status !== 'refunded') {
      player.settledStake += stake; player.returned += credit; player.settledBets++; if (e.status === 'won') player.wins++;
      // Outcome evidence is measured against the fair value at acceptance: after an acceptance hold that is p_fresh,
      // so the hold's own selection (which bets survive the re-validation) cannot read as skill.
      const sv = Number(stake), m = leg.x100 / 100, pe = leg.pFresh ?? leg.p;
      player.expectedReturn += sv * m * pe; player.returnVariance += sv * sv * m * m * pe * (1 - pe);
      // A boosted leg's policy RTP is its tier target (1 + lossBudget − guard adjustment): the controller aims realized RTP there.
      if (clean) this.controller.observe({ atMs: e.atMs, x100: leg.x100, stakeCenti: stake, creditCenti: credit, p: leg.p, policyRtp: 1 - (leg.policyEdge ?? leg.edge), adjust: leg.ctlAdjust ?? 0 });
    }
    if (leg.tier !== undefined) {
      // Legs on one square share its outcome; squares of one market-minute share the path (clustered variance for the budget statistics).
      const minute = Math.floor(leg.cell.startMs / 60_000);
      this.promoLedger.onSettle({ tier: leg.tier, boosted: leg.boosted ?? false, clean, stakeCenti: stake, creditCenti: credit, x100: leg.x100, p: leg.p, guardAdjust: leg.guardAdjust ?? 0, status: e.status,
        cluster: { cell: leg.cell.cellId, block: `${leg.cell.marketId}:${minute}`, minute } });
    }
    const settlement: LegSettlement = { status: e.status, settledMs: e.atMs, creditCenti: e.creditCenti, evidenceSampleIds: [...e.evidence], ...(e.touchTimeMs !== undefined ? { touchTimeMs: e.touchTimeMs } : {}), reason: e.reason };
    this.settled.set(e.legId, freezeDeep({ ...leg, status: e.status, settlement }));
    this.settledOrder.push(e.legId);
    while (this.settled.size > this.cfg.settledCapacity) this.settled.delete(this.settledOrder[this.settledHead++]!);
    if (this.settledHead > 100_000) { this.settledOrder.splice(0, this.settledHead); this.settledHead = 0; }
    this.metrics.onSettle(e.atMs, { x100: leg.x100, p: leg.p, phase: leg.phase, market: leg.cell.marketId, kind: leg.kind, strategy: leg.strategy, stake, ...(leg.policyEdge !== undefined ? { policyRtp: 1 - leg.policyEdge } : {}), ...(leg.tier !== undefined ? { tier: leg.tier, boosted: leg.boosted ?? false } : {}) }, e.status, credit);
  }

  /**
   * Live only (never during replay): the flag itself is a journaled event, so a rebuild reproduces it.
   * With graduated toxicity on (SPEC-10 §5): surcharge (flag) first, block on stronger evidence,
   * lift its own flag when the evidence fades; never on too little data.
   */
  private checkToxicity(account: string): void {
    const g = this.defensesConfig.toxicity;
    if (g.enabled) { this.checkGraduatedToxicity(account, g); return; }
    const t = this.toxicity;
    const p = this.players.get(account);
    if (!t || !p || p.flagged || p.settledBets < t.minBets) return;
    const z = excessReturnZ(p);
    if (!(z > t.zThreshold)) return;
    const r = this.setPlayerFlag(account, 'flag', { actor: TOXICITY_ACTOR, reason: `excess return z=${z.toFixed(2)} over ${p.settledBets} settled bets (RTP ${(Number(p.returned) / Number(p.settledStake)).toFixed(3)})` });
    if (r.ok) this.alert('warning', `Toxicity monitor flagged ${account} (z=${z.toFixed(2)})`, 'TOXIC_FLOW');
  }

  /** Latency evidence z of an account: mean signed hold move against the population, in population standard errors. */
  /**
   * Latency evidence z of an account: Σ(x − μ) / (s·√n) with s = max(population sd, the account's own sd), so
   * a strategy whose squares simply move more (far, low-probability cells) is not read as informed.
   */
  holdMoveZ(p: Pick<PlayerRecord, 'holdN' | 'holdMoveSum' | 'holdMoveSumSq'>): number {
    const n = p.holdN;
    if (n <= 0) return 0;
    const own = n > 1 ? Math.max(0, (p.holdMoveSumSq - (p.holdMoveSum * p.holdMoveSum) / n) / (n - 1)) : 0;
    return p.holdMoveSum / (Math.max(this.holdBaseline.sd, Math.sqrt(own)) * Math.sqrt(n));
  }

  private checkGraduatedToxicity(account: string, g: DefenseConfig['toxicity']): void {
    const p = this.players.get(account);
    if (!p || p.blocked || (p.settledBets < g.minBets && p.holdN < g.holdMinN)) return;
    const z = excessReturnZ(p), hz = this.holdMoveZ(p);
    const lastFlag = [...p.flags].reverse().find(f => f.action === 'flag' || f.action === 'unflag');
    const { action, evidence: kind } = toxicityDecision({ settledBets: p.settledBets, wins: p.wins, z, holdN: p.holdN, holdZ: hz, flagged: p.flagged, blocked: p.blocked, flaggedByMonitor: lastFlag?.action === 'flag' && lastFlag.actor === TOXICITY_ACTOR }, g);
    if (action === 'none') return;
    const rtp = p.settledStake > 0n ? (Number(p.returned) / Number(p.settledStake)).toFixed(3) : '—';
    const evidence = kind === 'latency'
      ? `latency evidence z=${hz.toFixed(2)} over ${p.holdN} held placements (mean fair-value move ${((p.holdMoveSum / Math.max(1, p.holdN)) * 100).toFixed(1)} pts above the population); excess return z=${z.toFixed(2)} over ${p.settledBets} settled bets`
      : `excess return z=${z.toFixed(2)} over ${p.settledBets} settled bets, ${p.wins} wins (RTP ${rtp}); latency evidence z=${hz.toFixed(2)} over ${p.holdN} holds`;
    if (action === 'flag') {
      const r = this.setPlayerFlag(account, 'flag', { actor: TOXICITY_ACTOR, reason: `${evidence}; flow surcharge ${g.surchargeEdge}` });
      if (r.ok) this.alert('warning', `Toxicity monitor surcharged ${account} (z=${z.toFixed(2)})`, 'TOXIC_FLOW');
    } else if (action === 'block') {
      const r = this.setPlayerFlag(account, 'block', { actor: TOXICITY_ACTOR, reason: `${evidence} above ${g.blockZ} after the surcharge` });
      if (r.ok) this.alert('critical', `Toxicity monitor blocked ${account} (z=${z.toFixed(2)})`, 'TOXIC_FLOW_BLOCKED');
    } else this.setPlayerFlag(account, 'unflag', { actor: TOXICITY_ACTOR, reason: `${evidence} fell below ${g.unflagZ}` });
  }

  legView(legId: string): LegView | undefined {
    const open = this.openLegs.get(legId);
    return open ? freezeDeep({ ...open, status: 'open' as const }) : this.settled.get(legId);
  }
  receiptFor(requestId: string): PlaceResult | undefined {
    const r = this.receipts.get(requestId);
    if (r) { const leg = this.legView(r.legId); return leg ? freezeDeep({ status: 'accepted', leg, newlyCommitted: false }) : undefined; }
    const held = this.holds.get(requestId);
    if (held) return this.pendingResult(held, false);
    return this.rejections.get(requestId)?.result;
  }
  openLegsList(): readonly LegRecord[] { return [...this.openLegs.values()]; }
  settledLegs(): readonly LegView[] { return this.settledOrder.slice(this.settledHead).map(id => this.settled.get(id)!).filter(Boolean); }

  // ---------------------------------------------------------------- withdrawals (vouchers)

  get maxVoucherAmountCenti(): string { return this.cfg.maxVoucherAmountCenti; }
  setMaxVoucherAmountCenti(centi: string): void { if (isPositiveCenti(centi)) (this.cfg as { maxVoucherAmountCenti: string }).maxVoucherAmountCenti = centi; }

  /** The voucher already issued for `requestId`, if any. */
  voucherByRequest(requestId: string): VoucherRecord | undefined { const id = this.vouchersByRequest.get(requestId); return id ? this.vouchers.get(id) : undefined; }
  /** The voucher of this ledger with (account, nonce), if any. */
  voucherByNonce(account: string, nonce: string | bigint): VoucherRecord | undefined { const id = this.vouchersByNonce.get(`${account.toLowerCase()}:${nonce.toString()}`); return id ? this.vouchers.get(id) : undefined; }

  /** Reserve funds for a withdrawal voucher (debit now; signature attached by the caller). Idempotent by requestId. */
  requestWithdrawal(requestId: string, account: string, amountCenti: string, chainNowS: bigint): { ok: true; voucher: VoucherRecord; created: boolean } | { ok: false; code: string; message: string } {
    if (!isRequestId(requestId)) return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed requestId' };
    const ids = ledgerAccountOf(account);
    if (!ids || ids.kind !== 'onchain') return { ok: false, code: 'INVALID_ACCOUNT', message: 'Only on-chain player accounts can withdraw' };
    const existingId = this.vouchersByRequest.get(requestId);
    if (existingId) {
      const v = this.vouchers.get(existingId)!;
      return v.account === ids.account && v.amountCenti === amountCenti ? { ok: true, voucher: v, created: false } : { ok: false, code: 'REQUEST_CONFLICT', message: 'requestId was used for a different withdrawal' };
    }
    const player = this.players.get(ids.account);
    if (!player) return { ok: false, code: 'UNKNOWN_ACCOUNT', message: 'Account has no deposits' };
    if (!isPositiveCenti(amountCenti)) return { ok: false, code: 'INVALID_AMOUNT', message: 'Amount must be a positive Centi amount' };
    if (BigInt(amountCenti) > BigInt(this.cfg.maxVoucherAmountCenti)) return { ok: false, code: 'ABOVE_VOUCHER_MAX', message: `Maximum withdrawal is ${this.cfg.maxVoucherAmountCenti} Centi` };
    // Stakes reserved by held placements are not withdrawable until the hold ends.
    if (this.ledger.balance(player.ledgerAccount) - (this.pendingStake.get(player.account) ?? 0n) < BigInt(amountCenti)) return { ok: false, code: 'INSUFFICIENT_BALANCE', message: 'Balance too low' };
    const voucherId = `V${this.voucherSeq + 1}`;
    this.commit({ type: 'voucher', voucherId, requestId, account: ids.account, amountCenti, nonce: voucherNonce(this.runId, voucherId, this.bootId), expiry: String(chainNowS + BigInt(this.cfg.voucherTtlS)) });
    return { ok: true, voucher: this.vouchers.get(voucherId)!, created: true };
  }
  private applyVoucher(e: Extract<EngineEvent, { type: 'voucher' }>): void {
    const player = this.players.get(e.account)!;
    this.post({ kind: 'voucher', ref: e.voucherId, atMs: e.atMs, postings: [{ account: player.ledgerAccount, delta: -BigInt(e.amountCenti) }, { account: ACCOUNTS.vouchers, delta: BigInt(e.amountCenti) }] });
    this.voucherSeq = Math.max(this.voucherSeq, Number(e.voucherId.slice(1)));
    this.vouchers.set(e.voucherId, { voucherId: e.voucherId, requestId: e.requestId, account: e.account, amountCenti: e.amountCenti, nonce: e.nonce, expiry: e.expiry, createdMs: e.atMs, status: 'signing' });
    this.vouchersByRequest.set(e.requestId, e.voucherId);
    this.vouchersByNonce.set(`${e.account}:${e.nonce}`, e.voucherId);
    player.vouchers.push(e.voucherId);
  }
  attachVoucherSignature(voucherId: string, signature: string): boolean {
    const v = this.vouchers.get(voucherId);
    if (!v || v.status !== 'signing' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
    this.commit({ type: 'voucher-signed', voucherId, signature });
    return true;
  }
  /** Return reserved funds for a voucher that was never signed. */
  cancelVoucher(voucherId: string, reason: string): boolean {
    const v = this.vouchers.get(voucherId);
    if (!v || v.status !== 'signing') return false;
    this.commit({ type: 'voucher-cancelled', voucherId, reason });
    return true;
  }
  private applyVoucherCancel(voucherId: string, reason: string, atMs: number): void {
    const v = this.vouchers.get(voucherId)!;
    const player = this.players.get(v.account)!;
    this.post({ kind: 'voucher-cancel', ref: voucherId, atMs, postings: [{ account: ACCOUNTS.vouchers, delta: -BigInt(v.amountCenti) }, { account: player.ledgerAccount, delta: BigInt(v.amountCenti) }] });
    v.status = 'cancelled'; v.cancelReason = reason;
  }
  /**
   * Stage A receipt claim: releases the voucher to the vault at once. Idempotent: a voucher already
   * claimed with the same transaction (e.g. by its chain event) answers true. The app's own flows use
   * `noteVoucherSubmitted` and let the `Withdrawn` event claim (`applyChainWithdrawal`).
   */
  markVoucherClaimed(voucherId: string, txHash: string): boolean {
    const v = this.vouchers.get(voucherId);
    if (v?.status === 'claimed') return v.txHash?.toLowerCase() === txHash.toLowerCase();
    if (!v || v.status !== 'pending') return false;
    this.commit({ type: 'voucher-claimed', voucherId, txHash });
    return true;
  }
  private applyVoucherClaim(voucherId: string, txHash: string, atMs: number): void {
    const v = this.vouchers.get(voucherId)!;
    this.post({ kind: 'voucher-claim', ref: voucherId, atMs, postings: [{ account: ACCOUNTS.vouchers, delta: -BigInt(v.amountCenti) }, { account: ACCOUNTS.vault, delta: BigInt(v.amountCenti) }] });
    v.status = 'claimed'; v.txHash = txHash; v.claimSource ??= 'receipt';
  }
  /**
   * The server submitted a redemption (or holds its receipt). Nothing moves: the voucher stays an
   * outstanding liability (and stays in the balance tree) until the chain delivers its `Withdrawn`
   * event, exactly like deposits, which are only ever credited from chain events. Idempotent.
   */
  noteVoucherSubmitted(voucherId: string, txHash: string): boolean {
    const v = this.vouchers.get(voucherId);
    if (!v || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return false;
    if (v.status === 'claimed') return true;
    if (v.status !== 'pending' && v.status !== 'signing') return false;
    if (v.submittedTxHash?.toLowerCase() !== txHash.toLowerCase()) this.commit({ type: 'voucher-submitted', voucherId, txHash: txHash.toLowerCase() });
    return true;
  }
  /**
   * Return the reserved amount of a voucher that can never be redeemed: the caller has checked that
   * chain time is past its expiry (plus a safety margin) and that the vault reports its nonce unused.
   */
  expireVoucher(voucherId: string, reason: string): boolean {
    const v = this.vouchers.get(voucherId);
    if (!v || (v.status !== 'pending' && v.status !== 'signing')) return false;
    this.commit({ type: 'voucher-expired', voucherId, reason });
    return true;
  }
  private applyVoucherExpired(voucherId: string, reason: string, atMs: number): void {
    const v = this.vouchers.get(voucherId)!;
    const player = this.players.get(v.account)!;
    this.post({ kind: 'voucher-expire', ref: voucherId, atMs, postings: [{ account: ACCOUNTS.vouchers, delta: -BigInt(v.amountCenti) }, { account: player.ledgerAccount, delta: BigInt(v.amountCenti) }] });
    v.status = 'expired'; v.cancelReason = reason;
  }

  /**
   * Apply a vault `Withdrawn` event from any wallet (ChainPort.onWithdrawn, delivered at least once).
   * Idempotent by `player:nonce`. A matching signing/pending voucher is claimed; every other case keeps
   * the ledger reconciled with the vault while charging the unexplained outflow conservatively
   * (see `WithdrawalOutcome`) and raises a critical alert.
   */
  applyChainWithdrawal(w: ChainWithdrawal): { ok: true; duplicate: boolean; outcome?: WithdrawalOutcome; record?: WithdrawalRecord } | { ok: false; code: string } {
    if (!isAddress(w.player) || typeof w.amountWei !== 'bigint' || w.amountWei <= 0n || typeof w.nonce !== 'bigint' || w.nonce < 0n || !/^0x[0-9a-fA-F]{64}$/.test(w.txHash) || !Number.isSafeInteger(w.logIndex) || w.logIndex < 0) return { ok: false, code: 'INVALID_WITHDRAWAL' };
    const player = w.player.toLowerCase();
    const nonce = w.nonce.toString();
    const key = `${player}:${nonce}`;
    const seen = this.chainWithdrawals.get(key);
    if (seen) return { ok: true, duplicate: true, outcome: seen.outcome, record: seen };
    const voucher = this.voucherByNonce(player, nonce);
    // A voucher claimed by a Stage A receipt is the same redemption seen late: nothing moves.
    if (voucher?.status === 'claimed') return { ok: true, duplicate: true };
    const base = { key, player, nonce, amountWei: w.amountWei.toString(), txHash: w.txHash.toLowerCase(), logIndex: w.logIndex, blockNumber: w.blockNumber.toString() };
    // The vault paid `amountWei`; the ledger moves whole Centi and books any sub-Centi rounding as retained dust.
    const paidCenti = (w.amountWei + CENTI_WEI - 1n) / CENTI_WEI;
    const dust = paidCenti * CENTI_WEI - w.amountWei;
    const dustField = dust > 0n ? { dustAddedWei: dust.toString() } : {};
    if (voucher && (voucher.status === 'pending' || voucher.status === 'signing')) {
      const vc = BigInt(voucher.amountCenti);
      if (w.amountWei === vc * CENTI_WEI) this.commit({ type: 'withdrawal', ...base, outcome: 'claimed', voucherId: voucher.voucherId, voucherCenti: voucher.amountCenti });
      else this.commit({ type: 'withdrawal', ...base, outcome: 'amount-mismatch', voucherId: voucher.voucherId, voucherCenti: voucher.amountCenti, ...(paidCenti > vc ? { houseCenti: (paidCenti - vc).toString() } : { returnedCenti: (vc - paidCenti).toString() }), ...dustField });
    } else if (voucher) {
      // Cancelled or expired: the amount went back to the balance, yet the vault paid it.
      const owner = this.players.get(player);
      const balance = owner ? this.ledger.balance(owner.ledgerAccount) : 0n;
      const clawback = balance < paidCenti ? balance : paidCenti;
      this.commit({ type: 'withdrawal', ...base, outcome: 'claimed-after-release', voucherId: voucher.voucherId, clawbackCenti: clawback.toString(), houseCenti: (paidCenti - clawback).toString(), ...dustField });
    } else {
      this.commit({ type: 'withdrawal', ...base, outcome: 'unmatched', houseCenti: paidCenti.toString(), ...dustField });
    }
    const record = this.chainWithdrawals.get(key)!;
    if (record.outcome !== 'claimed') {
      this.alert('critical', `Vault paid ${fromWei(w.amountWei).centi} Centi to ${player} (nonce ${nonce}, tx ${base.txHash}): ${record.outcome}${record.voucherId ? ` (voucher ${record.voucherId})` : ''}; the ledger booked it conservatively`, `WITHDRAWAL_${record.outcome.toUpperCase().replace(/-/g, '_')}`);
    }
    return { ok: true, duplicate: false, outcome: record.outcome, record };
  }
  private applyWithdrawal(e: Extract<EngineEvent, { type: 'withdrawal' }>): void {
    const v = e.voucherId ? this.vouchers.get(e.voucherId) : undefined;
    if (e.voucherId && !v) throw new Error(`Withdrawal ${e.key} names unknown voucher ${e.voucherId}`);
    const ref = `withdrawal:${e.key}`;
    const vault = ACCOUNTS.vault;
    if (e.outcome === 'claimed' || e.outcome === 'amount-mismatch') {
      const vc = BigInt(e.voucherCenti ?? v!.amountCenti);
      this.post({ kind: 'voucher-claim', ref, atMs: e.atMs, postings: [{ account: ACCOUNTS.vouchers, delta: -vc }, { account: vault, delta: vc }] });
      const house = BigInt(e.houseCenti ?? '0'), back = BigInt(e.returnedCenti ?? '0');
      if (house > 0n) this.post({ kind: 'withdrawal-anomaly', ref: `${ref}:house`, atMs: e.atMs, postings: [{ account: ACCOUNTS.equity, delta: -house }, { account: vault, delta: house }] });
      if (back > 0n) this.post({ kind: 'withdrawal-anomaly', ref: `${ref}:return`, atMs: e.atMs, postings: [{ account: vault, delta: -back }, { account: this.players.get(v!.account)!.ledgerAccount, delta: back }] });
    } else {
      const claw = BigInt(e.clawbackCenti ?? '0'), house = BigInt(e.houseCenti ?? '0');
      const owner = this.players.get(e.player);
      const postings: { account: string; delta: bigint }[] = [{ account: vault, delta: claw + house }];
      if (claw > 0n) postings.push({ account: owner!.ledgerAccount, delta: -claw });
      if (house > 0n) postings.push({ account: ACCOUNTS.equity, delta: -house });
      if (claw + house > 0n) this.post({ kind: 'withdrawal-anomaly', ref, atMs: e.atMs, postings });
    }
    if (e.dustAddedWei) this.totalDustWei += BigInt(e.dustAddedWei);
    if (v) {
      if (e.outcome === 'claimed-after-release') v.claimNote = `paid after ${v.status}`;
      else if (e.outcome === 'amount-mismatch') v.claimNote = `vault paid ${e.amountWei} wei`;
      v.status = 'claimed'; v.txHash = e.txHash; v.claimBlock = e.blockNumber; v.claimLogIndex = e.logIndex; v.claimSource = 'event';
    }
    // An outflow charged to house equity is a loss, not a treasury move: it counts towards the drawdown breaker (fail closed).
    this.chainWithdrawals.set(e.key, freezeDeep({ key: e.key, player: e.player, nonce: e.nonce, amountWei: e.amountWei, txHash: e.txHash, logIndex: e.logIndex, blockNumber: e.blockNumber, outcome: e.outcome, ...(e.voucherId ? { voucherId: e.voucherId } : {}), ms: e.atMs }));
  }
  /** On-chain redemptions the ledger could not match to a voucher it issued (should stay empty). */
  unmatchedWithdrawals(): WithdrawalRecord[] { return [...this.chainWithdrawals.values()].filter(w => w.outcome !== 'claimed'); }
  pendingVouchers(): VoucherRecord[] { return [...this.vouchers.values()].filter(v => v.status === 'pending' || v.status === 'signing'); }

  // ---------------------------------------------------------------- treasury and attestation

  /**
   * Book a house treasury flow. With `op`, it settles the pending operation `op.opId` (its reservation ends in
   * the same record); `resolution` says whether the outcome came from the receipt or from vault state.
   */
  recordTreasury(action: 'fund' | 'withdraw-surplus' | 'sync', amountCenti: string, txHash?: string, dustWei = 0n, op?: { readonly opId: string; readonly resolution: TreasuryResolution }): void {
    this.commit({ type: 'treasury', action, amountCenti, ...(txHash ? { txHash } : {}), ...(dustWei > 0n ? { dustWei: dustWei.toString() } : {}), ...(op ? { opId: op.opId, resolution: op.resolution } : {}) });
  }
  private applyTreasury(e: Extract<EngineEvent, { type: 'treasury' }>): void {
    const amount = BigInt(e.amountCenti);
    const inflow = e.action !== 'withdraw-surplus';
    this.post({ kind: e.action === 'fund' ? 'fund-house' : e.action === 'sync' ? 'house-sync' : 'withdraw-surplus', ref: `${e.action}:${e.seq}`, atMs: e.atMs, postings: [{ account: ACCOUNTS.vault, delta: inflow ? -amount : amount }, { account: ACCOUNTS.equity, delta: inflow ? amount : -amount }] });
    this.breakers.recordTreasuryFlow(inflow ? amount : -amount);
    if (e.dustWei) this.totalDustWei += BigInt(e.dustWei);
    this.houseNetBooked += inflow ? amount * CENTI_WEI + BigInt(e.dustWei ?? '0') : -amount * CENTI_WEI;
    if (e.opId && this.pendingOp?.opId === e.opId) this.pendingOp = undefined;
  }

  /**
   * Open a treasury operation before its first chain call (journaled, so it survives a restart). A surplus
   * withdrawal's amount is reserved at once: `riskEquity()` and `freeOnchainEquity()` exclude it, so bets
   * accepted while its attest and withdraw transactions are in flight stay covered by what remains in the
   * vault. Only one operation may be pending: its outcome is later matched against the vault's house counters.
   */
  beginTreasury(action: PendingTreasuryAction, amountCenti: string, actor: string): { ok: true; opId: string } | { ok: false; pending: PendingTreasury } {
    if (this.pendingOp) return { ok: false, pending: this.pendingOp };
    const opId = `T${this.treasurySeq + 1}`;
    this.commit({ type: 'treasury-pending', opId, action, amountCenti, actor });
    return { ok: true, opId };
  }
  /** The pending operation's chain call ended with an unknown outcome: it stays pending (and reserved). */
  markTreasuryUnknown(opId: string, txHash: string | undefined, reason: string): boolean {
    if (this.pendingOp?.opId !== opId) return false;
    this.commit({ type: 'treasury-unknown', opId, ...(txHash ? { txHash } : {}), reason });
    return true;
  }
  /** The pending operation moved no money (refused, reverted, or confirmed absent from the vault): end it and its reservation. */
  releaseTreasury(opId: string, reason: string, actor: string): boolean {
    if (this.pendingOp?.opId !== opId) return false;
    this.commit({ type: 'treasury-released', opId, reason, actor });
    return true;
  }
  /**
   * Match the pending operation against vault state: the vault's house net (houseFunded − houseWithdrawn)
   * minus what this ledger booked. Exactly the pending flow unbooked → it was mined: book it ('booked').
   * Nothing unbooked → it has not been mined (yet): it stays pending ('pending'). Anything else → 'mismatch'
   * (left pending, fail closed; the caller alerts). 'none' when nothing is pending.
   */
  resolveTreasury(vault: Pick<VaultState, 'houseFundedWei' | 'houseWithdrawnWei'>): { status: 'none' | 'booked' | 'pending' | 'mismatch'; unbookedWei: bigint; op?: PendingTreasury } {
    const unbookedWei = vault.houseFundedWei - vault.houseWithdrawnWei - this.houseNetBooked;
    const op = this.pendingOp;
    if (!op) return { status: 'none', unbookedWei };
    const flow = BigInt(op.amountCenti) * CENTI_WEI * (op.action === 'fund' ? 1n : -1n);
    if (unbookedWei === flow) {
      this.recordTreasury(op.action, op.amountCenti, op.txHash, 0n, { opId: op.opId, resolution: 'vault-state' });
      return { status: 'booked', unbookedWei, op };
    }
    return { status: unbookedWei === 0n ? 'pending' : 'mismatch', unbookedWei, op };
  }

  /**
   * What the ledger owes each on-chain account, in wei (SPEC-11 §6.2 leaf contract). One entry per
   * `player:<address>` account whose amount is > 0:
   *   ledger balance (incl. stakes reserved by held placements)
   * + vouchers not yet seen redeemed on chain (status signing or pending)
   * + max payout (stake + liability) of the account's open legs
   * all in Centi × 10^16, plus the wei dust of the account's own deposits.
   * Sim accounts (off-chain sim credit) are never included. Sorted by address.
   */
  balanceEntries(): { account: string; balanceWei: bigint }[] {
    const owed = new Map<string, bigint>();
    const add = (account: string, centi: bigint) => { if (centi !== 0n) owed.set(account, (owed.get(account) ?? 0n) + centi); };
    for (const p of this.players.values()) if (p.kind === 'onchain') add(p.account, this.ledger.balance(p.ledgerAccount));
    for (const v of this.vouchers.values()) if (v.status === 'pending' || v.status === 'signing') add(v.account, BigInt(v.amountCenti));
    for (const l of this.openLegs.values()) if (l.kind === 'onchain') add(l.account, BigInt(l.payoutCenti));
    const out: { account: string; balanceWei: bigint }[] = [];
    for (const p of this.players.values()) {
      if (p.kind !== 'onchain') continue;
      let dust = 0n; for (const d of p.deposits) dust += BigInt(d.dustWei);
      const wei = (owed.get(p.account) ?? 0n) * CENTI_WEI + dust;
      if (wei > 0n) out.push({ account: p.account, balanceWei: wei });
    }
    return out.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  }

  /** What the ledger owes one on-chain account right now, by the same rule as `balanceEntries()` (0 for sim or unknown accounts). */
  owedWei(account: string): bigint {
    const p = this.players.get(account.toLowerCase());
    if (!p || p.kind !== 'onchain') return 0n;
    let centi = this.ledger.balance(p.ledgerAccount), dust = 0n;
    for (const id of p.vouchers) { const v = this.vouchers.get(id)!; if (v.status === 'pending' || v.status === 'signing') centi += BigInt(v.amountCenti); }
    for (const l of this.openLegs.values()) if (l.account === p.account) centi += BigInt(l.payoutCenti);
    for (const d of p.deposits) dust += BigInt(d.dustWei);
    return centi * CENTI_WEI + dust;
  }

  /**
   * On-chain liabilities: player balances + vouchers not yet claimed + max payouts of open on-chain legs
   * (+ all retained dust). `ledgerRoot` is the balance-tree root (OpenZeppelin StandardMerkleTree of
   * (address, uint256)) over `balanceEntries()`; Σ leaves = liabilities − house-side dust ≤ liabilities.
   */
  attestationSnapshot(): { liabilitiesCenti: bigint; liabilitiesWei: bigint; ledgerRoot: string; entries: readonly { account: string; balanceWei: bigint }[]; leafTotalWei: bigint } {
    const liabilitiesCenti = this.ledger.total('player') + this.ledger.balance(ACCOUNTS.vouchers) + this.ledger.balance(ACCOUNTS.escrow) + this.onchainOpenLiability;
    const liabilitiesWei = liabilitiesCenti * CENTI_WEI + this.totalDustWei;
    const entries = this.balanceEntries();
    const leafTotalWei = entries.reduce((s, e) => s + e.balanceWei, 0n);
    // The vault's escape pool is bounded by the attested liabilities, so the leaves must never promise more.
    if (leafTotalWei > liabilitiesWei) throw new Error(`Balance tree total ${leafTotalWei} exceeds attested liabilities ${liabilitiesWei}`);
    return { liabilitiesCenti, liabilitiesWei, ledgerRoot: buildBalanceTree(entries).root, entries, leafTotalWei };
  }
  recordAttestation(seq: bigint, liabilitiesWei: bigint, ledgerRoot: string, asOf: bigint, txHash: string, tree: { leaves?: number; leafTotalWei?: bigint; treeFile?: string; treeSha256?: string } = {}): void {
    this.commit({
      type: 'attest', attestSeq: seq.toString(), liabilitiesWei: liabilitiesWei.toString(), ledgerRoot, asOf: asOf.toString(), txHash,
      ...(tree.leaves !== undefined ? { leaves: tree.leaves } : {}), ...(tree.leafTotalWei !== undefined ? { leafTotalWei: tree.leafTotalWei.toString() } : {}),
      ...(tree.treeFile ? { treeFile: tree.treeFile } : {}), ...(tree.treeSha256 ? { treeSha256: tree.treeSha256 } : {}),
    });
  }

  /** Vault assets must equal the ledger's view of on-chain money exactly (wei), dust included. */
  reconcile(vault: Pick<VaultState, 'assetsWei' | 'houseFundedWei' | 'houseWithdrawnWei' | 'totalDepositsWei' | 'totalWithdrawalsWei'>): {
    match: boolean; vaultAssetsWei: string; ledgerAssetsWei: string; deltaWei: string; dustWei: string; components: Record<string, string>;
  } {
    const ledgerCenti = -this.ledger.balance(ACCOUNTS.vault);
    const ledgerWei = ledgerCenti * CENTI_WEI + this.totalDustWei;
    const anomalies = this.unmatchedWithdrawals();
    return {
      match: ledgerWei === vault.assetsWei, vaultAssetsWei: vault.assetsWei.toString(), ledgerAssetsWei: ledgerWei.toString(), deltaWei: (vault.assetsWei - ledgerWei).toString(), dustWei: this.totalDustWei.toString(),
      components: {
        playerBalancesCenti: this.ledger.total('player').toString(), escrowCenti: this.ledger.balance(ACCOUNTS.escrow).toString(), vouchersCenti: this.ledger.balance(ACCOUNTS.vouchers).toString(),
        houseEquityCenti: this.equityOnchain().toString(), externalVaultCenti: this.ledger.balance(ACCOUNTS.vault).toString(),
        // Redemptions the ledger booked conservatively because no live voucher matched (should be 0).
        anomalousWithdrawals: String(anomalies.length), anomalousWithdrawalsWei: anomalies.reduce((s, w) => s + BigInt(w.amountWei), 0n).toString(),
      },
    };
  }

  /** Invariants that must hold at all times. */
  invariants(): { ledgerSumZero: boolean; negativeAccounts: string[]; simIdentity: boolean; escrowMatchesOpenStakes: boolean; solvencyViolations: number; equityNonNegative: boolean } {
    let escrow = 0n, escrowSim = 0n;
    for (const l of this.openLegs.values()) if (l.kind === 'sim') escrowSim += BigInt(l.stakeCenti); else escrow += BigInt(l.stakeCenti);
    // Sim credit identity: every issued credit sits in a sim balance, sim escrow or the house's sim result.
    const simIdentity = this.simCreditIssued === this.ledger.total('sim') + this.ledger.balance(ACCOUNTS.escrowSim) + this.simPnl() && -this.ledger.balance(ACCOUNTS.simCredit) === this.simCreditIssued;
    return {
      ledgerSumZero: this.ledger.sum() === 0n, negativeAccounts: this.ledger.negativeAccounts(), simIdentity,
      escrowMatchesOpenStakes: escrow === this.ledger.balance(ACCOUNTS.escrow) && escrowSim === this.ledger.balance(ACCOUNTS.escrowSim),
      solvencyViolations: this.solvencyViolations, equityNonNegative: this.equityOnchain() - this.treasuryReservedCenti() >= 0n && this.riskEquity() >= this.book.globalLiability(),
    };
  }

  // ---------------------------------------------------------------- admin actions

  private auditEntry(fields: Omit<AuditEntry, 'id' | 'ms'>): AuditEntry {
    this.auditSeq++;
    return freezeDeep({ id: `A${this.auditSeq}`, ms: this.clock, ...fields });
  }
  /** Journal an admin (or system) action; returns the audit id. */
  recordAudit(fields: Omit<AuditEntry, 'id' | 'ms'>): AuditEntry {
    const entry = this.auditEntry(fields);
    this.commit({ type: 'audit', entry });
    this.notify({ type: 'admin-action', data: entry });
    return entry;
  }
  auditLog(limit = 200): readonly AuditEntry[] { return this.audit.slice(-Math.max(1, Math.min(limit, 5000))).reverse(); }
  /** Every retained audit entry, oldest first (up to the 20,000 kept in memory; reports and analysis). */
  auditAll(): readonly AuditEntry[] { return [...this.audit]; }

  private ok(action: string, meta: AdminMeta, target: string | undefined, before: unknown, after: unknown, extra: Record<string, unknown> = {}): AdminResult {
    const entry = this.recordAudit({ kind: meta.actor === TOXICITY_ACTOR ? 'system' : 'admin', actor: meta.actor, action, ...(target ? { target } : {}), before, after, reason: meta.reason, result: 'ok' });
    return { ok: true, action, auditId: entry.id, before, after, ...extra };
  }

  private breakerAdmin(action: string, target: string | undefined, meta: AdminMeta, run: (m: { actor: string; atMs: number; reason: string }) => import('@maya/house').BreakerAdminResult, before: unknown, after: () => unknown): AdminResult {
    const r = run({ actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok) return fail(r.reason === 'unknown-market' ? 404 : r.reason === 'invalid-meta' ? 400 : 409, r.reason.toUpperCase().replace(/-/g, '_'), `Cannot ${action}: ${r.reason}`);
    for (const ev of r.events) { this.commit({ type: 'breaker', event: ev }); this.notify({ type: 'breaker', data: ev }); }
    return this.ok(action, meta, target, before, after());
  }

  pauseMarket(market: string, meta: AdminMeta): AdminResult {
    if (!this.markets.includes(market as MarketId)) return fail(404, 'UNKNOWN_MARKET', `Unknown market ${market}`);
    const m = market as MarketId;
    return this.breakerAdmin('market-pause', m, meta, x => this.breakers.pauseMarket(m, x), { paused: this.marketPaused(m) }, () => ({ paused: this.marketPaused(m) }));
  }
  resumeMarket(market: string, meta: AdminMeta): AdminResult {
    if (!this.markets.includes(market as MarketId)) return fail(404, 'UNKNOWN_MARKET', `Unknown market ${market}`);
    const m = market as MarketId;
    return this.breakerAdmin('market-resume', m, meta, x => this.breakers.resumeMarket(m, x), { paused: this.marketPaused(m) }, () => ({ paused: this.marketPaused(m) }));
  }
  pauseAll(meta: AdminMeta): AdminResult {
    if (meta.confirm !== 'pause-all') return fail(400, 'CONFIRM_REQUIRED', 'pause-all requires confirm: "pause-all"');
    const before = this.breakerStatus();
    return this.breakerAdmin('pause-all', undefined, meta, x => this.breakers.pauseAll(x), before, () => this.breakerStatus());
  }
  /** Clears the global manual pause and any drawdown state, including one restored from the journal. */
  resumeAll(meta: AdminMeta): AdminResult {
    const before = this.breakerStatus();
    const latched = this.latchedDrawdown;
    const r = this.breakers.resumeAll({ actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok && !latched) return fail(r.reason === 'invalid-meta' ? 400 : 409, r.reason.toUpperCase().replace(/-/g, '_'), `Cannot resume-all: ${r.reason}`);
    const events = r.ok ? [...r.events] : [];
    if (latched && !events.some(e => e.id === 'drawdown')) events.push({ type: 'breaker-transition', id: 'drawdown', from: latched.state, to: 'ok', atMs: this.clock, reason: meta.reason, actor: meta.actor });
    this.latchedDrawdown = undefined;
    for (const ev of events) { this.commit({ type: 'breaker', event: ev }); this.notify({ type: 'breaker', data: ev }); }
    return this.ok('resume-all', meta, undefined, before, this.breakerStatus());
  }

  setPricing(patch: Partial<PricingView>, meta: AdminMeta): AdminResult {
    const before = this.pricingView();
    const keys = ['standardEdge', 'capX100', 'aboveCap', 'impactK', 'z'] as const;
    if (!keys.some(k => patch[k] !== undefined)) return fail(400, 'VALIDATION_ERROR', 'Provide at least one of standardEdge, capX100, aboveCap, impactK, z');
    const inRange = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
    if (patch.standardEdge !== undefined && !inRange(patch.standardEdge, EDGE_RANGE.min, EDGE_RANGE.max)) return fail(400, 'VALIDATION_ERROR', `standardEdge must be within ${EDGE_RANGE.min}–${EDGE_RANGE.max}`);
    if (patch.capX100 !== undefined && (!Number.isSafeInteger(patch.capX100) || !inRange(patch.capX100, CAP_RANGE.min, CAP_RANGE.max))) return fail(400, 'VALIDATION_ERROR', `capX100 must be an integer within ${CAP_RANGE.min}–${CAP_RANGE.max}`);
    if (patch.aboveCap !== undefined && patch.aboveCap !== 'hide' && patch.aboveCap !== 'cap') return fail(400, 'VALIDATION_ERROR', 'aboveCap must be hide or cap');
    if (patch.impactK !== undefined && !inRange(patch.impactK, 0, 10)) return fail(400, 'VALIDATION_ERROR', 'impactK must be within 0–10');
    if (patch.z !== undefined && !inRange(patch.z, 0, 5)) return fail(400, 'VALIDATION_ERROR', 'z must be within 0–5');
    if (patch.standardEdge !== undefined && Math.abs(patch.standardEdge - before.standardEdge) > EDGE_DANGER + EPS && meta.confirm !== 'edge-change') return fail(400, 'CONFIRM_REQUIRED', 'An edge change above 2 points requires confirm: "edge-change"');
    const pricing: HousePricingConfig = Object.freeze({ ...this.pricingConfig, ...(patch.capX100 !== undefined ? { capX100: patch.capX100 } : {}), ...(patch.aboveCap !== undefined ? { aboveCap: patch.aboveCap } : {}), ...(patch.impactK !== undefined ? { impactK: patch.impactK } : {}), ...(patch.z !== undefined ? { z: patch.z } : {}) });
    if (pricing.capX100 < pricing.minX100) return fail(400, 'VALIDATION_ERROR', 'capX100 must be at least the minimum multiplier');
    let schedule: EdgeScheduleConfig | undefined;
    if (patch.standardEdge !== undefined && patch.standardEdge !== this.schedule.config.standard) {
      const r = new EdgeSchedule(this.schedule.config).change({ standard: patch.standardEdge }, { actor: meta.actor, atMs: this.clock, reason: meta.reason });
      if (!r.ok) return fail(400, 'VALIDATION_ERROR', r.reason);
      schedule = r.config;
    }
    const pricingChanged = stableStringify(pricing) !== stableStringify(this.pricingConfig);
    if (!pricingChanged && !schedule) return fail(409, 'NO_CHANGE', 'Pricing already has these values');
    if (pricingChanged) this.commit({ type: 'config', target: 'pricing', after: pricing });
    if (schedule) this.commit({ type: 'config', target: 'schedule', after: schedule });
    return this.ok('pricing', meta, undefined, before, this.pricingView());
  }

  setLaunch(patch: Partial<Pick<LaunchBoost, 'enabled' | 'edge' | 'untilPlayers'>>, meta: AdminMeta): AdminResult {
    if (this.promoConfig) return fail(409, 'LAUNCH_REPLACED', 'The single launch boost was replaced by the SPEC-12 promo tiers: use PUT /admin-api/promo (edit, extend, disable), POST /admin-api/promo/end-tier or POST /admin-api/promo/resume');
    const before = this.launchView();
    if (patch.enabled === undefined && patch.edge === undefined && patch.untilPlayers === undefined) return fail(400, 'VALIDATION_ERROR', 'Provide at least one of enabled, edge, untilPlayers');
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') return fail(400, 'VALIDATION_ERROR', 'enabled must be a boolean');
    if (patch.untilPlayers !== undefined && (!Number.isSafeInteger(patch.untilPlayers) || patch.untilPlayers < 0 || patch.untilPlayers > 10_000_000)) return fail(400, 'VALIDATION_ERROR', 'untilPlayers must be an integer within 0–10,000,000');
    if (patch.edge !== undefined && (typeof patch.edge !== 'number' || !(patch.edge >= EDGE_RANGE.min && patch.edge <= EDGE_RANGE.max))) return fail(400, 'VALIDATION_ERROR', `edge must be within ${EDGE_RANGE.min}–${EDGE_RANGE.max}`);
    const change: EdgeScheduleChange = { launch: { ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.edge !== undefined ? { edge: patch.edge } : {}), ...(patch.untilPlayers !== undefined ? { untilPlayers: patch.untilPlayers } : {}) } };
    const r = new EdgeSchedule(this.schedule.config).change(change, { actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok) return r.reason === 'no-change' ? fail(409, 'NO_CHANGE', 'Launch boost already has these values') : fail(400, 'VALIDATION_ERROR', r.reason);
    const effBefore = resolveEdge(this.schedule.config, { registeredPlayers: this.registered }).edge;
    const effAfter = resolveEdge(r.config, { registeredPlayers: this.registered }).edge;
    const dangerous = Math.abs(r.config.launch.edge - this.schedule.config.launch.edge) > EDGE_DANGER + EPS || Math.abs(effAfter - effBefore) > EDGE_DANGER + EPS;
    if (dangerous && meta.confirm !== 'edge-change') return fail(400, 'CONFIRM_REQUIRED', 'This launch change moves an edge by more than 2 points; it requires confirm: "edge-change"');
    this.commit({ type: 'config', target: 'schedule', after: r.config });
    return this.ok('launch', meta, undefined, before, this.launchView());
  }

  setLimits(patch: Partial<EngineLimits>, meta: AdminMeta): AdminResult {
    const before = { ...this.limitsConfig };
    const fractions = { cellFraction: 0.25, columnFraction: 0.25, globalFraction: 0.5, accountFraction: 0.25 } as const;
    let any = false;
    for (const [k, max] of Object.entries(fractions) as [keyof typeof fractions, number][]) {
      const v = patch[k]; if (v === undefined) continue; any = true;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.00001 || v > max) return fail(400, 'VALIDATION_ERROR', `${k} must be within 0.00001–${max}`);
    }
    for (const k of ['maxStakePerBetCenti', 'maxStakePerCellCenti'] as const) {
      const v = patch[k]; if (v === undefined) continue; any = true;
      if (!isPositiveCenti(v)) return fail(400, 'VALIDATION_ERROR', `${k} must be a positive Centi integer string`);
    }
    if (!any) return fail(400, 'VALIDATION_ERROR', 'Provide at least one limit');
    const after: EngineLimits = Object.freeze({ ...this.limitsConfig, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && (k in fractions || k === 'maxStakePerBetCenti' || k === 'maxStakePerCellCenti'))) });
    const err = validateRiskLimits(after);
    if (err) return fail(400, 'VALIDATION_ERROR', err);
    if (stableStringify(after) === stableStringify(this.limitsConfig)) return fail(409, 'NO_CHANGE', 'Limits already have these values');
    this.commit({ type: 'config', target: 'limits', after });
    return this.ok('limits', meta, undefined, before, { ...after });
  }

  setPlayerFlag(account: string, action: FlagAction, meta: AdminMeta): AdminResult {
    const ids = ledgerAccountOf(account);
    const player = ids ? this.players.get(ids.account) : undefined;
    if (!player) return fail(404, 'UNKNOWN_ACCOUNT', `Unknown account ${account}`);
    const field = action === 'flag' || action === 'unflag' ? 'flagged' : 'blocked';
    const value = action === 'flag' || action === 'block';
    if (player[field] === value) return fail(409, 'NO_CHANGE', `Account is already ${action === 'flag' ? 'flagged' : action === 'unflag' ? 'unflagged' : action === 'block' ? 'blocked' : 'unblocked'}`);
    const before = { flagged: player.flagged, blocked: player.blocked };
    this.commit({ type: 'player-flag', account: player.account, action, actor: meta.actor, reason: meta.reason });
    return this.ok(`player-${action}`, meta, player.account, before, { flagged: player.flagged, blocked: player.blocked });
  }
  private applyFlag(account: string, action: FlagAction, ms: number, actor: string, reason: string): void {
    const p = this.players.get(account)!;
    p.flags.push({ ms, actor, action, reason });
    if (action === 'flag' && !p.flagged) { p.flagged = true; this.flaggedCount++; }
    if (action === 'unflag' && p.flagged) { p.flagged = false; this.flaggedCount--; }
    if (action === 'block') p.blocked = true;
    if (action === 'unblock') p.blocked = false;
  }
  setSim(patch: Partial<SimSettings>, meta: AdminMeta): AdminResult {
    const before = { ...this.simSettings };
    if (patch.running === undefined && patch.speed === undefined && patch.arrivalsPerMin === undefined) return fail(400, 'VALIDATION_ERROR', 'Provide at least one of running, speed, arrivalsPerMin');
    if (patch.running !== undefined && typeof patch.running !== 'boolean') return fail(400, 'VALIDATION_ERROR', 'running must be a boolean');
    if (patch.speed !== undefined && (typeof patch.speed !== 'number' || !(patch.speed >= 0.1 && patch.speed <= 1000))) return fail(400, 'VALIDATION_ERROR', 'speed must be within 0.1–1000');
    if (patch.arrivalsPerMin !== undefined && (!Number.isSafeInteger(patch.arrivalsPerMin) || patch.arrivalsPerMin < 0 || patch.arrivalsPerMin > 100_000)) return fail(400, 'VALIDATION_ERROR', 'arrivalsPerMin must be an integer within 0–100,000');
    const settings: SimSettings = { running: patch.running ?? before.running, speed: patch.speed ?? before.speed, arrivalsPerMin: patch.arrivalsPerMin ?? before.arrivalsPerMin };
    if (stableStringify(settings) === stableStringify(before)) return fail(409, 'NO_CHANGE', 'Simulation already has these settings');
    this.commit({ type: 'sim', settings });
    return this.ok('sim', meta, undefined, before, { ...settings });
  }
  /** Non-admin sim settings change (the runner's own schedule), journaled without an audit entry. */
  applySimSettings(settings: SimSettings): void { this.commit({ type: 'sim', settings }); }

  // ---------------------------------------------------------------- defenses (SPEC-10)

  /** Live only: evaluate the adaptive edge every evalEveryMs of feed time; each move is a journaled event with an audit entry. */
  private maybeEvaluateController(): void {
    const c = this.defensesConfig.controller;
    if (this.nextControllerEvalMs === undefined) this.nextControllerEvalMs = this.clock + c.evalEveryMs;
    if (this.clock < this.nextControllerEvalMs) return;
    this.nextControllerEvalMs = this.clock + c.evalEveryMs;
    for (const ch of this.controller.evaluate(this.clock, c)) {
      this.commit({ type: 'controller', key: ch.key, before: ch.before, after: ch.after, realized: ch.realized, target: ch.target, se: ch.se, bets: ch.bets, avgAdjust: ch.avgAdjust });
      const entry = this.auditEntry({ kind: 'system', actor: CONTROLLER_ACTOR, action: 'controller-adjust', target: ch.key, before: ch.before, after: ch.after, result: 'ok',
        reason: `realized RTP ${(ch.realized * 100).toFixed(2)}% vs target ${(ch.target * 100).toFixed(2)}% over ${ch.bets} non-flagged bets (SE ${(ch.se * 100).toFixed(2)} pts, window-average adjustment ${(ch.avgAdjust * 100).toFixed(2)} pts)` });
      this.commit({ type: 'audit', entry });
      this.notify({ type: 'admin-action', data: entry });
    }
  }

  /**
   * Admin change of the defenses. Switching any defense off requires confirm "defenses-disable";
   * a change that moves an edge charged on new quotes by more than 2 points (controller overrides,
   * disabling the controller, the flow surcharge) requires confirm "edge-change".
   */
  setDefenses(patch: DefensePatch, meta: AdminMeta): AdminResult {
    const before = this.defensesConfig;
    const r = changeDefenses(before, patch, { actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok) return r.reason === 'no-change' ? fail(409, 'NO_CHANGE', r.detail) : fail(400, 'VALIDATION_ERROR', r.detail);
    const effBefore = this.controller.effective(before.controller), effAfter = this.controller.effective(r.config.controller);
    const edgeMove = Math.max(
      ...RANGE_KEYS.map(k => Math.abs((effAfter[k] ?? 0) - (effBefore[k] ?? 0))),
      Math.abs((r.config.toxicity.enabled ? r.config.toxicity.surchargeEdge : 0) - (before.toxicity.enabled ? before.toxicity.surchargeEdge : 0)),
    );
    // Disabling is the stronger class: its confirmation also covers the edge move it causes.
    const needed = r.event.disabled.length ? 'defenses-disable' : edgeMove > EDGE_DANGER + EPS ? 'edge-change' : undefined;
    if (needed === 'defenses-disable' && meta.confirm !== needed) return fail(400, 'CONFIRM_REQUIRED', `Disabling ${r.event.disabled.join(', ')} requires confirm: "defenses-disable"`);
    if (needed === 'edge-change' && meta.confirm !== needed) return fail(400, 'CONFIRM_REQUIRED', 'This change moves an edge charged on new quotes by more than 2 points; it requires confirm: "edge-change"');
    this.commit({ type: 'config', target: 'defenses', after: r.config });
    if (r.config.controller.evalEveryMs !== before.controller.evalEveryMs) this.nextControllerEvalMs = this.clock + r.config.controller.evalEveryMs;
    return this.ok('defenses', meta, undefined, before, r.config, { disabled: r.event.disabled });
  }

  // ---------------------------------------------------------------- promo tiers: guard and admin (SPEC-12)

  /** Live only: the current tier's budget guard every guard.evalEveryMs of feed time; each decision is journaled with an audit entry. */
  private maybeEvaluatePromoGuard(): void {
    const cfg = this.promoConfig;
    if (!cfg) return;
    if (this.nextPromoEvalMs === undefined) this.nextPromoEvalMs = this.clock + cfg.guard.evalEveryMs;
    if (this.clock < this.nextPromoEvalMs) return;
    this.nextPromoEvalMs = this.clock + cfg.guard.evalEveryMs;
    const r = this.currentTier();
    if (!r.config) return;
    const change = this.promoLedger.evaluateGuard(r.config, cfg.guard);
    if (!change) return;
    this.commit({ type: 'promo-guard', change, actor: PROMO_GUARD_ACTOR });
    const entry = this.auditEntry({ kind: 'system', actor: PROMO_GUARD_ACTOR, action: `promo-guard-${change.action}`, target: change.tier, before: change.before, after: change.after, reason: change.reason, result: 'ok' });
    this.commit({ type: 'audit', entry });
    this.notify({ type: 'admin-action', data: entry });
    if (change.action === 'trip') this.alert('critical', `Promo budget breaker tripped for the ${change.tier} tier: ${change.reason}. New quotes use standard pricing until an admin resumes (POST /admin-api/promo/resume).`, 'PROMO_BUDGET_BREAKER');
    else this.alert('info', `Promo budget guard ${change.action} (${change.tier}): ${change.reason}`, 'PROMO_GUARD');
  }

  /** Base edge the main grid would charge on new quotes under `config` (for the confirm rule). */
  private mainEdgeUnder(config: PromoConfig): number {
    const r = resolveTier(config, { players: this.registered, turnoverCenti: this.turnoverCenti });
    return tierPricing(r, this.schedule.config.standard, this.promoLedger.guard(r.tier)).baseEdge;
  }

  /**
   * PUT /admin-api/promo: edit tier fields, extend (raise thresholds, re-enable), disable or re-enable the promo.
   * A change that moves the edge charged on new quotes, or any tier's loss budget, by more than 2 points requires
   * confirm "edge-change". Journaled as `config` (target promo) with an audit entry (before/after, reason, actor).
   */
  setPromo(patch: PromoPatch, meta: AdminMeta): AdminResult {
    if (!this.promoConfig) return fail(409, 'PROMO_NOT_CONFIGURED', 'This server runs the legacy launch boost (no promo tiers configured)');
    const before = this.promoConfig;
    const r = changePromo(before, patch, { actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok) return r.reason === 'no-change' ? fail(409, 'NO_CHANGE', r.detail) : fail(400, 'VALIDATION_ERROR', r.detail);
    const edgeMove = Math.max(Math.abs(this.mainEdgeUnder(r.config) - this.mainEdgeUnder(before)), ...before.tiers.map((t, i) => Math.abs(r.config.tiers[i]!.lossBudget - t.lossBudget)));
    if (edgeMove > EDGE_DANGER + EPS && meta.confirm !== PROMO_CONFIRM.edgeChange) return fail(400, 'CONFIRM_REQUIRED', 'This promo change moves an edge by more than 2 points; it requires confirm: "edge-change"');
    const tierBefore = this.currentTier().tier;
    this.commit({ type: 'config', target: 'promo', after: r.config });
    return this.ok('promo', meta, undefined, { config: before, tier: tierBefore }, { config: r.config, tier: this.currentTier().tier });
  }

  /** POST /admin-api/promo/end-tier: end the current tier early (it is disabled; the next enabled tier, or standard, follows). */
  endPromoTier(meta: AdminMeta): AdminResult {
    if (!this.promoConfig) return fail(409, 'PROMO_NOT_CONFIGURED', 'This server runs the legacy launch boost (no promo tiers configured)');
    const current = this.currentTier();
    if (current.tier === 'standard') return fail(409, 'NO_PROMO_TIER', 'No promo tier is current (standard pricing already applies)');
    if (meta.confirm !== PROMO_CONFIRM.endTier) return fail(400, 'CONFIRM_REQUIRED', 'Ending a promo tier early reprices every new quote; it requires confirm: "promo-end-tier"');
    const r = changePromo(this.promoConfig, { tiers: { [current.tier]: { enabled: false } } }, { actor: meta.actor, atMs: this.clock, reason: meta.reason });
    if (!r.ok) return fail(400, 'VALIDATION_ERROR', r.detail);
    const before = { tier: current.tier, config: this.promoConfig };
    this.commit({ type: 'config', target: 'promo', after: r.config });
    return this.ok('promo-end-tier', meta, current.tier, before, { tier: this.currentTier().tier, config: r.config });
  }

  /** POST /admin-api/promo/resume: clear a tripped budget breaker (default: the current tier), restoring boosted pricing for new quotes. */
  resumePromo(tierRaw: unknown, meta: AdminMeta): AdminResult {
    if (!this.promoConfig) return fail(409, 'PROMO_NOT_CONFIGURED', 'This server runs the legacy launch boost (no promo tiers configured)');
    if (tierRaw !== undefined && !isPromoTierId(tierRaw)) return fail(400, 'VALIDATION_ERROR', `tier must be one of ${PROMO_TIER_IDS.join(', ')}`);
    const current = this.currentTier().tier;
    const tier = (tierRaw ?? current) as TierId;
    if (!isPromoTierId(tier)) return fail(409, 'NO_PROMO_TIER', 'No promo tier is current; name the tier to resume');
    if (meta.confirm !== PROMO_CONFIRM.resume) return fail(400, 'CONFIRM_REQUIRED', 'Resuming boosted pricing after a budget breaker requires confirm: "promo-resume"');
    const change = this.promoLedger.resumeChange(tier, `admin resume: ${meta.reason}`);
    if (!change) return fail(409, 'NOT_TRIPPED', `The ${tier} budget breaker is not tripped`);
    const before = { tier, guard: this.promoLedger.guard(tier) };
    this.commit({ type: 'promo-guard', change, actor: meta.actor });
    return this.ok('promo-resume', meta, tier, before, { tier, guard: this.promoLedger.guard(tier) });
  }

  /** Public promo view (GET /v1/promo, SPEC-12 §6): the tier players are priced in, its progress, and the account's allowance. */
  promoView(account?: string): { tier: TierId; label: string; minWinX100: number; progress: { players: number; untilPlayers: number | null; turnoverCenti: string; untilTurnoverCenti: string | null }; account: { boostRemainingCenti: string | null } | null } {
    const r = this.currentTier(), pricing = this.currentPricing();
    const progress = { players: this.registered, untilPlayers: r.untilPlayers, turnoverCenti: this.turnoverCenti.toString(), untilTurnoverCenti: r.untilTurnoverCenti?.toString() ?? null };
    let accountView: { boostRemainingCenti: string | null } | null = null;
    if (account !== undefined) {
      const ids = ledgerAccountOf(account);
      const p = ids ? this.players.get(ids.account) : undefined;
      const left = pricing.boosted && ids && !p?.flagged ? this.boostRemaining(ids.account, pricing.tier) : null;
      accountView = { boostRemainingCenti: left === null ? null : left.toString() };
    }
    return {
      tier: r.tier, label: pricing.fallback ? `${r.label} (paused)` : r.label, minWinX100: pricing.boosted ? pricing.minWinX100! : this.pricingConfig.minX100,
      progress, account: accountView,
    };
  }

  /** GET /admin-api/promo: configuration and live state per tier (turnover, players, realized loss vs budget, accounts, guard). */
  promoAdminView(): Record<string, unknown> {
    const cfg = this.promoConfig;
    const clock = this.clock;
    if (!cfg) return { configured: false, mode: 'legacy-launch-boost', launch: this.launchView(), clockMs: clock };
    const r = this.currentTier(), pricing = this.currentPricing();
    const standardEdge = this.schedule.config.standard;
    const minStake = BigInt(this.cfg.minStakeCenti);
    const currentIndex = r.tier === 'standard' ? cfg.tiers.length : cfg.tiers.findIndex(t => t.id === r.tier);
    const tiers = [...cfg.tiers.map(t => t.id), 'standard' as const].map((id, index) => {
      const t = tierConfig(cfg, id);
      const book = this.promoLedger.book(id);
      const guard = this.promoLedger.guard(id);
      const cap = this.boostCapCenti(id);
      const wasCurrent = this.tierLog.some(x => x.tier === id);
      const status = index === currentIndex ? 'current' : index < currentIndex ? (wasCurrent ? 'ended' : 'skipped') : (t && !t.enabled ? 'disabled' : 'upcoming');
      const boostedHandle = book.boosted.handle;
      const startIndex = this.tierLog.findIndex(x => x.tier === id);
      const started = startIndex >= 0 ? this.tierLog[startIndex] : undefined;
      const ended = startIndex >= 0 ? this.tierLog.slice(startIndex + 1).find(x => x.tier !== id) : undefined;
      return {
        id, label: t?.label ?? cfg.standardLabel, status, config: t ?? null,
        startedMs: started?.atMs ?? null, endedMs: ended?.atMs ?? null, startPlayers: started?.players ?? null, startTurnoverCenti: started?.turnoverCenti ?? null,
        turnoverCenti: book.turnover.toString(), bets: book.bets, boostedTurnoverCenti: book.boostedTurnover.toString(), boostedBets: book.boostedBets,
        realized: {
          boosted: book.boosted.snapshot(t?.lossBudget), boostedClean: book.boostedClean.snapshot(t?.lossBudget), standardPriced: book.standardPriced.snapshot(), all: book.all.snapshot(t?.lossBudget),
        },
        // What the boost cost against standard pricing on the settled boosted legs: expected house P&L at the standard edge − realized.
        promoCostCenti: (BigInt(Math.round(Number(boostedHandle) * standardEdge)) - book.boosted.housePnl).toString(),
        accounts: { ...this.promoLedger.accountCounts(id, cap, minStake), capCenti: cap?.toString() ?? null },
        guard: { ...guard },
        grid: this.promoGridStats.get(id) ?? null,
      };
    });
    return {
      configured: true, enabled: cfg.enabled, config: cfg, standardEdge, minStakeCenti: this.cfg.minStakeCenti,
      current: { tier: r.tier, label: r.label, boosted: pricing.boosted, ...(pricing.fallback ? { fallback: pricing.fallback } : {}), baseEdge: pricing.baseEdge, lossBudget: pricing.lossBudget ?? null, minWinX100: pricing.boosted ? pricing.minWinX100! : this.pricingConfig.minX100, guardAdjust: pricing.guardAdjust },
      progress: { players: this.registered, untilPlayers: r.untilPlayers, turnoverCenti: this.turnoverCenti.toString(), untilTurnoverCenti: r.untilTurnoverCenti?.toString() ?? null },
      tiers, tierLog: this.tierLog, guard: { config: cfg.guard, nextEvalMs: this.nextPromoEvalMs ?? null, tripped: PROMO_TIER_IDS.filter(id => this.promoLedger.guard(id).tripped) },
      confirm: PROMO_CONFIRM, clockMs: clock,
    };
  }

  /** Overview additions: tier, progress and budget used (SPEC-12 §6). */
  promoOverview(): Record<string, unknown> | null {
    if (!this.promoConfig) return null;
    const r = this.currentTier(), pricing = this.currentPricing();
    const book = this.promoLedger.book(r.tier);
    const t = r.config;
    const agg = book.boosted.snapshot(t?.lossBudget);
    const share = (v: bigint, of: bigint | null) => (of && of > 0n ? Number(v) / Number(of) : null);
    return {
      enabled: this.promoConfig.enabled, tier: r.tier, label: r.label, boosted: pricing.boosted, ...(pricing.fallback ? { fallback: pricing.fallback } : {}), baseEdge: pricing.baseEdge,
      minWinX100: pricing.boosted ? pricing.minWinX100! : this.pricingConfig.minX100,
      progress: { players: this.registered, untilPlayers: r.untilPlayers, playersShare: r.untilPlayers ? this.registered / r.untilPlayers : null, turnoverCenti: this.turnoverCenti.toString(), untilTurnoverCenti: r.untilTurnoverCenti?.toString() ?? null, turnoverShare: share(this.turnoverCenti, r.untilTurnoverCenti) },
      budget: { lossBudget: t?.lossBudget ?? null, tierTurnoverCenti: book.turnover.toString(), settledBoostedCenti: agg.handleCenti, housePnlCenti: agg.housePnlCenti, lossRate: agg.lossRate, lossRateLow: agg.lossRateLow, lossRateHigh: agg.lossRateHigh, budgetUsed: agg.budgetUsed ?? null },
      guard: { ...this.promoLedger.guard(r.tier) },
    };
  }

  /** The budget breakers as breaker rows for the overview (one per tripped tier). */
  promoBreakers(): { id: 'promoBudget'; market?: undefined; state: 'tripped'; since: number; reason: string; tier: PromoTierId }[] {
    // Only the tier being priced now: a tripped tier that has since ended no longer affects any quote (GET /admin-api/promo still lists it).
    const current = this.currentTier().tier;
    return PROMO_TIER_IDS.filter(id => id === current && this.promoLedger.guard(id).tripped).map(id => { const g = this.promoLedger.guard(id); return { id: 'promoBudget' as const, state: 'tripped' as const, since: g.since ?? 0, reason: `${id}: ${g.reason ?? 'budget exceeded'}`, tier: id }; });
  }

  /** Live defense metrics for the admin API (SPEC-10 §8). */
  defensesView(): Record<string, unknown> {
    const d = this.defensesConfig;
    let flagged = 0, blocked = 0, byMonitor = 0, blockedByMonitor = 0;
    for (const p of this.players.values()) {
      if (p.flagged) { flagged++; const last = [...p.flags].reverse().find(f => f.action === 'flag'); if (last?.actor === TOXICITY_ACTOR) byMonitor++; }
      if (p.blocked) { blocked++; const last = [...p.flags].reverse().find(f => f.action === 'block'); if (last?.actor === TOXICITY_ACTOR) blockedByMonitor++; }
    }
    return {
      config: d,
      hold: { enabled: d.hold.enabled, pending: this.holds.size, ...this.holdStats.snapshot(), rejectRate1h: this.holdStats.rejectRate1h(this.clock), rejectRateAll: this.holdStats.rejectRateAll(), latencyMs: this.holdStats.latency() },
      quoteValidity: { enabled: d.quoteValidity.enabled, graceMs: d.quoteValidity.graceMs, maxTtlMs: d.quoteValidity.maxTtlMs },
      minLeadS: d.minLeadS,
      ramp: { enabled: d.ramp.enabled, startCenti: d.ramp.startCenti, perSettledBetCenti: d.ramp.perSettledBetCenti, handleFraction: d.ramp.handleFraction, accountLimitCenti: this.limitAmounts().account.toString() },
      toxicity: { enabled: d.toxicity.enabled, mode: d.toxicity.enabled ? 'graduated' : 'monitor', flowEdge: this.flowEdgeActive(), flagged, flaggedByMonitor: byMonitor, blocked, blockedByMonitor, toxicFlowShare1h: this.flowShare.share1h(this.clock), toxicFlowShareAll: this.flowShare.shareAll() },
      controller: { enabled: d.controller.enabled, nextEvalMs: this.nextControllerEvalMs ?? null, ranges: this.controller.state(this.clock, d.controller) },
      reference: { enabled: d.reference.enabled, moveSigma: d.reference.moveSigma, invalidations: this.referenceInvalidations, lastObservationMs: this.lastReferenceMs ?? null },
    };
  }

  // ---------------------------------------------------------------- views

  limitUsage(): { global: number; maxColumn: number; maxCell: number; maxAccount: number } { return this.book.usage(this.riskEquity(), this.houseLimits()); }
  limitAmounts(): { cell: bigint; column: bigint; account: bigint; global: bigint } { return limitAmounts(this.riskEquity(), this.houseLimits()); }
  activePlayers(windowMs = 300_000): number { let n = 0; const floor = this.clock - windowMs; for (const p of this.players.values()) if (p.lastBetMs > floor && p.lastBetMs > 0) n++; return n; }
  get flagged(): number { return this.flaggedCount; }
  get auditCount(): number { return this.audit.length; }
  bandBounds(market: MarketId, bandIndex: number): { lower: string; upper: string } {
    const h = getMarket(market).bandHeight;
    const scale = (n: bigint) => decimalToString({ coefficient: (BigInt(h.coefficient) * n).toString(), exponent: h.exponent });
    return { lower: scale(BigInt(bandIndex)), upper: scale(BigInt(bandIndex) + 1n) };
  }

  /** Canonical state for rebuild comparison (everything the journal must reproduce). */
  stateSnapshot(): unknown {
    const players = [...this.players.values()].map(p => ({ ...p, cellStakes: [...p.cellStakes].sort(([a], [b]) => (a < b ? -1 : 1)) }));
    return JSON.parse(stableStringify({
      seq: this.seq, legSeq: this.legSeq, voucherSeq: this.voucherSeq, registered: this.registered, flagged: this.flaggedCount,
      ledger: this.ledger.snapshot(), book: this.book.snapshot(), openLegs: [...this.openLegs.values()], settled: this.settledLegs(),
      receipts: [...this.receipts].sort(([a], [b]) => (a < b ? -1 : 1)), players, deposits: [...this.deposits.values()], vouchers: [...this.vouchers.values()], chainWithdrawals: [...this.chainWithdrawals.values()],
      config: this.configSnapshot(), sim: this.simSettings, tables: this.markets.map(m => this.tableInfo(m)), audit: this.audit,
      paths: this.markets.map(m => ({ m, size: this.paths.get(m)!.size, latest: this.paths.get(m)!.latest() })),
      manualBreakers: this.breakerStatus().filter(b => b.id === 'manual' || b.id === 'drawdown'),
      attestation: this.lastAttestation, dust: this.totalDustWei, simCredit: this.simCreditIssued, onchainOpenLiability: this.onchainOpenLiability,
      pendingTreasury: this.pendingOp ?? null, treasurySeq: this.treasurySeq, houseNetBooked: this.houseNetBooked,
      rtp: this.metrics.rtpReport(), phaseLog: this.phaseLog.map(p => ({ phase: p.phase, registered: p.registered })),
      holds: [...this.holds.values()], pendingStake: [...this.pendingStake].sort(([a], [b]) => (a < b ? -1 : 1)), holdStats: this.holdStats.snapshot(),
      controller: this.controller.state(this.clock, this.defensesConfig.controller), flowShare: { handle: this.flowShare.handle, flagged: this.flowShare.flaggedHandle },
      promo: { turnover: this.turnoverCenti, tierLog: this.tierLog.map(t => ({ tier: t.tier, players: t.players, turnoverCenti: t.turnoverCenti, cause: t.cause })), ledger: this.promoLedger.snapshot(), pendingBoost: [...this.pendingBoost].sort(([a], [b]) => (a < b ? -1 : 1)) },
    }));
  }
}

export type { HouseQuote };
