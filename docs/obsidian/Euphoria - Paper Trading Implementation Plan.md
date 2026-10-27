---
type: implementation-plan
created: 2026-09-20
status: v1-scope-locked
tags: [Maya, Euphoria, paper-trading, Lynx, fidelity]
---

# Euphoria-style paper trading — v1 implementation plan

**Locked v1: BTC/USD and ETH/USD, Lynx public prices, locally calculated indicative odds, virtual USD and an Euphoria-style Three.js interface. No provider registration or real trading is required.**

[V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md) records the user's decision and explicit two-market confirmation. It supersedes the previous Binance/Wintermute provider choices, USDT/cross-pair scope and exact numeric Euphoria-odds dependency. Euphoria remains the controls, appearance and interaction reference.

**Sales-demo update:** [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) adds ten accepted bets per page load and a consultation modal immediately after the tenth. Refresh deliberately grants ten more. The offer is our customised turnkey white-label product, launch service and full project source-code handover; buyer-specific chain/provider/market details stay in separate literature.

**Product name: Maya.** The user approved a dummy consultation destination for now; set `consultationUrl` to `https://example.com`. Real appointment scheduling is outside the present demo requirements.

**Implementation structure:** [Maya - Development Graph](Maya%20-%20Development%20Graph.md) and [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md) expand this plan into the required monorepo and distinct adaptive desktop/tablet/mobile views. Their canonical package map supersedes earlier root-`src/` examples; every view retains the researched controls and one shared engine/ledger/allowance.

Prior planning is preserved in [the archived paper plan](Attachments/Tap%20Trading%20Research/Plan%20History/Paper%20Plan%20-%20before%20Lynx%20v1%20lock.md), [Wintermute - Integration and Access Plan](Wintermute%20-%20Integration%20and%20Access%20Plan.md) and the research notes. They do not select a v1 fallback.

## 1. Price and market mapping

| Market shown | Lynx Gridy public input | Axis |
|---|---|---|
| BTC/USD | `/gridy/prices/bsc/1` | USD per BTC |
| ETH/USD | `/gridy/prices/bsc/2` | USD per ETH |

The host is `<removed-third-party-endpoint>`; discover and validate pair/feed identity through `/gridy/config/bsc`. Config and ETH prices were read successfully; verifying BTC's price response is part of the first implementation unit. These are Pyth-derived price samples, not Binance trade events. Preserve source timestamps and precise values; use pair/feed/timestamp for sample identity and check for conflicting duplicates.

Use a bounded read-only adapter to share polling and config/model caching. No provider order, wallet, funding or authentication methods belong in it. A local service may proxy/cache the public data if browser-origin restrictions require that. Do not introduce a second data vendor.

All balances, stakes and payouts use virtual USD. Show a compact **Paper · USD** indicator and identify the odds as simulated/model-derived in the relevant explanatory UI. Open directly to the playable board, with no login or profile selection. Use $1,000 starting demo funds and a refill action that adds $1,000 without changing open bets. These are implementation defaults. Persist paper state locally; the historical replay retains its original balance sequence.

Persisted paper state is separate from the sales allowance. The accepted-bet count and modal-shown flag live only in page memory and reset on browser refresh. Restoring prior positions, switching pairs or refilling funds must not increment/reset that count. Booking-link configuration is the only consultation destination needed in the demo; no in-game provider setup or product questionnaire.

## 2. Recovered stake settings

The current public [Euphoria main bundle](https://euphoria.finance/assets/index-CoMhH3ox.js) defines a menu of:

**$0.10 · $0.50 · $1 · $5 · $10 · $25 · $50**

Its enabled items are filtered by `userTier.maxTrade`; unavailable items remain visible with a VIP label. The current trade module opens a size picker, with desktop `Alt+1` through `Alt+7` shortcuts. This is more precise than the FAQ's general “cycle sizes” description and supersedes the historical clip's $1–$500 menu for live paper mode.

| Reference profile | Minimum selectable | Maximum per placement | Maximum total stake per square | Enabled amounts |
|---|---:|---:|---:|---|
| New account — historical reference only | $0.10 | $5 | $25 | 0.10, 0.50, 1, 5 |
| Standard — shared demo limits | $0.10 | $10 | $50 | 0.10, 0.50, 1, 5, 10 |

Per-trade and per-square limits are from Euphoria's [published limits](https://docs.euphoria.finance/euphoria/fees-and-trading-limits). The minimum is the lowest selectable amount in the inspected client, not an independently tested server minimum. $50 is the highest menu item, **not the maximum enabled amount for every user**. No confirmed VIP limit or promotion threshold is available; do not invent either.

The table above is reference evidence, not a demo account system. **Latest user clarification: this is a playable demo for anyone.** Apply the recovered standard limits uniformly: selectable stakes **$0.10, $0.50, $1, $5, $10**, default **$1**, maximum **$10 per bet** and **$50 total stake per square**. These are implementation defaults derived from the reference; the user did not specify new numeric limits. Remove account/VIP gating, profile selection and inaccessible $25/$50 choices from the player flow.

Raising/lowering the stake moves through that allowed menu and stops at its endpoints. Selecting a stake does not place a bet. A low balance produces the insufficient-balance feedback on placement rather than silently changing the selected size. Multiple taps may accumulate on a square within the shared cap; a retry of the same request must remain idempotent. No all-in calculation or production tier progression is needed.

## 3. Recovered zoom and grid settings

Static analysis traced the asset configuration through chart construction, rather than taking the first default found in the bundle. The asset values override the generic minimum. The live chart route supplies the initial default below. Saved proof: [Euphoria controls facts](Attachments/Tap%20Trading%20Research/euphoria-controls-facts-2026-09-20.json).

| Setting | Recovered client value |
|---|---|
| Minimum zoom | `0.345` |
| Maximum zoom | `0.9` |
| Fresh route default/reset value | `0.6` |
| Wheel zoom-in / zoom-out | Multiply current value by `1.1` / `0.9`, then clamp |
| Pinch | Continuous scaling within the same bounds |
| Cell dimensions | Square cells: `canvasHeight / 6 × zoom` |
| Time width | 5 seconds per cell |
| BTC price band | 10 price units per cell |
| ETH price band | 0.50 price units per cell |

These zoom values are internal scale parameters, not necessarily labels shown to users. At a canvas height of 904 px, they imply approximately 52 px minimum, 90.4 px default and 135.6 px maximum cells. Match actual canvas sizing during visual verification. Saved settings can override the fresh default.

No fixed five-level preset array was found. The earlier proposed `0.5×, 0.75×, 1×, 1.5×, 2×` list is withdrawn. Match the recovered wheel/pinch behavior and bounds. Do not claim a particular reset button layout until observed; the reset behavior exists in code.

V1 uses BTC/USD and ETH/USD, with BTC $10 and ETH $0.50 bands. BTC/ETH is deferred. The renderer keeps these Euphoria-derived dimensions; the Lynx local pricing primitives must be validated against this geometry instead of copying a different live-server grid configuration.

## 4. Local indicative odds — accepted v1 choice

Use the published Lynx pricing model/SDK primitives and public probability table, with the latest compatible config and price buffer. Inspected SDK version: `0.0.1-alpha.1`; public table version: `2`; observed server formula version: `3.0.0`. These are distinct identifiers. Record model/config hashes with quotes and reject incompatible or malformed inputs.

The published preview estimates touch probability from recent volatility and cell geometry, then derives the gross multiplier using the configured margin and precision. The checked config has margin 0.10 and minimum payout 1.01×. Consume the model's output and validation rather than inventing an odds distribution or a commercial maximum. A zero/invalid probability or unsupported table-domain input produces an unavailable cell.

Keep Euphoria's five-second windows and BTC and ETH band dimensions above. Use a local pricing primitive for those bands; do not assume Lynx's default `liveBoard()` geometry matches Euphoria. No quote is submitted to Lynx. The application records its own paper quote revision, observation time, validity and locked multiplier.

**Numeric Euphoria odds parity is no longer a v1 acceptance gate.** These are locally simulated preview odds, not Euphoria quotes or Lynx server-accepted odds. The latter uses a richer model according to the SDK. Recorded video odds remain exact only for the visible historical replay values.

Related evidence: [Tap Trading - External Odds and Price Suppliers](Tap%20Trading%20-%20External%20Odds%20and%20Price%20Suppliers.md) and [Lynx - Stack Economics Flow and UX](Lynx%20-%20Stack%20Economics%20Flow%20and%20UX.md).

## 5. Paper execution and settlement

On tap, atomically validate the displayed quote's freshness, data/model, timing, shared caps and paper balance. Accept that exact valid multiplier, debit once and show the bet immediately; otherwise reject without a debit. A changed or expired quote must not silently substitute worse odds. Freeze market, time window, band, stake and multiplier. Switching market, zoom or stake never changes accepted terms. No order form, confirmation modal, artificial execution delay, slippage settings or external quote negotiation belongs in the player flow.

Use the config's compatible minimum lead time, observed as three seconds, as a named paper parameter. Do not call it a recovered Euphoria cutoff. Align future windows to the five-second grid. Time inclusion is `[start, end)`; price inclusion is `lower <= price <= upper`. A source sample inside both wins; a complete window with no qualifying sample misses. These are explicit Maya v1 semantics.

**The price determines win/loss, while the locked odds determine the return.** Never use a random draw to settle a bet. The renderer may smooth movement, but interpolation cannot manufacture a touch. Credit gross return once: stake multiplied by the accepted multiplier, with an explicit integer-cent rounding policy. A $5 bet at 2.5× returns $12.50 including stake on a win; a miss credits zero. Debit/credit/refund records and terminal outcomes must be idempotent.

Pause new placements when the price or model is stale. Reconcile gaps from the recent public buffer where possible. If sufficient interval evidence cannot be recovered, void/refund affected unresolved paper positions. No automatic switch to Binance, Deriv, Wintermute or Polymarket. Save source samples required by open positions so reload can resume without duplicate settlement.

## 6. Build order and completion gates

1. **Read-only feed/model proof.** Verify both USD inputs, load the model without credentials and price representative five-second BTC $10 / ETH $0.50 cells. Confirm model-domain, precision and stale-data behavior.
2. **Calibrated board.** Build TypeScript/Vite/Three.js and synchronized controls at the 1642 × 904 reference size. Preserve recovered stake picker, zoom, palette, cards and motion.
3. **Playable sales-demo loop.** Add one-tap local acceptance, fixed multipliers, multiple positions, shared stake caps, sampled touch outcomes, balance/refill and gap refunds. Integrate the page-local ten-bet allowance, tenth-bet consultation modal and configured booking link. Close the placement gate atomically after ten; keep the clock, feed and settlement running. Every visitor gets the same controls with no signup, and refresh resets only the allowance.
4. **Reference replay.** Reproduce the observed 53.888-second clip independently of live model-derived odds.
5. **End-to-end verification.** Verify both markets, stake/zoom extremes, overspending, duplicate requests, same-cell caps, market switching, reload and source failure. Test the 9→10 transition, rapid/rejected taps, continued settlement behind the modal, repeated refresh allowances and navigation to the configured dummy booking URL. Deliver the paper app with a fidelity/gap report; apply the sales gate only to prospect-facing live demo mode.

V1 planning is locked. Application implementation has not started in this decision turn.
