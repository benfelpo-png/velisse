# Fabric Ops — Agent Guide

Fabric inventory system for a multi-store fabric business. Roll-level yardage tracking, order allocation, transfers, deliveries, and native Shopify sync. Replaces ERPLY. Deployed as a single Vercel project: static app at `/`, serverless API at `/api/*`, Neon Postgres as the system of record.

## Layout

| Path | What it is |
|---|---|
| `public/index.html` | The entire client app. One file, deliberately: vanilla JS, no build step, no framework. ~4,500 lines organized in banner-commented sections (`/* ==== rolls ==== */` etc.). |
| `api/[...route].js` | The entire backend. One catch-all Vercel function: database CAS sync, snapshots, Shopify webhooks/queue, inventory + product push via Admin GraphQL. |
| `lib/db.js` | `sql` template tag. Neon HTTP driver in production, plain `pg` when `TEST_PG_URL` is set. Same queries both ways. |
| `tests/` | `app.smoke.test.mjs` (no deps needed) and `api.integration.test.mjs` (needs Postgres). |
| `docs/` | Deploy guide, Shopify setup, and the ERPLY/QuickBooks/Shopify integration spec. Read the spec before touching sync logic. |
| `alt/cloudflare/` | Earlier Cloudflare Worker port of the API. Not deployed. Ignore unless explicitly asked to target Cloudflare. |

## Commands

```bash
npm install
npm run test:app          # headless smoke of the client (fast, no DB)
TEST_PG_URL=postgresql://... npm run test:api   # full API integration (drops/recreates tables!)
npm run deploy            # vercel --prod
```

CI runs both on every push (`.github/workflows/ci.yml`).

## Architecture rules (do not break these)

1. **The transaction ledger is the source of truth.** Every yardage change goes through `txn()` in the client. Never mutate `roll.currentYards` directly. The ledger drives the QuickBooks export and is mirrored to the `ledger` SQL table server-side.
2. **Rolls are never Shopify products.** Shopify sees one variant with a yardage quantity. Sellable availability = Σ(current − reserved) over rolls that pass `rollSellable()` (excludes hold, damaged-archived, truck, staging, in-transit).
3. **Sync is CAS on a revision number.** Client saves locally first (offline-safe), then `POST /api/db` with its rev. Stale rev → 409 + server state → client adopts and re-renders. Don't replace this with last-write-wins.
4. **Conflict ownership:** inventory and prices, the app wins; orders, Shopify wins. See `docs/Fabric_Ops_Integration_and_Migration_Spec.md` §3.4.
5. **Device identity stays local.** `settings.storeId` / `settings.personId` are per-device and must survive a cloud pull (see `cloudPull` in the client).
6. **Views return strings.** Every `v*()` function returns HTML; the router assigns it to `#view`. Don't introduce el-mutating views.
7. **Secrets live in Vercel env vars only** (`APP_KEY`, `SHOPIFY_*`, `DATABASE_URL`). Never in the client, never committed.

## Conventions

- Client code is compact vanilla JS with template literals. Match the existing style; don't introduce a framework or build step.
- All API responses are JSON. Auth is the `X-Api-Key` header checked against `APP_KEY`, except `/api/webhooks/shopify` which is HMAC-verified instead.
- IDs are `uid()` strings; human codes are sequential (`ROLL-000001`, `SO-000001`, `TXN-0000001`). Ledger mirroring relies on `TXN-` codes being lexically ordered.
- After changing `public/index.html`, run `npm run test:app`. After changing `api/` or `lib/`, run the integration test.

## Known gaps (fine to pick up as tasks)

- No login gate on the page itself (data is key-gated; page is a shell without it). A per-person PIN gate is the designed next step.
- QuickBooks is CSV export only; the API poster would live in `api/` per spec §2.4.
- Photo slots store URLs; direct upload (Vercel Blob) is unbuilt.
