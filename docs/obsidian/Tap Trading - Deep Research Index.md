---
type: research-report
created: 2026-09-20
verified: 2026-09-20
tags: [Maya, tap-trading, architecture, economics, UX]
---

# Euphoria, RUSH and Lynx — reverse engineering

**The same price-time grid conceals three different execution models. Euphoria is the strongest reference for the supplied video's experience. Lynx provides the clearest publicly inspectable integration and economics. RUSH exposes useful implementation details, but several claims remain unverified.**

**Product decision:** the user selected Euphoria for how Maya should **look, feel and work**. [Euphoria - Product Reference and Fidelity Requirements](Euphoria%20-%20Product%20Reference%20and%20Fidelity%20Requirements.md) now governs the build alongside the video measurements. The comparison below remains research evidence, not an unresolved choice of design direction.

**Locked v1:** [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md) selects Lynx public price/model inputs, local indicative odds, BTC/USD and ETH/USD, virtual USD and Euphoria-style Three.js controls/visuals. No registration or real trading. [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md) is the implementation plan.

**Demo clarification:** anyone opens straight into play, chooses a pair, adjusts zoom/stake within shared limits and taps bets. Actual sampled price movement decides win/loss; fixed model-derived odds decide payout. No random outcomes, account tiers or production execution workflow.

**Business purpose and name:** the product is **Maya**, offered as a turnkey white-label game with customisation, launch and full project source-code handover. [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) defines ten accepted bets per page load, a consultation modal after the tenth, and ten more on each refresh. The booking URL is an approved dummy (`https://example.com`) for now. Buyer/provider onboarding and configuration options belong in separate literature.

**Development graph:** [Maya - Development Graph](Maya%20-%20Development%20Graph.md) organizes implementation into six nodes, with subagent review loops and a navigable Obsidian Canvas. [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md) separates the requested three planning reviews at each level from runtime tests that remain to be executed when the app is built.

**Deferred provider research:** [Wintermute - Quote Supply for Paper Trading Odds](Wintermute%20-%20Quote%20Supply%20for%20Paper%20Trading%20Odds.md) and [Wintermute - Integration and Access Plan](Wintermute%20-%20Integration%20and%20Access%20Plan.md) are retained for future versions; they are not v1 dependencies.

**External supplier comparison:** [Tap Trading - External Odds and Price Suppliers](Tap%20Trading%20-%20External%20Odds%20and%20Price%20Suppliers.md) explains why Lynx was selected and distinguishes its local previews from firm market-maker quotes. Other providers remain research only.

Read the product reports:

1. [Euphoria - Stack Economics Flow and UX](Euphoria%20-%20Stack%20Economics%20Flow%20and%20UX.md)
2. [RUSH - Stack Economics Flow and UX](RUSH%20-%20Stack%20Economics%20Flow%20and%20UX.md)
3. [Lynx - Stack Economics Flow and UX](Lynx%20-%20Stack%20Economics%20Flow%20and%20UX.md)
4. [Tap Trading - Economics and Build Implications](Tap%20Trading%20-%20Economics%20and%20Build%20Implications.md)
5. [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md)

## What was actually inspected

Official docs, unauthenticated app screens, desktop and 390 × 844 mobile layouts for RUSH/Lynx, publicly served JavaScript, a published npm SDK, current public configuration endpoints, and limited read-only chain checks. No accounts, wallet signatures, deposits, bets, withdrawals or vendor contact were performed. Euphoria's authenticated trading experience was not entered; its reference video, docs and public application code provide that evidence.

**Evidence labels:** **Observed** = UI, public code or endpoint directly inspected. **Documented** = product/provider statement, not an independently measured guarantee. **Inferred** = reasoned architecture/economic conclusion. **Unknown** = not established. A library in a bundle does not prove a server uses it; a contract interface does not prove deployed bytecode matches it.

## Comparison

| Dimension | Euphoria | RUSH | Lynx |
|---|---|---|---|
| Core mechanic | Five-second touch windows; market-maker multiplier | Advertises grid entry; code also contains expiry-range pricing, leaving exact settlement unresolved | Solo touch-window positions; PvP credit-scoring contests |
| Frontend observed | React, Vite/Rolldown; custom Canvas 2D plus Rive/WebGL/WASM layers | React/Next.js; Canvas 2D; Vercel-served frontend | React/Vite, MobX; PixiJS game rendering |
| Identity | Privy; embedded account wallet | Privy/Solana wallets; session trading interface | EVM wallet/SIWE; Firebase-related auth code |
| Fast path | tRPC requests, NATS over WebSocket events | API requests, session authorization, MagicBlock interfaces | HTTP + Colyseus WebSockets; off-chain game ledger |
| Financial settlement | MegaETH contracts and RedStone per docs | Solana/Anchor + MagicBlock + Pyth per site/interface | Vault deposits/redemptions, ledger checkpoints; gameplay is not an L1 transaction per tap |
| Economics established | No current explicit trading fee per docs; competitive quotes. MM/platform revenue split unknown | Site says 3–5% of profit. Client pricing and fee interfaces need reconciliation | BSC solo config: 10% model margin. Enabled BSC PvP rooms checked: 10% pot fee |
| Integration evidence | Internal app protocol; public commercial SDK not found | Embedded Anchor interface; external integration terms not found | Published `lynx-gameroom-client` alpha, API/wire docs, live config; repository URL inaccessible |

These statements are supported in the individual reports. Prices, limits, room settings and deployed bundles are snapshots of 2026-09-20, not permanent terms.

## Findings that change the build decision

**A 3D engine is a frontend choice, not the source of the game mechanics.** The observed products use 2D chart rendering and animation. Three.js can reproduce the presentation, but it must sit above a separately specified clock, quote, acceptance, ledger and settlement system.

**Lynx is more relevant than the earlier broad comparison suggested.** It has both solo Gridy and PvP Gridy. The npm distribution exposes an integration client and documents custody/ledger boundaries. This is stronger evidence for integration feasibility than a generic white-label sales page, but does not establish permission to resell, rebrand, self-host the server, or reuse its UI assets.

**Zero explicit fees do not establish zero economic margin.** Euphoria's market makers can price their own risk into multipliers. Lynx explicitly reduces fair model payouts. RUSH's advertised profit fee is separate from the unresolved pricing margin in its client. Do not call all three “a casino with the same house edge.”

**Fast feedback and spendable withdrawals are different clocks.** The Lynx SDK describes settlement into a ledger shortly after a box ends and checkpoint-gated withdrawals taking materially longer. RUSH's speed claims were not benchmarked. Euphoria's oracle integration establishes fast data delivery, not a measured withdrawal SLA.

**Advertised scale needs denominators.** Lynx's homepage volume is labelled cumulative perpetual volume, not Arcade turnover. RUSH's headline volume cannot be used as tap-game revenue or stake turnover without a methodology; its separate 1000× product can make notional figures incomparable.

## Best reference for each part of Maya

| Need | Reference | Reason |
|---|---|---|
| Visual fidelity to the video | Euphoria | Strong match in palette, cards, controls and documented five-second touch rule; original video's provenance remains unproven |
| Inspectable payout model | Lynx Solo | Public margin/configuration, touch-probability client and model metadata |
| Multiplayer round design | Lynx PvP | Explicit separation between deposits, entry fee, credits, qualification and pot settlement |
| Session-based Solana flow | RUSH | Session token and delegation interfaces explain how repeated signing can be avoided |
| Initial implementation | Locked Maya v1 plan | Lynx public inputs, local preview odds and a virtual-USD ledger for BTC/USD and ETH/USD; no real execution |

## Evidence files

Open [Tap Trading Research - Evidence Index](Tap%20Trading%20Research%20-%20Evidence%20Index.md) for the complete attachment inventory and public HTTP retrieval list.

The readable audit trail is [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md). The machine-readable [HTTP request manifest](Attachments/Tap%20Trading%20Research/public-asset-requests.jsonl) records source URLs, timestamps and hashes. Attachments also include screenshots, current Lynx JSON snapshots, RUSH interface facts, chain-read results, reproducible inspection scripts, and the published Lynx SDK archive. Raw proprietary bundles remain only in the local research cache; the vault preserves their provenance and our findings.

Related history: [Video Analysis - Price-Time Prediction Grid](Video%20Analysis%20-%20Price-Time%20Prediction%20Grid.md), [Three.js Trading Game - Fidelity Build Plan](Three.js%20Trading%20Game%20-%20Fidelity%20Build%20Plan.md), [Crypto Tap Trading - Existing Products and Binance Mapping](Crypto%20Tap%20Trading%20-%20Existing%20Products%20and%20Binance%20Mapping.md).


## Playable implementation

The implemented local Docker demo, source and runtime QA evidence are linked from [Maya - Start Here](Maya%20-%20Start%20Here.md). Planning review records above remain historical and are not substituted for runtime proof.
