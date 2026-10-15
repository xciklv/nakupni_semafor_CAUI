const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUrl, validateInput, htmlToText, checkQuota } = require('../engine/input');

test('odkaz bez protokolu a s www', () => {
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

// --- SSRF: adresy, na které n8n nesmí server-side fetchovat ---

const SSRF_BLOCKED = [
  'localhost:5678/x', 'http://127.0.0.1:5678/webhook', 'http://[::1]/', 'http://0.0.0.0/',
  'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
  'http://foo.local/', 'http://2130706433/', 'http://0x7f.1/', 'http://127.1/', 'http://%31%32%37.0.0.1/',
  'http://user:pw@evil.cz@127.0.0.1/', 'https://shop.cz:8080/', 'http://[fd00::1]/', 'http://[::ffff:10.0.0.1]/',
  'http://[::]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:192.168.1.1]/',
  'http://100.64.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/', 'http://172.31.255.255/',
  'http://169.254.1.1/', 'http://0.1.2.3/', 'http://a.localhost/', 'http://x.internal/',
  'http://x.localdomain/', 'http://x.lan/', 'http://x.home.arpa/', 'http://localhost./x',
  'http://user@shop.cz/', 'http://shop.cz:81/', 'http://shop.cz:21/',
];

const PUBLIC_OK = [
  'alza.cz', 'https://www.temu.com/cz/foo.html', 'http://93.184.216.34/', 'https://shop.cz:443/',
  'https://shop.cz:80/', 'http://172.32.0.1/', 'http://100.128.0.1/', 'https://[2606:4700::1111]/',
];

test('vnitřní a neveřejné adresy → ok:false (SSRF)', () => {
  for (const raw of SSRF_BLOCKED) assert.equal(normalizeUrl(raw).ok, false, raw);
});

test('veřejné hosty včetně veřejného IPv4 literálu projdou', () => {
  for (const raw of PUBLIC_OK) assert.equal(normalizeUrl(raw).ok, true, raw);
});

test('tečka na konci hostname se odstraní před kontrolou a párováním', () => {
  assert.equal(normalizeUrl('bit.ly./x').ok, false);
  assert.equal(normalizeUrl('https://temu.com./cz/foo.html').rezim, 'marketplace');
});

test('zkrácené hosty včetně subdomény a tečky jsou zkrácené', () => {
  assert.equal(normalizeUrl('https://m.bit.ly/x').ok, false);
  assert.equal(normalizeUrl('https://bit.ly./x').ok, false);
});

test('utm parametry se nemažou', () => {
  assert.equal(normalizeUrl('alza.cz/p?utm_source=x').url, 'https://alza.cz/p?utm_source=x');
});

test('nestringový odkaz se chová jako žádný odkaz', () => {
  assert.equal(normalizeUrl(5), null);
  assert.equal(normalizeUrl({}), null);
  assert.equal(normalizeUrl(['bit.ly/x']), null);
  assert.equal(validateInput({ odkaz: 5 }).status, 400);
  const r = validateInput({ odkaz: {}, text: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.input.url, null);
});

test('screenshoty, které nejsou pole → 400', () => {
  const r = validateInput({ screenshoty: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.chyba, 'Nepodporovaný formát screenshotů.');
});

// --- htmlToText: neuzavřené bloky, komentáře, dekódování, limit ---

test('neuzavřený script zahodí zbytek dokumentu', () => {
  assert.equal(htmlToText('<p>a</p><script>var p=1;'), 'a');
  assert.equal(htmlToText('<script>a</script2>x<script>var p=1;').includes('var p'), false);
});

test('HTML komentáře se odstraní, neuzavřený komentář zahodí zbytek', () => {
  assert.equal(htmlToText('<p>a</p><!-- secret <b>x</b> --><p>b</p>'), 'a b');
  assert.equal(htmlToText('<p>a</p><!-- secret'), 'a');
});

test('style a noscript se odstraní', () => {
  assert.equal(htmlToText('<noscript>x</noscript>a<style>b</style>'), 'a');
});

test('dekódování &amp; je poslední', () => {
  assert.equal(htmlToText('&amp;lt;'), '&lt;');
});

test('null a undefined → prázdný text', () => {
  assert.equal(htmlToText(null), '');
  assert.equal(htmlToText(undefined), '');
});

test('vstup se ořízne na 2 000 000 znaků', () => {
  assert.equal(htmlToText('a'.repeat(3000000), 10000000).length, 2000000);
});

// --- htmlToText: linearita (ReDoS) ---

const PATHOLOGICAL = [
  ["'<' x 100000", '<'.repeat(100000)],
  ["'<script>' x 100000 (800 KB)", '<script>'.repeat(100000)],
  ["'<style>' x 114000 (800 KB)", '<style>'.repeat(114000)],
  ["'<!--' x 200000 (800 KB)", '<!--'.repeat(200000)],
  ["'</script ' x 100000", '</script '.repeat(100000)],
];

for (const [label, html] of PATHOLOGICAL) {
  test(`htmlToText je lineární, ${label} do 1 s`, () => {
    const t0 = Date.now();
    htmlToText(html);
    const dt = Date.now() - t0;
    assert.ok(dt < 1000, `trvalo ${dt} ms`);
  });
}

test('hostname bez tečky (kromě IP literálů) → ok:false', () => {
  for (const raw of ['https://constructor', 'https://__proto__', 'https://toString/x', 'https://intranet', 'http://hasOwnProperty/']) {
    const r = normalizeUrl(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.duvod, 'neplatná adresa', raw);
  }
});

test('alza.cz a veřejné IP literály zůstávají ok', () => {
  for (const raw of ['https://alza.cz', 'http://93.184.216.34/', 'http://[2001:db8::1]/']) assert.equal(normalizeUrl(raw).ok, true, raw);
});
