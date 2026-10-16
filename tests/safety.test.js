const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtraction } = require('../engine/llm');
const { safetySignals, safetyGateQuery, safetyGateSignals } = require('../engine/safety');

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

// --- Safety Gate (slabý signál gated značkou) ---
const XB = (znacka, model, extra = {}) => X({ nazev: 'Powerbanka', znacka, model, ...extra });
const ALERT = (brand, o = {}) => ({
  reference: 'SR/00232/25', publicationDate: '2025-01-13T00:00:00.000+00:00',
  product: { name: 'Power bank', nameSpecific: 'STB-200', brands: [{ brand }] },
  risk: { riskType: [{ key: 'riskType.fire', name: 'FIRE' }] }, ...o,
});

test('safetyGateQuery: bez značky -> null', () => {
  assert.equal(safetyGateQuery(X({ nazev: 'Powerbanka' })), null);
  assert.equal(safetyGateQuery(XB(null, 'A1')), null);
  assert.equal(safetyGateQuery(XB('   ', 'A1')), null);
});

test('safetyGateQuery: značka (+ model) -> fullTextSearch', () => {
  assert.deepEqual(safetyGateQuery(XB('Anker', null)), { fullTextSearch: 'Anker' });
  assert.deepEqual(safetyGateQuery(XB('Forever', 'STB-200')), { fullTextSearch: 'Forever STB-200' });
});

test('safetyGateQuery: sanitizace (diakritika pryč, jen písmena/číslice/mezera/pomlčka, mezery sloučeny)', () => {
  assert.equal(safetyGateQuery(XB('Škoda', 'Žluťoučký "kůň" (v2)!')).fullTextSearch, 'Skoda Zlutoucky kun v2');
  assert.equal(safetyGateQuery(XB('A  B\t&C', '  X--1  ')).fullTextSearch, 'A B C X--1');
  assert.equal(safetyGateQuery(XB('Anker', '"; DROP{}')).fullTextSearch, 'Anker DROP');
});

test('safetyGateQuery: max 60 znaků; méně než 2 znaky -> null', () => {
  const q = safetyGateQuery(XB('a'.repeat(50), 'b'.repeat(50)));
  assert.ok(q.fullTextSearch.length <= 60);
  assert.equal(safetyGateQuery(XB('X', null)), null);
  assert.equal(safetyGateQuery(XB('***', null)), null);
  assert.equal(safetyGateQuery(XB('日本', null)), null);
  assert.deepEqual(safetyGateQuery(XB('HP', null)), { fullTextSearch: 'HP' });
  assert.equal(safetyGateQuery(null), null);
  assert.equal(safetyGateQuery({}), null);
});

test('safetyGateSignals: shoda značky -> jediný low signál, nikdy hard', () => {
  const s = safetyGateSignals([ALERT('Anker'), ALERT('Anker', { reference: 'SR/2' })], XB('Anker', null));
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'safety_gate');
  assert.equal(s[0].module, 'safety');
  assert.equal(s[0].severity, 'low');
  assert.equal(s[0].hard, false);
  assert.equal(s[0].title, 'Značka byla v EU nahlášena v databázi nebezpečných výrobků');
  assert.equal(s[0].source, 'EU Safety Gate (CC BY 4.0)');
  assert.match(s[0].evidence, /nalezeno 2 upozornění k značce Anker/);
  assert.match(s[0].evidence, /SR\/00232\/25/);
  assert.match(s[0].evidence, /FIRE/);
  assert.match(s[0].evidence, /Netýká se nutně této nabídky/);
  assert.ok(s[0].evidence.length <= 300);
});

test('safetyGateSignals: celá slova, ne podřetězce (Anker vs Tanker)', () => {
  assert.deepEqual(safetyGateSignals([ALERT('Tanker'), ALERT('Banker Co')], XB('Anker', null)), []);
  assert.equal(safetyGateSignals([ALERT('Anker Innovations')], XB('Anker', null)).length, 1);
  assert.equal(safetyGateSignals([ALERT('Forever STB-200')], XB('Forever', null)).length, 1);
});

test('safetyGateSignals: bez ohledu na velikost písmen a diakritiku, vícenásobná slova', () => {
  assert.equal(safetyGateSignals([ALERT('ŠKODA')], XB('skoda', null)).length, 1);
  assert.equal(safetyGateSignals([ALERT('skoda')], XB('Škoda', null)).length, 1);
  assert.equal(safetyGateSignals([ALERT('Industry\nELECTRONICS')], XB('industry electronics', null)).length, 1);
  assert.deepEqual(safetyGateSignals([ALERT('Industry ELECTRONICS')], XB('electronics industry', null)), []);
});

test('safetyGateSignals: s modelem musí model sedět v product.name / nameSpecific', () => {
  assert.equal(safetyGateSignals([ALERT('Forever')], XB('Forever', 'STB-200')).length, 1);
  assert.equal(safetyGateSignals([ALERT('Forever')], XB('Forever', 'stb 200')).length, 1);
  assert.deepEqual(safetyGateSignals([ALERT('Forever')], XB('Forever', 'XYZ-900')), []);
  assert.deepEqual(safetyGateSignals([ALERT('Forever')], XB('Forever', 'STB-20')), []);
  const inName = ALERT('Ikea', { product: { name: 'VARMFRONT powerbanka', nameSpecific: null, brands: [{ brand: 'Ikea' }] } });
  assert.equal(safetyGateSignals([inName], XB('IKEA', 'Varmfront')).length, 1);
  // model uvedený jen ve značce alertu nestačí
  const onlyInBrand = ALERT('Forever STB-200', { product: { name: 'Power bank', nameSpecific: null, brands: [{ brand: 'Forever STB-200' }] } });
  assert.deepEqual(safetyGateSignals([onlyInBrand], XB('Forever', 'STB-200')), []);
});

test('safetyGateSignals: bez značky -> []', () => {
  assert.deepEqual(safetyGateSignals([ALERT('Anker')], X({ nazev: 'Powerbanka' })), []);
});

test('safetyGateSignals: podivné tvary -> [] bez výjimky', () => {
  const x = XB('Anker', null);
  for (const a of [null, undefined, 'x', 5, {}, [], [null], [5, 'a'], [{}], [{ product: null }], [{ product: { brands: 'Anker' } }], [{ product: { brands: [null, { brand: 5 }, {}] } }]]) {
    assert.deepEqual(safetyGateSignals(a, x), [], JSON.stringify(a));
  }
  assert.deepEqual(safetyGateSignals([ALERT('Anker')], null), []);
  const s = safetyGateSignals([{ product: { brands: [{ brand: 'Anker' }] } }], x);
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'safety_gate');
});

test('safetySignals: status a ce_chybi beze změny, nezávisí na značce', () => {
  const r = safetySignals(XB('Anker', 'A1263'));
  assert.equal(r.status, 'ok');
  assert.equal(r.signals[0].id, 'ce_chybi');
});
