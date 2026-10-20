'use strict';
// Perceptuální hash (dHash/aHash, 64 bitů) nad stažennými obrázky: duplicity uvnitř nabídky i mezi nabídkami a zkouška odolnosti hashe.
//   node tools/image-check/hash-compare.js [rootDir=eval/images] [--selftest <obrázek.jpg>] [--max 10]
// Funkce: celý obrázek (whole), po ořezu bílých okrajů (trim), a trim hash polovin obrázku (kolážím typu „auto nahoře, díl dole“).
const fs = require('node:fs');
const path = require('node:path');
const { openPixelTool, dhash, ahash, hamming } = require('./lib');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const REGIONS = { top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 1, 1] };

async function features(tool, buf) {
  const f = { whole: await dhash(tool, buf), awhole: await ahash(tool, buf), trim: await dhash(tool, buf, { trim: true }), atrim: await ahash(tool, buf, { trim: true }), regions: {} };
  for (const [k, r] of Object.entries(REGIONS)) f.regions[k] = await dhash(tool, buf, { region: r, trim: true });
  return f;
}

async function main() {
  const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'eval/images';
  const max = Number(arg('max', 10));
  const tool = await openPixelTool();
  try {
    const self = arg('selftest', null);
    if (self) {
      const buf = fs.readFileSync(self);
      const base = await features(tool, buf);
      const specs = [
        { name: 'zmenšeno na 50 %, JPEG q50', op: 'scale', k: 0.5, q: 0.5 }, { name: 'zmenšeno na 25 %, JPEG q30', op: 'scale', k: 0.25, q: 0.3 },
        { name: 'ořez na 90 % ze středu', op: 'crop', k: 0.9 }, { name: 'ořez na 75 % ze středu', op: 'crop', k: 0.75 }, { name: 'ořez na 60 % ze středu', op: 'crop', k: 0.6 },
        { name: 'zrcadlově převráceno', op: 'flip' }, { name: 'jas ×1,25 + kontrast', op: 'bright', k: 1.25 }, { name: 'bílý rámeček 12 %', op: 'border' }, { name: 'průsvitný vodoznak v rohu', op: 'watermark' },
      ];
      console.log('vzdálenost (bitů z 64) od originálu ' + self + ':');
      console.log('varianta'.padEnd(34) + 'dHash'.padEnd(7) + 'aHash'.padEnd(7) + 'dHash-trim  aHash-trim');
      for (const s of specs) {
        const f = await features(tool, await tool.variant(buf, s));
        console.log(s.name.padEnd(34) + String(hamming(base.whole, f.whole)).padEnd(7) + String(hamming(base.awhole, f.awhole)).padEnd(7) + String(hamming(base.trim, f.trim)).padEnd(12) + hamming(base.atrim, f.atrim));
      }
      return;
    }
    const imgs = [];
    for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith('_'))) {
      const p = path.join(root, d.name, 'images.json');
      if (!fs.existsSync(p)) continue;
      for (const it of JSON.parse(fs.readFileSync(p, 'utf8')).items.filter((x) => x.file)) {
        imgs.push({ id: d.name + '/' + it.n, offer: d.name, ...(await features(tool, fs.readFileSync(path.join(root, d.name, it.file)))) });
      }
    }
    console.log('obrázků: ' + imgs.length);
    const pairs = [];
    for (let i = 0; i < imgs.length; i++) for (let j = i + 1; j < imgs.length; j++) pairs.push({ a: imgs[i], b: imgs[j], d: hamming(imgs[i].whole, imgs[j].whole), da: hamming(imgs[i].awhole, imgs[j].awhole), dt: hamming(imgs[i].trim, imgs[j].trim) });
    const sorted = (k) => pairs.map((p) => p[k]).sort((x, y) => x - y);
    console.log('rozdělení vzdáleností všech různých dvojic, dHash: min ' + sorted('d')[0] + ', medián ' + sorted('d')[Math.floor(pairs.length / 2)] + ', max ' + sorted('d').pop() + '; po ořezu (trim): min ' + sorted('dt')[0]);
    console.log('\nDvojice s dHash (celý obrázek) ≤ ' + max + ' nebo trim ≤ ' + max + ':');
    pairs.filter((p) => p.d <= max || p.dt <= max).sort((x, y) => Math.min(x.d, x.dt) - Math.min(y.d, y.dt)).forEach((p) => console.log('  ' + p.a.id + ' ~ ' + p.b.id + '  whole ' + p.d + ', trim ' + p.dt + ', aHash ' + p.da + (p.a.offer === p.b.offer ? '  (stejná nabídka)' : '  (různé nabídky)')));
    console.log('\nPolovina jednoho obrázku ≈ celý jiný obrázek (trim hash, ≤ ' + max + '):');
    for (const a of imgs) for (const b of imgs) {
      if (a === b) continue;
      for (const [k, h] of Object.entries(a.regions)) { const d = hamming(h, b.trim); if (d <= max) console.log('  ' + a.id + ' [' + k + '] ~ ' + b.id + ' (celý)  ' + d); }
    }
  } finally { await tool.close(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
