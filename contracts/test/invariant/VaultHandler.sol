// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {CheatBase} from "../utils/TestBase.sol";
import {MockOpenToken} from "../../src/MockOpenToken.sol";
import {MayaHouseVault} from "../../src/MayaHouseVault.sol";
import {IMayaHouseVault} from "../../src/interfaces/IMayaHouseVault.sol";

/// @notice Drives the vault the way the house server and players would, while keeping an honest
///         off-chain ledger model (balances, outstanding vouchers, house equity) as ghost state.
///         Every call either behaves exactly as the vault's rules predict or bumps a violation counter
///         that the invariant suite asserts is zero. The operator also rotates the ledger signer through
///         the timelock (between two known keys), tunes the house limits and sweeps donations.
contract VaultHandler is CheatBase {
    uint256 internal constant ONE = 10 ** 18;

    enum VoucherStatus {
        Outstanding,
        Redeemed,
        Recredited
    }

    struct Voucher {
        address account;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
        bytes signature;
        address signedBy;
        VoucherStatus status;
    }

    MayaHouseVault public vault;
    MockOpenToken public token;
    address public operator;
    uint256[2] internal signerKeys;
    uint256 internal activeKey;
    address[] internal actors;
    Voucher[] internal vouchers;

    // Off-chain ledger model (what the house server would attest).
    mapping(address => uint256) public ledgerBalance;
    uint256 public ledgerBalancesTotal;
    uint256 public outstandingVouchers;
    uint256 public houseEquity;

    // Mirrors of every successful on-chain flow.
    uint256 public ghostDeposits;
    uint256 public ghostHouseFunded;
    uint256 public ghostWithdrawals;
    uint256 public ghostHouseWithdrawn;
    uint256 public ghostDonations;
    uint256 public ghostSwept;
    uint256 public redemptions;
    uint256 public distinctNoncesRedeemed;
    uint64 public seq;
    mapping(address => mapping(uint256 => bool)) internal redeemedNonce;

    // Violation counters: all must stay zero.
    uint256 public replaySuccesses;
    uint256 public unexpectedOutcomes;
    uint256 public houseWithdrawBreaches;
    uint256 public capBreaches;
    string public lastUnexpected;

    // Coverage counters so a run's shape can be inspected.
    mapping(string kind => uint256 count) public hits;
    mapping(bytes32 kindAndSelector => uint256 count) public rejects;

    constructor(
        MayaHouseVault vault_,
        MockOpenToken token_,
        address operator_,
        uint256 signerPk_,
        uint256 spareSignerPk_,
        address[] memory actors_
    ) {
        vault = vault_;
        token = token_;
        operator = operator_;
        signerKeys = [signerPk_, spareSignerPk_];
        actors = actors_;
    }

    // ------------------------------------------------------------------ actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 held = token.balanceOf(actor);
        if (held == 0) return;
        amount = bound(amount, 1, _min(held, 1_000_000 * ONE));
        bool paused = vault.paused();
        vm.prank(actor);
        try vault.deposit(amount) {
            if (paused) {
                _unexpected("deposit while paused");
                return;
            }
            ghostDeposits += amount;
            ledgerBalance[actor] += amount; // the indexer credits the player
            ledgerBalancesTotal += amount;
            hits["deposit"]++;
        } catch (bytes memory reason) {
            if (!paused || _selector(reason) != Pausable.EnforcedPause.selector) {
                _unexpected("deposit reverted");
                return;
            }
            hits["deposit:paused"]++;
        }
    }

    function fundHouse(uint256 amount) public {
        uint256 held = token.balanceOf(operator);
        if (held == 0) return;
        amount = bound(amount, 1, _min(held, 5_000_000 * ONE));
        vm.prank(operator);
        vault.fundHouse(amount);
        ghostHouseFunded += amount;
        houseEquity += amount;
        hits["fundHouse"]++;
    }

    /// @dev Settles one off-chain bet instantly. Wins never exceed house equity (the engine's solvency rule).
    function bet(uint256 actorSeed, uint256 stake, uint256 x100, bool win) external {
        address actor = _actor(actorSeed);
        uint256 balance = ledgerBalance[actor];
        if (balance == 0) return;
        stake = bound(stake, 1, balance);
        if (win) {
            uint256 profit = _min((stake * bound(x100, 101, 5_000)) / 100 - stake, houseEquity);
            ledgerBalance[actor] += profit;
            ledgerBalancesTotal += profit;
            houseEquity -= profit;
            hits["bet:win"]++;
        } else {
            ledgerBalance[actor] -= stake;
            ledgerBalancesTotal -= stake;
            houseEquity += stake;
            hits["bet:loss"]++;
        }
    }

    function requestVoucher(uint256 actorSeed, uint256 amount, uint256 ttl) external {
        address actor = _actor(actorSeed);
        uint256 cap = _min(ledgerBalance[actor], vault.maxVoucherAmount());
        if (cap == 0) return;
        amount = bound(amount, 1, cap);
        uint256 nonce = uint256(keccak256(abi.encode(actor, vouchers.length)));
        uint256 expiry = block.timestamp + bound(ttl, 0, 2 days);
        // The server signs with the key it holds; after a rotation that is the vault's current signer.
        uint256 key = signerKeys[activeKey];
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, vault.hashWithdrawal(actor, amount, nonce, expiry));
        vouchers.push(
            Voucher({
                account: actor,
                amount: amount,
                nonce: nonce,
                expiry: expiry,
                signature: abi.encodePacked(r, s, v),
                signedBy: vm.addr(key),
                status: VoucherStatus.Outstanding
            })
        );
        ledgerBalance[actor] -= amount;
        ledgerBalancesTotal -= amount;
        outstandingVouchers += amount;
        hits["requestVoucher"]++;
    }

    function redeemVoucher(uint256 indexSeed) external {
        if (vouchers.length == 0) return;
        Voucher storage voucher = vouchers[indexSeed % vouchers.length];
        if (voucher.status != VoucherStatus.Outstanding) return;

        uint256 day = block.timestamp / 1 days;
        bool expired = block.timestamp > voucher.expiry;
        bytes4 expected;
        if (vault.paused()) {
            expected = Pausable.EnforcedPause.selector;
        } else if (expired) {
            expected = IMayaHouseVault.VoucherExpired.selector;
        } else if (voucher.amount > vault.maxVoucherAmount()) {
            expected = IMayaHouseVault.VoucherAboveMax.selector;
        } else if (voucher.signedBy != vault.ledgerSigner()) {
            expected = IMayaHouseVault.InvalidSignature.selector; // rotated away: may pay again if rotated back
        } else if (vault.dailyOutflow(day) + voucher.amount > vault.dailyOutflowCap()) {
            expected = IMayaHouseVault.DailyOutflowCapExceeded.selector;
        } else if (vault.accountDailyOutflow(day, voucher.account) + voucher.amount > vault.accountDailyOutflowCap()) {
            expected = IMayaHouseVault.AccountDailyOutflowCapExceeded.selector;
        }
        if (vault.nonceUsed(voucher.account, voucher.nonce)) {
            _unexpected("outstanding nonce already used");
            return;
        }

        vm.prank(voucher.account);
        try vault.withdraw(voucher.amount, voucher.nonce, voucher.expiry, voucher.signature) {
            if (expected != bytes4(0)) {
                _unexpected("withdraw should have reverted");
                return;
            }
            voucher.status = VoucherStatus.Redeemed;
            outstandingVouchers -= voucher.amount;
            ghostWithdrawals += voucher.amount;
            redemptions++;
            if (!redeemedNonce[voucher.account][voucher.nonce]) {
                redeemedNonce[voucher.account][voucher.nonce] = true;
                distinctNoncesRedeemed++;
            }
            if (!vault.nonceUsed(voucher.account, voucher.nonce)) _unexpected("nonce not marked used");
            if (vault.dailyOutflow(day) > vault.dailyOutflowCap()) capBreaches++;
            if (vault.accountDailyOutflow(day, voucher.account) > vault.accountDailyOutflowCap()) capBreaches++;
            hits["withdraw"]++;
        } catch (bytes memory reason) {
            if (expected == bytes4(0) || _selector(reason) != expected) {
                _unexpected("withdraw reverted");
                return;
            }
            rejects[keccak256(abi.encode("withdraw:reverted", expected))]++;
        }

        // An expired voucher can never pay out again (time only moves forward): the ledger re-credits it.
        if (expired && voucher.status == VoucherStatus.Outstanding) {
            voucher.status = VoucherStatus.Recredited;
            outstandingVouchers -= voucher.amount;
            ledgerBalance[voucher.account] += voucher.amount;
            ledgerBalancesTotal += voucher.amount;
            hits["voucher:recredited"]++;
        }
    }

    function replayVoucher(uint256 indexSeed) external {
        if (vouchers.length == 0) return;
        Voucher storage voucher = vouchers[indexSeed % vouchers.length];
        if (voucher.status != VoucherStatus.Redeemed) return;
        vm.prank(voucher.account);
        try vault.withdraw(voucher.amount, voucher.nonce, voucher.expiry, voucher.signature) {
            replaySuccesses++;
        } catch {
            hits["replay:blocked"]++;
        }
    }

    /// @dev Honest attestation of the ledger model; `asOf` may lag the block by up to 30 s.
    function attest(uint256 lag) external {
        seq += 1;
        uint64 asOf = uint64(block.timestamp - bound(lag, 0, 30));
        vm.prank(vm.addr(signerKeys[activeKey]));
        vault.attest(ledgerBalancesTotal + outstandingVouchers, keccak256(abi.encode(seq)), asOf, seq);
        hits["attest"]++;
    }

    function withdrawHouse(uint256 amount, bool overdraw) external {
        uint256 surplus = vault.houseSurplus();
        uint256 buffer = vault.houseBuffer();
        uint256 withdrawable = surplus > buffer ? surplus - buffer : 0;
        uint256 capLeft = vault.remainingHouseDailyOutflow();
        bytes4 expected;
        if (vault.paused()) {
            expected = Pausable.EnforcedPause.selector;
        } else if (vault.attestationSeq() == 0) {
            expected = IMayaHouseVault.NoAttestation.selector;
        } else if (vault.attestationSigner() != vault.ledgerSigner()) {
            expected = IMayaHouseVault.AttestationBySupersededSigner.selector;
        } else if (vault.attestationAge() > vault.maxAttestationAge()) {
            expected = IMayaHouseVault.AttestationTooOld.selector;
        }

        if (overdraw) {
            // Probe the gates: anything above the surplus, into the buffer or past the daily cap is refused.
            amount = bound(amount, withdrawable + 1, surplus + 1_000_000 * ONE);
            if (expected == bytes4(0)) {
                expected = amount > surplus
                    ? IMayaHouseVault.ExceedsHouseSurplus.selector
                    : IMayaHouseVault.ExceedsHouseWithdrawable.selector;
            }
        } else {
            // Server discipline: never take more than the off-chain house equity either.
            uint256 limit = _min(_min(withdrawable, houseEquity), capLeft + 1_000 * ONE);
            if (limit == 0) return;
            amount = bound(amount, 1, limit);
            if (expected == bytes4(0) && amount > capLeft) expected = IMayaHouseVault.HouseDailyCapExceeded.selector;
        }

        uint256 required = vault.requiredAssets();
        vm.prank(operator);
        try vault.withdrawHouse(amount, operator) {
            if (expected != bytes4(0)) {
                houseWithdrawBreaches++;
                return;
            }
            ghostHouseWithdrawn += amount;
            houseEquity -= amount;
            if (vault.assets() < required + buffer) houseWithdrawBreaches++;
            if (vault.houseDailyOutflow(block.timestamp / 1 days) > vault.houseDailyCap()) capBreaches++;
            hits["withdrawHouse"]++;
        } catch (bytes memory reason) {
            if (expected == bytes4(0) || _selector(reason) != expected) {
                _unexpected("withdrawHouse reverted");
                return;
            }
            rejects[keccak256(abi.encode("withdrawHouse:reverted", expected))]++;
        }
    }

    function togglePause() external {
        bool paused = vault.paused();
        vm.prank(operator);
        if (paused) vault.unpause();
        else vault.pause();
        hits["togglePause"]++;
    }

    /// @dev Lowering every limit applies at once; raising any is scheduled and accepted by a later call once due
    ///      (and before it expires).
    function setLimits(uint256 maxVoucher, uint256 cap, uint256 accountCap, uint256 maxAge) external {
        uint256 eta = vault.pendingLimitsEta();
        if (eta != 0 && block.timestamp >= eta && block.timestamp <= eta + vault.TIMELOCK_GRACE_PERIOD()) {
            vm.prank(operator);
            vault.acceptLimits();
            hits["limits:accepted"]++;
            return;
        }
        maxVoucher = bound(maxVoucher, 1_000 * ONE, 100_000 * ONE);
        cap = bound(cap, maxVoucher, 500_000 * ONE);
        accountCap = bound(accountCap, maxVoucher, cap);
        maxAge = bound(maxAge, 10 minutes, 1 days);
        bool tightening = maxVoucher <= vault.maxVoucherAmount() && cap <= vault.dailyOutflowCap()
            && accountCap <= vault.accountDailyOutflowCap() && maxAge <= vault.maxAttestationAge();
        vm.prank(operator);
        vault.setLimits(maxVoucher, cap, accountCap, maxAge);
        bool applied = vault.maxVoucherAmount() == maxVoucher && vault.dailyOutflowCap() == cap
            && vault.accountDailyOutflowCap() == accountCap && vault.maxAttestationAge() == maxAge;
        if (tightening != applied || tightening != (vault.pendingLimitsEta() == 0)) {
            _unexpected("limits applied against the timelock rule");
            return;
        }
        hits[tightening ? "setLimits" : "limits:scheduled"]++;
    }

    /// @dev Tightening applies at once; loosening is scheduled and accepted by a later call once due.
    function setHouseLimits(uint256 bufferBps, uint256 cap) external {
        uint256 eta = vault.pendingHouseLimitsEta();
        if (eta != 0 && block.timestamp >= eta && block.timestamp <= eta + vault.TIMELOCK_GRACE_PERIOD()) {
            vm.prank(operator);
            vault.acceptHouseLimits();
            hits["houseLimits:accepted"]++;
            return;
        }
        bufferBps = bound(bufferBps, 0, 5_000);
        cap = bound(cap, 100 * ONE, 20_000_000 * ONE);
        bool tightening = bufferBps >= vault.houseBufferBps() && cap <= vault.houseDailyCap();
        vm.prank(operator);
        vault.setHouseLimits(bufferBps, cap);
        if (tightening != (vault.houseBufferBps() == bufferBps && vault.houseDailyCap() == cap)) {
            _unexpected("house limits applied against the timelock rule");
            return;
        }
        hits[tightening ? "houseLimits:tightened" : "houseLimits:scheduled"]++;
    }

    /// @dev Proposes the other known key (again, once a pending proposal has expired), waits `wait` seconds,
    ///      then tries to accept: only possible from the eta through eta + TIMELOCK_GRACE_PERIOD.
    function rotateSigner(uint256 wait) external {
        uint256 other = 1 - activeKey;
        address next = vm.addr(signerKeys[other]);
        uint256 grace = vault.TIMELOCK_GRACE_PERIOD();
        if (vault.pendingLedgerSigner() != next || block.timestamp > vault.pendingLedgerSignerEta() + grace) {
            vm.prank(operator);
            vault.proposeLedgerSigner(next);
        }
        uint256 eta = vault.pendingLedgerSignerEta();
        vm.warp(block.timestamp + bound(wait, 0, 3 days));
        vm.roll(block.number + 1);
        bool early = block.timestamp < eta;
        bool expired = block.timestamp > eta + grace;
        vm.prank(operator);
        try vault.acceptLedgerSigner() {
            if (early || expired) {
                _unexpected("rotation accepted outside its window");
                return;
            }
            activeKey = other;
            hits["rotate:accepted"]++;
        } catch (bytes memory reason) {
            bytes4 want = early ? IMayaHouseVault.TimelockNotElapsed.selector : IMayaHouseVault.ProposalExpired.selector;
            if (!(early || expired) || _selector(reason) != want) {
                _unexpected("rotation refused unexpectedly");
                return;
            }
            hits[early ? "rotate:pending" : "rotate:expired"]++;
        }
    }

    /// @dev Raw transfer to the vault: must never be counted as assets.
    function donate(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 held = token.balanceOf(actor);
        if (held == 0) return;
        amount = bound(amount, 1, _min(held, 10_000 * ONE));
        vm.prank(actor);
        if (!token.transfer(address(vault), amount)) {
            _unexpected("donation failed");
            return;
        }
        ghostDonations += amount;
        hits["donate"]++;
    }

    /// @dev The owner may only ever take the donations back, never accounted assets.
    function sweep() external {
        uint256 stray = ghostDonations - ghostSwept;
        uint256 assetsBefore = vault.assets();
        vm.prank(operator);
        try vault.sweepExcess(operator) returns (uint256 swept) {
            if (swept != stray || vault.assets() != assetsBefore) {
                _unexpected("sweep took more than the stray tokens");
                return;
            }
            ghostSwept += swept;
            hits["sweep"]++;
        } catch (bytes memory reason) {
            if (stray != 0 || _selector(reason) != IMayaHouseVault.NothingToSweep.selector) {
                _unexpected("sweep reverted");
                return;
            }
            hits["sweep:nothing"]++;
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 12 hours));
        vm.roll(block.number + 1);
        hits["warp"]++;
    }

    // ------------------------------------------------------------------ views for the invariant suite

    function trueLiabilities() external view returns (uint256) {
        return ledgerBalancesTotal + outstandingVouchers;
    }

    function voucherCount() external view returns (uint256) {
        return vouchers.length;
    }

    function activeSigner() external view returns (address) {
        return vm.addr(signerKeys[activeKey]);
    }

    // ------------------------------------------------------------------ internals

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _unexpected(string memory reason) internal {
        unexpectedOutcomes++;
        lastUnexpected = reason;
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 selector) {
        if (reason.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(reason, 0x20))
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
