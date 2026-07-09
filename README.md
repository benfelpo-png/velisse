# Velisse Fabric Inventory

Fabric inventory for a multi-store business: roll-level yardage tracking, QR scanning and label printing, order allocation with dye-lot preference, transfers, delivery routes, and native 2-way Shopify sync. Replaces ERPLY, exports to QuickBooks.

Canonical project links established on July 9, 2026:

- GitHub repo: `https://github.com/benfelpo-png/velisse`
- Vercel project: `https://vercel.com/velisse-fabrics/velisse`
- Current deployment host: `https://velisse-velisse-fabrics.vercel.app`
- API base: `https://velisse-velisse-fabrics.vercel.app/api`

One Vercel project = one app and API:

- `/` — the app (single-file, offline-capable, installable from the browser)
- `/api/*` — the backend (one serverless function)
- Neon Postgres — system of record: state, 30-revision snapshots, queryable transaction ledger, Shopify order queue

## Quickstart

```bash
npm install
npm run test:app                       # verify the client
vercel login && vercel --prod          # deploy (personal scope is default)
```

Then in the Vercel dashboard for `velisse-fabrics/velisse`: **Storage -> Neon Postgres -> connect**, add `APP_KEY`, and redeploy. Full walkthrough in `docs/DEPLOY.md`; Shopify go-live is in `docs/SETUP-SHOPIFY.md`.

## Existing GitHub Remote

```bash
git remote set-url origin https://github.com/benfelpo-png/velisse.git
git push origin main
```

The repo is already connected locally and pushed to `benfelpo-png/velisse`. Vercel should import or redeploy from that repo only; do not create a separate replacement repo or use an unrelated Vercel site.

## Working on it

Read `AGENTS.md` first — it's written for Cursor/Codex and defines the architecture rules (the transaction ledger is sacred, sync is compare-and-swap, rolls are never Shopify products). Tests:

```bash
npm run test:app                                   # no dependencies
TEST_PG_URL=postgresql://... npm run test:api      # any scratch Postgres; drops tables
```

CI runs both on every push.

## Docs

- `docs/DEPLOY.md` — Vercel + Neon + Shopify go-live
- `docs/SETUP-SHOPIFY.md` — Shopify custom app details
- `docs/Fabric_Ops_Integration_and_Migration_Spec.md` — ERPLY field mapping, QuickBooks journal rules, Shopify sync design and conflict rules
