---
type: development-node-plan
created: 2026-09-20
status: planned-three-node-reviews-complete
node: N3
depends-on: [N1, N2]
tags: [Maya, development-graph, paper-engine, settlement, qa]
---

# N3 — paper acceptance, ledger and settlement

**Build one local, deterministic engine that accepts an exact displayed quote, spends virtual USD once and settles only from qualifying Lynx samples.** This is a development plan; no game implementation or runtime tests have been performed in this node.

Graph: [Maya - Development Graph](Maya%20-%20Development%20Graph.md). Sources: [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md), [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md), [V1 - Playable Demo Gap Review](V1%20-%20Playable%20Demo%20Gap%20Review.md). The latest accepted demo/consultation rules govern older research. N1 supplies configuration and shared schemas; N2 supplies verified samples, quotes, timing and coverage. N4 consumes engine state for rendering; N5 connects the ten-placement consultation flow.

## Boundaries and fixed rules

| Concern | N3 decision |
|---|---|
| Markets | BTC/USD and ETH/USD; both continue settling when only one is visible. |
| Contract | Five-second `[startMs, endMs)` window with `lowerPrice <= samplePrice <= upperPrice`; use source timestamp, not receipt timestamp. |
| Outcome | First valid qualifying source sample wins; complete source evidence without a hit loses; unrecoverable missing evidence refunds. No interpolation, random win roll or rendered line collision. |
| Stake defaults | 10, 50, 100, 500 or 1,000 cents; maximum 1,000 cents per placement and 5,000 cents of accepted stake per canonical square. All visitors have the same choices. |
| Paper funds | Initial 100,000 cents once for a new local ledger; explicit refill adds 100,000 cents without changing open bets or allowance. These are implementation defaults, not new user-requested numbers. |
| Odds | N2 provides `grossX100` (integer hundredths): the inspected SDK floors the gross multiplier to two decimals. Show and freeze that same value with its model/config versions. Do not reprice after acceptance. |
| Acceptance | One tap; no cancellation, editing, cash-out, external trade, wallet, authentication or artificial delay. Invalid or expired quote rejects without debit; never silently substitute a new multiplier. |
| Persistence | Preserve bets, balance and source evidence across refresh; sales allowance remains separate page memory. |

Define canonical `cellId` by a stable schema prefix, market, window start/end and normalized exact lower/upper prices. Store model/config/rules revisions separately: a new quote revision must not give the same square a fresh cap. The cap is the sum of all accepted stake assigned to that square, including bets later refunded, not a renderer object ID or screen coordinate. Zoom and pair switches cannot alter the key. Legitimate distinct taps can add positions until the cap; the same request retry cannot.

## Dependencies and deliverables

| Node dependency | Required input | N3 output / consumer |
|---|---|---|
| N1 foundation | Validated demo config, market identity, money/price types, rules versions, app lifecycle | Shared contracts below; no independent duplicate config. |
| N2 feed/model | Validated quote registry, source samples, estimated source time, freshness, recovery coverage, immutable model/config provenance | Accepted quote terms and evidence references; N2 continues feeds required by open bets. |
| N4 board | Stable quote ID, canonical cell ID, selected integer-cent stake, one ID per intentional placement gesture | Accepted/rejected result, spendable balance, active exposure, outcome and evidence; never frame-by-frame ledger mutation. |
| N5 consultation | One document-lifetime in-memory allowance object and result subscriber | Serialized acceptance increments; tenth-acceptance event only after commit; no separate UI counter. |
| N6 graph QA | Deterministic sources, fake clock, simulated storage failures and multi-page browser harness | Evidence for every acceptance case below and combined N2 → N3 → N4 → N5 flows. |

Proposed monorepo files, not files created during planning. This package allocation supersedes the earlier root-`src/` sketch; see [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). `@maya/engine` depends on `@maya/contracts` and `@maya/config`, with injected quote/clock/coverage/allowance ports. It does not import feature-package internals or `apps/demo`.

| File / module | Responsibility |
|---|---|
| Shared `@maya/contracts` contracts/units/identities exports | Import immutable DTOs/exact-value helpers; coordinate N1-owned shared payout helper so N4 needs no engine import or duplicate rounding implementation. |
| `packages/engine/src/acceptance/` | Per-document serialized placement entry point, quote validation, allowance coupling. |
| `packages/engine/src/settlement/`, `recovery/` | Source-sampled predicate, coverage decision, catch-up and terminal transition. |
| `packages/engine/src/ledger/`, `storage/` | Transactional records, receipts, balance, exposure, evidence, migration and browser-specific storage entry. |
| Engine read-only snapshot exports, `packages/engine/tests/`, `apps/demo/tests/e2e/paper.spec.ts` | Read-only views, meaningful domain tests and composed browser persistence/race tests. |

Shared types are consolidated with N1 rather than copied into multiple nodes. Future file names may change at scaffolding, but module boundaries and evidence obligations stay fixed.

## Shared interfaces

N1 owns the canonical schema. Use integer milliseconds for time, `DecimalValue {coefficient: string, exponent: number}` for exact prices and integer cents for virtual money. DecimalValue means coefficient × 10^exponent; normalize equivalent values before comparison or cell identity. Parse internal integer arithmetic to `bigint`, never money or price-boundary arithmetic through JavaScript floating point. In this note, “command” means one `PlacementIntent`; its idempotency identifier is `requestId` and its document identity is `pageLoadId`.

| Contract | Required fields / behavior |
|---|---|
| `PriceSample` | `market`, `feedId`, `sourceTimeMs`, exact `price: DecimalValue`, canonical sample identity, receipt time, provenance and validation status. Same identity with conflicting values is a fault, not last-write-wins. |
| `QuoteSnapshot` | `quoteId`, canonical `cellId`, market, DecimalValue bounds, window, `grossX100`, quote observation/expiry, lead-time policy, source sample identity/time and model/config/rules/cadence identities. Frozen and obtained from N2's trusted in-process registry. `grossX100` means integer multiplier-hundredths. |
| `PlacementIntent` | New unique `requestId`, `pageLoadId`, `quoteId`, `stakeCents`, `cellId`; generated once per intentional gesture and reused for retries. Validate intent cell equals quote cell. No caller-supplied replacement odds or geometry. |
| `AcceptanceReceipt` | Accepted with immutable bet/ledger IDs and new paper snapshot; or typed rejection with no mutation. Replayed receipt is distinct from a newly committed acceptance event. |
| `CoverageReport` | Requested interval, evidence IDs, verified source watermark, `complete / recovering / unrecoverable`, conflict/gap reasons and policy version. N3 cannot invent completeness from wall time alone. |
| `PageAllowance` | In-memory `acceptedCount` (0–10), modal trigger flag and single serialized mutation path. New document starts at zero; hydration and settlement are not placements. |
| `PaperSnapshot` | Ledger revision, spendable cents, accepted open exposure, active and recent positions, feed/recovery status. Components subscribe; they do not own settlement. |
| `PositionSnapshot` | Immutable accepted terms, `status: open / won / lost / refunded`, accepted and terminal evidence, gross return and settlement time. Waiting/active/recovering are display substates of `open`. |

### Exact money and payout

Compute the winning gross credit once as `(stakeCents * grossX100 + 50n) / 100n` using nonnegative `bigint` integer division: round half up to a cent. A $0.10 stake at 1.05× therefore returns $0.11, and $0.10 at 1.04× returns $0.10. This is a Maya paper-ledger rounding decision, not a claim about Euphoria settlement rounding. Display potential gross return with this identical function before placement. The winning credit already includes the stake; do not credit it again. A loss credits zero; a refund credits precisely the original stake.

Persist `stakeCents`, `grossX100` and the computed `grossReturnCents` in accepted terms. A price/model update never changes them. Reject non-integer, negative, malformed or unsupported values before acceptance. Do not invent a commercial multiplier ceiling; reject values outside the validated adapter/domain or storage representation and record the reason.

## Bounded implementation sequence

1. Implement pure exact-value types, payout and touch predicates against deterministic fixtures; settle one BTC and one ETH example without rendering.
2. Add an atomic persistent ledger with idempotent acceptance and terminal transitions; keep read-only view derivation separate from mutations.
3. Connect N2 quotes, freshness, source time and coverage; prove accepted terms cannot change on a new quote revision, pair switch or zoom.
4. Integrate N5's one-document allowance through the same placement coordinator; accept the tenth before emitting its modal event and reject all later commands until refresh.
5. Verify reload, storage failure, two-tab races and gap recovery with the actual browser storage adapter before the graph declares N3 complete.

## Acceptance transaction

The per-document coordinator is the only entry point. It serializes taps, refill commands and acceptance completion bookkeeping. A transaction must not contain a network request or wait on a UI render.

Before committing a new placement, resolve the immutable N2 quote and validate its market, model/config/rules compatibility, finite supported model result, identity, source freshness, current source-aligned timing, expiry and minimum lead time. Validate allowed stake, spendable balance, canonical square cap and allowance. If waiting for a queued transaction makes the quote too old, reject it.

Commit a debit, immutable accepted position and command receipt together. Emit success only after commit, increment the in-memory allowance once before releasing the document queue, and close the gate when it reaches ten. N5 then opens the modal from that newly accepted receipt; feed processing and settlement continue. Repeated request IDs return the stored receipt without another debit, position or count. Unavailable cells, stale quotes, insufficient balance and the eleventh attempted bet reject with no financial or quota mutation.

Use a document-lifetime coordinator outside component mount/unmount. All placement origins, including keyboard and renderer hit tests, enter this one queue. Keep an in-flight command record until storage has definitely committed or aborted; an ambiguous completion is reconciled by command ID before allowing the next placement. A receipt recovered for that still-pending original command completes its bookkeeping once; a later duplicate delivery never emits another acceptance event. After the stored commit, update count and close the gate before notifying any UI subscriber. Subscriber exceptions must not skip counting, unlock an eleventh placement or reverse an accepted bet. A refresh destroys this memory and deliberately starts a fresh allowance.

N1's `OfferPresentationAck` adds `acknowledgeOfferShown({pageLoadId,presentationId})` to this document owner. Accept a matching-page acknowledgement only after count ten and successful dialog presentation; update only the page-memory `offerShown` flag idempotently, never count, balance or positions. N5 reconciles `acceptedCount === 10 && !offerShown` from the current snapshot if an event was missed, using one document controller and an in-flight presentation guard. A failed mount leaves presentation pending and placements closed; dismissal leaves the flag true. Adaptive desktop/tablet/mobile transitions never reconstruct this coordinator or reset count. All views use the same injected shared-unit payout helper and engine instance.

### Shared ledger and browser concurrency

Use one IndexedDB database per app origin/browser profile. Put balance, per-square exposure, positions, command receipts, ledger entries and source evidence in coordinated stores. Read-modify-write all affected ledger stores in one read/write transaction; all writers use overlapping transaction scopes. The transaction re-reads balance/cap/state and validates time-dependent acceptance immediately before its mutation. Local component state and `localStorage` are never the authority for funds.

Two tabs intentionally have independent page allowances but share this same paper balance/history. Both can submit valid commands; IndexedDB serializes their conflicting transactions. Both may process feed/settlement, but a terminal transition re-reads the position, interval evidence and coverage revision inside the transaction and succeeds only while the position is unresolved. Sample evidence is committed before or in the transaction that credits its win. Unique ledger keys such as `initial-grant`, `debit:<betId>` and `terminal:<betId>` protect initialization, duplicate requests and duplicate terminal effects. Only the first tab creating a new ledger applies the starting grant.

BroadcastChannel may tell other tabs to refresh their read snapshots; it is an optimization, not a correctness lock or source of funds. Re-read committed state on focus/visibility changes. No leader election, server execution or production account system is needed for this local paper demo.

If storage is unavailable, corrupt, full or requires an unsupported migration, pause new placements and show a recoverable storage error. Preserve existing records and do not silently reset the ledger or switch to nonpersistent accepted bets. An aborted storage transaction changes neither money nor quota. Store schema/policy versions, migrate transactionally and test the supported browser set. Persistence here covers normal refresh/reopen on the same origin/profile; it cannot promise recovery after deliberate browser-data deletion.

## Settlement, recovery and state

State transitions: `open → won | lost | refunded`; a successful acceptance creates `open`. An open position may display waiting-for-window, active-window or recovering; those labels do not create extra debits or outcomes. All terminal transitions and credits are idempotent.

For each valid sample, use its source timestamp and market to select relevant accepted positions. A qualifying sample can win immediately; the source sample and accepted terms are saved as the reason. Samples at `startMs` count; samples at `endMs` do not. Both price boundaries count. Do not convert a price jump over a band into a synthetic touch. Pair switching or closing the consultation overlay has no effect on active subscriptions.

Inclusive price edges mean a sample exactly on a shared edge can win accepted bets in both neighboring bands. Do not add an unapproved tie-breaker. One validated hit establishes the event even if another part of that interval has a gap; a sample whose own identity/value is conflicting is not a validated hit. Whole-window coverage is required for a no-hit loss, not for a separately proven hit.

After the window, ask N2 for interval coverage. A verified complete interval with no qualifying sample may lose; otherwise recover the recent source buffer and locally retained samples before deciding. Pause placements during stale inputs. If N2 cannot establish sufficient evidence within its measured recovery policy, refund the original stake once and show “refunded — price data unavailable.” A loss must not be inferred solely because an end-time animation finished or a timer fired while the page was suspended.

A proposed loss/refund must re-check the latest persisted interval evidence in its terminal transaction; a stale coverage snapshot cannot override an already persisted qualifying hit. Pin the recovery deadline and coverage/cadence policy to each accepted position so tabs do not invent different timeouts. Terminal outcomes stay terminal: data arriving after the validated finality deadline is recorded for diagnostics without retroactively debiting, crediting or reopening a settled bet. A contradictory post-finality sample is a coverage-policy defect to investigate, not permission to rewrite balances silently. N2's finality policy must pass delayed-sample tests before enabling live paper placement.

Persist the latest ledger, accepted terms and evidence needed by open positions. Hydrate before enabling bets. Reconcile open positions for both markets, including expired windows. Accepted multipliers stay frozen across reload, and restored positions do not consume the new page allowance. Free paper refill is an explicit additive transaction, not a ledger reset.

Keep all source evidence needed by unresolved positions; history pruning may never remove it. Preserve sufficient terminal evidence/provenance for the exposed recent-results records. Page suspension or closure stops local computation, so resume reconciles elapsed windows rather than claiming the browser ran while closed. Back/forward cache restoration of the same document retains its existing allowance; a true new document/refresh gets ten. A post-upgrade accepted bet uses its stored supported settlement policy; an unsupported policy must remain visibly unresolved pending an explicit documented recovery/refund decision, never be silently migrated into a different contract.

## Planned verification and evidence gates

These cases are requirements for future implementation tests; no listed runtime case has been executed by this planning task.

| ID | Concrete case | Required result |
|---|---|---|
| N3-A01 | $5 accepted at 2.50×, later quote changes; $0.10 at 1.05× and 1.04× | Debit once; wins return $12.50, $0.11 and $0.10 respectively; visible potential return equals credited gross return. |
| N3-A02 | Quote expires or lead-time falls short while waiting | No accepted bet, debit or allowance increment; typed unavailable/requote feedback. |
| N3-A03 | Two rapid $10 taps with only $10 balance | Exactly one accepted; other rejected; no negative balance. |
| N3-A04 | Same-square accepted stake $50, plus one more allowed stake | Extra command rejected; pair/zoom/rerender cannot bypass canonical cap. |
| N3-A05 | Retry same command, then distinct same-square tap | Retry replays original receipt; distinct tap is a new bet if eligible. |
| N3-A06 | Source time exactly start, one millisecond before end, exactly end | First two can qualify; end sample cannot. Receipt delay never changes timestamp inclusion. |
| N3-A07 | Price exactly lower or upper; jump across without sampled membership | Boundaries qualify; unsampled crossing does not. |
| N3-A08 | Out-of-order and duplicate samples; conflicting same-identity value | Stable deduplication/order; conflict is surfaced to N2 coverage and does not invent a win/loss. |
| N3-A09 | Complete window misses; incomplete window with no hit | Complete loses; incomplete recovers or refunds, never guesses. |
| N3-A10 | Pair switch, modal open/dismissed, page hidden during open bets | All existing bets continue or catch up for both markets; no dependency on render frames. |
| N3-A11 | Refresh after 9/10 accepted bets with pending positions | Old terms/balance recover; fresh allowance is zero; old hydration/settlement uses none. |
| N3-A12 | Concurrent taps at count 9; retry or rejected tap | Only one new acceptance; modal once after commit; later commands have no debit. |
| N3-A13 | Crash/reload around debit or credit transaction | Whole transaction or no transaction; no orphan debit, duplicate outcome or refund. |
| N3-A14 | Refill with active bets and exhausted allowance | Add $1,000 once per intended command; retain bets and count ten. |
| N3-A15 | Same-origin tabs race for balance, square cap or settlement | One coherent shared ledger, no overspend or double credit; each document retains its own ten-bet allowance. |
| N3-A16 | Storage abort/full/unavailable; unsupported schema; two tabs initialize | No orphan debit/count, no silent reset; initial grant occurs once; unavailable persistence pauses new bets. |
| N3-A17 | Committed acceptance but subscriber throws; command completion is uncertain | Coordinator reconciles and counts the original acceptance once; no extra acceptance event or eleventh bet. |
| N3-A18 | Stale loss/refund decision races a persisted qualifying hit | Re-read evidence/state atomically; valid persisted hit is honored; one terminal entry only. |
| N3-A19 | Boundary shared by adjacent bands; equivalent decimal forms; new quote/model revision | Both accepted neighbor bets may win; normalized values yield one canonical cell identity; revision does not reset the stake cap. |
| N3-A20 | Suspend/close then resume; back/forward cache; price history prune | Reconcile elapsed windows without fabricated ticks; same-document allowance survives; retain all evidence needed by open bets. |
| N3-A21 | Missed tenth-acceptance event, failed modal mount, duplicate/wrong-page presentation ack and layout-profile transition | Snapshot reconciliation opens once when possible; ack affects only matching document's shown flag at ten; count/ledger never change and dismissed offer does not reopen on rotation. |

Release evidence must include the test report, fixed fixture/provenance IDs, a two-market accepted-terms/settlement trace, a real browser reload/two-tab recording and inspectable persisted records showing one debit/terminal credit per position. N2's BTC/model/coverage proof and N5's tenth-bet browser proof remain graph dependencies, not successes implied by this plan.

## Review loops

Planning reviews below are actual document review/revision passes. Future implementation tests remain unexecuted.

### QA pass 1 — completeness review and correction

Reviewed the first draft against all four source notes and N2's inspected SDK precision finding. Found that the draft required exact payouts but left multiplier precision and cent rounding implicit; it also omitted cadence provenance from accepted terms. Corrected the quote contract to integer `grossX100`, added half-up final-cent arithmetic and explicit potential-return parity, and pinned cadence policy with model/config/rules provenance. Expanded N3-A01 with half-cent and below-half-cent cases. Residual gate: N2 must execute the two-market sampled-event/model proof; this document review does not supply it.

### QA pass 2 — adversarial and interface review / correction

Re-read the revised acceptance, recovery and test sections with two simultaneous tabs, slow commits, component remounts, throwing UI listeners and stale no-hit decisions. Found that the draft promised atomicity without specifying the storage primitive/transaction scope, and could leave the page quota or terminal decision dependent on UI delivery. Corrected the design to shared-origin IndexedDB transactions, unique debit/terminal keys, document-owned serialized counting before notification, explicit uncertain-command reconciliation and interval-evidence recheck at finality. Added storage failure/migration behavior and N3-A16–A18. Residual gate: actual browser multi-tab/abort tests and N2's delayed-sample finality policy remain required.

### QA pass 3 — corrected regression and traceability review

Re-read the entire twice-revised plan against the latest source instructions and the graph owner's shared schema. Found incompatible draft field names (`cellKey`, `commandId`, `PlaceBetCommand`, `priceAtoms/priceScale`) and a rules-version component in square identity that could reset the $50 cap on a configuration update. Aligned the wire vocabulary to N1's `cellId`, `requestId`, `pageLoadId`, `PlacementIntent`, `DecimalValue` and `open` status; separated quote provenance from canonical cell identity. Checked that earlier payout/quota/transaction fixes remain present. Added the inclusive-adjacent-band implication, hit-versus-no-hit coverage distinction, document-versus-back/forward lifecycle, protected evidence retention and N3-A19–A20.

| Requirement traced after correction | Planned evidence |
|---|---|
| Price decides outcome; visible locked odds decide gross payout | N3-A01, A06–A09, A19; N2 sampled-event proof. |
| No overspend, duplicate debit, duplicate settlement or same-square bypass | N3-A03–A05, A13, A15–A19. |
| Ten accepted placements; rejected/retried/hydrated bets excluded; modal does not pause outcomes | N3-A10–A12, A17 plus N5 browser contract. |
| Refresh grants ten while old funds/terms/bets persist | N3-A11, A13–A16, A20. |
| Missing evidence recovers/refunds without invented touch or loss | N3-A07–A09, A18, A20; N2 measured coverage/finality gate. |

**Node planning review result:** three review/revision passes completed; no known unresolved plan-level contract conflict after alignment. All implementation tests, storage behavior and live feed/model compatibility remain NOT RUN. Node approval is a plan review, not permission to label the future application runtime verified.

## Residual implementation gates

**Coordinator assembly correction before graph QA:** applied the monorepo package/port allocation, shared-unit helper boundary and N1/N5 offer-presentation acknowledgement, adding N3-A21. Original three node reviews remain preserved above; sequential graph QA assesses these corrections and the new adaptive consumers. Runtime tests remain NOT RUN.

- N2 must prove live BTC and ETH access, the five-second BTC $10 / ETH $0.50 model domain and event-definition compatibility; until then N3 uses explicit developer fixtures.
- N2 must supply a measured freshness/clock/coverage/recovery policy, including late samples and conflicting duplicates; do not invent numeric timeouts in N3.
- Browser storage, migration, races and recovery require executable tests during implementation. This node does not establish production integrity, regulated execution or provider support.
