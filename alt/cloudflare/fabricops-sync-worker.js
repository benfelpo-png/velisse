/**
 * Fabric Ops — Shopify Sync Worker
 * Single-file Cloudflare Worker. The native connector between the Fabric Ops
 * app and a Shopify store (custom app, Admin GraphQL API).
 *
 * Endpoints (all except webhooks require X-Api-Key: APP_KEY):
 *   GET  /health              → shop name + location list (for store mapping)
 *   GET  /db                  → { rev, data } current database state
 *   PUT  /db                  → { rev, data, device } compare-and-swap save; 409 + server state on stale rev
 *   GET  /db/snapshots        → last 30 revisions (point-in-time history)
 *   POST /db/restore          → { rev } roll the database back to a snapshot (as a new rev)
 *   POST /webhooks/shopify    → orders/create + orders/updated (HMAC verified), queued in KV
 *   GET  /orders/pending      → queued Shopify orders not yet imported
 *   POST /orders/ack          → { ids:[...] } mark imported, removed from queue
 *   POST /inventory/set       → { items:[{sku, locationId, available, inventoryItemId?}] }
 *   POST /products/push       → { variants:[{variantCode, title, color, productType,
 *                                 description, price, sku, photos[], shopifyProductId?, shopifyVariantId?}] }
 *
 * Required config (wrangler secrets / vars):
 *   SHOPIFY_SHOP            e.g. "dripped-fabrics.myshopify.com"
 *   SHOPIFY_TOKEN           Admin API access token from the custom app (shpat_…)
 *   SHOPIFY_WEBHOOK_SECRET  webhook signing secret from the custom app
 *   APP_KEY                 shared secret; paste the same value into Fabric Ops → Sync → Connector settings
 * Required bindings:
 *   ORDERS                  KV namespace for the pending-order queue
 *   DB                      D1 database (SQLite) — the system of record
 *
 * Shopify custom app scopes: read_orders, write_products, write_inventory, read_locations
 */

const API_VERSION = "2026-07";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // CORS for the Fabric Ops app (runs from file:// or any host)
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    try {
      if (path === "/webhooks/shopify" && request.method === "POST")
        return cors(await handleWebhook(request, env));

      // everything else requires the shared key
      if (request.headers.get("X-Api-Key") !== env.APP_KEY)
        return cors(json({ error: "Unauthorized" }, 401));

      if (path === "/health" && request.method === "GET")
        return cors(await handleHealth(env));
      if (path === "/db" && request.method === "GET")
        return cors(await handleDbGet(env));
      if (path === "/db" && (request.method === "PUT" || request.method === "POST"))
        return cors(await handleDbPut(request, env));
      if (path === "/db/snapshots" && request.method === "GET")
        return cors(await handleSnapshots(env));
      if (path === "/db/restore" && request.method === "POST")
        return cors(await handleRestore(request, env));
      if (path === "/orders/pending" && request.method === "GET")
        return cors(await handlePending(env));
      if (path === "/orders/ack" && request.method === "POST")
        return cors(await handleAck(request, env));
      if (path === "/inventory/set" && request.method === "POST")
        return cors(await handleInventorySet(request, env));
      if (path === "/products/push" && request.method === "POST")
        return cors(await handleProductsPush(request, env));

      return cors(json({ error: "Not found" }, 404));
    } catch (e) {
      return cors(json({ error: e.message || String(e) }, 500));
    }
  },
};

/* ---------------- helpers ---------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type,X-Api-Key");
  return new Response(res.body, { status: res.status, headers: h });
}

async function gql(env, query, variables) {
  const res = await fetch(
    `https://${env.SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors).slice(0, 300));
  return data.data;
}

function userErrors(node) {
  const errs = (node && node.userErrors) || [];
  return errs.map((e) => e.message).join("; ");
}

/* ---------------- /health ---------------- */

async function handleHealth(env) {
  const out = { ok: true, db: !!env.DB, shop: null, locations: [] };
  if (env.SHOPIFY_SHOP && env.SHOPIFY_TOKEN) {
    try {
      const data = await gql(
        env,
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
  return json(out);
}

/* ---------------- database (D1) ---------------- */

async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         rev INTEGER NOT NULL,
         data TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         updated_by TEXT)`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS snapshots (
         rev INTEGER PRIMARY KEY,
         data TEXT NOT NULL,
         at TEXT NOT NULL,
         device TEXT)`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS ledger (
         code TEXT PRIMARY KEY,
         at TEXT, type TEXT, roll_code TEXT, variant_code TEXT,
         yards REAL, prev_yards REAL, new_yards REAL,
         order_number TEXT, person TEXT, notes TEXT)`
    ),
  ]);
}

async function handleDbGet(env) {
  await ensureTables(env);
  const row = await env.DB.prepare("SELECT rev, data, updated_at FROM state WHERE id = 1").first();
  if (!row) return json({ rev: 0, data: null });
  return json({ rev: row.rev, data: JSON.parse(row.data), updatedAt: row.updated_at });
}

async function handleDbPut(request, env) {
  await ensureTables(env);
  const body = await request.json();
  const clientRev = body.rev || 0;
  const device = (body.device || "").slice(0, 60);
  if (!body.data || typeof body.data !== "object")
    return json({ error: "No data" }, 400);

  const row = await env.DB.prepare("SELECT rev, data FROM state WHERE id = 1").first();
  const serverRev = row ? row.rev : 0;
  if (row && clientRev !== serverRev)
    return json(
      { error: "Conflict: server has rev " + serverRev, rev: serverRev, data: JSON.parse(row.data) },
      409
    );

  const newRev = serverRev + 1;
  const dataStr = JSON.stringify(body.data);
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO state (id, rev, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, data=excluded.data,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).bind(newRev, dataStr, at, device),
    env.DB.prepare("INSERT OR REPLACE INTO snapshots (rev, data, at, device) VALUES (?, ?, ?, ?)")
      .bind(newRev, dataStr, at, device),
    env.DB.prepare(
      "DELETE FROM snapshots WHERE rev NOT IN (SELECT rev FROM snapshots ORDER BY rev DESC LIMIT 30)"
    ),
  ]);
  await mirrorLedger(env, body.data);
  return json({ ok: true, rev: newRev });
}

/* append-only mirror of the inventory ledger into a real, queryable SQL table */
async function mirrorLedger(env, data) {
  try {
    const txns = Array.isArray(data.transactions) ? data.transactions : [];
    if (!txns.length) return;
    const last = await env.DB.prepare("SELECT MAX(code) AS c FROM ledger").first();
    const maxCode = (last && last.c) || "";
    const rolls = {}, variants = {}, orders = {}, people = {};
    (data.rolls || []).forEach((r) => (rolls[r.id] = r.code));
    (data.variants || []).forEach((v) => (variants[v.id] = v.code));
    (data.orders || []).forEach((o) => (orders[o.id] = o.number));
    (data.people || []).forEach((p) => (people[p.id] = p.name));
    const fresh = txns.filter((t) => t.code > maxCode).slice(0, 500);
    if (!fresh.length) return;
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO ledger
       (code, at, type, roll_code, variant_code, yards, prev_yards, new_yards, order_number, person, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(
      fresh.map((t) =>
        stmt.bind(
          t.code, t.createdAt || "", t.type || "",
          rolls[t.rollId] || "", variants[t.variantId] || "",
          t.quantityYards ?? 0, t.previousYards ?? 0, t.newYards ?? 0,
          orders[t.orderId] || "", people[t.personId] || "", t.notes || ""
        )
      )
    );
  } catch (e) {
    /* mirror is best-effort; never block a save on it */
  }
}

async function handleSnapshots(env) {
  await ensureTables(env);
  const rows = await env.DB.prepare(
    "SELECT rev, at, device, LENGTH(data) AS bytes FROM snapshots ORDER BY rev DESC LIMIT 30"
  ).all();
  return json({ snapshots: rows.results || [] });
}

async function handleRestore(request, env) {
  await ensureTables(env);
  const { rev } = await request.json();
  const snap = await env.DB.prepare("SELECT data FROM snapshots WHERE rev = ?").bind(rev).first();
  if (!snap) return json({ error: "No snapshot for rev " + rev }, 404);
  const cur = await env.DB.prepare("SELECT rev FROM state WHERE id = 1").first();
  const newRev = ((cur && cur.rev) || 0) + 1;
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO state (id, rev, data, updated_at, updated_by) VALUES (1, ?, ?, ?, 'restore')
       ON CONFLICT(id) DO UPDATE SET rev=excluded.rev, data=excluded.data,
         updated_at=excluded.updated_at, updated_by='restore'`
    ).bind(newRev, snap.data, at),
    env.DB.prepare("INSERT OR REPLACE INTO snapshots (rev, data, at, device) VALUES (?, ?, ?, 'restore of rev ' || ?)")
      .bind(newRev, snap.data, at, rev),
  ]);
  return json({ ok: true, rev: newRev, restoredFrom: rev });
}

/* ---------------- webhooks → KV queue ---------------- */

async function handleWebhook(request, env) {
  const raw = await request.arrayBuffer();
  const hmac = request.headers.get("X-Shopify-Hmac-Sha256") || "";
  const ok = await verifyHmac(raw, hmac, env.SHOPIFY_WEBHOOK_SECRET);
  // Always 200 valid-shaped responses; Shopify retries on non-2xx.
  if (!ok) return json({ error: "HMAC verification failed" }, 401);

  const topic = request.headers.get("X-Shopify-Topic") || "";
  if (!topic.startsWith("orders/")) return json({ ok: true, ignored: topic });

  const order = JSON.parse(new TextDecoder().decode(raw));
  // Only queue paid, unfulfilled, non-cancelled orders.
  if (order.cancelled_at) {
    await env.ORDERS.delete(`order:${order.id}`);
    return json({ ok: true, removed: order.id });
  }
  if (order.financial_status && !["paid", "partially_paid", "authorized"].includes(order.financial_status))
    return json({ ok: true, skipped: order.financial_status });

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
  await env.ORDERS.put(`order:${order.id}`, JSON.stringify(slim), {
    expirationTtl: 60 * 60 * 24 * 30, // 30-day safety expiry
  });
  return json({ ok: true, queued: order.id });
}

async function verifyHmac(rawBody, headerB64, secret) {
  if (!headerB64 || !secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // constant-time-ish compare
  if (expected.length !== headerB64.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ headerB64.charCodeAt(i);
  return diff === 0;
}

/* ---------------- order queue ---------------- */

async function handlePending(env) {
  const list = await env.ORDERS.list({ prefix: "order:" });
  const orders = [];
  for (const k of list.keys.slice(0, 50)) {
    const v = await env.ORDERS.get(k.name);
    if (v) orders.push(JSON.parse(v));
  }
  orders.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  return json({ orders });
}

async function handleAck(request, env) {
  const { ids } = await request.json();
  for (const id of ids || []) await env.ORDERS.delete(`order:${id}`);
  return json({ ok: true, acked: (ids || []).length });
}

/* ---------------- inventory push ---------------- */

async function handleInventorySet(request, env) {
  const { items } = await request.json();
  if (!Array.isArray(items) || !items.length) return json({ error: "No items" }, 400);

  const results = [];
  const errors = [];
  let updated = 0;

  // Resolve inventoryItemIds for items that lack one (lookup by SKU).
  const need = items.filter((i) => !i.inventoryItemId && i.sku);
  const skuMap = {};
  for (const batch of chunk([...new Set(need.map((i) => i.sku))], 10)) {
    const q = batch.map((s) => `sku:'${s.replace(/'/g, "\\'")}'`).join(" OR ");
    const data = await gql(
      env,
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
      env,
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

  return json({ ok: errors.length === 0, updated, errors, results });
}

/* ---------------- product push ---------------- */

async function handleProductsPush(request, env) {
  const { variants } = await request.json();
  if (!Array.isArray(variants) || !variants.length)
    return json({ error: "No variants" }, 400);

  const results = [];
  let created = 0, updated = 0;

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
        env,
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
  return json({ ok: true, created, updated, results });
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
