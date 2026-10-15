const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtraction } = require('../engine/llm');
const { SELLER_EU, registrable, parseCoi, rdapAgeDays, isValidIco, rdapUrl, sellerSignals } = require('../engine/seller');

const NOW = Date.parse('2026-10-15T00:00:00Z');
const X = (prodejce = {}) => normalizeExtraction({ produkt: { nazev: 'A' }, prodejce });
const rdap = (iso) => ({ events: [{ eventAction: 'registration', eventDate: iso }] });
const ids = (r) => r.signals.map((s) => s.id);

const COI_HTML = `
<div class="eshops-list">
<article class="information-row" id="post-1"><div class="entry-content">
<p class = "list_titles"><br><span>clarkscz.cz</span></p>
<p>Jako provozovatel webu není uveden nikdo.</p><p>(05. 10. 2026)</p></div></article>
<article class="information-row" id="post-2"><div class="entry-content">
<p class = "list_titles"><br><span>Www.Tytyok.shop, kovexcz.store</span></p>
<p>Web provozuje subjekt mimo EU.</p></div></article></div>
<p>Seznam přebírá seznam.cz a eset.com</p>`;

test('registrable bere poslední dvě části', () => {
  assert.equal(registrable('shop.example.cz'), 'example.cz');
  assert.equal(registrable('alza.cz'), 'alza.cz');
});

test('registrable zná dvouúrovňové veřejné přípony', () => {
  assert.equal(registrable('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('www.example.com.pl'), 'example.com.pl');
  assert.equal(registrable('co.uk'), 'co.uk');
});

test('parseCoi vytáhne domény a důvody', () => {
  const l = parseCoi(COI_HTML);
  assert.equal(l['clarkscz.cz'], 'Jako provozovatel webu není uveden nikdo.');
  assert.ok(l['tytyok.shop']);
  assert.ok(l['kovexcz.store']);
  assert.equal(l['seznam.cz'], undefined);
});

test('parseCoi je lineární i bez uzavíracích značek', () => {
  const t0 = Date.now();
  const l = parseCoi('<p class="list_titles"><span>a.cz</span></p>'.repeat(20000));
  assert.ok(Date.now() - t0 < 1000);
  assert.ok('a.cz' in l);
  const t1 = Date.now();
  assert.doesNotThrow(() => parseCoi('<p class="list_titles"><span>a.cz</span>'.repeat(20000)));
  assert.ok(Date.now() - t1 < 1000);
});

test('rdapAgeDays a chybějící událost', () => {
  assert.equal(rdapAgeDays(rdap('2026-10-05T00:00:00+00:00'), NOW), 10);
  assert.equal(rdapAgeDays({ events: [] }, NOW), null);
  assert.equal(rdapAgeDays(null, NOW), null);
});

test('isValidIco kontroluje délku a kontrolní číslici', () => {
  assert.equal(isValidIco('27082440'), true);
  assert.equal(isValidIco('27082441'), false);
  assert.equal(isValidIco('123'), false);
});

test('rdapUrl: .cz přímo, ostatní přes rdap.org', () => {
  assert.equal(rdapUrl('alza.cz'), 'https://rdap.nic.cz/domain/alza.cz');
  assert.equal(rdapUrl('foo.com'), 'https://rdap.org/domain/foo.com');
});

test('SELLER_EU obsahuje CZ a neobsahuje CN', () => {
  assert.ok(SELLER_EU.includes('CZ'));
  assert.ok(!SELLER_EU.includes('CN'));
});

test('nová doména a ČOI zásah → hard signál', async () => {
  const r = await sellerSignals({
    x: X(), rezim: 'eshop', host: 'www.clarkscz.cz', nowMs: NOW,
    fetchers: { rdap: async () => rdap('2026-10-01T00:00:00+00:00'), ares: async () => null },
    coiList: parseCoi(COI_HTML),
  });
  assert.equal(r.status, 'ok');
  assert.ok(ids(r).includes('domena_nova'));
  const coi = r.signals.find((s) => s.id === 'coi_seznam');
  assert.equal(coi.hard, true);
});

test('stará doména mimo seznam → bez signálů', async () => {
  const r = await sellerSignals({
    x: X({ provozovatel_uveden: true, kontakt_uveden: true }), rezim: 'eshop', host: 'alza.cz', nowMs: NOW,
    fetchers: { rdap: async () => rdap('1999-01-01T00:00:00+00:00'), ares: async () => null }, coiList: parseCoi(COI_HTML),
  });
  assert.deepEqual(r.signals, []);
  assert.equal(r.status, 'ok');
});

test('výpadek RDAP i ČOI a žádná pole → nezkontrolováno', async () => {
  const boom = async () => { throw new Error('down'); };
  const r = await sellerSignals({ x: X(), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: { rdap: boom, ares: boom }, coiList: null });
  assert.equal(r.status, 'unchecked');
  assert.deepEqual(r.signals, []);
});

test('IČO neexistuje v ARES → high; neplatné IČO → medium', async () => {
  const f = { rdap: async () => rdap('2000-01-01T00:00:00+00:00'), ares: async () => null };
  const a = await sellerSignals({ x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: f, coiList: {} });
  assert.equal(a.signals.find((s) => s.id === 'ico_neexistuje').severity, 'high');
  const b = await sellerSignals({ x: X({ ico: '12345678' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: f, coiList: {} });
  assert.ok(ids(b).includes('ico_neplatne'));
});

test('zaniklý subjekt v ARES → high', async () => {
  const r = await sellerSignals({
    x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW,
    fetchers: { rdap: async () => rdap('2000-01-01T00:00:00+00:00'), ares: async () => ({ obchodniJmeno: 'X', datumZaniku: '2020-01-01' }) }, coiList: {},
  });
  assert.ok(ids(r).includes('subjekt_zanikl'));
});

test('marketplace: nízké hodnocení, nový obchod, málo prodejů, odeslání mimo EU bez kontaktu', async () => {
  const r = await sellerSignals({
    x: X({ hodnoceni: 3.4, stari_obchodu_dny: 30, pocet_prodeju: 10, zeme_odeslani: 'cn', kontakt_uveden: false }),
    rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null,
  });
  assert.deepEqual(ids(r).sort(), ['hodnoceni_nizke', 'malo_prodeju', 'mimo_eu_bez_kontaktu', 'obchod_novy'].sort());
  assert.equal(r.status, 'ok');
});

test('hodnocení 0 znamená bez hodnocení: žádný signál a nepočítá se jako kontrola', async () => {
  const r = await sellerSignals({ x: X({ hodnoceni: 0 }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(r.signals, []);
  assert.equal(r.status, 'unchecked');
});

test('marketplace nevolá RDAP ani ČOI', async () => {
  let called = false;
  const f = { rdap: async () => { called = true; return {}; } };
  await sellerSignals({ x: X({ hodnoceni: 4.8 }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: f, coiList: {} });
  assert.equal(called, false);
});

test('kontakt_uveden:false v EU → kontakt_chybi, bez mimo_eu_bez_kontaktu', async () => {
  const r = await sellerSignals({ x: X({ kontakt_uveden: false, zeme_odeslani: 'DE' }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(ids(r), ['kontakt_chybi']);
  assert.equal(r.status, 'ok');
});

test('kontakt_uveden:false bez země → kontakt_chybi', async () => {
  const r = await sellerSignals({ x: X({ kontakt_uveden: false }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(ids(r), ['kontakt_chybi']);
});

test('provozovatel_uveden:false a odeslání z CN → jen mimo_eu_bez_kontaktu', async () => {
  const r = await sellerSignals({ x: X({ provozovatel_uveden: false, zeme_odeslani: 'CN' }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(ids(r), ['mimo_eu_bez_kontaktu']);
  assert.equal(r.status, 'ok');
});
