const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeExecutions, parseArgs, resolveWorkflowIds, main, WORKFLOW_IDS, WORKFLOW_NAMES, WORKFLOWS } = require('../tools/purge-executions');

const KEY = 'tajny-klic-n8n-12345';
const BASE = 'http://127.0.0.1:5678';

const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Falešné n8n API: průběhy po workflow, stránkování po `pageSize`, záznam všech volání.
function fakeN8n({ executions, pageSize = 100, failDelete = [] }) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, headers: opts.headers || {} });
    const u = new URL(url);
    if (method === 'GET' && u.pathname === '/api/v1/executions') {
      const wf = u.searchParams.get('workflowId');
      const all = executions[wf] || [];
      const start = Number(u.searchParams.get('cursor') || 0);
      const limit = Math.min(Number(u.searchParams.get('limit')), pageSize);
      const data = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return resp(200, { data, nextCursor: next });
    }
    if (method === 'DELETE') {
      const id = u.pathname.split('/').pop();
      if (failDelete.includes(id)) return resp(500, { message: `Interní chyba, klíč ${KEY}` });
      return resp(200, { id });
    }
    return resp(404, {});
  };
  return { fetchImpl, calls };
}

const makeExecs = (n, from = 1, ageH = 1) => Array.from({ length: n }, (_, i) => ({ id: from + i, startedAt: hoursAgo(ageH) }));
const deleted = (calls) => calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop());

test('konstanty: ID obou workflow Nákupního semaforu', () => {
  assert.deepEqual(WORKFLOW_IDS, ['mHufaoyMTJDT3vQG', 'nkWebStrankaV1x7q']);
});

test('stránkování: dvě stránky po 100 a 20 průběhů dají nalezeno 120', async () => {
  const { fetchImpl, calls } = fakeN8n({ executions: { w1: makeExecs(120) } });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], fetchImpl });
  assert.equal(r.nalezeno, 120);
  const lists = calls.filter((c) => c.method === 'GET');
  assert.equal(lists.length, 2);
  assert.ok(lists[0].url.includes('workflowId=w1') && lists[0].url.includes('limit=100'));
  assert.ok(lists[1].url.includes('cursor='));
  assert.ok(lists.every((c) => c.url.startsWith(`${BASE}/api/v1/executions?`)));
  assert.ok(calls.every((c) => c.headers['X-N8N-API-KEY'] === KEY));
});

test('více workflow: průběhy se sčítají', async () => {
  const { fetchImpl } = fakeN8n({ executions: { a: makeExecs(3, 1), b: makeExecs(2, 10) } });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['a', 'b'], fetchImpl });
  assert.equal(r.nalezeno, 5);
});

test('dryRun (výchozí) nevolá DELETE', async () => {
  const { fetchImpl, calls } = fakeN8n({ executions: { w1: makeExecs(5) } });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], fetchImpl });
  assert.deepEqual(r, { nalezeno: 5, smazano: 0, chyby: [] });
  assert.equal(deleted(calls).length, 0);
});

test('dryRun: false smaže přesně nalezené', async () => {
  const { fetchImpl, calls } = fakeN8n({ executions: { w1: makeExecs(120, 1000) } });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], dryRun: false, fetchImpl });
  assert.equal(r.nalezeno, 120);
  assert.equal(r.smazano, 120);
  assert.deepEqual(r.chyby, []);
  const ids = deleted(calls).map(Number).sort((a, b) => a - b);
  assert.deepEqual(ids, makeExecs(120, 1000).map((e) => e.id));
  assert.ok(calls.filter((c) => c.method === 'DELETE').every((c) => c.url.startsWith(`${BASE}/api/v1/executions/`)));
});

test('olderThanHours: 24 smaže jen starší průběhy', async () => {
  const executions = { w1: [
    { id: 1, startedAt: hoursAgo(48) },
    { id: 2, startedAt: hoursAgo(2) },
    { id: 3, startedAt: hoursAgo(30) },
    { id: 4, startedAt: null },
    { id: 5, startedAt: 'nesmysl' },
  ] };
  const { fetchImpl, calls } = fakeN8n({ executions });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], olderThanHours: 24, dryRun: false, fetchImpl });
  assert.equal(r.nalezeno, 2);
  assert.equal(r.smazano, 2);
  assert.deepEqual(deleted(calls).sort(), ['1', '3']);
});

test('baseUrl mimo 127.0.0.1 a localhost vyhodí chybu a nic nevolá', async () => {
  for (const baseUrl of ['https://evil.example', 'http://127.0.0.1.evil.example', 'http://evil.example/127.0.0.1', 'http://user@evil.example', 'ftp://127.0.0.1', 'neni-url']) {
    let called = 0;
    await assert.rejects(
      purgeExecutions({ baseUrl, apiKey: KEY, workflowIds: ['w1'], fetchImpl: async () => { called++; return resp(200, { data: [] }); } }),
      (e) => { assert.ok(!e.message.includes(KEY)); return true; },
      baseUrl,
    );
    assert.equal(called, 0, baseUrl);
  }
  for (const baseUrl of ['http://localhost:5678', 'http://127.0.0.1:5678/', 'http://127.0.0.1:5678']) {
    const { fetchImpl } = fakeN8n({ executions: {} });
    await purgeExecutions({ baseUrl, apiKey: KEY, workflowIds: ['w1'], fetchImpl });
  }
});

test('chyba při jednom smazání se zapíše do chyby, ostatní se smažou, klíč v chybě není', async () => {
  const { fetchImpl, calls } = fakeN8n({ executions: { w1: makeExecs(4, 1) }, failDelete: ['2'] });
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], dryRun: false, fetchImpl });
  assert.equal(r.nalezeno, 4);
  assert.equal(r.smazano, 3);
  assert.equal(r.chyby.length, 1);
  assert.ok(r.chyby[0].includes('2') && r.chyby[0].includes('500'));
  assert.equal(deleted(calls).length, 4);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('výjimka z fetch při mazání se zapíše do chyby bez klíče', async () => {
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'DELETE') throw new Error(`ECONNRESET při volání s klíčem ${KEY}`);
    return resp(200, { data: [{ id: 1, startedAt: hoursAgo(1) }], nextCursor: null });
  };
  const r = await purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], dryRun: false, fetchImpl });
  assert.equal(r.smazano, 0);
  assert.equal(r.chyby.length, 1);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('chyba při výpisu vyhodí výjimku bez klíče', async () => {
  for (const fetchImpl of [
    async () => resp(401, { message: `špatný klíč ${KEY}` }),
    async () => { throw new Error(`connect ECONNREFUSED, hlavička ${KEY}`); },
  ]) {
    await assert.rejects(
      purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], fetchImpl }),
      (e) => { assert.ok(!e.message.includes(KEY)); return true; },
    );
  }
});

test('stránkování, které se zacyklí na stejném kurzoru, skončí chybou', async () => {
  const fetchImpl = async () => resp(200, { data: [{ id: 1, startedAt: hoursAgo(1) }], nextCursor: 'porad-stejny' });
  await assert.rejects(purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], fetchImpl }), /kurzor|stránkování/i);
});

test('chybějící apiKey nebo workflowIds vyhodí výjimku', async () => {
  const { fetchImpl } = fakeN8n({ executions: {} });
  for (const apiKey of [undefined, '', '   ', 42]) {
    await assert.rejects(purgeExecutions({ apiKey, workflowIds: ['w1'], fetchImpl }), /N8N_API_KEY|apiKey/);
  }
  await assert.rejects(purgeExecutions({ apiKey: KEY, workflowIds: [], fetchImpl }), /workflow/i);
  await assert.rejects(purgeExecutions({ apiKey: KEY, fetchImpl }), /workflow/i);
});

test('olderThanHours: záporná nebo nečíselná hodnota vyhodí výjimku (nesmí smazat vše)', async () => {
  const { fetchImpl, calls } = fakeN8n({ executions: { w1: makeExecs(2) } });
  for (const olderThanHours of [-1, NaN, 'abc']) {
    await assert.rejects(purgeExecutions({ apiKey: KEY, workflowIds: ['w1'], olderThanHours, dryRun: false, fetchImpl }));
  }
  assert.equal(calls.length, 0);
});

test('parseArgs: --yes a --older-than-hours', () => {
  assert.deepEqual(parseArgs([]), { yes: false, olderThanHours: 0 });
  assert.deepEqual(parseArgs(['--yes']), { yes: true, olderThanHours: 0 });
  assert.deepEqual(parseArgs(['--older-than-hours', '24']), { yes: false, olderThanHours: 24 });
  assert.deepEqual(parseArgs(['--yes', '--older-than-hours=6']), { yes: true, olderThanHours: 6 });
  for (const bad of [['--older-than-hours'], ['--older-than-hours', 'x'], ['--older-than-hours', '-3'], ['--nesmysl'], ['--api-key', 'abc']]) {
    assert.throws(() => parseArgs(bad), Error, bad.join(' '));
  }
});

// --- nález 23: ID workflow nemusí v dané instanci n8n existovat ---

// Falešné n8n s workflow: `workflows` je { id: název }; GET /workflows/:id vrací 404 pro neznámé ID, GET /workflows seznam (stránkovaný po 2).
function fakeWorkflows({ workflows, executions = {}, status = 200 }) {
  const calls = [];
  const exec = fakeN8n({ executions });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (method === 'GET' && u.pathname.startsWith('/api/v1/workflows')) {
      calls.push(url);
      if (status !== 200) return resp(status, { message: `klíč ${KEY}` });
      const id = u.pathname.split('/')[4];
      if (id) return workflows[id] ? resp(200, { id, name: workflows[id] }) : resp(404, { message: 'not found' });
      const all = Object.entries(workflows).map(([wid, name]) => ({ id: wid, name }));
      const start = Number(u.searchParams.get('cursor') || 0);
      return resp(200, { data: all.slice(start, start + 2), nextCursor: start + 2 < all.length ? String(start + 2) : null });
    }
    return exec.fetchImpl(url, opts);
  };
  return { fetchImpl, calls, execCalls: exec.calls };
}

test('konstanty: názvy workflow odpovídají sestavení', () => {
  assert.deepEqual(WORKFLOW_NAMES, ['Nákupní semafor', 'Nákupní semafor – web']);
});

const W = [{ id: 'a', name: 'Nákupní semafor' }, { id: 'b', name: 'Nákupní semafor – web' }];

test('resolveWorkflowIds: existující ID zůstanou beze změny a seznam podle názvu se nevolá', async () => {
  const { fetchImpl, calls } = fakeWorkflows({ workflows: { a: 'Nákupní semafor', b: 'Nákupní semafor – web' } });
  const r = await resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl });
  assert.deepEqual(r, { ids: ['a', 'b'], nenalezena: [], podleNazvu: [] });
  assert.ok(calls.every((u) => new URL(u).pathname.split('/')[4]), 'jen dotazy na konkrétní ID');
});

test('resolveWorkflowIds: jedno ID chybí, druhé existuje; chybějící se dohledá podle názvu (i na druhé stránce seznamu)', async () => {
  const { fetchImpl } = fakeWorkflows({ workflows: { b: 'Nákupní semafor – web', x1: 'Jiné', x2: 'Jiné 2', x3: 'Nákupní semafor', x5: 'Nákupní semafor kopie' } });
  const r = await resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl });
  assert.deepEqual(r, { ids: ['b', 'x3'], nenalezena: [], podleNazvu: ['x3'] });
});

test('resolveWorkflowIds: žádné ID neexistuje, obě workflow se najdou podle názvu', async () => {
  const { fetchImpl } = fakeWorkflows({ workflows: { x1: 'Jiné', x2: 'Jiné 2', x3: 'Nákupní semafor', x4: 'Nákupní semafor – web' } });
  const r = await resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl });
  assert.deepEqual(r, { ids: ['x3', 'x4'], nenalezena: [], podleNazvu: ['x3', 'x4'] });
});

test('resolveWorkflowIds: workflow, které není ani podle ID, ani podle názvu, se vrátí jako nenalezené', async () => {
  const { fetchImpl } = fakeWorkflows({ workflows: { b: 'Nákupní semafor – web', x1: 'Jiné' } });
  const r = await resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl });
  assert.deepEqual(r, { ids: ['b'], nenalezena: [W[0]], podleNazvu: [] });
});

test('resolveWorkflowIds: nic nenalezeno ani podle ID, ani podle názvu vyhodí srozumitelnou chybu bez klíče', async () => {
  const { fetchImpl } = fakeWorkflows({ workflows: { x1: 'Jiné' } });
  await assert.rejects(resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl }), (e) => {
    assert.match(e.message, /nenalezen|neexistuj/i);
    assert.ok(e.message.includes('a') && e.message.includes('Nákupní semafor'));
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('resolveWorkflowIds: jiná chyba než 404 (např. 401) skončí chybou bez klíče, ne „nenalezeno“', async () => {
  const { fetchImpl } = fakeWorkflows({ workflows: {}, status: 401 });
  await assert.rejects(resolveWorkflowIds({ apiKey: KEY, workflows: W, fetchImpl }), (e) => {
    assert.match(e.message, /401/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

function spustMain(argv, fw) {
  const out = []; const err = [];
  const log = console.log; const error = console.error; const warn = console.warn;
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' ')); console.warn = (...a) => err.push(a.join(' '));
  return main(argv, { N8N_API_KEY: KEY }, { fetchImpl: fw.fetchImpl }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }))
    .finally(() => { console.log = log; console.error = error; console.warn = warn; });
}

test('main: když žádné workflow neexistuje, řekne to nahlas (ne „Nalezeno 0“), skončí kódem 1 a nic nemaže', async () => {
  const fw = fakeWorkflows({ workflows: { x1: 'Jiné' } });
  const r = await spustMain(['--yes'], fw);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /Nalezeno 0/);
  assert.match(r.err, /nenalezen|neexistuj/i);
  assert.ok(!(r.out + r.err).includes(KEY));
  assert.equal(fw.execCalls.length, 0, 'výpis ani mazání průběhů se nevolá');
});

test('main: ID neexistují, ale workflow jsou podle názvu; vypíše, že se použila nalezená, a smaže jejich průběhy', async () => {
  const fw = fakeWorkflows({ workflows: { x3: 'Nákupní semafor', x4: 'Nákupní semafor – web' }, executions: { x3: makeExecs(2, 1), x4: makeExecs(1, 10) } });
  const r = await spustMain(['--yes'], fw);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out + r.err, /podle názvu/);
  assert.match(r.out, /Nalezeno 3 průběhů, smazáno 3/);
  assert.deepEqual(deleted(fw.execCalls).sort(), ['1', '10', '2']);
});

test('main: jedno z ID chybí, dohledá se podle názvu a průběhy obou workflow se smažou, kód 0', async () => {
  const fw = fakeWorkflows({ workflows: { [WORKFLOW_IDS[1]]: 'Nákupní semafor – web', x3: 'Nákupní semafor' }, executions: { [WORKFLOW_IDS[1]]: makeExecs(2, 1), x3: makeExecs(3, 10) } });
  const r = await spustMain(['--yes'], fw);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('podle názvu (x3)'), r.out);
  assert.match(r.out, /Nalezeno 5 průběhů, smazáno 5/);
  assert.deepEqual(deleted(fw.execCalls).sort(), ['1', '10', '11', '12', '2']);
});

test('main: jedno workflow chybí i po dohledání: smaže průběhy nalezených, ale skončí kódem 1 a jasnou hláškou', async () => {
  const fw = fakeWorkflows({ workflows: { [WORKFLOW_IDS[1]]: 'Nákupní semafor – web' }, executions: { [WORKFLOW_IDS[1]]: makeExecs(2) } });
  const r = await spustMain(['--yes'], fw);
  assert.equal(r.code, 1);
  assert.match(r.out, /smazáno 2/);
  assert.ok(r.err.includes(WORKFLOW_IDS[0]) && r.err.includes('Nákupní semafor'), r.err);
  assert.match(r.err, /není v n8n|nemazaly/);
  assert.ok(!(r.out + r.err).includes(KEY));
});

test('main: výpis (bez --yes) s chybějícím workflow také skončí kódem 1 a nic nemaže', async () => {
  const fw = fakeWorkflows({ workflows: { [WORKFLOW_IDS[1]]: 'Nákupní semafor – web' }, executions: { [WORKFLOW_IDS[1]]: makeExecs(2) } });
  const r = await spustMain([], fw);
  assert.equal(r.code, 1);
  assert.equal(deleted(fw.execCalls).length, 0);
});

test('ID a názvy workflow zapisuje build a mazání je čte odtud (nerozejdou se)', () => {
  const { WORKFLOW_API, WORKFLOW_WEB, buildWorkflow, buildWebWorkflow } = require('../build/build-workflow');
  const api = buildWorkflow({ credId: 'C', credName: 'N' });
  const web = buildWebWorkflow();
  assert.equal(api.id, WORKFLOW_API.id);
  assert.equal(web.id, WORKFLOW_WEB.id);
  assert.equal(api.name, 'Nákupní semafor');
  assert.equal(web.name, 'Nákupní semafor – web');
  assert.deepEqual(WORKFLOW_IDS, [api.id, web.id]);
  assert.deepEqual(WORKFLOW_NAMES, [api.name, web.name]);
  assert.equal(api.nodes.find((n) => n.name === 'Webhook').parameters.path, 'nakupni-semafor');
  assert.equal(web.nodes.find((n) => n.name === 'Webhook – stránka').parameters.path, 'nakupni-semafor-web');
});
