import { DEMO_CONFIG } from '@maya/config';
import { formatCents } from '@maya/contracts';

export const walletIcon = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2" y="5" width="16" height="12" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M3 5V4a2 2 0 0 1 2-2h10v3M13 9h5v4h-5z" stroke="currentColor" stroke-width="1.5"/></svg>';
export const menuIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
export const zoomIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8m-4-4v8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
export const historyIcon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true"><path d="M4 5v5h5M4 10a8 8 0 1 1 1 7M12 7v5l3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Everything the board shows that differs between the paper demo and the live ($OPEN testnet) game. Amounts are
 * integer strings in the game's minor unit: US cents in paper, Centi (0.01 OPEN) live. Presentation only: the
 * injected acceptance port still owns every financial decision.
 */
export interface GamePresentation {
  readonly mode: 'paper' | 'live';
  /** Stake menu (minor units), ascending. */
  readonly stakes: readonly string[];
  readonly initialStake: string;
  /** Accepted plays per page before the board locks (paper: 10); null = no limit. */
  readonly playLimit: number | null;
  /** Exact money label, e.g. `$1,000.00` or `1,000.00 OPEN`. */
  readonly formatMoney: (minor: string) => string;
  /** Short stake label on the desktop stake control, e.g. `$1` or `1 OPEN`. */
  readonly formatStake: (minor: string) => string;
  readonly wordmarkTag: string;
  readonly walletButtonLabel: string;
  /** Dialog the wallet button opens (paper: the integrations dialog). */
  readonly walletButtonControls: string;
  readonly boardHint: string;
  readonly emptyText: string;
  /** Contents of `.wallet-group` in the desktop/tablet bottom bar. */
  readonly walletGroupHtml: string;
  readonly helpHtml: string;
  readonly phone: {
    readonly balanceSmall: string;
    readonly balanceAria: string;
    readonly balanceTitle: string;
    /** Balance panel body after its heading (tip and actions). */
    readonly balanceBodyHtml: string;
    readonly menuFundsLabel: string;
    readonly walletMenuLabel: string;
    readonly helpHtml: string;
  };
}

const paperStake = (value: string) => '$' + Number(value) / 100;

/** The paper demo exactly as it was before Stage B (tests/presentation.test.ts pins every string). */
export const PAPER_PRESENTATION: GamePresentation = Object.freeze({
  mode: 'paper',
  stakes: DEMO_CONFIG.stakeMenuCents,
  initialStake: DEMO_CONFIG.initialStakeCents,
  playLimit: DEMO_CONFIG.maxNewBetsPerPage,
  formatMoney: (value: string) => formatCents(value),
  formatStake: paperStake,
  wordmarkTag: 'PAPER PLAY',
  walletButtonLabel: 'Crypto wallet integrations',
  walletButtonControls: 'wallet-integrations',
  boardHint: '<strong>Pick a square. Catch the price.</strong> Win its displayed return.',
  emptyText: 'Getting live prices and simulated odds ready.',
  walletGroupHtml: `<div class="pill wallet">${walletIcon}<span class="balance">$1,000.00</span></div><button class="subtle-button" data-action="refill" aria-label="Add one thousand paper dollars">+ Paper funds</button><span class="allowance"><b>10</b> plays left</span>`,
  helpHtml: '<p><strong>Choose where. Choose when.</strong><br>Each square is a price band over five seconds. Tap it to place your selected paper stake.</p><p>If the recorded price line touches your square during its five seconds, you win. Each incoming price is pinned for this paper game, so the line and result use the same path. Its multiplier is your total return, including the stake.</p><p>All funds and odds are simulated. Refresh starts a new session with $1,000 and ten plays. Bets from the previous session do not carry over. Missing price data refunds the affected play.</p>',
  phone: Object.freeze({
    balanceSmall: 'PAPER BALANCE',
    balanceAria: 'Paper balance and funds',
    balanceTitle: 'Paper balance',
    balanceBodyHtml: '<p class="phone-tip">Refresh starts a new $1,000 session with ten plays.</p><button class="phone-full" data-action="refill">+ Paper funds</button>',
    menuFundsLabel: 'Paper funds',
    walletMenuLabel: 'Wallet ↗',
    helpHtml: '<p>Choose a stake, then tap a future square. Each square covers a price band over five seconds. If the recorded price line touches it in that window, you win the displayed total return, including your stake.</p><p>Each additional tap adds the selected stake. Pinch with two fingers to zoom; drag with one finger to explore. All funds and odds are simulated.</p>',
  }),
});

/** `.maya` root markup. */
export function rootMarkup(p: GamePresentation): string {
  return `<div class="scene" aria-label="Price and time prediction board"><div class="history-shade"></div><div class="offers"></div><div class="positions"></div><div class="axes"></div></div>
      <header class="header"><div class="pair-pill"><span class="coin-symbol" aria-hidden="true">₿</span><select aria-label="Trading pair"><option value="btc-usd">BTC / USD</option><option value="eth-usd">ETH / USD</option></select><span class="pair-price">—</span></div><div class="wordmark">MAYA <span>${p.wordmarkTag}</span><div class="header-actions"><button class="help-button" aria-label="How to play" aria-expanded="false">?</button><button class="wallet-button" data-action="wallet" aria-label="${p.walletButtonLabel}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${p.walletButtonControls}">${walletIcon}</button></div></div></header>
      <div class="status-line" data-state="loading"><span class="status-dot"></span><span class="connection-text">Connecting to live prices</span></div>
      <div class="board-hint">${p.boardHint}</div>
      <div class="empty-state"><b>Connecting to the market</b><span>${p.emptyText}</span></div>
      <div class="results-panel" aria-label="Recent results"><div class="results-title">YOUR RECENT PLAYS<button class="results-close" data-action="results-close" aria-label="Close recent results">×</button></div><div class="result-items"></div></div>
      <div class="navigation-row"><button data-action="live" aria-label="Back to live chart">↗ Back to live</button><button data-action="next" aria-label="Focus next available square">Next square →</button><button data-action="results" aria-label="View recent results">Results</button></div>
      <footer class="bottom-bar"><div class="wallet-group">${p.walletGroupHtml}</div>
      <div class="right-controls"><div class="zoom-group" aria-label="Chart zoom"><button class="circle small" data-action="zoom-out" aria-label="Zoom out">−</button><span class="zoom-readout">0.60</span><button class="circle small" data-action="zoom-in" aria-label="Zoom in">+</button></div><div class="stake-group" aria-label="Stake controls"><button class="stake-edge" data-action="min" aria-label="Minimum stake">MIN</button><button class="step" data-action="lower" aria-label="Lower stake">−</button><div class="stake-value" aria-live="polite"><small>STAKE</small><b>${p.formatStake(p.initialStake)}</b></div><button class="step" data-action="raise" aria-label="Raise stake">+</button><button class="stake-edge" data-action="max" aria-label="Maximum stake">MAX</button></div></div></footer>
      <div class="toast-stack" aria-live="polite"></div><div class="screen-reader" role="status" aria-live="polite"></div><div class="overlay-host"></div>
      <dialog class="wallet-dialog" id="wallet-integrations" aria-labelledby="wallet-title" aria-describedby="wallet-description"><button class="wallet-dialog-close" data-action="wallet-close" aria-label="Close wallet integrations">×</button><div class="wallet-dialog-icon">${walletIcon}</div><div class="wallet-eyebrow">CUSTOM INTEGRATIONS</div><h2 id="wallet-title">Your chain. Your wallet.</h2><p id="wallet-description">For support for any crypto chain or wallet, contact us to discuss your Maya integration.</p><a class="wallet-contact" href="${DEMO_CONFIG.consultationUrl}" target="_blank" rel="noopener noreferrer">Contact us <span aria-hidden="true">↗</span></a></dialog>`;
}

/** Phone header account button markup. */
export function phoneAccountMarkup(p: GamePresentation): string {
  return `<button data-action="phone-balance" aria-label="${p.phone.balanceAria}" aria-haspopup="dialog" aria-controls="phone-controls"><small>${p.phone.balanceSmall}</small><b class="phone-balance">${p.mode === 'paper' ? '$1,000.00' : '—'}</b></button><button class="phone-history" data-action="results" aria-label="View recent results">${historyIcon}</button>`;
}

/** Phone thumb bar markup. */
export function phoneBarMarkup(p: GamePresentation): string {
  return `<button data-action="phone-menu" aria-label="Open game controls" aria-haspopup="dialog" aria-controls="phone-controls" aria-expanded="false">${menuIcon}</button><button data-action="lower" aria-label="Lower stake">−</button><button class="phone-stake" data-action="phone-stake" aria-label="Choose stake" aria-haspopup="dialog" aria-controls="phone-controls" aria-expanded="false"><small>STAKE PER TAP</small><b data-phone-stake>${p.formatMoney(p.initialStake)}</b></button><button data-action="raise" aria-label="Raise stake">+</button><button class="phone-zoom" data-action="phone-zoom" aria-label="Adjust chart zoom" aria-haspopup="dialog" aria-controls="phone-controls" aria-expanded="false">${zoomIcon}<span data-phone-zoom>0.6×</span></button>`;
}

/** Phone controls dialog markup. */
export function phoneDialogMarkup(p: GamePresentation): string {
  const limit = p.playLimit;
  return `<div class="phone-dialog-heading"><h2 id="phone-controls-title">Game controls</h2><button data-action="phone-close" aria-label="Close game controls">×</button></div>
      <section data-phone-section="stake"><div class="phone-section-heading"><span>Stake per tap</span><b data-phone-stake>${p.formatMoney(p.initialStake)}</b></div><div class="phone-presets">${p.stakes.map((value,index)=>`<button data-action="set-stake" data-stake-index="${index}" aria-pressed="${value===p.initialStake}">${p.formatMoney(value)}</button>`).join('')}</div><div class="phone-stake-steps"><button data-action="min" aria-label="Minimum stake">MIN</button><button data-action="lower" aria-label="Lower stake">−</button><button data-action="raise" aria-label="Raise stake">+</button><button data-action="max" aria-label="Maximum stake">MAX</button></div></section>
      <section data-phone-section="zoom"><div class="phone-zoom-steps"><span>Chart zoom</span><button data-action="zoom-out" aria-label="Zoom out">−</button><output data-phone-zoom>0.6×</output><button data-action="zoom-in" aria-label="Zoom in">+</button></div><p class="phone-tip">Pinch the chart to zoom · 0.345×–0.9×</p></section>
      <section data-phone-section="balance"><div class="phone-section-heading"><span>${p.phone.balanceTitle}</span><b class="phone-balance">${p.mode === 'paper' ? '$1,000.00' : '—'}</b></div>${p.phone.balanceBodyHtml}</section>
      <section class="phone-menu-actions" data-phone-section="menu"><button data-action="live">↗ Back to live</button><button data-action="next">Next square →</button><button data-action="results">Recent plays</button><button data-action="phone-balance">${p.phone.menuFundsLabel}</button><button data-action="phone-help">? Help</button><button data-action="wallet">${p.phone.walletMenuLabel}</button>${limit === null ? '' : `<button class="phone-full" data-action="reload" data-phone-reload hidden>Refresh · ${limit} more plays</button>`}</section>
      <section data-phone-section="help">${p.phone.helpHtml}</section>
      <button class="phone-full phone-done" data-action="phone-close">Back to chart</button>`;
}
