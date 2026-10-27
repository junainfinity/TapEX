---
type: project-handoff
created: 2026-09-20
tags: [Maya, demo, Docker, handoff]
---

# Maya — playable demo

**Play locally: [Open Maya](http://127.0.0.1:8080).** Docker Desktop hosts the game on this computer.

Choose BTC/USD or ETH/USD, set your stake and zoom, and tap a future square. The recorded price line touching its time and price range wins the displayed total return. Repeated bets on one square add to its visible stake. After ten accepted bets the consultation offer appears. **Every refresh starts a fresh $1,000 session with ten plays and empty recent plays.** Previous records remain saved only for audit and cannot change the new balance. Wallet/consultation actions now open https://quantellics.com/launch-review/; the original example.com destination is historical. Phone wallet access is in the controls menu.

Current implementation: [Maya Runtime - Mobile Thumb Bar and Pinch Zoom](Maya%20Runtime%20-%20Mobile%20Thumb%20Bar%20and%20Pinch%20Zoom.md) — single-row phone controls, taller canvas, pinch handling and three passing final Docker/public gauntlets. The last full workspace check on 22 September passed 165 tests. [Maya Runtime - Wallet Controls and Fresh Sessions](Maya%20Runtime%20-%20Wallet%20Controls%20and%20Fresh%20Sessions.md) retains the earlier wallet/reset implementation and its dated 160-test/53-check evidence. Earlier persistence behavior documented below is historical.

Project documentation: [Maya - Planning Debug and Results Index](Maya%20-%20Planning%20Debug%20and%20Results%20Index.md) connects the graph, six node plans, three-pass reviews, debugging record and runtime results. [Maya - Repository and Technical Handover](Maya%20-%20Repository%20and%20Technical%20Handover.md) links the private Q-Maya repository, detailed architecture/integration README and Quantellics brand assets.

Mobile update (22 September): [Maya Runtime - Mobile Thumb Bar and Pinch Zoom](Maya%20Runtime%20-%20Mobile%20Thumb%20Bar%20and%20Pinch%20Zoom.md) — the selected single-row thumb bar, taller phone canvas and native pinch handling, with the gauntlet's failures and successful corrections. Desktop/tablet geometry comparisons passed. [Maya - Mobile Gameplay Layout Proposal](Maya%20-%20Mobile%20Gameplay%20Layout%20Proposal.md) preserves the five original concepts.

Latest refinement: [Maya Runtime - Bet Integrity and Leaderboard](Maya%20Runtime%20-%20Bet%20Integrity%20and%20Leaderboard.md) — each accepted click adds the selected stake immediately: $5 → $10 → $15 → $20 across four clicks. Verified all five stakes on desktop/tablet/mobile layouts and live saved debits. Also includes the top-left translucent overlay without chart shrinkage, combined stake cards, escalating real win streaks, and one recorded path for chart and new-bet settlement. Earlier motion evidence: [Maya Runtime - Motion and Adaptive Refinement](Maya%20Runtime%20-%20Motion%20and%20Adaptive%20Refinement.md).

## Run and inspect

Full source: `<repo>`. From that directory, `docker compose up -d --build --wait` starts or reconstructs Maya, `docker compose ps` shows health, and `docker compose down` stops it. [Source README](../../README.md) and [delivery record](../DELIVERY.md) include the settings and limitations.

- [Maya - Development Graph](Maya%20-%20Development%20Graph.md) — reviewed node/dependency plan, also available as its Obsidian Canvas.
- [Maya - Graph QA Log](Maya%20-%20Graph%20QA%20Log.md) — three planning graph reviews and frozen inputs.
- [Maya Runtime - N6 Integration and Docker](Maya%20Runtime%20-%20N6%20Integration%20and%20Docker.md) — three runtime graph rounds and actual hosted browser results.
- [Maya Runtime - N6 Independent Review](Maya%20Runtime%20-%20N6%20Independent%20Review.md) — independent composition/source review.
- [Tap Trading Research - Search and Action Log](Tap%20Trading%20Research%20-%20Search%20and%20Action%20Log.md) — research, decisions and implementation history.

## What was proved

Latest full mobile validation (22 September): **165 unit tests**, types, boundaries and build passed. Three final Docker runs passed112 checks each; three public runs passed113/112/112 checks. These were browser touch-emulation checks, not physical-phone certification. The 25 September handoff freshly checked source, containers and HTTP without repeating that full suite. See Maya - Agent Handoff - 2026-09-25.

Earlier wallet/session evidence:53 browser checks and a separate ten-bet journey with141 exact ledger checks; refresh restored $1,000 and ten plays. See [Maya Runtime - Wallet Controls and Fresh Sessions](Maya%20Runtime%20-%20Wallet%20Controls%20and%20Fresh%20Sessions.md).

Earlier integrity refinement: **157 unit tests passed**, together with types, boundaries and build. Its Docker ledger passed **365 exact checks** across 27 settled positions. Two twenty-second live captures each recorded 1,201 frames with p95 16.8ms and no stalls or frames above 50ms. The overlay preserved the reference desktop's 904px chart. Three layout rounds, grouped bets, multiple real-streak effect tiers, reduced motion and rapid clicks were verified. Full evidence and limitations: [Maya Runtime - Bet Integrity and Leaderboard](Maya%20Runtime%20-%20Bet%20Integrity%20and%20Leaderboard.md).

The initial delivery passed 95 unit tests, typechecks, boundary checks and production build. Its real Docker browser journeys exercised both pairs, every stake, allowed zoom limits, four complete ten-bet sessions, consultation, refresh, retained open positions, two-tab shared balance and feed interruption/recovery. That historical 41-position ledger ended with 21 observed wins and 20 observed losses, and passed 267 exact balance/evidence checks. Current refinement results are in [Maya Runtime - Bet Integrity and Leaderboard](Maya%20Runtime%20-%20Bet%20Integrity%20and%20Leaderboard.md). Separate node reports preserve their correction/recheck rounds and failures.

Runtime evidence is copied into `Attachments/Maya Runtime`, with [SHA-256 inventory](runtime-evidence-manifest.json). Source, test harnesses and original artifacts remain in the monorepo. Planning cases, deterministic fixtures, emulated devices and real live-browser evidence are labeled separately.

## Scope kept explicit

This is an Euphoria-inspired Maya paper demo using Lynx public prices and locally simulated odds. It does not certify proprietary Euphoria odds, pixel/font/sound identity, physical-device performance, a market-maker partnership or real execution. New v2 bets and the visible line share immutable first-persisted observations and straight connectors; historical v1 bets keep their original stabilized sampled rule. Numerical model verification is not empirical market calibration. Earlier limits and failed aspirational gates remain preserved in [Maya Runtime - N2 Prices and Odds](Maya%20Runtime%20-%20N2%20Prices%20and%20Odds.md) and [Maya Runtime - N4 Playable Experience](Maya%20Runtime%20-%20N4%20Playable%20Experience.md).

White-label buyer choices and future production onboarding remain separate: [V1 - White-label Demo and Consultation Flow](V1%20-%20White-label%20Demo%20and%20Consultation%20Flow.md) and [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md).
