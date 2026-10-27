const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWorkflow } = require('../build/build-workflow');
const { runCodeNode } = require('./sandbox');

// Glue kroky, které skládají verdikt (Moduly, Souhrn): nálezy z code review 5 až 7 (pravidla neúplného vstupu, věrohodný prodejce, přeskočené moduly).
const WF = buildWorkflow({ credId: 'C', credName: 'N' });
const codeOf = (name) => WF.nodes.find((n) => n.name === name).parameters.jsCode;
const anthropicReply = (obj) => ({ type: 'message', role: 'assistant', content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }], stop_reason: 'end_turn' });
const fixtureJson = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

const runModuly = (json, ctx, o = {}) => runCodeNode(codeOf('Moduly'), { json, nodes: { 'Vstup a načtení': ctx }, httpStub: () => ({ statusCode: 404, body: '' }), ...o });

// --- nález 5 (D2): chybějící údaje u neúplného vstupu jen info ---
test('glue 03: vložený text bez CE a s GPSR „ne“ dá info (nepočítá se do skóre), úplné čtení stránky low', async () => {
  const textCtx = { zkratka: false, input: { text: 'Nabíječka 65 W za 199 Kč', screenshoty: [], url: null }, pageText: '', rezim: 'neznámé', host: null, obsah: true };
  const x = anthropicReply({ produkt: { nazev: 'Nabíječka 65 W', kategorie: 'elektronika', cena: 199, mena: 'CZK' }, prodejce: {}, recenze: {}, obrazky: {}, gpsr: { vyrobce_uveden: 'ne', adresa_vyrobce: 'neuvedeno', odpovedna_osoba_eu: 'neuvedeno' }, nerealne_parametry: [], nesoulady: [] });
  const text = await runModuly(x, textCtx);
  const sev = (out, id) => (out.signals.find((s) => s.id === id) || {}).severity;
  assert.equal(sev(text.out, 'ce_chybi'), 'info');
  assert.equal(sev(text.out, 'gpsr_chybi'), 'info');

  const plny = fixtureJson('dossier-cyklosvitilna.json');
  plny.gaps = [{ what: 'doba existence obchodu', why: 'na stránce obchodu není uvedena' }];
  const readerCtx = { zkratka: false, input: { text: '', screenshoty: [], url: null }, pageText: '', rezim: 'marketplace', host: 'aliexpress.com', obsah: true, dossier: plny };
  const reader = await runModuly({}, readerCtx);
  assert.equal(sev(reader.out, 'ce_chybi'), 'low');
});

// --- Souhrn (glue 07): nálezy 6 a 7 ---
const { normalizeDossier } = require('../engine/dossier');
const DOSSIER = normalizeDossier(fixtureJson('dossier-cyklosvitilna.json')).dossier;
const PLAUS_V_PORADKU = anthropicReply({ tvrzeni: [], verdikt: 'v_poradku', jistota: 'vysoka', vysvetleni_pro_laika: 'Čísla sedí.', otazka_pro_prodejce: '' });
const OK3 = { offer: 'ok', seller: 'ok', safety: 'ok' };
const mod = (o = {}) => ({ verdict: { semafor: 'zelená', score: 0, confidence: 'střední', unchecked: [], skipped: [] }, signals: [], moduly: OK3, external: true, mameObrazky: false, dossier: DOSSIER, ...o });
const runSouhrn = (nodes, o = {}) => runCodeNode(codeOf('Souhrn'), { json: PLAUS_V_PORADKU, nodes: { Moduly: mod(), 'LLM – věrohodnost': PLAUS_V_PORADKU, 'Sestavit věrohodnost': { bezDat: false }, ...nodes }, ...o });
const payload = (out) => JSON.parse(out.llmRequest.messages[0].content);
const sellerSig = (severity) => ({ id: 's', module: 'seller', severity, title: 't', evidence: 'e', source: 'x', hard: false, druh: 'riziko', citace: null, vysvetleni: null, otazka: null, vypocet: null, jistota: null, odkazy: [] });

test('glue 07: prodejce působí věrohodně jen s odpovědí externího zdroje (ARES/VIES/ČOI/RDAP)', async () => {
  const flag = async (m) => (await runSouhrn({ Moduly: mod(m) })).out;
  const s = await flag({ external: true });
  assert.equal(payload(s).prodejce_duveryhodny, true);
  assert.equal(s.prodejceDuveryhodny, true);
  const bez = await flag({ external: false });
  assert.equal(payload(bez).prodejce_duveryhodny, false);
  assert.equal(bez.prodejceDuveryhodny, false);
  // externí zdroj nestačí, když je modul prodejce nezkontrolovaný nebo má střední nález
  assert.equal(payload(await flag({ external: true, moduly: { ...OK3, seller: 'unchecked' } })).prodejce_duveryhodny, false);
  assert.equal(payload(await flag({ external: true, signals: [sellerSig('medium')] })).prodejce_duveryhodny, false);
  assert.equal(payload(await flag({ external: true, signals: [sellerSig('low')] })).prodejce_duveryhodny, true);
});

test('glue 07 (D3): selhání věrohodnosti nebo obrázků nepustí zelenou, výsledek je šedá', async () => {
  const chyba = { error: { message: '401' } };
  const vyp = await runSouhrn({ 'LLM – věrohodnost': chyba });
  assert.deepEqual(vyp.out.verdict.skipped, ['ověření věrohodnosti']);
  assert.equal(vyp.out.verdict.semafor, 'šedá');
  assert.equal(payload(vyp.out).semafor, 'šedá');
  assert.deepEqual(payload(vyp.out).nezkontrolovano, ['ověření věrohodnosti']);

  const obr = await runSouhrn({ 'Obrázky – příprava': { obrazky: DOSSIER.obrazky } }, { $input: { first: () => ({ json: chyba }), all: () => [{ json: chyba }, { json: chyba }, { json: chyba }] } });
  assert.deepEqual(obr.out.verdict.skipped, ['analýza obrázků']);
  assert.equal(obr.out.verdict.semafor, 'šedá');
});

test('glue 07 (D3): výpadek Icecatu z modulů (identita) nepustí zelenou', async () => {
  const { out } = await runSouhrn({ Moduly: mod({ verdict: { semafor: 'zelená', score: 0, confidence: 'střední', unchecked: [], skipped: ['Icecat'] } }) });
  assert.equal(out.verdict.semafor, 'šedá');
  assert.deepEqual(payload(out).nezkontrolovano, ['identita produktu: Icecat']);
});

test('glue 07 (D3): věrohodnost bez dat k posouzení (bezDat) zelenou nebrání; funkční věrohodnost bez nálezů dá zelenou', async () => {
  const bezDat = await runSouhrn({ 'LLM – věrohodnost': { error: { message: 'x' } }, 'Sestavit věrohodnost': { bezDat: true } });
  assert.deepEqual(bezDat.out.verdict.skipped, []);
  assert.equal(bezDat.out.verdict.semafor, 'zelená');
  const ok = await runSouhrn({});
  assert.equal(ok.out.verdict.semafor, 'zelená');
});

// --- marketplace: zelená jen s externím ověřením prodejce ---
test('glue 03: marketplace + prodejce ok z textových údajů bez externího zdroje: šedá; e-shop beze změny', async () => {
  const x = anthropicReply({ produkt: { nazev: 'Powerbanka', kategorie: 'jiné', cena: 500, mena: 'CZK' }, prodejce: { nazev: 'Shop', hodnoceni: 4.8, pocet_prodeju: 1200 }, recenze: {}, obrazky: {}, gpsr: { vyrobce_uveden: 'ano', adresa_vyrobce: 'ano', odpovedna_osoba_eu: 'ano' }, nerealne_parametry: [], nesoulady: [] });
  const ctx = (rezim, host) => ({ zkratka: false, input: { text: 'Powerbanka za 500 Kč, prodejce Shop 4,8 hvězdy, 1200 prodejů', screenshoty: [], url: null }, pageText: '', rezim, host, obsah: true });
  const mp = await runModuly(x, ctx('marketplace', null));
  assert.equal(mp.out.moduly.seller, 'ok');
  assert.equal(mp.out.external, false);
  assert.equal(mp.out.verdict.semafor, 'šedá');
  assert.equal(mp.out.verdict.sellerUnverified, 'bez_udaju');
  assert.equal(mp.out.marketplace, true);
  const nezn = await runModuly(x, ctx('neznámé', null));
  assert.equal(nezn.out.verdict.semafor, 'zelená');
  assert.equal(nezn.out.marketplace, false);
});

test('glue 07: marketplace bez externího zdroje: zelená -> šedá, s externím zdrojem zelená, oranžová zůstává', async () => {
  const semafor = async (m, nodes = {}) => (await runSouhrn({ Moduly: mod(m), ...nodes })).out;
  const bez = await semafor({ marketplace: true, external: false });
  assert.equal(bez.verdict.semafor, 'šedá');
  assert.equal(bez.verdict.sellerUnverified, 'bez_udaju');
  assert.deepEqual(payload(bez).nezkontrolovano, ['prodejce: nelze ověřit v rejstřících (v nabídce není IČO ani DIČ)']);
  assert.equal((await semafor({ marketplace: true, external: true })).verdict.semafor, 'zelená');
  assert.equal((await semafor({ marketplace: false, external: false })).verdict.semafor, 'zelená');
  const medium = { id: 'm', module: 'offer', severity: 'medium', title: 't', evidence: 'e', source: 'x', hard: false, druh: 'riziko', citace: null, vysvetleni: null, otazka: null, vypocet: null, jistota: null, odkazy: [] };
  const low = (id) => ({ ...medium, id, severity: 'low' });
  const orange = await semafor({ marketplace: true, external: false, signals: [medium, low('a'), low('b')] });
  assert.equal(orange.verdict.semafor, 'oranžová');
});

// --- druhé kolo, nález 1: nález z registru (i low) věrohodnost prodejce nepotvrzuje ---
test('glue 07: low nález ze zdroje ARES, VIES, RDAP nebo ČOI zakazuje větu o věrohodném prodejci; low z textu nabídky ne', async () => {
  const flag = async (signals) => (await runSouhrn({ Moduly: mod({ external: true, signals }) })).out.prodejceDuveryhodny;
  const reg = (source, extra = {}) => ({ ...sellerSig('low'), source, ...extra });
  for (const source of ['ARES', 'VIES', 'RDAP', 'ČOI']) assert.equal(await flag([reg(source)]), false, source);
  assert.equal(await flag([reg('analýza nabídky')]), true);
  assert.equal(await flag([reg('ARES', { severity: 'info' })]), true, 'info se nepočítá');
});

test('glue 03: marketplace s IČO, které ARES nenajde, nebo s neplatným DIČ: external false, šedá, žádná věrohodnost prodejce', async () => {
  const x = (prodejce) => anthropicReply({ produkt: { nazev: 'Powerbanka', kategorie: 'jiné', cena: 500, mena: 'CZK' }, prodejce, recenze: {}, obrazky: {}, gpsr: { vyrobce_uveden: 'ano', adresa_vyrobce: 'ano', odpovedna_osoba_eu: 'ano' }, nerealne_parametry: [], nesoulady: [] });
  const ctx = { zkratka: false, input: { text: 'Powerbanka za 500 Kč', screenshoty: [], url: null }, pageText: '', rezim: 'marketplace', host: 'temu.com', obsah: true };
  const stub = (o) => (o.url.startsWith('https://ares.gov.cz/') ? { statusCode: 404, body: '' } : { statusCode: 200, body: { isValid: false, userError: 'INVALID' } });
  const ares = await runModuly(x({ nazev: 'Shop', hodnoceni: 4.8, pocet_prodeju: 1200, ico: '27082440' }), ctx, { httpStub: stub });
  assert.equal(ares.out.signals.some((s) => s.id === 'ico_neexistuje'), true);
  assert.equal(ares.out.external, false);
  assert.equal(ares.out.verdict.semafor, 'šedá');
  assert.equal(ares.out.verdict.sellerUnverified, 'nepotvrzeno', 'registr se zkoušel a prodejce nepotvrdil');
  assert.equal(ares.out.sellerIds, true);
});

// --- druhé kolo, nález 6: uplny jen bez mezer ve specifikaci a popisu a s hledáním CE i v popisu ---
test('glue 03: čtečkový dossier s mezerou ve specifikaci nebo popisu: ce_chybi jen info; bez takových mezer low; CE v popisu ho ruší', async () => {
  const raw = fixtureJson('dossier-cyklosvitilna.json');
  const sevOf = async (mod) => {
    const d = JSON.parse(JSON.stringify(raw));
    mod(d);
    const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: null }, pageText: '', rezim: 'marketplace', host: 'aliexpress.com', obsah: true, dossier: d };
    const { out } = await runModuly({}, ctx);
    return (out.signals.find((s) => s.id === 'ce_chybi') || {}).severity;
  };
  const jenObchod = (d) => { d.gaps = [{ what: 'doba existence obchodu', why: 'na stránce obchodu není uvedena' }]; };
  assert.equal(await sevOf(() => {}), 'info', 'fixture hlásí nerozbalené řádky specifikace');
  assert.equal(await sevOf(jenObchod), 'low');
  assert.equal(await sevOf((d) => { jenObchod(d); d.gaps.push({ what: 'popis prodejce', why: 'prázdný' }); }), 'info');
  assert.equal(await sevOf((d) => { jenObchod(d); d.description = { ...d.description, aiOverview: { bullets: ['Lamp is CE certified.'] } }; }), undefined, 'CE v AI přehledu ce_chybi ruší');
});

// --- marketplace bez odkazu: text nebo screenshot s tržištěm ---
const extrakce = (produkt = {}, prodejce = {}) => anthropicReply({ produkt: { nazev: 'Powerbanka', kategorie: 'jiné', cena: 500, mena: 'CZK', ...produkt }, prodejce: { nazev: 'Shop', hodnoceni: 4.7, pocet_prodeju: 1200, ...prodejce }, recenze: {}, obrazky: {}, gpsr: { vyrobce_uveden: 'ano', adresa_vyrobce: 'ano', odpovedna_osoba_eu: 'ano' }, nerealne_parametry: [], nesoulady: [] });
const vstup = (text, screenshoty = []) => ({ zkratka: false, input: { text, screenshoty, url: null }, pageText: '', rezim: 'neznámé', host: null, obsah: true });
const ALLEGRO_TEXT = fs.readFileSync(path.join(__dirname, '..', 'eval', 'fixtures', 'allegro-oneblade.txt'), 'utf8');

test('glue 03: Allegro text bez odkazu a bez externího ověření: nejvýš šedá; text kabelu a text bez znaků tržiště zůstávají zelené', async () => {
  const allegro = await runModuly(extrakce(), vstup(ALLEGRO_TEXT));
  assert.equal(allegro.out.marketplace, true);
  assert.equal(allegro.out.external, false);
  assert.equal(allegro.out.verdict.semafor, 'šedá');
  assert.equal(allegro.out.verdict.sellerUnverified, 'bez_udaju');
  const kabel = await runModuly(extrakce(), vstup('USB-C kabel 1 m, 60 W. Cena 149 Kč. Prodejce: Kabely CZ s.r.o. Produkt nese označení CE.'));
  assert.equal(kabel.out.marketplace, false);
  assert.equal(kabel.out.verdict.semafor, 'zelená');
});

test('glue 03: screenshot bez odkazu, extrakce pozná AliExpress (produkt.platforma): šedá; bez platformy beze změny', async () => {
  const shot = [{ mime: 'image/png', data: 'AAAA' }];
  const ali = await runModuly(extrakce({ platforma: 'AliExpress' }), vstup('', shot));
  assert.equal(ali.out.marketplace, true);
  assert.equal(ali.out.verdict.semafor, 'šedá');
  const bez = await runModuly(extrakce({ platforma: '' }), vstup('', shot));
  assert.equal(bez.out.marketplace, false);
  assert.equal(bez.out.verdict.semafor, 'zelená');
});

test('glue 03: e-shop s odkazem se nemění ani při zmínce tržiště v textu; oranžová na tržišti zůstává oranžová', async () => {
  const eshop = { ...vstup('Doprava jako na Allegro'), rezim: 'eshop', host: 'example.cz', input: { text: 'Doprava jako na Allegro', screenshoty: [], url: { rezim: 'eshop', host: 'example.cz' } } };
  const e = await runModuly(extrakce(), eshop);
  assert.equal(e.out.marketplace, false);
  const orange = await runModuly(extrakce({ cena: 150, referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } }, { hodnoceni: 3.0 }), vstup(ALLEGRO_TEXT));
  assert.equal(orange.out.marketplace, true);
  assert.notEqual(orange.out.verdict.semafor, 'šedá');
  assert.notEqual(orange.out.verdict.semafor, 'zelená');
});

// --- D2 pro prodejce: absence údajů u neúplného vstupu jen info ---
test('glue 03: text s kontakt_uveden:false a zemí CN: info, skóre bez těchto bodů, modul prodejce není ok jen z absence; plné čtení e-shopu beze změny', async () => {
  const x = extrakce({ nazev: 'Nabíječka' }, { nazev: 'Shop', hodnoceni: null, pocet_prodeju: null, kontakt_uveden: false, provozovatel_uveden: null, podminky_uvedeny: false, zeme_odeslani: 'CN' });
  const text = await runModuly(x, vstup('Nabíječka za 500 Kč, odesláno z Číny'));
  const sev = (out, id) => (out.signals.find((s) => s.id === id) || {}).severity;
  assert.equal(sev(text.out, 'mimo_eu_bez_kontaktu'), 'info');
  assert.equal(sev(text.out, 'podminky_chybi'), 'info');
  assert.equal(text.out.verdict.score, 0);
  assert.equal(text.out.moduly.seller, 'unchecked', 'absence sama modul prodejce nezkontroluje');
  assert.equal(text.out.verdict.semafor, 'šedá');
  // e-shop s plně načtenou stránkou (pageText) zachovává původní závažnosti
  const eshop = { zkratka: false, input: { text: '', screenshoty: [], url: { rezim: 'eshop', host: 'example.cz' } }, pageText: 'Text stránky e-shopu. '.repeat(30), rezim: 'eshop', host: 'example.cz', obsah: true };
  const plny = await runModuly(x, eshop);
  assert.equal(sev(plny.out, 'mimo_eu_bez_kontaktu'), 'medium');
  assert.equal(sev(plny.out, 'podminky_chybi'), 'low');
  // e-shop s odkazem, ale bez načtené stránky (jen vložený text) je neúplný vstup
  const bezStranky = await runModuly(x, { ...eshop, pageText: '', input: { text: 'ručně vložený text', screenshoty: [], url: { rezim: 'eshop', host: 'example.cz' } } });
  assert.equal(sev(bezStranky.out, 'mimo_eu_bez_kontaktu'), 'info');
});

test('glue 03: čtečkový dossier marketplace počítá prodejce jako úplné čtení (absence z dossieru by měla původní závažnost)', async () => {
  const d = fixtureJson('dossier-cyklosvitilna.json');
  d.gaps = [];
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: null }, pageText: '', rezim: 'marketplace', host: 'aliexpress.com', obsah: true, dossier: d };
  const { out } = await runModuly({}, ctx);
  assert.ok(!out.signals.some((s) => s.module === 'seller' && ['kontakt_chybi', 'provozovatel_chybi', 'mimo_eu_bez_kontaktu'].includes(s.id)), 'dossier tyto údaje nenese, nic se nevymýšlí');
});

test('glue 03: nenačtená stránka e-shopu se zapíše mezi přeskočené zdroje; přečtená ne', async () => {
  const ctx = (nenactena) => ({ zkratka: false, input: { text: '', screenshoty: [], url: { ok: true, url: 'https://www.example.cz/p/x', host: 'example.cz', rezim: 'eshop' } }, pageText: '', rezim: 'eshop', host: 'example.cz', obsah: false, strankaNenactena: nenactena });
  const a = await runModuly({}, ctx(true));
  assert.ok(a.out.verdict.skipped.includes('čtení stránky'));
  assert.equal(a.out.verdict.semafor, 'šedá');
  const b = await runModuly({}, ctx(false));
  assert.ok(!b.out.verdict.skipped.includes('čtení stránky'));
});

test('glue 03: číslo z AliExpressu se hlásí jen u e-shopu s odkazem, ne na tržišti ani z textu bez odkazu', async () => {
  const text = 'Dětský batoh Kód 1005007138908110 814 Kč';
  const ctx = (rezim, host, extra = {}) => ({ zkratka: false, input: { text: '', screenshoty: [], url: host ? { ok: true, url: 'https://' + host + '/x', host, rezim } : null }, pageText: '', rezim, host, obsah: true, ...extra });
  const ids = (r) => r.out.signals.map((s) => s.id);
  assert.ok(ids(await runModuly({}, ctx('eshop', 'bartis.cz', { pageText: text }))).includes('kod_z_aliexpressu'));
  const vlozeny = ctx('eshop', 'bartis.cz');
  vlozeny.input.text = text;
  assert.ok(ids(await runModuly({}, vlozeny)).includes('kod_z_aliexpressu'));
  assert.ok(!ids(await runModuly({}, ctx('marketplace', 'aliexpress.com', { pageText: text }))).includes('kod_z_aliexpressu'));
  assert.ok(!ids(await runModuly({}, ctx('neznámé', null, { pageText: text }))).includes('kod_z_aliexpressu'));
});
