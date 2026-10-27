---
type: runtime-node-evidence
created: 2026-09-20
status: implemented-three-focused-qa-passes-integration-gates-separate
node: N2
tags: [Maya, runtime, Lynx, prices, odds, QA]
---

# Maya runtime — N2 prices and odds

**Both Lynx markets now supply exact source observations to the playable paper demo. Runtime odds use a new local, deterministic five-observation probability model because the published touch table failed the requested sampled-event compatibility test.** These are simulated indicative quotes, not Lynx/Wintermute executable market-maker quotes.

This note records implementation and evidence after the user's request to build and host Maya in Docker Desktop. [Maya Development - N2 Prices and Odds](Maya%20Development%20-%20N2%20Prices%20and%20Odds.md) and the frozen [Maya - Development Graph](Maya%20-%20Development%20Graph.md) planning evidence remain unchanged historical plans. Root coordinates actual renderer, ledger, consultation and Docker verification; this note owns market data, local probability, quote registry and same-provider relay.

## Implemented source and model decisions

| Item | Implemented behavior / evidence |
|---|---|
| Markets | BTC/USD, pair 1; ETH/USD, pair 2; exact feed IDs pinned in `@maya/config`; `bsc` identifies the Lynx read route, not a selected customer deployment chain |
| Pricing input | Actual public Lynx price buffers only; no alternate vendor, generated prices, authenticated SDK method, order, wallet or on-chain call |
| Authority / precision | Bounded JSON parser preserves numeric lexemes before JavaScript Number conversion. Settlement uses exact coefficient/exponent decimals and source timestamps. Chain/pair/feed/count/positive-value validation; duplicate JSON keys rejected |
| Source cadence | Capture observed integer one-second slots; window `start,start+5s)` evaluates exactly start, +1, +2, +3 and +4 seconds; price bounds inclusive |
| Stable frontier | Only observations at least three source seconds behind a buffer's newest timestamp become authoritative. Provisional variants and bounded raw responses remain available diagnostically. Finalized conflicting values quarantine their sample ID instead of overwriting |
| Geometry | Five-second epoch grid; BTC $10 bands; ETH $0.50 bands. This is Maya's locked board geometry; it is not a claim that the live provider accepts the same ETH step |
| Probability | `maya-gaussian-discrete-five-v1`: zero-drift Gaussian log-return model, observed EWMA lambda .94, no artificial volatility floor, exact five discrete observations. Deterministic Gauss-Legendre first-hit integration; no RNG in playable pricing or settlement |
| Published table | Version 2 table retained as a conservative domain reference and forensic comparison. Coordinates must stay inside its axes; no silent clamping. Its values do **not** determine runtime probability |
| Economics | Public config formula version 3.0.0, house edge .10 and minimum gross 1.01 at capture. Gross multiplier is decimal-rational `floor((1-edge)/p*100)` represented by integer-string `grossX100`. No hidden displayed precision. Engine settles exact shown multiplier with its pinned integer-cent payout rule |
| Quote validity | Immutable source/config/model/policy provenance, fixed exact cell identity, source timestamp and accepted visible multiplier. Expiry is the earliest of reception +1.8s, cell start minus public minimum lead, and source +7s. Unready clocks, stale/conflicting history, invalid model domain, zero volatility and expired quotes fail closed |

Primary public resources actually read:

- [Lynx configuration.
- BTC/USD public buffer and ETH/USD public buffer.
- Published Lynx touch probability table.
- Reviewed SDK package `lynx-gameroom-client` 0.0.1-alpha.1 (not redistributed here), MIT license, Copyright (c) 2026 Lynx Protocol; inspected ESM SHA-256 `5d4059391dfdf3115e7aa4bf69ac8c04dddfb4cfb326603993595cf00c03e264`. Copied license and attribution are in `packages/pricing/LICENSE-LYNX` and `NOTICE.md`. A source-code license does not establish a white-label license or service SLA.

## Measured feed behavior and chosen operational policy

The read-only capture ran **2026-09-20 13:35:09.581 to 13:45:09.764 UTC**: 600.183 seconds, 515 successful buffers per pair plus config/table, 71 transport failures per pair. These were timeout/fetch failures; they must not be described as observed HTTP 429 responses. The preserved records include unsuccessful attempts.

| Measured item | BTC/USD | ETH/USD |
|---|---:|---:|
| Unique source timestamps | 657 | 657 |
| Buffer source gap min/max | 1s / 1s | 1s / 1s |
| Latest-source receipt lag p50 / p95 | 323ms / 703ms | 320ms / 703ms |
| Request RTT p50 / p95 | 257.5ms / 266.2ms | 259.6ms / 293.1ms |
| Observed value revisions | 440 | 356 |
| Revision ages behind buffer latest | age 0: 3; age 1: 437 | age 0: 3; age 1: 352; age 2: 1 |
| Finalized conflicts with 3s frontier | 0 | 0 |

The three-second frontier is an evidence-informed **Maya choice**, not a provider finality promise. A later contradiction excludes that sample and blocks a proven-loss conclusion; the engine recovers/refunds open positions under its pinned policy. Terminal outcomes are not silently rewritten. Missing or conflicting history never becomes a fabricated loss, and a segment drawn between two samples never proves a hit.

`maya-lynx-sampled-1s-stabilized-3s-v1` records these operational choices: 1s sample interval; 3s stabilization; 1s additional watermark grace; 30s recovery deadline; nominal 1s polling after each completed cycle; 7s maximum healthy source age including stabilization; 1.8s quote TTL; 120s ordinary in-memory history; at least 30 history observations to warm up. Unresolved position windows are exempt from ordinary evidence pruning. Both markets remain subscribed regardless of selected pair.

Clock time is anchored to upstream HTTP Date, transport duration and relay cache age, propagated with monotonic elapsed time. Date's one-second resolution and transport uncertainty remain explicit. Readiness expires after 6s without coherent evidence; uncertainty must stay within the configured interval bound. It never treats the latest price timestamp as current UTC. A resumed/BFCache page invalidates readiness synchronously, waits for old requests and revalidates both pairs; older request generations cannot restore readiness.

Actual Chrome153 direct-source proof found config/BTC/ETH HTTP200 but no readable Date header; the table request failed CORS. Root authorized a fixed same-provider relay. It serves only GET `/api/config`, `/api/prices/1`, `/api/prices/2`, `/api/table` and `/health`. Raw bytes survive; upstream Date/RTT/cache age are exposed. Concurrent readers share fetches; public upstream errors share retry backoff and preserve status/Retry-After. There is no arbitrary URL proxy. Browser-native fetch also required its global receiver; initial unbound invocation failed in the actual browser and was corrected with a regression test.

## Published-table failure and corrected numerical proof

**Published-table semantic check: FAIL, preserved.** The table gives positive probability for zero-width bands (center 0, r=2, u=.5 yields about .46553). A discrete Gaussian sample has zero probability of landing at one exact point. Six initial independent path comparisons had substantial event errors. Adjusting the monitored span from five seconds to four seconds repaired several cases but left the central narrow-band error about .0434; it did not repair the structural mismatch.

Root explicitly authorized a local sampled-event implementation using the same feed, variance estimator and public economics. With normalized start variance 1 and one-second increment variance `1/T`, the density of first landing inside the band at observation j is its unconditional Gaussian density minus each earlier first-hit density propagated to j. Integrating those five disjoint densities produces the probability of at least one in-band observation. This is numerical evaluation of a stated model, not market calibration or a supplier quote.

Initial broad-band/long-horizon quadrature failed its negative-density guard. Adaptive resolution was increased to `ceil(32 + 1.6 * normalizedWidth / sqrt(1/T))`, bounded at 384 production nodes. The guard was not weakened. Kernel reuse within a calculation and quote-result caching per source/cell avoid recalculating probability each frame.

The corrected model passed:

1. Eight independent 100,000-path sampled-event checks, developer-only fixed seed `0x6d617961`; all errors within predeclared `5 Monte Carlo SE + .0005`; maximum probability error .00148335. The reference compares `[start,end)` against an intentionally different inclusive-end event as well.
2. A 125-case declared domain grid, adaptive order against doubled resolution, with maximum absolute probability difference `3.22e-15` against a `1e-6` criterion.
3. Exact zero-width, symmetry, widening-band, no-volatility-floor, explicit-domain, exact-gross-rounding and immutable-quote tests.

The independent path experiment validates model-event implementation within its reported statistical bound. The doubled-order check validates numerical convergence on its declared grid. Neither establishes that Gaussian/EWMA predictions are calibrated to future crypto prices, and neither makes the model identical to Euphoria's proprietary odds.

## Availability and performance evidence

`analysis-sampled-production-replay.json` replays captured successes **and failures** through production parsing, source clock, frontier, health, TTL and quote model every 100ms. It uses actual captured prices, not synthetic feed fixtures. Replay transport adds zero browser/relay overhead, and its historical capture schedule is not a claim about future runtime poll timing.

| Metric | BTC/USD | ETH/USD |
|---|---:|---:|
| Evaluated / healthy instants | 5958 / 5179 | 5958 / 5179 |
| >=3 usable quotes across >=2 candidate windows / healthy instants | 92.817% | 97.084% |
| >=1 candidate quote / healthy instants | 96.389% | 98.494% |
| >=1 candidate quote / all instants, including source failure | 83.787% | 85.616% |
| Median / minimum eligible cells of canonical 42 | 35 / 0 | 32 / 0 |
| Longest zero-quote interval including outage | 79.1s | 79.1s |
| Longest healthy zero-quote interval | 14.1s | 3.0s |

**The original assistant-selected 95% model-candidate target remains BTC FAIL.** Root explicitly revised that local-demo operational target to **90%**, informed by the observed coverage. The corrected model passes this revised target without changing observed prices, volatility, source, geometry or stake controls. This decision is not an exact user-specified threshold or provider guarantee. Zero-quote instants remain visibly paused.

The first production replay's Node 42-cell quote batch was p95 about 3.56ms BTC / 3.70ms ETH and maximum 12.57ms / 8.86ms on this development machine; final regression rerun timings are preserved separately. These include cached frame evaluations and new-source work. They are **not mobile/browser performance results**. The separate 95% **visible viewport** coverage gate remains owned by integration; mathematical candidates do not prove cells are visible, unclipped or interactive at a given zoom.

## Public interfaces and exact handoff

`LynxMarketData({baseUrl:'/api', fetchImpl?, monotonic?})` exposes `start`, `stop`, `revalidate`, `getClock`, `getConfig`, `getTable`, `getTableId`, `getMinLeadMs`, `getSettlementPolicy`, `getHealth`, `getSamples`, `getCoverage`, `getRevision`, `getConflictingSampleIds`, `retainWindows`, `subscribe` and diagnostics. `LIVE_POLICY` and `SETTLEMENT_POLICY` are exported. `getConfig()` returns content-hash config ID, public formula/edge/minimum/minimum lead. Both market polls begin on start.

`PaperQuoteBook({table,tableId,getConfig,policyId,quoteTtlMs})` exposes `updateMarket`, `quoteCell`, `getQuote`, `candidates` and `getSigma`. It consumes N1 shared `PriceSample`, `CellTerms`, `ClockSnapshot` and `InputHealth` and returns shared immutable `QuoteSnapshot`. `grossX100` is integer-string hundredths. Source/config/table/policy/model identities remain explicit; cell identity itself is independent of model/config revision.

Engine coverage carries explicit interval, sample IDs, watermark, pinned policy ID and finalized conflict IDs. Complete means every expected slot exists without conflict and the watermark passes the interval. After refresh, engine-persisted exact complete evidence may remain valid after the adapter's ordinary rolling buffer forgets it; N3 requires matching policy/market/interval, complete slots, no known conflicts and sufficient watermark before using that evidence. N2 never reconstructs missing prices.

Source files: `trading-game/packages/market-data`, `trading-game/packages/pricing`, `trading-game/apps/feed-relay`. Root owns composition and final Docker image rebuild; SDK attribution files must accompany the distributed static artifact.

## Three actual QA rounds and evidence archive

[Detailed N2 QA rounds](../../artifacts/verification/n2/qa-rounds.md) records findings, failures, fixes and commands. Final `round-3-results.json` preserves exact command execution timestamps, exit codes and output.

1. **Pass 1:** measured source/config/table, event compatibility failure, numerical-resolution failure, corrected model and actual-browser fetch receiver failure; first corrected market-data 10/10 and pricing 8/8 tests passed.
2. **Pass 2:** adversarial authority/precision/clock, pending resume request, finalized conflict/recovery/retention, relay fixed routes/concurrency/rate recovery; market-data 12/12, pricing 8/8 and relay 4/4 passed.
3. **Pass 3:** corrected builds, all 24 focused tests, eight independent path cases, 125 convergence cases and production availability replay rerun; all seven commands exited 0. No unexecuted browser/engine/renderer assertion is labeled a node test pass.

Evidence copied into `Attachments/Maya Runtime/n2/`: original raw capture, config/table, source/browser proof, historical table analyses, structural-failure reference, corrected numerical reference, new production replay, QA record and final regression outputs. The implementation workspace retains the originals under `trading-game/artifacts/verification/n2`. No additional external search was necessary in this implementation phase beyond the recorded public source reads and previously preserved SDK inspection.

Remaining practical limits: public-source outages and quiet/out-of-domain intervals pause new quotes; Gaussian/EWMA odds remain local indicative estimates; provider access can change; source/licensing/service suitability for a commercial white-label launch still requires its separate integration and supplier agreement. Actual Docker/browser playability, viewport coverage, consultation flow, persistent ledger and whole-graph checks are root/N3 integration evidence, not silently assumed here.
