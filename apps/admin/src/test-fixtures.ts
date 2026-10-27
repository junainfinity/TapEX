/** Small deterministic payloads shared by unit tests (not bundled: only tests import this). */
import type { ChainState, LaunchState, LimitsConfig, MarketState, PlayerRow, PricingConfig } from './types.js';

export const OPERATOR = '0x1111111111111111111111111111111111111111';
export const VAULT = '0x2222222222222222222222222222222222222222';
export const TOKEN = '0x3333333333333333333333333333333333333333';

export function launchFixture(overrides: Partial<LaunchState> = {}): LaunchState {
  return { enabled: true, active: true, edge: 0.03, untilPlayers: 10_000, standardEdge: 0.08, ...overrides };
}

export function pricingFixture(overrides: Partial<PricingConfig> = {}): PricingConfig {
  return { standardEdge: 0.08, capX100: 5000, aboveCap: 'hide', impactK: 0.5, z: 1, ...overrides };
}

export function limitsFixture(overrides: Partial<LimitsConfig> = {}): LimitsConfig {
  return { cellFraction: 0.001, columnFraction: 0.005, globalFraction: 0.02, accountFraction: 0.002, maxStakePerBetCenti: '100000', maxStakePerCellCenti: '500000', ...overrides };
}

export function marketFixture(id: string, overrides: Partial<MarketState> = {}): MarketState {
  return { id, enabled: true, paused: false, lastPriceMs: 1_790_000_000_000, spot: id.startsWith('BTC') ? '64012.5' : '2451.25', sigma: 0.0004, tableId: `maya-calibrated-v3-${id}`, ...overrides };
}

export function overviewFixture(): Record<string, unknown> {
  return {
    network: 'base-sepolia', chainId: 84532, operator: OPERATOR, vault: VAULT, token: TOKEN, feedMode: 'replay', speed: 20, clockMs: 1_790_000_000_000,
    equityCenti: '512345678', playerBalancesCenti: '1200000', openLiabilityCenti: '345600',
    limitUsage: { global: 0.41, maxColumn: 0.7, maxCell: 0.93 },
    registeredPlayers: 7412, activePlayers5m: 811,
    launch: launchFixture(),
    breakers: [{ id: 'feedStale', market: 'ETH/USD', state: 'ok', since: 1_789_999_000_000, reason: '' }],
    markets: [{ ...marketFixture('BTC/USD'), spot: 64012.5 }, marketFixture('ETH/USD')],
    handle24hCenti: '98765400', ggr24hCenti: '4321000', rtp24h: 0.9563, betsPerMin: 412,
  };
}

export function chainFixture(overrides: { vault?: Partial<ChainState['vault']>; lastAttestation?: ChainState['lastAttestation']; operatorTokenCenti?: string } = {}): ChainState {
  return {
    network: 'base-sepolia', chainId: 84532,
    vault: {
      address: VAULT, token: TOKEN, paused: false, assetsCenti: '100000000', houseFundedCenti: '80000000', totalPlayerDepositsCenti: '25000000',
      totalPlayerWithdrawalsCenti: '5000000', houseWithdrawnCenti: '0', surplusCenti: '60000000', maxAttestationAgeSec: 3600, ...overrides.vault,
    },
    lastAttestation: overrides.lastAttestation === undefined ? { seq: 12, asOfMs: 1_790_000_000_000 - 600_000, liabilitiesCenti: '40000000', ledgerRoot: `0x${'ab'.repeat(32)}` } : overrides.lastAttestation,
    operator: { address: OPERATOR, ethWei: '500000000000000000', tokenCenti: overrides.operatorTokenCenti ?? '900000000' },
    pendingVouchers: { count: 2, totalCenti: '15000' },
    indexer: { lagBlocks: 1 },
  };
}

export function playerFixture(overrides: Partial<PlayerRow> = {}): PlayerRow {
  return { account: 'player:0x4444444444444444444444444444444444444444', kind: 'onchain', balanceCenti: '12000', handleCenti: '50000', pnlCenti: '-2300', bets: 40, rtp: 0.954, flagged: false, blocked: false, firstSeenMs: 1_789_990_000_000, ...overrides };
}
