// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {TestBase} from "./TestBase.sol";
import {MockOpenToken} from "../../src/MockOpenToken.sol";
import {MayaHouseVault} from "../../src/MayaHouseVault.sol";

/// @notice Deterministic vault deployment plus EIP-712 voucher helpers computed independently of the vault.
abstract contract VaultFixture is TestBase {
    uint256 internal constant ONE = 10 ** 18;
    /// @dev 2026-09-21T14:13:20Z — a fixed mid-day start so UTC day boundaries are known in tests.
    uint256 internal constant START = 1_790_000_000;
    uint64 internal constant START64 = 1_790_000_000;
    uint48 internal constant START48 = 1_790_000_000;
    uint256 internal constant PLAYER_TOKENS = 5_000_000 * ONE;
    uint256 internal constant ESCAPE_DELAY = 7 days;
    uint256 internal constant SIGNER_DELAY = 48 hours;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address account,uint256 amount,uint256 nonce,uint256 expiry)");

    uint256 internal operatorPk;
    address internal operator;
    uint256 internal signerPk;
    address internal signer;
    address internal alice;
    address internal bob;
    address internal carol;

    MockOpenToken internal token;
    MayaHouseVault internal vault;

    function setUp() public virtual {
        vm.warp(START);
        operatorPk = keyFor("operator");
        operator = vm.addr(operatorPk);
        vm.label(operator, "operator");
        signerPk = keyFor("ledger-signer");
        signer = vm.addr(signerPk);
        vm.label(signer, "ledger-signer");
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        carol = makeAddr("carol");

        vm.startPrank(operator);
        token = new MockOpenToken();
        vault = new MayaHouseVault(token, signer, ESCAPE_DELAY);
        assertTrue(token.transfer(alice, PLAYER_TOKENS), "transfer");
        assertTrue(token.transfer(bob, PLAYER_TOKENS), "transfer");
        assertTrue(token.transfer(carol, PLAYER_TOKENS), "transfer");
        token.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        _approve(alice);
        _approve(bob);
        _approve(carol);
    }

    function _approve(address player) internal {
        vm.prank(player);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(address player, uint256 amount) internal {
        vm.prank(player);
        vault.deposit(amount);
    }

    function _fund(uint256 amount) internal {
        vm.prank(operator);
        vault.fundHouse(amount);
    }

    function _attest(uint256 liabilities, uint64 asOf, uint64 seq) internal {
        vm.prank(signer);
        vault.attest(liabilities, keccak256(abi.encode("root", seq)), asOf, seq);
    }

    function _attestNow(uint256 liabilities) internal {
        _attest(liabilities, uint64(block.timestamp), vault.attestationSeq() + 1);
    }

    function _attestRoot(uint256 liabilities, bytes32 root, uint64 asOf) internal {
        uint64 seq = vault.attestationSeq() + 1;
        vm.prank(signer);
        vault.attest(liabilities, root, asOf, seq);
    }

    /// @dev Rotates the ledger signer through the timelock (advances time by the signer-change delay).
    function _rotateSigner(address next) internal {
        vm.prank(operator);
        vault.proposeLedgerSigner(next);
        vm.warp(vault.pendingLedgerSignerEta());
        vm.prank(operator);
        vault.acceptLedgerSigner();
    }

    /// @dev Applies player limits, waiting out the timelock (the time advances by the signer-change delay) when
    ///      the change raises any of them.
    function _applyLimits(uint256 maxVoucher, uint256 cap, uint256 accountCap, uint256 maxAge) internal {
        vm.prank(operator);
        vault.setLimits(maxVoucher, cap, accountCap, maxAge);
        uint256 eta = vault.pendingLimitsEta();
        if (eta == 0) return;
        vm.warp(eta);
        vm.prank(operator);
        vault.acceptLimits();
    }

    /// @dev Applies house limits, waiting out the timelock when the change loosens them.
    function _setHouseLimits(uint256 bufferBps, uint256 cap) internal {
        vm.prank(operator);
        vault.setHouseLimits(bufferBps, cap);
        uint256 eta = vault.pendingHouseLimitsEta();
        if (eta == 0) return;
        vm.warp(eta);
        vm.prank(operator);
        vault.acceptHouseLimits();
    }

    /// @dev Reference: ceil(required * bps / 10_000), kept on top of the obligations by withdrawHouse.
    function _expectedBuffer() internal view returns (uint256) {
        uint256 required = vault.requiredAssets();
        uint256 bps = vault.houseBufferBps();
        // Split so a saturated (type(uint256).max) requirement cannot overflow; exact ceiling division.
        // forge-lint: disable-next-line(divide-before-multiply)
        return (required / 10_000) * bps + ((required % 10_000) * bps + 9_999) / 10_000;
    }

    function _domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("MayaHouseVault"), keccak256("1"), block.chainid, verifyingContract)
        );
    }

    function _digest(address verifyingContract, address account, uint256 amount, uint256 nonce, uint256 expiry)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(WITHDRAWAL_TYPEHASH, account, amount, nonce, expiry));
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(verifyingContract), structHash));
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _voucher(address account, uint256 amount, uint256 nonce, uint256 expiry)
        internal
        view
        returns (bytes memory)
    {
        return _sign(signerPk, _digest(address(vault), account, amount, nonce, expiry));
    }

    function _withdraw(address player, uint256 amount, uint256 nonce, uint256 expiry) internal {
        bytes memory sig = _voucher(player, amount, nonce, expiry);
        vm.prank(player);
        vault.withdraw(amount, nonce, expiry, sig);
    }

    /// @dev Reference implementation of SPEC §5 houseSurplus, written independently of the vault.
    function _expectedSurplus() internal view returns (uint256) {
        uint256 assets_ =
            vault.totalPlayerDeposits() + vault.houseFunded() - vault.totalPlayerWithdrawals() - vault.houseWithdrawn();
        uint256 owed = vault.attestedLiabilities() + vault.depositsSinceAttest();
        uint256 claimed = vault.claimedSinceAttest();
        uint256 required = owed > claimed ? owed - claimed : 0;
        return assets_ > required ? assets_ - required : 0;
    }
}
