---
type: runtime-implementation
product: Maya
node: N1
date: 2026-09-20
status: foundation-complete-integration-pending
---

# Maya Runtime — N1 Foundation

The foundation is implemented under `<repo>`. Three focused implementation QA rounds passed after the corrections recorded below. The final isolated build executed six uncached tasks and **41 tests passed**. This result covers contracts/configuration/tooling only; it does not assert that the playable app, data providers or Docker deployment have passed.

Planning references: [Maya Development - N1 Foundation](Maya%20Development%20-%20N1%20Foundation.md), [Maya - Development Graph](Maya%20-%20Development%20Graph.md), [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md). These planning notes were left unchanged while final graph review used its frozen input snapshot.

## Implementation delivered

| Area | Files and responsibility |
|---|---|
| Workspace | `package.json`, `pnpm-workspace.yaml`, frozen `pnpm-lock.yaml`, `turbo.json`, `.node-version`, `.gitignore`, `tooling/tsconfig/base.json` |
| Shared public contracts | `packages/contracts/src/contracts.ts`, `units.ts`, `identities.ts`, `index.ts`; compiled ESM and declaration exports |
| Shared settings | `packages/config/src/demo.ts`, `adaptive.ts`, `provenance.ts`, `validate.ts`, `index.ts` |
| Dependency enforcement | `tooling/check-boundaries.mjs`; checks workspace graph, cycles, declared imports, public exports, cross-package relative imports and browser/server boundaries |
| Scaffold handoff | Six package manifests/TypeScript configs, `apps/demo` manifest and justified dependency-free `apps/feed-relay` manifest. Feature/app sources are owned by N2/N3/root. Root later extended the game-ui build to copy its CSS. |

Workspace package names: `@maya/contracts`, `@maya/config`, `@maya/market-data`, `@maya/pricing`, `@maya/engine`, `@maya/game-ui`, `@maya/demo`, `@maya/feed-relay`. Contracts is the leaf; config depends on contracts; feature packages depend on contracts/config and expose deliberate compiled entrypoints. Demo composes the feature packages. Internal dependencies use `workspace:*`; no private source wildcard exports or path aliases bypass the packages.

## Concrete shared contracts

- `MarketId` is `btc-usd | eth-usd`; `DecimalValue` is `{coefficient:string, exponent:number}`. Cents and `grossX100` use integer strings; timestamps use safe integer milliseconds.
- `CellTerms` contains `cellId`, `marketId`, `startMs`, `endMs`, `lowerPrice`, `upperPrice`, `ruleVersion`. `QuoteSnapshot` extends it with quote ID/revision, frozen gross multiplier, source/generation/expiry times, provenance and `simulated:true`. `PlacementIntent` references quote/cell IDs and stake cents. `PositionSnapshot` preserves accepted terms with `open | won | lost | refunded` status.
- `PriceSample` has sample/market/pair/feed IDs, source and receipt timestamps, exact price and optional source hash. `InputHealth`, `ClockSnapshot`, `CoverageReport` and runtime-supplied `SettlementPolicy` separate source readiness from UI. `CandidateDemand` describes model candidates; `ViewportQuoteDemand` separately names fully visible cells.
- Injectable ports are `ClockPort`, `QuoteRegistryPort`, `MarketDataPort` and `PaperEnginePort`. The optional `MarketDataPort.getConflictingSampleIds(marketId)` and `CoverageReport.conflictSampleIds` let N2 communicate source quarantine to N3 without silently selecting the last value.
- `PageAllowanceSnapshot` is separate from `PaperSnapshot`. `acknowledgeOfferShown({pageLoadId,presentationId})` records a displayed offer and does not grant bets or reset the count. N3 owns page/ledger state; UI reconciles count 10 and missing presentation acknowledgement.

Exact helpers include parsing/normalization/comparison, bucket flooring, canonical cell identity, half-open source-time touch checks, gross-return calculation and display formatting. `grossReturn` rounds half-up only at the final cent; model gross multipliers are floored to integer hundredths first. Equivalent decimal bounds produce the same cell ID. Rule/model/config revisions are provenance and never part of the exposure-cap identity. `createCellTerms` aliases `createCell`. `decimalToNumber` is explicitly for rendering/model projection, not settlement.

## Settings encoded and provenance preserved

| Setting | Implemented value |
|---|---|
| Markets | BTC/USD pair 1; ETH/USD pair 2; selected Lynx BSC route/feed identities from research |
| Price bands/time windows | BTC $10; ETH $0.50; epoch-aligned 5 seconds |
| Stakes | $0.10, $0.50, $1, $5, $10; default $1; $10 per bet and $50 total accepted stake per canonical cell |
| Zoom | Continuous 0.345–0.9; fresh 0.6; button factors 1.1/0.9 |
| Demo account/offer | $1,000 starting balance and refill as Maya defaults; 10 newly accepted bets per document; dummy CTA `https://example.com` |

Profile predicates are ordered: width <768 or usable height <500 selects mobile; otherwise width <1200 or coarse pointer with width <1440 selects tablet; otherwise desktop. Profiles retain desktop/tablet/mobile anchor fractions 0.29/0.24/0.18, right gutters 48/44/40, DPR caps 2/1.5/1.5 and p95 rendering targets 16.7/20/33.3 ms. These are layout/performance requirements, not claims that the browser has achieved them.

`CONFIG_PROVENANCE` distinguishes user decisions, recovered Euphoria control snapshots, Maya implementation defaults and observed Lynx input identity. Shared configuration deliberately does not invent proven feed freshness, stabilization or settlement coverage thresholds; N2 supplies measured policy. Actual eligibility, viewport usability and correctness remain integration gates.

## Dependencies, official sources and licenses

Exact installed pins: pnpm 11.25.0, Turbo 2.11.2, TypeScript 7.0.2, Vitest 5.0.1, Vite 8.3.0, Three 0.186.0, `@types/three` 0.186.0, `@types/node` 24.13.6, fake-indexeddb 6.2.5 and `@babel/parser` 7.29.9. Versions/engine compatibility were checked against the [official npm registry](https://registry.npmjs.org/); they were not copied from illustrative skill examples. Shell Node is 24.21.0; standalone pnpm reported embedded Node 24.19.0. The engine range accepts Node 24, while `.node-version` records 24.21.0.

Installed license texts were inspected and hashed. TypeScript and fake-indexeddb are Apache-2.0; the other listed direct dependencies are MIT. Detailed license files, hashes and opening text are retained in `artifacts/verification/n1/included-license-audit.json`. This is an audit of listed direct dependencies, not a claim that every transitive redistribution requirement has been reviewed.

Applied skill: Turborepo SKILL.md (historical local reference: `~/.codex/plugins/cache/openai-curated-remote/vercel/0.21.4/skills/turborepo/SKILL.md`). Supporting documentation: [pnpm workspaces](https://pnpm.io/workspaces), [Turborepo task configuration](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/crafting-your-repository/configuring-tasks.mdx), [internal packages](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/core-concepts/internal-packages.mdx), and [run options](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/run.mdx). Actual command execution corrected one version-specific planning assumption described below.

## QA round 1 — contract/configuration implementation

Implemented exact units, identity, shared DTOs/ports and settings; installed pinned packages. `pnpm test:n1` passed **41 tests**. The first fresh build command failed because this Turbo release rejects `--force` combined with `--cache`. Replaced that invocation with `--cache=local:`. The corrected foundation build/typecheck passed **4 tasks, 0 cached**. Adjusted Node engine compatibility for pnpm's embedded runtime without changing the recorded target Node version. Status: **PASS after fixes**.

## QA round 2 — adversarial inputs and package boundaries

Reviewed raw decimal accuracy beyond binary-float precision, equivalent-bound cell identity, negative bucket flooring, source-time and price boundaries, malicious/unbounded numeric input, large integer payouts and half-up rounding. Tightened configuration validation so an unresearched positive stake/band/zoom value cannot silently replace the locked setup. Added deeply immutable cell price bounds and conflict-quarantine port support. Re-ran **41 tests: PASS**.

The first boundary checker attempted the TypeScript compiler API, which was absent from the installed TypeScript 7 shape; replaced it with pinned Babel parsing. The real workspace passed (8 workspaces, 20 source files, 15 edges at that checkpoint). A deliberately invalid fixture correctly failed with all four expected diagnostics: forbidden dependency, cycle, cross-package relative import and undeclared dependency. Status: **PASS after fixes**. Subsequent files from peer nodes still need whole-graph checks.

## QA round 3 — fresh build and correction recheck

Created an isolated copy of root tooling/contracts/config with the unchanged lockfile and no previous build output or task cache. `pnpm install --offline --frozen-lockfile` passed. `pnpm exec turbo run build typecheck test:unit --cache=local:` passed **6 tasks, 0 cached; 41 tests**. Refreshed the working foundation outputs afterward with another uncached build/typecheck: **4 tasks passed**. Status: **PASS for N1**.

Evidence: [N1 verification record](../../artifacts/verification/n1/README.md), `clean-install.log`, `clean-build-and-tests.log`, `boundary-negative-result.json`, `included-license-audit.json`, `registry-versions.json`, `qa-rounds.json` and `source-hashes.json` in `<repo>/artifacts/verification/n1`.

Normal deterministic tasks use local-only Turbo cache; probes/E2E/evidence have `cache:false`. Fresh required QA uses `--cache=local:`. Do not combine `--cache` and `--force` on the pinned release. No Turbo account, remote cache or service account was configured.

## Residual gates and action log

N2 integrates current Lynx data/model policy and the authorized relay. N3 implements atomic durable acceptance/settlement with per-document allowance. Root/N4/N5 integrate the adaptive Three.js experience and offer. N6/root own browser, Docker and whole-graph runtime verification. N1 did not call a market provider, execute a trade, commit Git, deploy the app or claim those gates passed.

Automatic approval review rejected recursive cleanup of the isolated verification copy, with the stated reason `blocked by policy`. No alternative deletion mechanism was attempted. `artifacts/verification/n1/clean-workspace` remains, is ignored by Git, and must be excluded from Docker/source packaging; root was notified. The logs remain the intended review artifacts.
