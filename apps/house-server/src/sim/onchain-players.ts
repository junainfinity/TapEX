import type { MarketId } from '@maya/contracts';
import { CENTI_WEI, fromWei, toWei } from '@maya/house';
import type { ChainPort } from '../chain-port.js';
import type { HouseEngine } from '../engine/engine.js';
import type { HouseRejection } from '../engine/types.js';
import { errorMessage } from '../util.js';
import { Prng } from './prng.js';
import { chooseCell } from './strategies.js';

export interface ChainReceipt {
  readonly kind: 'deposit' | 'withdraw' | 'attest' | 'fund' | 'withdraw-surplus';
  readonly role?: string;
  readonly account?: string;
  readonly amountCenti?: string;
  readonly amountWei?: string;
  readonly txHash: string;
  readonly blockNumber?: string;
  readonly explorerUrl?: string | null;
  readonly atMs: number;
}

export interface OnchainOptions {
  readonly markets: readonly MarketId[];
  readonly seed: number | string;
  /** tOPEN each player deposits at setup (wei). */
  readonly depositWei: bigint;
  readonly betsPerMin?: number;
  /** Stake range in OPEN. */
  readonly stake?: readonly [number, number];
  /** Chain time for voucher expiry (Unix seconds). */
  readonly chainNowS: () => bigint;
  readonly log?: (line: string) => void;
}

/**
 * Drives the 11 on-chain testnet players (player-1..11): real vault deposits, bets through the same
 * engine as everyone else, and voucher withdrawals claimed on-chain. Private keys stay inside the
 * ChainPort implementation; this class only ever sees roles and addresses.
 */
export class OnchainPlayers {
  readonly receipts: ChainReceipt[] = [];
  readonly errors: string[] = [];
  readonly stats = { attempts: 0, accepted: 0, held: 0, rejections: {} as Partial<Record<HouseRejection, number>> };
  private readonly held = new Set<string>();
  private readonly prng: Prng;
  private readonly next = new Map<string, number>();
  private readonly bets = new Map<string, number>();
  private readonly roster: readonly { role: string; address: string }[];

  constructor(private readonly engine: HouseEngine, private readonly chain: ChainPort, private readonly options: OnchainOptions) {
    this.prng = new Prng(options.seed);
    this.roster = chain.players().map(p => ({ role: p.role, address: p.address.toLowerCase() }));
  }

  get players(): readonly { role: string; address: string }[] { return this.roster; }

  /** Deposit for every player and wait until the ledger has credited each deposit. */
  async depositAll(timeoutMs = 120_000, pump: () => Promise<void> = () => new Promise(r => setTimeout(r, 250))): Promise<void> {
    const before = new Map(this.roster.map(p => [p.address, this.engine.player(p.address)?.deposits.length ?? 0]));
    for (const p of this.roster) {
      try {
        const tx = await this.chain.playerDeposit(p.role, this.options.depositWei);
        this.receipts.push({ kind: 'deposit', role: p.role, account: p.address, amountWei: this.options.depositWei.toString(), amountCenti: fromWei(this.options.depositWei).centi, txHash: tx.txHash, explorerUrl: this.chain.explorerUrl('tx', tx.txHash), atMs: this.engine.nowMs });
      } catch (error) { this.errors.push(`deposit ${p.role}: ${errorMessage(error)}`); }
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const missing = this.roster.filter(p => (this.engine.player(p.address)?.deposits.length ?? 0) <= before.get(p.address)! && this.receipts.some(r => r.kind === 'deposit' && r.role === p.role));
      if (!missing.length) break;
      if (Date.now() > deadline) { this.errors.push(`deposits not indexed within ${timeoutMs} ms: ${missing.map(m => m.role).join(', ')}`); break; }
      await pump();
    }
    for (const r of this.receipts) if (r.kind === 'deposit' && !r.blockNumber) {
      const d = [...this.engine.deposits.values()].find(x => x.txHash === r.txHash.toLowerCase());
      if (d) (r as { blockNumber?: string }).blockNumber = d.blockNumber;
    }
  }

  /** Follow held placements (SPEC-10 acceptance hold) to their final result. */
  private followHolds(): void {
    for (const id of [...this.held]) {
      const r = this.engine.receiptFor(id);
      if (r?.status === 'pending') continue;
      this.held.delete(id);
      if (r?.status === 'accepted') this.stats.accepted++;
      else { const reason = r?.status === 'rejected' ? r.reason : 'STATE_NOT_READY'; this.stats.rejections[reason] = (this.stats.rejections[reason] ?? 0) + 1; }
    }
  }

  step(nowMs: number): void {
    if (this.held.size) this.followHolds();
    const rate = this.options.betsPerMin ?? 2;
    const [lo, hi] = this.options.stake ?? [1, 20];
    for (const p of this.roster) {
      const due = this.next.get(p.role) ?? nowMs + this.prng.exp(60_000 / rate);
      if (!this.next.has(p.role)) { this.next.set(p.role, due); continue; }
      if (due > nowMs) continue;
      this.next.set(p.role, nowMs + this.prng.exp(60_000 / rate));
      const record = this.engine.player(p.address);
      if (!record) continue;
      const market = this.options.markets[this.prng.int(0, this.options.markets.length - 1)]!;
      const grid = this.engine.latestGrid(market, record.flagged && this.engine.flowEdgeActive() > 0);
      if (!grid) continue;
      const choice = chooseCell('casual', { grid, prng: this.prng, streak: 0, stands: q => this.engine.quoteStands(q) });
      if (!choice) continue;
      let stake = BigInt(Math.round(this.prng.logUniform(lo, hi) * 100)) / 10n * 10n;
      const balance = this.engine.availableBalance(p.address);
      for (const cap of [balance, BigInt(choice.quote.maxStakeCenti), this.engine.accountMaxStake(p.address, choice.quote.x100)]) if (cap < stake) stake = cap;
      stake = stake / 10n * 10n;
      if (stake < 10n) continue;
      const n = (this.bets.get(p.role) ?? 0) + 1; this.bets.set(p.role, n);
      this.stats.attempts++;
      const requestId = `onchain:${p.role}:${this.engine.bootId}:${n}`;
      const r = this.engine.placeBet({ requestId, account: p.address, quoteId: choice.quote.quoteId, revision: choice.quote.revision, cellId: choice.quote.cellId, stakeCenti: stake.toString() });
      if (r.status === 'accepted') this.stats.accepted++;
      else if (r.status === 'pending') { this.stats.held++; this.held.add(requestId); }
      else this.stats.rejections[r.reason] = (this.stats.rejections[r.reason] ?? 0) + 1;
    }
  }

  /** Withdraw `fraction` of each player's free balance: voucher → signature → on-chain claim. */
  async withdrawAll(fraction: number, label: string): Promise<void> {
    for (const p of this.roster) {
      const balance = this.engine.availableBalance(p.address);
      const amount = (balance * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      if (amount <= 0n) continue;
      const req = this.engine.requestWithdrawal(`withdraw:${p.role}:${label}:${this.engine.bootId}`, p.address, amount.toString(), this.options.chainNowS());
      if (!req.ok) { this.errors.push(`withdraw ${p.role}: ${req.code} ${req.message}`); continue; }
      const v = req.voucher;
      try {
        let signature = v.signature;
        if (!signature) {
          signature = await this.chain.signWithdrawal({ account: p.address, amountWei: toWei(v.amountCenti), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry) });
          this.engine.attachVoucherSignature(v.voucherId, signature);
          this.engine.flush();
        }
        const tx = await this.chain.playerWithdraw(p.role, { amountWei: toWei(v.amountCenti), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), signature });
        // The chain's Withdrawn event claims the voucher (at once on the offline chain, after confirmations on a live one).
        this.engine.noteVoucherSubmitted(v.voucherId, tx.txHash);
        this.engine.flush();
        this.receipts.push({ kind: 'withdraw', role: p.role, account: p.address, amountCenti: v.amountCenti, amountWei: (BigInt(v.amountCenti) * CENTI_WEI).toString(), txHash: tx.txHash, explorerUrl: this.chain.explorerUrl('tx', tx.txHash), atMs: this.engine.nowMs });
      } catch (error) {
        if (this.engine.vouchers.get(v.voucherId)?.status === 'signing') this.engine.cancelVoucher(v.voucherId, `signing failed: ${errorMessage(error)}`);
        this.errors.push(`withdraw ${p.role}: ${errorMessage(error)}`);
        this.engine.flush();
      }
    }
  }
}
