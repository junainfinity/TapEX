---
type: runtime-node-report
created: 2026-09-20
node: N4
status: three-runtime-rounds-complete-with-explicit-limits
tags: [Maya, runtime, Three.js, QA, desktop, tablet, mobile]
---

# N4 — playable experience implementation and QA

**Implemented and checked the shared Three.js/HTML experience in three real correction-and-verification rounds.** Browser evidence here uses the explicitly labelled developer fixture at `/dev.html`; this report does not claim live provider, pricing-model, persistent-ledger or physical-device verification. Those require the graph's integration reports.

Related: [Maya Development - N4 Playable Experience](Maya%20Development%20-%20N4%20Playable%20Experience.md), [Maya - Development Graph](Maya%20-%20Development%20Graph.md), [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). Application root: `<repo>`.

## Delivered code

The `@maya/game-ui` package contains the retained Three.js scene, orthographic shared projection, burgundy grid/intersection dots, sample markers and white-hot dashed trace, supplied-term lime position cards, pair/stake/zoom controls, result feedback and adaptive layouts. It consumes injected state/quote/placement ports and never calculates odds, settles positions or changes balances itself. Source values supplied by the engine remain authoritative; between-sample connectors crossing a supplied position are suppressed.

Controls preserve the shared menu, continuous .345–.9 zoom and fresh/reset .6. Controls measure at least44px in all five checked profiles; grid cells preserve researched geometry and can be smaller. Cell-size-relative text avoids overflowing small neighboring squares. The fixed chart-height cap preserves two future windows at maximum zoom under the configured source-age/lead-time horizon; portrait spare height is centered rather than changing effective zoom. The real live model's available quotes remain a separate integration gate.

Every animation frame rechecks complete visible-cell bounds, so a quote drifting across the clipped board is disabled/hidden before the next200ms quote refresh. Pointer release rechecks visibility and the original square. A canceled drag stays canceled, pinch never bets, held keys/synthetic post-key clicks cannot double-place, and “Next square” searches canonical quotes and reveals an actual available square if none is visible. Package diagnostics expose render/resource measurements only.

Recent results consume the engine's newest-first ordering. Offer text/card/axis DOM is retained when unchanged; GPU geometry is allocated once and disposed explicitly. Tablet consultation layout uses a separate two-column offer/actions arrangement with52px actions, desktop uses the centered card, mobile uses a sheet; N5 owns its actual lifecycle and verified its dialog views separately.

## QA round 1 — source/settings, geometry and initial views

Read the saved reference frame and active visual plan plus actual code. Found35px mobile stake targets, absent intersection dots, initial empty-result feedback, stale clipping during camera movement and unnecessary DOM replacement. Corrected them, added shared visibility/point/tap/chart-height helpers and meaningful boundary tests. Inspected the rendered1642×904 fixture screenshot against the reference direction; kept dashed connectors as an explicit sampled-source adaptation. Built `@maya/game-ui` successfully and ran four unit tests: clipping at every edge, deterministic single-cell edge picking, canceled drag return, and horizon-preserving zoom geometry.

Evidence: [initial corrected desktop](../../artifacts/verification/n4/round1-desktop.png), [geometry tests](../../packages/game-ui/tests/geometry.test.ts).

## QA round 2 — browser input, gating and retained state

Ran fourteen browser assertions covering exact stake/zoom extrema, default reset, one activation across keydown/repeat/synthetic click, stale-state rejection, exhausted allowance, supplied-term position cards and unchanged offer DOM (zero child-list replacements during the measured interval). A native browser mouse tap followed by dragging away and returning produced exactly one intent total. Initial CLI attempts used fractional mouse coordinates unsupported by that CLI command; integer-coordinate retry succeeded. This was a test-command issue, not an application pass.

Added keyboard duplicate protection, original-square release validation, retained axes/card rendering, and corrected newest-first history after graph integration feedback. The fixture has no paper ledger; its recorded intents establish the UI boundary only.

Evidence: [14 browser assertions](../../artifacts/verification/n4/round2-browser.json), [native pointer result](../../artifacts/verification/n4/native-pointer.json), [browser assertion source](../../artifacts/verification/n4/round2-browser.js).

## QA round 3 — corrected profiles, touch and bounded resources

Used the same `maya-n4` agent-browser session and native Chrome DevTools touch dispatch for a touch tap, drag-return and two-finger pinch. All produced the expected one-or-zero intent counts. The supplied jump fixture suppressed crossing connectors without manufacturing a win. Five device profiles retained stake, zoom and allowance; all enabled offers fit entirely inside the board; all visible non-grid controls measured at least44px; no horizontal page overflow occurred.

Screenshot review found short-landscape labels/cards too large for24px cells and navigation covering time labels. Corrected text size from actual cell pixels and moved short-landscape navigation to the header. Rebuilt and explicitly reloaded after detecting Vite's previously cached workspace CSS, then recaptured the final profiles. This last correction is included in the final built package.

Final correction check also caught a CSS-specificity override on mobile text; the final short-landscape capture now uses8px offer text inside24.5px cells and navigation at top10px, with no label spill. The minimum zoom readout now prints `0.345` exactly. [Final DOM assertions](../../artifacts/verification/n4/final-corrections.json) confirm both corrections. The five-profile timing run preceded these last presentation-only fixes; it is not a fresh timing measurement of those exact text changes.

Measured profiles: desktop1642×904; tablet820×1180 and1180×820; phone390×844 and844×390. Each sampled roughly156–157 frames after settling. p95 values are recorded per profile in the JSON report; the observed range is around17ms on this Windows host's headless Chrome153, **not measurements on actual phones/tablets**. The desktop16.7ms aspiration was narrowly exceeded in this browser run, so it is not labelled a universal performance pass. Tablet20ms/mobile33.3ms targets were met in the emulated run. GPU allocations stayed at5 geometries/0 textures/5 draw calls throughout all five profile transitions.

Evidence: [profile/touch/resource report](../../artifacts/verification/n4/round3-profiles.json), [native CDP capture source](../../artifacts/verification/n4/capture-profiles.mjs), [mobile zoom coverage](../../artifacts/verification/n4/mobile-zoom-coverage.json).

Final package build and four unit tests passed again. `@maya/demo` typecheck passed with the developer fixture included. Explicit disposal removed the Maya root/canvas and released all five geometries; see [disposal evidence](../../artifacts/verification/n4/dispose.json). Browser error output was empty. The private `maya-n4` browser session was closed; the shared Vite server was left running.

| Final view | Screenshot |
|---|---|
| Desktop | [1642×904](../../artifacts/verification/n4/round3-desktop.png) |
| Tablet portrait | [820×1180](../../artifacts/verification/n4/round3-tablet-portrait.png) |
| Tablet landscape | [1180×820](../../artifacts/verification/n4/round3-tablet-landscape.png) |
| Phone portrait | [390×844](../../artifacts/verification/n4/round3-mobile-portrait.png) |
| Phone landscape | [844×390](../../artifacts/verification/n4/round3-mobile-landscape.png) |

## Limits and graph handoff

This is a working visual fixture and shared game UI, not the complete53.888-second reconstructed13-position video replay. No±2px reference-fidelity claim, original font identity, sound match, exhaustive WCAG audit or real-device gesture certification has been earned. The broad reference appearance is manually checked; source-sampled traces and adaptive layouts intentionally differ where required for truthful demo behavior.

The live entry, provider proof, model eligibility, durable ten-bet acceptance and consultation lifecycle remain N2/N3/N5/N6 responsibilities. All changes are in the owned UI package, explicit developer fixture and N4 evidence. No public deployment, vendor messaging, real trades or account creation occurred. The final integration build must consume the most recent game-ui package/CSS rather than an earlier cached Docker/Vite bundle.

## Subsequent deployed live viewport spot check

On2026-09-20 from14:25:34 to14:27:42 UTC, independently checked the Docker-served demo at `http://127.0.0.1:8080` with confirmed assets `index-CQZh7Zci.js` and `index-iLnVPsnp.css`. Used only visible controls, native emulated touch and the read-only `__mayaReadOnly.snapshot()` hook. No source changes were made during this check.

Both pairs × desktop1642×904/tablet820×1180/mobile390×844 × zoom .345/.6/.9 yielded18 cases, each24 samples roughly250ms apart. All432 samples reported healthy inputs and visible offers; all had at least3 offered cells across2 future columns. No enabled cell crossed the whole-cell clipping bounds in any sample. Each case lasted approximately6 seconds: **this does not establish the separate ten-minute95%availability gate**.

One native emulated mobile touch placed a real **paper** ETH bet through the deployed engine: allowance0→1, stake$1, frozen19.43× gross return, immutable position recorded as open at the check. It was not a real-money trade. Five final live screenshots cover desktop, both tablet orientations and both mobile orientations. These are still browser emulations on Windows, not physical-device evidence.

The additional visual inspection found a remaining distinction between cell clipping and text fitting: at mobile minimum zoom, some long numeric multipliers exceed the19px inner width and are clipped by overflow. For example, the observed1380.59X label measured24.4px. Reported this to the graph owner as a targeted label-fit correction; full numeric odds must remain visible without rounded K/M substitution. Whole-cell placement safety passed independently of this text issue. The following evidence reflects the stated asset hashes, before any later coordinator correction.

Evidence: [18-case live report](../../artifacts/verification/n6/live-viewport-report.json), [live check source](../../artifacts/verification/n6/live-viewport-check.mjs), [numeric-label overflow observation](../../artifacts/verification/n6/live-viewport-label-overflow.json), [minimum-zoom label screenshot](../../artifacts/verification/n6/live-viewport-mobile-min-label-overflow.png). Final screenshots are `live-viewport-desktop.png`, `live-viewport-tablet-portrait.png`, `live-viewport-tablet-landscape.png`, `live-viewport-mobile-portrait.png` and `live-viewport-mobile-landscape.png` beside the report.

### Targeted label-fit correction and deployed recheck

The graph owner authorized a text-only fix after the live finding. Added horizontal fitting only when the natural complete label exceeds available cell padding; never round/shorten multipliers or alter the exact accessible label. The same fit applies to stake text when hover/focus reveals it. Fit recalculates after content/cell/font changes and on hover/focus, with geometry writes batched before measurement; short labels are never enlarged. A fifth unit test verifies fit and no upscaling; the UI build and all5 tests pass.

Rebuilt deployment assets are **`index-CnnISgxg.js` / `index-BsFr3F5v.css`**. On ETH/mobile390×844, rechecked all three zooms for24 samples each:72/72 healthy samples, zero numeric-label overflows, zero exact-aria/value mismatches. The minimum view actively fitted up to45 labels; e.g1273.80X remained complete. Native hover and keyboard focus retained complete odds/stake text. One default-zoom focus inspection lost its target as a live cell expired; a fresh-target follow-up checked maximum$10 stake at all three zooms, without placing another bet.

The reported numeric-label issue is corrected in those new assets. Evidence: [deployed label-fit report](../../artifacts/verification/n6/live-label-fit-report.json), [maximum-stake focus follow-up](../../artifacts/verification/n6/live-label-fit-max-stake-focus.json), and screenshots `live-label-fit-mobile-min.png`, `live-label-fit-mobile-default.png`, `live-label-fit-mobile-max.png` in the same N6 artifact directory. This targeted recheck does not reinterpret the earlier short coverage sample as the longer95%gate.

The separate `maya-live-layout` browser session was closed after handoff. Docker remained running; no further source changes or checks are pending from N4.
