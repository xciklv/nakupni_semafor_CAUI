// Kritérium stability evalu (eval/gate.js): čisté funkce nad záznamy výsledků, žádné volání API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateGate, isMarketplaceCase, formatGate, requiredAgreement } = require('../eval/gate');

// Záznam jednoho běhu ve tvaru z toResultRecord (semafor = výsledek, jinak stav).
const rec = (id, label, semafor, extra = {}) => ({ id, label, skupina: 'synthetic', stav: 'ok', semafor, skore: 0, signaly: [], ...extra });
const runs = (id, label, semafory, extra = {}) => semafory.map((s) => (s === 'chyba'
  ? { id, label, skupina: 'synthetic', stav: 'chyba', chyba: 'timeout', ...extra }
  : s === 'potrebuji_vice'
    ? { id, label, skupina: 'synthetic', stav: 'potrebuji_vice', zprava: 'x', ...extra }
    : rec(id, label, s, extra)));
const Z = 'zelená', O = 'oranžová', C = 'červená', S = 'šedá';

test('requiredAgreement: ceil(0,8 × repeat) bez chyby plovoucí řádky', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8, 10].map(requiredAgreement), [1, 2, 3, 4, 4, 7, 8]);
  assert.equal(requiredAgreement(1), 1);
  assert.equal(requiredAgreement(3), 3);
  assert.equal(requiredAgreement(5), 4);
  assert.equal(requiredAgreement(8), 7);
  assert.equal(requiredAgreement(10), 8);
});

test('gate: 5 běhů zelená u případu ok projde', () => {
  const g = evaluateGate(runs('a', 'ok', [Z, Z, Z, Z, Z]), { repeat: 5 });
  assert.equal(g.pass, true);
  assert.deepEqual(g.duvody, []);
});

test('gate: 3 zelená + 2 oranžová u ok případu selže a důvod nese id případu', () => {
  const g = evaluateGate(runs('kabel-ok', 'ok', [Z, Z, Z, O, O]), { repeat: 5 });
  assert.equal(g.pass, false);
  assert.ok(g.duvody.some((d) => d.includes('kabel-ok')), g.duvody.join('|'));
});

test('gate: 4 z 5 stejně projde (hranice ceil(0,8 × 5) = 4)', () => {
  assert.equal(evaluateGate(runs('a', 'podvod', [O, O, O, O, Z]), { repeat: 5 }).pass, true);
});

test('gate: oranžová a červená jsou jedna strana (problém)', () => {
  assert.equal(evaluateGate(runs('a', 'podvod', [O, C, O, C, C]), { repeat: 5 }).pass, true);
});

test('gate: neurčeno (šedá, potrebuji_vice, chyba) u podvodu se nepočítá jako shoda se žádnou stranou', () => {
  // 3× problém + 2× šedá: shoda jen 3 z 5, požadováno 4
  const g = evaluateGate(runs('p', 'podvod', [O, O, O, S, S]), { repeat: 5 });
  assert.equal(g.pass, false);
  assert.ok(g.duvody.some((d) => d.includes('p')));
  assert.equal(evaluateGate(runs('p', 'podvod', [O, O, O, 'potrebuji_vice', 'chyba']), { repeat: 5 }).pass, false);
  // šedá se nepřipočte ani k „zelené“: 3× zelená + 2× šedá u ok případu také neprojde
  assert.equal(evaluateGate(runs('o', 'ok', [Z, Z, Z, S, S]), { repeat: 5 }).pass, false);
});

test('gate: repeat 1: jeden běh problém/ok projde, šedá nebo chyba ne', () => {
  assert.equal(evaluateGate(runs('a', 'ok', [Z]), { repeat: 1 }).pass, true);
  assert.equal(evaluateGate(runs('a', 'podvod', [C]), { repeat: 1 }).pass, true);
  assert.equal(evaluateGate(runs('a', 'ok', [S]), { repeat: 1 }).pass, false);
  assert.equal(evaluateGate(runs('a', 'ok', ['chyba']), { repeat: 1 }).pass, false);
});

test('gate: repeat 3 vyžaduje všechny tři stejné', () => {
  assert.equal(evaluateGate(runs('a', 'ok', [Z, Z, Z]), { repeat: 3 }).pass, true);
  assert.equal(evaluateGate(runs('a', 'ok', [Z, Z, O]), { repeat: 3 }).pass, false);
});

test('gate: počet běhů případu se musí shodovat s repeat', () => {
  const g = evaluateGate(runs('a', 'ok', [Z, Z, Z]), { repeat: 5 });
  assert.equal(g.pass, false);
  assert.ok(g.duvody.some((d) => d.includes('a')));
});

test('gate: kolísání 1 z 8 případů při repeat 5 projde, 2 z 8 selže', () => {
  const stable = (n) => Array.from({ length: 8 - n }, (_, i) => runs('s' + i, 'ok', [Z, Z, Z, Z, Z])).flat();
  const wobble = (id) => runs(id, 'ok', [Z, Z, Z, Z, O]); // 4 z 5: sám o sobě projde, ale kolísá
  const one = evaluateGate([...stable(1), ...wobble('k1')], { repeat: 5 });
  assert.equal(one.pass, true, one.duvody.join('|'));
  const two = evaluateGate([...stable(2), ...wobble('k1'), ...wobble('k2')], { repeat: 5 });
  assert.equal(two.pass, false);
  assert.ok(two.duvody.some((d) => d.includes('k1') && d.includes('k2')), two.duvody.join('|'));
});

test('gate: limit kolísání je ceil(n / 8): jeden případ i u malé sady, dva až od devíti', () => {
  const stable = (n) => Array.from({ length: n }, (_, i) => runs('s' + i, 'ok', [Z, Z, Z, Z, Z])).flat();
  const wobble = (id) => runs(id, 'ok', [Z, Z, Z, Z, O]);
  assert.equal(evaluateGate([...stable(6), ...wobble('k1')], { repeat: 5 }).pass, true); // 1 ze 7
  assert.equal(evaluateGate([...stable(5), ...wobble('k1'), ...wobble('k2')], { repeat: 5 }).pass, false); // 2 ze 7
  assert.equal(evaluateGate([...stable(6), ...wobble('k1'), ...wobble('k2')], { repeat: 5 }).pass, false); // 2 z 8
  assert.equal(evaluateGate([...stable(7), ...wobble('k1'), ...wobble('k2')], { repeat: 5 }).pass, true); // 2 z 9
  assert.equal(evaluateGate([...stable(6), ...wobble('k1'), ...wobble('k2'), ...wobble('k3')], { repeat: 5 }).pass, false); // 3 z 9
});

test('gate: limit kolísání se počítá až od repeat 5 (při 3 běhy stejně vyžadují všechny shodné)', () => {
  const g = evaluateGate([...runs('a', 'ok', [Z, Z, Z]), ...runs('b', 'ok', [Z, Z, Z])], { repeat: 3 });
  assert.equal(g.pass, true);
});

test('gate: kolísání počítá i sporné případy a sporný případ se sám na shodu nehodnotí', () => {
  const stable = (n) => Array.from({ length: n }, (_, i) => runs('s' + i, 'ok', [Z, Z, Z, Z, Z])).flat();
  const sporne = (id) => runs(id, 'sporne', [O, O, S, S, O]); // shoda jen 3 z 5, ale label sporne se na správnost neměří
  const one = evaluateGate([...stable(7), ...sporne('x1')], { repeat: 5 });
  assert.equal(one.pass, true, one.duvody.join('|'));
  assert.equal(evaluateGate([...stable(6), ...sporne('x1'), ...sporne('x2')], { repeat: 5 }).pass, false);
});

test('gate: sporný marketplace případ skupiny produkt se zelenou je selhání, i při jediném zeleném běhu', () => {
  const m = { skupina: 'produkt', marketplace: true };
  const g = evaluateGate(runs('produkt-cyklosvitilna-odkaz', 'sporne', [O, O, O, O, Z], m), { repeat: 5 });
  assert.equal(g.pass, false);
  assert.ok(g.duvody.some((d) => d.includes('produkt-cyklosvitilna-odkaz') && /zelen/i.test(d)), g.duvody.join('|'));
  assert.equal(evaluateGate(runs('p', 'sporne', [Z], m), { repeat: 1 }).pass, false);
  assert.equal(evaluateGate(runs('p', 'sporne', [O, O, O, O, O], m), { repeat: 5 }).pass, true);
});

test('gate: sporný případ mimo marketplace nebo mimo skupinu produkt se zelenou neselhává', () => {
  assert.equal(evaluateGate(runs('p', 'sporne', [Z, Z, Z, Z, Z], { skupina: 'produkt' }), { repeat: 5 }).pass, true);
  assert.equal(evaluateGate(runs('p', 'sporne', [Z, Z, Z, Z, Z], { skupina: 'synthetic', marketplace: true }), { repeat: 5 }).pass, true);
});

test('gate: více důvodů najednou a prázdný vstup', () => {
  const g = evaluateGate([...runs('a', 'ok', [Z, Z, O, O, S]), ...runs('b', 'podvod', [O, O, O, S, S])], { repeat: 5 });
  assert.equal(g.pass, false);
  assert.ok(g.duvody.some((d) => d.includes('a')) && g.duvody.some((d) => d.includes('b')));
  const empty = evaluateGate([], { repeat: 5 });
  assert.equal(empty.pass, false);
  assert.ok(empty.duvody.length > 0);
});

test('gate: neplatný repeat vyhodí chybu', () => {
  for (const bad of [0, -1, 2.5, NaN, undefined, '5']) assert.throws(() => evaluateGate([], { repeat: bad }), /repeat/, String(bad));
  assert.throws(() => evaluateGate([]), /repeat/);
});

test('isMarketplaceCase: podle domény odkazu nebo příznaku marketplace', () => {
  assert.equal(isMarketplaceCase({ odkaz: 'https://www.aliexpress.com/item/1.html' }), true);
  assert.equal(isMarketplaceCase({ odkaz: 'https://aliexpress.com/item/1.html' }), true);
  assert.equal(isMarketplaceCase({ odkaz: 'https://www.temu.com/x.html' }), true);
  assert.equal(isMarketplaceCase({ odkaz: 'https://allegro.cz/nabidka/x' }), true);
  assert.equal(isMarketplaceCase({ odkaz: 'https://www.action.com/cs-cz/p/1/' }), false);
  assert.equal(isMarketplaceCase({ odkaz: 'https://evil.com/?u=aliexpress.com' }), false);
  assert.equal(isMarketplaceCase({ odkaz: 'https://notaliexpress.com/x' }), false);
  assert.equal(isMarketplaceCase({ text: 'nabídka', marketplace: true }), true);
  assert.equal(isMarketplaceCase({ text: 'nabídka' }), false);
  assert.equal(isMarketplaceCase(null), false);
});

test('formatGate: PASS/FAIL a důvody po řádcích', () => {
  assert.deepEqual(formatGate({ pass: true, duvody: [] }), ['PASS']);
  assert.deepEqual(formatGate({ pass: false, duvody: ['a: x', 'b: y'] }), ['FAIL', '- a: x', '- b: y']);
});

test('run-eval.js se dá načíst (syntaxe) a zná přepínač --gate', () => {
  const { spawnSync } = require('node:child_process');
  const file = require('node:path').join(__dirname, '..', 'eval', 'run-eval.js');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(require('node:fs').readFileSync(file, 'utf8'), /opts\.gate/);
});
