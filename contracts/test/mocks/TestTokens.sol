// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Skims `feeBps` of every transfer to a sink, so the recipient receives less than `value`.
contract FeeOnTransferToken is ERC20 {
    address public constant FEE_SINK = address(0xFEE);
    uint256 public feeBps;

    constructor(uint256 supply, uint256 feeBps_) ERC20("Fee Token", "FEE") {
        feeBps = feeBps_;
        _mint(msg.sender, supply);
    }

    function setFeeBps(uint256 feeBps_) external {
        feeBps = feeBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, FEE_SINK, fee);
        super._update(from, to, value - fee);
    }
}

/// @notice Returns false from transfer/transferFrom instead of reverting, without moving funds.
contract FalseReturnToken is ERC20 {
    bool public failTransfers;

    constructor(uint256 supply) ERC20("False Token", "FALSE") {
        _mint(msg.sender, supply);
    }

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transfer(to, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (failTransfers) return false;
        return super.transferFrom(from, to, value);
    }
}

/// @notice ERC-777-style hook token: once armed, the next balance update calls `target` with `data`
///         (as the token contract) and bubbles any revert, simulating a reentrant callback.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public data;
    bool public armed;

    constructor(uint256 supply) ERC20("Hook Token", "HOOK") {
        _mint(msg.sender, supply);
    }

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed) return;
        armed = false;
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
