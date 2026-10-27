import { formatOpen } from './presentation.js';

/** A wallet the page can connect (EIP-6963 announcement or the injected fallback). */
export interface LiveProviderOption { readonly id: string; readonly name: string; readonly icon?: string | undefined }
export interface LiveTx { readonly label: string; readonly hash: string; readonly url: string | null }
export type LiveFlowStatus = 'idle' | 'working' | 'done' | 'failed';
/** A deposit or withdrawal in progress: one line of status plus the transactions it produced. */
export interface LiveFlow { readonly status: LiveFlowStatus; readonly step: string; readonly message?: string | undefined; readonly txs: readonly LiveTx[] }
export interface LiveVoucherRow {
  readonly voucherId: string;
  readonly amountCenti: string;
  /** Server status (pending, claimed, cancelled, expired) refined by the client (sent, expired on chain). */
  readonly label: string;
  readonly expiryMs: number;
  readonly canSend: boolean;
  readonly txUrl?: string | null | undefined;
  readonly note?: string | undefined;
}
export interface LivePromoView {
  readonly tierLabel: string;
  /** e.g. "Win at least 25% on every square". */
  readonly minWinText: string;
  readonly progressText: string | null;
  readonly progressFraction: number | null;
  readonly boostText: string | null;
}
export interface LiveShellState {
  readonly chain: { readonly name: string; readonly chainId: number; readonly walletSupported: boolean } | null;
  readonly wallet: {
    readonly status: 'unavailable' | 'disconnected' | 'connecting' | 'connected';
    readonly providers: readonly LiveProviderOption[];
    readonly providerName?: string | undefined;
    readonly address?: string | undefined;
    readonly addressUrl?: string | null | undefined;
    readonly wrongChain?: boolean | undefined;
    /** tOPEN in the wallet (Centi, floored) and ETH for gas (wei); null while unknown. */
    readonly tokenCenti?: string | null | undefined;
    readonly ethWei?: string | null | undefined;
    readonly error?: string | undefined;
  };
  readonly session: { readonly status: 'signed-out' | 'signing' | 'signed-in'; readonly account?: string | undefined; readonly error?: string | undefined };
  /** In-game balance (Centi); null when signed out. */
  readonly balance: { readonly totalCenti: string | null; readonly availableCenti: string | null };
  readonly deposit: LiveFlow;
  readonly withdraw: LiveFlow & { readonly vouchers: readonly LiveVoucherRow[] };
  readonly promo: LivePromoView | null;
}
export interface LiveShellActions {
  connect(providerId: string): void;
  switchChain(): void;
  signIn(): void;
  signOut(): void;
  disconnect(): void;
  deposit(amountText: string): void;
  withdraw(amountText: string): void;
  sendVoucher(voucherId: string): void;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ethText = (wei: string) => { const w = BigInt(wei); const milli = w / 10n ** 15n; return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')} ETH`; };
const TESTNET_NOTE = 'TESTNET · tOPEN is a test mock of $OPEN and has no value.';

/**
 * Live ($OPEN testnet) chrome around the board: account chip, TESTNET flag, promo banner and the account, deposit
 * and withdraw dialogs. Presentation only: it renders the state it is given and reports intents to the host.
 */
export class LiveShell {
  private readonly root: HTMLElement;
  private readonly chip: HTMLButtonElement;
  private readonly phoneConnect: HTMLButtonElement;
  private readonly flag: HTMLDivElement;
  private readonly promo: HTMLDivElement;
  readonly account: HTMLDialogElement;
  readonly depositDialog: HTMLDialogElement;
  readonly withdrawDialog: HTMLDialogElement;
  private state?: LiveShellState;
  private readonly cleanup: (() => void)[] = [];

  constructor(game: { readonly root: HTMLElement }, private readonly actions: LiveShellActions) {
    this.root = game.root;
    this.root.dataset.live = 'true';
    this.chip = document.createElement('button');
    this.chip.className = 'live-account-chip';
    this.chip.dataset.live = 'open-account';
    this.chip.setAttribute('aria-haspopup', 'dialog');
    this.chip.setAttribute('aria-controls', 'maya-account');
    this.chip.textContent = 'Connect wallet';
    this.root.querySelector('.header-actions')!.prepend(this.chip);
    this.phoneConnect = document.createElement('button');
    this.phoneConnect.className = 'live-phone-connect';
    this.phoneConnect.dataset.live = 'open-account';
    this.phoneConnect.setAttribute('aria-haspopup', 'dialog');
    this.phoneConnect.setAttribute('aria-controls', 'maya-account');
    this.phoneConnect.textContent = 'Connect';
    this.root.querySelector('.phone-account')?.prepend(this.phoneConnect);
    this.flag = document.createElement('div');
    this.flag.className = 'live-flag';
    this.flag.textContent = 'TESTNET';
    this.flag.title = TESTNET_NOTE;
    this.root.append(this.flag);
    this.promo = document.createElement('div');
    this.promo.className = 'live-promo';
    this.promo.hidden = true;
    // Not a live region: the boost counter changes after every bet and would interrupt screen readers.
    this.promo.setAttribute('role', 'note');
    this.promo.setAttribute('aria-label', 'Promotion');
    const header = this.root.querySelector('.header')!;
    header.insertBefore(this.promo, header.querySelector('.wordmark'));

    this.account = this.dialog('maya-account', 'Wallet and account', `<div class="live-note">${TESTNET_NOTE}</div><div class="live-account-body"></div>`);
    this.depositDialog = this.dialog('maya-deposit', 'Deposit tOPEN', `<div class="live-note">${TESTNET_NOTE}</div>
      <p class="live-help">Move tOPEN from your wallet into the Maya house vault. Your wallet asks you to approve the vault first (only when its allowance is short), then to deposit. Your in-game balance updates once the house has seen the deposit on chain.</p>
      <form class="live-form" data-live-form="deposit" novalidate><label for="maya-deposit-amount">Amount (OPEN)</label><div class="live-input-row"><input id="maya-deposit-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="100.00" aria-describedby="maya-deposit-hint"><button type="button" class="live-max" data-live="deposit-max">Max</button></div>
      <p class="live-hint" id="maya-deposit-hint"></p><button type="submit" class="live-primary" data-live="deposit-submit">Deposit</button></form>
      <div class="live-flow" role="status" aria-live="polite"></div>`);
    this.withdrawDialog = this.dialog('maya-withdraw', 'Withdraw OPEN', `<div class="live-note">${TESTNET_NOTE}</div>
      <p class="live-help">The house signs a withdrawal voucher for your account, then your wallet sends it to the vault, which pays out tOPEN. A voucher is valid for one hour; an unsent expired voucher returns to your balance after the house confirms it on chain.</p>
      <form class="live-form" data-live-form="withdraw" novalidate><label for="maya-withdraw-amount">Amount (OPEN)</label><div class="live-input-row"><input id="maya-withdraw-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="50.00" aria-describedby="maya-withdraw-hint"><button type="button" class="live-max" data-live="withdraw-max">Max</button></div>
      <p class="live-hint" id="maya-withdraw-hint"></p><button type="submit" class="live-primary" data-live="withdraw-submit">Request withdrawal</button></form>
      <div class="live-flow" role="status" aria-live="polite"></div><h3 class="live-subtitle">Your withdrawals</h3><ul class="live-vouchers"></ul>`);

    const onClick = (event: Event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-live]');
      if (!target || !this.root.contains(target)) return;
      const action = target.dataset.live!;
      if (action === 'open-account') this.openAccount();
      else if (action === 'close') target.closest('dialog')?.close();
      else if (action === 'connect') this.actions.connect(target.dataset.provider ?? '');
      else if (action === 'switch-chain') this.actions.switchChain();
      else if (action === 'sign-in') this.actions.signIn();
      else if (action === 'sign-out') this.actions.signOut();
      else if (action === 'disconnect') this.actions.disconnect();
      else if (action === 'open-deposit') { this.account.close(); this.openDeposit(); }
      else if (action === 'open-withdraw') { this.account.close(); this.openWithdraw(); }
      else if (action === 'deposit-max') this.fillMax('deposit');
      else if (action === 'withdraw-max') this.fillMax('withdraw');
      else if (action === 'send-voucher') this.actions.sendVoucher(target.dataset.voucher ?? '');
    };
    const onSubmit = (event: Event) => {
      const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-live-form]');
      if (!form) return;
      event.preventDefault();
      const amount = (form.querySelector('input[name=amount]') as HTMLInputElement).value.trim();
      if (form.dataset.liveForm === 'deposit') this.actions.deposit(amount); else this.actions.withdraw(amount);
    };
    this.root.addEventListener('click', onClick);
    this.root.addEventListener('submit', onSubmit);
    this.cleanup.push(() => this.root.removeEventListener('click', onClick), () => this.root.removeEventListener('submit', onSubmit));
  }

  private dialog(id: string, title: string, body: string): HTMLDialogElement {
    const d = document.createElement('dialog');
    d.id = id;
    d.className = 'live-dialog';
    d.setAttribute('aria-labelledby', `${id}-title`);
    d.innerHTML = `<button class="live-dialog-close" data-live="close" aria-label="Close ${title.toLowerCase()}">×</button><h2 id="${id}-title">${title}</h2>${body}`;
    d.addEventListener('click', event => {
      const rect = d.getBoundingClientRect(), e = event as MouseEvent;
      if (event.target === d && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)) d.close();
    });
    this.root.append(d);
    return d;
  }

  /** True while any live dialog is open (the board must not take taps). */
  isBlocking(): boolean { return this.account.open || this.depositDialog.open || this.withdrawDialog.open; }
  openAccount(): void { this.closeAll(); this.account.showModal(); this.chip.setAttribute('aria-expanded', 'true'); this.account.addEventListener('close', () => this.chip.setAttribute('aria-expanded', 'false'), { once: true }); }
  openDeposit(): void { this.closeAll(); this.depositDialog.showModal(); this.depositDialog.querySelector<HTMLInputElement>('input')!.focus(); }
  openWithdraw(): void { this.closeAll(); this.withdrawDialog.showModal(); this.withdrawDialog.querySelector<HTMLInputElement>('input')!.focus(); }
  private closeAll(): void { for (const d of [this.account, this.depositDialog, this.withdrawDialog]) if (d.open) d.close(); }

  private fillMax(kind: 'deposit' | 'withdraw'): void {
    const s = this.state;
    const centi = kind === 'deposit' ? s?.wallet.tokenCenti : s?.balance.availableCenti;
    if (!centi) return;
    const input = (kind === 'deposit' ? this.depositDialog : this.withdrawDialog).querySelector<HTMLInputElement>('input')!;
    const v = BigInt(centi);
    input.value = `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
    input.focus();
  }

  update(state: LiveShellState): void {
    this.state = state;
    const { wallet, session, chain } = state;
    const signedIn = session.status === 'signed-in' && !!session.account;
    // Header chip and phone connect button.
    const chipText = !chain?.walletSupported ? 'Offline vault' : signedIn ? short(session.account!) : wallet.status === 'connected' ? (wallet.wrongChain ? 'Switch network' : 'Sign in') : wallet.status === 'connecting' ? 'Connecting…' : 'Connect wallet';
    if (this.chip.textContent !== chipText) this.chip.textContent = chipText;
    this.chip.dataset.state = signedIn ? 'signed-in' : wallet.status;
    this.chip.setAttribute('aria-label', signedIn ? `Signed in as ${session.account}. Open wallet and account` : `${chipText}. Open wallet and account`);
    this.phoneConnect.hidden = signedIn;
    this.phoneConnect.textContent = wallet.status === 'connected' && !wallet.wrongChain ? 'Sign in' : 'Connect';
    this.root.dataset.liveSession = signedIn ? 'signed-in' : 'signed-out';
    // TESTNET flag (phone shows it; desktop has it in the wordmark) and promo.
    const flagText = state.promo ? `TESTNET · ${state.promo.tierLabel}` : 'TESTNET';
    if (this.flag.textContent !== flagText) this.flag.textContent = flagText;
    this.renderPromo(state.promo);
    this.renderAccount(state);
    this.renderFlow(this.depositDialog, state.deposit);
    this.renderFlow(this.withdrawDialog, state.withdraw);
    this.renderVouchers(state.withdraw.vouchers);
    const depHint = this.depositDialog.querySelector('.live-hint')!;
    const depText = !signedIn ? 'Sign in first.' : wallet.tokenCenti != null ? `Wallet: ${formatOpen(wallet.tokenCenti)} (tOPEN)` : 'Reading your wallet balance…';
    if (depHint.textContent !== depText) depHint.textContent = depText;
    const wdHint = this.withdrawDialog.querySelector('.live-hint')!;
    const wdText = !signedIn ? 'Sign in first.' : state.balance.availableCenti != null ? `Available: ${formatOpen(state.balance.availableCenti)}` : 'Reading your balance…';
    if (wdHint.textContent !== wdText) wdHint.textContent = wdText;
    const busy = (f: LiveFlow) => f.status === 'working';
    this.depositDialog.querySelector<HTMLButtonElement>('[data-live=deposit-submit]')!.disabled = !signedIn || busy(state.deposit) || !!wallet.wrongChain;
    this.withdrawDialog.querySelector<HTMLButtonElement>('[data-live=withdraw-submit]')!.disabled = !signedIn || busy(state.withdraw);
  }

  private renderPromo(p: LivePromoView | null): void {
    this.promo.hidden = !p;
    if (!p) return;
    const key = JSON.stringify(p);
    if (this.promo.dataset.key === key) return;
    this.promo.dataset.key = key;
    const pct = p.progressFraction === null ? null : Math.max(0, Math.min(100, Math.round(p.progressFraction * 100)));
    this.promo.innerHTML = `<span class="live-promo-tier">${esc(p.tierLabel)}</span><span class="live-promo-win">${esc(p.minWinText)}</span>${p.progressText ? `<span class="live-promo-progress">${pct !== null ? `<i style="--p:${pct}%" aria-hidden="true"></i>` : ''}${esc(p.progressText)}</span>` : ''}${p.boostText ? `<span class="live-promo-boost">${esc(p.boostText)}</span>` : ''}`;
  }

  private renderAccount(s: LiveShellState): void {
    const { wallet, session, chain, balance } = s;
    // Rendered as small independent parts, so a polled figure (a balance) never replaces a button the player is pressing.
    const parts: [string, string][] = [];
    if (!chain) parts.push(['status', '<p class="live-help">Reading the house configuration…</p>']);
    else if (!chain.walletSupported) parts.push(['status', '<p class="live-help">This house runs an offline test vault, so no wallet can connect. Deposits and withdrawals need a house on anvil or Base Sepolia.</p>']);
    else {
      let info = `<h3 id="maya-acct-wallet">Wallet · ${esc(chain.name)}</h3>`, actions = '';
      if (wallet.status === 'connected' && wallet.address) {
        info += `<p class="live-address" title="${esc(wallet.address)}">${esc(wallet.providerName ?? 'Wallet')} · ${wallet.addressUrl ? `<a href="${esc(wallet.addressUrl)}" target="_blank" rel="noopener noreferrer">${esc(short(wallet.address))} ↗</a>` : esc(short(wallet.address))}</p>`;
        if (wallet.wrongChain) { info += '<p class="live-warn">Your wallet is on another network.</p>'; actions += `<button class="live-primary" data-live="switch-chain">Switch to ${esc(chain.name)}</button>`; }
        else info += `<dl class="live-balances"><div><dt>tOPEN in wallet</dt><dd>${wallet.tokenCenti != null ? esc(formatOpen(wallet.tokenCenti)) : '…'}</dd></div><div><dt>ETH for gas</dt><dd>${wallet.ethWei != null ? esc(ethText(wallet.ethWei)) : '…'}</dd></div></dl>${wallet.ethWei === '0' ? '<p class="live-warn">You need a little test ETH for gas before you can deposit or withdraw.</p>' : ''}`;
        actions += '<button class="live-link" data-live="disconnect">Disconnect wallet</button>';
      } else if (wallet.status === 'connecting') info += '<p class="live-help">Check your wallet to connect…</p>';
      else if (wallet.providers.length) actions += `<div class="live-providers">${wallet.providers.map(p => `<button class="live-provider" data-live="connect" data-provider="${esc(p.id)}">${p.icon && /^data:image\/(svg\+xml|png|webp)[;,]/.test(p.icon) ? `<img src="${esc(p.icon)}" alt="" width="24" height="24">` : ''}<span>Connect ${esc(p.name)}</span></button>`).join('')}</div>`;
      else info += '<p class="live-help">No browser wallet found. Install MetaMask (or another EIP-6963 wallet) and reload this page.</p>';
      if (wallet.error) actions += `<p class="live-error" role="alert">${esc(wallet.error)}</p>`;
      parts.push(['wallet-info', info], ['wallet-actions', actions]);
      let sess = '<h3 id="maya-acct-session">Sign-in</h3>';
      if (session.status === 'signed-in' && session.account) sess += `<p>Signed in as <b title="${esc(session.account)}">${esc(short(session.account))}</b></p><button class="live-secondary" data-live="sign-out">Sign out</button>`;
      else if (session.status === 'signing') sess += '<p class="live-help">Check your wallet: sign the Maya sign-in message (no gas, no transaction).</p>';
      else sess += `<p class="live-help">Sign a message with your wallet to prove you own it. It costs no gas.</p><button class="live-primary" data-live="sign-in" ${wallet.status !== 'connected' || wallet.wrongChain ? 'disabled' : ''}>Sign in with Ethereum</button>`;
      if (session.error) sess += `<p class="live-error" role="alert">${esc(session.error)}</p>`;
      parts.push(['session', sess]);
      parts.push(['balance-values', `<h3 id="maya-acct-balance">In-game balance</h3><dl class="live-balances"><div><dt>Balance</dt><dd>${balance.totalCenti != null ? esc(formatOpen(balance.totalCenti)) : '—'}</dd></div><div><dt>Available</dt><dd>${balance.availableCenti != null ? esc(formatOpen(balance.availableCenti)) : '—'}</dd></div></dl>`]);
      parts.push(['balance-actions', `<div class="live-actions"><button class="live-secondary" data-live="open-deposit" ${session.status !== 'signed-in' ? 'disabled' : ''}>Deposit</button><button class="live-secondary" data-live="open-withdraw" ${session.status !== 'signed-in' ? 'disabled' : ''}>Withdraw</button></div>`]);
    }
    const body = this.account.querySelector<HTMLElement>('.live-account-body')!;
    const layout = parts.map(([k]) => k).join(',');
    if (body.dataset.layout !== layout) {
      body.dataset.layout = layout;
      const section = (label: string, keys: string[]) => `<section class="live-section" aria-labelledby="${label}">${keys.map(k => `<div data-part="${k}"></div>`).join('')}</section>`;
      body.innerHTML = parts.length === 1 ? '<div data-part="status"></div>' : section('maya-acct-wallet', ['wallet-info', 'wallet-actions']) + section('maya-acct-session', ['session']) + section('maya-acct-balance', ['balance-values', 'balance-actions']);
    }
    for (const [key, html] of parts) {
      const el = body.querySelector<HTMLElement>(`[data-part="${key}"]`)!;
      if (el.dataset.html === html) continue;
      // Keep keyboard focus on the same control across a re-render of its part.
      const focused = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement.dataset.live : undefined;
      el.dataset.html = html;
      el.innerHTML = html;
      if (focused) (body.querySelector<HTMLElement>(`[data-live="${focused}"]:not([disabled])`) ?? this.account.querySelector<HTMLElement>('.live-dialog-close'))?.focus();
    }
  }

  private renderFlow(dialog: HTMLDialogElement, f: LiveFlow): void {
    const box = dialog.querySelector<HTMLElement>('.live-flow')!;
    const html = f.status === 'idle' && !f.txs.length ? '' : `<p class="live-step" data-status="${f.status}">${esc(f.step)}</p>${f.message ? `<p class="${f.status === 'failed' ? 'live-error' : 'live-help'}">${esc(f.message)}</p>` : ''}${f.txs.length ? `<ul class="live-txs">${f.txs.map(t => `<li>${esc(t.label)}: ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(short(t.hash))} ↗</a>` : `<code title="${esc(t.hash)}">${esc(short(t.hash))}</code>`}</li>`).join('')}</ul>` : ''}`;
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.innerHTML = html;
  }

  private renderVouchers(rows: readonly LiveVoucherRow[]): void {
    const list = this.withdrawDialog.querySelector<HTMLElement>('.live-vouchers')!;
    const html = rows.length ? rows.map(r => `<li data-voucher-status="${esc(r.label)}"><span class="live-voucher-amount">${esc(formatOpen(r.amountCenti))}</span><span class="live-voucher-status">${esc(r.label)}${r.note ? ` · ${esc(r.note)}` : ''}</span>${r.txUrl ? `<a href="${esc(r.txUrl)}" target="_blank" rel="noopener noreferrer">tx ↗</a>` : ''}${r.canSend ? `<button class="live-secondary" data-live="send-voucher" data-voucher="${esc(r.voucherId)}">Send to wallet</button>` : ''}</li>`).join('') : '<li class="live-help">No withdrawals yet.</li>';
    if (list.dataset.html === html) return;
    list.dataset.html = html;
    list.innerHTML = html;
  }

  dispose(): void { for (const c of this.cleanup) c(); for (const d of [this.account, this.depositDialog, this.withdrawDialog]) d.remove(); this.chip.remove(); this.phoneConnect.remove(); this.flag.remove(); this.promo.remove(); }
}
