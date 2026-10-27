import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

// e2e verifier: the house server had no RPC override for MAYA_NETWORK=local (always anvil at 127.0.0.1:8545), so it
// could not attach to an anvil on another port while the deploy CLI (--rpc-url) and the anvil tests (MAYA_RPC_URL) could.
describe('MAYA_RPC_URL', () => {
  const base = { MAYA_REPO_ROOT: '.' };
  it('is absent by default (network default RPC)', () => {
    const r = loadConfig(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.rpcUrl).toBeUndefined();
  });
  it('passes an http(s) endpoint through for the live chain adapter', () => {
    expect(loadConfig({ ...base, MAYA_NETWORK: 'local', MAYA_RPC_URL: ' http://127.0.0.1:8551 ' })).toMatchObject({ ok: true, config: { network: 'local', rpcUrl: 'http://127.0.0.1:8551' } });
  });
  it('rejects a malformed endpoint', () => {
    const bad = loadConfig({ ...base, MAYA_RPC_URL: 'ws://127.0.0.1:8551' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/MAYA_RPC_URL must be an http\(s\) URL/);
  });
});
