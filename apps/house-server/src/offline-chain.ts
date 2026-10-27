import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AttestationRequest, ChainAttestation, ChainDeposit, ChainPort, ChainTx, ChainWithdrawal, PlayerLimits, VaultOperatorExtras, VaultState, WithdrawalVoucher,
} from './chain-port.js';
import { verifyBalanceProof } from './chain/merkle.js';
import { sha256Hex } from './util.js';

const WEI = 10n ** 18n;
const DAY = 86_400n;
const BPS = 10_000n;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** MayaHouseVault constants mirrored here (SPEC-11). */
export const OFFLINE_VAULT_RULES = Object.freeze({
  defaultMaxAttestationAge: 600n,
  maxAttestationAgeLimit: DAY,
  defaultSignerChangeDelay: 48n * 3_600n,
  minSignerChangeDelay: 3_600n,
  maxSignerChangeDelay: 30n * DAY,
  defaultHouseBufferBps: 1_000n,
  defaultHouseDailyCap: 10_000_000n * WEI,
  defaultEscapeDelay: 7n * DAY,
  minEscapeDelay: 3n * DAY,
  maxEscapeDelay: 90n * DAY,
  /** Per-account share of the daily player cap (CS-M2). */
  defaultAccountDailyOutflowCap: 250_000n * WEI,
  /** Proposals are acceptable from their eta through eta + this (CS-L2). */
  timelockGracePeriod: 7n * DAY,
  /** Largest seq increase one attestation may make (CS-H1). */
  maxAttestationSeqStep: 1_000_000n,
});

/** Revert-style error carrying the MayaHouseVault custom error name. */
export class OfflineChainError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = 'OfflineChainError'; }
}

export interface OfflineChainOptions {
  /** Chain time in ms; defaults to the wall clock. Tests and replays inject the feed clock. */
  readonly now?: () => number;
  /** Operator's initial tOPEN supply (MockOpenToken mints 1e9 to the deployer). */
  readonly operatorSupplyWei?: bigint;
  /** House funded at "deploy" like script/Deploy.s.sol (default 1e26 wei); 0 skips. */
  readonly initialHouseFundWei?: bigint;
  /** tOPEN transferred to each testnet player at setup (default 10,000 tOPEN). */
  readonly playerFundingWei?: bigint;
  readonly players?: number;
  /** Deterministic key material; random when omitted. */
  readonly seed?: string;
  readonly maxVoucherAmountWei?: bigint;
  readonly dailyOutflowCapWei?: bigint;
  /** Per-account daily share (default 250,000 tOPEN, clamped into [maxVoucherAmount, dailyOutflowCap]). */
  readonly accountDailyOutflowCapWei?: bigint;
  /** Default 600 s (the vault default since SPEC-11). */
  readonly maxAttestationAgeS?: bigint;
  /** Constructor argument of the vault (default 7 days, bounds 3..90 days). */
  readonly escapeDelayS?: bigint;
  /** Deliver deposit and withdrawal events synchronously (tests / max-speed replays) instead of on a microtask. */
  readonly syncEvents?: boolean;
  /**
   * Persist the whole vault/token state to this JSON file after every state change (atomic replace), and
   * restore from it when it exists, so a server restart that rebuilds its journal reconciles against the
   * same vault. Requires `seed` (the HMAC signer key is re-derived from it, never written). A restored
   * chain re-delivers every recorded Deposited/Withdrawn event to the first subscriber of each kind
   * (at least once, like the live indexer), which closes the crash window between a transaction and the
   * journal flush.
   */
  readonly statePath?: string;
}

interface Attestation extends ChainAttestation { readonly signer: string; readonly assetsAtAttest: bigint; readonly txSeq: number; readonly attestedAtS: bigint }
interface Flow { readonly account: string; readonly atS: bigint; readonly amount: bigint }

/** On-disk form of an OfflineChain (bigints as decimal strings). */
interface OfflineStateV1 {
  readonly version: 1;
  readonly seedCheck: string;
  readonly addresses: { token: string; vault: string; operator: string; ledgerSigner: string };
  readonly players: number;
  readonly block: string; readonly txSeq: number;
  readonly token: [string, string][]; readonly eth: [string, string][];
  readonly usedNonces: string[];
  readonly outflowByDay: [string, string][]; readonly houseOutflowByDay: [string, string][];
  readonly depositLog: { account: string; atS: string; amount: string }[]; readonly payoutLog: { account: string; atS: string; amount: string }[];
  readonly escapeClaimedBy: [string, string][];
  readonly totals: { totalPlayerDeposits: string; houseFunded: string; totalPlayerWithdrawals: string; houseWithdrawn: string; depositCount: string; claimedSinceAttest: string; escapePool: string; escapeClaimedTotal: string };
  readonly paused: boolean; readonly escapeMode: boolean;
  readonly limits: { maxVoucherAmount: string; dailyOutflowCap: string; maxAttestationAge: string; escapeDelay: string; deployedAtS: string; signerChangeDelay: string; houseBufferBps: string; houseDailyCap: string; accountDailyOutflowCap?: string };
  readonly accountOutflowByDay?: [string, string][];
  readonly pendingLimits?: { maxVoucherAmount: string; dailyOutflowCap: string; accountDailyOutflowCap: string; maxAttestationAge: string; eta: string } | null;
  readonly ledgerSignerSinceS?: string;
  readonly ledgerSigner: string;
  readonly pendingSigner: { address: string; eta: string } | null;
  readonly pendingDelay: { delay: string; eta: string } | null;
  readonly pendingHouseLimits: { houseBufferBps: string; houseDailyCap: string; eta: string } | null;
  readonly attestation: { liabilitiesWei: string; asOf: string; seq: string; ledgerRoot: string; signer: string; assetsAtAttest: string; txSeq: number; attestedAtS: string } | null;
  readonly receipts: { kind: string; txHash: string; blockNumber: string; detail: string }[];
  readonly depositEvents: { player: string; amountWei: string; depositId: string; txHash: string; logIndex: number; blockNumber: string }[];
  readonly withdrawalEvents: { player: string; amountWei: string; nonce: string; txHash: string; logIndex: number; blockNumber: string }[];
}
const RECEIPT_TAIL = 500;
const big = (s: string): bigint => BigInt(s);
const pairs = (m: Map<string | bigint, bigint>): [string, string][] => [...m].map(([k, v]) => [k.toString(), v.toString()]);

/**
 * In-memory stand-in for MockOpenToken + MayaHouseVault with the vault's accounting and revert
 * rules (SPEC §5, SPEC-11 and the contracts deviations): measured inflows, EIP-712-style vouchers bound
 * to account/amount/nonce/expiry, unordered nonces, UTC-day outflow caps, attestations with deposits
 * cut at `asOf` and claims reset at the attest transaction, house withdrawals gated by surplus, buffer and
 * a daily cap, timelocked signer rotation and parameter loosening, excess sweeps and the escape hatch.
 * Signatures are HMACs under the offline ledger-signer secret; nothing here touches a real chain.
 */
export class OfflineChain implements ChainPort, VaultOperatorExtras {
  readonly network = 'offline' as const;
  readonly chainId = 0;
  private readonly now: () => number;
  private readonly secret: string;
  private readonly addr: { token: string; vault: string; operator: string; ledgerSigner: string };
  private readonly roster: { role: string; address: string }[];
  private readonly token = new Map<string, bigint>();
  private readonly eth = new Map<string, bigint>();
  private readonly listeners = new Set<(d: ChainDeposit) => void>();
  private readonly withdrawalListeners = new Set<(w: ChainWithdrawal) => void>();
  private readonly usedNonces = new Set<string>();
  private readonly outflowByDay = new Map<bigint, bigint>();
  /** Key `<day>:<account>`. */
  private readonly accountOutflowByDay = new Map<string, bigint>();
  private readonly houseOutflowByDay = new Map<bigint, bigint>();
  private readonly depositLog: Flow[] = [];
  private readonly payoutLog: Flow[] = [];
  private readonly escapeClaimedBy = new Map<string, bigint>();
  private block = 1n;
  private txSeq = 0;
  private running = false;
  totalPlayerDeposits = 0n;
  houseFunded = 0n;
  totalPlayerWithdrawals = 0n;
  houseWithdrawn = 0n;
  depositCount = 0n;
  paused = false;
  maxVoucherAmount: bigint;
  dailyOutflowCap: bigint;
  accountDailyOutflowCap: bigint;
  maxAttestationAge: bigint;
  readonly escapeDelay: bigint;
  readonly deployedAtS: bigint;
  /** The vault's current ledger signer (the offline adapter holds the key for `addresses().ledgerSigner` at deploy). */
  ledgerSigner: string;
  /** Chain time the current signer took office (deployment, then each accepted rotation). */
  ledgerSignerSinceS: bigint;
  private pendingLimits: { maxVoucherAmount: bigint; dailyOutflowCap: bigint; accountDailyOutflowCap: bigint; maxAttestationAge: bigint; eta: bigint } | null = null;
  signerChangeDelay: bigint = OFFLINE_VAULT_RULES.defaultSignerChangeDelay;
  houseBufferBps: bigint = OFFLINE_VAULT_RULES.defaultHouseBufferBps;
  houseDailyCap: bigint = OFFLINE_VAULT_RULES.defaultHouseDailyCap;
  private pendingSigner: { address: string; eta: bigint } | null = null;
  private pendingDelay: { delay: bigint; eta: bigint } | null = null;
  private pendingHouseLimits: { houseBufferBps: bigint; houseDailyCap: bigint; eta: bigint } | null = null;
  escapeMode = false;
  escapePool = 0n;
  escapeClaimedTotal = 0n;
  private attestation: Attestation | undefined;
  private claimedSinceAttest = 0n;
  readonly receipts: { kind: string; txHash: string; blockNumber: bigint; detail: string }[] = [];
  private readonly seedCheck: string;
  /** Size of the deterministic player roster (the external-deposit hook extends the roster only transiently). */
  private readonly playerCount: number;
  /** Every emitted event (kept only when persisting, for re-delivery after a restore). */
  private readonly depositEvents: ChainDeposit[] = [];
  private readonly withdrawalEvents: ChainWithdrawal[] = [];
  private replay: { deposits: ChainDeposit[]; withdrawals: ChainWithdrawal[] } | undefined;
  /** True when this instance was restored from `statePath` rather than freshly "deployed". */
  readonly restored: boolean;

  constructor(private readonly options: OfflineChainOptions = {}) {
    this.now = options.now ?? Date.now;
    if (options.statePath && options.seed === undefined) throw new OfflineChainError('SeedRequired', 'a persisted offline chain needs a seed (its signer key is derived from it and never written)');
    const seed = options.seed ?? randomBytes(16).toString('hex');
    this.secret = sha256Hex(`offline-ledger-signer:${seed}`);
    this.seedCheck = sha256Hex(`offline-seed-check:${seed}`);
    const address = (label: string) => `0x${sha256Hex(`offline:${seed}:${label}`).slice(0, 40)}`;
    this.addr = { token: address('token'), vault: address('vault'), operator: address('open-operator'), ledgerSigner: address('ledger-signer') };
    this.ledgerSigner = this.addr.ledgerSigner;
    this.roster = Array.from({ length: options.players ?? 11 }, (_, i) => ({ role: `player-${i + 1}`, address: address(`player-${i + 1}`) }));
    this.playerCount = this.roster.length;
    this.maxVoucherAmount = options.maxVoucherAmountWei ?? 100_000n * WEI;
    this.dailyOutflowCap = options.dailyOutflowCapWei ?? 1_000_000n * WEI;
    this.accountDailyOutflowCap = options.accountDailyOutflowCapWei ?? defaultAccountCap(this.maxVoucherAmount, this.dailyOutflowCap);
    this.maxAttestationAge = options.maxAttestationAgeS ?? OFFLINE_VAULT_RULES.defaultMaxAttestationAge;
    if (!validLimits({ maxVoucherAmountWei: this.maxVoucherAmount, dailyOutflowCapWei: this.dailyOutflowCap, accountDailyOutflowCapWei: this.accountDailyOutflowCap, maxAttestationAge: this.maxAttestationAge })) {
      throw new OfflineChainError('InvalidLimits', `maxVoucher ${this.maxVoucherAmount}, cap ${this.dailyOutflowCap}, account cap ${this.accountDailyOutflowCap}, age ${this.maxAttestationAge}`);
    }
    this.ledgerSignerSinceS = 0n; // set below: the deployment time, or the restored value
    const state = options.statePath && existsSync(options.statePath) ? this.readState(options.statePath) : undefined;
    this.restored = !!state;
    if (state) {
      this.escapeDelay = big(state.limits.escapeDelay);
      this.deployedAtS = big(state.limits.deployedAtS);
      this.ledgerSignerSinceS = this.deployedAtS;
      this.load(state);
      this.replay = { deposits: [...this.depositEvents], withdrawals: [...this.withdrawalEvents] };
      return;
    }
    const escapeDelay = options.escapeDelayS ?? OFFLINE_VAULT_RULES.defaultEscapeDelay;
    if (escapeDelay < OFFLINE_VAULT_RULES.minEscapeDelay || escapeDelay > OFFLINE_VAULT_RULES.maxEscapeDelay) throw new OfflineChainError('InvalidEscapeDelay', `${escapeDelay}`);
    this.escapeDelay = escapeDelay;
    this.deployedAtS = this.nowS();
    this.ledgerSignerSinceS = this.deployedAtS;
    this.token.set(this.addr.operator, options.operatorSupplyWei ?? 1_000_000_000n * WEI);
    for (const a of [this.addr.operator, this.addr.ledgerSigner]) this.eth.set(a, WEI);
    for (const p of this.roster) {
      this.transfer(this.addr.operator, p.address, options.playerFundingWei ?? 10_000n * WEI);
      this.eth.set(p.address, WEI / 10n);
    }
    const fund = options.initialHouseFundWei ?? 100_000_000n * WEI;
    if (fund > 0n) this.houseFundInternal(fund, 'deploy-fund');
    this.persist();
  }

  // ---------------------------------------------------------------- persistence

  private readState(path: string): OfflineStateV1 {
    let state: OfflineStateV1;
    try { state = JSON.parse(readFileSync(path, 'utf8')) as OfflineStateV1; } catch (error) { throw new OfflineChainError('StateUnreadable', `${path}: ${(error as Error).message}`); }
    if (state?.version !== 1) throw new OfflineChainError('StateVersion', `${path}: unsupported offline chain state version ${String(state?.version)}`);
    if (state.seedCheck !== this.seedCheck || state.addresses.vault !== this.addr.vault || state.addresses.token !== this.addr.token || state.players !== this.playerCount) {
      throw new OfflineChainError('DeploymentMismatch', `${path} belongs to another offline deployment (seed or player count differs)`);
    }
    return state;
  }

  private load(s: OfflineStateV1): void {
    this.block = big(s.block); this.txSeq = s.txSeq;
    for (const [k, v] of s.token) this.token.set(k, big(v));
    for (const [k, v] of s.eth) this.eth.set(k, big(v));
    for (const n of s.usedNonces) this.usedNonces.add(n);
    for (const [k, v] of s.outflowByDay) this.outflowByDay.set(big(k), big(v));
    for (const [k, v] of s.accountOutflowByDay ?? []) this.accountOutflowByDay.set(k, big(v));
    for (const [k, v] of s.houseOutflowByDay) this.houseOutflowByDay.set(big(k), big(v));
    for (const f of s.depositLog) this.depositLog.push({ account: f.account, atS: big(f.atS), amount: big(f.amount) });
    for (const f of s.payoutLog) this.payoutLog.push({ account: f.account, atS: big(f.atS), amount: big(f.amount) });
    for (const [k, v] of s.escapeClaimedBy) this.escapeClaimedBy.set(k, big(v));
    const t = s.totals;
    this.totalPlayerDeposits = big(t.totalPlayerDeposits); this.houseFunded = big(t.houseFunded); this.totalPlayerWithdrawals = big(t.totalPlayerWithdrawals); this.houseWithdrawn = big(t.houseWithdrawn);
    this.depositCount = big(t.depositCount); this.claimedSinceAttest = big(t.claimedSinceAttest); this.escapePool = big(t.escapePool); this.escapeClaimedTotal = big(t.escapeClaimedTotal);
    this.paused = s.paused; this.escapeMode = s.escapeMode;
    const l = s.limits;
    this.maxVoucherAmount = big(l.maxVoucherAmount); this.dailyOutflowCap = big(l.dailyOutflowCap); this.maxAttestationAge = big(l.maxAttestationAge);
    this.signerChangeDelay = big(l.signerChangeDelay); this.houseBufferBps = big(l.houseBufferBps); this.houseDailyCap = big(l.houseDailyCap);
    this.accountDailyOutflowCap = l.accountDailyOutflowCap !== undefined ? big(l.accountDailyOutflowCap) : defaultAccountCap(this.maxVoucherAmount, this.dailyOutflowCap);
    const pl = s.pendingLimits;
    this.pendingLimits = pl ? { maxVoucherAmount: big(pl.maxVoucherAmount), dailyOutflowCap: big(pl.dailyOutflowCap), accountDailyOutflowCap: big(pl.accountDailyOutflowCap), maxAttestationAge: big(pl.maxAttestationAge), eta: big(pl.eta) } : null;
    if (s.ledgerSignerSinceS !== undefined) this.ledgerSignerSinceS = big(s.ledgerSignerSinceS);
    this.ledgerSigner = s.ledgerSigner;
    this.pendingSigner = s.pendingSigner ? { address: s.pendingSigner.address, eta: big(s.pendingSigner.eta) } : null;
    this.pendingDelay = s.pendingDelay ? { delay: big(s.pendingDelay.delay), eta: big(s.pendingDelay.eta) } : null;
    this.pendingHouseLimits = s.pendingHouseLimits ? { houseBufferBps: big(s.pendingHouseLimits.houseBufferBps), houseDailyCap: big(s.pendingHouseLimits.houseDailyCap), eta: big(s.pendingHouseLimits.eta) } : null;
    const a = s.attestation;
    this.attestation = a ? { liabilitiesWei: big(a.liabilitiesWei), asOf: big(a.asOf), seq: big(a.seq), ledgerRoot: a.ledgerRoot, signer: a.signer, assetsAtAttest: big(a.assetsAtAttest), txSeq: a.txSeq, attestedAtS: big(a.attestedAtS) } : undefined;
    for (const r of s.receipts) this.receipts.push({ kind: r.kind, txHash: r.txHash, blockNumber: big(r.blockNumber), detail: r.detail });
    for (const d of s.depositEvents) this.depositEvents.push({ player: d.player, amountWei: big(d.amountWei), depositId: big(d.depositId), txHash: d.txHash, logIndex: d.logIndex, blockNumber: big(d.blockNumber) });
    for (const w of s.withdrawalEvents) this.withdrawalEvents.push({ player: w.player, amountWei: big(w.amountWei), nonce: big(w.nonce), txHash: w.txHash, logIndex: w.logIndex, blockNumber: big(w.blockNumber) });
  }

  /** Write the full state (atomic replace) when a state file is configured. Called after every state change. */
  private persist(): void {
    const path = this.options.statePath;
    if (!path) return;
    const a = this.attestation;
    const state: OfflineStateV1 = {
      version: 1, seedCheck: this.seedCheck, addresses: { ...this.addr }, players: this.playerCount, block: this.block.toString(), txSeq: this.txSeq,
      token: pairs(this.token), eth: pairs(this.eth), usedNonces: [...this.usedNonces], outflowByDay: pairs(this.outflowByDay), houseOutflowByDay: pairs(this.houseOutflowByDay),
      accountOutflowByDay: pairs(this.accountOutflowByDay),
      depositLog: this.depositLog.map(f => ({ account: f.account, atS: f.atS.toString(), amount: f.amount.toString() })),
      payoutLog: this.payoutLog.map(f => ({ account: f.account, atS: f.atS.toString(), amount: f.amount.toString() })),
      escapeClaimedBy: pairs(this.escapeClaimedBy),
      totals: {
        totalPlayerDeposits: this.totalPlayerDeposits.toString(), houseFunded: this.houseFunded.toString(), totalPlayerWithdrawals: this.totalPlayerWithdrawals.toString(), houseWithdrawn: this.houseWithdrawn.toString(),
        depositCount: this.depositCount.toString(), claimedSinceAttest: this.claimedSinceAttest.toString(), escapePool: this.escapePool.toString(), escapeClaimedTotal: this.escapeClaimedTotal.toString(),
      },
      paused: this.paused, escapeMode: this.escapeMode,
      limits: {
        maxVoucherAmount: this.maxVoucherAmount.toString(), dailyOutflowCap: this.dailyOutflowCap.toString(), maxAttestationAge: this.maxAttestationAge.toString(), escapeDelay: this.escapeDelay.toString(),
        deployedAtS: this.deployedAtS.toString(), signerChangeDelay: this.signerChangeDelay.toString(), houseBufferBps: this.houseBufferBps.toString(), houseDailyCap: this.houseDailyCap.toString(),
        accountDailyOutflowCap: this.accountDailyOutflowCap.toString(),
      },
      pendingLimits: this.pendingLimits ? {
        maxVoucherAmount: this.pendingLimits.maxVoucherAmount.toString(), dailyOutflowCap: this.pendingLimits.dailyOutflowCap.toString(),
        accountDailyOutflowCap: this.pendingLimits.accountDailyOutflowCap.toString(), maxAttestationAge: this.pendingLimits.maxAttestationAge.toString(), eta: this.pendingLimits.eta.toString(),
      } : null,
      ledgerSignerSinceS: this.ledgerSignerSinceS.toString(),
      ledgerSigner: this.ledgerSigner,
      pendingSigner: this.pendingSigner ? { address: this.pendingSigner.address, eta: this.pendingSigner.eta.toString() } : null,
      pendingDelay: this.pendingDelay ? { delay: this.pendingDelay.delay.toString(), eta: this.pendingDelay.eta.toString() } : null,
      pendingHouseLimits: this.pendingHouseLimits ? { houseBufferBps: this.pendingHouseLimits.houseBufferBps.toString(), houseDailyCap: this.pendingHouseLimits.houseDailyCap.toString(), eta: this.pendingHouseLimits.eta.toString() } : null,
      attestation: a ? { liabilitiesWei: a.liabilitiesWei.toString(), asOf: a.asOf.toString(), seq: a.seq.toString(), ledgerRoot: a.ledgerRoot, signer: a.signer, assetsAtAttest: a.assetsAtAttest.toString(), txSeq: a.txSeq, attestedAtS: a.attestedAtS.toString() } : null,
      receipts: this.receipts.slice(-RECEIPT_TAIL).map(r => ({ kind: r.kind, txHash: r.txHash, blockNumber: r.blockNumber.toString(), detail: r.detail })),
      depositEvents: this.depositEvents.map(d => ({ player: d.player, amountWei: d.amountWei.toString(), depositId: d.depositId.toString(), txHash: d.txHash, logIndex: d.logIndex, blockNumber: d.blockNumber.toString() })),
      withdrawalEvents: this.withdrawalEvents.map(w => ({ player: w.player, amountWei: w.amountWei.toString(), nonce: w.nonce.toString(), txHash: w.txHash, logIndex: w.logIndex, blockNumber: w.blockNumber.toString() })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(state));
    renameSync(`${path}.tmp`, path);
  }
  /** Persist, then return `value` (every state-changing method ends here). */
  private done<T>(value: T): T { this.persist(); return value; }

  addresses(): { token: string; vault: string; operator: string; ledgerSigner: string } { return { ...this.addr, ledgerSigner: this.ledgerSigner }; }
  /** Address of the ledger-signer key this adapter holds (the vault's signer at deploy; differs after a rotation). */
  get signerKeyAddress(): string { return this.addr.ledgerSigner; }
  async start(): Promise<void> { this.running = true; }
  async stop(): Promise<void> { this.running = false; }
  onDeposit(listener: (d: ChainDeposit) => void): () => void {
    this.listeners.add(listener);
    // After a restore, the first subscriber gets every recorded deposit again (at least once; the ledger dedupes).
    const pending = this.replay?.deposits.splice(0);
    if (pending?.length) this.deliverTo(listener, pending);
    return () => { this.listeners.delete(listener); };
  }
  onWithdrawn(listener: (w: ChainWithdrawal) => void): () => void {
    this.withdrawalListeners.add(listener);
    const pending = this.replay?.withdrawals.splice(0);
    if (pending?.length) this.deliverTo(listener, pending);
    return () => { this.withdrawalListeners.delete(listener); };
  }
  private deliverTo<E>(listener: (e: E) => void, events: readonly E[]): void {
    const deliver = () => { for (const e of events) listener(e); };
    if (this.options.syncEvents) deliver(); else queueMicrotask(deliver);
  }
  players(): readonly { role: string; address: string }[] { return this.roster.map(p => ({ ...p })); }
  indexerLagBlocks(): number { return 0; }
  explorerUrl(): string | null { return null; }
  private nowS(): bigint { return BigInt(Math.floor(this.now() / 1000)); }
  /** Chain time (Unix seconds) as the vault sees it (block.timestamp). */
  chainNowS(): bigint { return this.nowS(); }
  get assets(): bigint { return this.totalPlayerDeposits + this.houseFunded - this.totalPlayerWithdrawals - this.houseWithdrawn; }
  get isRunning(): boolean { return this.running; }

  private transfer(from: string, to: string, amount: bigint): void {
    const balance = this.token.get(from) ?? 0n;
    if (amount <= 0n) throw new OfflineChainError('ZeroAmount', 'amount must be positive');
    if (balance < amount) throw new OfflineChainError('ERC20InsufficientBalance', `${from} holds ${balance}, needs ${amount}`);
    this.token.set(from, balance - amount);
    this.token.set(to, (this.token.get(to) ?? 0n) + amount);
  }
  private tx(kind: string, detail: string): ChainTx & { blockNumber: bigint } {
    this.txSeq++; this.block++;
    const txHash = `0x${sha256Hex(`offline-tx:${this.addr.vault}:${this.txSeq}:${kind}:${detail}`)}`;
    this.receipts.push({ kind, txHash, blockNumber: this.block, detail });
    return { txHash, blockNumber: this.block };
  }
  private emit<E>(listeners: Set<(e: E) => void>, event: E): void {
    const deliver = () => { for (const l of [...listeners]) l(event); };
    if (this.options.syncEvents) deliver(); else queueMicrotask(deliver);
  }
  private requireNotEscaped(): void {
    if (this.escapeMode) throw new OfflineChainError('EscapeModeActive', 'the vault is in escape mode');
  }
  private holdsSignerKey(): boolean { return this.ledgerSigner === this.addr.ledgerSigner; }
  private houseFundInternal(amount: bigint, kind: string): ChainTx {
    this.transfer(this.addr.operator, this.addr.vault, amount);
    this.houseFunded += amount;
    return this.tx(kind, amount.toString());
  }

  private digest(v: WithdrawalVoucher): string {
    return `${this.chainId}|${this.addr.vault}|${v.account.toLowerCase()}|${v.amountWei}|${v.nonce}|${v.expiry}`;
  }
  private hmac(v: WithdrawalVoucher): string {
    return `0x${createHmac('sha256', this.secret).update(this.digest(v)).digest('hex')}${'00'.repeat(32)}1b`;
  }
  async signWithdrawal(v: WithdrawalVoucher): Promise<string> {
    if (!this.holdsSignerKey()) throw new OfflineChainError('SignerMismatch', `the vault's ledger signer is ${this.ledgerSigner}; this adapter holds ${this.addr.ledgerSigner}`);
    if (v.amountWei <= 0n || v.nonce < 0n || v.expiry < 0n) throw new OfflineChainError('InvalidVoucher', 'voucher terms out of range');
    return this.hmac(v);
  }

  async nonceUsed(account: string, nonce: bigint): Promise<boolean> { return this.usedNonces.has(`${account.toLowerCase()}:${nonce}`); }

  async fundHouse(amountWei: bigint): Promise<ChainTx> {
    this.requireNotEscaped();
    return this.done(this.houseFundInternal(amountWei, 'fundHouse'));
  }

  async attest(a: AttestationRequest): Promise<ChainTx> {
    this.requireNotEscaped();
    if (!this.holdsSignerKey()) throw new OfflineChainError('NotLedgerSigner', `${this.addr.ledgerSigner} is not the vault's signer ${this.ledgerSigner}`);
    const last = this.attestation?.seq ?? 0n;
    if (a.seq <= last || a.seq < 1n) throw new OfflineChainError('NonIncreasingSeq', `${a.seq} <= ${last}`);
    const maxStep = OFFLINE_VAULT_RULES.maxAttestationSeqStep;
    if (a.seq - last > maxStep) throw new OfflineChainError('SeqStepTooLarge', `${a.seq} is more than ${maxStep} past ${last}`);
    if (a.asOf > this.nowS()) throw new OfflineChainError('AttestationFromFuture', `${a.asOf} > ${this.nowS()}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(a.ledgerRoot)) throw new OfflineChainError('InvalidRoot', 'ledgerRoot must be bytes32');
    const receipt = this.tx('attest', `${a.seq}:${a.liabilitiesWei}`);
    this.attestation = {
      liabilitiesWei: a.liabilitiesWei, asOf: a.asOf, seq: a.seq, ledgerRoot: a.ledgerRoot.toLowerCase(), signer: this.ledgerSigner,
      assetsAtAttest: this.assets, txSeq: this.txSeq, attestedAtS: this.nowS(),
    };
    this.claimedSinceAttest = 0n;
    return this.done({ txHash: receipt.txHash });
  }

  /** Deposits mined at or after the attestation's asOf. */
  depositsSinceAttest(): bigint {
    if (!this.attestation) return this.totalPlayerDeposits;
    let sum = 0n;
    for (const d of this.depositLog) if (d.atS >= this.attestation.asOf) sum += d.amount;
    return sum;
  }
  requiredAssets(): bigint {
    const req = (this.attestation?.liabilitiesWei ?? 0n) + this.depositsSinceAttest() - this.claimedSinceAttest;
    return req > 0n ? req : 0n;
  }
  houseSurplus(): bigint { const s = this.assets - this.requiredAssets(); return s > 0n ? s : 0n; }
  /** ceil(requiredAssets * houseBufferBps / 10_000). */
  houseBuffer(): bigint { return (this.requiredAssets() * this.houseBufferBps + BPS - 1n) / BPS; }
  remainingHouseDailyOutflow(): bigint {
    const used = this.houseOutflowByDay.get(this.nowS() / DAY) ?? 0n;
    return used >= this.houseDailyCap ? 0n : this.houseDailyCap - used;
  }
  houseWithdrawable(): bigint {
    const surplus = this.houseSurplus(); const buffer = this.houseBuffer();
    const afterBuffer = surplus > buffer ? surplus - buffer : 0n;
    const remaining = this.remainingHouseDailyOutflow();
    return afterBuffer < remaining ? afterBuffer : remaining;
  }
  excess(): bigint { const held = this.token.get(this.addr.vault) ?? 0n; return held > this.assets ? held - this.assets : 0n; }
  lastAttestationAt(): bigint { return this.attestation ? this.attestation.attestedAtS : this.deployedAtS; }
  /** A newly accepted signer gets a full escape window before its predecessor's root can be frozen (CS-H1). */
  escapeAvailableAt(): bigint {
    const since = this.lastAttestationAt() > this.ledgerSignerSinceS ? this.lastAttestationAt() : this.ledgerSignerSinceS;
    return since + this.escapeDelay;
  }
  /** Escape mode: accounted assets above what claims can still take; 0 otherwise. */
  escapeSurplus(): bigint {
    if (!this.escapeMode) return 0n;
    const reserved = this.escapePool - this.escapeClaimedTotal;
    return this.assets > reserved ? this.assets - reserved : 0n;
  }
  async remainingAccountDailyOutflow(account: string): Promise<bigint> {
    const day = this.nowS() / DAY;
    const used = this.accountOutflowByDay.get(`${day}:${account.toLowerCase()}`) ?? 0n;
    const own = used >= this.accountDailyOutflowCap ? 0n : this.accountDailyOutflowCap - used;
    const usedAll = this.outflowByDay.get(day) ?? 0n;
    const shared = usedAll >= this.dailyOutflowCap ? 0n : this.dailyOutflowCap - usedAll;
    return own < shared ? own : shared;
  }
  /** Proposals are acceptable from their eta through eta + the grace period (CS-L2). */
  private requireDue(eta: bigint): void {
    const now = this.nowS();
    if (now < eta) throw new OfflineChainError('TimelockNotElapsed', `${eta} > ${now}`);
    const expiredAt = eta + OFFLINE_VAULT_RULES.timelockGracePeriod;
    if (now > expiredAt) throw new OfflineChainError('ProposalExpired', `expired at ${expiredAt}, now ${now}`);
  }

  async withdrawHouse(amountWei: bigint, to: string): Promise<ChainTx> {
    if (this.paused) throw new OfflineChainError('EnforcedPause', 'vault paused');
    this.requireNotEscaped();
    if (amountWei <= 0n) throw new OfflineChainError('ZeroAmount', 'amount must be positive');
    const recipient = to.toLowerCase();
    if (recipient === ZERO_ADDRESS) throw new OfflineChainError('ZeroAddress', 'recipient is the zero address');
    if (recipient === this.addr.vault) throw new OfflineChainError('InvalidRecipient', 'recipient is the vault');
    if (!this.attestation) throw new OfflineChainError('NoAttestation', 'attest first');
    if (this.attestation.signer !== this.ledgerSigner) throw new OfflineChainError('AttestationBySupersededSigner', `${this.attestation.signer} != ${this.ledgerSigner}`);
    const age = this.nowS() - this.attestation.asOf;
    if (age > this.maxAttestationAge) throw new OfflineChainError('AttestationTooOld', `${age} > ${this.maxAttestationAge}`);
    const surplus = this.houseSurplus();
    if (amountWei > surplus) throw new OfflineChainError('ExceedsHouseSurplus', `${amountWei} > ${surplus}`);
    const buffer = this.houseBuffer();
    const withdrawable = surplus > buffer ? surplus - buffer : 0n;
    if (amountWei > withdrawable) throw new OfflineChainError('ExceedsHouseWithdrawable', `${amountWei} > ${withdrawable} (buffer ${buffer})`);
    const day = this.nowS() / DAY;
    const used = this.houseOutflowByDay.get(day) ?? 0n;
    if (used + amountWei > this.houseDailyCap) throw new OfflineChainError('HouseDailyCapExceeded', `${used + amountWei} > ${this.houseDailyCap}`);
    this.transfer(this.addr.vault, recipient, amountWei);
    this.houseOutflowByDay.set(day, used + amountWei);
    this.houseWithdrawn += amountWei;
    return this.done({ txHash: this.tx('withdrawHouse', amountWei.toString()).txHash });
  }

  async sweepExcess(to: string): Promise<ChainTx & { amountWei: bigint }> {
    const recipient = to.toLowerCase();
    if (recipient === ZERO_ADDRESS) throw new OfflineChainError('ZeroAddress', 'recipient is the zero address');
    if (recipient === this.addr.vault) throw new OfflineChainError('InvalidRecipient', 'recipient is the vault');
    const amount = this.excess();
    if (amount === 0n) throw new OfflineChainError('NothingToSweep', 'no tokens above accounted assets');
    this.transfer(this.addr.vault, recipient, amount);
    return this.done({ txHash: this.tx('sweepExcess', amount.toString()).txHash, amountWei: amount });
  }

  async pauseVault(): Promise<ChainTx> {
    if (this.paused) throw new OfflineChainError('EnforcedPause', 'already paused');
    this.paused = true; return this.done({ txHash: this.tx('pause', '').txHash });
  }
  async unpauseVault(): Promise<ChainTx> {
    if (!this.paused) throw new OfflineChainError('ExpectedPause', 'not paused');
    this.paused = false; return this.done({ txHash: this.tx('unpause', '').txHash });
  }

  // ---------------------------------------------------------------- timelocked admin

  async proposeLedgerSigner(address: string): Promise<ChainTx> {
    const next = address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(next)) throw new OfflineChainError('InvalidAddress', address);
    if (next === ZERO_ADDRESS) throw new OfflineChainError('ZeroAddress', 'signer is the zero address');
    if (next === this.addr.operator) throw new OfflineChainError('SignerIsOwner', next);
    if (next === this.ledgerSigner) throw new OfflineChainError('SignerUnchanged', next);
    this.pendingSigner = { address: next, eta: this.nowS() + this.signerChangeDelay };
    return this.done({ txHash: this.tx('proposeLedgerSigner', next).txHash });
  }
  async acceptLedgerSigner(): Promise<ChainTx> {
    const pending = this.pendingSigner;
    if (!pending) throw new OfflineChainError('NoPendingLedgerSigner', 'nothing proposed');
    this.requireDue(pending.eta);
    this.pendingSigner = null;
    this.ledgerSigner = pending.address;
    this.ledgerSignerSinceS = this.nowS();
    return this.done({ txHash: this.tx('acceptLedgerSigner', pending.address).txHash });
  }
  async cancelLedgerSigner(): Promise<ChainTx> {
    if (!this.pendingSigner) throw new OfflineChainError('NoPendingLedgerSigner', 'nothing proposed');
    const dropped = this.pendingSigner.address;
    this.pendingSigner = null;
    return this.done({ txHash: this.tx('cancelLedgerSigner', dropped).txHash });
  }

  async setSignerChangeDelay(delaySeconds: bigint): Promise<ChainTx> {
    const r = OFFLINE_VAULT_RULES;
    if (delaySeconds < r.minSignerChangeDelay || delaySeconds > r.maxSignerChangeDelay || delaySeconds >= this.escapeDelay) throw new OfflineChainError('InvalidSignerChangeDelay', `${delaySeconds}`);
    this.pendingDelay = null;
    if (delaySeconds >= this.signerChangeDelay) this.signerChangeDelay = delaySeconds;
    else this.pendingDelay = { delay: delaySeconds, eta: this.nowS() + this.signerChangeDelay };
    return this.done({ txHash: this.tx('setSignerChangeDelay', delaySeconds.toString()).txHash });
  }
  async acceptSignerChangeDelay(): Promise<ChainTx> {
    const pending = this.pendingDelay;
    if (!pending) throw new OfflineChainError('NoPendingSignerChangeDelay', 'nothing scheduled');
    this.requireDue(pending.eta);
    this.pendingDelay = null;
    this.signerChangeDelay = pending.delay;
    return this.done({ txHash: this.tx('acceptSignerChangeDelay', pending.delay.toString()).txHash });
  }
  async cancelSignerChangeDelay(): Promise<ChainTx> {
    if (!this.pendingDelay) throw new OfflineChainError('NoPendingSignerChangeDelay', 'nothing scheduled');
    this.pendingDelay = null;
    return this.done({ txHash: this.tx('cancelSignerChangeDelay', '').txHash });
  }

  async setHouseLimits(houseBufferBps: bigint, houseDailyCapWei: bigint): Promise<ChainTx> {
    if (houseBufferBps < 0n || houseBufferBps > BPS || houseDailyCapWei <= 0n) throw new OfflineChainError('InvalidHouseLimits', `${houseBufferBps} bps, cap ${houseDailyCapWei}`);
    this.pendingHouseLimits = null;
    if (houseBufferBps >= this.houseBufferBps && houseDailyCapWei <= this.houseDailyCap) {
      this.houseBufferBps = houseBufferBps; this.houseDailyCap = houseDailyCapWei;
    } else {
      this.pendingHouseLimits = { houseBufferBps, houseDailyCap: houseDailyCapWei, eta: this.nowS() + this.signerChangeDelay };
    }
    return this.done({ txHash: this.tx('setHouseLimits', `${houseBufferBps}:${houseDailyCapWei}`).txHash });
  }
  async acceptHouseLimits(): Promise<ChainTx> {
    const pending = this.pendingHouseLimits;
    if (!pending) throw new OfflineChainError('NoPendingHouseLimits', 'nothing scheduled');
    this.requireDue(pending.eta);
    this.pendingHouseLimits = null;
    this.houseBufferBps = pending.houseBufferBps; this.houseDailyCap = pending.houseDailyCap;
    return this.done({ txHash: this.tx('acceptHouseLimits', '').txHash });
  }
  async cancelHouseLimits(): Promise<ChainTx> {
    if (!this.pendingHouseLimits) throw new OfflineChainError('NoPendingHouseLimits', 'nothing scheduled');
    this.pendingHouseLimits = null;
    return this.done({ txHash: this.tx('cancelHouseLimits', '').txHash });
  }

  /** Lowering (or keeping) every limit applies at once; raising any of them waits `signerChangeDelay` (CS-L1). */
  async setLimits(limits: PlayerLimits): Promise<ChainTx> {
    const { maxVoucherAmountWei: v, dailyOutflowCapWei: cap, accountDailyOutflowCapWei: account, maxAttestationAge: age } = limits;
    if (!validLimits(limits)) throw new OfflineChainError('InvalidLimits', `maxVoucher ${v}, cap ${cap}, account cap ${account}, age ${age}`);
    this.pendingLimits = null;
    if (v <= this.maxVoucherAmount && cap <= this.dailyOutflowCap && account <= this.accountDailyOutflowCap && age <= this.maxAttestationAge) {
      this.maxVoucherAmount = v; this.dailyOutflowCap = cap; this.accountDailyOutflowCap = account; this.maxAttestationAge = age;
    } else {
      this.pendingLimits = { maxVoucherAmount: v, dailyOutflowCap: cap, accountDailyOutflowCap: account, maxAttestationAge: age, eta: this.nowS() + this.signerChangeDelay };
    }
    return this.done({ txHash: this.tx('setLimits', `${v}:${cap}:${account}:${age}`).txHash });
  }
  async acceptLimits(): Promise<ChainTx> {
    const pending = this.pendingLimits;
    if (!pending) throw new OfflineChainError('NoPendingLimits', 'nothing scheduled');
    this.requireDue(pending.eta);
    this.pendingLimits = null;
    this.maxVoucherAmount = pending.maxVoucherAmount; this.dailyOutflowCap = pending.dailyOutflowCap;
    this.accountDailyOutflowCap = pending.accountDailyOutflowCap; this.maxAttestationAge = pending.maxAttestationAge;
    return this.done({ txHash: this.tx('acceptLimits', '').txHash });
  }
  async cancelLimits(): Promise<ChainTx> {
    if (!this.pendingLimits) throw new OfflineChainError('NoPendingLimits', 'nothing scheduled');
    this.pendingLimits = null;
    return this.done({ txHash: this.tx('cancelLimits', '').txHash });
  }

  // ---------------------------------------------------------------- escape hatch

  async triggerEscape(): Promise<ChainTx> {
    this.requireNotEscaped();
    const availableAt = this.escapeAvailableAt();
    if (this.nowS() < availableAt) throw new OfflineChainError('EscapeNotYetAvailable', `${availableAt} > ${this.nowS()}`);
    const obligations = (this.attestation?.liabilitiesWei ?? 0n) + this.depositsSinceAttest();
    this.escapeMode = true;
    this.escapePool = this.assets < obligations ? this.assets : obligations;
    return this.done({ txHash: this.tx('triggerEscape', this.escapePool.toString()).txHash });
  }

  /** Escape mode only: moves the accounted assets no claim can reach (booked as a house withdrawal) (CS-M1). */
  async recoverEscapeSurplus(to: string): Promise<ChainTx & { amountWei: bigint }> {
    if (!this.escapeMode) throw new OfflineChainError('EscapeModeInactive', 'escape mode is off');
    const recipient = to.toLowerCase();
    if (recipient === ZERO_ADDRESS) throw new OfflineChainError('ZeroAddress', 'recipient is the zero address');
    if (recipient === this.addr.vault) throw new OfflineChainError('InvalidRecipient', 'recipient is the vault');
    const amount = this.escapeSurplus();
    if (amount === 0n) throw new OfflineChainError('NothingToRecover', 'every accounted token is still claimable');
    this.transfer(this.addr.vault, recipient, amount);
    this.houseWithdrawn += amount;
    return this.done({ txHash: this.tx('recoverEscapeSurplus', amount.toString()).txHash, amountWei: amount });
  }

  async escapeEntitlement(account: string, attestedBalanceWei: bigint): Promise<bigint> {
    const who = account.toLowerCase();
    const cut = this.attestation?.asOf ?? 0n;
    const after = (log: Flow[]) => log.reduce((sum, f) => (f.account === who && f.atS > cut ? sum + f.amount : sum), 0n);
    const owed = attestedBalanceWei + after(this.depositLog);
    const paid = after(this.payoutLog);
    return owed > paid ? owed - paid : 0n;
  }

  async playerClaimEscape(role: string, attestedBalanceWei: bigint, proof: readonly string[]): Promise<ChainTx & { paidWei: bigint }> {
    const player = this.role(role);
    if (!this.escapeMode) throw new OfflineChainError('EscapeModeInactive', 'escape mode is off');
    if (attestedBalanceWei !== 0n && !verifyBalanceProof(this.attestation?.ledgerRoot ?? `0x${'00'.repeat(32)}`, player.address, attestedBalanceWei, proof)) {
      throw new OfflineChainError('InvalidProof', `no leaf for ${player.address} with ${attestedBalanceWei}`);
    }
    const entitlement = await this.escapeEntitlement(player.address, attestedBalanceWei);
    if (entitlement === 0n) throw new OfflineChainError('NothingToClaim', player.address);
    const remaining = this.escapePool - this.escapeClaimedTotal;
    if (remaining === 0n) throw new OfflineChainError('EscapePoolExhausted', 'the escape pool is spent');
    const paid = entitlement < remaining ? entitlement : remaining;
    this.escapeClaimedTotal += paid;
    this.escapeClaimedBy.set(player.address, (this.escapeClaimedBy.get(player.address) ?? 0n) + paid);
    this.totalPlayerWithdrawals += paid; this.claimedSinceAttest += paid;
    this.payoutLog.push({ account: player.address, atS: this.nowS(), amount: paid });
    this.transfer(this.addr.vault, player.address, paid);
    return this.done({ txHash: this.tx('claimEscape', `${player.address}:${paid}`).txHash, paidWei: paid });
  }

  async vaultState(): Promise<VaultState> {
    const a = this.attestation;
    const grace = OFFLINE_VAULT_RULES.timelockGracePeriod;
    const pl = this.pendingLimits;
    return {
      assetsWei: this.assets, houseFundedWei: this.houseFunded, totalDepositsWei: this.totalPlayerDeposits, totalWithdrawalsWei: this.totalPlayerWithdrawals,
      houseWithdrawnWei: this.houseWithdrawn, surplusWei: this.houseSurplus(), paused: this.paused, maxVoucherAmountWei: this.maxVoucherAmount,
      dailyOutflowCapWei: this.dailyOutflowCap, accountDailyOutflowCapWei: this.accountDailyOutflowCap,
      pendingLimits: pl ? {
        maxVoucherAmountWei: pl.maxVoucherAmount, dailyOutflowCapWei: pl.dailyOutflowCap, accountDailyOutflowCapWei: pl.accountDailyOutflowCap,
        maxAttestationAge: pl.maxAttestationAge, eta: pl.eta, expiresAt: pl.eta + grace,
      } : null,
      lastAttestation: a ? { liabilitiesWei: a.liabilitiesWei, asOf: a.asOf, seq: a.seq, ledgerRoot: a.ledgerRoot } : null,
      ledgerSigner: this.ledgerSigner, pendingSigner: this.pendingSigner ? { ...this.pendingSigner, expiresAt: this.pendingSigner.eta + grace } : null,
      signerChangeDelay: this.signerChangeDelay, pendingSignerChangeDelay: this.pendingDelay ? { ...this.pendingDelay, expiresAt: this.pendingDelay.eta + grace } : null,
      maxAttestationAge: this.maxAttestationAge, houseBufferBps: this.houseBufferBps, houseDailyCap: this.houseDailyCap,
      pendingHouseLimits: this.pendingHouseLimits ? { ...this.pendingHouseLimits, expiresAt: this.pendingHouseLimits.eta + grace } : null,
      houseWithdrawableWei: this.houseWithdrawable(), excessWei: this.excess(),
      escape: {
        mode: this.escapeMode, lastAttestationAt: this.lastAttestationAt(), escapeDelay: this.escapeDelay, availableAt: this.escapeAvailableAt(),
        poolWei: this.escapePool, claimedWei: this.escapeClaimedTotal, signerSince: this.ledgerSignerSinceS, surplusWei: this.escapeSurplus(),
      },
    };
  }
  async balances(address: string): Promise<{ ethWei: bigint; tokenWei: bigint }> {
    const key = address.toLowerCase();
    return { ethWei: this.eth.get(key) ?? 0n, tokenWei: this.token.get(key) ?? 0n };
  }

  private role(role: string): { role: string; address: string } {
    const p = this.roster.find(r => r.role === role);
    if (!p) throw new OfflineChainError('UnknownRole', role);
    return p;
  }

  async playerDeposit(role: string, amountWei: bigint): Promise<ChainTx> {
    const player = this.role(role);
    if (this.paused) throw new OfflineChainError('EnforcedPause', 'vault paused');
    this.requireNotEscaped();
    this.transfer(player.address, this.addr.vault, amountWei);
    this.totalPlayerDeposits += amountWei; this.depositCount++;
    this.depositLog.push({ account: player.address, atS: this.nowS(), amount: amountWei });
    const receipt = this.tx('deposit', `${player.address}:${amountWei}`);
    const event: ChainDeposit = { player: player.address, amountWei, depositId: this.depositCount, txHash: receipt.txHash, logIndex: 0, blockNumber: receipt.blockNumber };
    if (this.options.statePath) this.depositEvents.push(event);
    // Persisted before delivery: the ledger never credits a deposit the restored vault would not hold.
    this.persist();
    this.emit(this.listeners, event);
    return { txHash: receipt.txHash };
  }

  async playerWithdraw(role: string, v: { amountWei: bigint; nonce: bigint; expiry: bigint; signature: string }): Promise<ChainTx> {
    const player = this.role(role);
    if (this.paused) throw new OfflineChainError('EnforcedPause', 'vault paused');
    this.requireNotEscaped();
    if (v.amountWei <= 0n) throw new OfflineChainError('ZeroAmount', 'amount must be positive');
    const now = this.nowS();
    if (now > v.expiry) throw new OfflineChainError('VoucherExpired', `${v.expiry} < ${now}`);
    if (v.amountWei > this.maxVoucherAmount) throw new OfflineChainError('VoucherAboveMax', `${v.amountWei} > ${this.maxVoucherAmount}`);
    const nonceKey = `${player.address}:${v.nonce}`;
    if (this.usedNonces.has(nonceKey)) throw new OfflineChainError('NonceAlreadyUsed', nonceKey);
    // Valid only while the vault's signer is the key that produced it (a rotation invalidates outstanding vouchers).
    const expected = this.hmac({ account: player.address, amountWei: v.amountWei, nonce: v.nonce, expiry: v.expiry });
    if (!this.holdsSignerKey() || expected !== v.signature) throw new OfflineChainError('InvalidSignature', 'voucher not signed by the ledger signer');
    const day = now / DAY;
    const used = this.outflowByDay.get(day) ?? 0n;
    if (used + v.amountWei > this.dailyOutflowCap) throw new OfflineChainError('DailyOutflowCapExceeded', `${used + v.amountWei} > ${this.dailyOutflowCap}`);
    const accountKey = `${day}:${player.address}`;
    const accountUsed = this.accountOutflowByDay.get(accountKey) ?? 0n;
    if (accountUsed + v.amountWei > this.accountDailyOutflowCap) {
      throw new OfflineChainError('AccountDailyOutflowCapExceeded', `${player.address}: ${accountUsed + v.amountWei} > ${this.accountDailyOutflowCap}`);
    }
    if (v.amountWei > this.assets) throw new OfflineChainError('InsufficientAssets', `${v.amountWei} > ${this.assets}`);
    this.usedNonces.add(nonceKey);
    this.outflowByDay.set(day, used + v.amountWei);
    this.accountOutflowByDay.set(accountKey, accountUsed + v.amountWei);
    this.totalPlayerWithdrawals += v.amountWei; this.claimedSinceAttest += v.amountWei;
    this.payoutLog.push({ account: player.address, atS: now, amount: v.amountWei });
    this.transfer(this.addr.vault, player.address, v.amountWei);
    const receipt = this.tx('withdraw', `${player.address}:${v.nonce}`);
    const event: ChainWithdrawal = { player: player.address, amountWei: v.amountWei, nonce: v.nonce, txHash: receipt.txHash, logIndex: 0, blockNumber: receipt.blockNumber };
    if (this.options.statePath) this.withdrawalEvents.push(event);
    this.persist();
    this.emit(this.withdrawalListeners, event);
    return { txHash: receipt.txHash };
  }

  /** Escape-claim total paid to `account`. */
  escapeClaimedByAccount(account: string): bigint { return this.escapeClaimedBy.get(account.toLowerCase()) ?? 0n; }
  /** Test hook: a raw token transfer into the vault (not accounted; `sweepExcess` can move it). */
  donate(from: string, amountWei: bigint): void { this.transfer(from.toLowerCase(), this.addr.vault, amountWei); this.persist(); }
  /** Test hook: a raw deposit from an arbitrary address (dust amounts, unknown depositors). */
  async externalDeposit(address: string, amountWei: bigint): Promise<ChainTx> {
    const key = address.toLowerCase();
    if (!this.token.has(key)) this.transfer(this.addr.operator, key, amountWei);
    this.roster.push({ role: `external-${this.roster.length + 1}`, address: key });
    const tx = await this.playerDeposit(this.roster.at(-1)!.role, amountWei);
    this.roster.pop();
    return tx;
  }
}

/** The vault's setLimits bounds: 0 < maxVoucher <= accountCap <= dailyCap and 0 < maxAttestationAge <= 1 day. */
function validLimits(l: PlayerLimits): boolean {
  return l.maxVoucherAmountWei > 0n && l.maxVoucherAmountWei <= l.accountDailyOutflowCapWei && l.accountDailyOutflowCapWei <= l.dailyOutflowCapWei
    && l.maxAttestationAge > 0n && l.maxAttestationAge <= OFFLINE_VAULT_RULES.maxAttestationAgeLimit;
}

/** 250,000 tOPEN clamped into [maxVoucher, dailyCap], so custom constructor caps stay a valid combination. */
function defaultAccountCap(maxVoucher: bigint, dailyCap: bigint): bigint {
  const d = OFFLINE_VAULT_RULES.defaultAccountDailyOutflowCap;
  const capped = d < dailyCap ? d : dailyCap;
  return capped > maxVoucher ? capped : maxVoucher;
}
