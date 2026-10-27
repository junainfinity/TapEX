import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recoverMessageAddress, recoverTypedDataAddress, stringToHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { devWalletAllowed, type DevWallet, type DevWalletTx } from '../src/api/dev-wallet.js';
import { loadConfig } from '../src/config.js';
import { api, startTestApp, type TestApp } from './app-helpers.js';

const player = privateKeyToAccount(generatePrivateKey());
const sent: DevWalletTx[] = [];
/** A DevWallet over one throwaway key (createDevWallet needs a live anvil; its RPC chain check runs in browser QA). */
const fake: DevWallet = {
  chainId: 31337, siweDomain: '127.0.0.1:5173', defaultRole: 'player-1',
  has: role => role === 'player-1',
  address: () => player.address,
  signMessage: (_role, raw) => player.signMessage({ message: { raw } }),
  signTypedData: (_role, t) => player.signTypedData(t as Parameters<typeof player.signTypedData>[0]),
  sendTransaction: async (_role, tx) => { sent.push(tx); return `0x${'ab'.repeat(32)}` as Hex; },
};

describe('dev test wallet gating', () => {
  it('is allowed only with the flag, the local chain and a 127.0.0.1 bind (config refuses anything else)', () => {
    expect(devWalletAllowed({ devTestWallet: true, host: '127.0.0.1', network: 'local' })).toEqual({ ok: true });
    expect(devWalletAllowed({ devTestWallet: false, host: '127.0.0.1', network: 'local' }).ok).toBe(false);
    expect(devWalletAllowed({ devTestWallet: true, host: '0.0.0.0', network: 'local' }).ok).toBe(false);
    expect(devWalletAllowed({ devTestWallet: true, host: '127.0.0.1', network: 'base-sepolia' }).ok).toBe(false);
    expect(devWalletAllowed({ devTestWallet: true, host: '127.0.0.1', network: 'offline' }).ok).toBe(false);
    expect(loadConfig({ MAYA_NETWORK: 'local', MAYA_DEV_TEST_WALLET: '1' })).toMatchObject({ ok: true, config: { devTestWallet: true, devTestWalletRole: 'player-1', host: '127.0.0.1' } });
    expect(loadConfig({})).toMatchObject({ ok: true, config: { devTestWallet: false, publicOrigin: 'http://127.0.0.1:8180' } });
    for (const env of [{ MAYA_NETWORK: 'base-sepolia', MAYA_DEV_TEST_WALLET: '1' }, { MAYA_DEV_TEST_WALLET: '1' }, { MAYA_NETWORK: 'local', MAYA_HOST: '0.0.0.0', MAYA_DEV_TEST_WALLET: 'true' }, { MAYA_NETWORK: 'local', MAYA_DEV_TEST_WALLET: '1', MAYA_DEV_TEST_WALLET_ROLE: 'open-operator' }]) {
      const r = loadConfig(env);
      expect(r.ok, JSON.stringify(env)).toBe(false);
      if (!r.ok) expect(r.errors.join(' ')).toMatch(/MAYA_DEV_TEST_WALLET/);
    }
    expect(loadConfig({ MAYA_PUBLIC_ORIGIN: 'http://127.0.0.1:8180/path' }).ok).toBe(false);
  });
});

describe('dev test wallet route', () => {
  let plain: TestApp, dev: TestApp;
  beforeAll(async () => {
    plain = await startTestApp({ auth: { publicOrigin: 'http://127.0.0.1:5173', chainId: 31337 } });
    dev = await startTestApp({ auth: { publicOrigin: 'http://127.0.0.1:5173', chainId: 31337 }, devWallet: fake });
  });
  afterAll(async () => { await plain.close(); await dev.close(); });

  it('does not exist unless the server was built with a dev wallet', async () => {
    for (const method of ['eth_accounts', 'personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction']) {
      expect((await api(plain.base, 'POST', `/v1/dev/wallet/${method}`, { params: [] })).status).toBe(404);
    }
  });

  it('answers accounts and signs only this game\'s SIWE messages, local-chain typed data and local transactions', async () => {
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_requestAccounts', {})).body).toEqual({ result: [player.address] });
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_accounts', { role: 'player-9' })).status).toBe(400);
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_chainId', {})).status).toBe(404);

    const siwe = createSiweMessage({ address: player.address, chainId: 31337, domain: '127.0.0.1:5173', nonce: 'abcdef123456', uri: 'http://127.0.0.1:5173/', version: '1', issuedAt: new Date() });
    const signed = await api(dev.base, 'POST', '/v1/dev/wallet/personal_sign', { params: [stringToHex(siwe), player.address] });
    expect(signed.status).toBe(200);
    expect(await recoverMessageAddress({ message: siwe, signature: signed.body.result })).toBe(player.address);
    // Anything else is refused: another site, another chain (e.g. Base Sepolia, where these keys also hold tOPEN), plain text.
    for (const message of [
      createSiweMessage({ address: player.address, chainId: 84532, domain: '127.0.0.1:5173', nonce: 'abcdef123456', uri: 'http://127.0.0.1:5173/', version: '1' }),
      createSiweMessage({ address: player.address, chainId: 31337, domain: 'evil.example', nonce: 'abcdef123456', uri: 'https://evil.example/', version: '1' }),
      'Please sign to prove you own this wallet',
    ]) expect((await api(dev.base, 'POST', '/v1/dev/wallet/personal_sign', { params: [stringToHex(message), player.address] })).body.error.code).toBe('DEV_WALLET_MESSAGE_REFUSED');
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/personal_sign', { params: [stringToHex(siwe), '0x' + '1'.repeat(40)] })).status).toBe(403);

    const typed = { domain: { name: 'MayaHouseVault', version: '1', chainId: 31337, verifyingContract: '0x' + '2'.repeat(40) }, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], Ping: [{ name: 'n', type: 'uint256' }] }, primaryType: 'Ping', message: { n: '7' } };
    const sig = await api(dev.base, 'POST', '/v1/dev/wallet/eth_signTypedData_v4', { params: [player.address, JSON.stringify(typed)] });
    expect(sig.status).toBe(200);
    const { EIP712Domain: _d, ...types } = typed.types;
    expect(await recoverTypedDataAddress({ domain: { ...typed.domain, verifyingContract: typed.domain.verifyingContract as Hex }, types, primaryType: 'Ping', message: { n: 7n }, signature: sig.body.result })).toBe(player.address);
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_signTypedData_v4', { params: [player.address, JSON.stringify({ ...typed, domain: { ...typed.domain, chainId: 84532 } })] })).body.error.code).toBe('DEV_WALLET_CHAIN_REFUSED');

    const tx = await api(dev.base, 'POST', '/v1/dev/wallet/eth_sendTransaction', { params: [{ from: player.address, to: '0x' + '3'.repeat(40), data: '0x1234', value: '0x0', gas: '0x5208' }] });
    expect(tx.body).toEqual({ result: `0x${'ab'.repeat(32)}` });
    expect(sent.at(-1)).toEqual({ to: '0x' + '3'.repeat(40), data: '0x1234', value: 0n, gas: 21000n });
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_sendTransaction', { params: [{ from: '0x' + '1'.repeat(40), to: '0x' + '3'.repeat(40) }] })).status).toBe(403);
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_sendTransaction', { params: [{ from: player.address, data: '0x60' }] })).status).toBe(400);
    expect((await api(dev.base, 'POST', '/v1/dev/wallet/eth_sendTransaction', { params: [{ from: player.address, to: '0x' + '3'.repeat(40), chainId: '0x14a34' }] })).status).toBe(403);
  });

  it('refuses non-loopback Host headers (DNS rebinding) and foreign origins', async () => {
    const port = new URL(dev.base).port;
    const { request } = await import('node:http');
    const status = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/v1/dev/wallet/eth_accounts', method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject); req.end('{}');
    });
    expect(await status({ Host: `127.0.0.1:${port}` })).toBe(200);
    expect(await status({ Host: `localhost:${port}` })).toBe(200);
    expect(await status({ Host: `attacker.example:${port}` })).toBe(403);
    expect(await status({ Host: `127.0.0.1:${port}`, Origin: 'https://attacker.example' })).toBe(403);
    expect(await status({ Host: `127.0.0.1:${port}`, Origin: 'http://127.0.0.1:5173' })).toBe(200);
  });
});
