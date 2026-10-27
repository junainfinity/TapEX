---
type: implementation-report
created: 2026-09-20
tags: [Maya, UI, wallet, paper-session, QA]
---

# Wallet controls and fresh sessions

User requested hover animation for every page button, a wallet icon right of the help circle, and a contact message for adding chain or wallet support with a button to example.com. During implementation the user also requested that every refresh restore $1,000. These requests are now implemented. Earlier instructions to preserve the playable balance across refresh are superseded.

## Delivered behavior

Controls change background/text/border colours with soft glow on hover, keyboard focus and touch press. Bet targets do not move. The wallet icon opens a native accessible dialog: “Your chain. Your wallet.” Its message offers contact about supporting any crypto chain or wallet; Contact us opens the approved dummy https://example.com in a new tab. Escape, close and backdrop dismiss it, focus returns to the icon, and background betting is blocked. Reduced motion removes entrance motion and transitions. No wallet connection or real transaction is implemented.

Every page document now owns a unique session ledger key. On refresh, the visible balance is exactly $1,000, the ten-play allowance resets, and active positions/recent plays start empty. Previous session records and the original shared ledger remain saved for audit, but old positions cannot change the new balance. Other tabs are independent. A reconnect within the same document does not create a second grant. Help and consultation text reflect these semantics.

## Verification and deployment

`pnpm check` passes all 160 tests, all typechecks, boundaries and production build. Three new engine tests cover old-balance isolation, an older session winning while a new session remains $1,000, and persisted debit/idempotency within one scope versus a fresh scope on reload.

The real Docker browser passed 53 checks over five layouts: desktop 1642×904, tablet 768×1024, mobile 390×844, narrow mobile 320×740 and landscape 844×390. It checked wallet placement, dialog containment, keyboard focus, Escape/close/backdrop, reduced motion, 15 hover controls, an actual contact link navigation to example.com, and fresh balance after both a refill and a real $5 paper bet. Screenshots were inspected. The examples are emulated viewports, not physical-device certification.

A separate full ten-bet journey used both markets and all five stakes, triggered one consultation offer, and passed 141 exact ledger checks across ten settled losses. Clicking the visible refresh control returned $1,000, zero positions, ten plays and no consultation overlay. The current-session audit helper now reads the diagnostic ledger key. Earlier evidence using the original shared ledger is historical and remains intact.

Final assets: `index-C17uMyXW.js`, `index-CKtWwCWC.css`, unchanged `pricing-worker-B5eTPeMV.js`. Both Docker services are healthy. Browser error capture was empty. The user's tab was refreshed to the new experience; test bets were made in an independent browser profile. Raw reports, screenshots, build logs and source manifests are archived under `Attachments/Maya Runtime/integrity/wallet-*`, with originals in the monorepo.

## Corrections recorded

The first production build failed because the explicit asset-copy list did not include the new controls stylesheet. Adding that filename fixed the build. An early hover harness reported two failures because those controls already had keyboard-focus colours equal to hover colours. Resetting focus through neutral native clicks fixed the measurement; all 53 checks then passed. A final style-specificity refinement preserves the light contact-button treatment; the default broadcast-channel name remains compatible for non-session engine clients. These are recorded separately from application failures.

No vendor research, market-maker onboarding or messages to others occurred. The only external page navigation was the requested example.com contact behavior. Source and portable delivery notes are in `<repo>`.
