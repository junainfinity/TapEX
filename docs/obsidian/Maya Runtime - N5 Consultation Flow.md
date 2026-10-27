---
type: implementation-qa
created: 2026-09-20
node: N5
status: isolated-controller-three-rounds-passed
tags: [Maya, runtime, consultation, QA, fixture]
---

# N5 — Consultation implementation and executed QA

**The actual consultation controller passed 15 isolated browser checks after three inspect/fix/recheck rounds.** Desktop, tablet, mobile and short-landscape presentation were inspected using the actual shared game CSS. This is component evidence with a deterministic `PaperEnginePort`, not proof of real prices, engine accounting, persisted bets or full-game settlement.

Plan: [Maya Development - N5 Consultation Flow](Maya%20Development%20-%20N5%20Consultation%20Flow.md). Architecture: [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). N3 continues to own counts, balances, accepted positions and the `OfferPresentationAck` mutation. N5 reads the allowance and presents the offer; it never increments the quota.

## Scope and files

- Changed actual controller: `<repo>/apps/demo/src/sales-flow/ConsultationController.ts`.
- Added development-only harness and reproducible cases under `apps/demo/tests/`: `sales-test.html`, `sales-harness.ts`, `tsconfig.json` and `README.md`.
- Evidence directory: `<repo>/artifacts/verification/n5`; [final report](../../artifacts/verification/n5/summary.json) and [named case results](../../artifacts/verification/n5/round3-corrected-regression.json).
- Browser: agent-browser session `maya-n5`, headless Chrome153 on Windows. Tested emulated viewport sizes, not physical phones/tablets. Used the agent-browser skill at `~/.codex/plugins/cache/openai-curated-remote/vercel/0.21.4/skills/agent-browser/SKILL.md`.

The harness is `/tests/sales-test.html` on the existing Vite dev server. Its banner identifies a developer fixture with no provider, prices or ledger. It imports the actual controller and `@maya/game-ui` CSS, supplies named fixture notifications/acknowledgement faults, and makes no feed request. It is absent from `index.html`; Vite has the default single production entry, and the Docker runtime stage copies only the built `apps/demo/dist`. An explicit `import.meta.env.DEV` guard also prevents running the harness as a production entry. Final built-bundle/Docker verification belongs to the graph coordinator; N5 did not rebuild or stop the shared server.

## QA round 1 — presentation, copy and acknowledgement

Executed the first four controller cases in a real browser: count-nine stays quiet, a missed tenth event is reconciled from snapshot, exact Maya copy/dummy link/initial heading focus, dismissal retains count/focus, and a detached host must not acknowledge display. Initial result: **3 passed, 1 failed**.

**Defect found:** appending the dialog to a detached host still marked it presented and acknowledged it. Corrected the controller to require a connected host and a visibly sized, focused dialog before acknowledging. Failure cleans up mounted listeners/dialog state. Re-executed the four cases: **4 passed**. Before/after results are `round1-before.json` and `round1-after.json`.

## QA round 2 — failures, disposal and reentrant acknowledgement

Executed queued-disposal, late host attachment, one-shot acknowledgement failure with reentrant notifications, originating-click/held-Enter suppression with assistive click allowance, and viewport-change click-through cases. Initial result: **2 passed, 3 failed**.

**Defects found and fixed:** a queued microtask opened after disposal; a host becoming available later never retried its pending offer; acknowledgement retry re-entered through subscription notification and recursed. Added disposed guards, bounded presentation retry scheduling, stable document identity, acknowledgement-in-progress guard and complete timer/listener cleanup. Recheck: **5 passed**. Added a sixth adversarial case where `append` throws once; the invisible failure does not acknowledge, then the same pending offer recovers exactly once. Final round-two regression: **6 passed**. Evidence: `round2-before.json`, `round2-after.json` and the final combined report.

## QA round 3 — corrected lifecycle and adaptive journey

Executed concurrent controller construction, cross-action pointer release, orientation while pressed, focus-loop/Escape, and dismissed-controller remount. Initial result: **2 passed, 3 failed**.

**Defects found and fixed:** two already-queued mounts could each open an offer; a pointer beginning on one modal action could activate a different action; orientation-only cancellation was missing. Recheck the current allowance/owned modal before opening, identify each visible offer by page ID, latch the precise pressed action, cancel moved gestures, and invalidate input on resize/orientation/blur/visual-viewport or pointer-capability changes. Re-executed all three rounds against the final controller: **15 passed, zero failed** (4 + 6 + 5). No count mutation path was added.

The harness typecheck initially found its partially constructed fixture cast lacked `controller`. Replaced it with a fully typed fixture initializer. Both `pnpm --filter @maya/demo typecheck` and `pnpm --filter @maya/demo exec tsc -p tests/tsconfig.json --noEmit` passed afterwards. The final 15-case browser regression followed that correction.

| Emulated viewport | Observed result |
|---|---|
| 1280×720 desktop | Centered 480px dialog; close44px, CTA49px, results46px; heading focused; one acknowledgement. |
| 820×1180 tablet | Distinct 610px panel with two-column inclusions/actions; CTA/results52px and close44px. |
| 390×844 mobile | Bottom sheet; all actions visible with CTA49px/results46px/close44px; same page ID/count10/one acknowledgement. |
| 844×390 short landscape | Compact profile; scroll-capable bounded dialog, all primary controls within viewport; same open instance and allowance. |

Screenshot evidence: [desktop](../../artifacts/verification/n5/desktop-offer.png), [tablet](../../artifacts/verification/n5/tablet-offer.png), [mobile](../../artifacts/verification/n5/mobile-offer.png) and [short landscape](../../artifacts/verification/n5/short-landscape-offer.png). N4 owned CSS changes; N5 inspected them and reported the measured tablet layout/actions. The screenshots preserve the then-current visible heading focus treatment.

Clicked the actual **Book a consultation** anchor once. It opened `https://example.com/` in another tab; the original fixture remained available. No scheduler/contact form/booking was created. Returning, choosing **View my results** and resizing to desktop retained count10 and closed state with focus on results. Two real browser reload observations produced new page IDs and count0. These verify document/controller lifecycle only: the fixture deliberately has no persisted wallet or old positions, so they cannot stand in for the N3 persistence test.

## Evidence limits and integration handoff

Completed isolated N5 coverage includes visibility/acknowledgement, retry cleanup, copy/dummy URL, focus, one-off presentation, repeated notifications, remount/resize/orientation, origin-click and held-key suppression, and scoped adaptive presentation. Native keyboard focus traversal and programmatically dispatched accessibility-style clicks were tested; no screen-reader or physical-device session was claimed. A production controller is constructed once by the app composition, above layouts.

The graph still must prove real N3 accepted bets1–10 and eleventh rejection; real persisted ledger/positions across refresh and tabs; BTC/ETH settlement while the modal is open; and production build/Docker fixture exclusion. N5's fixture accepted-notification helper does not implement or verify those financial transitions. The dummy link remains the user-approved placeholder. No public deployment, provider registration or real trade occurred in this node.

Final report records controller/harness SHA-256 values and UTC test timestamps. The three runtime rounds here supplement, rather than rewrite, the earlier planning QA records.
