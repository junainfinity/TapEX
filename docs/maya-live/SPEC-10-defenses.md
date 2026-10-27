# SPEC-10 — House defenses against latency arbitrage and model drift

Status: design addendum to `SPEC.md` (2026-09-26, defenses-engineer). Implemented in `packages/house/src/defenses.ts` (pure configuration, decisions and the adaptive edge controller), `packages/house/src/grid.ts` (minimum lead, range adjustments, `cellFairValue`) and `apps/house-server` (engine, admin/player API, simulator, ablation runner). Measured results: `artifacts/verification/defenses-ablation-2026-09-26.md`.

## 1. Problem

The Stage A 24 h simulation lost 2.8 M OPEN on a 5 M OPEN bankroll. Players who see the next first-seen second early ("snipers") realized 166 % RTP; everyone else lost to the house. Three facts drive it:

1. A quote stayed acceptable for up to 1.8 s and the price-move guard only acted once the server itself had the newer second, so a bet placed between the source second and its delivery was accepted at the old price.
2. **One second of information is worth far more than the edge.** Measured on the recorded BTC path with the refitted table, the calibrated probability of a fixed square moves over one second by a median 6 % and a 90th percentile of 28 % of its value (§9). The table has a step at band edges (e.g. 0.74 → 0.39 when the price crosses out of a band by 0.02 bands at τ = 5 s), so crossings are where a 1 s edge concentrates. The launch edge is 3 %, the standard edge 8 %.
3. Toxicity was flagged only after 50 settled bets at z > 4, i.e. after the damage.

## 2. Mechanisms

| # | Defense | Where | Decides |
| --- | --- | --- | --- |
| 1 | Acceptance hold | engine `placeBet` → `resolveHold` | Held until the next first-seen sample after the request (≤ `maxHoldMs`), re-validated with a symmetric fair-value tolerance, accepted at the original quote |
| 2 | Quote validity | engine `quoteSupersededAt` | A quote stands until the next first-seen sample is observed + `graceMs` (capped by `maxTtlMs`) |
| 3 | Minimum lead | `buildQuoteGrid(minLeadS)` | Cells with τ < `minLeadS` are unavailable (`too-late`); geometry unchanged |
| 4 | New-account ramp | engine `prepareLeg` | Account liability limit = min(account limit, start + per settled bet + fraction × settled handle) |
| 5 | Graduated toxicity | engine `checkGraduatedToxicity` | Surcharge (flag) first, block on stronger evidence, lift own flags; outcome **and latency** evidence |
| 6 | Adaptive edge controller | `EdgeController` | Per multiplier range, nudges the edge from clean realized vs policy RTP |
| 7 | Reference feed guard | `HermesSseReference` → `observeReference` | Live only: a sub-second Pyth move beyond `moveSigma·σ·√Δt` stops standing quotes |

### 2.1 Acceptance hold (§1 of the brief)

- A placement that passes every immediate check (account, stake, quote, lead, validity, market gate, available balance, per-square cap, liability limits incl. the ramp) is journaled as `hold` and answered `pending` (HTTP 202). The stake is reserved (`availableBalance`), not posted.
- On the first sample of that market with `t > requestT` (the latest second when the request arrived), the engine re-checks the account (blocked, flagged-grid variant), the lead (≥ 1 s left), the market gate, recomputes the square's calibrated probability at the fresh second with the quote's own table (`cellFairValue`) and compares it with the quoted one:
  - `tolScale: 'relative'` — reject `QUOTE_CHANGED` when |p_fresh − p_quote| > max(`tolAbs`, `tolRel` × p_quote);
  - `tolScale: 'logit'` — reject when |logit p_fresh − logit p_quote| > `tolRel` (the same width for the player's and the house's probability).
  Both directions reject (a move for the player and a move for the house alike). Then funds, per-square cap, liability limits, ramp and solvency are re-checked and the leg is committed **at the original quote** (`requestedMs`, `pFresh` recorded on the leg).
- No fresh sample by `requestedMs + maxHoldMs` → `onTimeout` (`reject` = `QUOTE_EXPIRED`, fail closed; or `accept`).
- The fair-value check supersedes the spot price-move guard at the end of a hold (the guard still applies at request time).
- Tolerance per account (`holdTolRelFor`): accounts flagged **with current latency evidence** use `flaggedTolRel`; an account's first `newAccountHolds` holds may use `newAccountTolRel` (trust ramp; 0 disables); otherwise `tolRel`. Never looser than `tolRel`.
- Idempotency: the same requestId returns the same pending view during the hold and the final receipt afterwards; a changed intent is `REQUEST_CONFLICT`. Rejections at resolution are journaled (`hold-resolved`) and rebuilt into the receipt map. Holds still open when the server restarts are rejected at boot (`QUOTE_EXPIRED`, detail `restart`) because quotes do not survive a restart.
- Every outcome has a detail code (`ok`, `timeout-accepted`, `fair-value`, `fair-value-unavailable`, `timeout`, `limit`, `ramp`, `solvency`, `balance`, `cell-cap`, `blocked`, `paused`, `stale`, `late`, `flag-variant`, `quote-gone`, `restart`) counted in `holdStats`.

### 2.2 Latency evidence (extension of §5)

Every hold that could be re-valued adds x = clamp(p_fresh / p_quote − 1, −0.5, 1) to its account. The account's evidence is Σ(x − μ) / (σ √n), where μ and σ are an EWMA population baseline over all holds (`HoldMoveBaseline`, α = 1/2000; both derived from journaled events in order, so a rebuild reproduces them). An honest account's requests are uncorrelated with the next second's move (population mean ≈ +1–2 %, σ ≈ 0.25); a 1 s sniper's mean is ≈ +0.45. Rejected holds count as evidence too, so the signal builds from every attempt, not only settled bets. It flags after `holdMinN` holds at z > `holdZ` and blocks after `holdBlockMinN` at z > `holdBlockZ` (only once flagged). Outcome evidence (excess return against p at acceptance — p_fresh after a hold, so the hold's own selection cannot read as skill) keeps its own thresholds (`minBets`, `minWins`, `surchargeZ`, `blockZ`, `blockMinBets`). Flag = the flow surcharge (`surchargeEdge`, applied through the flagged grid); the monitor lifts only its own flags and only when both kinds of evidence are below `unflagZ`.

### 2.3 Adaptive edge controller (§6)

Per §7 multiplier range: a 5-minute-bucket rolling window (`windowMs`) of settled **clean** flow — legs not priced from the flagged grid, from accounts never flagged/blocked and with latency evidence ≤ `cleanHoldZ`. Every `evalEveryMs` it compares realized RTP with the policy RTP (Σ stake × (1 − phase edge − drawdown widening)); when |gap| > max(`deadband`, `zGate` × SE) and `minBets` are in the window, it moves the range adjustment toward (window-average adjustment + gap) — anti-windup — by at most `maxStepPerEval`, at most `maxStepPerHour` in any hour, within [`minAdjust`, `maxAdjust`], and only in the direction of the gap. Adjustments are journaled (`controller`) with an audit entry (actor `edge-controller`, kind `system`). Admin `overrides` pin a range; disabling reverts to overrides only. The cell's edge = grid edge + adjustment of the range of its unadjusted offer.

### 2.4 Reference feed (§7)

`HermesSseReference` streams `GET {MAYA_HERMES_URL}/v2/updates/price/stream?ids[]=<btc>&ids[]=<eth>&parsed=true` (feed ids from `packages/config` `MARKETS[].feedId`), decodes SSE incrementally with size bounds, never steps back in publisher time, reconnects with capped backoff and jitter, treats 15 s of silence as a stall. Enabled by default only with `MAYA_FEED=live` (`MAYA_REFERENCE_FEED=hermes|off`); refused in replay. It never prices, accepts or settles.

## 3. Configuration (defaults = production, `DEFAULT_DEFENSES`)

All values are validated (`validateDefenses`, ranges below); `DEFENSES_OFF` is Stage A (1.8 s TTL, 3 s lead, monitor-only toxicity). Changed at runtime with `PUT /admin-api/defenses` (journaled).

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `hold.enabled` | true | bool | acceptance hold |
| `hold.maxHoldMs` | 1500 | 250–5000 | longest wait for the next first-seen sample |
| `hold.tolScale` | `logit` | relative \| logit | scale of the symmetric tolerance (§2.1) |
| `hold.tolRel` | 1.3 | 0–5 | tolerance width (log-odds for `logit`, fraction of p for `relative`) |
| `hold.tolAbs` | 0.002 | 0–0.2 | absolute floor (`relative` scale only) |
| `hold.onTimeout` | reject | reject \| accept | no fresh sample within the hold |
| `hold.flaggedTolRel` | 0.05 | 0–5 | width while flagged on latency evidence |
| `hold.newAccountHolds` | 10 | 0–10000 | trust ramp length (0 = off) |
| `hold.newAccountTolRel` | 0.12 | 0–5 | width during the trust ramp |
| `hold.newAccountMaxZ` | 2 | −10–100 | latency z above which the ramp does not end |
| `quoteValidity.enabled` | true | bool | quote stands until the next sample + grace |
| `quoteValidity.graceMs` | 500 | 0–2000 | grace after a newer first-seen sample |
| `quoteValidity.maxTtlMs` | 2500 | 500–10000 | cap when no newer sample arrives |
| `minLeadS` | 4 | 3–10 | minimum lead of an offered cell (3 = Stage A) |
| `ramp.enabled` | true | bool | new-account liability ramp |
| `ramp.startCenti` | 25000 | > 0 | limit with no settled history (250 OPEN of liability) |
| `ramp.perSettledBetCenti` | 2500 | ≥ 0 | added per settled bet |
| `ramp.handleFraction` | 0.25 | 0–10 | added per Centi of settled handle |
| `toxicity.enabled` | true | bool | graduated policy (off = Stage A monitor, z > 4 after 50) |
| `toxicity.minBets` / `minWins` | 20 / 5 | ≥ 5 / ≥ 0 | minimum outcome evidence |
| `toxicity.surchargeZ` / `surchargeEdge` | 3 / 0.05 | 1–20 / 0–0.25 | flag on outcome z and the flow surcharge |
| `toxicity.blockZ` / `blockMinBets` | 6 / 60 | ≥ surchargeZ / ≥ minBets | block on outcome evidence (flagged accounts only) |
| `toxicity.holdMinN` / `holdZ` | 10 / 4 | ≥ 5 / 1–50 | flag on latency evidence |
| `toxicity.holdBlockMinN` / `holdBlockZ` | 25 / 6 | ≥ holdMinN / ≥ holdZ | block on latency evidence (flagged accounts only) |
| `toxicity.unflagZ` | 1 | ≤ surchargeZ − 0.5 | the monitor lifts its own flag below this |
| `controller.enabled` | true | bool | adaptive edge |
| `controller.windowMs` / `evalEveryMs` | 3 h / 15 min | 10 min–7 d / 1 min–1 d | rolling window, cadence |
| `controller.minBets` / `zGate` / `deadband` | 1000 / 2 / 0.005 | ≥ 1 / 0–10 / 0–0.2 | hysteresis |
| `controller.maxStepPerEval` / `maxStepPerHour` | 0.01 / 0.03 | ≤ 0.05 / ≤ 0.2 | step bounds |
| `controller.minAdjust` / `maxAdjust` | −0.02 / 0.05 | −0.1–0 / 0–0.2 | adjustment bounds |
| `controller.cleanHoldZ` | 2 | 0–100 | latency z above which an account's flow is not learned from |
| `controller.overrides` | {} | range → −0.1–0.2 | admin-pinned adjustments |
| `reference.enabled` / `moveSigma` | true / 4 | bool / 0.5–50 | reference-feed guard (acts only when a reference feed is attached) |

## 4. Journal

New events: `hold` (the held placement), `hold-resolved` (outcome, detail, reason, p_fresh, fresh second, latency, leg id), `controller` (range, before, after, realized, target, SE, bets, window-average adjustment), `config` with target `defenses`. The boot config snapshot carries `defenses` (journals written before SPEC-10 keep the configured set). Legs carry `policyEdge`, `ctlAdjust`, `requestedMs`, `pFresh`.

## 5. Player API

- `POST /v1/bets` → `200 accepted` | `202 pending { requestId, newlyHeld, hold: { quoteId, cellId, market, stakeCenti, x100, requestedMs, holdUntilMs }, retryAfterMs }` | 4xx rejected.
- `GET /v1/bets/by-request/:id` → `200` with `pending`, `accepted` or `rejected`.
- `GET /v1/account/:address` adds `availableCenti` and `pendingBets`. `GET /v1/quotes` adds `acceptance { hold, maxHoldMs, minLeadS }`; a superseded quote shows as `expired`; `maxStakeCenti` includes the ramp.

## 6. Admin API (SPEC §7 conventions)

- `GET /admin-api/defenses` → `{ config, hold { enabled, pending, created, accepted, rejected, byDetail, rejectRate1h, rejectRateAll, latencyMs { p50, p95, max, n } }, quoteValidity, minLeadS, ramp { …, accountLimitCenti }, toxicity { mode, flowEdge, flagged, flaggedByMonitor, blocked, blockedByMonitor, toxicFlowShare1h, toxicFlowShareAll }, controller { enabled, nextEvalMs, ranges[] }, reference { enabled, moveSigma, invalidations, lastObservationMs }, referenceFeed, clockMs }`.
- `PUT /admin-api/defenses` `{ hold?, quoteValidity?, minLeadS?, ramp?, toxicity?, controller?, reference?, reason, confirm? }` — partial, strict keys (nested too), overrides set to `null` are removed. Switching any defense off requires `confirm: "defenses-disable"`; a change that moves an edge charged on new quotes by > 2 points (controller override, disabling the controller, surcharge) requires `confirm: "edge-change"`. Ack `{ ok, action: 'defenses', auditId, before, after, disabled }`; journaled `config` + audit.
- `GET /admin-api/overview` adds `holdPending`, `holdRejectRate` (1 h), `holdLatencyP95Ms`, `toxicFlowShare` (1 h), `defenses { … }` and `controller { enabled, ranges: [{ key, adjust, effective, override?, realized, target, bets }] }`.

## 7. Simulation

Strategies: casual, chaser, grinder, streaker, whale (honest), `sniper1s` (the Stage A sniper, 1 s foresight, 5 %), `sniper2s` (2 s foresight, 1 %), `splitter` (1 s foresight; moves to a fresh account after 15 accepted bets or as soon as it is surcharged or blocked, up to 25 accounts; 1 %). Weights are normalised. Honest clients only see standing quotes and stake within the balance net of held stakes and the account headroom incl. the ramp. `run-sim --defenses <profile> --tune path=value --dump-legs`; `run-ablation` runs profiles × periods in child processes and writes the summary.

## 8. Measured results and tuning

Full tables and reading: `artifacts/verification/defenses-ablation-2026-09-26.md` (34 runs: 2 periods × {none, each defense alone, all, all with lead 3/5, all minus each defense, all without the trust ramp}; 12,000 players, 5 M OPEN, real `run-sim`). With all defenses:

| | Period 1 (09-23) | Period 2 (09-24) | No defenses (P1 / P2) |
| --- | --- | --- | --- |
| House P&L | +1,338,028 OPEN | +1,247,835 OPEN | −3,505,568 / −3,412,956 |
| Launch-phase GGR | +154,377 | +252,582 | −2,303,950 / −2,450,587 |
| Honest RTP vs policy | 94.23 % vs 93.53 % | 94.59 % vs 94.60 % | 94.46 % vs 93.69 % / 93.49 % vs 93.28 % |
| Honest rejections (all reasons) | 7.1 % | 7.9 % | 1.0 % / 1.4 % |
| Hold latency p95 | 1,500 ms | 1,500 ms | — |
| sniper1s RTP (accepted bets) | 105.7 % ± 8.2 (1,387) | 114.3 % ± 7.7 (1,078) | 165.8 % (83,302) / 166.4 % (77,909) |
| splitter RTP | 92.7 % ± 5.4 (3,179) | 101.6 % ± 4.4 (3,259) | 164.7 % / 166.3 % |
| sniper2s RTP | 165.7 % ± 6.4 (975) | 156.4 % ± 6.5 (855) | 175.8 % / 177.7 % |
| Adversary P&L | −24,722 OPEN | −28,685 OPEN | −4,162,528 / −4,173,928 |
| Max 1 h drawdown | 2.04 % | 1.42 % | 5.22 % / 5.42 % |

Targets: house P&L > 0 in both periods, honest rejections < 10 %, hold p95 ≤ 1.5 s, launch GGR ≥ 0 and exact reconciliation are met. Honest RTP is within ±1.5 pts of policy for casual, streaker and whale in both periods, for chaser and grinder in period 1 only (period 2: chaser +4.2, grinder −1.65 pts). The adversary RTP targets are not met (sniper1s < 97 % in neither period, splitter in period 1 only, sniper2s best effort not met); why, and why the house result is nevertheless unaffected, is §9.1.

Tuning path (scratch runs, not kept): a relative tolerance of 5 % rejected ≈ 64 % of honest bets; 20–50 % trades 25 % → 8 % honest rejections against snipers kept at 103–114 % and truncation bias (grinder +3.5 pts, chaser −4.9 pts at 40 %); outcome-only toxicity flagged snipers after ~50 bets and surcharged hundreds of honest grinders whose RTP the hold's selection had lifted (fixed by measuring outcome evidence against p_fresh); the controller learning from unflagged adversaries raised every range by 3.5–5 pts (fixed by the clean-flow rule); the log-odds tolerance at 1.3 with a 10-hold trust ramp at 0.12 and latency-evidence flags gave the best honest RTP and rejection with the adversary result at −1 % to −2 % of GGR; a 3 h / 3 pts-per-hour controller kept honest strategies closer to policy than 6 h / 1 pt per hour.

## 9. Limits

1. **One second of information is worth more than the edge, for everybody.** The symmetric check cannot separate an adversary's pick from an honest bet one bet at a time; it bounds the damage, and the per-account latency evidence separates them over ~10 holds. Adversaries therefore keep an RTP above 97 % on the few bets they get accepted before they are caught (1–5 k per day in total, statistically ≈ 100 %). A fast reference feed (Pyth Hermes, §2.4) narrows the window in production but is not exercised by the replay.
2. **Model limits.** The calibrated table has a step at band edges and no momentum term, so the fair value itself moves in jumps and informed flow keeps some edge after re-validation. A continuous, momentum-aware fair value would make the hold much tighter for the same honest cost; that is a pricing-model change outside this scope.
3. **The 2 s sniper** has information about the second after the fresh sample, which no single-sample hold can see; only detection limits it (−23 k to −28 k OPEN per day here).
4. **Detection needs data.** A splitter that opens a fresh account for every handful of bets gets each account's first holds under the trust ramp; the simulation allows 25 accounts per splitter at no cost, production has deposit and identity friction.
5. **Selection by the hold.** Any rejection after new information selects bets. The log-odds scale keeps it small; the remaining per-strategy drift is corrected by the controller per multiplier range, not per strategy, and the long-shot ranges hold too few bets to move safely (chaser over-return in period 2).
6. **Honest cost.** A new account's first 10 taps see roughly half of their bets re-quoted away (trust ramp; ≈ 57 %, estimated from `all` vs `all-no-trust`); 1.2–2.5 % of honest placements fail closed on feed gaps; 2–3 % of honest accounts are surcharged at some point, and 3 honest chasers were blocked in one period.
7. **Not modelled.** Client network latency (quote validity matters more with it), a live reference feed, adversaries that learn from rejections, and the SPEC-11 vault flows (escape hatch, house buffer), which the core server does not yet consume.
8. **Operational guidance.** Do not run the adaptive edge without the hold and graduated toxicity: without latency evidence it cannot tell toxic flow from drift and charges honest players for it (§8, `controller` alone: −3.2 to −3.5 pts).
