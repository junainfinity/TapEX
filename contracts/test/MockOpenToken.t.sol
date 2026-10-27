// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {TestBase} from "./utils/TestBase.sol";
import {MockOpenToken} from "../src/MockOpenToken.sol";

contract MockOpenTokenTest is TestBase {
    MockOpenToken internal token;
    address internal operator;

    function setUp() public {
        operator = makeAddr("operator");
        vm.prank(operator);
        token = new MockOpenToken();
    }

    function test_metadataIdentifiesTheMock() public view {
        assertEq(token.name(), "Test OPEN (Maya-Live mock)", "name");
        assertEq(token.symbol(), "tOPEN", "symbol");
        assertEq(token.decimals(), 18, "decimals");
    }

    function test_fixedSupplyMintedToDeployer() public view {
        assertEq(token.INITIAL_SUPPLY(), 1_000_000_000 * 10 ** 18, "one billion tOPEN");
        assertEq(token.totalSupply(), token.INITIAL_SUPPLY(), "total supply");
        assertEq(token.balanceOf(operator), token.INITIAL_SUPPLY(), "all minted to the operator");
    }

    function test_hasNoMintOrBurnEntryPoints() public {
        bytes[] memory calls = new bytes[](4);
        calls[0] = abi.encodeWithSignature("mint(address,uint256)", operator, 1);
        calls[1] = abi.encodeWithSignature("mint(uint256)", 1);
        calls[2] = abi.encodeWithSignature("burn(uint256)", 1);
        calls[3] = abi.encodeWithSignature("burnFrom(address,uint256)", operator, 1);
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(operator);
            (bool ok,) = address(token).call(calls[i]);
            assertFalse(ok, "no supply-changing entry point");
        }
        assertEq(token.totalSupply(), token.INITIAL_SUPPLY(), "supply unchanged");
    }

    function test_transfersLikeAPlainErc20() public {
        address alice = makeAddr("alice");
        vm.prank(operator);
        assertTrue(token.transfer(alice, 5 * 10 ** 18), "transfer");
        assertEq(token.balanceOf(alice), 5 * 10 ** 18, "received");
        assertEq(token.balanceOf(operator), token.INITIAL_SUPPLY() - 5 * 10 ** 18, "debited");
    }
}
