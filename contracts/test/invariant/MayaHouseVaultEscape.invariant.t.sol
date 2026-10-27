// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {VaultFixture} from "../utils/VaultFixture.sol";
import {EscapeHandler} from "./EscapeHandler.sol";

/// @notice Escape-hatch invariants over random sequences of deposits, bets, vouchers, honest Merkle-root
///         attestations, silence (time jumps), escape triggers and honest, forged, zero-leaf and borrowed
///         claims, and the owner's recovery of the unclaimable bankroll: total escape claims never exceed the
///         attested player obligations, no account is paid twice, escape mode cannot start while attestations
///         are fresh, and a recovery never takes what claims can still reach.
contract MayaHouseVaultEscapeInvariantTest is VaultFixture {
    EscapeHandler internal handler;

    function setUp() public override {
        super.setUp();
        address dave = makeAddr("dave");
        vm.prank(operator);
        assertTrue(token.transfer(dave, PLAYER_TOKENS), "transfer");
        _approve(dave);
        _fund(2_000_000 * ONE);
        handler = new EscapeHandler(vault, token, operator, signerPk, [alice, bob, carol, dave]);

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = EscapeHandler.deposit.selector;
        selectors[1] = EscapeHandler.bet.selector;
        selectors[2] = EscapeHandler.requestVoucher.selector;
        selectors[3] = EscapeHandler.redeemVoucher.selector;
        selectors[4] = EscapeHandler.attest.selector;
        selectors[5] = EscapeHandler.warp.selector;
        selectors[6] = EscapeHandler.triggerEscape.selector;
        selectors[7] = EscapeHandler.claim.selector;
        selectors[8] = EscapeHandler.claim.selector; // claims are the point once escape mode is on
        selectors[9] = EscapeHandler.warp.selector; // silence has to last escapeDelay
        selectors[10] = EscapeHandler.recover.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Deterministic walk through the live phase, a refused early trigger, escape and every claim path.
    function test_escapeHandlerSmoke_reachesEveryPath() public {
        handler.claim(0, 0); // EscapeModeInactive
        handler.recover(); // EscapeModeInactive
        handler.deposit(0, 100_000 * ONE);
        handler.deposit(1, 50_000 * ONE);
        handler.bet(0, 10_000 * ONE, 300, true);
        handler.bet(1, 5_000 * ONE, 0, false);
        handler.requestVoucher(0, 20_000 * ONE, 1 days); // v0
        handler.redeemVoucher(0);
        handler.attest();
        handler.deposit(2, 7_000 * ONE); // after the root: added to carol's claim
        handler.deposit(0, 3_000 * ONE); // after the root: added to alice's claim
        handler.requestVoucher(1, 1_000 * ONE, 1 hours); // v1 (from bob's post-root balance)
        handler.redeemVoucher(1); // after the root: subtracted from bob's claim
        handler.requestVoucher(0, 2_000 * ONE, 1 hours); // v2 after the root, never redeemed: still owed to alice
        handler.triggerEscape(0); // too early
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(1 days);
        handler.redeemVoucher(2); // expired: re-credited
        handler.triggerEscape(3);
        handler.triggerEscape(2); // already on
        handler.deposit(0, ONE); // EscapeModeActive
        handler.attest(); // EscapeModeActive
        handler.claim(0, 1); // inflated leaf
        handler.claim(0, 3); // borrowed proof
        handler.recover(); // the bankroll beyond the pool goes back to the owner, mid-claims
        handler.recover(); // NothingToRecover
        handler.claim(0, 2); // zero leaf first: only the post-root flows
        handler.claim(0, 0); // then the leaf: the rest, never more
        handler.claim(0, 0); // NothingToClaim
        handler.claim(1, 0);
        handler.claim(2, 0);
        handler.claim(3, 0); // dave never played: NothingToClaim

        string[14] memory keys = [
            "deposit",
            "bet",
            "requestVoucher",
            "withdraw",
            "withdraw:expired",
            "attest",
            "trigger:early",
            "trigger",
            "trigger:again",
            "deposit:escaped",
            "attest:escaped",
            "recover",
            "recover:nothing",
            "recover:inactive"
        ];
        for (uint256 i; i < keys.length; ++i) {
            assertGe(handler.hits(keys[i]), 1, keys[i]);
        }
        assertEq(handler.hits("claim"), 4, "alice twice, bob, carol");
        assertEq(handler.hits("claim:refused"), 5, "inactive, inflated, borrowed, repeat, dave");
        assertTrue(handler.poolCoversEveryone(), "an honest, solvent house covers every claim");
        assertEq(handler.paid(0), handler.entitlementAtTrigger(0), "alice made whole exactly");
        assertEq(handler.paid(2), 7_000 * ONE, "carol gets her post-root deposit");
        // Recovered before any claim succeeded: exactly the assets above the pool at trigger time.
        assertEq(handler.recovered(), handler.assetsAtTrigger() - vault.escapePool(), "the bankroll came back");
        // Not all of the 2M: deposits mined in the attest block stay owed on top of the root (Stage A cut rule).
        assertGe(handler.recovered(), 1_500_000 * ONE, "the bulk of the 2M bankroll");
        assertEq(vault.assets(), vault.escapePool() - vault.escapeClaimedTotal(), "only the unclaimed pool stays");

        invariant_escapeClaimsNeverExceedThePool();
        invariant_poolNeverExceedsAttestedObligationsOrAssets();
        invariant_noAccountIsPaidTwice();
        invariant_noEscapeWhileAttestationsAreFresh();
        invariant_recoveryNeverTakesClaimableFunds();
        invariant_accountingHolds();
    }

    function invariant_escapeClaimsNeverExceedThePool() public view {
        assertLe(vault.escapeClaimedTotal(), vault.escapePool(), "total escape claims <= escape pool");
    }

    function invariant_poolNeverExceedsAttestedObligationsOrAssets() public view {
        if (!vault.escapeMode()) {
            assertEq(vault.escapePool(), 0, "no pool before escape");
            return;
        }
        assertLe(
            vault.escapePool(), handler.obligationsAtTrigger(), "pool <= attested liabilities + unattested deposits"
        );
        assertLe(vault.escapePool(), handler.assetsAtTrigger(), "pool <= assets at trigger");
    }

    function invariant_noAccountIsPaidTwice() public view {
        assertEq(handler.overpaid(), 0, "an account was paid more than its entitlement");
        assertEq(handler.shortPaid(), 0, "an honest claim was short-paid although the pool covered everyone");
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            total += handler.paid(i);
        }
        assertEq(total, vault.escapeClaimedTotal(), "escape payouts mirror");
    }

    function invariant_noEscapeWhileAttestationsAreFresh() public view {
        assertEq(handler.earlyTriggers(), 0, "escape triggered while attestations were fresh");
        assertEq(handler.unexpected(), 0, handler.lastUnexpected());
    }

    function invariant_recoveryNeverTakesClaimableFunds() public view {
        assertEq(handler.recoveryBreaches(), 0, "a recovery left less than the unclaimed pool");
        if (vault.escapeMode()) {
            assertGe(vault.assets(), vault.escapePool() - vault.escapeClaimedTotal(), "assets cover the unclaimed pool");
        } else {
            assertEq(handler.recovered(), 0, "no recovery outside escape mode");
        }
    }

    function invariant_accountingHolds() public view {
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets (no donations here)");
        assertEq(
            vault.assets(),
            vault.totalPlayerDeposits() + vault.houseFunded() - vault.totalPlayerWithdrawals() - vault.houseWithdrawn(),
            "assets identity"
        );
    }
}
