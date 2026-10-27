import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { balanceLeaf, buildBalanceTree, hashPair, verifyBalanceProof, ZERO_ROOT } from '../../src/chain/merkle.js';

const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;

/** Five-entry vector; contracts/test/BalanceTreeVectors.t.sol asserts the same root, leaves and proofs on-chain. */
const VECTOR = [
  { account: A, balanceWei: 5n * E18 },
  { account: B, balanceWei: 25n * 10n ** 17n },
  { account: '0x3333333333333333333333333333333333333333', balanceWei: 0n },
  { account: '0x4444444444444444444444444444444444444444', balanceWei: 123_456_789n },
  { account: '0x5555555555555555555555555555555555555555', balanceWei: 10n ** 26n },
] as const;
const VECTOR_ROOT = '0x00a7954bee27bd442b85741764026460d1ca2136d7ed909ad49c7b8bd9b34c09';

describe('balance Merkle tree (OpenZeppelin StandardMerkleTree, address/uint256 leaves)', () => {
  it('reproduces the OpenZeppelin merkle-tree README root for its two-value example', () => {
    // StandardMerkleTree.of([[A, "5000000000000000000"], [B, "2500000000000000000"]], ["address", "uint256"]).root
    expect(buildBalanceTree([{ account: A, balanceWei: 5n * E18 }, { account: B, balanceWei: 25n * 10n ** 17n }]).root)
      .toBe('0xd4dee0beab2d53f2cc83e567171bd2820e49898130a22622b10ead383e90bd77');
  });

  it('double-hashes abi.encode(account, balance) for leaves, like the vault', () => {
    const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [A, 7n]));
    expect(balanceLeaf(A, 7n)).toBe(keccak256(inner));
    expect(balanceLeaf(A.toUpperCase().replace('0X', '0x'), 7n)).toBe(balanceLeaf(A, 7n)); // case-insensitive account
  });

  it('builds the cross-checked five-entry vector and every proof verifies', () => {
    const tree = buildBalanceTree(VECTOR);
    expect(tree.root).toBe(VECTOR_ROOT);
    expect(tree.proofFor(A)).toEqual([
      '0x971819f2a55389b975f1b78c5f0a4395598e1752fcda9b0eb22b0a3c30862fd9',
      '0x562848ac4bd13613689eda3c9f338dfcd1cab2e317c152071b4d2c40ddeddab6',
    ]);
    for (const entry of VECTOR) {
      const proof = tree.proofFor(entry.account);
      expect(verifyBalanceProof(tree.root, entry.account, entry.balanceWei, proof)).toBe(true);
      expect(verifyBalanceProof(tree.root, entry.account, entry.balanceWei + 1n, proof)).toBe(false);
      expect(tree.balanceOf(entry.account)).toBe(entry.balanceWei);
    }
    expect(verifyBalanceProof(tree.root, B, 5n * E18, tree.proofFor(A))).toBe(false); // borrowed proof
    expect(tree.entries.map(e => e.account)).toEqual(VECTOR.map(e => e.account)); // input order kept
    expect(Object.isFrozen(tree.entries)).toBe(true);
  });

  it('is independent of input order (leaves are sorted)', () => {
    const reversed = buildBalanceTree([...VECTOR].reverse());
    expect(reversed.root).toBe(VECTOR_ROOT);
    expect(reversed.proofFor(A)).toEqual(buildBalanceTree(VECTOR).proofFor(A));
  });

  it('handles one entry (root = leaf, empty proof) and no entries (zero root)', () => {
    const one = buildBalanceTree([{ account: A, balanceWei: 1n }]);
    expect(one.root).toBe(balanceLeaf(A, 1n));
    expect(one.proofFor(A)).toEqual([]);
    expect(verifyBalanceProof(one.root, A, 1n, [])).toBe(true);
    const none = buildBalanceTree([]);
    expect(none.root).toBe(ZERO_ROOT);
    expect(none.balanceOf(A)).toBeUndefined();
    expect(() => none.proofFor(A)).toThrow(/empty balance tree/);
    expect(verifyBalanceProof(ZERO_ROOT, A, 1n, [])).toBe(false);
  });

  it('rejects duplicates, bad accounts and out-of-range balances; unknown accounts have no proof', () => {
    expect(() => buildBalanceTree([{ account: A, balanceWei: 1n }, { account: A.toLowerCase(), balanceWei: 2n }])).toThrow(/Duplicate/);
    expect(() => buildBalanceTree([{ account: '0x123', balanceWei: 1n }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => buildBalanceTree([{ account: A, balanceWei: -1n }])).toThrow(/uint256/);
    expect(() => buildBalanceTree([{ account: A, balanceWei: 1n << 256n }])).toThrow(/uint256/);
    expect(() => buildBalanceTree([{ account: A, balanceWei: 1 as unknown as bigint }])).toThrow(/uint256/);
    const tree = buildBalanceTree(VECTOR);
    expect(() => tree.proofFor('0x6666666666666666666666666666666666666666')).toThrow(/no leaf/);
    expect(tree.balanceOf('0x6666666666666666666666666666666666666666')).toBeUndefined();
    expect(verifyBalanceProof('0x1234', A, 1n, [])).toBe(false);
    expect(verifyBalanceProof(tree.root, A, 5n * E18, ['0xzz'])).toBe(false);
  });

  it('hashes pairs commutatively (sorted), as OpenZeppelin Hashes.commutativeKeccak256', () => {
    const x = keccak256('0x01'); const y = keccak256('0x02');
    expect(hashPair(x, y)).toBe(hashPair(y, x));
    const [lo, hi] = x < y ? [x, y] : [y, x];
    expect(hashPair(x, y)).toBe(keccak256(`${lo}${hi.slice(2)}` as Hex));
  });
});
