const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtraction } = require('../engine/llm');
const { offerSignals } = require('../engine/offer');

const X = (o) => normalizeExtraction(o);
const ids = (r) => r.signals.map((s) => s.id);

test('bez názvu a ceny je modul nezkontrolován', () => {
  assert.equal(offerSignals(X({})).status, 'unchecked');
});

test('běžná nabídka bez rozporů nemá signály', () => {
  const r = offerSignals(X({ produkt: { nazev: 'Mouse', cena: 500, mena: 'CZK', referencni_cena_odhad: { min: 400, max: 700, mena: 'CZK' } } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.signals, []);
});

test('cena pod čtvrtinou reference → medium, pod polovinou → low', () => {
  const base = { nazev: 'Powerbanka', mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } };
  const a = offerSignals(X({ produkt: { ...base, cena: 150 } })).signals.find((s) => s.id === 'cena_extremne_nizka');
  assert.equal(a.severity, 'medium');
  const b = offerSignals(X({ produkt: { ...base, cena: 350 } })).signals.find((s) => s.id === 'cena_nizka');
  assert.equal(b.severity, 'low');
});

test('cena v jiné měně než reference se neporovnává', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A', cena: 5, mena: 'EUR', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } } }));
  assert.deepEqual(r.signals, []);
});

test('nerealistické parametry, nesoulady, recenze a obrázky', () => {
  const r = offerSignals(X({
    produkt: { nazev: 'Powerbanka' },
    nerealne_parametry: ['30000 mAh za 199 Kč – cena baterie vyšší'],
    nesoulady: ['Fotka ukazuje jiný model'],
    obrazky: { vypada_ai_nebo_katalog: true, nesoulad_s_popisem: true },
    recenze: { pocet: 50, podobne_texty: true, vsechny_5_hvezd: true, genericke: true },
  }));
  assert.deepEqual(ids(r).sort(), ['nesoulad', 'nesoulad_obrazku', 'nerealny_parametr', 'obrazky_ai_katalog', 'recenze_genericke', 'recenze_podobne', 'recenze_same_petky'].sort());
  assert.equal(r.signals.find((s) => s.id === 'obrazky_ai_katalog').severity, 'low');
});

test('pět hvězd bez dostatku recenzí není signál', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, recenze: { pocet: 3, vsechny_5_hvezd: true } }));
  assert.deepEqual(r.signals, []);
});

test('počet signálů z nesouladů je omezen na 3', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nesoulady: ['1', '2', '3', '4', '5'] }));
  assert.equal(r.signals.filter((s) => s.id === 'nesoulad').length, 3);
});
