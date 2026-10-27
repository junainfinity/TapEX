---
type: runtime-implementation-evidence
created: 2026-09-20
status: implemented-unit-verified-browser-integration-pending
node: N3
tags: [Maya, runtime, paper-engine, IndexedDB, QA]
---

# N3 — implemented paper engine and three QA rounds

**The local paper engine is implemented in `trading-game/packages/engine`. All 24 deterministic tests pass after three review/fix/recheck rounds; package typecheck and build pass.** Actual desktop/tablet/mobile browser integration, Docker hosting and real multi-tab browser verification remain graph-owner work. This note does not claim those checks ran here.

This is runtime evidence following [Maya Development - N3 Paper Engine](Maya%20Development%20-%20N3%20Paper%20Engine.md), [Maya Development - N1 Foundation](Maya%20Development%20-%20N1%20Foundation.md) and [Maya - Development Graph](Maya%20-%20Development%20Graph.md). Frozen planning notes were not rewritten. The new implementation uses only `@maya/contracts` and `@maya/config`; market data, quotes, clock and settlement policy are injected through shared ports. There is no feature-package side import, signup, server ledger, real execution, RNG outcome or external write.

## Delivered files and API

| File | Implementation |
|---|---|
| [Engine API](../../packages/engine/src/index.ts) | `PaperEngine`, serialized acceptance, ten-bet page allowance, offer acknowledgement, exact settlement and recovery. |
| [IndexedDB storage](../../packages/engine/src/storage.ts) | One atomic aggregate ledger record containing balance, positions, exposure, command/refill receipts, source evidence/conflicts and debit/terminal entries. |
| [Executable cases](../../packages/engine/tests/engine.test.ts) | 24 Vitest cases using real IndexedDB API semantics via `fake-indexeddb`, deterministic clock/feed/model ports and multiple independent engine instances. |

Construct `new PaperEngine({ clock, quotes, marketData, settlementPolicy, minLeadMs, pageLoadId? })` and await `initialize()`. The API is `getSnapshot()` / `snapshot()`, `getAllowance()`, `subscribe(listener)`, `placeBet(intent)` / `place(intent)`, `refill(requestId?)`, `tick()`, `refresh()`, `acknowledgeOfferShown(ack)` and `dispose()`. A per-document ID defaults to a new UUID. Root composition must call `tick()` once after initialize and on a periodic timer so outage recovery advances without feed events; the engine also subscribes to data changes. Inject N2's `SETTLEMENT_POLICY` and validated `getMinLeadMs` into composition.

The origin-scoped database defaults to `maya-paper-v1`. Tests can inject another IndexedDB factory/name and starting balance. One aggregate object store is a deliberate implementation simplification from the planning sketch's multiple stores: every writer still enters an overlapping read/write transaction, so debit, exposure, receipt and position or terminal credit remain atomic across tabs. Initial grant has one persisted identity; no per-tab money reset occurs.

## Behavior verified in the node

1. **Exact accepted terms.** Quote registry identity, revision, canonical five-second cell, aligned BTC $10 / ETH $0.50 band, active model policy, source observation, quote lifetime, lead time, health, stake menu, balance and shared square exposure are validated inside the transaction. Shared helpers keep decimal comparisons exact. Frozen visible `grossX100` produces a half-up integer-cent gross return; later quotes cannot alter it.
2. **No duplicate funds or allowance.** Stored request receipts make retries idempotent. New accepted placements debit once and increment page memory before notifying UI listeners. Ten accepts close the page gate; a throwing listener cannot create an eleventh. Hydration, retries, rejection, outcomes and refill do not count. Offer acknowledgement changes only its matching exhausted page's shown flag.
3. **Sampled outcomes.** Source samples are identified by feed and source timestamp; both price edges count and time is `[start,end)`. Future samples cannot settle before their source time; jumps without sampled membership do not touch. An exact shared price boundary can win both neighboring accepted bands. The modal has no control over the settlement engine.
4. **Recovery and reload.** Persisted samples supplement the current N2 buffer. A complete cadence under the accepted policy, valid watermark and no conflicts supports a loss even after older provider-buffer samples roll off. Missing history waits then refunds at the pinned deadline. Conflicting source observations are quarantined. A later contradiction does not silently reopen a terminal position.
5. **Shared browser ledger.** Two engine instances race against the same IndexedDB factory/database without overspending, exceeding a square cap, duplicating a grant or crediting an outcome twice. Each page has independent allowance. Aborted storage writes mutate neither the durable ledger nor count; unsupported stored schema pauses without silently deleting data.

## Three executed QA loops

| Round | Actual review, defect or correction | Recheck evidence |
|---|---|---|
| 1 — normal exact behavior | Reviewed cell and quote authority, added aligned-band and authoritative-observation validation. Verified BTC/ETH hit, exact 2.50× gross, fractional-cent rounding, inclusive adjacent edges, no interpolation/end-time touch, normal reload and gap refund. | **7/7 passed** in [pass 1 JSON](../../packages/engine/artifacts/qa-pass-1.json). |
| 2 — adversarial transactions/interfaces | Initial run: **15 passed, 2 failed**. Provider conflict notifications were not applied before settlement, and an invalid “complete” report with one sample could produce a loss. Persisted the conflict notifications and required every pinned cadence slot. Also exercised ten concurrent placements, same-request conflict/retry, stale transaction-time validation, cross-tab balance/cap/init/credit races, throwing subscribers, offer acknowledgement and disk-full rollback. | [Before-fix report](../../packages/engine/artifacts/qa-pass-2-before-fixes.json), then **17/17 passed** in [pass 2 JSON](../../packages/engine/artifacts/qa-pass-2.json). |
| 3 — corrected regression/lifecycle | Initial run exposed an early win from a future-dated sample; restricted settlement to usable source clock/time. A further recovery regression exposed refund despite a fully persisted no-hit window after the provider buffer rolled off; reconstructed completeness from durable samples with the same cadence, watermark, policy and conflict gates. Rechecked immutable terms, terminal finality, stale/wrong-page/revision/lead rejection, unsupported schema and a persisted hit preceding another tab's miss decision. | [Future-sample failing report](../../packages/engine/artifacts/qa-pass-3-before-fixes.json), [recovery failing report](../../packages/engine/artifacts/qa-pass-3-recovery-before-fix.json), then **24/24 passed** in [pass 3 JSON](../../packages/engine/artifacts/qa-pass-3.json). |

Commands executed from the engine package: `pnpm exec vitest run tests/engine.test.ts --reporter=default --reporter=json --outputFile=artifacts/qa-pass-N.json`. Executed from the workspace: `pnpm --filter @maya/engine typecheck` and `pnpm --filter @maya/engine build`, both successful after the final fixes. Dependency scaffolding and install belonged to N1; no root manifest was changed by N3.

## Remaining graph evidence

Coordinator integration correction after the original three rounds: bounded idle sample/conflict retention to the newest120 seconds while retaining evidence for every terminal result and all open windows. Added a regression that checks old idle samples are pruned without deleting a winner's durable evidence or changing its balance/result. The engine now passes25 tests; original24-test reports/hashes remain historical. Final root workspace and live journal evidence is recorded in [Maya Runtime - N6 Integration and Docker](Maya%20Runtime%20-%20N6%20Integration%20and%20Docker.md).

N6/root must prove actual browser behavior: real two-tab IDB transactions and refresh, background/resume, desktop/tablet/mobile layout transitions using the same instance, the tenth-bet modal/reconciliation, dummy booking link, live N2 price/model integration and hosted Docker experience. `fake-indexeddb` verifies the transaction algorithm but is not a substitute for these browser checks. Input/model calibration and provider health remain N2's authority; this engine does not claim Euphoria odds parity or live market-maker execution.

The ledger keeps local history and required evidence; browser data deletion cannot be recovered without an account/backend, which is outside this anonymous demo. Storage unavailability/full/corruption pauses acceptance rather than accepting a nonpersistent bet. No production integrity or anti-tampering claim is made for this editable local paper ledger.
