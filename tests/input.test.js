const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeUrl, validateInput, htmlToText, checkQuota, detectMarketplace } = require('../engine/input');
const { runInRealisticSandbox, createRealisticContext, FORBIDDEN_GLOBALS } = require('./sandbox');

const ASCII_DUVOD = 'neplatný odkaz (použijte adresu v ASCII tvaru nebo vložte text či screenshot)';

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

test('diakritická doména je odmítnuta (ASCII-only), punycode projde', () => {
  const r = normalizeUrl('https://české-zboží.cz/a');
  assert.equal(r.ok, false);
  assert.equal(r.duvod, ASCII_DUVOD);
  const p = normalizeUrl('https://xn--esk-zbo-q7a3d.cz/a');
  assert.equal(p.ok, true);
  assert.equal(p.host, 'xn--esk-zbo-q7a3d.cz');
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

const FORMAT_CHYBA = 'Nepodporovaný formát obrázku (PNG, JPEG, WEBP).';

test('data screenshotu: platné base64 projde', () => {
  for (const data of ['AAAA', 'QUJD', 'QQ==', 'QUI=', 'abc+/0123456789XYZ', 'A'.repeat(200)]) {
    assert.equal(validateInput({ screenshoty: [{ mime: 'image/png', data }] }).ok, true, data);
  }
});

test('data screenshotu: prázdná, s mezerami, novými řádky, uvozovkami, data: prefixem, unicode nebo víc "=" se odmítají (400)', () => {
  const bad = ['', 'AA AA', 'AAAA\n', 'AA\nAA', 'AA"AA', "AA'AA", 'data:image/png;base64,AAAA', 'AAAé', 'AA AA', 'AAA===', 'A=AA', '<svg/>', 'AAAA\0'];
  for (const data of bad) {
    const r = validateInput({ screenshoty: [{ mime: 'image/png', data }] });
    assert.equal(r.ok, false, JSON.stringify(data));
    assert.equal(r.status, 400, JSON.stringify(data));
    assert.equal(r.chyba, FORMAT_CHYBA);
  }
});

test('data screenshotu: 5 MB platného base64 se ověří rychle (lineárně), o znak víc je 413', () => {
  const t0 = Date.now();
  const r = validateInput({ screenshoty: [{ mime: 'image/jpeg', data: 'A'.repeat(5000000) }] });
  assert.equal(r.ok, true);
  const bad = validateInput({ screenshoty: [{ mime: 'image/jpeg', data: 'A'.repeat(4999999) + '!' }] });
  assert.equal(bad.status, 400);
  assert.ok(Date.now() - t0 < 1000, 'validace trvala ' + (Date.now() - t0) + ' ms');
  assert.equal(validateInput({ screenshoty: [{ mime: 'image/png', data: 'A'.repeat(5000001) }] }).status, 413);
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
  // IPv6 literály se odmítají celé, i veřejné (záměrně přísnější než normalizace URL).
  'https://[2606:4700::1111]/', 'http://[2001:db8::1]/',
];

const PUBLIC_OK = [
  'alza.cz', 'https://www.temu.com/cz/foo.html', 'http://93.184.216.34/', 'https://shop.cz:443/',
  'http://shop.cz:80/', 'https://shop.cz/', 'http://shop.cz/', 'http://172.32.0.1/', 'http://100.128.0.1/',
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
  for (const raw of ['https://constructor', 'https://__proto__', 'https://toString/x', 'https://printer', 'http://hasOwnProperty/']) {
    const r = normalizeUrl(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.duvod, 'neplatná adresa', raw);
  }
});

test('alza.cz a veřejný IPv4 literál zůstávají ok, veřejný IPv6 literál je odmítnut', () => {
  for (const raw of ['https://alza.cz', 'http://93.184.216.34/']) assert.equal(normalizeUrl(raw).ok, true, raw);
  assert.equal(normalizeUrl('http://[2001:db8::1]/').ok, false);
});

// --- ruční parser URL (v Code nodu n8n globál URL neexistuje) ---

// [vstup, očekávané ok, očekávaná url, očekávaný host] (url a host jen pro ok:true)
const URL_CASES = [
  ['https://www.alza.cz/produkt?utm_source=x', true, 'https://www.alza.cz/produkt?utm_source=x', 'alza.cz'],
  ['www.alza.cz/x?utm=1', true, 'https://www.alza.cz/x?utm=1', 'alza.cz'],
  ['HTTPS://WWW.ALZA.CZ/Path?Q=A', true, 'https://www.alza.cz/Path?Q=A', 'alza.cz'],
  ['http://Alza.CZ/x', true, 'http://alza.cz/x', 'alza.cz'],
  ['https://alza.cz./x', true, 'https://alza.cz/x', 'alza.cz'],
  ['https://alza.cz...', true, 'https://alza.cz/', 'alza.cz'],
  ['https://alza.cz:443/x', true, 'https://alza.cz/x', 'alza.cz'],
  ['http://alza.cz:80/x', true, 'http://alza.cz/x', 'alza.cz'],
  ['https://alza.cz/x#frag', true, 'https://alza.cz/x', 'alza.cz'],
  ['https://alza.cz#frag', true, 'https://alza.cz/', 'alza.cz'],
  ['https://alza.cz?a=1#frag?b', true, 'https://alza.cz/?a=1', 'alza.cz'],
  ['https://alza.cz/a%20b?x=%2F', true, 'https://alza.cz/a%20b?x=%2F', 'alza.cz'],
  ['https://xn--esk-zbo-q7a3d.cz/a', true, 'https://xn--esk-zbo-q7a3d.cz/a', 'xn--esk-zbo-q7a3d.cz'],
  ['http://93.184.216.34/', true, 'http://93.184.216.34/', '93.184.216.34'],
  ['https://www.temu.com/cz/foo.html', true, 'https://www.temu.com/cz/foo.html', 'temu.com'],
  ['  https://alza.cz/x  ', true, 'https://alza.cz/x', 'alza.cz'],
  ['https://sub-1.shop.co.uk/a', true, 'https://sub-1.shop.co.uk/a', 'sub-1.shop.co.uk'],
  ['http://172.32.0.1/', true, 'http://172.32.0.1/', '172.32.0.1'],
  // schémata
  ['javascript:alert(1)', false], ['ftp://x.cz/a', false], ['mailto:a@b.cz', false],
  ['data:text/html,<b>x</b>', false], ['file:///etc/passwd', false], ['//alza.cz/x', false],
  // tvar hostitele
  ['https://a..b/', false], ['https://.a.cz/', false], ['https://alza..cz/', false], ['http://localhost../', false],
  ['https://-a.cz/', false], ['https://a-.cz/', false], ['https://a_b.cz/', false], ['https://alza.c0m/', false],
  ['https://alza.c/', false], ['https://' + 'a'.repeat(64) + '.cz/', false],
  ['https://' + ('a'.repeat(60) + '.').repeat(5) + 'cz/', false],
  ['https://', false], ['https:///x', false], ['https://alza.cz@/x', false],
  // číselné a nestandardní IP zápisy
  ['http://2130706433/', false], ['http://0x7f.1/', false], ['http://0x7f.0.0.1/', false], ['http://0177.0.0.1/', false],
  ['http://127.1/', false], ['http://1.2.3/', false], ['http://1.2.3.4.5/', false], ['http://93.184.216.034/', false],
  ['http://256.1.1.1/', false], ['http://127.0.0.1/', false], ['http://10.1.2.3/', false], ['http://169.254.169.254/', false],
  ['http://192.168.0.1/', false], ['http://172.16.0.1/', false], ['http://100.64.0.1/', false], ['http://0.0.0.0/', false],
  ['http://224.0.0.1/', false], ['http://255.255.255.255/', false],
  // authority: userinfo, procenta, porty, IPv6
  ['https://user:pw@alza.cz/', false], ['https://user@alza.cz/', false], ['https://evil.cz@127.0.0.1/', false],
  ['http://%31%32%37.0.0.1/', false], ['https://al%7Aa.cz/', false], ['https://alza.cz%2F@x.cz/', false],
  ['https://alza.cz:8080/', false], ['https://alza.cz:0443/', false], ['https://alza.cz:abc/', false], ['https://alza.cz:80:80/', false],
  ['http://[::1]/', false], ['http://[fd00::1]/', false], ['http://[::ffff:10.0.0.1]/', false], ['http://[2001:db8::1]/', false],
  ['http://localhost/', false], ['localhost:5678/x', false], ['http://foo.local/', false], ['http://a.localhost/', false],
  ['http://x.internal/', false], ['http://x.localdomain/', false], ['http://x.lan/', false], ['http://x.home.arpa/', false],
  ['https://constructor', false], ['https://__proto__', false], ['https://intranet/x', false],
  ['http://shop.cz:443/', false], ['https://shop.cz:80/', false],
  // zkracovače
  ['bit.ly/abc', false], ['https://m.bit.ly./x', false], ['https://s.click.aliexpress.com/e/x', false],
  // znaky mimo tisknutelné ASCII, mezery, řídicí znaky, zpětné lomítko
  ['https://evil.cz\\@127.0.0.1/', false], ['https://alza.cz\\x', false], ['https://alza.cz/a b', false],
  ['https://alza .cz/', false], ['https://alza.cz/\tx', false], ['https://alza.cz/\nx', false], ['https://alza.cz/\u0000', false],
  ['https://alza.cz/á', false], ['https://české-zboží.cz/a', false], ['https://alza.cz/‮', false],
  ['https://alza.cz/' + 'a'.repeat(2033), false],
];

function checkUrlCase(normalize, [raw, ok, url, host]) {
  const r = normalize(raw);
  assert.ok(r && typeof r === 'object', 'výsledek pro ' + JSON.stringify(raw));
  assert.equal(r.ok, ok, 'ok pro ' + JSON.stringify(raw) + ' -> ' + JSON.stringify(r));
  if (ok) {
    assert.equal(r.url, url, 'url pro ' + JSON.stringify(raw));
    assert.equal(r.host, host, 'host pro ' + JSON.stringify(raw));
  } else {
    assert.equal(typeof r.duvod, 'string', 'důvod pro ' + JSON.stringify(raw));
  }
}

test('normalizeUrl: tabulka ok:true / ok:false případů (plain Node)', () => {
  for (const c of URL_CASES) checkUrlCase(normalizeUrl, c);
});

test('normalizeUrl: 2048 znaků projde, 2049 ne', () => {
  const base = 'https://alza.cz/';
  assert.equal(normalizeUrl(base + 'a'.repeat(2048 - base.length)).ok, true);
  assert.equal(normalizeUrl(base + 'a'.repeat(2049 - base.length)).ok, false);
});

test('normalizeUrl: důvody pro ASCII, port, interní adresu, přihlašovací údaje a zkrácený odkaz', () => {
  assert.equal(normalizeUrl('https://evil.cz\\@127.0.0.1/').duvod, ASCII_DUVOD);
  assert.equal(normalizeUrl('https://alza.cz/a b').duvod, ASCII_DUVOD);
  assert.equal(normalizeUrl('https://alza.cz:8080/').duvod, 'nepodporovaný port');
  assert.equal(normalizeUrl('http://127.0.0.1/').duvod, 'odkaz míří na interní nebo neveřejnou adresu');
  assert.equal(normalizeUrl('http://localhost../').duvod, 'odkaz míří na interní nebo neveřejnou adresu');
  assert.equal(normalizeUrl('https://user@alza.cz/').duvod, 'odkaz nesmí obsahovat přihlašovací údaje');
  assert.match(normalizeUrl('bit.ly/x').duvod, /zkrácený odkaz/);
});

test('normalizeUrl: procenta v cestě a dotazu zůstanou, v authority se odmítnou', () => {
  const r = normalizeUrl('https://alza.cz/a%20b?x=%2F');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://alza.cz/a%20b?x=%2F');
  assert.equal(normalizeUrl('https://alza%2ecz/a').ok, false);
});

function sandboxEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'input.js'), 'utf8');
  return runInRealisticSandbox(src + '\n;({ normalizeUrl, validateInput, htmlToText, checkQuota });');
}
const viaJson = (v) => JSON.parse(JSON.stringify(v));

test('realistický sandbox nemá URL, AbortSignal, structuredClone ani další nedostupné globály', () => {
  const ctx = createRealisticContext();
  for (const g of FORBIDDEN_GLOBALS) assert.equal(vm.runInContext('typeof ' + g, ctx), 'undefined', g);
  assert.equal(vm.runInContext('typeof setTimeout + typeof clearTimeout + typeof Object.hasOwn', ctx), 'functionfunctionfunction');
});

test('sandbox bez URL: normalizeUrl dává stejné výsledky jako v plain Node', () => {
  const e = sandboxEngine();
  for (const c of URL_CASES) {
    checkUrlCase((raw) => viaJson(e.normalizeUrl(raw)), c);
    assert.deepEqual(viaJson(e.normalizeUrl(c[0])), viaJson(normalizeUrl(c[0])), JSON.stringify(c[0]));
  }
  assert.equal(e.normalizeUrl('   '), null);
  assert.equal(e.normalizeUrl(undefined), null);
  assert.equal(e.normalizeUrl(5), null);
});

test('sandbox bez URL: validateInput přijme veřejný odkaz a odmítne interní', () => {
  const e = sandboxEngine();
  const ok = viaJson(e.validateInput({ odkaz: 'https://www.alza.cz/x' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.input.url.url, 'https://www.alza.cz/x');
  assert.equal(ok.input.url.host, 'alza.cz');
  for (const odkaz of ['http://127.0.0.1:5678/healthz', 'http://[::1]/', 'http://2130706433/', 'javascript:alert(1)']) {
    const r = viaJson(e.validateInput({ odkaz }));
    assert.equal(r.ok, false, odkaz);
    assert.equal(r.status, 400, odkaz);
  }
  assert.equal(viaJson(e.validateInput({ odkaz: 'bit.ly/x', text: 'nabídka' })).input.url, null);
  assert.equal(viaJson(e.validateInput({})).status, 400);
});

// Sken: API, které v Code nodu n8n není (nebo se na něj nesmí spoléhat), mimo komentáře.
const FORBIDDEN_API = [
  [/\bnew\s+URL\b/, 'new URL'], [/\bURLSearchParams\b/, 'URLSearchParams'], [/\bstructuredClone\b/, 'structuredClone'],
  [/\bBuffer\b/, 'Buffer'], [/\bTextEncoder\b/, 'TextEncoder'], [/\bTextDecoder\b/, 'TextDecoder'],
  [/\bfetch\s*\(/, 'fetch('], [/\bprocess\./, 'process.'], [/\bAbortSignal\b/, 'AbortSignal'],
];
// Odstraní blokové komentáře a řádkové komentáře ('//' na začátku nebo za mezerou, takže 'https://' zůstane).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}
function forbiddenApiIn(src) {
  const code = stripComments(src);
  return FORBIDDEN_API.filter(([re]) => re.test(code)).map(([, name]) => name);
}

test('sken zakázaných API zachytí použití a ignoruje komentáře i https://', () => {
  assert.deepEqual(forbiddenApiIn('const u = new URL(x);'), ['new URL']);
  assert.deepEqual(forbiddenApiIn('x = Buffer.from(a); fetch(u); process.env'), ['Buffer', 'fetch(', 'process.']);
  assert.deepEqual(forbiddenApiIn('// new URL(x)\n/* structuredClone */ const a = 1; // fetch(x)'), []);
  assert.deepEqual(forbiddenApiIn("const s = 'https://' + h; // AbortSignal"), []);
});

test('engine/*.js nepoužívá URL, URLSearchParams, structuredClone, Buffer, TextEncoder/Decoder, fetch, process ani AbortSignal', () => {
  const dir = path.join(__dirname, '..', 'engine');
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(files.length >= 8);
  for (const f of files) assert.deepEqual(forbiddenApiIn(fs.readFileSync(path.join(dir, f), 'utf8')), [], f);
});

test('engine/input.js nemá mrtvý kód po parseru URL (IPv6 expanze)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'input.js'), 'utf8');
  assert.equal(/inpExpandIpv6|inpIpv6Blocked|inpIsBlockedHost/.test(src), false);
});

// --- fix wave B: další neveřejné přípony, wildcard-DNS služby, nesoulad schématu a portu, limit screenshotu ---
test('rezervované a interní přípony (svc, home, corp, intranet, private, test, invalid, example) -> interní adresa', () => {
  for (const suf of ['svc', 'home', 'corp', 'intranet', 'private', 'test', 'invalid', 'example']) {
    for (const raw of ['http://x.' + suf + '/', 'https://a.b.' + suf + '/p?q=1', 'https://X.' + suf.toUpperCase() + './', 'http://' + suf + '/']) {
      const r = normalizeUrl(raw);
      assert.equal(r.ok, false, raw);
      assert.match(r.duvod, /interní/, raw);
    }
  }
  assert.equal(normalizeUrl('http://db.default.svc/').ok, false);
  assert.equal(normalizeUrl('http://nas.home/').ok, false);
});

test('přípony se párují po celých štítcích: shop.cz, testshop.cz, example.cz, home.cz zůstávají veřejné', () => {
  for (const raw of ['https://testshop.cz/', 'https://example.cz/p', 'https://home.cz/', 'https://privatelabel.cz/', 'https://www.svc-shop.cz/', 'https://mytest.com/']) {
    assert.equal(normalizeUrl(raw).ok, true, raw);
  }
});

test('wildcard-DNS a rebinding služby (nip.io, sslip.io, xip.io, localtest.me, lvh.me, traefik.me, local.gd, vcap.me, lacolhost.com, 1u.ms) -> odmítnuto', () => {
  for (const d of ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'traefik.me', 'local.gd', 'vcap.me', 'lacolhost.com', '1u.ms']) {
    for (const raw of ['http://' + d + '/', 'http://127.0.0.1.' + d + '/', 'https://a.b.' + d + '/x', 'https://WWW.' + d.toUpperCase() + './']) {
      const r = normalizeUrl(raw);
      assert.equal(r.ok, false, raw);
      assert.match(r.duvod, /interní/, raw);
    }
  }
});

test('služby se párují po celých štítcích: onip.io, mynip.io.cz, notlocal.gd.cz zůstávají veřejné', () => {
  for (const raw of ['https://onip.io/', 'https://nip.io.cz/', 'https://local.gd.cz/', 'https://xlvh.me/']) {
    assert.equal(normalizeUrl(raw).ok, true, raw);
  }
});

test('nesoulad schématu a portu (http:443, https:80) -> nesprávný port; výchozí porty a bez portu projdou', () => {
  for (const raw of ['http://x.cz:443/', 'https://x.cz:80/', 'http://x.cz:443', 'https://x.cz:80/a?b=1', 'x.cz:80/p']) {
    const r = normalizeUrl(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.duvod, 'nesprávný port', raw);
  }
  assert.equal(normalizeUrl('http://x.cz:81/').duvod, 'nepodporovaný port');
  assert.deepEqual(normalizeUrl('http://x.cz:80/a').url, 'http://x.cz/a');
  assert.deepEqual(normalizeUrl('https://x.cz:443/a').url, 'https://x.cz/a');
  assert.equal(normalizeUrl('https://x.cz/a').ok, true);
  assert.equal(normalizeUrl('http://x.cz/a').ok, true);
  assert.equal(normalizeUrl('x.cz:443/p').ok, true);
});

test('validateInput: screenshot nad 5 000 000 znaků -> 413, přesně 5 000 000 projde', () => {
  const sh = (n) => ({ screenshoty: [{ mime: 'image/png', data: 'A'.repeat(n) }] });
  assert.equal(validateInput(sh(5000000)).ok, true);
  const r = validateInput(sh(5000001));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

// --- obrázky a JSON-LD z rozšíření v prohlížeči ---

const OBR_BODY = { odkaz: 'https://allegro.cz/produkt/x?offerId=1', text: 'Powerbanka 199 Kč' };

test('validateInput: obrázky jen https, ostatní položky se zahodí bez chyby', () => {
  const r = validateInput({ ...OBR_BODY, obrazky: ['https://a.cz/1.jpg', 'http://x', 'javascript:1', 5] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.input.obrazky, ['https://a.cz/1.jpg']);
});

test('validateInput: devět adres se ořízne na osm, pořadí zůstane', () => {
  const urls = Array.from({ length: 9 }, (_, i) => 'https://a.cz/' + i + '.jpg');
  assert.deepEqual(validateInput({ ...OBR_BODY, obrazky: urls }).input.obrazky, urls.slice(0, 8));
});

test('validateInput: neplatné položky nezabírají místo z osmi', () => {
  const urls = ['http://x', 5, null, ...Array.from({ length: 9 }, (_, i) => 'https://a.cz/' + i + '.jpg')];
  assert.deepEqual(validateInput({ ...OBR_BODY, obrazky: urls }).input.obrazky, urls.slice(3, 11));
});

test('validateInput: adresa obrázku má nejvýš 500 znaků, delší se zahodí', () => {
  const ok = 'https://a.cz/' + 'a'.repeat(487);
  assert.equal(ok.length, 500);
  assert.deepEqual(validateInput({ ...OBR_BODY, obrazky: [ok, ok + 'a', 'https://a.cz/2.jpg'] }).input.obrazky, [ok, 'https://a.cz/2.jpg']);
});

test('validateInput: obrázky na interní adresu, s přihlašovacími údaji nebo bez protokolu se zahodí (SSRF)', () => {
  const r = validateInput({ ...OBR_BODY, obrazky: ['https://127.0.0.1/a.jpg', 'https://localhost/a.jpg', 'https://10.0.0.5/a.jpg', 'https://u:p@a.cz/1.jpg', 'a.cz/1.jpg', ' https://a.cz/2.jpg ', 'https://a.cz/2.jpg', 'https://a.cz/3 4.jpg'] });
  assert.deepEqual(r.input.obrazky, ['https://a.cz/2.jpg']);
});

test('validateInput: obrazky, které není pole, nebo chybí, dají prázdné pole', () => {
  for (const o of [undefined, null, 'https://a.cz/1.jpg', 5, { 0: 'https://a.cz/1.jpg' }]) {
    const r = validateInput({ ...OBR_BODY, obrazky: o });
    assert.equal(r.ok, true);
    assert.deepEqual(r.input.obrazky, []);
  }
});

test('validateInput: jsonld je řetězec do 4000 znaků, delší se ořízne, jiný typ se zahodí', () => {
  assert.equal(validateInput({ ...OBR_BODY, jsonld: ' {"a":1} ' }).input.jsonld, '{"a":1}');
  assert.equal(validateInput({ ...OBR_BODY, jsonld: 'x'.repeat(4000) }).input.jsonld.length, 4000);
  assert.equal(validateInput({ ...OBR_BODY, jsonld: 'x'.repeat(5000) }).input.jsonld.length, 4000);
  for (const j of [undefined, null, 5, {}, ['a']]) assert.equal(validateInput({ ...OBR_BODY, jsonld: j }).input.jsonld, '');
});

test('validateInput: samotné obrázky nebo JSON-LD nejsou vstup (bez odkazu, textu a screenshotu chyba)', () => {
  const r = validateInput({ obrazky: ['https://a.cz/1.jpg'], jsonld: '{}' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('validateInput: bez obrázků a JSON-LD vrací prázdné hodnoty', () => {
  const r = validateInput(OBR_BODY);
  assert.deepEqual(r.input.obrazky, []);
  assert.equal(r.input.jsonld, '');
});

// Vstup bez odkazu (vložený text, screenshot): tržiště se pozná z textu nebo z extrakce.
test('detectMarketplace: odkaz na tržiště je marketplace, odkaz na e-shop nikdy (ani když text zmiňuje tržiště)', () => {
  assert.equal(detectMarketplace({ rezim: 'marketplace', text: '' }), true);
  assert.equal(detectMarketplace({ rezim: 'eshop', text: 'Allegro bezpečný nákup, Super prodejce' }), false);
  assert.equal(detectMarketplace({ rezim: 'eshop', platforma: 'AliExpress' }), false);
});

test('detectMarketplace: vstup bez odkazu s názvem tržiště nebo typickou frází nabídky je marketplace', () => {
  const alle = fs.readFileSync(path.join(__dirname, '..', 'eval', 'fixtures', 'allegro-oneblade.txt'), 'utf8');
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: alle }), true);
  for (const t of ['Prodejce: X, Super prodejce, doporučuje 94,7 %.', 'Koupeno na AliExpress, doručení za 3 týdny', 'Temu: Free shipping', 'Amazon Prime nabídka', 'eBay Buyer Protection', 'Shein sada', 'Alibaba.com dodavatel', 'Wish']) {
    assert.equal(detectMarketplace({ rezim: 'neznámé', text: t }), true, t);
  }
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: '', platforma: 'AliExpress' }), true, 'z extrakce screenshotu');
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: '', pageText: 'Sold by X on Temu' }), true);
});

test('detectMarketplace: obyčejný text, e-shop bez zmínky o tržišti a nesmysly se nemění', () => {
  const kabel = 'USB-C kabel 1 m, nylonový oplet, 60 W, 3 A. Cena 149 Kč vč. DPH. Prodejce: Kabely CZ s.r.o., IČO 12345679. Produkt nese označení CE.';
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: kabel }), false);
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: '' }), false);
  assert.equal(detectMarketplace({ rezim: 'neznámé' }), false);
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: 'Whishlist, Temuco a Amazonka nejsou tržiště', platforma: 'Alza' }), false, 'jen celá slova');
  assert.equal(detectMarketplace({ rezim: 'neznámé', text: 'Hodnocení doporučuje 3 lidé' }), false);
  assert.equal(detectMarketplace(null), false);
});
