/**
 * db.js – browser port of database_manager.py
 * Same data model + rules as the desktop app, stored in IndexedDB
 * (localStorage fallback). Excel import/export keeps Database.xlsx compatible.
 */

const IDB_NAME = "comvex-bms";
const IDB_STORE = "kv";
const KEY = "db";
const LS_KEY = "comvex.db.v1";

export const PRODUCT_HEADERS = [
  "Barcode", "Factory", "Factory Code", "Category", "Color", "Size",
  "Creation Date", "ASIN", "Noon SKU", "Status", "Removed Date",
];
const LIST_SHEETS = {
  factories: ["Factories", "Factory Name"],
  categories: ["Categories", "Category Name"],
  colors: ["Colors", "Color Name"],
  sizes: ["Sizes", "Size Name"],
};

const empty = () => ({ factories: [], categories: [], colors: [], sizes: [], products: [] });
let state = empty();

// ── persistence ────────────────────────────────────────────────
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(IDB_STORE).objectStore(IDB_STORE).get(KEY);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const snapshot = JSON.parse(JSON.stringify(state));
    try { await idbSet(snapshot); return; } catch { /* fall through */ }
    try { localStorage.setItem(LS_KEY, JSON.stringify(snapshot)); } catch { /* storage unavailable */ }
  }, 50);
}

export async function initDb() {
  let saved;
  try { saved = await idbGet(); } catch { /* ignore */ }
  if (!saved) {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) saved = JSON.parse(raw); } catch { /* ignore */ }
  }
  state = { ...empty(), ...(saved || {}) };
  return !!saved;
}

// ── helpers ────────────────────────────────────────────────────
const norm = (s) => String(s ?? "").trim().toLowerCase();
const nowStr = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const nextId = (list) => (list.length ? Math.max(...list.map((x) => Number(x.row_id))) + 1 : 1);
const isRemoved = (p) => norm(p.status) === "removed";

export function buildSq(p) {
  const g = (k) => String(p[k] ?? "").trim();
  return `${g("factory_code")}-${g("factory")}-${g("category")}-${g("color")}-${g("size")}`;
}

/** Free-text search across every field – every word must match (same ranking as desktop). */
export function matchProducts(products, query) {
  const q = String(query || "").trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const ranked = [];
  products.forEach((p, idx) => {
    const sq = buildSq(p).toLowerCase();
    const bc = String(p.barcode ?? "").toLowerCase();
    const hay = [bc, sq, p.factory, p.factory_code, p.category, p.color, p.size, p.asin, p.noon_sku]
      .map((x) => String(x ?? "")).join(" | ").toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) return;
    const rank = bc === q || sq === q ? 0 : bc.startsWith(q) ? 1 : bc.includes(q) || sq.includes(q) ? 2 : 3;
    ranked.push([rank, idx, p]);
  });
  ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return ranked.map((r) => r[2]);
}

// ── generic list CRUD (factories / categories / colors / sizes) ─
const LABEL = { factories: "Factory", categories: "Category", colors: "Color", sizes: "Size" };

export const getAll = (kind) => state[kind].map((x) => ({ ...x }));

export function addItem(kind, name) {
  name = String(name ?? "").trim();
  const label = LABEL[kind];
  if (!name) return [false, `${label} name cannot be empty.`];
  if (state[kind].some((x) => norm(x.name) === norm(name))) return [false, `${label} ${kind === "factories" ? "name " : ""}already exists.`];
  state[kind].push({ row_id: nextId(state[kind]), name });
  persist();
  return [true, `${label} '${name}' added successfully.`];
}

export function updateItem(kind, rowId, name) {
  name = String(name ?? "").trim();
  const label = LABEL[kind];
  if (!name) return [false, `${label} name cannot be empty.`];
  if (state[kind].some((x) => x.row_id !== rowId && norm(x.name) === norm(name))) return [false, `${label} ${kind === "factories" ? "name " : ""}already exists.`];
  const it = state[kind].find((x) => x.row_id === rowId);
  if (!it) return [false, `${label} not found.`];
  it.name = name;
  persist();
  return [true, `${label} updated successfully.`];
}

export function deleteItem(kind, rowId) {
  const i = state[kind].findIndex((x) => x.row_id === rowId);
  if (i < 0) return [false, `${LABEL[kind]} not found.`];
  state[kind].splice(i, 1);
  persist();
  return [true, `${LABEL[kind]} deleted successfully.`];
}

// ── products ───────────────────────────────────────────────────
export const getActiveProducts = () => state.products.filter((p) => !isRemoved(p)).map((p) => ({ ...p }));
export const getRemovedProducts = () => state.products.filter(isRemoved).map((p) => ({ ...p }));
export const searchByBarcode = (bc) => getActiveProducts().find((p) => p.barcode === String(bc).trim()) || null;

export function saveProduct(barcode, factory, factory_code, category, color, size) {
  const ex = state.products.find((p) => String(p.barcode) === String(barcode));
  if (ex) {
    if (isRemoved(ex)) {
      ex.status = ""; ex.removed_date = "";
      persist();
      return [true, "Barcode restored from removed items."];
    }
    return [false, "Barcode already exists in database."];
  }
  state.products.push({
    barcode: String(barcode), factory, factory_code, category, color, size,
    date: nowStr(), asin: "", noon_sku: "", status: "", removed_date: "",
  });
  persist();
  return [true, "Product saved successfully."];
}

export function removeProduct(barcode) {
  const p = state.products.find((x) => String(x.barcode) === String(barcode));
  if (!p) return [false, "Product not found."];
  p.status = "Removed"; p.removed_date = nowStr();
  persist();
  return [true, "Barcode removed."];
}

export function restoreProduct(barcode) {
  const p = state.products.find((x) => String(x.barcode) === String(barcode));
  if (!p) return [false, "Product not found."];
  p.status = ""; p.removed_date = "";
  persist();
  return [true, "Barcode restored."];
}

export function updateProductExtra(barcode, asin, noon) {
  const p = state.products.find((x) => String(x.barcode) === String(barcode));
  if (!p) return [false, "Product not found."];
  p.asin = String(asin ?? "").trim();
  p.noon_sku = String(noon ?? "").trim();
  persist();
  return [true, "Saved."];
}

/**
 * Barcode = FactoryCode (typed) + FactoryRowID + CategoryRow + ColorRow + SizeRow
 * NOTE: like the desktop app, category/color/size use the 1-based POSITION in the list.
 */
export function generateBarcodeNumber(factoryName, factoryCode, categoryName, colorName, sizeName) {
  factoryCode = String(factoryCode ?? "").trim();
  if (!factoryCode) return [null, "Factory code is required."];
  if (!/^[A-Za-z0-9]+$/.test(factoryCode)) return [null, "Factory code must contain only letters and numbers."];
  const factory = state.factories.find((f) => norm(f.name) === norm(factoryName));
  if (!factory) return [null, "Factory not found."];
  const pos = (list, name) => { const i = list.findIndex((x) => norm(x.name) === norm(name)); return i < 0 ? null : i + 1; };
  const c = pos(state.categories, categoryName); if (c === null) return [null, "Category not found."];
  const col = pos(state.colors, colorName); if (col === null) return [null, "Color not found."];
  const s = pos(state.sizes, sizeName); if (s === null) return [null, "Size not found."];
  return [`${factoryCode}${factory.row_id}${c}${col}${s}`, "OK"];
}

// ── Excel import / export ──────────────────────────────────────
async function XLSX() { return (await import("xlsx")).default || (await import("xlsx")); }

const cellStr = (v) => (v === null || v === undefined ? "" : String(v).trim());

export async function importWorkbook(arrayBuffer) {
  const X = await XLSX();
  const wb = X.read(arrayBuffer, { type: "array", cellDates: false });
  const next = empty();

  for (const [kind, [sheet, nameHdr]] of Object.entries(LIST_SHEETS)) {
    const ws = wb.Sheets[sheet];
    if (!ws) continue;
    const rows = X.utils.sheet_to_json(ws, { header: 1, defval: null });
    const hdr = (rows[0] || []).map(cellStr);
    const iId = hdr.indexOf("Row ID") >= 0 ? hdr.indexOf("Row ID") : 0;
    const iName = hdr.indexOf(nameHdr) >= 0 ? hdr.indexOf(nameHdr) : 1;
    rows.slice(1).forEach((r) => {
      if (r[iId] === null || r[iId] === undefined || r[iId] === "") return;
      next[kind].push({ row_id: Number(r[iId]), name: cellStr(r[iName]) });
    });
  }

  const ws = wb.Sheets["Products"];
  if (ws) {
    const rows = X.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const hdr = (rows[0] || []).map(cellStr);
    const col = (h, fallback) => (hdr.indexOf(h) >= 0 ? hdr.indexOf(h) : fallback);
    const ix = {
      barcode: col("Barcode", 0), factory: col("Factory", 1), factory_code: col("Factory Code", 2),
      category: col("Category", 3), color: col("Color", 4), size: col("Size", 5),
      date: col("Creation Date", 6), asin: col("ASIN", 7), noon_sku: col("Noon SKU", 8),
      status: col("Status", 9), removed_date: col("Removed Date", 10),
    };
    rows.slice(1).forEach((r) => {
      if (r[ix.barcode] === null || r[ix.barcode] === undefined || r[ix.barcode] === "") return;
      const p = {};
      for (const k of Object.keys(ix)) p[k] = cellStr(r[ix[k]]);
      next.products.push(p);
    });
  }

  if (!wb.SheetNames.some((n) => ["Factories", "Products"].includes(n))) {
    return [false, "This file doesn't look like a COMVEX Database.xlsx (no Factories / Products sheet)."];
  }
  state = next;
  persist();
  return [true, `Imported ${next.factories.length} factories, ${next.categories.length} categories, ${next.colors.length} colors, ${next.sizes.length} sizes and ${next.products.length} barcodes.`];
}

function sheetFromRows(X, rows, widths) {
  const ws = X.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  return ws;
}

export async function buildWorkbook(only) {
  const X = await XLSX();
  const wb = X.utils.book_new();
  const wants = (n) => !only || only === n;
  for (const [kind, [sheet, hdr]] of Object.entries(LIST_SHEETS)) {
    if (!wants(sheet)) continue;
    const rows = [["Row ID", hdr], ...state[kind].map((x) => [x.row_id, x.name])];
    X.utils.book_append_sheet(wb, sheetFromRows(X, rows, [10, 32]), sheet);
  }
  if (wants("Products")) {
    const rows = [PRODUCT_HEADERS, ...state.products.map((p) => [
      p.barcode, p.factory, p.factory_code, p.category, p.color, p.size, p.date,
      p.asin || null, p.noon_sku || null, p.status || null, p.removed_date || null,
    ])];
    X.utils.book_append_sheet(wb, sheetFromRows(X, rows, [20, 25, 14, 20, 15, 10, 20, 20, 22, 12, 20]), "Products");
  }
  return X.write(wb, { type: "array", bookType: "xlsx" });
}

export const counts = () => ({
  factories: state.factories.length, categories: state.categories.length,
  colors: state.colors.length, sizes: state.sizes.length,
  barcodes: state.products.filter((p) => !isRemoved(p)).length,
});
