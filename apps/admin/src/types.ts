/**
 * Admin API contract (SPEC §7) as seen by the console. Amounts are `Centi`
 * decimal-integer strings (1 Centi = 0.01 OPEN); times are ms epoch; ratios
 * (edges, RTP, limit usage) are plain fractions (0.03 = 3 %).
 *
 * Fields marked optional are either optional in the spec or console extensions
 * recorded in docs/maya-live/DEVIATIONS.md; the UI degrades gracefully without them.
 */

/** Decimal string of an integer number of centi-OPEN. Never a float. */
export type Centi = string;
/** Decimal string of an integer number of wei (ETH balances). */
export type Wei = string;

export type MarketId = string;
export type FeedMode = 'replay' | 'live';
export type Phase = 'launch' | 'standard';
export type LegStatus = 'open' | 'won' | 'lost' | 'refunded';
export type PlayerKind = 'onchain' | 'sim';

export interface LaunchState {
  readonly enabled: boolean;
  /** true while registeredPlayers < untilPlayers and enabled. */
  readonly active: boolean;
  readonly edge: number;
  readonly untilPlayers: number;
  readonly standardEdge: number;
}

export interface Breaker {
  readonly id: string;
  readonly market?: MarketId;
  /** e.g. 'ok' | 'tripped' | 'widened' | 'paused'; anything but ok/clear is active. */
  readonly state: string;
  readonly since: number;
  readonly reason: string;
  /** SSE breaker events only: the previous state and who caused the transition ('system' for automatic ones). */
  readonly from?: string;
  readonly actor?: string;
  /** SPEC-12 `promoBudget` rows: the promo tier whose budget breaker tripped. */
  readonly tier?: string;
}

export interface MarketState {
  readonly id: MarketId;
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly lastPriceMs: number;
  readonly spot: string;
  readonly sigma: number;
  readonly tableId: string;
}

export interface PricingConfig {
  readonly standardEdge: number;
  readonly capX100: number;
  readonly aboveCap: 'hide' | 'cap';
  readonly impactK: number;
  readonly z: number;
}

export interface LimitsConfig {
  readonly cellFraction: number;
  readonly columnFraction: number;
  readonly globalFraction: number;
  readonly accountFraction: number;
  readonly maxStakePerBetCenti: Centi;
  readonly maxStakePerCellCenti: Centi;
}

export interface SimState {
  readonly running: boolean;
  readonly speed: number;
  readonly arrivalsPerMin: number;
}

/** A vault-health alert computed by the server (SPEC-11: pending timelocks, signer mismatch, stale attestations, escape). */
export interface ChainAlertView {
  readonly code: string;
  readonly level: 'info' | 'warning' | 'critical';
  readonly message: string;
  /** Chain time the condition refers to (an eta or availability time), when there is one. */
  readonly atMs?: number;
}

/** Adaptive edge controller state for one multiplier range (SPEC-10). Adjustments are edge fractions (0.01 = +1 pt). */
export interface ControllerRangeView {
  readonly key: string;
  /** Automatic adjustment the controller learned. */
  readonly adjust: number;
  /** Admin-pinned adjustment; the controller never moves a pinned range. */
  readonly override?: number;
  /** Adjustment applied to new quotes: override, else adjust while the controller is enabled, else 0. */
  readonly effective: number;
  readonly bets: number;
  readonly realized: number | null;
  /** RTP the pricing policy promises for this flow. */
  readonly target: number | null;
  readonly handleCenti?: Centi;
  readonly se?: number | null;
  readonly avgAdjust?: number | null;
  readonly lastChangeMs?: number;
}

/** Overview summary of which SPEC-10 defenses are on. */
export interface DefenseFlags {
  readonly hold: boolean;
  readonly quoteValidity: boolean;
  readonly minLeadS: number;
  readonly ramp: boolean;
  readonly toxicity: 'graduated' | 'monitor';
  readonly controller: boolean;
  readonly reference: boolean;
}

export interface HoldConfig {
  readonly enabled: boolean;
  readonly maxHoldMs: number;
  readonly tolScale: 'relative' | 'logit';
  readonly tolRel: number;
  readonly tolAbs: number;
  readonly onTimeout: 'reject' | 'accept';
  readonly flaggedTolRel: number;
  readonly newAccountHolds: number;
  readonly newAccountTolRel: number;
  readonly newAccountMaxZ: number;
}
export interface QuoteValidityConfig { readonly enabled: boolean; readonly graceMs: number; readonly maxTtlMs: number }
export interface RampConfig { readonly enabled: boolean; readonly startCenti: Centi; readonly perSettledBetCenti: Centi; readonly handleFraction: number }
export interface ToxicityConfig {
  readonly enabled: boolean;
  readonly minBets: number;
  readonly minWins: number;
  readonly surchargeZ: number;
  readonly surchargeEdge: number;
  readonly blockZ: number;
  readonly blockMinBets: number;
  readonly unflagZ: number;
  readonly holdMinN: number;
  readonly holdZ: number;
  readonly holdBlockMinN: number;
  readonly holdBlockZ: number;
}
export interface ControllerConfig {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly evalEveryMs: number;
  readonly minBets: number;
  readonly zGate: number;
  readonly deadband: number;
  readonly maxStepPerEval: number;
  readonly maxStepPerHour: number;
  readonly minAdjust: number;
  readonly maxAdjust: number;
  readonly cleanHoldZ: number;
  readonly overrides: Readonly<Record<string, number>>;
}
export interface ReferenceGuardConfig { readonly enabled: boolean; readonly moveSigma: number }

/** SPEC-10 defense configuration exactly as GET /admin-api/defenses reports it. */
export interface DefenseConfig {
  readonly hold: HoldConfig;
  readonly quoteValidity: QuoteValidityConfig;
  readonly minLeadS: number;
  readonly ramp: RampConfig;
  readonly toxicity: ToxicityConfig;
  readonly controller: ControllerConfig;
  readonly reference: ReferenceGuardConfig;
}

/** PUT /admin-api/defenses body (besides reason/confirm): sections merge one level deep; an override set to null is removed. */
export interface DefensePatch {
  readonly hold?: Partial<HoldConfig>;
  readonly quoteValidity?: Partial<QuoteValidityConfig>;
  readonly minLeadS?: number;
  readonly ramp?: Partial<RampConfig>;
  readonly toxicity?: Partial<ToxicityConfig>;
  readonly controller?: Partial<Omit<ControllerConfig, 'overrides'>> & { readonly overrides?: Readonly<Record<string, number | null>> };
  readonly reference?: Partial<ReferenceGuardConfig>;
}

/** Sub-second reference feed (Pyth Hermes) status; null when the server runs without one (replay). */
export interface ReferenceFeedStatus {
  readonly source: string;
  readonly connected: boolean;
  readonly messages: number;
  readonly prices: number;
  readonly reconnects: number;
  readonly lastMessageMs?: number;
  readonly lastError?: string;
  readonly markets: readonly { readonly market: string; readonly lastPublishMs?: number; readonly value?: number }[];
}

/** GET /admin-api/defenses: configuration plus live defense metrics. */
export interface DefensesView {
  readonly config: DefenseConfig;
  readonly hold: {
    readonly enabled: boolean;
    readonly pending: number;
    readonly created: number;
    readonly accepted: number;
    readonly rejected: number;
    /** Resolutions by outcome detail ('ok', 'fair-value', 'timeout', 'ramp', …). */
    readonly byDetail: Readonly<Record<string, number>>;
    readonly rejectRate1h: number | null;
    readonly rejectRateAll: number | null;
    readonly latencyMs: { readonly p50: number | null; readonly p95: number | null; readonly max: number | null; readonly n: number };
  };
  readonly ramp: { readonly accountLimitCenti?: Centi };
  readonly toxicity: {
    readonly mode: 'graduated' | 'monitor';
    /** Flow surcharge currently charged to flagged accounts. */
    readonly flowEdge: number;
    readonly flagged: number;
    readonly flaggedByMonitor: number;
    readonly blocked: number;
    readonly blockedByMonitor: number;
    readonly toxicFlowShare1h: number | null;
    readonly toxicFlowShareAll: number | null;
  };
  readonly controller: { readonly enabled: boolean; readonly nextEvalMs: number | null; readonly ranges: readonly ControllerRangeView[] };
  readonly reference: { readonly enabled: boolean; readonly moveSigma: number; readonly invalidations: number; readonly lastObservationMs: number | null };
  readonly referenceFeed: ReferenceFeedStatus | null;
  readonly clockMs: number;
}

// ---------------------------------------------------------------- SPEC-12 promo tiers

export type PromoTierId = 'launch' | 'growth' | 'scale';
export type TierId = PromoTierId | 'standard';
export type PromoTierStatus = 'current' | 'ended' | 'skipped' | 'upcoming' | 'disabled';

/** One promo tier's configuration (GET /admin-api/promo `config.tiers[]`). Thresholds are cumulative since launch. */
export interface PromoTierConfig {
  readonly id: PromoTierId;
  readonly label: string;
  readonly enabled: boolean;
  /** The tier ends at this many registered players… */
  readonly untilPlayers: number;
  /** …or at this cumulative turnover, whichever comes first. */
  readonly untilTurnoverCenti: Centi;
  /** Acceptable house loss on the tier's boosted turnover (0.10 = 10 %). */
  readonly lossBudget: number;
  /** Squares below this multiplier (×100) are hidden while the tier is boosted. */
  readonly minWinX100: number;
  readonly perAccountBoostCapCenti: Centi;
}

export interface PromoGuardConfig {
  readonly enabled: boolean;
  readonly evalEveryMs: number;
  readonly minTurnoverCenti: Centi;
  readonly zGate: number;
  readonly deadband: number;
  readonly maxStepPerEval: number;
  readonly maxTighten: number;
  readonly tripMarginRel: number;
  readonly tripZ: number;
  readonly acceptanceSignal: boolean;
}

export interface PromoConfig {
  readonly enabled: boolean;
  /** Exactly launch, growth, scale, in this order. */
  readonly tiers: readonly PromoTierConfig[];
  readonly standardLabel: string;
  readonly guard: PromoGuardConfig;
}

/** PUT /admin-api/promo body (besides reason/confirm): strict keys, nested too. */
export interface PromoPatch {
  readonly enabled?: boolean;
  readonly standardLabel?: string;
  readonly tiers?: Partial<Record<PromoTierId, Partial<Omit<PromoTierConfig, 'id'>>>>;
  readonly guard?: Partial<PromoGuardConfig>;
}

/** A tier's budget guard: the tightening added to its edge and the budget breaker. */
export interface PromoGuardState {
  readonly adjust: number;
  readonly tripped: boolean;
  readonly since?: number;
  readonly reason?: string;
  readonly lastChangeMs?: number;
}

/** Settled aggregate of one slice of a tier (boosted, boosted clean, standard-priced, all legs). */
export interface PromoAggView {
  readonly bets: number;
  readonly wins: number;
  readonly refunds: number;
  readonly handleCenti: Centi;
  readonly returnedCenti: Centi;
  /** Signed: negative = the house lost. */
  readonly housePnlCenti: Centi;
  readonly rtp: number | null;
  readonly expectedRtp: number | null;
  /** Realized house loss rate on handle (−housePnl / handle), with its 95 % interval (±1.96 SE, SE = the largest estimate). */
  readonly lossRate: number | null;
  readonly se: number | null;
  readonly seIndependent: number | null;
  readonly seClustered: number | null;
  readonly seBlock: number | null;
  readonly lossRateLow: number | null;
  readonly lossRateHigh: number | null;
  readonly budget?: number;
  readonly budgetUsed?: number | null;
  readonly budgetCenti?: Centi;
}

export interface PromoTierView {
  readonly id: TierId;
  readonly label: string;
  readonly status: PromoTierStatus;
  /** null for `standard`. */
  readonly config: PromoTierConfig | null;
  readonly startedMs: number | null;
  readonly endedMs: number | null;
  readonly startPlayers: number | null;
  readonly startTurnoverCenti: Centi | null;
  readonly turnoverCenti: Centi;
  readonly bets: number;
  readonly boostedTurnoverCenti: Centi;
  readonly boostedBets: number;
  readonly realized: { readonly boosted: PromoAggView; readonly boostedClean: PromoAggView; readonly standardPriced: PromoAggView; readonly all: PromoAggView };
  /** Signed: boosted settled handle × standard edge − realized boosted house P&L. */
  readonly promoCostCenti: Centi;
  readonly accounts: { readonly boosted: number; readonly capped: number; readonly capCenti: Centi | null };
  readonly guard: PromoGuardState;
  /** Boosted grids published in this tier: priced, offered and hidden-below-minimum squares, lowest multiplier offered. */
  readonly grid: { readonly grids: number; readonly priced: number; readonly offered: number; readonly hiddenMinWin: number; readonly lowestX100: number | null } | null;
}

export interface PromoTierLogEntry {
  readonly atMs: number;
  readonly tier: TierId;
  readonly players: number;
  readonly turnoverCenti: Centi;
  readonly cause: string;
}

export interface PromoProgress {
  readonly players: number;
  readonly untilPlayers: number | null;
  readonly turnoverCenti: Centi;
  readonly untilTurnoverCenti: Centi | null;
}

/** GET /admin-api/promo when promo tiers are configured. */
export interface PromoView {
  readonly configured: true;
  readonly enabled: boolean;
  readonly config: PromoConfig;
  readonly standardEdge: number;
  readonly minStakeCenti: Centi;
  readonly current: {
    readonly tier: TierId;
    readonly label: string;
    readonly boosted: boolean;
    /** 'budget-breaker' while the current tier's breaker has it priced at standard odds. */
    readonly fallback?: string;
    readonly baseEdge: number;
    readonly lossBudget: number | null;
    readonly minWinX100: number;
    readonly guardAdjust: number;
  };
  readonly progress: PromoProgress;
  /** launch, growth, scale, standard. */
  readonly tiers: readonly PromoTierView[];
  readonly tierLog: readonly PromoTierLogEntry[];
  readonly guard: { readonly config: PromoGuardConfig; readonly nextEvalMs: number | null; readonly tripped: readonly PromoTierId[] };
  readonly confirm: { readonly endTier: string; readonly resume: string; readonly edgeChange: string };
  readonly clockMs: number;
}

/** GET /admin-api/promo on a server that runs the legacy single launch boost. */
export interface PromoLegacyView {
  readonly configured: false;
  readonly mode: string;
  readonly clockMs: number;
}

/** Overview `promo` block (null/absent on a legacy server). */
export interface OverviewPromo {
  readonly enabled: boolean;
  readonly tier: TierId;
  readonly label: string;
  readonly boosted: boolean;
  readonly fallback?: string;
  readonly baseEdge: number;
  readonly minWinX100: number;
  readonly progress: PromoProgress & { readonly playersShare: number | null; readonly turnoverShare: number | null };
  readonly budget: {
    readonly lossBudget: number | null;
    readonly tierTurnoverCenti: Centi;
    readonly settledBoostedCenti: Centi;
    readonly housePnlCenti: Centi;
    readonly lossRate: number | null;
    readonly lossRateLow: number | null;
    readonly lossRateHigh: number | null;
    readonly budgetUsed: number | null;
  };
  readonly guard: PromoGuardState;
}

/** SPEC-11 escape hatch as the server reports it (chain times in ms). */
export interface EscapeState {
  readonly mode: boolean;
  /** Escape mode can be (or has been) triggered by anyone. */
  readonly available: boolean;
  readonly lastAttestationAtMs: number;
  readonly escapeDelaySec: number;
  readonly availableAtMs: number;
  readonly secondsUntilAvailable: number;
  readonly poolWei: Wei;
  readonly claimedWei: Wei;
  readonly poolCenti?: Centi;
  readonly claimedCenti?: Centi;
  /** Present on the proof endpoint in escape mode only. */
  readonly entitlementWei?: Wei;
}

/** A vault `Withdrawn` event the ledger could not match to its own voucher (booked conservatively). */
export interface WithdrawalAnomaly {
  readonly key: string;
  readonly player: string;
  readonly nonce: string;
  readonly amountWei: Wei;
  readonly txHash: string;
  readonly outcome: string;
  readonly voucherId?: string;
  readonly ms: number;
}

/** GET /v1/account/:address/proof (player API, public): the account's leaf in the attested balance tree. */
export interface AccountProof {
  readonly account: string;
  readonly chainId: number;
  readonly vault: string;
  readonly attestation: {
    readonly seq: string;
    readonly root: string;
    readonly asOfMs: number;
    readonly liabilitiesWei: Wei;
    readonly source: 'vault' | 'journal';
    readonly txHash?: string;
  } | null;
  readonly included: boolean;
  readonly balanceWei: Wei;
  readonly proof: readonly string[];
  readonly currentOwedWei?: Wei;
  readonly claim?: { readonly function: string; readonly attestedBalance: Wei; readonly proof: readonly string[] };
  readonly escape: EscapeState | null;
  readonly note?: string;
  /** Set when the server failed closed (503 PROOF_UNAVAILABLE): no proof is served, attestation/escape still are. */
  readonly unavailable?: { readonly code: string; readonly message: string };
}

export interface Overview {
  readonly network: string;
  readonly chainId: number;
  readonly operator: string;
  readonly vault: string;
  readonly token: string;
  readonly feedMode: FeedMode;
  readonly speed: number;
  readonly clockMs: number;
  readonly equityCenti: Centi;
  readonly playerBalancesCenti: Centi;
  readonly openLiabilityCenti: Centi;
  readonly limitUsage: { readonly global: number; readonly maxColumn: number; readonly maxCell: number };
  readonly registeredPlayers: number;
  readonly activePlayers5m: number;
  readonly launch: LaunchState;
  readonly breakers: readonly Breaker[];
  readonly markets: readonly MarketState[];
  readonly handle24hCenti: Centi;
  readonly ggr24hCenti: Centi;
  readonly rtp24h: number;
  readonly betsPerMin: number;
  /** Console extension: current config so controls can show an exact "before". */
  readonly pricing?: PricingConfig;
  readonly limits?: LimitsConfig;
  readonly sim?: SimState;
  /** Server extensions (SPEC-10 defenses, SPEC-11 chain health); undefined when not reported. */
  readonly ledgerSigner?: string;
  readonly holdPending?: number;
  /** Share of held placements rejected over the trailing hour; null = no holds yet. */
  readonly holdRejectRate?: number | null;
  readonly holdLatencyP95Ms?: number | null;
  /** Share of handle from flagged accounts over the trailing hour; null = no handle yet. */
  readonly toxicFlowShare?: number | null;
  readonly defenses?: DefenseFlags;
  readonly controller?: { readonly enabled: boolean; readonly ranges: readonly ControllerRangeView[] };
  readonly chainAlerts?: readonly ChainAlertView[];
  /** Server run identity (house-server extension): a new run restarts the replay clock and the journal sequence. */
  readonly runId?: string;
  readonly journalSeq?: number;
  /** SPEC-12 promo tiers; absent on a server running the legacy launch boost (it sends null). */
  readonly promo?: OverviewPromo;
}

export interface MetricsSeries {
  readonly t: readonly number[];
  readonly equity: readonly Centi[];
  readonly ggr: readonly Centi[];
  readonly handle: readonly Centi[];
  readonly rtp: readonly (number | null)[];
  readonly openLiability: readonly Centi[];
  readonly players: readonly number[];
  readonly betsPerMin: readonly number[];
}

export interface RtpRow {
  /** Multiplier range label ('1.01-2' … '20-50'), market id or phase, per table. */
  readonly key: string;
  readonly phase?: Phase;
  readonly bets: number;
  readonly handleCenti?: Centi;
  readonly returnedCenti?: Centi;
  readonly expected: number;
  readonly realized: number | null;
  /** Optional server-computed target band; otherwise the console derives ±2 SE. */
  readonly expectedLow?: number;
  readonly expectedHigh?: number;
}

export interface CalibrationPoint {
  readonly predicted: number;
  readonly observed: number;
  readonly n: number;
}

export interface RtpReport {
  readonly byRange: readonly RtpRow[];
  readonly byMarket: readonly RtpRow[];
  readonly byPhase: readonly RtpRow[];
  readonly calibration?: readonly CalibrationPoint[];
  readonly tables?: readonly { readonly market: MarketId; readonly tableId: string; readonly builtMs?: number; readonly previousTableId?: string }[];
  readonly lastRefitMs?: number;
}

export interface ExposureBand {
  readonly index: number;
  readonly lower?: string;
  readonly upper?: string;
}

export interface ExposureCell {
  readonly start: number;
  readonly bandIndex: number;
  readonly x100: number | null;
  readonly liabilityCenti: Centi;
  readonly limitCenti: Centi;
  readonly legs: number;
  /** Why an unavailable cell is not offered ('too-late', 'below-minimum', 'hidden-above-cap', …; server extension). */
  readonly reason?: string;
}

export interface Exposure {
  readonly market: MarketId;
  readonly windows: readonly number[];
  readonly bands: readonly ExposureBand[];
  readonly cells: readonly ExposureCell[];
  readonly columnLimitCenti?: Centi;
  /** Server clock when the grid was published (server extension). */
  readonly generatedAtMs?: number;
}

export interface PlayerRow {
  readonly account: string;
  readonly kind: PlayerKind;
  readonly strategy?: string;
  readonly balanceCenti: Centi;
  readonly handleCenti: Centi;
  readonly pnlCenti: Centi;
  readonly bets: number;
  readonly rtp: number | null;
  readonly flagged: boolean;
  readonly blocked: boolean;
  readonly firstSeenMs: number;
  /** SPEC-10 toxicity evidence (server extension). */
  readonly holds?: number;
  /** Latency evidence: mean signed fair-value move during holds, in population standard errors. */
  readonly latencyZ?: number | null;
  /** Outcome evidence: excess return over the model, in standard errors. */
  readonly excessReturnZ?: number | null;
}

export interface PlayerPage {
  readonly rows: readonly PlayerRow[];
  readonly nextCursor?: string | null;
  readonly total?: number;
}

export interface BetLeg {
  readonly legId: string;
  readonly account: string;
  readonly kind?: PlayerKind;
  readonly market: MarketId;
  readonly start: number;
  readonly end?: number;
  readonly bandIndex: number;
  /** Optional band price bounds (decimal strings) for display. */
  readonly lower?: string;
  readonly upper?: string;
  readonly stakeCenti: Centi;
  readonly x100: number;
  readonly payoutCenti: Centi;
  readonly status: LegStatus;
  readonly placedMs: number;
  readonly settledMs?: number;
  readonly phase?: Phase;
  /** SPEC-10 acceptance hold: time between request and acceptance (ms). */
  readonly heldMs?: number;
  readonly strategy?: string;
}

export interface LedgerMovement {
  readonly id: string;
  readonly amountCenti: Centi;
  readonly ms: number;
  readonly txHash?: string;
  readonly status?: string;
  readonly dustWei?: Wei;
  /** Withdrawal vouchers (SPEC-11 wiring). */
  readonly nonce?: string;
  readonly expiryMs?: number;
  readonly submittedTxHash?: string;
  readonly claimSource?: string;
  readonly claimNote?: string;
  readonly releaseReason?: string;
}

export interface PlayerFlag {
  readonly ms: number;
  readonly actor: string;
  readonly action: string;
  readonly reason: string;
}

export interface PlayerDetail {
  readonly player: PlayerRow;
  readonly bets: readonly BetLeg[];
  readonly deposits: readonly LedgerMovement[];
  readonly withdrawals: readonly LedgerMovement[];
  readonly flags: readonly PlayerFlag[];
}

export interface BetPage {
  readonly rows: readonly BetLeg[];
  readonly nextCursor?: string | null;
}

export interface Attestation {
  readonly seq: number;
  readonly asOfMs: number;
  readonly liabilitiesCenti: Centi;
  readonly ledgerRoot: string;
  readonly txHash?: string;
  readonly blockNumber?: number;
  /** Balance tree behind the root (SPEC-11): leaf count, leaf total and the persisted tree file. */
  readonly tree?: { readonly leaves: number | null; readonly leafTotalWei: Wei | null; readonly treeFile: string | null; readonly treeSha256: string | null };
}

export interface PendingVoucher {
  readonly account: string;
  readonly amountCenti: Centi;
  readonly nonce: string;
  readonly expiryMs: number;
  readonly voucherId?: string;
  /** 'signing' | 'pending' (signed, not yet seen redeemed on chain). */
  readonly status?: string;
  /** Redemption transaction the server submitted, awaiting its Withdrawn event. */
  readonly submittedTxHash?: string;
}

export interface ChainState {
  readonly network: string;
  readonly chainId: number;
  readonly vault: {
    readonly address: string;
    readonly token: string;
    readonly paused: boolean;
    readonly assetsCenti: Centi;
    readonly houseFundedCenti: Centi;
    readonly totalPlayerDepositsCenti: Centi;
    readonly totalPlayerWithdrawalsCenti: Centi;
    readonly houseWithdrawnCenti?: Centi;
    readonly surplusCenti: Centi;
    readonly maxVoucherAmountCenti?: Centi;
    readonly dailyOutflowCapCenti?: Centi;
    readonly maxAttestationAgeSec?: number;
    readonly ledgerSigner?: string;
    /** SPEC-11 hardening (server extensions); undefined when not reported. */
    readonly serverSigner?: string | null;
    readonly signerMismatch?: boolean;
    readonly pendingSigner?: { readonly address: string; readonly etaMs: number; readonly due: boolean } | null;
    readonly signerChangeDelaySec?: number;
    readonly pendingSignerChangeDelay?: { readonly delaySec: number; readonly etaMs: number } | null;
    readonly houseBufferBps?: number;
    readonly houseDailyCapCenti?: Centi;
    readonly pendingHouseLimits?: { readonly houseBufferBps: number; readonly houseDailyCapCenti: Centi; readonly etaMs: number } | null;
    /** What withdrawHouse accepts now: surplus less the obligations buffer, within the daily house cap. */
    readonly houseWithdrawableCenti?: Centi;
    /** Tokens held above accounted assets (sweepable). */
    readonly excessWei?: Wei;
    readonly excessCenti?: Centi;
    readonly escape?: EscapeState;
    /** The server could not read the vault; the numbers are placeholders. */
    readonly unavailable?: boolean;
  };
  readonly lastAttestation: Attestation | null;
  readonly operator: { readonly address: string; readonly ethWei: Wei; readonly tokenCenti: Centi };
  readonly pendingVouchers: { readonly count: number; readonly totalCenti: Centi; readonly items?: readonly PendingVoucher[] };
  readonly indexer: { readonly lagBlocks: number; readonly lastBlock?: number; readonly headBlock?: number; readonly confirmations?: number };
  readonly alerts?: readonly ChainAlertView[];
  readonly withdrawals?: { readonly indexed: number; readonly anomalies: readonly WithdrawalAnomaly[] };
  /** Vault assets versus ledger assets, to the wei. */
  readonly reconciliation?: { readonly match: boolean; readonly vaultAssetsWei: Wei; readonly ledgerAssetsWei: Wei; readonly deltaWei: string; readonly dustWei: Wei } | null;
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
}

export interface Alert {
  readonly level: 'info' | 'warning' | 'critical';
  readonly message: string;
  readonly ms: number;
  readonly code?: string;
}

export interface RefitProgress {
  readonly jobId: string;
  readonly market?: MarketId;
  readonly progress: number;
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  readonly tableId?: string;
  readonly message?: string;
}

/** Acknowledgement of a write; the server journals before/after. Extra fields pass through. */
export interface WriteAck {
  readonly ok?: boolean;
  readonly action?: string;
  readonly auditId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly jobId?: string;
  readonly txHash?: string;
  readonly [key: string]: unknown;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  /** HTTP status, 0 for network failures. */
  readonly status: number;
  /** Set on a failed write that may still have been applied (5xx, chain timeout): never resubmit it with a new key. */
  readonly outcome?: 'unknown';
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiErrorBody };

/** SSE events on GET /admin-api/stream. */
export type StreamEvent =
  | { readonly type: 'overview'; readonly data: Overview }
  | { readonly type: 'bet'; readonly data: BetLeg }
  | { readonly type: 'settlement'; readonly data: BetLeg }
  | { readonly type: 'breaker'; readonly data: Breaker }
  | { readonly type: 'admin-action'; readonly data: AuditEntry }
  | { readonly type: 'alert'; readonly data: Alert }
  | { readonly type: 'refit'; readonly data: RefitProgress };

export type StreamEventType = StreamEvent['type'];
