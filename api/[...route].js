/**
 * Fabric Ops — Sync API (Vercel + Neon Postgres)
 * Catch-all serverless function. Every endpoint lives under /api:
 *
 *   GET  /api/health              → db check + Shopify shop/locations (if configured)
 *   GET  /api/db                  → { rev, data } current database state
 *   POST /api/db                  → { rev, data, device } compare-and-swap save; 409 + server state if stale
 *   GET  /api/db/snapshots        → last 30 revisions
 *   POST /api/db/restore          → { rev } roll back to a snapshot (as a new rev)
 *   POST /api/webhooks/shopify    → orders/create + orders/updated (HMAC verified) → order queue
 *   GET  /api/orders/pending      → queued Shopify orders
 *   POST /api/orders/ack          → { ids } remove imported orders from queue
 *   POST /api/inventory/set       → { items:[{sku, locationId, available, inventoryItemId?}] }
 *   POST /api/products/push       → { variants:[…] } productSet create/update
 *
 * Env vars (Vercel project settings):
 *   DATABASE_URL            provided automatically by the Neon integration
 *   APP_KEY                 shared secret; same value goes in the app's connector settings
 *   SHOPIFY_SHOP            your-store.myshopify.com          (optional until Shopify go-live)
 *   SHOPIFY_TOKEN           Admin API token (shpat_…)         (optional until Shopify go-live)
 *   SHOPIFY_WEBHOOK_SECRET  webhook signing secret            (optional until Shopify go-live)
 *
 * Shopify custom app scopes: read_orders, write_products, write_inventory, read_locations
 */

import crypto from "node:crypto";
import { sql } from "../lib/db.js";

export const config = { api: { bodyParser: false } };

const API_VERSION = "2026-07";

let tablesReady = null;
function ensureTables() {
  if (!tablesReady)
    tablesReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS state (
        id INT PRIMARY KEY CHECK (id = 1),
        rev BIGINT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT)`;
      await sql`CREATE TABLE IF NOT EXISTS snapshots (
        rev BIGINT PRIMARY KEY,
        data JSONB NOT NULL,
        at TIMESTAMPTZ NOT NULL,
        device TEXT)`;
      await sql`CREATE TABLE IF NOT EXISTS ledger (
        code TEXT PRIMARY KEY,
        at TEXT, type TEXT, roll_code TEXT, variant_code TEXT,
        yards DOUBLE PRECISION, prev_yards DOUBLE PRECISION, new_yards DOUBLE PRECISION,
        order_number TEXT, person TEXT, notes TEXT)`;
      await sql`CREATE TABLE IF NOT EXISTS order_queue (
        id BIGINT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    })();
  return tablesReady;
}

/* ---------------- entry ---------------- */

export default async function handler(req, res) {
  const path = routePath(req);

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const raw = await readRaw(req);

    if (path === "/webhooks/shopify" && req.method === "POST")
      return await handleWebhook(req, res, raw);

    if (!process.env.APP_KEY)
      return res.status(500).json({ error: "APP_KEY is not configured" });
    if (req.headers["x-api-key"] !== process.env.APP_KEY)
      return res.status(401).json({ error: "Unauthorized" });

    const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};

    if (path === "/health" && req.method === "GET") return await handleHealth(res);
    if (path === "/db" && req.method === "GET") return await handleDbGet(res);
    if (path === "/db" && (req.method === "POST" || req.method === "PUT"))
      return await handleDbPut(res, body);
    if (path === "/db/snapshots" && req.method === "GET") return await handleSnapshots(res);
    if (path === "/db/restore" && req.method === "POST") return await handleRestore(res, body);
    if (path === "/orders/pending" && req.method === "GET") return await handlePending(res);
    if (path === "/orders/ack" && req.method === "POST") return await handleAck(res, body);
    if (path === "/inventory/set" && req.method === "POST") return await handleInventorySet(res, body);
    if (path === "/products/push" && req.method === "POST") return await handleProductsPush(res, body);

    return res.status(404).json({ error: "Not found: " + path });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}

function routePath(req) {
  const parts = [].concat(req.query.route || []);
  if (parts.length) return "/" + parts.join("/");
  const pathname = new URL(req.url || "/", "http://fabricops.local").pathname;
  return pathname.replace(/^\/api(?=\/|$)/, "") || "/";
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ---------------- shopify helpers ---------------- */

async function gql(query, variables) {
  const r = await fetch(
    `https://${process.env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const data = await r.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data;
}

const userErrors = (n) => ((n && n.userErrors) || []).map((e) => e.message).join("; ");
const shopifyConfigured = () => !!(process.env.SHOPIFY_SHOP && process.env.SHOPIFY_TOKEN);

/* ---------------- /health ---------------- */

async function handleHealth(res) {
  await ensureTables();
  const out = { ok: true, db: true, shop: null, locations: [] };
  if (shopifyConfigured()) {
    try {
      const data = await gql(
        `{ shop { name myshopifyDomain }
           locations(first: 20) { nodes { id name isActive } } }`
      );
      out.shop = data.shop.name;
      out.domain = data.shop.myshopifyDomain;
      out.locations = data.locations.nodes
        .filter((l) => l.isActive)
        .map((l) => ({ id: l.id, name: l.name }));
    } catch (e) {
      out.shopifyError = e.message;
    }
  }
  return res.status(200).json(out);
}

/* ---------------- database ---------------- */

async function handleDbGet(res) {
  await ensureTables();
  const rows = await sql`SELECT rev, data, updated_at FROM state WHERE id = 1`;
  if (!rows.length) return res.status(200).json({ rev: 0, data: null });
  return res
    .status(200)
    .json({ rev: Number(rows[0].rev), data: rows[0].data, updatedAt: rows[0].updated_at });
}

async function handleDbPut(res, body) {
  await ensureTables();
  const clientRev = Number(body.rev || 0);
  const device = String(body.device || "").slice(0, 60);
  if (!body.data || typeof body.data !== "object")
    return res.status(400).json({ error: "No data" });
  const dataStr = JSON.stringify(body.data);

  /* atomic CAS: update only if rev matches */
  const updated = await sql`
    UPDATE state SET rev = rev + 1, data = ${dataStr}::jsonb,
      updated_at = now(), updated_by = ${device}
    WHERE id = 1 AND rev = ${clientRev}
    RETURNING rev`;

  let newRev;
  if (updated.length) {
    newRev = Number(updated[0].rev);
  } else {
    const cur = await sql`SELECT rev, data FROM state WHERE id = 1`;
    if (cur.length)
      return res.status(409).json({
        error: "Conflict: server has rev " + cur[0].rev,
        rev: Number(cur[0].rev),
        data: cur[0].data,
      });
    /* first ever save */
    newRev = clientRev + 1;
    await sql`INSERT INTO state (id, rev, data, updated_at, updated_by)
              VALUES (1, ${newRev}, ${dataStr}::jsonb, now(), ${device})`;
  }

  await sql`INSERT INTO snapshots (rev, data, at, device)
            VALUES (${newRev}, ${dataStr}::jsonb, now(), ${device})
            ON CONFLICT (rev) DO UPDATE SET data = EXCLUDED.data, at = EXCLUDED.at`;
  await sql`DELETE FROM snapshots WHERE rev NOT IN
            (SELECT rev FROM snapshots ORDER BY rev DESC LIMIT 30)`;
  await mirrorLedger(body.data);
  return res.status(200).json({ ok: true, rev: newRev });
}

async function mirrorLedger(data) {
  try {
    const txns = Array.isArray(data.transactions) ? data.transactions : [];
    if (!txns.length) return;
    const last = await sql`SELECT MAX(code) AS c FROM ledger`;
    const maxCode = (last[0] && last[0].c) || "";
    const idx = (arr, key) =>
      Object.fromEntries((arr || []).map((x) => [x.id, x[key]]));
    const rolls = idx(data.rolls, "code"),
      variants = idx(data.variants, "code"),
      orders = idx(data.orders, "number"),
      people = idx(data.people, "name");
    const fresh = txns.filter((t) => t.code > maxCode).slice(0, 500);
    for (const batch of chunk(fresh, 25)) {
      await Promise.all(
        batch.map(
          (t) => sql`INSERT INTO ledger
            (code, at, type, roll_code, variant_code, yards, prev_yards, new_yards, order_number, person, notes)
            VALUES (${t.code}, ${t.createdAt || ""}, ${t.type || ""},
              ${rolls[t.rollId] || ""}, ${variants[t.variantId] || ""},
              ${t.quantityYards ?? 0}, ${t.previousYards ?? 0}, ${t.newYards ?? 0},
              ${orders[t.orderId] || ""}, ${people[t.personId] || ""}, ${t.notes || ""})
            ON CONFLICT (code) DO NOTHING`
        )
      );
    }
  } catch (e) {
    /* mirror is best-effort; never block a save */
  }
}

async function handleSnapshots(res) {
  await ensureTables();
  const rows = await sql`SELECT rev, at, device, LENGTH(data::text) AS bytes
                         FROM snapshots ORDER BY rev DESC LIMIT 30`;
  return res.status(200).json({
    snapshots: rows.map((r) => ({
      rev: Number(r.rev), at: r.at, device: r.device, bytes: Number(r.bytes),
    })),
  });
}

async function handleRestore(res, body) {
  await ensureTables();
  const rev = Number(body.rev);
  const snap = await sql`SELECT data FROM snapshots WHERE rev = ${rev}`;
  if (!snap.length) return res.status(404).json({ error: "No snapshot for rev " + rev });
  const cur = await sql`SELECT rev FROM state WHERE id = 1`;
  const newRev = Number((cur[0] && cur[0].rev) || 0) + 1;
  const dataStr = JSON.stringify(snap[0].data);
  await sql`INSERT INTO state (id, rev, data, updated_at, updated_by)
            VALUES (1, ${newRev}, ${dataStr}::jsonb, now(), 'restore')
            ON CONFLICT (id) DO UPDATE SET rev = EXCLUDED.rev, data = EXCLUDED.data,
              updated_at = EXCLUDED.updated_at, updated_by = 'restore'`;
  await sql`INSERT INTO snapshots (rev, data, at, device)
            VALUES (${newRev}, ${dataStr}::jsonb, now(), ${"restore of rev " + rev})
            ON CONFLICT (rev) DO NOTHING`;
  return res.status(200).json({ ok: true, rev: newRev, restoredFrom: rev });
}

/* ---------------- webhooks → order queue ---------------- */

async function handleWebhook(req, res, raw) {
  const hmac = req.headers["x-shopify-hmac-sha256"] || "";
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (!secret)
    return res.status(401).json({ error: "SHOPIFY_WEBHOOK_SECRET not configured" });
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  const ok =
    hmac.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: "HMAC verification failed" });
  await ensureTables();

  const topic = req.headers["x-shopify-topic"] || "";
  if (!topic.startsWith("orders/"))
    return res.status(200).json({ ok: true, ignored: topic });

  const order = JSON.parse(raw.toString("utf8"));
  if (order.cancelled_at) {
    await sql`DELETE FROM order_queue WHERE id = ${order.id}`;
    return res.status(200).json({ ok: true, removed: order.id });
  }
  if (
    order.financial_status &&
    !["paid", "partially_paid", "authorized"].includes(order.financial_status)
  )
    return res.status(200).json({ ok: true, skipped: order.financial_status });

  const slim = {
    id: order.id,
    name: order.name,
    createdAt: order.created_at,
    email: order.email || (order.customer && order.customer.email) || "",
    customerName: order.customer
      ? `${order.customer.first_name || ""} ${order.customer.last_name || ""}`.trim()
      : "",
    phone: (order.shipping_address && order.shipping_address.phone) || order.phone || "",
    shipping: !!order.shipping_address,
    address: order.shipping_address ? order.shipping_address.address1 : "",
    city: order.shipping_address ? order.shipping_address.city : "",
    zip: order.shipping_address ? order.shipping_address.zip : "",
    lineItems: (order.line_items || []).map((li) => ({
      sku: li.sku || "",
      title: li.title,
      quantity: li.quantity,
      price: li.price,
    })),
  };
  await sql`INSERT INTO order_queue (id, data) VALUES (${order.id}, ${JSON.stringify(slim)}::jsonb)
            ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
  return res.status(200).json({ ok: true, queued: order.id });
}

async function handlePending(res) {
  await ensureTables();
  const rows = await sql`SELECT data FROM order_queue ORDER BY created_at ASC LIMIT 50`;
  return res.status(200).json({ orders: rows.map((r) => r.data) });
}

async function handleAck(res, body) {
  await ensureTables();
  const ids = (body.ids || []).map(Number).filter(Boolean);
  if (ids.length) await sql`DELETE FROM order_queue WHERE id = ANY(${ids})`;
  return res.status(200).json({ ok: true, acked: ids.length });
}

/* ---------------- inventory push ---------------- */

async function handleInventorySet(res, body) {
  if (!shopifyConfigured())
    return res.status(400).json({ error: "Shopify not configured on the server yet" });
  const items = body.items;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: "No items" });

  const results = [];
  const errors = [];
  let updated = 0;

  const need = items.filter((i) => !i.inventoryItemId && i.sku);
  const skuMap = {};
  for (const batch of chunk([...new Set(need.map((i) => i.sku))], 10)) {
    const q = batch.map((s) => `sku:'${s.replace(/'/g, "\\'")}'`).join(" OR ");
    const data = await gql(
      `query($q:String!){ productVariants(first: 50, query:$q)
         { nodes { sku inventoryItem { id } } } }`,
      { q }
    );
    for (const n of data.productVariants.nodes)
      if (n.sku) skuMap[n.sku] = n.inventoryItem.id;
  }

  const quantities = [];
  for (const it of items) {
    const invId = it.inventoryItemId || skuMap[it.sku];
    if (!invId) {
      errors.push(`No Shopify variant for SKU ${it.sku} — push products first`);
      continue;
    }
    quantities.push({
      inventoryItemId: invId,
      locationId: it.locationId,
      quantity: Math.max(0, Math.floor(it.available)),
    });
    results.push({ sku: it.sku, inventoryItemId: invId });
  }

  for (const batch of chunk(quantities, 100)) {
    const data = await gql(
      `mutation($input: InventorySetOnHandQuantitiesInput!) {
         inventorySetOnHandQuantities(input: $input) {
           userErrors { field message } } }`,
      {
        input: {
          reason: "correction",
          referenceDocumentUri: "gid://fabricops/sync",
          setQuantities: batch,
        },
      }
    );
    const errs = userErrors(data.inventorySetOnHandQuantities);
    if (errs) errors.push(errs);
    else updated += batch.length;
  }

  return res.status(200).json({ ok: errors.length === 0, updated, errors, results });
}

/* ---------------- product push ---------------- */

async function handleProductsPush(res, body) {
  if (!shopifyConfigured())
    return res.status(400).json({ error: "Shopify not configured on the server yet" });
  const variants = body.variants;
  if (!Array.isArray(variants) || !variants.length)
    return res.status(400).json({ error: "No variants" });

  const results = [];
  let created = 0,
    updated = 0;

  for (const v of variants) {
    try {
      const title = `${v.title} — ${v.color}`;
      const media = (v.photos || []).map((u) => ({
        originalSource: u,
        mediaContentType: "IMAGE",
      }));
      const productInput = {
        title,
        descriptionHtml: v.description || "",
        productType: v.productType || "",
        status: "ACTIVE",
        variants: [
          {
            price: String(v.price ?? "0"),
            sku: v.sku,
            inventoryItem: { tracked: true },
            inventoryPolicy: "DENY",
          },
        ],
      };
      if (v.shopifyProductId) productInput.id = v.shopifyProductId;

      const data = await gql(
        `mutation($input: ProductSetInput!, $media: [CreateMediaInput!]) {
           productSet(input: $input, media: $media) {
             product { id variants(first: 1) { nodes { id sku inventoryItem { id } } } }
             userErrors { field message } } }`,
        { input: productInput, media: media.length ? media : undefined }
      );
      const errs = userErrors(data.productSet);
      if (errs) {
        results.push({ variantCode: v.variantCode, error: errs });
        continue;
      }
      const p = data.productSet.product;
      const pv = p.variants.nodes[0] || {};
      results.push({
        variantCode: v.variantCode,
        productId: p.id,
        variantId: pv.id,
        inventoryItemId: pv.inventoryItem && pv.inventoryItem.id,
      });
      v.shopifyProductId ? updated++ : created++;
    } catch (e) {
      results.push({ variantCode: v.variantCode, error: e.message });
    }
  }
  return res.status(200).json({ ok: true, created, updated, results });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
