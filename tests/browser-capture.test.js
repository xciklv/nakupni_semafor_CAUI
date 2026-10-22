const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cap = require('../tools/browser-capture/extract.js');
const { validateInput } = require('../engine/input');
const { extractionToDossier, dossierToExtraction, dossierPromptText } = require('../engine/dossier');
const { normalizeExtraction } = require('../engine/llm');
const { sellerSignals } = require('../engine/seller');

const DIR = path.join(__dirname, '..', 'tools', 'browser-capture');
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v)); // objekty z vm kontextu mají cizí prototypy

// --- cleanUrl ---

test('cleanUrl: odstraní sledovací parametry a ponechá cestu', () => {
  assert.equal(cap.cleanUrl('https://www.aliexpress.com/item/1.html?spm=a&gclid=x&algo_pvid=y'), 'https://www.aliexpress.com/item/1.html');
});

test('cleanUrl: offerId zůstává, reklamní parametry ne', () => {
  assert.equal(cap.cleanUrl('https://allegro.cz/produkt/x?offerId=18724176560&gclid=1'), 'https://allegro.cz/produkt/x?offerId=18724176560');
});

test('cleanUrl: každý ze jmenovaných parametrů i utm_* a _gl a share_token', () => {
  const names = ['gclid', 'wbraid', 'gbraid', 'pvid', 'scm', 'spm', 'algo_pvid', 'algo_exp_id', 'pdp_ext_f', 'pdp_npi', 'curPageLogUid', 'utm_source', 'utm_campaign', 'utm_whatever', '_gl', 'share_token'];
  for (const n of names) {
    assert.equal(cap.cleanUrl('https://shop.cz/p?' + n + '=1&offerId=7&id=3'), 'https://shop.cz/p?offerId=7&id=3', n);
  }
  assert.equal(cap.cleanUrl('https://shop.cz/p?' + names.map((n) => n + '=1').join('&')), 'https://shop.cz/p');
});

test('cleanUrl: ostatní parametry zůstávají beze změny kódování, fragment a přihlašovací údaje se zahodí', () => {
  assert.equal(cap.cleanUrl('https://shop.cz/p?q=a%20b+c&gclid=1#recenze'), 'https://shop.cz/p?q=a%20b+c');
  assert.equal(cap.cleanUrl('https://uzivatel:heslo@shop.cz/p'), 'https://shop.cz/p');
});

test('cleanUrl: neplatný vstup nespadne', () => {
  assert.equal(cap.cleanUrl('není adresa'), 'není adresa');
  assert.equal(cap.cleanUrl(''), '');
  assert.equal(cap.cleanUrl(undefined), '');
});

// --- trimToSentences ---

test('trimToSentences: 20 000 znaků se zkrátí na celou větu', () => {
  const text = Array.from({ length: 1500 }, (_, i) => 'Věta číslo ' + i + ' o výrobku.').join(' ');
  assert.ok(text.length > 20000);
  const r = cap.trimToSentences(text, 20000);
  assert.ok(r.length <= 20000);
  assert.ok(r.length > 15000, 'nezahodí zbytečně moc');
  assert.match(r, /Věta číslo \d+ o výrobku\.$/);
  assert.ok(text.startsWith(r));
});

test('trimToSentences: krátký text zůstane, bez interpunkce se řeže na celé slovo', () => {
  assert.equal(cap.trimToSentences('Krátký text.', 100), 'Krátký text.');
  const r = cap.trimToSentences('slovo '.repeat(100), 50);
  assert.ok(r.length <= 50);
  assert.match(r, /slovo$/);
});

test('trimToSentences: věta končící přesně na hranici zůstane celá', () => {
  assert.equal(cap.trimToSentences('Jedna věta. Druhá věta. Třetí věta.', 23), 'Jedna věta. Druhá věta.');
});

test('trimToSentences: řádky bez teček se řežou na řádku', () => {
  const r = cap.trimToSentences('Řádek jedna\nŘádek dvě\nŘádek tři', 25);
  assert.equal(r, 'Řádek jedna\nŘádek dvě');
});

// --- dropPageChrome ---

test('dropPageChrome: odřízne hlavičku s jménem, účtem a košíkem před titulkem nabídky', () => {
  const text = 'Martina\nMůj účet\nKošík\nKategorie\nElektronika\nPowerbanka 50000 mAh\nCena 199 Kč\nPopis nabídky.';
  const r = cap.dropPageChrome(text, 'Powerbanka 50000 mAh');
  assert.equal(r, 'Powerbanka 50000 mAh\nCena 199 Kč\nPopis nabídky.');
  assert.ok(!r.includes('Martina'));
});

test('dropPageChrome: titulek karty s příponou webu najde nadpis nabídky', () => {
  const text = 'Přihlásit se\nKošík\nPowerbanka 50000 mAh\nCena 199 Kč';
  const r = cap.dropPageChrome(text, 'Powerbanka 50000 mAh - Allegro.cz');
  assert.equal(r, 'Powerbanka 50000 mAh\nCena 199 Kč');
});

test('dropPageChrome: bez nalezeného titulku odstraní řádky menu a účtu včetně jména nad nimi', () => {
  const text = 'Martina / Můj účet / Košík\nAhoj, Martino\nJana\nMoje konto\nMenu\nCena 199 Kč\nRozměry 10 x 20 cm\nKošík je plný nabídek.';
  const r = cap.dropPageChrome(text, 'Titulek, který na stránce není');
  assert.ok(!r.includes('Martina') && !r.includes('Martino') && !r.includes('Jana'), r);
  assert.ok(!/Můj účet|Moje konto/.test(r), r);
  assert.ok(r.includes('Cena 199 Kč') && r.includes('Rozměry 10 x 20 cm'), r);
  assert.ok(r.includes('Košík je plný nabídek.'), 'věta o obsahu zůstane');
});

test('dropPageChrome: prázdný titulek a prázdný text nespadnou', () => {
  assert.equal(cap.dropPageChrome('', 'x'), '');
  assert.equal(cap.dropPageChrome('Cena 199 Kč', ''), 'Cena 199 Kč');
  assert.equal(cap.dropPageChrome(undefined, undefined), '');
});

test('dropPageChrome: obsah za titulkem zůstane celý, i když obsahuje slovo košík nebo účet', () => {
  const text = 'Hlavička\nPowerbanka\nPřidat do košíku\nCena 199 Kč\nBankovní účet prodejce: viz podmínky.';
  const r = cap.dropPageChrome(text, 'Powerbanka');
  assert.equal(r, 'Powerbanka\nPřidat do košíku\nCena 199 Kč\nBankovní účet prodejce: viz podmínky.');
});

// --- extract.js ve (falešné) stránce ---

function runExtract({ href, title, bodyText, ld = [], meta = [], imgs = [] }) {
  const doc = {
    title,
    body: { innerText: bodyText },
    querySelectorAll(sel) {
      if (sel === 'script[type="application/ld+json"]') return ld.map((t) => ({ textContent: t }));
      if (sel === 'script:not([src])') return [];
      if (sel.startsWith('meta[')) return meta.map((u) => ({ content: u }));
      if (sel === 'img') return imgs;
      return [];
    },
  };
  const ctx = vm.createContext({ document: doc, location: { href }, URL });
  vm.runInContext(read('extract.js'), ctx);
  return plain(vm.runInContext('nakupniKontrolaExtract()', ctx));
}

const PAGE = 'Martina\nMůj účet\nKošík\nPowerbanka 50000 mAh\nCena 199 Kč\n' + Array.from({ length: 60 }, (_, i) => 'Parametr ' + i + ' má hodnotu ' + i + '.').join('\n');

test('extract: odkaz je očištěný, text bez jména účtu, JSON-LD a obrázky jsou zvlášť, ne v textu', () => {
  const r = runExtract({
    href: 'https://allegro.cz/produkt/x?offerId=18724176560&gclid=1&utm_source=a#r', title: 'Powerbanka 50000 mAh - Allegro.cz', bodyText: PAGE,
    ld: ['{ "@type": "Product",\n "name": "Powerbanka", "review": [ { "reviewBody": "Dobrá" } ] }'],
    meta: ['https://a.cz/1.jpg'],
  });
  assert.equal(r.odkaz, 'https://allegro.cz/produkt/x?offerId=18724176560');
  assert.ok(r.text.includes('Powerbanka 50000 mAh') && r.text.includes('Cena 199 Kč'));
  assert.ok(!r.text.includes('Martina'), 'jméno účtu neodchází');
  assert.ok(!r.text.includes('Můj účet'));
  assert.ok(!r.text.includes('gclid') && !r.text.includes('utm_source'));
  assert.equal(r.jsonld, '{"@type":"Product","name":"Powerbanka","review":[{"reviewBody":"Dobrá"}]}');
  assert.ok(!r.text.includes('reviewBody'), 'JSON-LD jde v samostatném poli');
  assert.deepEqual(r.obrazky, ['https://a.cz/1.jpg']);
});

test('extract: limity (text 20 000, JSON-LD 4 000, obrázky 8 × 500 znaků jen https)', () => {
  const dlouhe = Array.from({ length: 3000 }, (_, i) => 'Věta číslo ' + i + ' o výrobku.').join(' ');
  const meta = ['http://x.cz/a.jpg', 'https://x.cz/' + 'a'.repeat(600) + '.jpg', 'javascript:1'];
  for (let i = 0; i < 12; i++) meta.push('https://x.cz/img' + i + '.jpg?spm=1&share_token=abc');
  const r = runExtract({ href: 'https://shop.cz/p', title: 'T', bodyText: dlouhe, ld: ['{"x":"' + 'b'.repeat(6000) + '"}'], meta });
  assert.ok(r.text.length <= 20000);
  assert.match(r.text, /Věta číslo \d+ o výrobku\.$/);
  assert.ok(r.jsonld.length <= 4000 && r.jsonld.length > 3000);
  assert.equal(r.obrazky.length, 8);
  for (const u of r.obrazky) {
    assert.ok(u.startsWith('https://') && u.length <= 500, u);
    assert.ok(!/share_token|spm=/.test(u), u);
  }
});

test('extract: nic nepřidává do stránky ani neklikne (jen čtení DOM)', () => {
  const src = read('extract.js');
  assert.ok(!/\.click\(|dispatchEvent|\.submit\(|innerHTML|outerHTML|insertAdjacentHTML|eval\(|document\.cookie|localStorage|sessionStorage/.test(src));
});

test('extract.js lze do stránky vložit opakovaně (žádné const/let/class na nejvyšší úrovni)', () => {
  assert.equal(/^(const|let|class)\s/m.test(read('extract.js')), false);
});

// --- manifest a soubory ---

test('manifest: MV3, žádný trvalý přístup ke stránkám, odesílání jen na lokální n8n', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1:5678/*']);
  assert.equal(m.content_scripts, undefined);
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(m.background.service_worker, 'background.js');
});

test('soubory rozšíření nepoužívají innerHTML ani vzdálený kód', () => {
  for (const f of ['extract.js', 'background.js', 'overlay.js']) {
    const src = read(f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), f);
    assert.ok(!/<script|https?:\/\/(?!127\.0\.0\.1:5678)/.test(src.replace(/\/\/.*$/gm, '')), f + ' odkazuje na cizí adresu');
  }
});

// --- service worker (background.js) s falešným chrome ---

const NABIDKA = {
  odkaz: 'https://allegro.cz/produkt/x?offerId=1', titulek: 'Powerbanka', text: 'Zdroj: sběr\nOdkaz: https://allegro.cz/produkt/x?offerId=1\n\n[Text stránky]\nPowerbanka 50000 mAh. Cena 199 Kč.',
  obrazky: ['https://a.cz/1.jpg'], jsonld: '{"@type":"Product"}', vlozena: [], diagnostika: { sirkaTextuPuvodni: 100, jsonLd: 1, vlozenaData: [], obrazkuNalezeno: 1 },
};
const PRODEJCE = { ...NABIDKA, odkaz: 'https://allegro.cz/uzivatel/prodejce', titulek: 'Prodejce', text: 'Prodejce 98 % doporučuje.', obrazky: ['https://a.cz/2.jpg'], jsonld: '{"@type":"Store"}' };

function loadBackground({ fetchImpl, pages }) {
  const store = {};
  const handlers = {};
  const states = [];
  const intervals = [];
  const cleared = [];
  const timeouts = [];
  const fetches = [];
  let page = 0;
  const chrome = {
    action: { onClicked: { addListener: (f) => { handlers.click = f; } } },
    runtime: { onMessage: { addListener: (f) => { handlers.message = f; } }, getPlatformInfo: () => Promise.resolve({}) },
    storage: { session: {
      get: async (k) => (typeof k === 'string' ? (k in store ? { [k]: plain(store[k]) } : {}) : plain(store)),
      set: async (o) => { Object.assign(store, plain(o)); },
      remove: async (k) => { delete store[k]; },
    } },
    scripting: { executeScript: async (o) => {
      if (o.args) { states.push(plain(o.args[0])); return [{ result: undefined }]; }
      if (o.files) return [{ result: undefined }];
      return [{ result: pages[Math.min(page++, pages.length - 1)] }];
    } },
  };
  const ctx = vm.createContext({
    chrome, console,
    fetch: async (url, init) => { fetches.push({ url, init }); return fetchImpl(url, init); },
    AbortSignal: { timeout: (ms) => { timeouts.push(ms); return { ms }; } },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { cleared.push(id); },
    importScripts: (f) => vm.runInContext(read(f), ctx),
  });
  vm.runInContext(read('background.js'), ctx);
  const until = async (cond) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r)); assert.ok(cond(), 'čekání na stav vypršelo'); };
  return { store, handlers, states, intervals, cleared, timeouts, fetches, until };
}

const OK = (body = { stav: 'ok', semafor: 'zelená', shrnuti: 's', jistota: 'střední', signaly: [], co_delat: [] }) => async () => ({ ok: true, status: 200, json: async () => body });

test('background: kliknutí uloží stránku do chrome.storage.session a ukáže celý odesílaný text', async () => {
  const b = loadBackground({ fetchImpl: OK(), pages: [NABIDKA, PRODEJCE] });
  await b.handlers.click({ id: 7 });
  assert.equal(b.store.sbirka.length, 1);
  const n = b.states.find((s) => s.faze === 'nahled');
  assert.ok(n);
  assert.deepEqual(Object.keys(n.payload).sort(), ['jsonld', 'obrazky', 'odkaz', 'text']);
  assert.equal(n.payload.text, NABIDKA.text);
  assert.deepEqual(n.payload.obrazky, ['https://a.cz/1.jpg']);
  assert.equal(n.payload.jsonld, '{"@type":"Product"}');
  assert.equal(b.fetches.length, 0, 'před potvrzením se nic neodesílá');
});

test('background: odeslání pošle jen { odkaz, text, obrazky, jsonld }, shodné s náhledem, a vyprázdní sbírku', async () => {
  const b = loadBackground({ fetchImpl: OK(), pages: [NABIDKA, PRODEJCE] });
  await b.handlers.click({ id: 7 });
  await b.handlers.click({ id: 7 });
  assert.equal(b.store.sbirka.length, 2);
  const nahled = b.states.filter((s) => s.faze === 'nahled').pop();
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'vysledek'));
  assert.equal(b.fetches.length, 1);
  const f = b.fetches[0];
  assert.equal(f.url, 'http://127.0.0.1:5678/webhook/nakupni-kontrola');
  assert.equal(f.init.method, 'POST');
  const body = JSON.parse(f.init.body);
  assert.deepEqual(Object.keys(body).sort(), ['jsonld', 'obrazky', 'odkaz', 'text']);
  assert.deepEqual(body, nahled.payload, 'odešle se přesně to, co uživatel viděl');
  assert.equal(body.odkaz, NABIDKA.odkaz);
  assert.deepEqual(body.obrazky, NABIDKA.obrazky, 'obrázky a JSON-LD jsou z nabídky (první stránky)');
  assert.equal(body.jsonld, NABIDKA.jsonld);
  assert.ok(body.text.includes('Powerbanka 50000 mAh') && body.text.includes('Prodejce 98 % doporučuje.'));
  assert.ok(body.text.length <= 20000);
  assert.deepEqual(b.store.sbirka || [], [], 'sbírka je po odeslání prázdná');
  assert.equal(JSON.stringify(b.store).includes('Powerbanka 50000 mAh'), false, 'odeslaný text nezůstane v úložišti');
});

test('background: oprava ze spiku (udržování workeru při dlouhé kontrole a limit 180 s) zůstává', async () => {
  const b = loadBackground({ fetchImpl: OK(), pages: [NABIDKA] });
  await b.handlers.click({ id: 7 });
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'vysledek'));
  assert.equal(b.intervals.length, 1);
  assert.equal(b.intervals[0].ms, 20000);
  assert.deepEqual(b.timeouts, [180000]);
  assert.deepEqual(b.cleared, [1], 'udržování se po skončení vypne');
  assert.match(read('background.js'), /chrome\.storage\.session/);
});

test('background: dvojí kliknutí na „Zkontrolovat“ odešle jedinou kontrolu', async () => {
  const b = loadBackground({ fetchImpl: OK(), pages: [NABIDKA] });
  await b.handlers.click({ id: 7 });
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'vysledek'));
  assert.equal(b.fetches.length, 1);
});

test('background: stejná stránka se přepíše, „Vymazat sběr“ sbírku vyprázdní', async () => {
  const b = loadBackground({ fetchImpl: OK(), pages: [NABIDKA] });
  await b.handlers.click({ id: 7 });
  await b.handlers.click({ id: 7 });
  assert.equal(b.store.sbirka.length, 1);
  b.handlers.message({ akce: 'vymazat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'prazdno'));
  assert.deepEqual(b.store.sbirka, []);
});

test('background: chyba spojení se ukáže uživateli, udržování se vypne a sbírka zůstane pro další pokus', async () => {
  const b = loadBackground({ fetchImpl: async () => { throw new Error('síť'); }, pages: [NABIDKA] });
  await b.handlers.click({ id: 7 });
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'chyba'));
  assert.deepEqual(b.cleared, [1]);
  assert.equal(b.store.sbirka.length, 1);
});

// Nález 13: sbírka se vyprázdní jen po skutečně provedené kontrole; při chybě serveru zůstane a uživatel dostane srozumitelnou hlášku.
async function odesliSChybou(fetchImpl) {
  const b = loadBackground({ fetchImpl, pages: [NABIDKA] });
  await b.handlers.click({ id: 7 });
  b.handlers.message({ akce: 'odeslat' }, { tab: { id: 7 } });
  await b.until(() => b.states.some((s) => s.faze === 'vysledek' || s.faze === 'chyba'));
  return b;
}

for (const [status, hlaska] of [[429, /limit/i], [413, /velk|dlouh/i], [500, /chyb.*server|server.*chyb/i]]) {
  test('background: HTTP ' + status + ' sbírku nevyprázdní a ukáže srozumitelnou chybu', async () => {
    const b = await odesliSChybou(async () => ({ ok: false, status, json: async () => ({ stav: 'chyba', chyba: 'text ze serveru' }) }));
    assert.equal(b.store.sbirka.length, 1, 'sbírka zůstala pro další pokus');
    const s = b.states.find((x) => x.faze === 'chyba');
    assert.ok(s, 'ukáže se fáze chyba (ne výsledek)');
    assert.match(s.chyba, hlaska);
    assert.ok(!b.states.some((x) => x.faze === 'vysledek'));
  });
}

test('background: HTTP 200 se stavem chyba sbírku nevyprázdní a ukáže chybu z odpovědi', async () => {
  const b = await odesliSChybou(async () => ({ ok: true, status: 200, json: async () => ({ stav: 'chyba', chyba: 'Text je příliš dlouhý.' }) }));
  assert.equal(b.store.sbirka.length, 1);
  assert.match(b.states.find((x) => x.faze === 'chyba').chyba, /Text je příliš dlouhý./);
});

test('background: odpověď, která není JSON (HTTP 500), sbírku nevyprázdní', async () => {
  const b = await odesliSChybou(async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('x'); } }));
  assert.equal(b.store.sbirka.length, 1);
  assert.ok(b.states.some((x) => x.faze === 'chyba'));
});

test('background: úspěšná kontrola (200 ok) sbírku vyprázdní a potrebuji_vice se bere jako provedená kontrola', async () => {
  for (const odpoved of [{ stav: 'ok', semafor: 'zelená' }, { stav: 'potrebuji_vice', zprava: 'víc podkladů' }]) {
    const b = await odesliSChybou(async () => ({ ok: true, status: 200, json: async () => odpoved }));
    assert.deepEqual(b.store.sbirka, []);
    assert.deepEqual(b.states.find((x) => x.faze === 'vysledek').odpoved, odpoved);
  }
});

// --- překryv (overlay.js) s falešným DOM ---

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.style = {}; this.className = ''; }
  append(...c) { this.children.push(...c); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren() { this.children = []; }
  // Jako prohlížeč: shadowRoot je z vnějšku vidět jen u mode 'open'; u 'closed' je null a kořen má jen ten, kdo ho dostal z attachShadow.
  attachShadow({ mode }) { this.mode = mode; this.koren = new El('#shadow'); return this.koren; }
  get shadowRoot() { return this.mode === 'open' ? this.koren : null; }
  remove() { this.removed = true; }
}
// Jeden „svět“ stránky (document + izolovaný kontext skriptu); overlay.js se do něj vkládá znovu před každým vykreslením, jako to dělá background.js.
function overlayWorld() {
  const documentElement = new El('html');
  const document = {
    documentElement,
    createElement: (t) => new El(t),
    getElementById: (id) => documentElement.children.find((c) => c.id === id && !c.removed) || null,
  };
  const ctx = vm.createContext({ document, chrome: { runtime: { sendMessage: () => {} } } });
  const texts = (e, out = []) => { if (e.textContent) out.push(e.textContent); e.children.forEach((c) => texts(c, out)); return out; };
  return {
    document,
    host: () => documentElement.children.find((c) => c.id === 'nakupni-kontrola-host' && !c.removed),
    render(stav) {
      vm.runInContext(read('overlay.js'), ctx);
      vm.runInContext('nakupniKontrolaOverlay', ctx)(stav);
      return texts(this.host().koren);
    },
  };
}
function renderOverlay(stav) { return overlayWorld().render(stav); }

test('overlay: náhled ukáže celý odesílaný text, adresy obrázků i JSON-LD', () => {
  const payload = { odkaz: NABIDKA.odkaz, text: NABIDKA.text, obrazky: ['https://a.cz/1.jpg', 'https://a.cz/2.jpg'], jsonld: '{"@type":"Product","name":"X"}' };
  const texts = renderOverlay({ faze: 'nahled', sbirka: [{ odkaz: NABIDKA.odkaz, titulek: 'Powerbanka', znaku: 90 }], diagnostika: NABIDKA.diagnostika, payload });
  assert.ok(texts.includes(payload.text), 'celý text, ne jen počet znaků');
  assert.ok(texts.includes(payload.jsonld));
  assert.ok(texts.some((t) => t.includes('https://a.cz/1.jpg') && t.includes('https://a.cz/2.jpg')));
  assert.ok(texts.includes('Zkontrolovat'));
});

// --- od rozšíření přes API do dossieru ---

test('tělo rozšíření projde validateInput a extractionToDossier doplní obrázky i JSON-LD', () => {
  const body = { odkaz: NABIDKA.odkaz, text: NABIDKA.text, obrazky: NABIDKA.obrazky, jsonld: NABIDKA.jsonld };
  const v = validateInput(body);
  assert.equal(v.ok, true);
  assert.deepEqual(v.input.obrazky, ['https://a.cz/1.jpg']);
  assert.equal(v.input.jsonld, '{"@type":"Product"}');
  const d = extractionToDossier(normalizeExtraction({ produkt: { nazev: 'Powerbanka', tvrzene_parametry: ['50000 mAh'] } }), v.input);
  assert.deepEqual(d.obrazky, [{ url: 'https://a.cz/1.jpg' }]);
  assert.deepEqual(d.tvrzeni, ['50000 mAh', 'JSON-LD: {"@type":"Product"}']);
  assert.equal(d.platforma, 'allegro');
});

test('extractionToDossier: JSON-LD se do tvrzení vejde nejvýš do 4000 znaků a model ho v promptu uvidí celý', () => {
  const ld = '{"review":[' + '{"reviewBody":"Skvělé"},'.repeat(160) + '{"reviewBody":"Konec"}]}';
  assert.ok(ld.length > 3500 && ld.length < 4000);
  const d = extractionToDossier(normalizeExtraction({}), { jsonld: ld + 'x'.repeat(2000) });
  assert.equal(d.tvrzeni.length, 1);
  assert.ok(d.tvrzeni[0].length <= 4000 + 'JSON-LD: '.length);
  const p = dossierPromptText(d, 12000);
  assert.ok(p.text.includes('Konec'), 'druhá polovina JSON-LD není uříznutá na 400 znaků');
});

test('extractionToDossier: neplatné obrázky se zahodí a bez nich i bez JSON-LD je dossier beze změny', () => {
  const d = extractionToDossier(normalizeExtraction({}), { obrazky: ['http://x', 5, 'https://ok.cz/a.jpg'], jsonld: 5 });
  assert.deepEqual(d.obrazky, [{ url: 'https://ok.cz/a.jpg' }]);
  assert.deepEqual(d.tvrzeni, []);
  assert.deepEqual(extractionToDossier(normalizeExtraction({}), {}).obrazky, []);
});

// --- prodejce z textu ---

const SELLER_TEXT = { prodejce: { nazev: 'EKSTRA-OFERTY', hodnoceni: 4.7, pocet_prodeju: 1200, ico: '27074358' } };

test('dossier z textu: dossierToExtraction předá o prodejci všechno, co dossier opravdu obsahuje', () => {
  const d = extractionToDossier(normalizeExtraction(SELLER_TEXT), { url: { url: 'https://allegro.cz/x', host: 'allegro.cz', rezim: 'marketplace' } });
  assert.equal(d.prodejce.pocetProdeju, 1200);
  const x = dossierToExtraction(d);
  assert.equal(x.prodejce.nazev, 'EKSTRA-OFERTY');
  assert.ok(Math.abs(x.prodejce.hodnoceni - 4.7) < 0.1);
  assert.equal(x.prodejce.pocet_prodeju, 1200);
  assert.equal(x.prodejce.ico, '27074358');
});

test('dossier z textu: nic se nevymýšlí (chybějící údaje zůstanou null)', () => {
  const d = extractionToDossier(normalizeExtraction({ prodejce: { nazev: 'Shop', hodnoceni: 4.5 } }), {});
  const x = dossierToExtraction(d);
  assert.equal(x.prodejce.pocet_prodeju, null);
  assert.equal(x.prodejce.ico, null);
  assert.equal(x.prodejce.stari_obchodu_dny, null);
  assert.equal(x.prodejce.provozovatel_uveden, null);
});

test('dossier z textu: hodnocení a počet prodejů stačí na zkontrolovaný modul prodejce (SELLER_MIN_CHECKS)', async () => {
  const d = extractionToDossier(normalizeExtraction({ prodejce: { nazev: 'EKSTRA-OFERTY', hodnoceni: 4.7, pocet_prodeju: 1200 } }), {});
  const x = dossierToExtraction(d);
  const r = await sellerSignals({ x, rezim: 'marketplace', host: 'allegro.cz', fetchers: {}, coiList: null, nowMs: Date.now() });
  assert.notEqual(r.status, 'unchecked');
});

// --- nález 10: překryv nesmí jít přečíst ze stránky ---

test('overlay: kořen okna je closed, stránka na něj přes host.shadowRoot nedosáhne a další vykreslení ho znovu použije', () => {
  const w = overlayWorld();
  w.render({ faze: 'prazdno' });
  const host = w.host();
  assert.equal(host.mode, 'closed');
  assert.equal(host.shadowRoot, null, 'z pohledu stránky žádný shadowRoot');
  const texts = w.render({ faze: 'nahled', sbirka: [{ odkaz: NABIDKA.odkaz, titulek: 'P', znaku: 90 }], diagnostika: NABIDKA.diagnostika, payload: { odkaz: NABIDKA.odkaz, text: 'Tajný text sběru', obrazky: [], jsonld: '' } });
  assert.ok(texts.includes('Tajný text sběru'));
  assert.equal(w.host(), host, 'okno se nevytváří znovu');
  assert.equal(host.shadowRoot, null);
  assert.equal(host.children.length, 0, 'okno není vidět jako potomek hostitele');
});

test('overlay: když se izolovaný svět ztratí a hostitel zůstane, okno se vytvoří znovu a text starého okna nezůstane', () => {
  const w = overlayWorld();
  w.render({ faze: 'nahled', sbirka: [{ odkaz: NABIDKA.odkaz, titulek: 'P', znaku: 9 }], diagnostika: NABIDKA.diagnostika, payload: { odkaz: NABIDKA.odkaz, text: 'Starý sběr', obrazky: [], jsonld: '' } });
  const stary = w.host();
  const ctx2 = vm.createContext({ document: w.document, chrome: { runtime: { sendMessage: () => {} } } }); // jiný kontext = bez zapamatovaného kořene
  vm.runInContext(read('overlay.js'), ctx2);
  vm.runInContext('nakupniKontrolaOverlay', ctx2)({ faze: 'prazdno' });
  assert.ok(stary.removed, 'osiřelý hostitel se odstraní');
  assert.notEqual(w.host(), stary);
});

test('overlay: komentář ani README netvrdí, že stránka na okno nedosáhne bez výhrady', () => {
  assert.doesNotMatch(read('overlay.js').split('\n').slice(0, 2).join(' '), /stránka na něj nedosáhne/);
  assert.doesNotMatch(read('README.md'), /stránka na něj nedosáhne/);
});

// --- nález 14: výsledek se vykreslí z nalezy (druh, závažnost), ne jako samé varování ---

function stromVysledku(odpoved) {
  const w = overlayWorld();
  w.render({ faze: 'vysledek', odpoved, stran: 1 });
  return w.host().koren;
}
const vsechny = (e, out = []) => { out.push(e); e.children.forEach((c) => vsechny(c, out)); return out; };
const textUzlu = (e) => vsechny(e).map((x) => x.textContent).filter(Boolean).join(' | ');
const naleztKartu = (koren, titul) => vsechny(koren).find((e) => e.className.split(' ').includes('sig') && textUzlu(e).includes(titul));
const MAM = (druh, zavaznost, titul) => ({ id: titul, modul: 'prodejce', druh, zavaznost, titul, dukaz: 'důkaz ' + titul, zdroj: 'ARES' });
const ODPOVED = (nalezy) => ({ stav: 'ok', semafor: 'oranžová', shrnuti: 'S', jistota: 'střední', co_delat: [], signaly: nalezy.map((n) => ({ ...n, druh: undefined })), nalezy });

test('overlay: nelze_overit je ve sbalené skupině s poznámkou, bez štítku závažnosti a bez barvy varování', () => {
  const koren = stromVysledku(ODPOVED([MAM('riziko', 'medium', 'Riziko A'), MAM('nelze_overit', 'medium', 'Neověřeno B'), MAM('riziko', 'info', 'Info C')]));
  const nelze = naleztKartu(koren, 'Neověřeno B');
  assert.ok(nelze, 'nález je vidět');
  const details = vsechny(koren).find((e) => e.tag === 'details' && textUzlu(e).includes('Neověřeno B'));
  assert.ok(details, 'je ve sbaleném <details>');
  assert.match(textUzlu(details), /Nepodařilo se ověřit \(1\)/);
  assert.match(textUzlu(details), /není podezření/);
  assert.ok(!/(^|\s)(medium|high|low)(\s|$)/.test(nelze.className), 'třída: ' + nelze.className);
  assert.ok(!/Střední|Vysoká|Nízká/.test(textUzlu(nelze)), 'bez štítku závažnosti');
  const riziko = naleztKartu(koren, 'Riziko A');
  assert.match(riziko.className, /medium/);
  assert.match(textUzlu(riziko), /Střední/);
  assert.ok(!vsechny(koren).some((e) => e.tag === 'details' && textUzlu(e).includes('Riziko A')), 'riziko není sbalené mezi neověřenými');
});

test('overlay: info vypadá jako informace (štítek Informace, neutrální třída), tvrzení, která nesedí, mají vlastní skupinu', () => {
  const koren = stromVysledku(ODPOVED([MAM('info', 'info', 'Jen info'), MAM('nesmysl', 'high', 'Fyzikální nesmysl'), MAM('rozpor', 'medium', 'Rozpor v nabídce')]));
  const info = naleztKartu(koren, 'Jen info');
  assert.match(info.className, /info/);
  assert.ok(!/medium|high|low/.test(info.className));
  assert.match(textUzlu(info), /Informace/);
  const hlavicky = vsechny(koren).filter((e) => e.tag === 'h4').map((e) => e.textContent);
  assert.ok(hlavicky.includes('Tvrzení, která nesedí'), hlavicky.join());
  assert.ok(hlavicky.includes('Rizika'), hlavicky.join());
  const skupina = vsechny(koren).find((e) => e.className.split(' ').includes('skupina') && textUzlu(e).includes('Fyzikální nesmysl'));
  assert.ok(skupina && textUzlu(skupina).includes('Rozpor v nabídce') && !textUzlu(skupina).includes('Jen info'));
});

test('overlay: stará odpověď bez nalezy se ukáže ze signalu (se závažností), prázdné nalezy při neprázdných signalech také', () => {
  const sig = [{ titul: 'Starý signál', dukaz: 'd', zavaznost: 'low' }];
  for (const odpoved of [{ stav: 'ok', semafor: 'zelená', shrnuti: 'S', jistota: 'střední', co_delat: [], signaly: sig }, { stav: 'ok', semafor: 'zelená', shrnuti: 'S', jistota: 'střední', co_delat: [], signaly: sig, nalezy: [] }]) {
    const koren = stromVysledku(odpoved);
    const karta = naleztKartu(koren, 'Starý signál');
    assert.ok(karta);
    assert.match(textUzlu(karta), /Nízká/);
  }
});

test('overlay: bez nálezů a bez signálů se nevykreslí žádná skupina; text nálezu jde jen přes textContent', () => {
  const koren = stromVysledku({ stav: 'ok', semafor: 'zelená', shrnuti: 'S', jistota: 'střední', co_delat: [], signaly: [], nalezy: [] });
  assert.equal(vsechny(koren).filter((e) => e.tag === 'h4').length, 0);
  assert.ok(!read('overlay.js').includes('innerHTML'));
});
