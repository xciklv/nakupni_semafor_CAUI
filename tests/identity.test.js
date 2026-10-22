const test = require('node:test');
const assert = require('node:assert/strict');
const { checkGtin, gs1Prefix, icecatUrl, parseIcecat, identitySignals } = require('../engine/identity');
const { llmAccuses } = require('../engine/llm');

const ICECAT_PHILIPS = { msg: 'OK', data: { GeneralInfo: { IcecatId: 101280280, Brand: 'Philips', BrandPartCode: 'QP410/50', GTIN: ['8710103997122'], Title: 'Philips Norelco OneBlade QP410/50 příslušenství k holicím strojkům Břit' } } };
const NOT_FOUND = { StatusCode: 16, Code: 400, Message: 'The GTIN can not be found' };
const dossier = (o = {}) => ({ nazev: 'Břit pro holicí strojek OneBlade', specifikace: [], identifikatory: [], ...o });
const ean = (hodnota, druh = 'ean') => ({ hodnota, druh });
const recorder = (body) => {
  const calls = [];
  return { calls, fetchers: { icecat: async (g) => { calls.push(g); if (body instanceof Error) throw body; return body; } } };
};

test('checkGtin: platné kódy 8, 12, 13 a 14 číslic', () => {
  assert.deepEqual(checkGtin('8710103997122'), { ok: true, delka: 13, duvod: null });
  assert.equal(checkGtin('0198222626846').ok, true);
  assert.equal(checkGtin('73513537').ok, true);
  assert.equal(checkGtin('036000291452').ok, true);
  assert.equal(checkGtin('10036000291459').ok, true);
});

test('checkGtin: špatná kontrolní číslice, délka a znaky', () => {
  const bad = checkGtin('8590000000000');
  assert.equal(bad.ok, false);
  assert.match(bad.duvod, /kontroln/);
  const short = checkGtin('12345');
  assert.equal(short.ok, false);
  assert.equal(short.delka, 5);
  assert.match(short.duvod, /délka/);
  assert.equal(checkGtin('87101039971AB').ok, false);
  assert.equal(checkGtin(8710103997122).ok, false);
  assert.equal(checkGtin('').ok, false);
});

test('gs1Prefix: země přidělení prefixu', () => {
  assert.deepEqual(gs1Prefix('8590000000000'), { prefix: '859', zeme: 'CZ', vnitrni: false });
  assert.equal(gs1Prefix('8580000000000').zeme, 'SK');
  assert.equal(gs1Prefix('5900000000000').zeme, 'PL');
  assert.equal(gs1Prefix('8710103997122').zeme, 'NL');
  assert.equal(gs1Prefix('8790000000000').zeme, 'NL');
  assert.equal(gs1Prefix('4000000000000').zeme, 'DE');
  assert.equal(gs1Prefix('4400000000000').zeme, 'DE');
  assert.equal(gs1Prefix('6901234567892').zeme, 'CN');
  assert.equal(gs1Prefix('0198222626846').zeme, 'US');
  assert.equal(gs1Prefix('1000000000000').zeme, 'US');
  assert.equal(gs1Prefix('9999999999999').zeme, null);
});

test('gs1Prefix: vnitřní a nepravé rozsahy (02x, 2xx, 978/979, 99x)', () => {
  for (const c of ['2000000000008', '0200000000000', '9780306406157', '9790000000000', '9910000000000']) {
    const r = gs1Prefix(c);
    assert.equal(r.vnitrni, true, c);
    assert.equal(r.zeme, null, c);
  }
});

test('gs1Prefix: GTIN-12 a GTIN-14 se srovnají na 13 číslic', () => {
  assert.equal(gs1Prefix('036000291452').prefix, '003');
  assert.equal(gs1Prefix('10036000291459').prefix, '003');
});

test('icecatUrl a parseIcecat', () => {
  assert.equal(icecatUrl('8710103997122'), 'https://live.icecat.biz/api?shopname=openIcecat-live&lang=cz&GTIN=8710103997122');
  assert.deepEqual(parseIcecat(NOT_FOUND), { nalezeno: false, znacka: null, kodVyrobce: null, nazev: null });
  assert.equal(parseIcecat(null).nalezeno, false);
  assert.equal(parseIcecat('x').nalezeno, false);
  assert.deepEqual(parseIcecat(ICECAT_PHILIPS), { nalezeno: true, znacka: 'Philips', kodVyrobce: 'QP410/50', nazev: 'Philips Norelco OneBlade QP410/50 příslušenství k holicím strojkům Břit' });
  assert.equal(parseIcecat({ msg: 'OK', data: { GeneralInfo: { Brand: 5 } } }).znacka, null);
});

test('dossier bez identifikátorů: nezkontrolováno, žádný dotaz', async () => {
  const f = recorder(ICECAT_PHILIPS);
  assert.deepEqual(await identitySignals({ dossier: dossier(), fetchers: f.fetchers }), { status: 'unchecked', signals: [], skipped: [] });
  assert.deepEqual(f.calls, []);
});

test('model a sku, které nejsou kód GTIN, se nehledají', async () => {
  const f = recorder(ICECAT_PHILIPS);
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('QP410/50', 'model'), ean('ABC-12345', 'sku'), ean('1234567890123', 'model')] }), fetchers: f.fetchers });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(r.signals, []);
  assert.equal(r.status, 'unchecked');
});

test('neplatný kód označený jako EAN: jeden nález ean_neplatny bez dotazu', async () => {
  const f = recorder(ICECAT_PHILIPS);
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('8590000000000'), ean('12345')] }), fetchers: f.fetchers });
  assert.deepEqual(f.calls, []);
  assert.equal(r.status, 'ok');
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].id, 'ean_neplatny');
  assert.equal(r.signals[0].module, 'identity');
  assert.equal(r.signals[0].severity, 'low');
  assert.match(r.signals[0].citace, /8590000000000/);
});

test('platný kód, který Icecat nezná: jediný nález ean_nenalezen, nelze_overit, info', async () => {
  const f = recorder(NOT_FOUND);
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122')] }), fetchers: f.fetchers });
  assert.deepEqual(f.calls, ['8710103997122']);
  assert.equal(r.signals.length, 1);
  assert.equal(r.signals[0].id, 'ean_nenalezen');
  assert.equal(r.signals[0].druh, 'nelze_overit');
  assert.equal(r.signals[0].severity, 'info');
  assert.deepEqual(r.skipped, []);
});

test('13místný kód z pole model, který projde kontrolou GTIN a Icecat ho nezná: nelze_overit, ne rozpor', async () => {
  const f = recorder(NOT_FOUND);
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('0198222626846', 'model')] }), fetchers: f.fetchers });
  assert.deepEqual(f.calls, ['0198222626846']);
  assert.deepEqual(r.signals.map((s) => [s.id, s.druh, s.severity]), [['ean_nenalezen', 'nelze_overit', 'info']]);
});

test('Icecat zná kód, značka se v nabídce neobjevuje a nabídka žádnou jinou značku neuvádí: jen low rozpor identifikator_nesedi', async () => {
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122')] }), fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.equal(r.status, 'ok');
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.id, 'identifikator_nesedi');
  assert.equal(s.severity, 'low');
  assert.equal(s.druh, 'rozpor');
  assert.match(s.citace, /Philips/);
  assert.match(s.citace, /Břit pro holicí strojek OneBlade/);
  assert.match(s.citace, /8710103997122/);
  assert.ok(s.otazka && s.otazka.length <= 200);
  assert.ok(s.vysvetleni);
});

test('medium jen když nabídka výslovně uvádí jinou značku než Icecat a kód je výslovně označený EAN', async () => {
  const d = dossier({ specifikace: [{ nazev: 'Značka', hodnota: 'Braun' }], identifikatory: [ean('8710103997122')] });
  const r = await identitySignals({ dossier: d, fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.deepEqual(r.signals.map((s) => [s.id, s.severity]), [['identifikator_nesedi', 'medium']]);
});

test('jiná značka v nabídce, ale kód pochází z pole model (ne výslovný EAN): jen low', async () => {
  const d = dossier({ specifikace: [{ nazev: 'Značka', hodnota: 'Braun' }], identifikatory: [ean('8710103997122', 'model')] });
  const r = await identitySignals({ dossier: d, fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.deepEqual(r.signals.map((s) => [s.id, s.severity]), [['identifikator_nesedi', 'low']]);
});

test('aliasy značek: model nebo řada z nabídky odpovídá značce z Icecatu, žádný nález', async () => {
  const cases = [
    ['iPhone 15 Pro 256 GB', 'Apple'], ['Samsung Galaxy S24', 'Samsung'], ['Galaxy S24 Ultra', 'Samsung'], ['Redmi Note 13', 'Xiaomi'],
    ['PlayStation 5 Slim', 'Sony'], ['ThinkPad T14 Gen 4', 'Lenovo'], ['HP Pavilion 15', 'Hewlett-Packard'], ['Hewlett-Packard LaserJet', 'HP'],
    ['Pixel 8 Pro', 'Google'], ['Xbox Series X', 'Microsoft'],
  ];
  for (const [nazev, brand] of cases) {
    const body = { msg: 'OK', data: { GeneralInfo: { Brand: brand, BrandPartCode: 'ZZ-1', Title: brand + ' produkt' } } };
    const r = await identitySignals({ dossier: dossier({ nazev, identifikatory: [ean('8710103997122')] }), fetchers: recorder(body).fetchers });
    assert.deepEqual(r.signals, [], nazev + ' / ' + brand);
  }
});

test('alias nepomůže, když nabídka výslovně uvádí jinou značku: stále medium', async () => {
  const body = { msg: 'OK', data: { GeneralInfo: { Brand: 'Apple', BrandPartCode: 'MTV', Title: 'Apple iPhone' } } };
  const d = dossier({ nazev: 'Kabel pro telefon', specifikace: [{ nazev: 'Brand', hodnota: 'Anker' }], identifikatory: [ean('8710103997122')] });
  const r = await identitySignals({ dossier: d, fetchers: recorder(body).fetchers });
  assert.deepEqual(r.signals.map((s) => [s.id, s.severity]), [['identifikator_nesedi', 'medium']]);
});

test('značka ve specifikaci je alias značky z Icecatu (Galaxy = Samsung): žádný nález', async () => {
  const body = { msg: 'OK', data: { GeneralInfo: { Brand: 'Samsung', BrandPartCode: 'SM-1', Title: 'Samsung' } } };
  const d = dossier({ nazev: 'Telefon', specifikace: [{ nazev: 'Značka', hodnota: 'Galaxy' }], identifikatory: [ean('8710103997122')] });
  const r = await identitySignals({ dossier: d, fetchers: recorder(body).fetchers });
  assert.deepEqual(r.signals, []);
});

test('shoda značky v názvu, ve specifikaci nebo přes kód výrobce: žádný nález', async () => {
  const id = [ean('8710103997122')];
  for (const d of [
    dossier({ nazev: 'Philips OneBlade břit', identifikatory: id }),
    dossier({ nazev: 'Břit OneBlade', specifikace: [{ nazev: 'Značka', hodnota: 'PHILIPS' }], identifikatory: id }),
    dossier({ nazev: 'Břit QP410/50 pro OneBlade', identifikatory: id }),
  ]) {
    const r = await identitySignals({ dossier: d, fetchers: recorder(ICECAT_PHILIPS).fetchers });
    assert.deepEqual(r.signals, []);
    assert.equal(r.status, 'ok');
  }
});

test('značka je celé slovo: Philipsen není Philips', async () => {
  const r = await identitySignals({ dossier: dossier({ nazev: 'Philipsen holicí břit', identifikatory: [ean('8710103997122')] }), fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.equal(r.signals[0].id, 'identifikator_nesedi');
  assert.equal(r.signals[0].severity, 'low');
});

test('bez názvu a bez značky v dossieru se nic neporovnává', async () => {
  const r = await identitySignals({ dossier: dossier({ nazev: null, identifikatory: [ean('8710103997122')] }), fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.deepEqual(r.signals, []);
});

test('selhání Icecatu: skipped Icecat, žádné nálezy, nezkontrolováno', async () => {
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122')] }), fetchers: recorder(new Error('timeout')).fetchers });
  assert.deepEqual(r, { status: 'unchecked', signals: [], skipped: ['Icecat'] });
  const none = await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122')] }), fetchers: {} });
  assert.deepEqual(none.skipped, ['Icecat']);
});

test('stejný kód dvakrát se ptá jednou a dotazů je nejvýš 2', async () => {
  const f = recorder(NOT_FOUND);
  await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122'), ean('8710103997122', 'model'), ean('0198222626846'), ean('4006381333931')] }), fetchers: f.fetchers });
  assert.deepEqual(f.calls, ['8710103997122', '0198222626846']);
});

test('texty nálezů projdou filtrem obviňování', async () => {
  const r = await identitySignals({ dossier: dossier({ identifikatory: [ean('8710103997122'), ean('12345')] }), fetchers: recorder(ICECAT_PHILIPS).fetchers });
  assert.equal(r.signals.length, 2);
  for (const s of r.signals) for (const t of [s.title, s.evidence, s.citace, s.vysvetleni, s.otazka]) assert.ok(!llmAccuses(t || ''), t);
});
