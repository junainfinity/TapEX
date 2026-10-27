// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {MayaHouseVault} from "../src/MayaHouseVault.sol";
import {IMayaHouseVault} from "../src/interfaces/IMayaHouseVault.sol";
import {FeeOnTransferToken, FalseReturnToken, ReentrantToken} from "./mocks/TestTokens.sol";

contract MayaHouseVaultTest is VaultFixture {
    uint256 internal constant HOUSE = 1_000 * ONE;

    // ================================================================ construction

    function test_constructor_setsConfiguration() public view {
        assertEq(address(vault.token()), address(token), "token");
        assertEq(vault.ledgerSigner(), signer, "signer");
        assertEq(vault.owner(), operator, "owner is deployer");
        assertEq(vault.pendingOwner(), address(0), "no pending owner");
        assertEq(vault.maxVoucherAmount(), vault.DEFAULT_MAX_VOUCHER_AMOUNT(), "default max voucher");
        assertEq(vault.dailyOutflowCap(), vault.DEFAULT_DAILY_OUTFLOW_CAP(), "default daily cap");
        assertEq(vault.accountDailyOutflowCap(), 250_000 * ONE, "default per-account daily cap");
        assertEq(vault.pendingLimitsEta(), 0, "no pending limit change");
        assertEq(vault.ledgerSignerSince(), START, "the first signer takes office at deployment");
        assertEq(vault.MAX_ATTESTATION_SEQ_STEP(), 1_000_000, "seq step bound");
        assertEq(vault.TIMELOCK_GRACE_PERIOD(), 7 days, "proposal grace period");
        assertEq(vault.maxAttestationAge(), 10 minutes, "default attestation age is 10 min");
        assertEq(vault.MAX_ATTESTATION_AGE_LIMIT(), 1 days, "age limit");
        assertEq(vault.signerChangeDelay(), 48 hours, "default signer change delay");
        assertEq(vault.houseBufferBps(), 1_000, "default buffer 10%");
        assertEq(vault.houseDailyCap(), 10_000_000 * ONE, "default house daily cap");
        assertEq(vault.escapeDelay(), 7 days, "escape delay");
        assertEq(vault.deployedAt(), START, "deployment time");
        assertEq(vault.lastAttestationAt(), START, "deployment time stands in before the first attestation");
        assertEq(vault.escapeAvailableAt(), START + 7 days, "escape clock");
        assertEq(vault.pendingLedgerSigner(), address(0), "no pending signer");
        assertFalse(vault.escapeMode(), "not in escape mode");
        assertFalse(vault.paused(), "not paused");
        assertEq(vault.assets(), 0, "no assets");
        assertEq(vault.attestationSeq(), 0, "no attestation");
    }

    function test_constructor_emitsConfiguration() public {
        vm.expectEmit(true, true, true, true);
        emit IMayaHouseVault.LedgerSignerUpdated(address(0), signer);
        vm.expectEmit(true, true, true, true);
        emit IMayaHouseVault.LimitsUpdated(100_000 * ONE, 1_000_000 * ONE, 250_000 * ONE, 10 minutes);
        vm.expectEmit(true, true, true, true);
        emit IMayaHouseVault.SignerChangeDelayUpdated(0, 48 hours);
        vm.expectEmit(true, true, true, true);
        emit IMayaHouseVault.HouseLimitsUpdated(1_000, 10_000_000 * ONE);
        vm.prank(operator);
        new MayaHouseVault(token, signer, ESCAPE_DELAY);
    }

    function test_constructor_revertsOnZeroToken() public {
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vm.prank(operator);
        new MayaHouseVault(IERC20(address(0)), signer, ESCAPE_DELAY);
    }

    function test_constructor_revertsOnZeroSigner() public {
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vm.prank(operator);
        new MayaHouseVault(token, address(0), ESCAPE_DELAY);
    }

    function test_constructor_revertsOnTokenWithoutCode() public {
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidToken.selector, alice));
        vm.prank(operator);
        new MayaHouseVault(IERC20(alice), signer, ESCAPE_DELAY);
    }

    function test_constructor_revertsWhenSignerIsDeployer() public {
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerIsOwner.selector, operator));
        vm.prank(operator);
        new MayaHouseVault(token, operator, ESCAPE_DELAY);
    }

    function test_constructor_boundsTheEscapeDelay() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidEscapeDelay.selector, 3 days - 1));
        new MayaHouseVault(token, signer, 3 days - 1);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidEscapeDelay.selector, 90 days + 1));
        new MayaHouseVault(token, signer, 90 days + 1);
        assertEq(new MayaHouseVault(token, signer, 3 days).escapeDelay(), 3 days, "minimum");
        assertEq(new MayaHouseVault(token, signer, 90 days).escapeDelay(), 90 days, "maximum");
        vm.stopPrank();
    }

    function test_eip712Domain_isMayaHouseVaultV1() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            vault.eip712Domain();
        assertEq(name, "MayaHouseVault", "domain name");
        assertEq(version, "1", "domain version");
        assertEq(chainId, block.chainid, "domain chainId");
        assertEq(verifyingContract, address(vault), "domain verifyingContract");
    }

    function test_hashing_matchesIndependentEip712Encoding() public view {
        assertEq(vault.WITHDRAWAL_TYPEHASH(), WITHDRAWAL_TYPEHASH, "typehash");
        assertEq(vault.domainSeparator(), _domainSeparator(address(vault)), "domain separator");
        assertEq(
            vault.hashWithdrawal(alice, 12 * ONE, 7, START + 60),
            _digest(address(vault), alice, 12 * ONE, 7, START + 60),
            "withdrawal digest"
        );
    }

    // ================================================================ deposit

    function test_deposit_creditsAndEmitsSequentialIds() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.Deposited(alice, 250 * ONE, 1);
        _deposit(alice, 250 * ONE);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.Deposited(bob, 1, 2);
        _deposit(bob, 1);

        assertEq(vault.totalPlayerDeposits(), 250 * ONE + 1, "total deposits");
        assertEq(vault.depositCount(), 2, "deposit count");
        assertEq(vault.assets(), 250 * ONE + 1, "assets");
        assertEq(token.balanceOf(address(vault)), 250 * ONE + 1, "vault balance");
        assertEq(token.balanceOf(alice), PLAYER_TOKENS - 250 * ONE, "alice debited");
    }

    function test_deposit_revertsOnZeroAmount() public {
        vm.expectRevert(IMayaHouseVault.ZeroAmount.selector);
        _deposit(alice, 0);
    }

    function test_deposit_revertsWhenPaused() public {
        vm.prank(operator);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _deposit(alice, ONE);
    }

    function test_deposit_revertsWithoutAllowance() public {
        address dave = makeAddr("dave");
        vm.prank(alice);
        assertTrue(token.transfer(dave, ONE), "transfer");
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, ONE)
        );
        _deposit(dave, ONE);
    }

    function test_deposit_recordsTimestampedHistory() public {
        _deposit(alice, 10 * ONE);
        _deposit(bob, 5 * ONE); // same block timestamp: checkpoint is updated in place
        vm.warp(START + 100);
        _deposit(carol, 7 * ONE);
        assertEq(vault.totalPlayerDepositsAt(START48 - 1), 0, "before first deposit");
        assertEq(vault.totalPlayerDepositsAt(START48), 15 * ONE, "at START");
        assertEq(vault.totalPlayerDepositsAt(START48 + 99), 15 * ONE, "between");
        assertEq(vault.totalPlayerDepositsAt(START48 + 100), 22 * ONE, "at second timestamp");
        assertEq(vault.totalPlayerDepositsAt(type(uint48).max), 22 * ONE, "far future");
    }

    function test_deposit_feeOnTransferCreditsReceivedAmount() public {
        (FeeOnTransferToken fot, MayaHouseVault v) = _feeVault(100); // 1%
        vm.expectEmit(true, true, true, true, address(v));
        emit IMayaHouseVault.Deposited(alice, 990 * ONE, 1);
        vm.prank(alice);
        v.deposit(1_000 * ONE);
        assertEq(v.totalPlayerDeposits(), 990 * ONE, "credited received");
        assertEq(v.assets(), 990 * ONE, "assets");
        assertEq(fot.balanceOf(address(v)), v.assets(), "balance == assets");
    }

    function test_deposit_revertsWhenNothingReceived() public {
        (, MayaHouseVault v) = _feeVault(10_000); // 100% fee
        vm.expectRevert(IMayaHouseVault.NothingReceived.selector);
        vm.prank(alice);
        v.deposit(ONE);
    }

    function test_deposit_revertsWhenTokenReturnsFalse() public {
        vm.startPrank(operator);
        FalseReturnToken bad = new FalseReturnToken(1_000 * ONE);
        MayaHouseVault v = new MayaHouseVault(bad, signer, ESCAPE_DELAY);
        assertTrue(bad.transfer(alice, 100 * ONE), "transfer");
        vm.stopPrank();
        vm.prank(alice);
        bad.approve(address(v), type(uint256).max);
        bad.setFailTransfers(true);

        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        vm.prank(alice);
        v.deposit(ONE);
    }

    function test_deposit_blocksReentrancy() public {
        (ReentrantToken hook, MayaHouseVault v) = _hookVault();
        hook.arm(address(v), abi.encodeCall(MayaHouseVault.deposit, (1)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        v.deposit(ONE);
    }

    // ================================================================ fundHouse

    function test_fundHouse_creditsBankroll() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseFunded(operator, HOUSE);
        _fund(HOUSE);
        assertEq(vault.houseFunded(), HOUSE, "houseFunded");
        assertEq(vault.assets(), HOUSE, "assets");
        assertEq(vault.totalPlayerDeposits(), 0, "not a player deposit");
        assertEq(token.balanceOf(address(vault)), HOUSE, "vault balance");
    }

    function test_fundHouse_revertsForNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.fundHouse(ONE);
    }

    function test_fundHouse_revertsOnZeroAmount() public {
        vm.expectRevert(IMayaHouseVault.ZeroAmount.selector);
        _fund(0);
    }

    function test_fundHouse_allowedWhilePaused() public {
        vm.prank(operator);
        vault.pause();
        _fund(HOUSE);
        assertEq(vault.houseFunded(), HOUSE, "operator can top up during an incident");
    }

    function test_fundHouse_feeOnTransferCreditsReceivedAmount() public {
        (FeeOnTransferToken fot, MayaHouseVault v) = _feeVault(250); // 2.5%
        vm.prank(operator);
        fot.approve(address(v), type(uint256).max);
        vm.expectEmit(true, true, true, true, address(v));
        emit IMayaHouseVault.HouseFunded(operator, 975 * ONE);
        vm.prank(operator);
        v.fundHouse(1_000 * ONE);
        assertEq(v.houseFunded(), 975 * ONE, "credited received");
        assertEq(fot.balanceOf(address(v)), v.assets(), "balance == assets");
    }

    function test_fundHouse_revertsWhenNothingReceived() public {
        (FeeOnTransferToken fot, MayaHouseVault v) = _feeVault(0);
        vm.prank(operator);
        fot.approve(address(v), type(uint256).max);
        fot.setFeeBps(10_000);
        vm.expectRevert(IMayaHouseVault.NothingReceived.selector);
        vm.prank(operator);
        v.fundHouse(ONE);
    }

    // ================================================================ withdraw

    function test_withdraw_paysVoucherAndRecordsState() public {
        _fund(HOUSE);
        _deposit(alice, 100 * ONE);
        uint256 amount = 150 * ONE; // player won: paid partly from the bankroll
        uint256 nonce = 42;
        uint256 expiry = block.timestamp + 10 minutes;
        bytes memory sig = _voucher(alice, amount, nonce, expiry);

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.Withdrawn(alice, amount, nonce);
        vm.prank(alice);
        vault.withdraw(amount, nonce, expiry, sig);

        assertEq(token.balanceOf(alice), PLAYER_TOKENS - 100 * ONE + amount, "alice paid");
        assertEq(vault.totalPlayerWithdrawals(), amount, "withdrawals");
        assertEq(vault.assets(), HOUSE + 100 * ONE - amount, "assets");
        assertTrue(vault.nonceUsed(alice, nonce), "nonce consumed");
        assertEq(vault.dailyOutflow(block.timestamp / 1 days), amount, "daily outflow");
        assertEq(vault.claimedSinceAttest(), amount, "claimed since attest");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
    }

    function test_withdraw_revertsOnZeroAmount() public {
        _fund(HOUSE);
        bytes memory sig = _voucher(alice, 0, 1, block.timestamp + 60);
        vm.expectRevert(IMayaHouseVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.withdraw(0, 1, block.timestamp + 60, sig);
    }

    function test_withdraw_revertsWhenExpired() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp - 1;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.VoucherExpired.selector, expiry, block.timestamp));
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_acceptsAtExactExpiry() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 30;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.warp(expiry);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
        assertTrue(vault.nonceUsed(alice, 1), "redeemed on the expiry second");
    }

    function test_withdraw_revertsAboveMaxVoucher() public {
        _setLimits(100 * ONE, 1_000 * ONE, 10 minutes);
        _fund(HOUSE);
        uint256 amount = 100 * ONE + 1;
        bytes memory sig = _voucher(alice, amount, 1, block.timestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.VoucherAboveMax.selector, amount, 100 * ONE));
        vm.prank(alice);
        vault.withdraw(amount, 1, block.timestamp + 60, sig);

        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60); // exactly the max is fine
        assertEq(vault.totalPlayerWithdrawals(), 100 * ONE, "max voucher redeemed");
    }

    function test_withdraw_revertsOnNonceReuse() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 9, expiry);
        vm.prank(alice);
        vault.withdraw(ONE, 9, expiry, sig);

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonceAlreadyUsed.selector, alice, 9));
        vm.prank(alice);
        vault.withdraw(ONE, 9, expiry, sig);

        // A fresh voucher reusing the nonce with different terms is rejected too.
        bytes memory sig2 = _voucher(alice, 2 * ONE, 9, expiry);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonceAlreadyUsed.selector, alice, 9));
        vm.prank(alice);
        vault.withdraw(2 * ONE, 9, expiry, sig2);
    }

    function test_withdraw_noncesArePerAccountAndUnordered() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        _withdraw(alice, ONE, 5, expiry);
        _withdraw(bob, ONE, 5, expiry); // same nonce, different account
        _withdraw(alice, ONE, 2, expiry); // lower nonce after a higher one
        _withdraw(alice, ONE, type(uint256).max, expiry);
        assertTrue(vault.nonceUsed(alice, 5) && vault.nonceUsed(bob, 5), "per-account nonce 5");
        assertTrue(vault.nonceUsed(alice, 2), "unordered nonce");
        assertFalse(vault.nonceUsed(bob, 2), "bob nonce 2 untouched");
        assertEq(vault.totalPlayerWithdrawals(), 4 * ONE, "four redemptions");
    }

    function test_withdraw_revertsWhenSignedByAnotherKey() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _sign(keyFor("mallory"), _digest(address(vault), alice, ONE, 1, expiry));
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_revertsWhenOwnerSigns() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        // Separation of duties: a voucher signed by the owner key must not pay out.
        bytes memory sig = _sign(operatorPk, _digest(address(vault), alice, ONE, 1, expiry));
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_revertsWhenRedeemedByAnotherAccount() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(bob);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_revertsOnTamperedTerms() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.startPrank(alice);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vault.withdraw(ONE + 1, 1, expiry, sig);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vault.withdraw(ONE, 2, expiry, sig);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vault.withdraw(ONE, 1, expiry + 1, sig);
        vm.stopPrank();
    }

    function test_withdraw_revertsOnCrossChainReplay() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry); // signed for chain 31337
        vm.chainId(84532);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);

        // The domain is rebuilt for the new chain: a voucher signed for 84532 is honoured there.
        assertEq(vault.domainSeparator(), _domainSeparator(address(vault)), "domain follows chainid");
        _withdraw(alice, ONE, 1, expiry);
        assertTrue(vault.nonceUsed(alice, 1), "redeemed on its own chain");
    }

    function test_withdraw_revertsOnCrossVaultReplay() public {
        _fund(HOUSE);
        vm.startPrank(operator);
        MayaHouseVault other = new MayaHouseVault(token, signer, ESCAPE_DELAY);
        token.approve(address(other), HOUSE);
        other.fundHouse(HOUSE);
        vm.stopPrank();

        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry); // bound to `vault`
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        other.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_rejectsMalleatedHighSSignature() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes32 digest = _digest(address(vault), alice, ONE, 1, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), signer, "raw ecrecover accepts the twin");

        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, abi.encodePacked(r, highS, flippedV));
    }

    function test_withdraw_rejectsMalformedSignatures() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, _digest(address(vault), alice, ONE, 1, expiry));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));

        bytes[] memory bad = new bytes[](5);
        bad[0] = abi.encodePacked(r, vs); // ERC-2098 compact form (64 bytes) is not accepted
        bad[1] = abi.encodePacked(r, s, v, uint8(0)); // 66 bytes
        bad[2] = abi.encodePacked(r, s, uint8(29)); // invalid v
        bad[3] = new bytes(65); // all zero
        bad[4] = ""; // empty
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
            vm.prank(alice);
            vault.withdraw(ONE, 1, expiry, bad[i]);
        }
        assertFalse(vault.nonceUsed(alice, 1), "nonce untouched");
    }

    function test_withdraw_enforcesDailyOutflowCapByUtcDay() public {
        _setLimits(100 * ONE, 250 * ONE, 10 minutes);
        _fund(HOUSE);
        uint256 day = block.timestamp / 1 days;
        uint256 expiry = (day + 3) * 1 days;
        _withdraw(alice, 100 * ONE, 1, expiry);
        _withdraw(bob, 100 * ONE, 1, expiry);
        assertEq(vault.remainingDailyOutflow(), 50 * ONE, "50 left today");

        bytes memory sig = _voucher(carol, 100 * ONE, 1, expiry);
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.DailyOutflowCapExceeded.selector, day, 100 * ONE, 50 * ONE)
        );
        vm.prank(carol);
        vault.withdraw(100 * ONE, 1, expiry, sig);
        assertFalse(vault.nonceUsed(carol, 1), "rejected voucher stays redeemable later");

        vm.warp((day + 1) * 1 days - 1); // 23:59:59 UTC, same day
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.DailyOutflowCapExceeded.selector, day, 100 * ONE, 50 * ONE)
        );
        vm.prank(carol);
        vault.withdraw(100 * ONE, 1, expiry, sig);

        vm.warp((day + 1) * 1 days); // 00:00:00 UTC next day: fresh budget
        vm.prank(carol);
        vault.withdraw(100 * ONE, 1, expiry, sig);
        assertEq(vault.dailyOutflow(day), 200 * ONE, "previous day total");
        assertEq(vault.dailyOutflow(day + 1), 100 * ONE, "new day total");
        assertEq(vault.currentDay(), day + 1, "current day");
    }

    function test_withdraw_capLoweredBelowUsageBlocksRestOfDay() public {
        _fund(HOUSE);
        uint256 day = block.timestamp / 1 days;
        _withdraw(alice, 300 * ONE, 1, block.timestamp + 60);
        _setLimits(100 * ONE, 200 * ONE, 10 minutes);
        assertEq(vault.remainingDailyOutflow(), 0, "nothing left");
        bytes memory sig = _voucher(alice, ONE, 2, block.timestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.DailyOutflowCapExceeded.selector, day, ONE, 0));
        vm.prank(alice);
        vault.withdraw(ONE, 2, block.timestamp + 60, sig);
    }

    function test_withdraw_revertsWhenVaultAssetsInsufficient() public {
        _deposit(alice, 10 * ONE);
        bytes memory sig = _voucher(alice, 20 * ONE, 1, block.timestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InsufficientAssets.selector, 20 * ONE, 10 * ONE));
        vm.prank(alice);
        vault.withdraw(20 * ONE, 1, block.timestamp + 60, sig);
    }

    function test_withdraw_donationsDoNotBackVouchers() public {
        _deposit(alice, 10 * ONE);
        vm.prank(bob);
        assertTrue(token.transfer(address(vault), 100 * ONE), "transfer"); // raw donation, not accounted
        bytes memory sig = _voucher(alice, 20 * ONE, 1, block.timestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InsufficientAssets.selector, 20 * ONE, 10 * ONE));
        vm.prank(alice);
        vault.withdraw(20 * ONE, 1, block.timestamp + 60, sig);
    }

    function test_withdraw_revertsWhenPausedAndResumesAfter() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.prank(operator);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);

        vm.prank(operator);
        vault.unpause();
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
        assertTrue(vault.nonceUsed(alice, 1), "redeemed after unpause");
    }

    function test_withdraw_signerRotationInvalidatesOutstandingVouchers() public {
        _fund(HOUSE);
        uint256 expiry = block.timestamp + 3 days;
        bytes memory oldSig = _voucher(alice, ONE, 1, expiry);
        uint256 newPk = keyFor("ledger-signer-2");
        vm.prank(operator);
        vault.proposeLedgerSigner(vm.addr(newPk));
        // Until the rotation lands, the current signer's vouchers stay valid and the proposed key's do not.
        bytes memory earlySig = _sign(newPk, _digest(address(vault), alice, ONE, 2, expiry));
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 2, expiry, earlySig);
        vm.warp(vault.pendingLedgerSignerEta());
        vm.prank(operator);
        vault.acceptLedgerSigner();

        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, oldSig);

        bytes memory newSig = _sign(newPk, _digest(address(vault), alice, ONE, 1, expiry));
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, newSig);
        assertTrue(vault.nonceUsed(alice, 1), "new signer voucher redeemed");
    }

    function test_withdraw_blocksReentrancy() public {
        (ReentrantToken hook, MayaHouseVault v) = _hookVault();
        vm.prank(operator);
        hook.approve(address(v), type(uint256).max);
        vm.prank(operator);
        v.fundHouse(1_000 * ONE);

        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _sign(signerPk, _digest(address(v), alice, ONE, 1, expiry));
        bytes memory sig2 = _sign(signerPk, _digest(address(v), address(hook), ONE, 2, expiry));
        hook.arm(address(v), abi.encodeCall(MayaHouseVault.withdraw, (ONE, 2, expiry, sig2)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        v.withdraw(ONE, 1, expiry, sig);

        // Cross-function: re-entering deposit from the payout callback is blocked as well.
        hook.arm(address(v), abi.encodeCall(MayaHouseVault.deposit, (1)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(alice);
        v.withdraw(ONE, 1, expiry, sig);
    }

    function test_withdraw_feeOnTransferKeepsBalanceCoveringAssets() public {
        (FeeOnTransferToken fot, MayaHouseVault v) = _feeVault(100);
        vm.prank(alice);
        v.deposit(1_000 * ONE); // 990 credited
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _sign(signerPk, _digest(address(v), alice, 500 * ONE, 1, expiry));
        uint256 before = fot.balanceOf(alice);
        vm.prank(alice);
        v.withdraw(500 * ONE, 1, expiry, sig);
        assertEq(v.assets(), 490 * ONE, "assets debited by voucher amount");
        assertEq(fot.balanceOf(address(v)), v.assets(), "balance == assets");
        assertEq(fot.balanceOf(alice) - before, 495 * ONE, "token fee borne by the recipient");
    }

    function test_withdraw_revertsWhenTokenReturnsFalse() public {
        vm.startPrank(operator);
        FalseReturnToken bad = new FalseReturnToken(1_000 * ONE);
        MayaHouseVault v = new MayaHouseVault(bad, signer, ESCAPE_DELAY);
        bad.approve(address(v), type(uint256).max);
        v.fundHouse(100 * ONE);
        vm.stopPrank();
        bad.setFailTransfers(true);

        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _sign(signerPk, _digest(address(v), alice, ONE, 1, expiry));
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        vm.prank(alice);
        v.withdraw(ONE, 1, expiry, sig);
    }

    // ================================================================ attest

    function test_attest_storesSnapshotAndEmits() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 10);
        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60);
        vm.warp(START + 20);

        bytes32 root = keccak256("ledger-root-1");
        uint64 asOf = START64 + 15;
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.Attested(1, 200 * ONE, root, asOf, 1_200 * ONE, 0);
        vm.prank(signer);
        vault.attest(200 * ONE, root, asOf, 1);

        assertEq(vault.attestedLiabilities(), 200 * ONE, "liabilities");
        assertEq(vault.attestedLedgerRoot(), root, "root");
        assertEq(vault.attestationSeq(), 1, "seq");
        assertEq(vault.attestationAsOf(), asOf, "asOf");
        assertEq(vault.attestedAt(), START + 20, "attestedAt");
        assertEq(vault.attestationSigner(), signer, "attestor");
        assertEq(vault.assetsAtAttest(), 1_200 * ONE, "assets snapshot");
        assertEq(vault.depositsSinceAttest(), 0, "deposits reset");
        assertEq(vault.claimedSinceAttest(), 0, "claims reset");
        assertEq(vault.attestationAge(), 5, "age from asOf");
    }

    function test_attest_depositsAtOrAfterAsOfStayUnattested() public {
        _deposit(alice, 100 * ONE); // t = START
        vm.warp(START + 10);
        _deposit(bob, 50 * ONE); // t = START + 10
        vm.warp(START + 20);

        _attest(0, START64 + 10, 1);
        assertEq(vault.depositsSinceAttest(), 50 * ONE, "deposit mined at asOf is not assumed indexed");

        _attest(0, START64 + 11, 2);
        assertEq(vault.depositsSinceAttest(), 0, "deposits strictly before asOf are covered");

        _attest(0, START64, 3);
        assertEq(vault.depositsSinceAttest(), 150 * ONE, "an earlier asOf re-counts deposits (conservative)");

        _attest(0, 0, 4);
        assertEq(vault.depositsSinceAttest(), 150 * ONE, "asOf 0 treats every deposit as unattested");

        vm.warp(START + 30);
        _deposit(carol, 5 * ONE);
        assertEq(vault.depositsSinceAttest(), 155 * ONE, "later deposits accrue");
    }

    function test_attest_emitsCarriedDeposits() public {
        _deposit(alice, 100 * ONE);
        vm.warp(START + 10);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.Attested(1, 0, bytes32(0), START64, 100 * ONE, 100 * ONE);
        vm.prank(signer);
        vault.attest(0, bytes32(0), START64, 1);
    }

    function test_attest_claimsNetOnlyAfterTheAttestIsMined() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 10);
        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60); // before attest
        _attest(200 * ONE, START64 + 5, 1); // asOf predates that claim
        assertEq(vault.claimedSinceAttest(), 0, "pre-attest claim not netted (conservative)");
        _withdraw(alice, 40 * ONE, 2, block.timestamp + 60); // after attest
        assertEq(vault.claimedSinceAttest(), 40 * ONE, "post-attest claim netted");
        assertEq(vault.requiredAssets(), 160 * ONE, "200 - 40");
    }

    function test_attest_revertsForNonSigner() public {
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NotLedgerSigner.selector, operator));
        vm.prank(operator);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 1);

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NotLedgerSigner.selector, alice));
        vm.prank(alice);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 1);
    }

    function test_attest_requiresStrictlyIncreasingSeq() public {
        vm.startPrank(signer);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonIncreasingSeq.selector, 0, 0));
        vault.attest(0, bytes32(0), uint64(block.timestamp), 0);

        vault.attest(0, bytes32(0), uint64(block.timestamp), 5);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonIncreasingSeq.selector, 5, 5));
        vault.attest(0, bytes32(0), uint64(block.timestamp), 5);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonIncreasingSeq.selector, 4, 5));
        vault.attest(0, bytes32(0), uint64(block.timestamp), 4);

        vault.attest(0, bytes32(0), uint64(block.timestamp), 100); // gaps are allowed
        vm.stopPrank();
        assertEq(vault.attestationSeq(), 100, "seq");
    }

    function test_attest_rejectsFutureAsOfButAcceptsNow() public {
        uint64 future = uint64(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.AttestationFromFuture.selector, future, block.timestamp));
        vm.prank(signer);
        vault.attest(0, bytes32(0), future, 1);

        _attest(0, uint64(block.timestamp), 1);
        assertEq(vault.attestationAge(), 0, "fresh");
    }

    function test_attest_allowedWhilePaused() public {
        vm.prank(operator);
        vault.pause();
        _attest(7, uint64(block.timestamp), 1);
        assertEq(vault.attestedLiabilities(), 7, "attested while paused");
    }

    // ================================================================ houseSurplus / requiredAssets

    function test_houseSurplus_beforeAnyAttestationIsTheBankroll() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        assertEq(vault.requiredAssets(), 300 * ONE, "all deposits owed");
        assertEq(vault.houseSurplus(), HOUSE, "only the bankroll is surplus");
        assertEq(vault.houseSurplus(), _expectedSurplus(), "reference");
    }

    function test_houseSurplus_followsAttestedLiabilities() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 10);
        _attestNow(250 * ONE); // alice lost 50 off-chain
        assertEq(vault.houseSurplus(), 1_050 * ONE, "1300 - 250");
        _attestNow(900 * ONE); // players up 600 incl. open max payouts
        assertEq(vault.houseSurplus(), 400 * ONE, "1300 - 900");
        assertEq(vault.houseSurplus(), _expectedSurplus(), "reference");
    }

    function test_houseSurplus_floorsAtZero() public {
        _fund(HOUSE);
        _attestNow(HOUSE + 1);
        assertEq(vault.houseSurplus(), 0, "insolvent attestation leaves no surplus");
    }

    function test_requiredAssets_floorsWhenClaimsExceedObligations() public {
        _fund(HOUSE);
        _attestNow(0);
        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60);
        assertEq(vault.requiredAssets(), 0, "floored at zero");
        assertEq(vault.houseSurplus(), 900 * ONE, "assets");
    }

    function test_requiredAssets_saturatesOnAbsurdLiabilities() public {
        _fund(HOUSE);
        _attestNow(type(uint256).max);
        vm.warp(START + 1);
        _deposit(alice, ONE);
        assertEq(vault.requiredAssets(), type(uint256).max, "saturated");
        assertEq(vault.houseSurplus(), 0, "no surplus, no overflow");
    }

    function test_houseSurplus_ignoresDonations() public {
        _fund(HOUSE);
        _attestNow(0);
        vm.prank(alice);
        assertTrue(token.transfer(address(vault), 500 * ONE), "transfer");
        assertEq(vault.assets(), HOUSE, "donation not counted");
        assertEq(vault.houseSurplus(), HOUSE, "surplus unchanged");
        assertGe(token.balanceOf(address(vault)), vault.assets(), "balance covers assets");
    }

    // ================================================================ withdrawHouse

    function test_withdrawHouse_paysSurplusAboveTheBufferExactly() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 1); // the ledger has indexed the deposit: asOf is after its block
        _attestNow(300 * ONE);
        address treasury = makeAddr("treasury");
        assertEq(vault.houseBuffer(), 30 * ONE, "10% of the 300 attested");
        assertEq(vault.houseBuffer(), _expectedBuffer(), "reference buffer");
        assertEq(vault.houseWithdrawable(), 970 * ONE, "surplus minus buffer");

        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.HouseWithdrawn(treasury, 400 * ONE);
        vm.prank(operator);
        vault.withdrawHouse(400 * ONE, treasury);
        assertEq(token.balanceOf(treasury), 400 * ONE, "treasury paid");
        assertEq(vault.houseWithdrawn(), 400 * ONE, "houseWithdrawn");
        assertEq(vault.houseSurplus(), 600 * ONE, "surplus reduced");
        assertEq(vault.houseDailyOutflow(START / 1 days), 400 * ONE, "daily house outflow");

        vm.prank(operator);
        vault.withdrawHouse(570 * ONE, operator);
        assertEq(vault.houseSurplus(), 30 * ONE, "only the buffer is left");
        assertEq(vault.houseWithdrawable(), 0, "nothing withdrawable");
        assertEq(vault.assets(), 330 * ONE, "player funds and buffer intact");

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseWithdrawable.selector, 1, 0));
        vm.prank(operator);
        vault.withdrawHouse(1, operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseSurplus.selector, 30 * ONE + 1, 30 * ONE));
        vm.prank(operator);
        vault.withdrawHouse(30 * ONE + 1, operator);
    }

    function test_withdrawHouse_revertsAboveSurplus() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 1);
        _attestNow(300 * ONE);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseSurplus.selector, HOUSE + 1, HOUSE));
        vm.prank(operator);
        vault.withdrawHouse(HOUSE + 1, operator);
    }

    function test_withdrawHouse_keepsTheBufferOnTopOfObligations() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 1);
        _attestNow(300 * ONE);
        // Inside the surplus but inside the buffer: refused with the withdrawable amount.
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseWithdrawable.selector, 971 * ONE, 970 * ONE));
        vm.prank(operator);
        vault.withdrawHouse(971 * ONE, operator);
        vm.prank(operator);
        vault.withdrawHouse(970 * ONE, operator);
        assertEq(vault.assets(), vault.requiredAssets() + vault.houseBuffer(), "exactly obligations + buffer left");
    }

    function test_withdrawHouse_bufferRoundsUpAndCanExceedTheSurplus() public {
        _fund(HOUSE);
        vm.warp(START + 1);
        _attestNow(1); // 1 wei of obligations: a 10% buffer still keeps 1 wei
        assertEq(vault.houseBuffer(), 1, "ceil(0.1 wei) = 1 wei");
        _attestNow(HOUSE - 50 * ONE); // surplus 50 < buffer 95
        assertEq(vault.houseSurplus(), 50 * ONE, "surplus");
        assertEq(vault.houseWithdrawable(), 0, "buffer larger than the surplus");
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseWithdrawable.selector, ONE, 0));
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);
    }

    function test_withdrawHouse_enforcesTheDailyHouseCapByUtcDay() public {
        _fund(HOUSE);
        _setHouseLimits(1_000, 100 * ONE); // tightening: applies at once
        uint256 day = block.timestamp / 1 days;
        _attestNow(0);
        vm.prank(operator);
        vault.withdrawHouse(60 * ONE, operator);
        assertEq(vault.remainingHouseDailyOutflow(), 40 * ONE, "40 left today");
        assertEq(vault.houseWithdrawable(), 40 * ONE, "the cap binds before the surplus");
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.HouseDailyCapExceeded.selector, day, 41 * ONE, 40 * ONE));
        vm.prank(operator);
        vault.withdrawHouse(41 * ONE, operator);

        _setHouseLimits(1_000, 50 * ONE); // lowered below the usage of the day: nothing more today
        assertEq(vault.remainingHouseDailyOutflow(), 0, "cap below usage");
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.HouseDailyCapExceeded.selector, day, 1, 0));
        vm.prank(operator);
        vault.withdrawHouse(1, operator);

        vm.warp((day + 1) * 1 days); // next UTC day: fresh budget, fresh attestation needed
        _attestNow(0);
        vm.prank(operator);
        vault.withdrawHouse(50 * ONE, operator);
        assertEq(vault.houseDailyOutflow(day + 1), 50 * ONE, "new day total");
        assertEq(vault.houseDailyOutflow(day), 60 * ONE, "previous day total");
    }

    function test_withdrawHouse_capIsSeparateFromThePlayersDailyCap() public {
        _fund(HOUSE);
        _setLimits(100 * ONE, 100 * ONE, 10 minutes);
        _attestNow(0);
        vm.prank(operator);
        vault.withdrawHouse(500 * ONE, operator);
        assertEq(vault.remainingDailyOutflow(), 100 * ONE, "players keep their whole budget");
        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60);
        assertEq(vault.remainingHouseDailyOutflow(), 10_000_000 * ONE - 500 * ONE, "house budget unaffected");
    }

    function test_withdrawHouse_cannotReachDepositsMadeAfterAttest() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 10);
        _attestNow(300 * ONE);
        vm.warp(START + 20);
        _deposit(bob, 500 * ONE);
        assertEq(vault.houseSurplus(), HOUSE, "new deposit is owed, not surplus");
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseSurplus.selector, HOUSE + 1, HOUSE));
        vm.prank(operator);
        vault.withdrawHouse(HOUSE + 1, operator);
        assertEq(vault.houseBuffer(), 80 * ONE, "the buffer grows with the unattested deposit");
    }

    function test_withdrawHouse_claimsAfterAttestLeaveSurplusUnchanged() public {
        _fund(HOUSE);
        _deposit(alice, 300 * ONE);
        vm.warp(START + 1);
        _attestNow(300 * ONE);
        _withdraw(alice, 100 * ONE, 1, block.timestamp + 60);
        assertEq(vault.houseSurplus(), HOUSE, "claim reduces assets and obligations equally");
        assertEq(vault.houseBuffer(), 20 * ONE, "buffer follows the remaining obligations");
    }

    function test_withdrawHouse_revertsForNonOwner() public {
        _fund(HOUSE);
        _attestNow(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        vm.prank(signer);
        vault.withdrawHouse(ONE, signer);
    }

    function test_withdrawHouse_validatesArguments() public {
        _fund(HOUSE);
        _attestNow(0);
        vm.startPrank(operator);
        vm.expectRevert(IMayaHouseVault.ZeroAmount.selector);
        vault.withdrawHouse(0, operator);
        vm.expectRevert(IMayaHouseVault.ZeroAddress.selector);
        vault.withdrawHouse(ONE, address(0));
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidRecipient.selector, address(vault)));
        vault.withdrawHouse(ONE, address(vault));
        vm.stopPrank();
    }

    function test_withdrawHouse_requiresAnAttestation() public {
        _fund(HOUSE);
        vm.expectRevert(IMayaHouseVault.NoAttestation.selector);
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);
    }

    function test_withdrawHouse_requiresFreshAttestation() public {
        _fund(HOUSE);
        _attest(0, START64 - 100, 1);
        vm.warp(START - 100 + 10 minutes); // age == max (10 min default): allowed
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);

        vm.warp(START - 100 + 10 minutes + 1);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.AttestationTooOld.selector, 10 minutes + 1, 10 minutes));
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);
    }

    function test_withdrawHouse_requiresAttestationFromCurrentSigner() public {
        _fund(HOUSE);
        address newSigner = vm.addr(keyFor("ledger-signer-2"));
        vm.prank(operator);
        vault.proposeLedgerSigner(newSigner);
        vm.warp(vault.pendingLedgerSignerEta());
        _attestNow(0); // the old signer still attests until the rotation is accepted
        vm.prank(operator);
        vault.acceptLedgerSigner();
        vm.expectRevert(
            abi.encodeWithSelector(IMayaHouseVault.AttestationBySupersededSigner.selector, signer, newSigner)
        );
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NotLedgerSigner.selector, signer));
        vm.prank(signer);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 2);

        vm.prank(newSigner);
        vault.attest(0, bytes32(0), uint64(block.timestamp), 2);
        vm.prank(operator);
        vault.withdrawHouse(ONE, operator);
        assertEq(vault.houseWithdrawn(), ONE, "withdrawn under the new signer's attestation");
    }

    function test_withdrawHouse_revertsWhenPaused() public {
        _fund(HOUSE);
        _attestNow(0);
        vm.startPrank(operator);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.withdrawHouse(ONE, operator);
        vm.stopPrank();
    }

    // ================================================================ owner admin

    function test_pause_unpause_emitAndGate() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit Pausable.Paused(operator);
        vm.prank(operator);
        vault.pause();
        assertTrue(vault.paused(), "paused");

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(operator);
        vault.pause();

        vm.expectEmit(true, true, true, true, address(vault));
        emit Pausable.Unpaused(operator);
        vm.prank(operator);
        vault.unpause();
        assertFalse(vault.paused(), "unpaused");

        vm.expectRevert(Pausable.ExpectedPause.selector);
        vm.prank(operator);
        vault.unpause();
    }

    function test_pause_unpause_onlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, signer));
        vm.prank(signer);
        vault.pause();

        vm.prank(operator);
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.unpause();
    }

    function test_setLimits_updatesAndEmits() public {
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsUpdated(5 * ONE, 5 * ONE, 5 * ONE, 1 minutes);
        _setLimits(5 * ONE, 5 * ONE, 1 minutes); // boundaries: voucher == account cap == cap
        assertEq(vault.maxVoucherAmount(), 5 * ONE, "max voucher");
        assertEq(vault.dailyOutflowCap(), 5 * ONE, "cap");
        assertEq(vault.accountDailyOutflowCap(), 5 * ONE, "account cap");
        assertEq(vault.maxAttestationAge(), 1 minutes, "age");

        // age == limit is a loosening: it takes effect through the timelock (CS-L1).
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsProposed(5 * ONE, 5 * ONE, 5 * ONE, 1 days, START + 48 hours);
        vm.prank(operator);
        vault.setLimits(5 * ONE, 5 * ONE, 5 * ONE, 1 days);
        vm.warp(START + 48 hours);
        vm.expectEmit(true, true, true, true, address(vault));
        emit IMayaHouseVault.LimitsUpdated(5 * ONE, 5 * ONE, 5 * ONE, 1 days);
        vm.prank(operator);
        vault.acceptLimits();
        assertEq(vault.maxAttestationAge(), 1 days, "age");
    }

    function test_setLimits_rejectsInvalidCombinations() public {
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, 0, ONE, ONE, 1 hours));
        vault.setLimits(0, ONE, ONE, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, 2 * ONE, ONE, ONE, 1 hours));
        vault.setLimits(2 * ONE, ONE, ONE, 1 hours);
        // voucher above the per-account share, and a per-account share above the shared cap
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, 2 * ONE, 3 * ONE, ONE, 1 hours));
        vault.setLimits(2 * ONE, 3 * ONE, ONE, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, ONE, 2 * ONE, 3 * ONE, 1 hours));
        vault.setLimits(ONE, 2 * ONE, 3 * ONE, 1 hours);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, ONE, ONE, ONE, 0));
        vault.setLimits(ONE, ONE, ONE, 0);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, ONE, ONE, ONE, 1 days + 1));
        vault.setLimits(ONE, ONE, ONE, 1 days + 1);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.setLimits(ONE, ONE, ONE, 1 hours);
    }

    function test_renounceOwnership_isDisabled() public {
        vm.expectRevert(IMayaHouseVault.RenounceDisabled.selector);
        vm.prank(operator);
        vault.renounceOwnership();
        assertEq(vault.owner(), operator, "owner unchanged");
    }

    function test_transferOwnership_isTwoStep() public {
        address nextOwner = makeAddr("next-owner");
        vm.expectEmit(true, true, true, true, address(vault));
        emit Ownable2Step.OwnershipTransferStarted(operator, nextOwner);
        vm.prank(operator);
        vault.transferOwnership(nextOwner);
        assertEq(vault.owner(), operator, "still owner until accepted");
        assertEq(vault.pendingOwner(), nextOwner, "pending");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.acceptOwnership();

        vm.expectEmit(true, true, true, true, address(vault));
        emit Ownable.OwnershipTransferred(operator, nextOwner);
        vm.prank(nextOwner);
        vault.acceptOwnership();
        assertEq(vault.owner(), nextOwner, "accepted");
        assertEq(vault.pendingOwner(), address(0), "pending cleared");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        vm.prank(operator);
        vault.pause();
        vm.prank(nextOwner);
        vault.pause();
        assertTrue(vault.paused(), "new owner controls the vault");
    }

    function test_transferOwnership_canBeCancelled() public {
        address nextOwner = makeAddr("next-owner");
        vm.startPrank(operator);
        vault.transferOwnership(nextOwner);
        vault.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(vault.pendingOwner(), address(0), "cancelled");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nextOwner));
        vm.prank(nextOwner);
        vault.acceptOwnership();
    }

    function test_transferOwnership_rejectsLedgerSignerAndStrangers() public {
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SignerIsOwner.selector, signer));
        vm.prank(operator);
        vault.transferOwnership(signer);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.transferOwnership(alice);
    }

    // ================================================================ views

    function test_attestationAge_isMaxBeforeFirstAttestation() public {
        assertEq(vault.attestationAge(), type(uint256).max, "never attested");
        _attest(0, START64 - 100, 1);
        assertEq(vault.attestationAge(), 100, "age");
        vm.warp(START + 50);
        assertEq(vault.attestationAge(), 150, "ages with time");
    }

    function test_remainingDailyOutflow_tracksUsage() public {
        _fund(HOUSE);
        assertEq(vault.remainingDailyOutflow(), vault.DEFAULT_DAILY_OUTFLOW_CAP(), "full budget");
        _withdraw(alice, 10 * ONE, 1, block.timestamp + 60);
        assertEq(vault.remainingDailyOutflow(), vault.DEFAULT_DAILY_OUTFLOW_CAP() - 10 * ONE, "used");
        assertEq(vault.currentDay(), START / 1 days, "UTC day index");
    }

    // ================================================================ helpers

    /// @dev Instant (tightening) limit change; the per-account share equals the shared cap so it never binds first.
    function _setLimits(uint256 maxVoucher, uint256 cap, uint256 age) internal {
        vm.prank(operator);
        vault.setLimits(maxVoucher, cap, cap, age);
        assertEq(vault.pendingLimitsEta(), 0, "tightening applies at once");
    }

    function _feeVault(uint256 feeBps) internal returns (FeeOnTransferToken fot, MayaHouseVault v) {
        vm.startPrank(operator);
        fot = new FeeOnTransferToken(10_000_000 * ONE, 0);
        v = new MayaHouseVault(fot, signer, ESCAPE_DELAY);
        assertTrue(fot.transfer(alice, 1_000_000 * ONE), "transfer");
        vm.stopPrank();
        vm.prank(alice);
        fot.approve(address(v), type(uint256).max);
        fot.setFeeBps(feeBps);
    }

    function _hookVault() internal returns (ReentrantToken hook, MayaHouseVault v) {
        vm.startPrank(operator);
        hook = new ReentrantToken(10_000_000 * ONE);
        v = new MayaHouseVault(hook, signer, ESCAPE_DELAY);
        assertTrue(hook.transfer(alice, 1_000_000 * ONE), "transfer");
        vm.stopPrank();
        vm.prank(alice);
        hook.approve(address(v), type(uint256).max);
    }
}
