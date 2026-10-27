// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Minimal Foundry cheatcode interface for the cheatcodes these tests use.
/// @dev forge-std is not vendored in this repo (lib/ only carries OpenZeppelin), so the tests talk to the
///      cheatcode precompile directly. Signatures mirror forge-std's Vm.sol.
interface Vm {
    enum ForgeContext {
        TestGroup,
        Test,
        Coverage,
        Snapshot,
        ScriptGroup,
        ScriptDryRun,
        ScriptBroadcast,
        ScriptResume,
        Unknown
    }

    // environment
    function warp(uint256 newTimestamp) external;
    function roll(uint256 newHeight) external;
    function chainId(uint256 newChainId) external;
    function prank(address msgSender) external;
    function startPrank(address msgSender) external;
    function stopPrank() external;
    function label(address account, string calldata newLabel) external;
    function assume(bool condition) external pure;

    // keys and signatures
    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);

    // expectations
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function expectPartialRevert(bytes4 revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;

    // env, files, json
    function setEnv(string calldata name, string calldata value) external;
    function envUint(string calldata name) external view returns (uint256 value);
    function envAddress(string calldata name) external view returns (address value);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256 value);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory value);
    function projectRoot() external view returns (string memory path);
    function readFile(string calldata path) external view returns (string memory data);
    function removeFile(string calldata path) external;
    function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address);
    function toString(uint256 value) external pure returns (string memory stringifiedValue);
    function toString(address value) external pure returns (string memory stringifiedValue);
    function isContext(ForgeContext context) external view returns (bool result);

    // assertions (revert with the message on failure)
    function assertTrue(bool condition, string calldata error) external pure;
    function assertFalse(bool condition, string calldata error) external pure;
    function assertEq(bool left, bool right, string calldata error) external pure;
    function assertEq(uint256 left, uint256 right, string calldata error) external pure;
    function assertEq(address left, address right, string calldata error) external pure;
    function assertEq(bytes32 left, bytes32 right, string calldata error) external pure;
    function assertEq(string calldata left, string calldata right, string calldata error) external pure;
    function assertGe(uint256 left, uint256 right, string calldata error) external pure;
    function assertGt(uint256 left, uint256 right, string calldata error) external pure;
    function assertLe(uint256 left, uint256 right, string calldata error) external pure;
    function assertLt(uint256 left, uint256 right, string calldata error) external pure;
}
