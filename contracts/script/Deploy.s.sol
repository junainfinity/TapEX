// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {MockOpenToken} from "../src/MockOpenToken.sol";
import {MayaHouseVault} from "../src/MayaHouseVault.sol";

/// @dev The few Foundry cheatcodes this script needs (forge-std is not vendored in this repo).
interface ScriptVm {
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

    function envUint(string calldata name) external view returns (uint256 value);
    function envAddress(string calldata name) external view returns (address value);
    function envOr(string calldata name, uint256 defaultValue) external view returns (uint256 value);
    function envOr(string calldata name, string calldata defaultValue) external view returns (string memory value);
    function addr(uint256 privateKey) external pure returns (address keyAddr);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
    function projectRoot() external view returns (string memory path);
    function toString(uint256 value) external pure returns (string memory stringifiedValue);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function isContext(ForgeContext context) external view returns (bool result);
}

/// @title Deploy (LOCAL anvil only)
/// @notice Deploys MockOpenToken + MayaHouseVault, sets the ledger signer, funds the house and writes
///         `deployments/<chainId>.json` = { chainId, token, vault, operator, ledgerSigner, blockNumber }.
///         Testnet deployments are done by the house server via viem, never with this script.
/// @dev Env: PRIVATE_KEY (operator key, uint), SIGNER (ledger signer address), optional HOUSE_FUND_WEI
///      (default 100,000,000 tOPEN; 0 skips funding), ESCAPE_DELAY (seconds, default 7 days) and
///      DEPLOYMENT_FILE (absolute path under deployments/).
///      Usage (anvil in another shell):
///        forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
///      `blockNumber` is the chain head the script simulated against: a safe lower bound for indexers.
///      A dry run (no --broadcast) deploys nothing and therefore writes no file.
contract Deploy {
    // forge-lint: disable-next-line(screaming-snake-case-const)
    ScriptVm private constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant DEFAULT_HOUSE_FUND = 100_000_000 * 10 ** 18;
    uint256 public constant DEFAULT_ESCAPE_DELAY = 7 days;

    error LocalOnly(uint256 chainId);

    struct Deployment {
        uint256 chainId;
        address token;
        address vault;
        address operator;
        address ledgerSigner;
        uint256 blockNumber;
    }

    function run() external returns (Deployment memory deployment) {
        uint256 operatorKey = vm.envUint("PRIVATE_KEY");
        address ledgerSigner = vm.envAddress("SIGNER");
        uint256 houseFund = vm.envOr("HOUSE_FUND_WEI", DEFAULT_HOUSE_FUND);
        uint256 escapeDelay = vm.envOr("ESCAPE_DELAY", DEFAULT_ESCAPE_DELAY);
        deployment = deployWithEscapeDelay(operatorKey, ledgerSigner, houseFund, escapeDelay);

        if (vm.isContext(ScriptVm.ForgeContext.ScriptDryRun)) return deployment;
        string memory defaultPath =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        _write(deployment, vm.envOr("DEPLOYMENT_FILE", defaultPath));
    }

    function deploy(uint256 operatorKey, address ledgerSigner, uint256 houseFund)
        public
        returns (Deployment memory deployment)
    {
        return deployWithEscapeDelay(operatorKey, ledgerSigner, houseFund, DEFAULT_ESCAPE_DELAY);
    }

    function deployWithEscapeDelay(uint256 operatorKey, address ledgerSigner, uint256 houseFund, uint256 escapeDelay)
        public
        returns (Deployment memory deployment)
    {
        if (block.chainid != ANVIL_CHAIN_ID) revert LocalOnly(block.chainid);
        address operator = vm.addr(operatorKey);
        uint256 head = block.number;

        vm.startBroadcast(operatorKey);
        MockOpenToken token = new MockOpenToken();
        MayaHouseVault vault = new MayaHouseVault(token, ledgerSigner, escapeDelay);
        if (houseFund != 0) {
            token.approve(address(vault), houseFund);
            vault.fundHouse(houseFund);
        }
        vm.stopBroadcast();

        deployment = Deployment({
            chainId: block.chainid,
            token: address(token),
            vault: address(vault),
            operator: operator,
            ledgerSigner: ledgerSigner,
            blockNumber: head
        });
    }

    function _write(Deployment memory d, string memory path) private {
        string memory key = "maya-live-deployment";
        vm.serializeUint(key, "chainId", d.chainId);
        vm.serializeAddress(key, "token", d.token);
        vm.serializeAddress(key, "vault", d.vault);
        vm.serializeAddress(key, "operator", d.operator);
        vm.serializeAddress(key, "ledgerSigner", d.ledgerSigner);
        string memory json = vm.serializeUint(key, "blockNumber", d.blockNumber);
        vm.writeJson(json, path);
    }
}
