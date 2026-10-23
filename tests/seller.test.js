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
  assert.equal(a.external, false, 'záporná odpověď registru ověření nepotvrzuje, ani když jiný zdroj (RDAP) vyšel dobře');
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
  const ares = await run({ nazev: 'Alza.cz', ico: '27082440' }, { coiList: null, fetchers: { rdap: async () => { throw new Error('x'); }, ares: async () => ({ obchodniJmeno: 'Alza.cz a.s.' }) } });
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

// --- VIES (ověření DIČ) a datum vzniku firmy z ARES ---
// Pole dic dodává extrakce až v Tasku 4, proto se tady dosazuje ručně.
const XD = (prodejce) => { const x = X(prodejce); x.prodejce.dic = prodejce.dic; return x; };
const viesOk = async () => ({ isValid: true, userError: 'VALID', name: 'ČEZ, a. s.', address: 'Duhová 1444/2\nPRAHA 4' });
const runVies = (prodejce, o = {}) => sellerSignals({
  x: XD(prodejce), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, coiList: null,
  fetchers: { vies: viesOk }, ...o,
});

test('VIES: platné DIČ a shodné jméno → žádný nález, external a status ok; volá se (cc, číslo)', async () => {
  const calls = [];
  const r = await runVies({ nazev: 'ČEZ Prodej s.r.o.', dic: 'CZ45274649' }, { fetchers: { vies: async (cc, cislo) => { calls.push([cc, cislo]); return { isValid: true, name: 'ČEZ, a. s.' }; } } });
  assert.deepEqual(calls, [['CZ', '45274649']]);
  assert.deepEqual(ids(r), []);
  assert.equal(r.external, true);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.skipped, []);
});

test('VIES: DIČ s mezerami a malými písmeny se před dotazem upraví', async () => {
  const calls = [];
  await runVies({ dic: ' cz 4527 4649 ' }, { fetchers: { vies: async (cc, cislo) => { calls.push([cc, cislo]); return { isValid: true }; } } });
  assert.deepEqual(calls, [['CZ', '45274649']]);
});

test('VIES: isValid:false → dic_neplatne (low: neplátce DPH je normální, DIČ z textu je neověřené), zdroj se počítá jako externí kontrola', async () => {
  const r = await runVies({ nazev: 'Firma', dic: 'CZ12345678' }, { fetchers: { vies: async () => ({ isValid: false, userError: 'INVALID' }) } });
  const s = r.signals.find((x) => x.id === 'dic_neplatne');
  assert.ok(s);
  assert.equal(s.severity, 'low');
  assert.equal(s.source, 'VIES');
  assert.match(s.evidence, /CZ12345678/);
  assert.equal(r.external, false, 'neplatné DIČ není kladné ověření');
  assert.equal(r.status, 'ok', 'VIES odpověděl, takže modul prodejce je zkontrolovaný');
});

test('VIES: platné DIČ, ale jméno nesdílí žádné slovo delší než 3 znaky → dic_jmeno_nesedi (low, rozpor)', async () => {
  const r = await runVies({ nazev: 'Super Shop Praha', dic: 'CZ45274649' }, { fetchers: { vies: async () => ({ isValid: true, name: 'Alfa Beta s.r.o.' }) } });
  const s = r.signals.find((x) => x.id === 'dic_jmeno_nesedi');
  assert.ok(s);
  assert.equal(s.severity, 'low');
  assert.equal(s.druh, 'rozpor');
  assert.equal(s.citace, 'Super Shop Praha');
  assert.ok(s.vysvetleni && s.otazka);
  assert.ok(!ids(r).includes('dic_neplatne'));
});

test('VIES: jméno se porovnává bez diakritiky a velikosti písmen; slova do 3 znaků (a., s., ČEZ) nerozhodují', async () => {
  const same = await runVies({ nazev: 'CEZ DISTRIBUCE', dic: 'CZ12345678' }, { fetchers: { vies: async () => ({ isValid: true, name: 'ČEZ Distribuce, a. s.' }) } });
  assert.deepEqual(ids(same), []);
  const onlyShort = await runVies({ nazev: 'ČEZ s.r.o.', dic: 'CZ45274649' }, { fetchers: { vies: async () => ({ isValid: true, name: 'ČEZ, a. s.' }) } });
  assert.deepEqual(ids(onlyShort), [], 'bez slova delšího než 3 znaky nelze porovnat, takže bez nálezu');
});

test('VIES: jméno z VIES chybí, je "---" nebo prodejce.nazev chybí → bez nálezu o jménu', async () => {
  for (const [nazev, name] of [['Super Shop', undefined], ['Super Shop', '---'], ['Super Shop', ''], [null, 'ČEZ, a. s.']]) {
    const r = await runVies({ nazev, dic: 'CZ45274649' }, { fetchers: { vies: async () => ({ isValid: true, name }) } });
    assert.deepEqual(ids(r), [], String(name));
    assert.equal(r.external, true);
  }
});

test('VIES: selhání (vyhodí, nepoužitelná odpověď, userError členského státu) → skipped VIES, žádný nález', async () => {
  const boom = async () => { throw new Error('VIES 503'); };
  const a = await runVies({ hodnoceni: 4.8, dic: 'CZ45274649' }, { fetchers: { vies: boom } });
  assert.deepEqual(a.skipped, ['VIES']);
  assert.deepEqual(ids(a), []);
  assert.equal(a.external, false);
  assert.equal(a.status, 'unchecked', 'jediný údaj o prodejci bez externí kontroly');
  for (const body of [null, 'oops', 5, [], {}, { isValid: 'yes' }, { isValid: false, userError: 'MS_UNAVAILABLE' }, { isValid: false, userError: 'TIMEOUT' }]) {
    const r = await runVies({ nazev: 'X Shop', dic: 'CZ45274649' }, { fetchers: { vies: async () => body } });
    assert.deepEqual(r.skipped, ['VIES'], JSON.stringify(body));
    assert.deepEqual(ids(r), [], JSON.stringify(body));
    assert.equal(r.external, false);
  }
  const noFn = await runVies({ dic: 'CZ45274649' }, { fetchers: {} });
  assert.deepEqual(noFn.skipped, ['VIES'], 'chybějící fetchers.vies je nedostupný zdroj, ne výjimka');
  const ok = await runVies({ hodnoceni: 4.8, dic: 'CZ45274649' }, { fetchers: { rdap: OLD, vies: boom }, rezim: 'eshop', host: 'x.cz', coiList: {} });
  assert.deepEqual(ok.skipped, ['VIES']);
  assert.equal(ok.status, 'ok', 'ČOI stačí');
});

test('VIES: bez dic nebo s DIČ jiného tvaru se vies nevolá a nic se nezapíše do skipped', async () => {
  let called = 0;
  const f = { vies: async () => { called++; return { isValid: true }; } };
  for (const dic of [undefined, null, '', 'CZ', 'C1234', '12345678', 'CZ12345678901234', 'CZ 12-34']) {
    const r = await runVies({ hodnoceni: 4.8, dic }, { fetchers: f });
    assert.deepEqual(r.skipped, [], String(dic));
  }
  assert.equal(called, 0);
});

test('VIES: běží souběžně s RDAP a ARES', async () => {
  const started = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const p = sellerSignals({
    x: XD({ ico: '27082440', dic: 'CZ27082440' }), rezim: 'eshop', host: 'x.cz', nowMs: NOW, coiList: {},
    fetchers: {
      rdap: () => { started.push('rdap'); return gate.then(() => rdap('2000-01-01T00:00:00+00:00')); },
      ares: () => { started.push('ares'); return gate.then(() => ({})); },
      vies: () => { started.push('vies'); return gate.then(() => ({ isValid: true })); },
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(started.slice().sort(), ['ares', 'rdap', 'vies']);
  release();
  assert.deepEqual((await p).skipped, []);
});

test('ARES: datumVzniku před 30 dny → firma_nova (low: mladá firma nic nedokazuje); od 180 dní výš ne', async () => {
  const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
  const run1 = (datumVzniku) => run({ ico: '27082440' }, { fetchers: { rdap: OLD, ares: async () => ({ obchodniJmeno: 'Nová s.r.o.', datumVzniku }) } });
  const s = (await run1(day(30))).signals.find((x) => x.id === 'firma_nova');
  assert.ok(s);
  assert.equal(s.severity, 'low');
  assert.equal(s.source, 'ARES');
  assert.match(s.evidence, /30 dn/);
  assert.ok(ids(await run1(day(179))).includes('firma_nova'));
  assert.ok(!ids(await run1(day(180))).includes('firma_nova'));
  assert.ok(!ids(await run1('1992-05-06')).includes('firma_nova'));
});

test('ARES: nepoužitelné nebo budoucí datumVzniku se ignoruje', async () => {
  for (const datumVzniku of [undefined, null, 'ne datum', 20260101, '2027-01-01']) {
    const r = await run({ ico: '27082440' }, { fetchers: { rdap: OLD, ares: async () => ({ datumVzniku }) } });
    assert.ok(!ids(r).includes('firma_nova'), String(datumVzniku));
    assert.deepEqual(r.skipped, []);
  }
});

test('ARES: zaniklá firma dává subjekt_zanikl, ne firma_nova', async () => {
  const r = await run({ ico: '27082440' }, { fetchers: { rdap: OLD, ares: async () => ({ obchodniJmeno: 'X', datumVzniku: '2026-10-01', datumZaniku: '2026-10-10' }) } });
  assert.ok(ids(r).includes('subjekt_zanikl'));
  assert.ok(!ids(r).includes('firma_nova'));
});

// --- druhé kolo, nález 1: external platí jen pro kladnou odpověď registru ---
const ARES_OK = async () => ({ obchodniJmeno: 'Alza.cz a.s.', datumVzniku: '1994-01-01' });
const runExt = (prodejce, fetchers, o = {}) => sellerSignals({ x: XD(prodejce), rezim: 'marketplace', host: 'temu.com', nowMs: NOW, coiList: null, fetchers, ...o });

test('external: ARES našel subjekt a jméno sedí s prodejcem → true', async () => {
  const r = await runExt({ nazev: 'Alza.cz', ico: '27082440' }, { ares: ARES_OK });
  assert.equal(r.external, true);
  assert.deepEqual(ids(r), []);
});

test('external: ARES 404 (IČO nenalezeno) je ověření nepotvrzeno → false, modul prodejce ale odpověď dostal (status ok)', async () => {
  const r = await runExt({ nazev: 'Alza.cz', ico: '27082440' }, { ares: async () => null });
  assert.ok(ids(r).includes('ico_neexistuje'));
  assert.equal(r.external, false);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.skipped, []);
});

test('external: ARES najde cizí subjekt (jméno nesedí) → nález ares_jmeno_nesedi (low, rozpor) a external false', async () => {
  const r = await runExt({ nazev: 'Super Shop Praha', ico: '27082440' }, { ares: ARES_OK });
  const s = r.signals.find((x) => x.id === 'ares_jmeno_nesedi');
  assert.ok(s);
  assert.equal(s.severity, 'low');
  assert.equal(s.druh, 'rozpor');
  assert.equal(s.source, 'ARES');
  assert.equal(s.citace, 'Super Shop Praha');
  assert.ok(s.vysvetleni && s.otazka);
  assert.equal(r.external, false);
});

test('ARES: jméno se porovnává tolerantně (diakritika, velikost, podřetězec, právní forma)', async () => {
  for (const [own, ares] of [['ALZA', 'Alza.cz a.s.'], ['Alza.cz a.s.', 'ALZA'], ['Tchibo Praha s.r.o.', 'Tchibo Praha spol. s r.o.'], ['Rohlík', 'Rohlik.cz Finance a.s.'], ['Kosmas.cz', 'KOSMAS s.r.o.']]) {
    const r = await runExt({ nazev: own, ico: '27082440' }, { ares: async () => ({ obchodniJmeno: ares }) });
    assert.deepEqual(ids(r), [], own + ' / ' + ares);
    assert.equal(r.external, true, own + ' / ' + ares);
  }
});

test('external: ARES bez porovnatelného jména (prodejce bez názvu, odpověď bez obchodniJmeno) → false, bez nálezu', async () => {
  for (const [nazev, body] of [[null, { obchodniJmeno: 'Alza.cz a.s.' }], ['Alza.cz', {}], ['ab', { obchodniJmeno: 'Alza.cz a.s.' }]]) {
    const r = await runExt({ nazev, ico: '27082440' }, { ares: async () => body });
    assert.equal(r.external, false, String(nazev));
    assert.ok(!ids(r).includes('ares_jmeno_nesedi'), String(nazev));
  }
});

test('external: VIES isValid:false, firma_nova a jméno u DIČ nesedí jsou ověření nepotvrzeno → false', async () => {
  const bad = await runExt({ nazev: 'Firma Test', dic: 'CZ12345678' }, { vies: async () => ({ isValid: false, userError: 'INVALID' }) });
  assert.equal(bad.external, false);
  assert.equal(bad.status, 'ok');
  const mismatch = await runExt({ nazev: 'Super Shop Praha', dic: 'CZ45274649' }, { vies: async () => ({ isValid: true, name: 'Alfa Beta s.r.o.' }) });
  assert.equal(mismatch.external, false);
  const day = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
  const nova = await runExt({ nazev: 'Alza.cz', ico: '27082440' }, { ares: async () => ({ obchodniJmeno: 'Alza.cz a.s.', datumVzniku: day(30) }) });
  assert.ok(ids(nova).includes('firma_nova'));
  assert.equal(nova.external, false);
  const zanikl = await runExt({ nazev: 'Alza.cz', ico: '27082440' }, { ares: async () => ({ obchodniJmeno: 'Alza.cz a.s.', datumZaniku: '2020-01-01' }) });
  assert.equal(zanikl.external, false);
});

test('external: mladá doména (RDAP) a e-shop na seznamu ČOI externí ověření nedají; stará doména a čistý seznam ano', async () => {
  const young = await run({}, { coiList: null, fetchers: { rdap: async () => rdap('2026-09-01T00:00:00+00:00') } });
  assert.equal(young.external, false);
  const listed = await run({}, { fetchers: { rdap: async () => { throw new Error('x'); } }, coiList: { 'x.cz': 'Rizikový web' } });
  assert.equal(listed.external, false);
  assert.equal((await run({}, { coiList: null })).external, true);
});

test('external: záporná odpověď jednoho registru ruší kladnou odpověď jiného (stará doména + IČO nenalezeno → false)', async () => {
  const r = await run({ nazev: 'Alza.cz', ico: '27082440' }, { fetchers: { rdap: OLD, ares: async () => null } });
  assert.ok(ids(r).includes('ico_neexistuje'));
  assert.equal(r.external, false);
});

// D2 i pro prodejce: chybějící údaje u neúplného vstupu (text, screenshot, rozšíření) jsou jen info a nepočítají se jako kontrola.
const ABSENCE = { kontakt_uveden: false, provozovatel_uveden: false, podminky_uvedeny: false, zeme_odeslani: 'CN' };
const sevOf = (r, id) => (r.signals.find((s) => s.id === id) || {}).severity;

test('neúplný vstup: mimo_eu_bez_kontaktu a podminky_chybi jsou info/nelze_overit a skóre je 0', async () => {
  const r = await runMk(ABSENCE);
  assert.deepEqual(ids(r).sort(), ['mimo_eu_bez_kontaktu', 'podminky_chybi']);
  for (const s of r.signals) {
    assert.equal(s.severity, 'info', s.id);
    assert.equal(s.druh, 'nelze_overit', s.id);
    assert.match(s.evidence, /část nabídky/);
  }
  assert.equal(computeVerdict(r.signals, { offer: 'ok', seller: r.status, safety: 'ok' }).score, 0);
});

test('neúplný vstup: kontakt_chybi a provozovatel_chybi (bez složeného signálu) jsou také info', async () => {
  const r = await runMk({ kontakt_uveden: false, provozovatel_uveden: false, zeme_odeslani: 'DE' }, { uplny: false });
  assert.deepEqual(ids(r).sort(), ['kontakt_chybi', 'provozovatel_chybi']);
  assert.ok(r.signals.every((s) => s.severity === 'info' && s.druh === 'nelze_overit'));
});

test('neúplný vstup: absence nepatří do checks, modul prodejce z ní sám nezíská „ok“', async () => {
  const r = await runMk(ABSENCE);
  assert.equal(r.status, 'unchecked');
  assert.equal((await runMk({ ...ABSENCE, hodnoceni: 4.8 })).status, 'unchecked', 'jeden skutečný údaj k absenci nestačí');
  assert.equal((await runMk({ ...ABSENCE, hodnoceni: 4.8, pocet_prodeju: 1200 })).status, 'ok');
});

test('neúplný vstup: přítomné údaje (kontakt a provozovatel uvedeny) jako kontrola dál platí', async () => {
  const r = await runMk({ kontakt_uveden: true, provozovatel_uveden: true });
  assert.deepEqual(r.signals, []);
  assert.equal(r.status, 'ok');
});

test('úplné čtení (uplny: true): původní závažnosti zůstávají', async () => {
  const r = await runMk(ABSENCE, { uplny: true });
  assert.equal(sevOf(r, 'mimo_eu_bez_kontaktu'), 'medium');
  assert.equal(sevOf(r, 'podminky_chybi'), 'low');
  const eu = await runMk({ kontakt_uveden: false, provozovatel_uveden: false, zeme_odeslani: 'DE' }, { uplny: true });
  assert.deepEqual(eu.signals.map((s) => [s.id, s.severity]).sort(), [['kontakt_chybi', 'medium'], ['provozovatel_chybi', 'medium']]);
  assert.equal(r.status, 'ok', 'tři skutečné absence z plné stránky jsou kontrola');
});

test('neúplný vstup: ostatní signály prodejce (nízké hodnocení, málo prodejů, nový obchod) se nemění', async () => {
  const r = await runMk({ hodnoceni: 3.4, stari_obchodu_dny: 30, pocet_prodeju: 10 });
  assert.deepEqual(r.signals.map((s) => [s.id, s.severity]).sort(), [['hodnoceni_nizke', 'medium'], ['malo_prodeju', 'low'], ['obchod_novy', 'medium']]);
});
