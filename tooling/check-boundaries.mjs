import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const rootOption = process.argv.find(arg => arg.startsWith('--root='));
const root = rootOption ? path.resolve(rootOption.slice('--root='.length)) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPaths = [];
for (const parent of ['apps', 'packages']) {
  for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
    if (entry.isDirectory()) manifestPaths.push(path.join(root, parent, entry.name, 'package.json'));
  }
}
const workspaces = new Map();
for (const file of manifestPaths) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (workspaces.has(manifest.name)) throw new Error(`Duplicate package ${manifest.name}`);
  workspaces.set(manifest.name, { dir: path.dirname(file), manifest });
}
const errors = [];
const edges = new Map();
const apps = ['@maya/demo', '@maya/feed-relay', '@maya/recorder', '@maya/house-server', '@maya/admin'];
for (const [name, { manifest }] of workspaces) {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  const allowed = name === '@maya/contracts' ? [] : name === '@maya/config' ? ['@maya/contracts'] : name.startsWith('@maya/') && !apps.includes(name) ? ['@maya/contracts', '@maya/config'] : [...workspaces.keys()].filter(n => n !== name && !apps.includes(n));
  const direct = [];
  for (const [dep, version] of Object.entries(dependencies)) if (dep.startsWith('@maya/')) {
    direct.push(dep);
    if (!workspaces.has(dep) || !allowed.includes(dep)) errors.push(`${name}: forbidden/missing workspace dependency ${dep}`);
    if (version !== 'workspace:*') errors.push(`${name}: ${dep} must use workspace:*`);
  }
  edges.set(name, direct);
}
const visited = new Set(); const visiting = new Set();
function visit(name) {
  if (visiting.has(name)) { errors.push(`Workspace cycle at ${name}`); return; }
  if (visited.has(name)) return;
  visiting.add(name); for (const dep of edges.get(name) ?? []) visit(dep); visiting.delete(name); visited.add(name);
}
for (const name of workspaces.keys()) visit(name);
async function sourceFiles(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(file));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) out.push(file);
  }
  return out;
}
let sourceCount = 0;
for (const [name, { dir, manifest }] of workspaces) {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  for (const file of await sourceFiles(path.join(dir, 'src'))) {
    sourceCount++;
    const ast = parse(await readFile(file, 'utf8'), { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'], createImportExpressions: true });
    function inspect(specifier) {
      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(dir + path.sep)) errors.push(`${file}: relative import crosses package boundary: ${specifier}`);
        return;
      }
      if (specifier.startsWith('node:')) { if (name === '@maya/game-ui' || name === '@maya/demo') errors.push(`${file}: Node import in browser package`); return; }
      if (specifier.startsWith('#')) { errors.push(`${file}: undeclared package import alias ${specifier}`); return; }
      const parts = specifier.split('/'); const dep = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!declared[dep]) errors.push(`${file}: undeclared dependency ${dep}`);
      const target = workspaces.get(dep);
      if (target) {
        const sub = specifier === dep ? '.' : '.' + specifier.slice(dep.length);
        if (!target.manifest.exports?.[sub]) errors.push(`${file}: unexported subpath ${specifier}`);
        if ((name === '@maya/demo' || name === '@maya/game-ui') && (dep === '@maya/feed-relay' || sub.startsWith('./server'))) errors.push(`${file}: server entry imported into browser`);
      }
    }
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source?.type === 'StringLiteral') inspect(node.source.value);
      if (node.type === 'ImportExpression') {
        if (node.source?.type === 'StringLiteral') inspect(node.source.value);
        else errors.push(`${file}: nonliteral dynamic import cannot be boundary-checked`);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc' || key === 'comments' || key === 'tokens') continue;
        if (Array.isArray(value)) for (const child of value) walk(child);
        else if (value && typeof value === 'object') walk(value);
      }
    }
    walk(ast);
  }
}
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log(JSON.stringify({ check: 'workspace-boundaries', status: 'PASS', workspaces: workspaces.size, sourceFiles: sourceCount, dependencyEdges: [...edges.values()].reduce((n, e) => n + e.length, 0) }));
