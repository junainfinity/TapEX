// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {BalanceTree} from "./utils/BalanceTree.sol";
import {MayaHouseVault} from "../src/MayaHouseVault.sol";
import {IMayaHouseVault} from "../src/interfaces/IMayaHouseVault.sol";
import {FeeOnTransferToken, ReentrantToken} from "./mocks/TestTokens.sol";

/// @notice SPEC-11: timelocked signer rotation, signer-change delay, house buffer and daily cap, excess
///         sweep and the player escape hatch.
contract MayaHouseVaultHardeningTest is VaultFixture {
    uint256 internal constant HOUSE = 1_000 * ONE;
    address internal nextSigner;

    function setUp() public override {
        super.setUp();
        nextSigner = vm.addr(keyFor("ledger-signer-2"));
    }

    // ================================================================ ledger-signer rotation

    function test_proposeLedgerSigner_schedulesAndEmits() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposed(signer, nextSigner, START + 48 hours);
        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        assertEq(vault.pendingLedgerSigner(), nextSigner, "pending");
        assertEq(vault.pendingLedgerSignerEta(), START + 48 hours, "eta");
        assertEq(vault.ledgerSigner(), signer, "unchanged until accepted");
    }

    function test_proposeLedgerSigner_rejectsInvalidSigners() public {
        address pendingOwner_ = makeAddr("pending-owner");
        vm.startPrank(operator);
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vault.proposeLedgerSigner(address(0));
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerIsOwner.selector, operator));
        vault.proposeLedgerSigner(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerUnchanged.selector, signer));
        vault.proposeLedgerSigner(signer);
        vault.transferOwnership(pendingOwner_);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerIsOwner.selector, pendingOwner_));
        vault.proposeLedgerSigner(pendingOwner_);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        vm.prank(signer);
        vault.proposeLedgerSigner(nextSigner);
    }

    function test_acceptLedgerSigner_waitsForTheDelay() public {
        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        uint256 eta = START + 48 hours;
        vm.warp(eta - 1);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, eta, eta - 1));
        vm.prank(operator);
        vault.acceptLedgerSigner();

        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerUpdated(signer, nextSigner);
        vm.prank(operator);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSigner(), nextSigner, "rotated");
        assertEq(vault.pendingLedgerSigner(), address(0), "pending cleared");
        assertEq(vault.pendingLedgerSignerEta(), 0, "eta cleared");
    }

    function test_acceptLedgerSigner_requiresAProposalAndTheOwner() public {
        vm.expectRevert(IMayaHouseVault.NoPendingLedgerSigner.selector);
        vm.prank(operator);
        vault.acceptLedgerSigner();

        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        vm.warp(START + 48 hours);
        // Not even the proposed key can complete the rotation: only the owner.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nextSigner));
        vm.prank(nextSigner);
        vault.acceptLedgerSigner();
    }

    function test_cancelLedgerSigner_dropsTheProposal() public {
        vm.expectRevert(IMayaHouseVault.NoPendingLedgerSigner.selector);
        vm.prank(operator);
        vault.cancelLedgerSigner();

        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.cancelLedgerSigner();

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LedgerSignerProposalCancelled(nextSigner);
        vm.prank(operator);
        vault.cancelLedgerSigner();
        assertEq(vault.pendingLedgerSigner(), address(0), "cleared");
        vm.warp(START + 48 hours);
        vm.expectRevert(IMayaHouseVault.NoPendingLedgerSigner.selector);
        vm.prank(operator);
        vault.acceptLedgerSigner();
    }

    function test_proposeLedgerSigner_replacesAPendingProposalAndRestartsTheClock() public {
        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        vm.warp(START + 40 hours);
        address third = makeAddr("ledger-signer-3");
        vm.prank(operator);
        vault.proposeLedgerSigner(third);
        assertEq(vault.pendingLedgerSigner(), third, "replaced");
        vm.warp(START + 48 hours); // the first proposal's eta: no longer relevant
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, START + 88 hours, START + 48 hours)
        );
        vm.prank(operator);
        vault.acceptLedgerSigner();
        vm.warp(START + 88 hours);
        vm.prank(operator);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSigner(), third, "the latest proposal won");
    }

    function test_transferOwnership_rejectsThePendingSignerButCanStillBeCancelled() public {
        vm.startPrank(operator);
        vault.proposeLedgerSigner(nextSigner);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerIsOwner.selector, nextSigner));
        vault.transferOwnership(nextSigner);
        address newOwner = makeAddr("new-owner");
        vault.transferOwnership(newOwner);
        vault.transferOwnership(address(0)); // cancelling a transfer stays possible with a pending signer
        vm.stopPrank();
        assertEq(vault.pendingOwner(), address(0), "transfer cancelled");
    }

    function test_rotation_keepsSignerAndOwnerDistinctAcrossAnOwnershipTransfer() public {
        address newOwner = makeAddr("new-owner");
        vm.startPrank(operator);
        vault.proposeLedgerSigner(nextSigner);
        vault.transferOwnership(newOwner);
        vm.stopPrank();
        vm.prank(newOwner);
        vault.acceptOwnership();
        vm.warp(START + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        vm.prank(operator);
        vault.acceptLedgerSigner();
        vm.prank(newOwner);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSigner(), nextSigner, "rotated by the new owner");
        assertTrue(vault.ledgerSigner() != vault.owner(), "distinct");
    }

    // ================================================================ signer-change delay

    function test_setSignerChangeDelay_increaseAppliesAtOnce() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayUpdated(48 hours, 72 hours);
        vm.prank(operator);
        vault.setSignerChangeDelay(72 hours);
        assertEq(vault.signerChangeDelay(), 72 hours, "applied");
        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        assertEq(vault.pendingLedgerSignerEta(), START + 72 hours, "new proposals use the longer delay");
    }

    function test_setSignerChangeDelay_decreaseIsItselfTimelocked() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayProposed(1 hours, START + 48 hours);
        vm.prank(operator);
        vault.setSignerChangeDelay(1 hours);
        assertEq(vault.signerChangeDelay(), 48 hours, "not yet");
        assertEq(vault.pendingSignerChangeDelay(), 1 hours, "pending");
        assertEq(vault.pendingSignerChangeDelayEta(), START + 48 hours, "pending eta");

        vm.warp(START + 48 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, START + 48 hours, START + 48 hours - 1)
        );
        vm.prank(operator);
        vault.acceptSignerChangeDelay();

        vm.warp(START + 48 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayUpdated(48 hours, 1 hours);
        vm.prank(operator);
        vault.acceptSignerChangeDelay();
        assertEq(vault.signerChangeDelay(), 1 hours, "applied after its own delay");
        assertEq(vault.pendingSignerChangeDelayEta(), 0, "cleared");

        vm.prank(operator);
        vault.proposeLedgerSigner(nextSigner);
        assertEq(vault.pendingLedgerSignerEta(), START + 49 hours, "rotation notice is never below the old delay");
    }

    function test_setSignerChangeDelay_enforcesBounds() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidSignerChangeDelay.selector, 1 hours - 1));
        vault.setSignerChangeDelay(1 hours - 1);
        // Must stay below the escape delay so a lost key can be replaced before players can force escape.
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidSignerChangeDelay.selector, 7 days));
        vault.setSignerChangeDelay(7 days);
        vault.setSignerChangeDelay(7 days - 1);
        assertEq(vault.signerChangeDelay(), 7 days - 1, "just below escape delay");

        MayaHouseVault slow = new MayaHouseVault(token, signer, 90 days);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidSignerChangeDelay.selector, 30 days + 1));
        slow.setSignerChangeDelay(30 days + 1);
        slow.setSignerChangeDelay(30 days);
        assertEq(slow.signerChangeDelay(), 30 days, "absolute maximum");
        vm.stopPrank();
    }

    function test_signerChangeDelay_acceptCancelAndReplace() public {
        vm.startPrank(operator);
        vm.expectRevert(IMayaHouseVault.NoPendingSignerChangeDelay.selector);
        vault.acceptSignerChangeDelay();
        vm.expectRevert(IMayaHouseVault.NoPendingSignerChangeDelay.selector);
        vault.cancelSignerChangeDelay();

        vault.setSignerChangeDelay(2 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayProposalCancelled(2 hours);
        vault.cancelSignerChangeDelay();
        assertEq(vault.pendingSignerChangeDelayEta(), 0, "cancelled");

        vault.setSignerChangeDelay(2 hours);
        // Any new call supersedes the pending decrease, even an increase.
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayProposalCancelled(2 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.SignerChangeDelayUpdated(48 hours, 50 hours);
        vault.setSignerChangeDelay(50 hours);
        assertEq(vault.pendingSignerChangeDelayEta(), 0, "superseded");
        vm.stopPrank();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setSignerChangeDelay(3 hours);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.acceptSignerChangeDelay();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.cancelSignerChangeDelay();
        vm.stopPrank();
    }

    // ================================================================ house limits

    function test_setHouseLimits_tighteningAppliesAtOnce() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsUpdated(2_000, 5_000_000 * ONE);
        vm.prank(operator);
        vault.setHouseLimits(2_000, 5_000_000 * ONE);
        assertEq(vault.houseBufferBps(), 2_000, "buffer raised");
        assertEq(vault.houseDailyCap(), 5_000_000 * ONE, "cap lowered");
        assertEq(vault.pendingHouseLimitsEta(), 0, "nothing pending");

        vm.prank(operator);
        vault.setHouseLimits(10_000, 5_000_000 * ONE); // 100 % buffer and an unchanged cap are tightening too
        assertEq(vault.houseBufferBps(), 10_000, "full buffer");
    }

    function test_setHouseLimits_looseningIsTimelocked() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsProposed(500, 10_000_000 * ONE, START + 48 hours);
        vm.prank(operator);
        vault.setHouseLimits(500, 10_000_000 * ONE);
        assertEq(vault.houseBufferBps(), 1_000, "unchanged");
        assertEq(vault.pendingHouseBufferBps(), 500, "pending buffer");
        assertEq(vault.pendingHouseDailyCap(), 10_000_000 * ONE, "pending cap");
        assertEq(vault.pendingHouseLimitsEta(), START + 48 hours, "pending eta");

        vm.warp(START + 48 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, START + 48 hours, START + 48 hours - 1)
        );
        vm.prank(operator);
        vault.acceptHouseLimits();
        vm.warp(START + 48 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsUpdated(500, 10_000_000 * ONE);
        vm.prank(operator);
        vault.acceptHouseLimits();
        assertEq(vault.houseBufferBps(), 500, "applied");
        assertEq(vault.pendingHouseLimitsEta(), 0, "cleared");
        assertEq(vault.pendingHouseBufferBps(), 0, "cleared buffer");

        // A higher cap (with a higher buffer) is still a loosening.
        vm.prank(operator);
        vault.setHouseLimits(9_000, 20_000_000 * ONE);
        assertEq(vault.pendingHouseLimitsEta(), START + 96 hours, "raising the cap waits");
    }

    function test_setHouseLimits_rejectsInvalidValuesAndStrangers() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidHouseLimits.selector, 10_001, ONE));
        vault.setHouseLimits(10_001, ONE);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidHouseLimits.selector, 1_000, 0));
        vault.setHouseLimits(1_000, 0);
        vm.expectRevert(IMayaHouseVault.NoPendingHouseLimits.selector);
        vault.acceptHouseLimits();
        vm.expectRevert(IMayaHouseVault.NoPendingHouseLimits.selector);
        vault.cancelHouseLimits();
        vm.stopPrank();

        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setHouseLimits(2_000, ONE);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.acceptHouseLimits();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.cancelHouseLimits();
        vm.stopPrank();
    }

    function test_houseLimits_cancelAndSupersede() public {
        vm.startPrank(operator);
        vault.setHouseLimits(0, 10_000_000 * ONE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsProposalCancelled(0, 10_000_000 * ONE);
        vault.cancelHouseLimits();
        assertEq(vault.pendingHouseLimitsEta(), 0, "cancelled");

        vault.setHouseLimits(0, 10_000_000 * ONE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsProposalCancelled(0, 10_000_000 * ONE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseLimitsUpdated(1_000, ONE);
        vault.setHouseLimits(1_000, ONE); // a tightening call replaces the pending loosening
        vm.stopPrank();
        assertEq(vault.pendingHouseLimitsEta(), 0, "superseded");
        assertEq(vault.houseDailyCap(), ONE, "tightened");
    }

    function test_houseLimits_looseningWaitsForTheCurrentSignerDelay() public {
        vm.prank(operator);
        vault.setSignerChangeDelay(5 days);
        vm.prank(operator);
        vault.setHouseLimits(0, 10_000_000 * ONE);
        assertEq(vault.pendingHouseLimitsEta(), START + 5 days, "same notice as a signer rotation");
    }

    // ================================================================ sweepExcess

    function test_sweepExcess_movesOnlyStrayTokens() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        assertEq(vault.excess(), 0, "nothing stray");
        vm.prank(bob);
        assertTrue(token.transfer(address(vault), 42 * ONE), "donation");
        assertEq(vault.excess(), 42 * ONE, "donation is excess");
        address treasury = makeAddr("treasury");

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.ExcessSwept(treasury, 42 * ONE);
        vm.prank(operator);
        uint256 swept = vault.sweepExcess(treasury);
        assertEq(swept, 42 * ONE, "returned amount");
        assertEq(token.balanceOf(treasury), 42 * ONE, "paid out");
        assertEq(vault.assets(), HOUSE + 300 * ONE, "accounted assets untouched");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
        assertEq(vault.excess(), 0, "no excess left");

        vm.expectRevert(IMayaHouseVault.NothingToSweep.selector);
        vm.prank(operator);
        vault.sweepExcess(treasury);
    }

    function test_sweepExcess_validatesCallerAndRecipient() public {
        vm.prank(bob);
        assertTrue(token.transfer(address(vault), ONE), "donation");
        vm.startPrank(operator);
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vault.sweepExcess(address(0));
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidRecipient.selector, address(vault)));
        vault.sweepExcess(address(vault));
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.sweepExcess(alice);
    }

    function test_sweepExcess_worksWhilePausedAndWithFeeTokens() public {
        vm.startPrank(operator);
        FeeOnTransferToken fot = new FeeOnTransferToken(10_000_000 * ONE, 0);
        MayaHouseVault v = new MayaHouseVault(fot, signer, ESCAPE_DELAY);
        fot.approve(address(v), type(uint256).max);
        v.fundHouse(1_000 * ONE);
        assertTrue(fot.transfer(address(v), 10 * ONE), "donation");
        fot.setFeeBps(100);
        v.pause();
        uint256 swept = v.sweepExcess(operator);
        vm.stopPrank();
        assertEq(swept, 10 * ONE, "all stray tokens");
        assertEq(fot.balanceOf(address(v)), v.assets(), "the fee is borne by the recipient, not the vault");
    }

    function test_sweepExcess_blocksReentrancy() public {
        vm.startPrank(operator);
        ReentrantToken hook = new ReentrantToken(10_000_000 * ONE);
        MayaHouseVault v = new MayaHouseVault(hook, signer, ESCAPE_DELAY);
        assertTrue(hook.transfer(address(v), 5 * ONE), "donation");
        vm.stopPrank();
        // The payout callback re-enters another guarded entry point (the caller is the token, so a direct
        // re-entry of sweepExcess would already stop at onlyOwner).
        hook.arm(address(v), abi.encodeCall(MayaHouseVault.deposit, (1)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(operator);
        v.sweepExcess(operator);
    }

    // ================================================================ escape hatch

    function test_triggerEscape_isRefusedWhileAttestationsAreFresh() public {
        uint256 available = START + ESCAPE_DELAY;
        vm.warp(available - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.EscapeNotYetAvailable.selector, available, available - 1)
        );
        vault.triggerEscape();

        _attestNow(0); // every attestation restarts the clock
        assertEq(vault.lastAttestationAt(), available - 1, "attest time");
        vm.warp(available);
        vm.expectRevert(
            abi.encodeWithSelector(
                IMayaHouseVault.EscapeNotYetAvailable.selector, available - 1 + ESCAPE_DELAY, available
            )
        );
        vault.triggerEscape();
        assertFalse(vault.escapeMode(), "still live");
    }

    function test_triggerEscape_anyoneAfterTheDelay_evenWhilePaused() public {
        (bytes32 root,) = _scenario();
        vm.prank(operator);
        vault.pause();
        vm.warp(vault.escapeAvailableAt());
        uint256 pool = 510 * ONE + 100 * ONE; // attested liabilities + carol's unattested deposit
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.EscapeModeActivated(carol, 1, root, START64 + 10, pool);
        vm.prank(carol);
        vault.triggerEscape();
        assertTrue(vault.escapeMode(), "escape mode");
        assertEq(vault.escapePool(), pool, "pool");

        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        vault.triggerEscape();
    }

    function test_escapeMode_stopsDepositsVouchersHouseFlowsAndAttestations() public {
        _fund(HOUSE);
        _deposit(alice, 100 * ONE);
        uint256 expiry = START + 30 days;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();

        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        _deposit(alice, ONE);
        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        _fund(ONE);
        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);
        vm.expectRevert(IMayaHouseVault.EscapeModeActive.selector);
        vm.prank(signer);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 1);
    }

    function test_claimEscape_paysLastAttestedBalancesNetOfLaterFlows() public {
        (bytes32 root, BalanceTree.Tree memory tree) = _scenario();
        assertEq(vault.attestedLedgerRoot(), root, "root attested");
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();

        // alice: 250 attested, redeemed a 50 voucher after the root -> 200
        uint256 aliceBefore = token.balanceOf(alice);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.EscapeClaimed(alice, 200 * ONE, 200 * ONE, 250 * ONE);
        vm.prank(alice);
        uint256 paid = vault.claimEscape(250 * ONE, BalanceTree.proof(tree, 0));
        assertEq(paid, 200 * ONE, "net of the post-root voucher");
        assertEq(token.balanceOf(alice) - aliceBefore, 200 * ONE, "tokens moved");

        // bob: 260 attested (he won 60 off-chain), nothing since
        vm.prank(bob);
        assertEq(vault.claimEscape(260 * ONE, BalanceTree.proof(tree, 1)), 260 * ONE, "bob");
        // carol: not in the tree, deposited 100 after the root: no proof needed for a zero balance
        vm.prank(carol);
        assertEq(vault.claimEscape(0, new bytes32[](0)), 100 * ONE, "carol");

        assertEq(vault.escapeClaimedTotal(), 560 * ONE, "total");
        assertEq(vault.escapeClaimedBy(alice), 200 * ONE, "per account");
        assertLe(vault.escapeClaimedTotal(), vault.escapePool(), "within the pool");
        assertEq(vault.playerWithdrawalsOf(alice), 250 * ONE, "voucher + escape claim");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
        assertEq(
            vault.assets(),
            vault.totalPlayerDeposits() + vault.houseFunded() - vault.totalPlayerWithdrawals() - vault.houseWithdrawn(),
            "assets identity holds in escape mode"
        );
    }

    function test_claimEscape_neverPaysTheSameBalanceTwice() public {
        (, BalanceTree.Tree memory tree) = _scenario();
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        bytes32[] memory proof = BalanceTree.proof(tree, 1);
        vm.prank(bob);
        vault.claimEscape(260 * ONE, proof);
        vm.expectRevert(IMayaHouseVault.NothingToClaim.selector);
        vm.prank(bob);
        vault.claimEscape(260 * ONE, proof);
        vm.expectRevert(IMayaHouseVault.NothingToClaim.selector);
        vm.prank(bob);
        vault.claimEscape(0, new bytes32[](0));
        assertEq(vault.escapeEntitlement(bob, 260 * ONE), 0, "nothing left");
    }

    function test_claimEscape_rejectsForgedBalancesAndBorrowedProofs() public {
        (, BalanceTree.Tree memory tree) = _scenario();
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        vm.startPrank(alice);
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vault.claimEscape(251 * ONE, BalanceTree.proof(tree, 0));
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vault.claimEscape(260 * ONE, BalanceTree.proof(tree, 1)); // bob's leaf, claimed by alice
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vault.claimEscape(250 * ONE, new bytes32[](0));
        vm.stopPrank();
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vm.prank(carol);
        vault.claimEscape(250 * ONE, BalanceTree.proof(tree, 0));
    }

    function test_claimEscape_requiresEscapeMode() public {
        (, BalanceTree.Tree memory tree) = _scenario();
        vm.expectRevert(IMayaHouseVault.EscapeModeInactive.selector);
        vm.prank(alice);
        vault.claimEscape(250 * ONE, BalanceTree.proof(tree, 0));
    }

    function test_claimEscape_cutsFlowsStrictlyAfterTheRootAsOf() public {
        _fund(HOUSE);
        _deposit(alice, 100 * ONE); // t = START
        _withdraw(alice, 10 * ONE, 1, START + 1 days); // t = START: the ledger already netted it
        vm.warp(START + 5);
        _deposit(alice, 7 * ONE); // t = START + 5 == asOf: covered by the leaf
        bytes32 root = BalanceTree.leaf(alice, 97 * ONE); // single-leaf tree: root == leaf, empty proof
        _attestRoot(97 * ONE, root, START64 + 5);
        vm.warp(START + 6);
        _deposit(alice, 3 * ONE); // after asOf: added
        _withdraw(alice, 2 * ONE, 2, START + 1 days); // after asOf: subtracted
        assertEq(vault.escapeEntitlement(alice, 97 * ONE), 98 * ONE, "97 + 3 - 2");
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        vm.prank(alice);
        assertEq(vault.claimEscape(97 * ONE, new bytes32[](0)), 98 * ONE, "paid");
        assertEq(vault.playerDepositsOf(alice), 110 * ONE, "cumulative deposits");
    }

    function test_claimEscape_beforeAnyAttestationReturnsNetDeposits() public {
        _fund(HOUSE);
        _deposit(alice, 100 * ONE);
        _withdraw(alice, 30 * ONE, 1, START + 60);
        _deposit(bob, 40 * ONE);
        _withdraw(bob, 90 * ONE, 1, START + 60); // bob won off-chain and was paid: nothing owed on-chain
        assertEq(vault.escapeAvailableAt(), START + ESCAPE_DELAY, "clock runs from deployment");
        vm.warp(START + ESCAPE_DELAY);
        vault.triggerEscape();
        assertEq(vault.escapePool(), 140 * ONE, "pool = unattested deposits");
        vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
        vm.prank(alice);
        vault.claimEscape(70 * ONE, new bytes32[](0)); // no root to prove against
        vm.prank(alice);
        assertEq(vault.claimEscape(0, new bytes32[](0)), 70 * ONE, "alice net deposits");
        vm.expectRevert(IMayaHouseVault.NothingToClaim.selector);
        vm.prank(bob);
        vault.claimEscape(0, new bytes32[](0));
    }

    function test_claimEscape_poolCapsAnOverstatedRoot() public {
        _fund(HOUSE);
        _deposit(alice, 100 * ONE);
        _deposit(bob, 100 * ONE);
        vm.warp(START + 1);
        // A broken ledger attests 200 of liabilities but a tree that promises 300 each.
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        uint256[] memory balances = new uint256[](2);
        balances[0] = 300 * ONE;
        balances[1] = 300 * ONE;
        BalanceTree.Tree memory tree = BalanceTree.build(accounts, balances);
        _attestRoot(200 * ONE, BalanceTree.root(tree), START64 + 1);
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        assertEq(vault.escapePool(), 200 * ONE, "pool = attested liabilities");
        vm.prank(alice);
        assertEq(vault.claimEscape(300 * ONE, BalanceTree.proof(tree, 0)), 200 * ONE, "capped by the pool");
        vm.expectRevert(IMayaHouseVault.EscapePoolExhausted.selector);
        vm.prank(bob);
        vault.claimEscape(300 * ONE, BalanceTree.proof(tree, 1));
        assertEq(vault.escapeClaimedTotal(), 200 * ONE, "never above attested liabilities");
        assertEq(vault.assets(), HOUSE, "the bankroll was not touched beyond the pool");
    }

    function test_claimEscape_poolNeverExceedsAssets() public {
        _deposit(alice, 100 * ONE);
        vm.warp(START + 1);
        _attestRoot(1_000_000 * ONE, BalanceTree.leaf(alice, 1_000_000 * ONE), START64 + 1);
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        assertEq(vault.escapePool(), 100 * ONE, "min(assets, obligations)");
        vm.prank(alice);
        assertEq(vault.claimEscape(1_000_000 * ONE, new bytes32[](0)), 100 * ONE, "all that exists");
    }

    function test_claimEscape_worksWhilePausedAndBlocksReentrancy() public {
        vm.startPrank(operator);
        ReentrantToken hook = new ReentrantToken(10_000_000 * ONE);
        MayaHouseVault v = new MayaHouseVault(hook, signer, ESCAPE_DELAY);
        assertTrue(hook.transfer(alice, 1_000 * ONE), "transfer");
        vm.stopPrank();
        vm.startPrank(alice);
        hook.approve(address(v), type(uint256).max);
        v.deposit(100 * ONE);
        vm.stopPrank();
        vm.prank(operator);
        v.pause();
        vm.warp(v.escapeAvailableAt());
        v.triggerEscape();
        hook.arm(address(v), abi.encodeCall(MayaHouseVault.claimEscape, (0, new bytes32[](0))));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        v.claimEscape(0, new bytes32[](0));
        hook.arm(address(v), abi.encodeCall(IMayaHouseVault.escapeMode, ())); // harmless callback
        vm.prank(alice);
        assertEq(v.claimEscape(0, new bytes32[](0)), 100 * ONE, "claimed while paused");
        assertTrue(v.paused(), "still paused");
    }

    function test_sweepExcess_inEscapeModeLeavesTheEscapePoolIntact() public {
        _scenario();
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        vm.prank(bob);
        assertTrue(token.transfer(address(vault), 5 * ONE), "donation");
        uint256 assetsBefore = vault.assets();
        vm.prank(operator);
        vault.sweepExcess(operator);
        assertEq(vault.assets(), assetsBefore, "accounted assets untouched");
        assertGe(vault.assets(), vault.escapePool() - vault.escapeClaimedTotal(), "pool still backed");
    }

    function test_balanceLeaf_matchesTheStandardMerkleTreeEncoding() public view {
        assertEq(vault.balanceLeaf(alice, 123), BalanceTree.leaf(alice, 123), "leaf encoding");
        assertEq(
            vault.balanceLeaf(alice, 123), keccak256(bytes.concat(keccak256(abi.encode(alice, uint256(123))))), "spec"
        );
    }

    function test_views_trackPerAccountFlows() public {
        _fund(HOUSE);
        _deposit(alice, 10 * ONE);
        _deposit(alice, 5 * ONE);
        _withdraw(alice, 3 * ONE, 1, START + 60);
        assertEq(vault.playerDepositsOf(alice), 15 * ONE, "deposits");
        assertEq(vault.playerWithdrawalsOf(alice), 3 * ONE, "withdrawals");
        assertEq(vault.playerDepositsOf(bob), 0, "none");
        assertEq(vault.escapeEntitlement(alice, 0), 12 * ONE, "net before any attestation");
    }

    // ================================================================ helpers

    /// @dev fund 1000; alice 300 + bob 200 deposited at START; root at asOf START+10: alice 250, bob 260 (510
    ///      attested); then carol deposits 100 and alice redeems a 50 voucher, both after the root.
    function _scenario() internal returns (bytes32 root, BalanceTree.Tree memory tree) {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        _deposit(bob, 200 * ONE);
        vm.warp(START + 10);
        address[] memory accounts = new address[](2);
        accounts[0] = alice;
        accounts[1] = bob;
        uint256[] memory balances = new uint256[](2);
        balances[0] = 250 * ONE;
        balances[1] = 260 * ONE;
        tree = BalanceTree.build(accounts, balances);
        root = BalanceTree.root(tree);
        _attestRoot(510 * ONE, root, START64 + 10);
        vm.warp(START + 20);
        _deposit(carol, 100 * ONE);
        _withdraw(alice, 50 * ONE, 1, START + 1 days);
    }
}
