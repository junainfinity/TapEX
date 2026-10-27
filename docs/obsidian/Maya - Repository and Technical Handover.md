---
type: repository-handoff
created: 2026-09-20
tags: [Maya, Quantellics, GitHub, architecture, API, branding]
---

# Repository and technical handover

The user requested a GitHub repository named Q-Maya, a comprehensive technical README, and Quantellics company branding for that repository. The game itself remains named Maya.

## Engineering documentation

[Detailed README](../../README.md) documents the checked local source: technology versions, eight workspaces, runtime/package architecture, data contracts, startup/price/quote/placement/settlement/session/consultation flows, exact payout arithmetic, and desktop/tablet/mobile behavior. It includes Mermaid diagrams and file-level links.

The customisation guide distinguishes public-price adapters, local versus external odds, and server paper versus real execution. It explains the concrete bootstrap dependencies beyond the narrow ports, literal two-market contract types, relay URL ownership, source time/precision/cadence, immutable quotes, size-dependent maker terms, pending acceptance, idempotent timeout reconciliation, server-authoritative accounting, and matched event/price/model/settlement rules. Suggested backend endpoints are labeled proposed, not existing. No new provider or live execution was implemented during this documentation task.

[Documentation index](../README.md) links the full note export. [Maya - Planning Debug and Results Index](Maya%20-%20Planning%20Debug%20and%20Results%20Index.md) consolidates graph/node loops, failures, fixes and current results while preserving original review snapshots. The export transforms note links for GitHub and maps runtime archive references back to existing source-tree evidence. Research screenshots, JSON, review snapshots, historical plans and the original reference clip are included; caches and installed dependencies are excluded.

## Quantellics identity

User asked for a typographic crypto-technology wordmark, then dark and light editions with one consistent coloured shape. The chosen direction uses geometric lettering, a mint diagonal Q stroke and a mint square dot above the i. Dark/light editions retain the same accent colour. GitHub's README uses a picture element to select the appropriate edition based on colour scheme. [Brand assets and generation provenance](../brand/README.md) records the final files and prompts.

The built-in image-generation tool was used. An initial image had distressed edge artifacts; a targeted cleanup produced clean lettering. The user's dark/light and square-accent request then guided two variants. Final assets are repository branding, not an in-game identity change. They are raster wordmarks, not claimed editable vector artwork.

## Repository actions and evidence

Created Q-Maya as an empty private repository in the existing authenticated GitHub account. Initialized the local monorepo on main, configured the account's noreply Git identity, added the origin and made the initial source commit cc17598. Git Credential Manager authentication succeeded without exporting credentials. A stalled login helper was stopped before retrying; official GCM environment/configuration docs were consulted. No credential/token values were copied into docs or Git.

The initial source inventory contained 468 committed files and no matches for the bounded private-key/GitHub-token/AWS-key scan. This scan is a publication check, not a comprehensive security audit. The expanded pre-push scan also found no matches. Git line-ending conversion was disabled for captured evidence and exported archive files after Git staging revealed it would otherwise invalidate recorded hashes. All471 staged exported/runtime blobs then matched their recorded SHA-256 values.

**Upload verified:** first published commit `f12245777dd0225e974496a2d3ab82663fbafaad` contains586 files. GitHub main matched local HEAD; the private badge, source/docs folders, rendered README, loaded2172×724 logo and dark/light picture sources were verified in the browser. Five Mermaid diagrams were present. A visual review found horizontal graphs too small, so the runtime/development graphs were switched to vertical layouts for the closeout commit. [Publication receipt](../../artifacts/verification/publication/github-upload.json) records this initial verified payload; a later documentation closeout commit includes the receipt itself.

The portable archive contains43 root notes, one Canvas and63 research/development attachments. Its429 local links and363 runtime references passed validation. The broader README/docs check initially passed550 links before final index/receipt additions. Frozen original review files remain byte-for-byte unchanged. The user's Maya tab now runs `index-C17uMyXW.js`, shows $1,000 and10 plays after refresh, includes the wallet control and offers live squares after warmup.

## One-time workstation shutdown

User explicitly requested shutdown at 1 AM IST. Windows Task Scheduler task `Maya-OneTime-Shutdown-2026-09-21-0100-IST` is registered for **21 September 2026 at 01:00:00 +05:30**, with wake-to-run enabled and `shutdown.exe /s /t 0`. It performs a normal shutdown without forced application closing. A preliminary Codex heartbeat was removed after the native task was verified, avoiding duplicate scheduling. The native schedule does not require Codex to remain open; unsaved-application prompts can prevent normal shutdown. This is a local operational action, not part of the deployable app.
