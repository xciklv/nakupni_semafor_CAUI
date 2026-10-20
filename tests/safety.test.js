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

test('dětské zboží bez zmínky o shodě → low (ce_chybi je vždy low)', () => {
  const r = safetySignals(X({ nazev: 'Dětská hračka s baterií', kategorie: 'hračky' }));
  assert.equal(r.signals[0].severity, 'low');
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

test('dětská hračka bez diakritiky → low', () => {
  const r = safetySignals(X({ nazev: 'Detska hracka', kategorie: 'hracky' }));
  assert.equal(r.signals[0].severity, 'low');
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

test('dětská hračka s baterií → low a text o hračkách', () => {
  const s = safetySignals(X({ nazev: 'Dětská hračka s baterií', kategorie: 'hračky' })).signals[0];
  assert.equal(s.severity, 'low');
  assert.match(s.evidence, /U hraček je označení CE povinné/);
});

test('Toy car → low se zněním o hračkách', () => {
  const s = safetySignals(X({ nazev: 'Toy car' })).signals[0];
  assert.equal(s.severity, 'low');
  assert.match(s.evidence, /U hraček je označení CE povinné/);
});

test('ce_chybi je low u všech kategorií (žádný medium ani high)', () => {
  for (const nazev of ['Toy car', 'Hračka', 'Nabíječka', 'USB kabel', 'LED pásek', 'Dron DJI Mini', 'Mobilní telefon']) {
    const r = safetySignals(X({ nazev }));
    assert.equal(r.signals.length, 1, nazev);
    assert.equal(r.signals[0].id, 'ce_chybi', nazev);
    assert.equal(r.signals[0].severity, 'low', nazev);
  }
});

const ceChybi = (nazev, kategorie) => safetySignals(X({ nazev, kategorie })).signals.some((s) => s.id === 'ce_chybi');

test('slovní kotvy: automobil, mobiliář a lampion nejsou spouštěč CE', () => {
  assert.equal(ceChybi('Automobil Škoda Octavia'), false);
  assert.equal(ceChybi('Autopotah na automobil'), false);
  assert.equal(ceChybi('Mobiliář zahradní'), false);
  assert.equal(ceChybi('Papírový lampion'), false);
  assert.equal(ceChybi('Lampiony na svatbu'), false);
  assert.equal(ceChybi('Lampas'), false);
});

test('slovní kotvy: mobil, lampa a dron se pořád poznají', () => {
  assert.equal(ceChybi('Mobil Samsung Galaxy'), true);
  assert.equal(ceChybi('Mobilní telefon'), true);
  assert.equal(ceChybi('Stolní lampa'), true);
  assert.equal(ceChybi('Lampy LED'), true);
  assert.equal(ceChybi('Dron DJI Mini 4'), true);
  assert.equal(ceChybi('Drony s kamerou'), true);
  assert.equal(ceChybi('Drone with camera'), true);
});

test('slovní kotva: androns není dron', () => {
  assert.equal(ceChybi('Androns řemínek'), false);
  assert.equal(ceChybi('Kalhoty Androns'), false);
});

test('hračka v ohýbaných tvarech (hračku, hračkou, hračkám, hraček) se pozná', () => {
  for (const nazev of ['Koupím hračku', 'Hra s hračkou', 'Dárek pro hračkám', 'Sada hraček', 'Plyšová hračka', 'Autíčka na hračky', 'Toys set']) {
    const s = safetySignals(X({ nazev })).signals;
    assert.equal(s.length, 1, nazev);
    assert.match(s[0].evidence, /U hraček je označení CE povinné/, nazev);
  }
  assert.equal(ceChybi('Hrací karty'), false);
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
  assert.equal(safetyGateQuery(XB('HP', null)), null);
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

const STOP = ['unbranded', 'no brand', 'nobrand', 'brand', 'generic', 'noname', 'no name', 'original', 'universal', 'oem', 'unknown', 'none', 'n/a', 'na', 'other', 'others', 'brandless', 'bez značky', 'neznámá', 'vlastní značka', 'private label', 'handmade', 'mini', 'power', 'smart', 'pro', 'plus', 'max', 'new', 'hot', 'best', 'top', 'super'];

test('generické značky (stop-list): dotaz null a signál nevzniká ani při shodě s alertem', () => {
  for (const w of STOP) {
    for (const v of [w, w.toUpperCase(), '  ' + w + ' ']) {
      assert.equal(safetyGateQuery(XB(v, null)), null, v);
      assert.equal(safetyGateQuery(XB(v, 'STB-200')), null, v + ' + model');
      assert.deepEqual(safetyGateSignals([ALERT(v), ALERT(w)], XB(v, null)), [], v);
      assert.deepEqual(safetyGateSignals([ALERT(v)], XB(v, 'STB-200')), [], v + ' + model');
    }
  }
  assert.deepEqual(safetyGateSignals([ALERT('No brand')], XB('No brand', null)), []);
  assert.equal(safetyGateQuery(XB('Power Max', null)), null, 'jen ze stop slov');
  assert.deepEqual(safetyGateSignals([ALERT('Power Max')], XB('Power Max', null)), []);
  assert.equal(safetyGateQuery(XB('Bez značky', null)), null);
  assert.equal(safetyGateQuery(XB('N/A', null)), null);
});

test('značka obsahující stop slovo, ale nejen ono, je použitelná', () => {
  assert.deepEqual(safetyGateQuery(XB('Anker Power', null)), { fullTextSearch: 'Anker Power' });
  assert.equal(safetyGateSignals([ALERT('Anker Power')], XB('Anker Power', null)).length, 1);
});

test('krátká značka (<3 znaky) jen s použitelným modelem', () => {
  assert.equal(safetyGateQuery(XB('HP', null)), null);
  assert.equal(safetyGateQuery(XB('LG', '1')), null);
  assert.equal(safetyGateQuery(XB('O2', '   ')), null);
  assert.deepEqual(safetyGateQuery(XB('HP', 'Pavilion 15')), { fullTextSearch: 'HP Pavilion 15' });
  assert.deepEqual(safetyGateSignals([ALERT('HP', { product: { name: 'Laptop', nameSpecific: 'Pavilion 15', brands: [{ brand: 'HP' }] } })], XB('HP', null)), []);
  const hp = ALERT('HP', { product: { name: 'Laptop', nameSpecific: 'HP Pavilion 15 charger', brands: [{ brand: 'HP' }] } });
  assert.equal(safetyGateSignals([hp], XB('HP', 'Pavilion 15')).length, 1);
  assert.deepEqual(safetyGateSignals([ALERT('HP')], XB('HP', 'Envy 13')), []);
});

test('model: použitelný jen s písmenem/číslicí a ne čistě číselný kratší než 3 číslice', () => {
  assert.deepEqual(safetyGateQuery(XB('Anker', '1')), { fullTextSearch: 'Anker' });
  assert.deepEqual(safetyGateQuery(XB('Anker', '12')), { fullTextSearch: 'Anker' });
  assert.deepEqual(safetyGateQuery(XB('Anker', '--')), { fullTextSearch: 'Anker' });
  assert.deepEqual(safetyGateQuery(XB('Anker', '123')), { fullTextSearch: 'Anker 123' });
  assert.deepEqual(safetyGateQuery(XB('Anker', 'A1')), { fullTextSearch: 'Anker A1' });
  // nepoužitelný model se ignoruje (nezužuje shodu)
  assert.equal(safetyGateSignals([ALERT('Anker')], XB('Anker', '1')).length, 1);
  assert.equal(safetyGateSignals([ALERT('Anker')], XB('Anker', '--')).length, 1);
  // použitelný model gatuje dál
  assert.deepEqual(safetyGateSignals([ALERT('Anker')], XB('Anker', 'A1263')), []);
});

test('Anker funguje s modelem i bez', () => {
  const a = ALERT('Anker', { product: { name: 'Power bank', nameSpecific: 'A1263 PowerCore', brands: [{ brand: 'Anker' }] } });
  assert.equal(safetyGateSignals([a], XB('Anker', null)).length, 1);
  assert.equal(safetyGateSignals([a], XB('Anker', 'A1263')).length, 1);
  assert.deepEqual(safetyGateQuery(XB('Anker', 'A1263')), { fullTextSearch: 'Anker A1263' });
});

test('"&" se v dotazu i při porovnání chová stejně (mezera)', () => {
  assert.equal(safetyGateQuery(XB('Black&Decker', null)).fullTextSearch, 'Black Decker');
  assert.equal(safetyGateSignals([ALERT('Black & Decker')], XB('Black&Decker', null)).length, 1);
  assert.equal(safetyGateSignals([ALERT('Black&Decker')], XB('Black & Decker', null)).length, 1);
});

// --- GPSR (výrobce, adresa, odpovědná osoba v EU) ---
const XG = (gpsr, produkt = { nazev: 'Bavlněné triko' }) => normalizeExtraction({ produkt, gpsr });

test('gpsr_chybi: jednou, i když chybí všechna tři pole; low riziko', () => {
  const r = safetySignals(XG({ vyrobce_uveden: 'ne', adresa_vyrobce: 'ne', odpovedna_osoba_eu: 'ne' }));
  const g = r.signals.filter((s) => s.id === 'gpsr_chybi');
  assert.equal(g.length, 1);
  assert.equal(g[0].severity, 'low');
  assert.equal(g[0].druh, 'riziko');
  assert.equal(g[0].module, 'safety');
  assert.match(g[0].title, /GPSR/);
});

test('gpsr_chybi: stačí jedno pole "ne"', () => {
  assert.equal(safetySignals(XG({ vyrobce_uveden: 'ano', adresa_vyrobce: 'ano', odpovedna_osoba_eu: 'ne' })).signals.filter((s) => s.id === 'gpsr_chybi').length, 1);
});

test('gpsr: ano a neuvedeno (nelze posoudit) nález nevyvolají', () => {
  assert.deepEqual(safetySignals(XG({ vyrobce_uveden: 'ano', adresa_vyrobce: 'ano', odpovedna_osoba_eu: 'ano' })).signals, []);
  assert.deepEqual(safetySignals(XG({ vyrobce_uveden: 'neuvedeno', adresa_vyrobce: 'neuvedeno', odpovedna_osoba_eu: 'neuvedeno' })).signals, []);
  assert.deepEqual(safetySignals(normalizeExtraction({ produkt: { nazev: 'Bavlněné triko' } })).signals, []);
});

test('gpsr_chybi se přidá vedle ce_chybi', () => {
  const r = safetySignals(XG({ vyrobce_uveden: 'ne' }, { nazev: 'Nabíječka USB' }));
  assert.deepEqual(r.signals.map((s) => s.id), ['ce_chybi', 'gpsr_chybi']);
});

test('safetySignals bez pole gpsr (ruční objekt) funguje', () => {
  const x = X({ nazev: 'Nabíječka USB' });
  delete x.gpsr;
  assert.deepEqual(safetySignals(x).signals.map((s) => s.id), ['ce_chybi']);
});
