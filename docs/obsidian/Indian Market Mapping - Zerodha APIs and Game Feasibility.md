---
type: feasibility-note
created: 2026-09-20
verified: 2026-09-20
tags:
  - Maya
  - trading-game
  - indian-markets
  - zerodha
  - data-licensing
---

# Indian market mapping — Zerodha APIs and game feasibility

> **Superseded product direction:** later on 20 September 2026, the user dropped the Indian-market/Zerodha route and selected Binance BTC/ETH price charts. This note is retained as research history. Current direction: [Crypto Tap Trading - Existing Products and Binance Mapping](Crypto%20Tap%20Trading%20-%20Existing%20Products%20and%20Binance%20Mapping.md).

**The visual game can be adapted to Indian-market-style prices. Zerodha can technically supply relevant data, but its published terms prohibit using its APIs/live data for this type of trading game.** Build the initial version with generated prices and virtual points; treat an actual-market edition as a separate product/data-permission decision.

Related: [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md) and [Video Analysis - Price-Time Prediction Grid](Video%20Analysis%20-%20Price-Time%20Prediction%20Grid.md). This is a technical and product assessment, not a determination that a real-money version is lawful.

## Confirmed controls

The user adds two requirements beyond the initial video interpretation:

1. Select the lowest or maximum stake, as well as intermediate amounts.
2. Zoom in and out through predetermined levels.

Exact amounts and zoom levels were not supplied. MAX must have an explicit definition: configured cap versus maximum affordable amount. The proposed initial implementation selects the highest affordable configured preset. Zoom changes the view without altering any already-accepted prediction.

## What corresponds to an Indian market instrument

| Reference game element | Indian-market equivalent | What we build |
|---|---|---|
| ETH price line | NIFTY 50 / SENSEX index values, or an individual stock's price | A selected instrument drives the chart. Indices use points; equity prices use rupees. |
| Future square | A specified future time window and price/point band | Our own prediction object, not an exchange order or exchange-listed contract. |
| Offered 2.51× multiplier | No equivalent value supplied by a normal stock quote | A game-specific scoring/payout model. |
| Stake and balance | Virtual points in the initial game | Our own ledger, not the user's Zerodha buying power or broker cash. |
| Hit, miss, glow, zoom, MIN/MAX | Application behavior | Our own engine and Three.js/UI code. |

Kite documents both tradable-instrument and index quote formats, including NIFTY 50 and SENSEX. The instrument master includes exchange, symbol, type, tick size, lot size, and derivative expiry. Resolve these from current metadata rather than hardcoding a token or assuming every instrument has the same price increment. [WebSocket formats](https://kite.trade/docs/connect/v3/websocket/), [instrument metadata](https://kite.trade/docs/connect/v3/market-quotes/).

### Candidate underlying types

**For a clean index-style interface:** a broad-index value such as NIFTY 50 is a natural conceptual mapping. Choosing it as a reference is not buying the index or creating a broker-backed bet. The first prototype can instead use a clearly fictional index with its own generated series.

**For a rupee-price interface:** use the behavior of a liquid equity as the design model. With a permitted source, an equity's last traded price is easy to explain and display. For a synthetic prototype, use a fictional company and generated prices rather than labelling fake numbers as a real company's live price.

**For futures or options:** the chart could follow an individual contract's traded price, but expiry, changing symbols, contract size, and price gaps add complexity. An option premium is not a probability that a five-second price rectangle will be touched, and its strike is not automatically one of our grid bands. This is a poor first implementation target.

An ordinary broker order buys/sells a quantity of an instrument using the supported order types. It does not promise a fixed 2.51× credit when a chart rectangle is touched. Our game rules do not become exchange-backed just because the line comes from an exchange feed. [Kite order API](https://kite.trade/docs/connect/v3/orders/).

## API versus MCP

| Capability | Technical role | Fit for this project |
|---|---|---|
| Kite Connect WebSocket | Persistent instrument-price updates | Appropriate transport for a permitted real-time market application; not authorized for this game under ordinary terms. |
| Quote REST endpoints | Current snapshots and startup data | Useful to initialize a permitted chart; avoid using repeated snapshots as a substitute for a stream. |
| Instrument master | Symbols, IDs, tick size, contract metadata | Necessary for proper instrument selection in a permitted integration. |
| Historical API | OHLC candles from one-minute resolution upward | Useful for charts/aggregate analysis; cannot reconstruct a five-second within-band touch sequence. |
| Kite MCP | AI requests for market/account information | Useful for conversation and analysis; it should not drive animation, quote updates, or settlement. |

Zerodha's MCP product is built on Kite Connect and advertises account/market lookups through an AI assistant. My architecture recommendation is to use direct streaming for any permitted real-time application and keep MCP outside the event-processing loop. MCP is not a data-use-permission workaround. [Official MCP product](https://zerodha.com/products/mcp/).

The listed Connect tier is **₹500/month** for WebSocket and historical data access, as checked on 20 September 2026. Paying this fee does not grant game or redistribution rights. [Official API pricing](https://zerodha.com/products/api/).

## Why the five-second game needs special data handling

The historical API's smallest documented candle is one minute. Open/high/low/close describe extrema and endpoints, not the time and order of every price move. A one-minute candle therefore cannot decide whether the price touched a particular band during one chosen five-second segment. Drawing a smooth path between candle endpoints would invent that evidence. [Historical API](https://kite.trade/docs/connect/v3/historical/).

For any permitted observed-data edition, distinguish two paths:

1. **Display path:** may interpolate visually to make updates look smooth.
2. **Settlement evidence:** source observations with timestamps and a documented missing-data policy.

The visual line alone must not create a win between two real observations. Unlike our simulated feed, observed exchange updates do not establish every intervening price. Define settlement as observed-quote hits, or obtain a source with the necessary completeness; never imply it captures every exchange trade without evidence. Pause new positions on stale data and explicitly void/refund affected predictions when an interval cannot be resolved under the stated rules.

Band sizes should reflect the chosen instrument's scale and metadata. Do not mechanically replace a $0.50 ETH band with a ₹0.50 stock band or 0.50 index points. Calibrate the game using the chosen price process. A larger displayed zoom range does not authorize changing an existing position's settlement interval.

## Current permission constraint

Zerodha's published API terms explicitly disallow use of the APIs and/or live data for virtual/mock trading applications and trading-related games. They also restrict public display of live data. These are product-specific limitations, not merely a warning about real-money trading. A private demo using fake money should not be assumed exempt. [Kite Connect terms, section 2(a)](https://kite.trade/terms/).

SEBI's **8 May 2026** circular, effective **1 July 2026**, establishes a **30-day lag** for the educational data sharing/use it covers. Its educational sharing provision requires no monetary incentives and an appropriate legal agreement, with a specific NISM exception. It is not blanket authorization for a betting game, and does not override a provider's contract. Older one-day educational-lag guidance should not be used as the current general rule. [SEBI circular](https://www.sebi.gov.in/sebi_data/attachdocs/may-2026/1778242522289.pdf).

Consequently, a broker login, API key, paid plan, read-only integration, or MCP connection alone is insufficient permission for the proposed game. No Zerodha connection was made and no account data was accessed for this assessment.

## Buildable routes

| Route | What it retains | Current decision |
|---|---|---|
| **Generated-price game with virtual points** | Grid, touch rules, odds, MIN/MAX, zoom levels, animation, fast rounds | Recommended initial build; uses our own generated data. |
| **Properly licensed historical educational replay** | Actual old market movement and a training experience | Conditional on educational fit, required data age, provider permissions, and sufficiently granular data. No assumption that Kite history is licensed for this game. |
| **Broker-connected trading interface** | Chart/grid UI adapted to real buy/sell orders | A different product with broker/exchange requirements and actual trading economics; does not preserve the fixed touch payout. |

For a permitted data-backed route, the architecture would be:

```text
authorized data source
    → backend normalizer and timestamped event log
    → authoritative rule engine and virtual ledger
    → application WebSocket
    → Three.js chart and controls
```

Keep credentials in the backend, never in the browser. Any recording, replay, or downstream display must also be covered by the data permissions. For the initial generated-price version, substitute the seeded simulator for the external data source and avoid broker integration entirely.

**Recommended next build step:** implement the existing frozen-frame prototype with a fictional Indian-style price series, virtual points, explicit MIN/MAX behavior, and preset zoom. Preserve the ability to substitute a permitted data source later without changing the renderer.
