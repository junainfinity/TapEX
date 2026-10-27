---
type: provider-research
created: 2026-09-20
verified: 2026-09-20
status: lynx-selected-for-v1
tags: [Maya, tap-trading, API, market-making, white-label, prices, odds]
---

# External odds and price suppliers for Maya

**Useful integrations exist, but no supplier was verified as a ready-to-use source of Euphoria's exact five-second grid quotes. Lynx is the closest inspectable technical lead; Tradesmarter is the closest explicit commercial white-label lead.**

Research context: the user asked whether live games or white-label platforms can supply prices/odds. **Subsequent decision:** [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md) selects Lynx public inputs and local indicative odds for BTC/USD and ETH/USD. Provider comparisons below preserve the evidence and limitations behind that choice.

## What “odds access” means

These are separate capabilities:

1. **Price data:** the current underlying asset value, timestamps and history.
2. **Indicative multiplier:** a model's estimate for a possible position, which can change before acceptance.
3. **Accepted quote:** a specified payout for an exact contract, size and acceptance time.
4. **Funded counterparty:** someone supplies the capital and accepts real losses when players win.
5. **Commercial integration:** permission and operational support for our own interface, brand and users.

An SDK, a visible cell multiplier, or a software vendor's odds engine does not establish all five. For paper-only Maya, capital is unnecessary, but the distinction between simulated odds and an externally accepted quote still matters.

## Comparison

| Candidate | Prices / odds evidence | External access | Fit for Euphoria-style cells |
|---|---|---|---|
| Lynx Gridy | Live BTC/USD and ETH/USD config; ETH price HTTP request succeeded. SDK produces indicative touch-window grids; server sets final multiplier on bet acceptance. | Published alpha client and wallet-free observation. Branded deployment agreement and liquidity provision unverified. | Closest inspected rule match; local model previews are not a firm external quote feed. |
| Tradesmarter Tap Trading | Advertises live prices, configurable multipliers/payouts and API integration of pricing/settlement. | Explicit B2B white-label/API offer; no technical quote contract or working API tested. | Strong commercial lead; touch-before-expiry versus stay-inside descriptions conflict. |
| TapTradings.com | Advertises five-second grid rounds and proprietary odds software. | White-label/source-code and integration claims; no quote API or delivered product independently verified. | Superficially close; evidence is marketing only. |
| Forsee | Documents live directional odds and price endpoints. | Approved-account API keys during limited rollout; no credentials used. | Minute-or-longer UP/DOWN markets; not five-second touch-band cells. |
| Overtime / Thales Speed Markets | Public developer integration for AMM-backed directional markets and Pyth pricing. | API + smart-contract integration documented; example API host failed DNS here. | At-expiry direction, currently advertised from five minutes; not touch-window grid odds. |
| Deriv | Public BTC/USD and ETH/USD ticks successfully retrieved; public contract discovery and proposal APIs documented. | Anonymous public data connection worked. | Returned crypto contracts were MULTUP/MULTDOWN only; no compatible touch-band contract verified. |
| Euphoria | Professional market makers quote each cell; internal price/quote transports observed. | No supported public external price/quote API or white-label program verified. | Exact reference, but access remains unconfirmed. |
| RUSH | Public app shows prices/multipliers; prior code inspection found pricing parameters and market-making interfaces. | No supported external quote API or white-label offer verified. | Candidate partnership only; internal app routes are not an integration product. |

## 1. Lynx — strongest inspectable grid integration

The published lynx-gameroom-client registry entry still reports version `0.0.1-alpha.1`. The preserved package README/API docs describe wallet-free observation and `gridy.liveBoard()`: current spot, volatility, box geometry, availability and indicative multipliers. They explicitly distinguish these locally calculated board values from the server's final accepted multiplier.

Fresh unauthenticated reads at approximately **10:11 UTC on 20 September 2026** succeeded:

- BSC configuration: BTC/USD and ETH/USD, durations 3/4/5/10 seconds, minimum delay 3 seconds, formula version 3.0.0, model margin 10%, minimum payout 1.01×.
- ETH/USD price buffer: 71 timestamped observations; the latest was current to the retrieval second.

The SDK's API documentation describes roughly one observation per second from its Pyth stream. A successful current buffer read is not an uptime or latency benchmark. No BTC/ETH cross was present in the checked config. USD values must not be relabeled USDT.

**Commercial boundary:** the client package is MIT-labelled, but that does not grant branded service hosting, server code, guaranteed house liquidity or permission to redistribute a production feed. No standalone firm-quote endpoint was established without submitting a real bet; no bet was submitted.

**For paper Maya:** we could investigate the published price/config + SDK preview route while retaining our own renderer and paper ledger. This would be Lynx-derived indicative pricing, not Euphoria's competitive market-maker quotes. It would also require resolving differences in price source, sampling, bands and supported markets before claiming rule parity. See [Lynx - Stack Economics Flow and UX](Lynx%20-%20Stack%20Economics%20Flow%20and%20UX.md).

## 2. Tradesmarter — explicit white-label pricing offer

Its [Tap Trading product page](https://www.tradesmarter.com/tap-trading.html) advertises branded deployment, embedding and APIs covering pricing, balances and settlement, plus configurable markets, stakes, timing, multipliers and exposure. This is direct vendor evidence of a B2B offer, rather than an inference from a consumer app.

However, it describes both touching a target before expiry and remaining inside a box throughout its duration. Those are different contracts. Its linked consumer demo `taptrading.com` again redirected to a GoDaddy domain-for-sale destination in the web check. No technical API specification, running demo, funded external market maker or commercial price was verified.

**Assessment:** first commercial inquiry candidate, subject to demonstrating the exact future-window touch rule, a read-only quote API and use with our custom Three.js interface. The page does not establish that Tradesmarter funds payouts. No inquiry sent.

## 3. TapTradings.com — software claim, unverified delivery

[TapTradings.com](https://taptradings.com/) advertises five-second grid play, real-time proprietary odds, adjustable house margin, source-code access and integration with user/wallet systems. It is a different domain from the singular Tradesmarter demo; no relationship was established.

No public odds API, independent live client, delivered code or liquidity commitment was verified. Its claims support investigating a software licence, not treating it as an established external market-maker feed. Prioritize behind providers with inspectable interfaces.

## 4. Forsee — documented odds API, different game

The [official API documentation](https://api.forsee.market/) documents `/v1/markets` with directional multipliers and `/v1/prices`. API keys require approved access during rollout. Its market rounds include one, five and fifteen minutes, with expiry/TWAP rules; no touch-band quoting is documented.

There are material documentation inconsistencies: one section calls the price endpoint a round-open snapshot, another says live updates with an approximately two-second cache; the OpenAPI spec retains round-open wording. The page describes engine quotes constrained by a price-aware market maker, while the specification calls odds pool-derived. A push feed remains on the roadmap. These prevent claiming a verified low-latency market-maker service.

The [OpenAPI file](https://api.forsee.market/openapi.json) returned HTTP 200 and is saved locally. No authenticated price/odds response, solvency, liquidity guarantee or white-label licence was verified. This is a secondary lead if the product changes to directional rounds.

## 5. Overtime / Thales — genuine integration model, different contracts

[Thales developer documentation](https://docs.thales.io/for-developers) explicitly supports external apps using its market-making, liquidity and settlement contracts. The [Speed Markets integration guide](https://docs.thales.io/thales-speed-markets/speed-markets-integration) provides APIs for transaction parameters and contract integration. [Overtime's current site](https://www.overtime.io/) advertises directional crypto expiries as short as five minutes.

The [introductory documentation](https://docs.thales.io/thales-speed-markets/introduction-to-speed-markets) describes BTC/ETH, Pyth data and 2× directional payout before fees. Some timing/funding descriptions are historical or internally inconsistent; do not treat them as today's limits or liquidity balances.

A read-only GET of the integration guide's exact example parameters failed DNS for `overtimemarketsv2.xyz`. The [Overtime build-your-own guide](https://docs.overtime.io/build-your-own-speed-markets-app) still cites that host. This environment's failed lookup does not prove the protocol is unavailable. No transaction or contract call was sent. Current endpoint deployment and capital remain unverified.

**Assessment:** stronger evidence of externally integratable market-making infrastructure than a generic white-label claim, but its payout event is the wrong one for Euphoria's cells.

## 6. Deriv — confirmed prices, unsuitable crypto contracts in this check

Connected successfully to the officially documented [public WebSocket](https://developers.deriv.com/docs/options/websocket/) with no account or token. [Active-symbol discovery](https://developers.deriv.com/comparison/active-symbols/) returned BTC/USD (`cryBTCUSD`) and ETH/USD (`cryETHUSD`), and fresh ticks were retrieved for both.

The [contract-discovery interface](https://developers.deriv.com/comparison/contracts-for/) returned only `MULTUP` and `MULTDOWN` for both crypto symbols. These are leveraged directional contracts, not fixed-payout touch-window odds. Deriv's general [proposal API](https://developers.deriv.com/comparison/proposal/) supports quotes, but that does not make unavailable crypto contract types available.

The ticks comparison docs say `subscribe: 0` is accepted; the live service rejected it. Omitting that optional parameter returned ticks successfully. An initial broad symbol-name regex also matched “Netherlands”; it was corrected to require the cryptocurrency market. Both attempts are retained in the evidence. Only public reads occurred; no proposal, purchase, authentication or trade was sent.

**Assessment:** verified price-only possibility for this brief; do not propose its generic Touch/No Touch feature as a verified BTC/ETH grid solution.

## Euphoria and RUSH

Euphoria's [platform documentation](https://docs.euphoria.finance/euphoria/about-the-platform) explicitly says professional market makers continuously quote the squares. The distinction is access: no external developer quote service or commercial white-label programme was established. Its internal app feed is not automatically reusable by a separate product. See [Euphoria - Stack Economics Flow and UX](Euphoria%20-%20Stack%20Economics%20Flow%20and%20UX.md).

[RUSH](https://rush.trade/) remains a partnership lead, not a verified quote supplier. Earlier static inspection established internal pricing paths and a market-maker interface, not supported commercial access. New targeted searches did not establish such an offer. See [RUSH - Stack Economics Flow and UX](RUSH%20-%20Stack%20Economics%20Flow%20and%20UX.md).

## Decision for Maya

**Technical follow-up:** validate Lynx's read-only board integration in a small isolated prototype if the user chooses that route. Keep every multiplier labelled as indicative/simulated and preserve the exact contract geometry and source.

**Commercial follow-up:** obtain a Tradesmarter demo and API specification before considering a purchase. The minimum questions are:

1. Can it quote a bounded price band during a future five-second window, where any touch wins?
2. Can our own renderer consume timestamped prices and per-cell quotes, with quote IDs, size limits and expiry, without embedding their UI?
3. Are multipliers locally modelled, firm house quotes, or competitively sourced from external market makers; who supplies capital?
4. Is paper/sandbox-only use supported, and which exact BTC/USDT, ETH/USDT and BTC/ETH markets are available?
5. What are feed rights, latency limits, commercial fees and supported stake/grid constraints?

No vendor contacted and no purchase made. The later v1 decision selects Lynx public inputs and local paper odds; other suppliers are deferred. No game implementation has begun.

## Follow-up: access without registration

**For the requested Euphoria-style game, public prices plus locally calculated indicative odds are available without an account. A public, account-free feed of firm five-second touch-band quotes is still unverified.**

Lynx is the closest route: the public price/config endpoints were successfully read earlier, and static inspection of the SDK confirms `liveBoard()` calls a local pricer using a downloaded probability table, a price buffer and configuration. Its preview is explicitly less sophisticated than the server's accepted-quote model. On this follow-up, fetched the SDK's exact public probability table without credentials: HTTP 200, 521,812 bytes, SHA-256 `6feaea2d86d14e96f917051b2a568977fd427ded65fea0c3f87f25b396638af8`. The artifact reports table version `2`; this is not the configuration's separate formula-version field. No SDK installed or executed. Thus the model inputs are accessible anonymously; an end-to-end SDK runtime proof is not yet claimed.

For **other contract types**, Polymarket documents public [market discovery](https://docs.polymarket.com/market-data/discover-markets), [order-book/outcome prices](https://docs.polymarket.com/market-data/prices-order-books) and [market streams](https://docs.polymarket.com/market-data/realtime-data). Those prices give market-implied odds for existing listed questions; they cannot be reused as probabilities for arbitrary five-second grid cells. Its [Chainlink TWAP relay](https://docs.polymarket.com/market-data/chainlink-twap) is also documented as credential-free through RTDS, but a 30/60-second time-weighted average is not an instantaneous tick and cannot silently replace the touch-settlement feed. This follow-up inspected documentation, not live Polymarket responses or execution.

The user subsequently accepted this compromise for v1: Lynx public inputs plus local indicative multipliers, BTC/USD and ETH/USD only. This does not preserve Euphoria exact odds. See [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md).

## Saved evidence

- [Public access checks](Attachments/Tap%20Trading%20Research/provider-access-checks-2026-09-20.json): fresh Lynx responses, Deriv requests/responses, Forsee specification receipt and outcomes.
- [Lynx configuration](Attachments/Tap%20Trading%20Research/lynx-provider-config-2026-09-20.json), [ETH price buffer](Attachments/Tap%20Trading%20Research/lynx-provider-eth-prices-2026-09-20.json), [package registry snapshot](Attachments/Tap%20Trading%20Research/lynx-provider-package-2026-09-20.json).
- [Forsee specification](Attachments/Tap%20Trading%20Research/forsee-openapi-2026-09-20.json).
- [Read-only probe script](Attachments/Tap%20Trading%20Research/check_provider_access.mjs). External scripts were not installed or executed.
- [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md) and [Tap Trading Research - Evidence Index](Tap%20Trading%20Research%20-%20Evidence%20Index.md).
