const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, validateInput, htmlToText, checkQuota } = require('../engine/input');

test('odkaz bez protokolu, www a tracking parametry', () => {
  const r = normalizeUrl('www.Alza.cz/produkt?utm_source=x');
  assert.equal(r.ok, true);
  assert.equal(r.host, 'alza.cz');
  assert.equal(r.rezim, 'eshop');
});

test('marketplace včetně subdomén', () => {
  assert.equal(normalizeUrl('https://www.temu.com/cz/foo.html').rezim, 'marketplace');
  assert.equal(normalizeUrl('https://cs.aliexpress.com/item/1.html').rezim, 'marketplace');
  assert.equal(normalizeUrl('https://www.allegro.cz/nabidka/1').rezim, 'marketplace');
});

test('zkrácený a nebezpečný odkaz → ok:false', () => {
  assert.equal(normalizeUrl('bit.ly/abc').ok, false);
  assert.equal(normalizeUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeUrl('ftp://x.cz/a').ok, false);
});

test('diakritická doména projde', () => {
  assert.equal(normalizeUrl('https://české-zboží.cz/a').ok, true);
});

test('prázdný odkaz → null', () => {
  assert.equal(normalizeUrl('   '), null);
  assert.equal(normalizeUrl(undefined), null);
});

test('prázdný vstup → 400', () => {
  const r = validateInput({});
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('vstup mimo limity → 413', () => {
  assert.equal(validateInput({ text: 'a'.repeat(100000) }).status, 413);
  const shot = { mime: 'image/png', data: 'AAAA' };
  assert.equal(validateInput({ screenshoty: [shot, shot, shot, shot, shot] }).status, 413);
  assert.equal(validateInput({ screenshoty: [{ mime: 'image/png', data: 'A'.repeat(6000000) }] }).status, 413);
});

test('nepodporovaný formát obrázku → 400', () => {
  assert.equal(validateInput({ screenshoty: [{ mime: 'image/gif', data: 'AAAA' }] }).status, 400);
});

test('neplatný odkaz bez dalšího vstupu → 400, s textem projde bez odkazu', () => {
  assert.equal(validateInput({ odkaz: 'bit.ly/x' }).status, 400);
  const r = validateInput({ odkaz: 'bit.ly/x', text: 'nabídka' });
  assert.equal(r.ok, true);
  assert.equal(r.input.url, null);
});

test('htmlToText odstraní skripty, styly a tagy', () => {
  const t = htmlToText('<style>a{}</style><script>evil()</script><h1>Powerbanka&nbsp;20000</h1><p>Cena 199&nbsp;Kč</p>');
  assert.equal(t, 'Powerbanka 20000 Cena 199 Kč');
});

test('htmlToText ořízne na max', () => {
  assert.equal(htmlToText('<p>' + 'a'.repeat(100) + '</p>', 10).length, 10);
});

test('checkQuota počítá za den a resetuje se', () => {
  const st = {};
  const day1 = Date.parse('2026-10-20T10:00:00Z');
  assert.equal(checkQuota(st, day1, 2).ok, true);
  assert.equal(checkQuota(st, day1, 2).ok, true);
  assert.equal(checkQuota(st, day1, 2).ok, false);
  assert.equal(checkQuota(st, day1 + 86400000, 2).ok, true);
});
