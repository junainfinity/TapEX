import type { CellTerms, MarketId, RejectionReason } from '@maya/contracts';
import type { BreakerEvent, DefenseConfig, EdgeScheduleConfig, HousePricingConfig, LimitKind, PromoConfig, PromoGuardChange, PromoTierId, RiskLimits, TierId } from '@maya/house';

export type AccountKind = 'onchain' | 'sim';
export type Phase = 'launch' | 'standard';
export type LegStatus = 'open' | 'won' | 'lost' | 'refunded';

/** Contract rejection reasons plus the house-specific ones. */
export type HouseRejection = RejectionReason | 'LIABILITY_LIMIT' | 'ACCOUNT_BLOCKED' | 'UNKNOWN_ACCOUNT' | 'PRICE_MOVED' | 'MARKET_PAUSED' | 'INVALID_REQUEST';

export interface BetIntent {
  readonly requestId: string;
  /** Public account id: a 0x address (on-chain) or `sim:<id>`. */
  readonly account: string;
  readonly quoteId: string;
  readonly revision?: number;
  readonly cellId: string;
  readonly stakeCenti: string;
}

/** One accepted tap: immutable once journaled. */
export interface LegRecord {
  readonly seq: number;
  readonly legId: string;
  readonly requestId: string;
  readonly account: string;
  readonly ledgerAccount: string;
  readonly kind: AccountKind;
  readonly strategy?: string;
  readonly quoteId: string;
  readonly revision: number;
  readonly cell: CellTerms;
  readonly bandIndex: number;
  readonly x100: number;
  readonly stakeCenti: string;
  readonly payoutCenti: string;
  readonly liabilityCenti: string;
  readonly placedMs: number;
  readonly phase: Phase;
  readonly edge: number;
  /** Calibrated fair probability at issue (expected RTP = p × x100 / 100). */
  readonly p: number;
  readonly tableId: string;
  readonly sourceTimeMs: number;
  readonly flagged: boolean;
  /** RTP-promise edge (phase edge + drawdown widening) the leg was priced under; flow surcharge and controller excluded. */
  readonly policyEdge?: number;
  /** Adaptive controller adjustment included in `edge`. */
  readonly ctlAdjust?: number;
  /** When the placement arrived (differs from placedMs after an acceptance hold). */
  readonly requestedMs?: number;
  /** Fair probability re-validated at the end of the hold. */
  readonly pFresh?: number;
  /**
   * SPEC-12 promo tier current when the quote was issued (absent for legacy launch-boost legs). `phase` keeps its two
   * values for compatibility: 'launch' = priced at a promo tier's boosted odds, 'standard' = standard pricing.
   */
  readonly tier?: TierId;
  /** Priced at the tier's boosted odds (counts against the account's per-tier boost cap). */
  readonly boosted?: boolean;
  /** Budget-guard adjustment included in the boosted edge. */
  readonly guardAdjust?: number;
}

/** A placement waiting for the next first-seen sample (SPEC-10 acceptance hold). */
export interface HoldRecord {
  readonly requestId: string;
  readonly intentKey: string;
  readonly account: string;
  readonly ledgerAccount: string;
  readonly kind: AccountKind;
  readonly quoteId: string;
  readonly cellId: string;
  readonly market: MarketId;
  readonly stakeCenti: string;
  readonly x100: number;
  readonly pQuote: number;
  readonly requestedMs: number;
  /** Latest first-seen second when the request arrived; the hold ends at the first newer one. */
  readonly requestT: number;
  readonly deadlineMs: number;
  /** SPEC-12: the held placement names a boosted quote of this tier; its stake is reserved against the account's boost cap. */
  readonly boostTier?: PromoTierId;
}
export type HoldDetail = 'ok' | 'timeout-accepted' | 'fair-value' | 'fair-value-unavailable' | 'timeout' | 'price-moved' | 'limit' | 'ramp' | 'solvency' | 'balance' | 'cell-cap'
  | 'blocked' | 'paused' | 'stale' | 'late' | 'flag-variant' | 'quote-gone' | 'restart' | 'boost-cap';

export interface LegSettlement {
  readonly status: 'won' | 'lost' | 'refunded';
  readonly settledMs: number;
  readonly creditCenti: string;
  readonly evidenceSampleIds: readonly string[];
  readonly touchTimeMs?: number;
  readonly reason: string;
}

export interface LegView extends LegRecord {
  readonly status: LegStatus;
  readonly settlement?: LegSettlement;
}

export type PlaceResult =
  | { readonly status: 'accepted'; readonly leg: LegView; readonly newlyCommitted: boolean }
  | { readonly status: 'pending'; readonly hold: HoldView; readonly newlyHeld: boolean }
  | { readonly status: 'rejected'; readonly reason: HouseRejection; readonly message?: string; readonly limit?: LimitKind };

/** Player-facing view of a held placement. */
export interface HoldView {
  readonly requestId: string;
  readonly account: string;
  readonly quoteId: string;
  readonly cellId: string;
  readonly market: MarketId;
  readonly stakeCenti: string;
  readonly x100: number;
  readonly requestedMs: number;
  readonly holdUntilMs: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly ms: number;
  readonly kind: 'admin' | 'breaker' | 'system';
  readonly actor: string;
  readonly action: string;
  readonly target?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string;
  readonly result?: string;
  readonly txHash?: string;
}

export interface SimSettings { readonly running: boolean; readonly speed: number; readonly arrivalsPerMin: number }

export interface ConfigSnapshot {
  readonly pricing: HousePricingConfig;
  readonly schedule: EdgeScheduleConfig;
  readonly limits: RiskLimits;
  /** Absent in journals written before SPEC-10 (those runs had every defense off). */
  readonly defenses?: DefenseConfig;
  /** SPEC-12 promo tiers. Absent in journals written before SPEC-12 (the legacy single launch boost). */
  readonly promo?: PromoConfig;
}

export interface BootFeed { readonly mode: 'replay' | 'live'; readonly fromMs?: number; readonly toMs?: number; readonly network?: string; readonly chainId?: number }

export type FlagAction = 'flag' | 'unflag' | 'block' | 'unblock';

export type PendingTreasuryAction = 'fund' | 'withdraw-surplus';
export type TreasuryResolution = 'receipt' | 'vault-state';
/**
 * A house treasury transaction whose outcome the ledger has not booked yet (at most one at a time).
 * sending: the transaction is being sent (or the process stopped before its outcome was known) ·
 * unknown: the chain call timed out or its broadcast state is unknown; it may still be mined.
 * A pending surplus withdrawal's amount is reserved against equity for acceptance and solvency checks.
 */
export interface PendingTreasury {
  readonly opId: string;
  readonly action: PendingTreasuryAction;
  readonly amountCenti: string;
  readonly actor: string;
  readonly startedMs: number;
  readonly state: 'sending' | 'unknown';
  readonly txHash?: string;
  readonly note?: string;
}

interface Base { readonly seq: number; readonly atMs: number }
export type EngineEvent = Base & (
  | { readonly type: 'boot'; readonly runId: string; readonly bootId: string; readonly version: 1; readonly markets: readonly MarketId[]; readonly config?: ConfigSnapshot; readonly feed?: BootFeed }
  | { readonly type: 'sample'; readonly market: MarketId; readonly t: number; readonly price: string; readonly receivedAtMs: number }
  | { readonly type: 'table'; readonly market: MarketId; readonly tableId: string; readonly file?: string; readonly source: 'published' | 'refit'; readonly rows?: number }
  | { readonly type: 'register'; readonly account: string; readonly kind: AccountKind; readonly via: 'sign-in' | 'deposit' | 'sim'; readonly strategy?: string }
  | { readonly type: 'deposit'; readonly account: string; readonly key: string; readonly amountWei: string; readonly centi: string; readonly dustWei: string; readonly depositId: string; readonly txHash: string; readonly logIndex: number; readonly blockNumber: string }
  | { readonly type: 'sim-credit'; readonly account: string; readonly amountCenti: string; readonly grantId: string }
  | { readonly type: 'bet'; readonly leg: LegRecord; readonly intentKey: string }
  | { readonly type: 'settle'; readonly legId: string; readonly status: 'won' | 'lost' | 'refunded'; readonly creditCenti: string; readonly evidence: readonly string[]; readonly touchTimeMs?: number; readonly reason: string }
  | { readonly type: 'voucher'; readonly voucherId: string; readonly requestId: string; readonly account: string; readonly amountCenti: string; readonly nonce: string; readonly expiry: string }
  | { readonly type: 'voucher-signed'; readonly voucherId: string; readonly signature: string }
  | { readonly type: 'voucher-cancelled'; readonly voucherId: string; readonly reason: string }
  | { readonly type: 'voucher-claimed'; readonly voucherId: string; readonly txHash: string }
  /** The server submitted (or saw a receipt for) the voucher's redemption; money moves only on the chain event. */
  | { readonly type: 'voucher-submitted'; readonly voucherId: string; readonly txHash: string }
  /** An unredeemed voucher expired on chain time with its nonce unused: the reserved amount returns to the balance. */
  | { readonly type: 'voucher-expired'; readonly voucherId: string; readonly reason: string }
  /**
   * A vault `Withdrawn` event (any wallet), idempotent by `key` = `player:nonce`. The posting amounts are
   * fixed at commit time so a rebuild applies exactly the same entries.
   */
  | { readonly type: 'withdrawal'; readonly key: string; readonly player: string; readonly nonce: string; readonly amountWei: string; readonly txHash: string; readonly logIndex: number; readonly blockNumber: string;
      readonly outcome: WithdrawalOutcome; readonly voucherId?: string; readonly voucherCenti?: string; readonly clawbackCenti?: string; readonly houseCenti?: string; readonly returnedCenti?: string; readonly dustAddedWei?: string }
  /**
   * A booked house treasury flow. `opId` names the pending operation it settles (absent for syncs and Stage A
   * journals); `resolution` says how its outcome was learned: the transaction receipt, or the vault's house
   * counters after an unknown outcome.
   */
  | { readonly type: 'treasury'; readonly action: 'fund' | 'withdraw-surplus' | 'sync'; readonly amountCenti: string; readonly txHash?: string; readonly dustWei?: string; readonly opId?: string; readonly resolution?: TreasuryResolution }
  /** A treasury transaction is about to be sent: a surplus withdrawal's amount is reserved against equity until it is booked or released. */
  | { readonly type: 'treasury-pending'; readonly opId: string; readonly action: PendingTreasuryAction; readonly amountCenti: string; readonly actor: string }
  /** The chain call of the pending operation ended with an unknown outcome (it may still be mined): it stays pending and reserved. */
  | { readonly type: 'treasury-unknown'; readonly opId: string; readonly txHash?: string; readonly reason: string }
  /** The pending operation moved no money: refused or reverted before mining, or released by an admin once the vault showed no such flow. */
  | { readonly type: 'treasury-released'; readonly opId: string; readonly reason: string; readonly actor: string }
  | { readonly type: 'attest'; readonly attestSeq: string; readonly liabilitiesWei: string; readonly ledgerRoot: string; readonly asOf: string; readonly txHash: string;
      /** Balance-tree facts (absent in Stage A journals): leaf count, Σ leaves (wei) and the persisted tree file with its sha256. */
      readonly leaves?: number; readonly leafTotalWei?: string; readonly treeFile?: string; readonly treeSha256?: string }
  | { readonly type: 'config'; readonly target: 'pricing' | 'schedule' | 'limits' | 'defenses' | 'promo'; readonly after: HousePricingConfig | EdgeScheduleConfig | RiskLimits | DefenseConfig | PromoConfig }
  /** SPEC-12 budget-guard decision for one tier (tighten, relax, trip, or an admin resume). */
  | { readonly type: 'promo-guard'; readonly change: PromoGuardChange; readonly actor: string }
  | { readonly type: 'hold'; readonly hold: HoldRecord }
  | { readonly type: 'hold-resolved'; readonly requestId: string; readonly outcome: 'accepted' | 'rejected'; readonly detail: HoldDetail; readonly reason?: HouseRejection; readonly message?: string; readonly pFresh?: number; readonly freshT?: number; readonly latencyMs: number; readonly legId?: string }
  | { readonly type: 'controller'; readonly key: string; readonly before: number; readonly after: number; readonly realized: number; readonly target: number; readonly se: number; readonly bets: number; readonly avgAdjust: number }
  | { readonly type: 'player-flag'; readonly account: string; readonly action: FlagAction; readonly actor: string; readonly reason: string }
  | { readonly type: 'breaker'; readonly event: BreakerEvent }
  | { readonly type: 'audit'; readonly entry: AuditEntry }
  | { readonly type: 'sim'; readonly settings: SimSettings }
);
export type EngineEventType = EngineEvent['type'];
/** Distributive Omit so each union member keeps its own fields. */
export type EventInput<E = EngineEvent> = E extends unknown ? Omit<E, 'seq' | 'atMs'> : never;

export interface DepositRecord {
  readonly key: string;
  readonly account: string;
  readonly amountWei: string;
  readonly centi: string;
  readonly dustWei: string;
  readonly depositId: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly ms: number;
}

/**
 * signing: funds reserved, signature not yet attached · pending: signed, redeemable until expiry ·
 * claimed: the vault paid it · cancelled: never signed, funds returned · expired: expired unredeemed on
 * chain time (nonce unused), funds returned.
 */
export type VoucherStatus = 'signing' | 'pending' | 'claimed' | 'cancelled' | 'expired';
export interface VoucherRecord {
  readonly voucherId: string;
  readonly requestId: string;
  readonly account: string;
  readonly amountCenti: string;
  /** uint256 decimal string, unique per (run, voucher) so it never collides on a vault shared across runs. */
  readonly nonce: string;
  /** Unix seconds (chain time). */
  readonly expiry: string;
  readonly createdMs: number;
  status: VoucherStatus;
  signature?: string;
  /** Redemption transaction (from the chain event, or from a Stage A receipt claim). */
  txHash?: string;
  /** Redemption the server submitted or saw a receipt for, before the chain event arrived. */
  submittedTxHash?: string;
  /** Block and log index of the `Withdrawn` event that claimed it. */
  claimBlock?: string;
  claimLogIndex?: number;
  /** How the claim was recorded: the chain event (authoritative) or a Stage A receipt. */
  claimSource?: 'event' | 'receipt';
  /** Set when the vault paid a voucher the ledger had already released (see `WithdrawalOutcome`). */
  claimNote?: string;
  cancelReason?: string;
}

/**
 * How a vault `Withdrawn` event was applied:
 * - claimed: it redeemed a signing/pending voucher of the same amount (voucher liability → vault).
 * - claimed-after-release: the voucher had been cancelled or expired and re-credited; the amount is clawed
 *   back from the player's balance, and any shortfall is charged to house equity.
 * - amount-mismatch: the matching voucher names another amount; the voucher is claimed, any excess is charged
 *   to house equity and any unpaid remainder returns to the player (the nonce is spent).
 * - unmatched: no voucher of this ledger has that player:nonce; the outflow is charged to house equity.
 */
export type WithdrawalOutcome = 'claimed' | 'claimed-after-release' | 'amount-mismatch' | 'unmatched';

/** One on-chain redemption seen through `ChainPort.onWithdrawn`. */
export interface WithdrawalRecord {
  readonly key: string;
  readonly player: string;
  readonly nonce: string;
  readonly amountWei: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly outcome: WithdrawalOutcome;
  readonly voucherId?: string;
  readonly ms: number;
}

export interface PlayerFlagEntry { readonly ms: number; readonly actor: string; readonly action: FlagAction; readonly reason: string }

export interface AdminMeta { readonly actor: string; readonly reason: string; readonly confirm?: string }
export type AdminResult =
  | { readonly ok: true; readonly action: string; readonly auditId: string; readonly before: unknown; readonly after: unknown; readonly txHash?: string; readonly jobId?: string; readonly [key: string]: unknown }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly txHash?: string; readonly opId?: string };

/** Engine notifications for the SSE stream (never emitted while rebuilding). */
export type EngineNotice =
  | { readonly type: 'bet' | 'settlement'; readonly data: LegView }
  | { readonly type: 'breaker'; readonly data: BreakerEvent }
  | { readonly type: 'admin-action'; readonly data: AuditEntry }
  | { readonly type: 'alert'; readonly data: { readonly level: 'info' | 'warning' | 'critical'; readonly message: string; readonly ms: number; readonly code?: string } }
  | { readonly type: 'refit'; readonly data: { readonly jobId: string; readonly progress: number; readonly state: 'queued' | 'running' | 'done' | 'failed'; readonly market?: MarketId; readonly tableId?: string; readonly message?: string } };
