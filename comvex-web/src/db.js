/**
 * db.js – shared online database (Supabase) with the same data model + rules as the
 * desktop app. All data is loaded into memory at sign-in (fast search / filter);
 * every change is written to Supabase first, then mirrored in memory.
 * Excel import/export keeps Database.xlsx compatible.
 */
import { supabase } from "./supabase.js";

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
const PRODUCT_KEYS = ["barcode", "factory", "factory_code", "category", "color", "size", "date", "asin", "noon_sku", "status", "removed_date"];

const empty = () => ({ factories: [], categories: [], colors: [], sizes: [], products: [] });
let state = empty();

// ── loading ────────────────────────────────────────────────────
const PAGE = 1000; // Supabase returns at most 1000 rows per request
async function fetchAll(table, order) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select("*").order(order).range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}
const toItem = (r) => ({ row_id: Number(r.row_id), name: String(r.name ?? "") });
const toProduct = (r) => { const p = {}; for (const k of PRODUCT_KEYS) p[k] = String(r[k] ?? ""); return p; };

export async function reload() {
  const [f, c, col, s, p] = await Promise.all([
    fetchAll("factories", "row_id"), fetchAll("categories", "row_id"),
    fetchAll("colors", "row_id"), fetchAll("sizes", "row_id"), fetchAll("products", "seq"),
  ]);
  state = { factories: f.map(toItem), categories: c.map(toItem), colors: col.map(toItem), sizes: s.map(toItem), products: p.map(toProduct) };
}
export const initDb = reload;

// ── helpers ────────────────────────────────────────────────────
const norm = (s) => String(s ?? "").trim().toLowerCase();
const nowStr = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const isRemoved = (p) => norm(p.status) === "removed";
const NO_PERM = "You don't have permission to do that (or it was already changed by someone else — try Refresh).";
const errText = (e) => (e?.code === "42501" || /row-level security|permission/i.test(e?.message || "") ? NO_PERM : e?.message || "Server error.");

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
const dupMsg = (kind) => `${LABEL[kind]} ${kind === "factories" ? "name " : ""}already exists.`;

export const getAll = (kind) => state[kind].map((x) => ({ ...x }));

export async function addItem(kind, name) {
  name = String(name ?? "").trim();
  const label = LABEL[kind];
  if (!name) return [false, `${label} name cannot be empty.`];
  if (state[kind].some((x) => norm(x.name) === norm(name))) return [false, dupMsg(kind)];
  const { data, error } = await supabase.from(kind).insert({ name }).select().single();
  if (error) return [false, error.code === "23505" ? `${dupMsg(kind)} (added by someone else — press Refresh)` : errText(error)];
  state[kind].push(toItem(data));
  return [true, `${label} '${name}' added successfully.`];
}

export async function updateItem(kind, rowId, name) {
  name = String(name ?? "").trim();
  const label = LABEL[kind];
  if (!name) return [false, `${label} name cannot be empty.`];
  if (state[kind].some((x) => x.row_id !== rowId && norm(x.name) === norm(name))) return [false, dupMsg(kind)];
  const it = state[kind].find((x) => x.row_id === rowId);
  if (!it) return [false, `${label} not found.`];
  const { data, error } = await supabase.from(kind).update({ name }).eq("row_id", rowId).select();
  if (error) return [false, error.code === "23505" ? dupMsg(kind) : errText(error)];
  if (!data.length) return [false, NO_PERM];
  it.name = name;
  return [true, `${label} updated successfully.`];
}

export async function deleteItem(kind, rowId) {
  const i = state[kind].findIndex((x) => x.row_id === rowId);
  if (i < 0) return [false, `${LABEL[kind]} not found.`];
  const { data, error } = await supabase.from(kind).delete().eq("row_id", rowId).select();
  if (error) return [false, errText(error)];
  if (!data.length) return [false, NO_PERM];
  state[kind].splice(i, 1);
  return [true, `${LABEL[kind]} deleted successfully.`];
}

// ── products ───────────────────────────────────────────────────
export const getActiveProducts = () => state.products.filter((p) => !isRemoved(p)).map((p) => ({ ...p }));
export const getRemovedProducts = () => state.products.filter(isRemoved).map((p) => ({ ...p }));
export const searchByBarcode = (bc) => getActiveProducts().find((p) => p.barcode === String(bc).trim()) || null;

const findLocal = (barcode) => state.products.find((x) => String(x.barcode) === String(barcode));

async function patchProduct(barcode, fields) {
  const { data, error } = await supabase.from("products").update(fields).eq("barcode", String(barcode)).select("barcode");
  if (error) return [false, errText(error)];
  if (!data.length) return [false, NO_PERM];
  return [true, ""];
}

export async function saveProduct(barcode, factory, factory_code, category, color, size) {
  const ex = findLocal(barcode);
  if (ex) {
    if (isRemoved(ex)) {
      const [ok, msg] = await patchProduct(barcode, { status: "", removed_date: "" });
      if (!ok) return [false, msg];
      ex.status = ""; ex.removed_date = "";
      return [true, "Barcode restored from removed items."];
    }
    return [false, "Barcode already exists in database."];
  }
  const row = {
    barcode: String(barcode), factory, factory_code, category, color, size,
    date: nowStr(), asin: "", noon_sku: "", status: "", removed_date: "",
  };
  const { error } = await supabase.from("products").insert(row);
  if (error) {
    if (error.code === "23505") { await reload().catch(() => {}); return [false, "Barcode already exists in database."]; }
    return [false, errText(error)];
  }
  state.products.push(toProduct(row));
  return [true, "Product saved successfully."];
}

export async function removeProduct(barcode) {
  const p = findLocal(barcode);
  if (!p) return [false, "Product not found."];
  const removed_date = nowStr();
  const [ok, msg] = await patchProduct(barcode, { status: "Removed", removed_date });
  if (!ok) return [false, msg];
  p.status = "Removed"; p.removed_date = removed_date;
  return [true, "Barcode removed."];
}

export async function restoreProduct(barcode) {
  const p = findLocal(barcode);
  if (!p) return [false, "Product not found."];
  const [ok, msg] = await patchProduct(barcode, { status: "", removed_date: "" });
  if (!ok) return [false, msg];
  p.status = ""; p.removed_date = "";
  return [true, "Barcode restored."];
}

export async function updateProductExtra(barcode, asin, noon) {
  const p = findLocal(barcode);
  if (!p) return [false, "Product not found."];
  const a = String(asin ?? "").trim(), n = String(noon ?? "").trim();
  const [ok, msg] = await patchProduct(barcode, { asin: a, noon_sku: n });
  if (!ok) return [false, msg];
  p.asin = a; p.noon_sku = n;
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

/**
 * Import ADDS what is missing from the shared database (matched by name / barcode).
 * Nothing existing is changed or deleted, so importing twice is harmless.
 */
export async function importWorkbook(arrayBuffer) {
  const X = await XLSX();
  const wb = X.read(arrayBuffer, { type: "array", cellDates: false });
  if (!wb.SheetNames.some((n) => ["Factories", "Products"].includes(n))) {
    return [false, "This file doesn't look like a COMVEX Database.xlsx (no Factories / Products sheet)."];
  }
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

  const added = { factories: 0, categories: 0, colors: 0, sizes: 0, products: 0 };
  let skipped = 0;
  const finish = async (ok, msg) => { await reload().catch(() => {}); return [ok, msg]; };

  // lists first (keep the file's Row IDs when free, otherwise next free number)
  for (const kind of Object.keys(LIST_SHEETS)) {
    const have = new Set(state[kind].map((x) => norm(x.name)));
    const used = new Set(state[kind].map((x) => x.row_id));
    let max = state[kind].reduce((m, x) => Math.max(m, x.row_id), 0);
    const rows = [];
    for (const it of next[kind]) {
      const n = norm(it.name);
      if (!n || have.has(n)) continue;
      have.add(n);
      let id = it.row_id;
      if (!Number.isFinite(id) || id <= 0 || used.has(id)) id = max + 1;
      used.add(id); max = Math.max(max, id);
      rows.push({ row_id: id, name: it.name });
    }
    if (!rows.length) continue;
    const { error } = await supabase.from(kind).insert(rows);
    if (error) return finish(false, `Import stopped at ${LABEL[kind]} list: ${errText(error)}`);
    added[kind] = rows.length;
  }

  // products in chunks
  const seen = new Set(state.products.map((p) => p.barcode));
  const fresh = [];
  for (const p of next.products) {
    if (seen.has(p.barcode)) { skipped++; continue; }
    seen.add(p.barcode);
    fresh.push(p);
  }
  for (let i = 0; i < fresh.length; i += 500) {
    const chunk = fresh.slice(i, i + 500);
    const { data, error } = await supabase.from("products").upsert(chunk, { onConflict: "barcode", ignoreDuplicates: true }).select("barcode");
    if (error) return finish(false, `Import stopped after ${added.products} barcodes: ${errText(error)}`);
    added.products += data.length;
    skipped += chunk.length - data.length;
  }

  return finish(true, `Imported ${added.factories} factories, ${added.categories} categories, ${added.colors} colors, ${added.sizes} sizes and ${added.products} barcodes` + (skipped ? ` (${skipped} barcodes already existed and were skipped).` : "."));
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
