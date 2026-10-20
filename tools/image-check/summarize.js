'use strict';
// Souhrn uložených běhů analyze.js: shoda mezi opakováními po jednotlivých obrázcích a poli + součty tokenů a ceny.
//   node tools/image-check/summarize.js <dir> [prefix]      (prefix = začátek názvu souboru v <dir>/runs, např. full-haiku)
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2], prefix = process.argv[3] || '';
const runsDir = path.join(dir, 'runs');
const groups = {};
for (const f of fs.readdirSync(runsDir).filter((x) => x.endsWith('.json') && x.startsWith(prefix))) {
  const key = f.replace(/-\d+\.json$/, '');
  (groups[key] = groups[key] || []).push(JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
}
const mode = (a) => { const c = {}; a.forEach((x) => { c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((x, y) => y[1] - x[1]); };
for (const [key, runs] of Object.entries(groups)) {
  const ok = runs.filter((r) => r.parsed);
  console.log('\n== ' + key + ': ' + runs.length + ' běhů, validní JSON ' + ok.length);
  console.log('  tokeny vstup/výstup (průměr): ' + Math.round(avg(runs.map((r) => r.usage.input_tokens))) + ' / ' + Math.round(avg(runs.map((r) => r.usage.output_tokens))) + ', cena/běh USD ' + avg(runs.map((r) => r.cost_usd)).toFixed(5) + ', čas ' + Math.round(avg(runs.map((r) => r.ms))) + ' ms');
  const fields = ['typ_snimku', 'zobrazuje_prodavany_produkt', 'generovani_ai'];
  const imgs = new Set(); ok.forEach((r) => r.parsed.obrazky.forEach((o) => imgs.add(o.n)));
  for (const f of fields) {
    const row = [...imgs].sort((a, b) => a - b).map((n) => {
      const vals = ok.map((r) => (r.parsed.obrazky.find((o) => o.n === n) || {})[f]);
      const m = mode(vals);
      return n + ':' + m.map(([v, c]) => v + (m.length > 1 ? '×' + c : '')).join('|');
    });
    console.log('  ' + f + ' → ' + row.join('  '));
  }
  console.log('  jeden_produkt: ' + mode(ok.map((r) => r.parsed.celkem.vsechny_obrazky_jeden_produkt)).map(([v, c]) => v + '×' + c).join(', '));
  console.log('  počet rozporů v běhu: ' + ok.map((r) => r.parsed.rozpory.length).join(', '));
  ok.forEach((r, i) => r.parsed.rozpory.forEach((x) => console.log('    [' + (i + 1) + '] obr.' + x.obrazek + ' (' + x.jistota + '): ' + x.tvrzeni_nabidky + ' ⟷ ' + x.co_je_na_obrazku)));
}
function avg(a) { return a.reduce((x, y) => x + y, 0) / a.length; }
