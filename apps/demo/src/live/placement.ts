import type { QuoteSnapshot } from '@maya/contracts';
import type { PendingPlay } from '@maya/game-ui';
import { HouseError, type HouseApi, type PlacementBody } from './house-api.js';

/** Player-facing text for every typed rejection the house can return (SPEC §1.5, SPEC-10). */
export const REJECTION_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  QUOTE_CHANGED: 'Price moved — try again',
  QUOTE_EXPIRED: 'Price moved — try again',
  PRICE_MOVED: 'Price moved — try again',
  TOO_LATE: 'Too close to its start — pick a later square',
  INSUFFICIENT_BALANCE: 'Not enough OPEN — deposit to play',
  STAKE_NOT_ALLOWED: 'That stake is not allowed here',
  CELL_CAP_EXCEEDED: 'You reached the limit for this square',
  LIABILITY_LIMIT: 'The house cannot take more on this square now — try a smaller stake',
  ACCOUNT_BLOCKED: 'This account cannot place bets (withdrawals still work)',
  UNKNOWN_ACCOUNT: 'Sign in to play',
  MARKET_PAUSED: 'Trading is paused for this market',
  INPUT_NOT_READY: 'Waiting for fresh house prices',
  REQUEST_CONFLICT: 'That tap conflicted with another — try again',
  INVALID_REQUEST: 'The house could not read that tap — try again',
  AUTH_REQUIRED: 'Your session ended — sign in again',
  RATE_LIMITED: 'Too many taps — slow down a moment',
  ORIGIN_MISMATCH: 'This page is not the house\'s game address',
});
export function rejectionText(reason: string | undefined, fallback = 'That square is unavailable — try another'): string {
  return (reason && REJECTION_MESSAGES[reason]) || fallback;
}
/** Short caption drawn on the refused square. */
export function rejectionCaption(reason: string | undefined): string {
  return reason === 'QUOTE_CHANGED' || reason === 'QUOTE_EXPIRED' || reason === 'PRICE_MOVED' ? 'Price moved' : reason === 'INSUFFICIENT_BALANCE' ? 'Deposit to play' : 'Not placed';
}

export type PlacementOutcome =
  | { readonly kind: 'accepted'; readonly requestId: string }
  | { readonly kind: 'rejected'; readonly requestId: string; readonly reason: string; readonly message: string; readonly quote: QuoteSnapshot }
  | { readonly kind: 'auth'; readonly requestId: string }
  | { readonly kind: 'unknown'; readonly requestId: string; readonly message: string };

interface Tracked { play: PendingPlay; quote: QuoteSnapshot; since: number }

/**
 * Bets through the house: POST /v1/bets names the quote the player saw (never odds) and a fresh requestId per tap.
 * 202 pending (the SPEC-10 hold) shows "Confirming…" and is followed with GET /v1/bets/by-request/:id. A timeout or
 * dropped connection is not a rejection: the SAME requestId is reconciled until the house answers or the quote is
 * provably dead (its validity has passed, so the house can no longer accept it). Never a new requestId, never a
 * silent re-send.
 */
export class PlacementBook {
  private readonly tracked = new Map<string, Tracked>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly api: HouseApi, private readonly nowMs: () => number, private readonly onOutcome: (o: PlacementOutcome) => void) {}

  pending(): readonly PendingPlay[] { return [...this.tracked.values()].map(t => t.play); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const l of this.listeners) l(); }
  clear(): void { this.tracked.clear(); this.emit(); }

  async place(quote: QuoteSnapshot, stakeCenti: string): Promise<void> {
    const requestId = crypto.randomUUID();
    const play: PendingPlay = { ...cellOf(quote), requestId, stakeCents: stakeCenti, grossX100: quote.grossX100, phase: 'confirming' };
    this.tracked.set(requestId, { play, quote, since: performance.now() });
    this.emit();
    let answer: Awaited<ReturnType<HouseApi['placeBet']>>;
    try {
      answer = await this.api.placeBet({ requestId, quoteId: quote.quoteId, revision: quote.revision, cellId: quote.cellId, stakeCenti });
    } catch (error) {
      if (error instanceof HouseError && error.unknownOutcome) { await this.reconcile(requestId); return; }
      this.finish({ kind: 'unknown', requestId, message: 'The house did not answer — check your plays' });
      return;
    }
    await this.handle(requestId, answer.status, answer.body, answer.error?.code);
  }

  private async handle(requestId: string, status: number, body: PlacementBody | undefined, errorCode?: string): Promise<void> {
    const t = this.tracked.get(requestId);
    if (!t) return;
    if (status === 200 && body?.status === 'accepted') { this.finish({ kind: 'accepted', requestId }); return; }
    if ((status === 202 || status === 200) && body?.status === 'pending') { await this.follow(requestId, body.retryAfterMs ?? 250); return; }
    if (status === 401) { this.finish({ kind: 'auth', requestId }); return; }
    if (status >= 500 || status === 0) { await this.reconcile(requestId); return; }
    const reason = body?.reason ?? errorCode;
    this.finish({ kind: 'rejected', requestId, reason: reason ?? 'UNAVAILABLE', message: rejectionText(reason), quote: t.quote });
  }

  /** The house holds the bet until its next first-seen second (≤ maxHoldMs): poll the same requestId. */
  private async follow(requestId: string, retryAfterMs: number): Promise<void> {
    const deadline = performance.now() + 15_000;
    let wait = Math.max(150, Math.min(1_000, retryAfterMs));
    while (this.tracked.has(requestId) && performance.now() < deadline) {
      await sleep(wait);
      let r: Awaited<ReturnType<HouseApi['betByRequest']>>;
      try { r = await this.api.betByRequest(requestId); } catch { wait = Math.min(2_000, wait * 2); continue; }
      if (r.status === 200 && r.body?.status === 'pending') { wait = Math.max(150, Math.min(1_000, r.body.retryAfterMs ?? 250)); continue; }
      if (r.status === 404) { await this.reconcile(requestId); return; }
      if (r.status === 200 && (r.body?.status === 'accepted' || r.body?.status === 'rejected')) {
        await this.handle(requestId, r.body.status === 'accepted' ? 200 : 422, r.body);
        return;
      }
      if (r.status === 401) { this.finish({ kind: 'auth', requestId }); return; }
      wait = Math.min(2_000, wait * 2);
    }
    if (this.tracked.has(requestId)) this.finish({ kind: 'unknown', requestId, message: 'Still waiting for the house — your plays list will show it if it was placed' });
  }

  /**
   * The answer was lost. Ask for the same requestId until the house answers; "not found" is only final once the quote
   * can no longer be accepted (house clock past its validity plus the hold window), otherwise the request may still be
   * on its way.
   */
  private async reconcile(requestId: string): Promise<void> {
    const t = this.tracked.get(requestId);
    if (!t) return;
    t.play = { ...t.play, phase: 'checking' };
    this.emit();
    const deadline = performance.now() + 30_000;
    let wait = 400;
    while (this.tracked.has(requestId) && performance.now() < deadline) {
      await sleep(wait);
      let r: Awaited<ReturnType<HouseApi['betByRequest']>>;
      try { r = await this.api.betByRequest(requestId); } catch { wait = Math.min(3_000, wait * 1.6); continue; }
      if (r.status === 200 && r.body?.status === 'pending') { await this.follow(requestId, r.body.retryAfterMs ?? 250); return; }
      if (r.status === 200 && r.body) { await this.handle(requestId, r.body.status === 'accepted' ? 200 : 422, r.body); return; }
      if (r.status === 401) { this.finish({ kind: 'auth', requestId }); return; }
      if (r.status === 404 && this.nowMs() > t.quote.validUntilMs + 2_000 + 1_500) {
        this.finish({ kind: 'rejected', requestId, reason: 'NOT_RECEIVED', message: 'That tap never reached the house — nothing was charged', quote: t.quote });
        return;
      }
      wait = Math.min(3_000, wait * 1.6);
    }
    if (this.tracked.has(requestId)) this.finish({ kind: 'unknown', requestId, message: 'Could not confirm that tap — your plays list will show it if it was placed' });
  }

  private finish(o: PlacementOutcome): void {
    if (!this.tracked.delete(o.requestId)) return;
    this.emit();
    this.onOutcome(o);
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function cellOf(q: QuoteSnapshot) { return { cellId: q.cellId, marketId: q.marketId, startMs: q.startMs, endMs: q.endMs, lowerPrice: q.lowerPrice, upperPrice: q.upperPrice, ruleVersion: q.ruleVersion }; }
