---
type: development-node-plan
created: 2026-09-20
status: monorepo-amendment-three-pass-reviewed
node: N5
amendment_qa_passes: [1, 2, 3]
depends-on: [N1, N3]
tags: [Maya, development-graph, consultation, allowance, QA]
---

# N5 — Ten-bet allowance and consultation flow

**Give visitors ten accepted paper bets per document, then invite them to launch Maya under their own brand.** A real refresh grants another ten indefinitely. The invitation never requires registration, booking, payment or contact information to restart the demo. This is a development plan; no application or runtime check was executed for this node.

**Current amendment:** Maya will be a monorepo with distinct adaptive desktop, tablet and mobile views. The three original QA records remain below. Three additional amendment rechecks reconcile package ownership, presentation acknowledgements and responsive dialog lifecycle without changing the ten-bet rules.

Graph: [Maya - Development Graph](Maya%20-%20Development%20Graph.md). Governing offer: [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md). Contracts and acceptance authority: [Maya Development - N1 Foundation](Maya%20Development%20-%20N1%20Foundation.md) and [Maya Development - N3 Paper Engine](Maya%20Development%20-%20N3%20Paper%20Engine.md). The product name is **Maya**. Euphoria remains the internal experience reference; the offer never suggests selling Euphoria source code or an affiliation.

Architecture: [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). [Maya Development - N4 Playable Experience](Maya%20Development%20-%20N4%20Playable%20Experience.md) owns the canonical profile selector and view integration. The reusable dialog belongs to `@maya/game-ui`; its document-lifetime controller belongs to `@maya/demo`.

## Dependencies, ownership and node contract

| Dependency | Input to N5 | N5 obligation |
|---|---|---|
| N1 | Validated `productName`, `maxNewBetsPerPage=10`, dummy `consultationUrl=https://example.com`; canonical shared DTOs and `OfferPresentationAck` | Import `@maya/config` and `@maya/contracts` rather than duplicate limits, identity or DTOs. |
| N3 | Document-lifetime acceptance coordinator, `PageAllowanceSnapshot`, committed `PlacementResult`, live `PositionSnapshot`/`PositionChanged` | Present the allowance and react to the committed tenth acceptance. Never debit, settle or increment a UI-owned count. |
| N4 integration consumer | Chart/controls/results focus targets and placement affordances | Display remaining bets, exhausted status and accessible offer overlay without stopping chart/feed/settlement. N4 is a consumer integration, not a new prerequisite edge. |
| N6 | Browser fixtures, restart/two-tab harness, all three adaptive profiles and keyboard checks | Supply the cases below and keep runtime status NOT RUN until evidence exists. |

N3 owns the only allowance mutation path. N5 may provide the presentation/controller initialized at document bootstrap, but it cannot increment from a pointer event, button click, event-bus duplicate, local position-array length or UI render. `PlacementIntent` uses N1's `requestId`, `pageLoadId`, `quoteId`/revision, `cellId` and `stakeCents`. `PlacementResult.newlyCommitted` distinguishes a new accepted position from a replay; rejected, hydrated and replayed receipts consume no allowance. N3 keeps the counter authoritative inside its serialized acceptance coordinator and publishes N1's `PageAllowanceSnapshot` with count, remaining and offer-shown flag.

The acceptance order is N3's durable debit/position/receipt commit → synchronous document-memory count increment and gate update → acceptance notification → N5 presentation. Count ten closes the gate before the next queued placement can execute. A storage abort changes neither debit nor allowance; a committed acceptance cannot be rolled back merely because a modal listener fails. N5 never runs a parallel quota check as the authority.

Opening must not depend solely on receiving one transient event. The single app-level controller reconciles `acceptedCount === 10 && !offerShown` on subscription and state updates. It retains a stable unique `presentationId` and an in-flight presentation guard. If the dialog cannot attach/open, retain pending status and the closed placement gate, clear only the guard and retry when the view is available. Only after the dialog is successfully visible/focused call the injected N3 port `acknowledgeOfferShown({pageLoadId, presentationId})`, using N1's `OfferPresentationAck`. N3 returns the authoritative `PageAllowanceSnapshot` and sets only `offerShown=true` at count ten for the same document; stale-document/early acknowledgements reject and duplicate acknowledgements are idempotent. It never changes count, balance, positions or gate and never writes a ledger transaction. Duplicate receipts/snapshot updates cannot schedule a second open. The app controller separately retains whether the already-shown dialog is open or dismissed. Dismissal leaves offer-shown true. Both containers live above all adaptive view compositions and reset only on a new document.

An acknowledgement failure after successful display is different from presentation failure. Preserve the app controller's open/dismissed state and stable presentation ID, reconcile N3's snapshot and retry the same valid acknowledgement when appropriate; never show the offer again merely because its acknowledgement was interrupted. An early or foreign-page acknowledgement is a rejected integration defect and cannot grant quota or modify another page's state. UI code does not set `offerShown` directly or infer acknowledgement from a mount callback before the dialog is visible/focused.

## Proposed application files

These are future modules beneath monorepo root `<repo>`, not files created in this planning task. This allocation supersedes the earlier single-root source sketch.

| File | Responsibility and boundary |
|---|---|
| `packages/game-ui/src/consultation/allowance-status.ts` | Reusable read-only snapshot view; text such as `3 of 10 demo bets placed`; exhausted notice. |
| `packages/game-ui/src/consultation/consultation-dialog.ts`, `packages/game-ui/src/consultation/consultation.css` | Reusable Maya dialog, explicit link/dismiss/focus behavior and distinct adaptive presentation; no engine construction/import. |
| `apps/demo/src/sales-flow/consultation-controller.ts` | Single document-lifetime subscription/reconciliation controller, stable presentation ID/guard and open-versus-dismissed state. |
| `apps/demo/src/sales-flow/wire-consultation.ts`, `apps/demo/src/bootstrap/` | Inject snapshots and acknowledgement port, compose UI once and attach lifecycle above profiles; no independent count mutation. |
| `packages/game-ui/tests/consultation.spec.ts`, `apps/demo/tests/sales-flow/consultation-controller.spec.ts`, `apps/demo/tests/e2e/demo-quota.spec.ts` | Presentation/controller contract checks and integrated browser allowance/refresh/CTA/profile flows. |

The allowance owner remains N3's `packages/engine/src/acceptance/`; shared DTOs/ports come from public `@maya/contracts` exports. `@maya/game-ui` imports only `@maya/contracts` and `@maya/config` workspace packages, never `@maya/engine` or an app/private source path. `apps/demo` imports public feature APIs and injects the read-only snapshots/actions into the UI and the acknowledgement port into its controller. This introduces no feature-to-feature dependency. Provider/source details do not move into consultation UI. Bootstrap creates one controller per document and mounts its dialog outside market/pair/profile view subtrees. Dispose subscriptions at actual document termination, not on a component unmount, pair change or a persisted `pagehide` leading to back/forward cache.

## Exact lifecycle and transitions

| Event or state | Required behavior |
|---|---|
| New document, including real refresh or a new tab | New `pageLoadId`; accepted count zero, remaining ten, offer unseen. Hydrate the existing origin-local ledger before placing bets. |
| Successful new acceptance 1–9 | Count increments exactly once through N3; no consultation overlay. |
| Successful new acceptance 10 | Valid position remains committed, count ten/remaining zero, placements gated, accepted result is published, then offer opens once and presentation is acknowledged. |
| Attempt 11 before refresh | N3 returns `ALLOWANCE_EXHAUSTED`; no debit, new position or second offer; show refresh/results affordance. |
| Invalid tap, stale quote, insufficient funds, rejected placement or duplicate request | No additional count. A retry that resolves the original uncertain commit completes that original acceptance once under N3. |
| Win, loss or refund; restored old bet; another tab's accepted position | No new count in this document. |
| Pair/stake/zoom change, resize, UI remount, free refill or route view change in the same document | Count and offer state unchanged. |
| Hidden page, resumed tab or back/forward cache restoration of the same document | Preserve count and offer state; catch up N3 state before new placement. No fresh allowance merely for becoming visible. |
| Close/Escape/`View my results` | Dismiss offer, preserve exhausted gate, reveal live board/results; no eleventh allowance and no repeated automatic offer. |
| Actual refresh after any count | Another ten accepted placements available; unlimited repetitions. Refresh does not mint a new ledger balance or erase open bets/history. |

The page-local allowance and offer state never go into localStorage, sessionStorage, IndexedDB, cookies or a server. The ledger intentionally does persist in N3's shared-origin IndexedDB. A new tab starts its own allowance but shares the durable balance, per-cell cap and positions; incoming position broadcasts must not be interpreted as new local placements. No IP/device/identity enforcement is wanted for this demo.

All accepted BTC and ETH bets continue to settle while the modal is visible or dismissed, regardless of the chosen pair. The overlay never suspends N2 feeds, N3 timers/recovery or position subscriptions. Browser suspension or closing a tab is handled by N3's resume/recovery policy, not a claim that JavaScript runs while closed.

## Maya offer and actions

**Title:** Launch Maya under your brand

**Body:** You've placed 10 demo bets. Book a consultation to purchase Maya as your white-label trading game. We'll customise it for your business, launch it for you and hand over the full project source code.

**Primary action:** Book a consultation

**Secondary action:** View my results

**Supporting line:** Your current bets will finish automatically. Refresh this page to play 10 more demo bets.

The primary action is a real anchor to configured `https://example.com`, activated only by the visitor, with `target="_blank"` and `rel="noopener noreferrer"`. It is a dummy destination, not a scheduler; do not show appointment confirmation or collect details. A brief `Demo booking link` helper may identify the placeholder without inserting technical provider/configuration details into the game. Leaving the original tab open allows its existing bets to continue. No external booking or vendor message is sent by the app.

Keep navigation in that explicit trusted anchor activation: do not await analytics or call an asynchronous popup opener. If a browser blocks or redirects how a new tab opens, keep the original usable and leave a selectable/copyable dummy destination in the dialog; do not automatically replace the demo tab. Opening the CTA does not mark an appointment as booked, alter count or grant more bets. On returning from a mobile external browser/tab, reconcile the existing document state; only an actual replacement document receives a fresh allowance.

The close button, Escape and secondary action dismiss the same overlay. Restore focus to a stable game/result-status control rather than a now-disabled bet button. Keep current outcomes visible in the results panel and expose a `Refresh to play 10 more` action after exhaustion; it must perform a real page reload, not reset memory in the same document. Booking is optional and never unlocks extra quota.

Use modal dialog semantics with an accessible title/description, focus containment, a visible close action and initially focus the heading/body (`tabindex=-1`) rather than the CTA. The gesture that placed bet ten must finish without activating any overlay control. For pointer/keyboard paths require a fresh pointer-down or non-repeated keyboard activation beginning after the dialog opens; ignore the originating pointer-up/click and held Enter repeats. Preserve assistive-technology activation that has no pointer-down rather than globally rejecting all such clicks; suppress only the recorded originating gesture/repeats and verify keyboard/screen-reader activation independently. The backdrop blocks game input while open but does not stop engine subscriptions. On phones, keep every action reachable inside the viewport with scrollable content and safe-area spacing. Dismissal returns focus without moving the market, resetting zoom or placing a bet.

## Adaptive consultation presentation

Consume N4's shared resolved profile rather than implement another breakpoint algorithm. The canonical order is compact/mobile when width <768 CSS px **or** usable height <500px; otherwise tablet/medium when width <1200px **or** coarse primary pointer and width <1440px; otherwise desktop/wide. These are Maya defaults, not Euphoria evidence or physical-device detection. Measure the outer usable host before profile-specific chrome, with safe-area/visual-viewport constraints, as N4 defines.

| Profile | Distinct presentation of the same offer |
|---|---|
| Desktop/wide | Centered bounded dialog with comfortable body measure, visible close action and clear primary/secondary actions; keyboard/fine pointer preserved. |
| Tablet/medium | Touch-spaced panel; portrait uses bottom-reachable actions, landscape uses balanced side-by-side actions where they fit; no hover dependency. |
| Mobile/compact | Thumb-reachable sheet-style dialog, scrollable copy and safe-area-aware actions; short landscape may use available full-height composition so close/CTA/results remain reachable. |

All profiles use the same dialog instance, copy, configured URL, page ID, controller and engine allowance snapshot. Layout changes reflow presentation; they do not perform a new offer-open transition. Preserve an open modal and its meaningful focused control across orientation/breakpoint/pointer changes; preserve dismissal without reopening. No profile transition creates a new quota, acknowledgement or ledger action. CTA/close/results controls use N4's proposed ≥44 CSS px touch targets. Normal keyboard and assistive activation still work in every profile.

Cancel any in-progress board or dialog pointer gesture when orientation, resolved profile, viewport geometry or input capability invalidates its target. A release over a moved CTA cannot activate it, and a gesture canceled during transition never resumes merely because the pointer returns. If the focused control remains visible, preserve its focus without re-running initial focus; otherwise move focus to the existing dialog heading, never automatically to the booking action. Resizing/dock changes cannot choose profiles from the dialog's own dimensions. Safe-area and virtual-keyboard intrusion are layout inputs only, not reasons to dismiss/reopen the offer or reset page state.

Chain choice, production pairs, market-maker onboarding, odds/liquidity integration, scope/pricing and source handover specifics stay in separate sales literature. Wintermute is a possible buyer integration discussion, not a verified partner or an active demo dependency. The UI offers Maya customisation/launch/source handover without inventing launch dates, product prices or turnkey compatibility with every provider.

## Developer replay boundary

The original thirteen-position reference fixture must stay available to N4/N6 as explicit developer replay. It uses its own fixture ledger/state and bypasses this sales allowance and offer. A mode switch in an ordinary prospect document must not silently turn live play into unlimited replay or reset its count. The prospect entry remains the ten-bet paper demo; fixture/replay controls and fixture code stay out of the prospect bundle/interface, not a fallback when public prices/model inputs fail. N6 verifies the development entry and prospect build separately.

## Planned verification cases

Every case below is a future implementation check, **NOT RUN** in this planning task.

| ID | Concrete input / action | Required evidence/result |
|---|---|---|
| N5-01 | Place nine new valid bets split across BTC/USD and ETH/USD | Count nine, one remaining, no modal; all positions exist once. |
| N5-02 | Accept tenth bet while two more placement gestures queue | Tenth debit/position commits; one modal; later placements rejected without debit; no eleventh acceptance. |
| N5-03 | Reject stale/unavailable/insufficient-funds taps and retry an accepted request | Count tracks new committed acceptances only; receipt replay does not reopen modal. |
| N5-04 | Storage abort at ninth count; separately commit tenth then throw from a UI subscriber | Abort leaves count nine; committed tenth remains counted/gated even if presentation throws. |
| N5-05 | Close, Escape and choose results after tenth, then try placing again | Overlay dismisses; count ten and gate remain; feed/results continue; no automatic second offer. |
| N5-06 | Refresh after zero, nine and ten bets, repeat twice, with old open bets | Each new document gets ten; old balance/terms/positions recover without duplicate debit/count; no booking required. |
| N5-07 | Exhaust quota then refill/change pair/zoom/stake/resize/remount | Count remains ten; refill adds only paper funds; existing terms and outcomes unchanged. |
| N5-08 | Two tabs place bets, share ledger and receive each other's updates | Independent counts and offer states; shared balance/cap/settlement remains N3-authoritative. |
| N5-09 | Live BTC and ETH positions resolve while offer open and after dismissal | Visible results reflect price-based wins/losses/refunds once; modal does not pause source/engine. |
| N5-10 | Explicit desktop, tablet and mobile CTA click | Exactly configured dummy URL opens; no auto-navigation or booking-success UI; original game state retained. |
| N5-11 | Keyboard/screen-reader activation in each profile through tenth placement/dismissal | Dialog has name/description, useful focus order and visible controls; assistive activation without pointer-down works; dismissal restores results focus. |
| N5-12 | Original thirteen-position developer replay and prospect bundle inspection | Historical replay completes all thirteen positions without offer/quota interference; prospect build excludes replay code/controls and stays capped at ten. |
| N5-13 | Detach/remount offer view around tenth commit; duplicate notifications; dialog open failure | Count/gate remain authoritative; pending offer reconciles once when available, then stays shown after dismissal/remount. |
| N5-14 | Pointer-up from bet ten arrives over CTA; held Enter repeats; fresh subsequent activation | Originating gesture cannot activate CTA/dismiss/refresh; a new intentional gesture works. |
| N5-15 | Hide/resume, same-document back/forward cache, CTA return; browser blocks popup | No quota reset or fake booking; usable dismiss/results/link remains; true new document alone grants ten. |
| N5-16 | Counts 9 and 10 across widths 767/768, 1199/1200 and coarse 1439/1440; usable heights 499/500 | Canonical N4 profile selected; same page/controller/dialog/ledger identities; tenth opens once, dismissed stays dismissed; boundaries do not reset count. |
| N5-17 | Rotate tablet portrait/landscape with open or dismissed offer; connect mouse; resize while pointer pressed; safe-area/keyboard intrusion | Distinct readable compositions and ≥44px actions; pending gesture cancels; focus is preserved/falls back safely; no CTA click-through, second modal or quota change. |
| N5-18 | Early, wrong-page, duplicate acknowledgement; successful display then interrupted acknowledgement; failed display | N3 changes only offerShown for valid count-ten same-page ack; duplicates idempotent; retries retain presentation ID and never redisplay an already shown/dismissed offer; failed display never acks. |
| N5-19 | Inspect imports/public exports and bootstrap composition in workspace build | game-ui imports only contracts/config; no app/private/engine import, no duplicate controller or engine; demo injects ports; browser cases reside under app E2E. |

Future implementation QA runs in three review/correction/recheck rounds: first deterministic allowance/presentation/acknowledgement and package-boundary cases; second browser refresh, concurrency, input, accessibility and transition failures across all three profiles; third corrected end-to-end tenth-bet → offer → dismissal/CTA → refresh regression with source evidence and source-package inspection. Record actual versus expected results and build/browser/profile identifiers. Failure after the third round remains a failure to fix and recheck, not permission to ship. These future rounds have not run.

## QA pass 1 — requirements, evidence and initial correction

Read the graph, N1 foundation, N3 paper engine and approved white-label flow before drafting. Reviewed the draft against acceptance ownership, persistence and offer copy. The user phrase “ten placed bets” needs the source notes' accepted-new-placement interpretation; a generic page-load reset could otherwise be mistaken for paper-wallet initialization. Made N3-owned `newlyCommitted` accounting, independent persisted ledger versus document allowance, and hydration/retry exclusion explicit. Added the distinction between shared tab ledger and each tab's own ten-bet allowance. Rechecked that tenth acceptance precedes modal, placement eleven rejects without debit, and the configured URL is the approved dummy.

Pass 1 result: requirements/evidence reconciled in this draft; runtime tests remain NOT RUN. Pass 2 will challenge rapid input, remount, focus, browser lifecycle and presentation failure rather than assume the happy path is sufficient.

## QA pass 2 — adversarial lifecycle and interface correction

Re-read the complete first draft against a lost tenth-bet UI notification, a detached modal view, an opening failure, a component remount, a held Enter key, a mobile popup and a restored back/forward-cache document. Found that once-only language did not specify recovery of a missed presentation event; input isolation was named but not defined; same-document history restoration and the replay bypass lacked explicit lifecycle boundaries. Corrected the contract with snapshot-based pending-offer reconciliation and N3-owned presentation acknowledgement, one document controller, fresh-gesture activation, stable focus restoration, native anchor behavior with a usable blocked-popup fallback, and same-document allowance retention. Defined replay as isolated fixture state rather than a prospect quota bypass. Added N5-13–15.

Recheck: no correction gives N5 a second count mutation path, moves quota to storage or pauses settlement. Every presentation failure leaves N3's accepted tenth position and exhausted gate intact. Runtime browser behavior remains NOT RUN; pass 3 checks corrected traceability and the latest shared vocabulary.

## QA pass 3 — corrected traceability and handoff recheck

Re-read the twice-revised note and searched the latest N1/N3/graph contracts for DTO names, acceptance order, offer flag ownership, replay and allowance lifecycle. Found two remaining wording hazards: “after acknowledgement” could confuse placement publication with modal-presentation acknowledgement, and a blanket fresh-pointer rule could block assistive technology that activates without pointer-down. Corrected the transition order and preserved assistive activation while suppressing the known initiating gesture. Made the document-owned dialog independent of pair-view remounts and specified that persisted `pagehide` does not dispose its controller. These corrections retain N3 as the only counter owner.

| Graph requirement | Corrected N5 coverage / future cases |
|---|---|
| R01, R15 — Maya branding, purchase/customisation/launch/source handover and approved dummy CTA | Exact copy and literature boundary; N5-10–11. |
| R11–R12 — durable ledger separate from ten accepted-new placements | Acceptance order, retry/failed-write handling and shared-origin tabs; N5-01–04, N5-08, N5-13. |
| R13–R14 — tenth offer, continuing results and unlimited real-refresh retries | Modal lifecycle, old-position hydration exclusion and no UI reset; N5-05–09, N5-13, N5-15. |
| R16 — usable desktop/mobile/keyboard experience without click-through | Dialog, link, focus and originating-gesture policy; N5-10–11, N5-14–15. |
| R18, R20 — separate thirteen-position replay, no production/vendor scope expansion | Isolated fixture entry and external literature; N5-12 plus N6 scope/network audit. |

Rechecked that all fifteen future cases have an observable result, the fifth and eleventh rows do not grant new quota on dismissal, N1 DTO names are used, and neither N5 nor its components infer count from position arrays. The N3 presentation-acknowledgement clarification was sent to the graph coordinator for cross-node incorporation; N5 does not edit N1/N3 files. This is a graph-level handoff detail, not an assertion that a browser implementation exists.

**Node planning result:** three draft/review/correct/recheck passes completed. All N5 runtime cases remain **NOT RUN**. The isolated-versus-integrated exit distinction in the graph-pass-1 correction below supersedes this original handoff: N3 supplies authoritative ports; N4/N5 harness checks can finish independently; N6 then supplies the mandatory real-board/engine browser evidence. No source feed/model feasibility, production provider integration or real consultation booking is established by this plan.

Document-only verification found exactly three QA pass headings and fifteen future test rows; all four wiki links resolve. Checks confirmed explicit runtime-NOT-RUN wording, the sole N3 counter owner and the dummy URL. This validation did not run an application, browser, provider API or booking service.

## Amendment recheck 1 — monorepo and adaptive requirements

Read the new monorepo/adaptive decision, amended N1 package/acknowledgement contract and amended N4 profile definitions. Reviewed the prior N5 file table and lifecycle text. Found obsolete single-root source paths, an unnamed presentation acknowledgement and mobile-only overlay wording without a tablet composition. Replaced the file map with `packages/game-ui/src/consultation` plus `apps/demo/src/sales-flow`/bootstrap/E2E, added injected public ports with no UI→engine dependency, adopted canonical `OfferPresentationAck` and specified the three distinct offer presentations. The original three QA records above remain historical evidence of the earlier scope.

Recheck result: count mutation still belongs only to N3, no package lifecycle is tied to a profile mount, and the selected URL/copy/ten-bet terms are unchanged. Amendment pass 2 will challenge transition races and acknowledgement failure paths. No runtime or package build has run.

## Amendment recheck 2 — transition races and package interfaces

Re-read the amended note against rotation at count nine/ten, changing input capability with a held pointer, a moved CTA under pointer-up, interrupted acknowledgement after successful display and early/foreign-page acknowledgement. Found that reflow preservation alone did not explicitly cancel pending dialog gestures and that failed acknowledgement could be confused with failed presentation. Corrected these as separate states: display failure can retry presentation; acknowledgement failure preserves open/dismissed state and retries the same presentation ID without a second open. Added focused-control fallback and cancellation across orientation/viewport/profile/capability changes. Expanded CTA/accessibility cases to tablet and added N5-16–19 for profile boundaries, transition safety, acknowledgement behavior and workspace imports.

Recheck result: pending gestures cannot click through a layout move, a dismissed offer stays dismissed during acknowledgement reconciliation, feature packages still depend only on contracts/config, and all accounting/quota decisions remain in N3. These are reviewed design corrections; the added cases remain NOT RUN. Amendment pass 3 checks traceability, current file paths and the unchanged original QA record.

## Amendment recheck 3 — corrected traceability and graph handoff

Re-read the corrected file/port/profile/test sections and compared the latest N1 `OfferPresentationAck`, N3 acknowledgement-owner text, N4 profile/dialog rules and amended graph R16/R19. Checked for obsolete `src/ui`/`src/domain` locations; none remain in the active plan. Found an abbreviated CSS path that could obscure its package owner, and replay wording weaker than N4's prospect-bundle exclusion. Expanded the CSS path and aligned replay isolation/exclusion. Made the three future implementation QA rounds explicit and broadened the N6 dependency wording to all three profiles. The earlier three QA records and their original verification counts remain unchanged as historical records; this amendment adds four cases.

| Amended graph obligation | N5 handoff / future proof |
|---|---|
| R11–R14 — count, persistent ledger, tenth offer and refresh | N5-01–09, N5-13, N5-15–18; N3 owns acceptance/count/ack state throughout layout changes. |
| R15 — Maya offer and dummy consultation action | N5-10–11; identical copy/destination across desktop/tablet/mobile with no booking gate. |
| R16 — distinct adaptive presentation and safe transitions | N4-resolved canonical profiles; N5-10–11, N5-14, N5-16–17. |
| R18–R19 — replay isolation and monorepo boundaries | N5-12, N5-19; reusable presentation in game-ui, one app controller and public injected ports. |

**Amendment planning result:** all three explicit rechecks completed with corrections. N1/N3 now name the same acknowledgement API; no unresolved plan-level ownership conflict was found. N5-01–19 remain **NOT RUN**. Required implementation evidence remains the workspace import/build check, N3 atomic acceptance/acknowledgement behavior and N6's real browser desktop/tablet/mobile, refresh, focus and gesture tests. This node has not scaffolded code, built packages, contacted a provider or run a browser.

Amended document-only verification: three original QA headings, three amendment rechecks, nineteen future case rows and six resolving wiki links; zero obsolete single-root UI/domain paths. Canonical acknowledgement and runtime-NOT-RUN markers are present. This checks the plan text only.

## Graph pass 1 correction — isolated handoff and integrated release

N5's **isolated implementation exit** depends on N1 schemas and N3's acceptance/page-snapshot/acknowledgement ports, not on a finished N4 or N6. Exercise the real N5 controller/presentation against deterministic port implementations and a bounded focus/results/layout harness. Run N5-01–05, N5-07, N5-10–11 and N5-13–19 in that harness, recording explicitly which services are fixtures. Browser-capable presentation checks may run in an isolated test page; they need not wait for the complete game. These checks cover count observation, pending-offer reconciliation, copy, focus, origin-gesture suppression, acknowledgement and profile reflow without duplicating N3 accounting.

N5-06 (true refresh with old positions), N5-08 (real shared-origin tabs), N5-09 (live settlement behind the offer) and N5-12 (actual replay/prospect build separation) are **downstream N6 integration release gates**. N6 also repeats N5-01–05/07/10–11/13–19 against the actual N3 engine, N4 board and built workspace, particularly N6-05–12/17–21. Harness success is not accepted as real storage, source, device or full-game proof. All three future runtime review rounds remain required, with isolated and integrated evidence labeled separately. N6 consumes completed isolated handoffs before producing integrated evidence; its own result cannot be a prerequisite for those handoffs.

This distinction also clarifies the preceding amendment's phrase “required implementation evidence”: full N6 browser evidence is required to release Maya, not to unblock its own component inputs. All runtime checks remain NOT RUN.
