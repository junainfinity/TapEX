/**
 * DEV ONLY — automated-QA test wallet. Bundled only when the game is built with VITE_MAYA_TEST_WALLET=1 (vite.config.ts
 * turns the flag into a compile-time constant, so default and production builds contain none of this file).
 *
 * An EIP-1193 provider announced through EIP-6963 that forwards eth_accounts / personal_sign / eth_signTypedData_v4 /
 * eth_sendTransaction to the house's POST /v1/dev/wallet/* route, which signs with a .secrets test player key and
 * exists only on a 127.0.0.1 house bound to a local anvil (MAYA_DEV_TEST_WALLET=1). No key ever reaches the browser.
 * Read-only JSON-RPC goes straight to the chain's public RPC from /v1/chain-config.
 */
type Listener = (...args: unknown[]) => void;
const SIGNING = new Set(['eth_accounts', 'eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']);
const READS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_call', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getCode', 'eth_getTransactionCount']);

class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }

export function installTestWallet(options: { role?: string | undefined } = {}): void {
  const listeners = new Map<string, Set<Listener>>();
  let config: Promise<{ chainId: number; rpcUrl: string | null }> | undefined;
  const chain = () => (config ??= fetch('/v1/chain-config', { credentials: 'same-origin' }).then(r => r.json()).then((c: { chainId: number; rpcUrl: string | null }) => ({ chainId: c.chainId, rpcUrl: c.rpcUrl })));
  // Like an authorised wallet, stay connected for this tab across reloads (so silent reconnect can be tested).
  const KEY = 'maya-test-wallet.connected';
  let connected = (() => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; } })();
  let rpcId = 1;

  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') {
      const wanted = Number(BigInt(String((list[0] as { chainId?: unknown } | undefined)?.chainId ?? '0x0')));
      if (wanted !== (await chain()).chainId) throw new RpcError(4902, `The dev test wallet only knows chain ${(await chain()).chainId}`);
      return null;
    }
    if (method === 'eth_accounts' && !connected) return [];
    if (SIGNING.has(method)) {
      const res = await fetch(`/v1/dev/wallet/${method}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(options.role ? { role: options.role } : {}), params: list }) });
      const body = await res.json().catch(() => ({})) as { result?: unknown; error?: { code?: string; message?: string } };
      if (!res.ok) throw new RpcError(-32000, body.error?.message ?? `dev wallet ${method} failed (${res.status})`);
      if (method === 'eth_requestAccounts') { connected = true; try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode */ } emit('accountsChanged', body.result); }
      return body.result;
    }
    if (READS.has(method)) {
      const { rpcUrl } = await chain();
      if (!rpcUrl) throw new RpcError(-32000, 'The house publishes no RPC URL');
      const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params: list }) });
      const body = await res.json() as { result?: unknown; error?: { code?: number; message?: string } };
      if (body.error) throw new RpcError(body.error.code ?? -32000, body.error.message ?? 'RPC error');
      return body.result;
    }
    throw new RpcError(4200, `The dev test wallet does not support ${method}`);
  };
  const emit = (event: string, ...args: unknown[]) => { for (const l of listeners.get(event) ?? []) l(...args); };
  const provider = Object.freeze({
    isMayaTestWallet: true,
    request,
    on: (event: string, l: Listener) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(l); },
    removeListener: (event: string, l: Listener) => { listeners.get(event)?.delete(l); },
  });
  const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#ffd98f"/><path d="M6 8h12v9H6z" fill="none" stroke="#2d1c05" stroke-width="1.6"/><text x="12" y="15" font-size="6" text-anchor="middle" fill="#2d1c05" font-family="sans-serif">DEV</text></svg>')}`;
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: 'Maya Test Wallet (dev only)', icon, rdns: 'dev.maya.testwallet' });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  console.warn('[maya] DEV ONLY test wallet announced (VITE_MAYA_TEST_WALLET=1); signatures come from the local house /v1/dev/wallet route.');
}
