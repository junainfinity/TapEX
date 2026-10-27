// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {VaultFixture} from "../utils/VaultFixture.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {IMayaHouseVault} from "../../src/interfaces/IMayaHouseVault.sol";

/// @notice Stateful invariants over random sequences of deposits, bankroll funding, off-chain bets,
///         voucher issuance/redemption/replay, attestations, house withdrawals, pauses, limit changes,
///         timelocked signer rotations and house-limit changes, donations, sweeps and time jumps.
contract MayaHouseVaultInvariantTest is VaultFixture {
    VaultHandler internal handler;
    address internal dave;

    function setUp() public override {
        super.setUp();
        dave = makeAddr("dave");
        vm.prank(operator);
        assertTrue(token.transfer(dave, PLAYER_TOKENS), "transfer");
        _approve(dave);
        // 6 h max age raises the default (10 min): applied through the timelock before the campaign starts.
        _applyLimits(50_000 * ONE, 250_000 * ONE, 100_000 * ONE, 6 hours);

        address[] memory actors = new address[](4);
        actors[0] = alice;
        actors[1] = bob;
        actors[2] = carol;
        actors[3] = dave;
        handler = new VaultHandler(vault, token, operator, signerPk, keyFor("ledger-signer-2"), actors);
        handler.fundHouse(2_000_000 * ONE); // seed the bankroll through the handler so ghosts track it

        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = VaultHandler.deposit.selector;
        selectors[1] = VaultHandler.fundHouse.selector;
        selectors[2] = VaultHandler.bet.selector;
        selectors[3] = VaultHandler.requestVoucher.selector;
        selectors[4] = VaultHandler.redeemVoucher.selector;
        selectors[5] = VaultHandler.replayVoucher.selector;
        selectors[6] = VaultHandler.attest.selector;
        selectors[7] = VaultHandler.withdrawHouse.selector;
        selectors[8] = VaultHandler.togglePause.selector;
        selectors[9] = VaultHandler.setLimits.selector;
        selectors[10] = VaultHandler.donate.selector;
        selectors[11] = VaultHandler.warp.selector;
        selectors[12] = VaultHandler.redeemVoucher.selector; // redemption is the hot path: weight it
        selectors[13] = VaultHandler.setHouseLimits.selector;
        selectors[14] = VaultHandler.rotateSigner.selector;
        selectors[15] = VaultHandler.sweep.selector;
        selectors[16] = VaultHandler.attest.selector; // keep attestations frequent so house withdrawals happen
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Deterministic walk through every handler branch, so the random campaign is known to reach
    ///      the success and rejection paths it classifies (and a broken handler cannot pass vacuously).
    function test_handlerSmoke_reachesEveryPath() public {
        handler.withdrawHouse(ONE, false); // NoAttestation
        handler.deposit(0, 20_000 * ONE);
        handler.deposit(1, 2_500 * ONE);
        handler.bet(0, 100 * ONE, 200, true);
        handler.bet(1, 50 * ONE, 0, false);

        handler.requestVoucher(0, 500 * ONE, 1 hours); // v0
        handler.redeemVoucher(0);
        handler.replayVoucher(0);

        handler.requestVoucher(1, 100 * ONE, 0); // v1 expires this second
        handler.warp(10);
        handler.redeemVoucher(1); // VoucherExpired -> re-credited

        handler.togglePause();
        handler.deposit(0, 10 * ONE); // EnforcedPause
        handler.requestVoucher(0, 100 * ONE, 1 hours); // v2
        handler.redeemVoucher(2); // EnforcedPause
        handler.withdrawHouse(ONE, false); // EnforcedPause
        handler.togglePause();
        handler.redeemVoucher(2);

        handler.attest(0);
        handler.withdrawHouse(1_000 * ONE, false);
        handler.withdrawHouse(5, true); // ExceedsHouseWithdrawable (inside the buffer)
        handler.withdrawHouse(type(uint256).max, true); // ExceedsHouseSurplus
        handler.setHouseLimits(1_000, 1_500 * ONE); // tighten the daily house cap: applies at once
        handler.withdrawHouse(1_000 * ONE, false); // HouseDailyCapExceeded (1,000 of 1,500 already used today)
        handler.warp(12 hours);
        handler.withdrawHouse(ONE, false); // AttestationTooOld (max age 6 h)

        handler.requestVoucher(0, 5_000 * ONE, 2 days); // v3
        handler.setLimits(1_000 * ONE, 1_500 * ONE, 1_000 * ONE, 1 hours); // lowers every limit: applies at once
        handler.redeemVoucher(3); // VoucherAboveMax
        handler.requestVoucher(0, 1_000 * ONE, 2 days); // v4
        handler.requestVoucher(0, 500 * ONE, 2 days); // v5
        handler.requestVoucher(1, 1_000 * ONE, 2 days); // v6
        handler.redeemVoucher(4);
        handler.redeemVoucher(5); // AccountDailyOutflowCapExceeded: alice used her 1,000 share of today's 1,500
        handler.redeemVoucher(6); // DailyOutflowCapExceeded: only 500 of the shared cap is left
        handler.donate(2, 10 * ONE);
        handler.fundHouse(ONE);
        handler.sweep();
        handler.sweep(); // NothingToSweep

        handler.setLimits(5_000 * ONE, 5_000 * ONE, 5_000 * ONE, 1 hours); // raises limits: scheduled
        handler.setHouseLimits(0, 10_000_000 * ONE); // loosening: scheduled
        handler.rotateSigner(0); // proposed, TimelockNotElapsed
        handler.requestVoucher(0, 100 * ONE, 2 days); // v7, signed by the outgoing key, expires at the rotation eta
        handler.rotateSigner(2 days); // accepted exactly at the eta
        handler.setHouseLimits(0, 0); // the scheduled loosening is due: accepted
        handler.setLimits(0, 0, 0, 0); // the scheduled limits are due: accepted
        assertEq(vault.maxVoucherAmount(), 5_000 * ONE, "raised limits applied after the timelock");
        handler.redeemVoucher(7); // InvalidSignature: the key was rotated away
        handler.withdrawHouse(ONE, false); // AttestationBySupersededSigner
        handler.attest(0); // the new signer attests
        handler.withdrawHouse(ONE, false);

        string[22] memory okKeys = [
            "deposit",
            "deposit:paused",
            "fundHouse",
            "bet:win",
            "bet:loss",
            "requestVoucher",
            "withdraw",
            "replay:blocked",
            "voucher:recredited",
            "attest",
            "withdrawHouse",
            "donate",
            "sweep",
            "sweep:nothing",
            "houseLimits:tightened",
            "houseLimits:scheduled",
            "houseLimits:accepted",
            "limits:scheduled",
            "limits:accepted",
            "rotate:pending",
            "rotate:accepted",
            "togglePause"
        ];
        for (uint256 i; i < okKeys.length; ++i) {
            assertGe(handler.hits(okKeys[i]), 1, okKeys[i]);
        }
        assertEq(handler.hits("togglePause"), 2, "pause and unpause");
        assertEq(handler.hits("withdrawHouse"), 2, "two house withdrawals");
        bytes4[6] memory withdrawRejects = [
            Pausable.EnforcedPause.selector,
            IMayaHouseVault.VoucherExpired.selector,
            IMayaHouseVault.VoucherAboveMax.selector,
            IMayaHouseVault.DailyOutflowCapExceeded.selector,
            IMayaHouseVault.AccountDailyOutflowCapExceeded.selector,
            IMayaHouseVault.InvalidSignature.selector
        ];
        for (uint256 i; i < withdrawRejects.length; ++i) {
            assertEq(
                handler.rejects(keccak256(abi.encode("withdraw:reverted", withdrawRejects[i]))), 1, "withdraw reject"
            );
        }
        bytes4[7] memory houseRejects = [
            IMayaHouseVault.NoAttestation.selector,
            Pausable.EnforcedPause.selector,
            IMayaHouseVault.ExceedsHouseWithdrawable.selector,
            IMayaHouseVault.ExceedsHouseSurplus.selector,
            IMayaHouseVault.HouseDailyCapExceeded.selector,
            IMayaHouseVault.AttestationTooOld.selector,
            IMayaHouseVault.AttestationBySupersededSigner.selector
        ];
        for (uint256 i; i < houseRejects.length; ++i) {
            assertEq(
                handler.rejects(keccak256(abi.encode("withdrawHouse:reverted", houseRejects[i]))), 1, "house reject"
            );
        }
        assertEq(vault.ledgerSigner(), handler.activeSigner(), "rotated");

        invariant_tokenBalanceCoversAssets();
        invariant_assetsIdentity();
        invariant_noNonceReuse();
        invariant_houseWithdrawalNeverTakesAttestedObligations();
        invariant_ledgerReconcilesAndPlayersAreCovered();
        invariant_surplusMatchesSpecFormula();
        invariant_rulesBehaveAsSpecified();
        invariant_signerNeverOwner();
    }

    function invariant_tokenBalanceCoversAssets() public view {
        assertGe(token.balanceOf(address(vault)), vault.assets(), "token.balanceOf(vault) >= assets");
        assertEq(
            token.balanceOf(address(vault)),
            vault.assets() + handler.ghostDonations() - handler.ghostSwept(),
            "balance = assets + unswept donations"
        );
        assertEq(vault.excess(), handler.ghostDonations() - handler.ghostSwept(), "excess = unswept donations");
    }

    function invariant_assetsIdentity() public view {
        assertEq(
            vault.assets(),
            vault.totalPlayerDeposits() + vault.houseFunded() - vault.totalPlayerWithdrawals() - vault.houseWithdrawn(),
            "assets identity"
        );
        assertEq(vault.totalPlayerDeposits(), handler.ghostDeposits(), "deposits mirror");
        assertEq(vault.houseFunded(), handler.ghostHouseFunded(), "houseFunded mirror");
        assertEq(vault.totalPlayerWithdrawals(), handler.ghostWithdrawals(), "withdrawals mirror");
        assertEq(vault.houseWithdrawn(), handler.ghostHouseWithdrawn(), "houseWithdrawn mirror");
    }

    function invariant_noNonceReuse() public view {
        assertEq(handler.replaySuccesses(), 0, "a redeemed voucher paid twice");
        assertEq(handler.redemptions(), handler.distinctNoncesRedeemed(), "every redemption used a fresh nonce");
    }

    function invariant_houseWithdrawalNeverTakesAttestedObligations() public view {
        assertEq(
            handler.houseWithdrawBreaches(), 0, "withdrawHouse left assets < liabilities + deposits - claims + buffer"
        );
    }

    function invariant_ledgerReconcilesAndPlayersAreCovered() public view {
        // Exact reconciliation of the honest off-chain ledger model against on-chain accounting.
        assertEq(
            vault.assets(), handler.trueLiabilities() + handler.houseEquity(), "assets = liabilities + house equity"
        );
        assertGe(vault.assets(), handler.trueLiabilities(), "player balances and vouchers always covered");
    }

    function invariant_surplusMatchesSpecFormula() public view {
        assertEq(vault.houseSurplus(), _expectedSurplus(), "houseSurplus formula");
        assertEq(vault.houseBuffer(), _expectedBuffer(), "houseBuffer formula");
    }

    function invariant_rulesBehaveAsSpecified() public view {
        assertEq(handler.unexpectedOutcomes(), 0, handler.lastUnexpected());
        assertEq(handler.capBreaches(), 0, "daily outflow above cap");
    }

    function invariant_signerNeverOwner() public view {
        address owner = vault.owner();
        assertTrue(vault.ledgerSigner() != owner && vault.ledgerSigner() != vault.pendingOwner(), "signer is owner");
        assertTrue(vault.pendingLedgerSigner() != owner, "pending signer is owner");
        assertEq(vault.ledgerSigner(), handler.activeSigner(), "the server holds the vault's current signer key");
    }
}
