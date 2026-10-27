import { createPublicClient, createWalletClient, getAddress, hexToString, http, isAddress as viemIsAddress, isHex, type Hex } from 'viem';
import { foundry } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';
import type { WalletSet } from '../chain/secrets.js';
import type { Ctx } from './context.js';
import { HttpError, Router, allowKeys, readJsonBody, sendJson } from './http.js';

/**
 * DEV ONLY — test wallet signer for automated browser QA on a local anvil chain.
 *
 * The game's dev build (VITE_MAYA_TEST_WALLET=1) announces an EIP-1193 shim through EIP-6963 that forwards
 * eth_accounts / personal_sign / eth_signTypedData_v4 / eth_sendTransaction here, so a .secrets test player key signs
 * server-side and no key ever reaches the browser. The route exists only when MAYA_DEV_TEST_WALLET=1 AND the server
 * is bound to 127.0.0.1 AND MAYA_NETWORK=local (config.ts refuses the flag otherwise; main.ts mounts it only then).
 *
 * Guards on top of the loopback bind: the Host header must name a loopback host (DNS rebinding), a present Origin must
 * be a loopback origin, only player-N roles sign, personal_sign signs only this game's SIWE messages for the local
 * chain, typed data must name the local chain id, and transactions go only to the local RPC whose chain id was
 * verified at start. The player keys are also used on Base Sepolia, so nothing signed here may be valid there.
 */
export const DEV_WALLET_METHODS = ['eth_accounts', 'eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'] as const;
export type DevWalletMethod = typeof DEV_WALLET_METHODS[number];

const PLAYER_ROLE = /^player-[1-9]\d{0,3}$/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

export interface DevWalletTx { readonly to: Hex; readonly data?: Hex | undefined; readonly value?: bigint | undefined; readonly gas?: bigint | undefined }

/** What the route needs; `createDevWallet` builds it from the testnet wallet file, tests inject fakes. */
export interface DevWallet {
  readonly chainId: number;
  /** SIWE domain the game signs in with (MAYA_PUBLIC_ORIGIN host). */
  readonly siweDomain: string;
  readonly defaultRole: string;
  has(role: string): boolean;
  address(role: string): string;
  signMessage(role: string, raw: Hex): Promise<Hex>;
  signTypedData(role: string, typedData: TypedDataInput): Promise<Hex>;
  sendTransaction(role: string, tx: DevWalletTx): Promise<Hex>;
}

export interface TypedDataInput { readonly domain: Record<string, unknown>; readonly types: Record<string, unknown>; readonly primaryType: string; readonly message: Record<string, unknown> }

/** Whether this configuration may mount the dev wallet (exact rule; config.ts refuses the flag otherwise). */
export function devWalletAllowed(c: { readonly devTestWallet?: boolean; readonly host: string; readonly network: string }): { ok: true } | { ok: false; reason: string } {
  if (!c.devTestWallet) return { ok: false, reason: 'MAYA_DEV_TEST_WALLET is not set' };
  if (c.network !== 'local') return { ok: false, reason: 'MAYA_DEV_TEST_WALLET needs MAYA_NETWORK=local' };
  if (c.host !== '127.0.0.1') return { ok: false, reason: 'MAYA_DEV_TEST_WALLET needs MAYA_HOST=127.0.0.1' };
  return { ok: true };
}

/** A DevWallet over the .secrets player keys (viem accounts; keys never leave `secrets.ts`) and the local RPC. */
export async function createDevWallet(options: { readonly wallets: WalletSet; readonly rpcUrl: string; readonly siweDomain: string; readonly defaultRole: string }): Promise<DevWallet> {
  const { wallets } = options;
  if (!PLAYER_ROLE.test(options.defaultRole) || !wallets.has(options.defaultRole)) throw new Error(`MAYA_DEV_TEST_WALLET_ROLE must name a player-N wallet in the secrets file (got ${options.defaultRole})`);
  const transport = http(options.rpcUrl, { timeout: 15_000, retryCount: 0 });
  const chainId = await createPublicClient({ chain: foundry, transport }).getChainId();
  if (chainId !== foundry.id) throw new Error(`Dev test wallet: RPC ${options.rpcUrl} is chain ${chainId}, not the local chain ${foundry.id}`);
  const role = (r: string) => { if (!PLAYER_ROLE.test(r) || !wallets.has(r)) throw new HttpError(400, 'UNKNOWN_ROLE', 'role must name a player-N test wallet'); return r; };
  return {
    chainId, siweDomain: options.siweDomain, defaultRole: options.defaultRole,
    has: r => PLAYER_ROLE.test(r) && wallets.has(r),
    address: r => wallets.address(role(r)),
    signMessage: (r, raw) => wallets.account(role(r)).signMessage({ message: { raw } }),
    signTypedData: (r, t) => wallets.account(role(r)).signTypedData(t as Parameters<ReturnType<WalletSet['account']>['signTypedData']>[0]),
    sendTransaction: (r, tx) => createWalletClient({ account: wallets.account(role(r)), chain: foundry, transport }).sendTransaction({ to: tx.to, ...(tx.data ? { data: tx.data } : {}), ...(tx.value !== undefined ? { value: tx.value } : {}), ...(tx.gas !== undefined ? { gas: tx.gas } : {}) }),
  };
}

/** main.ts: build the dev wallet from `.secrets/testnet-wallets.json` (loaded lazily; only when devWalletAllowed). */
export async function loadDevWallet(options: { readonly repoRoot: string; readonly rpcUrl: string; readonly siweDomain: string; readonly defaultRole: string }): Promise<DevWallet> {
  const [{ loadWallets }, { repoPaths }] = await Promise.all([import('../chain/secrets.js'), import('../chain/networks.js')]);
  return createDevWallet({ wallets: loadWallets(repoPaths(options.repoRoot).secrets), rpcUrl: options.rpcUrl, siweDomain: options.siweDomain, defaultRole: options.defaultRole });
}

const quantity = (v: unknown, name: string): bigint | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be a 0x quantity`);
  return BigInt(v);
};
const sameAddress = (a: unknown, b: string) => typeof a === 'string' && viemIsAddress(a, { strict: false }) && getAddress(a) === getAddress(b);

export function devWalletRoutes(router: Router<Ctx>, wallet: DevWallet): void {
  router.add({ method: 'POST', pattern: '/v1/dev/wallet/:method', handler: async (ctx, p) => {
    const host = ctx.req.headers.host ?? '';
    if (!LOOPBACK_HOST.test(host)) { ctx.req.resume(); throw new HttpError(403, 'DEV_WALLET_LOOPBACK_ONLY', 'The dev test wallet answers loopback hosts only'); }
    const origin = ctx.req.headers.origin;
    if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) { ctx.req.resume(); throw new HttpError(403, 'DEV_WALLET_LOOPBACK_ONLY', 'The dev test wallet answers loopback origins only'); }
    ctx.deps.auth?.rateLimit('dev-wallet', 'loopback');
    const method = p['method'] as DevWalletMethod;
    if (!DEV_WALLET_METHODS.includes(method)) { ctx.req.resume(); throw new HttpError(404, 'NOT_FOUND', `Unsupported dev wallet method ${method}`); }
    const body = await readJsonBody(ctx.req);
    allowKeys(body, ['role', 'params']);
    const role = body['role'] === undefined ? wallet.defaultRole : body['role'];
    if (typeof role !== 'string' || !wallet.has(role)) throw new HttpError(400, 'UNKNOWN_ROLE', 'role must name a player-N test wallet');
    const params = body['params'] ?? [];
    if (!Array.isArray(params) || params.length > 4) throw new HttpError(400, 'VALIDATION_ERROR', 'params must be a JSON-RPC params array');
    const address = wallet.address(role);
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') { sendJson(ctx.res, 200, { result: [address] }); return; }

    if (method === 'personal_sign') {
      const [message, signer] = params as unknown[];
      if (!sameAddress(signer, address)) throw new HttpError(403, 'DEV_WALLET_WRONG_ACCOUNT', 'personal_sign names another account than the test wallet');
      if (typeof message !== 'string' || message.length > 8192) throw new HttpError(400, 'VALIDATION_ERROR', 'message must be a string');
      const raw = (isHex(message) ? message : `0x${Buffer.from(message, 'utf8').toString('hex')}`) as Hex;
      let text: string;
      try { text = hexToString(raw); } catch { throw new HttpError(400, 'VALIDATION_ERROR', 'message is not UTF-8'); }
      let siwe: ReturnType<typeof parseSiweMessage>;
      try { siwe = parseSiweMessage(text); } catch { siwe = {}; }
      // Only this game's sign-in on the local chain: nothing signed here is valid on Base Sepolia or another site.
      if (siwe.domain !== wallet.siweDomain || siwe.chainId !== wallet.chainId || !sameAddress(siwe.address, address)) {
        throw new HttpError(403, 'DEV_WALLET_MESSAGE_REFUSED', `The dev test wallet signs only SIWE messages for ${wallet.siweDomain} on chain ${wallet.chainId}`);
      }
      sendJson(ctx.res, 200, { result: await wallet.signMessage(role, raw) });
      return;
    }

    if (method === 'eth_signTypedData_v4') {
      const [signer, data] = params as unknown[];
      if (!sameAddress(signer, address)) throw new HttpError(403, 'DEV_WALLET_WRONG_ACCOUNT', 'eth_signTypedData_v4 names another account than the test wallet');
      let typed: unknown = data;
      if (typeof data === 'string') { try { typed = JSON.parse(data); } catch { throw new HttpError(400, 'VALIDATION_ERROR', 'typed data is not JSON'); } }
      const t = typed as Partial<TypedDataInput> | null;
      if (!t || typeof t !== 'object' || !t.domain || !t.types || typeof t.primaryType !== 'string' || !t.message) throw new HttpError(400, 'VALIDATION_ERROR', 'typed data needs domain, types, primaryType and message');
      if (Number(t.domain['chainId']) !== wallet.chainId) throw new HttpError(403, 'DEV_WALLET_CHAIN_REFUSED', `The dev test wallet signs typed data for chain ${wallet.chainId} only`);
      const { EIP712Domain: _drop, ...types } = t.types as Record<string, unknown>;
      sendJson(ctx.res, 200, { result: await wallet.signTypedData(role, { domain: t.domain, types, primaryType: t.primaryType, message: t.message }) });
      return;
    }

    // eth_sendTransaction: only calls to an existing address on the verified local chain.
    const [tx] = params as unknown[];
    if (!tx || typeof tx !== 'object') throw new HttpError(400, 'VALIDATION_ERROR', 'eth_sendTransaction needs a transaction object');
    const t = tx as Record<string, unknown>;
    const extra = Object.keys(t).filter(k => !['from', 'to', 'data', 'input', 'value', 'gas', 'chainId'].includes(k));
    if (extra.length) throw new HttpError(400, 'VALIDATION_ERROR', `Unsupported transaction field(s): ${extra.join(', ')}`);
    if (!sameAddress(t['from'], address)) throw new HttpError(403, 'DEV_WALLET_WRONG_ACCOUNT', 'from must be the test wallet');
    if (typeof t['to'] !== 'string' || !viemIsAddress(t['to'], { strict: false })) throw new HttpError(400, 'VALIDATION_ERROR', 'to must be an address (no contract creation)');
    if (t['chainId'] !== undefined && Number(quantity(t['chainId'], 'chainId')) !== wallet.chainId) throw new HttpError(403, 'DEV_WALLET_CHAIN_REFUSED', `chainId must be ${wallet.chainId}`);
    const data = t['data'] ?? t['input'];
    if (data !== undefined && (typeof data !== 'string' || !/^0x([0-9a-fA-F]{2}){0,65536}$/.test(data))) throw new HttpError(400, 'VALIDATION_ERROR', 'data must be 0x hex');
    const request: DevWalletTx = { to: getAddress(t['to']), data: data as Hex | undefined, value: quantity(t['value'], 'value'), gas: quantity(t['gas'], 'gas') };
    let hash: Hex;
    try { hash = await wallet.sendTransaction(role, request); } catch (error) {
      // Like a wallet: a transaction the node refuses (e.g. a revert found by gas estimation) is an error, not a hash.
      const text = (error as { shortMessage?: unknown }).shortMessage;
      throw new HttpError(422, 'DEV_WALLET_TX_FAILED', typeof text === 'string' ? text.slice(0, 300) : 'The local node refused the transaction');
    }
    sendJson(ctx.res, 200, { result: hash });
  } });
}
