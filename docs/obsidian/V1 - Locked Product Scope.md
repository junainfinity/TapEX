---
type: product-decision
created: 2026-09-20
status: locked-for-v1
tags: [Maya, v1, scope, paper-trading, Lynx, Euphoria]
---

# Maya v1 — locked product scope

**User-approved v1: an Euphoria-style Three.js paper-trading game for BTC/USD and ETH/USD, using Lynx's public price inputs and locally calculated indicative odds. No registration is required for these inputs.**

**Product name: Maya**, explicitly chosen by the user. The public demo and consultation message use this name.

**Development planning:** [Maya - Development Graph](Maya%20-%20Development%20Graph.md) expands this scope into six implementation nodes with three planning QA passes per node and three sequential graph reviews. [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md) records review results separately from future runtime tests.

**Architecture and devices:** the user requires a monorepo with distinctly optimized adaptive desktop, tablet and mobile views. [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md) governs package and layout boundaries; all views share the same game engine and rules.

The user said “lets lock this and only go with these for now for v1” after the no-registration recommendation. When asked about Lynx's two USD markets versus adding a synthetic cross, the user explicitly chose **“BTC/USD and ETH/USD only (recommended)”**.

The user then clarified: **“I am only building this as a playable demo, so anyone should be able to choose trading pair, just zoom in/out to our allowed levels, raise/lower stakes to allowed levels and hit bets”**, followed by **“and either loose or win according to their odds”** and **“and the price”**. This narrows the deliverable to immediate, anonymous paper play. No account tiers or production trading workflow belong in the demo.

This note governs v1 when older provider or pair decisions conflict. See [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md) for implementation details and [Tap Trading - External Odds and Price Suppliers](Tap%20Trading%20-%20External%20Odds%20and%20Price%20Suppliers.md) for evidence.

[V1 - Playable Demo Gap Review](V1%20-%20Playable%20Demo%20Gap%20Review.md) records the subsequent review of missing validation and recommended demo feedback. Recommendations in that review are distinguished from user-approved scope.

**Commercial purpose:** this is the playable sales demo for our proposed turnkey white-label product, including customisation, launch and full project source-code handover. [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) governs the new ten-bet allowance and consultation CTA. Production configuration and buyer/provider onboarding belong in separate literature, not the game controls.

## Locked choices

| Area | V1 decision |
|---|---|
| Product reference | Euphoria's look, feel, controls, tap interaction and position lifecycle. |
| Renderer | TypeScript, Vite and Three.js, with synchronized HTML controls. |
| Markets | BTC/USD and ETH/USD only. |
| Price source | Lynx public Gridy config and Pyth-derived price buffers. |
| Odds | Local indicative pricing using the published Lynx SDK/model inputs; freeze the accepted multiplier in our own paper ledger. |
| Money | Virtual USD; all placements and payouts are simulated locally. |
| Accounts | No user/provider signup, wallet, KYC, API key or real trading account in v1. |
| Stakes and zoom | One shared stake menu for everyone and Euphoria's bounded continuous zoom; no account/VIP gating. |
| Contract | Any qualifying sampled price touch inside the chosen band during its future five-second window. |
| Sales flow | Ten accepted paper bets per page load; consultation modal after the tenth; refresh grants ten more indefinitely. |

## The entire player flow

1. Open the demo directly on the live board, with free virtual USD already available.
2. Choose BTC/USD or ETH/USD; switch whenever desired without changing existing bets.
3. Zoom in/out within the shared limits and raise/lower the selected stake within the shared allowed menu.
4. Tap an available future square once to place a paper bet at its displayed valid multiplier. No confirmation dialog, wallet prompt or slippage settings.
5. Watch price-driven outcomes. On the tenth accepted bet, show the consultation message; keep existing bets settling, and stop new placements until refresh. Refresh gives ten more bets indefinitely without signup or booking.

The consultation offers Maya product purchase, customisation, launch and full project source-code handover. It can be dismissed to view results. Count accepted placements across both markets, not wins, settled bets or rejected taps. Store the allowance only in page memory; preserve the existing local paper ledger separately so restored bets do not consume the new allowance. A paper-money refill does not reset the placement allowance. The user approved a dummy booking URL for now: use configurable `https://example.com` with no scheduling integration required.

**Price determines the outcome; odds determine the payout.** Do not randomly roll a win/loss based on the quoted probability. For example, a $5 bet at 2.5× returns $12.50 total on a qualifying touch, or $0 on a miss. The stake was deducted when placed. Zoom and stake changes affect future interactions, not existing bets.

Implementation defaults, selected to make the demo concrete rather than claimed as additional user-specified numbers: start with $1,000 virtual USD; stake choices $0.10, $0.50, $1, $5 and $10, default $1; $50 total stake per square. These apply to every visitor and use the recovered Euphoria standard limits. The $25/$50 menu entries seen in Euphoria's client require higher, unverified tiers and are not demo choices. A refill adds $1,000 virtual USD without cancelling active bets. Zoom starts at 0.6, clamps to 0.345–0.9 and uses the recovered wheel factors 1.1/0.9; no invented preset array. No profile selection or tier unlocks.

## Public inputs

- Configuration.
- BTC/USD: `/gridy/prices/bsc/1`; ETH/USD: `/gridy/prices/bsc/2` on that same public host.
- Published client package, inspected version `0.0.1-alpha.1`.
- Public probability table, version `2`; its version is separate from the server's formula-version field.

Config, ETH prices and model table have been read without credentials. BTC is documented in the successfully read config; verify its price response during implementation. An end-to-end SDK/runtime integration has not yet been built.

## Odds and fidelity boundary

**The user now accepts the no-registration paper-odds route. Exact numeric Euphoria odds are no longer a v1 requirement.** Lynx's local previews are not its final server quotes and are not Euphoria's competitive market-maker quotes. There is no funded market maker or provider execution in this version.

Use the published pricing primitives with Euphoria's display geometry: five-second windows, BTC $10 bands and ETH $0.50 bands. Do not blindly copy Lynx's `liveBoard()` geometry or live-server trade restrictions into the UI. Validate that the model can price our geometry within its supported input domain; invalid or unavailable probabilities disable the cell. This is a paper-only adaptation, not a claim that Lynx would accept those contracts.

The checked Lynx pricing configuration supplies 10% model margin and a 1.01× minimum preview payout. Preserve provenance/versioning rather than inventing Euphoria margin or multiplier caps. Read current compatible config and stop quoting on incompatible model changes. Do not silently alter accepted positions.

## Paper settlement

Our authority is the timestamped Lynx price sample, not chart interpolation. Define time windows as `[start, end)` and band membership as `lower <= price <= upper`. A first qualifying sample wins; a complete window without a hit loses. These are explicit Maya v1 rules, not proof of Euphoria or Lynx server settlement equivalence.

Deduplicate source samples, preserve ordering and reconcile using the recent buffer. Pause new positions on stale inputs. If a window lacks sufficient source evidence after recovery, void/refund the affected unresolved position instead of guessing a win or loss. Sampled data can miss movement between observations; do not promise tick-for-tick equivalence to Euphoria's faster custom oracle.

## Deferred beyond v1

BTC/ETH and USDT-labelled demo markets; Wintermute onboarding and other buyer-specific production integrations; Polymarket/Deriv/Binance feeds; external firm-quote APIs; real stakes, deposits, withdrawals and wallet execution. Selling our future customised white-label product through the demo CTA is in scope; implementing every buyer's production deployment is not part of this demo build. There is no automatic provider fallback in v1.

## Implementation acceptance

1. Both USD markets use fresh public inputs without credentials and show clear stale/unavailable states.
2. Any visitor can immediately choose either pair, use every demo stake/zoom option and place a bet; no identity or tier gate. Euphoria's chart/control styling remains the reference.
3. Local accepted multipliers stay fixed through price changes, zoom and market switching.
4. Price-driven touch/miss outcomes, fixed payouts, balance, shared caps, duplicate taps/requests, reload and gap refunds behave deterministically. Wins are never randomized by the odds.
5. The tenth accepted placement opens the consultation modal once, accepted bets continue settling, and each refresh gives ten new placements. The supplied recording remains a developer-only historical fixture, exempt from the prospect-facing sales gate.

**Decision locked; application implementation has not started.** The next implementation unit is a read-only feed/model adapter that verifies both markets and prices a representative set of five-second cells before wiring the renderer. Replay and deterministic fixtures are developer verification tools; players see only the playable demo.
