import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const ARTIFACTS_DIR = path.join(REPO_ROOT, 'contracts', 'out');

export const TEST_ROLES = Object.freeze(['open-operator', 'ledger-signer', ...Array.from({ length: 11 }, (_, i) => `player-${i + 1}`)]);

/** Deterministic, publicly derivable keys: test fixtures only, never used outside local/fake chains. */
export function testKey(role: string, salt = 'maya-live-chain-test'): Hex {
  return keccak256(toHex(`${salt}:${role}`));
}

export function testWalletsJson(roles: readonly string[] = TEST_ROLES, salt?: string) {
  return {
    network: 'local-test', chainId: 31337, warning: 'deterministic test keys',
    wallets: roles.map(role => ({ role, address: privateKeyToAccount(testKey(role, salt)).address, privateKey: testKey(role, salt) })),
  };
}

export function testAddress(role: string, salt?: string): Hex {
  return privateKeyToAccount(testKey(role, salt)).address;
}

const temps: string[] = [];
export function tempDir(prefix = 'maya-chain-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function writeJson(file: string, value: unknown): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function writeTestWallets(dir: string, roles?: readonly string[], salt?: string): string {
  return writeJson(path.join(dir, 'testnet-wallets.json'), testWalletsJson(roles, salt));
}

export type RpcHandler = (params: readonly unknown[]) => unknown;

/** Minimal JSON-RPC over HTTP on 127.0.0.1 for exercising code paths that stop before any transaction. */
export async function startFakeRpc(handlers: Record<string, RpcHandler>): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const handle = (msg: { id: number; method: string; params?: unknown[] }) => {
        calls.push(msg.method);
        const handler = handlers[msg.method];
        if (!handler) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method ${msg.method} not supported by fake` } };
        try { return { jsonrpc: '2.0', id: msg.id, result: handler(msg.params ?? []) }; } catch (error) {
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: (error as Error).message } };
        }
      };
      const parsed = JSON.parse(body) as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(handle) : handle(parsed)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake rpc did not bind');
  return {
    url: `http://127.0.0.1:${address.port}`, calls,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

export async function waitFor<T>(probe: () => T | undefined | null | false, { timeoutMs = 10_000, intervalMs = 20, what = 'condition' } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}
