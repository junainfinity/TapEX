---
type: implementation-log
created: 2026-09-20
status: delivered-local-demo
tags: [Maya, implementation, Docker, QA]
---

# Maya implementation and Docker delivery

The user added **“once done, host it in docker desktop”** during the final planning reviews. This extends the task from a reviewed development plan to building the playable demo and running it locally in Docker Desktop. The coordinator stated that interpretation and explained that the earlier plan-only ETA does not cover implementation.

Authority remains [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Maya - Development Graph](Maya%20-%20Development%20Graph.md) and [Maya - Monorepo and Adaptive Layouts](Maya%20-%20Monorepo%20and%20Adaptive%20Layouts.md). Historical planning QA remains separately recorded in [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md); it is not runtime evidence. Use the Obsidian vault for missing context, as the user explicitly requested.

## Local delivery target

Build the pnpm/Turborepo monorepo at `<repo>`. Run its built demo through Docker Compose on a free localhost port, bound to `127.0.0.1`. Provide the working localhost URL, start/stop instructions and full local source. No public hosting account or domain is required. Add a same-provider read-only relay only if actual browser access needs it; never use a relay to introduce an unapproved vendor or synthetic prices.

Use a reproducible multi-stage image, a Docker health check and a read-only static serving container where feasible. Verify the actual container-served build in the browser, including both markets, desktop/tablet/mobile, ten accepted bets, consultation, refresh and persisted old bets. Inspect existing containers/ports and avoid stopping or replacing unrelated services. Document fresh-image/build IDs and actual results.

## Environment preflight

Read-only checks on 2026-09-20 found Docker Desktop running with the `desktop-linux` context, Engine 29.8.0, Docker Compose v5.5.1, Node v24.21.0 and pnpm 11.25.0. `<repo>` did not yet exist at this check. No containers were created or altered by the preflight.

The coordinator gave a provisional 60–90 minute build/verification estimate, explicitly subject to live feed/model compatibility. This is an estimate, not a delivery or correctness guarantee. All feed/model, runtime and device results must be recorded as actually observed.

## Execution status

Final plan reviews in progress. Implementation, runtime node QA, integrated runtime QA and Docker hosting have not started at this point. Later entries below will record concrete actions and outcomes without rewriting earlier evidence.

## Temporary keep-awake request

User explicitly requested that the laptop not sleep until the project is fully done. Started a hidden PowerShell helper at `<repo>/.codex-task/keep-awake.ps1`, PID 10904, at 2026-09-20T13:32:00Z. Windows `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)` returned a nonzero success value. The helper records its state in `keep-awake-status.json` and holds the request until `keep-awake.stop` is created beside it. It then releases the request and exits. No permanent power-plan setting was changed. This prevents automatic idle sleep/display timeout; it cannot prevent a manual shutdown or power loss.

The optional `powercfg /requests` inspection required administrator rights and did not run; no elevation was requested because the task-scoped Windows API request had already succeeded. On project completion, create the stop marker and verify the helper's `active:false` status. Do not leave the helper running after completed delivery.

## Planning closeout and implementation start

All six node plans completed three original reviews (18), with 12 additional monorepo/adaptive amendment passes across N1/N4/N5/N6. All three sequential graph reviews completed; two first-pass planning defects were corrected and independently rechecked. The graph, Canvas, frozen inputs and full reports are retained in the vault. The plan defines 111 future checks; this number is not a passing-test count.

N1 started workspace/contracts/config implementation, N2 began a ten-minute public feed capture at 13:35:09 UTC plus market-data/pricing implementation, N3 started the persistent engine, and the coordinator began the Three.js/HTML UI. Source files live in the monorepo, with focused implementation reports in `artifacts/verification/` and corresponding new `Maya Runtime` vault notes.

Applied the `vercel:agent-browser` and `vercel:agent-browser-verify` skills for actual browser verification. A temporary source probe at `http://127.0.0.1:5177` used agent-browser0.38.1 with system Chrome153. Config/BTC/ETH fetched successfully as JSON, but browser-visible Date headers were null; direct probability-table fetch failed. Saved exact results to `trading-game/artifacts/verification/n2/browser-direct-source-proof.json`. This establishes a need for the conditional same-provider relay. N2 will implement fixed allowlisted endpoints for the same public config/prices/table; no alternate price source or synthetic fallback is introduced. The temporary probe server must be stopped after integration.


## Local delivery completed

Maya is running through Docker Desktop at **http://127.0.0.1:8080**. Both services are healthy, loopback-only; the fixed relay has no arbitrary proxy/order/account route. Final UI assets are `index-CnnISgxg.js` and `index-BsFr3F5v.css`. Full source and start/stop instructions are at `<repo>/README.md`; [Maya - Start Here](Maya%20-%20Start%20Here.md) is the vault entry point.

All six implementation nodes completed three actual correction/recheck loops, followed by three integrated graph rounds. Final workspace:95 unit tests, TypeScript, boundaries and build passed. Hosted journey evidence covers four ten-bet sessions, live wins/losses, the modal, reload, retained open bets, two-tab balance and source-outage recovery. Final coordinator ledger:41 settled positions,267 exact audit checks. Physical-device/pixel-perfect/proprietary-odds claims remain explicitly unmade; see [Maya Runtime - N6 Integration and Docker](Maya%20Runtime%20-%20N6%20Integration%20and%20Docker.md).

Temporary probe5177, Vite5173 and development relay8787 were stopped after verifying their owned process command lines. Only Maya's Docker services remain as the hosting deployment. The temporary keep-awake helper is released at closeout and its final status is saved in the runtime archive. No permanent Windows power settings were changed.
