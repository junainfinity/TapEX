---
type: video-analysis
created: 2026-09-20
tags:
  - Maya
  - video-reference
  - trading-game
  - interaction-design
source_file: 2d85614526e5682bc1c198c6fe2bfd0a2f1a998c.mp4
duration_seconds: 53.888
resolution: 1642x904
---

# Video analysis — price-time prediction grid

**The clip demonstrates a short-horizon price prediction game: place a dollar stake in a future time-and-price square, then watch the moving price line either reach that square or miss it.** The interface combines a live-looking Ethereum price chart, changing payout multipliers, one-click position placement, and bright reward effects.

The recording ends with two wins, but the displayed balance is **$40.15 lower** than at the start. The celebrations should not be mistaken for a profitable overall session.

Related implementation plan: [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md).

**Later source research:** Euphoria is a strong candidate for the video's original product. Its public homepage shows the same burgundy/pink chart and neon yellow-green position cards, and its own documentation describes Tap Trading. This is a visual/product match, not verified file provenance. See [Crypto Tap Trading - Existing Products and Binance Mapping](Crypto%20Tap%20Trading%20-%20Existing%20Products%20and%20Binance%20Mapping.md).

**User clarification, 20 September 2026:** the game also supports selecting the lowest or maximum stake and zooming in/out through set levels. These are user-confirmed requirements, beyond what this clip alone establishes. Exact limits, zoom presets, and the MAX control's relationship to available balance remain configurable/unspecified. See [Indian Market Mapping - Zerodha APIs and Game Feasibility](Indian%20Market%20Mapping%20-%20Zerodha%20APIs%20and%20Game%20Feasibility.md).

## Source and review coverage

[reference-video.mp4](Attachments/Price-time%20grid%20demo/reference-video.mp4)

- Original supplied file: `~\Downloads\2d85614526e5682bc1c198c6fe2bfd0a2f1a998c.mp4`.
- Duration: **53.888 seconds**; image size: **1642 × 904**; video rate: **30 fps**, with an audio track.
- Review covered the entire timeline using 108 chronological frames at half-second intervals, full-resolution inspection of important states, a denser 10 fps examination of the stake selector, and the final frame. This is a frame-based review, not a claim that every original frame was individually inspected.
- The complete audio was processed with speech recognition, including a second pass after amplification. Neither pass recovered speech. The audio is quiet; this note does not claim a verified narration transcript or identify its non-speech sounds.
- The product name, website, code, pricing model, and backend are not identified in the footage. UI prompts such as “Try another square” are observations from the recording, not instructions to operate an account.

Times below are approximate **video elapsed times**, not the chart's clock labels. “Observed” means visible in the clip; “inferred” means a likely explanation of that evidence.

## 1. What is on screen

![00-00-interface.jpg](Attachments/Price-time%20grid%20demo/00-00-interface.jpg)

| Element | Observation | Meaning / confidence |
|---|---|---|
| Main canvas | A dark burgundy chart fills the screen, without a visible app sidebar or order-entry panel. | The chart itself is the interaction surface. |
| Top-left pill | Ethereum-shaped icon, price with two decimal places, and dropdown chevron. Initial price is about **$2,992.58**. | Strong indication of an ETH price instrument; the quote source is unknown. |
| Price trace | Thin pink historical line, pale/white newest segment, glowing endpoint. | Past path and current price share one continuous trace. |
| Right edge | Price labels in roughly **$0.50** steps and a moving pink current-price badge rounded to one decimal place. | Price bands define the grid rows. |
| Bottom edge | Clock labels approximately every **15 seconds**; three grid columns between major labels. | Individual columns appear to represent **5-second** windows. |
| Future grid | Squares to the right of the price tip display multipliers such as `2.00X`, `4.68X`, and `25.6X`. | These are offered payouts/odds, not trade sizes or volume. |
| Bottom-left pill | Wallet-like icon and dollar balance, starting at **$68.82**. | Available game/account balance. Whether this is real or simulated money is not shown. |
| Bottom-right pill | Selectable stake amount, initially **$1**, soon **$5**. | Sets the amount for subsequent placements. |
| Small circular control | A four-direction/recenter-like icon appears near the lower right. | Exact behavior is not demonstrated clearly enough to identify it with certainty. |

The price tip generally stays near the left third of the viewport. Time advances by scrolling the chart and positions leftward; the price scale also shifts vertically. The future grid dominates the remaining width. Accepted positions are attached to chart coordinates rather than fixed screen positions.

The recording starts partway through a chart history. There is no opening tutorial, login, deposit, or market-selection flow.

## 2. What a grid square represents

**Strong inference:** each selectable square is a prediction about a price band during a specific future time window.

1. Choose the stake amount.
2. Click a future square at the desired time and price.
3. A bright card shows the stake and a multiplier.
4. The square moves toward the current-time position as the chart scrolls.
5. A successful square pays out and animates; unsuccessful squares dim and disappear after their window passes.

The result appears to depend on the **price path entering a square during its window**, rather than only the closing price at one expiry instant. Near the end, two vertically adjacent squares in the same time column win at different moments as price moves down through them. That is strong evidence for a touch/intersection rule. Exact boundary handling, tick interpolation, and official settlement rules remain unknown.

The grid is richer than a simple “up or down” choice: the user chooses both **where** the price may go and **when** it may get there. Multiple squares can be active simultaneously, including adjacent rows and columns.

### How the multipliers behave

Unselected grid multipliers change as time and price change. Cells far from the current price often offer larger multipliers, especially when little time remains to reach them. Values are not simply increasing with horizontal distance: the relationship depends on both axes.

Accepted cards appear to retain their own quoted multiplier while the surrounding grid reprices. Brief value changes during initial placement may reflect quote confirmation or animation; they do not establish the original pricing protocol.

The clip does **not** reveal an implied-probability formula, volatility estimator, house margin, liquidity source, or risk engine. The displayed multipliers alone cannot establish any of those.

## 3. Complete sequence

| Video time | What happens | What it establishes |
|---|---|---|
| **00:00–00:02.5** | Chart is already moving. Balance is $68.82. The stake control changes from $1 to $5. | Stake selection and live-looking chart updates precede placement. Intermediate animated digits are not necessarily separate presets. |
| **00:02.5–00:05.5** | Four $5 cards are placed in a vertical stack in one future column. Balance settles at $48.82. | Four separate stakes, with immediate visual feedback. |
| **00:06.5–00:07.5** | Two further $5 cards appear in the next column. Balance becomes $38.82. | Six positions can coexist and form a small two-dimensional cluster. |
| **00:07.5–00:12** | Price rises above much of that cluster; the cards move left with the timeline. | Merely choosing a nearby square does not guarantee the path will enter it at the right time. |
| **00:12–00:14.5** | Two additional higher-price squares are purchased. Their settled multipliers include **2.25X** and **3.14X**. Balance becomes $28.82. | The user can continue placing positions while earlier ones remain unresolved. |
| **00:15.5–00:17.5** | A new card flashes orange/red. A toast says **“Try another square.”** Older cards begin fading. | Placement can be rejected. The rejected-looking card is distinct from a normally expiring card. The exact rejection cause is not shown. |
| **00:18–00:26.5** | Remaining early cards pass through their windows, fade, and disappear. No payout toast appears; balance settles/remains at $28.82. | The first eight accepted $5 positions produce no visible returns. |
| **00:26.5–00:29.5** | The board is temporarily clear of positions; the chart keeps moving. | The game is continuous rather than a screen transition between rounds. |
| **00:29.5–00:31.5** | Two higher-price cards are added, with settled values **3.61X** and **2.61X**. Balance reaches $18.82. | A second group begins. |
| **00:35–00:37.5** | Several rapid placements are attempted near the current price. One orange/red card shows **2.07X** and “Try another square.” Accepted nearby cards include **1.98X**, **2.51X**, and **2.46X**. Balance settles at $3.82; **“Insufficient balance.”** appears on another attempt. | There are placement constraints and a balance check. Fast provisional changes must not be counted as final accepted stakes. |
| **00:38–00:40.5** | Five accepted cards remain visible; the chart begins rising again. | Rejected attempts do not remain as ordinary active positions. |
| **00:40.5–00:44.2** | The stake control is cycled through $10, $50, $100, $200, $500, and back to $1. Existing cards remain $5. | The stake selector affects future placements only. No new accepted bet is visible in this sequence. |
| **00:45.5–00:46.5** | Earlier squares dim. Price enters the upper of the two later adjacent cards. A neon burst appears and a toast says **“You won $12.55”**. Balance rises from $3.82 to $16.37. | First successful settlement: $5 × 2.51 = $12.55. |
| **00:49–00:49.5** | Price moves down into the remaining lower card. Another burst appears and a toast says **“You won $12.30”**. Balance reaches $28.67. | Second successful settlement: $5 × 2.46 = $12.30. |
| **00:50–00:53.888** | All position cards are gone. Reward text/toasts fade while the chart continues. The stake selector is $1. The final inspected price is about $2,992.53 and balance is $28.67. | No summary screen or explicit end-of-round screen is shown. The recording simply ends. |

## 4. Balance and payout reconstruction

The settled balances reconcile exactly:

| Item | Amount |
|---|---:|
| Opening balance | $68.82 |
| First group: eight accepted $5 stakes | −$40.00 |
| Balance after first group | $28.82 |
| Second group: five accepted $5 stakes | −$25.00 |
| Balance before wins | $3.82 |
| First payout: $5 × 2.51 | +$12.55 |
| Second payout: $5 × 2.46 | +$12.30 |
| Closing balance | **$28.67** |
| Change over the recording | **−$40.15** |

This supports **13 accepted positions, 2 winners, and 11 positions with no visible payout**, assuming no hidden external balance adjustments. Total accepted stakes are $65; total credited payouts are $24.85.

The multiplier represents **gross return including the stake**, consistent with the displayed debits and credits. The first winning position contributes $7.55 net after its $5 stake; the second contributes $7.30. Those individual gains do not offset the other $55 in stakes.

Rejected attempts may briefly show a provisional card or balance animation before reverting. They must not be counted just by counting every card that flashes on screen.

## 5. Visual language and interaction feedback

### Base scene

The background is a deep plum/burgundy gradient with a subtle vignette. Sampled reference pixels include approximately **#361727** in an upper background area and **#2B1220** elsewhere. Control interiors are near **#1A0A13**. These are compressed-video samples, not authoritative original design tokens.

Grid lines and small intersection dots use muted pink/magenta. Historical regions are dimmer than the future quote area. The result is a continuous chart rather than a collection of independent boxes.

Numbers use narrow, compact typography. Chart labels and odds are much quieter than accepted positions. The exact font cannot be established from the clip alone.

### Active cards

![00-08-5-active-positions.jpg](Attachments/Price-time%20grid%20demo/00-08-5-active-positions.jpg)

Cards nearly fill their cells, with rounded corners, a bright pale outline, a yellow-green center, and a soft glow. The stake is the large dark label; the multiplier is smaller beneath it. Cards pop into view, sometimes briefly overshooting/fading during placement.

Some active cards glow more strongly as the path gets near them. That may be proximity feedback, hover, or a timed animation; the exact trigger is not proven. Multiple selected cells remain separate cards, even when touching edges.

### Rejections and exhausted balance

![00-16-5-rejected-position.jpg](Attachments/Price-time%20grid%20demo/00-16-5-rejected-position.jpg)

The orange/red cap on a yellow card is a distinct warning state. “Try another square.” appears in a translucent rounded toast near the top center. Its cause could be a stale quote, cutoff, invalid square, or another constraint; the recording does not resolve which.

![00-37-insufficient-balance.jpg](Attachments/Price-time%20grid%20demo/00-37-insufficient-balance.jpg)

At $3.82, a $5 request triggers “Insufficient balance.” This is a separately identifiable failure. Toasts can stack rather than immediately replacing each other.

### Expiry and wins

Unsuccessful positions become muted/translucent and then disappear, with no equally prominent loss celebration or result panel.

![00-46-5-first-win.jpg](Attachments/Price-time%20grid%20demo/00-46-5-first-win.jpg)

Successful positions disappear into a bright yellow-green, irregular energy-ring burst with sparks. Floating payout text rises/fades near the hit location, while the top toast gives the precise amount and the bottom balance updates. The first floating label shows roughly `+$12.5`, while its toast explicitly states `$12.55`; preserving that distinction matters for a faithful recreation.

![00-49-5-second-win.jpg](Attachments/Price-time%20grid%20demo/00-49-5-second-win.jpg)

The second effect repeats with about `+$12.3` and the exact `$12.30` toast. Both victories occur without interrupting the chart.

### Stake selector

![stake-selector-sequence.jpg](Attachments/Price-time%20grid%20demo/stake-selector-sequence.jpg)

Stable values observed across the clip are **$1, $5, $10, $50, $100, $200, $500**. Some transition frames show partial/interpolated digits; those should not be invented as additional presets. The control cycles back to $1. The chart remains interactive-looking while these values change.

## 6. Product understanding

The main design decision is to make **the chart itself an order-entry surface**. A user expresses a prediction spatially, sees a quoted return directly in the target region, and watches the path approach it.

The interaction has three connected loops:

1. **Prediction:** observe the current path, compare nearby time/price squares, and choose a stake.
2. **Anticipation:** watch purchased squares approach the present while quotes and price keep moving.
3. **Resolution:** missed squares quietly expire; hits trigger conspicuous animation, payout text, and balance changes.

The bright accepted cards make a portfolio of tiny short-term predictions legible at a glance. Vertical clusters spread predictions across price bands; horizontal clusters spread them across time windows. The clip demonstrates both patterns, without proving that either is a successful strategy.

Several subtle details are central to the experience: the pale leading edge of the price line, constant scrolling, stable quotes on purchased cards, instant stake feedback, precise wallet arithmetic, and uninterrupted reward animation over the chart.

## 7. What remains unknown

| Unknown | What can safely be concluded |
|---|---|
| Product identity and implementation | The screenshot alone does not establish an app name, framework, renderer, or hosting stack. |
| Real market versus simulation | The interface looks like ETH pricing, but the source and authenticity of the feed are not shown. |
| Settlement definition | Touching a price band within a time window is strongly supported; exact endpoints, tick gaps, and ordering rules are not. |
| Quote calculation and rejection reason | Multipliers update dynamically and some placements fail, but the algorithms are hidden. |
| Unseen flows and audio | Login, deposits, withdrawals, mobile layout, dropdown contents, and a verified soundtrack are not available from this recording. |

**Recreation implication:** reproduce the visible screen and demonstrated states first, using explicit replacement rules for hidden behavior. The companion [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md) turns this evidence into an implementation sequence and measurable checks.
