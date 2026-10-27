/**
 * Typed client for the $OPEN house player API (same origin; the session is an HttpOnly cookie the browser sends).
 * No request is ever retried here: a timeout or dropped connection is reported as an unknown outcome and the
 * caller reconciles (bets by the same requestId, withdrawals by their list).
 */
export class HouseError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body?: unknown) { super(message); }
  /** No answer: the request may or may not have reached the house. */
  get unknownOutcome(): boolean { return this.status === 0; }
}

export interface ChainConfig {
  readonly network: string;
  readonly chainId: number;
  readonly chainName: string;
  readonly walletSupported: boolean;
  readonly rpcUrl: string | null;
  readonly explorer: string | null;
  readonly token: { readonly address: string; readonly symbol: string; readonly name: string; readonly decimals: number };
  readonly vault: string;
  readonly nativeCurrency: { readonly name: string; readonly symbol: string; readonly decimals: number };
  readonly siwe?: { readonly domain: string; readonly uri: string; readonly chainId: number };
}
export interface NonceResponse { readonly nonce: string; readonly expiresAtMs: number; readonly domain: string; readonly uri: string; readonly chainId: number; readonly version: '1'; readonly statement: string }
export interface SessionResponse { readonly authenticated: boolean; readonly account?: string; readonly expiresAtMs?: number; readonly chainId?: number }
export interface PathResponse { readonly market: string; readonly feedId: string; readonly pairId: 1 | 2; readonly clockMs: number; readonly speed: number; readonly latestT: number | null; readonly samples: readonly { t: number; sourceTimeMs: number; price: string; sampleId: string; receivedAtMs: number }[] }
export interface QuoteCell { readonly cellId: string; readonly start: number; readonly end: number; readonly lower: string; readonly upper: string; readonly available: boolean; readonly reason?: string; readonly quoteId?: string; readonly revision?: number; readonly x100?: number; readonly maxStakeCenti?: string; readonly validUntilMs?: number; readonly window: number; readonly bandOffset: number }
export interface QuotesResponse { readonly market: string; readonly available?: boolean; readonly reason?: string; readonly t?: number; readonly generatedAtMs?: number; readonly clockMs?: number; readonly tableId?: string; readonly phase?: string; readonly edge?: number; readonly minStakeCenti?: string; readonly acceptance?: { readonly hold: boolean; readonly maxHoldMs: number; readonly minLeadS: number }; readonly cells: readonly QuoteCell[] }
export interface LegJson { readonly legId: string; readonly requestId: string; readonly quoteId: string; readonly account: string; readonly market: string; readonly cellId: string; readonly start: number; readonly end: number; readonly lower: string; readonly upper: string; readonly stakeCenti: string; readonly x100: number; readonly payoutCenti: string; readonly status: 'open' | 'won' | 'lost' | 'refunded'; readonly placedMs: number; readonly tableId?: string; readonly settledMs?: number; readonly creditCenti?: string; readonly evidenceSampleIds?: readonly string[]; readonly settlementReason?: string; readonly touchTimeMs?: number }
export interface AccountResponse { readonly account: string; readonly registered: boolean; readonly balanceCenti: string; readonly availableCenti?: string; readonly blocked?: boolean; readonly flagged?: boolean; readonly pendingBets?: readonly unknown[]; readonly openLegs: readonly LegJson[]; readonly recentLegs: readonly LegJson[]; readonly deposits: readonly { id: string; amountCenti: string; dustWei: string; txHash: string; blockNumber: string; ms: number }[] }
export interface VoucherJson { readonly voucherId: string; readonly requestId: string; readonly status: 'signing' | 'pending' | 'claimed' | 'cancelled' | 'expired'; readonly account: string; readonly amountCenti: string; readonly amountWei: string; readonly nonce: string; readonly expiry: string; readonly expiryMs: number; readonly signature?: string; readonly vault: string; readonly chainId: number; readonly createdMs: number; readonly submittedTxHash?: string; readonly txHash?: string; readonly releaseReason?: string }
export interface WithdrawalsResponse { readonly account: string; readonly availableCenti: string; readonly rows: readonly VoucherJson[] }
export interface PromoResponse { readonly tier: 'launch' | 'growth' | 'scale' | 'standard'; readonly label: string; readonly minWinX100: number; readonly progress: { readonly players: number; readonly untilPlayers: number | null; readonly turnoverCenti: string; readonly untilTurnoverCenti: string | null }; readonly account: { readonly boostRemainingCenti: string | null } | null }
/** POST /v1/bets and GET /v1/bets/by-request answer: accepted (200), pending (202) or rejected (4xx body). */
export interface PlacementBody { readonly status: 'accepted' | 'pending' | 'rejected'; readonly leg?: LegJson; readonly reason?: string; readonly message?: string; readonly retryAfterMs?: number; readonly hold?: { readonly holdUntilMs: number } }

export class HouseApi {
  constructor(private readonly base = '') {}

  private async send(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 8_000): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal, headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new HouseError(0, controller.signal.aborted ? 'TIMEOUT' : 'NETWORK', controller.signal.aborted ? 'The house did not answer in time' : 'Could not reach the house', error);
    } finally { clearTimeout(timer); }
    let parsed: unknown;
    try { const text = await res.text(); parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    return { status: res.status, body: parsed };
  }

  /** Throws HouseError for non-2xx answers. */
  private async json<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const r = await this.send(method, path, body, timeoutMs);
    if (r.status < 200 || r.status >= 300) {
      const e = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new HouseError(r.status, e?.code ?? `HTTP_${r.status}`, e?.message ?? `The house answered ${r.status}`, r.body);
    }
    return r.body as T;
  }

  chainConfig(): Promise<ChainConfig> { return this.json('GET', '/v1/chain-config'); }
  nonce(): Promise<NonceResponse> { return this.json('GET', '/v1/auth/nonce'); }
  verify(message: string, signature: string): Promise<SessionResponse> { return this.json('POST', '/v1/auth/verify', { message, signature }); }
  logout(): Promise<SessionResponse> { return this.json('POST', '/v1/auth/logout', {}); }
  session(): Promise<SessionResponse> { return this.json('GET', '/v1/session'); }
  path(market: string, fromMs?: number): Promise<PathResponse> { return this.json('GET', `/v1/path?market=${encodeURIComponent(market)}${fromMs !== undefined ? `&fromMs=${Math.max(0, Math.floor(fromMs))}` : ''}`); }
  quotes(market: string): Promise<QuotesResponse> { return this.json('GET', `/v1/quotes?market=${encodeURIComponent(market)}`, undefined, 4_000); }
  account(address: string): Promise<AccountResponse> { return this.json('GET', `/v1/account/${encodeURIComponent(address)}`); }
  withdrawals(): Promise<WithdrawalsResponse> { return this.json('GET', '/v1/withdrawals'); }
  requestWithdrawal(requestId: string, amountCenti: string): Promise<VoucherJson & { created: boolean }> { return this.json('POST', '/v1/withdrawals', { requestId, amountCenti }, 20_000); }
  promo(): Promise<PromoResponse> { return this.json('GET', '/v1/promo'); }

  /** A placement answer of any status; only a missing answer throws (HouseError with status 0). */
  async placeBet(intent: { requestId: string; quoteId: string; revision: number; cellId: string; stakeCenti: string }, timeoutMs = 8_000): Promise<{ status: number; body: PlacementBody | undefined; error?: { code?: string; message?: string } }> {
    const r = await this.send('POST', '/v1/bets', intent, timeoutMs);
    return { status: r.status, body: r.body as PlacementBody | undefined, ...(r.status >= 400 ? { error: (r.body as { error?: { code?: string; message?: string } } | undefined)?.error ?? {} } : {}) };
  }
  async betByRequest(requestId: string): Promise<{ status: number; body: PlacementBody | undefined }> {
    const r = await this.send('GET', `/v1/bets/by-request/${encodeURIComponent(requestId)}`);
    return { status: r.status, body: r.body as PlacementBody | undefined };
  }
}
