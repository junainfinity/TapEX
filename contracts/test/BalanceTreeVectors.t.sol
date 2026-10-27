// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {BalanceTree} from "./utils/BalanceTree.sol";

/// @notice Cross-language vectors: the same roots, leaves and proofs are asserted by the TypeScript helper
///         (apps/house-server/test/chain/merkle.test.ts, src/chain/merkle.ts). The two-entry root is the
///         OpenZeppelin merkle-tree README example for StandardMerkleTree.of(values, ["address", "uint256"]).
contract BalanceTreeVectorsTest is VaultFixture {
    address internal constant A = 0x1111111111111111111111111111111111111111;
    address internal constant B = 0x2222222222222222222222222222222222222222;
    address internal constant C = 0x3333333333333333333333333333333333333333;
    address internal constant D = 0x4444444444444444444444444444444444444444;
    address internal constant E = 0x5555555555555555555555555555555555555555;
    bytes32 internal constant VECTOR_ROOT = 0x00a7954bee27bd442b85741764026460d1ca2136d7ed909ad49c7b8bd9b34c09;

    function test_readmeVector_twoEntries() public pure {
        address[] memory accounts = new address[](2);
        accounts[0] = A;
        accounts[1] = B;
        uint256[] memory balances = new uint256[](2);
        balances[0] = 5 ether;
        balances[1] = 2.5 ether;
        assertEq(
            BalanceTree.root(BalanceTree.build(accounts, balances)),
            0xd4dee0beab2d53f2cc83e567171bd2820e49898130a22622b10ead383e90bd77,
            "OpenZeppelin README root"
        );
    }

    function test_fiveEntryVector_matchesTheTypeScriptHelper() public view {
        (address[] memory accounts, uint256[] memory balances) = _vector();
        BalanceTree.Tree memory tree = BalanceTree.build(accounts, balances);
        assertEq(BalanceTree.root(tree), VECTOR_ROOT, "root");
        assertEq(
            vault.balanceLeaf(A, 5 ether), 0xeb02c421cfa48976e66dfb29120745909ea3a0f843456c263cf8f1253483e283, "leaf A"
        );
        assertEq(vault.balanceLeaf(C, 0), 0xdd05ddd79adc5569806124d3c5d8151b75bc81032a0ea21d4cd74fd964947bf5, "leaf C");

        bytes32[] memory proofA = new bytes32[](2);
        proofA[0] = 0x971819f2a55389b975f1b78c5f0a4395598e1752fcda9b0eb22b0a3c30862fd9;
        proofA[1] = 0x562848ac4bd13613689eda3c9f338dfcd1cab2e317c152071b4d2c40ddeddab6;
        bytes32[] memory built = BalanceTree.proof(tree, 0);
        assertEq(built.length, 2, "proof length");
        assertEq(built[0], proofA[0], "proof A[0]");
        assertEq(built[1], proofA[1], "proof A[1]");
        assertTrue(MerkleProof.verify(proofA, VECTOR_ROOT, vault.balanceLeaf(A, 5 ether)), "TS proof verifies on-chain");

        bytes32[] memory proofE = new bytes32[](3);
        proofE[0] = 0xb92c48e9d7abe27fd8dfd6b5dfdbfb1c9a463f80c712b66f3a5180a090cccafc;
        proofE[1] = 0xeb02c421cfa48976e66dfb29120745909ea3a0f843456c263cf8f1253483e283;
        proofE[2] = 0x562848ac4bd13613689eda3c9f338dfcd1cab2e317c152071b4d2c40ddeddab6;
        assertTrue(MerkleProof.verify(proofE, VECTOR_ROOT, vault.balanceLeaf(E, 1e26)), "deep leaf verifies");
        assertFalse(MerkleProof.verify(proofE, VECTOR_ROOT, vault.balanceLeaf(E, 1e26 + 1)), "tampered balance fails");
        for (uint256 i; i < accounts.length; ++i) {
            assertTrue(
                MerkleProof.verify(
                    BalanceTree.proof(tree, i), VECTOR_ROOT, vault.balanceLeaf(accounts[i], balances[i])
                ),
                "every Solidity-built proof verifies"
            );
        }
    }

    function _vector() internal pure returns (address[] memory accounts, uint256[] memory balances) {
        accounts = new address[](5);
        accounts[0] = A;
        accounts[1] = B;
        accounts[2] = C;
        accounts[3] = D;
        accounts[4] = E;
        balances = new uint256[](5);
        balances[0] = 5 ether;
        balances[1] = 2.5 ether;
        balances[2] = 0;
        balances[3] = 123_456_789;
        balances[4] = 1e26;
    }
}
