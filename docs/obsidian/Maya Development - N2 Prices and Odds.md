---
type: development-node
created: 2026-09-20
status: plan-reviewed-three-passes-runtime-not-run
node: N2
tags: [Maya, development, graph, Lynx, prices, odds, QA]
---

# N2 — prove the public prices and local paper odds

**Deliver a read-only Lynx adapter that supplies both Maya markets, source samples, and usable quotes for the exact five-second board. Application implementation and runtime validation are NOT RUN.** This node is a development specification with three plan-review passes, not an assertion that the provider integration already works.

Authority: [Maya - Development Graph](Maya%20-%20Development%20Graph.md), [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md), [V1 - Playable Demo Gap Review](V1%20-%20Playable%20Demo%20Gap%20Review.md), [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md). N1 owns common rules/types; N2 supplies evidence and quote availability to the paper engine and renderer. No alternate provider, authenticated SDK calls, real order API or on-chain execution belongs in this node. `bsc` in the source URL identifies the existing read API; it does not select a chain for a customer's future Maya deployment.

## Inputs, outputs and proposed implementation files

| Input | Result handed to the graph |
|---|---|
| N1 rules: BTC/USD and ETH/USD; BTC $10/ETH $0.50 bands; five-second UTC-aligned cells; inclusive price bounds and `[start,end)` time | Stable cell identity and exact bounds, independent of zoom, current viewport or selected pair |
| Public config, public per-pair buffers, public table and pinned compatible model adapter | Versioned `MarketSnapshot`, source `PriceSample` events, per-market health |
| Canonical candidate cells and additional viewport cell demand, with the source-aligned clock | Immutable `QuoteSnapshot` or reasoned unavailability for each exact cell; model coverage and viewport visibility are separate reports |
| Existing positions' market/window requirements from the paper engine | Continued subscriptions plus `CoverageReport` for settlement/recovery |
| Browser access, clock, cadence and model proof | A saved runtime report and measured operational policy, or an explicit failed gate |

Monorepo allocation supersedes the initial root-`src/` sketch: `packages/market-data/src/client/`, `normalization/`, `clock/` and `coverage/` own transport, samples, clock and recovery; `packages/pricing/src/model/`, `domain/` and `quotes/` own local odds. Import N1 types from `@maya/contracts` and settings from `@maya/config`. Pricing and market-data receive services/samples through shared ports rather than importing one another. `apps/demo` composes them. Place deterministic fixtures/tests in their owning packages, browser integration in `apps/demo/tests/e2e/`, and evidence at root `artifacts/verification/n2/`. The optional `apps/feed-relay` may import only market-data's declared server-safe entry; no relay is assumed necessary. See [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md).

## Evidence baseline and exact public reads

| Read-only resource | Known from saved evidence | Implementation gate |
|---|---|---|
| Config | Pair 1 BTC/USD, pair 2 ETH/USD with distinct feed IDs; `minDelay=3`; pricing formula `3.0.0`, edge `0.10`, minimum multiplier `1.01` | Re-fetch, validate identities and a supported schema/version; missing pricing fields cannot fall back to SDK defaults |
| BTC buffer | Listed by successful config read; this endpoint's response is not yet proven in saved checks | Verify no-credential response, schema, authority, source cadence and fresh timestamps |
| ETH buffer | Saved 71 observations with integer-second `t` and numeric USD `p`; consecutive samples about one second apart | Verify current behavior rather than treating one capture as a cadence guarantee |
| Probability table | Saved version `2`, SHA-256 `6feaea2d86d14e96f917051b2a568977fd427ded65fea0c3f87f25b396638af8` | Check axes, dimensions, finite probabilities, compatible provenance and supported domain |
| SDK package | Static inspection of `0.0.1-alpha.1`; package metadata says MIT; code has not been installed or executed | Confirm attribution/license files when implementing an adapted local primitive; do not import wallet/order modules merely to calculate odds |

The table has 61,710 values and axes: `zCenter ∈ [-4,4]`, `zHeight ∈ [0,4]`, `r ∈ [1.01,6]`, `u ∈ [0,1]`. These bounds describe the inspected table, not a permanent provider promise. Record the actual axis arrays and hashes in each model version. Config formula version and table version are separate fields; their different numbers do not themselves prove compatibility or incompatibility.

Saved config's BTC steps `[5,4,10]` include our $10 band. ETH steps `[0.1,0.15,0.3]` omit our $0.50 band. Maya quotes local paper cells; it must prove the table mathematics supports its exact geometry rather than submit those cells to a live server or silently change the UI's bands.

## Shared data and quote contracts

| Contract | Required semantics |
|---|---|
| `PriceSample` | `marketId`, provider `chain`, `pairId`, `feedId`, canonical `sourceTimeMs`, losslessly preserved `price: DecimalValue` (`{coefficient:string, exponent:number}`), receipt time and raw-response hash/provenance. Source `t` is converted from seconds to milliseconds once. Parse numeric lexemes without first rounding them to display cents. Dedupe identity is source authority plus source timestamp; conflicting numeric prices under that identity are a conflict, not last-write-wins. Equivalent decimal encodings are normalized for comparison; raw evidence remains preserved. Internal names `sourceTimestampMs`/`priceUsd` map to shared `sourceTimeMs`/`price`, not alternative wire fields. |
| `MarketSnapshot` | Ordered deduplicated samples, latest sample ID/time, config/table/local-adapter IDs, observed cadence statistics, `clockStatus`, data health and generation/revision. Model numeric conversion is distinct from exact settlement prices. Both source and receipt timestamps remain visible in developer evidence. |
| `QuoteSnapshot` | Unique `quoteId`, revision, market and exact `cellId`/bounds/window; `grossX100` positive integer encoded as a base-10 string on the shared DTO, with precision `2`; source snapshot/sample ID; model/config/table/cadence/rules IDs; quote generation time; explicit `validUntilMs`; local indicative status. Validate model-number conversion before encoding; internal exact calculations use bigint. The renderer formats exactly `grossX100 / 100`, with no hidden precision or lossy Number conversion of the DTO. No quote promises provider execution. |
| `CoverageReport` | Requested market/window, `complete | recovering | unrecoverable`, ordered evidence sample IDs, coverage-policy version, expected cadence, observed maximum gap, latest trustworthy source watermark, missing expected observations and conflicting identities. A hit can be proven before a window is complete; a miss requires a complete report. Recovery status must never be interpreted as a loss. |
| `QuoteUnavailable` | Stable reason such as `warming-up`, `stale-source`, `clock-uncertain`, `insufficient-history`, `invalid-volatility`, `out-of-domain`, `below-minimum`, `too-late`, `model-incompatible` or `unsafe-numeric-range`. The board distinguishes market-wide pause from an unavailable individual cell. |

Source precision is preserved even when a JSON number looks like `2573.9578848700003`. Do not round that value to the chart's axis precision before testing a hit. The chart can format labels independently. Fixed-point ledger cents, gross-payout rounding and persistence are owned by the paper engine; the quote adapter supplies the exact visible multiplier in hundredths.

N1 is the schema authority. Canonical `cellId` combines schema prefix, market, exact time window and exact price bounds, **never a model/config revision**; version metadata lives separately so repeated quotes cannot bypass per-cell exposure. Engine placement uses `PlacementIntent {requestId,pageLoadId,quoteId,stakeCents,cellId}` and resolves `PositionSnapshot` states `open | won | lost | refunded`. N2 observes these contracts to retain required markets/evidence; it neither counts accepted bets nor owns balances. Any internal alias must map explicitly at this shared boundary.

The latest valid displayed quote is accepted unchanged or rejected. Recalculation at tap time must not silently replace it with another multiplier. Revoking/expiring unaccepted quote revisions does not change any accepted position. Price, volatility, config or zoom updates cannot rewrite frozen terms.

## Clock, polling, freshness and recovery policy

1. Load and validate config/table; fetch buffers for both pairs concurrently once. Poll only one in-flight request per pair, share data between chart, model and settlement. Begin the runtime proof at a proposed one-second polling interval because the saved buffer is about 1 Hz; this is an experiment setting, not a provider rate entitlement or a final threshold. Respect errors and `Retry-After`; back off with jitter and show health accurately.
2. Request both markets at startup. Keep polling the selected pair and every pair with open/restored positions. Switching the visible pair never removes the other pair's settlement evidence. Pair-scoped generation tokens prevent a late response from painting the wrong market, while valid evidence can still enter that market's store.
3. Use a monotonic elapsed-time clock anchored to a measured UTC estimate. Check any available same-provider HTTP Date/relay receipt evidence and round-trip uncertainty; do not equate the latest sample's timestamp with current time, which could hide a stale feed. Browser clock jumps, suspend/resume and excessive uncertainty pause new quotes until re-anchored. A same-provider relay may expose timing if CORS prevents direct access. The exact usable clock path is a runtime gate.
4. Measure at least ten minutes of both feeds in the intended runtime path, recording receipt lag, source cadence, gaps, duplicates, request duration and HTTP behavior. Pin `pollIntervalMs`, `staleAfterMs`, `clockUncertaintyLimitMs`, `maxSampleGapMs`, `lateArrivalGraceMs`, `quoteTtlMs`, `recoveryDeadlineMs`, `historyWarmup` and quote horizon in one named policy. Report measured distributions and each selected bound. Thresholds are Maya policy derived from measurements, not alleged Lynx guarantees. Rerun this bounded probe only if measurements fail or a relevant change is made.
5. A rejected/malformed response cannot advance the watermark. Refetch the same provider's recent buffer after reconnect or reload and merge it idempotently. Continue resolving open positions while new placements are paused, including after the ten-bet modal appears. If sufficient source evidence is unrecoverable by the policy deadline, return `unrecoverable` for a refund. Do not generate replacement prices or use visual interpolation to fill gaps.

The source clock estimate, freshness and quote TTL all enter eligibility. `validUntilMs` is the minimum of the quote generation plus measured TTL and `windowStartMs - compatibleLeadTimeMs`; a market pause or explicitly invalidated quote revokes eligibility sooner. The observed lead-time input is three seconds. Accept only while the conservative clock upper bound `estimatedUtcNowMs + uncertaintyMs < validUntilMs`, with the market still healthy; N1/N3 must share this same predicate. A browser returning from sleep cannot place using a cached apparently unexpired quote before clock/data revalidation. No longer-lived quote can be created by repeatedly receiving the same stale sample.

After the cadence proof, `complete` must become an executable coverage rule, not a judgment made by the renderer. For a verified integer-second schedule with one observation per second, a five-second window requires all five expected timestamps, no unresolved identity conflict, and a finality watermark beyond the exclusive end. If runtime data is irregular, the policy must explicitly define the expected observation schedule and tolerance; do not reuse the five-sample assumption or treat five arbitrary samples as complete. The late-arrival/finality rule is a Maya operational assumption tested against captured data, not a guarantee that Lynx observations are immutable. Preserve supporting samples and hashes for each result. A complete interval with no hit is a miss; a gap or conflict cannot become a miss because time elapsed. A qualifying trustworthy hit follows N3's explicit hit-finality policy.

The sample store retains all evidence needed by open positions plus the measured recovery buffer. Close or trim only after the engine has durably recorded the result/evidence. A restored position older than the public buffer may be unrecoverable; do not pretend the rolling source has unlimited history. Config changes that alter feed identity cannot silently remap open positions to a different feed. Keep their frozen source authority, use matching recoverable evidence, and otherwise report the coverage failure for refund.

## Local model adaptation and numeric behavior

The inspected volatility estimator uses log-return variance per elapsed second, EWMA lambda `0.94`, then the square root. It returns zero for insufficient/nonmoving history. Do not invent volatility, pad history with fake ticks or add an unreviewed volatility floor to create attractive odds.

For positive spot/bounds/volatility and future time to start, the inspected preview transforms the cell. Maya's adapted model anchors `spot` and model time to the same latest validated sample: `timeToStartS = (windowStartMs - spotSample.sourceTimeMs) / 1000`. Quote acceptance uses the separately measured current clock above. Anchoring old spot to response-receipt time would understate the forecast horizon when data is delayed.

```text
scale   = sigmaPerSqrtSec * sqrt(timeToStartS)
zLower  = log(lower / spot) / scale
zUpper  = log(upper / spot) / scale
zCenter = (zLower + zUpper) / 2
zHeight = (zUpper - zLower) / 2
r       = (timeToStartS + 5) / timeToStartS
u       = sqrt(settleDtS / 5)   // 0 indicates continuous monitoring
```

Table interpolation supplies `probability`. With explicit compatible edge `0.10`, the inspected multiplier behavior is `floor((1 - edge) / probability * 100) / 100`. Reject invalid/nonfinite probabilities, values outside `(0,1]`, multiplier below compatible `minPayoutX`, or a number beyond the exact integer contract. Emit the integer numerator of the two-decimal result. Check near-integer floating-point boundaries against an independently calculated reference before deciding an implementation epsilon; silently adding epsilon changes the odds rule.

**Critical domain guard:** the SDK's table lookup silently clamps all four coordinates to its axes. Maya must validate all coordinates before interpolation and label out-of-domain cells unavailable. A finite SDK result is not proof that the requested cell was actually priced. No mathematical extrapolation, maximum-multiplier invention or endpoint clamp may stand in for model validation.

**Critical sampling guard:** `previewMultiplier` defaults `settleDtS` to `0.05` seconds; the saved public buffer is about one second. Its exported `GridyClient.pricer()` passes no cadence override and uses local wall-clock time. The low-level preview/table helpers are not listed in the inspected top-level export list. Blindly calling `pricer()` or `liveBoard()` does not meet Maya's contract.

Plan a small attributed local adapter for the inspected probability transformation/interpolation, pinned table, explicit house edge, source-aligned time and explicit measured sampling interval. Package metadata licenses the SDK code as MIT; preserve required notices after inspecting its included license during implementation. This does not establish rights to a vendor's server or white-label product. The selected one-second candidate gives `u = sqrt(1/5) ≈ 0.4472`, within the inspected table's u-axis. This is only a domain check: it is not runtime execution or proof of calibration.

Verify the table's event definition, observation schedule/phase and endpoint treatment against Maya's rule: at least one qualifying received source observation during `[start,end)`, inclusive price band. Repeated values at different source times are observations; conflicting values at one identity are not. An independent deterministic sampled-path reference must test steps, jumps and boundary observations. If the table cannot represent this event acceptably, record the failed proof and resolve the local-model rule openly before calling the node complete. Do not ship 50 ms odds as if they were proven for 1 Hz settlement. Player-facing language remains “simulated odds”; no claim of calibrated win probability or firm market-maker quotes is earned by this work.

## A usable board is a required output

N2 must support a playable board in both markets, not an all-disabled renderer marked as complete. Price only actual five-second cells at BTC $10/ETH $0.50 dimensions. Zoom changes presentation and additional cell demand, never the underlying contract or model result. Two separate gates replace the earlier ambiguous combined metric:

**ModelCandidateCoverage (N2 isolated):** at each scheduled 100ms evaluation instant during the ten-minute captured normal-feed proof, take the first six five-second UTC-aligned windows whose starts are strictly later than `clockUpperNow + compatibleLeadTime`. For each window use seven exact price buckets: the bucket containing the latest source price plus offsets −3 through +3. This produces 42 canonical candidates per market, independent of viewport/zoom. The first start uses strict-next epoch alignment, including when the threshold falls exactly on a boundary. The finite model probe horizon ends at the sixth window's end; additional viewport requests are separately domain-checked, never extrapolated. Both candidates and observations use exact shared identities; clock/quote state is evaluated at each instant, not only when a new sample arrives.

Require at least three eligible quoted cells spanning at least two distinct windows in at least 95% of source-and-clock-healthy post-warmup evaluation instants, separately for BTC and ETH. Save total/healthy/excluded instants, reason counts, source age, clock bounds and every candidate's quote/unavailability. The denominator is independent of model success: quiet valid data, invalid/zero volatility, out-of-domain or below-minimum quotes remain failures in the healthy denominator. Unhealthy periods are reported separately and cannot be hidden as model success. This is a proposed Maya gate, not a provider guarantee or statistical calibration claim.

**ViewportPlayableCoverage (N4/N6 integration):** separately require at least one fully visible, readable and selectable eligible cell in at least 95% of those healthy instants for each declared viewport/profile and zoom minimum/default/maximum, in the default live-follow view with an unexhausted allowance and adequate paper balance. A fully visible cell is entirely inside the unobscured chart interaction rectangle; a clipped/offscreen cell cannot count. The numerator must use the same valid quote IDs available for engine acceptance at that instant. N4 defines chart sizing, phase coverage, navigation and clipping; N6 records the real UI result. The lower per-view minimum is deliberate for compact screens; N2 still must demonstrate multiple model choices. Neither gate implies the other.

If either gate fails, release readiness fails: do not widen bands, change duration, invent volatility or quietly hide the failure. The downstream N2+N3 integration barrier must also produce one accepted-and-settled developer paper example per market, with deterministic hit and miss cases when the live run lacks one outcome. N2 exports fixtures/contracts first; it does not wait for a dependent renderer/engine to exist before its isolated checks run. Model-domain, cutoff/TTL, clipping and user-panned-out-of-view reasons stay distinguishable.

## Acceptance cases and evidence to hand off

All following runtime cases are **NOT RUN**. Each implementation pass records command/build ID, source hashes, fixtures or observation window, expected/actual result and fix/recheck evidence. Green plan review is not green runtime QA.

| Case | Required check | Output / downstream consumer |
|---|---|---|
| N2-01 | Anonymous direct-browser/conditional relay reads for both pairs; no wallet/auth/order calls; BTC verified explicitly | Network trace and validated authority/schema; graph integration |
| N2-02 | Lossless numbers, seconds-to-ms, ordering, identical duplicates, conflicting duplicates, wrong feed/pair and malformed/future data | Canonical sample fixtures and quarantines; paper engine |
| N2-03 | Normal cadence probe, latency and clock policy; stale/wall-clock jump/suspend handling | Measured versioned policy; renderer + engine |
| N2-04 | Schema/hash/version compatibility, sorted finite table axes, dimension product, finite bounded probabilities, exact-domain checks | Pinned model manifest and failure fixtures; quote book |
| N2-05 | Exact BTC $10/ETH $0.50 cells; 5-second windows; explicit sampling adaptation; event/phase/boundary reference | Model domain and semantics report; release gate |
| N2-06 | Two-decimal floor, edge/minimum, invalid/zero probability/volatility, safe integer range, TTL and exact visible quote acceptance | Immutable quote fixtures; engine + UI |
| N2-07 | Canonical 42-cell ModelCandidateCoverage for both pairs over all epoch phases; healthy denominator includes quiet/unsupported-model failures; no all-disabled success | Candidate/quote matrix; separate downstream N4/N6 viewport gate |
| N2-08 | Gaps/reordered arrivals/reload recovery/retention limits; hits versus complete misses; no fabricated intermediate touch | Coverage fixtures and loss/refund distinction; engine |
| N2-09 | Switch pairs with both open, suspend, ten-bet gate/modal, rejected taps, page refresh | Both subscriptions survive where required; graph sales-flow check |
| N2-10 | Source samples → displayed immutable odds → accepted paper bet → source-driven result for BTC and ETH | Small reproducible end-to-end evidence pack with N3; graph QA |

N2-01 through N2-08 define the isolated adapter/model exit. N2-09 is exercised first through subscription-demand fixtures, then with the actual page/engine during graph QA. N2-10 belongs to the downstream integration barrier and graph QA; this preserves an acyclic build dependency while retaining the end-to-end release requirement. A passing N2 unit suite cannot waive these downstream checks.

## QA pass 1 — completeness and evidence

**Completed as a plan review on 2026-09-20.** Read locked scope, implementation plan, gap review, supplier research, saved config/ETH response/table and inspected SDK sections. Compared promises to existing evidence, without calling a live provider or executing the SDK.

Findings and fixes:

1. BTC access was only inferred from config. Added explicit N2-01 proof and kept the unknown visible.
2. ETH $0.50 geometry differs from server configuration. Preserved the user-selected geometry and added exact-domain/model proof N2-05 instead of copying `liveBoard()`.
3. Table lookup clamps out-of-domain cells; finite odds alone could falsely pass. Added strict pre-interpolation guards and N2-04.
4. Preview default `settleDtS=0.05` differs from saved samples; public pricer hides that parameter. Added explicit sampled-cadence adapter and event-semantic gate.
5. Multiplier precision was previously unspecified. Recovered floor-to-two-decimals behavior and defined visible/accepted integer hundredths, N2-06.

Residual gates: all runtime checks above; actual browser access; clock/cadence policy; model/event suitability; usable quote coverage. This pass completes evidence-aware planning, not provider integration.

## QA pass 2 — adversarial cases and interfaces

**Completed as a second plan read/revision on 2026-09-20.** Re-read the written node and checked its shared interfaces with the N3 paper-engine agent. The attempted shell wildcard lookup for an N1 filename did not resolve; no N1 content is claimed to have been read in this pass. Root owns reconciliation with N1.

Findings and fixes:

1. Odds field naming differed across nodes. Adopted canonical `grossX100`; N3 confirmed final gross-payout cents are rounded half-up with bigint, separate from model floor-to-hundredths. N2 does not round prices to cents.
2. “Complete coverage” could be misread as any five samples or passage of wall time. Added an executable expected-observation schedule/finality requirement, conflict handling, and retained evidence; irregular cadence remains a measured-policy gate.
3. A slow response could anchor an old spot to a newer clock and a clock uncertainty could permit a late bet. Aligned model time with the spot sample and defined the conservative strict acceptance cutoff.
4. Pair switching, quota expiry and an old reload could orphan settlement. Specified continued required subscriptions, retention, finite public history and refund evidence; provider feed-identity changes cannot remap open positions.
5. A passing finite-odds test could leave the actual demo unplayable. Retained a numerical two-pair/two-window availability gate, including valid quiet data in its denominator, with a failed gate rather than hidden geometry/volatility changes.

Residual gates are unchanged in status: implementation, clock path, measured cadence/finality, model-event fit and usable coverage remain NOT RUN. No real trades, provider writes or runtime QA were attempted.

## QA pass 3 — recheck and traceability

**Completed as a third plan review on 2026-09-20.** Re-read the revised contracts and acceptance table, inspected node text with PowerShell, checked all five linked local attachments exist, and reconciled the root's N1 vocabulary. The table contains ten unique cases, N2-01 through N2-10. The old multiplier alias is absent; canonical `grossX100` and `DecimalValue` are present. This is document verification only.

Findings and fixes:

1. Source decimals and placement/cell names needed final schema alignment. Added N1's coefficient/exponent decimal type, `quoteId`, `cellId`, placement identifiers and four canonical position states. Kept model revision out of cell identity so quote refresh cannot reset exposure.
2. Requiring an N3 settlement example inside N2's own isolated exit could create a circular dependency. Split adapter exit from downstream N2+N3 integration evidence; graph QA still requires the full example in each pair.
3. Timing, duplicates, unavailable cells, model sampling, repeat bets and refresh each have a case ID and consumer. Runtime claims remain explicitly NOT RUN; gates with missing proof are not converted to completed tasks.

| Requirement group | Trace |
|---|---|
| Both markets, single public vendor, anonymous access | N2-01, N2-02 |
| Freshness, source clock, no fabricated data, recover/refund | N2-03, N2-08 |
| Exact geometry, valid domain, sample-event model, visible frozen odds | N2-04, N2-05, N2-06 |
| A board visitors can actually bet on at allowed zoom | N2-07, downstream N2-10 |
| Open positions survive pair switch, ten-bet gate and page refresh | N2-09, downstream N2-10 |

**Three plan-review passes complete.** Residual implementation gates: BTC/browser access, measured operational thresholds/clock, sampled-event model suitability, geometry/quote availability, and actual N2+N3 settlement evidence. None is claimed solved by the plan. First implementation action: create the no-credential two-market read/model proof harness against N1 contracts and record the bounded N2-01–N2-08 evidence.

## Sources and action record

**Coordinator assembly correction before graph QA:** applied the user's monorepo allocation without changing N2 behavior; aligned the quote DTO to N1's decimal-string `grossX100` and explicitly mapped source time/price field aliases. The three node-review records above describe the original review sequence; sequential graph QA reviews this corrected version and the new adaptive consumers. Runtime cases remain NOT RUN.

Existing vault evidence read for this node:

- [Tap Trading - External Odds and Price Suppliers](Tap%20Trading%20-%20External%20Odds%20and%20Price%20Suppliers.md) and the four governing notes linked above.
- [Saved current config](Attachments/Tap%20Trading%20Research/lynx-provider-config-2026-09-20.json), [saved ETH buffer](Attachments/Tap%20Trading%20Research/lynx-provider-eth-prices-2026-09-20.json), [saved table](Attachments/Tap%20Trading%20Research/lynx-gridy-touch-table-2026-09-20.json), [package manifest](Attachments/Tap%20Trading%20Research/lynx-package-manifest.json).
- The `lynx-gameroom-client` 0.0.1-alpha.1 SDK package (not redistributed here). Its inspected `dist/index.js` SHA-256 is `5d4059391dfdf3115e7aa4bf69ac8c04dddfb4cfb326603993595cf00c03e264`: volatility lines 2360–2377; table interpolation/domain behavior 2890–2979; preview parameters/formula 2981–3028; pricer 3426–3491. The package declaration export list excludes the low-level preview/table helpers. Line references identify the preserved package content, not an upstream moving branch.
- Local actions: PowerShell/`rg` reads of the above notes and cached package; JSON parsing to inspect table axes/count; one owned node-note creation and subsequent review edits. No new web search, live endpoint probe, dependency installation, SDK execution, application build, vendor communication or trade occurred.
