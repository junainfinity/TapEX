import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, numberToHex, parseAbi, stringToHex, type Hex } from 'viem';
import type { ChainConfig } from './house-api.js';

/** Minimal EIP-1193 provider. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}
export interface WalletEntry { readonly id: string; readonly name: string; readonly icon?: string; readonly rdns?: string; readonly provider: Eip1193Provider }

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 amount) returns (bool)']);
const VAULT = parseAbi(['function deposit(uint256 amount)', 'function withdraw(uint256 amount, uint256 nonce, uint256 expiry, bytes signature)']);

/** EIP-1193 errors carry a numeric code; 4001 = the user rejected the request. */
export function walletErrorCode(error: unknown): number | undefined {
  const e = error as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: { code?: unknown } };
  for (const c of [e?.code, e?.data?.originalError?.code, e?.cause?.code]) if (typeof c === 'number') return c;
  return undefined;
}
export function walletErrorMessage(error: unknown, fallback: string): string {
  const code = walletErrorCode(error);
  if (code === 4001) return 'You rejected the request in your wallet.';
  if (code === 4100) return 'Your wallet has not authorised this site. Connect it first.';
  if (code === -32002) return 'Your wallet already has a pending request. Open it to continue.';
  const m = (error as { message?: unknown })?.message;
  return typeof m === 'string' && m.length < 240 ? `${fallback}: ${m}` : fallback;
}

/**
 * EIP-6963 discovery (MetaMask first), with the injected `window.ethereum` as a fallback when no wallet announces
 * itself. Keeps listening, so a wallet that loads late still appears.
 */
export class WalletDiscovery {
  private readonly entries = new Map<string, WalletEntry>();
  private readonly listeners = new Set<() => void>();
  private fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown }; provider?: Eip1193Provider }>).detail;
    const info = detail?.info, provider = detail?.provider;
    if (!info || !provider || typeof provider.request !== 'function' || typeof info.uuid !== 'string' || typeof info.name !== 'string') return;
    const rdns = typeof info.rdns === 'string' ? info.rdns : undefined;
    // One entry per wallet (rdns), newest announcement wins; drop the injected fallback once a real wallet announces.
    for (const [id, e] of this.entries) if ((rdns && e.rdns === rdns) || id === 'injected') this.entries.delete(id);
    this.entries.set(info.uuid, { id: info.uuid, name: info.name.slice(0, 40), ...(typeof info.icon === 'string' ? { icon: info.icon } : {}), ...(rdns ? { rdns } : {}), provider });
    this.emit();
  };

  start(): void {
    window.addEventListener('eip6963:announceProvider', this.onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    this.fallbackTimer = setTimeout(() => {
      const injected = (window as unknown as { ethereum?: Eip1193Provider & { isMetaMask?: boolean } }).ethereum;
      if (!this.entries.size && injected && typeof injected.request === 'function') {
        this.entries.set('injected', { id: 'injected', name: injected.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: injected });
        this.emit();
      }
    }, 500);
  }
  stop(): void { window.removeEventListener('eip6963:announceProvider', this.onAnnounce); if (this.fallbackTimer) clearTimeout(this.fallbackTimer); }
  list(): WalletEntry[] {
    const rank = (e: WalletEntry) => (e.rdns === 'io.metamask' || e.rdns?.startsWith('io.metamask') ? 0 : e.id === 'injected' ? 2 : 1);
    return [...this.entries.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }
  get(id: string): WalletEntry | undefined { return this.entries.get(id); }
  byRdns(rdns: string): WalletEntry | undefined { return [...this.entries.values()].find(e => e.rdns === rdns); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const l of this.listeners) l(); }
}

export interface TxReceipt { readonly status: 'success' | 'reverted'; readonly blockNumber: bigint; readonly transactionHash: Hex }

/** One connected wallet on the house's chain: chain switching, SIWE signatures, tOPEN/vault calls. */
export class ConnectedWallet {
  address: `0x${string}` | undefined;
  constructor(readonly entry: WalletEntry, readonly chain: ChainConfig) {}
  private req<T>(method: string, params?: unknown): Promise<T> { return this.entry.provider.request({ method, ...(params === undefined ? {} : { params }) }) as Promise<T>; }

  /** eth_requestAccounts (prompts) or eth_accounts (silent reconnect). */
  async connect(prompt: boolean): Promise<`0x${string}` | undefined> {
    const accounts = await this.req<unknown[]>(prompt ? 'eth_requestAccounts' : 'eth_accounts');
    const first = Array.isArray(accounts) ? accounts.find((a): a is string => typeof a === 'string' && isAddress(a)) : undefined;
    this.address = first ? getAddress(first) : undefined;
    return this.address;
  }
  async chainId(): Promise<number> { return Number(BigInt(await this.req<string>('eth_chainId'))); }
  async onRightChain(): Promise<boolean> { return (await this.chainId()) === this.chain.chainId; }

  /** wallet_switchEthereumChain, adding the chain from /v1/chain-config when the wallet does not know it (4902). */
  async ensureChain(): Promise<void> {
    if (await this.onRightChain()) return;
    const chainId = numberToHex(this.chain.chainId);
    try { await this.req('wallet_switchEthereumChain', [{ chainId }]); }
    catch (error) {
      const code = walletErrorCode(error);
      if (code !== 4902 && code !== -32603) throw error;
      if (!this.chain.rpcUrl) throw new Error('The house did not publish an RPC URL for this chain');
      await this.req('wallet_addEthereumChain', [{ chainId, chainName: this.chain.chainName, rpcUrls: [this.chain.rpcUrl], nativeCurrency: this.chain.nativeCurrency, ...(this.chain.explorer ? { blockExplorerUrls: [this.chain.explorer] } : {}) }]);
    }
    if (!(await this.onRightChain())) throw new Error(`Your wallet is still not on ${this.chain.chainName}`);
  }

  /** personal_sign of an EIP-4361 message (UTF-8 as hex, as wallets expect). */
  async signMessage(message: string): Promise<Hex> {
    if (!this.address) throw new Error('No wallet account connected');
    return this.req<Hex>('personal_sign', [stringToHex(message), this.address]);
  }

  private async call(to: string, data: Hex): Promise<Hex> { return this.req<Hex>('eth_call', [{ to, data }, 'latest']); }
  async tokenBalance(): Promise<bigint> {
    const data = encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [this.address!] });
    return decodeFunctionResult({ abi: ERC20, functionName: 'balanceOf', data: await this.call(this.chain.token.address, data) });
  }
  async allowance(): Promise<bigint> {
    const data = encodeFunctionData({ abi: ERC20, functionName: 'allowance', args: [this.address!, getAddress(this.chain.vault)] });
    return decodeFunctionResult({ abi: ERC20, functionName: 'allowance', data: await this.call(this.chain.token.address, data) });
  }
  async ethBalance(): Promise<bigint> { return BigInt(await this.req<string>('eth_getBalance', [this.address, 'latest'])); }
  /** Latest block time (seconds): vouchers expire by chain time, not the browser clock. */
  async chainTimeS(): Promise<bigint> { const b = await this.req<{ timestamp?: string } | null>('eth_getBlockByNumber', ['latest', false]); return BigInt(b?.timestamp ?? '0x0'); }

  private send(to: string, data: Hex): Promise<Hex> { return this.req<Hex>('eth_sendTransaction', [{ from: this.address, to, data }]); }
  approve(amountWei: bigint): Promise<Hex> { return this.send(this.chain.token.address, encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [getAddress(this.chain.vault), amountWei] })); }
  deposit(amountWei: bigint): Promise<Hex> { return this.send(this.chain.vault, encodeFunctionData({ abi: VAULT, functionName: 'deposit', args: [amountWei] })); }
  withdraw(v: { amountWei: bigint; nonce: bigint; expiry: bigint; signature: Hex }): Promise<Hex> { return this.send(this.chain.vault, encodeFunctionData({ abi: VAULT, functionName: 'withdraw', args: [v.amountWei, v.nonce, v.expiry, v.signature] })); }

  /** Poll the receipt through the wallet's own RPC (no second endpoint, no CORS). */
  async waitForReceipt(hash: Hex, timeoutMs = 180_000): Promise<TxReceipt> {
    const deadline = Date.now() + timeoutMs;
    for (let delay = 500; Date.now() < deadline; delay = Math.min(3_000, delay * 1.5)) {
      const r = await this.req<{ status?: string; blockNumber?: string; transactionHash?: Hex } | null>('eth_getTransactionReceipt', [hash]);
      if (r && r.blockNumber) return { status: r.status === '0x1' ? 'success' : 'reverted', blockNumber: BigInt(r.blockNumber), transactionHash: r.transactionHash ?? hash };
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    throw new Error('The transaction is not mined yet. Check the explorer; the game updates when it lands.');
  }

  explorerTx(hash: string): string | null { return this.chain.explorer ? `${this.chain.explorer}/tx/${hash}` : null; }
  explorerAddress(address: string): string | null { return this.chain.explorer ? `${this.chain.explorer}/address/${address}` : null; }
}
