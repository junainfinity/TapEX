import { formatCents } from '@maya/contracts';
import { walletIcon, type GamePresentation } from '../presentation.js';

/** Live stake menu in Centi (0.01 OPEN): 1, 5, 10, 25 and 100 OPEN. The house's minimum stake is 0.10 OPEN. */
export const LIVE_STAKES_CENTI = Object.freeze(['100', '500', '1000', '2500', '10000']);
export const LIVE_INITIAL_STAKE_CENTI = '100';

/** Exact OPEN amount from Centi, e.g. `1,234.56 OPEN`. */
export function formatOpen(centi: string): string { return `${formatCents(centi, '')} OPEN`; }
/** Short OPEN label without trailing zero decimals, e.g. `1 OPEN`, `2.5 OPEN`. */
export function formatOpenShort(centi: string): string { return `${formatCents(centi, '').replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} OPEN`; }

const help = '<p><strong>Choose where. Choose when.</strong><br>Each square is a price band over five seconds. Tap it to stake OPEN from your in-game balance.</p>'
  + "<p>If the house's recorded first-seen price line touches your square during its five seconds, you win its multiplier: your total return, including the stake. The chart draws exactly that recorded path, and the odds come from the house.</p>"
  + '<p>The house confirms each tap at the next price second. If the price moved too far, the tap is refused and nothing is charged. Missing price data refunds the play.</p>'
  + '<p><strong>TESTNET.</strong> tOPEN is a test mock of $OPEN and has no value.</p>';

/** The $OPEN testnet game: OPEN amounts, no play limit, deposit/withdraw instead of paper funds. */
export function livePresentation(): GamePresentation {
  return Object.freeze({
    mode: 'live',
    stakes: LIVE_STAKES_CENTI,
    initialStake: LIVE_INITIAL_STAKE_CENTI,
    playLimit: null,
    formatMoney: formatOpen,
    formatStake: formatOpenShort,
    wordmarkTag: 'TESTNET',
    walletButtonLabel: 'Wallet and account',
    walletButtonControls: 'maya-account',
    boardHint: '<strong>Pick a square. Catch the price.</strong> Win its displayed return in OPEN.',
    emptyText: 'Getting the house price path and odds ready.',
    walletGroupHtml: `<div class="pill wallet">${walletIcon}<span class="balance">0.00 OPEN</span></div><button class="subtle-button" data-action="refill" aria-label="Deposit tOPEN into the game">Deposit</button><button class="subtle-button" data-action="withdraw" aria-label="Withdraw OPEN to your wallet">Withdraw</button>`,
    helpHtml: help,
    phone: Object.freeze({
      balanceSmall: 'IN-GAME OPEN',
      balanceAria: 'In-game balance, deposit and withdraw',
      balanceTitle: 'In-game balance',
      balanceBodyHtml: '<p class="phone-tip">TESTNET · tOPEN is a test mock of $OPEN and has no value.</p><div class="phone-live-funds"><button data-action="refill">Deposit</button><button data-action="withdraw">Withdraw</button></div><button class="phone-full" data-action="wallet">Wallet and account</button>',
      menuFundsLabel: 'Balance',
      walletMenuLabel: 'Wallet',
      helpHtml: help,
    }),
  });
}
