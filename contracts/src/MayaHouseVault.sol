// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IMayaHouseVault} from "./interfaces/IMayaHouseVault.sol";

/// @title MayaHouseVault
/// @notice Custodies OPEN for Maya-Live. The $OPEN operator (owner) funds the bankroll; players deposit and
///         withdraw with vouchers signed by the house ledger key. The owner may only withdraw what exceeds the
///         ledger-attested player obligations plus a buffer, within a daily cap (SPEC §5, SPEC-11). If the
///         ledger stops attesting for `escapeDelay`, anyone can switch the vault into escape mode, after which
///         every account claims its last-attested balance with a Merkle proof.
/// @dev Accounting is internal: token balances are read only to measure what a transfer actually delivered and
///      to size `excess()`, so donations and fee-on-transfer skims can never inflate `assets()`. Rebasing tokens
///      are not supported. Rotating `ledgerSigner` (timelocked) invalidates every outstanding voucher and the
///      current attestation for house withdrawals. Every loosening (signer, signer-change delay, house limits,
///      player limits and attestation freshness) waits `signerChangeDelay` and expires `TIMELOCK_GRACE_PERIOD`
///      after its eta.
contract MayaHouseVault is IMayaHouseVault, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address account,uint256 amount,uint256 nonce,uint256 expiry)");

    /// @dev Defaults assume an 18-decimal token; the owner tunes them with `setLimits` / `setHouseLimits`.
    uint256 public constant DEFAULT_MAX_VOUCHER_AMOUNT = 100_000 * 10 ** 18;
    uint256 public constant DEFAULT_DAILY_OUTFLOW_CAP = 1_000_000 * 10 ** 18;
    /// @dev A quarter of the shared daily cap: one account can never exhaust the other players' budget.
    uint256 public constant DEFAULT_ACCOUNT_DAILY_OUTFLOW_CAP = 250_000 * 10 ** 18;
    uint256 public constant DEFAULT_MAX_ATTESTATION_AGE = 10 minutes;
    uint256 public constant MAX_ATTESTATION_AGE_LIMIT = 1 days;
    uint256 public constant DEFAULT_SIGNER_CHANGE_DELAY = 48 hours;
    uint256 public constant MIN_SIGNER_CHANGE_DELAY = 1 hours;
    uint256 public constant MAX_SIGNER_CHANGE_DELAY = 30 days;
    uint256 public constant BPS = 10_000;
    uint256 public constant DEFAULT_HOUSE_BUFFER_BPS = 1_000;
    uint256 public constant DEFAULT_HOUSE_DAILY_CAP = 10_000_000 * 10 ** 18;
    uint256 public constant DEFAULT_ESCAPE_DELAY = 7 days;
    uint256 public constant MIN_ESCAPE_DELAY = 3 days;
    uint256 public constant MAX_ESCAPE_DELAY = 90 days;
    /// @dev A timelocked proposal can be accepted from its eta until eta + this; afterwards it must be re-proposed
    ///      (with fresh on-chain notice).
    uint256 public constant TIMELOCK_GRACE_PERIOD = 7 days;
    /// @dev Largest seq increase one attestation may make. Tolerates gaps (a reorged attest, a journal ahead of
    ///      the vault) while making it infeasible for any key to reach type(uint64).max, which would freeze the
    ///      root forever (no later attestation, not even by a rotated-in signer, could supersede it).
    uint64 public constant MAX_ATTESTATION_SEQ_STEP = 1_000_000;

    // SPEC §5 names this getter `token`.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IERC20 public immutable token;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable escapeDelay;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable deployedAt;
    address public ledgerSigner;
    /// @dev Block time the current signer took office; a new signer gets a full escape window to attest.
    uint256 public ledgerSignerSince;

    uint256 public maxVoucherAmount;
    uint256 public dailyOutflowCap;
    uint256 public accountDailyOutflowCap;
    uint256 public maxAttestationAge;
    uint256 public pendingMaxVoucherAmount;
    uint256 public pendingDailyOutflowCap;
    uint256 public pendingAccountDailyOutflowCap;
    uint256 public pendingMaxAttestationAge;
    /// @dev 0 = no pending loosening.
    uint256 public pendingLimitsEta;

    uint256 public totalPlayerDeposits;
    uint256 public houseFunded;
    uint256 public totalPlayerWithdrawals;
    uint256 public houseWithdrawn;
    uint256 public depositCount;

    uint256 public attestedLiabilities;
    uint256 public assetsAtAttest;
    bytes32 public attestedLedgerRoot;
    address public attestationSigner;
    uint64 public attestationSeq;
    uint64 public attestationAsOf;
    uint64 public attestedAt;

    address public pendingLedgerSigner;
    uint256 public pendingLedgerSignerEta;
    uint256 public signerChangeDelay;
    uint256 public pendingSignerChangeDelay;
    /// @dev 0 = no pending decrease.
    uint256 public pendingSignerChangeDelayEta;

    uint256 public houseBufferBps;
    uint256 public houseDailyCap;
    uint256 public pendingHouseBufferBps;
    uint256 public pendingHouseDailyCap;
    /// @dev 0 = no pending loosening.
    uint256 public pendingHouseLimitsEta;

    bool public escapeMode;
    uint256 public escapePool;
    uint256 public escapeClaimedTotal;

    /// @dev totalPlayerDeposits mined strictly before the latest attestation's asOf.
    uint256 private _depositsBaseline;
    /// @dev totalPlayerWithdrawals when the latest attestation was mined.
    uint256 private _claimsBaseline;

    mapping(address account => mapping(uint256 nonce => bool used)) public nonceUsed;
    mapping(uint256 day => uint256 amount) public dailyOutflow;
    mapping(uint256 day => mapping(address account => uint256 amount)) public accountDailyOutflow;
    mapping(uint256 day => uint256 amount) public houseDailyOutflow;
    mapping(address account => uint256 paid) public escapeClaimedBy;

    /// @dev Cumulative player deposits keyed by block timestamp; lets `attest` cut deposits at `asOf`.
    Checkpoints.Trace208 private _depositHistory;
    /// @dev Per account, cumulative deposits and cumulative payouts (vouchers + escape claims) by block
    ///      timestamp; lets an escape claim net the flows mined after the frozen root's `asOf`.
    mapping(address account => Checkpoints.Trace208) private _playerDeposits;
    mapping(address account => Checkpoints.Trace208) private _playerWithdrawals;

    modifier whenNotEscaped() {
        _requireNotEscaped();
        _;
    }

    constructor(IERC20 token_, address ledgerSigner_, uint256 escapeDelay_)
        Ownable(msg.sender)
        EIP712("MayaHouseVault", "1")
    {
        if (address(token_) == address(0) || ledgerSigner_ == address(0)) revert ZeroAddress();
        if (address(token_).code.length == 0) revert InvalidToken(address(token_));
        if (ledgerSigner_ == msg.sender) revert SignerIsOwner(ledgerSigner_);
        if (escapeDelay_ < MIN_ESCAPE_DELAY || escapeDelay_ > MAX_ESCAPE_DELAY) {
            revert InvalidEscapeDelay(escapeDelay_);
        }
        token = token_;
        escapeDelay = escapeDelay_;
        deployedAt = block.timestamp;
        ledgerSigner = ledgerSigner_;
        ledgerSignerSince = block.timestamp;
        emit LedgerSignerUpdated(address(0), ledgerSigner_);
        _applyLimits(
            DEFAULT_MAX_VOUCHER_AMOUNT,
            DEFAULT_DAILY_OUTFLOW_CAP,
            DEFAULT_ACCOUNT_DAILY_OUTFLOW_CAP,
            DEFAULT_MAX_ATTESTATION_AGE
        );
        // DEFAULT_SIGNER_CHANGE_DELAY (48 h) < MIN_ESCAPE_DELAY (3 days), so the default is always valid.
        signerChangeDelay = DEFAULT_SIGNER_CHANGE_DELAY;
        emit SignerChangeDelayUpdated(0, DEFAULT_SIGNER_CHANGE_DELAY);
        _applyHouseLimits(DEFAULT_HOUSE_BUFFER_BPS, DEFAULT_HOUSE_DAILY_CAP);
    }

    // ------------------------------------------------------------------ inflows

    /// @inheritdoc IMayaHouseVault
    function deposit(uint256 amount) external nonReentrant whenNotPaused whenNotEscaped {
        uint256 received = _pull(amount);
        uint256 total = totalPlayerDeposits + received;
        totalPlayerDeposits = total;
        uint256 depositId = ++depositCount;
        _depositHistory.push(uint48(block.timestamp), SafeCast.toUint208(total));
        _accrue(_playerDeposits[msg.sender], received);
        emit Deposited(msg.sender, received, depositId);
    }

    /// @inheritdoc IMayaHouseVault
    function fundHouse(uint256 amount) external onlyOwner nonReentrant whenNotEscaped {
        uint256 received = _pull(amount);
        houseFunded += received;
        emit HouseFunded(msg.sender, received);
    }

    // ------------------------------------------------------------------ outflows

    /// @inheritdoc IMayaHouseVault
    function withdraw(uint256 amount, uint256 nonce, uint256 expiry, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
        whenNotEscaped
    {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > expiry) revert VoucherExpired(expiry, block.timestamp);
        if (amount > maxVoucherAmount) revert VoucherAboveMax(amount, maxVoucherAmount);
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);

        // The digest binds account, chainId and this vault, so a voucher cannot be replayed by another
        // account, on another chain or against another vault. tryRecover rejects high-s signatures.
        bytes32 digest = _withdrawalDigest(msg.sender, amount, nonce, expiry);
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != ledgerSigner) revert InvalidSignature();

        uint256 day = block.timestamp / 1 days;
        _checkOutflowCaps(msg.sender, day, amount);

        uint256 available = assets();
        if (amount > available) revert InsufficientAssets(amount, available);

        nonceUsed[msg.sender][nonce] = true;
        dailyOutflow[day] += amount;
        accountDailyOutflow[day][msg.sender] += amount;
        totalPlayerWithdrawals += amount;
        _accrue(_playerWithdrawals[msg.sender], amount);
        emit Withdrawn(msg.sender, amount, nonce);

        token.safeTransfer(msg.sender, amount);
    }

    /// @inheritdoc IMayaHouseVault
    function withdrawHouse(uint256 amount, address to) external onlyOwner nonReentrant whenNotPaused whenNotEscaped {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRecipient(to);
        if (attestationSeq == 0) revert NoAttestation();
        if (attestationSigner != ledgerSigner) revert AttestationBySupersededSigner(attestationSigner, ledgerSigner);
        uint256 age = block.timestamp - attestationAsOf;
        if (age > maxAttestationAge) revert AttestationTooOld(age, maxAttestationAge);
        uint256 surplus = houseSurplus();
        if (amount > surplus) revert ExceedsHouseSurplus(amount, surplus);
        uint256 withdrawable = _afterBuffer(surplus);
        if (amount > withdrawable) revert ExceedsHouseWithdrawable(amount, withdrawable);
        uint256 day = block.timestamp / 1 days;
        uint256 used = houseDailyOutflow[day];
        uint256 cap = houseDailyCap;
        if (used + amount > cap) revert HouseDailyCapExceeded(day, amount, used >= cap ? 0 : cap - used);

        houseDailyOutflow[day] = used + amount;
        houseWithdrawn += amount;
        emit HouseWithdrawn(to, amount);

        token.safeTransfer(to, amount);
    }

    /// @inheritdoc IMayaHouseVault
    function sweepExcess(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRecipient(to);
        amount = excess();
        if (amount == 0) revert NothingToSweep();
        emit ExcessSwept(to, amount);
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ attestation

    /// @inheritdoc IMayaHouseVault
    /// @dev Deposits mined at or after `asOf` stay counted as unattested (the ledger may not have indexed
    ///      them yet), while claims are only netted once mined after this call. Both choices can only
    ///      understate the surplus, never let the owner reach player funds.
    function attest(uint256 liabilities, bytes32 ledgerRoot, uint64 asOf, uint64 seq) external whenNotEscaped {
        if (msg.sender != ledgerSigner) revert NotLedgerSigner(msg.sender);
        uint64 lastSeq = attestationSeq;
        if (seq <= lastSeq) revert NonIncreasingSeq(seq, lastSeq);
        // Bounded step: a leaked signer key cannot jump to type(uint64).max and make its root permanent.
        if (seq - lastSeq > MAX_ATTESTATION_SEQ_STEP) revert SeqStepTooLarge(seq, lastSeq, MAX_ATTESTATION_SEQ_STEP);
        if (asOf > block.timestamp) revert AttestationFromFuture(asOf, block.timestamp);

        uint256 depositsBaseline = asOf == 0 ? 0 : _depositHistory.upperLookupRecent(SafeCast.toUint48(asOf - 1));
        uint256 assetsNow = assets();

        attestedLiabilities = liabilities;
        attestedLedgerRoot = ledgerRoot;
        attestationSigner = msg.sender;
        attestationSeq = seq;
        attestationAsOf = asOf;
        attestedAt = uint64(block.timestamp);
        assetsAtAttest = assetsNow;
        _depositsBaseline = depositsBaseline;
        _claimsBaseline = totalPlayerWithdrawals;

        emit Attested(seq, liabilities, ledgerRoot, asOf, assetsNow, totalPlayerDeposits - depositsBaseline);
    }

    // ------------------------------------------------------------------ escape hatch

    /// @inheritdoc IMayaHouseVault
    function triggerEscape() external whenNotEscaped {
        uint256 availableAt = escapeAvailableAt();
        if (block.timestamp < availableAt) revert EscapeNotYetAvailable(availableAt, block.timestamp);
        // Claims can never exceed what the ledger last attested for players plus the deposits it had not
        // yet covered, nor what the vault holds.
        uint256 pool = Math.min(assets(), Math.saturatingAdd(attestedLiabilities, depositsSinceAttest()));
        escapeMode = true;
        escapePool = pool;
        emit EscapeModeActivated(msg.sender, attestationSeq, attestedLedgerRoot, attestationAsOf, pool);
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev The payout is recorded as a withdrawal after the root's `asOf`, so the entitlement of a second
    ///      claim (with any leaf) is net of it: an account can never be paid twice for the same balance.
    function claimEscape(uint256 attestedBalance, bytes32[] calldata proof)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (!escapeMode) revert EscapeModeInactive();
        // Before the first attestation the root is zero, which no proof can reach.
        if (
            attestedBalance != 0
                && !MerkleProof.verifyCalldata(proof, attestedLedgerRoot, balanceLeaf(msg.sender, attestedBalance))
        ) revert InvalidProof();
        uint256 entitlement = escapeEntitlement(msg.sender, attestedBalance);
        if (entitlement == 0) revert NothingToClaim();
        uint256 remaining = escapePool - escapeClaimedTotal;
        if (remaining == 0) revert EscapePoolExhausted();
        paid = Math.min(entitlement, remaining);

        escapeClaimedTotal += paid;
        escapeClaimedBy[msg.sender] += paid;
        totalPlayerWithdrawals += paid;
        _accrue(_playerWithdrawals[msg.sender], paid);
        emit EscapeClaimed(msg.sender, paid, entitlement, attestedBalance);

        token.safeTransfer(msg.sender, paid);
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev Claims can never take more than `escapePool - escapeClaimedTotal` (the pool is fixed at trigger time
    ///      and never grows), so the rest of the accounted assets (the bankroll) is provably unclaimable and would
    ///      otherwise stay locked forever. Afterwards `assets() == escapePool - escapeClaimedTotal`.
    function recoverEscapeSurplus(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        if (!escapeMode) revert EscapeModeInactive();
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert InvalidRecipient(to);
        amount = escapeSurplus();
        if (amount == 0) revert NothingToRecover();
        houseWithdrawn += amount;
        emit EscapeSurplusRecovered(to, amount);
        token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------ owner admin

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev A new proposal replaces a pending one (emitting its cancellation) and restarts the delay.
    function proposeLedgerSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        if (newSigner == owner() || newSigner == pendingOwner()) revert SignerIsOwner(newSigner);
        if (newSigner == ledgerSigner) revert SignerUnchanged(newSigner);
        address replaced = pendingLedgerSigner;
        if (replaced != address(0)) emit LedgerSignerProposalCancelled(replaced);
        uint256 eta = block.timestamp + signerChangeDelay;
        pendingLedgerSigner = newSigner;
        pendingLedgerSignerEta = eta;
        emit LedgerSignerProposed(ledgerSigner, newSigner, eta);
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev The pending signer can never be the owner or the pending owner: `proposeLedgerSigner` rejects both
    ///      and `transferOwnership` rejects the pending signer. The new signer's term starts now, which restarts
    ///      the escape clock (see `escapeAvailableAt`).
    function acceptLedgerSigner() external onlyOwner {
        address next = pendingLedgerSigner;
        if (next == address(0)) revert NoPendingLedgerSigner();
        _requireDue(pendingLedgerSignerEta);
        delete pendingLedgerSigner;
        delete pendingLedgerSignerEta;
        emit LedgerSignerUpdated(ledgerSigner, next);
        ledgerSigner = next;
        ledgerSignerSince = block.timestamp;
    }

    function cancelLedgerSigner() external onlyOwner {
        address proposed = pendingLedgerSigner;
        if (proposed == address(0)) revert NoPendingLedgerSigner();
        delete pendingLedgerSigner;
        delete pendingLedgerSignerEta;
        emit LedgerSignerProposalCancelled(proposed);
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev Must stay below `escapeDelay` so a lost signer key can always be replaced before players can
    ///      force escape mode. Any call replaces a pending decrease.
    function setSignerChangeDelay(uint256 newDelay) external onlyOwner {
        if (newDelay < MIN_SIGNER_CHANGE_DELAY || newDelay > MAX_SIGNER_CHANGE_DELAY || newDelay >= escapeDelay) {
            revert InvalidSignerChangeDelay(newDelay);
        }
        _clearPendingSignerChangeDelay();
        uint256 current = signerChangeDelay;
        if (newDelay >= current) {
            signerChangeDelay = newDelay;
            emit SignerChangeDelayUpdated(current, newDelay);
        } else {
            uint256 eta = block.timestamp + current;
            pendingSignerChangeDelay = newDelay;
            pendingSignerChangeDelayEta = eta;
            emit SignerChangeDelayProposed(newDelay, eta);
        }
    }

    function acceptSignerChangeDelay() external onlyOwner {
        uint256 eta = pendingSignerChangeDelayEta;
        if (eta == 0) revert NoPendingSignerChangeDelay();
        _requireDue(eta);
        uint256 newDelay = pendingSignerChangeDelay;
        delete pendingSignerChangeDelay;
        delete pendingSignerChangeDelayEta;
        emit SignerChangeDelayUpdated(signerChangeDelay, newDelay);
        signerChangeDelay = newDelay;
    }

    function cancelSignerChangeDelay() external onlyOwner {
        if (pendingSignerChangeDelayEta == 0) revert NoPendingSignerChangeDelay();
        _clearPendingSignerChangeDelay();
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev Any call replaces a pending loosening.
    function setHouseLimits(uint256 houseBufferBps_, uint256 houseDailyCap_) external onlyOwner {
        if (houseBufferBps_ > BPS || houseDailyCap_ == 0) revert InvalidHouseLimits(houseBufferBps_, houseDailyCap_);
        _clearPendingHouseLimits();
        if (houseBufferBps_ >= houseBufferBps && houseDailyCap_ <= houseDailyCap) {
            _applyHouseLimits(houseBufferBps_, houseDailyCap_);
        } else {
            uint256 eta = block.timestamp + signerChangeDelay;
            pendingHouseBufferBps = houseBufferBps_;
            pendingHouseDailyCap = houseDailyCap_;
            pendingHouseLimitsEta = eta;
            emit HouseLimitsProposed(houseBufferBps_, houseDailyCap_, eta);
        }
    }

    function acceptHouseLimits() external onlyOwner {
        uint256 eta = pendingHouseLimitsEta;
        if (eta == 0) revert NoPendingHouseLimits();
        _requireDue(eta);
        uint256 bufferBps = pendingHouseBufferBps;
        uint256 cap = pendingHouseDailyCap;
        delete pendingHouseBufferBps;
        delete pendingHouseDailyCap;
        delete pendingHouseLimitsEta;
        _applyHouseLimits(bufferBps, cap);
    }

    function cancelHouseLimits() external onlyOwner {
        if (pendingHouseLimitsEta == 0) revert NoPendingHouseLimits();
        _clearPendingHouseLimits();
    }

    /// @inheritdoc IMayaHouseVault
    /// @dev Raising a player limit or `maxAttestationAge` widens what a compromised key can take (vouchers per day,
    ///      house withdrawals against stale attestations), so it gets the same public notice as a house-limit
    ///      loosening. Tightening stays instant: it is the incident response.
    function setLimits(
        uint256 maxVoucherAmount_,
        uint256 dailyOutflowCap_,
        uint256 accountDailyOutflowCap_,
        uint256 maxAttestationAge_
    ) external onlyOwner {
        _validateLimits(maxVoucherAmount_, dailyOutflowCap_, accountDailyOutflowCap_, maxAttestationAge_);
        _clearPendingLimits();
        if (
            maxVoucherAmount_ <= maxVoucherAmount && dailyOutflowCap_ <= dailyOutflowCap
                && accountDailyOutflowCap_ <= accountDailyOutflowCap && maxAttestationAge_ <= maxAttestationAge
        ) {
            _applyLimits(maxVoucherAmount_, dailyOutflowCap_, accountDailyOutflowCap_, maxAttestationAge_);
        } else {
            uint256 eta = block.timestamp + signerChangeDelay;
            pendingMaxVoucherAmount = maxVoucherAmount_;
            pendingDailyOutflowCap = dailyOutflowCap_;
            pendingAccountDailyOutflowCap = accountDailyOutflowCap_;
            pendingMaxAttestationAge = maxAttestationAge_;
            pendingLimitsEta = eta;
            emit LimitsProposed(maxVoucherAmount_, dailyOutflowCap_, accountDailyOutflowCap_, maxAttestationAge_, eta);
        }
    }

    function acceptLimits() external onlyOwner {
        uint256 eta = pendingLimitsEta;
        if (eta == 0) revert NoPendingLimits();
        _requireDue(eta);
        uint256 maxVoucher = pendingMaxVoucherAmount;
        uint256 cap = pendingDailyOutflowCap;
        uint256 accountCap = pendingAccountDailyOutflowCap;
        uint256 maxAge = pendingMaxAttestationAge;
        _deletePendingLimits();
        _applyLimits(maxVoucher, cap, accountCap, maxAge);
    }

    function cancelLimits() external onlyOwner {
        if (pendingLimitsEta == 0) revert NoPendingLimits();
        _clearPendingLimits();
    }

    /// @notice Starts a two-step transfer; the (pending) ledger signer can never become (pending) owner.
    function transferOwnership(address newOwner) public override onlyOwner {
        // ledgerSigner is never zero; address(0) cancels a pending transfer and must stay allowed.
        if (newOwner == ledgerSigner || (newOwner != address(0) && newOwner == pendingLedgerSigner)) {
            revert SignerIsOwner(newOwner);
        }
        super.transferOwnership(newOwner);
    }

    /// @notice Disabled: an ownerless vault would strand the bankroll and freeze every admin control.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ views

    function assets() public view returns (uint256) {
        return totalPlayerDeposits + houseFunded - totalPlayerWithdrawals - houseWithdrawn;
    }

    function depositsSinceAttest() public view returns (uint256) {
        return totalPlayerDeposits - _depositsBaseline;
    }

    function claimedSinceAttest() public view returns (uint256) {
        return totalPlayerWithdrawals - _claimsBaseline;
    }

    function requiredAssets() public view returns (uint256) {
        // Saturating: an absurd attested figure must block surplus withdrawals, not brick the views.
        uint256 owed = Math.saturatingAdd(attestedLiabilities, depositsSinceAttest());
        uint256 claimed = claimedSinceAttest();
        return owed > claimed ? owed - claimed : 0;
    }

    function houseSurplus() public view returns (uint256) {
        uint256 held = assets();
        uint256 required = requiredAssets();
        return held > required ? held - required : 0;
    }

    function houseBuffer() public view returns (uint256) {
        return Math.mulDiv(requiredAssets(), houseBufferBps, BPS, Math.Rounding.Ceil);
    }

    function houseWithdrawable() external view returns (uint256) {
        return Math.min(_afterBuffer(houseSurplus()), remainingHouseDailyOutflow());
    }

    function remainingHouseDailyOutflow() public view returns (uint256) {
        uint256 used = houseDailyOutflow[block.timestamp / 1 days];
        return used >= houseDailyCap ? 0 : houseDailyCap - used;
    }

    function excess() public view returns (uint256) {
        uint256 held = token.balanceOf(address(this));
        uint256 accounted = assets();
        return held > accounted ? held - accounted : 0;
    }

    function attestationAge() external view returns (uint256) {
        if (attestationSeq == 0) return type(uint256).max;
        return block.timestamp - attestationAsOf;
    }

    function lastAttestationAt() public view returns (uint256) {
        return attestationSeq == 0 ? deployedAt : attestedAt;
    }

    function escapeAvailableAt() public view returns (uint256) {
        return Math.max(lastAttestationAt(), ledgerSignerSince) + escapeDelay;
    }

    function escapeSurplus() public view returns (uint256) {
        if (!escapeMode) return 0;
        uint256 reserved = escapePool - escapeClaimedTotal;
        uint256 held = assets();
        return held > reserved ? held - reserved : 0;
    }

    function escapeEntitlement(address account, uint256 attestedBalance) public view returns (uint256) {
        uint48 cut = SafeCast.toUint48(attestationAsOf);
        uint256 depositedAfter = _flowAfter(_playerDeposits[account], cut);
        uint256 paidAfter = _flowAfter(_playerWithdrawals[account], cut);
        uint256 owed = Math.saturatingAdd(attestedBalance, depositedAfter);
        return owed > paidAfter ? owed - paidAfter : 0;
    }

    function balanceLeaf(address account, uint256 balanceWei) public pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(bytes.concat(keccak256(abi.encode(account, balanceWei))));
    }

    function playerDepositsOf(address account) external view returns (uint256) {
        return _playerDeposits[account].latest();
    }

    function playerWithdrawalsOf(address account) external view returns (uint256) {
        return _playerWithdrawals[account].latest();
    }

    function currentDay() external view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function remainingDailyOutflow() public view returns (uint256) {
        uint256 used = dailyOutflow[block.timestamp / 1 days];
        return used >= dailyOutflowCap ? 0 : dailyOutflowCap - used;
    }

    function remainingAccountDailyOutflow(address account) external view returns (uint256) {
        uint256 used = accountDailyOutflow[block.timestamp / 1 days][account];
        uint256 own = used >= accountDailyOutflowCap ? 0 : accountDailyOutflowCap - used;
        return Math.min(own, remainingDailyOutflow());
    }

    function totalPlayerDepositsAt(uint48 timestamp) external view returns (uint256) {
        return _depositHistory.upperLookupRecent(timestamp);
    }

    function hashWithdrawal(address account, uint256 amount, uint256 nonce, uint256 expiry)
        external
        view
        returns (bytes32)
    {
        return _withdrawalDigest(account, amount, nonce, expiry);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------ internals

    /// @dev Pulls `amount` from msg.sender and returns the balance delta actually received.
    function _pull(uint256 amount) private returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();
    }

    function _requireNotEscaped() private view {
        if (escapeMode) revert EscapeModeActive();
    }

    /// @dev A timelocked proposal is acceptable from `eta` through `eta + TIMELOCK_GRACE_PERIOD`.
    function _requireDue(uint256 eta) private view {
        if (block.timestamp < eta) revert TimelockNotElapsed(eta, block.timestamp);
        uint256 expiredAt = eta + TIMELOCK_GRACE_PERIOD;
        if (block.timestamp > expiredAt) revert ProposalExpired(expiredAt, block.timestamp);
    }

    /// @dev The shared player cap first (the circuit breaker), then the account's own share of it.
    function _checkOutflowCaps(address account, uint256 day, uint256 amount) private view {
        uint256 used = dailyOutflow[day];
        uint256 cap = dailyOutflowCap;
        if (used + amount > cap) revert DailyOutflowCapExceeded(day, amount, used >= cap ? 0 : cap - used);
        uint256 accountUsed = accountDailyOutflow[day][account];
        uint256 accountCap = accountDailyOutflowCap;
        if (accountUsed + amount > accountCap) {
            revert AccountDailyOutflowCapExceeded(
                account, day, amount, accountUsed >= accountCap ? 0 : accountCap - accountUsed
            );
        }
    }

    function _accrue(Checkpoints.Trace208 storage trace, uint256 amount) private {
        trace.push(uint48(block.timestamp), SafeCast.toUint208(uint256(trace.latest()) + amount));
    }

    /// @dev Cumulative flow recorded strictly after `cut`.
    function _flowAfter(Checkpoints.Trace208 storage trace, uint48 cut) private view returns (uint256) {
        return trace.latest() - trace.upperLookupRecent(cut);
    }

    function _afterBuffer(uint256 surplus) private view returns (uint256) {
        uint256 buffer = houseBuffer();
        return surplus > buffer ? surplus - buffer : 0;
    }

    function _withdrawalDigest(address account, uint256 amount, uint256 nonce, uint256 expiry)
        private
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(WITHDRAWAL_TYPEHASH, account, amount, nonce, expiry)));
    }

    /// @dev 0 < maxVoucherAmount <= accountDailyOutflowCap <= dailyOutflowCap and 0 < maxAttestationAge <= 1 day.
    function _validateLimits(
        uint256 maxVoucherAmount_,
        uint256 dailyOutflowCap_,
        uint256 accountDailyOutflowCap_,
        uint256 maxAttestationAge_
    ) private pure {
        if (
            maxVoucherAmount_ == 0 || maxVoucherAmount_ > accountDailyOutflowCap_
                || accountDailyOutflowCap_ > dailyOutflowCap_ || maxAttestationAge_ == 0
                || maxAttestationAge_ > MAX_ATTESTATION_AGE_LIMIT
        ) {
            revert InvalidLimits(maxVoucherAmount_, dailyOutflowCap_, accountDailyOutflowCap_, maxAttestationAge_);
        }
    }

    function _applyLimits(
        uint256 maxVoucherAmount_,
        uint256 dailyOutflowCap_,
        uint256 accountDailyOutflowCap_,
        uint256 maxAttestationAge_
    ) private {
        maxVoucherAmount = maxVoucherAmount_;
        dailyOutflowCap = dailyOutflowCap_;
        accountDailyOutflowCap = accountDailyOutflowCap_;
        maxAttestationAge = maxAttestationAge_;
        emit LimitsUpdated(maxVoucherAmount_, dailyOutflowCap_, accountDailyOutflowCap_, maxAttestationAge_);
    }

    function _deletePendingLimits() private {
        delete pendingMaxVoucherAmount;
        delete pendingDailyOutflowCap;
        delete pendingAccountDailyOutflowCap;
        delete pendingMaxAttestationAge;
        delete pendingLimitsEta;
    }

    function _clearPendingLimits() private {
        if (pendingLimitsEta == 0) return;
        emit LimitsProposalCancelled(
            pendingMaxVoucherAmount, pendingDailyOutflowCap, pendingAccountDailyOutflowCap, pendingMaxAttestationAge
        );
        _deletePendingLimits();
    }

    function _applyHouseLimits(uint256 houseBufferBps_, uint256 houseDailyCap_) private {
        houseBufferBps = houseBufferBps_;
        houseDailyCap = houseDailyCap_;
        emit HouseLimitsUpdated(houseBufferBps_, houseDailyCap_);
    }

    function _clearPendingSignerChangeDelay() private {
        if (pendingSignerChangeDelayEta == 0) return;
        uint256 dropped = pendingSignerChangeDelay;
        delete pendingSignerChangeDelay;
        delete pendingSignerChangeDelayEta;
        emit SignerChangeDelayProposalCancelled(dropped);
    }

    function _clearPendingHouseLimits() private {
        if (pendingHouseLimitsEta == 0) return;
        uint256 bufferBps = pendingHouseBufferBps;
        uint256 cap = pendingHouseDailyCap;
        delete pendingHouseBufferBps;
        delete pendingHouseDailyCap;
        delete pendingHouseLimitsEta;
        emit HouseLimitsProposalCancelled(bufferBps, cap);
    }
}
