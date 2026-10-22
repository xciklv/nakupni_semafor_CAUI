const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflow } = require('../build/build-workflow');
const { runCodeNode } = require('./sandbox');

// Glue kroky, které skládají verdikt (Moduly, Souhrn): nálezy z code review 5 až 7 (pravidla neúplného vstupu, věrohodný prodejce, přeskočené moduly).
const WF = buildWorkflow({ credId: 'C', credName: 'N' });
const codeOf = (name) => WF.nodes.find((n) => n.name === name).parameters.jsCode;
const openai = (obj) => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], stop_reason: 'end_turn' });
const fixtureJson = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

const runModuly = (json, ctx, o = {}) => runCodeNode(codeOf('Moduly'), { json, nodes: { 'Vstup a načtení': ctx }, httpStub: () => ({ statusCode: 404, body: '' }), ...o });

// --- nález 5 (D2): chybějící údaje u neúplného vstupu jen info ---
test('glue 03: vložený text bez CE a s GPSR „ne“ dá info (nepočítá se do skóre), úplné čtení stránky low', async () => {
  const textCtx = { zkratka: false, input: { text: 'Nabíječka 65 W za 199 Kč', screenshoty: [], url: null }, pageText: '', rezim: 'neznámé', host: null, obsah: true };
  const x = openai({ produkt: { nazev: 'Nabíječka 65 W', kategorie: 'elektronika', cena: 199, mena: 'CZK' }, prodejce: {}, recenze: {}, obrazky: {}, gpsr: { vyrobce_uveden: 'ne', adresa_vyrobce: 'neuvedeno', odpovedna_osoba_eu: 'neuvedeno' }, nerealne_parametry: [], nesoulady: [] });
  const text = await runModuly(x, textCtx);
  const sev = (out, id) => (out.signals.find((s) => s.id === id) || {}).severity;
  assert.equal(sev(text.out, 'ce_chybi'), 'info');
  assert.equal(sev(text.out, 'gpsr_chybi'), 'info');

  const readerCtx = { zkratka: false, input: { text: '', screenshoty: [], url: null }, pageText: '', rezim: 'marketplace', host: 'aliexpress.com', obsah: true, dossier: fixtureJson('dossier-cyklosvitilna.json') };
  const reader = await runModuly({}, readerCtx);
  assert.equal(sev(reader.out, 'ce_chybi'), 'low');
});

// --- Souhrn (glue 07): nálezy 6 a 7 ---
const { normalizeDossier } = require('../engine/dossier');
const DOSSIER = normalizeDossier(fixtureJson('dossier-cyklosvitilna.json')).dossier;
const PLAUS_V_PORADKU = openai({ tvrzeni: [], verdikt: 'v_poradku', jistota: 'vysoka', vysvetleni_pro_laika: 'Čísla sedí.', otazka_pro_prodejce: '' });
const OK3 = { offer: 'ok', seller: 'ok', safety: 'ok' };
const mod = (o = {}) => ({ verdict: { semafor: 'zelená', score: 0, confidence: 'střední', unchecked: [], skipped: [] }, signals: [], moduly: OK3, external: true, mameObrazky: false, dossier: DOSSIER, ...o });
const runSouhrn = (nodes, o = {}) => runCodeNode(codeOf('Souhrn'), { json: PLAUS_V_PORADKU, nodes: { Moduly: mod(), 'LLM – věrohodnost': PLAUS_V_PORADKU, 'Sestavit věrohodnost': { bezDat: false }, ...nodes }, ...o });
const payload = (out) => JSON.parse(out.llmRequest.messages[0].content);
const sellerSig = (severity) => ({ id: 's', module: 'seller', severity, title: 't', evidence: 'e', source: 'x', hard: false, druh: 'riziko', citace: null, vysvetleni: null, otazka: null, vypocet: null, jistota: null, odkazy: [] });

test('glue 07: prodejce působí věrohodně jen s odpovědí externího zdroje (ARES/VIES/ČOI/RDAP)', async () => {
  const flag = async (m) => (await runSouhrn({ Moduly: mod(m) })).out;
  const s = await flag({ external: true });
  assert.equal(payload(s).prodejce_duveryhodny, true);
  assert.equal(s.prodejceDuveryhodny, true);
  const bez = await flag({ external: false });
  assert.equal(payload(bez).prodejce_duveryhodny, false);
  assert.equal(bez.prodejceDuveryhodny, false);
  // externí zdroj nestačí, když je modul prodejce nezkontrolovaný nebo má střední nález
  assert.equal(payload(await flag({ external: true, moduly: { ...OK3, seller: 'unchecked' } })).prodejce_duveryhodny, false);
  assert.equal(payload(await flag({ external: true, signals: [sellerSig('medium')] })).prodejce_duveryhodny, false);
  assert.equal(payload(await flag({ external: true, signals: [sellerSig('low')] })).prodejce_duveryhodny, true);
});

test('glue 07 (D3): selhání věrohodnosti nebo obrázků nepustí zelenou, výsledek je šedá', async () => {
  const chyba = { error: { message: '401' } };
  const vyp = await runSouhrn({ 'LLM – věrohodnost': chyba });
  assert.deepEqual(vyp.out.verdict.skipped, ['ověření věrohodnosti']);
  assert.equal(vyp.out.verdict.semafor, 'šedá');
  assert.equal(payload(vyp.out).semafor, 'šedá');
  assert.deepEqual(payload(vyp.out).nezkontrolovano, ['ověření věrohodnosti']);

  const obr = await runSouhrn({ 'Obrázky – příprava': { obrazky: DOSSIER.obrazky } }, { $input: { first: () => ({ json: chyba }), all: () => [{ json: chyba }, { json: chyba }, { json: chyba }] } });
  assert.deepEqual(obr.out.verdict.skipped, ['analýza obrázků']);
  assert.equal(obr.out.verdict.semafor, 'šedá');
});

test('glue 07 (D3): výpadek Icecatu z modulů (identita) nepustí zelenou', async () => {
  const { out } = await runSouhrn({ Moduly: mod({ verdict: { semafor: 'zelená', score: 0, confidence: 'střední', unchecked: [], skipped: ['Icecat'] } }) });
  assert.equal(out.verdict.semafor, 'šedá');
  assert.deepEqual(payload(out).nezkontrolovano, ['identita produktu: Icecat']);
});

test('glue 07 (D3): věrohodnost bez dat k posouzení (bezDat) zelenou nebrání; funkční věrohodnost bez nálezů dá zelenou', async () => {
  const bezDat = await runSouhrn({ 'LLM – věrohodnost': { error: { message: 'x' } }, 'Sestavit věrohodnost': { bezDat: true } });
  assert.deepEqual(bezDat.out.verdict.skipped, []);
  assert.equal(bezDat.out.verdict.semafor, 'zelená');
  const ok = await runSouhrn({});
  assert.equal(ok.out.verdict.semafor, 'zelená');
});
