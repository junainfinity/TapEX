import type { MarketId } from '@maya/contracts';
import type { HouseEngine } from '../engine/engine.js';
import type { HouseRejection, PlaceResult } from '../engine/types.js';
import { Prng } from './prng.js';
import { ALL_STRATEGIES, DEFAULT_MIX, FARMER, PROFILES, SPLITTER, chooseCell, type Strategy } from './strategies.js';

export interface CrowdOptions {
  readonly targetPlayers: number;
  /** New players per simulated minute. */
  readonly arrivalsPerMin: number;
  readonly seed: number | string;
  readonly markets: readonly MarketId[];
  readonly mix?: Partial<Record<Strategy, number>>;
  /** First sim id number (restarts continue after existing sim accounts). */
  readonly idOffset?: number;
  /** Share of players on the first market (default 0.6). */
  readonly firstMarketShare?: number;
  readonly peek?: (market: MarketId, t: number) => number | undefined;
}

export interface StrategyStats {
  players: number;
  /** Accounts used (the splitter spreads over many). */
  accounts: number;
  attempts: number;
  accepted: number;
  skipped: number;
  creditCenti: bigint;
  rebuys: number;
  retired: number;
  /** Every rejection, immediate or at the end of an acceptance hold. */
  rejections: Partial<Record<HouseRejection, number>>;
  /** Placements answered `pending` (acceptance hold) and how they ended. */
  held: number;
  heldAccepted: number;
  heldRejected: number;
  holdLatencyMs: number[];
}

interface SimPlayer {
  readonly id: string;
  readonly strategy: Strategy;
  readonly market: MarketId;
  /** Account currently betting (the splitter rotates). */
  account: string;
  readonly accounts: string[];
  accountBets: number;
  sessionEndMs: number;
  sessionsLeft: number;
  streak: number;
  pending: string[];
  bets: number;
  retired: boolean;
}

interface Due { readonly atMs: number; readonly order: number; readonly player: number; readonly kind: 'bet' | 'session' }
interface Held { readonly player: number; readonly requestedMs: number }

/** Binary min-heap on (atMs, order) so equal times resolve deterministically. */
class Heap {
  private readonly items: Due[] = [];
  get size(): number { return this.items.length; }
  peek(): Due | undefined { return this.items[0]; }
  push(d: Due): void {
    const a = this.items; a.push(d);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (less(a[p]!, a[i]!)) break; [a[p], a[i]] = [a[i]!, a[p]!]; i = p; }
  }
  pop(): Due | undefined {
    const a = this.items; if (!a.length) return undefined;
    const top = a[0]!; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && less(a[l]!, a[m]!)) m = l;
        if (r < a.length && less(a[r]!, a[m]!)) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i]!, a[m]!]; i = m;
      }
    }
    return top;
  }
}
const less = (a: Due, b: Due) => a.atMs < b.atMs || (a.atMs === b.atMs && a.order < b.order);

const OPEN = 100n;
function centiOf(open: number): bigint { return BigInt(Math.max(1, Math.round(open * 100))); }

/**
 * Synthetic crowd (SPEC §6 sim/): players arrive over the run, play sessions at a strategy's pace,
 * and bet through `HouseEngine.placeBet` exactly like real players: they see only quotes the house
 * would still accept, stake within their balance and account headroom, and follow held placements
 * to their final result. Funded by off-chain `sim-credit` only. Deterministic for a seed and feed.
 */
export class CrowdSim {
  readonly stats = new Map<Strategy, StrategyStats>();
  private readonly prng: Prng;
  private readonly players: SimPlayer[] = [];
  private readonly heap = new Heap();
  private readonly held = new Map<string, Held>();
  private order = 0;
  private nextArrivalMs: number | undefined;
  private arrivalsPerMin: number;
  running = true;
  private readonly mix: Record<Strategy, number>;
  /** The mix without zero weights (same draws as the full mix; the farmer has weight 0 unless a mix names it). */
  private readonly weights: Record<Strategy, number>;

  constructor(private readonly engine: HouseEngine, private readonly options: CrowdOptions) {
    this.prng = new Prng(options.seed);
    this.arrivalsPerMin = options.arrivalsPerMin;
    this.mix = { ...DEFAULT_MIX, ...(options.mix ?? {}) };
    this.weights = Object.fromEntries(Object.entries(this.mix).filter(([, w]) => w > 0)) as Record<Strategy, number>;
    for (const s of ALL_STRATEGIES) this.stats.set(s, { players: 0, accounts: 0, attempts: 0, accepted: 0, skipped: 0, creditCenti: 0n, rebuys: 0, retired: 0, rejections: {}, held: 0, heldAccepted: 0, heldRejected: 0, holdLatencyMs: [] });
  }

  get arrived(): number { return this.players.length; }
  get target(): number { return this.options.targetPlayers; }
  get rate(): number { return this.arrivalsPerMin; }
  get heldCount(): number { return this.held.size; }
  setArrivalsPerMin(rate: number, nowMs: number): void {
    this.arrivalsPerMin = Math.max(0, rate);
    this.nextArrivalMs = this.arrivalsPerMin > 0 ? nowMs + this.prng.exp(60_000 / this.arrivalsPerMin) : undefined;
  }
  activeCount(): number { let n = 0; for (const p of this.players) if (!p.retired) n++; return n; }

  step(nowMs: number): void {
    this.followHolds(nowMs);
    if (!this.running) return;
    if (this.nextArrivalMs === undefined && this.arrivalsPerMin > 0) this.nextArrivalMs = nowMs + this.prng.exp(60_000 / this.arrivalsPerMin);
    while (this.nextArrivalMs !== undefined && this.nextArrivalMs <= nowMs && this.players.length < this.options.targetPlayers) {
      this.arrive(nowMs);
      this.nextArrivalMs += this.prng.exp(60_000 / this.arrivalsPerMin);
    }
    for (let due = this.heap.peek(); due && due.atMs <= nowMs; due = this.heap.peek()) {
      this.heap.pop();
      const p = this.players[due.player]!;
      if (p.retired) continue;
      if (due.kind === 'session') this.startSession(due.player, nowMs);
      else this.turn(due.player, nowMs);
    }
  }

  /** Follow held placements to their final result (the client polls GET /v1/bets/by-request/:id). */
  followHolds(nowMs: number): void {
    if (!this.held.size) return;
    for (const [requestId, h] of [...this.held]) {
      const r = this.engine.receiptFor(requestId);
      if (r?.status === 'pending') continue;
      this.held.delete(requestId);
      const p = this.players[h.player]!;
      const stats = this.stats.get(p.strategy)!;
      stats.holdLatencyMs.push(nowMs - h.requestedMs);
      if (!r) { stats.heldRejected++; stats.rejections['STATE_NOT_READY'] = (stats.rejections['STATE_NOT_READY'] ?? 0) + 1; continue; }
      this.record(p, stats, r, true);
    }
  }

  private record(p: SimPlayer, stats: StrategyStats, r: PlaceResult, afterHold: boolean): void {
    if (r.status === 'accepted') {
      stats.accepted++; p.pending.push(r.leg.legId); p.accountBets++;
      if (afterHold) stats.heldAccepted++;
    } else if (r.status === 'rejected') {
      stats.rejections[r.reason] = (stats.rejections[r.reason] ?? 0) + 1;
      if (afterHold) stats.heldRejected++;
    }
  }

  private schedule(player: number, atMs: number, kind: Due['kind']): void { this.heap.push({ atMs: Math.ceil(atMs), order: this.order++, player, kind }); }

  private arrive(nowMs: number): void {
    const n = (this.options.idOffset ?? 0) + this.players.length + 1;
    const strategy = this.prng.weighted(this.weights);
    const markets = this.options.markets;
    const market = markets.length > 1 && !this.prng.chance(this.options.firstMarketShare ?? 0.6) ? markets[1 + Math.floor(this.prng.next() * (markets.length - 1))]! : markets[0]!;
    const id = `sim:${String(n).padStart(5, '0')}`;
    const reg = this.engine.register(id, 'sim', strategy);
    if (!reg.ok) return;
    const profile = PROFILES[strategy];
    const idx = this.players.length;
    this.players.push({ id, strategy, market, account: id, accounts: [id], accountBets: 0, sessionEndMs: 0, sessionsLeft: profile.maxSessions, streak: 0, pending: [], bets: 0, retired: false });
    const s = this.stats.get(strategy)!;
    s.players++; s.accounts++;
    this.grant(idx, 'arrival');
    this.startSession(idx, nowMs);
  }

  /**
   * Splitter: open a fresh account (evades per-account toxicity; each new account starts at the ramp's base limit).
   * Farmer (SPEC-12): open a fresh account once the current one has used its promo allowance.
   */
  private rotate(idx: number): boolean {
    const p = this.players[idx]!;
    const farmer = p.strategy === 'farmer';
    if (p.accounts.length >= (farmer ? FARMER.maxAccounts : SPLITTER.maxAccounts)) return false;
    const account = `${p.id}.${farmer ? 'f' : 's'}${p.accounts.length}`;
    const reg = this.engine.register(account, 'sim', p.strategy);
    if (!reg.ok) return false;
    p.accounts.push(account); p.account = account; p.accountBets = 0;
    this.stats.get(p.strategy)!.accounts++;
    this.grant(idx, 'split');
    return true;
  }

  private grant(idx: number, why: string): void {
    const p = this.players[idx]!;
    const profile = PROFILES[p.strategy];
    const credit = centiOf(this.prng.logUniform(profile.credit[0], profile.credit[1])) / OPEN * OPEN;
    if (this.engine.grantSimCredit(p.account, credit.toString(), `${p.account}:${why}:${this.order}`)) this.stats.get(p.strategy)!.creditCenti += credit;
  }

  private startSession(idx: number, nowMs: number): void {
    const p = this.players[idx]!;
    const profile = PROFILES[p.strategy];
    p.sessionsLeft--;
    p.sessionEndMs = nowMs + this.prng.exp(profile.sessionMin * 60_000);
    this.schedule(idx, nowMs + this.prng.exp(60_000 / profile.betsPerMin), 'bet');
  }

  private endSession(idx: number, nowMs: number): void {
    const p = this.players[idx]!;
    const profile = PROFILES[p.strategy];
    if (p.sessionsLeft > 0 && this.prng.chance(profile.returnProb)) this.schedule(idx, nowMs + this.prng.exp(profile.breakMin * 60_000), 'session');
    else this.retire(idx);
  }
  private retire(idx: number): void { const p = this.players[idx]!; if (!p.retired) { p.retired = true; this.stats.get(p.strategy)!.retired++; } }

  private updateStreak(p: SimPlayer): void {
    const still: string[] = [];
    for (const id of p.pending) {
      const leg = this.engine.legView(id);
      if (!leg || leg.status === 'open') { if (leg) still.push(id); continue; }
      if (leg.status === 'won') p.streak++; else if (leg.status === 'lost') p.streak = 0;
    }
    p.pending = still;
  }

  private turn(idx: number, nowMs: number): void {
    const p = this.players[idx]!;
    const profile = PROFILES[p.strategy];
    if (nowMs >= p.sessionEndMs) { this.endSession(idx, nowMs); return; }
    this.schedule(idx, nowMs + this.prng.exp(60_000 / profile.betsPerMin), 'bet');
    const stats = this.stats.get(p.strategy)!;
    this.updateStreak(p);
    if (p.strategy === 'splitter') {
      // Evasion: move on before the toxicity minimum, and as soon as the account is surcharged or blocked.
      const current = this.engine.player(p.account);
      if (p.accountBets >= SPLITTER.betsPerAccount || current?.flagged || current?.blocked) this.rotate(idx);
    }
    const minStake = BigInt(10);
    if (p.strategy === 'farmer') {
      // Farming only makes sense at boosted odds: skip while no boost is offered, move on once the allowance is used up.
      const pricing = this.engine.currentPricing();
      if (!pricing.boosted) { stats.skipped++; return; }
      const left = this.engine.boostRemaining(p.account, pricing.tier);
      if (left !== null && left < minStake && !this.rotate(idx)) { this.retire(idx); return; }
    }
    let balance = this.engine.availableBalance(p.account);
    if (balance < minStake) {
      if (p.pending.length || this.hasHeld(idx)) return; // wait for open legs and holds to settle
      if (p.strategy === 'splitter' && this.rotate(idx)) balance = this.engine.availableBalance(p.account);
      else if (this.prng.chance(profile.rebuyProb)) { this.grant(idx, `rebuy${stats.rebuys}`); stats.rebuys++; balance = this.engine.availableBalance(p.account); }
      else { this.retire(idx); return; }
    }
    // The account's own grid: flagged surcharge grid; SPEC-12 boosted odds while its allowance lasts, else standard.
    const grid = this.engine.gridFor(p.account, p.market);
    if (!grid) { stats.skipped++; return; }
    const choice = chooseCell(p.strategy, { grid, prng: this.prng, streak: p.streak, ...(this.options.peek ? { peek: this.options.peek } : {}), table: this.engine.currentTable(p.market), stands: q => this.engine.quoteStands(q) });
    if (!choice) { stats.skipped++; return; }
    // The farmer always stakes its maximum; everybody else draws a stake from the profile.
    let stake = Number.isFinite(choice.stakeFactor) ? centiOf(this.prng.logUniform(profile.stake[0], profile.stake[1]) * choice.stakeFactor) : BigInt(this.engine.limits.maxStakePerBetCenti);
    stake = stake / 10n * 10n;
    // The client shows the player's own maximum (cell headroom, balance, per-bet cap, account headroom incl. the new-account ramp,
    // and SPEC-12 the remaining promo allowance on a boosted square).
    const caps = [BigInt(choice.quote.maxStakeCenti), balance, BigInt(this.engine.limits.maxStakePerBetCenti), this.engine.accountMaxStake(p.account, choice.quote.x100)];
    const boostCap = this.engine.boostStakeCap(p.account, choice.quote);
    if (boostCap !== undefined) caps.push(boostCap);
    for (const c of caps) if (c < stake) stake = c;
    stake = stake / 10n * 10n;
    if (stake < minStake) { stats.skipped++; return; }
    stats.attempts++;
    p.bets++;
    const requestId = `${p.id}:${p.bets}`;
    const r = this.engine.placeBet({ requestId, account: p.account, quoteId: choice.quote.quoteId, revision: choice.quote.revision, cellId: choice.quote.cellId, stakeCenti: stake.toString() });
    if (r.status === 'pending') { stats.held++; this.held.set(requestId, { player: idx, requestedMs: nowMs }); }
    else this.record(p, stats, r, false);
  }

  private hasHeld(idx: number): boolean { for (const h of this.held.values()) if (h.player === idx) return true; return false; }

  /** Per-strategy player outcomes from the engine's accounts (exact Centi), summed over every account a player used. */
  outcomes(): Record<Strategy, { players: number; accounts: number; bets: number; handleCenti: string; settledStakeCenti: string; returnedCenti: string; playerPnlCenti: string; housePnlCenti: string; rtp: number | null; creditCenti: string; balanceCenti: string; attempts: number; accepted: number; skipped: number; rebuys: number; rejections: Partial<Record<HouseRejection, number>>; rejected: number; rejectionRate: number | null; held: number; heldAccepted: number; heldRejected: number; holdLatencyMs: { p50: number | null; p95: number | null; max: number | null } }> {
    const out = {} as ReturnType<CrowdSim['outcomes']>;
    for (const s of ALL_STRATEGIES) {
      let bets = 0, handle = 0n, settled = 0n, returned = 0n, balance = 0n;
      for (const p of this.players) {
        if (p.strategy !== s) continue;
        for (const account of p.accounts) {
          const r = this.engine.player(account);
          if (!r) continue;
          bets += r.bets; handle += r.handle; settled += r.settledStake; returned += r.returned; balance += this.engine.balanceOf(account);
        }
      }
      const st = this.stats.get(s)!;
      const rejected = Object.values(st.rejections).reduce((a, b) => a + (b ?? 0), 0);
      const lat = [...st.holdLatencyMs].sort((a, b) => a - b);
      const q = (f: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(f * lat.length))]! : null);
      out[s] = {
        players: st.players, accounts: st.accounts, bets, handleCenti: handle.toString(), settledStakeCenti: settled.toString(), returnedCenti: returned.toString(),
        playerPnlCenti: (returned - settled).toString(), housePnlCenti: (settled - returned).toString(), rtp: settled > 0n ? Number(returned) / Number(settled) : null,
        creditCenti: st.creditCenti.toString(), balanceCenti: balance.toString(), attempts: st.attempts, accepted: st.accepted, skipped: st.skipped, rebuys: st.rebuys, rejections: { ...st.rejections },
        rejected, rejectionRate: st.attempts > 0 ? rejected / st.attempts : null, held: st.held, heldAccepted: st.heldAccepted, heldRejected: st.heldRejected,
        holdLatencyMs: { p50: q(0.5), p95: q(0.95), max: lat.length ? lat.at(-1)! : null },
      };
    }
    return out;
  }
}
