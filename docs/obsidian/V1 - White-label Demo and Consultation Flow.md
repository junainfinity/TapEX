---
type: product-decision
created: 2026-09-20
status: accepted-direction
tags: [Maya, v1, white-label, sales-demo, consultation]
---

# Maya — white-label product, playable demo and consultation flow

**The demo is a hands-on sales experience for our proposed turnkey white-label trading game.** Prospective buyers experience an Euphoria-style game, then receive an invitation to discuss purchasing, customisation, launch and full project source-code handover.

**User-approved product name: Maya.** Use Maya in the public demo, consultation message, document titles for the commercial offer and future sales literature. Visual-reference notes can retain Euphoria's name when describing their source.

User direction: make the game playable; show a consultation message after the tenth placed bet; refreshing must let visitors place ten more bets, repeatedly. Keep chain, pair, pricing/odds, liquidity-provider and other customisation details in separate literature. Buyers arrange their own market-maker/provider onboarding for their chosen production integration.

Related: [V1 - Locked Product Scope](V1%20-%20Locked%20Product%20Scope.md), [Euphoria - Paper Trading Implementation Plan](Euphoria%20-%20Paper%20Trading%20Implementation%20Plan.md), [V1 - Playable Demo Gap Review](V1%20-%20Playable%20Demo%20Gap%20Review.md). This note controls the new sales flow where earlier uninterrupted-play assumptions conflict.

## Product offer and responsibility

The intended commercial offer is a white-label game tailored to the buyer, launched for them, with full source code for the delivered project handed over. The demo demonstrates interaction and visual quality with paper bets; it is not itself a completed production trading deployment.

The buyer is responsible for signing up with the selected market maker/liquidity provider and obtaining the access required for their deployment. Provider selection, supported contracts/odds, integration scope, chain, pairs and operating requirements are handled through consultation and separate literature. Wintermute is the user's example, not a claim that a ready-made Wintermute five-second grid-odds integration or commercial partnership has been verified. Existing [Wintermute - Integration and Access Plan](Wintermute%20-%20Integration%20and%20Access%20Plan.md) remains research for those discussions, not a demo dependency.

The playable screen uses the selected BTC/USD and ETH/USD Lynx public inputs and local paper odds. It contains no chain picker, liquidity-provider selector, production signup or technical sales questionnaire.

## Player journey

1. Open the demo directly with virtual funds and an allowance of ten paper bets.
2. Choose either demo pair, change permitted zoom/stake, and place bets through the normal one-tap flow. A compact count can show how many of the ten have been placed.
3. On the tenth successful placement, show that accepted bet and open the consultation modal once. The trigger is placement, not the tenth settled bet or tenth win.
4. Offer a booking link and a dismiss action. All accepted bets continue settling, and the price/chart keep updating while the message is open or dismissed.
5. Refresh the page to receive another ten placements. This may be repeated indefinitely, without an account or booking requirement.

**Implementation interpretation:** ten accepted bets are the allowance for each page load. After the tenth, new placement is disabled until refresh; closing the modal allows viewing results but does not grant an eleventh bet. This gives concrete meaning to the user's “refresh ... 10 more bets” instruction. Booking is never required to refresh and play again.

## Exact counting and refresh rules

| Event | Effect |
|---|---|
| New page load or browser refresh | Set the page's placement count to zero and allow ten new accepted bets. |
| Valid paper bet accepted | Increment once, after validating and committing its stake debit/position. |
| Invalid, unavailable or rejected tap | No count increment and no stake debit. |
| Retried request for an already accepted bet | No extra count increment, debit or position. |
| Distinct additional bet on the same square | Counts once if it is accepted within the normal cap. |
| Switch pair, zoom, stake, resize or refill balance | Does not reset or increment the count. |
| Win, loss, void or refund | Does not change the count; the placement already happened. |
| Hydrate old positions after refresh | Does not count them as new placements. |
| Tenth acceptance | Count becomes ten, placement gate closes, modal opens once. |
| Eleventh attempted placement before refresh | Rejected without debit; provide a clear refresh/booking affordance. |

Keep the count and modal-trigger flag only in memory for the current document. Do not persist this allowance in localStorage, sessionStorage, cookies, account state or a server; do not use identity, IP or device checks to prevent replay. A pair switch or component rerender must not recreate the allowance. A new tab receives its own page-load allowance.

The allowance is separate from the paper ledger. Preserve existing bets, accepted multipliers and local balance/history across refresh as previously planned; a new page starts its count at zero while old bets recover/settle idempotently. Refresh does not promise to mint a new balance or erase losses. The existing free paper refill remains available and does not reset the count. Source gaps still follow the recovery/refund policy.

Serialize acceptance so rapid taps near the limit cannot accept more than ten new bets. Let the tenth bet commit before showing the modal; never debit a bet that the gate rejects. The modal is a UI overlay, not a pause of the game clock or settlement engine. Do not let the final tap click through into a modal action.

## Proposed consultation copy

**Title:** Launch Maya under your brand

**Body:** You've placed 10 demo bets. Book a consultation to purchase Maya as your white-label trading game. We'll customise it for your business, launch it for you and hand over the full project source code.

**Primary action:** Book a consultation

**Secondary action:** View my results

**Supporting line:** Your current bets will finish automatically. Refresh this page to play 10 more demo bets.

The secondary action, close button and Escape dismiss the message without increasing the allowance. Restore keyboard focus to the game/status control. Use a readable modal on phones, with appropriate focus handling and no fake urgency, mandatory email form or payment step.

The booking CTA opens the configured consultation URL on an explicit click, preferably in a separate tab so accepted bets remain visible in the demo. No appointment is made automatically. **User-approved temporary behavior: use a dummy URL.** Set `consultationUrl` to `https://example.com` for now. The owner explicitly said “the booking of consultation button can just be a demo url for now” and corrected this to “dummy url”. A real scheduling service is not a prerequisite for this version; replace this single configuration value when one is provided. This placeholder does not create or confirm a booking.

## Material outside the game

Separate sales/product literature should cover branding and customisation; chain and supported markets; odds and liquidity/provider integrations; the buyer's provider onboarding; and purchase scope, launch delivery and source-code handover. This note records that separation but does not invent prices, supported production integrations, timelines or a finished catalogue.

Use the product identity **Maya** and describe it as our white-label game. Euphoria is the experience reference; the CTA does not imply we sell Euphoria's source code or have an affiliation with it.

## Acceptance checks

1. Bets 1–9 work normally without the sales modal; the tenth accepted bet opens it exactly once and remains a valid, settling position.
2. Rejected taps, duplicate requests and settled/refunded bets do not alter the placement count; concurrent rapid taps cannot create an eleventh accepted bet.
3. Dismissing the message leaves the live board/results working with new placements disabled; existing positions settle regardless of modal or market selection.
4. Refresh after zero, nine or ten placements starts a fresh allowance of ten, indefinitely; restored old positions consume none of it and cannot settle twice.
5. The booking CTA opens the configured dummy `https://example.com` URL on explicit click on desktop and phone; the player can dismiss the modal and refresh without booking, signing up or providing contact information. No booking success is fabricated.

**Planning only:** no application, live booking integration, deployment or external vendor agreement was created in this turn.
