import { createCell, multiplyDecimalInteger, OBSERVED_PATH_RULE_VERSION, parseDecimal, type MarketId, type PositionSnapshot } from '@maya/contracts';
import { getMarket } from '@maya/config';
import { MayaGame } from '@maya/game-ui';
import { formatOpen, livePresentation, LiveShell, type LiveFlow, type LivePromoView, type LiveShellState, type LiveTx, type LiveVoucherRow } from '@maya/game-ui/live';
import { createSiweMessage } from 'viem/siwe';
import type { Hex } from 'viem';
import { centiToWei, parseOpenAmount, weiToCentiFloor } from './live/amounts.js';
import { HouseApi, HouseError, type AccountResponse, type ChainConfig, type LegJson, type PromoResponse, type VoucherJson } from './live/house-api.js';
import { HouseMarketFeed } from './live/market-feed.js';
import { PlacementBook, rejectionCaption, type PlacementOutcome } from './live/placement.js';
import { ConnectedWallet, WalletDiscovery, walletErrorMessage } from './live/wallet.js';

/**
 * Maya-Live (VITE_MAYA_MODE=live): the tap-trading board against the $OPEN house on testnet. The chart is the house's
 * pinned first-seen path and every square is a house quote; bets, balances and settlements come from the house.
 * Wallets connect through EIP-6963 (MetaMask first), sign in with SIWE, and move tOPEN in and out of the vault.
 */
declare const __MAYA_TEST_WALLET__: boolean;

const api = new HouseApi('');
const discovery = new WalletDiscovery();
const WALLET_KEY = 'maya-live.wallet';
let chainConfig: ChainConfig | undefined;
let startupError = '';
let selected: MarketId = 'btc-usd';
const feed = new HouseMarketFeed(api, selected);

let wallet: ConnectedWallet | undefined;
let walletStatus: 'disconnected' | 'connecting' | 'connected' = 'disconnected';
let walletError: string | undefined;
let wrongChain = false;
let tokenCenti: string | null = null;
let ethWei: string | null = null;
let chainNowS: bigint | undefined;
let detachWallet: (() => void) | undefined;
let triedSilentReconnect = false;

let session: { status: 'signed-out' | 'signing' | 'signed-in'; account?: string | undefined; error?: string | undefined } = { status: 'signed-out' };
let account: AccountResponse | undefined;
let positions: PositionSnapshot[] = [];
let promo: PromoResponse | null = null;
const idle: LiveFlow = { status: 'idle', step: '', txs: [] };
let deposit: LiveFlow = idle;
let withdraw: LiveFlow = idle;
let vouchers: readonly VoucherJson[] = [];
/** Voucher redemptions this page sent (hash, and whether the receipt came back successful). */
const sentVouchers = new Map<string, { hash: Hex; mined: boolean }>();

const signedIn = () => session.status === 'signed-in' && !!session.account;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safeStorage = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del: (k: string) => { try { localStorage.removeItem(k); } catch { /* private mode */ } } };

const placements = new PlacementBook(api, () => feed.nowMs(), outcome => onPlacement(outcome));
placements.subscribe(() => refresh());

const ui = new MayaGame(document.querySelector('#app')!, {
  presentation: livePresentation(),
  makeCell: (marketId, start, bucket) => { const m = getMarket(marketId); return createCell(marketId, start, multiplyDecimalInteger(m.bandHeight, BigInt(bucket)), multiplyDecimalInteger(m.bandHeight, BigInt(bucket + 1)), OBSERVED_PATH_RULE_VERSION); },
  // Only quotes the house issued (by cell id); the browser never computes odds.
  quoteFor: cell => feed.quoteFor(cell.cellId),
  onMarket: market => { selected = market; feed.setMarket(market); refresh(); },
  onBet: (quote, stakeCenti) => {
    if (!signedIn()) { ui.toast(walletStatus === 'connected' ? 'Sign in with your wallet to play.' : 'Connect your wallet and sign in to play.'); shell.openAccount(); return; }
    void placements.place(quote, stakeCenti);
    refresh();
  },
  onRefill: () => shell.openDeposit(),
  onWithdraw: () => shell.openWithdraw(),
  onWallet: () => shell.openAccount(),
  onReload: () => location.reload(),
  inputBlocked: () => shell.isBlocking(),
});
const shell = new LiveShell(ui, {
  connect: id => void connect(id),
  switchChain: () => void switchChain(),
  signIn: () => void signIn(),
  signOut: () => void signOut('You signed out.'),
  disconnect: () => void disconnect(),
  deposit: text => void startDeposit(text),
  withdraw: text => void startWithdraw(text),
  sendVoucher: id => { const v = vouchers.find(x => x.voucherId === id); if (v) void sendVoucherFlow(v); },
});

// ------------------------------------------------------------------ view

function legToPosition(l: LegJson): PositionSnapshot {
  return Object.freeze({
    cellId: l.cellId, marketId: l.market as MarketId, startMs: l.start, endMs: l.end, lowerPrice: parseDecimal(l.lower), upperPrice: parseDecimal(l.upper), ruleVersion: OBSERVED_PATH_RULE_VERSION,
    positionId: l.legId, requestId: l.requestId, pageLoadId: '', quoteId: l.quoteId, stakeCents: l.stakeCenti, grossX100: String(l.x100), grossReturnCents: l.payoutCenti,
    acceptedAtMs: l.placedMs, status: l.status,
    provenance: Object.freeze({ modelId: 'maya-house', configId: 'house', tableId: l.tableId ?? '', policyId: OBSERVED_PATH_RULE_VERSION, sourceSampleId: '' }),
    ...(l.settledMs !== undefined ? { settledAtMs: l.settledMs } : {}), ...(l.touchTimeMs !== undefined ? { touchTimeMs: l.touchTimeMs } : {}),
    ...(l.evidenceSampleIds ? { evidenceSampleIds: l.evidenceSampleIds } : {}), ...(l.settlementReason ? { settlementReason: l.settlementReason } : {}),
  });
}

function promoView(p: PromoResponse | null): LivePromoView | null {
  if (!p) return null;
  const minWin = p.minWinX100 - 100;
  const until = p.progress.untilPlayers;
  return {
    tierLabel: p.label,
    minWinText: minWin > 0 ? `Win at least ${minWin}% on every square` : 'House odds on every square',
    progressText: until ? `${p.progress.players.toLocaleString('en-US')} / ${until.toLocaleString('en-US')} players` : null,
    progressFraction: until ? p.progress.players / until : null,
    boostText: p.account?.boostRemainingCenti && p.account.boostRemainingCenti !== '0' ? `Your boost: ${formatOpen(p.account.boostRemainingCenti)} left` : null,
  };
}

function voucherRows(): LiveVoucherRow[] {
  const now = chainNowS ?? BigInt(Math.floor(Date.now() / 1000));
  return vouchers.slice(0, 8).map(v => {
    const sent = sentVouchers.get(v.voucherId);
    const expired = BigInt(v.expiry) < now;
    const mine = !!wallet?.address && wallet.address.toLowerCase() === v.account.toLowerCase();
    const label = v.status === 'claimed' ? 'Paid out' : v.status === 'cancelled' ? 'Cancelled · returned to balance' : v.status === 'expired' ? 'Expired · returned to balance' : v.status === 'signing' ? 'Being signed by the house'
      : sent?.mined ? 'Sent · waiting for the house to record it' : sent ? 'Sent · waiting for the network' : expired ? 'Expired on chain' : 'Ready to send';
    const note = v.status === 'pending' && expired && !sent ? 'returns to your balance after the house confirms (about 10 minutes after expiry)' : v.status === 'pending' && !expired && !sent ? `valid until ${new Date(Number(v.expiry) * 1000).toLocaleTimeString()}` : undefined;
    const hash = v.txHash ?? sent?.hash;
    return { voucherId: v.voucherId, amountCenti: v.amountCenti, label, expiryMs: v.expiryMs, canSend: v.status === 'pending' && !!v.signature && !expired && !sent && mine && !wrongChain && withdraw.status !== 'working', ...(hash && wallet ? { txUrl: wallet.explorerTx(hash) } : {}), ...(note ? { note } : {}) };
  });
}

function shellState(): LiveShellState {
  return {
    chain: chainConfig ? { name: chainConfig.chainName, chainId: chainConfig.chainId, walletSupported: chainConfig.walletSupported } : null,
    wallet: {
      status: chainConfig && !chainConfig.walletSupported ? 'unavailable' : walletStatus,
      providers: discovery.list().map(e => ({ id: e.id, name: e.name, ...(e.icon ? { icon: e.icon } : {}) })),
      ...(wallet?.address ? { address: wallet.address, addressUrl: wallet.explorerAddress(wallet.address), providerName: wallet.entry.name } : {}),
      wrongChain, tokenCenti, ethWei, ...(walletError ? { error: walletError } : {}),
    },
    session,
    balance: { totalCenti: signedIn() ? account?.balanceCenti ?? null : null, availableCenti: signedIn() ? account?.availableCenti ?? account?.balanceCenti ?? null : null },
    deposit, withdraw: { ...withdraw, vouchers: voucherRows() }, promo: promoView(promo),
  };
}

function refresh(): void {
  const health = feed.health();
  const samples = feed.getSamples(selected);
  const ready = !startupError && health.status === 'ready' && samples.length >= 2 && feed.clockReady;
  const who = signedIn() ? '' : walletStatus === 'connected' ? ' · Sign in to play' : ' · Connect a wallet to play';
  const message = startupError || `TESTNET · ${health.message}${who}`;
  ui.update({
    marketId: selected, pathMode: 'linear', samples, positions, balanceCents: signedIn() ? account?.availableCenti ?? account?.balanceCenti ?? '0' : '0', acceptedCount: 0,
    health: health.status, healthMessage: message, ready, nowMs: feed.nowMs(), maxHealthySourceAgeS: 7, leadTimeS: feed.minLeadS, pending: placements.pending(),
  });
  shell.update(shellState());
}

// ------------------------------------------------------------------ placements

function onPlacement(o: PlacementOutcome): void {
  if (o.kind === 'accepted') { void pollAccount(); }
  else if (o.kind === 'rejected') { ui.toast(o.message); ui.rejectAt(o.quote, rejectionCaption(o.reason)); if (o.reason === 'INSUFFICIENT_BALANCE') void pollAccount(); }
  else if (o.kind === 'auth') { void signOut('Your session ended — sign in again to play.', false); }
  else ui.toast(o.message);
  refresh();
}

// ------------------------------------------------------------------ account data

let accountBusy = false;
async function pollAccount(): Promise<void> {
  if (!signedIn() || accountBusy) return;
  accountBusy = true;
  const who = session.account!;
  try {
    const a = await api.account(who);
    if (session.account !== who) return;
    account = a;
    positions = a.recentLegs.map(legToPosition);
  } catch (error) {
    if (error instanceof HouseError && error.status === 401) await signOut('Your session ended — sign in again to play.', false);
  } finally { accountBusy = false; refresh(); }
}
async function loadVouchers(): Promise<void> {
  if (!signedIn()) { vouchers = []; return; }
  try { vouchers = (await api.withdrawals()).rows; } catch { /* keep the last list */ }
  refresh();
}
async function loadPromo(): Promise<void> {
  try { promo = await api.promo(); } catch (error) { if (error instanceof HouseError && error.status === 404) promo = null; }
  refresh();
}
async function refreshBalances(): Promise<void> {
  if (!wallet?.address || walletStatus !== 'connected') return;
  try {
    wrongChain = !(await wallet.onRightChain());
    if (wrongChain) { tokenCenti = null; ethWei = null; return; }
    const [token, eth, now] = await Promise.all([wallet.tokenBalance(), wallet.ethBalance(), wallet.chainTimeS()]);
    tokenCenti = weiToCentiFloor(token); ethWei = eth.toString(); chainNowS = now;
  } catch { /* transient RPC failure: keep the last figures */ }
  finally { refresh(); }
}

// ------------------------------------------------------------------ wallet and session

function attach(w: ConnectedWallet): void {
  detachWallet?.();
  const p = w.entry.provider;
  const onAccounts = (accounts: unknown) => {
    const next = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : undefined;
    if (!next) { void disconnect('Your wallet disconnected.'); return; }
    void w.connect(false).then(() => {
      if (signedIn() && session.account !== next) void signOut(`Wallet account changed to ${short(next)} — sign in again.`);
      void refreshBalances();
    });
  };
  const onChain = () => { void refreshBalances(); };
  p.on?.('accountsChanged', onAccounts);
  p.on?.('chainChanged', onChain);
  detachWallet = () => { p.removeListener?.('accountsChanged', onAccounts); p.removeListener?.('chainChanged', onChain); };
}

async function connect(providerId: string, prompt = true): Promise<void> {
  if (!chainConfig?.walletSupported) return;
  const entry = discovery.get(providerId);
  if (!entry) { walletError = 'That wallet is no longer available. Reload the page.'; refresh(); return; }
  walletStatus = 'connecting'; walletError = undefined; refresh();
  try {
    const w = new ConnectedWallet(entry, chainConfig);
    const address = await w.connect(prompt);
    if (!address) { walletStatus = 'disconnected'; if (prompt) walletError = 'Your wallet shared no account.'; refresh(); return; }
    wallet = w; attach(w);
    if (entry.rdns) safeStorage.set(WALLET_KEY, entry.rdns);
    walletStatus = 'connected';
    // A voucher that was waiting for a wallet can now be sent from the list.
    if (withdraw.status === 'failed' && withdraw.message?.startsWith('Connect your wallet')) withdraw = idle;
    if (prompt) { try { await w.ensureChain(); } catch (error) { walletError = walletErrorMessage(error, `Could not switch to ${chainConfig.chainName}`); } }
    wrongChain = !(await w.onRightChain());
    if (signedIn() && session.account !== address.toLowerCase()) await signOut(`This wallet (${short(address)}) is not the signed-in account — sign in again.`);
    void refreshBalances();
    refresh();
    if (prompt && !signedIn() && !wrongChain) await signIn();
  } catch (error) {
    walletStatus = wallet ? 'connected' : 'disconnected';
    walletError = walletErrorMessage(error, 'Could not connect your wallet');
    refresh();
  }
}

async function switchChain(): Promise<void> {
  if (!wallet) return;
  walletError = undefined;
  try { await wallet.ensureChain(); } catch (error) { walletError = walletErrorMessage(error, 'Could not switch network'); }
  await refreshBalances();
}

async function signIn(): Promise<void> {
  if (!wallet?.address || session.status === 'signing') return;
  session = { status: 'signing' }; refresh();
  try {
    if (!(await wallet.onRightChain())) await wallet.ensureChain();
    const n = await api.nonce();
    if (n.domain !== location.host || n.uri !== location.origin) throw new Error(`this page (${location.origin}) is not the house's game address (${n.uri})`);
    // Times from the house clock (the nonce expiry), so a skewed device clock cannot make the message stale.
    const issuedAt = new Date(n.expiresAtMs - 5 * 60_000);
    const message = createSiweMessage({ address: wallet.address, chainId: n.chainId, domain: n.domain, nonce: n.nonce, uri: n.uri, version: '1', statement: n.statement, issuedAt, expirationTime: new Date(issuedAt.getTime() + 10 * 60_000) });
    const signature = await wallet.signMessage(message);
    const s = await api.verify(message, signature);
    if (!s.authenticated || !s.account) throw new Error('the house did not open a session');
    session = { status: 'signed-in', account: s.account };
    ui.resetPositions(); positions = []; account = undefined; vouchers = []; placements.clear();
    ui.toast('Signed in. Pick a square to play.');
    await Promise.all([pollAccount(), loadVouchers(), loadPromo()]);
  } catch (error) {
    session = { status: 'signed-out', error: error instanceof HouseError ? `Sign-in refused (${error.code}): ${error.message}` : walletErrorMessage(error, 'Sign-in failed') };
  }
  refresh();
}

async function signOut(notice: string, tellHouse = true): Promise<void> {
  if (tellHouse) { try { await api.logout(); } catch { /* the cookie expires on its own */ } }
  session = { status: 'signed-out' };
  account = undefined; positions = []; vouchers = []; placements.clear(); ui.resetPositions();
  ui.toast(notice);
  void loadPromo();
  refresh();
}

async function disconnect(notice = 'Wallet disconnected.'): Promise<void> {
  detachWallet?.(); detachWallet = undefined;
  wallet = undefined; walletStatus = 'disconnected'; wrongChain = false; tokenCenti = null; ethWei = null; walletError = undefined;
  safeStorage.del(WALLET_KEY);
  if (signedIn()) await signOut(`${notice} You are signed out.`);
  else { ui.toast(notice); refresh(); }
}

// ------------------------------------------------------------------ deposit

async function startDeposit(text: string): Promise<void> {
  const parsed = parseOpenAmount(text);
  if (!parsed.ok) { deposit = { status: 'failed', step: parsed.error, txs: [] }; refresh(); return; }
  if (!wallet?.address || !signedIn()) { deposit = { status: 'failed', step: 'Connect your wallet and sign in first.', txs: [] }; refresh(); return; }
  const w = wallet, amountWei = centiToWei(parsed.centi), txs: LiveTx[] = [];
  const set = (status: LiveFlow['status'], step: string, message?: string) => { deposit = { status, step, ...(message ? { message } : {}), txs: [...txs] }; refresh(); };
  set('working', 'Checking your wallet…');
  try {
    await w.ensureChain();
    if (w.address!.toLowerCase() !== session.account) throw new Error(`switch your wallet to the signed-in account ${short(session.account!)}`);
    const balance = await w.tokenBalance();
    if (balance < amountWei) throw new Error(`your wallet holds ${formatOpen(weiToCentiFloor(balance))} (tOPEN)`);
    if ((await w.allowance()) < amountWei) {
      set('working', 'Approve the vault in your wallet (step 1 of 2)…');
      const approveHash = await w.approve(amountWei);
      txs.push({ label: 'Approve', hash: approveHash, url: w.explorerTx(approveHash) });
      set('working', 'Approving… waiting for the network');
      if ((await w.waitForReceipt(approveHash)).status !== 'success') throw new Error('the approval failed on chain');
    }
    set('working', `Confirm the deposit of ${formatOpen(parsed.centi)} in your wallet…`);
    const depositHash = await w.deposit(amountWei);
    txs.push({ label: 'Deposit', hash: depositHash, url: w.explorerTx(depositHash) });
    set('working', 'Depositing… waiting for the network');
    if ((await w.waitForReceipt(depositHash)).status !== 'success') throw new Error('the deposit failed on chain');
    set('working', 'Confirmed on chain · waiting for the house to credit it…');
    void refreshBalances();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await pollAccount();
      if (account?.deposits.some(d => d.txHash.toLowerCase() === depositHash.toLowerCase())) { set('done', `Credited ${formatOpen(parsed.centi)} to your in-game balance`); ui.toast(`Deposit credited: ${formatOpen(parsed.centi)}`, true); return; }
      await sleep(1_500);
    }
    set('working', 'Confirmed on chain · the house has not credited it yet', 'It is credited automatically once the house indexer sees it (Base Sepolia waits for 2 confirmations).');
  } catch (error) {
    set('failed', 'Deposit not completed', walletErrorMessage(error, 'The deposit did not go through'));
  }
}

// ------------------------------------------------------------------ withdraw

const WITHDRAW_ERRORS: Record<string, string> = {
  INSUFFICIENT_BALANCE: 'Not enough available OPEN (stakes in play are reserved).',
  ABOVE_VOUCHER_MAX: 'That is above the vault\'s per-withdrawal limit.',
  VAULT_PAUSED: 'The vault is paused; withdrawals resume when it is unpaused.',
  VAULT_ESCAPE_MODE: 'The vault is in escape mode: claim through the escape hatch instead.',
  SIGNER_MISMATCH: 'The house cannot sign vouchers right now (signer rotation). Try again later.',
  RATE_LIMITED: 'Too many withdrawal requests; wait a minute.',
  AUTH_REQUIRED: 'Your session ended — sign in again.',
};

async function startWithdraw(text: string): Promise<void> {
  const parsed = parseOpenAmount(text);
  if (!parsed.ok) { withdraw = { status: 'failed', step: parsed.error, txs: [] }; refresh(); return; }
  if (!signedIn()) { withdraw = { status: 'failed', step: 'Sign in first.', txs: [] }; refresh(); return; }
  withdraw = { status: 'working', step: 'Asking the house for a withdrawal voucher…', txs: [] }; refresh();
  let voucher: VoucherJson;
  try {
    voucher = await api.requestWithdrawal(crypto.randomUUID(), parsed.centi);
  } catch (error) {
    const unknown = error instanceof HouseError && error.unknownOutcome;
    withdraw = { status: 'failed', step: unknown ? 'The house did not answer' : 'Withdrawal refused', message: unknown ? 'Check “Your withdrawals” below before asking again: a voucher may already exist.' : error instanceof HouseError ? WITHDRAW_ERRORS[error.code] ?? error.message : 'The request failed', txs: [] };
    await loadVouchers();
    return;
  }
  await Promise.all([loadVouchers(), pollAccount()]);
  await sendVoucherFlow(voucher);
}

async function sendVoucherFlow(v: VoucherJson): Promise<void> {
  const txs: LiveTx[] = [];
  const set = (status: LiveFlow['status'], step: string, message?: string) => { withdraw = { status, step, ...(message ? { message } : {}), txs: [...txs] }; refresh(); };
  const w = wallet;
  if (!w?.address || !chainConfig) { set('failed', `Voucher for ${formatOpen(v.amountCenti)} is ready`, 'Connect your wallet to send it to the vault.'); return; }
  if (w.address.toLowerCase() !== v.account.toLowerCase()) { set('failed', 'Wrong wallet account', `Switch your wallet to ${short(v.account)} to send this voucher.`); return; }
  try {
    await w.ensureChain();
    if (v.chainId !== chainConfig.chainId || v.vault.toLowerCase() !== chainConfig.vault.toLowerCase()) throw new Error('the voucher is for another vault or chain');
    if (!v.signature) throw new Error('the house has not signed this voucher yet');
    const now = await w.chainTimeS();
    chainNowS = now;
    if (now > BigInt(v.expiry)) { set('failed', 'This voucher has expired', 'Expired vouchers cannot be sent. The amount returns to your balance after the house confirms it on chain (about 10 minutes after expiry).'); return; }
    set('working', `Confirm the withdrawal of ${formatOpen(v.amountCenti)} in your wallet…`);
    const hash = await w.withdraw({ amountWei: BigInt(v.amountWei), nonce: BigInt(v.nonce), expiry: BigInt(v.expiry), signature: v.signature as Hex });
    sentVouchers.set(v.voucherId, { hash, mined: false });
    txs.push({ label: 'Withdraw', hash, url: w.explorerTx(hash) });
    set('working', 'Withdrawing… waiting for the network');
    const receipt = await w.waitForReceipt(hash);
    if (receipt.status !== 'success') { sentVouchers.delete(v.voucherId); throw new Error('the vault refused the voucher (expired, already used, or over a daily limit)'); }
    sentVouchers.set(v.voucherId, { hash, mined: true });
    set('working', 'Paid out on chain · waiting for the house to record it…');
    void refreshBalances();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await loadVouchers();
      if (vouchers.find(x => x.voucherId === v.voucherId)?.status === 'claimed') { set('done', `Withdrew ${formatOpen(v.amountCenti)} to your wallet`); ui.toast(`Withdrawn: ${formatOpen(v.amountCenti)} (tOPEN)`); void pollAccount(); return; }
      await sleep(1_500);
    }
    set('done', `Withdrew ${formatOpen(v.amountCenti)} to your wallet`, 'The house records it once its indexer sees the transaction.');
  } catch (error) {
    set('failed', 'Withdrawal not completed', walletErrorMessage(error, 'The withdrawal did not go through'));
    void loadVouchers();
  }
}

// ------------------------------------------------------------------ start

async function start(): Promise<void> {
  if (__MAYA_TEST_WALLET__) {
    const { installTestWallet } = await import('./live/test-wallet.js');
    installTestWallet({ role: new URLSearchParams(location.search).get('testWallet') ?? undefined });
  }
  discovery.subscribe(() => { void silentReconnect(); refresh(); });
  discovery.start();
  feed.subscribe(refresh);
  feed.start();
  await loadHouse();
}

/** Chain config and any session the browser already holds; retried every 5 s while the house is unreachable. */
async function loadHouse(): Promise<void> {
  try {
    chainConfig = await api.chainConfig();
    const s = await api.session();
    if (s.authenticated && s.account) { session = { status: 'signed-in', account: s.account }; await Promise.all([pollAccount(), loadVouchers()]); }
    startupError = '';
  } catch (error) {
    startupError = error instanceof HouseError ? `The house is unavailable (${error.code}). Retrying…` : 'The house is unavailable. Retrying…';
    setTimeout(() => void loadHouse(), 5_000);
  }
  void loadPromo();
  void silentReconnect();
  refresh();
}

async function silentReconnect(): Promise<void> {
  if (triedSilentReconnect || wallet || !chainConfig?.walletSupported) return;
  const rdns = safeStorage.get(WALLET_KEY);
  const entry = rdns ? discovery.byRdns(rdns) : undefined;
  if (!entry) return;
  triedSilentReconnect = true;
  await connect(entry.id, false);
}

setInterval(refresh, 250);
setInterval(() => { if (signedIn()) void pollAccount(); }, 1_500);
setInterval(() => { if (signedIn()) void loadVouchers(); }, 5_000);
setInterval(() => void refreshBalances(), 6_000);
setInterval(() => void loadPromo(), 10_000);
window.addEventListener('pageshow', () => { ui.cancelGesture(); refresh(); });
window.addEventListener('pagehide', () => ui.cancelGesture());
void start();

// Read-only diagnostics for QA; exposes no action, no key and no cookie.
Object.defineProperty(window, '__mayaLive', { value: Object.freeze({
  snapshot: () => structuredClone({
    mode: 'live', marketId: selected, chain: chainConfig ? { chainId: chainConfig.chainId, network: chainConfig.network, vault: chainConfig.vault } : null,
    wallet: { status: walletStatus, address: wallet?.address ?? null, wrongChain, tokenCenti, ethWei, provider: wallet?.entry.name ?? null },
    session, balanceCenti: account?.balanceCenti ?? null, availableCenti: account?.availableCenti ?? null, positions: positions.length, pending: placements.pending().length,
    feed: feed.health(), houseNowMs: feed.nowMs(), visibleQuotes: Number(ui.root.dataset.visibleQuotes ?? 0), deposit, withdraw, vouchers: vouchers.map(v => ({ voucherId: v.voucherId, status: v.status, amountCenti: v.amountCenti })), promo,
  }),
  view: () => ui.diagnostics(),
}) });
