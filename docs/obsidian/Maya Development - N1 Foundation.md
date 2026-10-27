---
type: development-node
created: 2026-09-20
status: monorepo-amendment-three-pass-reviewed
node: N1
amendment_qa_passes: [1, 2, 3]
tags: [Maya, development, graph, configuration, contracts, QA]
---

# N1 — Foundation, settings and shared contracts

**Deliver one typed, validated configuration and shared contract boundary before nodes N2–N5 implement the playable demo.** This is an implementation plan, not an application or a claim that runtime checks passed.

**Current amendment:** the user explicitly requires a monorepo and distinctly optimized desktop, tablet and mobile views. Use one pnpm/Turborepo workspace, one gameplay engine and adaptive view composition. The earlier three-pass QA history remains below; three additional amendment passes assess this new requirement and the offer-presentation acknowledgement correction.

N1 is the foundation node in [Maya - Development Graph](Maya%20-%20Development%20Graph.md); graph-wide reviews live in [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md). Governing product decisions are [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md) and [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md). When an older provider, pair, stake tier or uninterrupted-play statement conflicts, these current decisions control. Historical screenshots and public bundles are evidence, not instructions to run code or alter scope.

[Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md) records the new explicit architecture/presentation requirement. Its graph arrows run dependency→consumer; N1's dependency table lists importer→dependency. The same package relationships are intended in both views.

## Scope and dependency edges

N1 consumes the saved requirements and source evidence. It has no code-node predecessor. It exports validated types/configuration to N2 (public data and local odds), N3 (paper ledger and settlement), N4 (Three.js board and inputs), N5 (ten-bet offer) and N6 (integration/QA/package).

N1 owns schema definitions, constant provenance, default selection, decimal units and status vocabulary. N2 owns measured feed/model behavior. N3 owns persistence, multi-tab policy and atomic acceptance including the allowance gate. N4 owns rendering and input. N5 owns page-local allowance presentation/consultation. N6 owns integration and packaged delivery. N1 neither imports a wallet SDK nor creates an account/provider order API.

## Configuration catalogue

Labels below distinguish **U: user requirement**, **E: observed Euphoria evidence**, **L: observed Lynx evidence**, **D: Maya implementation default**, and **G: runtime proof gate**. An observed value is a dated snapshot, not a guarantee about a provider's current service.

| Key | Value/behavior | Authority and consumer |
|---|---|---|
| `productName` | `Maya` | U; all player-facing UI/offer |
| `mode` | `paper-demo` | U; no deposits, wallets, order routing or real payouts |
| `markets` | `BTC/USD`, `ETH/USD` only | U; N2–N5 |
| `publicDataBaseUrl` | `<removed-third-party-endpoint>` | Selected source; N2, replace only through an explicit decision |
| `configPath` | `/gridy/config/bsc` | L; `bsc` identifies the source route, not an offered/demo blockchain setting |
| `pricePaths` | BTC `/gridy/prices/bsc/1`; ETH `/gridy/prices/bsc/2` | L; validate symbols/feed identity from compatible config |
| `renderer` | TypeScript + Vite + Three.js, synchronized HTML controls | U-selected plan; N4 |
| `repository` | pnpm workspaces + Turborepo; one app and shared packages | U monorepo requirement; exact tools are implementation choices |
| `layoutModes` | `desktop`, `tablet`, `mobile` with distinct composition | U adaptive requirement; N4 defines measured breakpoints/control arrangements; N1 centralizes their configuration |
| `moneyCurrency` | virtual USD | U; N3/N4 |
| `stakeMenuCents` | `[10, 50, 100, 500, 1000]` | D from E standard limits; same menu for everyone |
| `initialStakeCents` | `100` ($1) | D; selecting it does not place a bet |
| `maxStakePerBetCents` | `1000` ($10) | D from E standard limit |
| `maxAcceptedStakePerCellCents` | `5000` ($50) | D from E standard limit; N3 validates canonical cell identity |
| `startingBalanceCents` / `refillCents` | `100000` / `100000` ($1,000 each) | D, not separately user-specified numbers; refill leaves open positions and allowance intact |
| `zoomMin` / `zoomMax` | `0.345` / `0.9` | E; clamp every input path |
| `initialZoom` | `0.6` | E fresh-route value; no fixed preset array |
| `zoomInFactor` / `zoomOutFactor` | `1.1` / `0.9` | E; multiplicative steps then clamp; pinch is continuous |
| `cellPixels` | `canvasLogicalHeight / 6 × zoom` | E; CSS/logical pixels, separate from device pixel ratio |
| `windowMs` | `5000` | E adopted by Maya |
| `priceBandUsd` | BTC `10`; ETH `0.50` | E adopted by Maya; ETH geometry requires N2 model-domain proof |
| `timeInclusion` | `start <= sourceTime < end` | Explicit Maya rule, not verified server parity |
| `priceInclusion` | `lower <= sourcePrice <= upper` | Explicit Maya rule; a shared exact edge can qualify both adjacent bands |
| `windowAlignment` | Unix epoch multiples of 5,000 ms | D to make keys and quote/renderer alignment deterministic |
| `maxNewBetsPerPage` | `10` accepted new placements across both pairs | U; N3 atomic gate, N5 presentation |
| `consultationUrl` | `https://example.com` | U-approved dummy destination, not an actual scheduler |
| `consultationTitle` | `Launch Maya under your brand` | Saved proposed copy; N5 owns the rest of the approved-direction offer |

Source-derived dynamic values are not hard-coded product limits: saved Lynx `minDelay=3` seconds, formula version `3.0.0`, `houseEdge=0.1`, `minPayoutX=1.01`. N2 must validate a compatible live snapshot and emit versioned metadata. Published model table version `2` and inspected SDK `0.0.1-alpha.1` are separate version namespaces. Do not treat table `2` versus formula `3.0.0` as a mismatch by string comparison alone.

N2 must supply the actually validated quote horizon, quote lifetime, polling behavior, clock authority, stale threshold and compatible model domain. N3 must supply measured complete-window/catch-up rules. These are G items, not guessed defaults. Unsupported/malformed/stale inputs disable placement instead of silently substituting vendors or fabricating odds. A compatible config update affects new quotes only; accepted paper terms remain immutable.

### Source boundaries

The full Euphoria menu `[0.10, 0.50, 1, 5, 10, 25, 50]` is tier-filtered. Maya's anonymous demo intentionally excludes inaccessible $25/$50 choices and account/VIP gating. The generic min zoom found elsewhere in source does not override the asset-specific `0.345`. A browser route's saved settings do not prove a different fresh default. No discrete five-level zoom list was found.

The saved Lynx config's production minimum/maximum token amounts, chain contracts, risk limits and default live-board geometry are not Maya's stake menu, balance, blockchain setup or authoritative odds. ETH's saved server steps are `0.1/0.15/0.3`; Maya's `$0.50` must be demonstrated through supported local pricing primitives. No exact numeric Euphoria odds, ready Wintermute integration or real market-maker execution is claimed.

## Canonical monorepo output and file-to-package map

These are future files under **`<repo>`**. This map supersedes the original single-root `src/` sketch. No application file is created by this planning node.

| Directory / package name | Canonical file allocation and owner | Direct workspace dependencies |
|---|---|---|
| `packages/contracts` / `@maya/contracts` | `src/contracts.ts`, `units.ts`, `identities.ts`; N1 DTOs, decimal/cents, cell IDs and shared ports | None |
| `packages/config` / `@maya/config` | `src/demo.ts`, `validate.ts`, `provenance.ts`, `adaptive.ts`; N1 numeric/demo settings and N4-specified view policy | `@maya/contracts` |
| `packages/market-data` / `@maya/market-data` | `src/client/`, `normalization/`, `clock/`, `coverage/`; N2 transport/sample/health/recovery. Optional `src/server/` relay helpers have a separate export | `@maya/contracts`, `@maya/config` |
| `packages/pricing` / `@maya/pricing` | `src/model/`, `domain/`, `quotes/`; N2 local model and quote registry; receives validated samples through ports | `@maya/contracts`, `@maya/config` |
| `packages/engine` / `@maya/engine` | `src/acceptance/`, `ledger/`, `settlement/`, `storage/`, `recovery/`; N3 exact money, IndexedDB and acceptance | `@maya/contracts`, `@maya/config` |
| `packages/game-ui` / `@maya/game-ui` | `src/scene/`, `input/`, `controls/`, `layouts/{desktop,tablet,mobile}/`, `consultation/`; N4 distinct view composition and reusable N5 dialog presentation | `@maya/contracts`, `@maya/config` |
| `apps/demo` / `@maya/demo` | `src/bootstrap/`, `composition/`, `sales-flow/`, `tests/e2e/`; N6 wiring, N5 document allowance/modal lifecycle, Vite entry and static assets | All six packages above |
| `apps/feed-relay` / `@maya/feed-relay` — conditional | Minimal read-only relay only if N2 proves browser access requires it; no provider order/auth/ledger functions | `@maya/contracts`, `@maya/config`, `@maya/market-data` through explicit server entry only |

Dependencies point from importer to imported package. This is a DAG: contracts → no workspace dependency; config → contracts; feature packages → config/contracts; apps → their required feature packages. There are no feature-to-feature imports. `apps/demo` injects `PriceSource`, `QuoteRegistry`, coverage, clock and allowance ports into pricing/engine/UI. Packages never import apps, and browser code never imports the relay or the market-data server entry. Each package declares every dependency it imports, including external libraries; the root does not hide missing package dependencies.

N1 supplies root `package.json` (private), `pnpm-workspace.yaml` with `apps/*` and `packages/*`, one committed `pnpm-lock.yaml`, `turbo.json`, documented runtime/package-manager versions, and `tooling/tsconfig/` plus shared lint configuration. Compiler/lint tooling lives outside the runtime config package to avoid a contracts↔config dependency cycle. Each package has its own `package.json`, compiler configuration and relevant task scripts. `apps/demo/vite.config.ts` belongs to the app. Provenance and architecture documentation live under root `docs/`.

Use private package names above and `workspace:*` for internal dependencies, so the resolver cannot silently fetch a same-named remote package. A workspace root file and the explicit workspace protocol are documented by [pnpm](https://pnpm.io/workspaces). Pin actual compatible Node, pnpm, Turbo, TypeScript, Vite, Three.js and test tooling versions during implementation; do not adopt version numbers from a skill header as verified current versions. No registry publication, remote-cache login, service account or installation occurs in this plan.

### Package exports and dependency boundaries

Choose compiled ESM plus declaration outputs for internal runtime packages: explicit `exports` entries expose `types` and runtime `import` targets under each package's `dist/`. Contracts exposes approved contracts/units/identities; config exposes demo/adaptive/provenance; market-data exposes a browser-safe client entry and separately opt-in server entry; pricing/engine/game-ui expose deliberate integration APIs. No `src/*` wildcard exports, cross-package relative imports, TypeScript path aliases bypassing package exports, or duplicated contracts. Static CSS/assets get explicit game-ui exports as needed. These are Maya design choices based on the official [package-entrypoint documentation](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/structuring-a-repository.mdx) and [compiled internal-package option](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/core-concepts/internal-packages.mdx).

Do not rely on an unverified example `boundaries` config shape from the skill. During implementation, validate manifests/exports with compiler resolution and a small dependency-boundary check; add a built-in Turbo boundary check only after verifying the pinned version's actual schema. The graph check rejects cycles, app imports from packages and forbidden server imports into the demo bundle.

### Adaptive composition contract

`LayoutMode` is `desktop | tablet | mobile`. `ViewportContext` describes available logical width/height, orientation, pointer/hover capabilities, pixel ratio, safe-area needs and reduced-motion preference. N4 selects a mode from measured viewport/container needs and input capabilities; device names or user-agent guesses cannot determine gameplay behavior. N4 owns the view layouts/breakpoint values, then N1 records them once in `@maya/config/adaptive` for tests and composition.

The current N4 proposal, as recorded in the architecture note, selects `mobile` (compact) first when logical width <768 CSS px **or usable height <500 px**; otherwise `tablet` (medium) when width <1200 px **or** primary pointer is coarse and width <1440 px; otherwise `desktop` (wide). `compact/medium/wide` are presentation aliases, not extra modes. Record these ordered predicates as Maya defaults, separate from recovered Euphoria constants. Pointer/hover capability remains independently available within each mode. Include 767/768, 1199/1200, 1439/1440 and 499/500 boundary fixtures, landscape and coarse/fine input cases; physical device identity is never inferred from a threshold.

Desktop uses the full board with persistent richer controls/results; tablet uses a touch-optimized board and reorganized controls/results; mobile uses a dedicated compact arrangement and reachable controls/results. These are three compositions of the same scene/input primitives, not desktop CSS uniformly shrunk. N4 defines precise placements, hit targets and landscape behavior; N6 verifies each independently.

`apps/demo` creates the engine, data/model services and page allowance once above the layout switch. Width changes, orientation, tablet keyboard attachment, modal relocation and component remounts cannot recreate these services, refresh the ten-bet allowance or alter accepted terms. Preserve selected pair/stake/zoom and modal state while adapting; cancel an in-flight gesture when the transform changes instead of turning its release into a bet.

### Task graph and evidence cache policy

| Task | Dependencies and outputs | Cache/lifecycle policy |
|---|---|---|
| `build` | `^build`; package-local `dist/**`; compile libraries before app | Deterministic local cache allowed |
| `typecheck` | `^build` for compiled dependency declarations; no file output required | Local cache allowed with complete source/tooling inputs |
| `lint` | Package source and shared lint rules; type-aware lint, if selected, also waits for dependency declarations | Local cache allowed with complete inputs |
| `check:boundaries` | Root direct script inspects all workspace manifests/imports/exports against the declared DAG | Execute freshly outside Turbo caching; no specialized root-task syntax is assumed |
| `test:unit` | Own `build`; package-local deterministic fixture/coverage/report inputs/outputs | Local cache allowed for developer repetition; fixture hashes are inputs |
| `dev` | Finite `^build` first; library watchers and Vite are long-lived peers | `cache:false`, `persistent:true`; no task depends on another persistent task completing |
| `probe:live` | Own compiled data/pricing probe implementation; public live HTTP/model/browser-origin observations | `cache:false`; write a new dated run record every invocation |
| `test:e2e` / `qa:evidence` | Finished build plus test-owned preview lifecycle; desktop/tablet/mobile, reload/races/modal/adaptation checks | `cache:false`; fresh reports/screenshots per run, never restored QA success |

The documented `^build`, `outputs` and uncached/persistent task behavior support this plan. [Turborepo task configuration](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/configuring-tasks.mdx).

Root scripts explicitly use **`--cache=local:rw`**, which excludes remote cache access; no Turbo account, token, team or login is needed. During required fresh QA passes use `--force` for normally cacheable deterministic test tasks, and keep live probes/E2E/evidence permanently `cache:false`. The documented run options distinguish local-only cache and forced execution. [Turborepo run reference](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/run.mdx).

Keep default source inputs rather than prematurely restricting them. Add root tooling files as `globalDependencies`; add every build-affecting public `VITE_*`/configuration variable to the relevant hashed environment inputs. Do not hide influencing values in passthrough-only variables. Pin fixture/model snapshots used in deterministic tests, never pretend a cached fixture result proves a live feed. Evidence includes run ID/time, source revision, declared browser/view matrix and actual execution status. An old report on disk cannot satisfy a new QA invocation.

`test:e2e` owns start/readiness/stop of a built preview and optional relay; it does not depend on an infinite `dev` task finishing. Register live probe scripts in their owning data/pricing packages and an explicit root orchestration script to collect both runs. Build caches may supply unchanged executable artifacts, but the network/browser probe itself still runs now. Distinct output directories/run IDs prevent a stale report being read when the new process fails. N6 must verify cold build, dependency-change invalidation and fresh repeated evidence invocations after the actual versioned scripts exist.

## Shared data and event contracts

All monetary persistence/wire amounts are base-10 integer **cent strings**, converted to `bigint` for calculations. All source prices/bounds preserve decimal precision as `{ coefficient: string, exponent: number }`, representing `coefficient × 10^exponent` USD. Normalize equivalent forms for comparison and identity. N2 preserves the original JSON price lexeme or demonstrates that its parser/conversion is lossless for every supported source value; parsing to binary floating point and later printing a string does not by itself preserve exact source decimals. Do not round source prices to cents before testing a hit. Runtime numeric conversion may be used for plotting/model input with explicit precision checks, never as settlement authority. Validate finite safe integer timestamps and bound coefficient/exponent sizes before computation.

The agreed N2/N3 multiplier contract is **`grossX100`**, a positive integer encoded as a decimal string. N2's static inspection found that the SDK preview floors gross multipliers to two decimal places. Compute `grossX100 = floor(modelGrossMultiplier × 100)` with decimal-safe arithmetic, then derive the visible multiplier and immutable accepted multiplier from that same integer. No hidden higher-precision payout or substituted quote is allowed. The coincidentally similar Euphoria quote scale is separate evidence, not the reason for this choice.

N3 computes gross payout with positive integer round-half-up to the cent: `grossReturnCents = (stakeCents × grossX100 + 50) / 100` using truncating bigint division. Thus 500 cents at `grossX100=250` returns1250 cents; 50 cents at201 returns101 cents after rounding100.5 cents. N4 uses the same helper for the shown potential return. Source prices retain their independent exact decimal precision; two-decimal odds do not imply cent-rounded prices.

| Contract | Required content and invariants |
|---|---|
| `MarketDefinition` | Internal `btc-usd`/`eth-usd`; exact display symbol; source pair/feed identity; decimal band height; no BTC/ETH or USDT alias |
| `CellTerms` | `marketId`, `startMs`, `endMs`, exact decimal `lowerPrice`/`upperPrice`, and separate `ruleVersion`; `cellId` derives only from stable schema prefix + market + window + bounds, independent of model/config/rules revisions, zoom, pan or pixels |
| `PriceSample` | Source pair/feed ID, normalized decimal value, integer Unix `sourceTimeMs`, receive time, source revision/sequence if available, deterministic sample ID; identical duplicate versus conflicting duplicate distinguished |
| `InputHealth` | Market ID; status `loading`, `ready`, `stale`, `recovering`, `unavailable` or `incompatible`; reason; last source observation; model/config identity; measured coverage details from N2 |
| `QuoteSnapshot` | `quoteId`, revision, complete `CellTerms` with canonical `cellId`, `grossX100`, player-visible multiplier text derived from that integer, created/expiry timestamps and clock basis, observation watermark, model/config/table identity and hashes, `simulated=true`; valid only for its frozen terms |
| `CellDemand` / `AvailabilityReport` | Exact cell identities requested by canonical-model-probe or viewport consumer; separate ModelCandidateCoverage and ViewportPlayableCoverage metrics with policy ID, evaluation instant, denominator/status reasons and quote IDs. Model invalidity, lead/TTL cutoff and visual clipping remain separate; visibility never changes quote terms. N2 defines the fixed probe set; N4 owns view geometry. |
| `PlacementIntent` | Unique idempotency `requestId`, current `pageLoadId`, `quoteId`/revision, `stakeCents` and `cellId`; N3 verifies canonical quote and all gates, not UI-supplied computed payouts |
| `PlacementResult` | `accepted` with immutable position ID/terms/stake/`grossX100`, debit ID and `newlyCommitted` flag; or `rejected` with typed reason and no debit; already accepted retry returns existing result |
| `PositionSnapshot` | Accepted quote/market/cell/stake/`grossX100`, acceptance/debit identity, state `open`, `won`, `lost` or `refunded`; outcome evidence and terminal credit/refund identity; recoverable JSON schema version |
| `PositionChanged` | Position ID/revision, terminal outcome and exact gross return/refund in cents; N4/N5 observe, never settle or mutate accounting |
| `PageAllowanceSnapshot` | Fresh document ID, accepted-new count 0–10, remaining 0–10 and offer-shown flag; memory-only, emitted from acceptance owner; hydration/retry/settlement/refill cannot increment it |
| `OfferPresentationAck` | `pageLoadId`, unique `presentationId`; N5 sends only after the consultation is successfully visible/focused. N3's `acknowledgeOfferShown(ack)` returns the authoritative allowance snapshot and sets only `offerShown=true` for this document at accepted count10; stale-document/early acks reject, duplicates are idempotent |

Shared rejection reasons include `ALLOWANCE_EXHAUSTED`, `INSUFFICIENT_BALANCE`, `STAKE_NOT_ALLOWED`, `CELL_CAP_EXCEEDED`, `QUOTE_EXPIRED`, `QUOTE_CHANGED`, `TOO_LATE`, `INPUT_NOT_READY`, `UNSUPPORTED_CELL`, `STATE_NOT_READY` and `REQUEST_CONFLICT`. Keep technical detail in developer logs; N4/N5 map reasons to brief player feedback. A timeout is not proof of rejection: retry uses the same request ID.

These are the canonical shared DTO names. Node-local aliases such as `PlaceBetCommand`, `commandId`, `cellKey`, `priceAtoms/priceScale` or the conceptual accepted state must map explicitly to `PlacementIntent`, `requestId`, `cellId`, `DecimalValue` and persisted `open`; they must not create parallel subtly different schemas. N1's shared definitions are imported by each node. An exact price at either shared band boundary remains a valid hit for both adjacent cells under the selected inclusive-price rule.

In particular, **model/config/rules revisions are provenance fields, not part of the exposure-cap cell identity**. Otherwise a config update could recreate the same market/window/band under a new ID and bypass the $50 cap. The stable cell-key schema prefix changes only through an explicit storage migration that preserves aggregate exposure. Normalize decimal bounds before constructing IDs so `0.50`, `0.5` and `50 × 10^-2` cannot create different cells.

Acceptance notifications must distinguish a new atomic commit from an idempotent replay/hydration. N3 owns allowance mutation inside its acceptance critical section; N5 must not increment a second counter after rendering. The agreed sequence is durable IndexedDB debit/position commit, then synchronous in-memory count increment before queue release and acceptance/offer events. A failed durable commit changes neither count nor balance. A process ending after commit is a new page load when restored, deliberately receiving a new allowance; restored positions never count as new placements. Component remounts/pair changes cannot reset the page document's allowance. N3 owns shared-origin IndexedDB transaction design, multi-tab coordination and migration; N1 defines the shared schema only. A new tab has its own allowance but must not bypass shared durable balance/cell limits through a race.

The consultation is state-reconciled, not event-only: N5 checks **`acceptedCount === 10 && !offerShown`** both when subscribing/mounting and after state changes. A missed tenth-acceptance event therefore cannot suppress the offer. After successful presentation N5 calls `acknowledgeOfferShown({pageLoadId, presentationId})`; this changes neither count, balance, positions nor the placement gate. Failure to present leaves `offerShown=false` so retry/reconciliation remains possible. The N5 app-level view state separately retains whether the already-shown modal is still open or dismissed across adaptive remounts. The acknowledgement does not dismiss it, and an open modal does not reopen after explicit dismissal merely because layout changes. Both state containers live above all desktop/tablet/mobile compositions and reset only on a new document.

N5 has one app-level presentation controller with an in-flight presentation guard and stable `presentationId`; individual layout components cannot independently open duplicate offers. A layout transition transfers that controller's open dialog state to the new view. If mounting/presentation fails, clear only the in-flight guard and retry reconciliation; do not falsely acknowledge display. N3 serializes acknowledgement state updates and rejects an early or foreign-page acknowledgement without changing anything. This method never persists a quota or writes a ledger transaction.

N2's static model inspection also found silent lookup-coordinate clamping. Require explicit domain checks for all four lookup coordinates before a preview is offered; an out-of-domain cell is unavailable rather than assigned a boundary table value. No extrapolation, implicit clamp, arbitrary odds ceiling or invisible geometry adjustment can be presented as a valid Maya quote. The N2 model proof must still resolve the event-model versus sample-settlement calibration limit.

## Work sequence

1. Implement and validate the current scope configuration with provenance labels. Preserve the source snapshots as evidence rather than executing downloaded provider code by default.
2. Define shared DTOs, units, IDs and error vocabulary with N2/N3, using their measured precision and clock/coverage decisions.
3. Add small representative fixtures for both markets, quote acceptance/rejection, late data and terminal outcomes; fixtures must be marked historical/synthetic developer data.
4. Review contract usage with N4/N5 so pixel geometry, readable quote precision, count updates and modal presentation cannot affect accepted terms.
5. Hand N6 the config/contract acceptance checklist and explicit unresolved gates. Freeze a schema version for the first integrated build; incompatible changes require a coordinated migration.

## Acceptance and future test cases

| ID | Check and expected result | Runtime owner/status |
|---|---|---|
| N1-01 | Config exposes only Maya paper demo, BTC/USD and ETH/USD; no credential/provider setup or fallback route | N1/N6 — NOT RUN |
| N1-02 | Menu exactly 10/50/100/500/1000 cents; $1 default; $10 per bet/$50 per cell; up/down reaches endpoints without overflow or auto-betting | N1/N4/N3 — NOT RUN |
| N1-03 | All wheel/button/pinch zoom paths clamp .345–.9; fresh .6; multiply 1.1/.9; canvas/DPR mapping yields identical logical selection | N4 — NOT RUN |
| N1-04 | Both render/model/settlement use one five-second cell ID and exact BTC10/ETH.50 bounds independent of zoom/pair switch | N2/N3/N4 — NOT RUN |
| N1-05 | Decimal prices immediately above/below a boundary remain distinguishable; JSON round-trip preserves large cents and multiplier precision | N1/N3 — NOT RUN |
| N1-06 | Same source sample duplicate deduplicates; conflicting same identity pauses affected acceptance and is not silently overwritten | N2/N3 — NOT RUN |
| N1-07 | $5 at2.5× pays1250 cents once; $0.50 at2.01× displays/credits101 cents using half-up rounding; a raw2.019 model output is accepted/displayed as2.01×, never2.02× | N2/N3/N4 — NOT RUN |
| N1-08 | Request replay/hydration/refill/pair switch produces no new allowance count; tenth atomic acceptance emits one consultation trigger | N3/N5 — NOT RUN |
| N1-09 | Incompatible/malformed model/config or any out-of-domain lookup coordinate closes quoting before silent SDK clamping; previous accepted positions retain original terms and settlement rule version | N2/N3 — NOT RUN |
| N1-10 | CTA config is dummy HTTPS URL; no scheduler success, provider agreement or production integration is implied | N5/N6 — NOT RUN |
| N1-11 | Fresh checkout uses documented pinned runtime, pnpm and one frozen workspace lockfile; full build/check commands succeed without credentials or provider trading libraries | N1/N6 — NOT RUN |
| N1-12 | Workspace contains one demo and six declared shared packages; imports follow the manifest DAG/exports and optional relay is browser-proof dependent | N1/N6 — NOT RUN |
| N1-13 | Repeated identical live probe/E2E/evidence tasks execute afresh; a changed fixture/config/root tooling invalidates relevant deterministic caches; no remote-cache traffic | N1/N6 — NOT RUN |
| N1-14 | Desktop→tablet→mobile/orientation change preserves one engine, selections, ledger, page count and open/dismissed offer state; transform-changing gesture cannot place | N1/N4/N5/N6 — NOT RUN |
| N1-15 | N5 misses tenth event/remounts before display, reconciles count10+unshown, presents and acks once; early/stale/duplicate ack never alters quota/ledger; failed presentation remains retryable | N1/N3/N5 — NOT RUN |

N1 exits when configuration and schemas are implemented, validation cases pass, and N2/N3 accept unit/time/precision interfaces in writing. It may unblock UI scaffolding using clearly marked fixtures before live proof, but N6 cannot call the playable experience complete while N2's exact-cell model proof or N3's accounting/recovery gate remains open.

## QA pass 1 — completeness and source reconciliation

**Actual work performed:** read the three governing product/implementation/offer notes, the demo gap review, saved `euphoria-controls-facts-2026-09-20.json` and `lynx-provider-config-2026-09-20.json`. Compared numeric defaults, scope and evidence categories before drafting this node.

**Findings and changes:** retained the asset-specific continuous zoom rather than withdrawn presets; separated full tiered reference menu from shared standard demo menu; recorded $1,000/$1/refill as defaults rather than claimed explicit numeric user choices; retained ETH.50 as a model-adaptation gate; separated source `bsc` routing from player-facing chain choice; required local multiplier provenance rather than exact Euphoria odds. Added the tenth-acceptance event and page-memory allowance separation to shared interfaces.

**Status:** plan completeness/source review complete. Runtime validation remains NOT RUN. Open for pass2: adversarial contract review of decimal serialization, quote/display agreement, multi-tab ledger ownership and source coverage.

## QA pass 2 — adversarial and cross-node interfaces

**Actual work performed:** re-read the draft and challenged it with lost JSON precision, a2.019 raw multiplier, a half-cent gross return, a tenth-bet durable-write failure, an accepted request retried after refresh, shared-balance multi-tab access, and an unsupported model lookup coordinate. Reconciled N2/N3's interface decisions delivered by the graph owner.

**Findings and changes:** replaced the overgeneral rational multiplier proposal with the verified two-decimal `grossX100` contract; specified decimal-safe flooring and one half-up cents helper for display/settlement; required original price precision preservation; made durable commit → synchronous page count → events the acceptance order; assigned IndexedDB/multi-tab ownership to N3; added an explicit pre-lookup rejection requirement to prevent SDK clamping from silently changing quoted geometry.

**Status:** identified contract contradictions corrected in this plan. No runtime behavior was tested. Remaining gates: N2's measured timing/coverage/domain and model-event proof, N3's durable transaction/multi-tab implementation, and N4's logical-pixel/input demonstration. Pass3 will check correction/requirement traceability and the final cross-node vocabulary.

## QA pass 3 — correction recheck and acceptance traceability

**Actual work performed:** re-read the corrected N1 plan alongside [Maya - Development Graph](Maya%20-%20Development%20Graph.md) and the N3 paper-engine draft, then mapped every owned configuration/contract obligation to its future test and graph requirement. Checked the earlier numeric, rounding, allowance-ordering and silent-clamping corrections again.

**Findings and changes:** corrected the graph-note link and fixed the application root to `<repo>`; added the previously missing pinned-scaffold/lockfile deliverable and N1-11; made `quoteId/cellId/requestId/pageLoadId` and exact-decimal DTO names canonical, with explicit alias mapping for node-local engine names. Clarified that persisted `open` is the accepted nonterminal state. Cross-node recheck found that including model/config/rules versions in cell identity would bypass exposure caps after a revision; corrected the key to stable schema + market/window/bounds and kept versions as metadata. Runtime clocks, thresholds and model-domain fit remain measured N2/N3 gates rather than being guessed to make a checklist look complete.

| Graph requirements | N1 coverage / future case |
|---|---|
| R01–R03, R20 — product, pair and source scope | Catalogue and source boundaries; N1-01, N1-09 |
| R04–R05, R09–R10 — odds, geometry, immutable sampled contracts | Shared precision/cell/quote contracts; N1-04–07, N1-09 |
| R06–R08 — zoom, stakes, default funds | Catalogue; N1-02–03 and N3 fund initialization/refill cases |
| R11–R14 — ledger/allowance lifecycle | Shared commit/event order; N1-08 with N3/N5 integration cases |
| R15, R19 — offer/configured CTA and reproducible package | N1-10–11; N5 copy and N6 packaging evidence |

**Status:** all three planning review passes completed with corrections recorded. No runtime case is passed by this review; every N1-01–11 runtime case remains **NOT RUN**. R16–R18 accessibility/performance/replay are N4/N6 responsibilities with N1 supplying only the shared contracts. The node is ready for graph-level review and implementation; the application is not yet built, tested or deployed.

Final document-only check passed: all three QA headings and eleven future case IDs exist; recorded zoom values match the saved controls snapshot; all seven wiki links resolve; superseded graph-link/rational-multiplier text is absent; explicit floor/half-up and stable exposure-key rules are present. This check did not execute application code or a provider SDK.

## Evidence

- [Recovered Euphoria controls](Attachments/Tap%20Trading%20Research/euphoria-controls-facts-2026-09-20.json), checked2026-09-20; source SHA-256 `1da8a5e94f79453c4a7820a916006360b116c4f73dd4bb0af0f68bfd68c9124a`; static public-client evidence, not authenticated runtime.
- [Saved Lynx provider config](Attachments/Tap%20Trading%20Research/lynx-provider-config-2026-09-20.json); dated snapshot, not a live call in this task.
- [V1 - Playable Demo Gap Review](V1%20-%20Playable%20Demo%20Gap%20Review.md); exact model/domain/event calibration and source coverage remain unproved.

No app files, dependencies, public deployment, external messages or provider calls were created by this node-planning task.

## Monorepo/adaptive amendment — QA pass 1

**Actual review:** re-read N1 and the Turborepo skill, then checked official pnpm workspace and Turbo task/package/run documentation against the new explicit monorepo and desktop/tablet/mobile requirement. Reviewed the old root `src/` file map and event-only offer trigger for scope gaps.

**Findings and corrections:** replaced the single-app-root file allocation with `apps/demo`, six private `@maya/*` packages and a conditional read-only relay; established an acyclic dependency map and explicit compiled exports; kept adaptive views within one engine/app lifetime; added the presentation acknowledgement/reconciliation contract to close the missed-event/remount gap. Added future cases N1-12–15 and amended N1-11. The original three review passes above remain historical evidence; this amendment does not retrospectively claim they reviewed the newer requirement.

**Status:** amendment completeness review performed. No implementation, package install or runtime test. Next amendment review challenges task caching, package cycles, module lifetimes and acknowledgement races.

### Amendment sources and action record

Checked 2026-09-20. Read vercel:turborepo skill (historical local reference: `~/.codex/plugins/cache/openai-curated-remote/vercel/0.21.4/skills/turborepo/SKILL.md`), then verified behavior instead of copying example boundaries/flags/version numbers. Search queries: `site.turborepo.com docs caching cache false outputs tasks package exports`; `site.pnpm.io workspaces workspace protocol pnpm-workspace.yaml`. Used official sources only for the plan:

- [pnpm workspace documentation](https://pnpm.io/workspaces): workspace root file, `workspace:*` local resolution and shared lockfile.
- [Official Turbo task documentation source](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/configuring-tasks.mdx): dependency order, task outputs and fresh/persistent task semantics.
- [Official Turbo package-structure source](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/structuring-a-repository.mdx) and [internal-package source](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/core-concepts/internal-packages.mdx): explicit entrypoints and compiled-package option.
- [Official Turbo run reference source](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/run.mdx): verified `--cache=local:rw` and `--force`; no need for a remote-cache account.

The web renderer could not open three `turborepo.dev` pages because they returned `text/markdown`; the same documentation was successfully read from Vercel's official GitHub repository. This is a documentation-fetch limitation, not a Maya/provider outage. No unofficial mirrors or search-result commentary supplied technical decisions. Only this N1 note was edited; canonical package map was sent to the graph coordinator for the other nodes. No application was scaffolded and no live market endpoint was called during the amendment.

## Monorepo/adaptive amendment — QA pass 2

**Actual review:** challenged the amended plan with a config→contracts→compiler-config cycle, an internal package missing from the workspace, a server entry imported into the browser, a cached live probe, an E2E task waiting for an infinite dev server, two adaptive views mounting during the tenth-bet transition and a stale-page presentation acknowledgement. Read the graph's amended R16/R19 and compared ownership/cache statements.

**Findings and corrections:** retained root compiler tooling to avoid a runtime-package cycle and local-only `workspace:*` resolution; made the cross-workspace boundary check a fresh direct root task rather than trusting incomplete per-package cache inputs; separated finite E2E-owned preview startup from persistent dev tasks; required fresh report/run identity even when executable builds come from cache. Added one app-level presentation controller/in-flight guard so duplicated view subscribers cannot show two offers before the first acknowledgement. A failed display remains retryable without granting another bet.

**Status:** adversarial amendment review performed with corrections. Numeric trading settings and shared cell IDs are unchanged. Cold builds, import resolution, actual cache behavior and adaptive modal races remain future runtime checks, not tests passed in this turn. Pass3 rechecks the corrected map/contracts against graph scope and document integrity.

## Monorepo/adaptive amendment — QA pass 3

**Actual review:** re-read the corrected package/task/acknowledgement sections against [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md) and the amended graph. Traced N1-11–15 to R19 monorepo reproducibility, R16 adaptive usability and R12–R14 tenth-bet lifecycle. Rechecked the old financial/decimal/cell-ID invariants after the architecture changes.

**Findings and corrections:** reconciled the two package-graph arrow conventions explicitly; mapped N4's compact/medium/wide labels to the canonical mobile/tablet/desktop `LayoutMode`; recorded N4's ordered breakpoint defaults in the shared config contract, including short-height and coarse-pointer cases. Confirmed conditional relay isolation, one shared service lifetime, uncached fresh evidence and the successful-display-only acknowledgement. Preserved the earlier three-pass history rather than relabeling it as amendment work.

**Status:** all three amendment planning passes completed. N1 now hands off one monorepo/package map and shared adaptive/modal contracts. All **15 future runtime cases remain NOT RUN**. Cold install/build/cache validation, actual viewport interaction, live model feasibility and durable ledger/modal race tests remain implementation gates; no package version was guessed, app installed or game executed.

Final amendment document check passed: original three QA records retained; three amendment QA records present; 15 future case IDs; eight package nodes including the conditional relay form an acyclic graph with no missing dependency node; all nine wiki links resolve; saved zoom values and the stable exposure-key rule remain present; local-only cache/fresh evidence and presentation acknowledgement contracts are explicit. This is a static plan integrity check, not a built-workspace or browser test.
