# Maya-Live build spec — $OPEN as the house (testnet)

Status: authoritative build contract for Stage A (2026-09-26). Every component below codes against this file. If you must deviate, record the deviation in `docs/maya-live/DEVIATIONS.md` with the reason; never silently diverge.

## 0. What we are building

Maya is a tap-trading game. A player taps a **square**: a price band (BTC/USD $10 high, ETH/USD $0.50 high) × a 5-second future window. It **wins** if the recorded first-seen 1 s price path touches the band during the half-open window `[start, end)` (rule `maya-observed-linear-v2`, exact implementation `packages/contracts/src/path-touch.ts`). A win credits `stake × multiplier` (gross, includes stake). A loss credits nothing.

**Maya-Live is operated by $OPEN.** The `$OPEN operator` wallet owns the contracts, funds the house bankroll, and is the counterparty to every bet. All money is denominated in **OPEN** (ERC-20, 18 decimals). On testnet a mock token `tOPEN` ("Test OPEN (Maya-Live mock)") stands in for the real $OPEN (OpenLedger `0xA227Cc36938f0c9E09CE0e64dfab226cad739447` on Ethereum mainnet, which cannot be minted on testnet). Never label the mock as the real token.

Target network: **Base Sepolia** (chainId 84532, public RPC `https://sepolia.base.org`). Local development/tests: **anvil** (chainId 31337) via Docker image `ghcr.io/foundry-rs/foundry:stable`.

Bets are **off-chain** in the house server ledger (5-second bets cannot wait for blocks). Only token funding, deposits, withdrawals, liability attestations and house-surplus withdrawals are on-chain.

## 1. Invariants (non-negotiable; carried over from Maya)

1. Money is exact integers. Ledger unit = **centi-OPEN** (`Centi`, decimal string of an integer, 1 Centi = 0.01 OPEN = 10^16 wei). Never floats for money. Conversions wei↔Centi are exact; deposits that are not a multiple of 10^16 wei credit the floor and keep the remainder as `dust` (reported, not lost).
2. A quote is immutable once issued: `quoteId`, `revision`, cell terms, `x100` multiplier, `validUntilMs`. Acceptance resolves the server's stored quote; clients never send odds.
3. Acceptance is idempotent by `requestId`. Same intent → same result; changed intent with same id → `REQUEST_CONFLICT`. Never auto-retry with a new id; a timeout is not a rejection.
4. Each accepted tap is one immutable leg. Settlement uses the exact `@maya/contracts` touch functions on the pinned first-seen path. Missing evidence → refund per the recovery deadline, never invented prices.
5. Fail closed: stale feed, uncertain clock, unknown table cell, breaker tripped → no quote / rejection with a typed reason.
6. Solvency: at every acceptance, `houseEquity ≥ Σ over open legs (payout − stake)` and the risk limits in §4 hold. On-chain vault assets ≥ player balances + outstanding vouchers + open max payouts (attested).
7. Secrets: `.secrets/testnet-wallets.json` holds testnet keys (gitignored). Never print, log or commit private keys; print addresses only.

## 2. Units and constants (`packages/house/src/units.ts`)

- `CENTI_WEI = 10n ** 16n`; `toWei(centi: string): bigint`; `fromWei(wei: bigint): { centi: string; dustWei: bigint }`.
- `formatOpen(centi)` → e.g. `"1,234.56 OPEN"`.
- Multipliers are integers ×100 (`x100`, 101 = 1.01×). `payoutCenti(stakeCenti, x100) = floor(stake × x100 / 100)`.

## 3. Pricing (`packages/house`)

### 3.1 Calibrated table `maya-calibrated-v3`
JSON files `packages/house/data/maya-calibrated-v3-<market>.json`, produced by `tooling/calibrate/fit.mjs` (read it; it is the reference implementation). Fields: `tauMin 3, tauMax 32, bMax 3, sigmaBins 12, fracBins 5, prior 10`, `sigmaEdges[11]`, `counts {h0,n0,h1,n1,h2,n2}`, `golden[]`, `pricing`, `bandHeight`, `sigmaMode: 'h10'`.

Features for a quote instant `t` (integer seconds, latest first-seen price `spot`):
- `sigma = h10(t)`: RMS of `ln(P(t') / P(t'−10))` over available `t' ∈ (t−600, t]` (need ≥ 30 pairs), divided by √10. Fallback when insufficient: the 16 s EWMA of 1 s log returns (λ 0.94, `packages/pricing/src/model.ts` `ewmaSigma`).
- `s = sigma × spot / bandHeight`; `bucket = floor(spot / bandHeight)`; `frac = spot / bandHeight − bucket`.
- Window grid: `start0 = ceil((t + 3) / 5) × 5`; window `w ∈ 0..5` covers `[start0 + 5w, start0 + 5w + 5)`; `tau = start0 + 5w − t`. Band offset `b ∈ −3..3` covers `[(bucket+b)·h, (bucket+b+1)·h]`.
- Key: reflect `b<0` → `bAbs = |b|`, `frac' = 1 − frac`; `key = ((((tau−3)·4 + bAbs)·12 + sigmaBin(s))·5) + min(4, floor(frac'·5))`; `sigmaBin` = number of `sigmaEdges` ≤ s.
- Smoothing (hierarchical prior, then monotone non-increasing in `bAbs`, then std error) exactly as `smooth()` in `fit.mjs`. Must reproduce every `golden[]` row (`key`, `p`, `se`, `x100` at the table's `pricing`) to 1e-9.

### 3.2 Offer
`q = min(1, p + z·se + impact)`; `x100 = floor(100·(1 − edge) / q)`; if `x100 < minX100 (101)` → not offered; if `x100 > capX100 (5000)` → hidden (`aboveCap: 'hide'`) or capped (`'cap'`).
- `impact = impactK × cellLiabilityCenti / (cellFraction × equityCenti)` (price impact: crowded cells pay less on the next quote; each issued quote stays firm).
- `edge` = `launch.edge` (default **0.03**) while `registeredPlayers < launch.untilPlayers` (default **10,000**) and `launch.enabled`; else `edge.standard` (default **0.08**). Admin can end the boost early, extend it, or change the threshold; every change is journaled with actor and time.
- Optional per-account flow surcharge `flowEdge` (default 0, admin-tunable) for accounts flagged by the toxicity monitor.

### 3.3 Rolling refit
`refitTable(path, options)` builds a new table from the server's own recorded path over the trailing `trainHours` (default 36) using the same algorithm as `fit.mjs` (synthetic quote instants every second, labels via the touch rule). The server refits every `refitHours` (default 6) or on admin command, publishes the new table id, and keeps the previous one for already-issued quotes. Refit never changes an issued quote.

## 4. Risk (`packages/house/src/risk.ts`)

`LiabilityBook` tracks open liability `L = payout − stake` (Centi, bigint internally) per cell, per column (`market:start`), per account, and global. Limits are fractions of live house equity `E` (Centi):
- per cell `cellFraction` 0.001, per column `columnFraction` 0.005, global `globalFraction` 0.02, per account `accountFraction` 0.002.
- `canAccept(leg, E)` → `ok | 'LIABILITY_LIMIT' (which limit)`; `apply`, `release(on settle)`.
Breakers (state machine, all journaled): `feedStale` (no fresh price for > 7 s → pause quoting for that market), `drawdown` (1 h equity drop > 2% → widen edge +2 pts; > 5% → pause all), `equityFloor` (E < floor → quote nothing), `manual` (admin pause per market or global). Resume from drawdown/manual is admin-only.

## 5. Contracts (`contracts/`, Foundry, OpenZeppelin v5.6.1 submodule)

`MockOpenToken` — ERC20 "Test OPEN (Maya-Live mock)", symbol `tOPEN`, 18 decimals, fixed supply 1,000,000,000 minted to the deployer ($OPEN operator). Test-only; no admin mint after deploy.

`MayaHouseVault` — `Ownable2Step` (owner = $OPEN operator), `Pausable`, `ReentrancyGuard`, `EIP712("MayaHouseVault","1")`, `SafeERC20`. Internal accounting only (never raw `balanceOf` for math):
- `token` (immutable), `ledgerSigner` (server key; distinct from owner).
- `deposit(uint256 amount)` — measures received; `totalPlayerDeposits += received`; `emit Deposited(address indexed player, uint256 amount, uint256 indexed depositId)`.
- `fundHouse(uint256 amount)` onlyOwner — `houseFunded += received`; `emit HouseFunded`.
- `withdraw(uint256 amount, uint256 nonce, uint256 expiry, bytes sig)` — EIP-712 `Withdrawal(address account,uint256 amount,uint256 nonce,uint256 expiry)` signed by `ledgerSigner`, `account = msg.sender`; checks expiry, unused nonce (per account), `amount ≤ maxVoucherAmount`, daily outflow cap (UTC day), `whenNotPaused`, CEI, `nonReentrant`; `emit Withdrawn(player, amount, nonce)`.
- `attest(uint256 liabilities, bytes32 ledgerRoot, uint64 asOf, uint64 seq)` — only `ledgerSigner`; `seq` strictly increasing; `asOf ≤ block.timestamp`; stores snapshot `assetsAtAttest` and resets `depositsSinceAttest`, `claimedSinceAttest`. `liabilities` = player balances + outstanding vouchers + open max payouts.
- `houseSurplus()` view = `assets − (liabilities + depositsSinceAttest − claimedSinceAttest)` floored at 0, where `assets = totalPlayerDeposits + houseFunded − totalPlayerWithdrawals − houseWithdrawn`.
- `withdrawHouse(uint256 amount, address to)` onlyOwner — requires attestation age ≤ `maxAttestationAge` (default 1 h) and `amount ≤ houseSurplus()`.
- Owner admin: `pause/unpause`, `setLedgerSigner`, `setLimits(maxVoucherAmount, dailyOutflowCap, maxAttestationAge)`. All emit events.
- Tests: unit (every revert path), fuzz (amounts, nonces), invariant (`token.balanceOf(vault) ≥ assets`, `assets` identity, no nonce reuse, surplus never lets owner take player liabilities). Script `script/Deploy.s.sol` deploys token + vault, sets signer, funds house; writes addresses to `contracts/deployments/<chainId>.json`.

Build/test commands (Git Bash; the repo is mounted whole so the submodule resolves):
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo>:/repo" -w /repo/contracts --entrypoint sh ghcr.io/foundry-rs/foundry:stable -c "forge build && forge test -vv"
```

## 6. House server (`apps/house-server`, Node 24, TypeScript → `dist/`)

Single process, in-memory state with an append-only JSONL journal (`data/journal-<runId>.jsonl`) that can rebuild state on restart. Modules:
- `feed/` — `ReplayFeed` (market-log gz CSVs from `../market-data`, speed multiplier, start offset) and `LiveFeed` (polls the existing relay `/api/prices/1|2`, or Pyth Hermes later). Emits first-seen 1 s samples per market. Server clock = feed clock in replay mode.
- `quotes/` — per market, per new second: quote grid (6 windows × 7 bands) using §3; stores immutable quotes (TTL 1800 ms, minimum lead 3 s).
- `ledger/` — accounts (`player:<address>`, `house:equity`, `house:escrow`), double-entry entries, positions, receipts. Registered players count = distinct accounts with a first deposit or sign-in.
- `engine/` — `placeBet(intent)` (§1 invariants, §4 limits, price-move guard: reject if spot moved > `guardSigma × sigma × spot × √age` since quote), `tick()` settlement with exact touch functions and refunds.
- `chain/` — viem; network `local | base-sepolia`; reads `contracts/deployments/<chainId>.json` and ABIs from `contracts/out/`; deposit indexer (idempotent by `txHash:logIndex`, confirmations 2 on Base Sepolia, 0 on anvil); voucher signer (EIP-712, ledger-signer key from `.secrets`); periodic `attest` (every 10 min and on demand); operator actions (fund house, withdraw surplus) only via admin API.
- `sim/` — crowd simulator. Synthetic players arrive over the run (default target 12,000 players, so the 10,000-player launch boost ends mid-run) with strategies: `casual` (random nearby squares, small stakes), `chaser` (far squares), `grinder` (lowest odds, repeated), `streaker` (bets harder after wins), `sniper` (sees price 1 s early — adversarial), `whale` (large stakes). Synthetic players are funded by **off-chain sim credits** labelled `sim-credit` (never mixed with on-chain player funds; reported separately). The 11 on-chain testnet players (`player-1..11`) deposit real tOPEN on-chain and bet through the same engine.
- `api/player` — `POST /v1/bets`, `GET /v1/bets/by-request/:id`, `GET /v1/quotes?market=`, `GET /v1/account/:address` (Stage B adds SIWE).
- `api/admin` — under `/admin-api`, bearer token read from `.secrets/admin-token` (generated on first start; log only the file path, never the token). JSON only. See §7.

Config: `MAYA_NETWORK=local|base-sepolia`, `MAYA_FEED=replay|live`, `MAYA_REPLAY_SPEED` (default 20), `MAYA_REPLAY_FROM` (ISO), `MAYA_SIM_PLAYERS` (default 12000), `MAYA_ADMIN_PORT` 8790, `MAYA_DATA_DIR`.

## 7. Admin API (contract between server and panel)

All responses JSON; amounts are `Centi` strings; times are ms epoch; errors `{ error: { code, message } }`.

Read:
- `GET /admin-api/overview` → `{ network, chainId, operator, vault, token, feedMode, speed, clockMs, equityCenti, playerBalancesCenti, openLiabilityCenti, limitUsage: { global, maxColumn, maxCell }, registeredPlayers, activePlayers5m, launch: { enabled, active, edge, untilPlayers, standardEdge }, breakers: [{ id, market?, state, since, reason }], markets: [{ id, enabled, paused, lastPriceMs, spot, sigma, tableId }], handle24hCenti, ggr24hCenti, rtp24h, betsPerMin }`
- `GET /admin-api/metrics?from&to&step` → time series `{ t[], equity[], ggr[], handle[], rtp[], openLiability[], players[], betsPerMin[] }`
- `GET /admin-api/rtp` → RTP by multiplier range (`1.01-2, 2-5, 5-10, 10-20, 20-50`), by market, by phase (launch vs standard), expected vs realized, with bet counts
- `GET /admin-api/exposure?market=` → current grid `{ windows[], bands[], cells: [{ start, bandIndex, x100, liabilityCenti, limitCenti, legs }] }` (a heatmap)
- `GET /admin-api/players?sort&limit&cursor&q` → `{ rows: [{ account, kind: 'onchain'|'sim', strategy?, balanceCenti, handleCenti, pnlCenti, bets, rtp, flagged, blocked, firstSeenMs }] }`; `GET /admin-api/players/:account` (bets, deposits, withdrawals, flags)
- `GET /admin-api/bets?limit&cursor&account&market&status` → recent legs
- `GET /admin-api/chain` → vault on-chain state (assets, houseFunded, deposits, withdrawals, last attestation, surplus, paused, caps), operator balances (ETH, tOPEN), pending vouchers, indexer lag
- `GET /admin-api/audit?limit` → journal of admin actions and breaker transitions
- `GET /admin-api/stream` → **SSE**: `overview` every 1 s, `bet` (sampled ≤ 20/s), `settlement`, `breaker`, `admin-action`, `alert`

Write (every action journaled with actor, before/after, reason text required):
- `POST /admin-api/markets/:id/pause|resume`, `POST /admin-api/pause-all|resume-all`
- `PUT /admin-api/pricing` `{ standardEdge?, capX100?, aboveCap?, impactK?, z? }` (validated ranges: edge 0.01–0.25, cap 200–10000)
- `PUT /admin-api/launch` `{ enabled?, edge?, untilPlayers? }`
- `PUT /admin-api/limits` `{ cellFraction?, columnFraction?, globalFraction?, accountFraction?, maxStakePerBetCenti?, maxStakePerCellCenti? }`
- `POST /admin-api/refit` (start a refit now; returns job id; progress via SSE)
- `POST /admin-api/players/:account/flag|unflag|block|unblock`
- `POST /admin-api/treasury/fund` `{ amountCenti }` (operator → vault `fundHouse`), `POST /admin-api/treasury/withdraw-surplus` `{ amountCenti }`, `POST /admin-api/treasury/attest`
- `POST /admin-api/vault/pause|unpause`
- `POST /admin-api/sim` `{ running?, speed?, arrivalsPerMin? }` (simulation controls; hidden when `MAYA_FEED=live`)
Dangerous actions (pause-all, vault pause, withdraw-surplus, edge change > 2 pts) require `confirm: "<exact action name>"` in the body.

## 8. Admin panel (`apps/admin`, Vite + TypeScript, no framework; uPlot for time series)

"The house console." Must make monitoring and managing the game fast and obvious:
1. **Overview** — health strip (feed, chain, breakers, launch boost progress bar "7,412 / 10,000 players"), KPI tiles (equity, GGR 24 h, handle, realized RTP vs target, open liability vs limit, players, bets/min), equity + GGR chart, live bet ticker.
2. **Odds & RTP** — realized vs target RTP by multiplier range and phase (bars with target band), calibration drift, current table id + "Refit now".
3. **Exposure** — live heatmap of the quote grid per market (liability as % of cell limit), column totals, global gauge; click a cell for its legs.
4. **Players** — searchable, sortable table (on-chain vs sim), flags, block/unblock, drill-down with bet history and P&L.
5. **Controls** — pricing (standard edge, cap, impact), launch boost (enable, edge, threshold), limits, market pause/resume, pause-all; each change shows before → after, requires a reason, and dangerous ones require typed confirmation.
6. **Treasury & chain** — vault state, operator balances, surplus, attest, fund house, withdraw surplus, vault pause, pending vouchers, indexer lag, explorer links (`https://sepolia.basescan.org/address/<addr>`).
7. **Audit log** — every admin action and breaker transition.
Design: dark and light themes (tokens on `:root`), keyboard shortcuts (g o/r/e/p/c/t/a to switch pages, `/` search), responsive down to 1024 px, accessible (labels, focus rings, contrast AA), no layout shift on live updates, charts follow the `dataviz` skill (load it before writing chart code). Token entry: paste admin token once; stored in `sessionStorage` only. A `?demo` mode renders from a bundled fixture so the panel can be reviewed without a server.

## 9. Simulation outputs

`artifacts/verification/house-sim-<date>-<name>/`: `report.json`, `report.md` (phase split: launch vs standard; house P&L in OPEN and USD at a stated reference price; RTP by range; max drawdown; limit usage; breaker events; per-strategy player outcomes incl. sniper), on-chain receipts (tx hashes, block numbers, explorer links), final reconciliation (vault on-chain vs ledger: must match exactly; list any dust).
