// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {BalanceTree} from "./utils/BalanceTree.sol";
import {MayaHouseVault} from "../src/MayaHouseVault.sol";
import {IMayaHouseVault} from "../src/interfaces/IMayaHouseVault.sol";
import {FeeOnTransferToken} from "./mocks/TestTokens.sol";

contract MayaHouseVaultFuzzTest is VaultFixture {
    uint256 internal constant BANKROLL = 100_000_000 * ONE;
    uint256 internal constant MAX_VOUCHER = 100_000 * ONE;

    function setUp() public override {
        super.setUp();
        _fund(BANKROLL);
    }

    // ---------------------------------------------------------------- deposits

    function testFuzz_deposit_accountsExactly(uint256 a, uint256 b) public {
        a = bound(a, 1, PLAYER_TOKENS);
        b = bound(b, 1, PLAYER_TOKENS);
        _deposit(alice, a);
        _deposit(bob, b);
        assertEq(vault.totalPlayerDeposits(), a + b, "deposits");
        assertEq(vault.depositCount(), 2, "count");
        assertEq(vault.assets(), BANKROLL + a + b, "assets");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
    }

    function testFuzz_deposit_feeOnTransferCreditsMeasuredAmount(uint256 amount, uint256 feeBps) public {
        amount = bound(amount, 1, 1_000_000 * ONE);
        feeBps = bound(feeBps, 0, 9_999);
        vm.startPrank(operator);
        FeeOnTransferToken fot = new FeeOnTransferToken(10_000_000 * ONE, 0);
        MayaHouseVault v = new MayaHouseVault(fot, signer, ESCAPE_DELAY);
        assertTrue(fot.transfer(alice, 1_000_000 * ONE), "transfer");
        vm.stopPrank();
        fot.setFeeBps(feeBps);

        uint256 received = amount - (amount * feeBps) / 10_000;
        vm.startPrank(alice);
        fot.approve(address(v), amount);
        vm.expectEmit(true, true, true, true, address(v));
        emit IMayaHouseVault.Deposited(alice, received, 1);
        v.deposit(amount);
        vm.stopPrank();
        assertEq(v.totalPlayerDeposits(), received, "credited what arrived");
        assertEq(fot.balanceOf(address(v)), v.assets(), "balance == assets");
    }

    function testFuzz_depositsSinceAttest_cutsAtAsOf(uint256 gap1, uint256 gap2, uint256 asOfOffset) public {
        gap1 = bound(gap1, 1, 30 days);
        gap2 = bound(gap2, 1, 30 days);
        uint256 t1 = START + gap1;
        uint256 t2 = t1 + gap2;
        vm.warp(t1);
        _deposit(alice, 10 * ONE);
        vm.warp(t2);
        _deposit(bob, 20 * ONE);
        vm.warp(t2 + 1);

        uint256 asOf = bound(asOfOffset, 0, t2 + 1);
        _attest(0, SafeCast.toUint64(asOf), 1);
        uint256 expected = asOf <= t1 ? 30 * ONE : asOf <= t2 ? 20 * ONE : 0;
        assertEq(vault.depositsSinceAttest(), expected, "deposits mined at or after asOf stay unattested");
    }

    // ---------------------------------------------------------------- withdrawals

    function testFuzz_withdraw_validVoucherRedeemsExactlyOnce(uint256 amount, uint256 nonce, uint256 ttl, uint256 wait)
        public
    {
        amount = bound(amount, 1, MAX_VOUCHER);
        ttl = bound(ttl, 0, 365 days);
        wait = bound(wait, 0, ttl);
        uint256 expiry = block.timestamp + ttl;
        bytes memory sig = _voucher(alice, amount, nonce, expiry);
        vm.warp(block.timestamp + wait);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        vault.withdraw(amount, nonce, expiry, sig);
        assertEq(token.balanceOf(alice) - before, amount, "paid");
        assertTrue(vault.nonceUsed(alice, nonce), "nonce consumed");
        assertEq(vault.assets(), BANKROLL - amount, "assets");

        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonceAlreadyUsed.selector, alice, nonce));
        vm.prank(alice);
        vault.withdraw(amount, nonce, expiry, sig);
    }

    function testFuzz_withdraw_rejectsExpired(uint256 expiry, uint256 nowTs) public {
        nowTs = bound(nowTs, START, type(uint64).max);
        expiry = bound(expiry, 0, nowTs - 1);
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.warp(nowTs);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.VoucherExpired.selector, expiry, nowTs));
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function testFuzz_withdraw_rejectsAboveMax(uint256 amount) public {
        amount = bound(amount, MAX_VOUCHER + 1, type(uint256).max);
        bytes memory sig = _voucher(alice, amount, 1, block.timestamp + 60);
        vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.VoucherAboveMax.selector, amount, MAX_VOUCHER));
        vm.prank(alice);
        vault.withdraw(amount, 1, block.timestamp + 60, sig);
    }

    function testFuzz_withdraw_rejectsForeignSigner(uint256 pk, uint256 amount, uint256 nonce) public {
        pk = bound(pk, 1, SECP256K1_N - 1);
        vm.assume(pk != signerPk);
        amount = bound(amount, 1, MAX_VOUCHER);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _sign(pk, _digest(address(vault), alice, amount, nonce, expiry));
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(amount, nonce, expiry, sig);
    }

    function testFuzz_withdraw_rejectsAnyTamperedTerm(
        uint256 amount,
        uint256 nonce,
        uint256 ttl,
        uint8 field,
        uint256 replacement,
        address redeemer
    ) public {
        amount = bound(amount, 1, MAX_VOUCHER);
        ttl = bound(ttl, 1, 30 days);
        uint256 expiry = block.timestamp + ttl;
        bytes memory sig = _voucher(alice, amount, nonce, expiry);

        address account = alice;
        uint256 a = amount;
        uint256 n = nonce;
        uint256 e = expiry;
        field = field % 4;
        if (field == 0) {
            a = bound(replacement, 1, MAX_VOUCHER);
            vm.assume(a != amount);
        } else if (field == 1) {
            vm.assume(replacement != nonce);
            n = replacement;
        } else if (field == 2) {
            e = bound(replacement, block.timestamp, type(uint256).max);
            vm.assume(e != expiry);
        } else {
            vm.assume(redeemer != alice && redeemer != address(vm));
            account = redeemer;
        }
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(account);
        vault.withdraw(a, n, e, sig);
    }

    function testFuzz_withdraw_rejectsCrossChainReplay(uint64 chainId) public {
        vm.assume(chainId != 0 && chainId != block.chainid);
        uint256 expiry = block.timestamp + 60;
        bytes memory sig = _voucher(alice, ONE, 1, expiry);
        vm.chainId(chainId);
        vm.expectRevert(IMayaHouseVault.InvalidSignature.selector);
        vm.prank(alice);
        vault.withdraw(ONE, 1, expiry, sig);
    }

    function testFuzz_withdraw_dailyCapHoldsWithinAUtcDay(uint256 cap, uint256 a, uint256 b, uint256 secondsIn) public {
        cap = bound(cap, 2, 1_000_000 * ONE);
        a = bound(a, 1, cap);
        b = bound(b, 1, cap);
        _applyLimits(cap, cap, cap, 10 minutes); // raising the per-account share waits the timelock
        uint256 day = block.timestamp / 1 days;
        vm.warp(day * 1 days + bound(secondsIn, 0, 1 days - 2));
        uint256 expiry = (day + 2) * 1 days;
        _withdraw(alice, a, 1, expiry);

        vm.warp(block.timestamp + 1); // still the same UTC day
        bytes memory sig = _voucher(bob, b, 1, expiry);
        if (a + b <= cap) {
            vm.prank(bob);
            vault.withdraw(b, 1, expiry, sig);
            assertEq(vault.dailyOutflow(day), a + b, "within cap");
        } else {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.DailyOutflowCapExceeded.selector, day, b, cap - a));
            vm.prank(bob);
            vault.withdraw(b, 1, expiry, sig);
            assertEq(vault.dailyOutflow(day), a, "rejected voucher left no trace");
        }
        assertLe(vault.dailyOutflow(day), cap, "cap never exceeded");
    }

    // ---------------------------------------------------------------- attestation and surplus

    /// @dev Strictly increasing, by at most MAX_ATTESTATION_SEQ_STEP per attestation (CS-H1).
    function testFuzz_attest_seqIncreasesByABoundedStep(uint64 first, uint64 second) public {
        uint64 maxStep = vault.MAX_ATTESTATION_SEQ_STEP();
        first = uint64(bound(first, 1, type(uint64).max));
        if (first > maxStep) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SeqStepTooLarge.selector, first, 0, maxStep));
            vm.prank(signer);
            vault.attest(0, bytes32(0), uint64(block.timestamp), first);
            first = uint64(bound(first, 1, maxStep));
        }
        _attest(0, uint64(block.timestamp), first);
        if (second <= first) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.NonIncreasingSeq.selector, second, first));
            vm.prank(signer);
            vault.attest(0, bytes32(0), uint64(block.timestamp), second);
        } else if (second - first > maxStep) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.SeqStepTooLarge.selector, second, first, maxStep));
            vm.prank(signer);
            vault.attest(0, bytes32(0), uint64(block.timestamp), second);
        } else {
            _attest(0, uint64(block.timestamp), second);
            assertEq(vault.attestationSeq(), second, "advanced");
            return;
        }
        assertEq(vault.attestationSeq(), first, "a refused seq leaves the stored one");
    }

    function testFuzz_attest_asOfNeverInTheFuture(uint64 asOf) public {
        if (asOf > block.timestamp) {
            vm.expectRevert(
                abi.encodeWithSelector(IMayaHouseVault.AttestationFromFuture.selector, asOf, block.timestamp)
            );
            vm.prank(signer);
            vault.attest(0, bytes32(0), asOf, 1);
        } else {
            _attest(0, asOf, 1);
            assertEq(vault.attestationAge(), block.timestamp - asOf, "age");
        }
    }

    function testFuzz_houseSurplus_matchesSpecFormula(
        uint256 deposited,
        uint256 liabilities,
        uint256 claimedBefore,
        uint256 claimedAfter,
        uint256 lateDeposit
    ) public {
        deposited = bound(deposited, 1, PLAYER_TOKENS);
        lateDeposit = bound(lateDeposit, 1, PLAYER_TOKENS);
        liabilities = bound(liabilities, 0, 2 * BANKROLL);
        claimedBefore = bound(claimedBefore, 1, MAX_VOUCHER);
        claimedAfter = bound(claimedAfter, 1, MAX_VOUCHER);

        _deposit(alice, deposited);
        _withdraw(alice, claimedBefore, 1, block.timestamp + 60);
        vm.warp(block.timestamp + 1);
        _attestNow(liabilities);
        assertEq(vault.depositsSinceAttest(), 0, "deposit indexed");
        assertEq(vault.claimedSinceAttest(), 0, "claims reset");

        vm.warp(block.timestamp + 1);
        _deposit(bob, lateDeposit);
        _withdraw(alice, claimedAfter, 2, block.timestamp + 60);

        uint256 assets = BANKROLL + deposited + lateDeposit - claimedBefore - claimedAfter;
        uint256 owed = liabilities + lateDeposit;
        uint256 required = owed > claimedAfter ? owed - claimedAfter : 0;
        uint256 surplus = assets > required ? assets - required : 0;
        assertEq(vault.assets(), assets, "assets identity");
        assertEq(vault.requiredAssets(), required, "required");
        assertEq(vault.houseSurplus(), surplus, "surplus");
    }

    function testFuzz_withdrawHouse_neverBreachesRequiredAssets(
        uint256 deposited,
        uint256 liabilities,
        uint256 claimed,
        uint256 amount
    ) public {
        deposited = bound(deposited, 1, PLAYER_TOKENS);
        liabilities = bound(liabilities, 0, 2 * BANKROLL);
        claimed = bound(claimed, 1, MAX_VOUCHER);
        _deposit(alice, deposited);
        vm.warp(block.timestamp + 1);
        _attestNow(liabilities);
        _withdraw(alice, claimed, 1, block.timestamp + 60);

        uint256 surplus = vault.houseSurplus();
        uint256 required = vault.requiredAssets();
        uint256 buffer = _expectedBuffer();
        assertEq(vault.houseBuffer(), buffer, "buffer = ceil(required * 10%)");
        uint256 withdrawable = surplus > buffer ? surplus - buffer : 0;
        uint256 cap = vault.remainingHouseDailyOutflow();
        amount = bound(amount, 1, vault.assets());
        if (amount > surplus) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseSurplus.selector, amount, surplus));
        } else if (amount > withdrawable) {
            vm.expectRevert(
                abi.encodeWithSelector(IMayaHouseVault.ExceedsHouseWithdrawable.selector, amount, withdrawable)
            );
        } else if (amount > cap) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IMayaHouseVault.HouseDailyCapExceeded.selector, block.timestamp / 1 days, amount, cap
                )
            );
        }
        vm.prank(operator);
        vault.withdrawHouse(amount, operator);
        if (amount <= withdrawable && amount <= cap) {
            assertGe(vault.assets(), required + buffer, "assets stay >= attested obligations + buffer");
            assertEq(vault.houseSurplus(), surplus - amount, "surplus consumed");
            assertEq(vault.houseDailyOutflow(block.timestamp / 1 days), amount, "daily house outflow");
        }
    }

    function testFuzz_withdrawHouse_attestationAgeGate(uint256 maxAge, uint256 age) public {
        maxAge = bound(maxAge, 1, 1 days);
        age = bound(age, 0, 14 days);
        _applyLimits(MAX_VOUCHER, 1_000_000 * ONE, vault.accountDailyOutflowCap(), maxAge);
        _attestNow(0);
        vm.warp(block.timestamp + age);
        if (age <= maxAge) {
            vm.prank(operator);
            vault.withdrawHouse(ONE, operator);
            assertEq(vault.houseWithdrawn(), ONE, "fresh enough");
        } else {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.AttestationTooOld.selector, age, maxAge));
            vm.prank(operator);
            vault.withdrawHouse(ONE, operator);
        }
    }

    // ---------------------------------------------------------------- admin

    /// @dev Valid iff 0 < maxVoucher <= accountCap <= cap and 0 < maxAge <= 1 day; lowering or keeping every value
    ///      applies at once, raising any of them waits `signerChangeDelay` (CS-L1).
    function testFuzz_setLimits_acceptsExactlyTheValidRange(
        uint256 maxVoucher,
        uint256 cap,
        uint256 accountCap,
        uint256 maxAge
    ) public {
        maxVoucher = bound(maxVoucher, 0, 1e30);
        cap = bound(cap, 0, 1e30);
        accountCap = bound(accountCap, 0, 1e30);
        maxAge = bound(maxAge, 0, 30 days);
        bool valid = maxVoucher != 0 && maxVoucher <= accountCap && accountCap <= cap && maxAge != 0 && maxAge <= 1 days;
        bool tightening = maxVoucher <= vault.maxVoucherAmount() && cap <= vault.dailyOutflowCap()
            && accountCap <= vault.accountDailyOutflowCap() && maxAge <= vault.maxAttestationAge();
        if (!valid) {
            vm.expectRevert(
                abi.encodeWithSelector(IMayaHouseVault.InvalidLimits.selector, maxVoucher, cap, accountCap, maxAge)
            );
        }
        vm.prank(operator);
        vault.setLimits(maxVoucher, cap, accountCap, maxAge);
        if (!valid) return;
        if (!tightening) {
            assertEq(vault.pendingLimitsEta(), block.timestamp + SIGNER_DELAY, "loosening is scheduled");
            assertEq(vault.pendingMaxVoucherAmount(), maxVoucher, "pending max voucher");
            assertEq(vault.pendingDailyOutflowCap(), cap, "pending cap");
            assertEq(vault.pendingAccountDailyOutflowCap(), accountCap, "pending account cap");
            assertEq(vault.pendingMaxAttestationAge(), maxAge, "pending age");
            assertEq(vault.maxVoucherAmount(), 100_000 * ONE, "nothing applied before the eta");
            assertEq(vault.maxAttestationAge(), 10 minutes, "nothing applied before the eta");
            vm.warp(vault.pendingLimitsEta());
            vm.prank(operator);
            vault.acceptLimits();
        }
        assertEq(vault.pendingLimitsEta(), 0, "nothing pending");
        assertEq(vault.maxVoucherAmount(), maxVoucher, "max voucher");
        assertEq(vault.dailyOutflowCap(), cap, "cap");
        assertEq(vault.accountDailyOutflowCap(), accountCap, "account cap");
        assertEq(vault.maxAttestationAge(), maxAge, "age");
    }

    // ---------------------------------------------------------------- SPEC-11 hardening

    function testFuzz_houseBuffer_isTheCeilingShareOfRequiredAssets(uint256 liabilities, uint256 bps) public {
        bps = bound(bps, 0, 10_000);
        _setHouseLimits(bps, vault.houseDailyCap());
        _attestNow(liabilities);
        uint256 buffer = vault.houseBuffer();
        assertEq(buffer, _expectedBuffer(), "ceil(required * bps / 10_000)");
        assertLe(buffer, vault.requiredAssets(), "never above the obligations");
        uint256 surplus = vault.houseSurplus();
        uint256 afterBuffer = surplus > buffer ? surplus - buffer : 0;
        uint256 remaining = vault.remainingHouseDailyOutflow();
        assertEq(vault.houseWithdrawable(), afterBuffer < remaining ? afterBuffer : remaining, "withdrawable");
    }

    function testFuzz_setHouseLimits_onlyLooseningWaits(uint256 bps, uint256 cap) public {
        bps = bound(bps, 0, 10_000);
        cap = bound(cap, 1, 1e30);
        uint256 oldBps = vault.houseBufferBps();
        uint256 oldCap = vault.houseDailyCap();
        vm.prank(operator);
        vault.setHouseLimits(bps, cap);
        if (bps >= oldBps && cap <= oldCap) {
            assertEq(vault.houseBufferBps(), bps, "tightened now");
            assertEq(vault.houseDailyCap(), cap, "tightened now");
            assertEq(vault.pendingHouseLimitsEta(), 0, "nothing pending");
        } else {
            assertEq(vault.houseBufferBps(), oldBps, "unchanged buffer");
            assertEq(vault.houseDailyCap(), oldCap, "unchanged cap");
            assertEq(vault.pendingHouseLimitsEta(), block.timestamp + vault.signerChangeDelay(), "scheduled");
            vm.warp(block.timestamp + vault.signerChangeDelay());
            vm.prank(operator);
            vault.acceptHouseLimits();
            assertEq(vault.houseBufferBps(), bps, "applied after the delay");
            assertEq(vault.houseDailyCap(), cap, "applied after the delay");
        }
    }

    function testFuzz_setSignerChangeDelay_increaseNowDecreaseLater(uint256 newDelay) public {
        newDelay = bound(newDelay, 0, 60 days);
        bool valid = newDelay >= 1 hours && newDelay <= 30 days && newDelay < ESCAPE_DELAY;
        if (!valid) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.InvalidSignerChangeDelay.selector, newDelay));
        }
        vm.prank(operator);
        vault.setSignerChangeDelay(newDelay);
        if (!valid) return;
        if (newDelay >= SIGNER_DELAY) {
            assertEq(vault.signerChangeDelay(), newDelay, "increase applies at once");
        } else {
            assertEq(vault.signerChangeDelay(), SIGNER_DELAY, "decrease waits");
            assertEq(vault.pendingSignerChangeDelayEta(), block.timestamp + SIGNER_DELAY, "timed by the old delay");
        }
    }

    function testFuzz_acceptLedgerSigner_onlyAfterTheDelay(uint256 wait, uint256 keySeed) public {
        wait = bound(wait, 0, 4 days);
        address next = vm.addr(bound(keySeed, 1, SECP256K1_N - 1));
        vm.assume(next != signer && next != operator);
        vm.prank(operator);
        vault.proposeLedgerSigner(next);
        uint256 eta = block.timestamp + SIGNER_DELAY;
        vm.warp(block.timestamp + wait);
        if (wait < SIGNER_DELAY) {
            vm.expectRevert(abi.encodeWithSelector(IMayaHouseVault.TimelockNotElapsed.selector, eta, block.timestamp));
        }
        vm.prank(operator);
        vault.acceptLedgerSigner();
        assertEq(vault.ledgerSigner(), wait < SIGNER_DELAY ? signer : next, "rotation only after the delay");
    }

    function testFuzz_triggerEscape_onlyOnceAttestationsStopForTheDelay(uint256 attestAfter, uint256 wait) public {
        attestAfter = bound(attestAfter, 0, 6 days);
        wait = bound(wait, 0, 15 days);
        vm.warp(START + attestAfter);
        _attestNow(0);
        vm.warp(block.timestamp + wait);
        if (wait < ESCAPE_DELAY) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    IMayaHouseVault.EscapeNotYetAvailable.selector, START + attestAfter + ESCAPE_DELAY, block.timestamp
                )
            );
        }
        vault.triggerEscape();
        assertEq(vault.escapeMode(), wait >= ESCAPE_DELAY, "escape iff no attestation for escapeDelay");
    }

    function testFuzz_escape_honestRootPaysEveryoneExactlyOnce(uint256[3] memory seeds) public {
        address[] memory accounts = new address[](3);
        accounts[0] = alice;
        accounts[1] = bob;
        accounts[2] = carol;
        uint256[] memory leaves = new uint256[](3);
        uint256 liabilities;
        for (uint256 i; i < 3; ++i) {
            _deposit(accounts[i], bound(seeds[i], 1, 1_000_000 * ONE));
            leaves[i] = bound(uint256(keccak256(abi.encode(seeds[i], "leaf"))), 0, 2_000_000 * ONE);
            liabilities += leaves[i];
        }
        vm.warp(START + 1);
        BalanceTree.Tree memory tree = BalanceTree.build(accounts, leaves);
        _attestRoot(liabilities, BalanceTree.root(tree), START64 + 1);
        vm.warp(START + 2);
        uint256[] memory owed = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            uint256 extra = bound(uint256(keccak256(abi.encode(seeds[i], "deposit"))), 0, 1_000_000 * ONE);
            if (extra > 0) _deposit(accounts[i], extra);
            uint256 out = bound(uint256(keccak256(abi.encode(seeds[i], "withdraw"))), 0, leaves[i] + extra);
            if (out > MAX_VOUCHER) out = MAX_VOUCHER;
            if (out > 0) _withdraw(accounts[i], out, 1, START + 1 days);
            owed[i] = leaves[i] + extra - out;
            assertEq(vault.escapeEntitlement(accounts[i], leaves[i]), owed[i], "entitlement");
        }
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        assertLe(vault.escapePool(), liabilities + vault.depositsSinceAttest(), "pool <= attested + unattested");
        for (uint256 i; i < 3; ++i) {
            bytes32[] memory proof = BalanceTree.proof(tree, i);
            if (leaves[i] != 0) {
                vm.expectRevert(IMayaHouseVault.InvalidProof.selector);
                vm.prank(accounts[i]);
                vault.claimEscape(leaves[i] + 1, proof);
            }
            if (owed[i] == 0) {
                vm.expectRevert(IMayaHouseVault.NothingToClaim.selector);
                vm.prank(accounts[i]);
                vault.claimEscape(leaves[i], proof);
                continue;
            }
            uint256 before = token.balanceOf(accounts[i]);
            vm.prank(accounts[i]);
            vault.claimEscape(leaves[i], proof);
            assertEq(token.balanceOf(accounts[i]) - before, owed[i], "paid in full");
            vm.expectRevert(IMayaHouseVault.NothingToClaim.selector);
            vm.prank(accounts[i]);
            vault.claimEscape(leaves[i], proof);
        }
        assertLe(vault.escapeClaimedTotal(), vault.escapePool(), "claims within the pool");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
    }

    function testFuzz_escape_totalClaimsNeverExceedThePool(uint256 liabilities, uint256[3] memory claimedLeaves)
        public
    {
        address[] memory accounts = new address[](3);
        accounts[0] = alice;
        accounts[1] = bob;
        accounts[2] = carol;
        uint256[] memory leaves = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            _deposit(accounts[i], 100 * ONE);
            leaves[i] = bound(claimedLeaves[i], 1, 1_000_000_000 * ONE); // a root that may overstate liabilities
        }
        liabilities = bound(liabilities, 0, 1_000_000_000 * ONE);
        vm.warp(START + 1);
        BalanceTree.Tree memory tree = BalanceTree.build(accounts, leaves);
        _attestRoot(liabilities, BalanceTree.root(tree), START64 + 1);
        vm.warp(vault.escapeAvailableAt());
        vault.triggerEscape();
        uint256 pool = vault.escapePool();
        assertEq(pool, liabilities < vault.assets() ? liabilities : vault.assets(), "pool");
        for (uint256 i; i < 3; ++i) {
            uint256 remaining = pool - vault.escapeClaimedTotal();
            if (remaining == 0) vm.expectRevert(IMayaHouseVault.EscapePoolExhausted.selector);
            vm.prank(accounts[i]);
            vault.claimEscape(leaves[i], BalanceTree.proof(tree, i));
        }
        assertLe(vault.escapeClaimedTotal(), pool, "total escape claims <= pool <= attested liabilities");
        assertLe(vault.escapeClaimedTotal(), liabilities, "never above the attested liabilities");
    }

    function testFuzz_escapeEntitlement_cutsStrictlyAfterAsOf(uint256 gap, uint256 asOfOffset, uint256 leaf) public {
        gap = bound(gap, 0, 30 days);
        leaf = bound(leaf, 0, 1_000_000 * ONE);
        vm.warp(START + gap);
        _deposit(alice, 10 * ONE);
        _withdraw(alice, 4 * ONE, 1, START + 60 days);
        vm.warp(START + gap + 1);
        uint256 asOf = bound(asOfOffset, 0, START + gap + 1);
        _attestRoot(0, bytes32(0), SafeCast.toUint64(asOf));
        uint256 expected = asOf < START + gap ? leaf + 6 * ONE : leaf;
        assertEq(vault.escapeEntitlement(alice, leaf), expected, "flows at or before asOf belong to the leaf");
    }

    function testFuzz_sweepExcess_takesExactlyTheStrayTokens(uint256 donation, uint256 deposited) public {
        donation = bound(donation, 1, PLAYER_TOKENS / 2);
        deposited = bound(deposited, 1, PLAYER_TOKENS / 2);
        _deposit(alice, deposited);
        vm.prank(bob);
        assertTrue(token.transfer(address(vault), donation), "donation");
        uint256 assetsBefore = vault.assets();
        vm.prank(operator);
        assertEq(vault.sweepExcess(carol), donation, "swept the donation");
        assertEq(vault.assets(), assetsBefore, "assets untouched");
        assertEq(token.balanceOf(address(vault)), vault.assets(), "balance == assets");
    }
}
