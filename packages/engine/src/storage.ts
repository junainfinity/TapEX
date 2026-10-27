import type { PlacementIntent, PositionSnapshot, PriceSample } from '@maya/contracts';

export interface Receipt { readonly intent: PlacementIntent; readonly positionId: string }
export interface LedgerEntry { readonly id: string; readonly amountCents: string; readonly kind: 'grant' | 'debit' | 'win' | 'refund' | 'loss' | 'refill'; readonly positionId?: string }
export interface LedgerState {
  schemaVersion: 1;
  revision: number;
  balanceCents: string;
  positions: Record<string, PositionSnapshot>;
  receipts: Record<string, Receipt>;
  refills: Record<string, true>;
  exposures: Record<string, string>;
  samples: Record<string, PriceSample>;
  /** Kept separate so already-open v1 tabs cannot use v2 observations for legacy outcomes. */
  observedSamples?: Record<string, PriceSample>;
  conflicts: Record<string, true>;
  entries: Record<string, LedgerEntry>;
}
export function initialLedger(startingBalanceCents: string): LedgerState {
  return { schemaVersion: 1, revision: 0, balanceCents: startingBalanceCents, positions: {}, receipts: {}, refills: {}, exposures: {}, samples: {}, conflicts: {}, entries: { 'initial-grant': { id: 'initial-grant', amountCents: startingBalanceCents, kind: 'grant' } } };
}
function assertLedger(value: unknown): asserts value is LedgerState {
  const candidate = value as Partial<LedgerState> | undefined;
  if (!candidate || candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.revision) || typeof candidate.balanceCents !== 'string' || !/^\d+$/.test(candidate.balanceCents) || !candidate.positions || !candidate.receipts || !candidate.refills || !candidate.exposures || !candidate.samples || !candidate.conflicts || !candidate.entries) throw new Error('Unsupported or damaged paper ledger; existing data was preserved.');
}

/** One aggregate record is the transaction boundary: all tabs mutate the same scope. */
export class LedgerStorage {
  private database?: IDBDatabase;
  constructor(private readonly factory: IDBFactory | undefined, private readonly name: string, private readonly startingBalanceCents: string, private readonly ledgerKey = 'ledger') {}
  async open(): Promise<void> {
    if (this.database) return;
    if (!this.factory) throw new Error('Persistent browser storage is unavailable.');
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory!.open(this.name, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('paper')) request.result.createObjectStore('paper'); };
      request.onsuccess = () => { const database = request.result; database.onversionchange = () => database.close(); resolve(database); };
      request.onerror = () => reject(request.error ?? new Error('Unable to open paper storage.'));
      request.onblocked = () => reject(new Error('Another page is preventing paper storage from opening.'));
    });
  }
  async mutate<T>(change: (state: LedgerState) => { value: T; changed: boolean }): Promise<{ state: LedgerState; value: T }> {
    if (!this.database) throw new Error('Paper storage is not ready.');
    return new Promise((resolve, reject) => {
      const transaction = this.database!.transaction('paper', 'readwrite');
      const store = transaction.objectStore('paper');
      const request = store.get(this.ledgerKey);
      let result: { state: LedgerState; value: T } | undefined;
      let caught: unknown;
      request.onsuccess = () => {
        try {
          const absent = request.result === undefined;
          const state: unknown = absent ? initialLedger(this.startingBalanceCents) : request.result;
          assertLedger(state);
          const outcome = change(state);
          if (absent || outcome.changed) { state.revision += 1; store.put(state, this.ledgerKey); }
          result = { state, value: outcome.value };
        } catch (error) { caught = error; transaction.abort(); }
      };
      transaction.oncomplete = () => result ? resolve(result) : reject(new Error('Paper transaction completed without a result.'));
      transaction.onabort = () => reject(caught ?? transaction.error ?? new Error('Paper storage transaction was aborted.'));
      transaction.onerror = () => { /* onabort owns the one rejection */ };
    });
  }
  close(): void { this.database?.close(); this.database = undefined; }
}
