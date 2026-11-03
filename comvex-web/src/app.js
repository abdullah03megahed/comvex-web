import "./style.css";
import * as db from "./db.js";
import * as auth from "./auth.js";
import { renderBarcodeCanvas, ensureFonts, exportBarcodePng, printBarcode } from "./barcode.js";

// ── tiny helpers ───────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");

const NAV = [
  ["dashboard", "▦", "Dashboard", "Overview & search"],
  ["products", "📦", "Products", "Generate & manage barcodes"],
  ["factories", "🏭", "Factories", "Manage factories"],
  ["categories", "📂", "Categories", "Manage categories"],
  ["colors", "🎨", "Colors", "Manage colors"],
  ["sizes", "📐", "Sizes", "Manage sizes"],
  ["users", "👥", "Users", "Manage users & permissions"],
];
const CRUD = {
  factories: { icon: "🏭", title: "Factory Management", sub: "Manage production factories", one: "factory", sheet: "Factories", hdr: "Factory Name" },
  categories: { icon: "📂", title: "Category Management", sub: "Manage product categories", one: "category", sheet: "Categories", hdr: "Category Name" },
  colors: { icon: "🎨", title: "Color Management", sub: "Manage product colors", one: "color", sheet: "Colors", hdr: "Color Name" },
  sizes: { icon: "📐", title: "Size Management", sub: "Manage product sizes", one: "size", sheet: "Sizes", hdr: "Size Name" },
};
const PAGE_PERM = { dashboard: "view_dashboard", products: "view_products", factories: "view_lists", categories: "view_lists", colors: "view_lists", sizes: "view_lists", users: "manage_users" };
const can = (perm) => auth.can(user, perm);
const STAT_COLORS = { factories: "#5B5EF7", categories: "#22C55E", colors: "#3B82F6", sizes: "#A855F7", barcodes: "#F59E0B" };

let user = "";
let page = "dashboard";
let theme = (() => { try { return localStorage.getItem("comvex.theme") || "dark"; } catch { return "dark"; } })();
const ui = { dashQuery: "", lastGen: null, filter: "", shown: 10, crudSel: null, crudFilter: "" };

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("comvex.theme", theme); } catch { /* ignore */ }
}

// ── toasts / dialogs ───────────────────────────────────────────
function toast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = `toast ${type}`; t.textContent = msg; t.setAttribute("role", "status");
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), type === "error" ? 6000 : 3800);
}
const success = (m) => toast(m, "success"), failure = (m) => toast(m, "error"), warn = (m) => toast(m, "warning");

const dialogs = [];
function modal(html, { small = false, beforeClose } = {}) {
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="dialog ${small ? "sm" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(ov);
  const api = {
    el: ov.firstElementChild,
    async close(force = false) {
      if (!force && beforeClose && !(await beforeClose())) return false;
      ov.remove(); dialogs.splice(dialogs.indexOf(api), 1);
      return true;
    },
  };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) api.close(); });
  dialogs.push(api);
  return api;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dialogs.length) dialogs[dialogs.length - 1].close();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && user) { e.preventDefault(); focusSearch(); }
});

function confirmBox(message, { title = "Confirm", yes = "Yes", danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal(`<div class="dlg-body"><h3 class="dlg-title">${esc(title)}</h3><p style="margin:0;white-space:pre-line;color:var(--t2)">${esc(message)}</p></div>
      <div class="dlg-foot"><span class="spacer"></span><button class="btn quiet" data-a="no">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-a="yes">${esc(yes)}</button></div>`,
      { small: true, beforeClose: async () => { resolve(false); return true; } });
    $('[data-a="no"]', m.el).onclick = () => m.close();
    $('[data-a="yes"]', m.el).onclick = () => { resolve(true); m.close(true); };
    $('[data-a="yes"]', m.el).focus();
  });
}

function promptBox(title, label, initial = "") {
  return new Promise((resolve) => {
    const m = modal(`<div class="dlg-body"><h3 class="dlg-title">${esc(title)}</h3>
      <div class="field"><label>${esc(label)}</label><input type="text" value="${esc(initial)}" maxlength="120" autocomplete="off"></div></div>
      <div class="dlg-foot"><span class="spacer"></span><button class="btn quiet" data-a="no">Cancel</button><button class="btn primary" data-a="ok">Save</button></div>`,
      { small: true, beforeClose: async () => { resolve(null); return true; } });
    const inp = $("input", m.el);
    const ok = () => { const v = inp.value.trim(); if (!v) return warn(`${label} cannot be empty.`); resolve(v); m.close(true); };
    $('[data-a="no"]', m.el).onclick = () => m.close();
    $('[data-a="ok"]', m.el).onclick = ok;
    inp.onkeydown = (e) => { if (e.key === "Enter") ok(); };
    inp.focus(); inp.select();
  });
}

function download(data, filename, type = "application/octet-stream") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function copyText(btn, text) {
  if (!text || text === "—") return warn("Nothing to copy yet — generate a barcode first.");
  try { await navigator.clipboard.writeText(text); } catch {
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } finally { t.remove(); }
  }
  btn.textContent = "Copied ✓";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
}

async function mountBarcode(box, value) {
  if (!value) { box.innerHTML = `<div class="ph">Generate a barcode to preview</div>`; return; }
  await ensureFonts();
  box.replaceChildren(renderBarcodeCanvas(value, 1, 300));
}

// ── login ──────────────────────────────────────────────────────
function renderLogin() {
  user = "";
  const remembered = auth.getRemembered();
  app.innerHTML = `<div class="login">
    <section class="brand">
      <img src="/assets/icons/comvex_logo.png" alt="COMVEX">
      <h2>Enterprise-grade barcode<br>management made simple.</h2>
      <p>Manage factories, categories, colors, sizes<br>and generate barcodes with ease.</p>
      <div class="feat"><i>▦</i>Multi-factory barcode generation</div>
      <div class="feat"><i>🔍</i>Smart search by Barcode &amp; SQ</div>
      <div class="feat"><i>📊</i>Excel import &amp; export</div>
      <div class="feat"><i>🔒</i>Secure authentication</div>
    </section>
    <section class="login-form"><form class="login-card" autocomplete="on">
      <div><h3>Welcome back</h3><p>Sign in to your account</p></div>
      <div class="field"><label class="flabel" for="u">Username</label><input id="u" type="text" autocomplete="username" value="${esc(remembered)}" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label class="flabel" for="p">Password</label><div class="pw"><input id="p" type="password" autocomplete="current-password"><button type="button" id="eye" aria-label="Show password">👁</button></div></div>
      <label class="check"><input type="checkbox" id="rem" ${remembered ? "checked" : ""}> Remember me</label>
      <div class="msg err" id="err" role="alert"></div>
      <button class="btn primary lg" type="submit">Sign In</button>
    </form></section></div>`;
  const u = $("#u"), p = $("#p"), err = $("#err");
  $("#eye").onclick = () => { p.type = p.type === "password" ? "text" : "password"; };
  (remembered ? p : u).focus();
  $(".login-card").onsubmit = async (e) => {
    e.preventDefault();
    if (!u.value.trim() || !p.value) { err.textContent = "Please enter username and password."; return; }
    const btn = $("button[type=submit]"); btn.disabled = true; btn.textContent = "Signing in…";
    const [ok, msg] = await auth.login(u.value, p.value);
    if (!ok) { err.textContent = msg; btn.disabled = false; btn.textContent = "Sign In"; p.select(); return; }
    const name = u.value.trim().toLowerCase();
    auth.setSession(name); auth.setRemembered($("#rem").checked ? name : "");
    user = name; page = "dashboard"; renderShell();
  };
}

// ── shell ──────────────────────────────────────────────────────
function renderShell() {
  const navHtml = NAV.filter((n) => can(PAGE_PERM[n[0]])).map(([id, ic, label]) => `<button class="nav-btn" data-nav="${id}"><span class="ic">${ic}</span>${label}</button>`).join("");
  app.innerHTML = `<div class="shell">
    <aside class="sidebar" id="sidebar">
      <div class="logo-wrap"><img src="/assets/icons/comvex_logo.png" alt="COMVEX"></div><hr class="rule">
      <nav class="nav">${navHtml}</nav><hr class="rule">
      <button class="nav-btn" id="btn-profile" style="margin-top:6px"><span class="ic">👤</span>Profile &amp; Security</button>
      <button class="nav-btn danger" id="btn-logout"><span class="ic">🔴</span>Logout</button>
      <div class="status-card"><small>System Status</small><b>● Online</b></div>
    </aside>
    <div class="main">
      <header class="header">
        <button class="icon-btn burger" id="burger" aria-label="Menu">☰</button>
        <div><h1 id="h-title"></h1><div class="sub" id="h-sub"></div></div>
        <button class="search-pill" id="pill">🔍 Search products, factories…</button><span class="kbd">Ctrl + K</span>
        <span class="spacer"></span><span class="clock" id="clock"></span>
        <button class="icon-btn" id="theme" aria-label="Toggle theme"></button>
        <button class="user" id="btn-user"><span class="avatar">${esc(user[0]?.toUpperCase() || "?")}</span><div><b>${esc(user)}</b><small>${esc(auth.getRole(user))}</small></div></button>
      </header>
      <main class="page" id="page"></main>
      <div class="statusbar">COMVEX Barcode System · ${esc(user)} · Ready</div>
    </div></div>`;

  $$("[data-nav]").forEach((b) => (b.onclick = () => navigate(b.dataset.nav)));
  $("#pill").onclick = focusSearch;
  $("#btn-profile").onclick = $("#btn-user").onclick = openProfile;
  $("#btn-logout").onclick = async () => {
    if (await confirmBox("Are you sure you want to logout?", { title: "Logout", danger: true })) { auth.setSession(""); renderLogin(); }
  };
  $("#theme").onclick = () => { theme = theme === "dark" ? "light" : "dark"; applyTheme(); syncTheme(); };
  $("#burger").onclick = () => toggleSidebar();
  syncTheme(); tick(); navigate(page);
}
function syncTheme() { const t = $("#theme"); if (t) t.textContent = theme === "dark" ? "🌙" : "☀️"; }
function toggleSidebar(force) {
  const sb = $("#sidebar"); if (!sb) return;
  const open = force ?? !sb.classList.contains("open");
  sb.classList.toggle("open", open);
  $(".scrim")?.remove();
  if (open) { const s = document.createElement("div"); s.className = "scrim"; s.onclick = () => toggleSidebar(false); document.body.appendChild(s); }
}
setInterval(tick, 1000);
function tick() {
  const c = $("#clock"); if (!c) return;
  const d = new Date();
  c.textContent = `${d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}  ·  ${d.toLocaleTimeString("en-GB")}`;
}

function navigate(id) {
  if (!can(PAGE_PERM[id])) {
    id = NAV.map((n) => n[0]).find((x) => can(PAGE_PERM[x]));
    if (!id) { $("#page").innerHTML = `<div class="empty">Your account has no access to any page. Ask an administrator.</div>`; return; }
  }
  page = id; toggleSidebar(false);
  $$("[data-nav]").forEach((b) => b.classList.toggle("active", b.dataset.nav === id));
  const [, , title, sub] = NAV.find((n) => n[0] === id);
  $("#h-title").textContent = title; $("#h-sub").textContent = sub;
  const el = $("#page"); el.scrollTop = 0;
  if (id === "dashboard") renderDashboard(el);
  else if (id === "products") renderProducts(el);
  else if (id === "users") renderUsers(el);
  else renderCrud(el, id);
}
function focusSearch() { navigate("dashboard"); const i = $("#q"); if (i) { i.focus(); i.select(); } }

// ── dashboard ──────────────────────────────────────────────────
function renderDashboard(el) {
  const c = db.counts();
  const specs = [["factories", "Factories", "factories"], ["categories", "Categories", "categories"], ["colors", "Colors", "colors"], ["sizes", "Sizes", "sizes"], ["barcodes", "Barcodes", "products"]];
  el.innerHTML = `<div class="page-inner">
    <div class="stats">${specs.map(([k, l, go]) => `<div class="stat"><div class="num" style="color:${STAT_COLORS[k]}">${c[k]}</div><div class="lbl">${l}</div><button class="link" style="color:${STAT_COLORS[k]}" data-go="${go}">View all</button></div>`).join("")}</div>
    <section class="card"><h2 class="card-title">Search</h2>
      <p class="card-hint">Type anything: barcode, SQ, factory name or code, category, color, size, ASIN or Noon SKU. Several words narrow it down (e.g. “alpha red L”).</p>
      <div class="field" style="margin-top:12px"><input id="q" class="big-search" type="text" placeholder="Search barcodes, SQ, factories, products…" autocomplete="off" value="${esc(ui.dashQuery)}"></div>
      <p class="card-hint" id="count" style="margin:10px 0"></p>
      <div id="results"></div></section></div>`;
  $$("[data-go]", el).forEach((b) => (b.onclick = () => navigate(b.dataset.go)));
  const products = db.getActiveProducts();
  const q = $("#q"), box = $("#results"), count = $("#count");
  let matches = [], active = 0, timer;

  const run = () => {
    const query = q.value.trim(); ui.dashQuery = q.value;
    matches = query ? db.matchProducts(products, query) : [];
    const shown = matches.slice(0, 30); active = 0;
    if (!shown.length) {
      count.textContent = "";
      box.innerHTML = `<div class="empty">${query ? `No barcodes match “${esc(query)}”.` : `Start typing to search across ${products.length} barcode${products.length !== 1 ? "s" : ""}.`}</div>`;
      return;
    }
    count.textContent = `${matches.length} result${matches.length !== 1 ? "s" : ""} found${matches.length > 30 ? "  (showing the first 30 - refine your search)" : ""}  ·  click one, or press Enter to open the top result`;
    box.innerHTML = `<div class="results">${shown.map((p, i) => {
      const meta = [p.factory, p.category, p.color, p.size].filter(Boolean).join("  ·  ") + (p.asin ? `  ·  ASIN ${p.asin}` : "") + (p.noon_sku ? `  ·  Noon ${p.noon_sku}` : "");
      return `<button class="res ${i === 0 ? "active" : ""}" data-bc="${esc(p.barcode)}"><div class="top"><span class="rb">${esc(p.barcode)}</span><span class="rs">${esc(db.buildSq(p))}</span></div><div class="meta">${esc(meta)}</div></button>`;
    }).join("")}</div>`;
    $$(".res", box).forEach((b) => (b.onclick = () => openFromSearch(b.dataset.bc)));
  };
  const setActive = (i) => {
    const rows = $$(".res", box); if (!rows.length) return;
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, n) => r.classList.toggle("active", n === active));
    rows[active].scrollIntoView({ block: "nearest" });
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 120); };
  q.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Escape") { q.value = ""; run(); }
    else if (e.key === "Enter") { const r = $$(".res", box)[active]; if (r) openFromSearch(r.dataset.bc); }
  };
  run();
}
function openFromSearch(barcode) { navigate("products"); setTimeout(() => showProduct(barcode), 0); }

// ── products ───────────────────────────────────────────────────
function renderProducts(el) {
  const opts = (kind) => db.getAll(kind).map((x) => `<option>${esc(x.name)}</option>`).join("");
  el.innerHTML = `<div class="page-inner">
    <section class="card"><h2 class="card-title" style="margin-bottom:16px">Generate Barcode</h2>
      <div class="grid-2">
        <form class="gen-form" id="gen" autocomplete="off">
          ${[["Factory", "gf", "factories"], ["Category", "gc", "categories"], ["Color", "gcol", "colors"], ["Size", "gsz", "sizes"]].map(([l, id, k]) => `<div class="line"><span class="flabel">${l}</span><select id="${id}">${opts(k)}</select></div>`).join("")}
          <div class="line"><span class="flabel">Factory Code</span><input id="fcode" type="text" placeholder="e.g. 205" inputmode="text" autocapitalize="off"></div>
          <button class="btn primary lg" type="submit" ${can("generate") ? "" : "disabled"}>Generate Barcode</button>
        </form>
        <div class="gen-form">
          <div class="barcode-box" id="preview"></div>
          <div class="row"><button class="btn ghost" id="print" style="flex:1">Print</button><button class="btn ghost" id="png" style="flex:1">Export PNG</button></div>
          <div class="result-box"><span class="tag">BARCODE</span><span class="val big" id="r-bc">—</span><button class="btn mini" id="c-bc">Copy</button><hr>
            <span class="tag">SQ</span><span class="val ok" id="r-sq">—</span><button class="btn mini" id="c-sq">Copy</button></div>
        </div>
      </div></section>
    <section class="card">
      <div class="row between wrap"><div><h2 class="card-title">All Barcodes</h2><p class="card-hint">Click a barcode to open its details. Select any text to copy it.</p></div>
        <div class="row"><input id="filter" type="text" placeholder="Filter barcodes, SQ, factory…" style="width:280px;max-width:100%" value="${esc(ui.filter)}"><button class="btn ghost" id="refresh">Refresh</button></div></div>
      <hr class="rule" style="margin:14px 0 0"><div id="table"></div>
      <div class="row between" style="margin-top:12px"><span class="card-hint" id="tcount"></span><button class="btn ghost" id="more" hidden></button></div></section></div>`;

  const preview = $("#preview");
  const showResult = () => {
    const g = ui.lastGen;
    $("#r-bc").textContent = g?.bc || "—"; $("#r-sq").textContent = g?.sq || "—";
    mountBarcode(preview, g?.bc);
  };
  showResult();

  $("#gen").onsubmit = (e) => {
    e.preventDefault();
    if (!can("generate")) return warn("You don't have permission to generate barcodes.");
    const f = $("#gf").value, c = $("#gc").value, col = $("#gcol").value, sz = $("#gsz").value, code = $("#fcode").value.trim();
    if (!code) return warn("Please enter the Factory Code.");
    if (!(f && c && col && sz)) return warn("Select Factory, Category, Color and Size — add them in the Factories / Categories / Colors / Sizes pages first.");
    const [bc, msg] = db.generateBarcodeNumber(f, code, c, col, sz);
    if (bc === null) return failure(msg);
    const [, smsg] = db.saveProduct(bc, f, code, c, col, sz);
    const sq = db.buildSq({ factory_code: code, factory: f, category: c, color: col, size: sz });
    ui.lastGen = { bc, sq }; showResult(); drawTable();
    if (smsg.includes("restored")) success(`Barcode ${bc} was previously removed and has been restored.\n\nSQ: ${sq}`);
    else if (smsg.includes("already exists")) toast(`Barcode ${bc} already registered.\n\nSQ: ${sq}`);
    else success(`Barcode generated!\n\nBarcode: ${bc}\nSQ: ${sq}`);
  };
  $("#print").onclick = async () => { if (!ui.lastGen) return warn("Generate a barcode first before printing."); await printBarcode(ui.lastGen.bc); };
  $("#png").onclick = async () => {
    if (!can("export")) return warn("You don't have permission to export.");
    if (!ui.lastGen) return warn("Generate a barcode first before exporting.");
    const [ok, m] = await exportBarcodePng(ui.lastGen.bc); ok ? success(`Saved ${m}`) : failure(m);
  };
  $("#c-bc").onclick = (e) => copyText(e.currentTarget, ui.lastGen?.bc);
  $("#c-sq").onclick = (e) => copyText(e.currentTarget, ui.lastGen?.sq);

  let all = [], filtered = [];
  function drawTable() {
    all = db.getActiveProducts().reverse(); // newest first
    const q = $("#filter").value.trim(); ui.filter = $("#filter").value;
    filtered = q ? db.matchProducts(all, q) : all;
    const rows = filtered.slice(0, ui.shown);
    $("#table").innerHTML = rows.length
      ? `<table class="tbl"><thead><tr><th style="width:260px">Barcode</th><th>SQ</th></tr></thead><tbody>${rows.map((p) =>
          `<tr><td><button class="bc-link" data-bc="${esc(p.barcode)}" title="Click to open details">${esc(p.barcode)}</button></td><td class="val ok" style="font-size:13px">${esc(db.buildSq(p))}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${all.length ? "No barcodes match your filter." : "No barcodes yet. Generate your first one above."}</div>`;
    $$("[data-bc]", $("#table")).forEach((b) => (b.onclick = () => showProduct(b.dataset.bc)));
    const rem = filtered.length - rows.length;
    $("#tcount").textContent = `Showing ${rows.length} of ${filtered.length} barcode${filtered.length !== 1 ? "s" : ""}${filtered.length !== all.length ? `  (filtered from ${all.length})` : ""}`;
    const more = $("#more"); more.hidden = rem <= 0; more.textContent = `Show More  (${rem} remaining)`;
  }
  $("#filter").oninput = () => { ui.shown = 10; drawTable(); };
  $("#refresh").onclick = drawTable;
  $("#more").onclick = () => { ui.shown += 10; drawTable(); };
  drawTable();
}

async function showProduct(barcode) {
  if (!can("view_products")) return warn("You don't have permission to view products.");
  const p = db.searchByBarcode(barcode);
  if (!p) return warn(`Barcode ${barcode} was not found in the database.`);
  const val = (v) => esc(v === null || v === undefined || v === "" ? "—" : v);
  let saved = { asin: p.asin || "", noon: p.noon_sku || "" };
  const m = modal(`<div class="dlg-body">
      <h3 class="dlg-title">Product Details</h3>
      <div class="barcode-box" id="pd-img" style="height:170px"></div>
      <div class="result-box" style="grid-template-columns:70px 1fr"><span class="tag">BARCODE</span><span class="val big">${esc(p.barcode)}</span><span class="tag">SQ</span><span class="val ok">${esc(db.buildSq(p))}</span></div>
      <div class="info-grid">${[["Factory", p.factory], ["Factory code", p.factory_code], ["Category", p.category], ["Color", p.color], ["Size", p.size], ["Created", p.date]].map(([l, v]) => `<div><div class="flabel">${l}</div><div class="v">${val(v)}</div></div>`).join("")}</div>
      <hr class="rule">
      <div class="field"><label>ASIN</label><input id="pd-asin" type="text" placeholder="Amazon ASIN" value="${esc(saved.asin)}"></div>
      <div class="field"><label>Noon SKU</label><input id="pd-noon" type="text" placeholder="Noon SKU" value="${esc(saved.noon)}"></div>
      <div class="msg" id="pd-msg"></div></div>
    <div class="dlg-foot"><button class="btn ghost" id="pd-print">Print</button><button class="btn ghost" id="pd-png">PNG</button><button class="btn danger" id="pd-remove">Remove</button><span class="spacer"></span><button class="btn quiet" id="pd-close">Close</button><button class="btn primary" id="pd-save">Save</button></div>`,
    { beforeClose: async () => !dirty() || (await confirmBox("You have unsaved changes.\n\nClose without saving?", { title: "Unsaved changes", yes: "Close anyway" })) });
  const asin = $("#pd-asin", m.el), noon = $("#pd-noon", m.el), msg = $("#pd-msg", m.el);
  const dirty = () => asin.value.trim() !== saved.asin.trim() || noon.value.trim() !== saved.noon.trim();
  const setMsg = (t, cls = "") => { msg.textContent = t; msg.className = `msg ${cls}`; };
  if (!can("edit_product")) { asin.readOnly = noon.readOnly = true; $("#pd-save", m.el).hidden = true; }
  if (!can("remove_product")) $("#pd-remove", m.el).hidden = true;
  if (!can("export")) $("#pd-png", m.el).hidden = true;
  mountBarcode($("#pd-img", m.el), p.barcode);
  const onEdit = () => setMsg(dirty() ? "Unsaved changes" : "");
  asin.oninput = noon.oninput = onEdit;
  const save = () => {
    const [ok, t] = db.updateProductExtra(p.barcode, asin.value, noon.value);
    if (ok) { saved = { asin: asin.value.trim(), noon: noon.value.trim() }; setMsg("Saved ✓", "ok"); refreshCurrent(); } else setMsg(t, "err");
  };
  $("#pd-save", m.el).onclick = save;
  asin.onkeydown = noon.onkeydown = (e) => { if (e.key === "Enter") save(); };
  $("#pd-close", m.el).onclick = () => m.close();
  $("#pd-print", m.el).onclick = () => printBarcode(p.barcode);
  $("#pd-png", m.el).onclick = async () => { const [ok, t] = await exportBarcodePng(p.barcode); ok ? success(`Saved ${t}`) : failure(t); };
  $("#pd-remove", m.el).onclick = async () => {
    if (!(await confirmBox(`Remove barcode ${p.barcode}?\n\nIt will be hidden from the app but kept in your data marked as Removed, so it can be restored later (generate the same barcode again). All other barcodes stay unchanged.`, { title: "Remove barcode", yes: "Remove", danger: true }))) return;
    const [ok, t] = db.removeProduct(p.barcode);
    if (!ok) return setMsg(t, "err");
    saved = { asin: asin.value.trim(), noon: noon.value.trim() };
    m.close(true); refreshCurrent(); toast("Barcode removed.");
  };
  asin.focus();
}
function refreshCurrent() { if (user && page === "products") { const y = $("#page").scrollTop; navigate("products"); $("#page").scrollTop = y; } }

// ── CRUD pages ─────────────────────────────────────────────────
function renderCrud(el, kind) {
  const cfg = CRUD[kind];
  ui.crudSel = null; ui.crudFilter = "";
  el.innerHTML = `<div class="page-inner"><div><h2 style="margin:0;font-size:22px;letter-spacing:-.3px">${cfg.icon}  ${cfg.title}</h2><p class="card-hint" style="font-size:13px">${cfg.sub}</p></div>
    <section class="card">
      <div class="row wrap" style="gap:10px">
        <button class="btn add" id="add">+ Add</button><button class="btn edit" id="edit" disabled>✎ Edit</button><button class="btn danger" id="del" disabled>🗑 Delete</button>
        <span class="spacer"></span>
        <input id="cf" type="text" placeholder="Filter…" style="width:230px;max-width:100%"><button class="btn ghost" id="exp">↑ Export</button><button class="btn ghost" id="ref">↺ Refresh</button></div>
      <hr class="rule" style="margin:16px 0 4px"><div id="ctable" class="tbl-wrap"></div>
      <p class="card-hint" id="ccount" style="margin-top:12px;font-size:12.5px"></p></section></div>`;

  const draw = () => {
    const items = db.getAll(kind), q = ui.crudFilter.toLowerCase();
    const rows = items.filter((i) => !q || String(i.row_id).includes(q) || String(i.name).toLowerCase().includes(q));
    if (!items.some((i) => i.row_id === ui.crudSel)) ui.crudSel = null;
    $("#ctable").innerHTML = rows.length
      ? `<table class="tbl sel sticky"><thead><tr><th style="width:110px">Row ID</th><th>${cfg.hdr}</th></tr></thead><tbody>${rows.map((i) => `<tr data-id="${i.row_id}" class="${i.row_id === ui.crudSel ? "selected" : ""}"><td class="mono">${i.row_id}</td><td>${esc(i.name)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">${items.length ? "Nothing matches your filter." : `No ${cfg.one}s yet — click “+ Add”.`}</div>`;
    $$("tr[data-id]", $("#ctable")).forEach((tr) => {
      tr.onclick = () => { ui.crudSel = Number(tr.dataset.id); draw(); };
      tr.ondblclick = () => edit();
    });
    $("#edit").disabled = $("#del").disabled = ui.crudSel === null;
    const n = items.length; $("#ccount").textContent = `${n} ${cfg.one}${n !== 1 ? "s" : ""} total`;
  };
  const done = ([ok, m]) => { ok ? success(m) : failure(m); if (ok) draw(); return ok; };
  const add = async () => {
    if (!can("add_list")) return; const v = await promptBox(`Add ${cap(cfg.one)}`, cfg.hdr); if (v !== null) done(db.addItem(kind, v)); };
  const edit = async () => {
    if (!can("edit_list")) return;
    if (ui.crudSel === null) return warn(`Select a ${cfg.one}.`);
    const cur = db.getAll(kind).find((i) => i.row_id === ui.crudSel);
    const v = await promptBox(`Edit ${cap(cfg.one)}`, cfg.hdr, cur?.name || ""); if (v !== null) done(db.updateItem(kind, ui.crudSel, v));
  };
  const del = async () => {
    if (!can("delete_list")) return;
    if (ui.crudSel === null) return warn(`Select a row to delete.`);
    if (await confirmBox(`Are you sure you want to delete this ${cfg.one}?\n\nHeads-up: barcodes use each item's position in the list, so deleting one shifts the position of the items below it.`, { title: `Delete ${cfg.one}`, yes: "Delete", danger: true })) done(db.deleteItem(kind, ui.crudSel));
  };
  $("#add").onclick = add; $("#edit").onclick = edit; $("#del").onclick = del;
  $("#ref").onclick = draw;
  $("#add").hidden = !can("add_list"); $("#edit").hidden = !can("edit_list"); $("#del").hidden = !can("delete_list"); $("#exp").hidden = !can("export");
  $("#cf").oninput = (e) => { ui.crudFilter = e.target.value; draw(); };
  $("#exp").onclick = async () => { download(await db.buildWorkbook(cfg.sheet), `${cfg.one}s_export.xlsx`, XLSX_TYPE); success(`Exported ${cfg.one}s_export.xlsx`); };
  draw();
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ── user management ────────────────────────────────────────────
function renderUsers(el) {
  const rows = auth.listUsers();
  el.innerHTML = `<div class="page-inner"><div><h2 style="margin:0;font-size:22px;letter-spacing:-.3px">👥  User Management</h2><p class="card-hint" style="font-size:13px">Create users and choose what each one can see and do</p></div>
    <section class="card"><div class="row"><button class="btn add" id="u-add">+ Add User</button></div>
      <hr class="rule" style="margin:16px 0 4px"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Username</th><th>Role</th><th>Access</th><th>Last login</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td><b>${esc(u.username)}</b>${u.username === user ? ' <span class="card-hint">(you)</span>' : ""}</td><td>${esc(u.role)}</td>
        <td class="card-hint">${u.perms.length} of ${auth.PERMS.length} permissions</td>
        <td class="card-hint">${u.last_login ? esc(new Date(u.last_login).toLocaleString("en-GB")) : "Never"}</td>
        <td><div class="row" style="justify-content:flex-end"><button class="btn ghost" style="min-height:32px;padding:4px 14px" data-edit="${esc(u.username)}">Edit</button><button class="btn danger" style="min-height:32px;padding:4px 14px" data-del="${esc(u.username)}">Delete</button></div></td></tr>`).join("")}
      </tbody></table></div></section></div>`;
  $("#u-add").onclick = () => userDialog(null);
  $$("[data-edit]", el).forEach((b) => (b.onclick = () => userDialog(rows.find((u) => u.username === b.dataset.edit))));
  $$("[data-del]", el).forEach((b) => (b.onclick = async () => {
    const name = b.dataset.del;
    if (!(await confirmBox(`Delete user '${name}'?\n\nThey will no longer be able to sign in.`, { title: "Delete user", yes: "Delete", danger: true }))) return;
    const [ok, msg] = auth.deleteUser(name, user);
    ok ? success(msg) : failure(msg);
    if (ok) renderUsers(el);
  }));
}

function userDialog(existing) {
  const edit = !!existing;
  const perms = new Set(existing?.perms ?? auth.ROLE_PRESETS.Viewer);
  const m = modal(`<div class="dlg-body"><h3 class="dlg-title">${edit ? "Edit User" : "Add User"}</h3>
    <div class="field"><label>Username</label><input id="uf-name" type="text" value="${esc(existing?.username || "")}" ${edit ? "disabled" : ""} autocapitalize="off" autocomplete="off"></div>
    <div class="field"><label>${edit ? "New password (leave empty to keep)" : "Password"}</label><input id="uf-pw" type="password" autocomplete="new-password"></div>
    <div class="field"><label>Role (fills the permissions below)</label><select id="uf-role">${auth.ROLES.map((r) => `<option ${r === (existing?.role || "Viewer") ? "selected" : ""}>${r}</option>`).join("")}</select></div>
    <div class="field"><label>Permissions</label><div class="check-grid" id="uf-perms">${auth.PERMS.map(([k, l]) => `<label class="check"><input type="checkbox" value="${k}" ${perms.has(k) ? "checked" : ""}>${esc(l)}</label>`).join("")}</div></div>
    <div class="msg err" id="uf-err" role="alert"></div></div>
    <div class="dlg-foot"><span class="spacer"></span><button class="btn quiet" id="uf-x">Cancel</button><button class="btn primary" id="uf-ok">${edit ? "Save" : "Create"}</button></div>`);
  const boxes = $$("#uf-perms input", m.el), role = $("#uf-role", m.el);
  const lock = () => boxes.forEach((b) => { b.disabled = role.value === "Administrator"; if (b.disabled) b.checked = true; });
  role.onchange = () => { const pr = auth.ROLE_PRESETS[role.value]; boxes.forEach((b) => (b.checked = pr.includes(b.value))); lock(); };
  lock();
  $("#uf-x", m.el).onclick = () => m.close();
  $("#uf-ok", m.el).onclick = async () => {
    const sel = boxes.filter((b) => b.checked).map((b) => b.value);
    const [ok, msg] = edit
      ? await auth.updateUser(existing.username, { role: role.value, perms: sel, password: $("#uf-pw", m.el).value })
      : await auth.createUser($("#uf-name", m.el).value, $("#uf-pw", m.el).value, role.value, sel);
    if (!ok) { $("#uf-err", m.el).textContent = msg; return; }
    success(msg); m.close(true);
    if (edit && existing.username === user) renderShell(); else navigate("users");
  };
  $((edit ? "#uf-pw" : "#uf-name"), m.el).focus();
}

// ── profile & security ─────────────────────────────────────────
function openProfile() {
  const m = modal(`<div class="dlg-body" style="gap:16px">
      <div><h3 class="dlg-title">⚙️  Profile &amp; Security</h3><div class="card-hint" style="font-size:13px" id="who">Logged in as  ·  ${esc(user)}</div></div>
      <div class="tabs"><button class="tab on" data-t="u">👤 Username</button><button class="tab" data-t="p">🔒 Password</button><button class="tab" data-t="d">💾 Data</button></div>
      <div data-pane="u" class="gen-form">
        <div class="notice">Enter your new username. You will need it on next login.</div>
        <div class="field"><label>New Username</label><input id="nu" type="text" autocomplete="off" autocapitalize="off"></div>
        <button class="btn primary" id="su">Update Username</button></div>
      <div data-pane="p" class="gen-form" hidden>
        <div class="notice">Min 8 chars · 1 uppercase · 1 lowercase · 1 number · 1 special char</div>
        <div class="field"><label>Current Password</label><input id="op" type="password" autocomplete="current-password"></div>
        <div class="field"><label>New Password</label><input id="np" type="password" autocomplete="new-password"></div>
        <div class="field"><label>Confirm New Password</label><input id="cp" type="password" autocomplete="new-password"></div>
        <button class="btn primary" id="sp">Update Password</button></div>
      <div data-pane="d" class="gen-form" hidden>
        <div class="notice">Your data is stored in this browser. Download a backup regularly, or move your data to another browser/computer with Export → Import. The file is a normal <b>Database.xlsx</b>, compatible with the desktop app.</div>
        <button class="btn ghost" id="bk">↓ Export full database (.xlsx)</button>
        <button class="btn ghost" id="im">↑ Import database (.xlsx) — replaces current data</button>
        <input type="file" id="file" accept=".xlsx,.xls" hidden></div>
    </div><div class="dlg-foot"><span class="spacer"></span><button class="btn quiet" id="x">Close</button></div>`);
  $("#x", m.el).onclick = () => m.close();
  $$(".tab", m.el).forEach((t) => (t.onclick = () => {
    $$(".tab", m.el).forEach((x) => x.classList.toggle("on", x === t));
    $$("[data-pane]", m.el).forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.t));
  }));
  $("#su", m.el).onclick = () => {
    const nu = $("#nu", m.el).value.trim();
    if (!nu) return warn("Please enter the new username.");
    if (nu.toLowerCase() === user) return warn("New username is the same as current.");
    const [ok, msg] = auth.changeUsername(user, nu);
    if (!ok) return failure(msg);
    user = nu.toLowerCase(); success(`Username changed to '${user}'.`); m.close(true); renderShell();
  };
  $("#sp", m.el).onclick = async () => {
    const o = $("#op", m.el).value, n = $("#np", m.el).value, c = $("#cp", m.el).value;
    if (!o || !n || !c) return warn("Please fill in all fields.");
    if (n !== c) return failure("New passwords do not match.");
    const [ok, msg] = await auth.changePassword(user, o, n);
    if (!ok) return failure(msg);
    success("Password changed successfully."); ["#op", "#np", "#cp"].forEach((s) => ($(s, m.el).value = ""));
  };
  $("#bk", m.el).hidden = !can("export"); $("#im", m.el).hidden = !can("import");
  $("#bk", m.el).onclick = async () => {
    const d = new Date(), p = (x) => String(x).padStart(2, "0");
    download(await db.buildWorkbook(), `Database_backup_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`, XLSX_TYPE);
    success("Backup downloaded.");
  };
  $("#im", m.el).onclick = () => $("#file", m.el).click();
  $("#file", m.el).onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    if (!(await confirmBox(`Import “${f.name}”?\n\nThis REPLACES all current factories, categories, colors, sizes and barcodes in this browser. Export a backup first if unsure.`, { title: "Import database", yes: "Replace data", danger: true }))) return;
    try {
      const [ok, msg] = await db.importWorkbook(await f.arrayBuffer());
      if (!ok) return failure(msg);
      ui.lastGen = null; success(msg); m.close(true); navigate(page);
    } catch (err) { failure(`Import failed: ${err.message || err}`); }
  };
}

// ── boot ───────────────────────────────────────────────────────
(async function boot() {
  applyTheme();
  app.innerHTML = `<div style="display:grid;place-items:center;height:100vh;color:var(--t2)">Loading…</div>`;
  const hadData = await db.initDb();
  await auth.initAuth();
  if (!hadData) {
    // first run: start from the sample data shipped with the desktop app
    try {
      const r = await fetch("/assets/Database.sample.xlsx");
      if (r.ok) await db.importWorkbook(await r.arrayBuffer());
    } catch { /* start empty */ }
  }
  user = auth.getSession();
  if (user && auth.exists(user)) renderShell(); else renderLogin();
})();
