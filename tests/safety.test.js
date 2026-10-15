const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtraction } = require('../engine/llm');
const { safetySignals } = require('../engine/safety');

const X = (produkt) => normalizeExtraction({ produkt });

test('bez kategorie a názvu → nezkontrolováno', () => {
  assert.equal(safetySignals(X({})).status, 'unchecked');
});

test('elektronika bez zmínky o shodě → low signál', () => {
  const r = safetySignals(X({ nazev: 'Powerbanka 20000 mAh', kategorie: 'elektronika' }));
  assert.equal(r.status, 'ok');
  assert.equal(r.signals[0].id, 'ce_chybi');
  assert.equal(r.signals[0].severity, 'low');
});

test('dětské zboží bez zmínky o shodě → medium', () => {
  const r = safetySignals(X({ nazev: 'Dětská hračka s baterií', kategorie: 'hračky' }));
  assert.equal(r.signals[0].severity, 'medium');
});

test('se zmínkou o CE signál nevzniká', () => {
  const r = safetySignals(X({ nazev: 'Nabíječka', tvrzeni_certifikace: ['CE'] }));
  assert.deepEqual(r.signals, []);
});

test('zboží bez povinného CE (triko) → bez signálů, ale zkontrolováno', () => {
  const r = safetySignals(X({ nazev: 'Bavlněné triko', kategorie: 'oblečení' }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.signals, []);
});

test('názvy bez diakritiky (Nabijecka USB) → ce_chybi', () => {
  const r = safetySignals(X({ nazev: 'Nabijecka USB' }));
  assert.equal(r.signals[0].id, 'ce_chybi');
});

test('dětská hračka bez diakritiky → medium', () => {
  const r = safetySignals(X({ nazev: 'Detska hracka', kategorie: 'hracky' }));
  assert.equal(r.signals[0].severity, 'medium');
});

test('jen nesouvisející tvrzení (100% bavlna na nabíječce) → ce_chybi', () => {
  const r = safetySignals(X({ nazev: 'Nabíječka', tvrzeni_certifikace: ['100% bavlna'] }));
  assert.equal(r.signals[0].id, 'ce_chybi');
});

test('EU conformity / prohlášení o shodě se počítá jako shoda', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Nabíječka', tvrzeni_certifikace: ['EU conformity'] })).signals, []);
  assert.deepEqual(safetySignals(X({ nazev: 'Nabíječka', tvrzeni_certifikace: ['Prohlášení o shodě'] })).signals, []);
});
