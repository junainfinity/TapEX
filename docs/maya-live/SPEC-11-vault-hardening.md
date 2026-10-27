# SPEC-11 — MayaHouseVault hardening (addendum to SPEC §5 and §6 `chain/`)

Status: implemented by the vault-engineer on 2026-09-26 on top of Stage A (HEAD 881d3e8). Everything in SPEC §5 still holds unless this file says otherwise; deviations and small decisions are also listed in `DEVIATIONS.md` under `vault-engineer`.

Files: `contracts/src/MayaHouseVault.sol`, `contracts/src/interfaces/IMayaHouseVault.sol`, `contracts/script/Deploy.s.sol`, `contracts/test/**`, `apps/house-server/src/chain-port.ts`, `apps/house-server/src/offline-chain.ts`, `apps/house-server/src/chain/{merkle,indexer,live-chain,deploy,deploy-cli,attestation,tx,errors,index,abi}.ts`, `apps/house-server/test/chain/**`.

## 1. Constructor and defaults

`MayaHouseVault(IERC20 token, address ledgerSigner, uint256 escapeDelay)` — `escapeDelay` is immutable, 3 days ≤ `escapeDelay` ≤ 90 days (`InvalidEscapeDelay`), deploy default 7 days (`DEFAULT_ESCAPE_DELAY`). Owner = deployer; signer ≠ deployer (unchanged).

| Parameter | Default | Bounds | How it changes |
|---|---|---|---|
| `maxVoucherAmount` | 100,000 tOPEN | > 0, ≤ `dailyOutflowCap` | `setLimits`, instant (unchanged) |
| `dailyOutflowCap` (players) | 1,000,000 tOPEN / UTC day | ≥ `maxVoucherAmount` | `setLimits`, instant (unchanged) |
| `maxAttestationAge` | **10 min** (was 1 h) | 1 s .. **1 day** (was 7 days) | `setLimits`, instant |
| `signerChangeDelay` | 48 h | 1 h .. 30 days and **< `escapeDelay`** | increase instant; decrease timelocked |
| `houseBufferBps` | 1,000 (10 %) | 0 .. 10,000 | tighten (raise) instant; loosen timelocked |
| `houseDailyCap` | 10,000,000 tOPEN / UTC day | > 0 | tighten (lower) instant; loosen timelocked |
| `escapeDelay` | 7 days | 3 .. 90 days | immutable |

The constructor emits `LedgerSignerUpdated(0, signer)`, `LimitsUpdated`, `SignerChangeDelayUpdated(0, 48 h)` and `HouseLimitsUpdated(1000, 10M)`. Runtime size 15,124 bytes (limit 24,576).

## 2. Ledger-signer rotation (timelocked)

`setLedgerSigner` is removed. All owner-only:

- `proposeLedgerSigner(addr)` — reverts `ZeroAddress`, `SignerIsOwner` (owner or pending owner), `SignerUnchanged` (already the signer). Stores `pendingLedgerSigner`, `pendingLedgerSignerEta = block.timestamp + signerChangeDelay`; emits `LedgerSignerProposed(current, proposed, eta)`. A new proposal replaces a pending one and restarts the clock. The eta is fixed at proposal time (a later delay change does not move it).
- `acceptLedgerSigner()` — reverts `NoPendingLedgerSigner`, `TimelockNotElapsed(eta, now)` while `now < eta`. Emits `LedgerSignerUpdated(previous, next)`.
- `cancelLedgerSigner()` — reverts `NoPendingLedgerSigner`; emits `LedgerSignerProposalCancelled(proposed)`.
- Signer ≠ owner stays invariant: `proposeLedgerSigner` rejects the owner and the pending owner, `transferOwnership` rejects the signer and the pending signer (address(0), i.e. cancelling a transfer, stays allowed), `renounceOwnership` reverts.
- As in Stage A, a rotation invalidates every outstanding voucher (signature no longer recovers to the signer) and the current attestation for house withdrawals (`AttestationBySupersededSigner`). Rotating back to the same key re-validates unexpired vouchers.

## 3. Signer-change delay

`setSignerChangeDelay(d)` — `InvalidSignerChangeDelay` unless 1 h ≤ d ≤ 30 days and d < `escapeDelay` (a lost signer key can always be replaced before players can force escape mode). If `d ≥ signerChangeDelay` it applies at once (`SignerChangeDelayUpdated(old, new)`); otherwise it is scheduled at `now + current delay` (`SignerChangeDelayProposed(d, eta)`) and applied by `acceptSignerChangeDelay()` after the eta (`TimelockNotElapsed`, `NoPendingSignerChangeDelay`). `cancelSignerChangeDelay()` drops it (`SignerChangeDelayProposalCancelled`). Any `setSignerChangeDelay` call first drops a pending decrease. So a rotation is always announced at least one old delay ahead: a decrease to 1 h accepted at t+48 h makes the next rotation acceptable at t+49 h at the earliest.

## 4. House withdrawals

`withdrawHouse(amount, to)` (owner, `nonReentrant`, `whenNotPaused`, not in escape mode) checks, in order: `ZeroAmount`, `ZeroAddress`, `InvalidRecipient` (the vault), `NoAttestation`, `AttestationBySupersededSigner`, `AttestationTooOld(age, maxAttestationAge)` with age = `block.timestamp − attestationAsOf`, then

- `ExceedsHouseSurplus(amount, surplus)` if `amount > houseSurplus()` — SPEC §5 surplus, unchanged: `assets − max(0, attestedLiabilities + depositsSinceAttest − claimedSinceAttest)`;
- `ExceedsHouseWithdrawable(amount, withdrawable)` if `amount > surplus − houseBuffer()` (floored at 0), with `houseBuffer() = ceil(requiredAssets() × houseBufferBps / 10,000)` — the buffer is a share of the attested obligations *including* deposits the attestation does not cover yet, rounded up;
- `HouseDailyCapExceeded(day, amount, remaining)` if the house's own UTC-day total would exceed `houseDailyCap` (`houseDailyOutflow(day)`; separate from the players' `dailyOutflow`).

After a successful call `assets ≥ requiredAssets + houseBuffer` (asserted by the invariant suite). Views: `houseBuffer()`, `houseWithdrawable() = min(surplus − buffer, remainingHouseDailyOutflow())` (freshness, pause and escape are not considered), `remainingHouseDailyOutflow()`, `houseDailyOutflow(day)`.

`setHouseLimits(bps, cap)` — `InvalidHouseLimits` unless bps ≤ 10,000 and cap > 0. If `bps ≥ houseBufferBps && cap ≤ houseDailyCap` (tightening or equal) it applies at once (`HouseLimitsUpdated`); anything else, including a mixed change, is scheduled `signerChangeDelay` ahead (`HouseLimitsProposed(bps, cap, eta)`), applied by `acceptHouseLimits()` after the eta, dropped by `cancelHouseLimits()`, replaced by any new call (`HouseLimitsProposalCancelled`).

## 5. `sweepExcess(address to)` (owner, `nonReentrant`)

Sends `excess() = token.balanceOf(vault) − assets()` (floored at 0) to `to`; reverts `ZeroAddress`, `InvalidRecipient` (the vault), `NothingToSweep`. Emits `ExcessSwept(to, amount)` and returns the amount. Accounted assets never change (`assets()` is internal accounting; the invariant suite asserts `balance = assets + unswept donations` and `excess() = unswept donations` across random runs). Works while paused and in escape mode (it can never reach the escape pool, which is part of `assets`). With a fee-on-transfer token the recipient bears the fee; the vault balance drops by exactly the excess.

## 6. Escape hatch

### 6.1 The root
`attest(liabilities, ledgerRoot, asOf, seq)` is unchanged, but `ledgerRoot` is now the OpenZeppelin `StandardMerkleTree` root of `(address account, uint256 balanceWei)` leaves: `leaf = keccak256(bytes.concat(keccak256(abi.encode(account, balanceWei))))`, leaves sorted, commutative inner hashing, verified with `MerkleProof.verifyCalldata`. `vault.balanceLeaf(account, balance)` exposes the leaf. `apps/house-server/src/chain/merkle.ts` builds it (`buildBalanceTree(entries) → { root, entries, proofFor(account), balanceOf(account) }`, `verifyBalanceProof`, `balanceLeaf`); it reproduces the OpenZeppelin merkle-tree README root `0xd4dee0be…3e90bd77` for its two-value example, and a five-entry vector is asserted identically by `test/chain/merkle.test.ts` and `contracts/test/BalanceTreeVectors.t.sol`. An empty entry list yields the zero root (no proof reaches it).

### 6.2 What the ledger must put in the leaves (contract for the core server)
- One leaf per account at most (duplicates are rejected by `buildBalanceTree`); value = what the ledger owes the account: its balance plus its unredeemed vouchers (issued and not yet seen as `Withdrawn`) plus whatever share of open legs the house decides to honour (recommended: open max payouts, so that Σ leaves + retained dust = the attested `liabilities`). Σ leaves must not exceed the `liabilities` of the same call.
- The ledger's view of on-chain flows must be exactly those mined at timestamp ≤ `asOf`: every `Deposited` credited and every `Withdrawn` applied up to the indexer watermark. `LiveChain.attest` already clamps `asOf` to the watermark block's timestamp and refuses (`INDEXER_UNDELIVERED`) while indexed deposits, and — once an `onWithdrawn` listener is registered — withdrawals, are undelivered. Until the core server subscribes to `onWithdrawn` and nets redeemed vouchers, leaves may over-count vouchers redeemed at or before `asOf` (the pool below still bounds the total).

### 6.3 Triggering
`lastAttestationAt()` = block time of the latest attest transaction (`attestedAt`), or `deployedAt` before the first one; `escapeAvailableAt() = lastAttestationAt() + escapeDelay`. `triggerEscape()` — anyone, also while paused — reverts `EscapeNotYetAvailable(availableAt, now)` before that and `EscapeModeActive` once on. It freezes the latest root and `asOf` (attest reverts from then on), sets `escapePool = min(assets(), attestedLiabilities + depositsSinceAttest())` (saturating) and emits `EscapeModeActivated(caller, seq, root, asOf, pool)`. Escape mode is irreversible.

In escape mode `deposit`, `withdraw` (vouchers), `fundHouse`, `withdrawHouse` and `attest` revert `EscapeModeActive`. `pause/unpause`, rotation, limit setters and `sweepExcess` keep working (none of them can move accounted assets).

### 6.4 Claiming
`claimEscape(attestedBalance, proof)` (`nonReentrant`, works while paused; `EscapeModeInactive` before escape): if `attestedBalance ≠ 0` the proof must verify `balanceLeaf(msg.sender, attestedBalance)` against the frozen root (`InvalidProof`); 0 needs no proof. Then

`entitlement = max(0, attestedBalance + deposits(msg.sender, mined after asOf) − payouts(msg.sender, mined after asOf))`

where payouts are voucher withdrawals *and earlier escape claims* (per-account `Checkpoints.Trace208` by block timestamp; `escapeEntitlement(account, balance)` is the view). `NothingToClaim` if 0; `EscapePoolExhausted` if the pool is spent; otherwise it pays `min(entitlement, escapePool − escapeClaimedTotal)`, adds it to `totalPlayerWithdrawals` (so the `assets` identity and the admin console reconciliation still hold), to `escapeClaimedTotal`, `escapeClaimedBy(account)` and to the account's payouts, and emits `EscapeClaimed(account, paid, entitlement, attestedBalance)`. Because every payout is recorded after the cut, a second claim with any leaf is net of the first: no balance is ever paid twice, and a claim cut short by the pool leaves nothing claimable either (the pool cannot grow). Claims do not count against the daily outflow cap.

Before any attestation the root is zero, so only `attestedBalance = 0` is claimable: each account gets its net deposits (deposits − voucher withdrawals), and the pool is `min(assets, totalPlayerDeposits)`.

### 6.5 Cut timing (exactness)
Per-account flows are split at `asOf` strictly (`> asOf` belongs to the claim, `≤ asOf` to the leaf); the global `requiredAssets` keeps Stage A's rule (deposits `≥ asOf` stay owed). With the adapter's `asOf = watermark timestamp` this is exact on chains whose block timestamps strictly increase (Base Sepolia, Ethereum). Where two blocks can share a timestamp (anvil automine), a flow mined after the watermark in a block with the watermark's timestamp is misattributed: an unseen deposit is not added (the player under-claims) and an unseen withdrawal is not subtracted (the player over-claims, bounded by the pool). The anvil integration test advances time by 1 s around the root to avoid it.

## 7. Residual trust (what the hardening does and does not buy)

- **Ledger signer (server key)** is trusted for the correctness of `liabilities` and of the root. An understated attestation lets the owner withdraw player funds down to attested obligations + buffer (still per-day capped, still needs the owner); an overstated one only blocks house withdrawals. A wrong root misallocates escape claims first-come-first-served, but total claims never exceed `min(assets, attestedLiabilities + unattested deposits)`. The signer alone can sign vouchers up to `maxVoucherAmount` each, `dailyOutflowCap` per UTC day, and `assets` — the owner's response is `pause` plus a rotation (48 h). A signer that keeps attesting while refusing vouchers keeps the escape clock fresh: censorship is not covered by the escape hatch.
- **Owner ($OPEN operator)** alone cannot move accounted assets: `withdrawHouse` needs a fresh attestation from the current signer and keeps the buffer; `sweepExcess` only moves stray tokens; installing its own signer, loosening house limits or shortening the delay each needs `signerChangeDelay` (48 h) of on-chain notice. The owner can still pause (blocking deposits, vouchers and house withdrawals — not escape), tighten any limit instantly and raise the *player* limits instantly (`setLimits`, unchanged). **Owner + signer together (or the owner 48 h after proposing its own signer) can take all assets**: attest zero liabilities and withdraw up to `houseDailyCap` per day, and sign vouchers to itself up to player limits it can raise instantly. The timelocks turn an instant owner-key compromise into a ≥ 48 h publicly visible one (`LedgerSignerProposed`, `HouseLimitsProposed`, `SignerChangeDelayProposed`); they do not guarantee that players can exit in that window, because the owner can pause voucher withdrawals meanwhile.
- **Escape hatch** covers a dead house: no attestation for `escapeDelay` (immutable, 7 days default). It does not cover a live but hostile house (paused vault with continuing attestations). In escape mode the bankroll beyond the pool stays locked: there is no house withdrawal and no recovery path.
- **Staleness**: a house withdrawal may rely on an attestation up to `maxAttestationAge` (10 min) old; liabilities that grew since are covered only by the buffer (10 % of obligations) and the per-day cap.
- Token assumptions are unchanged: fee-on-transfer inflows are measured; rebasing tokens are unsupported.

## 8. Chain port and adapters (`apps/house-server`)

`ChainPort` (backward compatible; every existing method keeps its signature) gains:

```ts
onWithdrawn(listener: (w: ChainWithdrawal) => void): () => void;   // { player, amountWei, nonce, txHash, logIndex, blockNumber }, idempotent by `player:nonce`
nonceUsed(account: string, nonce: bigint): Promise<boolean>;
proposeLedgerSigner(address: string): Promise<ChainTx>;            // LiveChain returns { txHash, blockNumber, eta }
acceptLedgerSigner(): Promise<ChainTx>;
cancelLedgerSigner(): Promise<ChainTx>;
sweepExcess(to: string): Promise<ChainTx>;                         // LiveChain/OfflineChain also return amountWei
```

`VaultState` gains `ledgerSigner`, `pendingSigner: { address, eta } | null`, `signerChangeDelay`, `pendingSignerChangeDelay: { delay, eta } | null`, `maxAttestationAge`, `houseBufferBps`, `houseDailyCap` (wei), `pendingHouseLimits: { houseBufferBps, houseDailyCap, eta } | null`, `houseWithdrawableWei`, `excessWei`, `escape: { mode, lastAttestationAt, escapeDelay, availableAt, poolWei, claimedWei }` (all bigint seconds / wei). `surplusWei` keeps the SPEC §5 meaning; a server that withdraws surplus should bound itself by `houseWithdrawableWei`.

`VaultOperatorExtras` (implemented by `LiveChain` and `OfflineChain`, not on the port): `setSignerChangeDelay`, `acceptSignerChangeDelay`, `cancelSignerChangeDelay`, `setHouseLimits(bps, capWei)`, `acceptHouseLimits`, `cancelHouseLimits`, `triggerEscape(role?)`, `playerClaimEscape(role, attestedBalanceWei, proof)` (LiveChain returns `paidWei`), `escapeEntitlement(account, balanceWei)`.

- **Withdrawal indexing.** The deposit indexer reads `Deposited` and `Withdrawn` with one `eth_getLogs` per range (`DepositSource.vaultLogs`, topic0 OR-filter), with the same confirmations, re-read overlap, watermark hash check, orphan alerts, persistence and queue-until-first-listener behaviour as deposits. Withdrawal identity is `w:<player>:<nonce>` (the vault accepts each pair once ever), so a re-mined or re-submitted redemption is never delivered twice. The cursor is version 2 (`withdrawalsIndexed`, `pendingWithdrawals`); a version-1 cursor, or one written by a deposit-only source, is discarded and the chain rescanned (deposits are re-delivered once; the ledger credits idempotently). `indexerStatus()` adds `withdrawalsIndexed`, `withdrawalsDelivered`, `pendingWithdrawals`.
- **Fail closed after a rotation.** `acceptLedgerSigner` rewrites the deployment file's `ledgerSigner` (and `txs.acceptLedgerSigner`). The adapter only holds the ledger-signer key from `.secrets`, so once the recorded signer differs, `signWithdrawal` and `attest` throw `ChainError('SIGNER_MISMATCH')` instead of producing worthless vouchers; restart with the new key (start-up verification then passes).
- **Deploy tooling.** `deployContracts` passes `escapeDelaySec` to the constructor (default 7 days; attaching to a vault with a different one is `DEPLOYMENT_MISMATCH`), converges the signer by proposing and, on a re-run after the eta, accepting (`txs.proposeLedgerSigner/acceptLedgerSigner`; the file keeps the vault's actual signer meanwhile), and converges `signerChangeDelaySec` / `houseLimits` only when given (tightening at once, loosening scheduled, accepted on a re-run once due). CLI flags: `--escape-delay`, `--signer-change-delay`, `--house-buffer-bps`, `--house-daily-cap`; `--max-attestation-age` ≤ 86,400. `Deploy.s.sol` reads optional `ESCAPE_DELAY`.
- **OfflineChain** implements every new method with the vault's rules and error names (defaults now: `maxAttestationAge` 600 s, buffer 10 %, house cap 10M, escape 7 days via `escapeDelayS`), emits `onWithdrawn` for `playerWithdraw`, verifies escape proofs with `verifyBalanceProof`, and adds test hooks `donate(from, amount)` and `escapeClaimedByAccount(account)`. `nonceUsed` is now async (was a sync test hook).

## 9. Validation (2026-09-26)

| Command | Result |
|---|---|
| `forge build && forge test` (Docker, `foundry:stable`) | 173 passed, 0 failed (8 suites; fuzz 10,000 runs; invariants 256 runs × depth 64) |
| `forge coverage --report summary --no-match-coverage 'test/\|script/'` | `MayaHouseVault.sol` 100 % lines (281/281), statements (361/361), branches (57/57), functions (55/55) |
| `forge fmt --check src test script` | clean |
| `pnpm --filter @maya/house-server build` | ok |
| `pnpm --filter @maya/house-server exec vitest run test/chain` (no anvil) | 10 files passed, 1 skipped (the anvil file); 166 passed, 15 skipped |
| same with `MAYA_RPC_URL=http://127.0.0.1:8553` (dedicated anvil container) | 11 files passed; 181 passed (15 anvil integration tests) |
| `pnpm --filter @maya/house-server exec vitest run test/offline-chain.test.ts` | 3 passed |
| `pnpm --filter @maya/house-server exec vitest run` (whole server suite, no anvil) | 24 files passed, 1 skipped; 235 passed, 15 skipped |

Canary runs confirmed the random invariant campaigns reach house withdrawals, accepted rotations, sweeps and successful escape claims.
