# Testnet funding runbook (Base Sepolia)

Verified 2026-09-26 by a 48-agent faucet sweep plus live claims. Faucets change often; re-check before relying on one.

**Current state:** the $OPEN operator `0xb19339Eb15f067cc3eBc2400765703FC424aCa51` got 0.143 Base Sepolia ETH on 2026-09-26:
- 0.098 mined on the pk910 Sepolia proof-of-work faucet
- 0.05 from the Google Cloud faucet
- both bridged in [this L1 transaction](https://sepolia.etherscan.io/tx/0x7ec6fd4396704620e5273eeee07a5e8c7d9ea11f88c258438f638cc96b957770)

## Only Ethereum Sepolia or Base Sepolia ETH works
Base Sepolia's canonical bridge takes deposits only from **Ethereum Sepolia**. Hoodi ETH cannot reach Base Sepolia. A separate Hoodi deployment would be possible, since the contracts run on any EVM chain, but it isn't set up.

## Works for a fresh wallet: no login, no mainnet balance
| Source | Network | Amount | Gate | Notes |
| --- | --- | --- | --- | --- |
| [OpenFaucet.org Base Sepolia](https://openfaucet.org/base-sepolia) | **Base Sepolia (direct)** | 0.01–0.05 per claim | Proof-of-work in the browser, no captcha | Best top-up: no bridge needed |
| [pk910 Sepolia PoW](https://sepolia-faucet.pk910.de/) | Sepolia | 0.05–2.5 per session | Proof-of-work + auto Turnstile | Used 2026-09-26: about 0.8 ETH/h on 12 workers |
| [OpenFaucet.org Sepolia](https://openfaucet.org/ethereum-sepolia) | Sepolia | 0.01–0.05 | Proof-of-work | Backup |
| [GHOST faucet](https://ghostchain.io/faucet/ethereum-sepolia/) | Sepolia | 0.01 | Auto Turnstile | Shared cap of 200 claims/day, so claim early |

## Works with a login you already have in Chrome
| Source | Network | Amount | Login |
| --- | --- | --- | --- |
| [Google Cloud Web3 faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) | Sepolia | 0.05/day | Google (used 2026-09-26) |
| [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet) | Base Sepolia | 0.0001 per claim, up to 0.1 per 24 h | Coinbase |
| [Metana faucet](https://faucet.metana.io/) | Sepolia | 0.06 | Google + email code (needs the user) |

## Not usable for us
| Faucet | Why |
| --- | --- |
| Alchemy, QuickNode, Infura, Chainlink | Need a mainnet balance |
| ZalalenA, faucet.trade, testnet.help | Interactive captcha |
| thirdweb, ethfaucet.com (BringID) | Paid plan or humanity-verification points |
| ethereum-ecosystem.com Base PoW | Paused |

**Avoid** anyone selling testnet ETH, and anything that asks for a private key or seed phrase ([MetaMask scam guidance](https://support.metamask.io/stay-safe/protect-yourself/tokens-and-transactions/testnet-eth-scams/)).

## Bridge Sepolia → Base Sepolia
```bash
node tooling/testnet/bridge-sepolia-to-base.mjs --dry-run
node tooling/testnet/bridge-sepolia-to-base.mjs
```
The script:
1. Uses Base's official L1StandardBridge `0xfd0Bf71F60660E2f608ed56e1659C450eB113120` (per docs.base.org).
2. Keeps 0.005 ETH on Sepolia for gas.
3. Waits for the Base Sepolia credit, usually 1–3 minutes.
4. Reads keys from `.secrets/` and never prints them.
