import path from 'node:path';
import { decodeEventLog, type Address, type Hex } from 'viem';
import type { ChainPort, ChainTx, PlayerLimits, VaultOperatorExtras, VaultState } from '../chain-port.js';
import { mayaHouseVaultAbi } from './abi.js';
import { assertUint } from './amounts.js';
import { planAttestation } from './attestation.js';
import {
  checkedAddress, createContext, ensureAllowance, ethBalance, fundLocalWallets, hasCode, rpc, tokenBalance, vaultCall, verifyChainId,
  type ChainContext,
} from './context.js';
import { deployContracts } from './deploy.js';
import { readDeployment, writeDeployment, type DeploymentRecord } from './deployment.js';
import { ChainError } from './errors.js';
import { DepositIndexer, fileCursorStore, memoryCursorStore, viemDepositSource, type BlockRef, type CursorStore, type DepositEvent, type IndexerStatus, type WithdrawalEvent } from './indexer.js';
import { defaultRepoRoot, explorerUrl, repoPaths, type LiveNetwork } from './networks.js';
import { isPlayerRole, LEDGER_SIGNER_ROLE, OPERATOR_ROLE, type WalletInfo } from './secrets.js';
import type { TxReceipt } from './tx.js';
import { signWithdrawalVoucher } from './voucher.js';

export interface CreateChainOptions {
  readonly repoRoot?: string;
  readonly log?: (line: string) => void;
  readonly rpcUrl?: string;
  readonly secretsPath?: string;
  readonly artifactsDir?: string;
  readonly deploymentsDir?: string;
  /**
   * Directory for the persisted indexer cursor (`chain-cursor-<chainId>.json`). `null` keeps the
   * cursor in memory, so every process start rescans from the deployment block and re-delivers
   * (the ledger credits idempotently). Default: MAYA_DATA_DIR when set, else memory.
   */
  readonly dataDir?: string | null;
  readonly pollIntervalMs?: number;
  readonly confirmations?: number;
  readonly reorgDepth?: number;
  readonly logBatchSize?: number;
  readonly receiptTimeoutMs?: number;
  /** local only: send test ETH from anvil dev account 0 to zero-balance testnet wallets on start (default true). */
  readonly fundLocalWallets?: boolean;
  /** local only: deploy on start when the deployment file is missing or points at a reset chain (default false). */
  readonly deployIfMissing?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Extra result fields beyond ChainPort's `{ txHash }`. */
export interface MinedTx extends ChainTx {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
}

export interface MinedAttestation extends MinedTx {
  /** The asOf actually attested (the request's, clamped down to the indexer watermark's timestamp). */
  readonly asOf: bigint;
  readonly seq: bigint;
}

export interface MinedProposal extends MinedTx {
  /** Chain time from which the proposal can be accepted. */
  readonly eta: bigint;
}

export interface MinedSweep extends MinedTx {
  /** Tokens moved, read from the ExcessSwept event. */
  readonly amountWei: bigint;
}

export interface MinedClaim extends MinedTx {
  /** Tokens paid, read from the EscapeClaimed event. */
  readonly paidWei: bigint;
}

export interface MinedRecovery extends MinedTx {
  /** Tokens moved, read from the EscapeSurplusRecovered event. */
  readonly amountWei: bigint;
}

interface Subscription<E> {
  readonly listener: (event: E) => void;
  detach: (() => void) | undefined;
}

/** viem-backed ChainPort for a local anvil chain or Base Sepolia. */
export class LiveChain implements ChainPort, VaultOperatorExtras {
  readonly network: LiveNetwork;
  readonly chainId: number;
  private readonly ctx: ChainContext;
  private readonly repo: ReturnType<typeof repoPaths>;
  private readonly deploymentsDir: string;
  private readonly store: CursorStore;
  private readonly subscriptions = new Set<Subscription<DepositEvent>>();
  private readonly withdrawalSubscriptions = new Set<Subscription<WithdrawalEvent>>();
  private readonly flows = new Map<string, Promise<void>>();
  private deployment: DeploymentRecord | null;
  private indexer: DepositIndexer | null = null;
  private starting: Promise<void> | null = null;
  private started = false;

  constructor(network: LiveNetwork, private readonly options: CreateChainOptions = {}) {
    const env = options.env ?? process.env;
    this.repo = repoPaths(options.repoRoot ?? defaultRepoRoot(env));
    this.ctx = createContext(network, { rpcUrl: options.rpcUrl, secretsPath: options.secretsPath ?? this.repo.secrets, receiptTimeoutMs: options.receiptTimeoutMs, log: options.log, env });
    this.network = network;
    this.chainId = this.ctx.config.chainId;
    this.deploymentsDir = options.deploymentsDir ?? this.repo.deployments;
    this.deployment = readDeployment(this.deploymentsDir, this.chainId);
    const dataDir = options.dataDir === undefined ? (env['MAYA_DATA_DIR']?.trim() || null) : options.dataDir;
    this.store = dataDir ? fileCursorStore(path.join(dataDir, `chain-cursor-${this.chainId}.json`), options.log) : memoryCursorStore();
  }

  addresses(): { token: string; vault: string; operator: string; ledgerSigner: string } {
    const d = this.requireDeployment();
    return { token: d.token, vault: d.vault, operator: d.operator, ledgerSigner: d.ledgerSigner };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.starting ??= this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const indexer = this.indexer;
    this.indexer = null;
    this.started = false;
    for (const s of this.subscriptions) { s.detach?.(); s.detach = undefined; }
    for (const s of this.withdrawalSubscriptions) { s.detach?.(); s.detach = undefined; }
    await indexer?.stop();
  }

  onDeposit(listener: (d: DepositEvent) => void): () => void {
    const subscription: Subscription<DepositEvent> = { listener, detach: this.indexer?.onDeposit(listener) };
    this.subscriptions.add(subscription);
    return () => { this.subscriptions.delete(subscription); subscription.detach?.(); subscription.detach = undefined; };
  }

  onWithdrawn(listener: (w: WithdrawalEvent) => void): () => void {
    const subscription: Subscription<WithdrawalEvent> = { listener, detach: this.indexer?.onWithdrawal(listener) };
    this.withdrawalSubscriptions.add(subscription);
    return () => { this.withdrawalSubscriptions.delete(subscription); subscription.detach?.(); subscription.detach = undefined; };
  }

  async signWithdrawal(v: { account: string; amountWei: bigint; nonce: bigint; expiry: bigint }): Promise<string> {
    const d = this.requireDeployment();
    this.requireSignerKey(d, 'sign vouchers');
    return signWithdrawalVoucher(this.ctx.wallets.account(LEDGER_SIGNER_ROLE), { chainId: this.chainId, vault: d.vault }, v);
  }

  async nonceUsed(account: string, nonce: bigint): Promise<boolean> {
    const { deployment } = this.requireStarted();
    const owner = checkedAddress(account, 'account');
    const n = assertUint(nonce, 'nonce');
    return rpc('vault.nonceUsed', () => this.ctx.client.readContract({ address: deployment.vault, abi: mayaHouseVaultAbi, functionName: 'nonceUsed', args: [owner, n] }));
  }

  async attest(a: { liabilitiesWei: bigint; ledgerRoot: string; asOf: bigint; seq: bigint }): Promise<MinedAttestation> {
    const { deployment, indexer } = this.requireStarted();
    this.requireSignerKey(deployment, 'attest');
    // Read the watermark before any await: the caller snapshot its ledger in this same tick. Once the ledger
    // consumes withdrawals (an onWithdrawn listener exists), undelivered ones block the attestation too: the
    // escape root must reflect every claim mined at or before asOf.
    const undelivered = indexer.pendingCount() + (this.withdrawalSubscriptions.size > 0 ? indexer.pendingWithdrawalCount() : 0);
    const plan = planAttestation(a, indexer.watermark(), undelivered);
    if (!plan.ok) throw new ChainError(plan.code, plan.message);
    if (plan.clamped) this.ctx.log(`chain: attest seq ${plan.seq}: asOf ${a.asOf} is past the indexed chain time; attesting asOf ${plan.asOf}`);
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(LEDGER_SIGNER_ROLE),
      vaultCall(deployment.vault, 'attest', [plan.liabilitiesWei, plan.ledgerRoot, plan.asOf, plan.seq]));
    return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber, asOf: plan.asOf, seq: plan.seq });
  }

  async fundHouse(amountWei: bigint): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const amount = assertUint(amountWei, 'amountWei', { min: 1n });
    const operator = this.ctx.wallets.account(OPERATOR_ROLE);
    return this.withFlow(operator.address, async () => {
      const balance = await tokenBalance(this.ctx, deployment.token, operator.address);
      if (balance < amount) throw new ChainError('INSUFFICIENT_TOKEN_BALANCE', `Operator ${operator.address} holds ${balance} tOPEN wei, cannot fund the house with ${amount}`);
      await ensureAllowance(this.ctx, deployment.token, operator, deployment.vault, amount, 'fund house');
      return mined(await this.ctx.sender.send(operator, vaultCall(deployment.vault, 'fundHouse', [amount])));
    });
  }

  async withdrawHouse(amountWei: bigint, to: string): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const amount = assertUint(amountWei, 'amountWei', { min: 1n });
    const recipient = checkedAddress(to, 'withdrawHouse recipient');
    return mined(await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'withdrawHouse', [amount, recipient])));
  }

  async pauseVault(): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    return mined(await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'pause', [])));
  }

  async unpauseVault(): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    return mined(await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'unpause', [])));
  }

  async proposeLedgerSigner(address: string): Promise<MinedProposal> {
    const { deployment } = this.requireStarted();
    const next = checkedAddress(address, 'proposed ledger signer');
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'proposeLedgerSigner', [next]));
    const eta = await this.readAt(deployment.vault, 'pendingLedgerSignerEta', receipt.blockNumber);
    this.ctx.log(`chain: proposed ledger signer ${next}; acceptable from chain time ${eta} (tx ${receipt.hash})`);
    this.recordTx('proposeLedgerSigner', receipt.hash);
    return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber, eta });
  }

  /**
   * Completes the rotation and records the new signer in the deployment file. This adapter only holds the
   * ledger-signer key from the secrets file, so after rotating away from it signing and attesting fail with
   * SIGNER_MISMATCH until the process restarts with the new key.
   */
  async acceptLedgerSigner(): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'acceptLedgerSigner', []));
    const signer = await this.readAt(deployment.vault, 'ledgerSigner', receipt.blockNumber);
    const updated: DeploymentRecord = Object.freeze({ ...deployment, ledgerSigner: signer, txs: Object.freeze({ ...deployment.txs, acceptLedgerSigner: receipt.hash }) });
    writeDeployment(this.deploymentsDir, updated);
    this.deployment = updated;
    this.ctx.log(`chain: ledger signer is now ${signer} (tx ${receipt.hash})${signer === this.ctx.wallets.ledgerSigner.address ? '' : '; this adapter no longer holds the signer key'}`);
    return mined(receipt);
  }

  async cancelLedgerSigner(): Promise<MinedTx> {
    return this.operatorCall('cancelLedgerSigner', []);
  }

  async sweepExcess(to: string): Promise<MinedSweep> {
    const { deployment } = this.requireStarted();
    const recipient = checkedAddress(to, 'sweepExcess recipient');
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'sweepExcess', [recipient]));
    const event = vaultEvents(receipt, deployment.vault).find(e => e.eventName === 'ExcessSwept');
    const amountWei = event && event.eventName === 'ExcessSwept' ? event.args.amount : 0n;
    return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber, amountWei });
  }

  async setSignerChangeDelay(delaySeconds: bigint): Promise<MinedTx> {
    return this.operatorCall('setSignerChangeDelay', [assertUint(delaySeconds, 'delaySeconds')]);
  }

  async acceptSignerChangeDelay(): Promise<MinedTx> { return this.operatorCall('acceptSignerChangeDelay', []); }

  async cancelSignerChangeDelay(): Promise<MinedTx> { return this.operatorCall('cancelSignerChangeDelay', []); }

  async setHouseLimits(houseBufferBps: bigint, houseDailyCapWei: bigint): Promise<MinedTx> {
    return this.operatorCall('setHouseLimits', [assertUint(houseBufferBps, 'houseBufferBps'), assertUint(houseDailyCapWei, 'houseDailyCapWei')]);
  }

  async acceptHouseLimits(): Promise<MinedTx> { return this.operatorCall('acceptHouseLimits', []); }

  async cancelHouseLimits(): Promise<MinedTx> { return this.operatorCall('cancelHouseLimits', []); }

  /** Lowering every limit applies at once; raising any of them is scheduled `signerChangeDelay` ahead (CS-L1). */
  async setLimits(limits: PlayerLimits): Promise<MinedTx> {
    return this.operatorCall('setLimits', [
      assertUint(limits.maxVoucherAmountWei, 'maxVoucherAmountWei'), assertUint(limits.dailyOutflowCapWei, 'dailyOutflowCapWei'),
      assertUint(limits.accountDailyOutflowCapWei, 'accountDailyOutflowCapWei'), assertUint(limits.maxAttestationAge, 'maxAttestationAge'),
    ]);
  }

  async acceptLimits(): Promise<MinedTx> { return this.operatorCall('acceptLimits', []); }

  async cancelLimits(): Promise<MinedTx> { return this.operatorCall('cancelLimits', []); }

  /** Escape mode: moves the accounted assets no escape claim can reach (the bankroll) to `to` (CS-M1). */
  async recoverEscapeSurplus(to: string): Promise<MinedRecovery> {
    const { deployment } = this.requireStarted();
    const recipient = checkedAddress(to, 'recoverEscapeSurplus recipient');
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, 'recoverEscapeSurplus', [recipient]));
    const event = vaultEvents(receipt, deployment.vault).find(e => e.eventName === 'EscapeSurplusRecovered');
    const amountWei = event && event.eventName === 'EscapeSurplusRecovered' ? event.args.amount : 0n;
    return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber, amountWei });
  }

  async remainingAccountDailyOutflow(account: string): Promise<bigint> {
    const { deployment } = this.requireStarted();
    const owner = checkedAddress(account, 'account');
    return rpc('vault.remainingAccountDailyOutflow', () => this.ctx.client.readContract({ address: deployment.vault, abi: mayaHouseVaultAbi, functionName: 'remainingAccountDailyOutflow', args: [owner] }));
  }

  async triggerEscape(role: string = OPERATOR_ROLE): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    if (!this.ctx.wallets.has(role)) throw new ChainError('UNKNOWN_ROLE', `No wallet with role "${role}"`);
    return mined(await this.ctx.sender.send(this.ctx.wallets.account(role), vaultCall(deployment.vault, 'triggerEscape', [], `${role} vault.triggerEscape`)));
  }

  async playerClaimEscape(role: string, attestedBalanceWei: bigint, proof: readonly string[]): Promise<MinedClaim> {
    const { deployment } = this.requireStarted();
    const player = this.playerAccount(role);
    if (!Array.isArray(proof) || proof.some(p => typeof p !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p))) throw new ChainError('INVALID_ARGUMENT', 'proof must be an array of 32-byte hex strings');
    const receipt = await this.ctx.sender.send(player, vaultCall(deployment.vault, 'claimEscape', [assertUint(attestedBalanceWei, 'attestedBalanceWei'), proof as Hex[]], `${role} vault.claimEscape`));
    const event = vaultEvents(receipt, deployment.vault).find(e => e.eventName === 'EscapeClaimed');
    const paidWei = event && event.eventName === 'EscapeClaimed' ? event.args.paid : 0n;
    return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber, paidWei });
  }

  async escapeEntitlement(account: string, attestedBalanceWei: bigint): Promise<bigint> {
    const { deployment } = this.requireStarted();
    const owner = checkedAddress(account, 'account');
    const balance = assertUint(attestedBalanceWei, 'attestedBalanceWei');
    return rpc('vault.escapeEntitlement', () => this.ctx.client.readContract({ address: deployment.vault, abi: mayaHouseVaultAbi, functionName: 'escapeEntitlement', args: [owner, balance] }));
  }

  async vaultState(): Promise<VaultState> {
    const { deployment } = this.requireStarted();
    const address = deployment.vault;
    // Pin every read to one block so the snapshot is internally consistent.
    const blockNumber = await rpc('getBlockNumber', () => this.ctx.client.getBlockNumber({ cacheTime: 0 }));
    const read = <F extends VaultReadable>(functionName: F) =>
      rpc(`vault.${functionName}`, () => this.ctx.client.readContract({ address, abi: mayaHouseVaultAbi, functionName, blockNumber }));
    const [assets, houseFunded, deposits, withdrawals, houseWithdrawn, surplus, paused, maxVoucher, dailyCap, seq, liabilities, asOf, root] = await Promise.all([
      read('assets'), read('houseFunded'), read('totalPlayerDeposits'), read('totalPlayerWithdrawals'), read('houseWithdrawn'), read('houseSurplus'),
      read('paused'), read('maxVoucherAmount'), read('dailyOutflowCap'), read('attestationSeq'), read('attestedLiabilities'), read('attestationAsOf'), read('attestedLedgerRoot'),
    ]);
    const [signer, pendingSigner, pendingSignerEta, signerDelay, pendingDelay, pendingDelayEta, maxAge, bufferBps, houseCap, pendingBps, pendingCap, pendingLimitsEta] = await Promise.all([
      read('ledgerSigner'), read('pendingLedgerSigner'), read('pendingLedgerSignerEta'), read('signerChangeDelay'), read('pendingSignerChangeDelay'), read('pendingSignerChangeDelayEta'),
      read('maxAttestationAge'), read('houseBufferBps'), read('houseDailyCap'), read('pendingHouseBufferBps'), read('pendingHouseDailyCap'), read('pendingHouseLimitsEta'),
    ]);
    const [withdrawable, excess, escapeMode, lastAttestationAt, escapeDelay, availableAt, pool, claimed, signerSince, escapeSurplus] = await Promise.all([
      read('houseWithdrawable'), read('excess'), read('escapeMode'), read('lastAttestationAt'), read('escapeDelay'), read('escapeAvailableAt'), read('escapePool'), read('escapeClaimedTotal'),
      read('ledgerSignerSince'), read('escapeSurplus'),
    ]);
    const [accountCap, pendingMaxVoucher, pendingDailyCap, pendingAccountCap, pendingMaxAge, pendingPlayerLimitsEta, grace] = await Promise.all([
      read('accountDailyOutflowCap'), read('pendingMaxVoucherAmount'), read('pendingDailyOutflowCap'), read('pendingAccountDailyOutflowCap'), read('pendingMaxAttestationAge'),
      read('pendingLimitsEta'), read('TIMELOCK_GRACE_PERIOD'),
    ]);
    return Object.freeze({
      assetsWei: assets, houseFundedWei: houseFunded, totalDepositsWei: deposits, totalWithdrawalsWei: withdrawals, houseWithdrawnWei: houseWithdrawn,
      surplusWei: surplus, paused, maxVoucherAmountWei: maxVoucher, dailyOutflowCapWei: dailyCap, accountDailyOutflowCapWei: accountCap,
      pendingLimits: pendingPlayerLimitsEta === 0n ? null : Object.freeze({
        maxVoucherAmountWei: pendingMaxVoucher, dailyOutflowCapWei: pendingDailyCap, accountDailyOutflowCapWei: pendingAccountCap, maxAttestationAge: pendingMaxAge,
        eta: pendingPlayerLimitsEta, expiresAt: pendingPlayerLimitsEta + grace,
      }),
      lastAttestation: seq === 0n ? null : Object.freeze({ liabilitiesWei: liabilities, asOf: BigInt(asOf), seq: BigInt(seq), ledgerRoot: root }),
      ledgerSigner: signer,
      pendingSigner: pendingSigner === ZERO_ADDRESS ? null : Object.freeze({ address: pendingSigner, eta: pendingSignerEta, expiresAt: pendingSignerEta + grace }),
      signerChangeDelay: signerDelay,
      pendingSignerChangeDelay: pendingDelayEta === 0n ? null : Object.freeze({ delay: pendingDelay, eta: pendingDelayEta, expiresAt: pendingDelayEta + grace }),
      maxAttestationAge: maxAge, houseBufferBps: bufferBps, houseDailyCap: houseCap,
      pendingHouseLimits: pendingLimitsEta === 0n ? null : Object.freeze({ houseBufferBps: pendingBps, houseDailyCap: pendingCap, eta: pendingLimitsEta, expiresAt: pendingLimitsEta + grace }),
      houseWithdrawableWei: withdrawable, excessWei: excess,
      escape: Object.freeze({ mode: escapeMode, lastAttestationAt, escapeDelay, availableAt, poolWei: pool, claimedWei: claimed, signerSince, surplusWei: escapeSurplus }),
    });
  }

  async balances(address: string): Promise<{ ethWei: bigint; tokenWei: bigint }> {
    const { deployment } = this.requireStarted();
    const owner = checkedAddress(address, 'address');
    const [ethWei, tokenWei] = await Promise.all([ethBalance(this.ctx, owner), tokenBalance(this.ctx, deployment.token, owner)]);
    return Object.freeze({ ethWei, tokenWei });
  }

  indexerLagBlocks(): number { return this.indexer?.lagBlocks() ?? 0; }

  explorerUrl(kind: 'address' | 'tx', value: string): string | null { return explorerUrl(this.ctx.config, kind, value); }

  players(): readonly WalletInfo[] { return this.ctx.wallets.players(); }

  async playerDeposit(role: string, amountWei: bigint): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const player = this.playerAccount(role);
    const amount = assertUint(amountWei, 'amountWei', { min: 1n });
    return this.withFlow(player.address, async () => {
      const balance = await tokenBalance(this.ctx, deployment.token, player.address);
      if (balance < amount) throw new ChainError('INSUFFICIENT_TOKEN_BALANCE', `${role} ${player.address} holds ${balance} tOPEN wei, cannot deposit ${amount}`);
      await ensureAllowance(this.ctx, deployment.token, player, deployment.vault, amount, `${role} deposit`);
      return mined(await this.ctx.sender.send(player, vaultCall(deployment.vault, 'deposit', [amount], `${role} vault.deposit`)));
    });
  }

  async playerWithdraw(role: string, v: { amountWei: bigint; nonce: bigint; expiry: bigint; signature: string }): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const player = this.playerAccount(role);
    if (typeof v.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(v.signature)) throw new ChainError('INVALID_ARGUMENT', 'signature must be a 65-byte 0x-prefixed hex string');
    const args = [assertUint(v.amountWei, 'amountWei', { min: 1n }), assertUint(v.nonce, 'nonce'), assertUint(v.expiry, 'expiry'), v.signature as Hex];
    return mined(await this.ctx.sender.send(player, vaultCall(deployment.vault, 'withdraw', args, `${role} vault.withdraw`)));
  }

  // ---------------------------------------------------------------- extras (not on ChainPort)

  /** Latest fully indexed block; `attest` never uses an asOf later than its timestamp. */
  watermark(): BlockRef | null { return this.indexer?.watermark() ?? null; }

  indexerStatus(): IndexerStatus | null { return this.indexer?.status() ?? null; }

  deploymentRecord(): DeploymentRecord | null { return this.deployment; }

  /** Latest block timestamp (chain time, Unix seconds). */
  async chainTime(): Promise<bigint> {
    const block = await rpc('getBlock latest', () => this.ctx.client.getBlock({ blockTag: 'latest' }));
    return block.timestamp;
  }

  // ---------------------------------------------------------------- internals

  private async doStart(): Promise<void> {
    await verifyChainId(this.ctx);
    const local = this.network === 'local';
    if (local && this.options.fundLocalWallets !== false) await fundLocalWallets(this.ctx);
    let deployment = readDeployment(this.deploymentsDir, this.chainId);
    const live = deployment !== null && (await hasCode(this.ctx, deployment.token)) && (await hasCode(this.ctx, deployment.vault));
    if (!live) {
      if (local && this.options.deployIfMissing) {
        this.ctx.log(`chain: ${deployment ? 'deployment points at a reset chain' : 'no deployment'}; deploying to local anvil`);
        deployment = (await deployContracts({
          network: this.network, rpcUrl: this.ctx.config.rpcUrl, secretsPath: this.ctx.wallets.source, artifactsDir: this.options.artifactsDir ?? this.repo.artifacts,
          deploymentsDir: this.deploymentsDir, log: this.options.log, env: this.options.env, receiptTimeoutMs: this.options.receiptTimeoutMs, redeploy: deployment !== null,
        })).deployment;
      } else if (deployment) {
        throw new ChainError('DEPLOYMENT_MISMATCH', `No contract code at token ${deployment.token} / vault ${deployment.vault} on ${this.network}; redeploy with: node apps/house-server/dist/chain/deploy-cli.js --network ${this.network} --redeploy`);
      } else {
        throw new ChainError('DEPLOYMENT_MISSING', `No deployment for chainId ${this.chainId} in ${this.deploymentsDir}; deploy with: node apps/house-server/dist/chain/deploy-cli.js --network ${this.network}`);
      }
    }
    await this.verifyDeployment(deployment!);
    this.deployment = deployment;
    const config = this.ctx.config;
    const indexer = new DepositIndexer(viemDepositSource(this.ctx.client, deployment!.vault), {
      chainId: this.chainId, vault: deployment!.vault, startBlock: deployment!.blockNumber, deploymentBlockHash: deployment!.blockHash,
      confirmations: this.options.confirmations ?? config.confirmations, reorgDepth: this.options.reorgDepth ?? config.reorgDepth,
      batchSize: this.options.logBatchSize ?? config.logBatchSize, pollIntervalMs: this.options.pollIntervalMs ?? config.pollIntervalMs,
      store: this.store, log: this.ctx.log,
    });
    for (const s of this.subscriptions) s.detach = indexer.onDeposit(s.listener);
    for (const s of this.withdrawalSubscriptions) s.detach = indexer.onWithdrawal(s.listener);
    try {
      await indexer.start();
    } catch (error) {
      for (const s of this.subscriptions) { s.detach?.(); s.detach = undefined; }
      for (const s of this.withdrawalSubscriptions) { s.detach?.(); s.detach = undefined; }
      await indexer.stop();
      throw error instanceof ChainError ? error : new ChainError('RPC_UNAVAILABLE', `Deposit indexer could not complete its first scan: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    this.indexer = indexer;
    this.started = true;
  }

  private async verifyDeployment(d: DeploymentRecord): Promise<void> {
    const read = <F extends 'token' | 'owner' | 'ledgerSigner'>(functionName: F) => rpc(`vault.${functionName}`, () => this.ctx.client.readContract({ address: d.vault, abi: mayaHouseVaultAbi, functionName }));
    const [token, owner, signer] = await Promise.all([read('token'), read('owner'), read('ledgerSigner')]);
    const { operator, ledgerSigner } = this.ctx.wallets;
    const problems: string[] = [];
    if (token !== d.token) problems.push(`vault token is ${token}, deployment file says ${d.token}`);
    if (owner !== operator.address) problems.push(`vault owner is ${owner}, not the $OPEN operator wallet ${operator.address}`);
    if (signer !== ledgerSigner.address) problems.push(`vault ledgerSigner is ${signer}, not the ledger-signer wallet ${ledgerSigner.address}`);
    if (d.operator !== operator.address) problems.push(`deployment file operator ${d.operator} is not the $OPEN operator wallet ${operator.address}`);
    if (d.ledgerSigner !== ledgerSigner.address) problems.push(`deployment file ledgerSigner ${d.ledgerSigner} is not the ledger-signer wallet ${ledgerSigner.address}`);
    if (problems.length > 0) throw new ChainError('DEPLOYMENT_MISMATCH', `Deployment ${d.vault} does not match the testnet wallets: ${problems.join('; ')}`);
  }

  /** Fails closed once the vault's signer (as recorded) is not the key this adapter holds. */
  private requireSignerKey(d: DeploymentRecord, what: string): void {
    const held = this.ctx.wallets.ledgerSigner.address;
    if (d.ledgerSigner.toLowerCase() !== held.toLowerCase()) {
      throw new ChainError('SIGNER_MISMATCH', `Cannot ${what}: the vault's ledger signer is ${d.ledgerSigner} but this adapter holds the key for ${held}; restart with the new ledger-signer key`);
    }
  }

  private async operatorCall(functionName: string, args: readonly unknown[]): Promise<MinedTx> {
    const { deployment } = this.requireStarted();
    const receipt = await this.ctx.sender.send(this.ctx.wallets.account(OPERATOR_ROLE), vaultCall(deployment.vault, functionName, args));
    return mined(receipt);
  }

  private async readAt<F extends 'pendingLedgerSignerEta' | 'ledgerSigner'>(vault: Address, functionName: F, blockNumber: bigint) {
    return rpc(`vault.${functionName}`, () => this.ctx.client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName, blockNumber }));
  }

  private recordTx(key: string, hash: string): void {
    const d = this.deployment;
    if (!d) return;
    const updated: DeploymentRecord = Object.freeze({ ...d, txs: Object.freeze({ ...d.txs, [key]: hash }) });
    writeDeployment(this.deploymentsDir, updated);
    this.deployment = updated;
  }

  private requireDeployment(): DeploymentRecord {
    if (!this.deployment) throw new ChainError('DEPLOYMENT_MISSING', `No deployment for chainId ${this.chainId} in ${this.deploymentsDir}; deploy with: node apps/house-server/dist/chain/deploy-cli.js --network ${this.network}`);
    return this.deployment;
  }

  private requireStarted(): { deployment: DeploymentRecord; indexer: DepositIndexer } {
    if (!this.started || !this.indexer || !this.deployment) throw new ChainError('NOT_STARTED', 'Chain adapter is not started; await start() first');
    return { deployment: this.deployment, indexer: this.indexer };
  }

  private playerAccount(role: string) {
    if (!isPlayerRole(role) || !this.ctx.wallets.has(role)) throw new ChainError('UNKNOWN_ROLE', `"${role}" is not one of the on-chain player wallets (${this.ctx.wallets.players().map(p => p.role).join(', ')})`);
    return this.ctx.wallets.account(role);
  }

  /** Serialises allowance check → approve → action per owner, so concurrent flows never race on the allowance. */
  private async withFlow<T>(owner: Address, fn: () => Promise<T>): Promise<T> {
    const previous = this.flows.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(() => new Promise<void>(resolve => { release = resolve; }));
    this.flows.set(owner, current);
    await previous;
    try { return await fn(); } finally {
      release();
      if (this.flows.get(owner) === current) this.flows.delete(owner);
    }
  }
}

type VaultReadable = 'assets' | 'houseFunded' | 'totalPlayerDeposits' | 'totalPlayerWithdrawals' | 'houseWithdrawn' | 'houseSurplus' | 'paused'
  | 'maxVoucherAmount' | 'dailyOutflowCap' | 'attestationSeq' | 'attestedLiabilities' | 'attestationAsOf' | 'attestedLedgerRoot'
  | 'ledgerSigner' | 'pendingLedgerSigner' | 'pendingLedgerSignerEta' | 'signerChangeDelay' | 'pendingSignerChangeDelay' | 'pendingSignerChangeDelayEta'
  | 'maxAttestationAge' | 'houseBufferBps' | 'houseDailyCap' | 'pendingHouseBufferBps' | 'pendingHouseDailyCap' | 'pendingHouseLimitsEta'
  | 'houseWithdrawable' | 'excess' | 'escapeMode' | 'lastAttestationAt' | 'escapeDelay' | 'escapeAvailableAt' | 'escapePool' | 'escapeClaimedTotal'
  | 'ledgerSignerSince' | 'escapeSurplus' | 'accountDailyOutflowCap' | 'pendingMaxVoucherAmount' | 'pendingDailyOutflowCap' | 'pendingAccountDailyOutflowCap'
  | 'pendingMaxAttestationAge' | 'pendingLimitsEta' | 'TIMELOCK_GRACE_PERIOD';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function mined(receipt: TxReceipt): MinedTx {
  return Object.freeze({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
}

/** Decodes the vault's own events from a receipt (other emitters and unknown topics are skipped). */
function vaultEvents(receipt: TxReceipt, vault: Address) {
  const out: ReturnType<typeof decodeEventLog<typeof mayaHouseVaultAbi>>[] = [];
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== vault.toLowerCase() || log.topics.length === 0) continue;
    try {
      out.push(decodeEventLog({ abi: mayaHouseVaultAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data }));
    } catch { /* not a vault event */ }
  }
  return out;
}

export function createChain(network: LiveNetwork, options: CreateChainOptions = {}): LiveChain {
  return new LiveChain(network, options);
}
