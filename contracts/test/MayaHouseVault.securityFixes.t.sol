// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {BalanceTree} from "./utils/BalanceTree.sol";
import {IMayaHouseVault} from "../src/interfaces/IMayaHouseVault.sol";

/// @notice Regression tests for the contracts-security review of the SPEC-11 vault (CS-H1, CS-M1, CS-M2, CS-L1,
///         CS-L2, CS-L4). Each test replays the reviewer's failure scenario and asserts the fixed behaviour; every
///         one of them fails against the pre-fix vault (most do not even compile against it: the selectors and
///         functions they use are new).
contract MayaHouseVaultSecurityFixesTest is VaultFixture {
    uint256 internal constant BANKROLL = 100_000_000 * ONE; // the deploy flow's default house funding
    address internal attacker;
    address internal stranger;
    address internal whale;
    uint256 internal newSignerPk;
    address internal newSigner;

    function setUp() public override {
        super.setUp();
        attacker = makeAddr("attacker");
        stranger = makeAddr("stranger");
        whale = makeAddr("whale");
        newSignerPk = keyFor("ledger-signer-2");
        newSigner = vm.addr(newSignerPk);
        _fund(BANKROLL);
    }

    // ================================================================ CS-H1: seq exhaustion by a leaked signer key

    function test_CSH1_leakedSignerCannotJumpSeqToUint64Max() public {
        (bytes32 honestRoot,) = _honestRoot(); // seq 1
        uint64 maxStep = vault.MAX_ATTESTATION_SEQ_STEP();
        bytes32 evilRoot = vault.balanceLeaf(attacker, vault.assets());
        vm.warp(block.timestamp + 60);

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SeqStepTooLarge.selector, type(uint64).max, 1, maxStep));
        vm.prank(signer);
        vault.attest(type(uint256).max, evilRoot, uint64(block.timestamp), type(uint64).max);

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SeqStepTooLarge.selector, maxStep + 2, 1, maxStep));
        vm.prank(signer);
        vault.attest(type(uint256).max, evilRoot, uint64(block.timestamp), maxStep + 2);

        assertEq(vault.attestationSeq(), 1, "seq unchanged");
        assertEq(vault.attestedLedgerRoot(), honestRoot, "root unchanged");
    }

    function test_CSH1_seqGapsUpToTheStepStayAllowed() public {
        uint64 maxStep = vault.MAX_ATTESTATION_SEQ_STEP();
        _attest(0, uint64(block.timestamp), maxStep); // first attestation: 0 -> maxStep is exactly one step
        _attest(0, uint64(block.timestamp), 2 * maxStep);
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.SeqStepTooLarge.selector, 3 * maxStep + 1, 2 * maxStep, maxStep)
        );
        vm.prank(signer);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 3 * maxStep + 1);
        _attest(0, uint64(block.timestamp), 2 * maxStep + 1);
        assertEq(vault.attestationSeq(), 2 * maxStep + 1, "consecutive seq still works");
    }

    /// @dev The reviewer's failure scenario with the largest seq jump the vault still accepts: the documented
    ///      response (pause, then a 48 h rotation) now restores the honest root and no one can steal the vault.
    function test_CSH1_pauseAndRotationContainALeakedSigner() public {
        (bytes32 honestRoot, BalanceTree.Tree memory honest) = _honestRoot();
        uint256 vaultAssets = vault.assets();
        vm.warp(block.timestamp + 60);
        bytes32 evilRoot = vault.balanceLeaf(attacker, vaultAssets);
        uint64 evilSeq = vault.attestationSeq() + vault.MAX_ATTESTATION_SEQ_STEP();
        vm.prank(signer);
        vault.attest(type(uint256).max, evilRoot, uint64(block.timestamp), evilSeq);

        // The honest server with the same key can still supersede it (seq + 1 is always reachable).
        vm.prank(signer);
        vault.attest(3_000_000 * ONE, honestRoot, uint64(block.timestamp), evilSeq + 1);
        assertEq(vault.attestedLedgerRoot(), honestRoot, "honest server overrides the evil root");
        vm.prank(signer);
        vault.attest(type(uint256).max, evilRoot, uint64(block.timestamp), evilSeq + 2); // the attacker again

        // Runbook: pause at once, rotate through the timelock.
        vm.startPrank(operator);
        vault.pause();
        vault.proposeLedgerSigner(newSigner);
        vm.warp(vault.pendingLedgerSignerEta());
        vault.acceptLedgerSigner();
        vm.stopPrank();

        // The leaked key is dead; the new signer restores the honest root.
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NotLedgerSigner.selector, signer));
        vm.prank(signer);
        vault.attest(type(uint256).max, evilRoot, uint64(block.timestamp), evilSeq + 3);
        vm.prank(newSigner);
        vault.attest(3_000_000 * ONE, honestRoot, uint64(block.timestamp), evilSeq + 3);
        assertEq(vault.attestedLedgerRoot(), honestRoot, "honest root restored");

        // Even if the house then dies and a stranger triggers escape, the frozen root is the honest one.
        vm.warp(vault.escapeAvailableAt());
        vm.prank(stranger);
        vault.triggerEscape();
        assertEq(vault.attestedLedgerRoot(), honestRoot, "honest root frozen");
        assertEq(vault.escapePool(), 3_000_000 * ONE, "pool = honest obligations, not the whole vault");
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vm.prank(attacker);
        vault.claimEscape(vaultAssets, new bytes32[](0));
        vm.prank(alice);
        assertEq(vault.claimEscape(1_000_000 * ONE, BalanceTree.proof(honest, 0)), 1_000_000 * ONE, "alice whole");
        vm.prank(bob);
        assertEq(vault.claimEscape(2_000_000 * ONE, BalanceTree.proof(honest, 1)), 2_000_000 * ONE, "bob whole");
        assertEq(token.balanceOf(attacker), 0, "attacker got nothing");
    }

    /// @dev A late response: the owner only accepts the rotation 6 days after the leaked key's last attestation.
    ///      The new signer still gets a full escape window, so the root attested by the key it replaced cannot be
    ///      frozen one day later.
    function test_CSH1_aNewSignerGetsAFullEscapeWindow() public {
        _honestRoot();
        uint256 evilAt = block.timestamp + 60;
        vm.warp(evilAt);
        bytes32 evilRoot = vault.balanceLeaf(attacker, vault.assets());
        _attestRoot(type(uint256).max, evilRoot, SafeCast.toUint64(evilAt));

        vm.warp(evilAt + 4 days);
        vm.prank(operator);
        vault.proposeLedgerSigner(newSigner);
        vm.warp(vault.pendingLedgerSignerEta()); // evilAt + 6 days
        vm.prank(operator);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSignerSince(), evilAt + 6 days, "term start");
        assertEq(vault.lastAttestationAt(), evilAt, "the last attestation is still the leaked key's");
        assertEq(vault.escapeAvailableAt(), evilAt + 6 days + ESCAPE_DELAY, "clock restarted by the rotation");

        vm.warp(evilAt + ESCAPE_DELAY); // the evil root is 7 days old
        vm.expectRevert(
            abi.encodeWithSelector(
                IMayaHouseVault.EscapeNotYetAvailable.selector, evilAt + 6 days + ESCAPE_DELAY, evilAt + ESCAPE_DELAY
            )
        );
        vm.prank(attacker);
        vault.triggerEscape();

        // A later attestation moves the clock as before.
        vm.warp(evilAt + 8 days);
        uint64 nextSeq = vault.attestationSeq() + 1;
        vm.prank(newSigner);
        vault.attest(3_000_000 * ONE, bytes32(uint256(1)), uint64(block.timestamp), nextSeq);
        assertEq(vault.escapeAvailableAt(), evilAt + 8 days + ESCAPE_DELAY, "attestation clock");
    }

    // ================================================================ CS-M1: bankroll stranded by escape mode

    function test_CSM1_ownerRecoversTheUnclaimableBankrollAfterEscape() public {
        _deposit(alice, 1_000 * ONE);
        _deposit(bob, 2_000 * ONE);
        vm.warp(vault.deployedAt() + ESCAPE_DELAY); // the deploy flow never attested
        vm.prank(stranger);
        vault.triggerEscape();
        assertEq(vault.escapePool(), 3_000 * ONE, "pool = player deposits");
        assertEq(vault.escapeSurplus(), BANKROLL, "the bankroll is beyond every possible claim");

        uint256 before = token.balanceOf(operator);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.EscapeSurplusRecovered(operator, BANKROLL);
        vm.prank(operator);
        assertEq(vault.recoverEscapeSurplus(operator), BANKROLL, "recovered");
        assertEq(token.balanceOf(operator) - before, BANKROLL, "tokens moved");
        assertEq(vault.houseWithdrawn(), BANKROLL, "booked as a house withdrawal");
        assertEq(vault.assets(), 3_000 * ONE, "only the pool stays");
        assertEq(vault.escapeSurplus(), 0, "nothing left to recover");
        vm.expectRevert(IMayaHouseVault.NothingToRecover.selector);
        vm.prank(operator);
        vault.recoverEscapeSurplus(operator);

        // Players are paid exactly as before the recovery.
        vm.prank(alice);
        assertEq(vault.claimEscape(0, new bytes32[](0)), 1_000 * ONE, "alice");
        vm.prank(bob);
        assertEq(vault.claimEscape(0, new bytes32[](0)), 2_000 * ONE, "bob");
        assertEq(vault.assets(), 0, "empty");
        assertEq(token.balanceOf(address(vault)), 0, "no tokens stranded");
    }

    function test_CSM1_recoveryLeavesExactlyTheUnclaimedPoolAfterPartialClaims() public {
        (, BalanceTree.Tree memory honest) = _honestRoot();
        vm.warp(block.timestamp + 1);
        _deposit(carol, 500 * ONE); // after the root: owed on top of it
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        assertEq(vault.escapePool(), 3_000_500 * ONE, "attested + unattested deposits");
        vm.prank(alice);
        vault.claimEscape(1_000_000 * ONE, BalanceTree.proof(honest, 0));

        vm.prank(operator);
        vault.pause(); // recovery does not depend on the pause state
        vm.prank(operator);
        uint256 recovered = vault.recoverEscapeSurplus(operator);
        assertEq(recovered, BANKROLL, "the bankroll, not a wei of the unclaimed pool");
        assertEq(vault.assets(), vault.escapePool() - vault.escapeClaimedTotal(), "assets = unclaimed pool");

        vm.prank(bob);
        assertEq(vault.claimEscape(2_000_000 * ONE, BalanceTree.proof(honest, 1)), 2_000_000 * ONE, "bob whole");
        vm.prank(carol);
        assertEq(vault.claimEscape(0, new bytes32[](0)), 500 * ONE, "carol whole");
        assertEq(vault.assets(), 0, "every claim paid, nothing stranded");
    }

    function test_CSM1_recoveryIsOwnerOnlyAndOnlyInEscapeMode() public {
        assertEq(vault.escapeSurplus(), 0, "no escape surplus while live");
        vm.expectRevert(IMayaHouseVault.EscapeModeInactive.selector);
        vm.prank(operator);
        vault.recoverEscapeSurplus(operator);

        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.recoverEscapeSurplus(stranger);
        vm.startPrank(operator);
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vault.recoverEscapeSurplus(address(0));
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidRecipient.selector, address(vault)));
        vault.recoverEscapeSurplus(address(vault));
        vm.stopPrank();
    }

    // ================================================================ CS-M2: one account drains the shared cap

    /// @dev The reviewer's whale redeems vouchers at every UTC midnight and recycles the capital; it now hits its
    ///      own share of the cap and every other player keeps withdrawing.
    function test_CSM2_oneAccountCanNoLongerBlockEveryoneElse() public {
        vm.prank(operator);
        assertTrue(token.transfer(whale, 1_000_000 * ONE), "fund whale");
        _approve(whale);
        _deposit(alice, 5_000 * ONE);
        _deposit(whale, 1_000_000 * ONE);
        uint256 share = vault.accountDailyOutflowCap();
        assertEq(share, 250_000 * ONE, "default per-account share");

        for (uint256 d; d < 3; ++d) {
            uint256 dayStart = (block.timestamp / 1 days + 1) * 1 days;
            uint256 expiry = dayStart + 30 minutes;
            bytes[] memory sigs = new bytes[](10);
            for (uint256 i; i < 10; ++i) {
                sigs[i] = _voucher(whale, 100_000 * ONE, 1_000 * (d + 1) + i, expiry);
            }
            vm.warp(dayStart);
            uint256 day = dayStart / 1 days;
            vm.startPrank(whale);
            vault.withdraw(100_000 * ONE, 1_000 * (d + 1), expiry, sigs[0]);
            vault.withdraw(100_000 * ONE, 1_000 * (d + 1) + 1, expiry, sigs[1]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IMayaHouseVault.AccountDailyOutflowCapExceeded.selector, whale, day, 100_000 * ONE, 50_000 * ONE
                )
            );
            vault.withdraw(100_000 * ONE, 1_000 * (d + 1) + 2, expiry, sigs[2]);
            vm.stopPrank();
            assertEq(vault.remainingAccountDailyOutflow(whale), 50_000 * ONE, "whale: its share is used up");
            assertEq(vault.remainingDailyOutflow(), 800_000 * ONE, "the shared cap is not exhausted");

            vm.warp(block.timestamp + 2 hours);
            _withdraw(alice, 100 * ONE, d + 1, block.timestamp + 1 hours);
            _deposit(whale, 200_000 * ONE); // the whale recycles what it got out
        }
        assertEq(vault.playerWithdrawalsOf(alice), 300 * ONE, "alice got out every day");
    }

    function test_CSM2_accountShareIsPerAccountAndPerUtcDay() public {
        _applyLimits(100 * ONE, 1_000 * ONE, 250 * ONE, 10 minutes);
        uint256 day = block.timestamp / 1 days;
        uint256 expiry = (day + 3) * 1 days;
        _withdraw(alice, 100 * ONE, 1, expiry);
        _withdraw(alice, 100 * ONE, 2, expiry);
        assertEq(vault.accountDailyOutflow(day, alice), 200 * ONE, "alice today");
        assertEq(vault.remainingAccountDailyOutflow(alice), 50 * ONE, "alice's remaining share");
        bytes memory sig = _voucher(alice, 100 * ONE, 3, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMayaHouseVault.AccountDailyOutflowCapExceeded.selector, alice, day, 100 * ONE, 50 * ONE
            )
        );
        vm.prank(alice);
        vault.withdraw(100 * ONE, 3, expiry, sig);
        assertFalse(vault.nonceUsed(alice, 3), "a refused voucher stays redeemable later");

        _withdraw(bob, 100 * ONE, 1, expiry); // another account has its own share
        assertEq(vault.remainingAccountDailyOutflow(bob), 150 * ONE, "bob's remaining share");

        vm.warp((day + 1) * 1 days); // 00:00 UTC: a fresh share
        vm.prank(alice);
        vault.withdraw(100 * ONE, 3, expiry, sig);
        assertEq(vault.accountDailyOutflow(day + 1, alice), 100 * ONE, "alice's new day");

        // The remaining-share view is bounded by the shared cap too.
        _applyLimits(100 * ONE, 150 * ONE, 150 * ONE, 10 minutes);
        assertEq(vault.remainingDailyOutflow(), 50 * ONE, "shared cap left");
        assertEq(vault.remainingAccountDailyOutflow(bob), 50 * ONE, "min(own share, shared cap)");
        assertEq(vault.remainingAccountDailyOutflow(alice), 50 * ONE, "min(own share, shared cap)");
    }

    // ================================================================ CS-L1: instant loosening of setLimits

    function test_CSL1_raisingMaxAttestationAgeWaitsTheTimelock() public {
        _deposit(alice, 1_000 * ONE);
        _attestNow(1_000 * ONE);
        vm.warp(block.timestamp + 23 hours);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.AttestationTooOld.selector, 23 hours, 10 minutes));
        vm.prank(operator);
        vault.withdrawHouse(1_000_000 * ONE, operator);

        uint256 eta = block.timestamp + SIGNER_DELAY;
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsProposed(100_000 * ONE, 1_000_000 * ONE, 250_000 * ONE, 1 days, eta);
        vm.startPrank(operator);
        vault.setLimits(vault.maxVoucherAmount(), vault.dailyOutflowCap(), vault.accountDailyOutflowCap(), 1 days);
        assertEq(vault.maxAttestationAge(), 10 minutes, "not applied");
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.AttestationTooOld.selector, 23 hours, 10 minutes));
        vault.withdrawHouse(1_000_000 * ONE, operator); // the reviewer's same-block withdrawal fails
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, eta, block.timestamp));
        vault.acceptLimits();
        vm.stopPrank();

        vm.warp(eta);
        vm.prank(operator);
        vault.acceptLimits();
        assertEq(vault.maxAttestationAge(), 1 days, "applied after the public notice");
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.AttestationTooOld.selector, 23 hours + SIGNER_DELAY, 1 days)
        );
        vm.prank(operator);
        vault.withdrawHouse(1_000_000 * ONE, operator); // by then the old attestation is too old anyway
    }

    function test_CSL1_raisingPlayerLimitsIsTimelockedAndTighteningIsInstant() public {
        vm.startPrank(operator);
        // Tightening every value (or keeping it) applies at once.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsUpdated(50_000 * ONE, 500_000 * ONE, 250_000 * ONE, 5 minutes);
        vault.setLimits(50_000 * ONE, 500_000 * ONE, 250_000 * ONE, 5 minutes);
        assertEq(vault.pendingLimitsEta(), 0, "applied");

        // Raising any single one is scheduled: voucher size, shared cap, per-account share, freshness.
        uint256[4][4] memory raises = [
            [60_000 * ONE, 500_000 * ONE, 250_000 * ONE, 5 minutes],
            [50_000 * ONE, 600_000 * ONE, 250_000 * ONE, 5 minutes],
            [50_000 * ONE, 500_000 * ONE, 300_000 * ONE, 5 minutes],
            [50_000 * ONE, 500_000 * ONE, 250_000 * ONE, 6 minutes]
        ];
        for (uint256 i; i < 4; ++i) {
            vault.setLimits(raises[i][0], raises[i][1], raises[i][2], raises[i][3]);
            assertEq(vault.pendingLimitsEta(), block.timestamp + SIGNER_DELAY, "scheduled");
            assertEq(vault.maxVoucherAmount(), 50_000 * ONE, "unchanged");
            assertEq(vault.dailyOutflowCap(), 500_000 * ONE, "unchanged");
            assertEq(vault.accountDailyOutflowCap(), 250_000 * ONE, "unchanged");
            assertEq(vault.maxAttestationAge(), 5 minutes, "unchanged");
        }

        // A mixed change (one value down, one up) is a loosening too; any call replaces the pending one.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsProposalCancelled(50_000 * ONE, 500_000 * ONE, 250_000 * ONE, 6 minutes);
        vault.setLimits(10_000 * ONE, 900_000 * ONE, 250_000 * ONE, 5 minutes);
        assertEq(vault.pendingDailyOutflowCap(), 900_000 * ONE, "replaced");
        // A tightening call drops the pending loosening and applies at once.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsProposalCancelled(10_000 * ONE, 900_000 * ONE, 250_000 * ONE, 5 minutes);
        vault.setLimits(40_000 * ONE, 400_000 * ONE, 200_000 * ONE, 5 minutes);
        assertEq(vault.pendingLimitsEta(), 0, "nothing pending");
        assertEq(vault.dailyOutflowCap(), 400_000 * ONE, "tightened");

        vm.expectRevert(IMayaHouseVault.NoPendingLimits.selector);
        vault.acceptLimits();
        vm.expectRevert(IMayaHouseVault.NoPendingLimits.selector);
        vault.cancelLimits();
        vault.setLimits(40_000 * ONE, 400_000 * ONE, 200_000 * ONE, 1 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsProposalCancelled(40_000 * ONE, 400_000 * ONE, 200_000 * ONE, 1 hours);
        vault.cancelLimits();
        assertEq(vault.pendingLimitsEta(), 0, "cancelled");
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.acceptLimits();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.cancelLimits();
    }

    // ================================================================ CS-L2: timelocked proposals never expired

    function test_CSL2_staleProposalsExpire() public {
        vm.startPrank(operator);
        vault.proposeLedgerSigner(newSigner);
        vault.setHouseLimits(0, type(uint256).max);
        vault.setSignerChangeDelay(1 hours);
        vault.setLimits(100_000 * ONE, 1_000_000 * ONE, 250_000 * ONE, 1 days);
        vm.stopPrank();
        uint256 eta = START + SIGNER_DELAY;
        uint256 expiredAt = eta + vault.TIMELOCK_GRACE_PERIOD();

        vm.warp(START + 365 days);
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ProposalExpired.selector, expiredAt, block.timestamp));
        vault.acceptLedgerSigner();
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ProposalExpired.selector, expiredAt, block.timestamp));
        vault.acceptHouseLimits();
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ProposalExpired.selector, expiredAt, block.timestamp));
        vault.acceptSignerChangeDelay();
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ProposalExpired.selector, expiredAt, block.timestamp));
        vault.acceptLimits();
        vm.stopPrank();
        assertEq(vault.ledgerSigner(), signer, "signer unchanged");
        assertEq(vault.houseBufferBps(), 1_000, "buffer unchanged");
        assertEq(vault.houseDailyCap(), 10_000_000 * ONE, "cap unchanged");
        assertEq(vault.signerChangeDelay(), SIGNER_DELAY, "delay unchanged");
        assertEq(vault.maxAttestationAge(), 10 minutes, "age unchanged");
    }

    function test_CSL2_acceptableThroughTheLastSecondOfTheGracePeriod() public {
        vm.startPrank(operator);
        vault.proposeLedgerSigner(newSigner);
        vault.setHouseLimits(0, type(uint256).max);
        vault.setSignerChangeDelay(1 hours);
        vault.setLimits(100_000 * ONE, 1_000_000 * ONE, 250_000 * ONE, 1 days);
        vm.stopPrank();
        uint256 expiredAt = START + SIGNER_DELAY + vault.TIMELOCK_GRACE_PERIOD();

        vm.warp(expiredAt);
        vm.startPrank(operator);
        vault.acceptLedgerSigner();
        vault.acceptHouseLimits();
        vault.acceptSignerChangeDelay();
        vault.acceptLimits();
        vm.stopPrank();
        assertEq(vault.ledgerSigner(), newSigner, "rotated");
        assertEq(vault.houseBufferBps(), 0, "house limits");
        assertEq(vault.signerChangeDelay(), 1 hours, "delay");
        assertEq(vault.maxAttestationAge(), 1 days, "limits");
    }

    function test_CSL2_anExpiredProposalMustBeProposedAgainWithFreshNotice() public {
        vm.prank(operator);
        vault.proposeLedgerSigner(newSigner);
        uint256 expiredAt = START + SIGNER_DELAY + vault.TIMELOCK_GRACE_PERIOD();
        vm.warp(expiredAt + 1);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ProposalExpired.selector, expiredAt, expiredAt + 1));
        vm.prank(operator);
        vault.acceptLedgerSigner();

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposalCancelled(newSigner);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposed(signer, newSigner, expiredAt + 1 + SIGNER_DELAY);
        vm.prank(operator);
        vault.proposeLedgerSigner(newSigner);
        vm.warp(expiredAt + 1 + SIGNER_DELAY);
        vm.prank(operator);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSigner(), newSigner, "rotated after fresh notice");
    }

    // ================================================================ CS-L4: silent replacement of a signer proposal

    function test_CSL4_replacingASignerProposalEmitsItsCancellation() public {
        address a = vm.addr(keyFor("proposal-a"));
        address b = vm.addr(keyFor("proposal-b"));
        vm.prank(operator);
        vault.proposeLedgerSigner(a);
        vm.warp(START + 1 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposalCancelled(a);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposed(signer, b, START + 1 hours + SIGNER_DELAY);
        vm.prank(operator);
        vault.proposeLedgerSigner(b);
        assertEq(vault.pendingLedgerSigner(), b, "replaced");
    }

    // ================================================================ helpers

    /// @dev alice 1M and bob 2M deposited, then an honest root (seq 1) over exactly those balances.
    function _honestRoot() internal returns (bytes32 root, BalanceTree.Tree memory tree) {
        _deposit(alice, 1_000_000 * ONE);
        _deposit(bob, 2_000_000 * ONE);
        vm.warp(block.timestamp + 1);
        address[] memory accounts = new address[](2);
        uint256[] memory balances = new uint256[](2);
        accounts[0] = alice;
        balances[0] = 1_000_000 * ONE;
        accounts[1] = bob;
        balances[1] = 2_000_000 * ONE;
        tree = BalanceTree.build(accounts, balances);
        root = BalanceTree.root(tree);
        _attestRoot(3_000_000 * ONE, root, uint64(block.timestamp));
    }
}
