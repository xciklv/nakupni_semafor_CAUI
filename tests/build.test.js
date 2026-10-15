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

test('engine/*.js nemají duplicitní top-level deklarace (bundle je jeden scope)', () => {
  const seen = new Map();
  const dup = new Set();
  const re = /^(?:async\s+)?(?:const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/;
  for (const f of fs.readdirSync(path.join(root, 'engine')).filter((n) => n.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(root, 'engine', f), 'utf8').split('\n')) {
      if (/^if \(typeof (require|module) !== 'undefined'/.test(line)) continue;
      const m = re.exec(line);
      if (!m) continue;
      if (seen.has(m[1]) && seen.get(m[1]) !== f) dup.add(m[1] + ' (' + seen.get(m[1]) + ', ' + f + ')');
      else if (seen.has(m[1])) dup.add(m[1] + ' (opakuje se v ' + f + ')');
      seen.set(m[1], f);
    }
  }
  assert.deepEqual([...dup], [], 'duplicitní top-level názvy: ' + [...dup].join(', '));
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
});

// --- behavior glue 01 ve vm sandboxu ---
const STUB_BUNDLE = buildBundle();
async function runGlue01(body, { state = {}, httpStub } = {}) {
  const calls = [];
  const ctx = vm.createContext({
    URL, console,
    $input: { first: () => ({ json: { body } }) },
    $getWorkflowStaticData: () => state,
  });
  const fn = vm.runInContext('(async function(){' + STUB_BUNDLE + '\n' + glueSrc('01-vstup.js') + '\n})', ctx);
  const self = { helpers: { httpRequest: async (opts) => { calls.push(opts); return httpStub ? httpStub(opts) : { statusCode: 200, body: '' }; } } };
  const out = await fn.call(self);
  return { out: JSON.parse(JSON.stringify(out))[0].json, calls, state };
}

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
