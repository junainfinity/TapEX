import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBalanceTree, ZERO_ROOT, type BalanceTree } from './chain/merkle.js';
import { sha256Hex } from './util.js';

/**
 * One attested balance tree as persisted: exactly the leaves (`account`, `balanceWei`) whose
 * OpenZeppelin StandardMerkleTree root was sent to `MayaHouseVault.attest`. The file is written before
 * the attest transaction, so a crash between the transaction and the journal entry can never leave the
 * vault with a root nobody can prove against.
 */
export interface StoredTreeFile {
  readonly version: 1;
  readonly seq: string;
  readonly root: string;
  /** asOf the server requested; the effective asOf (a live chain clamps it to indexed time) is in the journal / vault. */
  readonly requestedAsOf: string;
  readonly chainId: number;
  readonly vault: string;
  readonly createdMs: number;
  readonly liabilitiesWei: string;
  readonly leafTotalWei: string;
  readonly entries: readonly { readonly account: string; readonly balanceWei: string }[];
}

export interface StoredTree {
  readonly file: StoredTreeFile;
  readonly tree: BalanceTree;
  /** File name inside the store directory (undefined for an in-memory store). */
  readonly name?: string;
  readonly sha256: string;
}

const MEMORY = 8;
const NAME_RE = /^attest-(\d{1,40})-(0x[0-9a-f]{64})\.json$/;

export function treeFileName(seq: bigint | string, root: string): string { return `attest-${seq.toString()}-${root.toLowerCase()}.json`; }

/**
 * Attested balance trees by (seq, root): the latest few in memory, every one on disk when a directory
 * is configured (`<dataDir>/attestations/<chainId>-<vault>/`, so trees outlive a run on a persistent
 * vault). Loading re-derives the root from the stored leaves and refuses a file that does not match.
 */
export class AttestationStore {
  private readonly memory = new Map<string, StoredTree>();

  constructor(readonly dir?: string) { if (dir) mkdirSync(dir, { recursive: true }); }

  private static key(seq: bigint | string, root: string): string { return `${seq.toString()}:${root.toLowerCase()}`; }

  /** Persist the tree about to be attested (atomic write) and keep it in memory. */
  save(file: StoredTreeFile): StoredTree {
    const text = `${JSON.stringify(file, null, 1)}\n`;
    const tree = buildBalanceTree(file.entries.map(e => ({ account: e.account, balanceWei: BigInt(e.balanceWei) })));
    if (tree.root !== file.root.toLowerCase()) throw new Error(`Balance tree root ${tree.root} does not match ${file.root}`);
    let name: string | undefined;
    if (this.dir) {
      name = treeFileName(file.seq, file.root);
      const path = join(this.dir, name);
      writeFileSync(`${path}.tmp`, text);
      renameSync(`${path}.tmp`, path);
    }
    const stored: StoredTree = Object.freeze({ file, tree, ...(name ? { name } : {}), sha256: sha256Hex(text) });
    this.remember(stored);
    return stored;
  }

  private remember(stored: StoredTree): void {
    this.memory.set(AttestationStore.key(stored.file.seq, stored.file.root), stored);
    while (this.memory.size > MEMORY) this.memory.delete(this.memory.keys().next().value!);
  }

  /** The tree attested as (seq, root): memory first, then disk. Undefined when unknown or corrupt. */
  find(seq: bigint | string, root: string): StoredTree | undefined {
    const hit = this.memory.get(AttestationStore.key(seq, root));
    if (hit) return hit;
    if (root.toLowerCase() === ZERO_ROOT) {
      // An empty ledger attests the zero root: no leaf, every account claims with balance 0 and no proof.
      return Object.freeze({ file: { version: 1 as const, seq: seq.toString(), root: ZERO_ROOT, requestedAsOf: '0', chainId: 0, vault: '', createdMs: 0, liabilitiesWei: '0', leafTotalWei: '0', entries: [] }, tree: buildBalanceTree([]), sha256: '' });
    }
    if (!this.dir) return undefined;
    const name = treeFileName(seq, root);
    const path = join(this.dir, name);
    if (!existsSync(path)) return undefined;
    try {
      const text = readFileSync(path, 'utf8');
      const file = JSON.parse(text) as StoredTreeFile;
      if (file.version !== 1 || !NAME_RE.test(name) || file.root.toLowerCase() !== root.toLowerCase() || file.seq !== seq.toString() || !Array.isArray(file.entries)) return undefined;
      const tree = buildBalanceTree(file.entries.map(e => ({ account: e.account, balanceWei: BigInt(e.balanceWei) })));
      if (tree.root !== root.toLowerCase()) return undefined;
      const stored: StoredTree = Object.freeze({ file, tree, name, sha256: sha256Hex(text) });
      this.remember(stored);
      return stored;
    } catch { return undefined; }
  }
}
