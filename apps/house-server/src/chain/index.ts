export { createChain, LiveChain, type CreateChainOptions, type MinedAttestation, type MinedClaim, type MinedProposal, type MinedSweep, type MinedTx } from './live-chain.js';
export {
  deployContracts, describeDeployment, preflight, DEFAULT_ESCAPE_DELAY_SEC, DEFAULT_HOUSE_LIMITS, DEFAULT_LIMITS, DEFAULT_SIGNER_CHANGE_DELAY_SEC, DEPLOY_DEFAULTS,
  MIN_OPERATOR_ETH_WEI, VAULT_BOUNDS, type DeployOptions, type DeployResult, type FundingTargets, type HouseLimits, type VaultLimits,
} from './deploy.js';
export { ChainError, isChainError, type ChainErrorCode, type RevertInfo } from './errors.js';
export {
  DepositIndexer, depositId, depositKey, fileCursorStore, memoryCursorStore, viemDepositSource, withdrawalKey,
  type BlockRef, type CursorStore, type DepositEvent, type DepositSource, type IndexerCursor, type IndexerStatus, type VaultLogs, type WithdrawalEvent, type WithdrawalLog,
} from './indexer.js';
export { balanceLeaf, buildBalanceTree, hashPair, verifyBalanceProof, ZERO_ROOT, type BalanceEntry, type BalanceTree, type BalanceTreeEntry } from './merkle.js';
export { planAttestation, type AttestationPlan } from './attestation.js';
export { networkConfig, explorerUrl, isLiveNetwork, type LiveNetwork, type NetworkConfig } from './networks.js';
export { readDeployment, writeDeployment, deploymentPath, type DeploymentRecord } from './deployment.js';
export { withdrawalDigest, recoverVoucherSigner, voucherDomain, WITHDRAWAL_TYPES } from './voucher.js';
export { parseUnits18, formatUnits18 } from './amounts.js';
export { mayaHouseVaultAbi, mockOpenTokenAbi } from './abi.js';

import type { CreateChain } from '../chain-port.js';
import { createChain as createLiveChain } from './live-chain.js';
// Compile-time guarantee that this adapter keeps matching the server's ChainPort contract.
createLiveChain satisfies CreateChain;
