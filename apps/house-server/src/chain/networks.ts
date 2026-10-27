import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseSepolia, foundry } from 'viem/chains';
import type { Chain } from 'viem';
import { ChainError } from './errors.js';

export type LiveNetwork = 'local' | 'base-sepolia';

export interface NetworkConfig {
  readonly network: LiveNetwork;
  readonly chainId: number;
  readonly chain: Chain;
  readonly rpcUrl: string;
  readonly explorer: string | null;
  /** Blocks a deposit must be buried under before the indexer credits it (SPEC §6). */
  readonly confirmations: number;
  /** Already-scanned blocks re-read on every poll so a shallow reorg is caught. */
  readonly reorgDepth: number;
  readonly logBatchSize: number;
  readonly pollIntervalMs: number;
  readonly receiptTimeoutMs: number;
  readonly rpcRetryCount: number;
  readonly rpcRetryDelayMs: number;
  readonly rpcTimeoutMs: number;
}

export const LOCAL_RPC_URL = 'http://127.0.0.1:8545';
export const BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
export const BASE_SEPOLIA_EXPLORER = 'https://sepolia.basescan.org';

/**
 * anvil's default dev account 0 (from the public "test test … junk" mnemonic). A published test
 * value, used only to fund the testnet wallets on a local anvil chain (chainId 31337).
 */
export const ANVIL_DEV_ACCOUNT_0 = Object.freeze({
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
} as const);

export interface NetworkOverrides {
  readonly rpcUrl?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export function isLiveNetwork(value: unknown): value is LiveNetwork {
  return value === 'local' || value === 'base-sepolia';
}

export function networkConfig(network: LiveNetwork, overrides: NetworkOverrides = {}): NetworkConfig {
  const env = overrides.env ?? process.env;
  if (network === 'local') {
    return Object.freeze({
      network, chainId: 31337, chain: foundry, rpcUrl: overrides.rpcUrl ?? LOCAL_RPC_URL, explorer: null,
      confirmations: 0, reorgDepth: 5, logBatchSize: 10_000, pollIntervalMs: 500, receiptTimeoutMs: 30_000,
      rpcRetryCount: 2, rpcRetryDelayMs: 100, rpcTimeoutMs: 10_000,
    });
  }
  if (network === 'base-sepolia') {
    return Object.freeze({
      network, chainId: 84532, chain: baseSepolia, rpcUrl: overrides.rpcUrl ?? nonEmpty(env['MAYA_RPC_URL']) ?? BASE_SEPOLIA_RPC_URL,
      explorer: BASE_SEPOLIA_EXPLORER, confirmations: 2, reorgDepth: 32, logBatchSize: 2_000, pollIntervalMs: 2_000,
      receiptTimeoutMs: 180_000, rpcRetryCount: 5, rpcRetryDelayMs: 250, rpcTimeoutMs: 20_000,
    });
  }
  throw new ChainError('INVALID_ARGUMENT', `Unknown network "${String(network)}" (expected local or base-sepolia)`);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** apps/house-server/{src,dist}/chain → repo root. MAYA_REPO_ROOT overrides. */
export function defaultRepoRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = nonEmpty(env['MAYA_REPO_ROOT']);
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

export interface RepoPaths {
  readonly secrets: string;
  readonly artifacts: string;
  readonly deployments: string;
}

export function repoPaths(repoRoot: string): RepoPaths {
  return Object.freeze({
    secrets: path.join(repoRoot, '.secrets', 'testnet-wallets.json'),
    artifacts: path.join(repoRoot, 'contracts', 'out'),
    deployments: path.join(repoRoot, 'contracts', 'deployments'),
  });
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function explorerUrl(config: Pick<NetworkConfig, 'explorer'>, kind: 'address' | 'tx', value: string): string | null {
  if (!config.explorer) return null;
  if (kind === 'address' && ADDRESS.test(value)) return `${config.explorer}/address/${value}`;
  if (kind === 'tx' && TX_HASH.test(value)) return `${config.explorer}/tx/${value}`;
  return null;
}
