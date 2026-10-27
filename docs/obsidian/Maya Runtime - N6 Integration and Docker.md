---
type: implementation-qa
created: 2026-09-20
status: delivered-with-explicit-limits
tags: [Maya, runtime, integration, Docker, QA]
---

# N6 runtime integration and Docker

**Delivered locally at http://127.0.0.1:8080.** The completed integrated rounds and explicit limits are recorded below; initial checkpoints are historical.

This is actual implementation evidence, separate from [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md)'s completed planning reviews. Scope and task history: [Maya - Implementation and Docker Delivery](Maya%20-%20Implementation%20and%20Docker%20Delivery.md). Source root: `<repo>`.

## Implemented composition

`apps/demo/src/bootstrap.ts` composes the six workspace packages once per document, injects the source/clock/quote ports into the engine, keeps both sources alive for open bets, maps read-only state into Three.js/HTML UI and connects the tenth-bet consultation controller. No fixture module is imported by the prospect entry. Refresh uses `location.reload()`; the durable engine ledger and ephemeral document allowance remain separate. Diagnostic browser hooks provide reads only.

The coordinator wrote the initial UI, app composition and consultation controller, then delegated three actual review/correction rounds for UI and consultation to N4/N5. N1 owns foundation evidence; N2 owns the live source/model proof; N3 owns engine tests. No final passing graph verdict is inferred from any one package.

## Initial integration checkpoints (historical)

1. Workspace boundary check passed with eight workspaces, 25 source files and 15 dependency edges at that revision. Foundation and engine reports establish 41 and 24 focused passing tests at initial handoff respectively; this is not the final application test count.
2. The explicit developer visual fixture loaded with a Three.js canvas and controls. Browser screenshots at desktop and 390×844 were inspected. A mixed-encoding character in a coordinator-edited UI string caused Vite's dependency scanner to reject UTF-8; corrected the source encoding, rebuilt and verified meaningful page content without the error overlay. The fixture is labeled and excluded from production.
3. Actual live composition initially failed because assigning native browser `fetch` to a class member changed its receiver. Captured the failure, injected a bound-safe wrapper in the app and reported the library correction to N2. Subsequent browser reads showed both markets ready, confirmed price age about five seconds, clock uncertainty about 706ms and 66 visible BTC quotes at that instant. These quotes used the interim model; this observation proves integration/availability only, not final pricing correctness.
4. Docker Compose configuration and initial multi-stage build passed. Pulled/pinned Node24-alpine digest `ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1` and nginx-unprivileged digest `b54ac358b83fc6c965793fd271839b4ea4cdb6e99895bb19618cbc2ca152d972`. Started `maya-feed-relay-1` and `maya-web-1`; both became healthy. The static server was reached at `http://127.0.0.1:8080`, with one canvas and expected controls. This initial image predates later source/model/UI fixes and must be rebuilt and verified before delivery.

The containers run without added capabilities, with read-only root filesystems; the web service has bounded temporary storage and is bound only to loopback. No preexisting containers were present in the initial inspection. No unrelated services were stopped. Verification copies, node_modules, vault files and development/test entries are excluded from the Docker build context.

## Operational/model corrections from actual evidence

The ten-minute source capture observed revisions confined to the newest two seconds. N2's three-second provisional frontier emitted no finalized conflicts in that capture; later finalized disagreements remain errors and cannot overwrite an authoritative sample. Confirmed source age is shown in the game. This is a measured local policy, not a provider immutability guarantee.

The original proposed 95% canonical candidate availability gate failed for BTC on the initial stabilized/table replay (93.30%, versus ETH97.64%). The coordinator explicitly chose a 90% local-demo candidate target based on observed usability, retaining the failed original metric and every unavailable instant. This does not alter user-selected geometry or fabricate quotes. Per-viewport visibility remains a separate check. Final metrics must be recomputed after the pricing correction below; the earlier percentages cannot certify the corrected model.

Independent sampled-path testing found the published table could assign positive probability to a zero-width band, showing crossing semantics incompatible with Maya's strict sampled-in-band event. The coordinator authorized a local deterministic Gaussian integration adaptation using the same Lynx price/EWMA/config inputs for five observations at start through end-minus-one-second. The original published-table equivalence gate remains failed; it is retained as domain/reference/provenance, not falsely described as the calculator for final odds. N2 must verify convergence, independent reference error, CPU cost and updated availability before this becomes the final local pricing policy. Game outcomes still depend only on actual confirmed prices, never random draws.

## Initial round status before the executed closeout below

| Round | Current state | Evidence required |
|---|---|---|
| 1 — complete normal journey | In progress | Final model, both pairs, all controls, acceptance/result, tenth offer, dismissal/CTA and repeated refresh |
| 2 — failures and lifecycles | Pending | Quotes/races, old open bets, shared tabs, source gaps/refunds, modal/input isolation and viewport changes |
| 3 — corrected Docker candidate | Pending | Final built-image URL, desktop/tablet/mobile captures, corrected regression, source/build inventory and handoff |

Viewport emulation is labeled as emulation. No physical phone/tablet or statistically calibrated market-maker execution claim is made. At this initial checkpoint Docker served an intermediate build. The executed closeout and final build identity are recorded below.


## Executed integrated graph rounds — delivery record

The three integrated loops below are separate from the planning graph reviews and each package's own three runtime loops. They are sequential review/correction/recheck rounds, not three individual assertions renamed as rounds.

| Round | Executed work and correction | Result/evidence |
|---|---|---|
| 1 — complete normal live journey | Composed final sampled model/source/engine/UI/controller, corrected native fetch receiver and bounded idle engine evidence retention, checked exact stake/zoom controls, both pairs, ten accepted bets and one consultation modal. Outcomes continued behind the modal. | Desktop, mobile and tablet each accepted ten, retaining 10→20→30 ledger positions across refresh. `desktop-ten-bets.json`, `mobile-ten-bets.json`, `tablet-ten-bets.json`; desktop settlement gave five observed wins and five observed losses with 66 exact audit assertions. |
| 2 — failures and lifecycles | Opened a second tab in the same browser context, placed through a native pointer click, immediately refreshed an open position, then stopped only Maya's feed relay. Recovered after restarting it and compared both tabs. Small-screen review found clipped odds/landscape labels and a rounded minimum-zoom readout; presentation corrections were delegated and rechecked. | Old tab stayed at count10; new tab count0 with the same30 positions. Native bet made31; refresh kept31/one open while count reset. Outage yielded zero offers and unusable source clock; recovery supplied all five missing historical slots, giving a valid miss rather than fabricated settlement. Both tabs matched the98830-cent ledger. Evidence captures preserve the sequence; 202 exact audit assertions passed. |
| 3 — corrected hosted candidate and independent review | Rebuilt pinned images, ran full95-test workspace check, typechecks/boundaries/build, independent source/model/engine composition review, hosted HTTP/route/attribution checks and a fourth complete ten-bet journey. Final viewport spotchecks and text-fitting correction are recorded alongside their actual build identity. | Final journey count10/one modal, exact0.345–0.9 zoom readout and all stakes. Coordinator ledger41 positions:21 observed wins/20 losses; 267 exact payout/journal/source-evidence assertions passed. `final-ledger-audit.json`, `final-workspace-check.log`, `final-browser-assets.json`, `final-containers.json`, `independent-review.md`. |

All browser-ledger snapshots are read-only captures of actual IndexedDB and application diagnostics. Journey automation activated UI buttons; native keyboard and pointer placements were separately exercised. No production mutation/testing backdoor was added. Real tabs shared a browser context. Deterministic concurrency/race/refund fixtures remain distinguished from the actual live sequences.

## Final model and gates

N2 completed the local sampled-model proof: 24 focused source/pricing/relay tests, eight independent 100,000-path reference cases and 125 convergence comparisons passed. Corrected canonical coverage was BTC92.817%/ETH97.084%; the original95% BTC gate remains FAIL and the explicitly revised90% local-demo policy passes. At least one candidate existed at96.389%/98.494% of healthy instants, with a79.1-second source outage retained in the all-instants result. These figures do not certify viewport visibility, uptime or market calibration.

N4's final deployed viewport spotchecks are separate short observations, not a ten-minute per-viewport SLA proof. The full53.888-second historical13-position replay, ±2px video/font/sound identity, physical-device testing and universal16.7ms frame performance have not been certified. These aspirational/unexecuted gates remain explicit; the delivery verdict is a working paper sales demo, not an assertion that all111 planned checks passed.

## Source and evidence handoff

Open [Maya - Start Here](Maya%20-%20Start%20Here.md) for the playable URL and source instructions. Runtime artifacts are archived under `Attachments/Maya Runtime` with SHA-256 copies; the full source remains in the monorepo. The final source/image/asset manifests identify the delivered revision. Development/test harnesses and captured evidence are excluded from the public app entry and Docker context. The source adaptation's MIT license and notice are included in the served third-party directory.


## Final deployed label correction and archive

All18 live profile/pair/zoom cases had offered cells across432 healthy short samples, including three cells/two future windows; zero whole-cell clipping failures. A native emulated mobile touch was accepted by the real paper engine in a separate browser profile. The long-odds label defect was fixed by fitting the complete text horizontally, preserving exact labels and aria values. Rebuilt assets are `index-CnnISgxg.js` / `index-BsFr3F5v.css`;72 fresh ETH/mobile samples across all three zoom values had zero numeric overflow or aria mismatch, with hover/focus stake visibility checked. Five geometry tests now bring the complete unit total to95. The final browser reported zero runtime errors.

Four complete ten-bet journeys ran before this final text-only correction, with their original asset identities preserved. The final correction was rechecked through focused deployed rendering and the full workspace check; it changed no odds, acceptance or settlement logic. `final-delivery-summary.json` and `final-source-manifest.json` capture the closeout. All runtime artifacts are copied into the vault with matching SHA-256 values, and local note links were validated.
