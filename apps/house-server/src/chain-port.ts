/**
 * The house server's only dependency on a chain. `src/chain/` implements it with viem for anvil and
 * Base Sepolia; `offline-chain.ts` implements it in memory for tests and offline simulations.
 * Amounts are raw token wei (18 decimals); the ledger converts with @maya/house toWei/fromWei.
 * Times on this port (asOf, eta, delays) are chain seconds as bigint.
 */
export type ChainNetwork = 'offline' | 'local' | 'base-sepolia';

export interface ChainDeposit {
  readonly player: string;
  readonly amountWei: bigint;
  readonly depositId: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

/**
 * A vault `Withdrawn` event (a redeemed voucher). Its identity is `player:nonce` (lowercase player): the
 * vault accepts each (account, nonce) once ever, so the key survives reorgs and re-submissions.
 */
export interface ChainWithdrawal {
  readonly player: string;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: bigint;
}

export interface WithdrawalVoucher {
  readonly account: string;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  readonly expiry: bigint;
}

export interface AttestationRequest {
  readonly liabilitiesWei: bigint;
  /**
   * 0x-prefixed 32-byte hex. For the escape hatch this must be `buildBalanceTree(...).root`
   * (`src/chain/merkle.ts`) over what the ledger owes each account; see SPEC-11 §4 for the leaf contract.
   */
  readonly ledgerRoot: string;
  /** Chain time in Unix seconds (<= latest block timestamp), never the replay clock. */
  readonly asOf: bigint;
  readonly seq: bigint;
}

export interface ChainAttestation {
  readonly liabilitiesWei: bigint;
  readonly asOf: bigint;
  readonly seq: bigint;
  readonly ledgerRoot: string;
}

/**
 * Every timelocked proposal can be accepted from `eta` through `expiresAt` = eta + the vault's
 * TIMELOCK_GRACE_PERIOD (7 days); afterwards acceptance reverts `ProposalExpired` and the owner must propose
 * again (fresh on-chain notice). `expiresAt` is optional so hand-built states stay valid; both adapters fill it.
 */
export interface PendingLedgerSigner {
  readonly address: string;
  /** Chain time from which `acceptLedgerSigner` succeeds. */
  readonly eta: bigint;
  readonly expiresAt?: bigint;
}

export interface PendingSignerChangeDelay {
  readonly delay: bigint;
  readonly eta: bigint;
  readonly expiresAt?: bigint;
}

export interface PendingHouseLimits {
  readonly houseBufferBps: bigint;
  readonly houseDailyCap: bigint;
  readonly eta: bigint;
  readonly expiresAt?: bigint;
}

/** A scheduled raise of the player limits or of `maxAttestationAge` (lowering applies at once). */
export interface PendingLimits {
  readonly maxVoucherAmountWei: bigint;
  readonly dailyOutflowCapWei: bigint;
  readonly accountDailyOutflowCapWei: bigint;
  readonly maxAttestationAge: bigint;
  readonly eta: bigint;
  readonly expiresAt?: bigint;
}

/** Player limits as `setLimits` takes them (wei, seconds). */
export interface PlayerLimits {
  readonly maxVoucherAmountWei: bigint;
  readonly dailyOutflowCapWei: bigint;
  /** Vouchers one account may redeem per UTC day (0 < maxVoucher <= this <= dailyOutflowCap). */
  readonly accountDailyOutflowCapWei: bigint;
  readonly maxAttestationAge: bigint;
}

export interface EscapeState {
  /** Escape mode is on (irreversible): deposits, vouchers, house flows and attestations are stopped. */
  readonly mode: boolean;
  /** Block time of the latest attestation (the deployment time before the first one). */
  readonly lastAttestationAt: bigint;
  readonly escapeDelay: bigint;
  /**
   * `max(lastAttestationAt, signerSince) + escapeDelay`: from then on anyone may trigger escape mode (a newly
   * accepted ledger signer gets a full escape window before a root its predecessor attested can be frozen).
   */
  readonly availableAt: bigint;
  readonly poolWei: bigint;
  readonly claimedWei: bigint;
  /** Block time the current ledger signer took office (deployment or its accepted rotation). */
  readonly signerSince?: bigint;
  /** Escape mode: accounted assets above what claims can still take (`recoverEscapeSurplus` moves them); else 0. */
  readonly surplusWei?: bigint;
}

export interface VaultState {
  readonly assetsWei: bigint;
  readonly houseFundedWei: bigint;
  readonly totalDepositsWei: bigint;
  readonly totalWithdrawalsWei: bigint;
  readonly houseWithdrawnWei: bigint;
  /** SPEC §5 surplus: assets above the attested obligations (the buffer is not deducted). */
  readonly surplusWei: bigint;
  readonly paused: boolean;
  readonly maxVoucherAmountWei: bigint;
  readonly dailyOutflowCapWei: bigint;
  /** Per-account share of the daily player cap (wei per UTC day). Optional for hand-built states; adapters fill it. */
  readonly accountDailyOutflowCapWei?: bigint;
  /** A scheduled raise of the player limits / attestation age, or null. Optional for hand-built states. */
  readonly pendingLimits?: PendingLimits | null;
  readonly lastAttestation: ChainAttestation | null;
  // SPEC-11 hardening
  readonly ledgerSigner: string;
  readonly pendingSigner: PendingLedgerSigner | null;
  readonly signerChangeDelay: bigint;
  readonly pendingSignerChangeDelay: PendingSignerChangeDelay | null;
  readonly maxAttestationAge: bigint;
  readonly houseBufferBps: bigint;
  /** Daily house-withdrawal cap in wei (UTC day). */
  readonly houseDailyCap: bigint;
  readonly pendingHouseLimits: PendingHouseLimits | null;
  /** What `withdrawHouse` would accept right now by amount: min(surplus − buffer, remaining daily cap). */
  readonly houseWithdrawableWei: bigint;
  /** Stray tokens (`token.balanceOf(vault) − assets`) that `sweepExcess` would move. */
  readonly excessWei: bigint;
  readonly escape: EscapeState;
}

export interface ChainTx { readonly txHash: string }

export interface ChainPort {
  readonly network: ChainNetwork;
  readonly chainId: number;
  addresses(): { token: string; vault: string; operator: string; ledgerSigner: string };
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Deposits are delivered at least once; the ledger credits idempotently by `txHash:logIndex`. */
  onDeposit(listener: (d: ChainDeposit) => void): () => void;
  /**
   * Redeemed vouchers, delivered at least once (idempotent by `player:nonce`) under the same confirmations
   * and reorg handling as deposits. Withdrawals found before the first subscription are queued for it.
   */
  onWithdrawn(listener: (w: ChainWithdrawal) => void): () => void;
  signWithdrawal(v: WithdrawalVoucher): Promise<string>;
  /** Whether the vault has consumed `nonce` for `account` (a voucher with it can never pay again). */
  nonceUsed(account: string, nonce: bigint): Promise<boolean>;
  attest(a: AttestationRequest): Promise<ChainTx>;
  fundHouse(amountWei: bigint): Promise<ChainTx>;
  withdrawHouse(amountWei: bigint, to: string): Promise<ChainTx>;
  pauseVault(): Promise<ChainTx>;
  unpauseVault(): Promise<ChainTx>;
  /** Starts a timelocked ledger-signer rotation (eta = now + signerChangeDelay). */
  proposeLedgerSigner(address: string): Promise<ChainTx>;
  /** Completes the pending rotation after its eta; afterwards this adapter can no longer sign or attest. */
  acceptLedgerSigner(): Promise<ChainTx>;
  cancelLedgerSigner(): Promise<ChainTx>;
  /** Sends stray tokens (balance above accounted assets) to `to`; never touches accounted assets. */
  sweepExcess(to: string): Promise<ChainTx>;
  vaultState(): Promise<VaultState>;
  balances(address: string): Promise<{ ethWei: bigint; tokenWei: bigint }>;
  indexerLagBlocks(): number;
  explorerUrl(kind: 'address' | 'tx', value: string): string | null;
  /** The on-chain testnet players (roles player-1..player-11); addresses only. */
  players(): readonly { role: string; address: string }[];
  playerDeposit(role: string, amountWei: bigint): Promise<ChainTx>;
  playerWithdraw(role: string, v: { amountWei: bigint; nonce: bigint; expiry: bigint; signature: string }): Promise<ChainTx>;
}

/**
 * Operator and player actions both adapters implement outside the core port (admin tooling, tests and the
 * escape-hatch drill). Same revert rules as the vault.
 */
export interface VaultOperatorExtras {
  /** Increases apply at once; a decrease is scheduled `signerChangeDelay` ahead. */
  setSignerChangeDelay(delaySeconds: bigint): Promise<ChainTx>;
  acceptSignerChangeDelay(): Promise<ChainTx>;
  cancelSignerChangeDelay(): Promise<ChainTx>;
  /** Tightening applies at once; loosening is scheduled `signerChangeDelay` ahead. */
  setHouseLimits(houseBufferBps: bigint, houseDailyCapWei: bigint): Promise<ChainTx>;
  acceptHouseLimits(): Promise<ChainTx>;
  cancelHouseLimits(): Promise<ChainTx>;
  /** Anyone may call once no attestation landed for `escapeDelay`. */
  triggerEscape(role?: string): Promise<ChainTx>;
  /** Escape mode: `role` claims its entitlement under the frozen root (balance 0 needs no proof). */
  playerClaimEscape(role: string, attestedBalanceWei: bigint, proof: readonly string[]): Promise<ChainTx>;
  /** The vault's `escapeEntitlement(account, attestedBalance)` (proof not checked). */
  escapeEntitlement(account: string, attestedBalanceWei: bigint): Promise<bigint>;
  /** Lowering every limit applies at once; raising any is scheduled `signerChangeDelay` ahead. */
  setLimits(limits: PlayerLimits): Promise<ChainTx>;
  acceptLimits(): Promise<ChainTx>;
  cancelLimits(): Promise<ChainTx>;
  /** Escape mode only: sends the accounted assets no claim can reach (the bankroll) to `to`. Returns amountWei. */
  recoverEscapeSurplus(to: string): Promise<ChainTx & { readonly amountWei: bigint }>;
  /** What `account` may still redeem today: min(remaining shared cap, remaining per-account share). */
  remainingAccountDailyOutflow(account: string): Promise<bigint>;
}

/** Signature of `createChain` exported by `src/chain/index.ts`. */
export type CreateChain = (network: Exclude<ChainNetwork, 'offline'>, options?: { readonly repoRoot?: string; readonly log?: (line: string) => void }) => Promise<ChainPort> | ChainPort;
