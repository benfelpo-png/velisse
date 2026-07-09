# Fabric Ops: Integration & Migration Spec

ERPLY migration mapping, QuickBooks Online accounting design, and Shopify 2-way sync architecture for the Fabric Ops inventory system. Companion to the app build and the functional spec.

The app already ships the file-based version of everything below: ERPLY-format product and stock exports, a QBO journal export driven by the transaction ledger, Shopify product/inventory CSV export and order CSV import, and a sync log. This document covers the field mappings behind those exports and what a hosted sync worker needs to do to make the integrations live and bidirectional.

---

## 1. ERPLY migration mapping

Goal: move off ERPLY without losing product, stock, customer, or pricing history, and keep the ability to re-export back to ERPLY format if you ever need to run both in parallel.

### 1.1 Products

ERPLY products flatten the hierarchy. Fabric Ops splits it. Migration goes one direction cleanly (ERPLY → Fabric Ops needs grouping decisions), and the reverse is automatic.

| ERPLY field | Fabric Ops field | Notes |
|---|---|---|
| Product code | `product_variants.variant_code` | One ERPLY product = one color variant. |
| Product name | `product_variants.variant_display_name` | |
| Product group | `fabric_types.type_name` | Group tree maps to Family → Type. Two-level ERPLY groups map directly. |
| Sales price | `product_variants.sale_price_per_yard` | ERPLY price list rows beyond the base price need a manual decision (see 1.4). |
| Cost | `product_variants.unit_cost_per_yard` | Roll-level landed cost supersedes this after migration. |
| Code 2 (EAN/UPC) | `sellable_skus.sku` or Shopify SKU | |
| Unit | `sellable_skus.uom` | ERPLY "unit" (m/yd) becomes the yard SKU's UOM. Convert meters to yards at 1.09361 during import. |
| Status | `product_variants.active` | ACTIVE/ARCHIVED → boolean. |
| Description, extra fields | `product_templates.description` | Template-level, shared across colors. |

Import procedure: export ERPLY products to CSV, group rows by design name (strip the color suffix from product names), create one template per design, one variant per row. The app's ERPLY product export (`More → Sync & Export`) produces the exact reverse format for verification.

### 1.2 Stock

ERPLY tracks quantity per warehouse. Fabric Ops tracks physical rolls. This is the one mapping that adds information rather than transforming it, so migration requires a physical count.

| ERPLY concept | Fabric Ops concept | Migration action |
|---|---|---|
| Warehouse | `stores` + `warehouse_locations` | Create one store per ERPLY warehouse; add bins as you go. |
| Stock quantity per product per warehouse | One or more `fabric_rolls` | Cannot be split automatically. Do a roll-level receive count: for each variant with ERPLY stock, receive each physical roll with its measured yards, lot, and bin. |
| FIFO cost layers | `fabric_rolls.cost_per_yard` per roll | Assign the ERPLY average or last-purchase cost per roll at receive time. |
| Inventory registration | `receive` transactions | Every migrated roll creates a receive ledger entry, so opening inventory is fully audited. |

Practical sequence: freeze ERPLY sales for a weekend, run the ERPLY stock report as the control total, receive rolls store-by-store in Fabric Ops, then reconcile total yards per variant per store against the ERPLY report. Variances become `cycle_count_variance` adjustments, not silent edits.

### 1.3 Customers and suppliers

| ERPLY field | Fabric Ops field |
|---|---|
| Customer name, email, phone | `customers.name/email/phone` |
| Address fields | `customers.address/city/postal` |
| Customer group (wholesale/retail) | tag on customer record; pricing handled per order |
| Supplier name | `suppliers.name` |

ERPLY sales history does not migrate as transactions. Keep an ERPLY CSV archive of historical invoices; Fabric Ops starts its ledger at the opening receive.

### 1.4 What does not map

- ERPLY price lists / customer-group pricing: Fabric Ops prices at the variant with per-order overrides. If wholesale tiers matter, they belong in the sync worker layer or as separate wholesale SKUs.
- ERPLY promotions, coupons, gift cards: out of scope; Shopify owns promotions post-migration.
- ERPLY POS Z-reports: replaced by the transaction ledger plus QBO journals.

---

## 2. QuickBooks Online accounting design

Principle: the inventory transaction ledger is the single source of truth, and every ledger row maps deterministically to a journal line. The app's QBO journal export already implements these rules; a hosted worker would post the same journals via the QBO API instead of CSV.

### 2.1 Chart of accounts

| Account | Type | Role |
|---|---|---|
| Inventory Asset | Other Current Asset | Value of fabric on hand at cost. |
| Cost of Goods Sold | COGS | Cost relief when yardage is sold or sampled. |
| Sales of Product Income | Income | Revenue (posted from Shopify/POS settlement, not from the inventory ledger). |
| Accounts Payable | Liability | Offset for receipts until the supplier bill is entered. |
| Inventory Shrinkage | COGS or Expense | Damage, negative adjustments, count variances. |

Account names are editable in the app (`Sync → QBO accounts`) so the export matches your existing QBO chart exactly.

### 2.2 Journal rules (implemented in the export)

| Ledger event | Debit | Credit | Amount |
|---|---|---|---|
| `receive`, `return` | Inventory Asset | Accounts Payable | yards × roll cost/yd |
| `sale`, `sample_cut` | COGS | Inventory Asset | yards cut × roll cost/yd |
| `damage`, negative `adjustment`, `cycle_count_variance` (short) | Inventory Shrinkage | Inventory Asset | yards × cost |
| positive `adjustment`, variance (over) | Inventory Asset | Inventory Shrinkage | yards × cost |
| `transfer`, `reserve`, `release_reservation` | — no journal — | | Location moves and reservations are not accounting events. |

Cost basis is the roll's `cost_per_yard` (falls back to variant cost), which makes this a specific-identification costing method. That is defensible for fabric because each roll genuinely has its own landed cost, and it is more accurate than ERPLY's warehouse-average FIFO.

Revenue side: do not journal sales revenue from the inventory ledger. Revenue posts from the sales channel (Shopify payout sync or POS daily summary) so that discounts, tax, and fees reconcile to actual settlement. The inventory ledger only moves cost. This split is what keeps QBO clean at scale.

### 2.3 Cadence and reconciliation

- Export/post journals weekly or monthly, grouped by day.
- Month-end check: QBO Inventory Asset balance should equal the app's Valuation report (cost basis) within pennies. If it drifts, the ledger export is the audit trail.
- Supplier bills: enter the actual bill in QBO against Accounts Payable; the receive journal already accrued the inventory side.

### 2.4 Going live via API

The in-app export produces a QBO-importable journal CSV. Full automation needs a small hosted worker using the QBO Accounting API (`JournalEntry` object, OAuth2). The worker reads the app's ledger (via the JSON backup or a future API), dedupes on transaction code (TXN-…), and posts entries idempotently. Nothing about the journal logic changes; only the transport does.

---

## 3. Shopify 2-way sync

### 3.1 Object mapping

| Fabric Ops | Shopify | Direction |
|---|---|---|
| Product template | Product | push |
| Product variant (color) | Product option value or standalone product | push |
| Sellable SKU (yard) | Variant with SKU, price | push |
| Three photo slots | Product media (positions 1–3) | push |
| Available yards per variant (sellable rolls only) | InventoryLevel | push |
| Shopify order + line items | Order + line items → allocation → cut | pull |
| Fulfillment status | FulfillmentOrder | push |

Key rule from the functional spec, preserved: rolls are never Shopify products. Shopify sees one variant with a yardage quantity; the roll/lot detail stays internal. Available quantity = Σ over sellable rolls of (current − reserved), excluding rolls on trucks, in staging, in transit, on hold, or damaged. This is exactly what the app's `rollSellable` logic computes and what the inventory CSV export publishes.

### 3.2 Push pipeline (app → Shopify)

Triggers that change available yardage and must push an inventory update: receive, cut/sale, sample cut, adjustment, damage, transfer dispatch (source down), transfer receive (destination up), reservation, release, order cancel.

Worker behavior:
1. Watch the ledger + allocations for changes (poll the backup JSON or subscribe when the app grows an API).
2. Recompute available per variant per Shopify location (map each store to a Shopify Location ID).
3. Push via GraphQL Admin API `inventorySetOnHandQuantities` (or `inventoryAdjustQuantities` for deltas).
4. Product/media pushes use `productSet` with the three photo URLs as media; the app already stores `shopify_product_id` / `shopify_variant_id` on the variant for idempotent updates.
5. Log every push to `shopify_sync_log` with status and error for retry.

### 3.3 Pull pipeline (Shopify → app)

1. Subscribe to `orders/create` and `orders/updated` webhooks (paid/unfulfilled filter).
2. For each order: upsert customer, create order with `shopify_order_id`, create line items by SKU match, auto-allocate (FIFO, dye-lot preference — same routine the app runs for manual orders).
3. When staff record the cut and the order completes in the app, push fulfillment back to Shopify with tracking if shipped.
4. Refunds/cancellations pull back as `release_reservation` or `return` transactions.

The app's CSV order import (`Sync → Import Shopify orders`) is the manual version of this pull and stays useful as the fallback when the worker is down.

### 3.4 Conflict rules

- Inventory: the app wins. Shopify quantity is a projection of the roll ledger, never edited in Shopify admin.
- Price and description: the app wins on push; make edits in Fabric Ops.
- Orders: Shopify wins. The app never edits a Shopify order upstream; it only fulfills or refunds through the API.
- Oversell (two channels sell the last yards): allocation fails in the app, order flags unfulfillable, staff resolve with a substitute lot or refund. The fast inventory push after every cut keeps this window small.

### 3.5 The connector (built)

The connector ships alongside the app as `fabricops-sync-worker.js`, a single-file Cloudflare Worker that acts as the Shopify custom app backend. It owns the Admin API token, verifies webhook HMACs, queues incoming orders in KV, and exposes an authenticated API the app calls directly:

| Endpoint | Purpose |
|---|---|
| `GET /health` | Shop check + Shopify location list for store mapping |
| `POST /webhooks/shopify` | orders/create + orders/updated, HMAC-verified, queued; cancellations clear the queue |
| `GET /orders/pending` → `POST /orders/ack` | Pull-and-acknowledge order queue, deduped by Shopify order ID |
| `POST /inventory/set` | `inventorySetOnHandQuantities` per SKU per location; resolves inventory item IDs by SKU on first push |
| `POST /products/push` | `productSet` create/update with photos as media; returns Shopify IDs the app stores per variant |

The app side is built in too: connector settings (worker URL, shared key, store→location mapping), Test connection, manual push/pull buttons, and an optional auto-push that debounces a live inventory sync 4 seconds after any stock-changing ledger event (cut, receive, adjust, damage, reserve, release, transfer). Setup takes ~15 minutes: create the custom app in Shopify admin with `read_orders`, `write_products`, `write_inventory`, `read_locations` scopes, deploy the worker with wrangler, register two webhooks. Full steps in `worker/SETUP.md`.

QBO remains file-based for now; the same worker is the natural home for a QBO journal poster later.

### 3.6 The database

The worker also carries the system of record: a Cloudflare D1 (SQLite) database with three tables.

| Table | Role |
|---|---|
| `state` | Current full application state, one row, with a revision number |
| `snapshots` | Last 30 revisions for point-in-time restore (a restore is itself a new revision) |
| `ledger` | Append-only SQL mirror of every inventory transaction — queryable directly with `wrangler d1 execute` for audits and accounting |

Sync model: each device saves locally first (localStorage, so the app works offline and in a plain browser with no worker at all), then pushes to D1 with optimistic locking on the revision number. A stale push gets a 409 with the server state; the app adopts it and tells the user. Device identity (which store and person you are) stays local and is never overwritten by a pull. Every device configured with the same worker URL and key shares one database, which is what makes the multi-store, multi-person workflows (transfers, deliveries, cutting queue) actually multi-user.

---

## 4. Migration sequence (recommended)

1. Build catalog in Fabric Ops (families → types → templates → variants → photo slots), or import from the ERPLY product CSV per §1.1.
2. Physical roll count and receive per §1.2; reconcile against ERPLY stock report.
3. Run both systems for one week with Fabric Ops as source of truth for stock; ERPLY read-only.
4. Point Shopify inventory at Fabric Ops exports (manual CSV at first, worker later).
5. First month-end: post QBO journal export, reconcile Inventory Asset to the valuation report.
6. Decommission ERPLY; keep its final exports archived.
