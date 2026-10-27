import { createPublicClient, getAddress, http, isAddress, type Address, type Chain, type PublicClient } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { mayaHouseVaultAbi, mockOpenTokenAbi } from './abi.js';
import { formatUnits18 } from './amounts.js';
import { ChainError, describe } from './errors.js';
import { ANVIL_DEV_ACCOUNT_0, networkConfig, type LiveNetwork, type NetworkConfig } from './networks.js';
import { loadWallets, type WalletSet } from './secrets.js';
import { TxSender, viemTxBackend, type TxCall } from './tx.js';

export interface ContextOptions {
  readonly rpcUrl?: string | undefined;
  readonly secretsPath: string;
  readonly receiptTimeoutMs?: number | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

/** Everything that talks to one RPC endpoint: config, read client, sequential sender and wallets. */
export interface ChainContext {
  readonly config: NetworkConfig;
  readonly chain: Chain;
  readonly client: PublicClient;
  readonly sender: TxSender;
  readonly wallets: WalletSet;
  readonly log: (line: string) => void;
}

export function createContext(network: LiveNetwork, options: ContextOptions): ChainContext {
  const config = networkConfig(network, { rpcUrl: options.rpcUrl, env: options.env });
  const wallets = loadWallets(options.secretsPath);
  const chain: Chain = { ...config.chain, rpcUrls: { default: { http: [config.rpcUrl] } } };
  // viem retries transient HTTP/RPC failures with exponential backoff (retryDelay · 2^attempt).
  const transport = http(config.rpcUrl, { retryCount: config.rpcRetryCount, retryDelay: config.rpcRetryDelayMs, timeout: config.rpcTimeoutMs });
  const pollingInterval = Math.min(config.pollIntervalMs, 1_000);
  const client = createPublicClient({ chain, transport, pollingInterval }) as PublicClient;
  const log = options.log ?? (() => undefined);
  const sender = new TxSender(viemTxBackend(client, chain, { pollingIntervalMs: pollingInterval }), {
    receiptTimeoutMs: options.receiptTimeoutMs ?? config.receiptTimeoutMs, log,
  });
  return Object.freeze({ config, chain, client, sender, wallets, log });
}

export async function verifyChainId(ctx: ChainContext): Promise<void> {
  let actual: number;
  try { actual = await ctx.client.getChainId(); } catch (error) {
    throw new ChainError('RPC_UNAVAILABLE', `Cannot reach the ${ctx.config.network} RPC at ${ctx.config.rpcUrl}: ${describe(error)}`, { cause: error });
  }
  if (actual !== ctx.config.chainId) {
    throw new ChainError('CHAIN_ID_MISMATCH', `RPC ${ctx.config.rpcUrl} serves chainId ${actual}, expected ${ctx.config.chainId} for ${ctx.config.network}`);
  }
}

export async function rpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) {
    if (error instanceof ChainError) throw error;
    throw new ChainError('RPC_UNAVAILABLE', `${label}: ${describe(error)}`, { cause: error });
  }
}

export function checkedAddress(value: string, label: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new ChainError('INVALID_ARGUMENT', `${label} must be an address, got "${String(value)}"`);
  return getAddress(value);
}

export async function hasCode(ctx: ChainContext, address: Address): Promise<boolean> {
  const code = await rpc(`getCode ${address}`, () => ctx.client.getCode({ address }));
  return code !== undefined && code !== '0x';
}

/** Vault calls can bubble token errors (SafeERC20 forwards revert data), so decode against both. */
const tokenErrors = mockOpenTokenAbi.filter(item => item.type === 'error');
export const vaultCallAbi = [...mayaHouseVaultAbi, ...tokenErrors];

export function vaultCall(vault: Address, functionName: string, args: readonly unknown[], label = `vault.${functionName}`): TxCall {
  return { kind: 'call', label, to: vault, abi: vaultCallAbi, functionName, args };
}

export function tokenCall(token: Address, functionName: string, args: readonly unknown[], label = `token.${functionName}`): TxCall {
  return { kind: 'call', label, to: token, abi: mockOpenTokenAbi, functionName, args };
}

export async function tokenBalance(ctx: ChainContext, token: Address, owner: Address, blockNumber?: bigint): Promise<bigint> {
  return rpc(`token.balanceOf(${owner})`, () => ctx.client.readContract({ address: token, abi: mockOpenTokenAbi, functionName: 'balanceOf', args: [owner], ...(blockNumber === undefined ? {} : { blockNumber }) }));
}

export async function ethBalance(ctx: ChainContext, address: Address, blockNumber?: bigint): Promise<bigint> {
  return rpc(`getBalance(${address})`, () => ctx.client.getBalance({ address, ...(blockNumber === undefined ? {} : { blockNumber }) }));
}

/** Approves exactly `amount` when the current allowance is short. Caller serialises flows per owner. */
export async function ensureAllowance(ctx: ChainContext, token: Address, owner: LocalAccount, spender: Address, amount: bigint, label: string): Promise<string | null> {
  const allowance = await rpc('token.allowance', () => ctx.client.readContract({ address: token, abi: mockOpenTokenAbi, functionName: 'allowance', args: [owner.address, spender] }));
  if (allowance >= amount) return null;
  const receipt = await ctx.sender.send(owner, tokenCall(token, 'approve', [spender, amount], `${label}: approve`));
  return receipt.hash;
}

export const LOCAL_OPERATOR_FUND_WEI = 100n * 10n ** 18n;
export const LOCAL_WALLET_FUND_WEI = 10n * 10n ** 18n;

/**
 * Local anvil only: sends test ETH from anvil's public dev account 0 to every testnet wallet
 * whose balance is zero. Returns the funded roles.
 */
export async function fundLocalWallets(ctx: ChainContext): Promise<readonly string[]> {
  if (ctx.config.network !== 'local' || ctx.config.chainId !== 31337) throw new ChainError('INVALID_ARGUMENT', 'Dev-account funding is only allowed on the local anvil chain');
  const dev = privateKeyToAccount(ANVIL_DEV_ACCOUNT_0.privateKey);
  const empty: { role: string; address: Address; amount: bigint }[] = [];
  for (const role of ctx.wallets.roles()) {
    const address = ctx.wallets.address(role);
    if ((await ethBalance(ctx, address)) !== 0n) continue;
    empty.push({ role, address, amount: role === ctx.wallets.operator.role ? LOCAL_OPERATOR_FUND_WEI : LOCAL_WALLET_FUND_WEI });
  }
  if (empty.length === 0) return Object.freeze([]);
  const needed = empty.reduce((sum, w) => sum + w.amount, 0n);
  const available = await ethBalance(ctx, dev.address);
  if (available < needed + 10n ** 17n) {
    throw new ChainError('INSUFFICIENT_GAS_FUNDS', `anvil dev account 0 (${dev.address}) holds ${formatUnits18(available)} ETH but funding ${empty.map(w => w.role).join(', ')} needs ${formatUnits18(needed)} ETH; restart anvil or fund the wallets another way`);
  }
  const funded: string[] = [];
  const pending: Promise<unknown>[] = [];
  for (const { role, address, amount } of empty) {
    const submitted = await ctx.sender.submit(dev, { kind: 'transfer', label: `fund ${role} from anvil dev account`, to: address, value: amount });
    pending.push(submitted.wait());
    funded.push(role);
    ctx.log(`chain: funded ${role} ${address} with ${formatUnits18(amount)} ETH from anvil dev account 0 (tx ${submitted.hash})`);
  }
  const failed = (await Promise.allSettled(pending)).find(r => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return Object.freeze(funded);
}
