# Fabric Ops

Fabric inventory for a multi-store business: roll-level yardage tracking, QR scanning and label printing, order allocation with dye-lot preference, transfers, delivery routes, and native 2-way Shopify sync. Replaces ERPLY, exports to QuickBooks.

One Vercel project = one permanent URL:

- `/` — the app (single-file, offline-capable, installable from the browser)
- `/api/*` — the backend (one serverless function)
- Neon Postgres — system of record: state, 30-revision snapshots, queryable transaction ledger, Shopify order queue

## Quickstart

```bash
npm install
npm run test:app                       # verify the client
vercel login && vercel --prod          # deploy (personal scope is default)
```

Then in the Vercel dashboard: **Storage → Neon Postgres → connect**, and `vercel env add APP_KEY production`, redeploy. Full walkthrough in `docs/DEPLOY.md`; Shopify go-live in the same doc.

## Push to GitHub for auto-deploys

```bash
git init && git add -A && git commit -m "Fabric Ops"
gh repo create fabricops --private --source . --push     # or add a remote manually
```

Then Vercel dashboard → New Project → import the repo. Every push deploys; PRs get preview URLs.

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
