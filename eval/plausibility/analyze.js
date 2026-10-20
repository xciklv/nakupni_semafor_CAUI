#!/usr/bin/env node
// Vyhodnocení spike: načte results/*.jsonl (kromě *-smoke) a cases.json, spočítá metriky na model a variantu a zapíše results/summary.json a summary.md.
//   node eval/plausibility/analyze.js
const fs = require('node:fs');
const path = require('node:path');

const DIR = __dirname;
const RES = path.join(DIR, 'results');
const cases = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const RANK = { v_poradku: 0, nepravdepodobne: 1, nesmysl: 2 };
const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + ' %' : '–');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const groups = [];
for (const f of fs.readdirSync(RES).filter((x) => x.endsWith('.jsonl') && !x.includes('smoke'))) {
  const rows = fs.readFileSync(path.join(RES, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  groups.push({ name: f.replace('.jsonl', ''), rows });
  // Navíc „běh 1“ samotný: souhrn přes všechna volání je u opakovaných modelů zkreslený výběrem těžkých případů.
  if (rows.some((r) => r.run > 1)) groups.push({ name: f.replace('.jsonl', '') + ' [jen běh 1]', rows: rows.filter((r) => r.run === 1) });
}

function metrics(rows) {
  const ok = rows.filter((r) => r.out);
  const m = { volani: rows.length, chyby: rows.length - ok.length };
  let exact = 0, flagOk = 0, falseAlarm = 0, nOk = 0, missed = 0, nBad = 0, strongAsWeak = 0, nNes = 0;
  const confusion = {};
  for (const r of ok) {
    const exp = byId[r.id].ocekavany, got = r.out.verdikt;
    confusion[exp + '→' + got] = (confusion[exp + '→' + got] || 0) + 1;
    if (exp === got) exact++;
    if ((exp === 'v_poradku') === (got === 'v_poradku')) flagOk++;
    if (exp === 'v_poradku') { nOk++; if (got !== 'v_poradku') falseAlarm++; }
    else { nBad++; if (got === 'v_poradku') missed++; }
    if (exp === 'nesmysl') { nNes++; if (got !== 'nesmysl') strongAsWeak++; }
  }
  Object.assign(m, { presnost_verdiktu: pct(exact, ok.length), rozliseni_problem_vs_ok: pct(flagOk, ok.length), falesny_poplach: pct(falseAlarm, nOk) + ` (${falseAlarm}/${nOk})`, prehlednuto: pct(missed, nBad) + ` (${missed}/${nBad})`, nesmysl_jen_jako_nepravdepodobne: pct(strongAsWeak - missedNes(ok), nNes), confusion });
  // konzistence: případy se ≥2 běhy; podíl případů, kde všechny běhy dají stejný verdikt
  const per = {};
  for (const r of ok) (per[r.id] = per[r.id] || []).push(r.out.verdikt);
  const multi = Object.entries(per).filter(([, v]) => v.length >= 2);
  const same = multi.filter(([, v]) => new Set(v).size === 1).length;
  m.konzistence = multi.length ? pct(same, multi.length) + ` (${same}/${multi.length} případů, verdikt shodný ve všech během)` : '–';
  m.nestabilni_pripady = multi.filter(([, v]) => new Set(v).size > 1).map(([id, v]) => `${id}: ${v.join('/')}`);
  const wrongAll = Object.entries(per).filter(([id, v]) => v.every((x) => x !== byId[id].ocekavany)).map(([id, v]) => `${id} (čekáno ${byId[id].ocekavany}, dostal ${v.join('/')})`);
  m.vzdy_spatne = wrongAll;
  const usd = rows.reduce((s, r) => s + (r.usd || 0), 0);
  m.naklady_usd = +usd.toFixed(4);
  m.cena_na_kontrolu_usd = ok.length ? +(usd / rows.filter((r) => r.usd).length).toFixed(5) : 0;
  m.vstup_tok_prumer = Math.round(rows.reduce((s, r) => s + (r.usage ? r.usage.input_tokens + (r.usage.cache_creation_input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) : 0), 0) / Math.max(1, rows.filter((r) => r.usage).length));
  m.vystup_tok_prumer = Math.round(rows.reduce((s, r) => s + (r.usage ? r.usage.output_tokens : 0), 0) / Math.max(1, rows.filter((r) => r.usage).length));
  m.latence_median_s = +(med(rows.map((r) => r.ms)) / 1000).toFixed(1);
  m.latence_max_s = +(Math.max(0, ...rows.map((r) => r.ms)) / 1000).toFixed(1);
  m.cache_cteni_tok = rows.reduce((s, r) => s + (r.usage ? r.usage.cache_read_input_tokens || 0 : 0), 0);
  return m;
}
const missedNes = (ok) => ok.filter((r) => byId[r.id].ocekavany === 'nesmysl' && r.out.verdikt === 'v_poradku').length;

const summary = {};
for (const g of groups) summary[g.name] = metrics(g.rows);
fs.writeFileSync(path.join(RES, 'summary.json'), JSON.stringify(summary, null, 2));

const L = ['# Souhrn měření (generováno analyze.js)', ''];
L.push('| běh | volání | chyby | přesnost verdiktu | problém×OK | falešný poplach | přehlédnuto | konzistence | USD celkem | USD/volání | výstup tok. | latence med. s |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const [n, m] of Object.entries(summary)) L.push(`| ${n} | ${m.volani} | ${m.chyby} | ${m.presnost_verdiktu} | ${m.rozliseni_problem_vs_ok} | ${m.falesny_poplach} | ${m.prehlednuto} | ${m.konzistence} | ${m.naklady_usd} | ${m.cena_na_kontrolu_usd} | ${m.vystup_tok_prumer} | ${m.latence_median_s} |`);
L.push('');
for (const [n, m] of Object.entries(summary)) {
  L.push(`## ${n}`, '', 'Matice očekávané→dostal: ' + Object.entries(m.confusion).sort().map(([k, v]) => `${k}=${v}`).join(', '), '');
  if (m.nestabilni_pripady.length) L.push('Nestabilní případy: ' + m.nestabilni_pripady.join('; '), '');
  if (m.vzdy_spatne.length) L.push('Vždy špatně: ' + m.vzdy_spatne.join('; '), '');
}
fs.writeFileSync(path.join(RES, 'summary.md'), L.join('\n'));
console.log(L.join('\n'));
