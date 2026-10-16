const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { predictedClass, resultClass, computeMetrics, confusion, topSignals } = require('../eval/metrics');
const { mimeFromName, buildRequestBody, toResultRecord, selectCases, parseArgs, renderReport } = require('../eval/report');

// ---- metrics ----

test('mapování semaforu na třídu', () => {
  assert.equal(predictedClass('zelená'), 'ok');
  assert.equal(predictedClass('oranžová'), 'rizikove');
  assert.equal(predictedClass('červená'), 'rizikove');
  assert.equal(predictedClass('šedá'), 'neurceno');
});

test('neznámý semafor nebo nic je neurčeno', () => {
  assert.equal(predictedClass('modrá'), 'neurceno');
  assert.equal(predictedClass(undefined), 'neurceno');
  assert.equal(predictedClass(null), 'neurceno');
  assert.equal(predictedClass(''), 'neurceno');
});

test('resultClass: chyba, potrebuji_vice, semafor', () => {
  assert.equal(resultClass({ stav: 'chyba', chyba: 'x' }), 'chyba');
  assert.equal(resultClass({ chyba: 'timeout' }), 'chyba');
  assert.equal(resultClass({ stav: 'potrebuji_vice', semafor: 'zelená' }), 'neurceno');
  assert.equal(resultClass({ stav: 'ok', semafor: 'červená' }), 'rizikove');
  assert.equal(resultClass({}), 'neurceno');
  assert.equal(resultClass(null), 'chyba');
});

const SAMPLE = [
  { id: 'p1', label: 'podvod', semafor: 'červená' }, { id: 'p2', label: 'podvod', semafor: 'oranžová' },
  { id: 'p3', label: 'podvod', semafor: 'zelená' }, { id: 'p4', label: 'podvod', semafor: 'šedá' },
  { id: 'o1', label: 'ok', semafor: 'zelená' }, { id: 'o2', label: 'ok', semafor: 'oranžová' },
  { id: 'o3', label: 'ok', semafor: 'zelená' }, { id: 'o4', label: 'ok', semafor: 'zelená' },
  { id: 's1', label: 'sporne', semafor: 'oranžová' },
];

test('metriky: recall podvodů, falešný poplach, neurčeno', () => {
  const m = computeMetrics(SAMPLE);
  assert.equal(m.total, 9);
  assert.deepEqual(m.per_label_counts, { ok: 4, sporne: 1, podvod: 4 });
  assert.equal(m.recall_podvod, 0.5);
  assert.equal(m.falesny_poplach, 0.25);
  assert.equal(m.neurceno, 1 / 9);
  assert.equal(m.neurceno_podvod, 0.25);
  assert.equal(m.neurceno_ok, 0);
  assert.equal(m.chyby, 0);
});

test('metriky: prázdný vstup nehází NaN', () => {
  const m = computeMetrics([]);
  assert.equal(m.total, 0);
  assert.deepEqual(m.per_label_counts, { ok: 0, sporne: 0, podvod: 0 });
  assert.equal(m.recall_podvod, null);
  assert.equal(m.falesny_poplach, null);
  assert.equal(m.neurceno, null);
  assert.equal(m.neurceno_podvod, null);
  assert.equal(m.neurceno_ok, null);
  assert.equal(m.chyby, 0);
});

test('metriky: jen jeden label', () => {
  const m = computeMetrics([{ label: 'ok', semafor: 'zelená' }, { label: 'ok', semafor: 'červená' }]);
  assert.equal(m.recall_podvod, null);
  assert.equal(m.neurceno_podvod, null);
  assert.equal(m.falesny_poplach, 0.5);
  assert.equal(m.neurceno, 0);
  const p = computeMetrics([{ label: 'podvod', semafor: 'červená' }]);
  assert.equal(p.recall_podvod, 1);
  assert.equal(p.falesny_poplach, null);
});

test('metriky: neznámý semafor a potrebuji_vice se počítají jako neurčeno', () => {
  const m = computeMetrics([
    { label: 'podvod', semafor: 'modrá' },
    { label: 'ok', stav: 'potrebuji_vice' },
    { label: 'ok', semafor: 'zelená' },
    { label: 'podvod', semafor: 'červená' },
  ]);
  assert.equal(m.neurceno, 0.5);
  assert.equal(m.neurceno_podvod, 0.5);
  assert.equal(m.neurceno_ok, 0.5);
  assert.equal(m.recall_podvod, 0.5);
  assert.equal(m.falesny_poplach, 0);
});

test('metriky: chyby se počítají zvlášť, podvod s chybou není zachycený a neurčeno není', () => {
  const m = computeMetrics([
    { label: 'podvod', stav: 'chyba', chyba: 'timeout' },
    { label: 'podvod', semafor: 'červená' },
    { label: 'ok', stav: 'chyba', chyba: 'HTTP 500' },
    { label: 'ok', chyba: 'soubor chybí' },
    { label: 'ok', semafor: 'šedá' },
  ]);
  assert.equal(m.total, 5);
  assert.equal(m.chyby, 3);
  assert.equal(m.recall_podvod, 0.5);
  assert.equal(m.falesny_poplach, 0);
  assert.equal(m.neurceno, 0.2);
  assert.equal(m.neurceno_ok, 1 / 3);
  assert.equal(m.neurceno_podvod, 0);
});

test('confusion: matice label x predikovaná třída', () => {
  const c = confusion([...SAMPLE, { label: 'ok', stav: 'chyba', chyba: 'x' }, { label: 'podvod', stav: 'potrebuji_vice' }]);
  assert.deepEqual(c.podvod, { ok: 1, rizikove: 2, neurceno: 2, chyba: 0 });
  assert.deepEqual(c.ok, { ok: 3, rizikove: 1, neurceno: 0, chyba: 1 });
  assert.deepEqual(c.sporne, { ok: 0, rizikove: 1, neurceno: 0, chyba: 0 });
  assert.deepEqual(confusion([]), {
    ok: { ok: 0, rizikove: 0, neurceno: 0, chyba: 0 },
    sporne: { ok: 0, rizikove: 0, neurceno: 0, chyba: 0 },
    podvod: { ok: 0, rizikove: 0, neurceno: 0, chyba: 0 },
  });
});

test('topSignals: nejčastější signály s počty podle labelu', () => {
  const r = [
    { label: 'podvod', signaly: ['a', 'b', 'a'] },
    { label: 'podvod', signaly: ['a', 'c'] },
    { label: 'ok', signaly: ['a', 'b'] },
    { label: 'sporne', signaly: [{ id: 'c' }] },
    { label: 'ok' },
    { label: 'ok', stav: 'chyba' },
  ];
  const t = topSignals(r);
  assert.deepEqual(t[0], { id: 'a', count: 3, per_label: { ok: 1, sporne: 0, podvod: 2 } });
  assert.deepEqual(t[1], { id: 'b', count: 2, per_label: { ok: 1, sporne: 0, podvod: 1 } });
  assert.deepEqual(t[2], { id: 'c', count: 2, per_label: { ok: 0, sporne: 1, podvod: 1 } });
  assert.equal(t.length, 3);
  assert.equal(topSignals(r, 2).length, 2);
  assert.deepEqual(topSignals([]), []);
});

// ---- report: request body ----

test('mimeFromName podle přípony', () => {
  assert.equal(mimeFromName('a.png'), 'image/png');
  assert.equal(mimeFromName('a.JPG'), 'image/jpeg');
  assert.equal(mimeFromName('a.jpeg'), 'image/jpeg');
  assert.equal(mimeFromName('a.webp'), 'image/webp');
  assert.throws(() => mimeFromName('a.gif'), /příponu/);
});

test('buildRequestBody: odkaz a text', () => {
  assert.deepEqual(buildRequestBody({ id: 'x', odkaz: 'https://a.cz/' }, '/nowhere'), { odkaz: 'https://a.cz/' });
  assert.deepEqual(buildRequestBody({ id: 'x', text: 'asdf' }, '/nowhere'), { text: 'asdf' });
});

test('buildRequestBody: screenshoty se čtou jako base64 s mime z přípony', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-eval-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'b.webp'), Buffer.from('hello'));
    const b = buildRequestBody({ id: 'x', screenshotFiles: ['a.png', 'b.webp'] }, dir);
    assert.deepEqual(b, { screenshoty: [{ mime: 'image/png', data: 'AQID' }, { mime: 'image/webp', data: Buffer.from('hello').toString('base64') }] });
    assert.throws(() => buildRequestBody({ id: 'x', screenshotFiles: ['chybi.png'] }, dir), /chybi\.png/);
    assert.throws(() => buildRequestBody({ id: 'x', screenshotFiles: ['../cases.json'] }, dir), /název souboru/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRequestBody: případ bez vstupu je chyba', () => {
  assert.throws(() => buildRequestBody({ id: 'x' }, '/nowhere'), /vstup/);
});

// ---- report: result record ----

test('toResultRecord: ok odpověď zachová jen potřebná pole a ids signálů', () => {
  const rec = toResultRecord({ id: 'a', label: 'podvod' }, {
    stav: 'ok', semafor: 'červená', skore: 80, jistota: 'vysoká', shrnuti: 'dlouhý text', co_delat: ['x'],
    signaly: [{ id: 'sig1', titul: 't' }, { id: 'sig2' }], nezkontrolovano: ['prodejce'], upozorneni: 'u',
  });
  assert.deepEqual(rec, { id: 'a', label: 'podvod', stav: 'ok', semafor: 'červená', skore: 80, jistota: 'vysoká', signaly: ['sig1', 'sig2'], nezkontrolovano: ['prodejce'] });
});

test('toResultRecord: potrebuji_vice, chyba a nesmyslné odpovědi', () => {
  const c = { id: 'a', label: 'ok' };
  assert.deepEqual(toResultRecord(c, { stav: 'potrebuji_vice', zprava: 'Vložte text' }), { id: 'a', label: 'ok', stav: 'potrebuji_vice', zprava: 'Vložte text' });
  assert.deepEqual(toResultRecord(c, { stav: 'chyba', chyba: 'Moc dlouhé' }), { id: 'a', label: 'ok', stav: 'chyba', chyba: 'Moc dlouhé' });
  for (const bad of [null, undefined, 'text', 42, [], {}, { stav: 'jine' }, { stav: 'ok' }]) {
    const r = toResultRecord(c, bad);
    assert.equal(r.stav, 'chyba');
    assert.equal(r.id, 'a');
    assert.equal(r.label, 'ok');
    assert.equal(typeof r.chyba, 'string');
  }
});

test('toResultRecord: ok odpověď s polopatickými poli nehází', () => {
  const r = toResultRecord({ id: 'a', label: 'ok' }, { stav: 'ok', semafor: 'zelená', signaly: 'nic', nezkontrolovano: null });
  assert.equal(r.semafor, 'zelená');
  assert.deepEqual(r.signaly, []);
  assert.deepEqual(r.nezkontrolovano, []);
});

// ---- report: CLI helpers ----

test('parseArgs a selectCases', () => {
  assert.deepEqual(parseArgs([]), { only: null, ids: null });
  assert.deepEqual(parseArgs(['--only', 'podvod']), { only: 'podvod', ids: null });
  assert.deepEqual(parseArgs(['--ids', 'a,b, c']), { only: null, ids: ['a', 'b', 'c'] });
  assert.throws(() => parseArgs(['--only']), /--only/);
  assert.throws(() => parseArgs(['--only', 'nesmysl']), /nesmysl/);
  assert.throws(() => parseArgs(['--foo']), /--foo/);
  const cases = [{ id: 'a', label: 'ok' }, { id: 'b', label: 'podvod' }, { id: 'c', label: 'podvod' }];
  assert.deepEqual(selectCases(cases, { only: 'podvod', ids: null }).map((c) => c.id), ['b', 'c']);
  assert.deepEqual(selectCases(cases, { only: null, ids: ['a', 'c'] }).map((c) => c.id), ['a', 'c']);
  assert.equal(selectCases(cases, { only: null, ids: null }).length, 3);
});

// ---- report: markdown ----

test('renderReport: počty, matice, procenta, signály, chybně zařazené případy', () => {
  const results = [
    { id: 'p1', label: 'podvod', stav: 'ok', semafor: 'červená', skore: 90, signaly: ['sig-a', 'sig-b'] },
    { id: 'p2', label: 'podvod', stav: 'ok', semafor: 'zelená', skore: 5, signaly: [] },
    { id: 'o1', label: 'ok', stav: 'ok', semafor: 'oranžová', skore: 40, signaly: ['sig-a'] },
    { id: 'o2', label: 'ok', stav: 'ok', semafor: 'zelená', skore: 0, signaly: [] },
    { id: 's1', label: 'sporne', stav: 'potrebuji_vice', zprava: 'x' },
    { id: 'o3', label: 'ok', stav: 'chyba', chyba: 'timeout' },
  ];
  const md = renderReport(results, { datum: '2026-10-16', api: 'http://x/webhook' });
  assert.match(md, /^# Výsledky testovací sady/);
  assert.match(md, /2026-10-16/);
  assert.match(md, /Počet případů: 6/);
  assert.match(md, /Zachycené podvody[^\n]*50 %/);
  assert.match(md, /Falešný poplach[^\n]*33 %/);
  assert.match(md, /Nelze posoudit[^\n]*17 %/);
  assert.match(md, /Chyby[^\n]*1/);
  assert.match(md, /\| podvod \| 1 \| 1 \| 0 \| 0 \|/);
  assert.match(md, /\| ok \| 1 \| 1 \| 0 \| 1 \|/);
  assert.match(md, /sig-a[^\n]*2/);
  const wrong = md.split('## Chybně zařazené případy')[1];
  assert.ok(wrong, 'sekce chybně zařazených případů');
  assert.match(wrong, /p2[^\n]*zelená/);
  assert.match(wrong, /o1[^\n]*oranžová[^\n]*sig-a/);
  assert.match(wrong, /o3[^\n]*timeout/);
  assert.ok(!/p1/.test(wrong));
});

test('renderReport: prázdné metriky jako n/a a žádné chybné případy', () => {
  const md = renderReport([{ id: 'o1', label: 'ok', stav: 'ok', semafor: 'zelená', signaly: [] }], { datum: '2026-10-16', api: 'x' });
  assert.match(md, /Zachycené podvody[^\n]*n\/a/);
  assert.match(md, /Falešný poplach[^\n]*0 %/);
  assert.match(md, /žádné/i);
  const empty = renderReport([], { datum: '2026-10-16', api: 'x' });
  assert.match(empty, /Počet případů: 0/);
  assert.match(empty, /n\/a/);
});

// ---- cases.json ----

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'cases.json'), 'utf8'));

test('cases.json: schéma', () => {
  assert.ok(Array.isArray(CASES));
  const ids = new Set();
  for (const c of CASES) {
    assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/, 'id ' + c.id);
    assert.ok(!ids.has(c.id), 'duplicitní id ' + c.id);
    ids.add(c.id);
    assert.ok(['ok', 'sporne', 'podvod'].includes(c.label), 'label ' + c.id);
    assert.equal(typeof c.zdroj, 'string');
    assert.ok(c.zdroj.length > 0);
    if (c.poznamka !== undefined) assert.equal(typeof c.poznamka, 'string');
    const kinds = ['odkaz', 'text', 'screenshotFiles'].filter((k) => c[k] !== undefined);
    assert.equal(kinds.length, 1, 'právě jeden druh vstupu: ' + c.id);
    if (c.odkaz !== undefined) assert.match(c.odkaz, /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/$/, 'odkaz ' + c.id);
    if (c.text !== undefined) assert.ok(typeof c.text === 'string' && c.text.trim().length > 0);
    if (c.screenshotFiles !== undefined) {
      assert.ok(Array.isArray(c.screenshotFiles) && c.screenshotFiles.length > 0);
      for (const f of c.screenshotFiles) assert.match(f, /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i);
    }
    assert.deepEqual(Object.keys(c).filter((k) => !['id', 'label', 'odkaz', 'text', 'screenshotFiles', 'zdroj', 'poznamka'].includes(k)), []);
  }
});

test('cases.json: složení sady', () => {
  const n = (l, k) => CASES.filter((c) => c.label === l && c[k] !== undefined).length;
  assert.equal(n('podvod', 'odkaz'), 15);
  assert.equal(n('ok', 'odkaz'), 15);
  assert.equal(CASES.filter((c) => c.text !== undefined).length, 4);
  assert.equal(CASES.filter((c) => c.text !== undefined && c.label === 'sporne').length, 1);
  assert.ok(CASES.some((c) => /Ignoruj všechny instrukce/.test(c.text || '')));
  assert.equal(new Set(CASES.filter((c) => c.odkaz).map((c) => c.odkaz)).size, 30);
});
