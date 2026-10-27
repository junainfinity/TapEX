import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertUint, formatUnits18, parseUnits18, UINT256_MAX, UINT64_MAX } from '../../src/chain/amounts.js';
import { planAttestation } from '../../src/chain/attestation.js';
import { ChainError, describe as describeError, formatRevert, isChainError } from '../../src/chain/errors.js';
import { ANVIL_DEV_ACCOUNT_0, defaultRepoRoot, explorerUrl, isLiveNetwork, networkConfig, repoPaths } from '../../src/chain/networks.js';
import { backoffDelay, retry } from '../../src/chain/retry.js';
import { privateKeyToAccount } from 'viem/accounts';
import { REPO_ROOT } from './fixtures.js';

describe('exact 18-decimal amounts', () => {
  it('parses decimals exactly, never rounding', () => {
    expect(parseUnits18('0')).toBe(0n);
    expect(parseUnits18('1')).toBe(10n ** 18n);
    expect(parseUnits18('0.01')).toBe(10n ** 16n);
    expect(parseUnits18('100000000')).toBe(10n ** 26n);
    expect(parseUnits18('0.000000000000000001')).toBe(1n);
    expect(parseUnits18(' 1.5 ')).toBe(15n * 10n ** 17n);
    expect(parseUnits18('123456789.123456789123456789')).toBe(123456789123456789123456789n);
  });
  it.each(['', '-1', '1.', '.5', '1e18', '1,000', '0x10', '1.0000000000000000001', 'abc', '1 000'])('rejects %j', text => {
    expect(() => parseUnits18(text, '--x')).toThrow(ChainError);
  });
  it('rejects values above uint256', () => {
    expect(() => parseUnits18('1'.padEnd(80, '0'))).toThrow(/uint256/);
  });
  it('formats without losing digits and round-trips', () => {
    expect(formatUnits18(0n)).toBe('0');
    expect(formatUnits18(10n ** 18n)).toBe('1');
    expect(formatUnits18(15n * 10n ** 17n)).toBe('1.5');
    expect(formatUnits18(1n)).toBe('0.000000000000000001');
    expect(formatUnits18(-25n * 10n ** 16n)).toBe('-0.25');
    for (const wei of [0n, 1n, 999n, 10n ** 16n + 3n, 123456789123456789123456789n]) expect(parseUnits18(formatUnits18(wei))).toBe(wei);
  });
  it('bounds-checks integers', () => {
    expect(assertUint(5n, 'x', { min: 1n })).toBe(5n);
    expect(() => assertUint(0n, 'x', { min: 1n })).toThrow(/x must be in/);
    expect(() => assertUint(UINT256_MAX + 1n, 'x')).toThrow(ChainError);
    expect(() => assertUint(1 as unknown as bigint, 'x')).toThrow(/bigint/);
  });
});

describe('network configuration', () => {
  it('defines local anvil and Base Sepolia per SPEC', () => {
    const local = networkConfig('local', { env: {} });
    expect(local).toMatchObject({ chainId: 31337, rpcUrl: 'http://127.0.0.1:8545', explorer: null, confirmations: 0 });
    const base = networkConfig('base-sepolia', { env: {} });
    expect(base).toMatchObject({ chainId: 84532, rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', confirmations: 2 });
    expect(base.chain.id).toBe(84532);
    expect(local.chain.id).toBe(31337);
    expect(Object.isFrozen(base)).toBe(true);
  });
  it('lets MAYA_RPC_URL override the Base Sepolia RPC only; an explicit rpcUrl wins', () => {
    const env = { MAYA_RPC_URL: 'https://example.invalid/rpc' };
    expect(networkConfig('base-sepolia', { env }).rpcUrl).toBe('https://example.invalid/rpc');
    expect(networkConfig('base-sepolia', { env: { MAYA_RPC_URL: '  ' } }).rpcUrl).toBe('https://sepolia.base.org');
    expect(networkConfig('local', { env }).rpcUrl).toBe('http://127.0.0.1:8545');
    expect(networkConfig('base-sepolia', { env, rpcUrl: 'http://x' }).rpcUrl).toBe('http://x');
  });
  it('rejects unknown networks', () => {
    expect(() => networkConfig('offline' as 'local')).toThrow(/Unknown network/);
    expect(isLiveNetwork('local')).toBe(true);
    expect(isLiveNetwork('offline')).toBe(false);
  });
  it('builds explorer links only for well-formed values on Base Sepolia', () => {
    const base = networkConfig('base-sepolia', { env: {} });
    const address = '0xb19339Eb15f067cc3eBc2400765703FC424aCa51';
    const tx = `0x${'ab'.repeat(32)}`;
    expect(explorerUrl(base, 'address', address)).toBe(`https://sepolia.basescan.org/address/${address}`);
    expect(explorerUrl(base, 'tx', tx)).toBe(`https://sepolia.basescan.org/tx/${tx}`);
    expect(explorerUrl(base, 'tx', address)).toBeNull();
    expect(explorerUrl(base, 'address', 'javascript:alert(1)')).toBeNull();
    expect(explorerUrl(networkConfig('local', { env: {} }), 'address', address)).toBeNull();
  });
  it('resolves the repo root from the module location or MAYA_REPO_ROOT', () => {
    expect(defaultRepoRoot({})).toBe(REPO_ROOT);
    expect(existsSync(path.join(defaultRepoRoot({}), 'contracts', 'foundry.toml'))).toBe(true);
    expect(defaultRepoRoot({ MAYA_REPO_ROOT: '/tmp/x' })).toBe(path.resolve('/tmp/x'));
    expect(repoPaths(REPO_ROOT).deployments).toBe(path.join(REPO_ROOT, 'contracts', 'deployments'));
  });
  it('pins the anvil dev account to its well-known public address', () => {
    expect(privateKeyToAccount(ANVIL_DEV_ACCOUNT_0.privateKey).address).toBe(ANVIL_DEV_ACCOUNT_0.address);
  });
});

describe('retry and backoff', () => {
  it('backs off exponentially up to the cap', () => {
    expect([0, 1, 2, 3, 4, 10, 60].map(a => backoffDelay(a, 100, 1_000))).toEqual([0, 100, 200, 400, 800, 1_000, 1_000]);
  });
  it('retries until success and reports each delay', async () => {
    const delays: number[] = [];
    let calls = 0;
    const value = await retry(async () => { if (++calls < 3) throw new Error('flaky'); return 'ok'; }, { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: async ms => { delays.push(ms); } });
    expect(value).toBe('ok');
    expect(delays).toEqual([10, 20]);
  });
  it('stops at the attempt limit or when told not to retry', async () => {
    const sleep = async () => undefined;
    let calls = 0;
    await expect(retry(async () => { calls++; throw new Error('down'); }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep })).rejects.toThrow('down');
    expect(calls).toBe(3);
    calls = 0;
    await expect(retry(async () => { calls++; throw new Error('fatal'); }, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep, shouldRetry: () => false })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});

describe('attestation planning', () => {
  const watermark = { number: 100n, hash: `0x${'11'.repeat(32)}`, timestamp: 1_800_000_000n };
  const request = { liabilitiesWei: 5n * 10n ** 18n, ledgerRoot: `0x${'AB'.repeat(32)}`, asOf: 1_799_999_990n, seq: 1n };

  it('keeps an asOf at or before the indexed chain time', () => {
    expect(planAttestation(request, watermark, 0)).toEqual({ ok: true, liabilitiesWei: request.liabilitiesWei, ledgerRoot: `0x${'ab'.repeat(32)}`, asOf: 1_799_999_990n, seq: 1n, clamped: false });
    expect(planAttestation({ ...request, asOf: watermark.timestamp }, watermark, 0)).toMatchObject({ ok: true, asOf: watermark.timestamp, clamped: false });
  });
  it('clamps a later asOf (wall clock, milliseconds, replay clock ahead) down to the watermark timestamp', () => {
    for (const asOf of [watermark.timestamp + 1n, 1_800_000_000_000n]) {
      expect(planAttestation({ ...request, asOf }, watermark, 0)).toMatchObject({ ok: true, asOf: watermark.timestamp, clamped: true });
    }
  });
  it('refuses before the first scan and while deposits are undelivered', () => {
    expect(planAttestation(request, null, 0)).toMatchObject({ ok: false, code: 'INDEXER_NOT_READY' });
    expect(planAttestation(request, watermark, 2)).toMatchObject({ ok: false, code: 'INDEXER_UNDELIVERED' });
  });
  it.each([
    ['negative liabilities', { liabilitiesWei: -1n }],
    ['liabilities above uint256', { liabilitiesWei: UINT256_MAX + 1n }],
    ['short root', { ledgerRoot: '0x1234' }],
    ['unprefixed root', { ledgerRoot: 'ab'.repeat(32) }],
    ['seq 0', { seq: 0n }],
    ['seq above uint64', { seq: UINT64_MAX + 1n }],
    ['asOf 0', { asOf: 0n }],
    ['number asOf', { asOf: 5 as unknown as bigint }],
  ])('rejects %s', (_label, change) => {
    expect(planAttestation({ ...request, ...change }, watermark, 0)).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  });
});

describe('ChainError', () => {
  it('carries a stable code, revert info and tx hash', () => {
    const error = new ChainError('CONTRACT_REVERT', 'x', { revert: { name: 'NoAttestation', args: [] }, txHash: '0x1' });
    expect(isChainError(error)).toBe(true);
    expect(isChainError(error, 'CONTRACT_REVERT')).toBe(true);
    expect(isChainError(error, 'TX_TIMEOUT')).toBe(false);
    expect(isChainError(new Error('x'))).toBe(false);
    expect(error.name).toBe('ChainError');
    expect(describeError(error)).toBe('CONTRACT_REVERT: x');
    expect(describeError('plain')).toBe('plain');
    expect(formatRevert({ name: 'ExceedsHouseSurplus', args: [5n, 3n] })).toBe('ExceedsHouseSurplus(5, 3)');
  });
});
