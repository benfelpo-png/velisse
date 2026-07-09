/**
 * Headless smoke test of the app's core logic (public/index.html).
 * Extracts the inline scripts, stubs the browser, and exercises the data
 * layer, allocation engine, storage tiers, and live-sync client.
 * Run: npm run test:app   (no database or network needed)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, "public/index.html"), "utf8");
const src = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((s) => !/^\s*$/.test(s)).join("\n;\n");

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? "  ok " : "FAIL ") + name);
  if (!cond) failures++;
};

/* ---- browser stubs ---- */
const localStore = {};
globalThis.localStorage = {
  getItem: (k) => localStore[k] ?? null,
  setItem: (k, v) => { localStore[k] = v; },
  removeItem: (k) => { delete localStore[k]; },
};
globalThis.window = { print() {}, scrollTo() {} };
const el = () => ({ innerHTML: "", classList: { add() {}, remove() {} }, textContent: "", style: {}, dataset: {}, value: "", checked: false });
globalThis.document = {
  querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => ({ click() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
};
try { globalThis.navigator = {}; } catch { /* Node >=21 exposes a read-only navigator; the stub is unnecessary there */ }
globalThis.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => "<svg></svg>" });
globalThis.jsQR = () => null;
globalThis.confirm = () => true;
const NativeURL = globalThis.URL;
globalThis.URL = NativeURL;
globalThis.URL.createObjectURL = () => "";
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = class {};

/* ---- fake sync server ---- */
const server = { rev: 0, data: null };
globalThis.fetch = async (url, opts) => {
  const method = (opts && opts.method) || "GET";
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  if (url.endsWith("/db") && method === "GET") return ok({ rev: server.rev, data: server.data });
  if (url.endsWith("/db")) {
    if (server.data && body.rev !== server.rev)
      return { ok: false, status: 409, text: async () => JSON.stringify({ error: "Conflict", rev: server.rev, data: server.data }) };
    server.rev++; server.data = body.data;
    return ok({ ok: true, rev: server.rev });
  }
  if (url.endsWith("/health")) return ok({ ok: true, db: true, shop: null, locations: [] });
  return { ok: false, status: 404, text: async () => "{}" };
};

/* ---- run app code + assertions ---- */
const tests = `
;(async function(){
  await new Promise(r=>setTimeout(r,50));
  db=EMPTY();ensureInventorySetup();
  check('empty inventory setup uses Buffalo team', db.stores[0].code==='BUF'&&db.stores[0].city==='Buffalo'&&db.people.map(p=>p.name).join(',')==='Aria,Aaron,Ben'&&loc(db.settings.lastScanLocationId).binCode==='BUF-RECEIVING');
  db=EMPTY();
  db.stores=[{id:'bk',code:'BK',name:'Brooklyn Store',city:'Brooklyn',active:true},{id:'wh1',code:'WH1',name:'Sunset Park Warehouse',city:'Brooklyn',active:true}];
  db.locations=[{id:'wh-a',storeId:'wh1',type:'bin',binCode:'WH-A-01-1',zone:'Zone A',qrValue:'BIN-WH-A-01-1',active:true}];
  db.people=[{id:'maria',name:'Maria G.',role:'manager',storeId:'wh1',active:true}];
  migrate();
  check('legacy BK/WH1 browser data migrates to Buffalo setup', db.stores.map(s=>s.code).join(',')==='BUF'&&db.people.map(p=>p.name).join(',')==='Aria,Aaron,Ben'&&loc(db.settings.lastScanLocationId).binCode==='BUF-RECEIVING'&&db.rolls.length===0);
  seed();
  db.settings.storeId=db.stores[0].id;db.settings.personId=db.people[0].id;
  check('seed creates demo data', db.rolls.length===11&&db.variants.length===6);
  check('demo data is Buffalo-scoped', db.stores.map(s=>s.code).join(',')==='BUF'&&db.locations.every(l=>l.binCode.startsWith('BUF-'))&&db.people.some(p=>p.name==='Ben'&&p.role==='admin'));
  const r0=db.rolls[0];const before=r0.currentYards;
  txn(r0,'sale',-2.5,{notes:'test'});
  check('ledger txn adjusts yardage', r0.currentYards===before-2.5&&db.transactions[0].type==='sale');
  const sku=db.sellableSkus.find(s=>s.uom==='yard');
  const o={id:uid(),number:nextCode('order','SO'),shopifyOrderId:'',customerId:db.customers[0].id,
    originStoreId:db.stores[0].id,fulfillment:'pickup',status:'open',routeId:null,createdAt:now(),updatedAt:now()};
  db.orders.push(o);addLine(o.id,sku.id,3);autoAllocateOrder(o.id);
  const li=db.lineItems.find(l=>l.orderId===o.id);
  const al=db.allocations.filter(a=>a.lineItemId===li.id);
  check('auto-allocation reserves FIFO', al.length>=1&&al.reduce((s,a)=>s+a.allocatedYards,0)===li.yardsRequired&&o.status==='reserved');
  const qrRoll=createInventoryRoll({qr:'PHYS-QR-0001',variantId:db.variants[0].id,yards:12.5,locationId:db.locations[0].id,lot:'OPENING'});
  check('QR intake creates roll from physical label', db.rolls.includes(qrRoll)&&qrRoll.qrValue==='PHYS-QR-0001'&&qrRoll.currentYards===12.5);
  countInventoryRoll(qrRoll.id,{yards:11.75,locationId:db.locations[1].id,lot:'OPENING',condition:'partial',notes:'test count'});
  check('QR count adjusts via ledger and moves bin', qrRoll.currentYards===11.75&&qrRoll.locationId===db.locations[1].id&&db.transactions[0].type==='cycle_count_variance');
  check('scan normalizes URL QR values', normalizeScanCode('https://x.example/roll/PHYS-QR-0001')==='PHYS-QR-0001');
  const views=[vHome,vCatalog,vRolls,vOrders,vLocations,vTransfers,vDelivery,vReports,vSync,vSettings,vScan,vMore];
  check('all views render strings', views.every(v=>typeof v()==='string'));
  save();await new Promise(r=>setTimeout(r,400));
  check('localStorage persists', !!localStorage.getItem('fabricops-db'));
  shopCfg().workerUrl='https://sync.test/api';shopCfg().apiKey='k';
  save();await new Promise(r=>setTimeout(r,2600));
  check('cloud push on save', server.rev===1&&server.data.rolls.length===12);
  const other=JSON.parse(JSON.stringify(server.data));other.rolls.pop();server.rev++;server.data=other;
  db.settings.lowStockYards=99;save();await new Promise(r=>setTimeout(r,2600));
  check('conflict adopts server state', db.rolls.length===11&&syncState.rev===server.rev);
  process.exit(failures?1:0);
})().catch(e=>{console.error('FAIL (exception)',e.message);process.exit(1)});`;
eval(src + tests);
