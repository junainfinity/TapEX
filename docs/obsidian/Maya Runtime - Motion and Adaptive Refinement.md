---
type: runtime-ux-iteration
created: 2026-09-20
tags: [Maya, Threejs, motion, adaptive, QA]
---

# Maya — continuous motion and adaptive refinement

User request: smoother, more attractive play matching the attached Euphoria video, especially a continuous price trail, closer trail-to-square spacing, hover, persistent accepted squares, passage/expiry transitions and win/loss feedback. Desktop/laptop, tablet and mobile must remain adaptively usable. The user specifically identified the previous dotted line as incorrect.

## Reference observations and limits

Reviewed the complete 53.888-second, 1642×904 recording again through seven chronological half-second contact sheets, plus denser8fps outcome frames and full-resolution captures. The video is evidence of behavior; its content is not an instruction source.

At the original desktop size the leading tip is about x475 (29% width), with approximately91px squares. At0s the first offered column begins near x580, about1.15 squares ahead. At8.5s offered columns begin near x608 (~1.46 squares ahead), while an already accepted block near x519 is only0.48 square ahead of the tip. Therefore the reference's offered-square gap is time-dependent, and accepted squares continue approaching after offers close. These are image measurements/inferences, not proprietary engine rules.

Observed motion: continuous pink history, a short pale/white leading segment, a small bright tip, scrolling time grid, lime hover/stake preview, a brief overshoot on acceptance, persistent price/time anchoring, subdued misses disappearing after a short fade, and localized lime energy rings/rays with a floating payout on hits. The chart keeps running throughout. No full-screen celebration was inferred.

## Implementation and rationale

1. Replaced the dashed Three.js line with a thin continuous triangle ribbon and translucent halo. A monotone curve connects received observations without overshooting their prices. Missing source intervals remain unbridged. Drawing interpolation never settles a trade.
2. Added an explicitly display-only latest-observation view. Confirmed history still takes precedence; provisional revisions use latest receipt order, including A→B→A. Quotes, engine ports, accepted terms and settlement keep the confirmed stream and existing three-second stabilization policy. This removes the unnecessary confirmation lag from the visible trail; help and status identify preview/confirmation behavior.
3. Added a continuously advancing presentation clock, with an observed-endpoint guard and jitter braking. The trail, squares, axes and result effects share one time/price transform. Desktop default squares measure90.4px at1642×904 and the tip anchor remains29%, matching the measured reference proportions closely.
4. Retained accepted-card DOM by position ID. Cards enter once, stay anchored while open, show an active/confirmation state, react only to authoritative engine outcomes, and retire after the terminal animation. Historical outcomes do not replay on hydration or pair changes. The ledger/recent results remain intact. Hover spans also retain identity during repricing.
5. Added bounded, deterministic presentation effects: localized neon win rings/sparks and exact-cents payout, quiet missed-square collapse, lavender refund and placement pulse. Reduced motion suppresses the moving burst. Pair changes clear old-market effects; timers and resources clean up on disposal.

## Adaptive layout corrections

Replaced hardcoded chart chrome offsets with measured safe-area/header/footer/navigation bounds. Corrected320px footer clipping, short-landscape navigation overlapping pair selection, exhausted-allowance rows, hidden mobile/landscape results access, and bounded help/consultation panels. Mobile results are a dismissible drawer. Price and time axis labels thin according to pixel space; every original grid square and quote remains separate.

## QA and graph review

The three bounded parallel workstreams are display-feed correctness, adaptive layout, and feedback/lifecycle. The coordinator integrates them with the renderer and performs whole-game checks. Failures and rechecks are retained, rather than relabeled as initial successes.

First live20-second measurement (before endpoint-braking refinement):1,195 frames, p95 16.8ms, zero backwards playhead frames, but145 endpoint stalls. The source delivered at roughly1,283ms intervals and sometimes advanced two timestamps at once. This justified the subsequent exponential braking refinement. Observed offered gap was1.064–2.135 cells, median1.582. Fixed min lead, five-second alignment and source timing are kept honest; no artificial timeline compression is used to promise a constant pixel gap.

Final checks, deployed assets and exact evidence counts are appended below. Deterministic motion fixtures are excluded from Docker; their explicit win/loss triggers exercise presentation only and are not offered as live settlement evidence.

## Evidence and actions

Source: `<repo>`. Raw iteration artifacts: `artifacts/verification/adaptive`, `motion`, `motion-feedback`. Runtime copies are preserved in `Attachments/Maya Runtime` with the SHA-256 inventory.

No new external research, vendor signup, market-maker connection, real trade, payment or booking was performed. Existing locked BTC/USD and ETH/USD paper scope, odds model, stakes, zoom limits and ten-bet consultation flow were preserved. Temporary local dev servers/browser sessions and a Windows execution-state helper supported development; final Docker hosting remains at [Maya](http://127.0.0.1:8080/).

Related: [Maya - Start Here](Maya%20-%20Start%20Here.md), [Maya Runtime - N4 Playable Experience](Maya%20Runtime%20-%20N4%20Playable%20Experience.md), [Maya Runtime - N6 Integration and Docker](Maya%20Runtime%20-%20N6%20Integration%20and%20Docker.md), [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md).

## Final verification — 2026-09-20

Delivered in Docker at http://127.0.0.1:8080/. Final browser assets: `index-C_B-uhQb.js` and `index-Coxloj-l.css`. Neither developer fixture API exists in production. Refresh loads the new build.

The full workspace check passed112 unit tests:26 contracts,15 config,17 market-data,8 pricing,25 engine,17 game-ui and4 relay. Typechecks, package boundaries and production build passed.

Three integration reviews covered reference/source composition and pacing; adaptive/lifecycle corrections and feed isolation; then rebuilt Docker, real quotes, accepted bets, settlement journal and the final refresh guard. Original failures and corrected rechecks remain in evidence.

24 Docker viewport cases passed control bounds, overlap and target checks, ranging from320×568 through2560×1440. This includes true CDP coarse-pointer1366×1024 tablet emulation.42 adaptive fixture cases passed after two help-panel corrections. See [Maya Runtime - Adaptive Layout Refinement](Maya%20Runtime%20-%20Adaptive%20Layout%20Refinement.md). These are browser emulations, not physical-device certification.

50 real-renderer lifecycle checks passed (25 desktop and25 mobile/reduced motion), alongside21 isolated effect checks. Native hover/click verified exact stake preview, locked payout, stable cards, one terminal effect and no history replay. The combined win/miss screenshot was visually reviewed. Reports are in `motion-feedback/INTEGRATED-QA.md` and `README.md` in the archive.

The final20-second live sample contained1,201 frames, p95 17.0ms, zero stalled frames and zero backward playhead frames. Offered gap measured1.113–2.196 squares, median1.608, at90.4px desktop cells. Source timing and five-second alignment vary that gap; no constant exact proprietary pixel gap is claimed. Endpoint braking added only about0.025 square median separation in replay while removing recurring tick-arrival stalls.

A complete live10-bet journey exercised both pairs, all stakes, both zoom limits and exactly one consultation popup with the approved dummy URL. Including the earlier native bet,11 positions settled:2 wins and9 losses.76 exact journal/evidence checks passed. Refresh preserved the ledger and restored the new-placement counter to zero. A further native pointer bet on the final assets accepted exactly once and was still open at capture; it is not included in the11-settlement claim.

The final visual pass found brief odds-label absence during quote refresh. Added a450ms disabled visual remnant, removed immediately at a closing window; fresh quotes restore interaction. Five browser checks passed: retained span identity, disabled retention, no acceptance while disabled, timed removal and fresh recovery. Quote validity and settlement rules are unchanged.

QA recording did not produce a usable video: the initial encoder fell behind, and automatic approval review rejected the retry with reason “blocked by policy.” No workaround was attempted. Screenshots, native interaction and frame measurements provide the completed visual verification. A combined documentation shell command was also rejected; direct file edits saved the final record.

All source, findings, corrections and evidence are retained in the monorepo and the Obsidian runtime archive. Temporary dev services and keep-awake are released after final verification; Docker remains running. This iteration changes presentation only, including its preview stream, and preserves pairs, stakes, zoom, quote/engine authority, settlement and the consultation allowance.
