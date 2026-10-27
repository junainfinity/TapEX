# Maya Runtime - Adaptive Layout Refinement

Status: source implementation and three independent adaptive QA rounds complete on2026-09-20. Final Docker verification belongs to the coordinator's integration report.

Maya now measures safe content space and actual header/footer/navigation height. Desktop/laptop keeps the full board; tablet uses a consolidated control tray; phones reflow narrow controls and use a recent-plays drawer. Landscape has separate chrome rows. Refresh after10 plays fits in the measured footer. Help and consultation panels respect bounded viewport height and safe insets.

Independent evidence:42 passing browser cases—16 initial viewport sizes,16 exhausted-count sizes,4 final safe-inset help/results states,6 consultation layouts. Controls were checked for viewport containment,44px target size and actual center hit visibility. Consultation actions remain reachable through internal scrolling on short screens. Stakes, zoom limits and financial behavior were not changed by adaptive code.

The review found and corrected portrait help covering its own toggle and landscape help overlapping navigation/footer. Coordinator also thinned axis labels on short landscape screens while retaining canonical cells. Original failures are preserved beside passing rechecks.

Source files:

- `<repo>/packages/game-ui/src/adaptive.css`
- `<repo>/packages/game-ui/src/layout.ts`

Evidence directory: `<repo>/artifacts/verification/adaptive/`. Main report: `final-report.md`; matrices: `round1-matrix.json`, `round2-exhausted-matrix.json`, `round3-modal-matrix.json`; safe-inset results and screenshots are alongside them. Final source hashes are recorded in `final-source-hashes.json`.

Tests use Chromium emulation and injected CSS safe insets, not physical phones/tablets. Agent-browser's iPad Pro emulation did not set the coarse-pointer media query; coordinator will verify1366×1024 coarse-pointer layout via CDP against Docker. The fixtures are developer-only and are not production gameplay APIs.

Related: [Maya - Start Here](Maya%20-%20Start%20Here.md), [Maya Runtime - N6 Integration and Docker](Maya%20Runtime%20-%20N6%20Integration%20and%20Docker.md), [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md).

## Recent-plays readability correction

The user's later correction required a race-game-style leaderboard over the chart, preserving chart area. Desktop/tablet now use a260px translucent overlay below the header/status/hint; it reserves no chart height. Text uses13px DM Sans with gold heading/cream rows and distinct result colors. Mobile Results remains an explicitly opened, bounded overlay near the chart top. Time labels use pale-blue monospace in a separate clear strip above desktop controls.

Three bounded QA rounds passed22 final cases:8 developer-fixture viewports,8 live Vite viewports,6 stress cases with four rows, long amounts, min/max zoom, exhausted allowance and safe insets. Four additional mobile rechecks corrected a fixture harness rerender and confirmed four-row panels preserve the same scene height. At1642×904, the scene remains904px high and initial cells remain90.4px. No extra leaderboard row or reserved empty area was added.

Evidence: `<repo>/artifacts/verification/adaptive/readability-report.md`; JSON matrices and screenshots with the `readability-` prefix are alongside it. The tests are Chromium emulations, not physical-device certification. Artificial long return values in stress screenshots are developer-fixture DOM content, not fabricated live outcomes or ledger mutations.

## Layout-read batching

A coordinator performance review found leaderboard/scene bounds being read for every offered square after position writes. The visibility pass now reads shared bounds once, batches time-label reads before writes, and batches changed text measurements. Input validation still measures fresh bounds; no cross-frame geometry cache is used.

A10-second1642×904 developer-fixture comparison reduced leaderboard rectangle reads from91,476 to660 (99.28%) and total rectangle reads from187,781 to5,597. Fixture p95 was16.8ms both before and after; this does not establish live Docker improvement, which the coordinator must resample. Desktop/tablet/mobile geometry checks and same-task fresh-input occlusion verification passed. Evidence: `<repo>/artifacts/verification/adaptive/layout-perf-report.md` and its JSON samples.
