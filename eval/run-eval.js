#!/usr/bin/env node
// Testovací sada Nákupního semaforu: pošle každý případ z eval/cases.json na webhook,
// spočítá metriky a zapíše eval/vysledky.json (strojově) a eval/vysledky.md (česky, čitelně).
//
// Použití (z kořene projektu, plain Node, žádné závislosti):
//   node eval/run-eval.js                        všechny případy
//   node eval/run-eval.js --only podvod          jen jeden label (ok | sporne | podvod)
//   node eval/run-eval.js --ids coi-epiona-cz,text-asdf-sporne    jen vybraná id
//   node eval/run-eval.js --ids produkt-megaknihy-parfem --repeat 5   každý případ 5× (1 až 10) a přehled, kolik se výsledek mění;
//                                                                     model nejde nastavit na deterministický výstup, takže jeden běh stabilitu neukáže
//   node eval/run-eval.js --ids a,b --repeat 5 --gate   navíc vyhodnotí kritérium stability (eval/gate.js), vypíše PASS/FAIL s důvody
//                                                       a při FAIL skončí s kódem 1
//
// Proměnné prostředí:
//   API         adresa webhooku (výchozí http://127.0.0.1:5678/webhook/nakupni-semafor)
//   DELAY_MS    pauza mezi požadavky v ms (výchozí 1500; případy se posílají postupně)
//   TIMEOUT_MS  limit jednoho požadavku v ms (výchozí 60000)
//
// Případ v eval/cases.json: { id, label: "ok"|"sporne"|"podvod", skupina, zdroj, poznamka?, <vstup> }, kde <vstup> je
// právě jedno z:
//   "odkaz": "https://eshop.cz/"                      odkaz na e-shop nebo nabídku
//   "text": "text nabídky ..."                         vložený text
//   "screenshotFiles": ["temu-powerbanka.png"]         soubory v eval/screens/ (png, jpg, jpeg, webp)
//
// skupina: "coi" (seznam ČOI, kruhová: jen kontrola funkčnosti, ne měřítko detekce), "legit" (známé e-shopy),
// "synthetic" (vlastní texty), "screens" (screenshoty). Chybí-li skupina, použije se "screens" pro screenshotFiles,
// jinak "synthetic". Souhrn uvádí detekci bez skupiny ČOI zvlášť.
//
// Jak přidat případ se screenshotem (marketplace nabídky z Temu, AliExpressu, Allega):
//   1. ulož screenshot do eval/screens/ (složka je v .gitignore, do gitu nejde)
//   2. přidej do eval/cases.json záznam, např.
//      { "id": "temu-powerbanka", "label": "podvod", "skupina": "screens", "screenshotFiles": ["temu-powerbanka.png"], "zdroj": "vlastní screenshot 2026-10-20" }
//   3. spusť node eval/run-eval.js --ids temu-powerbanka
// Chybí-li soubor, případ se zapíše jako "chyba" a běh pokračuje.
//
// Výstup: eval/vysledky.json a eval/vysledky.md (obojí v .gitignore). Skript nikdy nespadne na špatné odpovědi:
// zapíše {id, label, stav: "chyba", chyba} a jede dál. Případy typu "sporne" se do metrik zachycení a falešného
// poplachu nepočítají, jen se vypíšou.
const fs = require('node:fs');
const path = require('node:path');
const { computeMetrics } = require('./metrics');
const { evaluateGate, formatGate, isMarketplaceCase } = require('./gate');
const { buildRequestBody, toResultRecord, errorRecord, readNumberEnv, parseArgs, selectCases, renderReport, stabilityLines } = require('./report');

const API = process.env.API || 'http://127.0.0.1:5678/webhook/nakupni-semafor';
// Neplatná hodnota (nečíslo, záporná; u TIMEOUT_MS i 0) = výchozí.
const DELAY_MS = readNumberEnv(process.env.DELAY_MS, 1500);
const TIMEOUT_MS = readNumberEnv(process.env.TIMEOUT_MS, 60000, false);
const SCREENS = path.join(__dirname, 'screens');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCase(c) {
  let body;
  try {
    body = buildRequestBody(c, SCREENS);
  } catch (e) {
    return errorRecord(c, e.message);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    let j = null;
    try {
      j = await res.json();
    } catch (_) {
      return errorRecord(c, 'HTTP ' + res.status + ', odpověď není JSON');
    }
    const rec = toResultRecord(c, j);
    if (rec.stav === 'chyba' && !rec.chyba.startsWith('HTTP')) rec.chyba = 'HTTP ' + res.status + ': ' + rec.chyba;
    return rec;
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return errorRecord(c, timeout ? 'Časový limit ' + TIMEOUT_MS + ' ms' : 'Požadavek selhal: ' + (e && e.message ? e.message : e));
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
  const cases = selectCases(all, opts);
  if (!cases.length) throw new Error('Žádný případ nevyhovuje výběru.');
  console.log('API: ' + API + ', případů: ' + cases.length + (opts.repeat > 1 ? ', opakování: ' + opts.repeat : ''));
  const results = [];
  const total = cases.length * opts.repeat;
  let done = 0;
  for (const c of cases) {
    for (let rep = 0; rep < opts.repeat; rep++) {
      const rec = await runCase(c);
      if (isMarketplaceCase(c)) rec.marketplace = true;
      results.push(rec);
      done += 1;
      console.log(c.id.padEnd(40), c.label.padEnd(7), rec.semafor || rec.stav + (rec.chyba ? ' (' + rec.chyba + ')' : ''), opts.repeat > 1 ? 'skóre ' + rec.skore : '');
      if (done < total && DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }
  if (opts.repeat > 1) { console.log('\nStabilita:'); for (const l of stabilityLines(results)) console.log(l); }
  const m = computeMetrics(results);
  const datum = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(__dirname, 'vysledky.json'), JSON.stringify({ datum, api: API, metriky: m, vysledky: results }, null, 2));
  fs.writeFileSync(path.join(__dirname, 'vysledky.md'), renderReport(results, { datum, api: API, repeat: opts.repeat }));
  console.log(m);
  console.log('Zapsáno: eval/vysledky.json, eval/vysledky.md');
  if (opts.gate) {
    const g = evaluateGate(results, { repeat: opts.repeat });
    console.log('\nKritérium stability:');
    for (const l of formatGate(g)) console.log(l);
    if (!g.pass) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
