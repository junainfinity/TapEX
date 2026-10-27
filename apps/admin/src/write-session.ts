/**
 * One operator intent → at most one applied write (SPEC §1.3: a timeout is not a rejection; never retry
 * with a new id). The confirm dialog drives a `WriteSession`:
 *
 * - `submit(request)` sends a request under a fresh Idempotency-Key. After a definite rejection the
 *   operator may edit and submit again (a new intent, a new key).
 * - When the outcome is unknown (timeout, dropped connection, any 5xx, a chain error), the session locks:
 *   no new submission is accepted, only `retry()`, which resends the *identical* request with the *same*
 *   key so the server replays its stored answer instead of applying the action twice. The server keeps
 *   that memory in-process only, so the operator is still sent to the audit log first.
 *
 * `UnknownOutcomeLog` remembers unknown outcomes across dialogs, so reopening the same action warns.
 */
import { defaultRequestId, isUnknownOutcome, type AdminApi, type WriteRequest } from './api.js';
import type { ApiErrorBody, ApiResult, WriteAck } from './types.js';

export type WritePhase = 'ready' | 'pending' | 'applied' | 'rejected' | 'unknown';

const refused = (code: string, message: string): ApiResult<WriteAck> => ({ ok: false, error: { code, message, status: 0 } });

export class WriteSession {
  private phaseValue: WritePhase = 'ready';
  private lockedValue = false;
  private frozen: { readonly request: WriteRequest; readonly key: string } | null = null;
  private attemptsValue = 0;

  constructor(private readonly api: Pick<AdminApi, 'send'>, private readonly newKey: () => string = defaultRequestId) {}

  get phase(): WritePhase { return this.phaseValue; }
  /** True once any attempt had an unknown outcome: this session never sends a different request again. */
  get locked(): boolean { return this.lockedValue; }
  /** Idempotency-Key of the last request sent (null before the first). */
  get idempotencyKey(): string | null { return this.frozen?.key ?? null; }
  get attempts(): number { return this.attemptsValue; }
  get canSubmit(): boolean { return this.phaseValue !== 'pending' && this.phaseValue !== 'applied' && !this.lockedValue; }
  get canRetry(): boolean { return this.phaseValue === 'unknown' && this.frozen !== null; }

  /** Send a new request under a fresh key. Refused while pending, after an applied write and after an unknown outcome. */
  async submit(request: WriteRequest): Promise<ApiResult<WriteAck>> {
    if (this.phaseValue === 'pending') return refused('WRITE_PENDING', 'The previous request is still waiting for the server.');
    if (this.phaseValue === 'applied') return refused('ALREADY_APPLIED', 'This change was already applied. Start a new change if needed.');
    if (this.lockedValue) return refused('RESUBMIT_LOCKED', 'The previous request may already have been applied. Check the audit log, or retry the identical request with the same key.');
    this.frozen = { request, key: this.newKey() };
    return this.send();
  }

  /** Resend the request of an unknown outcome, byte for byte, with the same Idempotency-Key. */
  async retry(): Promise<ApiResult<WriteAck>> {
    if (!this.canRetry) return refused('NOTHING_TO_RETRY', 'Only a request whose outcome is unknown can be retried.');
    return this.send();
  }

  private async send(): Promise<ApiResult<WriteAck>> {
    const { request, key } = this.frozen!;
    this.phaseValue = 'pending';
    this.attemptsValue++;
    const result = await this.api.send(request, key);
    if (result.ok) this.phaseValue = 'applied';
    else if (isUnknownOutcome(result.error)) { this.phaseValue = 'unknown'; this.lockedValue = true; }
    else this.phaseValue = 'rejected';
    return result;
  }
}

export interface UnknownOutcomeNote {
  readonly path: string;
  readonly title: string;
  /** Wall-clock time of the unknown outcome. */
  readonly atMs: number;
  readonly code: string;
}

/** Unknown outcomes per endpoint path, so a reopened dialog for the same action warns before a second submission. */
export class UnknownOutcomeLog {
  private readonly notes = new Map<string, UnknownOutcomeNote>();
  constructor(private readonly windowMs = 30 * 60_000) {}

  record(path: string, title: string, error: ApiErrorBody, atMs: number): void {
    this.notes.set(path, Object.freeze({ path, title, atMs, code: error.code }));
  }

  /** The request that was later acknowledged (a retry replayed or applied it): no warning needed any more. */
  clear(path: string): void { this.notes.delete(path); }

  recent(path: string, nowMs: number): UnknownOutcomeNote | null {
    const note = this.notes.get(path);
    if (!note) return null;
    if (nowMs - note.atMs > this.windowMs) { this.notes.delete(path); return null; }
    return note;
  }
}
