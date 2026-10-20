#!/usr/bin/env node
// Spike věrohodnosti: pošle případy z cases.json přes n8n workflow „TEST – plausibility spike“ (webhook -> Anthropic Messages API)
// a zapíše každé volání jako řádek do results/<model>-<varianta>.jsonl. Plain Node, žádné závislosti.
//
//   node eval/plausibility/run.js --model claude-haiku-5-5 --variant P1 --repeat 3
//   node eval/plausibility/run.js --model claude-sonnet-5-5 --variant P1 --repeat 1 --ids kolo-25500-real,pb-30000-199
//
// Rozpočet: results/ledger.json drží součet nákladů ze všech běhů (z usage v odpovědích). Před každým voláním se kontroluje
// CAP_USD (výchozí 0.58); při dosažení se běh zastaví. Už hotové dvojice (případ, běh) se přeskočí, takže běh lze opakovat.
const fs = require('node:fs');
const path = require('node:path');
const { buildRequest } = require('./prompt');

const URL_ = process.env.API || 'http://127.0.0.1:5678/webhook/test-plausibility-spike';
const CAP_USD = Number(process.env.CAP_USD || 0.58);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
// USD za milion tokenů (vstup, výstup) podle zadání.
const PRICES = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };
const DIR = __dirname;
const RES = path.join(DIR, 'results');
const LEDGER = path.join(RES, 'ledger.json');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const model = arg('model');
const variant = arg('variant', 'P1');
const repeat = Number(arg('repeat', 1));
const ids = arg('ids') ? arg('ids').split(',') : null;
const tag = arg('tag', '');
if (!PRICES[model]) { console.error('--model musí být jeden z: ' + Object.keys(PRICES).join(', ')); process.exit(2); }

const cases = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8')).filter((c) => !ids || ids.includes(c.id));
fs.mkdirSync(RES, { recursive: true });
const outFile = path.join(RES, `${model}-${variant}${tag}.jsonl`);
const done = new Set();
if (fs.existsSync(outFile)) for (const l of fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); done.add(r.id + '#' + r.run); }
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { total_usd: 0, calls: 0, by_model: {} };
const saveLedger = () => fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));

// Cena z usage: necachovaný vstup 1×, zápis do cache 1,25×, čtení z cache 0,1× ceny vstupu; výstup (včetně myšlení) cena výstupu.
const cost = (m, u) => ((u.input_tokens + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0)) * PRICES[m][0] + u.output_tokens * PRICES[m][1]) / 1e6;

async function callOne(c, run) {
  const body = buildRequest(c.vstup, model, variant);
  const t0 = Date.now();
  let api = null, err = null;
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
    const txt = await res.text();
    try { api = JSON.parse(txt); } catch (e) { err = 'HTTP ' + res.status + ' nevalidní JSON: ' + txt.slice(0, 200); }
  } catch (e) { err = String(e.message || e); }
  const ms = Date.now() - t0;
  const rec = { id: c.id, run, model, variant, ms, stop_reason: api && api.stop_reason, usage: api && api.usage, err };
  if (api && api.type === 'error') rec.err = JSON.stringify(api.error).slice(0, 300);
  if (api && Array.isArray(api.content)) {
    const text = api.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { rec.out = JSON.parse(text); } catch (e) { rec.err = 'nevalidní JSON z modelu: ' + text.slice(0, 200); }
  } else if (api && !rec.err) rec.err = 'odpověď bez content: ' + JSON.stringify(api).slice(0, 300);
  if (api && api.usage) {
    rec.usd = cost(model, api.usage);
    ledger.total_usd += rec.usd; ledger.calls += 1;
    ledger.by_model[model] = (ledger.by_model[model] || 0) + rec.usd;
    saveLedger();
  }
  fs.appendFileSync(outFile, JSON.stringify(rec) + '\n');
  return rec;
}

(async () => {
  const jobs = [];
  for (let run = 1; run <= repeat; run++) for (const c of cases) if (!done.has(c.id + '#' + run)) jobs.push([c, run]);
  console.log(`${model} ${variant}: ${jobs.length} volání, dosud utraceno ${ledger.total_usd.toFixed(4)} USD (strop ${CAP_USD})`);
  let next = 0, stop = false, ok = 0, bad = 0;
  // První volání samo, aby se zapsala cache systémového promptu dřív, než ji začnou číst paralelní volání.
  if (jobs.length) { const [c0, r0] = jobs[next++]; const x = await callOne(c0, r0); if (x.out) ok++; else { bad++; console.log('CHYBA', c0.id, r0, x.err); } }
  const worker = async () => {
    while (!stop && next < jobs.length) {
      if (ledger.total_usd >= CAP_USD) { stop = true; console.log('STROP ROZPOČTU dosažen, zastavuji'); break; }
      const [c, run] = jobs[next++];
      const r = await callOne(c, run);
      if (r.out) ok++; else { bad++; console.log('CHYBA', c.id, run, r.err); }
      if ((ok + bad) % 10 === 0) console.log(`  ${ok + bad}/${jobs.length}  celkem ${ledger.total_usd.toFixed(4)} USD`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`hotovo: ok ${ok}, chyb ${bad}, celkem utraceno ${ledger.total_usd.toFixed(4)} USD`);
})();
