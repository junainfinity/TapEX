// Regenerates src/chain/abi.ts from the forge artifacts (run after changing the contracts):
//   node apps/house-server/test/chain/tools/gen-abi.mjs
// test/chain/artifacts.test.ts fails when the checked-in ABI drifts from contracts/out.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const out = path.join(repoRoot, 'contracts', 'out');
const target = path.resolve(here, '../../../src/chain/abi.ts');

function abiOf(file, name) {
  const artifact = JSON.parse(readFileSync(path.join(out, file, `${name}.json`), 'utf8'));
  if (!Array.isArray(artifact.abi)) throw new Error(`${name}: artifact has no abi`);
  return artifact.abi;
}
const render = abi => `[\n${abi.map(entry => `  ${JSON.stringify(entry)},`).join('\n')}\n] as const`;

const source = `// Generated from contracts/out by test/chain/tools/gen-abi.mjs. Do not edit by hand.
// test/chain/artifacts.test.ts asserts these match the forge artifacts exactly.

export const mockOpenTokenAbi = ${render(abiOf('MockOpenToken.sol', 'MockOpenToken'))};

export const mayaHouseVaultAbi = ${render(abiOf('MayaHouseVault.sol', 'MayaHouseVault'))};
`;
writeFileSync(target, source);
console.log(`wrote ${path.relative(repoRoot, target)}`);
