// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Vm} from "./Vm.sol";

/// @notice Cheatcode access and deterministic fuzz helpers shared by tests and invariant handlers.
abstract contract CheatBase {
    // forge-lint: disable-next-line(screaming-snake-case-const)
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @dev Maps `x` into [min, max]. Values already in range pass through unchanged and the fuzzer's edge
    ///      values (0..3 and max-3..max) map onto the range edges, mirroring forge-std's `bound`.
    function bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        require(min <= max, "bound: min > max");
        if (x >= min && x <= max) return x;
        uint256 size = max - min + 1;
        if (size == 0) return x; // full uint256 range
        if (x <= 3 && size > x) return min + x;
        if (x >= type(uint256).max - 3 && size > type(uint256).max - x) return max - (type(uint256).max - x);
        return min + (x % size);
    }

    function makeAddr(string memory name) internal returns (address account) {
        account = address(uint160(uint256(keccak256(abi.encodePacked("maya-live:", name)))));
        vm.label(account, name);
    }

    /// @dev Deterministic, valid secp256k1 private key derived from a label (test fixtures only).
    function keyFor(string memory name) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encodePacked("maya-live-key:", name))) % (SECP256K1_N - 1)) + 1;
    }
}

/// @notice Minimal test base: assertion helpers plus the invariant target hooks forge queries.
abstract contract TestBase is CheatBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    address[] private _targetContracts;
    FuzzSelector[] private _targetSelectors;

    function targetContract(address target) internal {
        _targetContracts.push(target);
    }

    function targetSelector(FuzzSelector memory selector) internal {
        _targetSelectors.push(selector);
    }

    /// @dev Queried by forge before invariant runs.
    function targetContracts() public view returns (address[] memory) {
        return _targetContracts;
    }

    /// @dev Queried by forge before invariant runs.
    function targetSelectors() public view returns (FuzzSelector[] memory) {
        return _targetSelectors;
    }

    function assertTrue(bool condition, string memory err) internal pure {
        vm.assertTrue(condition, err);
    }

    function assertFalse(bool condition, string memory err) internal pure {
        vm.assertFalse(condition, err);
    }

    function assertEq(uint256 left, uint256 right, string memory err) internal pure {
        vm.assertEq(left, right, err);
    }

    function assertEq(address left, address right, string memory err) internal pure {
        vm.assertEq(left, right, err);
    }

    function assertEq(bytes32 left, bytes32 right, string memory err) internal pure {
        vm.assertEq(left, right, err);
    }

    function assertEq(bool left, bool right, string memory err) internal pure {
        vm.assertEq(left, right, err);
    }

    function assertEq(string memory left, string memory right, string memory err) internal pure {
        vm.assertEq(left, right, err);
    }

    function assertGe(uint256 left, uint256 right, string memory err) internal pure {
        vm.assertGe(left, right, err);
    }

    function assertLe(uint256 left, uint256 right, string memory err) internal pure {
        vm.assertLe(left, right, err);
    }
}
