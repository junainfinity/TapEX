// Bridges test ETH from Ethereum Sepolia to Base Sepolia for a Maya-Live testnet wallet through
// Base's official L1StandardBridge (depositETH), then waits for the L2 credit.
// Keys are read from .secrets/testnet-wallets.json and never printed.
//
//   node tooling/testnet/bridge-sepolia-to-base.mjs [--role open-operator] [--amount 0.1] [--dry-run]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/house-server/package.json', import.meta.url));
const { createPublicClient, createWalletClient, formatEther, http, parseEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, sepolia } = require('viem/chains');

// docs.base.org/base-chain/network-information/base-contracts (Base Sepolia L1 contracts on Sepolia)
const L1_STANDARD_BRIDGE = '0xfd0Bf71F60660E2f608ed56e1659C450eB113120';
const ABI = [{ type: 'function', name: 'depositETH', stateMutability: 'payable', inputs: [{ name: '_minGasLimit', type: 'uint32' }, { name: '_extraData', type: 'bytes' }], outputs: [] }];
const L1_RESERVE = parseEther('0.005');

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const role = opt('role', 'open-operator');
const wallets = JSON.parse(readFileSync(new URL('../../.secrets/testnet-wallets.json', import.meta.url), 'utf8')).wallets;
const wallet = wallets.find((w) => w.role === role);
if (!wallet) throw new Error(`No wallet with role ${role}`);
const account = privateKeyToAccount(wallet.privateKey);

const l1 = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com') });
const l2 = createPublicClient({ chain: baseSepolia, transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org') });
const signer = createWalletClient({ account, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com') });

const [l1Balance, l2Before, code] = await Promise.all([l1.getBalance({ address: account.address }), l2.getBalance({ address: account.address }), l1.getCode({ address: L1_STANDARD_BRIDGE })]);
console.log(`${role} ${account.address}\n  Sepolia ${formatEther(l1Balance)} ETH\n  Base Sepolia ${formatEther(l2Before)} ETH`);
if (!code || code === '0x') throw new Error('L1StandardBridge has no code on Sepolia; refusing to send.');
const amount = opt('amount') ? parseEther(opt('amount')) : l1Balance - L1_RESERVE;
if (amount <= 0n || amount + L1_RESERVE > l1Balance) throw new Error(`Not enough Sepolia ETH: have ${formatEther(l1Balance)}, need amount + ${formatEther(L1_RESERVE)} reserve for gas.`);
console.log(`Bridging ${formatEther(amount)} ETH to Base Sepolia via ${L1_STANDARD_BRIDGE}`);
if (args.includes('--dry-run')) process.exit(0);

const hash = await signer.writeContract({ address: L1_STANDARD_BRIDGE, abi: ABI, functionName: 'depositETH', args: [200_000, '0x'], value: amount });
console.log(`  L1 tx https://sepolia.etherscan.io/tx/${hash}`);
const receipt = await l1.waitForTransactionReceipt({ hash, timeout: 300_000 });
if (receipt.status !== 'success') throw new Error(`L1 deposit reverted in block ${receipt.blockNumber}`);
console.log(`  L1 confirmed in block ${receipt.blockNumber}; waiting for the Base Sepolia credit (usually 1-3 min)`);
const deadline = Date.now() + 15 * 60_000;
for (;;) {
  const now = await l2.getBalance({ address: account.address });
  if (now > l2Before) { console.log(`  Base Sepolia balance ${formatEther(now)} ETH`); break; }
  if (Date.now() > deadline) throw new Error('No L2 credit after 15 minutes; check the L1 tx on the explorer.');
  await new Promise((r) => setTimeout(r, 10_000));
}
