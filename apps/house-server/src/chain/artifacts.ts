import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Abi, Hex } from 'viem';
import { mayaHouseVaultAbi, mockOpenTokenAbi } from './abi.js';
import { ChainError } from './errors.js';

export interface ContractArtifact {
  readonly name: string;
  readonly file: string;
  readonly abi: Abi;
  readonly bytecode: Hex;
}

export interface Artifacts {
  readonly token: ContractArtifact;
  readonly vault: ContractArtifact;
}

const REBUILD_HINT = 'rebuild with: MSYS_NO_PATHCONV=1 docker run --rm -v "<repo>:/repo" -w /repo/contracts --entrypoint sh ghcr.io/foundry-rs/foundry:stable -c "forge build --force"';

/** Reads one forge artifact (`out/<Name>.sol/<Name>.json`) and checks it has deployable bytecode. */
export function readArtifact(outDir: string, name: string): ContractArtifact {
  const file = path.join(outDir, `${name}.sol`, `${name}.json`);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    throw new ChainError('ARTIFACT_MISSING', `Contract artifact not found: ${file}; ${REBUILD_HINT}`, { cause: error });
  }
  let json: { abi?: unknown; bytecode?: { object?: unknown } };
  try { json = JSON.parse(text) as typeof json; } catch (error) {
    throw new ChainError('ARTIFACT_INVALID', `Contract artifact is not valid JSON: ${file}`, { cause: error });
  }
  if (!Array.isArray(json.abi)) throw new ChainError('ARTIFACT_INVALID', `${file} has no abi`);
  const bytecode = json.bytecode?.object;
  // `forge coverage`/`forge lint` can leave ABI-only artifacts behind; deploying those would fail opaquely.
  if (typeof bytecode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) {
    throw new ChainError('ARTIFACT_INVALID', `${file} has no creation bytecode; ${REBUILD_HINT}`);
  }
  return Object.freeze({ name, file, abi: json.abi as Abi, bytecode: bytecode as Hex });
}

/** Canonical JSON (sorted object keys) so ABI comparison ignores key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameAbi(a: Abi | readonly unknown[], b: Abi | readonly unknown[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Loads both artifacts and refuses to proceed when the compiled ABI no longer matches the typed ABI
 * this adapter was generated from (a contract change without regenerating `abi.ts`).
 */
export function loadArtifacts(outDir: string): Artifacts {
  const token = readArtifact(outDir, 'MockOpenToken');
  const vault = readArtifact(outDir, 'MayaHouseVault');
  for (const [artifact, expected] of [[token, mockOpenTokenAbi], [vault, mayaHouseVaultAbi]] as const) {
    if (!sameAbi(artifact.abi, expected)) {
      throw new ChainError('ARTIFACT_INVALID', `${artifact.name} ABI in ${artifact.file} differs from src/chain/abi.ts; regenerate with node apps/house-server/test/chain/tools/gen-abi.mjs`);
    }
  }
  return Object.freeze({ token, vault });
}
