// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IMayaHouseVault
/// @notice External surface of the Maya-Live house vault (SPEC §5, hardened by SPEC-11). Bets live in the
///         off-chain house ledger; this vault only custodies OPEN and records deposits, ledger-signed
///         withdrawals, liability attestations (whose root is a Merkle root of player balances) and
///         house-surplus withdrawals, and offers players an escape hatch when attestations stop.
///         All amounts are raw token units (wei); all times are Unix seconds.
interface IMayaHouseVault {
    // ---------------------------------------------------------------- events

    /// @notice `amount` is what the vault actually received (fee-on-transfer safe). `depositId` starts at 1.
    event Deposited(address indexed player, uint256 amount, uint256 indexed depositId);
    event HouseFunded(address indexed operator, uint256 amount);
    event Withdrawn(address indexed player, uint256 amount, uint256 indexed nonce);
    /// @param depositsSinceAttest deposits made at or after `asOf`, which `liabilities` is not assumed to cover.
    event Attested(
        uint64 indexed seq,
        uint256 liabilities,
        bytes32 ledgerRoot,
        uint64 asOf,
        uint256 assetsAtAttest,
        uint256 depositsSinceAttest
    );
    event HouseWithdrawn(address indexed to, uint256 amount);
    event LedgerSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event LimitsUpdated(
        uint256 maxVoucherAmount, uint256 dailyOutflowCap, uint256 accountDailyOutflowCap, uint256 maxAttestationAge
    );
    event LimitsProposed(
        uint256 maxVoucherAmount,
        uint256 dailyOutflowCap,
        uint256 accountDailyOutflowCap,
        uint256 maxAttestationAge,
        uint256 eta
    );
    event LimitsProposalCancelled(
        uint256 maxVoucherAmount, uint256 dailyOutflowCap, uint256 accountDailyOutflowCap, uint256 maxAttestationAge
    );

    event LedgerSignerProposed(address indexed currentSigner, address indexed proposedSigner, uint256 eta);
    event LedgerSignerProposalCancelled(address indexed proposedSigner);
    event SignerChangeDelayUpdated(uint256 previousDelay, uint256 newDelay);
    event SignerChangeDelayProposed(uint256 newDelay, uint256 eta);
    event SignerChangeDelayProposalCancelled(uint256 newDelay);
    event HouseLimitsUpdated(uint256 houseBufferBps, uint256 houseDailyCap);
    event HouseLimitsProposed(uint256 houseBufferBps, uint256 houseDailyCap, uint256 eta);
    event HouseLimitsProposalCancelled(uint256 houseBufferBps, uint256 houseDailyCap);
    event ExcessSwept(address indexed to, uint256 amount);
    event EscapeModeActivated(address indexed caller, uint64 seq, bytes32 ledgerRoot, uint64 asOf, uint256 escapePool);
    /// @param paid what was transferred (less than `entitlement` only when the escape pool ran short).
    event EscapeClaimed(address indexed account, uint256 paid, uint256 entitlement, uint256 attestedBalance);
    /// @notice Escape mode: the owner moved accounted assets that no escape claim can ever reach.
    event EscapeSurplusRecovered(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error InvalidToken(address token);
    error ZeroAmount();
    error NothingReceived();
    error SignerIsOwner(address account);
    error RenounceDisabled();
    error InvalidRecipient(address to);
    error VoucherExpired(uint256 expiry, uint256 timestamp);
    error VoucherAboveMax(uint256 amount, uint256 maxVoucherAmount);
    error NonceAlreadyUsed(address account, uint256 nonce);
    error InvalidSignature();
    error DailyOutflowCapExceeded(uint256 day, uint256 requested, uint256 remaining);
    error AccountDailyOutflowCapExceeded(address account, uint256 day, uint256 requested, uint256 remaining);
    error InsufficientAssets(uint256 requested, uint256 available);
    error NotLedgerSigner(address caller);
    error NonIncreasingSeq(uint64 seq, uint64 lastSeq);
    /// @dev `seq` may skip at most `maxStep` values past the stored one, so no key can exhaust the uint64 space.
    error SeqStepTooLarge(uint64 seq, uint64 lastSeq, uint64 maxStep);
    error AttestationFromFuture(uint64 asOf, uint256 timestamp);
    error NoAttestation();
    error AttestationBySupersededSigner(address attestor, address currentSigner);
    error AttestationTooOld(uint256 age, uint256 maxAge);
    error ExceedsHouseSurplus(uint256 amount, uint256 surplus);
    error InvalidLimits(
        uint256 maxVoucherAmount, uint256 dailyOutflowCap, uint256 accountDailyOutflowCap, uint256 maxAttestationAge
    );
    error NoPendingLimits();

    error SignerUnchanged(address signer);
    error NoPendingLedgerSigner();
    error TimelockNotElapsed(uint256 eta, uint256 timestamp);
    /// @dev A timelocked proposal must be accepted within `TIMELOCK_GRACE_PERIOD` after its eta; re-propose it.
    error ProposalExpired(uint256 expiredAt, uint256 timestamp);
    error InvalidSignerChangeDelay(uint256 delay);
    error NoPendingSignerChangeDelay();
    error InvalidHouseLimits(uint256 houseBufferBps, uint256 houseDailyCap);
    error NoPendingHouseLimits();
    /// @dev `amount` fits the surplus but would eat into the buffer kept on top of the attested obligations.
    error ExceedsHouseWithdrawable(uint256 amount, uint256 withdrawable);
    error HouseDailyCapExceeded(uint256 day, uint256 requested, uint256 remaining);
    error NothingToSweep();
    error InvalidEscapeDelay(uint256 escapeDelay);
    error EscapeModeActive();
    error EscapeModeInactive();
    error EscapeNotYetAvailable(uint256 availableAt, uint256 timestamp);
    error InvalidProof();
    error NothingToClaim();
    error EscapePoolExhausted();
    error NothingToRecover();

    // ---------------------------------------------------------------- player / operator / signer actions

    /// @notice Pull `amount` from the caller (requires allowance) and credit what is actually received.
    function deposit(uint256 amount) external;

    /// @notice Owner-only bankroll top-up; credits what is actually received to `houseFunded`.
    function fundHouse(uint256 amount) external;

    /// @notice Redeem a ledger-signed EIP-712 `Withdrawal(address account,uint256 amount,uint256 nonce,uint256 expiry)`
    ///         voucher for `msg.sender`. Valid while `block.timestamp <= expiry`.
    function withdraw(uint256 amount, uint256 nonce, uint256 expiry, bytes calldata signature) external;

    /// @notice Ledger-signer-only liability attestation. `liabilities` = player balances + outstanding vouchers
    ///         + open max payouts, as reflected by every on-chain deposit mined strictly before `asOf`.
    ///         `ledgerRoot` is the OpenZeppelin StandardMerkleTree root of `(address account, uint256 balanceWei)`
    ///         leaves: what the ledger owes each account given the on-chain flows mined at or before `asOf`.
    ///         `seq` must exceed the stored one by 1 .. `MAX_ATTESTATION_SEQ_STEP`.
    function attest(uint256 liabilities, bytes32 ledgerRoot, uint64 asOf, uint64 seq) external;

    /// @notice Owner-only withdrawal of house surplus under a fresh attestation from the current signer, keeping
    ///         `houseBuffer()` on top of the attested obligations and within `houseDailyCap` per UTC day.
    function withdrawHouse(uint256 amount, address to) external;

    function pause() external;
    function unpause() external;

    /// @notice Player-withdrawal limits and the house-withdrawal freshness bound. Lowering every value (or keeping
    ///         it) applies at once; raising any of them is scheduled `signerChangeDelay` ahead and applied by
    ///         `acceptLimits` (within `TIMELOCK_GRACE_PERIOD` after the eta). Any call replaces a pending change.
    function setLimits(
        uint256 maxVoucherAmount,
        uint256 dailyOutflowCap,
        uint256 accountDailyOutflowCap,
        uint256 maxAttestationAge
    ) external;
    function acceptLimits() external;
    function cancelLimits() external;

    /// @notice Starts a ledger-signer rotation that `acceptLedgerSigner` can complete after `signerChangeDelay`
    ///         (and at most `TIMELOCK_GRACE_PERIOD` after that). Replacing a pending proposal emits its cancellation.
    function proposeLedgerSigner(address newSigner) external;
    function acceptLedgerSigner() external;
    function cancelLedgerSigner() external;

    /// @notice Increases apply at once; a decrease is itself scheduled `signerChangeDelay` ahead.
    function setSignerChangeDelay(uint256 newDelay) external;
    function acceptSignerChangeDelay() external;
    function cancelSignerChangeDelay() external;

    /// @notice Tightening (a higher buffer and/or a lower cap) applies at once; any loosening is scheduled
    ///         `signerChangeDelay` ahead.
    function setHouseLimits(uint256 houseBufferBps, uint256 houseDailyCap) external;
    function acceptHouseLimits() external;
    function cancelHouseLimits() external;

    /// @notice Owner-only: sends `token.balanceOf(vault) - assets()` (stray or donated tokens) to `to`.
    function sweepExcess(address to) external returns (uint256 amount);

    /// @notice Anyone, once no attestation has landed for `escapeDelay`: freezes the latest root, stops
    ///         deposits, voucher withdrawals, house funding/withdrawals and attestations. Irreversible.
    function triggerEscape() external;

    /// @notice Escape mode only: pays `msg.sender` its entitlement under the frozen root (see `escapeEntitlement`).
    ///         `attestedBalance` 0 needs no proof.
    function claimEscape(uint256 attestedBalance, bytes32[] calldata proof) external returns (uint256 paid);

    /// @notice Owner-only, escape mode only: sends `escapeSurplus()` (accounted assets above what escape claims can
    ///         still take) to `to`, counted as a house withdrawal. No claim can ever reach these tokens.
    function recoverEscapeSurplus(address to) external returns (uint256 amount);

    // ---------------------------------------------------------------- views

    function token() external view returns (IERC20);
    function ledgerSigner() external view returns (address);
    function maxVoucherAmount() external view returns (uint256);
    function dailyOutflowCap() external view returns (uint256);
    /// @notice Voucher withdrawals one account may redeem per UTC day (so no account can drain the shared cap).
    function accountDailyOutflowCap() external view returns (uint256);
    function maxAttestationAge() external view returns (uint256);
    function pendingMaxVoucherAmount() external view returns (uint256);
    function pendingDailyOutflowCap() external view returns (uint256);
    function pendingAccountDailyOutflowCap() external view returns (uint256);
    function pendingMaxAttestationAge() external view returns (uint256);
    /// @notice 0 when no limit change is pending.
    function pendingLimitsEta() external view returns (uint256);

    function totalPlayerDeposits() external view returns (uint256);
    function houseFunded() external view returns (uint256);
    function totalPlayerWithdrawals() external view returns (uint256);
    function houseWithdrawn() external view returns (uint256);
    function depositCount() external view returns (uint256);

    function attestedLiabilities() external view returns (uint256);
    function attestedLedgerRoot() external view returns (bytes32);
    function attestationSeq() external view returns (uint64);
    function attestationAsOf() external view returns (uint64);
    function attestedAt() external view returns (uint64);
    function attestationSigner() external view returns (address);
    function assetsAtAttest() external view returns (uint256);

    function nonceUsed(address account, uint256 nonce) external view returns (bool);
    function dailyOutflow(uint256 day) external view returns (uint256);
    function accountDailyOutflow(uint256 day, address account) external view returns (uint256);

    function pendingLedgerSigner() external view returns (address);
    function pendingLedgerSignerEta() external view returns (uint256);
    function signerChangeDelay() external view returns (uint256);
    function pendingSignerChangeDelay() external view returns (uint256);
    function pendingSignerChangeDelayEta() external view returns (uint256);
    function houseBufferBps() external view returns (uint256);
    function houseDailyCap() external view returns (uint256);
    function pendingHouseBufferBps() external view returns (uint256);
    function pendingHouseDailyCap() external view returns (uint256);
    function pendingHouseLimitsEta() external view returns (uint256);
    function houseDailyOutflow(uint256 day) external view returns (uint256);

    function escapeDelay() external view returns (uint256);
    function deployedAt() external view returns (uint256);
    /// @notice Block time the current ledger signer took office (deployment, then each accepted rotation).
    function ledgerSignerSince() external view returns (uint256);
    function escapeMode() external view returns (bool);
    function escapePool() external view returns (uint256);
    function escapeClaimedTotal() external view returns (uint256);
    function escapeClaimedBy(address account) external view returns (uint256);

    /// @notice totalPlayerDeposits + houseFunded - totalPlayerWithdrawals - houseWithdrawn.
    function assets() external view returns (uint256);
    function depositsSinceAttest() external view returns (uint256);
    function claimedSinceAttest() external view returns (uint256);
    /// @notice max(0, attestedLiabilities + depositsSinceAttest - claimedSinceAttest), saturating.
    function requiredAssets() external view returns (uint256);
    /// @notice max(0, assets - requiredAssets).
    function houseSurplus() external view returns (uint256);
    /// @notice ceil(requiredAssets * houseBufferBps / 10_000): kept on top of the obligations by `withdrawHouse`.
    function houseBuffer() external view returns (uint256);
    /// @notice min(houseSurplus - houseBuffer, remainingHouseDailyOutflow) floored at 0 (attestation freshness,
    ///         pause and escape mode are not considered).
    function houseWithdrawable() external view returns (uint256);
    function remainingHouseDailyOutflow() external view returns (uint256);
    /// @notice token.balanceOf(vault) - assets(): stray or donated tokens that `sweepExcess` may move.
    function excess() external view returns (uint256);
    /// @notice Seconds since the latest attestation's `asOf`; `type(uint256).max` before the first attestation.
    function attestationAge() external view returns (uint256);
    /// @notice Block time of the latest attestation, or the deployment time before the first one.
    function lastAttestationAt() external view returns (uint256);
    /// @notice `max(lastAttestationAt(), ledgerSignerSince) + escapeDelay`: from then on anyone may trigger escape
    ///         mode. A newly accepted signer always gets a full `escapeDelay` to attest before a root attested by
    ///         the key it replaced can be frozen.
    function escapeAvailableAt() external view returns (uint256);
    /// @notice Escape mode: `assets() - (escapePool - escapeClaimedTotal)`, what `recoverEscapeSurplus` may move;
    ///         0 outside escape mode.
    function escapeSurplus() external view returns (uint256);
    /// @notice max(0, attestedBalance + deposits mined after the root's asOf - withdrawals and escape claims
    ///         mined after it), for `account` (proof not checked). Before any attestation `attestedBalance`
    ///         should be 0 and the entitlement is the account's net deposits.
    function escapeEntitlement(address account, uint256 attestedBalance) external view returns (uint256);
    /// @notice OpenZeppelin StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(account, balance)))).
    function balanceLeaf(address account, uint256 balanceWei) external pure returns (bytes32);
    /// @notice Cumulative deposits made by `account`.
    function playerDepositsOf(address account) external view returns (uint256);
    /// @notice Cumulative voucher withdrawals and escape claims paid to `account`.
    function playerWithdrawalsOf(address account) external view returns (uint256);
    /// @notice UTC day index (`block.timestamp / 1 days`) used by the daily outflow caps.
    function currentDay() external view returns (uint256);
    function remainingDailyOutflow() external view returns (uint256);
    /// @notice What `account` may still redeem today: min(remaining shared cap, remaining per-account cap).
    function remainingAccountDailyOutflow(address account) external view returns (uint256);
    /// @notice Cumulative player deposits mined at or before `timestamp`.
    function totalPlayerDepositsAt(uint48 timestamp) external view returns (uint256);
    function hashWithdrawal(address account, uint256 amount, uint256 nonce, uint256 expiry)
        external
        view
        returns (bytes32);
    function domainSeparator() external view returns (bytes32);
}
