---
type: product-decision
created: 2026-09-20
status: accepted-direction
tags: [Maya, Euphoria, product-plan, fidelity]
---

# Euphoria is the product reference

**User decision, 20 September 2026: our product should look, feel and work like Euphoria.** This supersedes treating Euphoria, RUSH and Lynx as equal design candidates. Euphoria defines the experience; the other teardowns remain engineering and commercial research.

The user's exact clarification was “look and feel like, work like as well.” Success therefore includes interaction, quote acceptance, position lifecycle, balance behavior and settlement feedback—not just a similar screenshot.

Related: [Euphoria - Stack Economics Flow and UX](Euphoria%20-%20Stack%20Economics%20Flow%20and%20UX.md), [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md), [Video Analysis - Price-Time Prediction Grid](Video%20Analysis%20-%20Price-Time%20Prediction%20Grid.md), [Tap Trading - Deep Research Index](Tap%20Trading%20-%20Deep%20Research%20Index.md).

**Locked v1:** [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md) selects Lynx public inputs, local indicative odds, BTC/USD and ETH/USD, and virtual USD. No registration or real trading; exact numeric Euphoria odds are explicitly outside v1. [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md) governs implementation.

**Latest scope clarification:** deliver a playable demo that anyone can open, choose a pair, zoom, adjust stake and tap bets. Price movement decides win/loss; fixed odds decide payout. No account tiers, wallet prompts or production execution workflow. This clarification overrides the earlier production-fidelity requirements where they conflict.

**Sales experience and identity:** the product is **Maya**. [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) specifies ten accepted paper bets per page load, a consultation modal after the tenth, and ten more bets on every refresh. The modal promotes Maya purchase, customisation, launch and full project source-code handover. Use the approved dummy booking URL `https://example.com` for now. Chain/provider/customisation detail stays in separate sales literature.

**Architecture/view requirement:** [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md) defines the user's monorepo and distinct adaptive desktop/tablet/mobile delivery. Desktop is calibrated against the supplied recording; tablet and mobile are purpose-designed adaptations with their own QA evidence, using the same game rules and engine.

## Requirements that remain in force

| Area | Decision |
|---|---|
| Reference | Euphoria's visual and interaction model, with the supplied clip as the measurable visual fixture. The clip's origin remains unproven. |
| Markets | BTC/USD and ETH/USD only, from Lynx public inputs. BTC/ETH and USDT markets are deferred. |
| Controls | One shared allowed stake menu for all visitors; bounded continuous zoom with recovered wheel factors and reset behavior. No VIP/account tiers, invented zoom preset array or all-in stake semantics. |
| Renderer | Three.js remains the requested implementation choice. Observed Euphoria uses custom Canvas 2D and Rive; identical libraries are not necessary for matching behavior. |
| Delivery | A directly playable paper demo with Lynx prices, locally simulated odds and local balance/refill. Reference replay is a developer verification tool. |
| Commercial flow | Maya sales modal after ten accepted bets; new placements resume after refresh, while existing bets settle normally. Developer reference replay bypasses this demo allowance. |

## What “looks like” means

The full-screen chart is the product surface. Preserve the burgundy/plum background, restrained pink grid and dots, faint history, bright white moving price tip, compact corner controls, narrow readable numerals and lime position cards. Preserve how the future grid occupies most of the width and how price/time labels stay aligned with it.

Match proportions, spacing, card geometry, contrast, line weight and animation timing against the original 1642 × 904 clip. The measured color tokens and initial coordinates live in the build plan. They are calibration inputs, not proof of Euphoria's current design tokens.

The visual target does not become RUSH's exchange-style layout or Lynx's Arcade lobby. Those products do not decide our navigation, typography, palette or default game loop. Use our own product identity while reproducing the selected experience.

## What “feels like” means

1. **Direct tapping:** select an available future square without an order form interrupting each placement. The stake persists for subsequent taps.
2. **Immediate acknowledgement:** validate and place the paper bet locally in one tap, freezing the valid displayed odds and debiting once. Show invalid/unavailable feedback without a debit; no confirmation dialog or simulated network delay.
3. **Continuous motion:** chart, grid, price tip, labels and accepted cards share one coordinate transform. Panning, zooming and resizing cannot cause drift or move an accepted contract's boundaries.
4. **Clear outcomes:** a qualifying price touch produces the reference's lime burst, payout feedback and balance credit; a miss fades; rejection explains the cause without charging the stake.
5. **Low interface overhead:** keep balance, stake and market selection accessible without making the game resemble a conventional exchange terminal. On mobile, preserve legibility and prevent a pinch/drag from becoming an unintended tap.

Sound and haptics are calibration items only where reference evidence supports them. The supplied clip had no spoken explanation; no unobserved audio interaction is claimed as recovered.

## What “works like” means

**Documented Euphoria rule:** a square represents a price band during a five-second window. One qualifying touch is sufficient to win; the price need not remain inside or finish inside. [How to tap trade](https://docs.euphoria.finance/euphoria/how-to-tap-trade).

The target lifecycle is:

```text
live paper quote → tap → validate → accept and debit once, or reject without debit
accepted → qualifying touch → credit gross payout once
accepted → window ends without touch → expire
source evidence unrecoverable → void and refund once
```

The accepted multiplier is fixed for that position. A $5 position accepted at 2.51× pays $12.55 total on a win, including the stake. Changing stake, changing market or zooming cannot reprice an accepted position. Multiple independently accepted positions can be active at the same time.

Euphoria documents competitive market-maker quotes and configurable slippage protection. Those remain reference research, not a demo feature requirement. Our local demo accepts the exact valid displayed quote or rejects an expired/unavailable one; it does not negotiate a replacement or expose a slippage setting. Insufficient funds, timing cutoff and shared exposure limits also produce clear feedback. [Platform pricing](https://docs.euphoria.finance/euphoria/about-the-platform), [FAQ](https://docs.euphoria.finance/euphoria/faq).

Repeated taps on one square must be modeled as independently accepted placements under a per-square exposure cap, rather than assumed to overwrite the first position. This is a **Maya target behavior informed by Euphoria's per-trade/per-square limits**; the exact current stacking gesture and aggregation display remain unverified. A retry of the same request must never create another position.

Use the shared demo menu from the implementation plan: $0.10, $0.50, $1, $5 and $10, with $50 total stake per square. These implementation defaults use the recovered standard limits and apply to everyone without tiers. Selecting a size is not an all-in calculation; enforce available balance on placement and allow free paper refills. Recovered zoom is continuous within 0.345–0.9, default 0.6; no fixed preset list was found. Zoom never changes accepted terms.

Win/loss is determined by the sampled price entering the selected band during its window. Odds fix the gross return on that event; they do not trigger a random outcome. A missed complete window returns nothing; unavailable source evidence follows the explicit recovery/refund rule.

## Functional fidelity versus unrecovered internals

| Established reference behavior | Implementation consequence | Remaining uncertainty |
|---|---|---|
| Five-second touch windows | Implement first qualifying touch, then one terminal outcome | Boundary inclusion, jump handling and exact oracle tick policy |
| Best market-maker quote | Separate quote provider from chart and position state | Proprietary pricing, matching and liquidity allocation |
| Slippage-protected acceptance | Demo simplification: accept the valid displayed odds exactly or reject without debit | Production tolerance defaults and rounding convention |
| Provisional and confirmed client state | Immediate local acceptance with idempotent debit and outcome | Production latency distribution and recovery details are outside the demo |
| Oracle-backed settlement | Authoritative timestamped events determine results | Contract/oracle details not recovered from blocked audit and chain reads |

The locked v1 decision authorizes Lynx-derived local indicative odds. This changes numeric pricing fidelity, while the recovered Euphoria controls and position lifecycle remain the reference. Local odds are simulated; no competitive external market-maker quote or real payout commitment is claimed. Missing or invalid model inputs keep the cell unavailable.

Matching the production financial system would require live market-maker liquidity, authoritative oracle rules, wallet authorization, funded settlement, exposure controls and reconciliation. Reproducing the UI does not supply those systems. Current public research identifies their boundaries but does not recover their implementation.

## Fidelity acceptance checklist

| Check | Pass condition |
|---|---|
| Reference sequence | Replay all 53.888 seconds; reproduce known thirteen $5 debits, $12.55/$12.30 credits and $28.67 final balance from $68.82. |
| Visual comparison | Compare fixed frames and motion segments at the reference viewport; record every remaining font, spacing and animation mismatch. |
| Trading lifecycle | One-tap acceptance, stale-quote rejection, insufficient funds, price-driven win/miss, refill and duplicate requests preserve ledger correctness. |
| Controls and multiple positions | Any visitor can use both USD markets, every shared stake choice, recovered zoom and simultaneous positions; accepted bets retain their terms. |
| Live data and recovery | Process authoritative events independently of rendering; identify gaps, suspend affected new placements and apply the specified recovery/void policy. |
| Consultation flow | Modal opens once after the tenth acceptance, no eleventh acceptance occurs before refresh, existing bets finish, and every refresh grants ten more. The CTA opens the configured dummy URL. |

An authenticated walkthrough of Euphoria would add evidence for deposit, withdrawal, current staking limits, profile/history and mobile gestures. Those unobserved screens remain explicit fidelity gaps. This decision records the intended experience and does not claim they have already been reproduced.
