import { encodeAbiParameters, getAddress, isAddress, keccak256, type Address, type Hex } from 'viem';
import { UINT256_MAX } from './amounts.js';
import { ChainError } from './errors.js';

/**
 * Merkle tree of player balances for `MayaHouseVault.attest`'s `ledgerRoot` (SPEC-11 §4).
 *
 * Byte-for-byte the OpenZeppelin `StandardMerkleTree.of(values, ['address', 'uint256'])` construction the
 * vault verifies with `MerkleProof.verifyCalldata`:
 * - leaf = keccak256(bytes.concat(keccak256(abi.encode(account, balanceWei)))) (double-hashed, so a leaf
 *   can never be confused with an inner node);
 * - leaves sorted ascending, stored at the end of a complete binary heap (`tree[len - 1 - i]`);
 * - inner node = keccak256 of the two children in ascending order (commutative, no position bits);
 * - a proof lists the sibling hashes from the leaf up to (not including) the root.
 * An empty entry list yields the zero root, which no proof can reach; an account then claims with balance 0.
 */
export interface BalanceEntry {
  readonly account: string;
  readonly balanceWei: bigint;
}

export interface BalanceTreeEntry {
  readonly account: Address;
  readonly balanceWei: bigint;
  readonly leaf: Hex;
}

export interface BalanceTree {
  /** 0x-prefixed 32-byte root, lowercase (the zero hash for an empty tree). */
  readonly root: Hex;
  /** Entries in input order with checksummed accounts and their leaf hashes. */
  readonly entries: readonly BalanceTreeEntry[];
  /** Sibling path for `account` (empty for a single-entry tree). Throws for an account not in the tree. */
  proofFor(account: string): readonly Hex[];
  /** The committed balance for `account`, or undefined when it has no leaf. */
  balanceOf(account: string): bigint | undefined;
}

export const ZERO_ROOT: Hex = `0x${'00'.repeat(32)}`;

const LEAF_TYPES = [{ type: 'address' }, { type: 'uint256' }] as const;

function checkedAccount(account: string): Address {
  if (typeof account !== 'string' || !isAddress(account, { strict: false })) {
    throw new ChainError('INVALID_ARGUMENT', `Balance tree account must be an address, got "${String(account)}"`);
  }
  return getAddress(account);
}

function checkedBalance(balanceWei: bigint, account: string): bigint {
  if (typeof balanceWei !== 'bigint' || balanceWei < 0n || balanceWei > UINT256_MAX) {
    throw new ChainError('INVALID_ARGUMENT', `Balance for ${account} must be a uint256 bigint`);
  }
  return balanceWei;
}

/** The vault's `balanceLeaf(account, balanceWei)`. */
export function balanceLeaf(account: string, balanceWei: bigint): Hex {
  const address = checkedAccount(account);
  const inner = keccak256(encodeAbiParameters(LEAF_TYPES, [address, checkedBalance(balanceWei, address)]));
  return keccak256(inner);
}

/** OpenZeppelin `Hashes.commutativeKeccak256`: hash of the pair in ascending order. */
export function hashPair(a: Hex, b: Hex): Hex {
  const x = a.toLowerCase() as Hex;
  const y = b.toLowerCase() as Hex;
  return keccak256(x < y ? `${x}${y.slice(2)}` as Hex : `${y}${x.slice(2)}` as Hex);
}

export function buildBalanceTree(entries: readonly BalanceEntry[]): BalanceTree {
  if (!Array.isArray(entries)) throw new ChainError('INVALID_ARGUMENT', 'Balance tree entries must be an array');
  const normalized: BalanceTreeEntry[] = [];
  const position = new Map<string, number>();
  for (const entry of entries) {
    const account = checkedAccount(entry?.account);
    const key = account.toLowerCase();
    if (position.has(key)) throw new ChainError('INVALID_ARGUMENT', `Duplicate balance tree account ${account}`);
    position.set(key, normalized.length);
    normalized.push(Object.freeze({ account, balanceWei: checkedBalance(entry.balanceWei, account), leaf: balanceLeaf(account, entry.balanceWei) }));
  }
  const frozenEntries = Object.freeze(normalized);
  if (normalized.length === 0) {
    return Object.freeze({
      root: ZERO_ROOT,
      entries: frozenEntries,
      proofFor: (account: string) => { throw new ChainError('INVALID_ARGUMENT', `${account} has no leaf in an empty balance tree`); },
      balanceOf: () => undefined,
    });
  }
  const order = normalized.map((_, i) => i).sort((a, b) => (normalized[a]!.leaf < normalized[b]!.leaf ? -1 : normalized[a]!.leaf > normalized[b]!.leaf ? 1 : 0));
  const tree: Hex[] = new Array<Hex>(2 * normalized.length - 1);
  const heapIndex = new Array<number>(normalized.length);
  order.forEach((entryIndex, i) => {
    const at = tree.length - 1 - i;
    tree[at] = normalized[entryIndex]!.leaf;
    heapIndex[entryIndex] = at;
  });
  for (let i = tree.length - 1 - normalized.length; i >= 0; i--) tree[i] = hashPair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  const indexOf = (account: string): number | undefined => position.get(checkedAccount(account).toLowerCase());
  return Object.freeze({
    root: tree[0]!,
    entries: frozenEntries,
    proofFor(account: string): readonly Hex[] {
      const i = indexOf(account);
      if (i === undefined) throw new ChainError('INVALID_ARGUMENT', `${account} has no leaf in this balance tree`);
      const proof: Hex[] = [];
      for (let at = heapIndex[i]!; at > 0; at = Math.floor((at - 1) / 2)) proof.push(tree[at % 2 === 1 ? at + 1 : at - 1]!);
      return Object.freeze(proof);
    },
    balanceOf(account: string): bigint | undefined {
      const i = indexOf(account);
      return i === undefined ? undefined : normalized[i]!.balanceWei;
    },
  });
}

/** `MerkleProof.verify(proof, root, balanceLeaf(account, balanceWei))`. */
export function verifyBalanceProof(root: string, account: string, balanceWei: bigint, proof: readonly string[]): boolean {
  if (typeof root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(root)) return false;
  let computed = balanceLeaf(account, balanceWei);
  for (const sibling of proof) {
    if (typeof sibling !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(sibling)) return false;
    computed = hashPair(computed, sibling as Hex);
  }
  return computed === root.toLowerCase();
}
