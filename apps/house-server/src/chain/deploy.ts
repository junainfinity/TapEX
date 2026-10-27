import { getAddress, type Address } from 'viem';
import { mayaHouseVaultAbi } from './abi.js';
import { formatUnits18 } from './amounts.js';
import { loadArtifacts } from './artifacts.js';
import {
  createContext, ensureAllowance, ethBalance, fundLocalWallets, hasCode, rpc, tokenBalance, tokenCall, vaultCall, verifyChainId,
  type ChainContext,
} from './context.js';
import { readDeployment, writeDeployment, type DeploymentRecord, type TxLog } from './deployment.js';
import { ChainError, describe } from './errors.js';
import { defaultRepoRoot, explorerUrl, networkConfig, repoPaths, type LiveNetwork } from './networks.js';
import type { TxReceipt } from './tx.js';

const ETH = 10n ** 18n;
const OPEN = 10n ** 18n;

/** SPEC: refuse to deploy on Base Sepolia unless the operator holds at least 0.01 ETH. */
export const MIN_OPERATOR_ETH_WEI = ETH / 100n;
/** Gas the operator must keep after topping up players and the signer. */
export const OPERATOR_GAS_RESERVE_WEI = ETH / 500n;

export interface VaultLimits {
  readonly maxVoucherAmountWei: bigint;
  readonly dailyOutflowCapWei: bigint;
  /** Vouchers one account may redeem per UTC day (maxVoucher <= this <= dailyOutflowCap). */
  readonly accountDailyOutflowCapWei: bigint;
  readonly maxAttestationAgeSec: bigint;
}

/** The vault constructor's defaults (MayaHouseVault.DEFAULT_*). */
export const DEFAULT_LIMITS: VaultLimits = Object.freeze({ maxVoucherAmountWei: 100_000n * OPEN, dailyOutflowCapWei: 1_000_000n * OPEN, accountDailyOutflowCapWei: 250_000n * OPEN, maxAttestationAgeSec: 600n });

export interface HouseLimits {
  readonly houseBufferBps: bigint;
  readonly houseDailyCapWei: bigint;
}

/** MayaHouseVault bounds and defaults (SPEC-11), mirrored so bad flags fail before any transaction. */
export const VAULT_BOUNDS = Object.freeze({
  maxAttestationAgeSec: 86_400n,
  minEscapeDelaySec: 3n * 86_400n,
  maxEscapeDelaySec: 90n * 86_400n,
  minSignerChangeDelaySec: 3_600n,
  maxSignerChangeDelaySec: 30n * 86_400n,
  maxHouseBufferBps: 10_000n,
  /** A timelocked proposal is acceptable from its eta through eta + this; afterwards it must be proposed again. */
  timelockGracePeriodSec: 7n * 86_400n,
});
export const DEFAULT_ESCAPE_DELAY_SEC = 7n * 86_400n;
export const DEFAULT_SIGNER_CHANGE_DELAY_SEC = 48n * 3_600n;
export const DEFAULT_HOUSE_LIMITS: HouseLimits = Object.freeze({ houseBufferBps: 1_000n, houseDailyCapWei: 10_000_000n * OPEN });

export interface FundingTargets {
  /** Ensure the vault's cumulative `houseFunded` is at least this. */
  readonly fundHouseWei: bigint;
  /** Ensure every player-N wallet holds at least this much ETH. */
  readonly playerEthWei: bigint;
  /** Ensure every player-N wallet holds at least this much tOPEN. */
  readonly playerTokensWei: bigint;
  /** Ensure the ledger-signer wallet holds at least this much ETH (it pays for `attest`). */
  readonly signerEthWei: bigint;
}

export const DEPLOY_DEFAULTS: Readonly<Record<LiveNetwork, FundingTargets>> = Object.freeze({
  local: Object.freeze({ fundHouseWei: 100_000_000n * OPEN, playerEthWei: 1n * ETH, playerTokensWei: 100_000n * OPEN, signerEthWei: 1n * ETH }),
  'base-sepolia': Object.freeze({ fundHouseWei: 100_000_000n * OPEN, playerEthWei: ETH / 2_000n, playerTokensWei: 100_000n * OPEN, signerEthWei: ETH / 2_000n }),
});

export interface DeployOptions extends Partial<FundingTargets> {
  readonly network: LiveNetwork;
  readonly repoRoot?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly secretsPath?: string | undefined;
  readonly artifactsDir?: string | undefined;
  readonly deploymentsDir?: string | undefined;
  /**
   * Converged per limit and only for the limits given: an omitted limit keeps its on-chain value (CS-L3).
   * Lowering applies at once; raising any limit is scheduled by the vault (re-run after its eta to accept).
   */
  readonly limits?: Partial<VaultLimits> | undefined;
  /** Constructor argument (immutable): seconds without an attestation before anyone may trigger escape mode. */
  readonly escapeDelaySec?: bigint | undefined;
  /** Converged only when given: increases apply at once, a decrease is scheduled (re-run after its eta). */
  readonly signerChangeDelaySec?: bigint | undefined;
  /** Converged only when given: tightening applies at once, loosening is scheduled (re-run after its eta). */
  readonly houseLimits?: HouseLimits | undefined;
  /** Deploy fresh contracts even when a deployment file exists. */
  readonly redeploy?: boolean | undefined;
  readonly receiptTimeoutMs?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface DeployResult {
  readonly deployment: DeploymentRecord;
  readonly file: string;
  readonly mode: 'deployed' | 'attached';
  readonly actions: readonly string[];
}

export type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly code: 'INSUFFICIENT_GAS_FUNDS'; readonly message: string };

/** Pure gas preflight for the operator wallet (typed result; the deployer turns a failure into a ChainError). */
export function preflight(input: { readonly network: LiveNetwork; readonly operator: string; readonly operatorEthWei: bigint; readonly distributionEthWei: bigint }): PreflightResult {
  const { network, operator, operatorEthWei, distributionEthWei } = input;
  if (network === 'base-sepolia' && operatorEthWei < MIN_OPERATOR_ETH_WEI) {
    return {
      ok: false, code: 'INSUFFICIENT_GAS_FUNDS',
      message: `The $OPEN operator wallet ${operator} holds ${formatUnits18(operatorEthWei)} ETH on Base Sepolia; deploying needs at least ${formatUnits18(MIN_OPERATOR_ETH_WEI)} ETH for gas. Send Base Sepolia ETH to ${operator} (e.g. from a Base Sepolia faucet) and re-run.`,
    };
  }
  const needed = distributionEthWei + OPERATOR_GAS_RESERVE_WEI;
  if (distributionEthWei > 0n && operatorEthWei < needed) {
    return {
      ok: false, code: 'INSUFFICIENT_GAS_FUNDS',
      message: `The $OPEN operator wallet ${operator} holds ${formatUnits18(operatorEthWei)} ETH but topping up the player and signer wallets needs ${formatUnits18(distributionEthWei)} ETH plus a ${formatUnits18(OPERATOR_GAS_RESERVE_WEI)} ETH gas reserve. Fund ${operator} or lower --player-eth/--signer-eth.`,
    };
  }
  return { ok: true };
}

/**
 * Deploys (or attaches to) MockOpenToken + MayaHouseVault from the $OPEN operator and converges the
 * chain to the requested state: ledger signer, limits, house funding and player/signer balances.
 * Every step is a top-up to a target, so re-running is idempotent. The deployment file is written
 * as soon as the vault exists and after every later step, so an interrupted run can be resumed.
 */
export async function deployContracts(options: DeployOptions): Promise<DeployResult> {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? defaultRepoRoot(env);
  const paths = repoPaths(root);
  const log = options.log ?? (() => undefined);
  const ctx = createContext(options.network, { rpcUrl: options.rpcUrl, secretsPath: options.secretsPath ?? paths.secrets, receiptTimeoutMs: options.receiptTimeoutMs, log, env });
  const artifacts = loadArtifacts(options.artifactsDir ?? paths.artifacts);
  const deploymentsDir = options.deploymentsDir ?? paths.deployments;
  const defaults = DEPLOY_DEFAULTS[options.network];
  const targets: FundingTargets = {
    fundHouseWei: options.fundHouseWei ?? defaults.fundHouseWei,
    playerEthWei: options.playerEthWei ?? defaults.playerEthWei,
    playerTokensWei: options.playerTokensWei ?? defaults.playerTokensWei,
    signerEthWei: options.signerEthWei ?? options.playerEthWei ?? defaults.signerEthWei,
  };
  const escapeDelay = options.escapeDelaySec ?? DEFAULT_ESCAPE_DELAY_SEC;
  const operator = ctx.wallets.account(ctx.wallets.operator.role);
  const signer = ctx.wallets.ledgerSigner.address;
  const actions: string[] = [];
  let changed = false;
  const act = (line: string, change = true) => { actions.push(line); if (change) changed = true; log(`deploy: ${line}`); };

  await verifyChainId(ctx);
  if (options.network === 'local') for (const role of await fundLocalWallets(ctx)) act(`funded ${role} from anvil dev account 0`);

  const recipients = [...ctx.wallets.players().map(p => ({ role: p.role, address: p.address, target: targets.playerEthWei })), { role: ctx.wallets.ledgerSigner.role, address: signer, target: targets.signerEthWei }];
  const ethShortfalls = await Promise.all(recipients.map(async r => { const bal = await ethBalance(ctx, r.address); return bal < r.target ? r.target - bal : 0n; }));
  const operatorEth = await ethBalance(ctx, operator.address);
  const check = preflight({ network: options.network, operator: operator.address, operatorEthWei: operatorEth, distributionEthWei: ethShortfalls.reduce((a, b) => a + b, 0n) });
  if (!check.ok) throw new ChainError(check.code, check.message);

  // ---- deploy or attach
  let record = readDeployment(deploymentsDir, ctx.config.chainId);
  let mode: DeployResult['mode'] = 'attached';
  if (record && !options.redeploy) {
    const live = (await hasCode(ctx, record.token)) && (await hasCode(ctx, record.vault));
    if (!live) {
      if (options.network !== 'local') throw new ChainError('DEPLOYMENT_MISMATCH', `No contract code at token ${record.token} / vault ${record.vault} on ${options.network}; pass --redeploy to deploy new contracts`);
      act(`deployment file points at contracts this anvil chain does not have (chain was reset); redeploying`);
      record = null;
    } else {
      await verifyAttachable(ctx, record, operator.address);
      const current = await readVault(ctx, record.vault, 'escapeDelay');
      if (options.escapeDelaySec !== undefined && current !== options.escapeDelaySec) {
        throw new ChainError('DEPLOYMENT_MISMATCH', `Vault ${record.vault} has escapeDelay ${current} s, which is immutable; pass --redeploy to deploy a vault with ${options.escapeDelaySec} s`);
      }
      act(`attached to existing deployment (token ${record.token}, vault ${record.vault})`, false);
    }
  }
  const txs: Record<string, string | Record<string, string>> = record && !options.redeploy ? cloneTxs(record.txs) : {};
  if (!record || options.redeploy) {
    mode = 'deployed';
    const tokenReceipt = await ctx.sender.send(operator, { kind: 'deploy', label: 'deploy MockOpenToken', abi: artifacts.token.abi, bytecode: artifacts.token.bytecode, args: [] });
    const token = deployedAddress(tokenReceipt, 'MockOpenToken');
    act(`deployed MockOpenToken (tOPEN) at ${token} (tx ${tokenReceipt.hash})`);
    const vaultReceipt = await ctx.sender.send(operator, { kind: 'deploy', label: 'deploy MayaHouseVault', abi: artifacts.vault.abi, bytecode: artifacts.vault.bytecode, args: [token, signer, escapeDelay] });
    const vault = deployedAddress(vaultReceipt, 'MayaHouseVault');
    act(`deployed MayaHouseVault at ${vault} (tx ${vaultReceipt.hash}); ledger signer ${signer} set by the constructor, escape delay ${escapeDelay} s`);
    txs['deployToken'] = tokenReceipt.hash; txs['deployVault'] = vaultReceipt.hash;
    record = Object.freeze({
      chainId: ctx.config.chainId, token, vault, operator: operator.address, ledgerSigner: signer,
      blockNumber: vaultReceipt.blockNumber, blockHash: vaultReceipt.blockHash, network: options.network, txs: cloneTxs(txs),
    });
  }
  const file = persist(deploymentsDir, record, txs);
  const { token, vault } = record;

  // ---- ledger signer (timelocked rotation: propose, then accept on a re-run after the eta)
  const currentSigner = await readVault(ctx, vault, 'ledgerSigner');
  if (currentSigner.toLowerCase() !== signer.toLowerCase()) {
    const [pendingRead, eta, now] = await Promise.all([readVault(ctx, vault, 'pendingLedgerSigner'), readVault(ctx, vault, 'pendingLedgerSignerEta'), chainTime(ctx)]);
    const expired = pendingRead !== ZERO_ADDRESS && now > eta + VAULT_BOUNDS.timelockGracePeriodSec;
    if (expired) act(`the pending ledger signer proposal ${pendingRead} expired at chain time ${eta + VAULT_BOUNDS.timelockGracePeriodSec}; proposing again`, false);
    const pending = expired ? ZERO_ADDRESS : pendingRead;
    if (pending.toLowerCase() === signer.toLowerCase() && now >= eta) {
      const r = await ctx.sender.send(operator, vaultCall(vault, 'acceptLedgerSigner', []));
      txs['acceptLedgerSigner'] = r.hash; act(`accepted ledger signer ${currentSigner} → ${signer} (tx ${r.hash})`);
      record = Object.freeze({ ...record, ledgerSigner: signer });
    } else if (pending.toLowerCase() === signer.toLowerCase()) {
      act(`ledger signer rotation ${currentSigner} → ${signer} is pending until chain time ${eta} (now ${now}); re-run after it`, false);
      record = Object.freeze({ ...record, ledgerSigner: currentSigner });
    } else {
      const r = await ctx.sender.send(operator, vaultCall(vault, 'proposeLedgerSigner', [signer]));
      const due = await readVault(ctx, vault, 'pendingLedgerSignerEta');
      txs['proposeLedgerSigner'] = r.hash;
      act(`proposed ledger signer ${currentSigner} → ${signer} (tx ${r.hash}); acceptable from chain time ${due}, re-run then`);
      record = Object.freeze({ ...record, ledgerSigner: currentSigner });
    }
  } else if (record.ledgerSigner.toLowerCase() !== signer.toLowerCase()) {
    record = Object.freeze({ ...record, ledgerSigner: signer }); // keep the file truthful about the vault's signer
  }
  // ---- limits (only the ones requested; an omitted limit keeps its on-chain value)
  if (options.limits !== undefined && Object.values(options.limits).some(v => v !== undefined)) {
    const [maxVoucher, dailyCap, accountCap, maxAge, pv, pc, pa, pm, eta, now] = await Promise.all([
      readVault(ctx, vault, 'maxVoucherAmount'), readVault(ctx, vault, 'dailyOutflowCap'), readVault(ctx, vault, 'accountDailyOutflowCap'), readVault(ctx, vault, 'maxAttestationAge'),
      readVault(ctx, vault, 'pendingMaxVoucherAmount'), readVault(ctx, vault, 'pendingDailyOutflowCap'), readVault(ctx, vault, 'pendingAccountDailyOutflowCap'),
      readVault(ctx, vault, 'pendingMaxAttestationAge'), readVault(ctx, vault, 'pendingLimitsEta'), chainTime(ctx),
    ]);
    const current: VaultLimits = { maxVoucherAmountWei: maxVoucher, dailyOutflowCapWei: dailyCap, accountDailyOutflowCapWei: accountCap, maxAttestationAgeSec: maxAge };
    const target = mergeLimits(current, options.limits);
    if (!sameLimits(current, target)) {
      const invalid = limitsProblem(target);
      if (invalid) throw new ChainError('INVALID_ARGUMENT', `Vault limits ${describeVaultLimits(target)} (requested, merged with the on-chain values ${describeVaultLimits(current)}) are invalid: ${invalid}`);
      const pending: VaultLimits = { maxVoucherAmountWei: pv, dailyOutflowCapWei: pc, accountDailyOutflowCapWei: pa, maxAttestationAgeSec: pm };
      const scheduled = eta !== 0n && sameLimits(pending, target);
      const expired = eta !== 0n && now > eta + VAULT_BOUNDS.timelockGracePeriodSec;
      if (scheduled && !expired && now >= eta) {
        const r = await ctx.sender.send(operator, vaultCall(vault, 'acceptLimits', []));
        txs['acceptLimits'] = r.hash; act(`limits ${describeVaultLimits(current)} → ${describeVaultLimits(target)} accepted (tx ${r.hash})`);
      } else if (scheduled && !expired) {
        act(`limits ${describeVaultLimits(current)} → ${describeVaultLimits(target)} are pending until chain time ${eta} (now ${now}); re-run after it`, false);
      } else {
        if (scheduled) act(`the scheduled limits change expired at chain time ${eta + VAULT_BOUNDS.timelockGracePeriodSec}; scheduling it again`, false);
        const r = await ctx.sender.send(operator, vaultCall(vault, 'setLimits', [target.maxVoucherAmountWei, target.dailyOutflowCapWei, target.accountDailyOutflowCapWei, target.maxAttestationAgeSec]));
        txs['setLimits'] = r.hash;
        const tightening = target.maxVoucherAmountWei <= current.maxVoucherAmountWei && target.dailyOutflowCapWei <= current.dailyOutflowCapWei
          && target.accountDailyOutflowCapWei <= current.accountDailyOutflowCapWei && target.maxAttestationAgeSec <= current.maxAttestationAgeSec;
        act(tightening
          ? `limits ${describeVaultLimits(current)} → ${describeVaultLimits(target)} (tx ${r.hash})`
          : `scheduled limits ${describeVaultLimits(current)} → ${describeVaultLimits(target)} (tx ${r.hash}); raising a limit waits the signer-change delay, re-run after it`);
      }
    }
  }
  // ---- signer-change delay (only when requested)
  if (options.signerChangeDelaySec !== undefined) {
    const target = options.signerChangeDelaySec;
    const [current, pending, eta, now] = await Promise.all([readVault(ctx, vault, 'signerChangeDelay'), readVault(ctx, vault, 'pendingSignerChangeDelay'), readVault(ctx, vault, 'pendingSignerChangeDelayEta'), chainTime(ctx)]);
    if (current !== target) {
      const expired = eta !== 0n && now > eta + VAULT_BOUNDS.timelockGracePeriodSec;
      if (expired && pending === target) act(`the scheduled signer-change delay decrease to ${target} s expired at chain time ${eta + VAULT_BOUNDS.timelockGracePeriodSec}; scheduling it again`, false);
      if (!expired && eta !== 0n && pending === target && now >= eta) {
        const r = await ctx.sender.send(operator, vaultCall(vault, 'acceptSignerChangeDelay', []));
        txs['acceptSignerChangeDelay'] = r.hash; act(`signer-change delay ${current} s → ${target} s accepted (tx ${r.hash})`);
      } else if (!expired && eta !== 0n && pending === target) {
        act(`signer-change delay decrease to ${target} s is pending until chain time ${eta}; re-run after it`, false);
      } else {
        const r = await ctx.sender.send(operator, vaultCall(vault, 'setSignerChangeDelay', [target]));
        txs['setSignerChangeDelay'] = r.hash;
        act(target > current ? `signer-change delay ${current} s → ${target} s (tx ${r.hash})` : `scheduled signer-change delay decrease ${current} s → ${target} s (tx ${r.hash}); re-run after ${current} s`);
      }
    }
  }
  // ---- house limits (only when requested)
  if (options.houseLimits !== undefined) {
    const { houseBufferBps, houseDailyCapWei } = options.houseLimits;
    const [bps, cap, pendingBps, pendingCap, eta, now] = await Promise.all([
      readVault(ctx, vault, 'houseBufferBps'), readVault(ctx, vault, 'houseDailyCap'), readVault(ctx, vault, 'pendingHouseBufferBps'),
      readVault(ctx, vault, 'pendingHouseDailyCap'), readVault(ctx, vault, 'pendingHouseLimitsEta'), chainTime(ctx),
    ]);
    const describeLimits = (b: bigint, c: bigint) => `buffer ${b} bps, daily house cap ${formatUnits18(c)} tOPEN`;
    if (bps !== houseBufferBps || cap !== houseDailyCapWei) {
      const expired = eta !== 0n && now > eta + VAULT_BOUNDS.timelockGracePeriodSec;
      const scheduled = eta !== 0n && !expired && pendingBps === houseBufferBps && pendingCap === houseDailyCapWei;
      if (expired && pendingBps === houseBufferBps && pendingCap === houseDailyCapWei) act(`the scheduled house limits change expired at chain time ${eta + VAULT_BOUNDS.timelockGracePeriodSec}; scheduling it again`, false);
      if (scheduled && now >= eta) {
        const r = await ctx.sender.send(operator, vaultCall(vault, 'acceptHouseLimits', []));
        txs['acceptHouseLimits'] = r.hash; act(`house limits → ${describeLimits(houseBufferBps, houseDailyCapWei)} accepted (tx ${r.hash})`);
      } else if (scheduled) {
        act(`house limits ${describeLimits(houseBufferBps, houseDailyCapWei)} are pending until chain time ${eta}; re-run after it`, false);
      } else {
        const r = await ctx.sender.send(operator, vaultCall(vault, 'setHouseLimits', [houseBufferBps, houseDailyCapWei]));
        txs['setHouseLimits'] = r.hash;
        const tightening = houseBufferBps >= bps && houseDailyCapWei <= cap;
        act(tightening ? `house limits → ${describeLimits(houseBufferBps, houseDailyCapWei)} (tx ${r.hash})` : `scheduled house limits → ${describeLimits(houseBufferBps, houseDailyCapWei)} (tx ${r.hash}); loosening waits the signer-change delay, re-run after it`);
      }
    }
  }
  persist(deploymentsDir, record, txs);

  // ---- escape clock (CS-M1): an idle deployment lets anyone trigger escape mode after escapeDelay
  const [houseFunded, escapeMode, attestationSeq, escapeAvailableAt] = await Promise.all([
    readVault(ctx, vault, 'houseFunded'), readVault(ctx, vault, 'escapeMode'), readVault(ctx, vault, 'attestationSeq'), readVault(ctx, vault, 'escapeAvailableAt'),
  ]);
  if (escapeMode) {
    act('the vault is in escape mode (irreversible): house funding skipped; players claim with their proofs and the owner can move the unclaimable bankroll out with recoverEscapeSurplus', false);
  } else if (attestationSeq === 0n) {
    act(`no attestation yet: anyone can trigger the vault's escape mode from chain time ${escapeAvailableAt}; start the house server (it attests every 10 min) before then`, false);
  }

  // ---- token budget
  const houseTopUp = !escapeMode && houseFunded < targets.fundHouseWei ? targets.fundHouseWei - houseFunded : 0n;
  const players = ctx.wallets.players();
  const tokenShortfalls = await Promise.all(players.map(async p => { const bal = await tokenBalance(ctx, token, p.address); return bal < targets.playerTokensWei ? targets.playerTokensWei - bal : 0n; }));
  const tokensNeeded = houseTopUp + tokenShortfalls.reduce((a, b) => a + b, 0n);
  const operatorTokens = await tokenBalance(ctx, token, operator.address);
  if (operatorTokens < tokensNeeded) {
    throw new ChainError('INSUFFICIENT_TOKEN_BALANCE', `Operator ${operator.address} holds ${formatUnits18(operatorTokens)} tOPEN but funding the house and players needs ${formatUnits18(tokensNeeded)} tOPEN`);
  }

  // ---- house funding
  if (houseTopUp > 0n) {
    const approveHash = await ensureAllowance(ctx, token, operator, vault, houseTopUp, 'fund house');
    if (approveHash) txs['approveHouse'] = approveHash;
    const r = await ctx.sender.send(operator, vaultCall(vault, 'fundHouse', [houseTopUp]));
    txs['fundHouse'] = r.hash; act(`funded the house with ${formatUnits18(houseTopUp)} tOPEN (tx ${r.hash})`);
    persist(deploymentsDir, record, txs);
  }

  // ---- distribution: independent transfers, broadcast back to back, receipts awaited together
  const transfers: { key: 'playerEth' | 'playerTokens' | 'signerEth'; role: string; line: string; wait: () => Promise<TxReceipt> }[] = [];
  const failures: string[] = [];
  const submit = async (key: 'playerEth' | 'playerTokens' | 'signerEth', role: string, line: string, call: Parameters<typeof ctx.sender.submit>[1]) => {
    try {
      const s = await ctx.sender.submit(operator, call);
      transfers.push({ key, role, line: `${line} (tx ${s.hash})`, wait: s.wait });
    } catch (error) { failures.push(`${line}: ${describe(error)}`); }
  };
  for (const [i, r] of recipients.entries()) {
    const shortfall = ethShortfalls[i]!;
    if (shortfall > 0n) await submit(r.role === ctx.wallets.ledgerSigner.role ? 'signerEth' : 'playerEth', r.role, `sent ${formatUnits18(shortfall)} ETH to ${r.role} ${r.address}`, { kind: 'transfer', label: `ETH to ${r.role}`, to: r.address, value: shortfall });
  }
  for (const [i, p] of players.entries()) {
    const shortfall = tokenShortfalls[i]!;
    if (shortfall > 0n) await submit('playerTokens', p.role, `sent ${formatUnits18(shortfall)} tOPEN to ${p.role} ${p.address}`, tokenCall(token, 'transfer', [p.address, shortfall], `tOPEN to ${p.role}`));
  }
  const settled = await Promise.allSettled(transfers.map(t => t.wait()));
  for (const [i, outcome] of settled.entries()) {
    const t = transfers[i]!;
    if (outcome.status === 'rejected') { failures.push(`${t.line}: ${describe(outcome.reason)}`); continue; }
    if (t.key === 'signerEth') txs['signerEth'] = outcome.value.hash;
    else {
      const map = (typeof txs[t.key] === 'object' ? txs[t.key] : {}) as Record<string, string>;
      map[t.role] = outcome.value.hash; txs[t.key] = map;
    }
    act(t.line);
  }
  persist(deploymentsDir, record, txs);
  if (failures.length > 0) throw new ChainError('TX_SEND_FAILED', `Deployment is usable but some top-ups failed (re-run to retry):\n  ${failures.join('\n  ')}`);
  if (!changed) act('nothing to do: chain already matches the requested state', false);
  return Object.freeze({ deployment: Object.freeze({ ...record, txs: cloneTxs(txs) }), file, mode, actions: Object.freeze(actions) });
}

function persist(dir: string, record: DeploymentRecord, txs: Record<string, string | Record<string, string>>): string {
  return writeDeployment(dir, { ...record, txs: cloneTxs(txs) });
}

function cloneTxs(txs: TxLog): Record<string, string | Record<string, string>> {
  const out: Record<string, string | Record<string, string>> = {};
  for (const [k, v] of Object.entries(txs)) out[k] = typeof v === 'string' ? v : { ...v };
  return out;
}

function deployedAddress(receipt: TxReceipt, name: string): Address {
  if (!receipt.contractAddress) throw new ChainError('TX_REVERTED', `${name} deployment ${receipt.hash} produced no contract address`, { txHash: receipt.hash });
  return getAddress(receipt.contractAddress);
}

type VaultView = 'ledgerSigner' | 'owner' | 'token' | 'maxVoucherAmount' | 'dailyOutflowCap' | 'maxAttestationAge' | 'houseFunded' | 'escapeDelay'
  | 'escapeMode' | 'attestationSeq' | 'escapeAvailableAt'
  | 'accountDailyOutflowCap' | 'pendingMaxVoucherAmount' | 'pendingDailyOutflowCap' | 'pendingAccountDailyOutflowCap' | 'pendingMaxAttestationAge' | 'pendingLimitsEta'
  | 'pendingLedgerSigner' | 'pendingLedgerSignerEta' | 'signerChangeDelay' | 'pendingSignerChangeDelay' | 'pendingSignerChangeDelayEta'
  | 'houseBufferBps' | 'houseDailyCap' | 'pendingHouseBufferBps' | 'pendingHouseDailyCap' | 'pendingHouseLimitsEta';
async function readVault<F extends VaultView>(ctx: ChainContext, vault: Address, functionName: F) {
  return rpc(`vault.${functionName}`, () => ctx.client.readContract({ address: vault, abi: mayaHouseVaultAbi, functionName }));
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Requested limits over the on-chain ones: every omitted limit keeps its current value (CS-L3). */
export function mergeLimits(current: VaultLimits, requested: Partial<VaultLimits>): VaultLimits {
  return Object.freeze({
    maxVoucherAmountWei: requested.maxVoucherAmountWei ?? current.maxVoucherAmountWei,
    dailyOutflowCapWei: requested.dailyOutflowCapWei ?? current.dailyOutflowCapWei,
    accountDailyOutflowCapWei: requested.accountDailyOutflowCapWei ?? current.accountDailyOutflowCapWei,
    maxAttestationAgeSec: requested.maxAttestationAgeSec ?? current.maxAttestationAgeSec,
  });
}

/** The vault's setLimits rule, so a bad combination fails before any transaction; null when valid. */
export function limitsProblem(l: VaultLimits): string | null {
  if (l.maxVoucherAmountWei <= 0n) return 'maxVoucher must be positive';
  if (l.maxVoucherAmountWei > l.accountDailyOutflowCapWei) return 'maxVoucher must not exceed the per-account daily cap';
  if (l.accountDailyOutflowCapWei > l.dailyOutflowCapWei) return 'the per-account daily cap must not exceed the daily cap';
  if (l.maxAttestationAgeSec <= 0n || l.maxAttestationAgeSec > VAULT_BOUNDS.maxAttestationAgeSec) return 'max attestation age must be 1..86400 s';
  return null;
}

function sameLimits(a: VaultLimits, b: VaultLimits): boolean {
  return a.maxVoucherAmountWei === b.maxVoucherAmountWei && a.dailyOutflowCapWei === b.dailyOutflowCapWei
    && a.accountDailyOutflowCapWei === b.accountDailyOutflowCapWei && a.maxAttestationAgeSec === b.maxAttestationAgeSec;
}

function describeVaultLimits(l: VaultLimits): string {
  return `(maxVoucher ${formatUnits18(l.maxVoucherAmountWei)} tOPEN, daily cap ${formatUnits18(l.dailyOutflowCapWei)} tOPEN, per-account daily cap ${formatUnits18(l.accountDailyOutflowCapWei)} tOPEN, max attestation age ${l.maxAttestationAgeSec} s)`;
}

async function chainTime(ctx: ChainContext): Promise<bigint> {
  const block = await rpc('getBlock latest', () => ctx.client.getBlock({ blockTag: 'latest' }));
  return block.timestamp;
}

async function verifyAttachable(ctx: ChainContext, record: DeploymentRecord, operator: Address): Promise<void> {
  const [token, owner] = await Promise.all([readVault(ctx, record.vault, 'token'), readVault(ctx, record.vault, 'owner')]);
  if (token.toLowerCase() !== record.token.toLowerCase()) throw new ChainError('DEPLOYMENT_MISMATCH', `Vault ${record.vault} holds token ${token}, but the deployment file says ${record.token}`);
  if (owner.toLowerCase() !== operator.toLowerCase()) throw new ChainError('DEPLOYMENT_MISMATCH', `Vault ${record.vault} is owned by ${owner}, not the $OPEN operator ${operator}; pass --redeploy to deploy contracts it owns`);
}

/** Printable summary for the CLI (addresses and tx hashes only). */
export function describeDeployment(result: DeployResult, network: LiveNetwork): string {
  const config = networkConfig(network);
  const link = (kind: 'address' | 'tx', v: string) => { const url = explorerUrl(config, kind, v); return url ? `  ${url}` : ''; };
  const d = result.deployment;
  return [
    `Maya-Live contracts on ${network} (chainId ${d.chainId}): ${result.mode}`,
    `  operator      ${d.operator}${link('address', d.operator)}`,
    `  ledgerSigner  ${d.ledgerSigner}${link('address', d.ledgerSigner)}`,
    `  token (tOPEN) ${d.token}${link('address', d.token)}   Test OPEN (Maya-Live mock), not the real $OPEN`,
    `  vault         ${d.vault}${link('address', d.vault)}`,
    `  start block   ${d.blockNumber}`,
    `  deployment    ${result.file}`,
    'Actions:',
    ...result.actions.map(a => `  - ${a}`),
  ].join('\n');
}
