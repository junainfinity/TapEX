# SPEC-12 — Promo tiers: the $OPEN acquisition budget

Status: design addendum to `SPEC.md` §3.2 (replaces the single launch boost), written by the promo-engineer on 2026-09-27 on top of HEAD 9f28f93. Everything in SPEC.md, SPEC-10 and SPEC-11 still holds unless this file says otherwise. Decisions and deviations are also listed in `DEVIATIONS.md` under `promo-engineer`. Measured results: `artifacts/verification/promo-tiers-2026-09-27.md`.

Files: `packages/house/src/promo.ts` (pure: configuration, validation, admin changes, tier resolution, pricing parameters, per-tier ledger and budget guard), `packages/house/src/pricing.ts` (`offerX100Signed`), `packages/house/src/grid.ts` (`QuoteGridInput.promo`), `apps/house-server/src/engine/engine.ts` (tiers, grid variants, boost cap, guard, admin, views, migration), `src/quotes/quote-book.ts` (variants), `src/api/promo.ts` (`GET /v1/promo`), `src/api/admin.ts` (admin routes), `src/api/views.ts` (per-account quotes), `src/app.ts` (overview), `src/bootstrap.ts` (production default), `src/sim/*` (farmer), `src/run-sim.ts`, `src/promo-report.ts`, `src/promo-payouts.ts`.

## 1. The operator's decisions (authoritative)

| Tier | Ends when (whichever first) | Acceptable house loss on turnover | Minimum win | Per-account boost cap |
| --- | --- | --- | --- | --- |
| launch | 10,000 registered players or 1,000,000 OPEN cumulative turnover | 10 % | 1.25× | 1,000 OPEN |
| growth | 100,000 players or 10,000,000 OPEN | 5 % | 1.10× | 5,000 OPEN |
| scale | 1,000,000 players or 100,000,000 OPEN | 1 % | 1.01× (admin-adjustable) | 20,000 OPEN |
| standard | after scale | house keeps its edge (standard edge 8 %) | 1.01× | — |

- **Turnover** = cumulative accepted stake (handle) since launch, every leg (sim and on-chain), never reset, never reduced by refunds (`HouseEngine.turnover`).
- **Registered players** = the existing count: distinct accounts with a first deposit or a sign-in (SIWE sign-in registers; sim players register on arrival).
- Thresholds are cumulative since launch and must be non-decreasing in tier order.

## 2. Tier resolution

`resolveTier(config, { players, turnoverCenti })`: the first tier, in order, that is enabled and whose thresholds are not reached (`players ≥ untilPlayers` or `turnover ≥ untilTurnoverCenti` ends it); else `standard`. A disabled promo, or an invalid progress reading, fails closed to `standard` (the house's own edge). Ending a tier early disables it; extending raises its thresholds (and re-enables it). The engine re-resolves after every register, bet, config and guard event and logs each transition (`tierLog`: time, tier, players, turnover, cause), raising an info alert `PROMO_TIER_CHANGED`. The transition is derived from journaled events, so a rebuild reproduces it exactly.

## 3. Configuration (`PromoConfig`, defaults `DEFAULT_PROMO`)

```ts
{ enabled: true,
  tiers: [ { id: 'launch', label: 'Launch boost', enabled: true, untilPlayers: 10_000, untilTurnoverCenti: '100000000', lossBudget: 0.10, minWinX100: 125, perAccountBoostCapCenti: '100000' },
           { id: 'growth', label: 'Growth boost', enabled: true, untilPlayers: 100_000, untilTurnoverCenti: '1000000000', lossBudget: 0.05, minWinX100: 110, perAccountBoostCapCenti: '500000' },
           { id: 'scale',  label: 'Scale boost',  enabled: true, untilPlayers: 1_000_000, untilTurnoverCenti: '10000000000', lossBudget: 0.01, minWinX100: 101, perAccountBoostCapCenti: '2000000' } ],
  standardLabel: 'Standard odds',
  guard: { enabled: true, evalEveryMs: 300_000, minTurnoverCenti: '2000000', zGate: 2, deadband: 0.005, maxStepPerEval: 0.01, maxTighten: 0.1, tripMarginRel: 0.02, tripZ: 3, acceptanceSignal: true } }
```

Validation (`validatePromo`): tiers exactly launch, growth, scale in order; label 1–40 chars; `untilPlayers` integer 0–10⁹; `untilTurnoverCenti` Centi; `lossBudget` 0–0.25; `minWinX100` integer 101–1000; `perAccountBoostCapCenti` positive Centi; thresholds non-decreasing; guard: `evalEveryMs` 1 min–1 d, `zGate` 0–10, `deadband` 0–0.2, `maxStepPerEval` 0–0.05, `maxTighten` 0–0.25, `tripMarginRel` 0–0.5, `tripZ` 0–20, `acceptanceSignal` boolean.

Production (`bootstrap.engineConfig`) always passes `DEFAULT_PROMO`; `EngineConfig.promo` omitted selects the legacy launch boost (Stage A behaviour), kept only for the Stage A test suite and old tooling (`engineConfig(..., { promo: null })`, `run-sim --promo legacy`).

## 4. Pricing per tier

For new quotes the engine takes `tierPricing(resolveTier(...), standardEdge, guard(tier))`:

- **Boosted** (a promo tier is current and its budget breaker is not tripped): base edge = −lossBudget + guard adjustment (≥ 0). The offer is SPEC §3.2 with a signed edge (`offerX100Signed`): `q = min(1, p + z·se + impact)`, `x100 = floor(100·(1 − edge)/q + 1e-9)`; the multiplier scale is `1 + lossBudget` so every square's expected return at its calibrated fair value is at most the tier target (flooring only lowers it: ≤ 0.5/x100 relative). Squares whose multiplier would fall below the tier's minimum win are **hidden** (`below-minimum`), squares above the cap are hidden as before. `offerX100` keeps refusing negative edges (its tests are unchanged).
- **Standard** (tier `standard`, or a tier whose breaker tripped): the standard edge and the 1.01× minimum, exactly the legacy standard pricing.
- Unchanged on top, in every tier: the flow surcharge for flagged accounts, the drawdown widening (+2 pts while widened), the adaptive controller's range adjustment (signed clamp to [−0.5, 0.99]), price impact, z·se, the cap.
- **Controller target.** A boosted quote's `policyEdge` is the tier target (−lossBudget + drawdown widening, *without* the guard adjustment). The clean-flow controller therefore aims realized RTP at `1 + lossBudget`; the guard (§6) independently keeps the tier inside its budget. When their estimators disagree, the two integrators settle on the house-favourable side (the guard never goes below 0, the controller stops at its bounds).
- **Hidden squares measured.** With the current tables and the production minimum lead of 4 s, the highest calibrated probabilities are about 0.8, so the launch floor hides 0.00–0.05 % of priced squares (the brief expected ~0.2 %); see the payout tables in the results report.

### 4.1 Grid variants and quote identity

Per market and second the engine publishes up to three immutable grids (`QuoteBook` variants):

| Variant | Who is quoted from it | Pricing | quoteId suffix |
| --- | --- | --- | --- |
| `main` | every unflagged account (anonymous callers too) | boosted while a tier is current, else standard | none |
| `standard` | accounts past their boost cap; flagged accounts when no surcharge applies | standard (only published while `main` is boosted) | `.s` |
| `flagged` | flagged accounts while a flow surcharge applies | standard + surcharge | `.f` |

Every quote carries `tier`, `boosted`, `guardAdjust` and `variant`; legs copy `tier`, `boosted` and `guardAdjust`. The leg's `phase` keeps its two values for compatibility: `launch` = priced by a promo tier's boosted odds, `standard` = standard pricing. **Flagged accounts never get boosted odds** (decision, §11).

## 5. Per-account boost cap

- Each account's boosted turnover is tracked per tier (`PromoLedger.boostUsed(tier, account)`), from accepted boosted legs. Held placements (SPEC-10 hold) reserve their boosted stake (`HoldRecord.boostTier`, journaled), so two held bets cannot jointly exceed the cap.
- `boostRemaining = max(0, cap − used − reserved)`. While it is at least the minimum stake the account is quoted from `main` (boosted) and every boosted cell's `maxStakeCenti` is capped by it; below it the account is quoted from `standard`.
- **Acceptance** (quote identity, idempotency and immutability unchanged): a boosted quote is accepted only if its stake fits the remaining allowance *of the quote's tier*; otherwise `STAKE_NOT_ALLOWED` with a message naming the remaining allowance (or saying it is used up). The rejection is remembered by requestId like any other (same intent → same answer; changed intent → `REQUEST_CONFLICT`). A standard-grid quote is accepted from any unflagged account. The accepted odds are always the quoted ones: a boosted quote issued in `launch` and accepted after the tier moved to `growth` keeps its launch multiplier and its leg is a `launch` leg (counted against the launch cap and the launch budget). At the end of a hold the cap is re-checked (excluding the hold's own reservation): detail `boost-cap`.
- Caps are per tier: an account gets its launch allowance, then its growth allowance, then its scale allowance.

## 6. Budget guard (per tier)

`PromoLedger` keeps per tier: turnover (all legs quoted while the tier was current), boosted turnover, per-account boosted turnover, accepted boosted aggregates (Σ stake·m·p at issue, Σ stake·m·p_fresh at acceptance), and settled aggregates for boosted legs (total and clean — the controller's rule), standard-priced legs and all legs.

**Statistics.** The crowd bets the same squares (grinders and farmers all take the lowest-odds square), so thousands of legs share one outcome. Every aggregate therefore carries three variance estimates of its realized return: independent legs Σ s²m²p(1−p); clustered by square Σ_square (Σ s·m)² p̄(1−p̄); and an empirical block estimate Σ_block (Σ credit − s·m·p)² over market × window-start-minute blocks (path correlation and model error). The SE used for every decision and interval is the largest (measured: 1.2–1.5× the independent SE in the kept 24 h runs, 1.9× in a scratch run with 3 % farmers).

Every `evalEveryMs` of feed time the current tier is checked (live only; every decision is journaled as `promo-guard` with an audit entry by actor `promo-guard`):

1. **Breaker**: realized cumulative loss − lossBudget × settled boosted turnover > `tripMarginRel` × turnover + `tripZ` × SD → `trip`: new quotes of the tier use standard pricing, `GET /v1/promo` labels the tier "(paused)", the overview lists a `promoBudget` breaker, and a critical alert `PROMO_BUDGET_BREAKER` goes out. Only an admin resumes (§7).
2. **Tighten**: the realized loss rate exceeds the budget by more than max(`deadband`, `zGate` × SE), **or** (with `acceptanceSignal`) the expected loss rate at acceptance exceeds it by more than `deadband` → raise the tier's guard adjustment toward the higher aim (turnover-weighted average adjustment + gap, anti-windup), at most `maxStepPerEval` per evaluation, within [0, `maxTighten`].
3. **Relax**: no signal above the budget, the acceptance signal (else the realized one) below it, and the realized loss rate not above the budget even as a point estimate → lower the adjustment toward the more conservative aim, never below 0 (never looser than the tier's nominal pricing).

Each signal needs `minTurnoverCenti` of its own turnover (settled or accepted). The acceptance signal exists because the SPEC-10 hold's symmetric re-validation selects bets whose fair value at acceptance is ~2 pts above the quoted one on near squares (§11); settled outcomes need far more turnover than a one-hour launch tier provides to see that.

## 7. Admin (SPEC §7 conventions) and migration

- `GET /admin-api/promo` → `{ configured, enabled, config, standardEdge, minStakeCenti, current: { tier, label, boosted, fallback?, baseEdge, lossBudget, minWinX100, guardAdjust }, progress: { players, untilPlayers, turnoverCenti, untilTurnoverCenti }, tiers: [ { id, label, status: current|ended|skipped|upcoming|disabled, config, startedMs, endedMs, startPlayers, startTurnoverCenti, turnoverCenti, bets, boostedTurnoverCenti, boostedBets, realized: { boosted, boostedClean, standardPriced, all }, promoCostCenti, accounts: { boosted, capped, capCenti }, guard, grid } ×4 ], tierLog, guard: { config, nextEvalMs, tripped }, confirm, clockMs }`. `realized.*` = `{ bets, wins, refunds, handleCenti, returnedCenti, housePnlCenti, rtp, expectedRtp, lossRate, se, seIndependent, seClustered, seBlock, lossRateLow, lossRateHigh, budget?, budgetUsed?, budgetCenti? }` (95 % interval). `promoCostCenti` = boosted settled handle × standard edge − realized boosted house P&L.
- `PUT /admin-api/promo` `{ enabled?, standardLabel?, tiers?: { launch?|growth?|scale?: { label?, enabled?, untilPlayers?, untilTurnoverCenti?, lossBudget?, minWinX100?, perAccountBoostCapCenti? } }, guard?: {…}, reason, confirm? }` — strict keys (nested too). Edit fields, extend (raise thresholds / re-enable), disable or enable the promo. A change that moves the base edge charged on new quotes, or any tier's loss budget, by more than 2 points requires `confirm: "edge-change"`.
- `POST /admin-api/promo/end-tier` `{ reason, confirm: "promo-end-tier" }` — disables the current tier (409 `NO_PROMO_TIER` in standard).
- `POST /admin-api/promo/resume` `{ tier?, reason, confirm: "promo-resume" }` — clears a tripped budget breaker (default: the current tier; 409 `NOT_TRIPPED`).
- Every write: reason 8–500 chars, Idempotency-Key replay, audit entry with actor, before/after and reason; journaled `config` (target `promo`) or `promo-guard`.
- `PUT /admin-api/launch` answers **409 `LAUNCH_REPLACED`** in promo mode (the single launch boost no longer exists). `overview.launch` stays for the console (enabled = promo switch, active = a promo tier is current, edge = the current base edge, negative while boosted, untilPlayers = the current tier's player threshold).
- `GET /admin-api/overview` adds `promo: { enabled, tier, label, boosted, fallback?, baseEdge, minWinX100, progress: { players, untilPlayers, playersShare, turnoverCenti, untilTurnoverCenti, turnoverShare }, budget: { lossBudget, tierTurnoverCenti, settledBoostedCenti, housePnlCenti, lossRate, lossRateLow, lossRateHigh, budgetUsed }, guard }` and a `promoBudget` row in `breakers` per tripped tier.
- **Migration.** The boot config snapshot carries `promo`. A journal written before SPEC-12 (no promo) opened by a server with promo tiers is migrated once at open: a `config` event (target `promo`) and a system audit entry `promo-migrated` (actor `promo-migration`, before = the legacy launch config) are journaled; tier progress counts the journal's own registered players and turnover. Legacy legs keep their fields (no `tier`). A journal's own promo config always wins over the process configuration.

## 8. Player API

`GET /v1/promo` (contract owned by the promo engineer, consumed by the game UI):

```
{ tier: 'launch'|'growth'|'scale'|'standard', label: string, minWinX100: number,
  progress: { players: number, untilPlayers: number|null, turnoverCenti: string, untilTurnoverCenti: string|null },
  account: { boostRemainingCenti: string|null } | null }
```

`account` is filled only when the request carries a valid player session (the wallet engineer's SIWE cookie, `sessionAccountOf`); a client-named account is ignored. `boostRemainingCenti` is null when no boost applies (standard tier, a paused tier, a flagged account). While a tier's breaker is tripped: `tier` stays the current tier, `label` gets " (paused)", `minWinX100` is the standard minimum.

`GET /v1/quotes` adds, in promo mode, `tier`, `pricing: 'boosted'|'standard'`, `variant`, `minWinX100` (boosted only) and `boostRemainingCenti`; the grid is the caller's own variant and boosted cells' `maxStakeCenti` never exceed the allowance.

## 9. Journal

New: `config` target `promo`; `promo-guard { change: { tier, action: tighten|relax|trip|resume, before, after, reason, handleCenti?, housePnlCenti?, lossRate?, budget?, se?, bets?, basis?, expectedLossRate?, acceptedCenti? }, actor }` (durable). `hold` gains `boostTier`; legs gain `tier`, `boosted`, `guardAdjust`. Tier transitions, per-tier books, caps and guard state are rebuilt exactly from the journal (`test/promo.test.ts` compares the full state snapshot).

## 10. Simulation

- Strategy `farmer` (`PROMO_STRATEGIES`, weight 0 unless a mix names it; no foresight): opens accounts and bets the lowest-odds offered square at the largest stake the account may place (cell headroom, balance, per-bet cap, new-account ramp, boost allowance); moves to a fresh account once the allowance is below the minimum stake (up to 20 accounts per farmer); skips while no boost is offered.
- `run-sim --promo tiers|off|legacy`, `--promo-config <file>`, `--promo-scale <players>,<turnover>` (simulation only; the report is flagged SCALED); the report gains `promo` (per tier: span, players and turnover at start/end, turnover and boosted turnover, realized loss vs budget for boosted total/clean and all legs with 95 % intervals and verdicts, RTP by range and pricing, promo cost, accounts boosted/capped/over cap, farmer accounts, hidden grid share, lowest boosted multiplier, guard events; farmers overall; the minimum-win check) and a markdown section.
- `node dist/promo-payouts.js --from <ISO> --hours 24 --every 7 --tables published|refit --min-lead 4 --out <dir>` builds the per-tier payout table from the recorded path.

## 11. Decisions and limits

1. **Flagged accounts are quoted at standard pricing** (plus the surcharge) in every tier: the budget is for acquiring honest players, and a flagged account has latency or outcome evidence against it.
2. **Guard acceptance signal** (beyond the brief's realized-only rule), **clustered statistics** and the **conservative relax** rule: see §6. Without them a one-hour launch tier overshot its budget by ~6 pts in scratch runs, and the independent-legs SE declared significance at 7 SE on what was path correlation.
3. **The hold's selection** (SPEC-10 §9.5) lifts the expected return at acceptance ~2 pts above the quoted model on near squares for honest players and ~5–10 pts for adversaries; the trust ramp's tight tolerance (a new account's first 10 holds) is the strongest selector, and the farmer lives in it permanently (fresh accounts). The guard corrects the aggregate; per-strategy differences remain.
4. **Regime risk.** Realized outcomes on the crowded low-odds squares swing ±10–20 pts from the model over 15-minute blocks (both markets together). Short tiers can land outside their budget on a bad regime even with correct pricing; the breaker bounds the damage and the report gives honest intervals.
5. **Sybil farming** is bounded per account (boosted turnover never exceeds the cap), not in total: N accounts farm N caps. Production has deposit and SIWE friction; the simulation opens accounts for free.
6. The SPEC-10 controller's own standard error still assumes independent legs (outside this change); it can move on correlated noise.
7. The console (`apps/admin`) does not show the promo view yet and its Launch control now gets 409 `LAUNCH_REPLACED`; `overview.launch` stays decodable.

## 12. Measured (24 h runs, 12,000 players + 1 % farmers, all defenses on; details in the results report)

| Run | launch (budget 10 %) | growth (5 %) | scale (1 %) | standard | House P&L 24 h | Reconciliation |
| --- | --- | --- | --- | --- | --- | --- |
| P1 09-23, real thresholds | 12.69 % [7.72, 17.67], 1.47 h | 5.56 % [3.27, 7.86], 5.91 h | −0.90 % [−2.79, 1.00], 16.6 h | not reached | +730,420 OPEN | exact |
| P2 09-24, real thresholds | 9.33 % [4.55, 14.11], 1.76 h | 2.07 % [−0.30, 4.44], 5.59 h | −1.87 % [−3.87, 0.14], 16.7 h | not reached | +929,508 OPEN | exact |
| 09-23, SCALED (players × 0.01, turnover × 0.1) | 14.71 % [−20, 50], 6 min | 9.96 % [3.33, 16.58], 0.98 h | 1.32 % [−1.21, 3.86], 6.3 h | house +11.06 %, 16.7 h | +1,617,750 OPEN | exact |

Realized boosted loss rate [95 % CI]. Every interval contains or lies below its budget; 4 of 9 point estimates are within budget, 5 above (the 09-23 early-morning stretch in P1 and the scaled run). Minimum-win floors: 0 violations in 4.36 M settled boosted legs. Caps: no account ever exceeded its tier cap; farmers still made 108–164 k OPEN per day because their realized RTP beat the model by 2–7.5 pts (§11.3).
