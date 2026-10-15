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

test('dětské oblečení → bez signálů (detsk není spouštěč CE)', () => {
  const r = safetySignals(X({ nazev: 'Dětské oblečení', kategorie: 'oblečení' }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.signals, []);
});

test('dětská postýlka → bez signálu', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Dětská postýlka' })).signals, []);
});

test('dětská hračka s baterií → medium a text o hračkách', () => {
  const s = safetySignals(X({ nazev: 'Dětská hračka s baterií', kategorie: 'hračky' })).signals[0];
  assert.equal(s.severity, 'medium');
  assert.match(s.evidence, /U hraček je označení CE povinné/);
});

test('Toy car → medium', () => {
  assert.equal(safetySignals(X({ nazev: 'Toy car' })).signals[0].severity, 'medium');
});

test('Nabíječka bez tvrzení → low', () => {
  const s = safetySignals(X({ nazev: 'Nabíječka' })).signals[0];
  assert.equal(s.severity, 'low');
  assert.match(s.evidence, /obvykle povinné/);
});

test('Kabelka dámská → bez signálu (kabel nesmí chytat kabelku)', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Kabelka dámská', kategorie: 'kabelky' })).signals, []);
});

test('USB kabel → low ce_chybi', () => {
  const s = safetySignals(X({ nazev: 'USB kabel' })).signals[0];
  assert.equal(s.id, 'ce_chybi');
  assert.equal(s.severity, 'low');
});

test('Kabely → low ce_chybi', () => {
  assert.equal(safetySignals(X({ nazev: 'Kabely' })).signals[0].severity, 'low');
});

test('Forma na led (led ve smyslu ledu) → bez signálu', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Forma na led' })).signals, []);
});

test('LED pásek → low ce_chybi', () => {
  const s = safetySignals(X({ nazev: 'LED pásek' })).signals[0];
  assert.equal(s.id, 'ce_chybi');
  assert.equal(s.severity, 'low');
});

test('Baterie do koupelny (baterie jako baterie na vodu) → bez signálu', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Baterie do koupelny' })).signals, []);
});

test('Wireless headphones → low ce_chybi', () => {
  assert.equal(safetySignals(X({ nazev: 'Wireless headphones' })).signals[0].severity, 'low');
});

test('Smartwatch → low ce_chybi', () => {
  assert.equal(safetySignals(X({ nazev: 'Smartwatch' })).signals[0].severity, 'low');
});

test('Charger 65W → low ce_chybi', () => {
  assert.equal(safetySignals(X({ nazev: 'Charger 65W' })).signals[0].severity, 'low');
});

test('Charger s CE v tvrzeních → bez signálu', () => {
  assert.deepEqual(safetySignals(X({ nazev: 'Charger 65W', tvrzeni_certifikace: ['CE'] })).signals, []);
});
