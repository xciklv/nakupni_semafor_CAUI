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

test('výpadek RDAP i ČOI a žádná pole → nezkontrolováno, bez externího zdroje, oba zdroje v skipped', async () => {
  const boom = async () => { throw new Error('down'); };
  const r = await sellerSignals({ x: X(), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: { rdap: boom, ares: boom }, coiList: null });
  assert.equal(r.status, 'unchecked');
  assert.deepEqual(r.signals, []);
  assert.equal(r.external, false);
  assert.deepEqual(r.skipped, ['RDAP (stáří domény)', 'seznam ČOI']);
});

test('IČO neexistuje v ARES → low s neutrálním zněním; neplatné IČO → low', async () => {
  const f = { rdap: async () => rdap('2000-01-01T00:00:00+00:00'), ares: async () => null };
  const a = await sellerSignals({ x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: f, coiList: {} });
  const ne = a.signals.find((s) => s.id === 'ico_neexistuje');
  assert.equal(ne.severity, 'low');
  assert.equal(ne.hard, false);
  assert.equal(ne.evidence, 'IČO nebylo nalezeno v českém registru ARES; u zahraničních (např. slovenských) firem je to běžné.');
  assert.equal(a.external, true);
  assert.deepEqual(a.skipped, []);
  const b = await sellerSignals({ x: X({ ico: '12345678' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: f, coiList: {} });
  assert.equal(b.signals.find((s) => s.id === 'ico_neplatne').severity, 'low');
});

test('zaniklý subjekt v ARES → high', async () => {
  const r = await sellerSignals({
    x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW,
    fetchers: { rdap: async () => rdap('2000-01-01T00:00:00+00:00'), ares: async () => ({ obchodniJmeno: 'X', datumZaniku: '2020-01-01' }) }, coiList: {},
  });
  assert.ok(ids(r).includes('subjekt_zanikl'));
  assert.equal(r.signals.find((s) => s.id === 'subjekt_zanikl').severity, 'high');
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
  assert.equal(r.status, 'unchecked'); // jediný údaj o prodejci bez externí kontroly nestačí (SELLER_MIN_CHECKS)
});

test('kontakt_uveden:false bez země → kontakt_chybi', async () => {
  const r = await sellerSignals({ x: X({ kontakt_uveden: false }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(ids(r), ['kontakt_chybi']);
});

test('provozovatel_uveden:false a odeslání z CN → jen mimo_eu_bez_kontaktu', async () => {
  const r = await sellerSignals({ x: X({ provozovatel_uveden: false, zeme_odeslani: 'CN' }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.deepEqual(ids(r), ['mimo_eu_bez_kontaktu']);
  assert.equal(r.status, 'unchecked'); // provozovatel_uveden je jediný zjištěný údaj
});

test('dědičné klíče objektů nejsou zásah v seznamu ČOI', async () => {
  const parsed = parseCoi(COI_HTML);
  for (const host of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    for (const coiList of [{}, parsed]) {
      const r = await sellerSignals({ x: X(), rezim: 'eshop', host, nowMs: NOW, fetchers: { rdap: async () => rdap('2000-01-01T00:00:00+00:00') }, coiList });
      assert.ok(!ids(r).includes('coi_seznam'), host);
    }
  }
});

test('parseCoi: nezavřené <p> za list_titles je lineární', () => {
  for (const open of ['<p>', '<p x>']) {
    const t0 = Date.now();
    const l = parseCoi('<p class="list_titles"><span>a.cz</span></p>' + open.repeat(100000));
    assert.ok(Date.now() - t0 < 1000, open);
    assert.equal(l['a.cz'], '');
  }
});

test('parseCoi dekóduje entity v důvodu a dělí domény i podle &nbsp;', () => {
  const l = parseCoi('<article><p class="list_titles"><span>a.cz&nbsp;b.cz</span></p><p>A&nbsp;&amp;&nbsp;B &lt;x&gt; &quot;q&quot; &#65;&#x42;</p></article>');
  assert.equal(l['a.cz'], 'A & B <x> "q" AB');
  assert.equal(l['b.cz'], 'A & B <x> "q" AB');
});

test('ARES: ne-objekt je nedostupný zdroj, datumZaniku musí být datum', async () => {
  const run = (body) => sellerSignals({
    x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW,
    fetchers: { rdap: async () => { throw new Error('down'); }, ares: async () => body }, coiList: null,
  });
  for (const body of [undefined, 'oops', 5]) {
    const r = await run(body);
    assert.equal(r.status, 'unchecked');
    assert.deepEqual(r.signals, []);
  }
  const bad = await run({ obchodniJmeno: 'X', datumZaniku: 'ne datum' });
  assert.deepEqual(bad.signals, []);
  assert.equal(bad.status, 'ok');
  const good = await run({ obchodniJmeno: 'X', datumZaniku: '2020-01-01' });
  assert.deepEqual(ids(good), ['subjekt_zanikl']);
});

test('rdapAgeDays: budoucí a neplatné datum → null', () => {
  assert.equal(rdapAgeDays(rdap('2027-01-01T00:00:00+00:00'), NOW), null);
  assert.equal(rdapAgeDays(rdap('October 5 2026'), NOW), null);
  assert.equal(rdapAgeDays(rdap('1'), NOW), null);
  assert.equal(rdapAgeDays(rdap('2026-10-05'), NOW), 10);
});

test('doména bez tečky: RDAP se nevolá a rdapUrl vrací null', async () => {
  let called = false;
  const r = await sellerSignals({ x: X(), rezim: 'eshop', host: 'intranet', nowMs: NOW, fetchers: { rdap: async () => { called = true; return {}; } }, coiList: null });
  assert.equal(called, false);
  assert.equal(r.status, 'unchecked');
  assert.equal(rdapUrl('intranet'), null);
});

const coiWrap = (title, reason) => '<article><p class = "list_titles"><br>' + title + '</p><p>' + reason + '</p></article>';
const fast = (name, html) => test('parseCoi lineární: ' + name, () => {
  const t0 = Date.now();
  assert.doesNotThrow(() => parseCoi(html));
  assert.ok(Date.now() - t0 < 1000);
});
fast('"<" x100000 v důvodu', coiWrap('<span>a.cz</span>', '<'.repeat(100000)));
fast('"<span>" x100000 bez uzavření v list_titles', coiWrap('<span>'.repeat(100000), 'x'));
fast('"<span>a.cz" x50000 bez uzavření', coiWrap('<span>a.cz'.repeat(50000), 'x'));
fast('"<a" x100000 v důvodu', coiWrap('<span>a.cz</span>', '<a'.repeat(100000)));

test('parseCoi: běžný záznam se dvěma doménami a značkami v důvodu', () => {
  const l = parseCoi(coiWrap('<span>a.cz, b.cz</span>', '<b>x</b>'));
  assert.equal(l['a.cz'], 'x');
  assert.equal(l['b.cz'], 'x');
  assert.deepEqual(Object.keys(l).sort(), ['a.cz', 'b.cz']);
});

// --- fix wave A: external / skipped, paralelní fetchery, české znění ---
const OLD = async () => rdap('2000-01-01T00:00:00+00:00');
const run = (prodejce, o = {}) => sellerSignals({ x: X(prodejce), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: { rdap: OLD, ares: async () => ({}) }, coiList: {}, ...o });

test('external: RDAP, ČOI i ARES samostatně stačí; marketplace bez externích zdrojů je external:false', async () => {
  assert.equal((await run({}, { coiList: null })).external, true, 'RDAP');
  assert.equal((await run({}, { fetchers: { rdap: async () => { throw new Error('x'); } } })).external, true, 'ČOI');
  const ares = await run({ ico: '27082440' }, { coiList: null, fetchers: { rdap: async () => { throw new Error('x'); }, ares: async () => ({}) } });
  assert.equal(ares.external, true, 'ARES');
  const mp = await sellerSignals({ x: X({ hodnoceni: 4.8 }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null });
  assert.equal(mp.external, false);
  assert.deepEqual(mp.skipped, []);
  const bad = await run({ ico: '12345678' }, { coiList: null, fetchers: { rdap: async () => { throw new Error('x'); } } });
  assert.equal(bad.external, false, 'neplatné IČO není externí zdroj');
});

test('skipped: RDAP bez použitelného data, ČOI bez seznamu a ARES s neplatnou odpovědí, v tomto pořadí', async () => {
  const r = await run({ ico: '27082440' }, { coiList: null, fetchers: { rdap: async () => ({ events: [] }), ares: async () => 'oops' } });
  assert.deepEqual(r.skipped, ['RDAP (stáří domény)', 'seznam ČOI', 'ARES']);
  assert.equal(r.external, false);
  assert.equal(r.status, 'unchecked');
});

test('skipped: ARES odmítnutí; dostupné zdroje v skipped nejsou', async () => {
  const r = await run({ ico: '27082440' }, { fetchers: { rdap: OLD, ares: async () => { throw new Error('ARES 500'); } } });
  assert.deepEqual(r.skipped, ['ARES']);
  assert.equal(r.external, true);
  const ok = await run({ ico: '27082440' });
  assert.deepEqual(ok.skipped, []);
});

test('skipped: neplatné IČO a doména bez tečky ARES ani RDAP nevolají; marketplace s nedostupným ARES ho uvede', async () => {
  let called = 0;
  const f = { rdap: async () => { called++; return {}; }, ares: async () => { called++; return {}; } };
  const a = await sellerSignals({ x: X({ ico: '12345678' }), rezim: 'eshop', host: 'intranet', nowMs: NOW, fetchers: f, coiList: {} });
  assert.deepEqual(a.skipped, []);
  assert.equal(called, 0);
  const m = await sellerSignals({ x: X({ ico: '27082440' }), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: { ares: async () => { throw new Error('x'); } }, coiList: null });
  assert.deepEqual(m.skipped, ['ARES']);
});

test('RDAP a ARES se volají souběžně (obě volání začnou dřív, než některé skončí)', async () => {
  const started = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const p = sellerSignals({
    x: X({ ico: '27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, coiList: {},
    fetchers: {
      rdap: () => { started.push('rdap'); return gate.then(() => rdap('2000-01-01T00:00:00+00:00')); },
      ares: () => { started.push('ares'); return gate.then(() => ({})); },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(started.slice().sort(), ['ares', 'rdap'], 'před uvolněním musí běžet obě');
  release();
  const r = await p;
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.skipped, []);
});

test('coiList smí být promise; odmítnutý promise = seznam ČOI v skipped', async () => {
  const hit = await run({}, { host: 'clarkscz.cz', coiList: Promise.resolve(parseCoi(COI_HTML)) });
  assert.ok(ids(hit).includes('coi_seznam'));
  const rej = await run({}, { coiList: Promise.reject(new Error('x')) });
  assert.deepEqual(rej.skipped, ['seznam ČOI']);
});

test('čeština: před 1 dnem / 2 dny / 5 dny', async () => {
  const ev = async (n) => (await sellerSignals({ x: X(), rezim: 'eshop', host: 'x.cz', nowMs: NOW, fetchers: { rdap: async () => rdap(new Date(NOW - n * 86400000).toISOString()) }, coiList: {} })).signals[0].evidence;
  assert.equal(await ev(0), 'Doména x.cz byla zaregistrována dnes.');
  assert.equal(await ev(1), 'Doména x.cz byla zaregistrována před 1 dnem.');
  assert.equal(await ev(2), 'Doména x.cz byla zaregistrována před 2 dny.');
  assert.equal(await ev(5), 'Doména x.cz byla zaregistrována před 5 dny.');
  assert.equal(await ev(100), 'Doména x.cz byla zaregistrována před 100 dny.');
});

test('čeština: počet prodejů, hodnocení s desetinnou čárkou, stáří obchodu', async () => {
  const sig = async (p, id) => (await sellerSignals({ x: X(p), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null })).signals.find((s) => s.id === id);
  assert.equal((await sig({ pocet_prodeju: 10 }, 'malo_prodeju')).evidence, 'Počet prodejů: 10.');
  assert.equal((await sig({ hodnoceni: 3.5 }, 'hodnoceni_prumerne')).evidence, 'Hodnocení prodejce je 3,5.');
  assert.equal((await sig({ hodnoceni: 3 }, 'hodnoceni_nizke')).evidence, 'Hodnocení prodejce je 3.');
  assert.equal((await sig({ stari_obchodu_dny: 30 }, 'obchod_novy')).evidence, 'Obchod je starý 30 dní.');
  assert.equal((await sig({ stari_obchodu_dny: 1 }, 'obchod_novy')).evidence, 'Obchod je starý 1 den.');
  assert.equal((await sig({ stari_obchodu_dny: 3 }, 'obchod_novy')).evidence, 'Obchod je starý 3 dny.');
  assert.equal((await sig({ stari_obchodu_dny: 0 }, 'obchod_novy')).evidence, 'Obchod je starý 0 dní.');
});

// --- stupně hodnocení prodejce a minimum údajů o prodejci ---
const { computeVerdict } = require('../engine/scoring');
const runMk = (p, extra = {}) => sellerSignals({ x: X(p), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, fetchers: {}, coiList: null, ...extra });

test('hodnocení prodejce: pod 3,5 střední signál, 3,5 až 4,0 nízký, od 4,0 žádný, 0 se nehodnotí', async () => {
  const sev = async (h) => (await runMk({ hodnoceni: h })).signals.map((s) => s.id + ':' + s.severity);
  assert.deepEqual(await sev(3.4), ['hodnoceni_nizke:medium']);
  assert.deepEqual(await sev(1), ['hodnoceni_nizke:medium']);
  assert.deepEqual(await sev(3.5), ['hodnoceni_prumerne:low']);
  assert.deepEqual(await sev(3.9), ['hodnoceni_prumerne:low']);
  assert.deepEqual(await sev(4.0), []);
  assert.deepEqual(await sev(4.8), []);
  assert.deepEqual(await sev(0), []);
});

test('hodnocení prodejce: 3,9 samo o sobě oranžovou nedá, 3,4 ano', async () => {
  const verdict = async (h) => { const r = await runMk({ hodnoceni: h, pocet_prodeju: 500 }); return computeVerdict(r.signals, { offer: 'ok', seller: r.status, safety: 'ok' }).semafor; };
  assert.equal(await verdict(3.9), 'zelená');
  assert.equal(await verdict(3.4), 'oranžová');
});

test('bez externí kontroly modul prodejce platí za zkontrolovaný až od 2 údajů; jediný údaj = nezkontrolováno', async () => {
  assert.equal((await runMk({})).status, 'unchecked');
  assert.equal((await runMk({ hodnoceni: 4.8 })).status, 'unchecked');
  assert.equal((await runMk({ pocet_prodeju: 1200 })).status, 'unchecked');
  assert.equal((await runMk({ hodnoceni: 4.8, pocet_prodeju: 1200 })).status, 'ok');
  assert.equal((await runMk({ kontakt_uveden: true, podminky_uvedeny: true })).status, 'ok');
});

test('marketplace/screenshot s jediným údajem o prodejci nikdy nedá zelenou (šedá), s dvěma údaji ano', async () => {
  const verdict = async (p) => { const r = await runMk(p); return computeVerdict(r.signals, { offer: 'ok', seller: r.status, safety: 'ok' }).semafor; };
  assert.equal(await verdict({ hodnoceni: 4.8 }), 'šedá');
  assert.equal(await verdict({ hodnoceni: 4.8, pocet_prodeju: 1200 }), 'zelená');
});

test('s externím zdrojem (ČOI) stačí modul prodejce i bez údajů z nabídky', async () => {
  const r = await runMk({}, { rezim: 'eshop', host: 'example.cz', coiList: {} });
  assert.equal(r.external, true);
  assert.equal(r.status, 'ok');
});
