// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @notice Test-only reimplementation of OpenZeppelin's StandardMerkleTree for `(address, uint256)` leaves:
///         double-hashed leaves, leaves sorted ascending, tree stored as a complete binary heap with the
///         leaves at the end, commutative (sorted-pair) keccak for inner nodes. Written independently of
///         the vault so escape claims are checked against a separately built root.
library BalanceTree {
    struct Tree {
        bytes32[] nodes;
        address[] accounts;
        uint256[] balances;
        /// @dev heap index of each account's leaf, aligned with `accounts`.
        uint256[] leafIndex;
    }

    function leaf(address account, uint256 balance) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, balance))));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function build(address[] memory accounts, uint256[] memory balances) internal pure returns (Tree memory t) {
        uint256 n = accounts.length;
        require(n > 0 && n == balances.length, "BalanceTree: bad input");
        bytes32[] memory hashes = new bytes32[](n);
        uint256[] memory order = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            hashes[i] = leaf(accounts[i], balances[i]);
            order[i] = i;
        }
        // insertion sort by leaf hash (ascending), carrying the original position
        for (uint256 i = 1; i < n; ++i) {
            bytes32 h = hashes[i];
            uint256 o = order[i];
            uint256 j = i;
            while (j > 0 && hashes[j - 1] > h) {
                hashes[j] = hashes[j - 1];
                order[j] = order[j - 1];
                --j;
            }
            hashes[j] = h;
            order[j] = o;
        }
        bytes32[] memory nodes = new bytes32[](2 * n - 1);
        uint256[] memory leafIndex = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            nodes[nodes.length - 1 - i] = hashes[i];
            leafIndex[order[i]] = nodes.length - 1 - i;
        }
        for (uint256 k = nodes.length - n; k > 0; --k) {
            uint256 i = k - 1;
            nodes[i] = hashPair(nodes[2 * i + 1], nodes[2 * i + 2]);
        }
        t = Tree({nodes: nodes, accounts: accounts, balances: balances, leafIndex: leafIndex});
    }

    function root(Tree memory t) internal pure returns (bytes32) {
        return t.nodes[0];
    }

    /// @dev Proof for the entry at position `i` of the input arrays.
    function proof(Tree memory t, uint256 i) internal pure returns (bytes32[] memory out) {
        uint256 index = t.leafIndex[i];
        uint256 depth;
        for (uint256 j = index; j > 0; j = (j - 1) / 2) {
            ++depth;
        }
        out = new bytes32[](depth);
        uint256 k;
        while (index > 0) {
            out[k++] = t.nodes[index % 2 == 1 ? index + 1 : index - 1];
            index = (index - 1) / 2;
        }
    }
}
