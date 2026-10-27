# Feed relay data provenance

Every file in this folder is **self-generated** by `apps/feed-relay/scripts/generate-data.mjs`. Seeds are fixed, so you can regenerate it exactly. It contains no data captured from Lynx, Gridy, Pyth or any exchange. Licence: **CC0-1.0** (public domain dedication).

| File | Content |
|---|---|
| `maya-config.json` | Pricing config served at `/api/config` (house edge 0.10, minimum payout 1.01x, minimum delay 3 s). These are operator defaults. Change them to suit your product. |
| `maya-domain-table.json` | Domain table served at `/api/table`. Runtime quotes come from the Maya path model (`packages/pricing`). This table only limits which boxes can be quoted. Its values are a simple Brownian approximation. |
| `replay-btc-usd.json`, `replay-eth-usd.json` | One hour of synthetic 1 s prices (seeded geometric Brownian motion). They play back ping-pong, so the loop has no price jump. They are **not real market prices**. |

`feedId` values are the public Pyth price-feed identifiers that `@maya/config` uses as market identity keys. They are not data.
