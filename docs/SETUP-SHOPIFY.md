# Fabric Ops ↔ Shopify Connector — Setup

The connector is one Cloudflare Worker (free tier is enough) plus a Shopify custom app on your store. Fifteen minutes end to end.

## 1. Create the Shopify custom app

Shopify admin → Settings → Apps and sales channels → Develop apps → Create an app ("Fabric Ops Sync").

Configure Admin API scopes:
- `read_orders`
- `write_products`
- `write_inventory`
- `read_locations`

Install the app, then copy the **Admin API access token** (shpat_…). You only see it once.

## 2. Deploy the worker

```bash
npm install -g wrangler
wrangler login
cd worker
npx wrangler kv namespace create ORDERS   # paste the id into wrangler.toml
npx wrangler d1 create fabricops          # paste the database_id into wrangler.toml
# edit wrangler.toml: set SHOPIFY_SHOP to your-store.myshopify.com
npx wrangler secret put SHOPIFY_TOKEN            # the shpat_ token
npx wrangler secret put APP_KEY                  # invent a long random string
npx wrangler deploy
```

Note the deployed URL, e.g. `https://fabricops-sync.yourname.workers.dev`.

## 3. Register webhooks

Shopify admin → Settings → Notifications → Webhooks → Create webhook:
- Event: **Order creation**, format JSON, URL: `https://<worker-url>/webhooks/shopify`
- Repeat for **Order update** (catches cancellations, which clear the queue).

Copy the **webhook signing secret** shown at the bottom of the webhooks page, then:

```bash
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
```

## 4. Connect the app

Fabric Ops → More → Sync & export → **Connect Shopify**:
- Worker URL: the deployed URL
- API key: the same APP_KEY value
- Tap **Test connection** — it lists your Shopify locations; paste each location ID into the store mapping.
- Optionally enable **auto-push** so every cut, receive, adjustment, and transfer syncs inventory within seconds.

## 5. First sync order of operations

1. **Push products** — creates/updates Shopify products from your variants (title, color, price, SKU, up to 3 photos) and stores the Shopify IDs back on each variant.
2. **Push inventory** — sets on-hand per location from sellable yardage (excludes reserved, damaged, on-hold, in-transit, truck, and staging stock).
3. Place a test order in Shopify → **Pull new orders** — it imports, matches SKUs, creates the customer, and auto-reserves rolls FIFO with dye-lot preference. Already-imported orders are skipped by Shopify order ID.

## The database

The worker carries a real SQLite database (Cloudflare D1) that is the system of record:

- **Shared state.** Every device connected with the same worker URL and key reads and writes the same data. The app saves locally first (works offline), then syncs to D1 with optimistic locking — if two people save at once, the second pulls the winner's state and is told so.
- **History.** Every cloud save keeps a snapshot (last 30 revisions). Sync page → Database → History lets you roll back to any of them; a restore is itself a new revision, so nothing is ever destroyed.
- **Queryable ledger.** Every inventory transaction is mirrored into a `ledger` SQL table. Query it directly for accounting or audits:

```bash
npx wrangler d1 execute fabricops --command \
  "SELECT type, SUM(yards) FROM ledger WHERE at >= '2026-07-01' GROUP BY type"
```

No worker configured? The app still persists in the browser's localStorage on each device — it just isn't shared.

## Conflict rules (as designed in the integration spec)

- Inventory: Fabric Ops wins. Never edit quantities in Shopify admin.
- Products/prices: Fabric Ops wins on push.
- Orders: Shopify wins; the app fulfills, never edits upstream.
