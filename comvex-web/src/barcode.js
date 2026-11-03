/**
 * barcode.js – real Code 128 (Set B) rendering, port of barcode_render.py.
 * Standard size 38.1 x 25.4 mm (scalable 80%-200%), quiet zones 3.63 / 2.31 mm.
 */
const PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312",
  "132212","221213","221312","231212","112232","122132","122231","113222",
  "123122","123221","223211","221132","221231","213212","223112","312131",
  "311222","321122","321221","312212","322112","322211","212123","212321",
  "232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121",
  "313121","211331","231131","213113","213311","213131","311123","311321",
  "331121","312113","312311","332111","314111","221411","431111","111224",
  "111422","121124","121421","141122","141221","112214","112412","122114",
  "122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112",
  "421211","212141","214121","412121","111143","111341","131141","114113",
  "114311","411113","411311","113141","114131","311141","411131","211412",
  "211214","211232","2331112",
];
const START_B = 104, STOP = 106;

const STANDARD_W = 38.1, STANDARD_H = 25.4, QUIET_L = 3.63, QUIET_R = 2.31, LABEL_H = 5.0;
export const MIN_SCALE = 0.8, MAX_SCALE = 2.0;

function values(text) {
  const v = [START_B];
  for (const ch of text) {
    let c = ch.charCodeAt(0);
    if (c < 32 || c > 127) c = 63; // "?"
    v.push(c - 32);
  }
  let sum = v[0];
  for (let i = 1; i < v.length; i++) sum += i * v[i];
  v.push(sum % 103, STOP);
  return v;
}

function runs(text) {
  const out = [];
  for (const val of values(text)) {
    let bar = true;
    for (const ch of PATTERNS[val]) { out.push([bar, Number(ch)]); bar = !bar; }
  }
  return out;
}

export const barcodeSizeMm = (scale = 1) => {
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  return { w: (QUIET_L + STANDARD_W + QUIET_R) * scale, h: (STANDARD_H + LABEL_H) * scale };
};

/** Draw the barcode (bars + human-readable text) onto a fresh canvas. */
export function renderBarcodeCanvas(text, scale = 1, dpi = 300) {
  scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  const pxMm = dpi / 25.4;
  const barW = STANDARD_W * scale * pxMm, barH = STANDARD_H * scale * pxMm;
  const qL = QUIET_L * scale * pxMm, qR = QUIET_R * scale * pxMm, labH = LABEL_H * scale * pxMm;
  const cv = document.createElement("canvas");
  cv.width = Math.max(1, Math.round(qL + barW + qR));
  cv.height = Math.max(1, Math.round(barH + labH));
  const g = cv.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);

  const r = runs(text);
  const units = r.reduce((s, [, w]) => s + w, 0);
  let unit = units ? barW / units : 0;
  let x = qL;
  if (unit >= 2) { // whole-pixel modules → scans reliably
    unit = Math.floor(unit);
    x = qL + Math.round((barW - units * unit) / 2);
  }
  g.fillStyle = "#000";
  for (const [bar, w] of r) {
    if (bar) g.fillRect(x, 0, w * unit, barH);
    x += w * unit;
  }
  g.font = `${Math.max(8, Math.floor(labH * 0.62))}px "JetBrains Mono", Consolas, monospace`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, cv.width / 2, barH + labH / 2);
  return cv;
}

// ── PNG with embedded DPI (pHYs) so it prints at true physical size ──
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pngWithDpi(canvas, dpi) {
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // after signature (8) + IHDR chunk (25)
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at), 0); out.set(chunk, at); out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: "image/png" });
}

export async function ensureFonts() {
  try { await document.fonts.load('12px "JetBrains Mono"'); } catch { /* ignore */ }
}

export async function exportBarcodePng(text, scale = 1, dpi = 300) {
  if (!text || text === "—") return [false, "Nothing to export."];
  await ensureFonts();
  const blob = await pngWithDpi(renderBarcodeCanvas(text, scale, dpi), dpi);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `barcode_${text}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return [true, `barcode_${text}.png`];
}

/** Print at true physical size (38.1 x 25.4 mm) using the browser print dialog. */
export async function printBarcode(text, scale = 1) {
  if (!text || text === "—") return false;
  await ensureFonts();
  const dpi = 300;
  const url = renderBarcodeCanvas(text, scale, dpi).toDataURL("image/png");
  const { w, h } = barcodeSizeMm(scale);
  const f = document.createElement("iframe");
  f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><title>Barcode ${text}</title><style>
    @page{size:A6 landscape;margin:0}
    html,body{margin:0;height:100%}
    body{display:flex;align-items:center;justify-content:center}
    img{width:${w.toFixed(2)}mm;height:${h.toFixed(2)}mm;image-rendering:pixelated}
  </style></head><body><img src="${url}"></body></html>`);
  d.close();
  const img = d.querySelector("img");
  await new Promise((res) => { if (img.complete) res(); else { img.onload = res; img.onerror = res; } });
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => f.remove(), 60_000);
  return true;
}
