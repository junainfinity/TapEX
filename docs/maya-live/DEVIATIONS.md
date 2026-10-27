
## packages/house (@maya/house) — 2026-09-26

- **house / tau 3 fails closed.** The SPEC grid rule `start0 = ceil((t + 3) / 5) × 5` yields tau = 3 one second in five, but both published `maya-calibrated-v3` tables hold zero observations at tau 3 (the recorder's window rule never produced it; `counts.n0[0..3] = 0`). `smooth()` would price those cells at the 0.5 fallback prior (b = 0 offered at ~1.84× against an empirical near-band p ≈ 0.8 at tau 4). `lookup()` therefore returns `undefined` (grid reason `out-of-domain`) for any cell whose tau×band level has no observation. Golden rows are unaffected (none has tau 3). Tables produced by `refitTable` use the live start rule and do observe tau 3, so the first window reopens after the first refit.
- **house / x100 epsilon.** `offerX100` floors `100·(1 − edge)/q + 1e-9`, exactly as `fit.mjs multiplierX100`; SPEC §3.2 omits the epsilon, but every golden `x100` was produced with it (e.g. q = 97/117 at edge 0.03 → 117, not 116).
- **house / q ≤ 0 is never offered.** Following `fit.mjs`, a zero probability is not offered even with `aboveCap: 'cap'` (reason `out-of-domain`).
- **house / EWMA fallback window.** "16 s EWMA" is read as λ = 0.94 (≈16 s effective horizon) over the trailing 68 one-second samples, which is what `PaperQuoteBook`/the recorder computed for the `sigma` column that `fit.mjs` falls back to. `ewmaSigma` is a bit-identical reimplementation of `packages/pricing` (cross-checked in tests; @maya/house cannot depend on @maya/pricing).
- **house / defaults not in SPEC.** `impactK` = 0.02 (a cell at its full liability limit adds 2 points to q); `equityFloorCenti` = '0'; the edge-schedule validation range 0.01–0.25 (from §7) also applies to the launch edge; `flowEdge` ≤ 0.25.
- **house / breakers.** Drawdown is measured from the equity peak inside the trailing 1 h (strictly `>` 2 % widens, `>` 5 % pauses; widened escalates to paused automatically). House funding / surplus withdrawal must be reported with `recordTreasuryFlow(delta)` so treasury moves are not read as P&L. `feedStale` and `equityFloor` start tripped until the first price / equity observation (fail closed) and recover automatically; drawdown and manual only via admin (`resumeAll` clears both the global manual pause and drawdown). The widening amount lives in the edge schedule (`drawdownWiden`, 0.02), the breaker only reports the widened state.
- **house / grid headroom.** Grid cells advertise `maxStakeCenti` = the largest stake whose liability fits cell, column and global headroom and the optional stake caps (per-account limits are checked at acceptance). Because payouts floor, a stake whose liability rounds to 0 can still fit at zero headroom for multipliers below 2.00×; the server's minimum stake should be applied on top.
- **house / refit instants.** `refitTable` treats every recorded second as a quote instant with the exact decimal band index (the recorder's `bucketIndex`) and the unrounded EWMA fallback (the recorder rounded `sigma` to 9 significant digits). With the same path, its output equals the `fit.mjs` CLI's JSON field-for-field except `source` (verified in `packages/house/test/refit.test.ts`).

## contracts/ (Foundry: MockOpenToken, MayaHouseVault) — 2026-09-26

- **contracts / artifact paths.** Forge's standard layout: `contracts/out/MayaHouseVault.sol/MayaHouseVault.json` and `contracts/out/MockOpenToken.sol/MockOpenToken.json` (`abi`, `bytecode.object`, `deployedBytecode.object`). No flat `out/<Name>.json`.
- **contracts / constructors (not specified by SPEC).** `MockOpenToken()` (no args; whole supply to the deployer). `MayaHouseVault(address token, address ledgerSigner)`: owner = the deployer (`msg.sender`, the $OPEN operator); `ledgerSigner` must be non-zero and differ from the deployer. Defaults: `maxVoucherAmount` 100,000 tOPEN, `dailyOutflowCap` 1,000,000 tOPEN, `maxAttestationAge` 1 h (tune with `setLimits`).
- **contracts / deposits cut at `asOf`, claims at the attest tx.** SPEC says `attest` "resets" `depositsSinceAttest`/`claimedSinceAttest`. Resetting deposits at the attest *transaction* would drop deposits mined after the ledger snapshot but before the attest landed (indexer lag), overstating `houseSurplus` by exactly those player funds. The vault keeps a timestamped deposit history and sets `depositsSinceAttest` = deposits mined at or after `asOf`; `claimedSinceAttest` resets when the attest is mined. Both can only understate the surplus. House-server contract: `liabilities` must include every deposit mined strictly before `asOf`, and `asOf` must be chain time (<= `block.timestamp`, e.g. the indexer watermark block's timestamp), never the replay feed clock. Attestation age is `block.timestamp - asOf`.
- **contracts / pause scope.** `deposit`, `withdraw` and `withdrawHouse` are `whenNotPaused` (SPEC names only `withdraw`); `fundHouse` and `attest` still work while paused so the operator can top up and the signer can re-attest during an incident.
- **contracts / signer rotation.** `setLedgerSigner` invalidates every outstanding voucher (signature no longer recovers to the signer) and the current attestation: `withdrawHouse` requires an attestation from the current signer (`AttestationBySupersededSigner`). The ledger must re-credit vouchers orphaned by a rotation once they expire. The signer can never be the owner or the pending owner; `renounceOwnership` always reverts.
- **contracts / daily outflow cap** counts player voucher withdrawals only, keyed by UTC day `block.timestamp / 86400`; `withdrawHouse` is bounded by surplus + attestation instead, so the owner cannot exhaust the players' daily budget.
- **contracts / voucher details.** Valid while `block.timestamp <= expiry`; nonces are unordered per account (any uint256, each usable once); `amount` must be > 0 and <= `maxVoucherAmount`; the vault must hold `amount` in internal `assets()`. `setLimits` requires `0 < maxVoucherAmount <= dailyOutflowCap` and `0 < maxAttestationAge <= 7 days`.
- **contracts / test harness.** `lib/` carries only OpenZeppelin (no forge-std), so tests use a minimal cheatcode interface (`test/utils/Vm.sol`, `TestBase.sol`) and the script declares the few cheatcodes it needs.
- **contracts / Deploy.s.sol env.** `PRIVATE_KEY` (operator key), `SIGNER` (ledger-signer *address*), optional `HOUSE_FUND_WEI` (default 100,000,000 tOPEN; 0 skips funding) and `DEPLOYMENT_FILE`. Refuses any chain but 31337; a dry run (no `--broadcast`) writes nothing. `blockNumber` in the JSON is the chain head the script simulated against: a safe lower bound for the deposit indexer, not the exact deployment block.

## apps/admin (@maya/admin, house console) — 2026-09-26

Where SPEC §7 is silent, the console codes to the choices below (all in `apps/admin/src/api.ts`, `decode.ts`, `controls.ts`, `types.ts`); the house server should match them or record its own deviation.

- **admin / SSE auth.** `EventSource` cannot send headers and the token must never go in a URL, so `GET /admin-api/stream` is read with `fetch` + `Authorization: Bearer <token>` + `Accept: text/event-stream`. The console resends `Last-Event-ID` on reconnect, honours `retry:`, treats 401/403 as terminal (no retry loop), reconnects on anything else with capped exponential backoff (1 s → 30 s, ±20 % jitter), and treats 15 s without bytes as a stall. Event names: `overview`, `bet`, `settlement`, `breaker`, `admin-action`, `alert`, plus **`refit`** `{ jobId, progress 0..1, state: queued|running|done|failed, market?, tableId?, message? }` for refit progress (SPEC says "progress via SSE" without naming the event). Unknown event names are ignored.
- **admin / confirm phrases.** Dangerous actions send `confirm` exactly as: `pause-all` (POST /pause-all), `vault-pause` (POST /vault/pause), `withdraw-surplus` (POST /treasury/withdraw-surplus), `edge-change` (PUT /pricing when `standardEdge` moves > 2 pts, and PUT /launch when `edge` moves > 2 pts **or** the edge charged on new quotes moves > 2 pts, e.g. ending the boost early 3 % → 8 %). When the current value is not reported, the console sends `confirm: "edge-change"` for any edge change (fail closed). Server should respond `400 { error: { code: "CONFIRM_REQUIRED" } }` otherwise.
- **admin / write body and ack.** Every write body carries `reason` (client requires ≥ 8 chars after trim) and, for dangerous actions, `confirm`; writes send an `Idempotency-Key` header (fresh UUID per submission). Expected 2xx ack: `{ ok: true, action, auditId, before, after, txHash?, jobId? }` (extra fields pass through). A 2xx with an empty/non-JSON body is treated as applied. A write timeout (30 s) or dropped connection is shown as an **unknown outcome** (`WRITE_TIMEOUT_UNKNOWN_OUTCOME` / `WRITE_NETWORK_UNKNOWN_OUTCOME`), resubmission from that dialog is disabled and the operator is sent to the audit log (SPEC §1.3: a timeout is not a rejection).
- **admin / current config in overview (extension).** SPEC §7 has no read endpoint for pricing, limits or sim settings, but controls need an exact "before". The console reads optional `overview.pricing {standardEdge, capX100, aboveCap, impactK, z}`, `overview.limits {cellFraction, columnFraction, globalFraction, accountFraction, maxStakePerBetCenti, maxStakePerCellCenti}` and `overview.sim {running, speed, arrivalsPerMin}`. Without them the diff shows "not reported" and edge changes always require confirmation. Control inputs start blank ("blank = unchanged") so a stale form never reverts another admin's change.
- **admin / list and query shapes.** List endpoints return `{ rows, nextCursor?, total? }` (a bare array is also accepted). `GET /players?sort=` uses `balance|handle|pnl|bets|rtp|firstSeen` with a leading `-` for descending (e.g. `sort=-pnl`). `GET /audit` rows: `{ id|seq, ms, kind: admin|breaker|system, actor, action, target?, before?, after?, reason?, result? }`. `GET /players/:account` → `{ player: <row>, bets, deposits: [{id, amountCenti, ms, txHash?, status?, dustWei?}], withdrawals: [...], flags: [{ms, actor, action, reason}] }`.
- **admin / leg and exposure shapes.** A leg is `{ legId, account, kind?, market, start, end?, bandIndex, lower?, upper?, stakeCenti, x100, payoutCenti, status: open|won|lost|refunded, placedMs, settledMs?, phase? }`; `x100` may be a number or integer string. Exposure `bands[]` are `{ index, lower?, upper? }` (bare numbers accepted) and `cells[].bandIndex` refers to `bands[].index` — **the same band identity legs carry**, so a cell drill-down filters `GET /bets?market=&status=open` by `start` and `bandIndex`. Optional `columnLimitCenti` enables column-total gauges. `limitUsage.*` are fractions of the respective limit (1 = at limit).
- **admin / RTP shape.** `byRange`, `byMarket`, `byPhase` rows: `{ key, phase?, bets, handleCenti?, returnedCenti?, expected, realized|null, expectedLow?, expectedHigh? }`; `byRange` rows carry `phase` for the launch/standard split. Without `expectedLow/High` the console draws the target band as expected ± 2 SE using SE = √((e·m − e²)/n) at the range's geometric-mean multiplier (equal-stake approximation). Optional `calibration: [{ predicted, observed, n }]`, `tables: [{ market, tableId, builtMs?, previousTableId? }]`, `lastRefitMs`.
- **admin / chain shape.** `GET /chain` → `{ network, chainId, vault: { address, token, paused, assetsCenti, houseFundedCenti, totalPlayerDepositsCenti, totalPlayerWithdrawalsCenti, houseWithdrawnCenti?, surplusCenti, maxVoucherAmountCenti?, dailyOutflowCapCenti?, maxAttestationAgeSec?, ledgerSigner? }, lastAttestation: { seq, asOfMs, liabilitiesCenti, ledgerRoot, txHash?, blockNumber? } | null, operator: { address, ethWei, tokenCenti }, pendingVouchers: { count, totalCenti, items? }, indexer: { lagBlocks, lastBlock?, headBlock?, confirmations? } }`. On-chain tOPEN amounts are Centi like everything else; ETH gas balance is a wei string. The console checks `assets = deposits + houseFunded − playerWithdrawals − houseWithdrawn` exactly and flags a mismatch.
- **admin / time axis.** All console times are rendered in UTC; the metrics window is anchored to `overview.clockMs` (the replay clock), never the browser clock.
- **admin / dataviz exception.** The dataviz guidance prefers proportional figures on stat tiles; the console uses tabular figures on live-updating tile values because the brief requires no layout shift on live updates.

## apps/house-server chain adapter (`src/chain/`, viem) — 2026-09-26

- **chain / attest clamps `asOf` down to indexed chain time.** The vault owes `liabilities` + deposits mined at or after `asOf`, so the ledger figure must cover every deposit mined strictly before `asOf`. The ledger has only seen deposits up to the indexer watermark block, so `LiveChain.attest` attests `min(request.asOf, watermark.timestamp)`. Moving `asOf` earlier only adds deposits to the owed side, which is conservative. It also keeps `asOf <= block.timestamp`, so a wall-clock, replay-clock or millisecond value never reverts with `AttestationFromFuture`. The watermark is read synchronously on entry, so the caller must snapshot its ledger in the same tick. `attest` refuses with `INDEXER_NOT_READY` before the first scan and with `INDEXER_UNDELIVERED` while indexed deposits wait for a listener. The result is `{ txHash, blockNumber, asOf, seq }`: journal the returned (effective) `asOf`, not the requested one. Extras on `LiveChain` (outside ChainPort): `watermark()`, `chainTime()`, `indexerStatus()`, `deploymentRecord()`.
- **chain / deposit identity across reorgs.** Deposits carry `txHash:logIndex` as SPEC says. Internally the indexer also dedupes by a reorg-stable key, `txHash#<ordinal of the Deposited log within the tx>`, so a transaction re-mined in a later block with a shifted `logIndex` is not delivered twice. Every poll re-reads the last `reorgDepth` blocks (5 local, 32 Base Sepolia). If the watermark block's hash changed, it re-reads the retained window (at least 1,024 blocks). A delivered deposit that later leaves the canonical chain cannot be retracted. It is logged as `ALERT` and listed in `indexerStatus().orphaned`; the confirmations (2 on Base Sepolia) are the guard. Delivery happens before the cursor is persisted, so a crash in that gap re-delivers the deposit rather than losing it. This matches chain-port's "at least once"; the ledger credits idempotently.
- **chain / listener buffering and cursor.** Deposits found while no `onDeposit` listener is registered are queued, persisted with the cursor, and delivered on the first subscription. The cursor is `chain-cursor-<chainId>.json` in `dataDir` (option, else `MAYA_DATA_DIR`); without one it stays in memory and every start rescans from the deployment block. The cursor is discarded when chainId, vault, start block or deployment block hash differ (a reset anvil). `indexerLagBlocks()` = last seen head − last fully scanned block, so a healthy Base Sepolia indexer reports about 2 (its confirmations).
- **chain / deploy CLI semantics.** `--fund-house`, `--player-eth` and `--player-tokens` are targets, not increments: the deployer tops up to them, which is what makes re-runs idempotent. `--fund-house` is compared with cumulative `houseFunded`. Extra flags: `--signer-eth` (ETH for the ledger signer's attest gas; defaults to `--player-eth`), `--max-voucher`, `--daily-cap`, `--max-attestation-age` (validated like `setLimits`; default = contract defaults), `--redeploy`, `--rpc-url`. Defaults: house 100,000,000 tOPEN; players 100,000 tOPEN; ETH 1 (local) or 0.0005 (Base Sepolia) per player and for the signer. Base Sepolia preflight: the operator needs ≥ 0.01 ETH, and also ≥ the ETH top-ups + 0.002 ETH reserve. On local, a deployment file pointing at addresses without code (reset anvil) is redeployed automatically. On Base Sepolia that is an error that asks for `--redeploy`.
- **chain / deployment file.** Written as soon as the vault exists and again after each later step: `{ chainId, token, vault, operator, ledgerSigner, blockNumber, blockHash, network, txs }`. `blockNumber`/`blockHash` are the vault deployment block, the indexer's exact start. `txs` keys: `deployToken`, `deployVault`, `setLedgerSigner`, `setLimits`, `approveHouse`, `fundHouse`, `signerEth`, `playerEth{role→hash}`, `playerTokens{role→hash}`. The latest hash is kept per key. Files written by `Deploy.s.sol` (no `txs`/`blockHash`) are accepted.
- **chain / local funding.** On anvil, wallets whose ETH balance is exactly 0 get test ETH from anvil's public dev account 0: 100 ETH for the operator, 10 ETH for every other role. This happens on `start()` and in the deployer. A clear `INSUFFICIENT_GAS_FUNDS` error is raised if dev account 0 cannot cover it (long-lived anvil); restart anvil.
- **chain / artifacts.** The typed ABIs in `src/chain/abi.ts` are generated from `contracts/out` by `test/chain/tools/gen-abi.mjs`. `test/chain/files.test.ts` and the deployer both refuse ABI drift. The existing (gitignored) `contracts/out/MayaHouseVault.sol/MayaHouseVault.json` had lost its bytecode (ABI-only; probably left behind by `forge coverage`/`forge lint`). `forge build` skipped it as cached, so it was rebuilt with `forge build --force`. The loader now rejects ABI-only artifacts and prints the rebuild command.
- **chain / errors.** Failures throw `ChainError` with a stable `code` (`CONTRACT_REVERT`, `TX_TIMEOUT` (outcome unknown), `NOT_STARTED`, `DEPLOYMENT_MISSING`, …). A decoded vault or token custom error is in `error.revert = { name, args }`. This differs from `OfflineChainError`, whose `code` is the custom error name. Chain-reading and tx methods require `start()`. `signWithdrawal`, `addresses()`, `players()` and `explorerUrl()` need only the deployment file.

## apps/house-server core (engine, ledger, feed, APIs, sim) — 2026-09-26

- **house-server / offline network.** `MAYA_NETWORK` also accepts `offline` (the default): `src/offline-chain.ts` is an in-memory MockOpenToken + MayaHouseVault with the vault's accounting and revert rules (HMAC vouchers under an offline signer secret). It is not persisted, so a restart that rebuilds a journal cannot reconcile against a fresh offline vault (logged as a warning). `local` / `base-sepolia` load `src/chain/index.js` lazily.
- **house-server / one port, localhost.** `/v1` (player) and `/admin-api` share one hardened server on `MAYA_ADMIN_PORT` (8790), bound to `MAYA_HOST` (default 127.0.0.1). Stage A has no SIWE, so the player API names the account in the body and must stay on localhost. Extra player routes: `POST /v1/sign-in`, `POST /v1/withdrawals` (idempotent voucher request, returns the EIP-712 domain and signature), `GET /v1/health`. Rejections are HTTP 422 (409 for `REQUEST_CONFLICT`) with `{ status: 'rejected', reason, message, error: { code, message } }`.
- **house-server / ledger accounts.** Besides `player:<address>`, `house:equity` and `house:escrow`: `sim:<id>` (sim players), `house:escrow-sim`, `house:sim-pnl` (the house result against sim players, never mixed with `house:equity`), `house:vouchers` (unclaimed vouchers), and contra accounts `external:vault` and `external:sim-credit`. Live equity E for limits and breakers = `house:equity + house:sim-pnl`, so the crowd drives the risk engine as real players would; on-chain legs are additionally bounded by the real bankroll (`house:equity` must cover all open on-chain liability). Reconciliation: vault `assets` = −`external:vault` × 10^16 + retained dust, exactly.
- **house-server / per-square stake cap is per account.** `maxStakePerCellCenti` follows the console's meaning (largest total stake one player may hold on one square), so the engine enforces it per account and hands @maya/house the limits without it (`LiabilityBook`'s variant would cap all players together). Cell/column/global liability limits still bound the square as a whole.
- **house-server / rejections are receipts too.** A rejected intent is remembered by `requestId` (in memory, bounded to 100,000, not journaled): the same intent gets the same rejection, a changed one `REQUEST_CONFLICT`. After a restart quotes are gone, so a re-evaluation can only reject.
- **house-server / TOO_LATE before QUOTE_EXPIRED.** Quote expiry is already bounded by `start − 3 s`, which would make `TOO_LATE` unreachable; the engine checks the square's lead first so a late tap gets the specific reason.
- **house-server / guard and stake defaults.** Price-move guard: reject when `|spot_now − quoted spot| > guardSigma × sigma × quoted spot × √age`, with age = seconds between the quote's source second and the latest observed second (guard only acts once a newer price exists); `guardSigma` 3 (`MAYA_GUARD_SIGMA`). Minimum stake 10 Centi (`MAYA_MIN_STAKE_CENTI`). Default `maxStakePerBetCenti` 1,000,000 and `maxStakePerCellCenti` 5,000,000 (always reported, the console requires them).
- **house-server / journal scope.** Every state change is an event (`boot, sample, table, register, deposit, sim-credit, bet, settle, voucher*, treasury, attest, config, player-flag, breaker, audit, sim`) applied through one `apply`, so a rebuild is exact (tested). Replay warm-up history before `MAYA_REPLAY_FROM` is not journaled; it is reloaded from the same market log on restart (the first boot record stores the replay period). Automatic `feedStale`/`equityFloor` states are recomputed live; a journaled drawdown `widened`/`paused` state is restored as a latch that only `resume-all` clears (fail closed).
- **house-server / startup refit.** In replay the server pins the trailing `trainHours` of recorded history and refits both tables at start (when ≥ 6 h is available), which reopens the tau = 3 window the published tables refuse; default replay start = first logged second + `trainHours`. Scheduled refits run every `refitHours` of feed time on a worker thread (inline in `run-sim`). Replay delivers each row at its source second + recorded `lag_ms` (capped at 3 s, monotone per market).
- **house-server / admin API details.** `reason` must be 8–500 characters; unknown body fields are rejected; `Idempotency-Key` replays the stored response (a different body is `409 IDEMPOTENCY_CONFLICT`); `X-Maya-Actor` (optional) names the admin in audit entries (`admin:<name>`). Confirm phrases are the console's (`pause-all`, `vault-pause`, `withdraw-surplus`, `edge-change`); an edge change counts if `standardEdge`, the launch edge or the edge charged on new quotes moves > 2 points. `refit` answers 202 with a `jobId`; progress is the SSE `refit` event. `settlement` SSE events are sampled like `bet` (≤ 20/s); non-overview events carry ids and a 1,000-event `Last-Event-ID` replay buffer. Extensions: overview `pricing/limits/sim` plus `equityOnchainCenti, simPnlCenti, simBalancesCenti, dustWei, drawdown1h, …`; exposure `columns`, `globalLimitCenti`; `bets?start=&bandIndex=`; chain `reconciliation`, `explorer`, `receipts`; rtp `tables`, `phaseLog`. Metrics `handle`/`ggr` are rolling 24 h sums sampled every 60 s of feed clock; RTP excludes refunds.
- **house-server / treasury.** Withdraw-surplus is bounded by free on-chain equity (`house:equity` − open on-chain liability), attests immediately before `withdrawHouse`, then checks the vault surplus. Attestation liabilities = on-chain player balances + unclaimed vouchers + max payouts of open on-chain legs + retained dust wei; `asOf` is the feed clock for the offline chain and the wall clock for live chains (which clamp it to the indexer watermark). Vouchers stay counted as liabilities until the server itself sees the claim (the ChainPort exposes no `Withdrawn` events or `nonceUsed`).
- **house-server / toxicity monitor.** Not specified beyond §3.2: an account is auto-flagged (actor `toxicity-monitor`, journaled, audit kind `system`) when its excess return exceeds 4 standard errors of the model after ≥ 50 settled bets. `flowEdge` stays 0 by default, so flagging alone does not change prices. Blocked accounts cannot bet but can still withdraw.
- **house-server / simulation model.** Strategy mix casual 47 %, chaser 15 %, grinder 15 %, streaker 13 %, whale 5 %, sniper 5 %; players arrive over the first 60 % of the run (the 10,000th of 12,000 at mid-run) and play sessions. The sniper sees the next second's first-seen price and re-prices near windows with the live table, betting only on a positive edge. In `run-sim` a simulated operator resumes a drawdown pause after 30 feed-minutes and blocks toxicity-flagged accounts after 15 (both configurable, both reported). Sim players count as registered players on arrival.
- **house-server / sim restarts.** Sim accounts, balances and legs are journaled like any other; the crowd's session state is not. After a restart the journaled sim players stay registered but idle, and new arrivals continue until the configured `MAYA_SIM_PLAYERS` total is reached.

## vault-engineer: SPEC-11 vault hardening (contracts/, src/chain/, chain-port, offline-chain) — 2026-09-26

Full addendum: `docs/maya-live/SPEC-11-vault-hardening.md`. These supersede the Stage A contract/chain notes above where they conflict.

- **vault-engineer / constructor and defaults.** `MayaHouseVault(token, ledgerSigner, escapeDelay)`: `escapeDelay` is immutable, 3–90 days (deploy default 7 days). `maxAttestationAge` default is 10 min (was 1 h) and its upper bound is 1 day (was 7 days): stricter than Stage A, since the server attests every 10 min and `withdrawHouse` runs right after an attest. New defaults: `signerChangeDelay` 48 h, `houseBufferBps` 1,000, `houseDailyCap` 10,000,000 tOPEN/UTC day.
- **vault-engineer / signer rotation.** `setLedgerSigner` is removed; `proposeLedgerSigner` / `acceptLedgerSigner` / `cancelLedgerSigner` are owner-only (the proposed key cannot accept by itself, so the adapter needs no second key). The eta is fixed at proposal time; a new proposal replaces a pending one and restarts the clock. `transferOwnership` also rejects the pending signer. `signerChangeDelay` must stay below `escapeDelay` (a lost key can be replaced before players can force escape) and within 1 h–30 days.
- **vault-engineer / timelocked loosening of house limits (not in the brief).** Raising `houseDailyCap` or lowering `houseBufferBps` waits `signerChangeDelay`; tightening is immediate. Without this an owner-key compromise could lift the cap instantly and the cap would bound nothing. `setLimits` (player caps, max attestation age) stays instant as in Stage A; SPEC-11 §7 spells out what that leaves open.
- **vault-engineer / buffer base.** The buffer is `ceil(requiredAssets × bps / 10,000)` (attested liabilities + unattested deposits − claims since), not raw `attestedLiabilities`, so it grows with deposits the ledger has not attested yet. `houseSurplus()` keeps the SPEC §5 formula (no buffer); the new `houseWithdrawable()` / `VaultState.houseWithdrawableWei` is what `withdrawHouse` accepts. New error `ExceedsHouseWithdrawable` (inside surplus, inside buffer) is distinct from `ExceedsHouseSurplus`.
- **vault-engineer / escape mode scope.** Besides deposits and house withdrawals (the brief), escape mode also stops voucher withdrawals, `fundHouse` and `attest`: the root is frozen and unredeemed vouchers are part of the leaves, so a voucher paid next to an escape claim would double-pay. Escape mode is irreversible, can be triggered and claimed while paused, and claims do not count against the daily outflow cap.
- **vault-engineer / escape entitlement.** `attestedBalance + deposits − payouts` of the account mined strictly after the root's `asOf` (payouts = vouchers + escape claims), floored at 0. Deposits after the root are added (otherwise a player depositing into a silent house would lose it). There is no "claimed" flag: every escape payout is recorded as a post-cut payout, so any second claim is net of the first. Zero-balance claims need no proof; before any attestation (zero root) only those are possible and pay net deposits. The escape clock runs from the attest transaction's block time (`attestedAt`), or from deployment before the first attestation.
- **vault-engineer / escape pool.** `min(assets, attestedLiabilities + depositsSinceAttest)` at trigger time. It deliberately does not subtract claims since the attestation: a player who won after the root and withdrew more than its leaf floors at 0, and subtracting its withdrawal from the pool would short-change everyone else. When the pool runs short a claim pays what is left (partial, first come first served) and later claims revert `EscapePoolExhausted`.
- **vault-engineer / leaf contract for the core server.** Leaves are what the ledger owes each account (balance + unredeemed vouchers + honoured share of open legs, Σ ≤ attested liabilities), reflecting exactly the chain flows mined at timestamp ≤ `asOf`. Exact on strictly increasing block timestamps (Base Sepolia); on anvil automine a flow in a later block sharing the watermark's timestamp can be misattributed (SPEC-11 §6.5). Until the core ledger consumes `onWithdrawn`, leaves may over-count vouchers redeemed before `asOf`; the pool bounds the total.
- **vault-engineer / ChainPort changes.** New `onWithdrawn`, `nonceUsed` (async; `OfflineChain.nonceUsed` used to be a synchronous test hook, so its single use in `test/offline-chain.test.ts` now awaits), `proposeLedgerSigner`, `acceptLedgerSigner`, `cancelLedgerSigner`, `sweepExcess`; `VaultState` gains the SPEC-11 fields (required, filled by both adapters). Extras outside the port are typed as `VaultOperatorExtras`. The house-server treasury note above ("the ChainPort exposes no `Withdrawn` events or `nonceUsed`") no longer holds.
- **vault-engineer / indexer cursor v2.** Deposits and withdrawals share one `eth_getLogs` per range. The cursor version is 2; version-1 cursors (and cursors from a deposit-only source) are discarded with a log line and the chain is rescanned, so deposits are re-delivered once after the upgrade (the ledger credits idempotently). `test/chain/indexer.test.ts` now expects `version: 2`.
- **vault-engineer / attest gating.** `LiveChain.attest` also refuses (`INDEXER_UNDELIVERED`) while indexed withdrawals are undelivered, but only once an `onWithdrawn` listener exists, so the core server's current flow (no withdrawal listener) keeps working.
- **vault-engineer / fail closed after rotating away.** `acceptLedgerSigner` rewrites the deployment file's `ledgerSigner` and `txs.acceptLedgerSigner`; while the recorded signer differs from the `.secrets` ledger-signer key, `signWithdrawal` and `attest` throw the new `ChainError` code `SIGNER_MISMATCH`. The deployer proposes on one run and accepts on a re-run after the eta, and meanwhile keeps the vault's actual signer in the file (start-up verification fails until the rotation is accepted and the process uses the new key).
- **vault-engineer / deployer semantics.** `--signer-change-delay` and `--house-buffer-bps` / `--house-daily-cap` are converged only when given (unlike the Stage A limits, which always converge to defaults): an automatic reset could schedule a loosening nobody asked for. `--escape-delay` only applies to a new vault; attaching to a vault with another value is `DEPLOYMENT_MISMATCH`.
- **vault-engineer / OfflineChain defaults.** `maxAttestationAge` 600 s (was 3,600), buffer and house daily cap enforced, `ledgerRoot` stored lowercase, `escapeDelayS` option (default 7 days).
- **vault-engineer / misc.** `TxReceipt` gained optional `logs` (used to read `ExcessSwept` / `EscapeClaimed` amounts). The anvil integration test honours `MAYA_RPC_URL` by passing `rpcUrl` explicitly; `networkConfig('local')` still ignores that variable (as its test requires). An empty balance tree has the zero root.
- **vault-engineer / core integration still open.** No core code calls the new chain APIs yet. To use the escape hatch and the buffer, the core server should: attest `buildBalanceTree(...).root` under the leaf contract above, subscribe `onWithdrawn` and net redeemed vouchers by `player:nonce`, bound withdraw-surplus by `houseWithdrawableWei`, and surface `SIGNER_MISMATCH` and the pending timelocks (`pendingSigner`, `pendingHouseLimits`, `pendingSignerChangeDelay`, `escape`) in the console.

## defenses-engineer (SPEC-10: latency arbitrage and model drift) — 2026-09-26

Design addendum: `docs/maya-live/SPEC-10-defenses.md`; measurements: `artifacts/verification/defenses-ablation-2026-09-26.md`.

- **defenses-engineer / engine default is "all defenses on".** `EngineConfig.defenses` omitted means `DEFAULT_DEFENSES` (fail safe). `bootstrap.engineConfig` passes it explicitly. The Stage A engine tests (`test/helpers.ts makeEngine`, `test/app-helpers.ts startTestApp`) now pass `DEFENSES_OFF` unless a test opts in, so every Stage A assertion still runs unchanged against the Stage A behaviour; the SPEC-10 behaviour has its own tests (`test/defenses*.test.ts`, `test/reference.test.ts`, `test/sim-strategies.test.ts`, `packages/house/test/defenses.test.ts`).
- **defenses-engineer / `pending` placement result.** `PlaceResult` gains `{ status: 'pending', hold, newlyHeld }`; `POST /v1/bets` answers 202 for it and `GET /v1/bets/by-request/:id` answers 200 with `pending | accepted | rejected`. A held stake is reserved (`availableBalance`), not posted, and is not withdrawable during the hold.
- **defenses-engineer / fair-value check replaces the price-move guard at the end of a hold.** The Stage A spot guard (`guardSigma`) still runs at request time; at resolution the symmetric fair-value tolerance supersedes it.
- **defenses-engineer / quote TTL.** With quote validity on, a quote's life is `min(generated + maxTtlMs, start − minLead, source + freshness)` and it stops standing `graceMs` after a newer first-seen sample was observed (or at once on a reference-feed invalidation). With it off, the Stage A 1.8 s TTL applies.
- **defenses-engineer / minimum lead keeps the §3.1 geometry.** `start0 = ceil((t + 3) / 5) × 5` is unchanged; cells with τ < `minLeadS` are unavailable with reason `too-late`, and `TOO_LATE` / quote expiry use `max(minLeadMs, minLeadS × 1000)`.
- **defenses-engineer / toxicity: graduated policy with latency evidence.** Beyond the brief's outcome thresholds, the monitor also uses the signed fair-value move between request and fresh sample of every held placement (rejected ones included) against a population baseline. Outcome evidence is measured against p at acceptance (p_fresh after a hold) so the hold's own selection cannot read as skill. With graduated toxicity on, `run-sim`'s simulated operator no longer blocks every monitor flag after 15 minutes (`operatorBlockMin` default 0; Stage A profile keeps 15).
- **defenses-engineer / controller learns from clean flow.** "Non-flagged flow" is read as: not priced from the flagged grid, account never flagged or blocked, latency evidence ≤ `cleanHoldZ`. Otherwise unflagged adversaries (the splitter) push every range's edge up at honest players' expense (measured: +3.5–5 pts in all ranges before this filter).
- **defenses-engineer / flow surcharge.** The effective flow edge is `max(schedule.flowEdge, toxicity.surchargeEdge)` while graduated toxicity is on; the flagged grid is published whenever that is > 0 and an account is flagged.
- **defenses-engineer / RTP ranges have one source.** `metrics.RTP_RANGES` re-exports `@maya/house MULTIPLIER_RANGES` (identical values) so the controller and the reports cannot drift apart.
- **defenses-engineer / sim changes (apply to every profile, including the Stage A baseline).** The Stage A `sniper` strategy is renamed `sniper1s`; `sniper2s` and `splitter` are added (weights normalised with the Stage A ones). Honest simulated clients only pick quotes the house would still accept (`quoteStands`) and cap stakes by balance net of held stakes and by the account headroom incl. the ramp, as the player API's `maxStakeCenti` does. Splitter sub-accounts register as players, so they also count towards the launch-boost threshold. `run-sim` refuses to write into an existing non-empty run folder.
- **defenses-engineer / reference feed.** `MAYA_REFERENCE_FEED` (default `hermes` with `MAYA_FEED=live`, `off` otherwise; `hermes` with replay is a config error) and `MAYA_HERMES_URL` (default https://hermes.pyth.network).
- **defenses-engineer / simulation builds.** Tuning runs (scratch, not kept) used a private build with `src/chain`, `chain-port.ts` and `offline-chain.ts` from git HEAD while the chain adapter was being changed concurrently. The kept ablation runs use a frozen snapshot of the integrated working tree taken when it built and passed all unit tests (`apps/house-server/data/simfinal`, gitignored; source hash in each run's `run.log` command and in the ablation report), so they include the concurrent SPEC-11 offline-chain changes as of that moment.
- **defenses-engineer / hold tolerance on the log-odds scale.** The brief's "|p_fresh − p_quote| exceeds tolerance in either direction" is implemented with a direction-free width on log-odds by default (`tolScale: 'logit'`; `'relative'` is available). A relative band cannot bind upward for high-probability squares (p can rise at most to 1) or downward for low ones, so it rejected mostly one side: measured +3.5 pts RTP for the grinder (low multipliers) and −4.9 pts for the chaser (long shots) at a 40 % relative band. The log-odds band treats the player's and the house's probability alike and removed most of that bias at a lower rejection rate.
- **defenses-engineer / trust ramp on the hold tolerance.** Beyond the brief's liability ramp, an account's first 10 holds (and any later hold while its latency evidence z > 2) use a tight tolerance, and accounts flagged on latency evidence keep a tight one. This bounds what a new or rotated account (the splitter) can extract before the monitor has 10 holds of evidence.

## server-wiring-engineer: SPEC-11 chain features wired into the core server (apps/house-server outside src/chain) — 2026-09-26

These notes supersede the Stage A house-server notes above where they conflict. In particular, the treasury note "vouchers stay counted as liabilities until the server itself sees the claim" and the offline-network note "it is not persisted" no longer hold.

- **server-wiring-engineer / withdrawals come from chain events.** `HouseApp.start()` subscribes to `ChainPort.onWithdrawn` after `onDeposit`. `HouseEngine.applyChainWithdrawal` then claims the voucher with that `player:nonce`, whoever submitted the transaction (a MetaMask player or the server).
  - This is now the only way the app releases a voucher to the vault.
  - A receipt the server holds (on-chain players in `run-sim`) is only journaled as a hint (`voucher-submitted`), the same way deposits are only credited from events.
  - So a voucher stays an outstanding liability, and stays in the balance tree, until its `Withdrawn` event is delivered up to the indexer watermark (the SPEC-11 §6.2 cut).
  - On a live chain, reconciliation shows the redeemed amount as a temporary delta until the confirmations pass. `run-sim` waits up to 180 s for those events before its final attestation.
  - `markVoucherClaimed` (the Stage A receipt claim) is kept for compatibility and for old journals. It answers true when the voucher is already claimed with the same tx.
  - New journal events: `withdrawal`, `voucher-submitted`, `voucher-expired`. The `attest` event gains optional `leaves`, `leafTotalWei`, `treeFile` and `treeSha256`.
- **server-wiring-engineer / anomalous redemptions are booked conservatively and stay visible.** Each `Withdrawn` event is applied once per `player:nonce`, and the journal event fixes the posting amounts. The four outcomes:
  - `claimed`: a signing or pending voucher of the same amount. The voucher liability moves to the vault.
  - `claimed-after-release`: the voucher was cancelled or expired and credited back, yet the vault paid it. The amount is taken back from the player's ledger balance, and house equity covers any shortfall.
  - `amount-mismatch`: the matching voucher names another amount. The voucher is claimed. House equity covers any excess; any unpaid remainder goes back to the player, because the nonce is spent.
  - `unmatched`: no voucher of this ledger has that nonce. House equity covers the whole amount.

  Every outcome except `claimed` raises a critical alert `WITHDRAWAL_<OUTCOME>`. It is also listed in `reconcile().components.anomalousWithdrawals[Wei]`, in `/admin-api/chain.withdrawals.anomalies` and in `GET /v1/withdrawals`.

  A charge to house equity is a loss, not a treasury flow, so it counts towards the drawdown breaker (fail closed). Amounts that are not whole Centi move `ceil(amount / 10^16)` Centi and book the rounding as retained dust, so the vault and ledger still match to the wei.

  Known hazard: a *fresh* journal attached to a vault with history that gets rescanned (for example after the indexer's cursor-v2 upgrade) sees every earlier redemption as `unmatched`. It charges each one to the house, with one alert each. Restart with the same `MAYA_RUN_ID` and journal instead.
- **server-wiring-engineer / voucher nonces are hashed.** The nonce is `uint256(first 31 bytes of sha256("maya-voucher-nonce:<runId>:<voucherId>"))`, so it is below 2^248. It replaces the Stage A counter (1, 2, 3, …).
  - Why: the vault accepts each (account, nonce) once ever, and it outlives journals (Base Sepolia). A counter restarted by a new journal would either revert as `NonceAlreadyUsed` or let an old voucher's event claim a new voucher.
  - The nonce is journaled in the `voucher` event, so a rebuild is exact.
- **server-wiring-engineer / expiry sweep (conservative on gaps).** Every 60 s of chain clock (`voucherSweepEveryMs`), the server looks at signing or pending vouchers whose expiry is more than `voucherExpiryMarginS` (600 s) behind chain time. It checks each one with `ChainPort.nonceUsed`:
  - Nonce unused: the voucher can never pay again. The amount returns to the balance (`voucher-expired`, with a system audit entry by the actor `voucher-sweep`).
  - Nonce used: its event is still on the way. The voucher stays a liability, and a one-time `WITHDRAWAL_EVENT_PENDING` warning is raised.
  - The read fails: the voucher is skipped until the next sweep.

  This is also how vouchers invalidated by a signer rotation (DEVIATIONS `contracts / signer rotation`) and vouchers stuck in `signing` after a crash return to balances. If a voucher is released and then paid anyway (clock skew beyond the margin), the `claimed-after-release` outcome catches it.
- **server-wiring-engineer / balance-tree leaves (exact definition).** `ledgerRoot` is `buildBalanceTree(HouseEngine.balanceEntries()).root` (`src/chain/merkle.ts`, the OpenZeppelin StandardMerkleTree of `(address, uint256)`). There is one leaf per on-chain account (`player:<address>`) whose amount is above 0. The amount, in wei, is the sum of:
  - the ledger balance, including stakes reserved by held placements;
  - its vouchers with status `signing` or `pending` (not yet seen redeemed on chain);
  - the max payout (stake + liability) of its open legs;
  - all of the above × 10^16, plus the wei dust of its own deposits.

  Left out of the tree:
  - sim accounts (off-chain sim credit);
  - accounts owed 0 (registered by sign-in only, or fully withdrawn). They claim with `attestedBalance = 0` and an empty proof.
  - house-side dust (from the treasury sync). It is still attested inside `liabilities`.

  So Σ leaves = `liabilities` − house-side dust, which is ≤ `liabilities`. Every snapshot checks this; if it ever fails, the snapshot throws and the attestation fails closed. An empty ledger attests the zero root.
- **server-wiring-engineer / tree persistence.** Each tree is written atomically *before* the attest transaction, to `<dataDir>/attestations/<chainId>-<vault>/attest-<seq>-<root>.json`. The file holds the leaves, the requested asOf, the liabilities and the leaf total.
  - There is one folder per vault, so trees outlive a run on a persistent vault. `run-sim` writes them to `<out>/attestations/`.
  - Writing first means a crash between the transaction and the journal flush never leaves the vault holding a root nobody can prove against.
  - Files from failed attempts, or attempts with an unknown outcome, may remain. They are never served, because lookup uses the vault's own (seq, root).
  - Loading recomputes the root from the stored leaves and ignores a file that does not reproduce it.
  - Without a data dir (journal off, tests), trees are kept in memory only (the latest 8).
- **server-wiring-engineer / `GET /v1/account/:address/proof`.** Public, like `/v1/account` (no guard). It returns the account's leaf under the attestation the vault currently holds (the frozen root in escape mode). If the vault can't be read, it uses the journal's latest attestation instead.
  - Response: `{ account, chainId, vault, attestation: { seq, root, asOf, asOfMs, liabilitiesWei, source: vault|journal, txHash? }, included, balanceWei, proof, currentOwedWei, claim: { function: 'claimEscape(uint256,bytes32[])', attestedBalance, proof }, escape: { mode, available, lastAttestationAtMs, escapeDelaySec, availableAtMs, secondsUntilAvailable, poolWei, claimedWei, entitlementWei? } }`.
  - `entitlementWei` is present only in escape mode. It comes from the adapters' `escapeEntitlement` (a `VaultOperatorExtras` method, duck-typed).
  - Before any attestation, the response has `attestation: null` and a balance of 0.
  - If the tree for the vault's root is missing or does not verify, the endpoint fails closed with 503 `PROOF_UNAVAILABLE`. The body still carries `attestation` and `escape`.
  - Vault reads are cached for 2 s, as for every other API read.
- **server-wiring-engineer / `/admin-api/chain` additions.**
  - `vault` gains `ledgerSigner` (the vault's), `serverSigner` (the key this process holds), `signerMismatch`, `pendingSigner {address, eta, etaMs, due}`, `signerChangeDelaySec`, `pendingSignerChangeDelay`, `maxAttestationAgeSec`, `houseBufferBps`, `houseDailyCapCenti`, `pendingHouseLimits`, `houseWithdrawableCenti/Wei`, `excessWei/Centi` and `escape {…, poolCenti, claimedCenti}`.
  - The top level gains `alerts[]` (computed now) and `withdrawals {indexed, anomalies}`.
  - `lastAttestation.tree` gives the leaf count, leaf total, file and sha256.
  - Pending vouchers show `voucherId` and `submittedTxHash`.
  - `overview.chainAlerts` carries the latest health-check alerts.
  - How `serverSigner` is found: it is captured at start. For a live chain that is after `LiveChain.start()` has checked that the vault's signer is the held key; for the offline chain it comes from `OfflineChain.signerKeyAddress`. `LiveChain.addresses().ledgerSigner` can't reveal a mismatch by itself, because it follows the deployment file, which `acceptLedgerSigner` rewrites.
- **server-wiring-engineer / vault admin endpoints.** They follow §7: a reason of 8–500 characters, unknown fields rejected, Idempotency-Key, and an audit entry with actor, before/after, reason and tx. Failures are audited as `failed: …`.
  - `POST /admin-api/vault/signer/propose {address}`: confirm `signer-propose`. Rejects a malformed or zero address, `SIGNER_IS_OWNER` and `SIGNER_UNCHANGED`.
  - `POST /vault/signer/accept`: confirm `signer-accept`. Answers `NO_PENDING_SIGNER`, or 409 `TIMELOCK_NOT_ELAPSED` from the vault's own check. The vault checks the eta against chain time; the server does not pre-check it with its own clock. The ack carries `invalidatedVouchers`, and a `warning` if this process no longer holds the signer key.
  - `POST /vault/signer/cancel`: a reason only, since cancelling reduces risk.
  - `POST /vault/sweep-excess {to}`: confirm `sweep-excess`. Rejects the zero address and the vault, answers `NOTHING_TO_SWEEP`, and returns `amountWei`. Nothing is posted to the ledger, because the swept tokens are outside accounted assets.
  - The vault's business reverts (`TimelockNotElapsed`, `NoPendingLedgerSigner`, `SignerUnchanged`, `SignerIsOwner`, `NothingToSweep`, `InvalidRecipient`, `ZeroAddress`, `EscapeModeActive`) answer 409 with the SNAKE_CASE name. Other chain failures answer 502 `CHAIN_ERROR` as before.
  - `withdraw-surplus` now has a third bound after the Stage A free-equity and surplus checks: `vault.houseWithdrawableWei` (409 `EXCEEDS_HOUSE_WITHDRAWABLE`). That covers the 10 % buffer on obligations and the house daily cap.
- **server-wiring-engineer / chain-health SSE alerts.** The vault state is checked every 60 s of chain clock (`chainHealthEveryMs`) and right after each vault admin action (`src/chain-alerts.ts`).
  - An alert goes out on the SSE `alert` event only when a condition appears or changes. Alerts are grouped by family: a new proposal or a higher level alerts again. When a condition clears, `<CODE>_RESOLVED` (info) goes out.
  - The codes:
    - `SIGNER_CHANGE_PENDING` (warning), which becomes `SIGNER_CHANGE_DUE` (critical) at the eta.
    - `SIGNER_MISMATCH` (critical).
    - `SIGNER_DELAY_CHANGE_PENDING` and `HOUSE_LIMITS_CHANGE_PENDING` (warning).
    - `ATTESTATION_STALE` (warning, when age > max(maxAttestationAge, 3 × the attest interval)).
    - `ESCAPE_APPROACHING` (warning at ≥ 50 % of `escapeDelay` since the last attestation, critical at ≥ 75 %).
    - `ESCAPE_AVAILABLE` (critical: anyone can trigger escape mode).
    - `ESCAPE_MODE` (critical).
  - Like every other alert, these are not journaled.
- **server-wiring-engineer / external-wallet withdrawals behind `MAYA_OPEN_PLAYER_API=testnet-unsafe`.** The default is `off`; any other value is a config error.
  - When off, `POST /v1/withdrawals` and `GET /v1/withdrawals?account=` answer 403 `PLAYER_API_DISABLED` and reserve nothing. The Stage A API test now opts in through the test helper.
  - The body is `{account, amountCenti, requestId?}`. A `requestId` makes retries idempotent. Without one, the server names the request `wd-<uuid>`, so a retry reserves again.
  - The answer is the signed voucher: `{voucherId, requestId, status, account, amountCenti, amountWei, nonce, expiry, expiryMs, signature, vault, chainId, created}`, plus the EIP-712 `domain`, `types`, `primaryType` and `message`, and `call` (`withdraw(uint256,uint256,uint256,bytes)` with its arguments).
  - New vouchers are refused, with nothing reserved, in three cases: the vault is paused (409 `VAULT_PAUSED`), in escape mode (409 `VAULT_ESCAPE_MODE`), or signed by a key this process does not hold (503 `SIGNER_MISMATCH`). A repeated requestId still gets its existing voucher.
  - Stage A has no SIWE, so anyone who reaches the port can act for any account. A voucher only pays `msg.sender = account`, so the exposure is griefing (moving a player's balance into a voucher until expiry plus margin), not theft. SIWE must replace this switch before any real use. Never enable it outside a testnet.
- **server-wiring-engineer / offline chain persists (feasible, done).** `OfflineChainOptions.statePath` writes the full vault and token state after every state change (tmp file + rename) and restores it at construction.
  - A `seed` is required, because the HMAC signer key is derived from it and never written. A file from another seed or player count is refused (`DeploymentMismatch`).
  - A restored chain delivers every recorded `Deposited` and `Withdrawn` event again to the first subscriber of each kind. That is "at least once", like the live indexer; the ledger drops duplicates.
  - State is saved before the event is delivered. So a deposit or redemption whose journal entry was lost in a crash is still applied after the restart.
  - `main.ts` uses `<dataDir>/offline-chain-<runId>.json` whenever the journal is on. Restarting with the same `MAYA_RUN_ID` rebuilds a ledger that reconciles exactly. This is tested, including a deposit whose journal line was lost.
  - Two gaps remain, the same as on a live chain:
    - A `fundHouse` or `withdrawHouse` that completed on chain but whose journal entry was lost still shows as a reconciliation delta. The ledger does not consume house treasury flows as events.
    - An attestation lost from the journal is harmless, because the next seq comes from the vault.
  - `run-sim` and the tests keep the in-memory chain (no `statePath`).
  - With `chainClock: 'feed'`, `HouseApp.chainNowS()` now reads the offline chain's own clock (`OfflineChain.chainNowS()`, which is the feed clock in production). So voucher expiries, the sweep and the alerts use the chain time the vault checks.
- **server-wiring-engineer / out of scope, still open.**
  - The house console (`apps/admin`) shows none of the new chain fields, alerts, signer or sweep actions, or anomalies; its decoder ignores the extra fields.
  - SIWE (Stage B) is not implemented.
  - The escape claim itself is a player transaction; the server only serves the data.
  - The SPEC-11 §6.5 caveat about anvil's shared block timestamps still applies to the leaves.
- **server-wiring-engineer / attestation asOf and voucher expiry use chain time (bug found on anvil).** Stage A requested the attestation `asOf` from the wall clock on live chains, and `LiveChain.attest` only clamps it *down* to the indexer watermark. When block time runs ahead of the wall clock (anvil after `evm_increaseTime`, or Base Sepolia by a second or two), `asOf` fell before flows the ledger had already applied. The vault then counted them again: an escape entitlement of 2× the leaf in the anvil run, and deposits since the attestation owed twice.
  - Fix: `HouseApp.chainTimeS()` = max(wall clock, `LiveChain.chainTime()`), read before the synchronous snapshot → tree → attest turn. The adapter still clamps it to the watermark. It also serves as the base of voucher expiries and as the expiry sweep's clock.
  - Offline chains use the vault's own clock.
  - This supersedes "asOf is … the wall clock for live chains" in the Stage A treasury note.
  - The chain-health alerts and the escape view keep the cheap wall clock on live chains.
- **server-wiring-engineer / live wiring test.** `test/app-live.anvil.test.ts` runs HouseApp on the real vault through LiveChain, with the deterministic fixture keys from `test/chain`. It covers:
  - deposits credited;
  - a 248-bit-nonce voucher redeemed from the player's wallet and claimed by its event;
  - the balance-tree root attested;
  - after the escape delay, the vault verifying the served proofs and paying each leaf once.

  It runs only with `MAYA_APP_ANVIL_URL` on a dedicated node, not with `MAYA_RPC_URL`. It moves anvil's clock by the escape delay, which breaks the same-UTC-day assumption of `test/chain/integration.anvil.test.ts` when both share a node.

## console-engineer: house console against the real server, SPEC-10 defenses and SPEC-11 vault surfaces (apps/admin) — 2026-09-26

Verified against the real server (`apps/house-server/dist/main.js`, `MAYA_NETWORK=offline`, `MAYA_FEED=replay`, scratch `MAYA_DATA_DIR` / `MAYA_SECRETS_DIR`, port 8796) through the Vite dev server. These supersede the Stage A `admin /` notes above where they conflict.

- **console-engineer / new Defenses page (`g d`).** SPEC §8 lists seven pages; the console adds an eighth, Defenses, between Controls and Treasury. It reads `GET /admin-api/defenses` (every 5 s) and writes `PUT /admin-api/defenses`. It shows:
  - hold, toxicity and controller metrics, and hold outcomes by detail;
  - realized vs policy RTP per multiplier range, with the learned, pinned and effective adjustment;
  - recent nudges from the audit log (`controller-adjust` by `edge-controller`, plus admin `defenses` changes);
  - the reference-feed status;
  - one form per section, and a pin table.

  `keys.test.ts` now expects the key order `orepcdta`.
- **console-engineer / defenses confirmation mirrors `engine.setDefenses`.**
  - Switching any defense off sends `confirm: "defenses-disable"`, which also covers the edge move it causes.
  - Otherwise, a move of more than 2 points in an edge charged on new quotes sends `"edge-change"`. The edge is measured per range (the override wins; otherwise the learned adjustment while the controller is on; otherwise 0) and on the flow surcharge (0 while graduated toxicity is off).
  - The view can be stale, so while the controller runs the console widens the test by one controller step (`maxStepPerEval`). It may therefore ask for `edge-change` when the server would not, which is harmless.
  - The server's cross-field rules are checked before the dialog opens: block z ≥ surcharge z, unflag z ≤ surcharge z − 0.5, block counts ≥ flag counts, hourly move ≥ step. Field bounds are the server's `validateDefenses` ranges.
  - The console warns when the adaptive edge would run without the hold or graduated toxicity. The server does not enforce that as an interlock.
- **console-engineer / surplus withdrawal no longer blocks on a stale attestation.** The server attests immediately before `withdrawHouse` (house-server treasury note). The Stage A console rule "attestation missing or older than the vault allows → attest first" therefore refused a request the server handles itself.
  - The plan now allows it and warns that a pre-withdrawal attestation transaction comes first.
  - It caps the amount at `min(surplus, houseWithdrawableCenti)`, which covers the 10 % obligations buffer and the daily house cap.
  - It refuses in escape mode.

  The unit test that asserted the old block was replaced by one asserting the server's rule (allowed, with the pre-attestation warning) and the new caps.
- **console-engineer / SPEC-11 vault controls.** These cover signer rotation (propose `signer-propose`, accept `signer-accept`, cancel with a reason only) and `sweep-excess`.
  - Accept is disabled until the server reports `pendingSigner.due`, so the vault never reverts with `TimelockNotElapsed`.
  - The countdown and the escape clock tick every second without re-rendering the forms.
  - The ack's `warning`, `invalidatedVouchers`, `amountWei`, `attestTxHash` and `disabled` are shown; a long `after` collapses.
  - Chain times use the feed clock for the offline vault and the demo, and wall time for live chains, as the server's alerts do.
  - Vault alerts (`overview.chainAlerts`, `chain.alerts`) appear in the shell banner strip with an "Open treasury" button.
  - A switched-off acceptance hold shows a standing warning banner.
- **console-engineer / proof lookup uses the public player route.** The escape-hatch proof is served only at `GET /v1/account/:address/proof`, not under `/admin-api`.
  - The console calls it with `PLAYER_PREFIX` and never sends the admin token there.
  - The 503 `PROOF_UNAVAILABLE` body is decoded, so the attestation and escape status still render.
  - The Vite dev proxy now also forwards `/v1/account`. Its target is configurable with `MAYA_ADMIN_API_TARGET` (default `http://127.0.0.1:8790`).
- **console-engineer / integration fixes found against the live server.**
  - Market ids are `btc-usd` and `eth-usd`. The console labels them `BTC/USD` in tables, the ticker, breaker titles and the exposure switch.
  - The offline network is labelled "Offline vault".
  - The exposure drill-down now asks the server for the cell (`bets?start=&bandIndex=`), with no status filter. Before, it read 500 open legs and filtered them locally, so it could miss legs in a busy market; at replay speed the window also settled before the answer arrived. Settled legs now show their result.
  - The Players On-chain and Simulated chips use the server's `kind=` filter. Before, the 11 on-chain accounts among thousands of sims could fall outside the loaded pages.
  - Players show holds, latency z and excess-return z, marked against the live toxicity thresholds.
  - The player drawer shows the voucher lifecycle (status, expiry, claim tx, claim source or note, release reason) and a proof lookup for on-chain accounts.
- **console-engineer / alert toasts are coalesced.** At crowd scale the toxicity monitor raises one SSE `alert` per account action (several per minute at ×10 replay), and critical toasts stay until dismissed.
  - The console now shows at most one toast per alert code per 60 s.
  - That toast says how many alerts were folded in and replaces the previous toast of the same code.
  - Every alert is still stored, and the audit log keeps the detail.
- **console-engineer / layout bug fixed (pre-existing).** The `sr-only` table captions are `position: absolute` with no positioned ancestor. They escaped the `.main` scroll container and stretched the document to about 1,300 px, so focusing a control near the bottom scrolled the whole shell and hid the header. `.main` is now `position: relative`. Chart tooltips also hide on scroll.
- **console-engineer / demo fixture follows the server.**
  - Shapes: server market ids, bare lower-case `0x` on-chain account ids, `sniper1s`, `maxAttestationAge` 600 s, and the SPEC-11 chain fields.
  - Routes implemented: `GET /defenses`, `PUT /defenses`, signer propose / accept / cancel, `sweep-excess`, `bets?start=&bandIndex=`, `players?kind=`, and the public proof route.
  - Validation and confirm classes are written independently of the console (`demo/extras.ts`), mirroring `validateDefenses` and `src/chain-alerts.ts`.
  - Scripted beats: the controller nudges a range at about 35 s, then every 90 s; a rotation proposed 48 h before the start becomes due at about 95 s; the signer attests every 10 minutes.
  - These extras use a second PRNG, so the Stage A seeded sequence is unchanged. The demo tests that named `BTC/USD` / `ETH/USD` now name `btc-usd` / `eth-usd`; the assertions are otherwise unchanged.
- **console-engineer / contract fixtures from the real server.** `src/live-fixtures.ts` holds trimmed responses captured from the server run above. It is test-only and not bundled. `src/contract.test.ts` checks three things against them:
  - every captured response decodes;
  - absent server extensions stay absent;
  - a wrong type in any of the new fields fails.

  To regenerate, capture the endpoints from a running server and rebuild the module.
- **console-engineer / observed server issues (not changed; for the server owners).**
  1. The toxicity alert text prints the outcome z even when the action used latency evidence, so a surcharge can read `(z=-0.50)`. The audit reason is correct.
  2. At 12,000 sims, the monitor's flag, surcharge and block entries fill the audit log: in one run, about 400 of the latest 400 were `toxicity-monitor`. `GET /admin-api/audit` has no kind or actor filter, so operator actions age out of the 500-entry window the console loads.
  3. The overview carries `holdLatencyP95Ms` but not the hold cap; the console reads `maxHoldMs` from `/defenses`.
  4. The proof lookup exists only on the player API. A static console build therefore needs `/v1/account` reachable at `VITE_ADMIN_API_BASE`, not just `/admin-api`.

## fixer (admin): console-conformance review fixes CC-01…CC-14 (apps/admin) — 2026-09-27

Regression tests are in `apps/admin/src/console-review.test.ts` (34 tests). I ran them against a copy of the pre-fix source, with the new helper names shimmed to the old DOM logic: 32 failed. The other 2 are guards that pass both before and after. These notes supersede the `admin / write body and ack` note above where they conflict.

- **fixer (admin) / CC-01 unknown write outcomes.**
  - A failed write is an *unknown outcome* in three cases:
    - there was no answer (timeout or dropped connection);
    - the status is any 5xx, such as the Vite proxy's empty 502 after the server applied the write, or a 500;
    - the code is `CHAIN_ERROR`, `TX_TIMEOUT`, `TX_UNKNOWN_OUTCOME` or `UNKNOWN_OUTCOME`, at any status.
  - The error keeps the server's code and message and carries `outcome: 'unknown'` (`api.isUnknownOutcome`). Reads are unchanged.
  - Each confirm dialog drives one `WriteSession` (`src/write-session.ts`). A new submission gets a fresh Idempotency-Key, so an edited resubmission after a definite rejection is a new intent.
  - After an unknown outcome the session locks:
    - the reason and confirmation inputs freeze and "Apply" is disabled;
    - the only action left is **Retry same request**. It resends the identical body under the **same** key, so the server's IdempotencyCache replays its stored answer instead of applying the write again;
    - the operator is still sent to the audit log first, because that cache lives only in server memory (see open issues).
  - This replaces the Stage A rule "fresh UUID per submission".
  - `UnknownOutcomeLog` remembers unknown outcomes per endpoint for 30 minutes. Reopening the same action (for example "Fund the house") shows a critical warning in the dialog.
  - Browser check against a scratch API behind the Vite proxy: the API applied the first fund request, then destroyed its socket.
    - The dialog showed `HTTP_502 Bad Gateway` as an unknown outcome.
    - A second Apply sent nothing.
    - Retry sent the same key and got the replayed ack: 2 requests, 1 applied.
- **fixer (admin) / CC-02 new runs.** `store.classifyOverview` replaces the old rule that dropped any overview with an older clock.
  - It treats an overview as a new run when:
    - `runId` differs;
    - `journalSeq` went back and the clock went forward;
    - `journalSeq` went back and the clock jumped back more than 60 s of server clock;
    - there is no run identity and the clock jumped back more than 60 s.
  - A new run:
    - resets the ticker, audit, refits, last breaker and chain state;
    - emits `run` and raises an info alert `NEW_RUN`;
    - makes Overview reload its metrics and chain, and Audit and Treasury re-poll.
  - A small backwards step within one run is still dropped.
  - A poll answer is dropped when another overview arrived after the poll was sent (`requestedAtMs`). This replaces the clock comparison for poll-versus-stream races.
  - `overview.runId` and `overview.journalSeq` are now decoded (optional).
- **fixer (admin) / CC-03 staleness.**
  - An overview older than 8 s of wall time marks the data stale (`OVERVIEW_STALE_MS`; the stream sends one every 1 s and the fallback poll runs every 5 s). When stale:
    - the Overview health strip and tiles grey out under a note giving the server-clock "as of" time and the last poll error;
    - the header clock reads "· stale";
    - a critical banner outranks every other banner.
  - Feed ages come from `store.feedNow()`, which has no 5 s cap, and re-render every second. The last-price ages on Controls use it too. The header clock stays capped.
  - "Live stream interrupted" now ranks above warnings (rank 2 of 3).
  - The fallback poll error is stored and shown in the banner detail.
  - "+N more" is now a button that expands the strip. The strip grows only when the operator asks.
  - The ticking age is `aria-hidden`, so screen readers are not re-alerted every second.
- **fixer (admin) / CC-04 market rows.**
  - `controls.marketControl` derives each row from the market's own `manual` breaker. It offers Resume only when that breaker is paused, and Pause otherwise.
  - The row names the other causes: `pause-all`, `drawdown pause`, `equity floor` and `feed stale`.
  - `marketPlan(market, action, breakers)` warns in two cases: a resume the server would reject with NOT_PAUSED, and a market that pause-all or a drawdown pause still holds.
  - Titles use labels such as `BTC/USD`.
  - Without a breaker list (older servers), the old `paused` behaviour remains.
- **fixer (admin) / CC-05 unreadable vault.** `vault.unavailable` now shows as follows:
  - the Overview chain cell is critical "Vault unreadable" (`chainSummary`);
  - a critical banner reads "Vault unreadable". The shell gets `/chain` from the store, which pages feed and a 30 s background poll refreshes;
  - Treasury shows a single critical badge instead of "Vault open", "Assets identity holds" and "reconciles" (`vaultBadges`);
  - the escape card says "unreadable", not "pre-SPEC-11";
  - the attestation card says "Unverified — the vault is unreadable" instead of "Fresh" from the journal fallback.
- **fixer (admin) / CC-07 alerts.**
  - A header **Alerts** button shows the unread count, highlighted when it includes a critical alert.
  - It opens a panel with the last 50 alerts and an All / Critical / Warning / Info filter.
  - When full, the store drops the oldest non-critical alert first.
  - Toasts follow the same rule, so an ack or routine toast never evicts a sticky critical toast.
  - Critical toasts use `role=alert`.
- **fixer (admin) / CC-08 breaker rows.** Breaker SSE payloads now decode `actor` and `from`.
  - Admin transitions add no client row: the server's `admin-action` row carries them, with the admin as actor.
  - Automatic transitions (`actor` 'system') add a provisional row:
    - id `breaker:<id>:<market|*>:<since>:<state>` and action `breaker:<id>:<state>`;
    - `before` set to `from`, and result "live (journal entry pending)".
  - The server's journaled row for the same id, market, time and state replaces the provisional row, whichever arrives first.
- **fixer (admin) / CC-09 money in acks and audit.**
  - `format.formatDisplayValue` renders `…Centi` keys as exact OPEN and `…Wei` keys as exact OPEN from wei, with any dust shown. Keys containing "eth" render as ETH.
  - It is used by the dialog's "Now" line and by the audit before/after cells.
  - The raw JSON stays in a "Raw JSON" disclosure and in the audit cell tooltip.
  - Audit search matches both forms.
- **fixer (admin) / CC-10.** The player drawer's flag label names the actor of the latest `flag` entry, for example "Flagged by admin" or "Flagged by toxicity monitor".
- **fixer (admin) / CC-11.** `rtp-stats.rtpTarget` is null for rows with no bets; the server sends expected 0 and a 0–0 band for them.
  - Such rows get no target tick and no band.
  - They read "no bets" in the chart, tooltip, aria label and tables.
  - Their gap is "—".
- **fixer (admin) / CC-12.** `pricingPlan(before, draft, { launch, registeredPlayers })` adds an "Edge on new quotes now" row.
  - While the boost is active, the dialog says the standard edge applies when the boost ends at N players.
  - A move of more than 2 points still needs `edge-change`, as the server requires.
- **fixer (admin) / CC-13.**
  - The header network pill stays visible at every width. Below 1280 px only the chain id hides, and the demo pill shortens to "Demo".
  - Checked in a 1024 px frame: the header does not overflow and the clock is not clipped.
  - Every on-chain plan has `onChain: true`, and its dialog reads "On-chain transaction on <network> · chain <id>". The on-chain plans (`ON_CHAIN_ACTIONS`) are fund, withdraw-surplus, attest, vault pause/unpause, signer propose/accept/cancel and sweep.
- **fixer (admin) / CC-14.** The House equity tile shows the exact figure to the cent, for example 99,999,801.94 instead of "99.9M".
  - The label is "House equity · OPEN".
  - The value uses a slightly smaller face so it fits.
- **fixer (admin) / open for the server owners (not changed here).**
  1. CC-06: answer TX_TIMEOUT with a distinct code, for example 504 `TX_TIMEOUT` with the tx hash, instead of 502 `CHAIN_ERROR`. The console already treats both as unknown.
  2. IdempotencyCache is in-memory, so a same-key retry re-applies the write in two cases:
     - after a server restart;
     - when the first request's handler threw instead of returning, because the cache stores only returned answers.
     
     It should be journaled.
  3. Raise a chain alert, and put it in `overview.chainAlerts`, when `readVault` fails. The console then need not rely on `/chain`.
  4. Optionally, expose `manualPaused` / `pausedBy` per market and a boot id in the overview.
  5. Alerts are not journaled. The console's panel only covers alerts received since the page loaded.


## fixer (contracts+chain): contracts-security review fixes CS-H1, CS-M1, CS-M2, CS-L1..L4 (contracts/, src/chain/, chain-port, offline-chain) — 2026-09-27

These supersede the SPEC-11 addendum and the `vault-engineer` notes above where they conflict. SPEC-11 itself was not edited (outside this role's files); §1, §2, §4, §6.3 and §7 of it should be read with the notes below.

- **fixer / CS-H1: bounded attestation seq step.** `attest` now also reverts `SeqStepTooLarge(seq, lastSeq, maxStep)` when `seq - attestationSeq > MAX_ATTESTATION_SEQ_STEP` (1,000,000).
  - Why a bound and not `seq == last + 1`: the server derives seq as `max(vault seq, journal seq) + 1` (`app.ts`), so a journal ahead of the vault (a reorged attest, a journal reused against a new vault) must not brick attestations.
  - Why it contains a leaked key: even at one million steps per transaction, reaching 2^64 takes about 1.8e13 attestations. The honest server (seq + 1) or a rotated-in signer can always supersede a malicious root.
- **fixer / CS-H1: a newly accepted signer gets a full escape window.** `ledgerSignerSince` (deployment, then each `acceptLedgerSigner`) is new, and `escapeAvailableAt() = max(lastAttestationAt(), ledgerSignerSince) + escapeDelay`.
  - `lastAttestationAt()` keeps its meaning (the attest block time). So the server's `ESCAPE_APPROACHING` alert, which measures attestation age, may escalate before `availableAt`. That is conservative.
  - Trade-off: an owner can postpone escape by rotating (each rotation needs 48 h of public notice). It gains nothing: an owner that installs its own signer could keep the clock fresh by attesting anyway (SPEC-11 §7).
- **fixer / CS-H1: SPEC-11 §7 correction.** A signer compromise is now contained by pause plus rotation, provided the new signer attests within `escapeDelay` of taking office.
  - What the attacker can still do: until the rotation, sign vouchers within the player limits, which are now timelocked for raises (see CS-L1).
  - Residual risk: if nobody ever attests after the rotation, escape eventually freezes the last root. That root may be the attacker's.
- **fixer / CS-M1: `recoverEscapeSurplus(address to)`** is owner-only and works only in escape mode, paused or not.
  - It sends `escapeSurplus() = assets() - (escapePool - escapeClaimedTotal)`, the accounted assets no claim can ever reach, and books them as `houseWithdrawn`. The `assets` identity and the console reconciliation therefore still hold.
  - Afterwards `assets() == escapePool - escapeClaimedTotal`. New event: `EscapeSurplusRecovered(to, amount)`. New error: `NothingToRecover`.
  - Not implemented (optional in the finding): `fundHouse` topping up the pool in escape mode. A claim cut short by the pool stays final.
  - The deployer now logs `no attestation yet: anyone can trigger the vault's escape mode from chain time …` for a never-attested vault.
  - The deployer skips house funding on an escaped vault, with a message, instead of failing on `EscapeModeActive`.
  - The idle-deployment risk remains: a vault that is never attested can be escaped after 7 days. Recovery makes that a bricked deployment, not a lost bankroll.
- **fixer / CS-M2: per-account daily cap.** New `accountDailyOutflowCap`, default 250,000 tOPEN (a quarter of the shared cap).
  - Tracking: `accountDailyOutflow(day, account)`, per UTC day, counting voucher withdrawals only. New error `AccountDailyOutflowCapExceeded(account, day, requested, remaining)`, checked after the shared cap.
  - New view `remainingAccountDailyOutflow(account) = min(own remaining share, shared remaining)`.
  - Residual risk: this stops one account from exhausting the shared cap. It does not stop Sybils: N accounts, with the same total capital (the cap), still can. The server-side reservation or throttle suggested by the finding lives in `engine.ts` (not this role) and is listed as open.
- **fixer / CS-L1: `setLimits` now takes four limits and timelocks raises.** The signature is `setLimits(maxVoucherAmount, dailyOutflowCap, accountDailyOutflowCap, maxAttestationAge)`; this is an ABI break.
  - Rule: `0 < maxVoucher <= accountCap <= dailyCap` and `0 < maxAge <= 1 day`.
  - Lowering or keeping every value applies at once. Raising any value, including a mixed change, is scheduled `signerChangeDelay` ahead. It is applied by `acceptLimits` and dropped by `cancelLimits` or by any new `setLimits` call.
  - New views: `pendingMaxVoucherAmount`, `pendingDailyOutflowCap`, `pendingAccountDailyOutflowCap`, `pendingMaxAttestationAge`, `pendingLimitsEta`.
  - Events: `LimitsUpdated` now has four fields; new `LimitsProposed(…, eta)` and `LimitsProposalCancelled(…)`; new error `NoPendingLimits`.
  - This also closes SPEC-11 §7's "raise the player limits instantly" path for an owner acting together with the signer.
- **fixer / CS-L2: proposals expire.** Every `accept*` (signer, signer-change delay, house limits, limits) reverts `ProposalExpired(eta + TIMELOCK_GRACE_PERIOD, now)` once `now > eta + TIMELOCK_GRACE_PERIOD` (7 days). The proposal stays stored until it is replaced or cancelled.
  - The deployer re-proposes an expired proposal, with a log line, instead of trying to accept it.
  - `VaultState` pending objects gain an optional `expiresAt`. Both adapters fill it.
- **fixer / CS-L3: the deployer converges only the limit flags given, each on its own.** `DeployOptions.limits` is now `Partial<VaultLimits>`, and an omitted limit keeps its on-chain value. This replaces the Stage A note "limits always converge to defaults".
  - Before any transaction, the merged combination is checked against the vault rule (`INVALID_ARGUMENT`).
  - The action line prints the limits before and after. A raise shows as `scheduled limits … → …` and is accepted on a re-run after the eta.
  - New CLI flag `--account-daily-cap`. The CLI no longer fills defaults. It validates only the relations between the flags given.
  - `test/chain/deploy-cli.test.ts` "fills unspecified limits from the vault defaults" encoded the bug and was replaced by "passes only the limit flags given".
  - No extra confirmation flag was added. A raise already needs 48 h of on-chain notice, and giving the flag is the intent.
- **fixer / CS-L4:** `proposeLedgerSigner` emits `LedgerSignerProposalCancelled(previous)` before `LedgerSignerProposed` when it replaces a pending proposal.
- **fixer / chain port and adapters.**
  - `VaultState` gains optional `accountDailyOutflowCapWei` and `pendingLimits`, and `EscapeState` gains optional `signerSince` and `surplusWei`. They are optional so hand-built states (e.g. `test/vault-admin-api.test.ts`) stay valid; `LiveChain` and `OfflineChain` always fill them.
  - `VaultOperatorExtras` gains `setLimits(PlayerLimits)`, `acceptLimits`, `cancelLimits`, `recoverEscapeSurplus(to)` (returns `amountWei`) and `remainingAccountDailyOutflow(account)`.
  - `OfflineChain` mirrors every rule above. Its state file stays version 1 with optional new fields: an older file loads with a 250k share and signer-since = deployment.
  - The option `accountDailyOutflowCapWei` defaults to 250k, clamped into `[maxVoucher, dailyCap]`.
  - `src/chain/abi.ts` was regenerated from `contracts/out`.
- **fixer / tests adapted to the new rules (not weakened).** In each case the property checked is unchanged or stronger:
  - Three unit tests whose `maxAttestationAge` of 1 h was irrelevant to what they check now pass 10 min, so the change stays an instant tightening.
  - Loosening setups go through the timelock with the new `VaultFixture._applyLimits`.
  - `testFuzz_attest_seqStrictlyIncreases` became `testFuzz_attest_seqIncreasesByABoundedStep`, which also asserts the step bound.
  - The invariant handlers model the per-account cap, limit scheduling and acceptance, proposal expiry, and (escape suite) owner recovery, with a new invariant `invariant_recoveryNeverTakesClaimableFunds`.
  - Exact-shape `toEqual` checks of pending proposals now include `expiresAt`.

## fixer (server+house): money-correctness and console-conformance fixes MC-1…MC-4, CC-06, CC-15 (apps/house-server, docker/live) — 2026-09-27

Regression tests: `test/restart-guard.test.ts` (MC-1), `test/app-restart.anvil.test.ts` (MC-1 on the real vault, needs `MAYA_APP_ANVIL_URL`), `test/treasury-safety.test.ts` (MC-2, MC-3, CC-06, CC-15), `test/journal-durability.test.ts` and `test/withdrawals-chain.test.ts` (MC-4). The 21 regression tests fail on a rebuilt copy of the pre-fix source (it typechecks) and pass after the fix. Three of them fail on the pre-fix copy only because they call new helpers (`resolveRunId`, `chainCursorDir`, `main`'s handle). The anvil test was run on the pre-fix copy with the old shared cursor directory. The two MC-1 control cases (same-run resume, explicit override) pass both before and after. These notes supersede earlier house-server notes where they conflict.

- **fixer (server+house) / MC-1 restarts resume their run.**
  - Without `MAYA_RUN_ID`, `main.ts` opens the run recorded in `<MAYA_DATA_DIR>/active-run-<network>.json`, else a new one. The file is `{ version: 1, network, runId, sinceMs }`, written atomically.
  - The chosen run id is recorded before the journal opens, whether it came from the env, the file or a new id.
  - An unreadable file is an error: the server never guesses a new run.
  - So a compose restart (persistent `/data`, no run id) resumes the journal that owns the player balances.
  - To start a fresh run on purpose, set `MAYA_RUN_ID` to a new id.
  - Behaviour change for local offline replays: a restart now resumes the previous replay instead of starting a new one.
- **fixer (server+house) / MC-1 fresh-ledger guard.**
  - `HouseApp.start()` checks the vault before it subscribes to chain events.
  - It throws `FreshLedgerError` when the journal has no ledger history (no `deposit`, `withdrawal`, `treasury`, `treasury-pending`, `attest` or `voucher` record) and either:
    - the vault has player history (`FRESH_LEDGER_ON_VAULT_HISTORY`): player deposits or withdrawals above 0, an attestation, or escape mode;
    - or the vault cannot be read (`FRESH_LEDGER_UNVERIFIED`).
  - A refused start journals only its boot records, so a retry under the same run id is refused again. It stops the chain adapter, and `main` exits 1 with the reason.
  - `MAYA_ALLOW_FRESH_LEDGER=1` (`AppOptions.allowFreshLedger`) overrides the guard for a deliberate rebuild from chain events. The known hazard of the server-wiring note applies: earlier redemptions are booked `unmatched`.
- **fixer (server+house) / MC-1 indexer cursor per run.**
  - `main.ts` passes `LiveChain` the directory `<dataDir>/runs/<runId>` (`bootstrap.chainCursorDir`). The cursor file becomes `runs/<runId>/chain-cursor-<chainId>.json`, so a new journal always rescans from the deployment block.
  - With the journal off, the cursor stays in memory (null).
  - An existing `<dataDir>/chain-cursor-<chainId>.json` is no longer read, so the first start after this change rescans once. Crediting is idempotent, so nothing is applied twice.
  - `src/chain` is unchanged.
- **fixer (server+house) / MC-1 reconciliation alert.**
  - The chain health check (every 60 s) now reads the vault fresh and computes `reconcile()`.
  - A mismatch raises critical `LEDGER_VAULT_MISMATCH` on SSE `alert`, in `overview.chainAlerts` and in `/admin-api/chain.alerts`. `LEDGER_VAULT_MISMATCH_RESOLVED` follows when the ledger matches again.
  - On live chains the mismatch must persist over two consecutive checks, because a vault read runs ahead of the indexer's confirmations. On the offline chain one check is enough.
  - A vault with continuous flows can still show a transient mismatch; that alert then resolves on its own.
- **fixer (server+house) / MC-2, MC-3 pending treasury operations.** `fund` and `withdraw-surplus` are journaled as a pending operation before the first await. New journal events:
  - `treasury-pending {opId: T<n>, action, amountCenti, actor}`;
  - `treasury-unknown {opId, txHash?, reason}`;
  - `treasury-released {opId, reason, actor}`;
  - `treasury` gains optional `opId` and `resolution: receipt | vault-state`.

  Rules:
  - At most one operation is pending.
  - A pending surplus withdrawal is **reserved**. `riskEquity()` = `equity()` − reserved, and it drives acceptance limits, solvency, grid headroom, `limitUsage` and `limitAmounts`. `freeOnchainEquity()` = `house:equity` − reserved − open on-chain liability.
  - Breakers keep `equity()`; the withdrawal reaches them as a treasury flow once booked.
  - `invariants().equityNonNegative` subtracts the reservation.
  - A refusal before sending (attestation failed, vault surplus or withdrawable exceeded) or a definite chain failure releases the operation.
  - An unknown outcome (`ChainError` code `TX_TIMEOUT`, or `TX_SEND_FAILED`, whose broadcast may have reached a node) keeps it pending and reserved.
  - Resolution compares the vault's `houseFunded − houseWithdrawn` with what the ledger booked (`houseNetBookedWei`):
    - exactly the pending flow unbooked → it is booked (`resolution: vault-state`, system audit by `treasury-resolver`, info alert `TREASURY_RESOLVED`);
    - nothing unbooked → it stays pending;
    - anything else → critical `TREASURY_UNRECONCILED` (it stays pending).
  - Resolution runs in the chain health check and before any new treasury action. That action answers 409 `TREASURY_OUTCOME_PENDING` (or `TREASURY_IN_PROGRESS`) while the operation stays pending.
  - A pending operation raises warning `TREASURY_OUTCOME_UNKNOWN`.
  - New endpoint `POST /admin-api/treasury/release-pending {opId}` (confirm `treasury-release`, reason required). It releases an operation only if a fresh vault read shows no unbooked house flow. A mined operation is booked instead (409 `TREASURY_ALREADY_MINED`); a mismatch answers 409 `TREASURY_UNRECONCILED`.
  - The pending operation is shown in `/admin-api/chain.treasury {pending, houseNetBookedWei}` and in `overview.treasuryPending`.
  - Treasury acks carry `opId`.
- **fixer (server+house) / CC-06 unknown outcomes on the admin API.**
  - Every chain-backed admin write whose call ends with `TX_TIMEOUT` or `TX_SEND_FAILED` answers 504 `CHAIN_OUTCOME_UNKNOWN`. This covers fund, withdraw-surplus, attest, vault pause/unpause, signer propose/accept/cancel and sweep-excess.
  - The response is `{ error: { code, message, txHash?, opId? } }`.
  - The audit result is `unknown: …`, with the tx hash.
  - Definite failures keep 502 `CHAIN_ERROR` and the audit result `failed: …`; they now also carry `txHash` when known.
  - The console already treats any 5xx as an unknown outcome (fixer (admin) CC-01), so 504 needs no console change. A same-key retry replays the stored 504 and sends nothing.
- **fixer (server+house) / CC-15 operator balances.** A failed operator balance read in `/admin-api/chain` is `operator: { address, ethWei: null, tokenCenti: null, unavailable: true, error }`, never zeros. **Console follow-up needed:** `apps/admin/src/decode.ts` (`decodeChain`) still requires `operator.tokenCenti`, so until it accepts this shape a balance-read failure makes the whole `/chain` decode fail instead of showing false zeros.
- **fixer (server+house) / MC-4 durable journal records.**
  - `JournalSink.append(record, durable?)`: `FileJournal` fsyncs a flush that carries a durable record before it returns. Other records keep the 1 s fsync window.
  - The engine decides durability before applying the record:
    - always durable: `deposit`, every `voucher*` event, `withdrawal`, `treasury*`, `attest`, `config`, `player-flag`, `breaker` and `sim`;
    - `audit` of kind admin;
    - `register`, `bet`, `hold`, `hold-resolved` and `settle` of on-chain accounts.
  - Feed samples, tables, controller steps, system audits and sim flow are not durable; they are the only tail an OS crash can cut.
  - Voucher nonces are now `uint256(first 31 bytes of sha256("maya-voucher-nonce:<runId>:<bootId>:<voucherId>"))`, replacing the formula in the server-wiring note. So a rebuilt ledger (a new boot) never re-issues a spent nonce for a reused voucher id.
  - The nonce is journaled, so rebuilds stay exact and old journals keep their nonces.
  - `voucherNonce(runId, voucherId)` without a boot id is still the Stage A formula.
- **fixer (server+house) / main() returns a handle.** `main(env, { signals?, log? })` returns `{ app, server, runId, stop() }`. It is used by the restart test; the CLI entry is unchanged.
  - When `start()` fails, main stops the app (closing the journal) and rethrows.
- **fixer (server+house) / open (outside this area, not changed).**
  1. `apps/admin`:
     - decode `operator.unavailable` with null balances (CC-15), and don't gate `fundPlan` or the low-gas warning on an unknown balance;
     - optionally surface `treasury.pending`, the `TREASURY_*` alerts and `release-pending`;
     - optionally add `CHAIN_OUTCOME_UNKNOWN` to `SERVER_UNKNOWN_OUTCOME_CODES` (5xx already covers it).
  2. `compose.live.yaml` (repo root) could pass `MAYA_RUN_ID` and `MAYA_ALLOW_FRESH_LEDGER` through from the host env. It is not required: the run id now persists in the house-data volume.
  3. `src/chain`: local anvil `receiptTimeoutMs` (30 s) equals the console's write timeout (30 s), so which one reports first is a race. `TX_SEND_FAILED` cannot tell a definite broadcast rejection from an unknown one, so the server treats it as unknown.
- **fixer (contracts+chain) / size note** (belongs to the contracts+chain section above; appended after a concurrent section). `forge build --sizes` now reports the `Deploy` *script* contract at 25,910 B runtime (it embeds the vault and token init code) and exits non-zero on EIP-170. The script is never deployed on chain. `forge script script/Deploy.s.sol` still runs (dry run checked with throwaway keys), and `Deploy.t.sol` passes. The vault itself is 16,925 B runtime (7,651 B margin); the SPEC-11 figure was 15,124 B.


## e2e verifier: full checks, local-chain end-to-end and final economic runs — 2026-09-26

Evidence: `artifacts/verification/e2e-local-2026-09-26/` (e2e-results.json: 196 checks by phase, HTTP and chain receipts; logs/; driver.mjs) and `artifacts/verification/house-sim-2026-09-26-final-p1|p2/`.

- **e2e verifier / MAYA_RPC_URL for the house server (integration fix).** `MAYA_NETWORK=local` always connected to anvil at 127.0.0.1:8545: `networkConfig('local')` ignores `MAYA_RPC_URL` by design (its test pins that), and `main.ts` passed no `rpcUrl` to `createChain`, so the server could not attach to an anvil on another port while the deploy CLI (`--rpc-url`) and the anvil tests (`MAYA_RPC_URL`) could. `config.ts` now reads an optional `MAYA_RPC_URL` (http(s) only, else a config error) into `ServerConfig.rpcUrl`, and `main.ts` → `bootstrap.loadLiveChain` passes it to `createChain` as an explicit `rpcUrl`. Omitted, behaviour is unchanged (network default). For base-sepolia this equals what `networkConfig` already did with the env var. The chain id is still verified (a wrong endpoint fails `CHAIN_ID_MISMATCH`). `run-sim --network local` still uses the default endpoint (unchanged). New test `test/config-rpc.test.ts`.
- **e2e verifier / observed, not changed: anvil time travel and the voucher sweep clock.** `HouseApp.tick` selects due vouchers with `chainNowS()` (the wall clock on live chains) and only then re-reads chain time. After `evm_increaseTime` a voucher issued before the jump is expired on chain at once but is only returned to the balance once the wall clock passes expiry + 600 s. This is conservative (it stays a liability, reconciliation stays exact); on Base Sepolia wall and block time agree. Measured in the e2e run: voucher V12 (issued before two 48 h jumps, expiry 1790453823) was released at 20:27:58Z wall, 55 s after expiry + 600 s, with its nonce unused on the vault, audited by `voucher-sweep`; reconciliation stayed exact (phase N in e2e-results.json).
- **e2e verifier / observed, not changed: failed attest attempts leave tree files.** An attest refused with `SIGNER_MISMATCH` still writes `attest-<seq>-<root>.json` before the transaction (as designed: written first, never served unless the vault holds that root), so two files can share a seq. Harmless, documented in the server-wiring note.

## wallet-engineer: Stage B player wallet game (SIWE sessions, chain config, pinned path, live game UI, dev test wallet) — 2026-09-27

Files: `apps/house-server/src/api/{auth,auth-rate,auth-routes,player-live,dev-wallet}.ts` (new), auth wiring in `src/api/player.ts`, additive lines in `src/api/{context,server}.ts`, `src/config.ts`, `src/main.ts`, `test/app-helpers.ts`; `packages/game-ui/src/presentation.ts` and `src/live/*` (new), presentation refactor of `src/index.ts`, `src/phone-controls.ts`, `src/feedback.ts`; `apps/demo/src/bootstrap-live.ts`, `src/live/*` (new), `apps/demo/vite.config.ts`. QA evidence: `artifacts/verification/wallet-game-2026-09-27/`.

- **wallet-engineer / sessions only where main.ts wires them.** `createHouseServer` enforces SIWE sessions when `ApiDeps.auth` is set, which `main.ts` always does. Without it (the embedded server of the Stage A tests) the player API behaves exactly as before, so every existing test keeps its assertions. `test/auth.test.ts` runs the same routes with `auth`.
- **wallet-engineer / SIWE rules.** `GET /v1/auth/nonce` → `{ nonce, expiresAtMs, domain, uri, chainId, version, statement }` (nonce single-use, 5 min). `POST /v1/auth/verify { message, signature }` accepts a message only when: domain = MAYA_PUBLIC_ORIGIN host, URI origin = MAYA_PUBLIC_ORIGIN, scheme (if present) matches, version 1, chain id = the house chain (the offline vault has chain id 0, so it signs in with the local chain id 31337), Issued At within [now − 5 min − 60 s, now + 60 s], Expiration Time in the future, Not Before not beyond 60 s. The nonce is consumed by every attempt that names it, failed ones included. Signatures go through viem `verifySiweMessage`: EOAs by ECDSA recovery (no node needed), contract wallets (ERC-1271/6492) through the chain RPC when there is one. A successful sign-in registers the player (`engine.register(account, 'sign-in')`).
- **wallet-engineer / cookie.** `maya_session`: 256-bit random token, `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`, plus `Secure` when MAYA_PUBLIC_ORIGIN is https. Only its SHA-256 is stored. The session lives 12 h from sign-in (absolute, not sliding). A new token is issued on every sign-in (the previous session of that browser ends) and by `GET /v1/session` once the token is 15 min old; the old token keeps working for 30 s so requests in flight do not fail. `POST /v1/auth/logout` ends every token of the sign-in. Sessions are in memory: a server restart signs everyone out (no money state depends on a session).
- **wallet-engineer / CSRF.** SameSite=Strict, plus a refusal (403 `ORIGIN_MISMATCH`) of state-changing session requests (verify, logout, bets, withdrawals, sign-in) whose `Origin` header names another origin. Requests without an Origin header (non-browser clients) are not refused on that ground.
- **wallet-engineer / account scope.** With sessions, the session's account is the only one a request can act for; a client-named account is never used for authorization:
  - `POST /v1/bets`: `account` may be omitted; if present it must equal the session account (403 `ACCOUNT_MISMATCH`, nothing placed).
  - `GET /v1/bets/by-request/:id`: another account's receipt answers 404, like an unknown id. Rejection receipts carry no account in the engine, so the API remembers which account sent each requestId (in memory, bounded to 100,000 like the engine's rejection memory).
  - `GET /v1/account/:address` and `GET /v1/account/:address/proof`: another address → 403. The proof route also accepts the admin bearer token (see open issues).
  - `POST /v1/withdrawals` and `GET /v1/withdrawals`: the session's account; a body/query account must match. MAYA_OPEN_PLAYER_API is no longer needed for them.
  - `GET /v1/quotes`: without `account` it stays public (the session account's grid is used when there is a session); `?account=` needs a matching session.
  - `POST /v1/sign-in`: confirms the session's account (SIWE already registered it).
  - No session → 401 `AUTH_REQUIRED`.
- **wallet-engineer / MAYA_OPEN_PLAYER_API=testnet-unsafe is now an explicit dev override.** Next to sessions it lets a request that carries no session act for the account it names on every account-scoped route (Stage A behaviour, e.g. for old drivers); a session still wins and a mismatch is still 403. Default off; main.ts logs a warning when it is on. Without sessions (embedded server) its old meaning (unauthenticated withdrawal routes) is unchanged.
- **wallet-engineer / rate limits.** Token buckets, per session (sid) or, before sign-in, per client IP: nonce 30/min, verify 20/min, session 120/min, bets 40 per 10 s, reads 300/min, withdrawals 20/min, dev wallet 600/min; 429 `RATE_LIMITED` with Retry-After. The IP is the socket peer: behind the compose nginx all players share the proxy's address (open issue).
- **wallet-engineer / session account for other routes.** `auth-routes.ts` exports `sessionAccountOf(ctx)` (the session account or undefined, never a client-named one). The promo engineer's `GET /v1/promo` uses it for `account`.
- **wallet-engineer / GET /v1/chain-config.** `{ network, chainId, chainName, testnet, walletSupported, rpcUrl, explorer, token { address, symbol: 'tOPEN', name, decimals: 18, mockOf: '$OPEN' }, vault, nativeCurrency, siwe { domain, uri, chainId } }`. `rpcUrl` is public by rule: MAYA_PUBLIC_RPC_URL (new, optional), else `https://sepolia.base.org` on base-sepolia (never MAYA_RPC_URL, which may carry an API key), else MAYA_RPC_URL or the anvil default on local. The offline vault answers `walletSupported: false`, `rpcUrl: null`.
- **wallet-engineer / GET /v1/path?market&fromMs.** The pinned first-seen samples (`{ t, sourceTimeMs, price (exact lexeme), sampleId, receivedAtMs }`) with `sourceTimeMs > fromMs`, at most the last 900 s (default 300 s without `fromMs`), plus `clockMs` and the feed `speed` so the client can extrapolate the house clock. Public, like the quotes.
- **wallet-engineer / dev test wallet.** `POST /v1/dev/wallet/{eth_accounts,eth_requestAccounts,personal_sign,eth_signTypedData_v4,eth_sendTransaction}` with `{ role?, params }`. It is mounted only when MAYA_DEV_TEST_WALLET=1 and MAYA_HOST=127.0.0.1 and MAYA_NETWORK=local; the flag with any other network or host is a config error (fail closed) rather than a silently absent route. It signs with `.secrets` player keys (MAYA_DEV_TEST_WALLET_ROLE, default player-1; `?testWallet=player-N` in the game URL picks another), through the viem accounts of `src/chain/secrets.ts`, so no key reaches the browser. Those keys also hold tOPEN on Base Sepolia, so the route refuses anything that could be valid elsewhere: non-loopback Host headers (DNS rebinding) and Origins, `personal_sign` of anything but this game's SIWE message on chain 31337, typed data for another chain id, transactions without a `to`, for another chain id, or from another account; transactions go only to the RPC whose chain id (31337) was checked at start. A transaction the node refuses answers 422 `DEV_WALLET_TX_FAILED`.
- **wallet-engineer / paper presentation pinned.** The board's paper strings moved into `packages/game-ui/src/presentation.ts` (`PAPER_PRESENTATION`) and are pinned by `tests/presentation.test.ts` against goldens generated from the git HEAD templates (`tests/paper-golden.ts`). In Chrome the old and new paper builds render the same `.maya` DOM (desktop and a 390 px frame, including stake, help, balance-panel and wallet-dialog interactions). The paper CSS and pricing-worker assets are byte-identical; the JS bundle differs only by the presentation parameters.
- **wallet-engineer / live UI lives in a subpath.** `@maya/game-ui/live` (new `exports` entry) holds `LiveShell`, `livePresentation` and `live.css`, so the paper bundle never includes them (verified: no live strings in the paper build). `MayaGame` gained only optional options (`presentation`, `onWallet`, `onWithdraw`, `inputBlocked`), an optional `GameViewState.pending`, and `resetPositions()` / `rejectAt()`; `FeedbackLayer` an optional money formatter and caption.
- **wallet-engineer / live build selection.** `apps/demo/vite.config.ts` returns the unchanged paper config unless VITE_MAYA_MODE=live; live mode rewrites index.html's entry to `src/bootstrap-live.ts` (plus title/description), proxies `/v1` to MAYA_HOUSE_URL (default http://127.0.0.1:8790) and defines `__MAYA_TEST_WALLET__`. The test wallet is a compile-time constant: the default live build contains none of it (checked by grepping the bundle), and a production build with VITE_MAYA_TEST_WALLET=1 fails; `vite build --mode development` (or the dev server) may include it for local QA. `apps/demo` got `viem` 2.56.9 (already in the lockfile) and a `test:unit` script.
- **wallet-engineer / live game rules.** Stakes 1, 5, 10, 25, 100 OPEN (the house minimum is 0.10); no play limit; the balance pill shows the available in-game balance. Positions are the account's server legs (`recentLegs`, the last 100). Every tap gets a fresh requestId; 202 shows "Confirming…" and follows `GET /v1/bets/by-request/:id`; a lost answer shows "Checking…" and reconciles the SAME requestId; "not placed" is concluded only once the house clock is 3.5 s past the quote's `validUntilMs` (a request arriving later would be refused as expired). Messages: QUOTE_CHANGED/QUOTE_EXPIRED/PRICE_MOVED → "Price moved — try again", INSUFFICIENT_BALANCE → "Not enough OPEN — deposit to play", etc. SIWE Issued At is taken from the house clock (nonce expiry − 5 min) so a skewed device clock cannot fail sign-in. Withdrawals use a new requestId per request; an unknown outcome sends the player to the list; a voucher is checked against the latest block time and never sent once expired. The shared `QuoteSnapshot` type requires `simulated: true`; live quotes set it only to satisfy the type (they are real house quotes; the UI never reads it).
- **wallet-engineer / open issues.**
  1. `apps/admin`: the escape-proof lookup calls `GET /v1/account/:address/proof` without credentials, which now answers 401 in production. The route accepts the admin bearer token; the console should send it there (or an `/admin-api` mirror should be added).
  2. `docker/live/game-nginx.conf` sets no `X-Forwarded-For`, and the server does not trust one: per-IP limits (nonce, verify) are per proxy behind nginx. A `MAYA_TRUST_PROXY` switch plus the header would make them per player.
  3. Sessions and the requestId owner map are in memory (a restart signs players out; by-request of a pre-restart rejection answers 404, as before for rejections).
  4. MetaMask itself was not driven in QA (only the dev test wallet); `wallet_addEthereumChain` was exercised only against the test wallet.
  5. Stage A `MAYA_OPEN_PLAYER_API` drivers keep working only with the override on.


## promo-engineer: SPEC-12 promo tiers replacing the single launch boost (packages/house, apps/house-server) — 2026-09-27

Design addendum: `docs/maya-live/SPEC-12-promo-tiers.md`; measurements: `artifacts/verification/promo-tiers-2026-09-27.md`. These supersede the SPEC.md §3.2 launch-boost rule and the Stage A `house / defaults` note on the launch edge where they conflict.

- **promo-engineer / production default and the legacy mode.** `bootstrap.engineConfig` passes `DEFAULT_PROMO` (the operator's table); `EngineConfig.promo` omitted keeps the legacy launch boost. The Stage A test helpers pin the legacy mode the same way the defenses engineer pinned `DEFENSES_OFF`: `test/helpers.ts makeEngine` passes no promo (unchanged file), `test/app-helpers.ts startTestApp` passes `promo: options.promo ?? null`, and the first `sim-e2e` test (the Stage A engine run, launch edge 3 %) passes `promo: null`. No assertion changed. `run-sim` and `defaultSimOptions` default to the promo tiers (`--promo legacy` for the old boost).
- **promo-engineer / migration of launch-boost journals.** A journal without a promo config opened by a server with promo tiers is migrated once at open: `config` (target `promo`) plus a system audit entry `promo-migrated` (actor `promo-migration`, before = the legacy launch config). Tier progress counts the journal's own players and turnover. A journal's own promo config always wins. `PUT /admin-api/launch` answers 409 `LAUNCH_REPLACED` in promo mode (explicit, fail closed, rather than silently mapping the old fields onto tiers); `overview.launch` stays, derived (edge = the current base edge, negative while boosted).
- **promo-engineer / `phase` keeps two values.** Legs, quotes and metrics keep `phase: 'launch' | 'standard'` for the console and old journals; with tiers `launch` means "priced at a promo tier's boosted odds". New fields carry the detail: `tier`, `boosted`, `guardAdjust` (legs, quotes), `variant` (quotes).
- **promo-engineer / signed offer.** `offerX100` still refuses negative edges (its test asserts it); promo pricing uses the new `offerX100Signed` (edge ≥ −0.5) and `adjustedEdgeSigned`. `QuoteGridInput.promo` switches a grid to tier pricing; an invalid promo input fails the grid closed (`model-incompatible`).
- **promo-engineer / per-account quotes.** Up to three grids per market-second: `main` (boosted while a tier is current), `standard` (`.s`, capped accounts) and `flagged` (`.f`). Quote ids differ per variant; acceptance only refuses (never re-prices): a boosted quote whose stake exceeds the account's remaining allowance in the quote's tier answers `STAKE_NOT_ALLOWED` (message names the allowance); remembered by requestId like every rejection. Held boosted stakes are reserved against the cap (`HoldRecord.boostTier`, journaled). A leg's tier is the quote's tier, even if the tier changed before acceptance.
- **promo-engineer / flagged accounts never get boosted odds** (not in the brief): they are quoted from the flagged grid (standard + surcharge) or, with no surcharge, the standard grid; a boosted quote from a flagged account is `QUOTE_CHANGED`.
- **promo-engineer / caps are per tier.** An account gets its launch allowance, then its growth allowance, then its scale allowance (the brief gives one cap per tier without saying whether they accumulate).
- **promo-engineer / per-tier accounting attribution.** Every leg belongs to the tier current when its quote was issued. The budget applies to *boosted* legs (the pricing the guard controls); "all legs" (incl. standard-priced legs of capped and flagged accounts) is reported next to it.
- **promo-engineer / controller target.** A boosted quote's `policyEdge` is the tier target (−lossBudget + widening) without the guard adjustment, so the clean-flow controller aims at `1 + lossBudget` and the guard alone accounts for the budget. Controller range adjustments apply to boosted and standard grids alike (they correct the model per multiplier range).
- **promo-engineer / budget guard beyond the brief.** (1) An acceptance-time signal (expected loss at p_fresh over accepted boosted legs) next to the realized one: scratch 3 h runs (3,000 players, 3 % farmers) showed the SPEC-10 hold selecting bets ~2 pts above the quoted model on near squares, which put a 42-minute launch tier at 16.3 % realized loss before the guard could see it in outcomes; with the signal the same run landed at 10.3 %. (2) Clustered statistics: the independent-legs SE was 0.5–1.1 % where realized deviated 8–20 pts per 15-minute block because the crowd shares square outcomes; the guard and every reported interval now use max(independent, clustered by square, empirical by market-minute block), measured 1.8–2× larger. (3) Relax only while the realized loss rate is not above the budget even as a point estimate. Defaults: evaluation every 5 min, 20,000 OPEN minimum turnover per signal, 1 pt per step, adjustment 0–10 pts, breaker at 2 % of turnover + 3 SD.
- **promo-engineer / hidden squares.** Measured with the current tables and the 4 s minimum lead: 0.00–0.05 % of priced squares are hidden by the launch floor (the brief expected ~0.2 %); the calibrated probabilities top out near 0.8 at τ ≥ 4 s.
- **promo-engineer / farmer strategy.** Added apart from `STRATEGIES` (`PROMO_STRATEGIES`, `ALL_STRATEGIES`) so the SPEC-10 test that `STRATEGIES` = honest + adversarial holds unchanged; weight 0 in `DEFAULT_MIX` (the promo runs use `--mix '{"farmer":0.01}'`). The crowd draws strategies from the mix without zero weights (same draws as before for every existing mix).
- **promo-engineer / reproducing SPEC-10.** `run-ablation` spawns `run-sim`, which now defaults to the promo tiers; reproduce the SPEC-10 ablation with `run-ablation ... -- --promo legacy`.
- **promo-engineer / kept runs.** Three 24 h runs on a frozen build (`apps/house-server/data/promofinal`, source hash `3646c31a416a0bec`); the only later source change is `HouseEngine.promoBreakers()` (overview lists a budget breaker only for the tier being priced; not used by `run-sim`). Results: 4 of 9 tier point estimates within budget, 5 above but inside their 95 % intervals, no interval above its budget, minimum-win floors respected, no account over its cap, reconciliation exact.
- **promo-engineer / leg dump.** `run-sim --dump-legs` appends `tier,boosted,account,placedMs,bandIndex` columns (existing columns unchanged).
- **promo-engineer / open (outside this role).**
  1. `apps/admin`: no promo page yet; its Launch control now receives 409 `LAUNCH_REPLACED`; it should read `GET /admin-api/promo` and `overview.promo`, write `PUT /admin-api/promo`, `POST /promo/end-tier` (confirm `promo-end-tier`) and `/promo/resume` (confirm `promo-resume`), and show the `promoBudget` breaker row.
  2. Game UI: consume `GET /v1/promo` and the `/v1/quotes` promo fields (`pricing`, `boostRemainingCenti`, `minWinX100`); a boosted stake above the allowance answers `STAKE_NOT_ALLOWED`.
  3. SPEC-10 controller: its standard error assumes independent legs; with a crowd on the same squares it under-states uncertainty the same way the promo guard's did (not changed here).
  4. The trust ramp's tight tolerance selects calm seconds for near squares, which a farmer on fresh accounts exploits; a volatility-conditioned fair value at re-validation (SPEC-10 §9.2) would remove it.
