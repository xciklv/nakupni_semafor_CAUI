const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const pageHtml = () => fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');

// Fake DOM: jen to, co stránka používá. Eviduje zápisy innerHTML/outerHTML a atributy všech elementů.
function makeDom() {
  const all = [];
  const byId = {};
  class FakeEl {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.textContent = ''; this.className = '';
      this.attrs = {}; this.htmlWrites = 0; this.listeners = {}; this.hidden = false; this.checked = false; this.disabled = false;
      this.href = ''; this.id = ''; this.type = ''; this.value = ''; this.focusCount = 0;
      const self = this;
      this.classList = {
        add(c) { if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim(); },
        remove(c) { self.className = self.className.split(' ').filter((x) => x && x !== c).join(' '); },
        contains(c) { return self.className.split(' ').includes(c); },
      };
      all.push(this);
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(name, v) { this.attrs[name] = String(v); }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }
    focus() { this.focusCount++; }
    scrollIntoView() {}
    click() { if (this.listeners.click) this.listeners.click({ preventDefault() {} }); }
    set innerHTML(v) { this.htmlWrites++; }
    set outerHTML(v) { this.htmlWrites++; }
  }
  const document = {
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => byId[id] || (byId[id] = new FakeEl('div')),
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
  };
  return { document, all, byId };
}

function texts(node, acc = []) {
  if (node.textContent) acc.push(node.textContent);
  node.children.forEach((c) => texts(c, acc));
  return acc;
}
function walk(node, fn) { fn(node); node.children.forEach((c) => walk(c, fn)); }
function find(node, pred) { let r = null; walk(node, (n) => { if (!r && pred(n)) r = n; }); return r; }
function findAll(node, pred) { const r = []; walk(node, (n) => { if (pred(n)) r.push(n); }); return r; }

// opts.hash: location.hash při načtení stránky
function loadPage(opts = {}) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(pageHtml());
  assert.ok(m, 'chybí <script>');
  const dom = makeDom();
  const ctx = vm.createContext({
    document: dom.document, navigator: undefined, console,
    location: { href: 'http://x/webhook/nakupni-kontrola-web' + (opts.hash || ''), hash: opts.hash || '' },
    URL, Image: class {}, fetch: async () => ({ json: async () => ({}) }),
  });
  vm.runInContext(m[1] + '\n;this.__PP = typeof PRVNI_POMOC !== "undefined" ? PRVNI_POMOC : null; this.__open = typeof otevritPrvniPomoc === "function" ? otevritPrvniPomoc : null; this.__render = render;', ctx);
  return { PP: ctx.__PP, otevrit: ctx.__open, render: ctx.__render, dom, ctx };
}

const PRIPADY = ['eshop-nedoruceno', 'bazar-zmizel-prodejce', 'falesny-kupujici', 'vylakane-udaje'];
// Hostitelé oficiálních zdrojů z obsahových podkladů (docs/superpowers/specs/prvni-pomoc/obsah-*.md).
const POVOLENE_HOSTY = new Set([
  'evropskyspotrebitel.cz', 'coi.gov.cz', 'policie.gov.cz', 'archiv.policie.gov.cz', 'cnb.cz', 'www.cnb.cz', 'csirt.cz', 'www.stoponline.cz',
  'finarbitr.gov.cz', 'portal.gov.cz', 'www.zakonyprolidi.cz', 'www.kb.cz', 'www.airbank.cz', 'www.csas.cz', 'www.moneta.cz', 'platbakartou.csob.cz',
  'www.paypal.com', 'www.vinted.cz', 'www.bazos.cz', 'o-seznam.cz', 'napoveda.seznam.cz', 'www.aukro.cz', 'www.zasilkovna.cz',
]);
const ZAKAZANE = /máte nárok|nárok máte|zaručen[eě] (vrác|získ)|vrátíme|určitě (dostan|získ)|dokážeme vrátit|jistě/i;

function vsechnyTexty(pp) { return JSON.stringify(pp); }

test('první pomoc: data obsahují přesně čtyři případy z podkladů', () => {
  const { PP } = loadPage();
  assert.ok(PP, 'chybí PRVNI_POMOC');
  assert.deepEqual([...PP.pripady.map((p) => p.id)], PRIPADY);
});

test('první pomoc: každý případ má kroky ve skupinách Hned / V nejbližších dnech / Později, podklady s „proč“ a seznam neověřeného', () => {
  const { PP } = loadPage();
  for (const p of PP.pripady) {
    assert.ok(p.nazev && p.popis, p.id + ': název a popis');
    assert.deepEqual([...new Set(p.kroky.map((k) => k.kdy))].sort(), ['dny', 'hned', 'pozdeji'], p.id + ': skupiny kroků');
    assert.ok(p.podklady.length >= 5 && p.podklady.length <= 8, p.id + ': počet podkladů ' + p.podklady.length);
    for (const d of p.podklady) assert.ok(d.nazev && d.proc && d.jak, p.id + ': podklad ' + d.nazev + ' musí mít proč a jak');
    assert.ok(p.neoverene.length >= 3, p.id + ': seznam neověřeného');
    assert.ok(p.otazky.length >= 1, p.id + ': otázka navíc');
  }
});

test('první pomoc: každý krok má zdroj, nebo je výslovně označen jako obecná rada; zdroje existují', () => {
  const { PP } = loadPage();
  for (const p of PP.pripady) {
    for (const k of p.kroky.concat(p.otazky.map((o) => o.krok), p.nalehave ? [p.nalehave] : [])) {
      assert.ok(k.text, p.id + ': krok bez textu');
      if (k.obecna) { assert.equal(k.zdroje && k.zdroje.length ? 'ma' : 'nema', 'nema', p.id + ': obecná rada nemá mít zdroj: ' + k.text); continue; }
      assert.ok(Array.isArray(k.zdroje) && k.zdroje.length >= 1, p.id + ': krok bez zdroje: ' + k.text);
      for (const z of k.zdroje) assert.ok(PP.zdroje[z], p.id + ': neznámý zdroj ' + z);
    }
  }
});

test('první pomoc: odkazy zdrojů jsou uloženy bez schématu, vedou jen na oficiální hostitele a po složení jsou https', () => {
  const { PP, ctx } = loadPage();
  const html = pageHtml();
  assert.equal(/https?:\/\//.test(html), false, 'stránka nesmí obsahovat žádnou literální adresu http(s)://');
  const bezpecny = vm.runInContext('bezpecnyOdkaz', ctx);
  const pouzite = new Set(PP.pripady.flatMap((p) => p.kroky.concat(p.otazky.map((o) => o.krok), p.nalehave ? [p.nalehave] : [])).flatMap((k) => k.zdroje || []));
  assert.ok(pouzite.size >= 20, 'katalog zdrojů se používá: ' + pouzite.size);
  for (const [id, z] of Object.entries(PP.zdroje)) {
    assert.ok(pouzite.has(id), id + ': nepoužitý zdroj v katalogu');
    assert.ok(z.nazev, id + ': název zdroje');
    assert.match(z.url, /^\/\/[a-z]/, id + ': URL bez schématu (//host/cesta)');
    const u = new URL(bezpecny('https:' + z.url));
    assert.equal(u.protocol, 'https:');
    assert.ok(POVOLENE_HOSTY.has(u.host), id + ': nepovolený hostitel ' + u.host);
  }
});

test('první pomoc: bez slibů a zakázaných formulací, bez právních výkladů z podkladů označených „neověřeno“', () => {
  const { PP } = loadPage();
  assert.equal(ZAKAZANE.test(vsechnyTexty(PP)), false, 'zakázaná formulace: ' + ZAKAZANE.exec(vsechnyTexty(PP)));
  assert.equal(/§/.test(vsechnyTexty(PP)), false, 'žádné paragrafy');
  assert.equal(/\+?420\s?\d{3}|\b\d{3}\s\d{3}\s\d{3}\b/.test(vsechnyTexty(PP)), false, 'žádná neověřená telefonní čísla bank');
});

test('první pomoc: stav obsahu je uveden (datum ověření zdrojů, bez odborné revize)', () => {
  const { PP } = loadPage();
  assert.equal(PP.overeno, '2026-10-16');
  assert.match(PP.upozorneni, /orientační pomůcka/);
  assert.match(PP.upozorneni, /není právní poradenství/);
  assert.match(PP.upozorneni, /odborn/);
  assert.match(PP.upozorneni, /nelze zaručit/);
});

test('stránka: záložky Zkontrolovat nabídku / První pomoc při podvodu a oba panely', () => {
  const html = pageHtml();
  assert.match(html, /<button id="tab-kontrola"[^>]*role="tab"[^>]*>Zkontrolovat nabídku<\/button>/);
  assert.match(html, /<button id="tab-pomoc"[^>]*role="tab"[^>]*>První pomoc při podvodu<\/button>/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="panel-kontrola"/);
  assert.match(html, /id="panel-pomoc"[^>]*hidden/);
  assert.equal(/<a\b/i.test(html), false, 'žádné statické odkazy');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function/.test(html), false);
});

test('záložky: kliknutí přepíná panely a aria-selected; první pomoc se vykreslí až na požádání', () => {
  const { dom } = loadPage();
  const tk = dom.byId['tab-kontrola'], tp = dom.byId['tab-pomoc'];
  const pk = dom.byId['panel-kontrola'], pp = dom.byId['panel-pomoc'];
  assert.equal(tk.attrs['aria-selected'], undefined);
  tp.click();
  assert.equal(tp.attrs['aria-selected'], 'true');
  assert.equal(tk.attrs['aria-selected'], 'false');
  assert.equal(pp.hidden, false);
  assert.equal(pk.hidden, true);
  assert.ok(texts(pp).some((t) => /Tohle se dá často řešit\./.test(t)));
  tk.click();
  assert.equal(pk.hidden, false);
  assert.equal(pp.hidden, true);
  assert.equal(tk.attrs['aria-selected'], 'true');
});

test('hash #prvni-pomoc otevře záložku a #prvni-pomoc/<případ> rovnou případ', () => {
  const a = loadPage({ hash: '#prvni-pomoc' });
  assert.equal(a.dom.byId['panel-pomoc'].hidden, false);
  const b = loadPage({ hash: '#prvni-pomoc/falesny-kupujici' });
  assert.equal(b.dom.byId['panel-pomoc'].hidden, false);
  assert.ok(texts(b.dom.byId['panel-pomoc']).includes('Falešný kupující nebo „kurýr“'));
  assert.ok(texts(b.dom.byId['panel-pomoc']).some((t) => /Podklady/.test(t)));
  const c = loadPage({ hash: '#prvni-pomoc/neexistuje' });
  assert.equal(c.dom.byId['panel-pomoc'].hidden, false);
  assert.equal(findAll(c.dom.byId['panel-pomoc'], (n) => n.className === 'kroky').length, 0);
});

function nahled(opts) {
  const p = loadPage(opts);
  p.dom.byId['tab-pomoc'].click();
  return p;
}
const out = (p) => p.dom.byId['panel-pomoc'];
const tlacitkoPripadu = (p, nazev) => find(out(p), (n) => n.tagName === 'BUTTON' && n.className === 'pripad' && texts(n)[0] === nazev);

test('výběr případu: ukáže kroky po skupinách, odškrtávací podklady s „proč“, zdroje a upozornění', () => {
  const p = nahled();
  assert.equal(PRIPADY.length, 4);
  for (const pr of p.PP.pripady) assert.ok(tlacitkoPripadu(p, pr.nazev), 'karta případu ' + pr.nazev);
  const pr = p.PP.pripady[0];
  tlacitkoPripadu(p, pr.nazev).click();
  const t = texts(out(p));
  for (const nadpis of ['Hned', 'V nejbližších dnech', 'Později', 'Podklady, které se vám budou hodit', 'Zdroje', 'Co zatím není ověřeno']) assert.ok(t.includes(nadpis), 'chybí nadpis ' + nadpis);
  const boxy = findAll(out(p), (n) => n.tagName === 'INPUT' && n.type === 'checkbox' && n.className === 'podklad');
  assert.equal(boxy.length, pr.podklady.length);
  for (const d of pr.podklady) assert.ok(t.includes(d.proc), 'proč: ' + d.nazev);
  assert.ok(t.some((x) => /orientační pomůcka/.test(x)));
  assert.ok(t.some((x) => /není právní poradenství/.test(x)));
});

test('odškrtávání podkladů: počítadlo se mění a nic se neodesílá ani nepersistuje', () => {
  const p = nahled();
  const pr = p.PP.pripady[0];
  tlacitkoPripadu(p, pr.nazev).click();
  const pocitadlo = find(out(p), (n) => n.attrs.id === 'pocitadlo');
  assert.ok(pocitadlo);
  assert.match(pocitadlo.textContent, new RegExp('^Máte 0 z ' + pr.podklady.length));
  const box = findAll(out(p), (n) => n.tagName === 'INPUT' && n.className === 'podklad')[0];
  box.checked = true; box.listeners.change();
  assert.match(pocitadlo.textContent, new RegExp('^Máte 1 z ' + pr.podklady.length));
  box.checked = false; box.listeners.change();
  assert.match(pocitadlo.textContent, /^Máte 0 z/);
  assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(pageHtml()), false);
});

test('otázka „už jsem prozradil“: zaškrtnutí vyhodí naléhavý krok nahoru, odškrtnutí ho schová; případ 4 ho má vždy', () => {
  for (const id of ['eshop-nedoruceno', 'bazar-zmizel-prodejce', 'falesny-kupujici']) {
    const p = nahled();
    const pr = p.PP.pripady.find((x) => x.id === id);
    tlacitkoPripadu(p, pr.nazev).click();
    assert.equal(find(out(p), (n) => n.attrs.id === 'nalehave').hidden, true, id + ': zpočátku skryto');
    const q = find(out(p), (n) => n.tagName === 'INPUT' && n.className === 'otazka-box');
    assert.ok(q, id + ': checkbox otázky');
    q.checked = true; q.listeners.change();
    const box = find(out(p), (n) => n.attrs.id === 'nalehave');
    assert.equal(box.hidden, false);
    assert.ok(texts(box).some((x) => /do své banky/.test(x)), id + ': volat banku');
    q.checked = false; q.listeners.change();
    assert.equal(find(out(p), (n) => n.attrs.id === 'nalehave').hidden, true);
  }
  const p = nahled();
  const pr = p.PP.pripady.find((x) => x.id === 'vylakane-udaje');
  tlacitkoPripadu(p, pr.nazev).click();
  assert.equal(find(out(p), (n) => n.attrs.id === 'nalehave').hidden, false);
  const q = find(out(p), (n) => n.tagName === 'INPUT' && n.className === 'otazka-box');
  assert.ok(q);
  q.checked = true; q.listeners.change();
  assert.ok(texts(find(out(p), (n) => n.attrs.id === 'nalehave')).some((x) => /vzdálený přístup|vzdáleného přístupu/.test(x)));
});

test('odkazy zdrojů: jen https, rel noopener, target _blank; vše přes DOM, žádné innerHTML', () => {
  const p = nahled();
  for (const pr of p.PP.pripady) {
    p.otevrit(null);
    tlacitkoPripadu(p, pr.nazev).click();
    const odkazy = findAll(out(p), (n) => n.tagName === 'A');
    assert.ok(odkazy.length >= 3, pr.id + ': odkazy');
    for (const a of odkazy) {
      assert.match(a.href, /^https:\/\//);
      assert.equal(a.attrs.rel, 'noopener noreferrer');
      assert.equal(a.attrs.target, '_blank');
    }
  }
  assert.equal(p.dom.all.filter((n) => n.htmlWrites > 0).length, 0);
});

test('výběr jiného případu přepíše zobrazení (kroky se nehromadí) a „Zpět na výběr“ vrátí karty', () => {
  const p = nahled();
  tlacitkoPripadu(p, p.PP.pripady[0].nazev).click();
  assert.equal(findAll(out(p), (n) => n.className === 'kroky').length, 1);
  assert.equal(findAll(out(p), (n) => n.className === 'pripad').length, 0, 'výběr případu se v detailu nezobrazuje');
  const zpet = find(out(p), (n) => n.tagName === 'BUTTON' && /Zpět na výběr/.test(n.textContent));
  assert.ok(zpet);
  zpet.click();
  assert.equal(findAll(out(p), (n) => n.className === 'kroky').length, 0);
  tlacitkoPripadu(p, p.PP.pripady[1].nazev).click();
  assert.equal(findAll(out(p), (n) => n.className === 'kroky').length, 1);
  assert.ok(texts(out(p)).includes(p.PP.pripady[1].nazev));
  assert.ok(!texts(out(p)).includes(p.PP.pripady[0].nazev));
});

test('propojení: výsledek kontroly nabízí „Už jste zaplatili? Co dělat“ a odkaz otevře první pomoc', () => {
  const p = loadPage();
  p.render({ stav: 'ok', semafor: 'červená', shrnuti: 'S', jistota: 'vysoká', co_delat: ['Nekupujte'], upozorneni: 'U', nezkontrolovano: [],
    nalezy: [{ id: 'x', modul: 'prodejce', druh: 'riziko', zavaznost: 'high', titul: 'Prodejce je na seznamu', dukaz: 'D', odkazy: [] }] });
  const tlacitka = findAll(p.dom.byId.out, (n) => n.tagName === 'BUTTON' && n.textContent === 'Už jste zaplatili? Co dělat');
  assert.ok(tlacitka.length >= 1, 'chybí propojení');
  tlacitka[0].click();
  assert.equal(p.dom.byId['panel-pomoc'].hidden, false);
  assert.equal(p.dom.byId['panel-kontrola'].hidden, true);
});

test('propojení: první pomoc nabízí cestu zpět „Zkontrolovat nabídku, než zaplatíte“', () => {
  const p = nahled();
  const zpet = find(out(p), (n) => n.tagName === 'BUTTON' && /Zkontrolovat nabídku, než zaplatíte/.test(n.textContent));
  assert.ok(zpet);
  zpet.click();
  assert.equal(p.dom.byId['panel-kontrola'].hidden, false);
});

test('CSS: záložky a první pomoc používají tokeny motivu, mají focus a nejsou jen barvou; třídy v DOM jsou z povoleného seznamu', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(pageHtml())[1];
  assert.match(css, /\.zalozka\b/);
  assert.match(css, /\.zalozka\[aria-selected="true"\]/);
  assert.match(css, /\.nalehave\b/);
  const p = nahled();
  tlacitkoPripadu(p, p.PP.pripady[2].nazev).click();
  const POVOLENE = new Set(['', 'card', 'hint', 'sekundarni', 'pripad', 'kroky', 'skupina-kroku', 'krok', 'proc', 'zdroje-kroku', 'podklad', 'podklad-radek', 'jak', 'nalehave', 'otazka-box',
    'upozorneni', 'poznamka', 'odkazy', 'stitek', 'obecna', 'seznam-bez', 'zdroje', 'sbalene', 'volba', 'volba-label', 'karty', 'err', 'lead', 'hned', 'dny', 'pozdeji', 'podklady', 'podklad-detail', 'nav-pomoc', 'nadpis', 'popis', 'pole-popis', 'popis-text']);
  for (const n of p.dom.all) for (const c of n.className.split(' ')) assert.ok(POVOLENE.has(c), 'nepovolená třída: ' + c);
});

test('úvod: tři sdělení (klid, nic neplatit ani když volá banka nebo policie, nic nemazat), bez věty o prohlížeči a bez právního upozornění', () => {
  const p = nahled();
  const uvod = out(p).children[0];
  const body = findAll(uvod, (n) => n.tagName === 'LI').map((n) => n.textContent);
  assert.equal(body.length, 3);
  assert.match(body[0], /klid/i);
  assert.match(body[1], /Nic neplať/);
  assert.match(body[1], /banka/);
  assert.match(body[1], /policie/);
  assert.match(body[2], /Nemaž/);
  for (const w of ['zprávy', 'e-maily', 'výpisy hovorů', 'screenshoty']) assert.ok(body[2].includes(w), 'nemazat: ' + w);
  const vse = texts(uvod).join(' ');
  assert.equal(/prohlížeči|orientační|právní poradenství/.test(vse), false, 'úvod je bez prohlížeče a bez právního upozornění');
});

test('upozornění o orientační pomůcce je dole: pod výběrem případu i pod detailem', () => {
  const p = nahled();
  const posledni = (n) => n.children[n.children.length - 1];
  assert.ok(texts(posledni(out(p))).some((x) => /orientační pomůcka/.test(x)), 'pod výběrem');
  tlacitkoPripadu(p, p.PP.pripady[0].nazev).click();
  assert.ok(texts(posledni(out(p))).some((x) => /orientační pomůcka/.test(x)), 'pod detailem');
  assert.equal(findAll(out(p), (n) => n.className === 'upozorneni').length, 0, 'žádný oranžový box nahoře');
});

test('popis situace: otevřené pole ve výběru případu; text se po výběru ukáže v detailu s tlačítkem Kopírovat, nic se neodesílá', () => {
  const p = nahled();
  const pole = find(out(p), (n) => n.tagName === 'TEXTAREA' && n.className === 'pole-popis');
  assert.ok(pole, 'chybí pole');
  assert.ok(find(out(p), (n) => n.tagName === 'LABEL' && /Popiš, co se stalo/.test(n.textContent)), 'popisek');
  const payload = '<img src=x onerror=alert(1)> Včera jsem poslal 1 200 Kč.';
  pole.value = payload; pole.listeners.input();
  tlacitkoPripadu(p, p.PP.pripady[1].nazev).click();
  const t = texts(out(p));
  assert.ok(t.includes('Tvůj popis'));
  assert.ok(t.includes(payload), 'popis je vložen jako prostý text');
  assert.ok(findAll(out(p), (n) => n.tagName === 'BUTTON' && n.textContent === 'Kopírovat').length >= 1);
  assert.equal(p.dom.all.filter((n) => n.htmlWrites > 0).length, 0);
  find(out(p), (n) => n.tagName === 'BUTTON' && /Zpět na výběr/.test(n.textContent)).click();
  assert.equal(find(out(p), (n) => n.tagName === 'TEXTAREA').value, payload);
});

test('popis situace: bez popisu se karta „Tvůj popis“ nezobrazí; kód první pomoci nic nevolá', () => {
  const p = nahled();
  tlacitkoPripadu(p, p.PP.pripady[0].nazev).click();
  assert.equal(texts(out(p)).includes('Tvůj popis'), false);
  const src = /const PRVNI_POMOC[\s\S]*$/.exec(pageHtml())[0];
  assert.equal(/fetch\(|XMLHttpRequest|sendBeacon/.test(src), false, 'první pomoc nevolá server');
});
