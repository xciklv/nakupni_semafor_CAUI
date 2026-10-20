'use strict';
// Krok 2 spiku: z page-dump.json (fetch-page.js) vybere obrázky hlavní galerie, stáhne je (po jednom, SSRF kontrola) do <dir>/orig/,
// zmenší na JPEG (delší strana ≤ maxEdge, výchozí 768) do <dir>/NN.jpg a spočítá dHash/aHash. Stránku znovu NEnačítá.
//   node tools/image-check/select-images.js <dir> [maxObrazku=8] [maxEdge=768]
// Výběr galerie: AliExpress → imagePathList z dat stránky; jinak velké <img> v horní části stránky mimo „doporučené“ bloky (heuristika).
const fs = require('node:fs');
const path = require('node:path');
const { checkUrl } = require('../page-reader/guard');
const { openPixelTool, dhash, ahash } = require('./lib');

function pickGallery(dump, max) {
  if (dump.imagePathLists && dump.imagePathLists[0] && dump.imagePathLists[0].length) return dump.imagePathLists[0].slice(0, max);
  const seen = new Set();
  const out = [];
  const cands = (dump.imgs || []).filter((i) => i.nw >= 300 && i.nh >= 300 && i.w >= 120 && i.y < 1800);
  for (const i of cands) {
    const key = i.src.replace(/_\d+x\d+.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key); out.push(i.src);
    if (out.length >= max) break;
  }
  return out;
}

async function download(url) {
  const g = await checkUrl(url);
  if (!g.ok) throw new Error('zamítnuto: ' + g.duvod);
  const r = await fetch(url, { headers: { accept: 'image/avif,image/webp,image/jpeg,image/png,*/*' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 12e6) throw new Error('příliš velký obrázek');
  return { buf, type: r.headers.get('content-type') || '' };
}

async function main() {
  const [dir, maxArg, edgeArg] = process.argv.slice(2);
  if (!dir) { console.error('použití: node select-images.js <dir> [max] [maxEdge]'); process.exit(2); }
  const max = Number(maxArg) || 8, maxEdge = Number(edgeArg) || 768;
  const dump = JSON.parse(fs.readFileSync(path.join(dir, 'page-dump.json'), 'utf8'));
  if (dump.blocked) { console.error('stránka byla zablokována ověřením, obrázky nejsou'); process.exit(4); }
  const urls = pickGallery(dump, max);
  if (!urls.length) { console.error('galerie nenalezena'); process.exit(5); }
  fs.mkdirSync(path.join(dir, 'orig'), { recursive: true });
  const tool = await openPixelTool();
  const items = [];
  try {
    for (let i = 0; i < urls.length; i++) {
      const nn = String(i + 1).padStart(2, '0');
      try {
        const { buf, type } = await download(urls[i]);
        const ext = /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg';
        fs.writeFileSync(path.join(dir, 'orig', nn + '.' + ext), buf);
        const r = await tool.resize(buf, maxEdge);
        fs.writeFileSync(path.join(dir, nn + '.jpg'), r.buf);
        items.push({ n: nn, url: urls[i], file: nn + '.jpg', srcW: r.srcW, srcH: r.srcH, w: r.w, h: r.h, origBytes: buf.length, bytes: r.buf.length, dhash: await dhash(tool, buf), ahash: await ahash(tool, buf) });
      } catch (e) { items.push({ n: nn, url: urls[i], error: e.message }); }
      await new Promise((r) => setTimeout(r, 800));
    }
  } finally { await tool.close(); }
  fs.writeFileSync(path.join(dir, 'images.json'), JSON.stringify({ source: dump.url, title: dump.title, items }, null, 1));
  console.table(items.map((x) => ({ n: x.n, src: x.srcW + 'x' + x.srcH, sent: x.w + 'x' + x.h, kB: x.bytes && Math.round(x.bytes / 1024), dhash: x.dhash, err: x.error })));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
