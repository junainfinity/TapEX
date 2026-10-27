import { describe, expect, it } from 'vitest';
import { parseDeployArgs, USAGE } from '../../src/chain/deploy-cli.js';
import { DEFAULT_ESCAPE_DELAY_SEC, DEFAULT_HOUSE_LIMITS, DEFAULT_LIMITS, DEFAULT_SIGNER_CHANGE_DELAY_SEC, limitsProblem, mergeLimits, VAULT_BOUNDS } from '../../src/chain/deploy.js';

const E18 = 10n ** 18n;

describe('deploy CLI: SPEC-11 vault parameters', () => {
  it('mirrors the vault defaults and bounds', () => {
    expect(DEFAULT_LIMITS.maxAttestationAgeSec).toBe(600n);
    expect(DEFAULT_ESCAPE_DELAY_SEC).toBe(604_800n);
    expect(DEFAULT_SIGNER_CHANGE_DELAY_SEC).toBe(172_800n);
    expect(DEFAULT_HOUSE_LIMITS).toEqual({ houseBufferBps: 1_000n, houseDailyCapWei: 10_000_000n * E18 });
    expect(VAULT_BOUNDS).toMatchObject({ maxAttestationAgeSec: 86_400n, minEscapeDelaySec: 259_200n, maxEscapeDelaySec: 7_776_000n, minSignerChangeDelaySec: 3_600n, maxSignerChangeDelaySec: 2_592_000n, maxHouseBufferBps: 10_000n });
    for (const flag of ['--escape-delay', '--signer-change-delay', '--house-buffer-bps', '--house-daily-cap']) expect(USAGE).toContain(flag);
  });

  it('leaves the timelocked parameters alone unless asked', () => {
    expect(parseDeployArgs(['--network', 'local'])).toMatchObject({ ok: true, options: { escapeDelaySec: undefined, signerChangeDelaySec: undefined, houseLimits: undefined } });
  });

  it('parses the escape delay, the signer-change delay and the house limits exactly', () => {
    const parsed = parseDeployArgs(['--network', 'local', '--escape-delay', '259200', '--signer-change-delay', '3600', '--house-buffer-bps', '2500', '--house-daily-cap', '1234.5']);
    expect(parsed).toMatchObject({ ok: true, options: { escapeDelaySec: 259_200n, signerChangeDelaySec: 3_600n, houseLimits: { houseBufferBps: 2_500n, houseDailyCapWei: 12_345n * 10n ** 17n } } });
    expect(parseDeployArgs(['--network', 'local', '--house-buffer-bps', '0'])).toMatchObject({ ok: true, options: { houseLimits: { houseBufferBps: 0n, houseDailyCapWei: DEFAULT_HOUSE_LIMITS.houseDailyCapWei } } });
    expect(parseDeployArgs(['--network', 'local', '--house-daily-cap', '5'])).toMatchObject({ ok: true, options: { houseLimits: { houseBufferBps: 1_000n, houseDailyCapWei: 5n * E18 } } });
  });

  it.each([
    [['--escape-delay', '259199'], '--escape-delay must be between'],
    [['--escape-delay', '7776001'], '--escape-delay must be between'],
    [['--escape-delay', '1.5'], 'positive integer'],
    [['--signer-change-delay', '3599'], '--signer-change-delay must be between'],
    [['--signer-change-delay', '604800'], 'below the escape delay'],
    [['--escape-delay', '259200', '--signer-change-delay', '259200'], 'below the escape delay'],
    [['--escape-delay', '7776000', '--signer-change-delay', '2592001'], '--signer-change-delay must be between'],
    [['--house-buffer-bps', '10001'], '--house-buffer-bps must be an integer between 0 and 10000'],
    [['--house-buffer-bps', '-1'], '--house-buffer-bps'],
    [['--house-daily-cap', '0'], '--house-daily-cap must be positive'],
    [['--house-daily-cap', '1e6'], '--house-daily-cap'],
  ])('rejects %j', (flags, message) => {
    const parsed = parseDeployArgs(['--network', 'local', ...flags]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(message);
  });

});

describe('deploy CLI: vault player limits (contracts-security review)', () => {
  it('mirrors the new vault defaults and bounds', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxVoucherAmountWei: 100_000n * E18, dailyOutflowCapWei: 1_000_000n * E18, accountDailyOutflowCapWei: 250_000n * E18, maxAttestationAgeSec: 600n });
    expect(VAULT_BOUNDS.timelockGracePeriodSec).toBe(604_800n);
    expect(USAGE).toContain('--account-daily-cap');
    expect(USAGE).toContain('an omitted one keeps its on-chain value');
  });

  it('CS-L3: converges each limit flag on its own and never fills defaults', () => {
    expect(parseDeployArgs(['--network', 'local'])).toMatchObject({ ok: true, options: { limits: undefined } });
    const share = parseDeployArgs(['--network', 'local', '--account-daily-cap', '300000']);
    expect(share.ok && !share.help ? share.options.limits : undefined).toEqual({ accountDailyOutflowCapWei: 300_000n * E18 });
    const all = parseDeployArgs(['--network', 'local', '--max-voucher', '5000', '--daily-cap', '50000', '--account-daily-cap', '20000', '--max-attestation-age', '300']);
    expect(all.ok && !all.help ? all.options.limits : undefined).toEqual({ maxVoucherAmountWei: 5_000n * E18, dailyOutflowCapWei: 50_000n * E18, accountDailyOutflowCapWei: 20_000n * E18, maxAttestationAgeSec: 300n });
  });

  it.each([
    [['--max-voucher', '300000', '--account-daily-cap', '200000'], '--max-voucher <= --account-daily-cap'],
    [['--account-daily-cap', '2000000', '--daily-cap', '1000000'], '--account-daily-cap <= --daily-cap'],
    [['--max-voucher', '0'], '--max-voucher must be positive'],
    [['--account-daily-cap', '1e6'], '--account-daily-cap'],
  ])('rejects %j', (flags, message) => {
    const parsed = parseDeployArgs(['--network', 'local', ...flags]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(message);
  });

  it('merges requested limits over the on-chain ones and applies the vault rule to the result', () => {
    const onChain = { maxVoucherAmountWei: 5_000n * E18, dailyOutflowCapWei: 50_000n * E18, accountDailyOutflowCapWei: 20_000n * E18, maxAttestationAgeSec: 300n };
    expect(mergeLimits(onChain, {})).toEqual(onChain);
    expect(mergeLimits(onChain, { maxVoucherAmountWei: 10_000n * E18 })).toEqual({ ...onChain, maxVoucherAmountWei: 10_000n * E18 });
    expect(limitsProblem(onChain)).toBeNull();
    expect(limitsProblem(mergeLimits(onChain, { maxVoucherAmountWei: 30_000n * E18 }))).toContain('per-account daily cap');
    expect(limitsProblem(mergeLimits(onChain, { accountDailyOutflowCapWei: 60_000n * E18 }))).toContain('must not exceed the daily cap');
    expect(limitsProblem(mergeLimits(onChain, { maxAttestationAgeSec: 86_401n }))).toContain('1..86400');
    expect(limitsProblem(mergeLimits(onChain, { maxVoucherAmountWei: 0n }))).toContain('positive');
  });
});
