# Velisse Shopify Connector Setup

The Shopify connector now runs inside the established Vercel project:

- GitHub repo: `https://github.com/benfelpo-png/velisse`
- Vercel project: `https://vercel.com/velisse-fabrics/velisse`
- Current deployment host: `https://velisse-velisse-fabrics.vercel.app`
- API base: `https://velisse-velisse-fabrics.vercel.app/api`

Do not use the old Cloudflare Worker/D1 setup for production. The Vercel function in `api/[...route].js` owns the database sync, Shopify order queue, inventory pushes, and product pushes.

## 1. Confirm Vercel

In Vercel project `velisse-fabrics/velisse`, confirm these env vars exist:

```text
DATABASE_URL
APP_KEY
```

`DATABASE_URL` is created by the Neon Postgres integration. `APP_KEY` is the shared secret pasted into the app connector settings. Never commit either value.

Deployment Protection must allow devices and Shopify to reach `/api/*`. If `/api/health` returns Vercel login HTML, Shopify webhooks and app sync will not work.

## 2. Create The Shopify Custom App

Shopify admin -> Settings -> Apps and sales channels -> Develop apps -> Create an app named:

```text
Velisse Inventory Sync
```

Configure Admin API scopes:

```text
read_orders
write_products
write_inventory
read_locations
```

Install the app, then copy the Admin API access token. You only see it once.

## 3. Add Shopify Env Vars In Vercel

In Vercel -> `velisse-fabrics/velisse` -> Settings -> Environment Variables, add:

```text
SHOPIFY_SHOP=your-store.myshopify.com
SHOPIFY_TOKEN=shpat_...
```

Redeploy after saving env vars.

## 4. Register Shopify Webhooks

In Shopify admin -> Settings -> Notifications -> Webhooks, create:

```text
Event: Order creation
Format: JSON
URL: https://velisse-velisse-fabrics.vercel.app/api/webhooks/shopify
```

Create another webhook:

```text
Event: Order update
Format: JSON
URL: https://velisse-velisse-fabrics.vercel.app/api/webhooks/shopify
```

Copy the webhook signing secret from Shopify, then add it to Vercel:

```text
SHOPIFY_WEBHOOK_SECRET=...
```

Redeploy again.

## 5. Connect The App

Open the Velisse app, then go to More -> Sync & export -> Connect Shopify.

Use:

```text
Worker URL: https://velisse-velisse-fabrics.vercel.app/api
API key:    the APP_KEY value from Vercel
```

Tap Test connection. It should return JSON from `/api/health` and list Shopify locations once Shopify env vars are present.

## 6. First Sync Order

1. Push products.
2. Push inventory.
3. Place a Shopify test order.
4. Pull new orders.
5. Confirm the order imports and auto-reserves rolls.

Conflict ownership remains:

- Inventory: Velisse wins. Never edit quantities in Shopify admin.
- Products/prices: Velisse wins on push.
- Orders: Shopify wins; Velisse imports and fulfills.
