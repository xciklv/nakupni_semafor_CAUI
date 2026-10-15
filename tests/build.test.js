const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildBundle, buildWorkflow } = require('../build/build-workflow');

const root = path.join(__dirname, '..');
const GLUE_FILES = ['01-vstup.js', '02-extrakce-req.js', '03-moduly.js', '04-odpoved.js'];
const glueSrc = (f) => fs.readFileSync(path.join(root, 'build', 'glue', f), 'utf8');

test('bundle obsahuje všechny funkce enginu a běží ve vm bez require', () => {
  const bundle = buildBundle();
  const ctx = vm.createContext({ URL, console });
  vm.runInContext(bundle + '\nthis.__t = [normalizeUrl, computeVerdict, offerSignals, sellerSignals, safetySignals, buildResponse, buildExtractRequest].every(f => typeof f === "function");', ctx);
  assert.equal(ctx.__t, true);
});

test('bundle neobsahuje require ani module.exports (kolize s const v jednom scope)', () => {
  const bundle = buildBundle();
  assert.equal(/\brequire\(/.test(bundle), false);
  assert.equal(/module\.exports/.test(bundle), false);
});

// Názvy deklarované na column 0 (const/let/var/function/class vč. destructuringu); guard řádky require/module se přeskakují.
function topLevelNames(src) {
  const names = [];
  for (const line of src.split('\n')) {
    if (/^if \(typeof (require|module) !== 'undefined'/.test(line)) continue;
    let m = /^(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { names.push(m[1]); continue; }
    m = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) { names.push(m[1]); continue; }
    m = /^(?:const|let|var)\s*([{[])([^}\]]*)[}\]]\s*=/.exec(line);
    if (m) {
      for (let part of m[2].split(',')) {
        part = part.replace(/=.*$/, '').trim().replace(/^\.\.\./, '');
        if (m[1] === '{' && part.includes(':')) part = part.split(':')[1].trim();
        const id = /^([A-Za-z_$][\w$]*)/.exec(part);
        if (id) names.push(id[1]);
      }
    }
  }
  return names;
}
function findDuplicateDecls(files) {
  const seen = new Map();
  const dup = [];
  for (const [f, src] of Object.entries(files)) {
    for (const n of topLevelNames(src)) {
      if (seen.has(n)) dup.push(n + ' (' + seen.get(n) + ', ' + f + ')');
      else seen.set(n, f);
    }
  }
  return dup;
}

test('engine/*.js nemají duplicitní top-level deklarace (bundle je jeden scope)', () => {
  const files = {};
  for (const f of fs.readdirSync(path.join(root, 'engine')).filter((n) => n.endsWith('.js'))) files[f] = fs.readFileSync(path.join(root, 'engine', f), 'utf8');
  assert.ok(Object.keys(files).length >= 8);
  const dup = findDuplicateDecls(files);
  assert.deepEqual(dup, [], 'duplicitní top-level názvy: ' + dup.join(', '));
});

test('skener duplicit zachytí function, const, let, var i destructuring', () => {
  const base = "const A = 1;\nfunction foo() {}\n";
  assert.deepEqual(findDuplicateDecls({ a: base, b: 'const B = 2;' }), []);
  assert.equal(findDuplicateDecls({ a: base, b: 'function foo() {}' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'let A = 2;' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'var A;' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'const { x, A } = require("y");' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'const { q: foo } = obj;' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'const [p, A] = arr;' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: 'let { x = 1, ...A } = obj;' }).length, 1);
  assert.equal(findDuplicateDecls({ a: base, b: "if (typeof require !== 'undefined') { var { A } = require('x'); }" }).length, 0);
  assert.equal(findDuplicateDecls({ a: base, b: '  const A = 1; // odsazené = lokální' }).length, 0);
});

test('každý glue soubor je s bundlem validní async tělo (top-level return/await)', () => {
  const bundle = buildBundle();
  for (const f of GLUE_FILES) {
    assert.doesNotThrow(() => new vm.Script('(async function(){' + bundle + '\n' + glueSrc(f) + '\n})', { filename: f }), 'glue ' + f);
  }
});

test('workflow má všechny nody a propojení', () => {
  const wf = buildWorkflow({ credId: 'CRED1', credName: 'Anthropic account' });
  const names = wf.nodes.map((n) => n.name);
  for (const n of ['Webhook', 'Vstup a načtení', 'Stačí vstup?', 'Sestavit extrakci', 'Claude – extrakce', 'Moduly', 'Claude – vysvětlení', 'Odpověď', 'Respond', 'Respond – více vstupu']) {
    assert.ok(names.includes(n), 'chybí node ' + n);
  }
  assert.equal(wf.nodes.find((n) => n.name === 'Webhook').parameters.path, 'nakupni-kontrola');
  assert.ok(wf.connections['Webhook']);
  assert.equal(wf.nodes.find((n) => n.name === 'Claude – extrakce').credentials.anthropicApi.id, 'CRED1');
});

test('workflow: každé spojení míří na existující node a IF má dva výstupy', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'N' });
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [from, v] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), 'zdroj ' + from);
    for (const out of v.main) for (const c of out) assert.ok(names.has(c.node), 'cíl ' + c.node);
  }
  assert.equal(wf.connections['Stačí vstup?'].main.length, 2);
  // pořadí výstupů IF: 0 = true (stačí vstup) -> extrakce, 1 = false -> odpověď bez LLM
  assert.equal(wf.connections['Stačí vstup?'].main[0][0].node, 'Sestavit extrakci');
  assert.equal(wf.connections['Stačí vstup?'].main[1][0].node, 'Respond – více vstupu');
});

test('workflow: settings nic neukládá (soukromí) a zachovává executionOrder v1', () => {
  const s = buildWorkflow({ credId: 'C', credName: 'N' }).settings;
  assert.equal(s.executionOrder, 'v1');
  assert.equal(s.saveDataSuccessExecution, 'none');
  assert.equal(s.saveDataErrorExecution, 'none');
  assert.equal(s.saveManualExecutions, false);
  assert.equal(s.saveExecutionProgress, false);
});

test('workflow: webhookId je UUID', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'N' });
  const withId = wf.nodes.filter((x) => 'webhookId' in x);
  assert.ok(withId.length >= 1);
  for (const n of withId) {
    assert.match(n.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, n.name);
  }
});

// --- behavior glue ve vm sandboxu (this s helpers, n8n globály jako stuby) ---
const STUB_BUNDLE = buildBundle();
// nodes: { 'Název nodu': json | function (může vyhodit) }
async function runGlue(file, { json = {}, nodes = {}, state = {}, httpStub, src, globals = {} } = {}) {
  const calls = [];
  const ctx = vm.createContext({
    URL, console, setTimeout, clearTimeout, AbortSignal,
    $input: { first: () => ({ json }) },
    $: (name) => ({
      first: () => {
        const n = nodes[name];
        if (typeof n === 'function') return { json: n() };
        if (n === undefined) throw new Error('node ' + name + ' neexistuje');
        return { json: n };
      },
    }),
    $getWorkflowStaticData: () => state,
    ...globals,
  });
  const fn = vm.runInContext('(async function(){' + STUB_BUNDLE + '\n' + (src || glueSrc(file)) + '\n})', ctx);
  const self = { helpers: { httpRequest: async (opts) => { calls.push(opts); return httpStub ? httpStub(opts) : { statusCode: 200, body: '' }; } } };
  const out = await fn.call(self);
  return { out: JSON.parse(JSON.stringify(out))[0].json, calls, state };
}
const runGlue01 = (body, o = {}) => runGlue('01-vstup.js', { ...o, json: { body } });

test('glue 01: prázdné tělo -> zkratka, 400', async () => {
  const { out, calls } = await runGlue01({});
  assert.equal(out.zkratka, true);
  assert.equal(out.status, 400);
  assert.equal(out.odpoved.stav, 'chyba');
  assert.equal(calls.length, 0);
});

test('glue 01: SSRF odkaz -> 400 a nic se nestahuje', async () => {
  const { out, calls } = await runGlue01({ odkaz: 'http://127.0.0.1:5678/x' });
  assert.equal(out.zkratka, true);
  assert.equal(out.status, 400);
  assert.equal(calls.length, 0);
});

test('glue 01: pouze text -> pokračuje, text zachován, nic se nestahuje', async () => {
  const { out, calls } = await runGlue01({ text: 'Powerbanka 199 Kč' });
  assert.equal(out.zkratka, false);
  assert.equal(out.input.text, 'Powerbanka 199 Kč');
  assert.equal(calls.length, 0);
});

test('glue 01: přesměrování 302 se nenásleduje -> potrebuji_vice, nic dalšího se nestahuje', async () => {
  const { out, calls } = await runGlue01({ odkaz: 'https://example.cz/p' }, {
    httpStub: () => ({ statusCode: 302, headers: { location: 'http://127.0.0.1/' }, body: '' }),
  });
  assert.equal(out.zkratka, true);
  assert.equal(out.status, 200);
  assert.equal(out.odpoved.stav, 'potrebuji_vice');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].disableFollowRedirect, true);
  assert.equal(calls[0].ignoreHttpStatusErrors, true);
  assert.equal(calls[0].returnFullResponse, true);
});

test('glue 01: stránka 200 -> pokračuje s neprázdným pageText', async () => {
  const { out } = await runGlue01({ odkaz: 'https://example.cz/p' }, {
    httpStub: () => ({ statusCode: 200, body: '<html>' + 'text '.repeat(200) + '</html>' }),
  });
  assert.equal(out.zkratka, false);
  assert.ok(out.pageText.length > 0);
});

test('glue 01: 404/500 stránka se nepoužije (potrebuji_vice)', async () => {
  for (const statusCode of [404, 500]) {
    const { out } = await runGlue01({ odkaz: 'https://example.cz/p' }, {
      httpStub: () => ({ statusCode, body: '<html>' + 'text '.repeat(200) + '</html>' }),
    });
    assert.equal(out.zkratka, true, 'status ' + statusCode);
    assert.equal(out.odpoved.stav, 'potrebuji_vice');
  }
});

test('glue 01: vyčerpaná denní kvóta -> 429', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { out, calls } = await runGlue01({ text: 'Powerbanka 199 Kč' }, { state: { day: today, count: 200 } });
  assert.equal(out.zkratka, true);
  assert.equal(out.status, 429);
  assert.equal(calls.length, 0);
});

test('glue 01: limit kvóty je jedna pojmenovaná konstanta na začátku', () => {
  assert.match(glueSrc('01-vstup.js'), /^\s*const MAX_DENNE = 200;/m);
});

test('glue 01: abortSignal se předá a nikdy se nevracející request skončí do deadline (potrebuji_vice)', async () => {
  const src = glueSrc('01-vstup.js');
  assert.match(src, /const FETCH_DEADLINE_MS = \d+;/);
  const fast = src.replace(/const FETCH_DEADLINE_MS = \d+;/, 'const FETCH_DEADLINE_MS = 50;');
  assert.notEqual(fast, src);
  const t0 = Date.now();
  const { out, calls } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://example.cz/p' } }, src: fast,
    httpStub: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - t0 < 1000, 'deadline nezabral');
  assert.equal(out.zkratka, true);
  assert.equal(out.odpoved.stav, 'potrebuji_vice');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].abortSignal, 'chybí abortSignal');
  assert.equal(typeof calls[0].abortSignal.aborted, 'boolean');
});

test('glue 01: bez AbortSignal v sandboxu se request přesto provede (deadline běží přes Promise.race)', async () => {
  const { out, calls } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://example.cz/p' } },
    globals: { AbortSignal: undefined },
    httpStub: () => ({ statusCode: 200, body: '<html>' + 'text '.repeat(200) + '</html>' }),
  });
  assert.equal(out.zkratka, false);
  assert.equal(calls[0].abortSignal, undefined);
});

test('glue 01: kvóta je zdokumentovaná v komentáři na začátku', () => {
  const head = glueSrc('01-vstup.js').split('\n').slice(0, 8).join('\n');
  assert.match(head, /kvót/i);
  assert.match(head, /potrebuji_vice/);
  assert.match(head, /přibližn/i);
});

// --- glue 02 ---
test('glue 02: sestaví požadavek na extrakci', async () => {
  const { out } = await runGlue('02-extrakce-req.js', { json: { input: { text: 'Powerbanka 199 Kč', screenshoty: [], url: null }, pageText: '' } });
  assert.equal(typeof out.llmRequest.model, 'string');
  assert.ok(Array.isArray(out.llmRequest.messages));
});

// --- glue 03 ---
const CTX_NEZNAME = { zkratka: false, input: { text: 'Powerbanka 199 Kč', screenshoty: [], url: null }, pageText: '', rezim: 'neznámé', host: null };
const EXTRACT_OK = { content: [{ type: 'text', text: '{"produkt":{"nazev":"Powerbanka","kategorie":"elektronika","cena":199,"mena":"CZK","referencni_cena_odhad":{"min":800,"max":1200,"mena":"CZK"}},"prodejce":{},"recenze":{},"obrazky":{},"nerealne_parametry":[],"nesoulady":[]}' }] };

test('glue 03: chyba Claude (error) -> šedá, vše nezkontrolováno, požadavek na vysvětlení', async () => {
  const { out, calls } = await runGlue('03-moduly.js', { json: { error: { message: '401' } }, nodes: { 'Vstup a načtení': CTX_NEZNAME } });
  assert.equal(out.verdict.semafor, 'šedá');
  assert.deepEqual(out.verdict.unchecked, ['offer', 'seller', 'safety']);
  assert.deepEqual(out.signals, []);
  assert.ok(out.llmRequest && Array.isArray(out.llmRequest.messages));
  assert.equal(calls.length, 0);
});

test('glue 03: validní extrakce, režim neznámé -> signály a verdikt není zelená, nic se nestahuje', async () => {
  const { out, calls } = await runGlue('03-moduly.js', { json: EXTRACT_OK, nodes: { 'Vstup a načtení': CTX_NEZNAME } });
  const ids = out.signals.map((s) => s.id);
  assert.ok(ids.includes('cena_extremne_nizka'), ids.join());
  assert.ok(ids.includes('ce_chybi'), ids.join());
  assert.notEqual(out.verdict.semafor, 'zelená');
  assert.equal(calls.length, 0);
});

function coiHtml(n) {
  let h = '<div>';
  for (let i = 0; i < n; i++) h += '<article><p class="list_titles"><br><span>riziko' + i + '.cz</span></p><p>Důvod ' + i + '.</p></article>';
  h += '<article><p class="list_titles"><br><span>clarkscz.cz</span></p><p>Provozovatel není uveden.</p></article></div>';
  return h;
}

test('glue 03: eshop na seznamu ČOI -> červená; seznam se cachuje do static data a podruhé se nestahuje', async () => {
  const state = {};
  const stub = (o) => {
    if (o.url.startsWith('https://coi.gov.cz/')) return coiHtml(150);
    if (o.url.startsWith('https://rdap.')) return { events: [{ eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' }] };
    if (o.url.startsWith('https://ares.gov.cz/')) return { statusCode: 404, body: {} };
    throw new Error('neočekávaný požadavek ' + o.url);
  };
  const extract = { content: [{ type: 'text', text: '{"produkt":{"nazev":"Mikina","kategorie":"oblečení","cena":500,"mena":"CZK"},"prodejce":{"ico":"27082440"},"recenze":{},"obrazky":{},"nerealne_parametry":[],"nesoulady":[]}' }] };
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: 'x', rezim: 'eshop', host: 'clarkscz.cz' };
  const coiCalls = (calls) => calls.filter((c) => c.url.startsWith('https://coi.gov.cz/')).length;
  const r1 = await runGlue('03-moduly.js', { json: extract, nodes: { 'Vstup a načtení': ctx }, state, httpStub: stub });
  assert.equal(r1.out.verdict.semafor, 'červená');
  assert.ok(r1.out.signals.some((s) => s.id === 'coi_seznam'));
  assert.ok(r1.out.signals.some((s) => s.id === 'ico_neexistuje'), 'ARES 404 -> ico_neexistuje');
  assert.equal(coiCalls(r1.calls), 1);
  assert.ok(state.coi && state.coi.list, 'cache v static data');
  const r2 = await runGlue('03-moduly.js', { json: extract, nodes: { 'Vstup a načtení': ctx }, state, httpStub: stub });
  assert.equal(coiCalls(r2.calls), 0, 'druhý běh používá cache');
  assert.equal(r2.out.verdict.semafor, 'červená');
});

test('glue 03: výjimka uvnitř -> degraduje na šedou, nic neuniká', async () => {
  const { out } = await runGlue('03-moduly.js', { json: EXTRACT_OK, nodes: { 'Vstup a načtení': () => { throw new Error('tajná chyba /interní/cesta'); } } });
  assert.equal(out.verdict.semafor, 'šedá');
  assert.deepEqual(out.verdict.unchecked, ['offer', 'seller', 'safety']);
  assert.deepEqual(out.signals, []);
  assert.ok(out.llmRequest && Array.isArray(out.llmRequest.messages));
  assert.equal(JSON.stringify(out).includes('tajná'), false);
});

// --- glue 04 ---
const MOD_OK = { verdict: { semafor: 'oranžová', score: 4, confidence: 'střední', unchecked: ['seller'] }, signals: [{ id: 'cena_nizka', module: 'offer', severity: 'low', title: 'Cena je nízká', evidence: 'x', source: 'odhad modelu' }] };

test('glue 04: chyba vysvětlení -> status 200, stav ok a záložní text', async () => {
  const { out } = await runGlue('04-odpoved.js', { json: { error: { message: 'x' } }, nodes: { Moduly: MOD_OK } });
  assert.equal(out.status, 200);
  assert.equal(out.odpoved.stav, 'ok');
  assert.equal(out.odpoved.semafor, 'oranžová');
  assert.equal(out.odpoved.shrnuti, 'Kontrola našla signály, které stojí za zvážení.');
});

test('glue 04: validní vysvětlení se použije', async () => {
  const text = JSON.stringify({ shrnuti: 'Nabídka má několik signálů, které stojí za pozornost.', co_delat: ['Porovnejte cenu u jiných prodejců.'] });
  const { out } = await runGlue('04-odpoved.js', { json: { content: [{ type: 'text', text }] }, nodes: { Moduly: MOD_OK } });
  assert.equal(out.status, 200);
  assert.equal(out.odpoved.shrnuti, 'Nabídka má několik signálů, které stojí za pozornost.');
  assert.deepEqual(out.odpoved.co_delat, ['Porovnejte cenu u jiných prodejců.']);
});

test('glue 04: výjimka -> 500 s obecnou hláškou bez úniku detailů', async () => {
  const { out } = await runGlue('04-odpoved.js', { json: {}, nodes: { Moduly: () => { throw new Error('tajná chyba /interní/cesta'); } } });
  assert.deepEqual(out, { status: 500, odpoved: { stav: 'chyba', chyba: 'Kontrola se nepodařila. Zkuste to prosím znovu.' } });
});

// --- Task 9: webová stránka servírovaná z n8n ---
const PAGE_PATH = path.join(root, 'web', 'index.html');
const pageHtml = () => fs.readFileSync(PAGE_PATH, 'utf8');
const CHYBA_OBECNA = 'Kontrola se nepodařila. Zkuste to prosím znovu.';

test('workflow servíruje webovou stránku na GET webhooku', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'A' });
  const get = wf.nodes.find((n) => n.name === 'Webhook – stránka');
  assert.equal(get.parameters.httpMethod, 'GET');
  assert.equal(get.parameters.path, 'nakupni-kontrola-web');
  const resp = wf.nodes.find((n) => n.name === 'Respond – stránka');
  assert.match(resp.parameters.responseBody, /<!doctype html>/i);
  assert.ok(wf.connections['Webhook – stránka']);
});

test('workflow: GET webhook stránky má vlastní UUID a odpověď je text/html propojená na Respond', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'A' });
  const get = wf.nodes.find((n) => n.name === 'Webhook – stránka');
  const post = wf.nodes.find((n) => n.name === 'Webhook');
  assert.match(get.webhookId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(get.webhookId, post.webhookId);
  const resp = wf.nodes.find((n) => n.name === 'Respond – stránka');
  assert.equal(resp.parameters.respondWith, 'text');
  assert.deepEqual(resp.parameters.options.responseHeaders.entries, [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }]);
  assert.deepEqual(wf.connections['Webhook – stránka'], { main: [[{ node: 'Respond – stránka', type: 'main', index: 0 }]] });
});

test('responseBody stránky není n8n výraz: nezačíná "=" a neobsahuje "{{"', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'A' });
  const body = wf.nodes.find((n) => n.name === 'Respond – stránka').parameters.responseBody;
  assert.equal(body, pageHtml());
  assert.equal(body.startsWith('='), false);
  assert.equal(body.includes('{{'), false);
});

test('stránka nepoužívá innerHTML a volá relativní API', () => {
  const html = pageHtml();
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b|new Function|setAttribute\(\s*['"]on/.test(html), false);
  assert.match(html, /nakupni-kontrola/);
});

test('stránka nemá žádnou externí adresu (http/https) ani zdroje mimo volání API', () => {
  assert.equal(/https?:\/\//.test(pageHtml()), false);
  assert.equal(/<(script|link|img|iframe)\b[^>]*\b(src|href)=/i.test(pageHtml()), false);
});

// Fake DOM: jen to, co stránka používá. Eviduje zápisy innerHTML/outerHTML a atributy všech elementů.
function makeFakeDom() {
  const all = [];
  const byId = {};
  class FakeEl {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.textContent = ''; this.className = '';
      this.attrs = {}; this.htmlWrites = 0; this.files = []; this.value = ''; this.disabled = false;
      all.push(this);
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener() {}
    setAttribute(name, v) { this.attrs[name] = String(v); }
    set innerHTML(v) { this.htmlWrites++; }
    set outerHTML(v) { this.htmlWrites++; }
  }
  const document = {
    createElement: (tag) => new FakeEl(tag),
    getElementById: (id) => byId[id] || (byId[id] = new FakeEl('div')),
  };
  return { document, all, byId };
}
function texts(node, acc = []) {
  if (node.textContent) acc.push(node.textContent);
  node.children.forEach((c) => texts(c, acc));
  return acc;
}
function loadPage() {
  const m = /<script>([\s\S]*?)<\/script>/.exec(pageHtml());
  assert.ok(m, 'chybí <script>');
  const dom = makeFakeDom();
  const ctx = vm.createContext({
    document: dom.document, location: { href: 'http://x/webhook/nakupni-kontrola-web' }, URL, console,
    fetch: async () => ({ json: async () => ({}) }),
  });
  vm.runInContext(m[1] + '\n;this.__render = render;', ctx);
  return { render: ctx.__render, dom };
}

test('render: ok odpověď s HTML v dukazu se vykreslí jako prostý text, bez innerHTML', () => {
  const { render, dom } = loadPage();
  const payload = '<img src=x onerror=alert(1)>';
  render({ stav: 'ok', semafor: 'červená', skore: 9, jistota: 'vysoká', shrnuti: 'Shrnutí', co_delat: ['Nekupujte'],
    signaly: [{ id: 'x', modul: 'Nabídka', zavaznost: 'high', titul: 'Titul', dukaz: payload, zdroj: 'z' }],
    nezkontrolovano: [], upozorneni: 'U' });
  assert.equal(dom.all.filter((n) => n.textContent === payload).length, 1);
  assert.equal(dom.all.filter((n) => n.htmlWrites > 0).length, 0);
  assert.equal(dom.all.filter((n) => Object.keys(n.attrs).some((k) => /^on/i.test(k))).length, 0);
  assert.ok(texts(dom.document.getElementById('out')).includes('Riziko: červená'));
});

test('render: chyba zobrazí text chyby', () => {
  const { render, dom } = loadPage();
  render({ stav: 'chyba', chyba: 'Nějaká chyba' });
  assert.ok(texts(dom.document.getElementById('out')).includes('Nějaká chyba'));
});

test('render: potrebuji_vice zobrazí zprávu', () => {
  const { render, dom } = loadPage();
  render({ stav: 'potrebuji_vice', zprava: 'Vložte text nabídky.' });
  assert.ok(texts(dom.document.getElementById('out')).includes('Vložte text nabídky.'));
});

test('render: neočekávaný tvar odpovědi nevyhodí výjimku a ukáže obecnou chybu', () => {
  for (const r of [null, undefined, 'text', 42, [], {}, { stav: 'neznamy' }, { stav: 'chyba' }, { stav: 'chyba', chyba: { x: 1 } }]) {
    const { render, dom } = loadPage();
    assert.doesNotThrow(() => render(r), 'render ' + JSON.stringify(r));
    assert.ok(texts(dom.document.getElementById('out')).includes(CHYBA_OBECNA), 'obecná chyba pro ' + JSON.stringify(r));
  }
});

test('render: stav ok s chybějícími nebo špatnými poli nevyhodí výjimku', () => {
  const shapes = [
    { stav: 'ok' },
    { stav: 'ok', signaly: 'x', co_delat: null, nezkontrolovano: 5, semafor: {}, shrnuti: 7 },
    { stav: 'ok', semafor: 'zelená', signaly: [null, 5, 'x', { titul: 1, dukaz: { a: 1 } }], co_delat: [null, 'Krok', 3], nezkontrolovano: ['a', {}] },
  ];
  for (const r of shapes) {
    const { render, dom } = loadPage();
    assert.doesNotThrow(() => render(r), JSON.stringify(r));
    assert.equal(dom.all.filter((n) => n.htmlWrites > 0).length, 0);
  }
  const { render, dom } = loadPage();
  render(shapes[2]);
  const t = texts(dom.document.getElementById('out'));
  assert.ok(t.includes('Krok'));
  assert.ok(!t.some((s) => s.includes('[object Object]')));
});
