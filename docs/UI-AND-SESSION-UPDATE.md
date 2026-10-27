# Button feedback, wallet contact and fresh paper sessions

The page now responds to pointer hover with background, text, border and glow transitions. Keyboard focus and touch presses receive matching feedback; disabled controls remain inactive. Bet squares stay fixed in position. Reduced-motion preferences remove transitions and dialog entrance motion.

A wallet icon sits immediately right of the help button at desktop, tablet, mobile and short landscape layouts. It opens a native modal dialog about adding support for any chain or wallet. The Contact us link opens https://example.com in a new tab. Escape, the close button and clicking the backdrop dismiss the dialog and return focus to the wallet icon. Native modal focus containment and explicit bet-input guards prevent background placement. No wallet connection is attempted.

Every document creates one random session ID and ledger key. The current session gets one $1,000 grant and ten plays. Refresh creates a new session with no active positions or recent-play entries; wins or refills in an older tab cannot change its balance. Earlier records, including the original shared `ledger` record, are preserved for audit. Session creation happens once per document, not during reconnect attempts. Help and consultation copy explain the new reset behavior.

Verification on 20 September 2026:

- `pnpm check`: 160 tests, types, boundaries and build pass. Three new engine cases cover prior-balance isolation, old-session win isolation, and reconnect/idempotency versus fresh scopes.
- 53 browser checks cover 15 hover controls, five layouts (1642×904, 768×1024, 390×844, 320×740, 844×390), dialog fit/focus/Escape/backdrop behavior, actual example.com navigation, reduced motion, and reset after spending or refilling.
- A full real ten-play journey used both markets and all stakes, showed exactly one consultation offer and reconciled ten settled losses with 141 exact ledger checks. Clicking its refresh control restored $1,000, zero positions and ten plays.
- Final Docker services are healthy. Assets are `index-C17uMyXW.js` and `index-CKtWwCWC.css`; the pricing worker is unchanged. Screenshots were visually inspected, and browser error capture was empty.

Evidence is under `artifacts/verification/integrity/wallet-*`. Early failed evidence is retained: the first build omitted the new CSS file from the asset copier; the first hover harness compared an already keyboard-focused control with its identical hover appearance. The copier and neutral-focus test setup were corrected. These records do not claim physical-device certification or a new render-performance benchmark. Earlier numerical and settlement evidence remains in its original reports.
