'use strict';
// Společné pomůcky spiku „analýza obrázků“: načtení Playwrightu, zmenšení obrázku a perceptuální hash.
// Bez nových závislostí: dekódování JPEG/PNG/WebP dělá Chromium, který projekt kvůli čtečce stránek už má.
const path = require('node:path');

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    path.join(__dirname, '..', '..', '..', 'contact-screening-project', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).chromium; } catch (e) { /* další kandidát */ }
  }
  throw new Error('Playwright nenalezen (nastavte PLAYWRIGHT_PATH).');
}

// Okno Chromia bez sítě (about:blank), jen na práci s pixely.
async function openPixelTool() {
  const browser = await loadPlaywright().launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('about:blank');
  return {
    // Zmenší na delší stranu maxEdge (nezvětšuje), vrátí JPEG jako Buffer + rozměry.
    async resize(buf, maxEdge = 768, quality = 0.82) {
      const r = await page.evaluate(async ({ b64, maxEdge, quality }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes]));
        const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); // průhlednost → bílá
        g.drawImage(bmp, 0, 0, w, h);
        const out = await c.convertToBlob({ type: 'image/jpeg', quality });
        const ab = new Uint8Array(await out.arrayBuffer());
        let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
        return { b64: btoa(s), w, h, srcW: bmp.width, srcH: bmp.height };
      }, { b64: buf.toString('base64'), maxEdge, quality });
      return { buf: Buffer.from(r.b64, 'base64'), w: r.w, h: r.h, srcW: r.srcW, srcH: r.srcH };
    },
    // Šedotónový vzorek w×h (po řádcích) pro dHash/aHash. opts.region = [x0,y0,x1,y1] jako zlomky obrázku; opts.trim = oříznout téměř bílé okraje
    // (obrázky na bílém pozadí a bílé pruhy, kterými marketplace doplňuje na čtverec).
    async gray(buf, w, h, opts = {}) {
      return page.evaluate(async ({ b64, w, h, opts }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes]));
        let [x0, y0, x1, y1] = (opts.region || [0, 0, 1, 1]).map((v, i) => v * (i % 2 ? bmp.height : bmp.width));
        if (opts.trim) {
          const S = 128, k = Math.min(1, S / Math.max(x1 - x0, y1 - y0));
          const tw = Math.max(1, Math.round((x1 - x0) * k)), th = Math.max(1, Math.round((y1 - y0) * k));
          const tc = new OffscreenCanvas(tw, th), tg = tc.getContext('2d', { willReadFrequently: true });
          tg.fillStyle = '#fff'; tg.fillRect(0, 0, tw, th); tg.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, tw, th);
          const d = tg.getImageData(0, 0, tw, th).data;
          let mx0 = tw, my0 = th, mx1 = -1, my1 = -1;
          for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const i = (y * tw + x) * 4; if (d[i] < 238 || d[i + 1] < 238 || d[i + 2] < 238) { if (x < mx0) mx0 = x; if (x > mx1) mx1 = x; if (y < my0) my0 = y; if (y > my1) my1 = y; } }
          if (mx1 >= mx0 && (mx1 - mx0 + 1) * (my1 - my0 + 1) > 0.05 * tw * th) {
            const nx0 = x0 + mx0 / k, ny0 = y0 + my0 / k, nx1 = x0 + (mx1 + 1) / k, ny1 = y0 + (my1 + 1) / k;
            x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1;
          }
        }
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        const out = [];
        for (let i = 0; i < w * h; i++) out.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
        return out;
      }, { b64: buf.toString('base64'), w, h, opts });
    },
    // Zkušební úprava obrázku (odolnost hashe): 'scale' (zmenšení+kvalita), 'crop', 'flip', 'bright', 'border', 'watermark'. Vrací JPEG Buffer.
    async variant(buf, spec) {
      const r = await page.evaluate(async ({ b64, spec }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes]));
        let W = bmp.width, H = bmp.height, sx = 0, sy = 0, sw = W, sh = H, q = 0.9, f = 'none';
        if (spec.op === 'scale') { W = Math.round(W * spec.k); H = Math.round(H * spec.k); q = spec.q; }
        if (spec.op === 'crop') { sx = W * (1 - spec.k) / 2; sy = H * (1 - spec.k) / 2; sw = W * spec.k; sh = H * spec.k; W = Math.round(sw); H = Math.round(sh); }
        if (spec.op === 'bright') f = 'brightness(' + spec.k + ') contrast(1.15)';
        const pad = spec.op === 'border' ? Math.round(W * 0.12) : 0;
        const c = new OffscreenCanvas(W + 2 * pad, H + 2 * pad), g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.filter = f;
        if (spec.op === 'flip') { g.translate(W, 0); g.scale(-1, 1); }
        g.drawImage(bmp, sx, sy, sw, sh, pad, pad, W, H);
        g.setTransform(1, 0, 0, 1, 0, 0); g.filter = 'none';
        if (spec.op === 'watermark') { g.font = 'bold ' + Math.round(H / 14) + 'px sans-serif'; g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillText('SHOPNAME.COM', W * 0.08, H * 0.92); }
        const out = await c.convertToBlob({ type: 'image/jpeg', quality: q });
        const ab = new Uint8Array(await out.arrayBuffer());
        let s = ''; for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
        return btoa(s);
      }, { b64: buf.toString('base64'), spec });
      return Buffer.from(r, 'base64');
    },
    async close() { await browser.close().catch(() => {}); },
  };
}

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
// dHash 64 bitů: zmenšit na 9×8, bit = (pixel vlevo < pixel vpravo). Vrací hex řetězec (16 znaků).
async function dhash(tool, buf, opts) {
  const g = await tool.gray(buf, 9, 8, opts);
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x] < g[y * 9 + x + 1] ? '1' : '0';
  return bitsToHex(bits);
}
// aHash 64 bitů: zmenšit na 8×8, bit = (pixel > průměr).
async function ahash(tool, buf, opts) {
  const g = await tool.gray(buf, 8, 8, opts);
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  return bitsToHex(g.map((v) => (v > mean ? '1' : '0')).join(''));
}
// Hammingova vzdálenost dvou hexových hashů stejné délky.
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

module.exports = { loadPlaywright, openPixelTool, dhash, ahash, hamming };
