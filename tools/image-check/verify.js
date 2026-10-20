'use strict';
// Strojová kontrola výstupu modelu: model smí obrázky číst, ale tvrzení, která uživateli ukážeme, musí projít kontrolou, kterou model sám neovlivní.
//  1) rozpor s číslem se uzná jen když (a) číslo z obrázku model skutečně opsal do precteny_text téhož obrázku a (b) toto číslo se
//     v textu nabídky NEVYSKYTUJE (tím odpadne „10000 mAh“ proti „>8000 mAh a 10000mAh v názvu“) a (c) číslo z tvrzení nabídky v textu nabídky je;
//  2) rozpor bez čísla (barva, tvar) se bere jen s jistotou "vysoka" a shodou aspoň ve 2 ze 3 běhů, jinak se zahodí;
//  3) věty, které rozpor popírají ("není rozpor"), se zahodí; 4) kategorie se berou většinovým hlasem přes opakování, s podílem shody.
// CLI:  node tools/image-check/verify.js <dir> <prefix>      (prefix = začátek názvu souboru v <dir>/runs, např. v2-haiku)
const fs = require('node:fs');
const path = require('node:path');

const nums = (s) => (String(s).replace(/(\d)[  ](?=\d{3}\b)/g, '$1').match(/\d{2,}(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));
const DENIES = /není rozpor|nejde o rozpor|nerozporuje|neodporuje|nelze posoudit jako rozpor|v rozsahu|odpovídá/i;

function checkClaim(r, parsed, offerText) {
  if (DENIES.test(r.co_je_na_obrazku + ' ' + r.tvrzeni_nabidky)) return { ok: false, why: 'rozpor popřen vlastním textem' };
  const img = (parsed.obrazky || []).find((o) => o.n === r.obrazek);
  const imgNums = nums((img && img.precteny_text || []).join(' '));
  const claimImgNums = nums(r.co_je_na_obrazku);
  const claimOfferNums = nums(r.tvrzeni_nabidky);
  const offerNums = new Set(nums(offerText));
  if (claimImgNums.length) {
    const seenOnImage = claimImgNums.filter((x) => imgNums.includes(x));
    if (!seenOnImage.length) return { ok: false, why: 'číslo z obrázku není v přečteném textu obrázku' };
    if (seenOnImage.every((x) => offerNums.has(x))) return { ok: false, why: 'číslo z obrázku nabídka také uvádí' };
    if (claimOfferNums.length && !claimOfferNums.some((x) => offerNums.has(x))) return { ok: false, why: 'číslo z nabídky v textu nabídky není' };
    return { ok: true, druh: 'cislo', key: r.obrazek + ':' + seenOnImage.filter((x) => !offerNums.has(x)).sort().join(',') };
  }
  if (r.jistota !== 'vysoka') return { ok: false, why: 'bez čísla a jistota není vysoká' };
  return { ok: true, druh: 'kvalitativni', key: r.obrazek + ':' + String(r.tvrzeni_nabidky).toLowerCase().slice(0, 20) };
}

// runs: pole parsed výstupů téže nabídky (opakování). Vrací konsolidovaný výsledek.
function consolidate(runs, offerText) {
  const k = runs.length;
  const vote = (vals) => {
    const c = {}; vals.forEach((v) => { c[v] = (c[v] || 0) + 1; });
    const [v, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return { hodnota: v, shoda: n / vals.length };
  };
  const ns = new Set(); runs.forEach((p) => p.obrazky.forEach((o) => ns.add(o.n)));
  const obrazky = [...ns].sort((a, b) => a - b).map((n) => {
    const per = runs.map((p) => p.obrazky.find((o) => o.n === n)).filter(Boolean);
    return { n, typ_snimku: vote(per.map((o) => o.typ_snimku)), zobrazuje_prodavany_produkt: vote(per.map((o) => o.zobrazuje_prodavany_produkt)), generovani_ai: vote(per.map((o) => o.generovani_ai)), co_je_videt: per[0].co_je_videt, precteny_text: per[0].precteny_text };
  });
  const claims = {};
  runs.forEach((p, i) => (p.rozpory || []).forEach((r) => {
    const c = checkClaim(r, p, offerText);
    if (!c.ok) return;
    const e = claims[c.key] = claims[c.key] || { druh: c.druh, obrazek: r.obrazek, behy: new Set(), priklad: r };
    e.behy.add(i);
  }));
  const rozpory = Object.values(claims).map((e) => ({ druh: e.druh, obrazek: e.obrazek, shoda: e.behy.size / k, tvrzeni_nabidky: e.priklad.tvrzeni_nabidky, co_je_na_obrazku: e.priklad.co_je_na_obrazku }))
    .filter((e) => e.shoda >= 2 / 3); // oba druhy chtějí shodu ve většině běhů
  return { obrazky, rozpory, jeden_produkt: vote(runs.map((p) => p.celkem.vsechny_obrazky_jeden_produkt)) };
}

if (require.main === module) {
  const [dir, prefix = ''] = process.argv.slice(2);
  const runsDir = path.join(dir, 'runs');
  const runs = fs.readdirSync(runsDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'))).filter((r) => r.parsed).map((r) => r.parsed);
  const offerText = fs.readFileSync(path.join(dir, 'page-text.txt'), 'utf8').slice(0, 2200);
  const out = consolidate(runs, offerText);
  console.log('běhů: ' + runs.length);
  out.obrazky.forEach((o) => console.log('obr.' + o.n + ': ' + o.typ_snimku.hodnota + ' (' + Math.round(o.typ_snimku.shoda * 100) + ' %), produkt: ' + o.zobrazuje_prodavany_produkt.hodnota + ' (' + Math.round(o.zobrazuje_prodavany_produkt.shoda * 100) + ' %), AI: ' + o.generovani_ai.hodnota));
  console.log('jeden produkt na všech: ' + out.jeden_produkt.hodnota + ' (' + Math.round(out.jeden_produkt.shoda * 100) + ' %)');
  console.log('uznané rozpory: ' + JSON.stringify(out.rozpory, null, 1));
}

module.exports = { consolidate, checkClaim, nums };
