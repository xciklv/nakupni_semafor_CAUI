'use strict';
// Obrázky nabídky pro analýzu: stažení (SSRF kontrola v každém kroku přesměrování), zmenšení na JPEG a perceptuální hash (dHash).
// Bez nových závislostí: dekódování JPEG/PNG/WebP a zmenšení dělá Chromium, který čtečka stránek už má. Žádná síť v prohlížeči (about:blank).
// dHash se počítá ze vzorku 9×8, takže hashe jsou mezi nabídkami srovnatelné.
const { checkUrl } = require('./guard');

const MAX_IMAGES = 8;
const MAX_URL = 2048;
const MAX_EDGE = 768; // delší strana zmenšeného obrázku
const JPEG_QUALITY = 0.82;
const MAX_BYTES = 12000000; // větší originál se nestahuje
const DOWNLOAD_MS = 10000;
const PROCESS_MS = 15000; // dekódování a zmenšení jednoho obrázku
const MAX_REDIRECTS = 3;
const IMAGE_TYPE_RE = /^image\/(jpeg|jpg|png|webp|gif|avif|bmp)\b/i; // SVG a ostatní typy ne

// { ok:true, urls } | { ok:false, duvod }. Jen https:, nejvýše MAX_IMAGES, bez duplicit.
function validateImageUrls(urls) {
  if (!Array.isArray(urls)) return { ok: false, duvod: 'urls musí být pole adres' };
  if (!urls.length || urls.length > MAX_IMAGES) return { ok: false, duvod: 'urls musí obsahovat 1 až ' + MAX_IMAGES + ' adres' };
  const out = [];
  for (const u of urls) {
    const s = typeof u === 'string' ? u.trim() : '';
    if (!s || s.length > MAX_URL || !/^https:\/\//i.test(s)) return { ok: false, duvod: 'povolené jsou jen adresy https:// do ' + MAX_URL + ' znaků' };
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, urls: out };
}

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
// dHash 64 bitů z šedotónového vzorku 9×8 (po řádcích): bit = pixel vlevo je tmavší než pixel vpravo. Výsledek je 16 hex znaků.
function dhashFromGray(gray) {
  if (!Array.isArray(gray) || gray.length !== 72) throw new Error('dHash potřebuje vzorek 9×8 (72 hodnot)');
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] < gray[y * 9 + x + 1] ? '1' : '0';
  return bitsToHex(bits);
}

// Stažení jednoho obrázku. Adresa se kontroluje před každým krokem, přesměrování se nenásledují automaticky (cíl by mohl být interní adresa).
function createDownloader({ check = checkUrl, fetchImpl = (typeof fetch === 'function' ? fetch : null), maxBytes = MAX_BYTES, timeoutMs = DOWNLOAD_MS, maxRedirects = MAX_REDIRECTS } = {}) {
  const tooBig = () => new Error('obrázek je příliš velký');
  async function readBody(res) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw tooBig();
      return buf;
    }
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw tooBig(); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  return async function download(startUrl) {
    const ctl = new AbortController();
    let timer;
    const limit = new Promise((resolve, reject) => { timer = setTimeout(() => { ctl.abort(); reject(new Error('čas na stažení obrázku vypršel')); }, timeoutMs); });
    const work = (async () => {
      let url = startUrl;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const g = await check(url);
        if (!g || !g.ok) throw new Error('adresa není povolená: ' + ((g && g.duvod) || 'neznámý důvod'));
        if (!/^https:\/\//i.test(url)) throw new Error('povolen je jen https');
        const res = await fetchImpl(url, { redirect: 'manual', signal: ctl.signal, headers: { accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5' } });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (location) { url = new URL(location, url).href; continue; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const type = String(res.headers.get('content-type') || '').trim();
        if (!IMAGE_TYPE_RE.test(type)) throw new Error('odpověď není obrázek (' + (type.slice(0, 40) || 'bez typu') + ')');
        const cl = String(res.headers.get('content-length') || '').trim();
        if (/^[0-9]+$/.test(cl) && Number(cl) > maxBytes) throw tooBig();
        return { buf: await readBody(res), type: type.toLowerCase() };
      }
      throw new Error('příliš mnoho přesměrování');
    })();
    work.catch(() => {});
    try { return await Promise.race([work, limit]); } finally { clearTimeout(timer); }
  };
}

// Okno Chromia bez sítě, jen na práci s pixely. process(buf) -> { jpeg: Buffer, gray: number[72] }: JPEG s delší stranou nejvýše MAX_EDGE
// (nezvětšuje; průhlednost se vyplní bílou) a vzorek 9×8 z původního obrázku pro dHash.
async function openPixelTool(chromium) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    return {
      async process(buf, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
        let timer;
        const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('zpracování obrázku vypršelo')), PROCESS_MS); });
        const work = page.evaluate(async ({ b64, maxEdge, quality }) => {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes]));
          const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
          const w = Math.max(1, Math.round(bmp.width * k));
          const h = Math.max(1, Math.round(bmp.height * k));
          const canvas = new OffscreenCanvas(w, h);
          const g = canvas.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
          g.drawImage(bmp, 0, 0, w, h);
          const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
          const ab = new Uint8Array(await out.arrayBuffer());
          let s = '';
          for (let i = 0; i < ab.length; i += 0x8000) s += String.fromCharCode.apply(null, ab.subarray(i, i + 0x8000));
          const sc = new OffscreenCanvas(9, 8);
          const sg = sc.getContext('2d', { willReadFrequently: true });
          sg.fillStyle = '#fff'; sg.fillRect(0, 0, 9, 8);
          sg.drawImage(bmp, 0, 0, 9, 8);
          const d = sg.getImageData(0, 0, 9, 8).data;
          const gray = [];
          for (let i = 0; i < 72; i++) gray.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
          return { b64: btoa(s), gray };
        }, { b64: buf.toString('base64'), maxEdge, quality });
        work.catch(() => {});
        try {
          const r = await Promise.race([work, limit]);
          return { jpeg: Buffer.from(r.b64, 'base64'), gray: r.gray };
        } finally { clearTimeout(timer); }
      },
      async close() { await browser.close().catch(() => {}); },
    };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

// Služba obrázků: urls -> { ok:true, obrazky:[{ url, mime, data, dhash }], vynechano?:[{ url, duvod }] } | { ok:false, duvod }.
// Obrázek, který nejde stáhnout nebo zpracovat, se vynechá (a zapíše do `vynechano`), ostatní projdou. Obrázky se zpracovávají po jednom.
function createImageService({ openTool, download = createDownloader() }) {
  return async function images(urls) {
    let tool;
    try { tool = await openTool(); } catch (e) { return { ok: false, duvod: 'prohlížeč pro zpracování obrázků se nespustil' }; }
    const obrazky = [];
    const vynechano = [];
    try {
      for (const url of urls) {
        try {
          const { buf } = await download(url);
          const r = await tool.process(buf);
          obrazky.push({ url, mime: 'image/jpeg', data: r.jpeg.toString('base64'), dhash: dhashFromGray(r.gray) });
        } catch (e) {
          vynechano.push({ url, duvod: String((e && e.message) || 'obrázek se nepodařilo zpracovat').slice(0, 120) });
        }
      }
    } finally { await tool.close(); }
    return vynechano.length ? { ok: true, obrazky, vynechano } : { ok: true, obrazky };
  };
}

module.exports = { createImageService, createDownloader, openPixelTool, dhashFromGray, validateImageUrls, MAX_IMAGES, MAX_EDGE };
