---
type: product-research
created: 2026-09-20
verified: 2026-09-20
tags:
  - Maya
  - crypto
  - tap-trading
  - Binance
  - competitors
---

# Crypto tap trading — existing products and Binance mapping

**Yes: crypto already has related financial instruments and very similar finished products. Euphoria is the strongest candidate for the supplied video's source; RUSH explicitly offers the same select-a-grid-cell mechanic.**

The locked v1 scope is **paper trading on BTC/USD and ETH/USD using Lynx public inputs and locally calculated preview odds**. Binance mappings and Wintermute investigation are retained as history. See [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md) and [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md).

Related: [Video Analysis - Price-Time Prediction Grid](Video%20Analysis%20-%20Price-Time%20Prediction%20Grid.md) and [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md).

**Deep-research update (2026-09-20):** see [Tap Trading - Deep Research Index](Tap%20Trading%20-%20Deep%20Research%20Index.md) for inspected public code, live configuration, mobile UX and economics. Lynx has both solo and multiplayer Gridy, plus a published alpha client SDK; the earlier table below was an initial product survey. Euphoria's current docs explicitly confirm five-second touch windows. RUSH's advertised touch rule still needs reconciliation with its client pricing and deployed settlement.

## 1. Existing products

| Product | Evidence | Match to our reference |
|---|---|---|
| **[Euphoria](https://euphoria.finance/)** | Its own docs describe Tap Trading and a game-like derivatives interface. Its public landing page, inspected in the browser, shows a burgundy/pink chart, lime position cards, multipliers, and the same corner-control style. | **Very close; likely source or the same design family.** The uploaded file has no visible branding, so its origin is not proven. |
| **[RUSH](https://rush.trade/)** | Its public product page explicitly describes choosing a multiplier on a grid and predicting whether price enters the selected cell. It advertises ten-second outcomes and Solana/MagicBlock infrastructure. | **Direct mechanic competitor.** Advertised timing differs from the approximately five-second columns in our clip. |
| **[Lynx Arcade / Gridy](https://www.lynx.finance/blog/crypto-price-prediction-game/)** | Lynx's own article describes a multiplayer price-grid game, alongside direction and coin-race games. Availability depends on live room configuration. | **Related product category.** The evidence is insufficient to call it the identical ruleset or interface. |

Euphoria's [official manifesto](https://docs.euphoria.finance/) establishes its Tap Trading positioning. Browser comparison of its public homepage supplies the visual evidence; we did not log in or execute any positions. Avoid similarly spelled unofficial domains when following product links.

RUSH's landing page and visible site content establish its advertised feature set, not independently audited volume, latency, withdrawal reliability, or suitability for a particular user. Those promotional performance claims are not needed for the product comparison.

## 2. Do the underlying instruments already exist?

**Yes, the financial family exists. The exact selectable five-second rectangle is a more specific contract.**

| Instrument | Basic outcome | Relationship to the game |
|---|---|---|
| One-touch option | Fixed payout if an agreed price barrier is reached during an observation period. | Closest established family. |
| Binary/digital option at expiry | Fixed payout if a condition is true at the expiry instant. | Similar payout form, but different from touching a region earlier in the window. |
| Our grid position | Payout if the observed price enters a bounded price band during a chosen future interval. | A time-windowed touch/range condition, with its own price source, sampling, boundaries, and settlement rules. |
| Spot / perpetual futures | Ownership or directional exposure with changing P&L. | Can supply market prices or other trading exposure; does not directly create this fixed-payout rectangle. |

Wintermute explicitly advertises crypto one-touch options and binaries through its OTC options offering, with custom structures. This establishes that the instrument family exists. It does not establish that a retail developer can route arbitrary $5, five-second cell bets to a public API with immediate fills. [Wintermute OTC options](https://www.wintermute.com/otc/options).

Likewise, buying an ordinary call or put with a strike and expiry does not automatically replicate the path-dependent payoff of this game. A barrier observed continuously from purchase is also different from a band observed only within a future sub-window.

**Architecture consequence:** we cannot turn a Binance price subscription into the game's execution venue. A real-value product would need an actual protocol/venue accepting the exact contract, or its own funded counterparty/liquidity and settlement design. A venue's documented integration interface, eligibility, supported markets, and precise rules must be verified before promising reuse. No Euphoria/RUSH execution API was verified in this research.

## 3. What Euphoria's data design teaches us

Euphoria's oracle provider RedStone describes a custom integration that supplies signed current prices and high/low values for short, fixed windows. It builds those aggregates at the data layer and aligns their timestamps with the observation windows. This is direct provider evidence that a tap-trading product needs more than a visually smooth price line. [RedStone's Euphoria integration](https://blog.redstone.finance/2026/01/13/euphoria-redstone-bolt/).

For our implementation, chart display, quote acceptance, and settlement must share a clearly defined price/time basis. We should not claim a match to Euphoria's payouts simply because a Binance line looks similar. Binance is one venue's spot feed; a signed multi-source oracle can produce different values and outcomes.

## 4. Selected Binance data plan

Use Binance's public market-data-only services. Its documentation states that these services need no API key, and provides dedicated REST and WebSocket hosts. [Market-data-only documentation](https://developers.binance.com/en/docs/products/spot/faqs/market_data_only).

```text
REST: https://data-api.binance.vision
WebSocket host: wss://data-stream.binance.vision:443
Streams: btcusdt@trade and ethusdt@trade
```

The raw trade stream carries symbol, trade ID, price, quantity, event time, and trade time. Use the trade timestamp for market-event ordering and settlement; keep receipt time separately to measure latency. [Binance trade streams](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-streams/~).

These endpoint capabilities were checked in official documentation; a running connection was not tested in this planning turn. Public market data requires no Binance login, but it is not an order-placement service.

### Required behavior

1. **Three markets:** BTC/USDT and ETH/USDT direct, plus BTC/ETH derived from reciprocal ETHBTC trades. Label quote currencies correctly and keep each position bound to its original market. BTC/ETH's price-band width remains an explicit extension decision.
2. **Continuous data:** backend feed adapter → timestamped normalized events → game engine and frontend stream. Keep chart rendering at display speed while settlement processes source events independently.
3. **Reliable recovery:** deduplicate events, detect stale/disconnected streams, pause new positions, recover missing data when possible, and apply explicit void/refund rules when an interval cannot be resolved. Never silently switch venues or generated prices for open predictions.
4. **Own game layer:** stakes, quotes, acceptance, MIN/MAX, balance, expiry, and payout effects remain application logic. The planned ledger uses virtual funds; the live quote feed does not trade BTC or ETH for the player.
5. **Preset zoom:** change the view without changing any placed position's market, price band, interval, stake, or multiplier. Keep pointer mapping aligned at every level.

The reference replay and seeded practice modes remain useful for reproducible visual and rule tests. They must be clearly distinct from the live Binance mode.

## 5. White-label options — checked 2026-09-20

**White-label vendors exist in this category, but no public white-label program was verified for Euphoria, RUSH, or Lynx Arcade themselves.** A missing public offer does not rule out a private commercial partnership. Referral programs and unrelated companies with similar names are not evidence of a white-label product.

| Vendor | Public offer | Evidence limits |
|---|---|---|
| **[Tradesmarter Tap Trading](https://www.tradesmarter.com/tap-trading.html)** | Branded platform, iframe/widget, API integration and Telegram mini app. Configurable crypto assets, stake limits, durations, multipliers and payout logic. | The page describes both touching a target and remaining inside a box for its full duration. Its linked consumer demo, `taptrading.com`, redirected to a domain-for-sale URL in the web checker. A working demo and precise contract rules need verification. |
| **[TapTradings.com](https://taptradings.com/)** | Advertises a white-label grid game, five-second rounds, source-code access, branding, wallet/user API integration and a Three.js/WebGL stack. | Marketing evidence only: delivery, code quality, source licence, operating clients and exact settlement rules were not independently verified. This is a different domain from the singular demo linked above; no relationship was established. |

Neither reviewed product page provides a concrete price for the relevant package. Setup charges, recurring fees, revenue share and modification rights need a written commercial proposal.

For the proposed custom Three.js frontend, confirm API rights or a modifiable source licence; an iframe alone may not support the required fidelity. MIN/MAX buttons and preset zoom behavior need demonstration even if stake limits are configurable. White-label software also does not establish who funds payouts or provides the counterparty.

**First evaluation requirement:** demonstrate a BTC/ETH position that wins on entry into the selected price band during its future time window, including adjacent-cell wins. This distinguishes our inferred reference mechanic from expiry-only and stay-inside variants. No vendor was contacted or purchased from.

## Product conclusion

This is an established **tap-trading / short-duration prediction** category, not a new mechanism created by this project. Euphoria and RUSH should be studied as direct product references. The build decision is whether to create a virtual-funds recreation with live BTC/ETH prices, integrate a documented existing protocol, or develop a separate financial execution system. Only the first is currently specified; no real-money execution integration has been verified or implemented.
