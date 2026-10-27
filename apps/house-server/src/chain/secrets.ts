import { readFileSync } from 'node:fs';
import { getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ChainError } from './errors.js';

export const OPERATOR_ROLE = 'open-operator';
export const LEDGER_SIGNER_ROLE = 'ledger-signer';
const PLAYER_ROLE = /^player-([1-9]\d*)$/;

export interface WalletInfo {
  readonly role: string;
  readonly address: Address;
}

/**
 * Testnet wallets from `.secrets/testnet-wallets.json`. Private keys never leave this module as
 * strings: each is turned into a viem account (which signs but does not expose the key) and the
 * parsed JSON is dropped. Error messages name roles and addresses only.
 */
export interface WalletSet {
  readonly source: string;
  readonly operator: WalletInfo;
  readonly ledgerSigner: WalletInfo;
  roles(): readonly string[];
  has(role: string): boolean;
  address(role: string): Address;
  account(role: string): PrivateKeyAccount;
  /** player-N roles in numeric order. */
  players(): readonly WalletInfo[];
}

export function isPlayerRole(role: string): boolean { return PLAYER_ROLE.test(role); }

export function loadWallets(file: string): WalletSet {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    throw new ChainError('SECRETS_MISSING', `Testnet wallet file not found or unreadable: ${file}`, { cause: error });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    // Never attach the parse error: its message can quote file content.
    throw new ChainError('SECRETS_INVALID', `Testnet wallet file is not valid JSON: ${file}`);
  }
  return walletsFromJson(parsed, file);
}

export function walletsFromJson(parsed: unknown, source = '<memory>'): WalletSet {
  const invalid = (why: string) => new ChainError('SECRETS_INVALID', `Testnet wallet file ${source}: ${why}`);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { wallets?: unknown }).wallets)) throw invalid('expected { wallets: [{ role, address, privateKey }] }');
  const accounts = new Map<string, PrivateKeyAccount>();
  for (const [index, entry] of ((parsed as { wallets: unknown[] }).wallets).entries()) {
    if (!entry || typeof entry !== 'object') throw invalid(`wallets[${index}] is not an object`);
    const { role, address, privateKey } = entry as { role?: unknown; address?: unknown; privateKey?: unknown };
    if (typeof role !== 'string' || role.trim() === '') throw invalid(`wallets[${index}] has no role`);
    if (accounts.has(role)) throw invalid(`duplicate role ${role}`);
    if (typeof address !== 'string' || !isAddress(address, { strict: false })) throw invalid(`${role} has an invalid address`);
    if (typeof privateKey !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw invalid(`${role} privateKey must be 0x-prefixed 32-byte hex`);
    let account: PrivateKeyAccount;
    try { account = privateKeyToAccount(privateKey as `0x${string}`); } catch { throw invalid(`${role} privateKey is not a valid secp256k1 key`); }
    if (account.address !== getAddress(address)) throw invalid(`${role} privateKey does not match its address ${getAddress(address)}`);
    accounts.set(role, account);
  }
  const info = (role: string): WalletInfo => {
    const account = accounts.get(role);
    if (!account) throw new ChainError('UNKNOWN_ROLE', `No wallet with role "${role}" in ${source}`);
    return Object.freeze({ role, address: account.address });
  };
  for (const required of [OPERATOR_ROLE, LEDGER_SIGNER_ROLE]) if (!accounts.has(required)) throw invalid(`missing required role ${required}`);
  const operator = info(OPERATOR_ROLE); const ledgerSigner = info(LEDGER_SIGNER_ROLE);
  if (operator.address === ledgerSigner.address) throw invalid('open-operator and ledger-signer must be different wallets');
  const players = Object.freeze([...accounts.keys()].filter(isPlayerRole)
    .sort((a, b) => Number(PLAYER_ROLE.exec(a)![1]) - Number(PLAYER_ROLE.exec(b)![1]))
    .map(info));
  const roles = Object.freeze([...accounts.keys()]);
  return Object.freeze({
    source, operator, ledgerSigner,
    roles: () => roles,
    has: (role: string) => accounts.has(role),
    address: (role: string) => info(role).address,
    account: (role: string) => {
      const account = accounts.get(role);
      if (!account) throw new ChainError('UNKNOWN_ROLE', `No wallet with role "${role}" in ${source}`);
      return account;
    },
    players: () => players,
  });
}
