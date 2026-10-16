const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildBundle, buildWorkflow, resolveQuota } = require('../build/build-workflow');
const { runInRealisticSandbox, runCodeNode } = require('./sandbox');

const root = path.join(__dirname, '..');
const GLUE_FILES = ['01-vstup.js', '02-extrakce-req.js', '03-moduly.js', '04-odpoved.js'];
const glueSrc = (f) => fs.readFileSync(path.join(root, 'build', 'glue', f), 'utf8');

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

test('workflow má všechny nody a propojení', () => {
  const wf = buildWorkflow({ credId: 'CRED1', credName: 'Anthropic account' });
  const names = wf.nodes.map((n) => n.name);
  for (const n of ['Webhook', 'Vstup a načtení', 'Stačí vstup?', 'Je obsah?', 'Sestavit extrakci', 'Claude – extrakce', 'Moduly', 'Claude – vysvětlení', 'Odpověď', 'Respond', 'Respond – více vstupu']) {
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
  // pořadí výstupů IF: 0 = true (stačí vstup) -> Je obsah?, 1 = false -> odpověď bez LLM
  assert.equal(wf.connections['Stačí vstup?'].main[0][0].node, 'Je obsah?');
  assert.equal(wf.connections['Stačí vstup?'].main[1][0].node, 'Respond – více vstupu');
});

test('workflow: Je obsah? true -> Sestavit extrakci, false -> Moduly (bez Claude extrakce)', () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'N' });
  const iff = wf.nodes.find((n) => n.name === 'Je obsah?');
  const ref = wf.nodes.find((n) => n.name === 'Stačí vstup?');
  assert.equal(iff.type, ref.type);
  assert.equal(iff.typeVersion, ref.typeVersion);
  assert.equal(iff.parameters.conditions.conditions[0].leftValue, '={{ $json.obsah }}');
  assert.equal(iff.parameters.conditions.conditions[0].operator.operation, 'true');
  assert.equal(wf.connections['Je obsah?'].main.length, 2);
  assert.deepEqual(wf.connections['Je obsah?'].main[0], [{ node: 'Sestavit extrakci', type: 'main', index: 0 }]);
  assert.deepEqual(wf.connections['Je obsah?'].main[1], [{ node: 'Moduly', type: 'main', index: 0 }]);
  assert.equal(wf.connections['Claude – extrakce'].main[0][0].node, 'Moduly');
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

// --- behavior Code nodů: SKUTEČNÝ jsCode z buildWorkflow běží v realistickém sandboxu (bez URL, AbortSignal, structuredClone, ...) ---
const WF = buildWorkflow({ credId: 'C', credName: 'N' });
const CODE_NODES = ['Vstup a načtení', 'Sestavit extrakci', 'Moduly', 'Odpověď'];
const NODE_OF_GLUE = { '01-vstup.js': 'Vstup a načtení', '02-extrakce-req.js': 'Sestavit extrakci', '03-moduly.js': 'Moduly', '04-odpoved.js': 'Odpověď' };
const nodeCode = (name) => WF.nodes.find((n) => n.name === name).parameters.jsCode;
// opts: viz runCodeNode (json, nodes, state, httpStub, $input, globals) + src (přepsaný jsCode)
const runNode = (name, { src, ...o } = {}) => runCodeNode(src || nodeCode(name), o);
const runGlue = (file, o) => runNode(NODE_OF_GLUE[file], o);
const runGlue01 = (body, o = {}) => runGlue('01-vstup.js', { ...o, json: { body } });
const CHYBA_OBECNA_API = 'Kontrola se nepodařila. Zkuste to prosím znovu.';

test('každý Code node nese celý bundle enginu (žádný node nevolá funkci mimo svůj scope)', () => {
  const bundle = buildBundle();
  for (const name of CODE_NODES) {
    const js = nodeCode(name);
    assert.ok(js.startsWith(bundle), name + ': jsCode nezačíná bundlem');
    assert.ok(js.length > bundle.length, name + ': chybí glue');
  }
});

test('každý $(\'Název nodu\') v jsCode odkazuje na existující node workflow', () => {
  const names = new Set(WF.nodes.map((n) => n.name));
  let found = 0;
  for (const name of CODE_NODES) {
    for (const m of nodeCode(name).matchAll(/\$\(\s*(['"`])([^'"`]+)\1\s*\)/g)) {
      found++;
      assert.ok(names.has(m[2]), name + ' odkazuje na neexistující node ' + m[2]);
    }
  }
  assert.ok(found >= 2, 'očekávány alespoň 2 odkazy $(...), nalezeno ' + found);
});

test('glue neobsahuje nedostupné globály (AbortSignal jen s typeof guardem)', () => {
  for (const f of GLUE_FILES) {
    const code = glueSrc(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const re of [/\bnew\s+URL\b/, /\bURLSearchParams\b/, /\bstructuredClone\b/, /\bBuffer\b/, /\bTextEncoder\b/, /\bTextDecoder\b/, /\bfetch\s*\(/, /\bprocess\./]) {
      assert.equal(re.test(code), false, f + ' ' + re);
    }
    if (/AbortSignal/.test(code)) assert.match(code, /typeof AbortSignal !== 'undefined'/, f + ': AbortSignal bez typeof guardu');
  }
});

test('Code nody: bundle běží v realistickém sandboxu bez require a bez URL', () => {
  const bundle = buildBundle();
  const r = runInRealisticSandbox(bundle + '\n[normalizeUrl, computeVerdict, offerSignals, sellerSignals, safetySignals, buildResponse, buildExtractRequest].every(f => typeof f === "function");');
  assert.equal(r, true);
});

test('každý Code node je validní async tělo (top-level return/await)', () => {
  for (const name of CODE_NODES) {
    assert.doesNotThrow(() => new vm.Script('(async function(){' + nodeCode(name) + '\n})', { filename: name }), name);
  }
});

test('glue 01: prázdné tělo -> zkratka, 400', async () => {
  const { out, calls } = await runGlue01({});
  assert.equal(out.zkratka, true);
  assert.equal(out.status, 400);
  assert.equal(out.odpoved.stav, 'chyba');
  assert.equal(calls.length, 0);
});

test('glue 01: SSRF odkaz -> 400 a nic se nestahuje', async () => {
  for (const odkaz of ['http://127.0.0.1:5678/x', 'http://[::1]/', 'http://2130706433/', 'http://169.254.169.254/latest/meta-data']) {
    const { out, calls } = await runGlue01({ odkaz });
    assert.equal(out.zkratka, true, odkaz);
    assert.equal(out.status, 400, odkaz);
    assert.equal(calls.length, 0, odkaz);
  }
});

test('glue 01: pouze text -> pokračuje, text zachován, nic se nestahuje', async () => {
  const { out, calls } = await runGlue01({ text: 'Powerbanka 199 Kč' });
  assert.equal(out.zkratka, false);
  assert.equal(out.input.text, 'Powerbanka 199 Kč');
  assert.equal(calls.length, 0);
});

test('glue 01: veřejný odkaz projde parserem a stáhne se přesně normalizovaná adresa', async () => {
  const { out, calls } = await runGlue01({ odkaz: 'https://www.alza.cz/x' }, {
    httpStub: () => ({ statusCode: 200, body: '<html>' + 'text '.repeat(200) + '</html>' }),
  });
  assert.equal(out.zkratka, false);
  assert.equal(out.host, 'alza.cz');
  assert.equal(out.rezim, 'eshop');
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.ok(calls.every((c) => c.url === 'https://www.alza.cz/x'));
});

test('glue 01: přesměrování 302 se nenásleduje; e-shop pokračuje bez obsahu, nic dalšího se nestahuje', async () => {
  const { out, calls } = await runGlue01({ odkaz: 'https://example.cz/p' }, {
    httpStub: () => ({ statusCode: 302, headers: { location: 'http://127.0.0.1/' }, body: '' }),
  });
  assert.equal(out.zkratka, false);
  assert.equal(out.obsah, false);
  assert.equal(out.pageText, '');
  assert.equal(out.rezim, 'eshop');
  assert.equal(out.host, 'example.cz');
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
  for (const c of calls) {
    assert.equal(c.disableFollowRedirect, true, c.method);
    assert.equal(c.ignoreHttpStatusErrors, true, c.method);
    assert.equal(c.returnFullResponse, true, c.method);
  }
});

test('glue 01: stránka 200 -> pokračuje s neprázdným pageText', async () => {
  const { out } = await runGlue01({ odkaz: 'https://example.cz/p' }, {
    httpStub: () => ({ statusCode: 200, body: '<html>' + 'text '.repeat(200) + '</html>' }),
  });
  assert.equal(out.zkratka, false);
  assert.equal(out.obsah, true);
  assert.ok(out.pageText.length > 0);
});

test('glue 01: 404/500 stránka se nepoužije; e-shop pokračuje bez obsahu, marketplace -> potrebuji_vice', async () => {
  for (const statusCode of [404, 500]) {
    const stub = () => ({ statusCode, body: '<html>' + 'text '.repeat(200) + '</html>' });
    const { out } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: stub });
    assert.equal(out.zkratka, false, 'status ' + statusCode);
    assert.equal(out.obsah, false);
    assert.equal(out.pageText, '');
    const m = await runGlue01({ odkaz: 'https://www.temu.com/p' }, { httpStub: stub });
    assert.equal(m.out.zkratka, true, 'marketplace ' + statusCode);
    assert.equal(m.out.odpoved.stav, 'potrebuji_vice');
  }
});

test('glue 01: obsah je true pro text, a e-shop s textem má obsah i bez načtené stránky', async () => {
  const t = await runGlue01({ text: 'Powerbanka' });
  assert.equal(t.out.obsah, true);
  const u = await runGlue01({ odkaz: 'https://example.cz/p', text: 'Powerbanka' }, { httpStub: () => ({ statusCode: 403, body: '' }) });
  assert.equal(u.out.obsah, true);
  assert.equal(u.out.pageText, '');
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

test('glue 01: bez AbortSignal v sandboxu (realita n8n) nikdy se nevracející request skončí do deadline (marketplace -> potrebuji_vice, e-shop pokračuje)', async () => {
  const src = nodeCode('Vstup a načtení');
  assert.match(src, /const FETCH_DEADLINE_MS = \d+;/);
  assert.match(src, /const FETCH_HEAD_DEADLINE_MS = 5000;/);
  const fast = src.replace(/const FETCH_DEADLINE_MS = \d+;/, 'const FETCH_DEADLINE_MS = 50;').replace(/const FETCH_HEAD_DEADLINE_MS = \d+;/, 'const FETCH_HEAD_DEADLINE_MS = 50;');
  assert.notEqual(fast, src);
  const t0 = Date.now();
  const { out, calls } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://www.temu.com/p' } }, src: fast,
    httpStub: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - t0 < 1000, 'deadline nezabral');
  assert.equal(out.zkratka, true);
  assert.equal(out.odpoved.stav, 'potrebuji_vice');
  assert.deepEqual(calls.map((c) => c.method), ['HEAD', 'GET']);
  assert.equal(calls[0].abortSignal, undefined);
  assert.equal(calls[1].abortSignal, undefined);
  const e = await runGlue('01-vstup.js', { json: { body: { odkaz: 'https://example.cz/p' } }, src: fast, httpStub: () => new Promise(() => {}) });
  assert.equal(e.out.zkratka, false);
  assert.equal(e.out.obsah, false);
});

test('glue 01: pokud runtime AbortSignal má, signál se předá requestu', async () => {
  const { calls } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://example.cz/p' } },
    globals: { AbortSignal: { timeout: () => ({ aborted: false }) } },
    httpStub: () => ({ statusCode: 200, body: '<html>' + 'text '.repeat(200) + '</html>' }),
  });
  assert.ok(calls[0].abortSignal, 'chybí abortSignal');
  assert.equal(typeof calls[0].abortSignal.aborted, 'boolean');
});

// --- fix wave B: meze stahování stránky (HEAD předkontrola, Range, Accept) ---
const HTML_OK = '<html>' + 'text '.repeat(200) + '</html>';
const methodsOf = (calls) => calls.map((c) => c.method);
// Stub: na HEAD odpoví head, na GET get.
const headGet = (head, get = () => ({ statusCode: 200, body: HTML_OK })) => (o) => (o.method === 'HEAD' ? head(o) : get(o));

test('glue 01: HEAD říká application/pdf -> GET se nevolá; e-shop pokračuje bez obsahu, marketplace -> potrebuji_vice', async () => {
  const stub = headGet(() => ({ statusCode: 200, headers: { 'content-type': 'application/pdf' }, body: '' }));
  const e = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: stub });
  assert.deepEqual(methodsOf(e.calls), ['HEAD']);
  assert.equal(e.out.zkratka, false);
  assert.equal(e.out.obsah, false);
  assert.equal(e.out.pageText, '');
  assert.equal(e.out.rezim, 'eshop');
  const m = await runGlue01({ odkaz: 'https://www.temu.com/p' }, { httpStub: stub });
  assert.deepEqual(methodsOf(m.calls), ['HEAD']);
  assert.equal(m.out.zkratka, true);
  assert.equal(m.out.odpoved.stav, 'potrebuji_vice');
});

test('glue 01: HEAD content-type se hodnotí bez ohledu na velikost písmen v názvu hlavičky i hodnotě; text/html a xhtml projdou', async () => {
  const types = [['Content-Type', 'TEXT/HTML; charset=UTF-8'], ['CONTENT-TYPE', 'application/xhtml+xml'], ['content-type', 'text/html']];
  for (const [k, v] of types) {
    const { calls, out } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { [k]: v }, body: '' })) });
    assert.deepEqual(methodsOf(calls), ['HEAD', 'GET'], k + ': ' + v);
    assert.equal(out.obsah, true);
  }
  for (const [k, v] of [['Content-Type', 'Application/PDF'], ['CONTENT-TYPE', 'image/png'], ['content-type', 'application/octet-stream'], ['content-type', 'text/htmlx']]) {
    const { calls } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { [k]: v }, body: '' })) });
    assert.deepEqual(methodsOf(calls), ['HEAD'], k + ': ' + v);
  }
});

test('glue 01: HEAD content-length nad 3 000 000 -> GET se nevolá; přesně 3 000 000 a nečíselné hodnoty projdou', async () => {
  const big = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { 'Content-Length': '50000000', 'content-type': 'text/html' }, body: '' })) });
  assert.deepEqual(methodsOf(big.calls), ['HEAD']);
  assert.equal(big.out.obsah, false);
  const m = await runGlue01({ odkaz: 'https://www.temu.com/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { 'content-length': '3000001' }, body: '' })) });
  assert.deepEqual(methodsOf(m.calls), ['HEAD']);
  assert.equal(m.out.odpoved.stav, 'potrebuji_vice');
  for (const cl of ['3000000', '12', 'abc', '']) {
    const { calls } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { 'content-length': cl }, body: '' })) });
    assert.deepEqual(methodsOf(calls), ['HEAD', 'GET'], 'content-length ' + cl);
  }
});

test('glue 01: HEAD 405 / 404 / 500 / výjimka -> GET se přesto zavolá a stránka se načte', async () => {
  const heads = [() => ({ statusCode: 405, headers: { 'content-type': 'application/pdf' }, body: '' }), () => ({ statusCode: 404, headers: {}, body: '' }),
    () => ({ statusCode: 500, headers: { 'content-length': '99999999' }, body: '' }), () => { throw new Error('ECONNRESET'); }, () => Promise.reject(new Error('x'))];
  for (const h of heads) {
    const { calls, out } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(h) });
    assert.deepEqual(methodsOf(calls), ['HEAD', 'GET']);
    assert.equal(out.obsah, true);
    assert.ok(out.pageText.length > 0);
  }
});

test('glue 01: HEAD bez content-type (2xx) -> GET se zavolá', async () => {
  const { calls, out } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: {}, body: '' })) });
  assert.deepEqual(methodsOf(calls), ['HEAD', 'GET']);
  assert.equal(out.obsah, true);
});

test('glue 01: GET posílá Range a Accept, HEAD má stejné bezpečné volby; 206 i 200 se přijmou', async () => {
  for (const statusCode of [200, 206]) {
    const { calls, out } = await runGlue01({ odkaz: 'https://example.cz/p' }, { httpStub: headGet(() => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: '' }), () => ({ statusCode, body: HTML_OK })) });
    const get = calls.find((c) => c.method === 'GET');
    const head = calls.find((c) => c.method === 'HEAD');
    assert.equal(get.headers.Range, 'bytes=0-2000000');
    assert.equal(get.headers.Accept, 'text/html,application/xhtml+xml');
    assert.equal(get.headers['Accept-Language'], 'cs');
    assert.equal(get.disableFollowRedirect, true);
    assert.equal(head.disableFollowRedirect, true);
    assert.equal(head.ignoreHttpStatusErrors, true);
    assert.equal(head.returnFullResponse, true);
    assert.equal(head.timeout, 5000);
    assert.equal(out.obsah, true, 'status ' + statusCode);
  }
});

test('glue 01: HEAD, který nikdy neodpoví, se po krátkém deadline přeskočí a GET proběhne', async () => {
  const src = nodeCode('Vstup a načtení').replace(/const FETCH_HEAD_DEADLINE_MS = \d+;/, 'const FETCH_HEAD_DEADLINE_MS = 40;');
  const t0 = Date.now();
  const { calls, out } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://example.cz/p' } }, src,
    httpStub: headGet(() => new Promise(() => {})),
  });
  assert.ok(Date.now() - t0 < 1500, 'HEAD deadline nezabral');
  assert.deepEqual(methodsOf(calls), ['HEAD', 'GET']);
  assert.equal(out.obsah, true);
});

test('glue 01: HEAD a GET předají abortSignal, pokud ho runtime má', async () => {
  const { calls } = await runGlue('01-vstup.js', {
    json: { body: { odkaz: 'https://example.cz/p' } },
    globals: { AbortSignal: { timeout: () => ({ aborted: false }) } },
    httpStub: headGet(() => ({ statusCode: 200, headers: {}, body: '' })),
  });
  assert.equal(calls.length, 2);
  for (const c of calls) assert.ok(c.abortSignal, c.method);
});

// --- fix wave B: QUOTA_PER_DAY při sestavení ---
const quotaOf = (src) => /^\s*const MAX_DENNE = (\d+);/m.exec(src)[1];
const vstupSrc = (wf) => wf.nodes.find((n) => n.name === 'Vstup a načtení').parameters.jsCode;

test('build: výchozí limit zůstává 200 (bez volby i s prázdnou hodnotou)', () => {
  assert.equal(quotaOf(nodeCode('Vstup a načtení')), '200');
  assert.equal(quotaOf(vstupSrc(buildWorkflow({ credId: 'C', credName: 'N', quotaPerDay: undefined }))), '200');
  assert.equal(resolveQuota('', () => assert.fail('nemá varovat')), 200);
});

test('build: quotaPerDay se dosadí do glue 01 (jen tam) a limit se v běhu skutečně uplatní', async () => {
  const wf = buildWorkflow({ credId: 'C', credName: 'N', quotaPerDay: 3 });
  const src = vstupSrc(wf);
  assert.equal(quotaOf(src), '3');
  assert.equal(src.split('const MAX_DENNE').length, 2);
  assert.equal(JSON.stringify(wf.nodes.filter((n) => n.name !== 'Vstup a načtení')).includes('MAX_DENNE'), false);
  const state = {};
  const run = () => runGlue('01-vstup.js', { json: { body: { text: 'Powerbanka 199 Kč' } }, src, state });
  for (let i = 0; i < 3; i++) assert.equal((await run()).out.zkratka, false);
  assert.equal((await run()).out.status, 429);
  assert.equal(quotaOf(vstupSrc(buildWorkflow({ credId: 'C', credName: 'N', quotaPerDay: '100000' }))), '100000');
  assert.equal(quotaOf(vstupSrc(buildWorkflow({ credId: 'C', credName: 'N', quotaPerDay: '1' }))), '1');
});

test('build: neplatný QUOTA_PER_DAY -> výchozí 200 s varováním', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const bad of ['abc', '0', '-5', '100001', '1.5', '1e3', 0, -1, 2.5, NaN, '12 3', true]) {
    const before = warn.mock.callCount();
    const wf = buildWorkflow({ credId: 'C', credName: 'N', quotaPerDay: bad });
    assert.equal(quotaOf(vstupSrc(wf)), '200', String(bad));
    assert.equal(warn.mock.callCount(), before + 1, 'varování pro ' + String(bad));
  }
  const seen = [];
  assert.equal(resolveQuota('x', (m) => seen.push(m)), 200);
  assert.match(seen[0], /QUOTA_PER_DAY/);
});

test('glue 01: kvóta je zdokumentovaná v komentáři na začátku', () => {
  const head = glueSrc('01-vstup.js').split('\n').slice(0, 8).join('\n');
  assert.match(head, /kvót/i);
  assert.match(head, /potrebuji_vice/);
  assert.match(head, /přibližn/i);
});

test('glue 01: výjimka kdekoli v těle -> 500 s obecnou hláškou, nic neuniká', async () => {
  const thrower = (msg) => () => { throw new Error(msg); };
  const cases = [
    { $input: { first: thrower('tajná chyba /interní/cesta') } },
    { json: { body: { text: 'x' } }, globals: { $getWorkflowStaticData: thrower('tajná chyba /interní/cesta') } },
    { json: { body: { text: 'x' } }, state: { day: new Date().toISOString().slice(0, 10), get count() { throw new Error('tajná chyba /interní/cesta'); } } },
  ];
  for (const c of cases) {
    const { out } = await runGlue('01-vstup.js', c);
    assert.deepEqual(out, { zkratka: true, status: 500, odpoved: { stav: 'chyba', chyba: CHYBA_OBECNA_API } });
    assert.equal(JSON.stringify(out).includes('tajná'), false);
  }
});

// --- glue 02 ---
test('glue 02: sestaví požadavek na extrakci (node nese bundle)', async () => {
  const { out } = await runGlue('02-extrakce-req.js', { json: { input: { text: 'Powerbanka 199 Kč', screenshoty: [], url: null }, pageText: '' } });
  assert.equal(typeof out.llmRequest.model, 'string');
  assert.ok(Array.isArray(out.llmRequest.messages));
});

test('glue 02: výjimka -> llmRequest null (Claude node selže a tok degraduje), nic neuniká', async () => {
  for (const c of [{ $input: { first: () => { throw new Error('tajná chyba'); } } }, { json: {} }, { json: { input: null } }]) {
    const { out } = await runGlue('02-extrakce-req.js', c);
    assert.deepEqual(out, { llmRequest: null });
  }
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

// --- glue 03: Safety Gate (slabý signál gated značkou; selhání = bez signálu) ---
const SG_URL = 'https://ec.europa.eu/safety-gate-alerts/public/api/search';
const extractBrand = (znacka, model) => ({ content: [{ type: 'text', text: JSON.stringify({ produkt: { nazev: 'Powerbanka', kategorie: 'elektronika', znacka, model, cena: 900, mena: 'CZK', tvrzeni_certifikace: ['CE'] }, prodejce: {}, recenze: {}, obrazky: {}, nerealne_parametry: [], nesoulady: [] }) }] });
const SG_ALERT = { reference: 'SR/00232/25', publicationDate: '2025-01-13T00:00:00.000+00:00', product: { name: 'Power bank', nameSpecific: 'STB-200', brands: [{ brand: 'Forever STB-200' }] }, risk: { riskType: [{ name: 'ENVIRONMENT' }] } };
const sgCalls = (calls) => calls.filter((c) => c.url === SG_URL);
const runSg = (extract, httpStub, o = {}) => runGlue('03-moduly.js', { json: extract, nodes: { 'Vstup a načtení': CTX_NEZNAME }, httpStub, ...o });

test('glue 03 Safety Gate: znacka null -> endpoint se nikdy nevolá', async () => {
  const { out, calls } = await runSg(extractBrand(null, 'X1'), () => { throw new Error('nemá se volat'); });
  assert.equal(sgCalls(calls).length, 0);
  assert.equal(calls.length, 0);
  assert.equal(out.signals.some((s) => s.id === 'safety_gate'), false);
});

test('glue 03 Safety Gate: generická značka (Unbranded) -> endpoint se nikdy nevolá', async () => {
  for (const z of ['Unbranded', 'No brand', 'HP']) {
    const { out, calls } = await runSg(extractBrand(z, null), () => ({ statusCode: 200, body: { content: [{ ...SG_ALERT, product: { ...SG_ALERT.product, brands: [{ brand: z }] } }] } }));
    assert.equal(sgCalls(calls).length, 0, z);
    assert.equal(out.signals.some((s) => s.id === 'safety_gate'), false, z);
  }
});

test('glue 03 Safety Gate: odeslaný požadavek (sanitizovaný dotaz, numberElements 20, totalElements 0)', async () => {
  const { calls } = await runSg(extractBrand('Škoda "Auto"', 'STB-200!'), () => ({ statusCode: 200, body: { content: [] } }));
  const c = sgCalls(calls);
  assert.equal(c.length, 1);
  assert.equal(c[0].method, 'POST');
  assert.equal(c[0].json, true);
  assert.equal(c[0].timeout, 8000);
  assert.equal(c[0].ignoreHttpStatusErrors, true);
  assert.equal(c[0].returnFullResponse, true);
  assert.equal(c[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(JSON.stringify(c[0].body)), {
    criteria: {},
    pagination: { sortField: 'PUBLICATION_DATE', sortOrder: 'DESC', totalElements: 0, page: 0, numberElements: 20 },
    fullTextSearch: 'Skoda Auto STB-200',
    language: 'en',
  });
});

test('glue 03 Safety Gate: shodná značka+model -> low signál safety_gate, verdikt jinak nezměněn', async () => {
  const ex = extractBrand('Forever', 'STB-200');
  const base = await runSg(ex, () => ({ statusCode: 200, body: { content: [] } }));
  const hit = await runSg(ex, () => ({ statusCode: 200, body: { content: [SG_ALERT] } }));
  assert.equal(base.out.signals.some((s) => s.id === 'safety_gate'), false);
  const sg = hit.out.signals.filter((s) => s.id === 'safety_gate');
  assert.equal(sg.length, 1);
  assert.equal(sg[0].severity, 'low');
  assert.equal(sg[0].hard, false);
  assert.equal(sg[0].module, 'safety');
  assert.deepEqual(hit.out.signals.filter((s) => s.id !== 'safety_gate'), base.out.signals);
  assert.equal(hit.out.verdict.score, base.out.verdict.score + 1);
  assert.equal(hit.out.verdict.semafor, base.out.verdict.semafor);
  assert.notEqual(hit.out.verdict.semafor, 'červená');
});

test('glue 03 Safety Gate: alert jiné značky (Tanker) ani jiného modelu signál nedá', async () => {
  const tanker = { ...SG_ALERT, product: { ...SG_ALERT.product, brands: [{ brand: 'Tanker' }] } };
  const r1 = await runSg(extractBrand('Anker', null), () => ({ statusCode: 200, body: { content: [tanker] } }));
  assert.equal(r1.out.signals.some((s) => s.id === 'safety_gate'), false);
  const r2 = await runSg(extractBrand('Forever', 'XYZ-9'), () => ({ statusCode: 200, body: { content: [SG_ALERT] } }));
  assert.equal(r2.out.signals.some((s) => s.id === 'safety_gate'), false);
});

test('glue 03 Safety Gate: 500 / jiný status / výjimka / podivné tělo -> bez signálu a bez pádu', async () => {
  const stubs = {
    500: () => ({ statusCode: 500, body: { content: [SG_ALERT] } }),
    405: () => ({ statusCode: 405, body: '<html>' }),
    throws: () => { throw new Error('ECONNRESET tajná chyba'); },
    rejects: () => Promise.reject(new Error('timeout')),
    stringBody: () => ({ statusCode: 200, body: 'ne json' }),
    nullBody: () => ({ statusCode: 200, body: null }),
    arrayBody: () => ({ statusCode: 200, body: [SG_ALERT] }),
    noContent: () => ({ statusCode: 200, body: { content: 'x' } }),
    undef: () => undefined,
  };
  const base = await runSg(extractBrand('Forever', 'STB-200'), () => ({ statusCode: 200, body: { content: [] } }));
  for (const [name, stub] of Object.entries(stubs)) {
    const { out, calls } = await runSg(extractBrand('Forever', 'STB-200'), stub);
    assert.equal(sgCalls(calls).length, 1, name);
    assert.equal(out.signals.some((s) => s.id === 'safety_gate'), false, name);
    assert.deepEqual(out.verdict, base.out.verdict, name);
    assert.deepEqual(out.signals, base.out.signals, name);
    assert.equal(JSON.stringify(out).includes('tajná'), false, name);
  }
});

test('glue 03 Safety Gate: nikdy se nevracející request skončí do deadline, ostatní signály zůstanou', async () => {
  const src = nodeCode('Moduly');
  assert.match(src, /const SAFETY_GATE_DEADLINE_MS = \d+;/);
  const fast = src.replace(/const SAFETY_GATE_DEADLINE_MS = \d+;/, 'const SAFETY_GATE_DEADLINE_MS = 50;');
  assert.notEqual(fast, src);
  const t0 = Date.now();
  const { out, calls } = await runSg(extractBrand('Forever', 'STB-200'), () => new Promise(() => {}), { src: fast });
  assert.ok(Date.now() - t0 < 1000, 'deadline nezabral');
  assert.equal(sgCalls(calls).length, 1);
  assert.equal(out.signals.some((s) => s.id === 'safety_gate'), false);
  assert.ok(out.verdict && out.llmRequest);
});

test('glue 03 Safety Gate: pozdní odmítnutí po deadline nevyvolá unhandled rejection', async () => {
  const src = nodeCode('Moduly').replace(/const SAFETY_GATE_DEADLINE_MS = \d+;/, 'const SAFETY_GATE_DEADLINE_MS = 20;');
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on('unhandledRejection', onRej);
  try {
    await runSg(extractBrand('Forever', 'STB-200'), () => new Promise((_, rej) => setTimeout(() => rej(new Error('pozdě')), 80)), { src });
    await new Promise((r) => setTimeout(r, 150));
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(seen, []);
});

test('glue 03 Safety Gate: souběžně se seller fetchery, žádný nový požadavek bez značky (eshop)', async () => {
  const stub = (o) => {
    if (o.url.startsWith('https://coi.gov.cz/')) return coiHtml(150);
    if (o.url.startsWith('https://rdap.')) return { events: [{ eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' }] };
    if (o.url === SG_URL) return { statusCode: 200, body: { content: [SG_ALERT] } };
    throw new Error('neočekávaný požadavek ' + o.url);
  };
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: 'x', rezim: 'eshop', host: 'clarkscz.cz' };
  const withBrand = await runGlue('03-moduly.js', { json: extractBrand('Forever', 'STB-200'), nodes: { 'Vstup a načtení': ctx }, state: {}, httpStub: stub });
  assert.ok(withBrand.out.signals.some((s) => s.id === 'safety_gate'));
  assert.ok(withBrand.out.signals.some((s) => s.id === 'coi_seznam'));
  assert.equal(sgCalls(withBrand.calls).length, 1);
  const noBrand = await runGlue('03-moduly.js', { json: extractBrand(null, null), nodes: { 'Vstup a načtení': ctx }, state: {}, httpStub: stub });
  assert.equal(sgCalls(noBrand.calls).length, 0);
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

// --- end-to-end: všechny čtyři Code nody po sobě, Claude HTTP nody simulované stubem ---
const ERR_CLAUDE = { error: { message: 'no credential' } };
const anthropic = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
const EXTRACT_POWERBANKA = anthropic({
  produkt: { nazev: 'Powerbanka', kategorie: 'elektronika', cena: 199, mena: 'CZK', referencni_cena_odhad: { min: 800, max: 1200, mena: 'CZK' } },
  prodejce: { zeme_odeslani: 'CN', kontakt_uveden: false }, recenze: {}, obrazky: {}, nerealne_parametry: [], nesoulady: [],
});
const EXPLAIN_OK = anthropic({ shrnuti: 'Cena je mnohem nižší než obvyklá a chybí kontakt na prodejce, proto je nabídka riziková.', co_delat: ['Porovnejte cenu u jiných prodejců.', 'Neplaťte předem.'] });

// Tok se prochází podle buildWorkflow().connections: IF nody se vyhodnotí z jejich podmínky ($json.pole, operace true/false),
// Claude HTTP nody jsou simulované stubem (extract/explain; odpověď příslušného nodu) a zaznamenají se do claudeCalls.
// Vrací final (výstup posledního nodu), výstupy Code nodů r1..r4 (nevolané = undefined) a visited (pořadí nodů).
async function runFlow(body, { extract = ERR_CLAUDE, explain = ERR_CLAUDE, httpStub, state = {} } = {}) {
  const claudeCalls = [], visited = [], nodes = {}, res = {};
  const stubs = { 'Claude – extrakce': extract, 'Claude – vysvětlení': explain };
  const codeKey = { 'Vstup a načtení': 'r1', 'Sestavit extrakci': 'r2', Moduly: 'r3', 'Odpověď': 'r4' };
  let name = 'Vstup a načtení', input = { body }, final;
  for (let guard = 0; guard < 20; guard++) {
    visited.push(name);
    const node = WF.nodes.find((n) => n.name === name);
    let out, port = 0;
    if (node.type === 'n8n-nodes-base.code') {
      const r = await runNode(name, { json: input, nodes, state, httpStub });
      res[codeKey[name]] = r; nodes[name] = r.out; out = r.out;
    } else if (node.type === 'n8n-nodes-base.httpRequest') {
      claudeCalls.push(name); out = stubs[name];
    } else if (node.type === 'n8n-nodes-base.if') {
      const c = node.parameters.conditions.conditions[0];
      const v = input[/^=\{\{ \$json\.(\w+) \}\}$/.exec(c.leftValue)[1]];
      port = (c.operator.operation === 'true' ? v === true : v === false) ? 0 : 1; out = input;
    } else { final = input; break; }
    const next = WF.connections[name] && WF.connections[name].main[port];
    if (!next || !next.length) { final = out; break; }
    name = next[0].node; input = out;
  }
  return { final, ...res, claudeCalls, visited };
}

test('e2e (a): text a selhání Claude -> 200, stav ok, šedá, nezkontrolováno nabídka/prodejce/bezpečnost', async () => {
  const f = await runFlow({ text: 'Powerbanka 30000 mAh jen 199 Kč! Odesíláme z Číny.' });
  assert.equal(typeof f.r2.out.llmRequest.model, 'string', 'Sestavit extrakci sestaví požadavek');
  assert.equal(f.final.status, 200);
  assert.equal(f.final.odpoved.stav, 'ok');
  assert.equal(f.final.odpoved.semafor, 'šedá');
  assert.deepEqual(f.final.odpoved.nezkontrolovano, ['nabídka', 'prodejce', 'bezpečnost']);
  assert.deepEqual(f.final.odpoved.signaly, []);
});

test('e2e (b): validní extrakce a vysvětlení -> signály, není zelená, vysvětlení z LLM prošlo guardy', async () => {
  const f = await runFlow({ text: 'Powerbanka 30000 mAh jen 199 Kč! Odesíláme z Číny.' }, { extract: EXTRACT_POWERBANKA, explain: EXPLAIN_OK });
  assert.equal(f.final.status, 200);
  const o = f.final.odpoved;
  assert.equal(o.stav, 'ok');
  assert.ok(o.signaly.some((s) => s.id === 'cena_extremne_nizka'), o.signaly.map((s) => s.id).join());
  assert.notEqual(o.semafor, 'zelená');
  assert.equal(o.shrnuti, 'Cena je mnohem nižší než obvyklá a chybí kontakt na prodejce, proto je nabídka riziková.');
  assert.deepEqual(o.co_delat, ['Porovnejte cenu u jiných prodejců.', 'Neplaťte předem.']);
});

test('e2e (b): vysvětlení, které neprojde guardy (podvodník, tvrzení o bezpečnosti, nevalidní tvar), se nepoužije', async () => {
  const bad = [
    anthropic({ shrnuti: 'Prodejce je podvodník.', co_delat: ['Nekupujte.'] }),
    anthropic({ shrnuti: 'Nabídka je bezpečná, můžete koupit.', co_delat: ['Kupte to.'] }),
    anthropic('to není JSON'),
    anthropic({ shrnuti: 'Jen shrnutí bez rad.' }),
  ];
  for (const explain of bad) {
    const f = await runFlow({ text: 'Powerbanka 30000 mAh jen 199 Kč!' }, { extract: EXTRACT_POWERBANKA, explain });
    const o = f.final.odpoved;
    assert.equal(f.final.status, 200);
    assert.equal(o.stav, 'ok');
    assert.notEqual(o.semafor, 'zelená');
    assert.ok(/^Kontrola našla|^Z dostupných/.test(o.shrnuti), 'záložní text, bylo: ' + o.shrnuti);
    assert.ok(o.signaly.length > 0);
  }
});

test('e2e (c): odkaz -> glue 01 stáhne stránku přes stub a tok doběhne', async () => {
  const seen = [];
  const httpStub = (o) => {
    seen.push(o.url);
    if (o.url === 'https://www.alza.cz/x') return { statusCode: 200, body: '<html><body>' + 'Powerbanka 30000 mAh za 199 Kč. '.repeat(30) + '</body></html>' };
    if (o.url.startsWith('https://coi.gov.cz/')) return coiHtml(150);
    if (o.url.startsWith('https://rdap.')) return { events: [{ eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' }] };
    throw new Error('neočekávaný požadavek ' + o.url);
  };
  const f = await runFlow({ odkaz: 'https://www.alza.cz/x' }, { extract: EXTRACT_POWERBANKA, explain: EXPLAIN_OK, httpStub });
  assert.equal(seen[0], 'https://www.alza.cz/x');
  assert.equal(f.r1.out.zkratka, false);
  assert.equal(f.r1.out.rezim, 'eshop');
  assert.ok(f.r1.out.pageText.length >= 300);
  assert.ok(JSON.stringify(f.r2.out.llmRequest).includes('https://www.alza.cz/x'));
  assert.equal(f.final.status, 200);
  assert.equal(f.final.odpoved.stav, 'ok');
  assert.notEqual(f.final.odpoved.semafor, 'zelená');
});

test('e2e: marketplace odkaz, který se nepodaří stáhnout, a bez dalšího vstupu -> potrebuji_vice ze Vstupu (200)', async () => {
  const f = await runFlow({ odkaz: 'https://www.temu.com/p' }, { httpStub: () => ({ statusCode: 403, body: '' }) });
  assert.equal(f.final.status, 200);
  assert.equal(f.final.odpoved.stav, 'potrebuji_vice');
  assert.deepEqual(f.visited, ['Vstup a načtení', 'Stačí vstup?', 'Respond – více vstupu']);
});

// --- Task 8c: kontroly hostitele e-shopu nezávisí na LLM ani na načtení stránky ---
const hostStub = (rdapYear, coi) => (o) => {
  if (o.url.startsWith('https://coi.gov.cz/')) return coi;
  if (o.url.startsWith('https://rdap.')) return { events: [{ eventAction: 'registration', eventDate: rdapYear + '-01-01T00:00:00Z' }] };
  if (o.url.startsWith('https://ares.')) throw new Error('ARES se tu nemá volat');
  return { statusCode: 403, body: '' };
};

test('e2e 8c (a): ČOI e-shop, stránka 403, bez textu -> červená bez Claude extrakce', async () => {
  const f = await runFlow({ odkaz: 'https://clarkscz.cz/x' }, { explain: EXPLAIN_OK, httpStub: hostStub(2019, coiHtml(150)) });
  assert.equal(f.final.status, 200);
  const o = f.final.odpoved;
  assert.equal(o.stav, 'ok');
  assert.equal(o.semafor, 'červená');
  assert.ok(o.signaly.some((s) => s.id === 'coi_seznam'));
  assert.deepEqual(o.nezkontrolovano, ['nabídka', 'bezpečnost']);
  assert.equal(f.r1.out.obsah, false);
  assert.equal(f.r2, undefined, 'Sestavit extrakci se nevolá');
  assert.ok(!f.claudeCalls.includes('Claude – extrakce'), 'Claude extrakce se nevolá: ' + f.claudeCalls);
  assert.deepEqual(f.visited, ['Vstup a načtení', 'Stačí vstup?', 'Je obsah?', 'Moduly', 'Claude – vysvětlení', 'Odpověď', 'Respond']);
});

test('e2e 8c (b): e-shop s textem a selhání Claude extrakce -> stále červená z ČOI, prodejce zkontrolován', async () => {
  const f = await runFlow({ odkaz: 'https://clarkscz.cz/x', text: 'Powerbanka' }, { extract: ERR_CLAUDE, httpStub: hostStub(2019, coiHtml(150)) });
  assert.equal(f.final.status, 200);
  const o = f.final.odpoved;
  assert.equal(o.semafor, 'červená');
  assert.ok(o.signaly.some((s) => s.id === 'coi_seznam'));
  assert.ok(!o.nezkontrolovano.includes('prodejce'), o.nezkontrolovano.join());
  assert.ok(f.claudeCalls.includes('Claude – extrakce'));
});

test('e2e 8c (c): marketplace s 403 stránkou -> potrebuji_vice (host kontroly nemá)', async () => {
  const f = await runFlow({ odkaz: 'https://www.temu.com/p' }, { httpStub: hostStub(2019, coiHtml(150)) });
  assert.equal(f.final.odpoved.stav, 'potrebuji_vice');
  assert.equal(f.r3, undefined);
});

test('e2e 8c (d): e-shop pouze z URL, mimo seznam ČOI, doména stará -> ok, šedá (nízká jistota), co_delat přítomno', async () => {
  const f = await runFlow({ odkaz: 'https://example.cz/' }, { httpStub: hostStub(2005, coiHtml(150)) });
  assert.equal(f.final.status, 200);
  const o = f.final.odpoved;
  assert.equal(o.stav, 'ok');
  assert.equal(o.semafor, 'šedá');
  assert.deepEqual(o.nezkontrolovano, ['nabídka', 'bezpečnost']);
  assert.ok(Array.isArray(o.co_delat) && o.co_delat.length > 0);
  assert.deepEqual(o.signaly, []);
  assert.ok(!f.claudeCalls.includes('Claude – extrakce'));
});

test('glue 03: vstup z glue 01 (bez odpovědi LLM, objekt bez content) je selhání extrakce, host kontroly běží', async () => {
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: '', rezim: 'eshop', host: 'clarkscz.cz', obsah: false };
  const { out } = await runGlue('03-moduly.js', { json: ctx, nodes: { 'Vstup a načtení': ctx }, httpStub: hostStub(2019, coiHtml(150)) });
  assert.equal(out.verdict.semafor, 'červená');
  assert.deepEqual(out.verdict.unchecked, ['offer', 'safety']);
});

test('e2e (d): Code node, který vyhodí výjimku, nikdy nevyhodí chybu ven, ale vrátí degradovaný payload', async () => {
  const boom = { $input: { first: () => { throw new Error('tajná chyba /interní/cesta'); } } };
  const nodesBoom = { 'Vstup a načtení': () => { throw new Error('tajná chyba /interní/cesta'); }, Moduly: () => { throw new Error('tajná chyba /interní/cesta'); } };
  const expected = {
    'Vstup a načtení': { zkratka: true, status: 500, odpoved: { stav: 'chyba', chyba: CHYBA_OBECNA_API } },
    'Sestavit extrakci': { llmRequest: null },
    Moduly: null,
    'Odpověď': { status: 500, odpoved: { stav: 'chyba', chyba: CHYBA_OBECNA_API } },
  };
  for (const name of CODE_NODES) {
    for (const o of name === 'Moduly' || name === 'Odpověď' ? [boom, { json: {}, nodes: nodesBoom }] : [boom]) {
      let r;
      await assert.doesNotReject(async () => { r = await runNode(name, o); }, name);
      assert.equal(JSON.stringify(r.out).includes('tajná'), false, name);
      if (expected[name]) assert.deepEqual(r.out, expected[name], name);
      else {
        assert.equal(r.out.verdict.semafor, 'šedá');
        assert.ok(r.out.llmRequest && Array.isArray(r.out.llmRequest.messages));
      }
    }
  }
});

// --- fix wave A: kalibrace verdiktu, viditelnost nedostupných zdrojů ---
const ext = (o) => anthropic({ produkt: {}, prodejce: {}, recenze: {}, obrazky: {}, nerealne_parametry: [], nesoulady: [], ...o });
const rdapIso = (y) => ({ events: [{ eventAction: 'registration', eventDate: y + '-01-01T00:00:00Z' }] });
const sigIds = (o) => o.signaly.map((s) => s.id);
const callsTo = (r, prefix) => r.r3.calls.filter((c) => c.url.startsWith(prefix)).length;
const NOTEBOOK = (o = {}) => ext({
  produkt: { nazev: 'Notebook Lenovo IdeaPad 15', kategorie: 'počítače', cena: 14990, mena: 'CZK' },
  prodejce: { nazev: 'Alza', provozovatel_uveden: true, kontakt_uveden: true }, ...o,
});

test('e2e kalibrace (a): textová nabídka jako z Alzy (katalogové fotky, obecné recenze), bez externího zdroje -> zelená, jistota střední, nikdy červená', async () => {
  for (const cert of [[], ['CE']]) {
    const extract = ext({
      produkt: { nazev: 'Powerbanka Xiaomi 20000 mAh', kategorie: 'elektronika', cena: 899, mena: 'CZK', referencni_cena_odhad: { min: 700, max: 1100, mena: 'CZK' }, tvrzeni_certifikace: cert },
      prodejce: { nazev: 'Alza', provozovatel_uveden: true, kontakt_uveden: true },
      recenze: { pocet: 120, prumer: 4.7, genericke: true }, obrazky: { vypada_ai_nebo_katalog: true },
    });
    const f = await runFlow({ text: 'Powerbanka Xiaomi 20000 mAh, 899 Kč, prodává Alza' }, { extract });
    const o = f.final.odpoved;
    assert.equal(o.semafor, 'zelená', JSON.stringify(sigIds(o)));
    assert.equal(o.jistota, 'střední', 'bez externího zdroje nikdy vysoká');
    assert.notEqual(o.semafor, 'červená');
    assert.deepEqual(o.nezkontrolovano, []);
    assert.ok(o.signaly.every((s) => s.zavaznost === 'info' || s.zavaznost === 'low'), JSON.stringify(o.signaly.map((s) => s.id + ':' + s.zavaznost)));
    assert.ok(sigIds(o).includes('obrazky_ai_katalog'), 'informace se ukazuje');
    assert.equal(sigIds(o).includes('ce_chybi'), cert.length === 0);
  }
});

test('e2e kalibrace (b): kabel jako z Temu (CN, bez kontaktu, 30 prodejů, katalogové fotky, bez CE) -> oranžová, ne červená', async () => {
  const extract = ext({
    produkt: { nazev: 'USB kabel 100W rychlonabíjecí', kategorie: 'elektronika', cena: 99, mena: 'CZK' },
    prodejce: { kontakt_uveden: false, zeme_odeslani: 'CN', pocet_prodeju: 30 }, obrazky: { vypada_ai_nebo_katalog: true },
  });
  const f = await runFlow({ odkaz: 'https://www.temu.com/p', text: 'USB kabel 99 Kč' }, { extract, httpStub: () => ({ statusCode: 403, body: '' }) });
  const o = f.final.odpoved;
  assert.equal(f.r1.out.rezim, 'marketplace');
  assert.equal(o.semafor, 'oranžová', JSON.stringify(sigIds(o)));
  assert.notEqual(o.semafor, 'červená');
  assert.ok(sigIds(o).includes('mimo_eu_bez_kontaktu'));
  assert.equal(o.jistota, 'střední');
});

test('e2e kalibrace (c): poctivý notebook se dvěma nesoulady od LLM -> zelená (a nesoulady jsou vidět)', async () => {
  const extract = NOTEBOOK({ nesoulady: ['Fotka ukazuje jiný model klávesnice', 'Popis uvádí 16 GB RAM, ale parametry 8 GB'] });
  const f = await runFlow({ text: 'Notebook Lenovo IdeaPad 15, 14 990 Kč' }, { extract });
  const o = f.final.odpoved;
  assert.equal(o.semafor, 'zelená');
  assert.equal(sigIds(o).filter((i) => i === 'nesoulad').length, 2);
  assert.equal(o.skore, 2);
});

test('e2e kalibrace (c2): obviňující text od LLM se zahodí už při normalizaci', async () => {
  const extract = NOTEBOOK({ nesoulady: ['Prodejce je podvodník', 'Fotka ukazuje jiný model'], nerealne_parametry: ['Nabídka je podvod'] });
  const f = await runFlow({ text: 'Notebook' }, { extract });
  const o = f.final.odpoved;
  assert.deepEqual(sigIds(o), ['nesoulad']);
  assert.ok(!JSON.stringify(o).includes('podvod'));
});

const coiFailStub = (extra) => (o) => {
  if (o.url.startsWith('https://coi.gov.cz/')) throw new Error('503');
  if (o.url.startsWith('https://rdap.')) return rdapIso(2005);
  return extra ? extra(o) : { statusCode: 403, body: '' };
};

test('e2e kalibrace (d): ČOI nejde stáhnout a není cache, RDAP ok, všechny moduly ok -> nezkontrolovano uvádí seznam ČOI, jistota není vysoká', async () => {
  const f = await runFlow({ odkaz: 'https://example.cz/p', text: 'Notebook' }, { extract: NOTEBOOK(), httpStub: coiFailStub() });
  const o = f.final.odpoved;
  assert.equal(o.stav, 'ok');
  assert.equal(o.semafor, 'zelená');
  assert.deepEqual(o.nezkontrolovano, ['prodejce: seznam ČOI']);
  assert.notEqual(o.jistota, 'vysoká');
  assert.equal(o.jistota, 'střední');
  assert.deepEqual(f.r3.out.verdict.skipped, ['seznam ČOI']);
});

test('e2e kalibrace (d2): všechny zdroje dostupné a moduly ok -> jistota vysoká a nic v nezkontrolovano', async () => {
  const stub = (o) => (o.url.startsWith('https://coi.gov.cz/') ? coiHtml(150) : o.url.startsWith('https://rdap.') ? rdapIso(2005) : { statusCode: 403, body: '' });
  const f = await runFlow({ odkaz: 'https://example.cz/p', text: 'Notebook' }, { extract: NOTEBOOK(), httpStub: stub });
  const o = f.final.odpoved;
  assert.equal(o.semafor, 'zelená');
  assert.equal(o.jistota, 'vysoká');
  assert.deepEqual(o.nezkontrolovano, []);
});

test('e2e kalibrace (e): obnova ČOI selže, ale existuje stará cache (>6 h) s hostem -> pořád červená ze staré cache', async () => {
  const stale = { at: Date.now() - 24 * 3600 * 1000, list: { 'clarkscz.cz': 'Provozovatel není uveden.' } };
  const state0 = { coi: { ...stale } };
  const f0 = await runFlow({ odkaz: 'https://clarkscz.cz/x' }, { httpStub: coiFailStub(), state: state0 });
  const o0 = f0.final.odpoved;
  assert.equal(o0.semafor, 'červená');
  assert.ok(sigIds(o0).includes('coi_seznam'));
  assert.ok(o0.nezkontrolovano.includes('prodejce: seznam ČOI (neaktuální)'), o0.nezkontrolovano.join());
  assert.deepEqual(f0.r3.out.verdict.skipped, ['seznam ČOI (neaktuální)']);
  assert.notEqual(o0.jistota, 'vysoká');
  assert.equal(callsTo(f0, 'https://coi.gov.cz/'), 1, 'obnova se zkusila');
  assert.equal(state0.coi.at, stale.at, 'stará cache zůstala');
  // obnova vrátí nepoužitelnou stránku (málo záznamů): stará cache se použije také
  const state = { coi: { ...stale } };
  const f = await runFlow({ odkaz: 'https://clarkscz.cz/x' }, { httpStub: (o) => (o.url.startsWith('https://coi.gov.cz/') ? '<html>změněná stránka</html>' : o.url.startsWith('https://rdap.') ? rdapIso(2005) : { statusCode: 403, body: '' }), state });
  assert.equal(f.final.odpoved.semafor, 'červená');
  assert.equal(state.coi.at, stale.at);
  assert.ok(f.final.odpoved.nezkontrolovano.includes('prodejce: seznam ČOI (neaktuální)'));
});

test('e2e kalibrace (e2): čerstvá cache (<6 h) se nepřeobnovuje', async () => {
  const state = { coi: { at: Date.now() - 3600 * 1000, list: { 'clarkscz.cz': 'x' } } };
  const f = await runFlow({ odkaz: 'https://clarkscz.cz/x' }, { httpStub: coiFailStub(), state });
  assert.equal(callsTo(f, 'https://coi.gov.cz/'), 0);
  assert.equal(f.final.odpoved.semafor, 'červená');
  assert.deepEqual(f.r3.out.verdict.skipped, [], 'čerstvá cache nic nepřidává do skipped');
  assert.ok(!f.final.odpoved.nezkontrolovano.some((x) => x.includes('ČOI')));
});

test('e2e kalibrace (f): ARES vrátí 404 pro IČO s platným kontrolním číslem -> jen low signál, žádná červená', async () => {
  const extract = NOTEBOOK({ prodejce: { nazev: 'Slovenská firma', ico: '27082440', provozovatel_uveden: true, kontakt_uveden: true } });
  const stub = (o) => (o.url.startsWith('https://coi.gov.cz/') ? coiHtml(150) : o.url.startsWith('https://rdap.') ? rdapIso(2005) : o.url.startsWith('https://ares.gov.cz/') ? { statusCode: 404, body: {} } : { statusCode: 403, body: '' });
  const f = await runFlow({ odkaz: 'https://example.cz/p', text: 'Notebook' }, { extract, httpStub: stub });
  const o = f.final.odpoved;
  const ne = o.signaly.find((s) => s.id === 'ico_neexistuje');
  assert.ok(ne, sigIds(o).join());
  assert.equal(ne.zavaznost, 'low');
  assert.match(ne.dukaz, /zahraničních/);
  assert.notEqual(o.semafor, 'červená');
  assert.equal(o.semafor, 'zelená');
});

test('glue 03 kalibrace (g): ČOI, RDAP a ARES se požadují souběžně (všechna volání začnou dřív, než některé skončí) a s kratšími timeouty', async () => {
  const started = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const stub = (o) => {
    if (o.url.startsWith('https://coi.gov.cz/')) { started.push('coi'); return gate.then(() => coiHtml(150)); }
    if (o.url.startsWith('https://rdap.')) { started.push('rdap'); return gate.then(() => rdapIso(2005)); }
    if (o.url.startsWith('https://ares.gov.cz/')) { started.push('ares'); return gate.then(() => ({ statusCode: 404, body: {} })); }
    throw new Error('neočekávaný požadavek ' + o.url);
  };
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: 'x', rezim: 'eshop', host: 'example.cz' };
  const extract = NOTEBOOK({ prodejce: { ico: '27082440', kontakt_uveden: true } });
  const p = runGlue('03-moduly.js', { json: extract, nodes: { 'Vstup a načtení': ctx }, state: {}, httpStub: stub });
  const t0 = Date.now();
  while (started.length < 3 && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(started.slice().sort(), ['ares', 'coi', 'rdap'], 'před uvolněním musí běžet všechny tři');
  release();
  const { out, calls } = await p;
  assert.deepEqual(out.verdict.skipped, []);
  assert.equal(out.verdict.confidence, 'vysoká');
  const timeoutOf = (prefix) => calls.find((c) => c.url.startsWith(prefix)).timeout;
  assert.equal(timeoutOf('https://rdap.'), 6000);
  assert.equal(timeoutOf('https://ares.gov.cz/'), 6000);
  assert.equal(timeoutOf('https://coi.gov.cz/'), 10000);
});

test('glue 03 kalibrace: verdikt nese skipped a Moduly neposílají dál nic navíc', async () => {
  const ctx = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: 'x', rezim: 'eshop', host: 'example.cz' };
  const { out } = await runGlue('03-moduly.js', { json: NOTEBOOK(), nodes: { 'Vstup a načtení': ctx }, state: {}, httpStub: coiFailStub() });
  assert.deepEqual(Object.keys(out).sort(), ['llmRequest', 'signals', 'verdict']);
  assert.deepEqual(Object.keys(out.verdict).sort(), ['confidence', 'score', 'semafor', 'skipped', 'unchecked']);
  assert.deepEqual(out.verdict.skipped, ['seznam ČOI']);
  assert.deepEqual(JSON.parse(out.llmRequest.messages[0].content).nezkontrolovano, ['prodejce: seznam ČOI']);
});

// --- fix wave A, round 1: wall-clock deadline pro ČOI, RDAP a ARES ---
const DEADLINE_CONSTS = ['COI_DEADLINE_MS', 'RDAP_DEADLINE_MS', 'ARES_DEADLINE_MS'];
const withShortDeadlines = (src, ms = 40) => DEADLINE_CONSTS.reduce((acc, name) => {
  const re = new RegExp('const ' + name + ' = \\d+;');
  assert.match(acc, re, 'chybí konstanta ' + name);
  return acc.replace(re, 'const ' + name + ' = ' + ms + ';');
}, src);
const DL_CTX = { zkratka: false, input: { text: '', screenshoty: [], url: {} }, pageText: 'x', rezim: 'eshop', host: 'example.cz' };
const DL_EXTRACT = () => NOTEBOOK({ prodejce: { ico: '27082440', kontakt_uveden: true } });
const hang = () => new Promise(() => {});
// stub: všechny zdroje v pořádku, kromě těch v `hung` (nevracejí se nikdy)
const dlStub = (hung) => (o) => {
  const key = o.url.startsWith('https://coi.gov.cz/') ? 'coi' : o.url.startsWith('https://rdap.') ? 'rdap' : o.url.startsWith('https://ares.gov.cz/') ? 'ares' : null;
  if (!key) throw new Error('neočekávaný požadavek ' + o.url);
  if (hung.includes(key)) return hang();
  if (key === 'coi') return coiHtml(150);
  if (key === 'rdap') return rdapIso(2005);
  return { statusCode: 200, body: { obchodniJmeno: 'X' } };
};
const nezk = async (modulyOut) => (await runGlue('04-odpoved.js', { json: { error: {} }, nodes: { Moduly: modulyOut } })).out.odpoved.nezkontrolovano;

test('glue 03: konstanty deadline na začátku (ČOI 10000, RDAP 6500, ARES 6500)', () => {
  const src = nodeCode('Moduly');
  assert.match(src, /const COI_DEADLINE_MS = 10000;/);
  assert.match(src, /const RDAP_DEADLINE_MS = 6500;/);
  assert.match(src, /const ARES_DEADLINE_MS = 6500;/);
});

for (const [key, label] of [['coi', 'seznam ČOI'], ['rdap', 'RDAP (stáří domény)'], ['ares', 'ARES']]) {
  test('glue 03 deadline: nikdy se nevracející ' + label + ' skončí do deadline a je v nezkontrolovano', async () => {
    const src = withShortDeadlines(nodeCode('Moduly'));
    const t0 = Date.now();
    const { out, calls } = await runGlue('03-moduly.js', { json: DL_EXTRACT(), nodes: { 'Vstup a načtení': DL_CTX }, state: {}, httpStub: dlStub([key]), src });
    assert.ok(Date.now() - t0 < 1000, 'deadline nezabral');
    assert.equal(calls.filter((c) => c.url.includes(key === 'coi' ? 'coi.gov.cz' : key === 'rdap' ? 'rdap.' : 'ares.gov.cz')).length, 1);
    assert.deepEqual(out.verdict.skipped, [label]);
    assert.notEqual(out.verdict.confidence, 'vysoká');
    assert.ok(out.verdict && out.llmRequest);
    assert.deepEqual(await nezk(out), ['prodejce: ' + label]);
  });
}

test('glue 03 deadline: všechny tři zdroje visí -> celý běh skončí do deadline, všechny tři v nezkontrolovano', async () => {
  const src = withShortDeadlines(nodeCode('Moduly'));
  const t0 = Date.now();
  const { out } = await runGlue('03-moduly.js', { json: DL_EXTRACT(), nodes: { 'Vstup a načtení': DL_CTX }, state: {}, httpStub: dlStub(['coi', 'rdap', 'ares']), src });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(out.verdict.skipped, ['RDAP (stáří domény)', 'seznam ČOI', 'ARES']);
  assert.deepEqual(await nezk(out), ['prodejce: RDAP (stáří domény)', 'prodejce: seznam ČOI', 'prodejce: ARES']);
});

test('glue 03 deadline: ČOI visí a existuje stará cache -> použije se stará cache (hit = červená), zdroj je neaktuální', async () => {
  const src = withShortDeadlines(nodeCode('Moduly'));
  const ctx = { ...DL_CTX, host: 'clarkscz.cz' };
  const state = { coi: { at: Date.now() - 24 * 3600 * 1000, list: { 'clarkscz.cz': 'Provozovatel není uveden.' } } };
  const { out } = await runGlue('03-moduly.js', { json: DL_EXTRACT(), nodes: { 'Vstup a načtení': ctx }, state, httpStub: dlStub(['coi']), src });
  assert.equal(out.verdict.semafor, 'červená');
  assert.ok(out.signals.some((s) => s.id === 'coi_seznam'));
  assert.deepEqual(out.verdict.skipped, ['seznam ČOI (neaktuální)']);
  assert.notEqual(out.verdict.confidence, 'vysoká');
});

test('glue 03 deadline: pozdní odmítnutí opuštěného requestu nevyvolá unhandled rejection', async () => {
  const src = withShortDeadlines(nodeCode('Moduly'), 20);
  const late = () => new Promise((_, rej) => setTimeout(() => rej(new Error('pozdě')), 80));
  const stub = (o) => (o.url.startsWith('https://coi.gov.cz/') || o.url.startsWith('https://rdap.') || o.url.startsWith('https://ares.gov.cz/') ? late() : { statusCode: 403, body: '' });
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const { out } = await runGlue('03-moduly.js', { json: DL_EXTRACT(), nodes: { 'Vstup a načtení': DL_CTX }, state: {}, httpStub: stub, src });
    assert.deepEqual(out.verdict.skipped, ['RDAP (stáří domény)', 'seznam ČOI', 'ARES']);
    await new Promise((r) => setTimeout(r, 200));
  } finally { process.off('unhandledRejection', onRej); }
  assert.deepEqual(seen, []);
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
function makeFakeDom(opts = {}) {
  const all = [];
  const byId = {};
  const log = opts.log || [];
  const ctx2d = {
    set fillStyle(v) { log.push('fillStyle:' + v); },
    fillRect() { log.push('fillRect'); },
    drawImage() { log.push('drawImage'); },
  };
  class FakeEl {
    constructor(tag) {
      this.tagName = tag; this.children = []; this.textContent = ''; this.className = '';
      this.attrs = {}; this.htmlWrites = 0; this.files = []; this.value = ''; this.disabled = false; this.listeners = {};
      all.push(this);
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    getContext() { return opts.noCtx ? null : ctx2d; }
    toDataURL() { return opts.dataUrl !== undefined ? opts.dataUrl : 'data:image/jpeg;base64,' + 'A'.repeat(200); }
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
// opts: noCtx (canvas bez 2d kontextu), dataUrl (co vrátí toDataURL), imgError (Image.onerror), fetchFail (síťová chyba)
function loadPage(opts = {}) {
  const m = /<script>([\s\S]*?)<\/script>/.exec(pageHtml());
  assert.ok(m, 'chybí <script>');
  const log = [];
  const dom = makeFakeDom({ log, noCtx: opts.noCtx, dataUrl: opts.dataUrl });
  const fetchCalls = [];
  class FakeImage {
    constructor() { this.width = 800; this.height = 600; }
    set src(v) {
      setTimeout(() => {
        try {
          if (opts.imgError) { if (this.onerror) this.onerror(); } else if (this.onload) this.onload();
        } catch (e) { log.push('threw:' + e.message); }
      }, 0);
    }
  }
  class FakeURL extends URL {
    static createObjectURL() { return 'blob:test'; }
    static revokeObjectURL(u) { log.push('revoke:' + u); }
  }
  const ctx = vm.createContext({
    document: dom.document, location: { href: opts.href || 'http://x/webhook/nakupni-kontrola-web' }, URL: FakeURL, Image: FakeImage, console,
    fetch: async (...args) => { fetchCalls.push(args); if (opts.fetchFail) throw new Error('síť'); return { json: async () => ({}) }; },
  });
  vm.runInContext(m[1] + '\n;this.__render = render; this.__toJpegBase64 = toJpegBase64; this.__apiUrl = apiUrl; this.__API = API;', ctx);
  return { render: ctx.__render, toJpeg: ctx.__toJpegBase64, apiUrl: ctx.__apiUrl, API: ctx.__API, dom, log, fetchCalls };
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
  assert.ok(texts(dom.document.getElementById('out')).includes('Vysoké riziko'));
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

// --- oprava 1: kontrast, zpracování obrázků, whitelist tříd, CSS ---
// Promise může ve staré verzi viset (výjimka uvnitř onload), proto každé čekání má strop.
async function settle(p, ms = 300) {
  let t;
  const timeout = new Promise((resolve) => { t = setTimeout(() => resolve({ timeout: true }), ms); });
  try {
    return await Promise.race([p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })), timeout]);
  } finally { clearTimeout(t); }
}
const ALLOWED_CLASSES = new Set(['', 'card', 'light', 'sig', 'err', 'hint', 'zelená', 'oranžová', 'červená', 'šedá', 'high', 'medium', 'low', 'info', 'sev']);
const CHYBA_ZPRACOVANI = 'Obrázek se nepodařilo zpracovat.';
const CHYBA_NACTENI = 'Obrázek se nepodařilo načíst.';

test('toJpegBase64: getContext vrátí null -> reject s hláškou o zpracování, objectURL se uvolní', async () => {
  const { toJpeg, log } = loadPage({ noCtx: true });
  const r = await settle(toJpeg({ name: 'a.jpg' }));
  assert.ok(!r.timeout, 'promise visí');
  assert.equal(r.ok, false);
  assert.equal(r.error.message, CHYBA_ZPRACOVANI);
  assert.ok(log.includes('revoke:blob:test'));
});

test('toJpegBase64: prázdný data URL ("data:,") -> reject', async () => {
  const { toJpeg, log } = loadPage({ dataUrl: 'data:,' });
  const r = await settle(toJpeg({ name: 'a.jpg' }));
  assert.ok(!r.timeout, 'promise visí');
  assert.equal(r.ok, false);
  assert.equal(r.error.message, CHYBA_ZPRACOVANI);
  assert.ok(log.includes('revoke:blob:test'));
});

test('toJpegBase64: data URL jiného typu než image/jpeg -> reject', async () => {
  const { toJpeg } = loadPage({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(200) });
  const r = await settle(toJpeg({ name: 'a.png' }));
  assert.equal(r.ok, false);
  assert.equal(r.error.message, CHYBA_ZPRACOVANI);
});

test('toJpegBase64: šťastná cesta -> JPEG base64, plátno se nejdřív vyplní bílou', async () => {
  const { toJpeg, log } = loadPage();
  const r = await settle(toJpeg({ name: 'a.jpg' }));
  assert.equal(r.ok, true, r.error && r.error.message);
  assert.equal(r.value.mime, 'image/jpeg');
  assert.equal(r.value.data, 'A'.repeat(200));
  const fill = log.indexOf('fillStyle:#fff');
  const rect = log.indexOf('fillRect');
  const draw = log.indexOf('drawImage');
  assert.ok(fill >= 0 && rect > fill && draw > rect, 'pořadí: ' + log.join(','));
  assert.ok(log.includes('revoke:blob:test'));
});

test('toJpegBase64: onerror -> reject s hláškou o načtení a objectURL se uvolní', async () => {
  const { toJpeg, log } = loadPage({ imgError: true });
  const r = await settle(toJpeg({ name: 'a.jpg' }));
  assert.ok(!r.timeout, 'promise visí');
  assert.equal(r.ok, false);
  assert.equal(r.error.message, CHYBA_NACTENI);
  assert.ok(log.includes('revoke:blob:test'));
});

async function submitPage(opts, files) {
  const p = loadPage(opts);
  p.dom.byId.shots.files = files;
  const r = await settle(p.dom.byId.f.listeners.submit({ preventDefault() {} }));
  assert.ok(!r.timeout, 'submit se nedokončil');
  return { ...p, go: p.dom.byId.go, out: p.dom.byId.out };
}

test('submit: chyba zpracování obrázku ukáže konkrétní hlášku, tlačítko se povolí, fetch se nevolá', async () => {
  const { out, go, fetchCalls } = await submitPage({ noCtx: true }, [{ name: 'a.png' }]);
  const t = texts(out);
  assert.ok(t.includes(CHYBA_ZPRACOVANI), t.join(' | '));
  assert.ok(!t.includes(CHYBA_OBECNA));
  assert.equal(go.disabled, false);
  assert.equal(go.textContent, 'Zkontrolovat');
  assert.equal(fetchCalls.length, 0);
});

test('submit: chyba načtení obrázku ukáže konkrétní hlášku', async () => {
  const { out, go } = await submitPage({ imgError: true }, [{ name: 'a.png' }]);
  assert.ok(texts(out).includes(CHYBA_NACTENI));
  assert.equal(go.disabled, false);
});

test('submit: síťová chyba ukáže obecnou hlášku a tlačítko se povolí', async () => {
  const { out, go } = await submitPage({ fetchFail: true }, []);
  assert.ok(texts(out).includes(CHYBA_OBECNA));
  assert.equal(go.disabled, false);
  assert.equal(go.textContent, 'Zkontrolovat');
});

test('change: více než 4 soubory -> upozornění, zkontrolují se první 4', async () => {
  const { dom } = loadPage();
  dom.byId.shots.files = [1, 2, 3, 4, 5, 6];
  dom.byId.shots.listeners.change();
  assert.match(dom.byId.limit.textContent, /6 souborů/);
  assert.match(dom.byId.limit.textContent, /prvních 4/);
});

test('render: nepovolené semafor/závažnost se nahradí šedou/low, třídy jsou jen z whitelistu', () => {
  const { render, dom } = loadPage();
  render({ stav: 'ok', semafor: 'card err', shrnuti: 'x', co_delat: [], signaly: [{ zavaznost: 'zelená zelená', titul: 'T', dukaz: 'D', modul: 'M' }] });
  const badge = dom.all.find((n) => n.className.startsWith('light'));
  assert.equal(badge.className, 'light šedá');
  assert.equal(badge.textContent, 'Nelze posoudit');
  const sig = dom.all.find((n) => n.className.startsWith('sig'));
  assert.equal(sig.className, 'sig low');
  for (const n of dom.all) for (const t of n.className.split(' ')) assert.ok(ALLOWED_CLASSES.has(t), 'nepovolená třída: ' + t);
});

test('render: povolený semafor se zobrazí beze změny', () => {
  const { render, dom } = loadPage();
  render({ stav: 'ok', semafor: 'zelená', shrnuti: 'x', co_delat: [], signaly: [{ zavaznost: 'high', titul: 'T', dukaz: 'D', modul: 'M' }] });
  const badge = dom.all.find((n) => n.className.startsWith('light'));
  assert.equal(badge.className, 'light zelená');
  assert.equal(badge.textContent, 'Nízké riziko');
  assert.equal(dom.all.find((n) => n.className.startsWith('sig')).className, 'sig high');
});

test('render: závažnost info má třídu sig info a všechny závažnosti mají viditelný textový štítek', () => {
  const labels = { info: 'Informace', low: 'Nízká', medium: 'Střední', high: 'Vysoká' };
  for (const [zavaznost, label] of Object.entries(labels)) {
    const { render, dom } = loadPage();
    render({ stav: 'ok', semafor: 'zelená', shrnuti: 'x', co_delat: [], signaly: [{ zavaznost, titul: 'Titul ' + zavaznost, dukaz: 'D', modul: 'M' }] });
    const sig = dom.all.find((n) => n.className.startsWith('sig'));
    assert.equal(sig.className, 'sig ' + zavaznost);
    const t = texts(sig);
    assert.ok(t.includes(label), zavaznost + ': chybí štítek ' + label + ' v ' + t.join(' | '));
    assert.ok(t.includes('Titul ' + zavaznost));
    const sev = sig.children.find((c) => c.className === 'sev');
    assert.ok(sev && sev.textContent === label, 'štítek má třídu sev');
    for (const n of dom.all) for (const c of n.className.split(' ')) assert.ok(ALLOWED_CLASSES.has(c), 'nepovolená třída: ' + c);
  }
});

test('render: neznámá závažnost se zobrazí jako Nízká (třída low), ne jako surová hodnota', () => {
  const { render, dom } = loadPage();
  render({ stav: 'ok', semafor: 'zelená', shrnuti: 'x', co_delat: [], signaly: [{ zavaznost: 'critical <b>', titul: 'T', dukaz: 'D', modul: 'M' }] });
  const sig = dom.all.find((n) => n.className.startsWith('sig'));
  assert.equal(sig.className, 'sig low');
  assert.ok(texts(sig).includes('Nízká'));
  assert.ok(!texts(sig).some((x) => x.includes('critical')));
});

test('CSS: .sig.info má tlumené ohraničení', () => {
  assert.match(cssOf(), /\.sig\.info\s*\{[^}]*border-color:\s*var\(--muted\)/);
});

function cssOf() { return /<style>([\s\S]*?)<\/style>/.exec(pageHtml())[1]; }
function tokensOf(block) {
  const t = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/g)) t[m[1]] = m[2];
  return t;
}
function lumOf(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrastOf(a, b) {
  const x = lumOf(a), y = lumOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('kontrast: text --on na odznacích a tlačítku má poměr >= 4.5 v obou tématech (WCAG)', () => {
  const css = cssOf();
  const light = tokensOf(/:root\s*\{([^}]*)\}/.exec(css)[1]);
  const darkM = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(darkM, 'chybí tmavé téma');
  const dark = { ...light, ...tokensOf(darkM[1]) };
  const bgToken = {};
  for (const m of css.matchAll(/\.([^\s{,:]+)\s*\{\s*background:\s*var\(--(\w+)\)/g)) bgToken[m[1]] = m[2];
  assert.match(css, /\.light \{[^}]*color:\s*var\(--on\)/);
  assert.match(css, /button \{[^}]*color:\s*var\(--on\)/);
  assert.match(css, /button \{[^}]*background:\s*var\(--accent\)/);
  const pairs = ['zelená', 'oranžová', 'červená', 'šedá'].map((c) => bgToken[c]).concat(['accent']);
  assert.equal(pairs.filter(Boolean).length, 5, 'chybí mapování třída -> pozadí');
  for (const [name, t] of [['světlé', light], ['tmavé', dark]]) {
    assert.ok(t.on, name + ': chybí --on');
    for (const tok of pairs) {
      assert.ok(t[tok], name + ': chybí --' + tok);
      const ratio = contrastOf(t[tok], t.on);
      assert.ok(ratio >= 4.5, name + ' --' + tok + ' vs --on: ' + ratio.toFixed(2));
    }
  }
});

test('CSS: color-scheme light dark na :root a overflow-wrap:anywhere pro .card, .sig a p', () => {
  const css = cssOf();
  assert.match(css, /:root\s*\{[^}]*color-scheme:\s*light dark/);
  assert.match(css, /\.card,\s*\.sig,\s*p\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

// --- fix wave B: adresa API (M1), soukromí a zdroje (M2), srozumitelné štítky verdiktu a nápověda (M3) ---
test('apiUrl: poslední segment nakupni-kontrola-web se nahradí; query, hash i koncová lomítka se zahodí', () => {
  const { apiUrl } = loadPage();
  const cases = [
    ['http://x/webhook/nakupni-kontrola-web', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook/nakupni-kontrola-web/', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook/nakupni-kontrola-web///', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook/nakupni-kontrola-web?a=1#b', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook/nakupni-kontrola-web/?a=1#b', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook/nakupni-kontrola-web#b', 'http://x/webhook/nakupni-kontrola'],
    ['http://x/webhook-test/nakupni-kontrola-web', 'http://x/webhook-test/nakupni-kontrola'],
    ['https://n8n.example.org:5678/webhook-test/nakupni-kontrola-web/?x=/y/z', 'https://n8n.example.org:5678/webhook-test/nakupni-kontrola'],
    ['https://host/prefix/webhook/nakupni-kontrola-web', 'https://host/prefix/webhook/nakupni-kontrola'],
  ];
  for (const [href, want] of cases) assert.equal(apiUrl(href), want, href);
});

test('apiUrl: adresa bez cesty nevyhodí výjimku a nepoškodí hostitele', () => {
  const { apiUrl } = loadPage();
  assert.equal(apiUrl('http://x'), 'http://x/nakupni-kontrola');
  assert.equal(apiUrl('http://x/'), 'http://x/nakupni-kontrola');
  assert.doesNotThrow(() => apiUrl(undefined));
});

test('stránka volá API na adrese odvozené z location (včetně lomítka na konci) a posílá POST', async () => {
  const p = await submitPage({ href: 'http://x/webhook-test/nakupni-kontrola-web/?a=1#b' }, []);
  assert.equal(p.API, 'http://x/webhook-test/nakupni-kontrola');
  assert.equal(p.fetchCalls.length, 1);
  assert.equal(p.fetchCalls[0][0], 'http://x/webhook-test/nakupni-kontrola');
  assert.equal(p.fetchCalls[0][1].method, 'POST');
});

test('stránka: poznámka o soukromí zmiňuje odeslání službě Claude (Anthropic) a zdroje dat; bez odkazů', () => {
  const html = pageHtml();
  assert.ok(html.includes('Screenshoty ani texty neukládáme. Pro vyhodnocení se odesílají službě Claude (Anthropic).'));
  assert.ok(html.includes('Zdroje dat: seznam rizikových e-shopů ČOI, ARES, RDAP (CZ.NIC), EU Safety Gate © Evropská unie (CC BY 4.0).'));
  assert.equal(/https?:\/\//.test(html), false);
  assert.equal(/<a\b/i.test(html), false);
});

test('stránka: u tlačítka je viditelná nápověda o délce kontroly a při čekání se ukazuje Kontroluji…', async () => {
  const html = pageHtml();
  const btn = html.indexOf('id="go"');
  const hint = html.indexOf('Kontrola může trvat až 30 sekund.');
  assert.ok(btn > 0 && hint > btn && hint - btn < 300, 'nápověda hned za tlačítkem');
  assert.match(html, /<p[^>]*class="hint"[^>]*>Kontrola může trvat až 30 sekund\./);
  const p = loadPage();
  p.dom.byId.shots.files = [];
  const done = p.dom.byId.f.listeners.submit({ preventDefault() {} });
  assert.equal(p.dom.byId.go.textContent, 'Kontroluji…');
  assert.equal(p.dom.byId.go.disabled, true);
  await settle(done);
  assert.equal(p.dom.byId.go.textContent, 'Zkontrolovat');
});

test('render: štítek verdiktu je srozumitelný text pro každý semafor a odpovídá barevné třídě', () => {
  const want = { 'zelená': 'Nízké riziko', 'oranžová': 'Střední riziko', 'červená': 'Vysoké riziko', 'šedá': 'Nelze posoudit' };
  for (const [semafor, label] of Object.entries(want)) {
    const { render, dom } = loadPage();
    render({ stav: 'ok', semafor, shrnuti: 'x', co_delat: [], signaly: [] });
    const badge = dom.all.find((n) => n.className.startsWith('light'));
    assert.equal(badge.className, 'light ' + semafor);
    assert.equal(badge.textContent, label);
    assert.ok(!/Riziko:/.test(badge.textContent));
    for (const n of dom.all) for (const c of n.className.split(' ')) assert.ok(ALLOWED_CLASSES.has(c), 'nepovolená třída: ' + c);
  }
});

test('render: štítek verdiktu se nikdy nebere z odpovědi (XSS, neznámý nebo vnořený semafor -> Nelze posoudit)', () => {
  for (const semafor of ['<img src=x onerror=alert(1)>', 'červená červená', '__proto__', 'constructor', 'toString', {}, ['červená'], null, 5]) {
    const { render, dom } = loadPage();
    render({ stav: 'ok', semafor, shrnuti: 'x', co_delat: [], signaly: [] });
    const badge = dom.all.find((n) => n.className.startsWith('light'));
    assert.equal(badge.className, 'light šedá', JSON.stringify(semafor));
    assert.equal(badge.textContent, 'Nelze posoudit', JSON.stringify(semafor));
    assert.equal(dom.all.filter((n) => n.htmlWrites > 0).length, 0);
  }
});
