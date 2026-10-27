import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { mayaHouseVaultAbi, mockOpenTokenAbi } from '../../src/chain/abi.js';
import { canonicalJson, loadArtifacts, readArtifact, sameAbi } from '../../src/chain/artifacts.js';
import { deploymentPath, parseDeployment, readDeployment, serializeDeployment, writeDeployment } from '../../src/chain/deployment.js';
import { ChainError } from '../../src/chain/errors.js';
import { loadWallets, walletsFromJson } from '../../src/chain/secrets.js';
import { ARTIFACTS_DIR, cleanupTemps, REPO_ROOT, tempDir, testKey, testWalletsJson, writeJson, writeTestWallets } from './fixtures.js';

afterEach(() => cleanupTemps());

function expectNoKeyLeak(error: unknown, keys: readonly string[]) {
  const text = `${String(error)} ${(error as Error).stack ?? ''} ${inspect(error, { depth: 5 })}`.toLowerCase();
  for (const key of keys) expect(text.includes(key.slice(2).toLowerCase())).toBe(false);
}

describe('testnet wallets', () => {
  it('loads roles, orders players numerically and exposes addresses only', () => {
    const json = testWalletsJson();
    const wallets = walletsFromJson(json, 'fixture');
    expect(wallets.operator.address).toBe(json.wallets[0]!.address);
    expect(wallets.ledgerSigner.address).toBe(json.wallets[1]!.address);
    expect(wallets.players().map(p => p.role)).toEqual(Array.from({ length: 11 }, (_, i) => `player-${i + 1}`));
    expect(wallets.address('player-10')).toBe(json.wallets[11]!.address);
    expect(Object.isFrozen(wallets.players())).toBe(true);
    const serialized = JSON.stringify({ players: wallets.players(), operator: wallets.operator, account: wallets.account('player-3') }) + inspect(wallets, { depth: 6 }) + inspect(wallets.account('player-3'), { depth: 6 });
    for (const w of json.wallets) expect(serialized.toLowerCase().includes(w.privateKey.slice(2).toLowerCase())).toBe(false);
  });

  it('signs with the role key', async () => {
    const wallets = walletsFromJson(testWalletsJson());
    const signature = await wallets.account('ledger-signer').signMessage({ message: 'hi' });
    const { recoverMessageAddress } = await import('viem');
    expect(await recoverMessageAddress({ message: 'hi', signature })).toBe(wallets.ledgerSigner.address);
  });

  it('rejects unknown roles with UNKNOWN_ROLE', () => {
    const wallets = walletsFromJson(testWalletsJson());
    expect(() => wallets.account('player-99')).toThrow(expect.objectContaining({ code: 'UNKNOWN_ROLE' }));
    expect(wallets.has('player-99')).toBe(false);
  });

  const keys = testWalletsJson().wallets.map(w => w.privateKey);
  it.each([
    ['no wallets array', { wallets: 'x' }],
    ['a missing required role', testWalletsJson(['open-operator', 'player-1'])],
    ['a duplicate role', { wallets: [...testWalletsJson().wallets, testWalletsJson().wallets[0]] }],
    ['an address that does not match its key', { wallets: testWalletsJson().wallets.map((w, i) => (i === 2 ? { ...w, address: testWalletsJson().wallets[3]!.address } : w)) }],
    ['a malformed key', { wallets: testWalletsJson().wallets.map((w, i) => (i === 0 ? { ...w, privateKey: w.privateKey.slice(0, 40) } : w)) }],
    ['the same wallet as operator and signer', { wallets: [testWalletsJson().wallets[0], { ...testWalletsJson().wallets[0], role: 'ledger-signer' }] }],
  ])('rejects %s without leaking keys', (_label, json) => {
    let caught: unknown;
    try { walletsFromJson(json, 'fixture'); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ChainError);
    expect((caught as ChainError).code).toBe('SECRETS_INVALID');
    expectNoKeyLeak(caught, keys);
  });

  it('reports a missing or unparsable file without echoing its content', () => {
    const dir = tempDir();
    expect(() => loadWallets(path.join(dir, 'nope.json'))).toThrow(expect.objectContaining({ code: 'SECRETS_MISSING' }));
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, `{"wallets":[{"privateKey":"${testKey('x')}"`);
    let caught: unknown;
    try { loadWallets(file); } catch (error) { caught = error; }
    expect((caught as ChainError).code).toBe('SECRETS_INVALID');
    expectNoKeyLeak(caught, [testKey('x')]);
    expect(loadWallets(writeTestWallets(dir)).players()).toHaveLength(11);
  });

  const real = path.join(REPO_ROOT, '.secrets', 'testnet-wallets.json');
  it.skipIf(!existsSync(real))('loads the real .secrets file: operator, distinct signer and 11 players (addresses only)', () => {
    const wallets = loadWallets(real);
    expect(wallets.players()).toHaveLength(11);
    expect(wallets.operator.address).not.toBe(wallets.ledgerSigner.address);
  });
});

describe('forge artifacts', () => {
  const haveArtifacts = existsSync(path.join(ARTIFACTS_DIR, 'MayaHouseVault.sol', 'MayaHouseVault.json'));
  it.skipIf(!haveArtifacts)('checked-in ABIs match contracts/out exactly and the artifacts carry bytecode', () => {
    const artifacts = loadArtifacts(ARTIFACTS_DIR);
    expect(sameAbi(artifacts.vault.abi, mayaHouseVaultAbi)).toBe(true);
    expect(sameAbi(artifacts.token.abi, mockOpenTokenAbi)).toBe(true);
    expect(artifacts.vault.bytecode.length).toBeGreaterThan(1_000);
    expect(artifacts.token.bytecode.startsWith('0x60')).toBe(true);
  });

  it('refuses ABI-only artifacts, missing artifacts and ABI drift with actionable errors', () => {
    const out = tempDir();
    const write = (name: string, body: unknown) => writeJson(path.join(out, `${name}.sol`, `${name}.json`), body);
    expect(() => readArtifact(out, 'MayaHouseVault')).toThrow(expect.objectContaining({ code: 'ARTIFACT_MISSING' }));
    write('MayaHouseVault', { abi: mayaHouseVaultAbi, id: 1 });
    expect(() => readArtifact(out, 'MayaHouseVault')).toThrow(/no creation bytecode.*forge build --force/);
    write('MayaHouseVault', { abi: mayaHouseVaultAbi.slice(1), bytecode: { object: '0x6080' } });
    write('MockOpenToken', { abi: mockOpenTokenAbi, bytecode: { object: '0x6080' } });
    expect(() => loadArtifacts(out)).toThrow(/differs from src\/chain\/abi\.ts; regenerate/);
    mkdirSync(path.join(out, 'X.sol'), { recursive: true });
    writeFileSync(path.join(out, 'X.sol', 'X.json'), '{');
    expect(() => readArtifact(out, 'X')).toThrow(expect.objectContaining({ code: 'ARTIFACT_INVALID' }));
  });

  it('compares ABIs independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(sameAbi([{ type: 'event', name: 'X', inputs: [] }], [{ name: 'X', inputs: [], type: 'event' }])).toBe(true);
  });
});

describe('deployment file', () => {
  const base = {
    chainId: 31337, token: '0x5fbdb2315678afecb367f032d93f642f64180aa3', vault: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
    operator: '0xb19339eb15f067cc3ebc2400765703fc424aca51', ledgerSigner: '0x27ade5d6127174a145ef7069e4d3c5c935892513', blockNumber: 2,
  };

  it('reads the Deploy.s.sol shape (no txs) and checksums addresses', () => {
    const record = parseDeployment(base, 31337);
    expect(record).toMatchObject({ chainId: 31337, token: '0x5FbDB2315678afecb367f032d93F642f64180aa3', blockNumber: 2n, txs: {} });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('round-trips the full shape through an atomic write', () => {
    const dir = tempDir();
    const record = parseDeployment({ ...base, blockHash: `0x${'cd'.repeat(32)}`, network: 'local', txs: { deployToken: `0x${'01'.repeat(32)}`, playerEth: { 'player-1': `0x${'02'.repeat(32)}` } } }, 31337);
    const file = writeDeployment(dir, record);
    expect(file).toBe(deploymentPath(dir, 31337));
    expect(readDeployment(dir, 31337)).toEqual(record);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ chainId: 31337, blockNumber: 2, txs: { playerEth: { 'player-1': expect.any(String) } } });
    expect(readdirSync(dir)).toEqual(['31337.json']);
    expect(serializeDeployment(record).endsWith('\n')).toBe(true);
  });

  it('returns null when absent and refuses malformed files', () => {
    const dir = tempDir();
    expect(readDeployment(dir, 31337)).toBeNull();
    writeFileSync(path.join(dir, '31337.json'), 'nope');
    expect(() => readDeployment(dir, 31337)).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_INVALID' }));
  });

  it.each([
    ['a chainId for another network', { chainId: 84532 }],
    ['a bad address', { vault: '0x123' }],
    ['a negative block', { blockNumber: -1 }],
    ['a fractional block', { blockNumber: 1.5 }],
    ['a bad block hash', { blockHash: '0x12' }],
    ['non-string txs', { txs: { deployToken: 5 } }],
  ])('rejects %s', (_label, change) => {
    expect(() => parseDeployment({ ...base, ...change }, 31337)).toThrow(expect.objectContaining({ code: 'DEPLOYMENT_INVALID' }));
  });
});
