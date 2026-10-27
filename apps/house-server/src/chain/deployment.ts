import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { ChainError } from './errors.js';

export type TxLog = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

/**
 * `contracts/deployments/<chainId>.json`. `script/Deploy.s.sol` writes the first six fields; the
 * TypeScript deployer adds `txs`, `network` and `blockHash` (the vault's deployment block, which
 * lets the deposit indexer notice that a local chain was reset under an old cursor).
 */
export interface DeploymentRecord {
  readonly chainId: number;
  readonly token: Address;
  readonly vault: Address;
  readonly operator: Address;
  readonly ledgerSigner: Address;
  /** First block the deposit indexer must scan (the vault deployment block, or a lower bound). */
  readonly blockNumber: bigint;
  readonly blockHash?: Hex | undefined;
  readonly network?: string | undefined;
  readonly txs: TxLog;
}

export function deploymentPath(dir: string, chainId: number): string {
  return path.join(dir, `${chainId}.json`);
}

export function parseDeployment(json: unknown, expectedChainId: number, source = '<memory>'): DeploymentRecord {
  const invalid = (why: string) => new ChainError('DEPLOYMENT_INVALID', `Deployment file ${source}: ${why}`);
  if (!json || typeof json !== 'object') throw invalid('not a JSON object');
  const raw = json as Record<string, unknown>;
  const chainId = raw['chainId'];
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId)) throw invalid('chainId must be an integer');
  if (chainId !== expectedChainId) throw invalid(`chainId ${chainId} does not match the network's ${expectedChainId}`);
  const address = (key: string): Address => {
    const value = raw[key];
    if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw invalid(`${key} must be an address`);
    return getAddress(value);
  };
  const blockRaw = raw['blockNumber'];
  let blockNumber: bigint;
  if (typeof blockRaw === 'number' && Number.isSafeInteger(blockRaw) && blockRaw >= 0) blockNumber = BigInt(blockRaw);
  else if (typeof blockRaw === 'string' && /^\d+$/.test(blockRaw)) blockNumber = BigInt(blockRaw);
  else throw invalid('blockNumber must be a non-negative integer');
  const blockHash = raw['blockHash'];
  if (blockHash !== undefined && (typeof blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(blockHash))) throw invalid('blockHash must be a 32-byte hex string');
  const network = raw['network'];
  if (network !== undefined && typeof network !== 'string') throw invalid('network must be a string');
  const txs = raw['txs'] ?? {};
  if (!txs || typeof txs !== 'object' || Array.isArray(txs)) throw invalid('txs must be an object');
  for (const [key, value] of Object.entries(txs)) {
    const ok = typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string'));
    if (!ok) throw invalid(`txs.${key} must be a tx hash or a map of tx hashes`);
  }
  const record: DeploymentRecord = {
    chainId, token: address('token'), vault: address('vault'), operator: address('operator'), ledgerSigner: address('ledgerSigner'),
    blockNumber, blockHash: blockHash as Hex | undefined, network: network as string | undefined, txs: txs as TxLog,
  };
  return Object.freeze(record);
}

/** Returns null when no deployment exists for the chain; throws DEPLOYMENT_INVALID when one is malformed. */
export function readDeployment(dir: string, chainId: number): DeploymentRecord | null {
  const file = deploymentPath(dir, chainId);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ChainError('DEPLOYMENT_INVALID', `Cannot read deployment file ${file}`, { cause: error });
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch (error) { throw new ChainError('DEPLOYMENT_INVALID', `Deployment file ${file} is not valid JSON`, { cause: error }); }
  return parseDeployment(json, chainId, file);
}

export function serializeDeployment(record: DeploymentRecord): string {
  const out: Record<string, unknown> = {
    chainId: record.chainId, token: record.token, vault: record.vault, operator: record.operator, ledgerSigner: record.ledgerSigner,
    blockNumber: Number.isSafeInteger(Number(record.blockNumber)) ? Number(record.blockNumber) : record.blockNumber.toString(),
  };
  if (record.blockHash) out['blockHash'] = record.blockHash;
  if (record.network) out['network'] = record.network;
  out['txs'] = record.txs;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Atomic write (temp file + rename) so a crash never leaves a truncated deployment file. */
export function writeDeployment(dir: string, record: DeploymentRecord): string {
  mkdirSync(dir, { recursive: true });
  const file = deploymentPath(dir, record.chainId);
  writeFileAtomic(file, serializeDeployment(record));
  return file;
}

export function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}
