/**
 * Integration test of the API function against a real PostgreSQL database.
 * Requires TEST_PG_URL, e.g. postgresql://postgres@localhost:5432/fabricops_test
 * Tables are dropped and recreated. Run: npm run test:api
 */
import crypto from "node:crypto";

if (!process.env.TEST_PG_URL) {
  console.error("Set TEST_PG_URL to a scratch Postgres database first.");
  process.exit(1);
}
process.env.APP_KEY = "testkey";
process.env.SHOPIFY_WEBHOOK_SECRET = "s3cret";

const { sql } = await import("../lib/db.js");
await sql`DROP TABLE IF EXISTS state, snapshots, ledger, order_queue`;
const handler = (await import("../api/[...route].js")).default;

let failures = 0;
const check = (name, cond) => { console.log((cond ? "  ok " : "FAIL ") + name); if (!cond) failures++; };

function mkReq(method, route, headers = {}, rawBuf = null) {
  const L = {};
  const r = { method, query: { route }, headers,
    on(ev, fn) { L[ev] = fn; if (ev === "end") setTimeout(() => { if (rawBuf && L.data) L.data(rawBuf); L.end(); }, 0); return r; } };
  return r;
}
function mkRes() { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(o) { r.body = o; return r; }, end() { return r; } }; return r; }
const K = { "x-api-key": "testkey" };
const call = async (method, route, body, extra) => {
  const r = mkRes();
  await handler(mkReq(method, route, { ...K, ...(extra || {}) }, body ? Buffer.from(JSON.stringify(body)) : null), r);
  return r;
};

let r = await call("GET", ["health"]);
check("health reports db, no shopify", r.code === 200 && r.body.db === true && r.body.shop === null);

r = await call("GET", ["db"]);
check("empty database is rev 0", r.code === 200 && r.body.rev === 0 && r.body.data === null);

const state1 = { settings: { lowStockYards: 15 },
  rolls: [{ id: "r1", code: "ROLL-000001" }], variants: [{ id: "v1", code: "SEQ-GLD" }],
  orders: [], people: [{ id: "p1", name: "Ben A." }],
  transactions: [{ code: "TXN-0000001", createdAt: "2026-07-08", type: "receive", rollId: "r1", variantId: "v1", quantityYards: 42, previousYards: 0, newYards: 42, personId: "p1", notes: "first" }] };
r = await call("POST", ["db"], { rev: 0, data: state1, device: "Ben A." });
check("first save becomes rev 1", r.code === 200 && r.body.rev === 1);

const state2 = structuredClone(state1);
state2.transactions.unshift({ code: "TXN-0000002", createdAt: "2026-07-08", type: "sale", rollId: "r1", variantId: "v1", quantityYards: -2.5, previousYards: 42, newYards: 39.5, personId: "p1", notes: "cut" });
r = await call("POST", ["db"], { rev: 1, data: state2, device: "Ben A." });
check("CAS save advances to rev 2", r.code === 200 && r.body.rev === 2);

r = await call("POST", ["db"], { rev: 1, data: state1, device: "Sasha L." });
check("stale rev returns 409 with server state", r.code === 409 && r.body.rev === 2 && !!r.body.data);

r = await call("GET", ["db", "snapshots"]);
check("snapshot history kept", r.code === 200 && r.body.snapshots.length === 2);

r = await call("POST", ["db", "restore"], { rev: 1 });
check("restore creates new rev", r.code === 200 && r.body.rev === 3 && r.body.restoredFrom === 1);
r = await call("GET", ["db"]);
check("restored state is rev 1 content", r.body.data.transactions.length === 1);

const ledger = await sql`SELECT code, type, roll_code, person FROM ledger ORDER BY code`;
check("ledger mirror queryable via SQL", ledger.length === 2 && ledger[1].type === "sale" && ledger[1].person === "Ben A.");

const order = { id: 9001, name: "#1001", created_at: "2026-07-08T12:00:00Z", financial_status: "paid",
  email: "a@b.com", customer: { first_name: "Test", last_name: "Buyer" },
  shipping_address: { address1: "1 Main", city: "BK", zip: "11201", phone: "555" },
  line_items: [{ sku: "SEQ-GLD-YD", title: "Gold Sequin", quantity: 2, price: "39.00" }] };
const raw = Buffer.from(JSON.stringify(order));
const hmac = crypto.createHmac("sha256", "s3cret").update(raw).digest("base64");
let wr = mkRes();
await handler(mkReq("POST", ["webhooks", "shopify"], { "x-shopify-hmac-sha256": hmac, "x-shopify-topic": "orders/create" }, raw), wr);
check("valid webhook queues order", wr.code === 200 && wr.body.queued === 9001);

wr = mkRes();
await handler(mkReq("POST", ["webhooks", "shopify"], { "x-shopify-hmac-sha256": "bad", "x-shopify-topic": "orders/create" }, raw), wr);
check("bad HMAC rejected", wr.code === 401);

r = await call("GET", ["orders", "pending"]);
check("pending returns queued order", r.body.orders.length === 1 && r.body.orders[0].lineItems[0].sku === "SEQ-GLD-YD");

r = await call("POST", ["orders", "ack"], { ids: [9001] });
r = await call("GET", ["orders", "pending"]);
check("ack clears queue", r.body.orders.length === 0);

const cancelled = { ...order, cancelled_at: "2026-07-08T13:00:00Z" };
const raw2 = Buffer.from(JSON.stringify(cancelled));
const hmac2 = crypto.createHmac("sha256", "s3cret").update(raw2).digest("base64");
wr = mkRes();
await handler(mkReq("POST", ["webhooks", "shopify"], { "x-shopify-hmac-sha256": hmac, "x-shopify-topic": "orders/create" }, raw), wr);
wr = mkRes();
await handler(mkReq("POST", ["webhooks", "shopify"], { "x-shopify-hmac-sha256": hmac2, "x-shopify-topic": "orders/updated" }, raw2), wr);
r = await call("GET", ["orders", "pending"]);
check("cancellation removes from queue", wr.body.removed === 9001 && r.body.orders.length === 0);

r = await call("GET", ["health"], null, { "x-api-key": "wrong" });
check("wrong key rejected", r.code === 401);

console.log(failures ? failures + " FAILURES" : "ALL PASS");
process.exit(failures ? 1 : 0);
