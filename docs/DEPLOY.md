# Fabric Ops on Vercel — Deploy

One project, one permanent URL. The app lives at `/`, the API and database live under `/api`.

## Deploy (from this folder)

```bash
npm install -g vercel
vercel login                 # log in with your personal account
vercel --prod                # personal scope is the default; accept the prompts
```

That prints your permanent URL, e.g. `https://fabricops.vercel.app`.
(If your account has teams, force personal scope with `vercel --prod --scope <your-username>`.)

## Add the database (2 minutes)

Vercel dashboard → your project → **Storage** → **Create Database** → **Neon Postgres** → connect to this project. That injects `DATABASE_URL` automatically. Tables create themselves on first use.

Then set the app key:

```bash
vercel env add APP_KEY production      # paste a long random string
vercel --prod                          # redeploy to pick up env vars
```

## Connect the app

Open `https://<your-url>` → More → Sync & export → **Connect Shopify**:
- Worker URL: `https://<your-url>/api`
- API key: the APP_KEY value

From that moment the cloud database is live: every device with the URL + key shares the same data, with snapshot history and the SQL ledger mirror. Shopify can wait — the database works without it.

## Shopify go-live (when ready)

1. Shopify admin → Settings → Apps → Develop apps → create "Fabric Ops Sync" with scopes `read_orders`, `write_products`, `write_inventory`, `read_locations`. Install, copy the Admin API token.
2. ```bash
   vercel env add SHOPIFY_SHOP production              # your-store.myshopify.com
   vercel env add SHOPIFY_TOKEN production             # shpat_…
   ```
3. Shopify admin → Settings → Notifications → Webhooks → add **Order creation** and **Order update**, JSON, pointing at `https://<your-url>/api/webhooks/shopify`. Copy the signing secret shown on that page:
   ```bash
   vercel env add SHOPIFY_WEBHOOK_SECRET production
   vercel --prod
   ```
4. In the app: Test connection → paste Shopify location IDs into the store mapping → Push products → Push inventory → place a test order → Pull new orders.

## Querying the database directly

Neon dashboard → SQL editor (or `psql $DATABASE_URL`):

```sql
SELECT type, SUM(yards) FROM ledger WHERE at >= '2026-07-01' GROUP BY type;
SELECT rev, at, device FROM snapshots ORDER BY rev DESC;
```

## Optional hardening

- Custom domain: project → Settings → Domains (e.g. `ops.yourdomain.com`).
- Gate the page itself: project → Settings → Deployment Protection (the data is already gated by APP_KEY either way).
