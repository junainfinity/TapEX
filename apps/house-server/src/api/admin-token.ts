import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ADMIN_TOKEN_FILE = 'admin-token';

/**
 * Admin bearer token from `<secretsDir>/admin-token`, generated (32 random bytes, hex) on first
 * start with file mode 600. Only the file path is ever logged.
 */
export function loadOrCreateAdminToken(secretsDir: string, log: (line: string) => void = () => undefined): { readonly token: string; readonly path: string; readonly created: boolean } {
  const path = join(secretsDir, ADMIN_TOKEN_FILE);
  if (existsSync(path)) {
    const token = readFileSync(path, 'utf8').trim();
    if (!/^[A-Za-z0-9._~+/=-]{32,256}$/.test(token)) throw new Error(`Admin token file ${path} is malformed (expected 32–256 URL-safe characters)`);
    log(`house: admin token file ${path}`);
    return { token, path, created: false };
  }
  mkdirSync(secretsDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
  try { chmodSync(path, 0o600); } catch { /* best effort on filesystems without POSIX modes */ }
  log(`house: created admin token file ${path}`);
  return { token, path, created: true };
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string') return false;
  const m = /^Bearer ([^\s]{1,512})$/.exec(header.trim());
  if (!m) return false;
  return timingSafeEqual(digest(m[1]!), digest(token));
}
