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
