/**
 * Double-entry ledger in exact Centi (bigint). Every transaction's postings sum to zero, so the sum
 * of all balances is always zero. Player, escrow and voucher accounts may never go negative;
 * house equity accounts may (reported as an invariant breach, never used to refuse a payout);
 * `external:*` accounts are contra accounts for money outside the ledger (the vault, sim credit).
 */
export const ACCOUNTS = Object.freeze({
  equity: 'house:equity',
  simPnl: 'house:sim-pnl',
  escrow: 'house:escrow',
  escrowSim: 'house:escrow-sim',
  vouchers: 'house:vouchers',
  vault: 'external:vault',
  simCredit: 'external:sim-credit',
});

export type AccountClass = 'player' | 'sim' | 'house' | 'external';
const ACCOUNT_RE = /^(player:0x[0-9a-f]{40}|sim:[A-Za-z0-9._-]{1,64}|house:(equity|sim-pnl|escrow|escrow-sim|vouchers)|external:(vault|sim-credit))$/;

export function accountClass(account: string): AccountClass {
  return account.startsWith('player:') ? 'player' : account.startsWith('sim:') ? 'sim' : account.startsWith('house:') ? 'house' : 'external';
}
function mayGoNegative(account: string): boolean {
  return account === ACCOUNTS.equity || account === ACCOUNTS.simPnl || account.startsWith('external:');
}

export type TxKind = 'deposit' | 'sim-credit' | 'stake' | 'win' | 'loss' | 'refund' | 'voucher' | 'voucher-cancel' | 'voucher-claim' | 'voucher-expire' | 'withdrawal-anomaly' | 'fund-house' | 'withdraw-surplus' | 'house-sync';
export interface Posting { readonly account: string; readonly delta: bigint }
export interface LedgerTx { readonly kind: TxKind; readonly ref: string; readonly atMs: number; readonly postings: readonly Posting[] }
export type PostResult = { readonly ok: true; readonly txNo: number } | { readonly ok: false; readonly reason: 'UNBALANCED' | 'INVALID_ACCOUNT' | 'INVALID_AMOUNT' | 'NEGATIVE_BALANCE'; readonly account?: string };

export class Ledger {
  private readonly balances = new Map<string, bigint>();
  private readonly classTotals: Record<AccountClass, bigint> = { player: 0n, sim: 0n, house: 0n, external: 0n };
  private txCount = 0;
  private readonly recent: LedgerTx[] = [];
  constructor(private readonly recentCapacity = 2000) {}

  balance(account: string): bigint { return this.balances.get(account) ?? 0n; }
  total(cls: AccountClass): bigint { return this.classTotals[cls]; }
  get transactions(): number { return this.txCount; }
  recentTransactions(): readonly LedgerTx[] { return this.recent; }

  /** Validate then apply atomically: either every posting lands or none does. */
  post(tx: LedgerTx): PostResult {
    let sum = 0n;
    const next = new Map<string, bigint>();
    for (const p of tx.postings) {
      if (typeof p.account !== 'string' || !ACCOUNT_RE.test(p.account)) return { ok: false, reason: 'INVALID_ACCOUNT', account: String(p.account) };
      if (typeof p.delta !== 'bigint') return { ok: false, reason: 'INVALID_AMOUNT', account: p.account };
      sum += p.delta;
      next.set(p.account, (next.get(p.account) ?? this.balance(p.account)) + p.delta);
    }
    if (sum !== 0n || tx.postings.length < 2) return { ok: false, reason: 'UNBALANCED' };
    for (const [account, value] of next) if (value < 0n && !mayGoNegative(account)) return { ok: false, reason: 'NEGATIVE_BALANCE', account };
    for (const p of tx.postings) this.classTotals[accountClass(p.account)] += p.delta;
    for (const [account, value] of next) { if (value === 0n) this.balances.delete(account); else this.balances.set(account, value); }
    this.txCount++;
    this.recent.push(Object.freeze({ ...tx, postings: Object.freeze(tx.postings.map(p => Object.freeze({ ...p }))) }));
    if (this.recent.length > this.recentCapacity) this.recent.splice(0, this.recent.length - this.recentCapacity);
    return { ok: true, txNo: this.txCount };
  }

  /** Sum of every balance; zero by construction. */
  sum(): bigint { let s = 0n; for (const v of this.balances.values()) s += v; return s; }

  /** Accounts that violate the non-negativity rule (should always be empty). */
  negativeAccounts(): string[] { return [...this.balances].filter(([a, v]) => v < 0n && !mayGoNegative(a)).map(([a]) => a); }

  entries(): IterableIterator<[string, bigint]> { return this.balances.entries(); }

  /** Sorted snapshot of all non-zero balances. */
  snapshot(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries([...this.balances].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v.toString()])));
  }
}
