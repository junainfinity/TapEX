---
type: development-node
created: 2026-09-20
status: planning-three-pass-reviewed
node: N4
amendment_qa_passes: [1, 2, 3]
tags: [Maya, development, Three.js, experience, QA]
---

# N4 — Playable board, controls and feedback

**Deliver Maya's Euphoria-style board with two selectable markets, bounded zoom/stakes, direct paper bets and clear price-driven outcomes.** This node plans the experience; no application, browser check or performance result has been produced by this document.

**Latest scope amendment:** deliver a pnpm/Turborepo monorepo with distinct desktop, tablet and mobile experiences. Adaptive views share one engine/session/ledger; they are not scaled copies of one desktop layout. The three original planning passes below are retained, with three amendment review/correction passes documenting this subsequent requirement.

N4 belongs to [Maya - Development Graph](Maya%20-%20Development%20Graph.md), with workspace details in [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). Its authority is [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) and [Maya Development - N1 Foundation](Maya%20Development%20-%20N1%20Foundation.md). [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md) supplies measured reference targets, not authority to restore obsolete providers, tiers or menus.

## Dependencies and ownership

| Edge | Consumed contract | N4 obligation |
|---|---|---|
| N1 → N4 | Config, `DecimalValue`, `CellTerms`, DTO vocabulary, units and rejection reasons | Import one schema; never derive accounting terms from rounded pixel coordinates. |
| N2 → N4 | Normalized `PriceSample`, `InputHealth`, immutable `QuoteSnapshot`, aligned clock/model metadata | Render actual source state and valid offered cells; retain presented quote identity for input. |
| N3 → N4 | Ledger/balance, immutable `PositionSnapshot`, `PlacementResult`, `PositionChanged`, acceptance API | Emit intents; display committed results. Renderer never accepts, settles, debits or credits a bet. |
| N4 + N5 → N6 | Global modal and page allowance presentation, integrated downstream | Independently verify shared presentation ports with harnesses; N6 joins the real controller/board. No reciprocal node-exit dependency. Backdrop stops input while settlement continues. |
| N4 → N6 | Calibrated scene, accessible controls, replay/checkpoints and test fixtures | Supply measurable visual/input evidence and unresolved fidelity limitations. |

Scaffolding may use explicit developer fixtures before N2/N3 are implemented. Prospect-facing live play cannot ship until both markets produce valid useful quotes and the engine has passed its accounting/recovery gates. The demo has no chain selector, liquidity-provider panel, technical quote controls, account tiers or real-money workflow. Public branding says **Maya**; Euphoria names/assets are reference evidence only.

## Planned implementation files and public surface

All paths below are future files under monorepo root `<repo>`; the vault holds the plan and comparison artifacts. N1 owns pnpm/Turborepo workspace declarations, package dependency rules and pinned versions.

| Files | Ownership/output |
|---|---|
| `packages/game-ui/src/scene/{BoardScene,GridLayer,PriceTrace,PositionLayer,WinEffects}.ts` | Orthographic Three.js scene, bounded grid/trace/card/effect resources; read-only scene snapshots. |
| `packages/game-ui/src/view/{ViewTransform,CameraController,PointerMapper}.ts` | One invertible logical-pixel ↔ time/price transform for geometry, labels, picking and world anchors. |
| `packages/game-ui/src/controls/`, `consultation/`, `styles/`, `theme/referenceTheme.ts` | HTML controls, balance/count/results, focus and announcements, sampled reference tokens. |
| `packages/game-ui/src/input/InteractionController.ts`, `layouts/{desktop,tablet,mobile}/`, `layouts/AdaptiveLayout.ts` | Canonical placement intents; distinct responsive layout/composition/input/resource policies. |
| `apps/demo/src/bootstrap.ts`, `apps/demo/src/dev/ReferenceReplay.ts`, `apps/demo/fixtures/reference-checkpoints.json`, `docs/visual-fidelity.md` | App-level composition and single initialization; developer-only isolated replay and fidelity report. |

The scene consumes snapshots and events, not a mutable engine store. It exposes resize/render/dispose and focused-cell actions; test hooks expose projected bounds, visible quote IDs and input intent events. N6 chooses the test harness; hooks must not create a second placement or settlement route. `@maya/game-ui` imports only shared `contracts`/`config` packages and accepts injected read snapshots/actions; it cannot import `engine`, `pricing` or `market-data` sideways, or create market clients, IndexedDB or page allowance. `@maya/demo` composes all six packages once. Use each package's compiled ESM/type exports, not private filesystem deep imports. Conditional `apps/feed-relay` belongs to N2/N6 if direct browser access fails; UI contains no provider transport implementation. N5's document/modal lifecycle wiring lives in `apps/demo`, while reusable modal/control presentation may use `game-ui` components.

Canonical DTO usage: prices/bounds are `DecimalValue` until explicit display projection; money is integer cents encoded as decimal strings in shared DTOs; displayed multiplier comes from integer-string `grossX100`; positions are `open | won | lost | refunded`. `PlacementIntent` contains `requestId`, `pageLoadId`, `quoteId`, revision, `stakeCents` and `cellId`. The stable `cellId` is N1's normalized market/window/bounds identity, not an instance ID or model revision. Render instance IDs map to this identity but never replace it.

## Observable settings and appearance

| Area | Exact adopted behavior or initial measured target |
|---|---|
| Markets and cells | BTC/USD and ETH/USD only; five-second epoch-aligned windows; BTC $10 and ETH $0.50 bands. A market switch changes the view/quotes, not existing position terms. |
| Zoom | Fresh `0.6`; continuous `[0.345, 0.9]`; zoom in multiplies by `1.1`, out by `0.9`, then clamps. Buttons/wheel use factors; pinch is continuous and clamps. No preset levels. Reset returns to `0.6`. |
| Cell projection | `logicalCanvasHeight / 6 × zoom` in CSS/logical pixels, independent of DPR. At 904 logical pixels and 0.6 this is 90.4 pixels; frame-estimated 91–92 pixels is a calibration observation, not a conflicting constant. |
| Stakes | `[10, 50, 100, 500, 1000]` cents; initial 100 cents. Raise/lower steps through the list and stops. Explicit minimum/maximum actions select $0.10/$10. No tiers, $25 or $50 bet choices. N3 enforces the $50 aggregate same-cell cap. |
| Virtual funds | Display $1,000 starting balance/default refill through N3's cents ledger. Refill adds $1,000; it never resets ten-bet allowance or open contracts. |

At the reference **1642 × 904** viewport, start with a full-bleed burgundy board; current-price tip near x475 (29% width); asset control around (12,18), 165×43; wallet bottom-left around 12px inset and 44px above bottom; stake control around (1533,815); selected cards nearly fill a cell with rounded narrow pale edges. These are initial measurements to refine against saved crops, not pixel-perfect claims. Time labels repeat every 15 seconds and price labels follow the selected asset band.

Reference starting colors: plum `#361727` / `#2B1220`, control interior `#1A0A13`. Sample grid, active-card lime, text, opacity and glow from the saved images during calibration. Match muted magenta lines/intersection dots, fading historical region, pink trace/white current tip, lime accepted cards and precise stake/multiplier typography. Keep colors, spacing, fonts and effects in `referenceTheme`; record any unidentified font/icon/audio substitution. No invented sound is needed to claim fidelity.

Use a shared view transform and orthographic camera; pool text/cards/particles and keep historical traces bounded. DOM labels project using the same transform. DPR affects render resolution only. Logical pointer hit rectangles and visual rectangles must agree at min/default/max zoom and after resize. Initial visual acceptance targets are geometry/anchor deviation ≤2 logical pixels at frozen reference checkpoints and card/label alignment ≤1 logical pixel; record any excluded region or revised target with evidence. These are Maya QA thresholds, not measurements already achieved.

Pointer picking must choose one cell at a visual shared edge: use a documented half-open picking rectangle/floor index, selecting the higher time/price bucket at an exact world boundary. This is an input-selection tie-breaker only. It cannot change N3's inclusive price settlement, where an already accepted bet on either adjacent band can win. Generate cell terms from canonical bucket indices/exact decimal bands, not the floating-point price reconstructed from a pixel. Convert relative offsets to scene floats only after preserving the exact domain identity.

## Price truth, outcomes and feedback

**Price samples decide hits; fixed accepted odds decide payout.** The authoritative trace is composed of source-time sample markers. Smooth camera motion is allowed; smoothing cannot invent source observations, overshoot price, emit hit events or animate a convincing solid touch without a qualifying sample.

Decorative connectors between samples use a visibly subdued/dashed treatment. For an accepted card's active time/price rectangle, clip decorative connectors across unobserved intervals rather than drawing an apparently authoritative crossing through the card. Show a hit marker/burst only at N3's qualifying source sample. A sample jump from below a band to above it without an in-band sample is not drawn as a winning contact. A brief help description may say “Hits use recorded price updates”; it must not be a large technical onboarding screen. This sampled-trace treatment is an intentional adaptation to our feed, to be documented beside the reference-fidelity report. N2's model/event calibration remains a feasibility gate, not solved by drawing a smoother chart.

Read only N2-validated observations. A malformed/conflicting sample may appear in developer diagnostics but never as an authoritative plotted hit. After a source gap, distinguish the gap instead of joining the last good point to a recovered point with a solid synthetic trace. A visible latest-price age/connection state must prevent a frozen quote from looking live. Model bounds determine the available cell horizon; N4 cannot fill unavailable areas with invented multipliers merely to resemble the recording. N2's viewport-independent ModelCandidateCoverage and N4/N6's separate ViewportPlayableCoverage both remain mandatory; only the latter varies with zoom and screen layout.

N3 uses time `[start, end)` and inclusive price `[lower, upper]`. An exact shared price edge can qualify both adjacent accepted cells; the renderer must support two outcome effects at that coordinate. Colors and text communicate `won`, `lost` and `refunded`; do not rely only on color. Expiry without complete evidence stays an engine-managed open/recovering position until resolved/refunded, never a locally inferred loss.

| State/event | Player feedback |
|---|---|
| Valid offer | Readable gross multiplier; hover/keyboard focus shows selected square and potential total return for selected stake. |
| Intent pending | Brief subdued outline/busy cue; no accepted stake card, balance credit/debit animation or allowance advance until N3 commits. |
| Accepted `open` | Stable stake/multiplier card, exact balance and count update; concise acknowledgement. Repeated bets on one cell preserve each position's odds/return in details. |
| Won / lost / refunded | Distinct result label and finite effect; exact credited total/refund from N3. Retain a compact recent result history after the card leaves the viewport. |
| Rejected / unhealthy | Typed, brief explanation; no lingering accepted card. Too-late/expired offer: “That square changed. Try another.” Funds: “Not enough paper balance.” Stale/recovering: visible connection state and paused new bets. |

Show total return distinctly from profit: $5 at 2.5× has $12.50 total return, $7.50 profit. Reuse N1/N3's payout-format helper; for $0.50 at 2.01× show/credit $1.01 with half-up cents rounding. Never recompute terminal returns from a floating multiplier or rounded DOM string.

Changing pairs keeps the engine subscribed to all needed market histories for open positions. A cross-market result updates balance/history and announces the market even when its card is offscreen. Pair-specific loading/unavailable state does not erase another market's open positions. Do not keep an old pair's price/quote briefly under the new pair label; switch identity and status atomically.

## Distinct desktop, tablet and mobile profiles

These breakpoints and performance budgets are **proposed Maya defaults**, not recovered Euphoria values. Resolve layout from the outer game host's available CSS size after safe-area/visual-viewport constraints but before subtracting profile-specific controls, then use pointer/hover capability to adapt input; do not infer device identity from user-agent text. This avoids a layout feedback loop where adding a dock changes the measured height and repeatedly switches profiles.

| Profile | Proposed selection | Composition, input and resource policy |
|---|---|---|
| Mobile/compact | Container width <768px **or** usable height <500px | Compact top pair/price line; bottom touch dock groups stake and zoom with balance/count nearby; limited simultaneous toasts; results expand on request. One-tap board remains primary, no mandatory trade form. Start with DPR cap 1.5 and lower pooled particles/glow; target p95 frame time ≤33.3ms on declared phone hardware. |
| Tablet/medium | Not compact, and width <1200px; also coarse-primary-pointer layouts below 1440px | Dedicated touch rail instead of widely separated desktop corner controls; readable split market/price header; stake/zoom and results arranged for two-handed landscape or bottom-reachable portrait. Touch and optional keyboard/mouse both work. Start with DPR cap 1.5, medium effect pool; target p95 ≤20ms on declared tablet hardware. |
| Desktop/wide | Remaining roomy containers | Calibrated full-bleed reference composition with corner pills, hover focus and wheel/keyboard paths; retain touch support if available. Start with DPR cap 2 and full bounded reference effects; target p95 ≤16.7ms on declared desktop hardware. |

`hover` and actual `pointerType` determine affordances independently of layout: a connected mouse on a tablet can hover; a touch laptop still cancels pinch/drags. A narrow desktop window gets compact composition without losing keyboard/mouse support. Profile labels describe available space and interaction, not guaranteed hardware detection. Both tablet orientations receive intentional placements rather than a desktop CSS scale transform.

Create persistent scene/control presenters and reflow them on profile changes. Do not remount app initialization, reset zoom/stake/selected pair, subscribe a second feed, reset the page allowance or recreate the ledger. Capture a stable world anchor across resize, cancel an in-progress gesture on any profile/capability transition, recompute view projection and keep accepted rectangles tied to the same terms. Camera and render-quality reconfiguration reuse the same scene/controller. Safe-area insets, orientation and `visualViewport` changes can reduce usable space; do not leave a dock or modal action underneath a notch, browser toolbar or virtual keyboard. No text input is needed for normal play; exercise virtual-keyboard intrusion through a controlled viewport/browser accessibility test without adding a needless player text form.

For short mobile landscapes and zoom minimum, grid cells may be smaller than 44px under the exact recovered formula. Do not enlarge overlapping grid hitboxes or secretly change zoom limits/band geometry. Keep controls ≥44px, offer zoom buttons and an optional accessible cell-navigation/activate path using large controls; default board tapping stays one action. N6 must demonstrate that real touch selection remains usable at declared dimensions, and report limitations rather than assert every square meets a 44px target.

Profile resource caps adjust drawing only: pool sizes, glow/effect detail, text update work and DPR may be tuned after measurement; source cadence, quote validity, settlement, ledger, allowance and accepted odds stay identical. Reduced motion has priority over every profile's normal effects. A breakpoint change while the consultation is open reflows the same modal without reopening it or changing its focus/allowance state.

## Live chart rectangle and visible quote coverage

This section corrects graph pass 1's narrow-screen geometry gap. The researched projection remains `cellPx = logicalCanvasHeight / 6 × zoom`, but `logicalCanvasHeight` is the actual chart rectangle, not the entire tall phone host. Profile selection still uses the outer host before chrome. Compute an unobscured chart region after allocating profile controls; controls/axis gutters cannot cover cells counted as playable.

Proposed Maya layout values: live source-tip anchor fraction `a` is desktop .29, tablet .24, mobile .18; right-axis gutter `g` is 48/44/40 CSS px respectively. Only the desktop anchor approximates the measured reference. Let `W` be chart width, `availableH` its available height and `F = W × (1-a) - g` the future interaction width. N2's measured policy must supply a conservative `maxHealthySourceAgeS` bounding `clockUpperNow - latestSourceTime` whenever new quotes are enabled; do not guess this unresolved bound. Set `requiredFutureS = maxHealthySourceAgeS + compatibleLeadTimeS + 3 × 5`. At zoom maximum .9, choose:

```text
chartH = min(availableH, F × 6 × 5 / (.9 × requiredFutureS))
cellPx = chartH / 6 × zoom
futureSecondsVisible = F × 5 / cellPx
```

The tip's source time is the chart's horizontal anchor. The extra three windows cover worst epoch alignment plus two complete eligible windows after the lead cutoff, including the strict-equality boundary. Use the measured policy bound rather than instant lag to avoid height jitter on every tick. Place spare portrait height in readable controls/results/spacing rather than stretching the grid. A nonpositive region is a layout failure; when health/policy is unresolved, show loading/unavailable instead of assuming a tradable horizon. This geometric rule guarantees time space under the policy bound, **not model quote availability**. Record any reference-height reduction as an adaptive fidelity deviation, never a new zoom value.

Default live-follow vertically centers the latest source price, using the same exact-world projection for all layers. N4/N6's ViewportPlayableCoverage requires at least one fully visible eligible cell in 95% of healthy post-warmup instants for each declared viewport, market and min/default/max zoom, separately from N2's 42-candidate model gate. Replay the captured time stream at 100ms steps, covering the entire five-second phase; include exact-boundary and immediately-before/after fixtures. Count only complete cells inside the unobscured region with a readable multiplier and an available valid quote. Partial cells may be drawn as context but are not clickable and do not count; keyboard focus/reveal must bring the full cell inside before activation. Tiny but nonoverlapping cells retain the accessible large-control navigation path.

User panning can intentionally leave the quote area. Keep a visible “Back to live” control restoring the default anchor without changing zoom, market, stake or terms, and a “Next available square” accessible navigation action that reveals the nearest valid canonical candidate (time first, then distance from spot), without placing a bet. Recheck eligibility after reveal before activation. User-panned states are reported separately from the default-view denominator; empty default views are never excluded merely because navigation could reveal another quote. Revealing another square cannot fabricate odds. Existing positions remain in canonical world coordinates and results remain available when offscreen.

The deterministic geometry fixtures must include tall portrait 390×844/360×800, tablet portrait and short landscape at zoom .9, all epoch phases and the maximum healthy source age. Assert two complete future windows fit horizontally. Actual quote/readability/selection success remains a separate runtime gate and may require a documented layout correction without changing the researched contract.

## Atomic inputs and accessibility

1. On primary pointer down, latch the actually presented `cellId`, quote/revision, selected stake, page ID and view revision. Track the pointer sequence; a tap uses the displayed offer, not a newer hidden quote.
2. On release, emit one intent only if the sequence remains a tap on the same logical target and controls/modal did not consume it. N3 validates timing/quote/allowance/caps and accepts the latched quote exactly or rejects. A market change, viewport resize, multitouch entry or active drag cancels the pending tap.
3. Once accepted/rejected, clear that input sequence. A transport/store timeout is uncertain: retry the same `requestId`, never mint a second bet automatically. Distinct intentional taps may place additional bets under the cap and ten-bet allowance.
4. Zoom/pan gestures only change the view. Movement beyond the implementation's documented gesture threshold cancels tap candidacy; a second pointer cancels it immediately. Once canceled, returning the finger to its start does not resurrect a tap. Release/cancel/lost-capture/focus loss resets the gesture.
5. HTML controls capture their own gestures and cannot bubble into board betting. Wheel/pinch clamping never resets stakes/allowance. Consultation overlay consumes all placement input while leaving render/engine clocks alive.

The gesture movement threshold is a usability value to calibrate with N6, not recovered Euphoria evidence. Buttons provide zoom/stake endpoint access without relying on wheel/pinch. Controls should be at least 44 CSS pixels where possible; smaller visual pills may use larger invisible padding without overlapping board actions. The profile-specific layout retains price/time labels, balance, paper indicator and count without covering every tradable square. Start desktop validation at 1642×904/1280×720 with fine pointer; tablet at 768×1024, 1024×768, 820×1180 and 1180×820 with coarse pointer; phone at 390×844/844×390. Also test a coarse 1366×1024 tablet against the medium-profile rule. These are planned viewports, not already tested physical devices; N6 must include real-device gesture evidence in its declared matrix.

Apply custom gesture handling to the board surface only; do not disable browser zoom globally. Suppress synthetic click events following a handled pointer sequence and treat the tenth-bet overlay as a new input boundary: all pre-overlay pointer/key sequences are consumed before any modal control may activate. A suspended or restored document cancels pending gestures and waits for N2/N3 revalidation before another placement. Same-document back/forward-cache restoration preserves the existing allowance; N4 remounts cannot create a new document identity.

Expose a keyboard-operable HTML representation of currently offered cells using a bounded roving focus target, not thousands of tab stops. Arrow keys move the focused cell; Enter/Space produces the same one-intent path; held-key repeats do not auto-bet. Announce market, price band, time window, multiplier and selected stake on focus. Provide visible focus; Tab reaches pair/stake/zoom/refill/results; chart render does not steal focus. Announce committed outcomes/health through a polite live region with batching, not every price sample.

Respect reduced motion by suppressing bursts/rolling digits and using immediate readable results. The same arithmetic/results and hit evidence remain visible. Text/controls require measured contrast while preserving the reference palette where possible. Sound cannot be the sole feedback. N5 owns dialog focus trap/Escape/restore; N4 supplies a stable status/results focus target after dismissal, since placement is then exhausted.

## Developer replay and prospect sales gate

The prospect demo counts ten **accepted new** bets across both markets per document. N5 displays the consultation after the tenth commit; N4 shows that committed card first and prevents the triggering pointer from activating the newly appearing dialog. Modal opening/dismissal is not a render pause or pair unsubscribe. Dismissal restores results access while new placement remains closed until refresh. N3/N5 own count/reload persistence semantics; N4 never derives count from visible cards or history length.

The offer is reconciled from N5's app-level state, not solely a one-time event: `acceptedCount === 10 && !offerShown` must still present if a view missed the commit notification. N5 acknowledges successful presentation with the shared `pageLoadId`/`presentationId`; N4's reusable dialog presentation must not acknowledge before it exists. N5 retains open-versus-dismissed state above adaptive layouts. Changing layouts therefore preserves an open modal and never reopens a deliberately dismissed one, resets count or acknowledges an invisible offer.

The separate developer replay reproduces the supplied 53.888-second recording, including 13 historical positions, initial balance $68.82 and final $28.67. The 13-position count is the saved ledger reconstruction from visible debits/credits, not a recovered server record. Its historical stake cycle and recorded rejection/outcome events intentionally bypass prospect allowance and current stake menu. Replay uses isolated fixtures and wallet state; running it cannot debit live demo funds or consume page allowance. Replay controls are development-only and absent from the prospect bundle/interface. The reconstructed path is not original tick data and its quotes do not prove current model parity.

Capture the opening board, active-position view, major win/rejection and ending frame at fixed reference times from the source note. Compare crops and overlays at 1642×904 using original 30fps footage for final timing calibration. Save screenshot diffs, geometry measurements, substituted assets and remaining deviations in the fidelity report. Freeze visual fixture clocks; never make a screenshot test depend on live prices.

## Future acceptance cases

Every case below is **NOT RUN**. N4 supplies component/input evidence; N6 repeats relevant cases in the integrated browser journey.

| ID | Concrete check and expected result |
|---|---|
| N4-01 | Open anonymously: Maya, correct paper indicator, only BTC/USD and ETH/USD, $1 selected stake and shared balance; no chain/provider/tier configuration. |
| N4-02 | At .6 test wheel/buttons through both bounds: each step×1.1/×.9 then clamp .345/.9; pinch remains continuous; reset=.6; no mutation of accepted terms. |
| N4-03 | Select/raise/lower/min/max through 10/50/100/500/1000 cents, stopping at endpoints; every selection is inert until a bet; no $25/$50 option. |
| N4-04 | Project/invert known cells at all zoom bounds, viewport/DPR combinations and follow-price movement; exact visual edges select one canonical cell without changing inclusive settlement; correct five-second/BTC10/ETH.50 bounds persist. |
| N4-05 | Tap while quotes refresh: exact presented revision accepted unchanged if valid, otherwise rejected with zero debit; no silent reprice or new request on timeout. |
| N4-06 | Rapid distinct taps and retried identical intents: N3 outcomes drive exact cards/count/balance; same-cell positions can have different locked odds without misleading aggregation. |
| N4-07 | Pointer drag, pan, second-finger pinch, wheel, pointercancel/lostcapture, resize and pair change during press produce zero placement intents; moving back does not resurrect tap. |
| N4-08 | Keyboard arrows/focus announce cell; Enter/Space places once; key-repeat does not place again; controls never click through and focus remains visible. |
| N4-09 | Qualifying sample at start/lower/upper yields correct marker; end timestamp excluded; a shared exact edge can show two simultaneous wins. |
| N4-10 | Jump across a band without in-band sample: no burst/credit, no solid decorative trace crossing accepted card; visually apparent hit agrees with N3 evidence. |
| N4-11 | $5 at 2.5× and $0.50 at 2.01× display $12.50/$1.01 total returns; won/lost/refunded feedback uses exact ledger outcomes once, not animation callbacks. |
| N4-12 | Switch pairs with open bets; old market continues settling and contributes labelled history/balance updates; new label never shows old prices/quotes. |
| N4-13 | Freshness loss/unsupported cells disable placement visibly; conflict/gap renders nonauthoritatively; usable-cell gate cannot pass an all-disabled board; no fallback, premature local loss or fabricated win. |
| N4-14 | Tenth acceptance card then modal; missed notification reconciles from state and presentation acknowledges only on success; no click-through; dismissed offer stays dismissed across layout changes; eleventh blocked and refresh restores ten. |
| N4-15 | Reference replay holds 13 reconstructed positions, $68.82→$28.67 and historical fixtures isolated from live ledger/quota; no replay mode appears for prospects. |
| N4-16 | Frozen 1642×904 reference checkpoints meet documented anchor/alignment thresholds; font/color/effect substitutions and unresolved deviations are recorded. |
| N4-17 | Desktop/portrait/landscape sizes, safe areas, DPR1/2 and browser zoom retain usable controls and tradable cells; no accidental tap after mobile gestures. |
| N4-18 | Reduced-motion/focus/contrast/live-announcement checks retain full functionality and visible outcomes; modal closes to stable results focus. |
| N4-19 | Resize repeatedly and run both-market play long enough to measure bounded trace/text/effect resources; dispose removes listeners/GPU resources; report measured frame times and target device. |
| N4-20 | Hide/reveal tab, back/forward restore or render/context interruption: N3 continues/catches up independently; restored gesture/quote is not clickable; same-document allowance survives and snapshots reconcile. |
| N4-21 | Resolve profiles at widths 767/768, 1199/1200 and coarse 1439/1440; heights 499/500; no dock-induced resize oscillation; capability transitions cancel pending gestures without resetting persistent app state. |
| N4-22 | Tablet 768×1024, 1024×768, 820×1180, 1180×820 and coarse 1366×1024 show intentional rail/header layouts; rotate with open positions and count 9/10: terms, balance, zoom/stake/pair, engine/scene/allowance identities remain stable. |
| N4-23 | Phone/tablet portrait and short landscape at all zooms/epoch phases obey chart-height/future-horizon geometry and ViewportPlayableCoverage; safe areas/keyboard leave controls reachable; clipped cells cannot place; live/reveal navigation does not bet; exact hitboxes never overlap. |
| N4-24 | pnpm/Turbo package boundary check: game-ui depends only on contracts/config; demo injects services once; no sideways imports, duplicated feed/persistence/engine or replay code in prospect bundle; profile budgets measured independently. |

Performance acceptance uses the three profile budgets above and named measured device/browser configurations in N6. Report p95 frame time, resource growth and effect-quality differences independently for desktop, tablet and mobile, rather than a universal frame-rate guarantee. No render-timer callback may determine financial state. Profile constants belong to `packages/config`; runtime capability selection/layout remains N4's responsibility.

Future N4 runtime QA has three review/correction rounds: (1) deterministic geometry, settings, quote presentation and replay checks; (2) gesture, accessibility, stale-data, modal and lifecycle adversarial browser checks; (3) corrected regression, measured visual/mobile/performance handoff. Record fixture/build/browser IDs and expected versus actual behavior. A failing third round stays a failed gate and routes to its owner; three repetitions do not excuse a failure. The completed planning passes below do not replace these runtime rounds.

## QA pass 1 — requirements and evidence

**Actual review performed:** read the graph, N1 contracts, current locked scope, consultation flow and complete relevant visual/rule sections of the fidelity plan before drafting. Compared recovered settings, historical replay and current sales constraints.

**Findings and corrections:** separated current five-choice stakes from historical/tiered values; retained continuous .345–.9 zoom instead of presets; reconciled source cell-size formula with approximate frame spacing; made Maya identity and source-independent sales literature explicit; split the 13-position historical fixture from ten-bet prospect mode. Added the N2 model-domain gate rather than pretending its odds are already valid.

**Later scope amendment — pass 1 re-review:** after the coordinator relayed the user's monorepo and three distinct device-view requirement, reviewed N4's prior files/layout/performance assumptions. Found single-app paths and mostly desktop/phone coverage. Replaced them with `packages/game-ui` plus `apps/demo` composition, three explicit profile layouts/input/resource budgets and tablet portrait/landscape coverage. Marked breakpoints/DPR/performance values as Maya defaults, not Euphoria evidence. Original pass work above remains an honest record of the earlier scope.

**Status:** requirements/evidence planning review complete. Runtime tests remain NOT RUN. Pass2 must challenge stale-quote/pointer timing, false rendered touches, market changes and canonical N2/N3 contracts.

## QA pass 2 — adversarial cases and cross-node interfaces

**Actual review performed:** read the N2 price/quote/coverage and N3 transaction/recovery plans, compared their contracts with this draft, then challenged a source jump across a card, conflicting sample, all-disabled board, drag ending in its start position, synthetic post-pointer click, tenth-bet modal click-through and same-document back/forward restore. Checked the replay count/balance/duration against the source video-analysis note.

**Findings and corrections:** made trace adaptation and source gaps explicit to prevent a visually false hit; added N2 usable-board coverage as a readiness dependency; restricted plot authority to validated samples; added gesture cancellation on suspend/restore and consumption of synthetic clicks across modal transition. Preserved browser zoom outside the board and distinguished back/forward restore from refresh. Clarified that the historical 13-position fixture is a balance-based reconstruction. N4 consumes N1 DTOs even where N2/N3 internal draft aliases differ; it does not create another receipt or counting schema.

**Later scope amendment — pass 2 re-review:** checked new package/profile contracts against the coordinator's finalized N1 boundary map; challenged height499/500, a connected mouse at tablet width, rotation while the tenth-bet modal is open and grid cells below44px at minimum zoom. Found a possible self-induced breakpoint oscillation and a missing capability-transition cancellation. Corrected measurement to the outer usable host before profile controls, explicitly retained the same scene/controller through transitions, canceled pending gestures on capability/profile changes and preserved an accessible large-control input path without overlapping cell hitboxes. Clarified integer-string DTO encoding and no sideways package imports.

**Status:** adversarial planning corrections applied. No pointer/browser/model tests have run. Pass3 will recheck these corrections against graph requirements, test coverage and handoff limits; timing thresholds, live usable-cell proof, physical mobile gestures and fidelity measurements remain future gates.

## QA pass 3 — corrected recheck and graph handoff

**Actual review performed:** re-read the corrected settings, input, sample-truth, consultation/replay and future-case sections against N1/N2/N3 and graph requirements R01–R20. Rechecked that all earlier fixes remain present and every owned obligation has a future case.

**Findings and corrections:** the shared-price-edge rule correctly allowed two settled winners but did not state which single square an edge tap selects. Added a deterministic picking-only half-open tie-breaker and canonical bucket-derived terms, explicitly preserving inclusive settlement. Expanded N4-04 accordingly. Added the three future runtime review rounds to distinguish completed planning QA from unexecuted browser verification. No renderer-owned balance/quota/outcome path remains in the design.

**Later scope amendment — pass 3 re-review:** re-read the corrected profile/package plan against N1's now-updated monorepo schema and presentation acknowledgement contract. Confirmed the three layout compositions, tablet orientations, capability boundaries and runtime-only resource adaptation. Found that N4's directory labels needed alignment with N1's canonical `controls/` and lower-case `layouts/{desktop,tablet,mobile}/`, and that a missed offer event needed explicit state reconciliation. Corrected the paths and documented presentation acknowledgement/open-versus-dismissed retention; expanded N4-14. All 24 future cases retain NOT RUN status. The three amendment review passes are complete; no original-runtime claim was upgraded.

| Graph obligations | N4 cases / dependency |
|---|---|
| R01–R02, R05–R08, R20 — identity, two markets, geometry and controls | N4-01–04; N1 exact config; N2 supported-cell proof |
| R03–R04, R09–R11 — source truth, locked quotes, accounting display and recovery | N4-05–06, N4-09–13, N4-20; N2/N3 authoritative contracts |
| R12–R15 — ten-bet flow and independent consultation | N4-14; N3 acceptance and N5 offer/count authority |
| R16–R18 — gestures/accessibility, bounded renderer and replay | N4-07–08, N4-15–23; N6 desktop/tablet/mobile browser/device report |
| R19 and later monorepo requirement — source package and delivery | N4-24, canonical package/file map and fixture/report handoff; N6 owns executable build/preview/package proof |
| Later three-view requirement — optimized desktop, tablet and mobile | N4-17, N4-19, N4-21–24; config profile defaults and no engine/scene/session reset |

**Status:** all three original planning review/revision passes and three monorepo/adaptive amendment passes complete. All N4-01–24 runtime cases remain **NOT RUN**. Residual gates are N2's two-market price/model/cadence proof, N3 accounting/recovery, downstream N4+N5 dialog integration in N6 (not an isolated N4 prerequisite), and measured visual/desktop/tablet/mobile/accessibility/performance verification. This node is ready for graph-level review, not a claim that Maya is implemented or runtime verified.

Document-only check: 24 unique future case IDs, three original QA headings, three amendment review records and eight resolving wiki links verified. Monorepo/tablet/runtime-NOT-RUN markers are present. This is a document consistency check, not an application test.

## Evidence and handoff

Evidence is local to the vault: [Video Analysis - Price-Time Prediction Grid](Video%20Analysis%20-%20Price-Time%20Prediction%20Grid.md), [Euphoria - Product Reference and Fidelity Requirements](Euphoria%20-%20Product%20Reference%20and%20Fidelity%20Requirements.md), [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md), [Maya Development - N1 Foundation](Maya%20Development%20-%20N1%20Foundation.md), and recovered-control snapshots linked by N1. This node makes no new provider calls and executes no external SDK.

N4 isolated implementation exit requires accepted upstream DTOs, focused geometry/component and browser interaction checks with explicit injected fixtures, a visual report with deviations, distinct desktop/tablet/mobile compositions and canonical package boundaries. N4-14/N4-18 may use a bounded modal/focus harness at this stage. Real model readiness, ViewportPlayableCoverage, engine acceptance and the actual N5 dialog/refresh journey are mandatory downstream N6 release gates, not reciprocal prerequisites for N4/N5 isolated handoffs. No renderer-owned accounting is allowed. Document review closes none of these runtime gates.
