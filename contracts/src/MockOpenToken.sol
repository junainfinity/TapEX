// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockOpenToken (tOPEN)
/// @notice Testnet-only stand-in for $OPEN. This is NOT the OpenLedger OPEN token
///         (0xA227Cc36938f0c9E09CE0e64dfab226cad739447 on Ethereum mainnet).
/// @dev The whole fixed supply is minted once to the deployer (the $OPEN operator).
///      There is deliberately no mint, burn or admin entry point after deployment.
contract MockOpenToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** 18;

    constructor() ERC20("Test OPEN (Maya-Live mock)", "tOPEN") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }
}
