---
type: design-review
created: 2026-09-20
status: recommendations-not-new-scope-approval
tags: [Maya, v1, demo, UX, verification]
---

# What is still missing from the playable demo plan?

The player loop is specified: choose BTC/USD or ETH/USD, adjust zoom and stake, tap a future square, and receive a price-driven result at locked paper odds. The biggest remaining dependency is demonstrating that the selected public price inputs and local odds model support this exact game together. Application implementation has not started.

Related: [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md), [Tap Trading - External Odds and Price Suppliers](Tap%20Trading%20-%20External%20Odds%20and%20Price%20Suppliers.md).

This is a review of our saved plan and evidence, not new live provider research. Recommendations below do not silently change the user's locked source, pairs or paper-only scope.

**Subsequent user direction:** the user accepted these points in principle and clarified that the demo sells **Maya**, a turnkey white-label product with customisation, launch and source-code handover. [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) now adds a ten-bet allowance per page load and consultation modal; refresh grants ten more indefinitely. A dummy booking URL is sufficient for now. Production chain/provider/market options belong in separate literature. The earlier notes below remain a dated gap review; the newer sales-flow decision controls where it changes uninterrupted play.

## 1. Prove price, odds and settlement agree

Already selected: Lynx public inputs, local indicative odds, five-second windows, BTC $10 and ETH $0.50 bands, and sample-based settlement. Config, an ETH response and the probability table were retrieved earlier; a complete BTC/ETH feed/model demonstration has not run.

Missing proof: verify both feeds, their timestamps and usable update cadence, compatible model/config versions, and the model's ability to quote the exact proposed cells. The saved Lynx config lists BTC steps 5/4/10 and ETH steps 0.1/0.15/0.3, so our ETH $0.50 geometry is a local adaptation, not a listed live-server step. Supported five-second duration alone does not establish support for every intended price band. The plan already requires validation rather than calling Lynx's default live board and assuming parity.

Also verify that the probability model's event definition matches our sample-based win predicate. Mathematical inference: a price path entering a band between received samples is not the same event as a received sample landing in that band. A model of one event is not automatically calibrated for the other. Do not claim a proven model mismatch before inspecting/testing it, and do not claim calibrated odds merely because finite multipliers are returned.

The player must never see a smooth line appear to hit a square while the app declares a loss without explanation. Keep interpolation visually distinct from qualifying observations; show the actual sampled hit when settling. Test price jumps, boundary touches and delayed samples. If data quality or model fit fails, revise the implementation with an explicit documented decision instead of adding a hidden alternative provider or fabricating ticks.

First implementation proof: quote, place and settle a local paper position in each market using recorded public samples, with the exact accepted terms and source evidence visible to a developer. Include deterministic hit/miss fixtures for cases a short live run may not produce.

## 2. Make eligible bets and placement finality obvious

The plan already sets five-second windows, configured lead time, fixed accepted odds, shared caps and distinct repeated taps. Show expired, too-near, unsupported and otherwise unavailable squares as unclickable. Show the chosen square's time, band, stake, multiplier and potential gross return on hover/focus or selection without adding a confirmation dialog.

Remaining recommendation: no cancellation, editing or cash-out after a paper bet is accepted. The user has not explicitly chosen those features. A visible quotation horizon still needs a concrete bound, derived from the model's supported domain and the visible grid; do not offer arbitrary far-future cells just because the renderer can draw them.

## 3. Explain interruptions fairly

Already chosen: stop new bets on stale inputs, recover recent samples and refund unresolved positions when enough source evidence cannot be recovered.

Missing implementation details: stale thresholds, clock alignment, complete-window criteria and the catch-up deadline before refund. Define these from measured source behavior. Use a compact reconnecting/paused state, then display refunded outcomes separately from wins and losses. A delayed response must not cause an immediate false loss at the window boundary. Refresh or tab suspension must not settle twice or drop open bets.

## 4. Give enough feedback to understand the result

Already chosen: virtual balance/refill, accepted cards, win/miss effects and local state persistence. Pair switching must leave open positions in the other pair active and settling against that pair's own feed.

Recommendation: a compact recent-results view showing market, stake, locked multiplier, win/loss/refund and gross return. Keep active exposure distinguishable from spendable paper balance and make results from a non-visible market discoverable. These are feedback elements, not a separate exchange dashboard. Protect against gesture errors: pinch/drag must not place a bet; repeated genuine taps remain intentional new bets subject to the shared cap.

## 5. Deliver something visitors can actually open

“Anyone can play” needs a working shareable browser URL with anonymous access. Hosting has not been selected or performed. Test the public data path from the browser; use only a minimal same-provider relay/cache if required. No key should be invented or account system added to solve a display/integration issue.

Recommended acceptance: the full pair → zoom/stake → bet → result loop works on desktop and phone, with readable cells, responsive controls and no modal onboarding. Device-local paper balance is sufficient; cross-device accounts and synchronization are outside the current scope.

## Defaults versus user decisions

The $1,000 starting funds, $1,000 refill, $1 starting stake and standard-profile $10 per-bet / $50 per-square caps were proposed implementation defaults. The user explicitly chose the playable-demo flow, two USD pairs, allowed limits, paper-only play and the provider/model direction; they did not separately specify those numeric demo defaults. Preserve that distinction rather than presenting the defaults as a new user approval.

The main next implementation task remains the two-market feed/model/settlement proof. The rest can be resolved as small demo implementation decisions; no additional supplier search or production trading system is needed to review this plan.
