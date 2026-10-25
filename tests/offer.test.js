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

test('cena pod čtvrtinou reference → low, pod polovinou → info (váha 0)', () => {
  const base = { nazev: 'Powerbanka', mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } };
  const a = offerSignals(X({ produkt: { ...base, cena: 150 } })).signals.find((s) => s.id === 'cena_extremne_nizka');
  assert.equal(a.severity, 'low');
  const b = offerSignals(X({ produkt: { ...base, cena: 350 } })).signals.find((s) => s.id === 'cena_nizka');
  assert.equal(b.severity, 'info');
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
  const sev = (id) => r.signals.find((s) => s.id === id).severity;
  for (const id of ['obrazky_ai_katalog', 'recenze_genericke']) assert.equal(sev(id), 'info', id);
  for (const id of ['nesoulad', 'nerealny_parametr', 'nesoulad_obrazku', 'recenze_podobne', 'recenze_same_petky']) assert.equal(sev(id), 'low', id);
});

test('žádný signál nabídky není medium ani high a cena_extremne_nizka je low', () => {
  const r = offerSignals(X({
    produkt: { nazev: 'Powerbanka', cena: 100, mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } },
    nerealne_parametry: ['a', 'b'], nesoulady: ['c', 'd'],
    obrazky: { vypada_ai_nebo_katalog: true, nesoulad_s_popisem: true },
    recenze: { pocet: 50, podobne_texty: true, vsechny_5_hvezd: true, genericke: true },
  }));
  assert.equal(r.signals.find((s) => s.id === 'cena_extremne_nizka').severity, 'low');
  assert.ok(r.signals.every((s) => s.severity === 'info' || s.severity === 'low'), r.signals.map((s) => s.id + ':' + s.severity).join());
});

const { computeVerdict } = require('../engine/scoring');
const ALL_OK = { offer: 'ok', seller: 'ok', safety: 'ok' };

test('legitimní nabídka (Alza: katalogové fotky, obecné recenze, cena v normě) → skóre <= 2, nikdy oranžová', () => {
  const r = offerSignals(X({
    produkt: { nazev: 'Powerbanka Xiaomi 20000 mAh', cena: 899, mena: 'CZK', referencni_cena_odhad: { min: 700, max: 1100, mena: 'CZK' } },
    obrazky: { vypada_ai_nebo_katalog: true, nesoulad_s_popisem: false },
    recenze: { pocet: 120, prumer: 4.7, podobne_texty: false, vsechny_5_hvezd: false, genericke: true },
  }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(ids(r).sort(), ['obrazky_ai_katalog', 'recenze_genericke']);
  const v = computeVerdict(r.signals, ALL_OK);
  assert.ok(v.score <= 2, 'skóre ' + v.score);
  assert.notEqual(v.semafor, 'oranžová');
  assert.notEqual(v.semafor, 'červená');
});

test('dva rozpory od LLM samy nedosáhnou oranžové', () => {
  const r = offerSignals(X({ produkt: { nazev: 'Notebook' }, nesoulady: ['Fotka ukazuje jiný model', 'Cena neodpovídá popisu'] }));
  assert.deepEqual(ids(r), ['nesoulad', 'nesoulad']);
  const v = computeVerdict(r.signals, ALL_OK);
  assert.equal(v.score, 2);
  assert.equal(v.semafor, 'zelená');
  const worst = offerSignals(X({ produkt: { nazev: 'N' }, nesoulady: ['a', 'b', 'c', 'd'], nerealne_parametry: ['x'] }));
  assert.equal(computeVerdict(worst.signals, ALL_OK).semafor, 'zelená', 'strop 3 signálů = skóre 3 bez medium');
});

test('pět hvězd bez dostatku recenzí není signál', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, recenze: { pocet: 3, vsechny_5_hvezd: true } }));
  assert.deepEqual(r.signals, []);
});

test('počet signálů z nesouladů je omezen na 2 (volný text modelu je nejméně spolehlivý signál)', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nesoulady: ['1', '2', '3', '4', '5'] }));
  assert.equal(r.signals.filter((s) => s.id === 'nesoulad').length, 2);
});

test('cena přesně 0,25× a 0,5× reference: 0,25× je cena_nizka, 0,5× nemá signál', () => {
  const base = { nazev: 'Powerbanka', mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } };
  const quarter = offerSignals(X({ produkt: { ...base, cena: 200 } })).signals;
  assert.deepEqual(quarter.map((s) => s.id), ['cena_nizka']);
  const half = offerSignals(X({ produkt: { ...base, cena: 400 } })).signals;
  assert.deepEqual(half, []);
});

test('cena 0 s referencí nevyvolá cenový signál a samotná cena 0 je nezkontrolovaná', () => {
  const base = { mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } };
  const withName = offerSignals(X({ produkt: { ...base, nazev: 'A', cena: 0 } }));
  assert.equal(withName.status, 'ok');
  assert.deepEqual(withName.signals, []);
  assert.equal(offerSignals(X({ produkt: { cena: 0 } })).status, 'unchecked');
});

test('recenze_same_petky: 20 recenzí ano, 19 ne', () => {
  const at20 = offerSignals(X({ produkt: { nazev: 'A' }, recenze: { pocet: 20, vsechny_5_hvezd: true } }));
  assert.deepEqual(ids(at20), ['recenze_same_petky']);
  const at19 = offerSignals(X({ produkt: { nazev: 'A' }, recenze: { pocet: 19, vsechny_5_hvezd: true } }));
  assert.deepEqual(ids(at19), []);
});

test('nerealne parametry jsou omezeny na 2 signály', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nerealne_parametry: ['1', '2', '3', '4', '5'] }));
  assert.equal(r.signals.filter((s) => s.id === 'nerealny_parametr').length, 2);
  assert.equal(r.signals.length, 2);
});

test('duplicitní nerealne parametry (bez ohledu na velikost písmen a mezery) dají jeden signál', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nerealne_parametry: ['x', 'X ', 'x'] }));
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].id, 'nerealny_parametr');
});

test('společný limit 2 pro nerealne parametry a nesoulady: nejdřív nerealne', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nerealne_parametry: ['a'], nesoulady: ['c', 'd', 'e'] }));
  assert.equal(r.signals.length, 2);
  assert.equal(r.signals.filter((s) => s.id === 'nerealny_parametr').length, 1);
  assert.equal(r.signals.filter((s) => s.id === 'nesoulad').length, 1);
  const only = offerSignals(X({ produkt: { nazev: 'A' }, nerealne_parametry: ['a', 'b'], nesoulady: ['c'] }));
  assert.equal(only.signals.filter((s) => s.id === 'nerealny_parametr').length, 2);
  assert.equal(only.signals.filter((s) => s.id === 'nesoulad').length, 0);
});

test('volný text modelu (nerealne + nesoulady) nikdy nepřidá víc než 2 body: samotný šum nedá oranžovou ani červenou', () => {
  const r = offerSignals(X({ produkt: { nazev: 'A' }, nerealne_parametry: ['a', 'b', 'c'], nesoulady: ['d', 'e', 'f', 'g'] }));
  const points = r.signals.reduce((sum, sg) => sum + (sg.severity === 'low' ? 1 : 0), 0);
  assert.equal(points, 2);
});

test('nižší hodnocení produktu: jen info (váha 0), barvu nemění; 3,6 z 5 při 5 hodnoceních', () => {
  const r = offerSignals(X({ produkt: { nazev: 'Dock' }, recenze: { pocet: 5, prumer: 3.6 } }));
  assert.deepEqual(ids(r), ['recenze_nizke_hodnoceni']);
  const s = r.signals[0];
  assert.equal(s.severity, 'info');
  assert.match(s.evidence, /3,6 z 5 \(5 hodnocení\)/);
  const v = computeVerdict(r.signals, ALL_OK);
  assert.equal(v.score, 0);
  assert.equal(v.semafor, 'zelená');
});

test('nižší hodnocení: hranice 4,0 a 3 hodnocení; neznámý počet se bere, 1–2 hodnocení jsou šum', () => {
  const at = (recenze) => ids(offerSignals(X({ produkt: { nazev: 'A' }, recenze })));
  assert.deepEqual(at({ pocet: 30, prumer: 4 }), []);
  assert.deepEqual(at({ pocet: 30, prumer: 4.2 }), []);
  assert.deepEqual(at({ pocet: 30, prumer: 3.9 }), ['recenze_nizke_hodnoceni']);
  assert.deepEqual(at({ pocet: 3, prumer: 2 }), ['recenze_nizke_hodnoceni']);
  assert.deepEqual(at({ pocet: 2, prumer: 1 }), []);
  assert.deepEqual(at({ pocet: null, prumer: 3.5 }), ['recenze_nizke_hodnoceni']);
  assert.deepEqual(at({ pocet: 10, prumer: null }), []);
});
