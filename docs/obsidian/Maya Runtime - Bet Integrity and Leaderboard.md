---
type: runtime-verification
created: 2026-09-20
tags: [Maya, paper-demo, integrity, animation, adaptive]
---

# Bet integrity, stacking, streaks and leaderboard

This refinement follows the user's reports of an apparent missed win, repeated clicks not adding visibly, overlapping timestamps/results, and the request for a translucent race-game leaderboard at the chart's top-left. It supersedes the settlement/presentation separation described in [Maya Runtime - Motion and Adaptive Refinement](Maya%20Runtime%20-%20Motion%20and%20Adaptive%20Refinement.md).

## Delivered behavior

Recent plays floats over chart history. Desktop/tablet use a compact 260px panel with a 78% dark background; mobile opens the panel over the upper chart. Showing results does not subtract chart height. Cream result text, gold headings and pale-blue monospace timestamps distinguish the two. The reference 1642 × 904 desktop retains a 904px scene and 90.4px squares at initial zoom.

Repeated accepted bets on one canonical square display one card with summed stake and an ×N count. Each leg keeps its own locked odds. A mixed-odds example verified by native clicks is $1 at 2.51x + $1 at 2.51x + $5 at 3.20x = $7 stake and $21.02 total return. The card does not invent an averaged multiplier.

One winning square increments the streak once, even if it has several legs. Win 1 uses a ring, win 2 a double ring, wins 3–4 a starburst, and wins 5+ a gold/lime nova. Streak badges are separate from exact payout amounts. Loss resets the streak; refunds do not count as wins. Effects deduplicate and clean up, follow their moving square, and respect reduced motion. A result's visual presentation waits for the displayed price to reach the recorded touch. A refund can still present during a feed freeze.

## Reproduced cause and corrected rule

The older v1 engine decided wins from five stabilized one-second observations, while the presentation drew connectors between incoming observations. A visible connector could cross a square without any eligible observation landing inside it. Provisional source prices could also be revised later. This was a real inconsistency, not a sufficient basis to claim that a particular user win was unpaid.

Independent replay found 9 BTC and 4 ETH completed windows with a continuous confirmed-price crossing that the five-sample rule missed. One BTC example: window start 1789911345000, price band 80430–80440; the last eligible price was about 80428.64 and the deadline observation was 80433.38581199. The last one-second connector entered the band before the deadline, although the old engine excluded the deadline observation.

New bets use `maya-observed-linear-v2`. The first observation persisted for each source second is immutable for this paper game. The chart and engine share this tape. Straight connectors join adjacent one-second observations; missing intervals are not fabricated. Exact rational segment intersections determine wins in the square's half-open time window. Both price edges count, but touching only at the end timestamp does not. A complete loss requires all six observations, including the one at the end of the final segment. Missing evidence refunds after the existing recovery deadline.

V2 observations live in a separate durable map so already-open older binaries cannot accidentally use them to settle v1 positions. Legacy bets retain their accepted rules and locked odds. Reloads and multiple tabs preserve first persisted observations. This is a defined paper-game path; it is not a claim that an early upstream value is the provider's final market price.

## Matching odds

New quotes use `maya-gaussian-linear-six-v2`, a local simulated model using public Lynx configuration/EWMA inputs. The six-observation connected-path event has probability `1 - P(all six below the lower edge) - P(all six above the upper edge)`. Deterministic Gaussian quadrature evaluates the two survival probabilities. A monotone price-space versus log-space connector has the same band-hit existence, though its touch time differs. Actual settlement uses the rendered price-space connector.

Eight independent NumPy cases with one million simulated Gaussian paths each agreed within six standard errors. Eight high-order quadrature comparisons differed by less than 4.2e-15. These verify the numerical model, not empirical market calibration or executable market-maker odds. No random draw decides a placed bet's outcome.

## User's saved records

Read-only inspection of the user's actual in-app browser on 2026-09-20 found 14 settled v1 positions: 6 wins and 8 losses. All six wins had one correct credit: 125, 213, 200, 170, 219 and 280 cents. Credits total 1207 cents; fourteen 100-cent stakes against the initial 100000-cent grant reconcile exactly to 99807 cents ($998.07). Each retained losing sample missed its accepted band. Most legacy losses do not retain the final deadline sample or the provisional path the user saw, so the particular apparent missed win cannot be reconstructed conclusively. No saved outcome or balance was rewritten.

The diagnostic view was opened in a temporary same-origin tab and closed after inspection. The normal user tab was refreshed to the new deployed build and visually inspected: top-left overlay, full available chart, continuous line and separated timestamps are present. Export was unsupported by the in-app browser; the audit summary above was derived from its visible read-only diagnostic JSON. A sandboxed DOM evaluator did not expose BigInt, so the small integer-cent journal sum was checked using safe exact JavaScript integer values.

## QA and evidence

Component loop: engine compatibility/collision/tape tests, pricing convergence/reference checks, grouping and timeline tests. Integrated UI loop: 73 browser checks across desktop grouped wins, lifecycle and mobile reduced motion, plus native repeated clicks and changed stake. Layout loop: 22 cases across three rounds, plus four mobile drawer rechecks. The earlier visual motion and adaptive reports remain historical evidence.

Live Docker loop confirmed two v2 native-click positions combined into a $2 square and settled as wins with separately locked returns of $1.54 and $1.67. One combined celebration was observed. The first 20-second combined capture had no backwards movement or playhead stalls, but p95 frame time was 33.4ms; this is a preserved failure under investigation, not a passing smoothness claim. A preceding fast native-input attempt accepted only one click; a second attempt accepted both. The team is checking rapid input and layout work before closing the delivery.

Evidence folders in the source tree: `artifacts/verification/integrity`, `group-streak`, `streak-feedback`, `adaptive`, `motion` and `motion-feedback`. Final verified results and archive status are appended below after the remaining checks.

Related: [Maya Runtime - Adaptive Layout Refinement](Maya%20Runtime%20-%20Adaptive%20Layout%20Refinement.md), [Maya - Start Here](Maya%20-%20Start%20Here.md), [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md).

## Frame pacing correction

The first layout fix reduced leaderboard rectangle reads by 99.28% (91,476 to 660 in the same ten-second fixture). Input validation still measures current panel geometry, including a same-task overlay movement test. Live p95 improved to 16.8ms, but inspecting the entire frame trace exposed sixteen 67–133ms frames in twenty seconds, recurring at the source update cadence. A good p95 alone hid these visible hitches.

The pure numerical probability calculation was moved into a dedicated browser Worker. Requests and results are batched; cache keys include every model input; stale responses cannot price a different path or configuration. Only the main-thread immutable quote registry and engine can issue/accept bets. While a background result is pending, an already-issued quote can remain usable only until its original expiry with the same policy/configuration. No quote lifetime is extended and no placeholder odds are invented. A historical backfill invalidates the relevant cache, and worker failure pauses odds. The worker is terminated when the document is disposed.

Eight bounded native rapid-input trials passed (six frozen-fixture gaps from 0 to 300ms, plus two live 160ms trials). The first intermittent live-only one-acceptance result was not reproduced, so its exact cause is unproven; pointer handlers and acceptance guards were not loosened. The initial CLI double-click probe emitted one pointer sequence with click count 2 and was excluded as an unsuitable test of two placement gestures.

A full ten-bet live journey used both pairs, all stakes, both zoom limits and exactly one consultation dialog pointing to the dummy URL. The resulting 25-position ledger (12 legacy and 13 v2) passed 337 exact checks: 7 wins, 18 losses, no open positions. This run preceded the worker-only performance change, so the final worker deployment is verified separately below.

## Final verified deployment

`pnpm check` passes all **157 unit tests**, all TypeScript checks, package-boundary checks and production build. Breakdown: 26 contracts, 15 config, 17 market-data, 25 pricing, 40 engine, 30 game UI and 4 relay. The background-adapter regression tests include pending results, original expiry with clock uncertainty, config/policy changes and historical backfills. One policy-cache regression initially failed and was fixed by including policy identity in the cache key. A sub-microdollar timeline test tolerance was corrected for browser epoch timestamp precision; settlement rational arithmetic was unchanged.

Docker is healthy at http://127.0.0.1:8080. Final assets: `index-CXMWdqWf.js`, `index-C5EcHUnM.css`, and `pricing-worker-B5eTPeMV.js`. No mutation fixture API is exposed by the production build. The 10.96kB numerical worker is loaded as a separate same-origin asset.

Two final live twenty-second captures each recorded **1,201 frames, p95 16.8ms, zero frames above 50ms, zero backwards playhead movement and zero playhead stalls**. The first also exercised native repeated bets: two accepted $1 legs became one $2 card; both correctly lost, and the loss effect appeared. Earlier live wins and deterministic multi-win streak checks verify the win branch separately. This host measurement is not a promise for every device or network condition.

The final browser ledger contains **27 settled positions: 7 wins and 20 losses**, with 12 legacy and 15 v2 positions. **365 exact journal/evidence checks passed** and the balance was 96381 cents. User-owned browser records were separate and remained $998.07. The native fixture, actual live bets, pricing reference simulation and visual-layout stress payloads are explicitly different evidence categories.

Final Docker screenshots and geometry checks cover 1642×904 desktop, 768×1024 tablet and 390×844 mobile with no horizontal overflow; desktop chart height remains 904px. Earlier 22-case overlay matrix, 73 integrated animation/grouping checks and eight rapid-input trials remain in their reports. Final desktop/tablet/mobile screenshots were visually inspected. Browser error capture was empty. The user's actual in-app tab was refreshed and confirmed to be running the final JS asset with the top-left 260px results overlay, live prices and preserved balance.

Original failed/superseded frame traces are retained as `performance-before-worker.json` and `smoke-before-worker.json`; final traces are `final-performance.json` and `live-smoke.json`. An initial post-reload smoke harness ran before a sufficiently distant offer had warmed; a bounded actionable-quote wait fixed the harness. It placed no bet in the failed warmup attempt. The final ledger audit, raw captures, screenshots, build logs, source manifest and reports are archived under `Attachments/Maya Runtime` with SHA-256 validation. No proprietary Euphoria pixel/odds identity or physical-device performance is claimed.

Final ETH/USD market selection also produced live worker-priced offers; evidence is `final-worker-eth-confirmed.json`. One CLI attribute-selector wait timed out despite the DOM already showing 69 actionable ETH offers; direct read-only DOM inspection confirmed the correct pair and worker asset. This was preserved as a harness limitation, not reported as an application outage.

Closeout: the archive contained 312 evidence files (56,535,340 bytes) at its first final pass, all matching source SHA-256 values; the final closeout copy adds the completed keep-awake status. Forty notes and 388 local links validated with no broken links. Owned test browsers and the Vite development server were closed, the temporary sleep-prevention request was released after verification, and the healthy Docker services were left running. The user's in-app Maya tab remains open on the final build.

## Selected stake per click — 20 September follow-up

Newest sizing adjustment: another 10% width reduction from the prior panel, plus 5% smaller heading/row/return fonts. Desktop/tablet base width is now 222.3px (247 × 0.9); mobile available-width factor is 0.855 (0.95 × 0.9). Retained uniform scale 0.89. Live user-tab bounds measured 197.845px wide, versus 219.825px previously. Desktop/tablet row and amount fonts are 12.35px (13 × 0.95), heading 10.45px (11 × 0.95); mobile equivalents are 11.4px and 9.5px. Line heights are retained. Docker build passed and the user tab loaded `index-MUh9j8kw.js` with `index-CFdN5uCM.css`. This supersedes the earlier panel dimensions below; no stake, history or settlement logic changed.

Final panel-size request: user asked for an 11% overall reduction, then clarified that “5% thinner” meant reducing width by a further 5%. Applied uniform 0.89 scale from the top-left anchor and reduced the base width by 5%: desktop/tablet 260px → 247px; mobile available width × 0.95. The user's actual hydrated tablet-layout tab showed exactly five recent plays. Measured panel bounds changed from 259.994×185.776px to 219.825×165.340px, matching width × 0.95 × 0.89 and height × 0.89 within subpixel rounding. Screenshot inspected: all five entries and values remain legible, top-left anchor preserved, chart geometry unchanged. Older records remain saved. Docker build passed and both services are healthy. Current assets: `index-CERoc3mo.js`, `index-Cr1BT2ag.css`, unchanged `pricing-worker-B5eTPeMV.js`. The user tab was refreshed to this build; no test bets were placed there.

Latest follow-up: “Your recent plays” is limited to the five newest entries in the common renderer used by all layouts. The previous limit was four. Saved positions remain untouched. Game UI typechecking and Docker production build passed. Current asset after this change: `index-D5l5PJxd.js`; the selected-stake evidence below records the preceding `index-DSvufFGt.js` build.

User clarified that every accepted click must add the selected stake, including double, triple and quadruple clicks. At $5 the visible square must progress $5 → $10 → $15 → $20. Subsequent stake changes affect only new legs. The $50 aggregate square cap and ten accepted bets per page still apply; rejected clicks do not increase the face amount or debit the balance.

Code inspection confirmed that pointer-down already captured the selected stake, pointer-up passed it to acceptance, and the engine persisted/debited that exact integer-cent value. Group cards already summed immutable stakes with BigInt. No monetary rewrite was needed. A reproducible presentation defect remained: immediately after selecting MAX, the selector read $10 while offer hover/accessible labels still read $1.00 until the next 160ms quote refresh.

The game UI now shares an offer-label updater between quote refresh and stake controls. Changing the stake synchronously refreshes all existing hover amounts and accessible descriptions, including text fitting. It neither remounts offer buttons nor modifies accepted cards. Stake-control bounds derive from the configured menu length. Each native click remains one pointer-up acceptance; no double-click handler was added that could count the same input twice.

Native-input verification used the real MayaGame UI with explicitly labeled deterministic price/time fixture data: desktop 1642×904 mouse, tablet 768×1024 touch emulation, and mobile 390×844 touch emulation. All five allowed stakes passed at click counts 1, 2, 3 and 4: **60 exact amount/card-count checks**. All fifteen immediate-label checks passed, and changing the selector left accepted cards unchanged. Three mixed-stake cases passed: two $0.50 legs plus two $5 legs produced $11 on one square. Desktop mouse events used native click counts 1–4. Touch cases used native touch-start/end sequences. Screenshots from all three profiles were visually inspected. These are emulated device sizes, not physical-device certification.

A separate real Docker browser profile then selected $5 and placed four native clicks on the same live BTC/USD square. The visible stake progressed $5/$10/$15/$20; accepted position stakes were each 500 cents and the balance progressed 99500/99000/98500/98000 cents. **33 ledger checks passed** with four open positions and no failures. This follow-up checks acceptance/debits; it does not claim a new settlement-outcome or performance benchmark. No test bets were placed in the user's browser profile.

`pnpm check` passed boundaries, types, all 157 unit tests and build using the existing Turbo cache where valid. Docker services are healthy; current app asset is `index-DSvufFGt.js` with unchanged CSS and worker assets. The user's in-app tab was refreshed and its script URL confirmed. Browser error capture was empty. Raw fixture/live input reports, screenshots, exact ledger audit, build and Docker logs are archived as `Attachments/Maya Runtime/integrity/stake-*`; source harnesses remain in the monorepo.

One initial fixture run was interrupted by Vite reloading shared package output during the concurrent workspace build. The harness then found a temporarily missing control. Re-running after the build completed passed every case; this was a test/build scheduling issue. The temporary Windows keep-awake helper initially exited under the default PowerShell script policy; invoking the already authorized helper with a process-local execution-policy override succeeded, without changing persistent system policy. No new market-maker research or external communications occurred.
