const test = require('node:test');
const assert = require('node:assert/strict');
const { purgeExecutions, parseArgs, WORKFLOW_IDS } = require('../tools/purge-executions');

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

test('konstanty: ID obou workflow Nákupní kontroly', () => {
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
