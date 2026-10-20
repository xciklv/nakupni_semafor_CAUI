const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { predictedClass, resultClass, computeMetrics, computeMetricsByGroup, confusion, topSignals } = require('../eval/metrics');
const { mimeFromName, buildRequestBody, caseGroup, toResultRecord, errorRecord, readNumberEnv, selectCases, parseArgs, renderReport } = require('../eval/report');

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

test('caseGroup: výchozí skupina podle druhu vstupu', () => {
  assert.equal(caseGroup({ skupina: 'coi', odkaz: 'https://a.cz/' }), 'coi');
  assert.equal(caseGroup({ screenshotFiles: ['a.png'] }), 'screens');
  assert.equal(caseGroup({ text: 'x' }), 'synthetic');
  assert.equal(caseGroup({ odkaz: 'https://a.cz/' }), 'synthetic');
});

test('toResultRecord: ok odpověď zachová jen potřebná pole a ids signálů, nese skupinu', () => {
  const rec = toResultRecord({ id: 'a', label: 'podvod', skupina: 'coi' }, {
    stav: 'ok', semafor: 'červená', skore: 80, jistota: 'vysoká', shrnuti: 'dlouhý text', co_delat: ['x'],
    signaly: [{ id: 'sig1', titul: 't' }, { id: 'sig2' }], nezkontrolovano: ['prodejce'], upozorneni: 'u',
  });
  assert.deepEqual(rec, { id: 'a', label: 'podvod', skupina: 'coi', stav: 'ok', semafor: 'červená', skore: 80, jistota: 'vysoká', signaly: ['sig1', 'sig2'], nezkontrolovano: ['prodejce'] });
});

test('toResultRecord: potrebuji_vice, chyba a nesmyslné odpovědi', () => {
  const c = { id: 'a', label: 'ok', skupina: 'legit' };
  assert.deepEqual(toResultRecord(c, { stav: 'potrebuji_vice', zprava: 'Vložte text' }), { id: 'a', label: 'ok', skupina: 'legit', stav: 'potrebuji_vice', zprava: 'Vložte text' });
  assert.deepEqual(toResultRecord(c, { stav: 'chyba', chyba: 'Moc dlouhé' }), { id: 'a', label: 'ok', skupina: 'legit', stav: 'chyba', chyba: 'Moc dlouhé' });
  for (const bad of [null, undefined, 'text', 42, [], {}, { stav: 'jine' }, { stav: 'ok' }]) {
    const r = toResultRecord(c, bad);
    assert.equal(r.stav, 'chyba');
    assert.equal(r.id, 'a');
    assert.equal(r.label, 'ok');
    assert.equal(r.skupina, 'legit');
    assert.equal(typeof r.chyba, 'string');
  }
});

test('errorRecord nese skupinu (výchozí podle vstupu)', () => {
  assert.deepEqual(errorRecord({ id: 'a', label: 'ok', screenshotFiles: ['x.png'] }, 'chybí'), { id: 'a', label: 'ok', skupina: 'screens', stav: 'chyba', chyba: 'chybí' });
});

test('toResultRecord: ok odpověď s polopatickými poli nehází', () => {
  const r = toResultRecord({ id: 'a', label: 'ok' }, { stav: 'ok', semafor: 'zelená', signaly: 'nic', nezkontrolovano: null });
  assert.equal(r.semafor, 'zelená');
  assert.deepEqual(r.signaly, []);
  assert.deepEqual(r.nezkontrolovano, []);
});

test('readNumberEnv: neplatné hodnoty padají na výchozí', () => {
  assert.equal(readNumberEnv(undefined, 1500), 1500);
  assert.equal(readNumberEnv('', 1500), 1500);
  assert.equal(readNumberEnv('abc', 1500), 1500);
  assert.equal(readNumberEnv('NaN', 1500), 1500);
  assert.equal(readNumberEnv('Infinity', 1500), 1500);
  assert.equal(readNumberEnv('-5', 1500), 1500);
  assert.equal(readNumberEnv('2500', 1500), 2500);
  assert.equal(readNumberEnv('0', 1500), 0);
  assert.equal(readNumberEnv('0', 60000, false), 60000);
  assert.equal(readNumberEnv('10', 60000, false), 10);
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

const mk = (id, label, skupina, semafor, extra = {}) => ({ id, label, skupina, stav: 'ok', semafor, skore: 0, signaly: [], ...extra });
const err = (id, label, skupina, chyba = 'timeout') => ({ id, label, skupina, stav: 'chyba', chyba });
const META = { datum: '2026-10-16', api: 'http://x/webhook' };
const COI_NOTE = 'Skupina ČOI je kruhová: verdikt vychází ze stejného seznamu, proto jde jen o kontrolu funkčnosti řetězce, ne o měřítko detekce. Zařazení na seznam ČOI znamená rizikového provozovatele, ne prokázaný podvod.';

// 4 coi podvody (3 rizikové), 4 legit ok (1 falešný poplach, 1 šedá), 2 synthetic podvody (1 zachycen), 1 synthetic ok, 1 sporné
const MIXED = [
  mk('c1', 'podvod', 'coi', 'červená'), mk('c2', 'podvod', 'coi', 'červená'), mk('c3', 'podvod', 'coi', 'oranžová'), mk('c4', 'podvod', 'coi', 'zelená'),
  mk('l1', 'ok', 'legit', 'zelená'), mk('l2', 'ok', 'legit', 'zelená'), mk('l3', 'ok', 'legit', 'oranžová', { skore: 40, signaly: ['sig-a'] }), mk('l4', 'ok', 'legit', 'šedá'),
  mk('s1', 'podvod', 'synthetic', 'červená', { signaly: ['sig-a', 'sig-b'] }), mk('s2', 'podvod', 'synthetic', 'zelená', { skore: 5 }),
  mk('s3', 'ok', 'synthetic', 'zelená'),
  { id: 's4', label: 'sporne', skupina: 'synthetic', stav: 'potrebuji_vice', zprava: 'x' },
];

test('computeMetricsByGroup: rozdělení po skupinách a detekce bez ČOI', () => {
  const g = computeMetricsByGroup(MIXED);
  assert.equal(g.overall.total, 12);
  assert.deepEqual(Object.keys(g.groups).sort(), ['coi', 'legit', 'synthetic']);
  assert.equal(g.groups.coi.total, 4);
  assert.equal(g.groups.coi.recall_podvod, 0.75);
  assert.equal(g.groups.coi.falesny_poplach, null);
  assert.equal(g.groups.legit.total, 4);
  assert.equal(g.groups.legit.falesny_poplach, 0.25);
  assert.equal(g.groups.legit.neurceno_ok, 0.25);
  assert.equal(g.groups.legit.recall_podvod, null);
  assert.equal(g.groups.synthetic.total, 4);
  assert.equal(g.groups.synthetic.recall_podvod, 0.5);
  assert.equal(g.groups.synthetic.falesny_poplach, 0);
  assert.equal(g.groups.synthetic.neurceno, 0.25);
  // detekce = všechno kromě coi: 8 případů, 2 podvody (1 zachycen), 5 ok (1 falešný poplach), 2 neurčeno (šedá + potrebuji_vice)
  assert.equal(g.detection.total, 8);
  assert.equal(g.detection.recall_podvod, 0.5);
  assert.equal(g.detection.falesny_poplach, 0.2);
  assert.equal(g.detection.neurceno, 0.25);
  assert.deepEqual(g.detection.per_label_counts, { ok: 5, sporne: 1, podvod: 2 });
  // overall zahrnuje coi: recall podvodů 4/6
  assert.equal(g.overall.recall_podvod, 4 / 6);
});

test('computeMetricsByGroup: prázdný vstup, chybějící skupina, jen coi', () => {
  const e = computeMetricsByGroup([]);
  assert.equal(e.overall.total, 0);
  assert.deepEqual(e.groups, {});
  assert.equal(e.detection.total, 0);
  assert.equal(e.detection.recall_podvod, null);
  const only = computeMetricsByGroup([mk('c1', 'podvod', 'coi', 'červená')]);
  assert.equal(only.detection.total, 0);
  assert.equal(only.detection.recall_podvod, null);
  assert.equal(only.groups.coi.recall_podvod, 1);
  const none = computeMetricsByGroup([{ id: 'x', label: 'ok', semafor: 'zelená' }]);
  assert.equal(none.groups.nezarazeno.total, 1);
  assert.equal(none.detection.total, 1);
});

test('computeMetrics: pocty (čitatele) odpovídají podílům', () => {
  const m = computeMetrics(MIXED);
  assert.deepEqual(m.pocty, { recall_podvod: 4, falesny_poplach: 1, neurceno: 2, neurceno_podvod: 0, neurceno_ok: 1 });
});

test('renderReport: hlavička s detekcí bez ČOI, každé procento se jmenovatelem', () => {
  const md = renderReport(MIXED, META);
  const lines = md.split('\n');
  assert.equal(lines[0], '# Výsledky testovací sady');
  assert.ok(lines.includes('- Datum: 2026-10-16, API: http://x/webhook'));
  assert.ok(lines.includes('- Počet případů: 12 (ok: 5, sporné: 1, podvod: 6)'));
  assert.ok(lines.includes('Malý vzorek: výsledky jsou orientační (n = 12).'));
  assert.ok(!md.includes('⚠'));
  assert.ok(!md.includes('Vyhodnoceno:'));
  const head = md.split('## Detekce (bez skupiny ČOI)')[1].split('\n## ')[0];
  assert.ok(head.includes('- Zachycené podvody (oranžová nebo červená): 1/2 (50 %)'));
  assert.ok(head.includes('- Falešný poplach u legitimních nabídek: 1/5 (20 %)'));
  assert.ok(head.includes('- Nelze posoudit (šedá nebo žádost o víc údajů): 2/8 (25 %)'));
  assert.ok(head.includes('- Nelze posoudit u podvodů: 0/2 (0 %), u legitimních nabídek: 1/5 (20 %)'));
});

test('renderReport: sekce po skupinách s vlastními x/y a poznámka u ČOI', () => {
  const md = renderReport(MIXED, META);
  const sec = (name) => md.split('## Skupina ' + name)[1].split('\n## ')[0];
  const coi = sec('ČOI (coi)');
  assert.ok(coi.includes('- Počet případů: 4'));
  assert.ok(coi.includes('- Zachycené podvody (oranžová nebo červená): 3/4 (75 %)'));
  assert.ok(coi.includes('- Falešný poplach u legitimních nabídek: n/a'));
  assert.ok(coi.includes(COI_NOTE));
  const legit = sec('legit');
  assert.ok(legit.includes('- Falešný poplach u legitimních nabídek: 1/4 (25 %)'));
  assert.ok(legit.includes('- Zachycené podvody (oranžová nebo červená): n/a'));
  assert.ok(!legit.includes('kruhová'));
  const syn = sec('synthetic');
  assert.ok(syn.includes('- Zachycené podvody (oranžová nebo červená): 1/2 (50 %)'));
  assert.ok(!syn.includes('kruhová'));
  assert.ok(!md.includes('## Skupina screens'));
  // pořadí: detekce před skupinami, ČOI před legit
  assert.ok(md.indexOf('## Detekce') < md.indexOf('## Skupina ČOI'));
  assert.ok(md.indexOf('## Skupina ČOI') < md.indexOf('## Skupina legit'));
});

test('renderReport: matice, signály a případy mimo očekávání s druhem', () => {
  const md = renderReport(MIXED, META);
  assert.ok(md.includes('| podvod | 2 | 4 | 0 | 0 |'));
  assert.ok(md.includes('| ok | 3 | 1 | 1 | 0 |'));
  assert.ok(md.includes('| sig-a | 2 | 1 / 0 / 1 |'));
  assert.ok(!md.includes('## Chybně zařazené případy'));
  const out = md.split('## Případy mimo očekávání')[1].split('\n## ')[0];
  assert.ok(out.includes('- c4 [coi] (zmeškaný podvod: podvod -> zelená, skóre 0): signály: žádné'));
  assert.ok(out.includes('- l3 [legit] (falešný poplach: ok -> oranžová, skóre 40): signály: sig-a'));
  assert.ok(out.includes('- l4 [legit] (neurčeno: ok -> šedá, skóre 0): signály: žádné'));
  assert.ok(out.includes('- s2 [synthetic] (zmeškaný podvod: podvod -> zelená, skóre 5): signály: žádné'));
  assert.ok(!out.includes('c1'));
  assert.ok(!out.includes('s4'));
});

test('renderReport: smíšený běh s chybami: varování, Vyhodnoceno, sazby jen z vyhodnocených', () => {
  const r = [
    mk('c1', 'podvod', 'coi', 'červená'), err('c2', 'podvod', 'coi'),
    mk('l1', 'ok', 'legit', 'zelená'), mk('l2', 'ok', 'legit', 'oranžová'), err('l3', 'ok', 'legit', 'HTTP 500: x'),
    mk('s1', 'podvod', 'synthetic', 'červená'), err('s2', 'podvod', 'synthetic'),
  ];
  const md = renderReport(r, META);
  const lines = md.split('\n');
  assert.ok(lines.includes('⚠ 3 z 7 požadavků skončilo chybou; metriky nejsou úplné.'));
  assert.ok(lines.includes('Vyhodnoceno: 4/7'));
  assert.ok(lines.includes('Procenta se počítají jen z vyhodnocených případů (bez chyb požadavků); chyby jsou uvedeny zvlášť.'));
  assert.ok(!md.includes('Žádný případ nebyl vyhodnocen.'));
  const head = md.split('## Detekce (bez skupiny ČOI)')[1].split('\n## ')[0];
  assert.ok(head.includes('- Zachycené podvody (oranžová nebo červená): 1/1 (100 %)'));
  assert.ok(head.includes('- Falešný poplach u legitimních nabídek: 1/2 (50 %)'));
  assert.ok(head.includes('- Chyby požadavků: 2'));
  const out = md.split('## Případy mimo očekávání')[1].split('\n## ')[0];
  assert.ok(out.includes('- l3 [legit] (chyba: ok -> chyba): HTTP 500: x'));
  assert.ok(out.includes('- c2 [coi] (chyba: podvod -> chyba): timeout'));
});

test('renderReport: běh, kde všechny požadavky selhaly, nesmí vypadat dokonale', () => {
  const r = [err('c1', 'podvod', 'coi'), err('l1', 'ok', 'legit'), err('s1', 'podvod', 'synthetic'), err('s2', 'ok', 'synthetic')];
  const md = renderReport(r, META);
  const lines = md.split('\n');
  assert.ok(lines.includes('⚠ 4 z 4 požadavků skončilo chybou; metriky nejsou úplné.'));
  assert.ok(lines.includes('Vyhodnoceno: 0/4'));
  assert.ok(lines.includes('Žádný případ nebyl vyhodnocen.'));
  assert.ok(lines.includes('- Zachycené podvody (oranžová nebo červená): n/a'));
  assert.ok(lines.includes('- Falešný poplach u legitimních nabídek: n/a'));
  assert.ok(lines.includes('- Nelze posoudit (šedá nebo žádost o víc údajů): n/a'));
  assert.ok(!/0\/0|\b0 %/.test(md));
  assert.ok(lines.includes('Malý vzorek: výsledky jsou orientační (n = 4).'));
});

test('renderReport: bez varování o malém vzorku od 100 případů', () => {
  const r = Array.from({ length: 100 }, (_, i) => mk('x' + i, 'ok', 'legit', 'zelená'));
  const md = renderReport(r, META);
  assert.ok(!md.includes('Malý vzorek'));
  assert.ok(md.includes('- Falešný poplach u legitimních nabídek: 0/100 (0 %)'));
});

test('renderReport: prázdný vstup', () => {
  const md = renderReport([], META);
  assert.ok(md.includes('- Počet případů: 0 (ok: 0, sporné: 0, podvod: 0)'));
  assert.ok(md.includes('Žádný případ nebyl vyhodnocen.'));
  assert.ok(md.includes('Malý vzorek: výsledky jsou orientační (n = 0).'));
  assert.ok(!md.includes('⚠'));
});

test('renderReport: výsledek bez skupiny nehází', () => {
  const md = renderReport([{ id: 'x', label: 'ok', stav: 'ok', semafor: 'zelená', signaly: [] }], META);
  assert.ok(md.includes('## Skupina nezarazeno'));
});

// ---- cases.json ----

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'cases.json'), 'utf8'));
const GROUPS = ['coi', 'legit', 'synthetic', 'produkt', 'screens'];
const COI_POZNAMKA = 'ČOI = rizikový provozovatel, ne prokázaný podvod';
const LEGIT_POZNAMKA = 'Obchod může blokovat automatické načtení; šedá je pak očekávaná.';

test('cases.json: schéma', () => {
  assert.ok(Array.isArray(CASES));
  const ids = new Set();
  for (const c of CASES) {
    assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/, 'id ' + c.id);
    assert.ok(!ids.has(c.id), 'duplicitní id ' + c.id);
    ids.add(c.id);
    assert.ok(['ok', 'sporne', 'podvod'].includes(c.label), 'label ' + c.id);
    assert.ok(GROUPS.includes(c.skupina), 'skupina je povinná a z ' + GROUPS.join('/') + ': ' + c.id);
    assert.equal(typeof c.zdroj, 'string');
    assert.ok(c.zdroj.length > 0);
    if (c.poznamka !== undefined) assert.equal(typeof c.poznamka, 'string');
    const kinds = ['odkaz', 'text', 'screenshotFiles'].filter((k) => c[k] !== undefined);
    assert.equal(kinds.length, 1, 'právě jeden druh vstupu: ' + c.id);
    // Skupiny coi a legit jsou kořeny domén; skupina produkt je konkrétní produktová stránka (cesta ano, query a fragment ne).
    if (c.odkaz !== undefined && c.skupina === 'produkt') assert.match(c.odkaz, /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/[^\s?#]*$/, 'odkaz ' + c.id);
    else if (c.odkaz !== undefined) assert.match(c.odkaz, /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/$/, 'odkaz ' + c.id);
    if (c.text !== undefined) assert.ok(typeof c.text === 'string' && c.text.trim().length > 0);
    if (c.screenshotFiles !== undefined) {
      assert.ok(Array.isArray(c.screenshotFiles) && c.screenshotFiles.length > 0);
      for (const f of c.screenshotFiles) assert.match(f, /^[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i);
    }
    assert.deepEqual(Object.keys(c).filter((k) => !['id', 'label', 'skupina', 'odkaz', 'text', 'screenshotFiles', 'zdroj', 'poznamka'].includes(k)), []);
    // druh vstupu odpovídá skupině
    const expected = { coi: 'odkaz', legit: 'odkaz', synthetic: 'text', produkt: 'odkaz', screens: 'screenshotFiles' }[c.skupina];
    assert.equal(kinds[0], expected, 'vstup ve skupině ' + c.skupina + ': ' + c.id);
  }
});

test('cases.json: složení sady po skupinách', () => {
  const g = (s) => CASES.filter((c) => c.skupina === s);
  assert.equal(g('coi').length, 15);
  assert.ok(g('coi').every((c) => c.label === 'podvod' && c.poznamka === COI_POZNAMKA && /^ČOI seznam, stav \d{4}-\d{2}-\d{2}/.test(c.zdroj)));
  assert.equal(g('legit').length, 15);
  assert.ok(g('legit').every((c) => c.label === 'ok' && c.poznamka === LEGIT_POZNAMKA && c.zdroj === 'známý ověřený e-shop'));
  assert.equal(g('synthetic').length, 4);
  assert.deepEqual(g('synthetic').map((c) => c.label).sort(), ['ok', 'podvod', 'podvod', 'sporne']);
  // Vlastní testy uživatele (2026-10-19): skutečné produktové stránky a screenshot AliExpressu.
  assert.equal(g('produkt').length, 4);
  assert.deepEqual(g('produkt').map((c) => c.label).sort(), ['ok', 'ok', 'ok', 'sporne']);
  assert.equal(g('screens').length, 1);
  assert.equal(g('screens')[0].label, 'sporne');
  assert.equal(CASES.length, 39);
  assert.ok(CASES.some((c) => /Ignoruj všechny instrukce/.test(c.text || '')));
  assert.equal(new Set(CASES.filter((c) => c.odkaz).map((c) => c.odkaz)).size, 34);
  assert.ok(!CASES.some((c) => /blockchain/.test(c.id)));
});
