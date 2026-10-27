import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { LocalAccount } from 'viem/accounts';
import { assertUint } from './amounts.js';
import { ChainError } from './errors.js';

/** Must match `EIP712("MayaHouseVault", "1")` and `WITHDRAWAL_TYPEHASH` in MayaHouseVault.sol. */
export const VOUCHER_DOMAIN_NAME = 'MayaHouseVault';
export const VOUCHER_DOMAIN_VERSION = '1';
export const WITHDRAWAL_TYPES = {
  Withdrawal: [
    { name: 'account', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const;

export interface VoucherTerms {
  readonly account: string;
  readonly amountWei: bigint;
  readonly nonce: bigint;
  readonly expiry: bigint;
}

export interface VoucherDomain {
  readonly chainId: number;
  readonly vault: Address;
}

export function voucherDomain(domain: VoucherDomain) {
  return { name: VOUCHER_DOMAIN_NAME, version: VOUCHER_DOMAIN_VERSION, chainId: domain.chainId, verifyingContract: domain.vault } as const;
}

function message(terms: VoucherTerms) {
  if (typeof terms.account !== 'string' || !isAddress(terms.account, { strict: false })) throw new ChainError('INVALID_ARGUMENT', `Voucher account must be an address, got "${String(terms.account)}"`);
  return {
    account: getAddress(terms.account),
    // The vault rejects zero amounts; signing one would only create an unusable voucher.
    amount: assertUint(terms.amountWei, 'voucher amountWei', { min: 1n }),
    nonce: assertUint(terms.nonce, 'voucher nonce'),
    expiry: assertUint(terms.expiry, 'voucher expiry', { min: 1n }),
  };
}

/** The EIP-712 digest the vault recovers (equals `vault.hashWithdrawal(account, amount, nonce, expiry)`). */
export function withdrawalDigest(domain: VoucherDomain, terms: VoucherTerms): Hex {
  return hashTypedData({ domain: voucherDomain(domain), types: WITHDRAWAL_TYPES, primaryType: 'Withdrawal', message: message(terms) });
}

/** 65-byte r‖s‖v signature (low-s, as the vault's ECDSA.tryRecover requires). */
export async function signWithdrawalVoucher(signer: LocalAccount, domain: VoucherDomain, terms: VoucherTerms): Promise<Hex> {
  return signer.signTypedData({ domain: voucherDomain(domain), types: WITHDRAWAL_TYPES, primaryType: 'Withdrawal', message: message(terms) });
}

export async function recoverVoucherSigner(domain: VoucherDomain, terms: VoucherTerms, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ domain: voucherDomain(domain), types: WITHDRAWAL_TYPES, primaryType: 'Withdrawal', message: message(terms), signature });
}
