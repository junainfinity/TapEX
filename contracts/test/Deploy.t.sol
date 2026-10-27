// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {MockOpenToken} from "../src/MockOpenToken.sol";
import {MayaHouseVault} from "../src/MayaHouseVault.sol";

contract DeployScriptTest is TestBase {
    Deploy internal script;
    uint256 internal operatorKey;
    address internal ledgerSigner;

    function setUp() public {
        script = new Deploy();
        operatorKey = keyFor("local-operator");
        ledgerSigner = vm.addr(keyFor("local-ledger-signer"));
    }

    /// @dev The only test that touches process env and the filesystem (env is process-global).
    function test_run_deploysFromEnvAndWritesDeploymentJson() public {
        // forge-lint: disable-start(unsafe-cheatcode)
        string memory path = string.concat(vm.projectRoot(), "/deployments/deploy-script-test.json");
        vm.setEnv("PRIVATE_KEY", vm.toString(operatorKey));
        vm.setEnv("SIGNER", vm.toString(ledgerSigner));
        vm.setEnv("HOUSE_FUND_WEI", vm.toString(uint256(5_000 * 10 ** 18)));
        vm.setEnv("DEPLOYMENT_FILE", path);

        Deploy.Deployment memory d = script.run();
        _assertDeployed(d, 5_000 * 10 ** 18);

        string memory json = vm.readFile(path);
        vm.removeFile(path);
        // forge-lint: disable-end(unsafe-cheatcode)
        assertEq(vm.parseJsonUint(json, ".chainId"), 31337, "json chainId");
        assertEq(vm.parseJsonAddress(json, ".token"), d.token, "json token");
        assertEq(vm.parseJsonAddress(json, ".vault"), d.vault, "json vault");
        assertEq(vm.parseJsonAddress(json, ".operator"), vm.addr(operatorKey), "json operator");
        assertEq(vm.parseJsonAddress(json, ".ledgerSigner"), ledgerSigner, "json ledgerSigner");
        assertEq(vm.parseJsonUint(json, ".blockNumber"), block.number, "json blockNumber");
    }

    function test_deploy_fundsHouseAndWiresRoles() public {
        Deploy.Deployment memory d = script.deploy(operatorKey, ledgerSigner, script.DEFAULT_HOUSE_FUND());
        _assertDeployed(d, script.DEFAULT_HOUSE_FUND());
    }

    function test_deploy_zeroFundSkipsFunding() public {
        Deploy.Deployment memory d = script.deploy(operatorKey, ledgerSigner, 0);
        _assertDeployed(d, 0);
    }

    function test_deploy_refusesNonLocalChains() public {
        vm.chainId(84532);
        vm.expectRevert(abi.encodeWithSelector(Deploy.LocalOnly.selector, 84532));
        script.deploy(operatorKey, ledgerSigner, 0);
    }

    function test_deploy_refusesOperatorAsSigner() public {
        vm.expectRevert();
        script.deploy(operatorKey, vm.addr(operatorKey), 0);
    }

    function _assertDeployed(Deploy.Deployment memory d, uint256 fund) internal view {
        address operator = vm.addr(operatorKey);
        MockOpenToken token = MockOpenToken(d.token);
        MayaHouseVault vault = MayaHouseVault(d.vault);
        assertEq(d.chainId, 31337, "chainId");
        assertEq(d.operator, operator, "operator");
        assertEq(d.ledgerSigner, ledgerSigner, "ledgerSigner");
        assertEq(d.blockNumber, block.number, "blockNumber");
        assertEq(token.balanceOf(operator), token.INITIAL_SUPPLY() - fund, "operator keeps the rest");
        assertEq(address(vault.token()), d.token, "vault token");
        assertEq(vault.owner(), operator, "vault owner");
        assertEq(vault.ledgerSigner(), ledgerSigner, "vault signer");
        assertEq(vault.houseFunded(), fund, "house funded");
        assertEq(token.balanceOf(d.vault), fund, "vault balance");
    }
}
