const test = require('node:test');
const assert = require('node:assert/strict');
const { signal } = require('../engine/signals');
const { computeVerdict } = require('../engine/scoring');
const { buildExplainRequest, parseExplanation, fallbackAdvice, buildResponse, needMoreInput } = require('../engine/explain');

const sg = (id, severity, extra = {}) => signal({ id, module: 'seller', severity, title: 'T ' + id, evidence: 'E ' + id, source: 'RDAP', ...extra });
const OK3 = { offer: 'ok', seller: 'ok', safety: 'ok' };

test('požadavek na vysvětlení obsahuje jen signály, ne uživatelská data', () => {
  const v = computeVerdict([sg('a', 'medium')], OK3);
  const r = buildExplainRequest(v, [sg('a', 'medium')]);
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.match(r.messages[0].content, /T a/);
});

test('parseExplanation přijme platný výstup a odmítne chybějící pole', () => {
  const good = { content: [{ type: 'text', text: '{"shrnuti":"Pozor.","co_delat":["Nekupuj."]}' }] };
  assert.deepEqual(parseExplanation(good), { ok: true, shrnuti: 'Pozor.', co_delat: ['Nekupuj.'] });
  assert.equal(parseExplanation({ content: [{ type: 'text', text: '{"x":1}' }] }).ok, false);
  assert.equal(parseExplanation({ error: {} }).ok, false);
});

test('fallbackAdvice existuje pro každý semafor', () => {
  for (const sem of ['zelená', 'oranžová', 'červená', 'šedá']) {
    const f = fallbackAdvice({ semafor: sem });
    assert.ok(f.shrnuti.length > 10);
    assert.ok(f.co_delat.length >= 1);
  }
});

test('buildResponse řadí signály podle závažnosti a uvádí nezkontrolované moduly', () => {
  const sigs = [sg('low1', 'low'), sg('high1', 'high'), sg('med1', 'medium')];
  const v = computeVerdict(sigs, { offer: 'ok', seller: 'ok', safety: 'unchecked' });
  const r = buildResponse({ verdict: v, signals: sigs, explanation: null });
  assert.equal(r.stav, 'ok');
  assert.deepEqual(r.signaly.map((s) => s.id), ['high1', 'med1', 'low1']);
  assert.deepEqual(r.nezkontrolovano, ['bezpečnost']);
  assert.equal(r.jistota, 'střední');
  assert.match(r.upozorneni, /pomůcka/i);
  assert.ok(r.shrnuti.length > 10, 'bez vysvětlení se použije fallback');
});

test('vysvětlení z LLM se použije, když je platné', () => {
  const v = computeVerdict([], OK3);
  const r = buildResponse({ verdict: v, signals: [], explanation: { ok: true, shrnuti: 'Vše vypadá v pořádku.', co_delat: ['Plať kartou.'] } });
  assert.equal(r.shrnuti, 'Vše vypadá v pořádku.');
  assert.deepEqual(r.co_delat, ['Plať kartou.']);
});

test('všechny moduly selhaly → šedá a seznam všech tří modulů', () => {
  const v = computeVerdict([], { offer: 'unchecked', seller: 'unchecked', safety: 'unchecked' });
  const r = buildResponse({ verdict: v, signals: [], explanation: null });
  assert.equal(r.semafor, 'šedá');
  assert.deepEqual(r.nezkontrolovano, ['nabídka', 'prodejce', 'bezpečnost']);
});

test('needMoreInput', () => {
  assert.deepEqual(needMoreInput('Vložte screenshot.'), { stav: 'potrebuji_vice', zprava: 'Vložte screenshot.' });
});

// --- controller guards ---

const apiWith = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('wording guard: vysvětlení nazývající prodejce podvodníkem se odmítne', () => {
  assert.equal(parseExplanation(apiWith({ shrnuti: 'Prodejce je podvodník.', co_delat: ['Nekupuj.'] })).ok, false);
  assert.equal(parseExplanation(apiWith({ shrnuti: 'Pozor.', co_delat: ['Tento e-shop je podvod.'] })).ok, false);
  assert.equal(parseExplanation(apiWith({ shrnuti: 'Našli jsme rizikové signály.', co_delat: ['Projděte si je.'] })).ok, true);
});

test('wording guard: odmítnuté vysvětlení se v buildResponse nahradí fallbackem', () => {
  const sigs = [sg('h', 'high')];
  const v = computeVerdict(sigs, OK3);
  const fb = fallbackAdvice(v);
  const r = buildResponse({ verdict: v, signals: sigs, explanation: { ok: true, shrnuti: 'Prodejce je podvodník.', co_delat: ['Nekupuj.'] } });
  assert.equal(r.shrnuti, fb.shrnuti);
  assert.deepEqual(r.co_delat, fb.co_delat);
});

test('consistency guard: červená + tvrzení bezpečnosti → fallback', () => {
  const sigs = [sg('h', 'high')];
  const v = computeVerdict(sigs, OK3);
  const fb = fallbackAdvice(v);
  const r = buildResponse({ verdict: v, signals: sigs, explanation: { ok: true, shrnuti: 'Vše je v pořádku, klidně kupte.', co_delat: ['Plať kartou.'] } });
  assert.equal(r.semafor, 'červená');
  assert.equal(r.shrnuti, fb.shrnuti);
  assert.deepEqual(r.co_delat, fb.co_delat);
});

test('consistency guard: červená + varování (negovaná bezpečnost) → LLM text', () => {
  const sigs = [sg('h', 'high')];
  const v = computeVerdict(sigs, OK3);
  const r = buildResponse({ verdict: v, signals: sigs, explanation: { ok: true, shrnuti: 'Nákup není bezpečný, raději nekupujte.', co_delat: ['Nekupujte.'] } });
  assert.equal(r.shrnuti, 'Nákup není bezpečný, raději nekupujte.');
});

test('consistency guard: zelená + varování → fallback', () => {
  const v = computeVerdict([], OK3);
  assert.equal(v.semafor, 'zelená');
  const fb = fallbackAdvice(v);
  const r = buildResponse({ verdict: v, signals: [], explanation: { ok: true, shrnuti: 'Nekupujte, je to nebezpečné.', co_delat: ['Počkejte.'] } });
  assert.equal(r.shrnuti, fb.shrnuti);
  assert.deepEqual(r.co_delat, fb.co_delat);
});

test('consistency guard: oranžová → LLM text bez kontroly', () => {
  const sigs = [sg('m', 'medium')];
  const v = computeVerdict(sigs, OK3);
  assert.equal(v.semafor, 'oranžová');
  const r = buildResponse({ verdict: v, signals: sigs, explanation: { ok: true, shrnuti: 'Nekupujte, je to nebezpečné.', co_delat: ['Počkejte.'] } });
  assert.equal(r.shrnuti, 'Nekupujte, je to nebezpečné.');
});

test('buildResponse kopíruje jen známá pole a omezuje délky', () => {
  const v = computeVerdict([], OK3);
  const r = buildResponse({
    verdict: v, signals: [],
    explanation: { ok: true, shrnuti: 'a'.repeat(500), co_delat: Array(6).fill('b'.repeat(300)), extra: 'x' },
  });
  assert.equal(r.shrnuti.length, 400);
  assert.ok(r.shrnuti.endsWith('…'));
  assert.equal(r.co_delat.length, 4);
  assert.ok(r.co_delat.every((x) => x.length <= 200));
  assert.equal('extra' in r, false);
});

test('buildResponse filtruje nestringové položky co_delat', () => {
  const sigs = [sg('m', 'medium')];
  const v = computeVerdict(sigs, OK3);
  const r = buildResponse({ verdict: v, signals: sigs, explanation: { ok: true, shrnuti: 'Pozor, rizika.', co_delat: ['Nekupuj.', 42, '   ', 'Dobrá rada.'] } });
  assert.deepEqual(r.co_delat, ['Nekupuj.', 'Dobrá rada.']);
});

test('buildResponse nikdy nespadne na chybějícím nebo nevalidním vysvětlení', () => {
  const v = computeVerdict([], OK3);
  for (const explanation of [undefined, null, {}, { ok: true }, { ok: true, shrnuti: 42, co_delat: 'x' }]) {
    const r = buildResponse({ verdict: v, signals: [], explanation });
    assert.ok(r.shrnuti.length > 10);
    assert.ok(Array.isArray(r.co_delat) && r.co_delat.length >= 1);
  }
  assert.doesNotThrow(() => buildResponse({ verdict: v }));
});

test('parseExplanation omezuje počet rad a délku textu', () => {
  const p = parseExplanation(apiWith({ shrnuti: 'a'.repeat(500), co_delat: ['1', '2', '3', '4', '5', '6'] }));
  assert.equal(p.ok, true);
  assert.equal(p.shrnuti.length, 400);
  assert.deepEqual(p.co_delat, ['1', '2', '3', '4']);
});
