import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseUnits18 } from './amounts.js';
import { deployContracts, describeDeployment, DEFAULT_HOUSE_LIMITS, VAULT_BOUNDS, type DeployOptions, type HouseLimits, type VaultLimits } from './deploy.js';
import { ChainError, describe } from './errors.js';
import { isLiveNetwork } from './networks.js';

export const USAGE = `Usage: node apps/house-server/dist/chain/deploy-cli.js --network local|base-sepolia [options]

Deploys MockOpenToken (tOPEN, a test stand-in for $OPEN) and MayaHouseVault from the $OPEN operator
wallet in .secrets/testnet-wallets.json, or attaches to contracts/deployments/<chainId>.json, then
tops the chain up to the requested state. Re-running is idempotent.

Options:
  --network <name>              local (anvil at 127.0.0.1:8545) or base-sepolia (chainId 84532)
  --fund-house <OPEN>           ensure the vault's cumulative house funding is at least this (default 100000000)
  --player-eth <ETH>            ensure each player-N wallet holds at least this much ETH (default local 1, base-sepolia 0.0005)
  --player-tokens <OPEN>        ensure each player-N wallet holds at least this much tOPEN (default 100000)
  --signer-eth <ETH>            ensure the ledger-signer wallet holds at least this much ETH for attest gas (default: --player-eth)
  --max-voucher <OPEN>          vault maxVoucherAmount (contract default 100000)
  --daily-cap <OPEN>            vault dailyOutflowCap, shared by all players per UTC day (contract default 1000000)
  --account-daily-cap <OPEN>    vault accountDailyOutflowCap, one account's share per UTC day (contract default
                                250000; max-voucher <= account-daily-cap <= daily-cap)
  --max-attestation-age <sec>   vault maxAttestationAge in seconds (contract default 600, at most 86400).
                                Each limit flag is converged on its own; an omitted one keeps its on-chain value.
                                Lowering applies at once; raising any limit is timelocked by the signer-change
                                delay: re-run after its eta (and within 7 days of it)
  --escape-delay <sec>          new vault only (immutable): silence before anyone may trigger escape mode
                                (default 604800 = 7 days; 259200..7776000)
  --signer-change-delay <sec>   ledger-signer rotation timelock (contract default 172800 = 48 h; 3600..2592000 and
                                below the escape delay). A decrease is itself timelocked: re-run after its eta
  --house-buffer-bps <bps>      share of attested obligations withdrawHouse keeps (contract default 1000 = 10 %)
  --house-daily-cap <OPEN>      house withdrawals per UTC day (contract default 10000000). Loosening either house
                                limit is timelocked by the signer-change delay: re-run after its eta
  --redeploy                    deploy new contracts even if a deployment file exists
  --rpc-url <url>               RPC endpoint override (base-sepolia also honours MAYA_RPC_URL)
  -h, --help                    show this help`;

export type ParsedArgs =
  | { readonly ok: true; readonly help: true }
  | { readonly ok: true; readonly help: false; readonly options: DeployOptions }
  | { readonly ok: false; readonly message: string };

export function parseDeployArgs(argv: readonly string[]): ParsedArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv], strict: true, allowPositionals: false,
      options: {
        network: { type: 'string' }, 'fund-house': { type: 'string' }, 'player-eth': { type: 'string' }, 'player-tokens': { type: 'string' },
        'signer-eth': { type: 'string' }, 'max-voucher': { type: 'string' }, 'daily-cap': { type: 'string' }, 'account-daily-cap': { type: 'string' }, 'max-attestation-age': { type: 'string' },
        'escape-delay': { type: 'string' }, 'signer-change-delay': { type: 'string' }, 'house-buffer-bps': { type: 'string' }, 'house-daily-cap': { type: 'string' },
        redeploy: { type: 'boolean' }, 'rpc-url': { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
  if (values['help']) return { ok: true, help: true };
  const network = values['network'];
  if (!isLiveNetwork(network)) return { ok: false, message: `--network must be local or base-sepolia${network === undefined ? '' : `, got "${String(network)}"`}` };
  try {
    const amount = (flag: string) => (typeof values[flag] === 'string' ? parseUnits18(values[flag] as string, `--${flag}`) : undefined);
    // Only the limit flags given are converged; an omitted one keeps its on-chain value (CS-L3). The deployer
    // re-checks the merged combination against the vault's rule before any transaction.
    let limits: Partial<VaultLimits> | undefined;
    if (['max-voucher', 'daily-cap', 'account-daily-cap', 'max-attestation-age'].some(f => values[f] !== undefined)) {
      const ageText = values['max-attestation-age'];
      if (ageText !== undefined && (typeof ageText !== 'string' || !/^[1-9]\d*$/.test(ageText))) return { ok: false, message: '--max-attestation-age must be a positive integer number of seconds' };
      const given: VaultLimits = {
        maxVoucherAmountWei: amount('max-voucher') ?? -1n, dailyOutflowCapWei: amount('daily-cap') ?? -1n,
        accountDailyOutflowCapWei: amount('account-daily-cap') ?? -1n, maxAttestationAgeSec: ageText === undefined ? -1n : BigInt(ageText as string),
      };
      const has = (v: bigint) => v >= 0n;
      // Mirror the vault's setLimits bounds for the flags given, so a bad flag fails before any transaction.
      if (given.maxVoucherAmountWei === 0n) return { ok: false, message: '--max-voucher must be positive (vault limits need 0 < --max-voucher <= --account-daily-cap <= --daily-cap)' };
      const order: [bigint, bigint, string][] = [
        [given.maxVoucherAmountWei, given.accountDailyOutflowCapWei, '--max-voucher <= --account-daily-cap'],
        [given.accountDailyOutflowCapWei, given.dailyOutflowCapWei, '--account-daily-cap <= --daily-cap'],
        [given.maxVoucherAmountWei, given.dailyOutflowCapWei, '--max-voucher <= --daily-cap'],
      ];
      for (const [low, high, rule] of order) if (has(low) && has(high) && low > high) return { ok: false, message: `vault limits need ${rule}` };
      if (has(given.maxAttestationAgeSec) && given.maxAttestationAgeSec > VAULT_BOUNDS.maxAttestationAgeSec) return { ok: false, message: '--max-attestation-age must be at most 86400 (1 day)' };
      limits = {
        ...(has(given.maxVoucherAmountWei) ? { maxVoucherAmountWei: given.maxVoucherAmountWei } : {}),
        ...(has(given.dailyOutflowCapWei) ? { dailyOutflowCapWei: given.dailyOutflowCapWei } : {}),
        ...(has(given.accountDailyOutflowCapWei) ? { accountDailyOutflowCapWei: given.accountDailyOutflowCapWei } : {}),
        ...(has(given.maxAttestationAgeSec) ? { maxAttestationAgeSec: given.maxAttestationAgeSec } : {}),
      };
    }
    const seconds = (flag: string): bigint | undefined | string => {
      const text = values[flag];
      if (text === undefined) return undefined;
      if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) return `--${flag} must be a positive integer number of seconds`;
      return BigInt(text);
    };
    const escapeDelaySec = seconds('escape-delay');
    if (typeof escapeDelaySec === 'string') return { ok: false, message: escapeDelaySec };
    if (escapeDelaySec !== undefined && (escapeDelaySec < VAULT_BOUNDS.minEscapeDelaySec || escapeDelaySec > VAULT_BOUNDS.maxEscapeDelaySec)) {
      return { ok: false, message: '--escape-delay must be between 259200 (3 days) and 7776000 (90 days)' };
    }
    const signerChangeDelaySec = seconds('signer-change-delay');
    if (typeof signerChangeDelaySec === 'string') return { ok: false, message: signerChangeDelaySec };
    if (signerChangeDelaySec !== undefined) {
      const escape = escapeDelaySec ?? 7n * 86_400n;
      if (signerChangeDelaySec < VAULT_BOUNDS.minSignerChangeDelaySec || signerChangeDelaySec > VAULT_BOUNDS.maxSignerChangeDelaySec || signerChangeDelaySec >= escape) {
        return { ok: false, message: '--signer-change-delay must be between 3600 and 2592000 seconds and below the escape delay' };
      }
    }
    let houseLimits: HouseLimits | undefined;
    if (values['house-buffer-bps'] !== undefined || values['house-daily-cap'] !== undefined) {
      const bpsText = values['house-buffer-bps'];
      if (bpsText !== undefined && (typeof bpsText !== 'string' || !/^\d+$/.test(bpsText) || BigInt(bpsText) > VAULT_BOUNDS.maxHouseBufferBps)) {
        return { ok: false, message: '--house-buffer-bps must be an integer between 0 and 10000' };
      }
      houseLimits = {
        houseBufferBps: bpsText === undefined ? DEFAULT_HOUSE_LIMITS.houseBufferBps : BigInt(bpsText as string),
        houseDailyCapWei: amount('house-daily-cap') ?? DEFAULT_HOUSE_LIMITS.houseDailyCapWei,
      };
      if (houseLimits.houseDailyCapWei === 0n) return { ok: false, message: '--house-daily-cap must be positive' };
    }
    const options: DeployOptions = {
      network,
      fundHouseWei: amount('fund-house'), playerEthWei: amount('player-eth'), playerTokensWei: amount('player-tokens'), signerEthWei: amount('signer-eth'),
      limits, escapeDelaySec, signerChangeDelaySec, houseLimits,
      redeploy: values['redeploy'] === true, rpcUrl: typeof values['rpc-url'] === 'string' ? values['rpc-url'] : undefined,
    };
    return { ok: true, help: false, options };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Returns the process exit code: 0 success, 1 failure, 2 usage error. */
export async function runDeployCli(argv: readonly string[], io: CliIo = { out: l => console.log(l), err: l => console.error(l) }, deploy: typeof deployContracts = deployContracts): Promise<number> {
  const parsed = parseDeployArgs(argv);
  if (!parsed.ok) { io.err(`error: ${parsed.message}\n\n${USAGE}`); return 2; }
  if (parsed.help) { io.out(USAGE); return 0; }
  try {
    const result = await deploy({ ...parsed.options, log: line => io.err(line) });
    io.out(describeDeployment(result, parsed.options.network));
    return 0;
  } catch (error) {
    if (error instanceof ChainError) io.err(`deploy failed [${error.code}]: ${error.message}`);
    else io.err(`deploy failed: ${describe(error)}`);
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  process.exitCode = await runDeployCli(process.argv.slice(2));
}
