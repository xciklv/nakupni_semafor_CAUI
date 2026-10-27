const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isPrivateIp, checkUrl, cleanText, looksBlocked } = require('../tools/page-reader/guard');
const { createReader } = require('../tools/page-reader/reader');
const { createHandler } = require('../tools/page-reader/server');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

// ---------- guard ----------
test('isPrivateIp: interní, loopback, link-local, CGNAT, multicast a mapované IPv6 jsou neveřejné; veřejné ne', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', 'neni-ip', '']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip);
});

test('checkUrl: veřejná adresa projde (překlad jména na veřejnou IP)', async () => {
  assert.deepEqual(await checkUrl('https://www.aliexpress.com/item/1.html?x=1', publicLookup), { ok: true });
  assert.deepEqual(await checkUrl('http://93.184.216.34/', publicLookup), { ok: true });
});

test('checkUrl: interní a neplatné adresy se odmítnou', async () => {
  const bad = ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://192.168.0.10:8080/', 'http://foo.internal/', 'http://printer.local/',
    'http://127.0.0.1.nip.io/', 'http://a.sslip.io/', 'ftp://example.cz/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pw@shop.cz/', 'nesmysl', '', 'http://169.254.169.254/latest/meta-data/'];
  for (const u of bad) assert.equal((await checkUrl(u, publicLookup)).ok, false, u);
});

test('checkUrl: veřejné jméno, které se překládá na interní IP (i jen jedna z adres), se odmítne; selhání překladu také', async () => {
  assert.equal((await checkUrl('https://evil.cz/', async () => [{ address: '10.0.0.5' }])).ok, false);
  assert.equal((await checkUrl('https://evil.cz/', async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }])).ok, false);
  assert.equal((await checkUrl('https://evil.cz/', async () => [{ address: '::1' }])).ok, false);
  assert.equal((await checkUrl('https://evil.cz/', async () => { throw new Error('ENOTFOUND'); })).ok, false);
  assert.equal((await checkUrl('https://evil.cz/', async () => [])).ok, false);
});

test('checkUrl: data:, blob: a about: jsou lokální a projdou bez překladu', async () => {
  const noLookup = async () => { throw new Error('nemá se volat'); };
  for (const u of ['data:text/plain;base64,AAAA', 'blob:https://x.cz/uuid', 'about:blank']) assert.equal((await checkUrl(u, noLookup)).ok, true, u);
});

test('cleanText: ořízne řádky, vyhodí prázdné, sjednotí mezery a omezí délku', () => {
  assert.equal(cleanText('  a\u00a0 b \r\n\n\n\t c  \n', 100), 'a b\nc');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(null, 10), '');
  assert.equal(cleanText(undefined, 10), '');
});

test('looksBlocked: pozná stránku s ověřením jen na začátku textu, nezahazuje běžný obsah s tímto slovem později', () => {
  assert.equal(looksBlocked('Sorry, we have detected unusual traffic from your network.'), true);
  assert.equal(looksBlocked('Captcha Interception'), true);
  assert.equal(looksBlocked('Please verify you are human'), true);
  assert.equal(looksBlocked('Powerbanka 20000 mAh\n' + 'x'.repeat(2000) + ' captcha'), false);
  assert.equal(looksBlocked('Běžná nabídka produktu'), false);
});

// ---------- reader (s náhradou Playwrightu) ----------
const LONG = 'Nabídka produktu. '.repeat(40); // > 300 znaků
const fastOpts = { settleMaxMs: 200, settleStableMs: 0, pollMs: 0, totalMs: 2000, minChars: 300 };
const instant = async () => {};

function fakePlaywright({ texts = [LONG], status = 200, finalUrl, title = 'Titulek', gotoImpl, connected = [] } = {}) {
  const log = { launches: 0, contexts: [], routes: [], closedContexts: 0, evaluate: 0 };
  const browser = {
    isConnected: () => (connected.length ? connected.shift() : true),
    close: async () => {},
    newContext: async (opts) => {
      log.contexts.push(opts);
      return {
        route: async (pattern, fn) => { log.routes.push(fn); },
        newPage: async () => ({
          goto: gotoImpl || (async (u) => ({ status: () => status, _url: u })),
          evaluate: async () => { const i = Math.min(log.evaluate++, texts.length - 1); return texts[i]; },
          url: () => finalUrl || 'https://shop.example.com/p',
          title: async () => title,
        }),
        close: async () => { log.closedContexts += 1; },
      };
    },
  };
  return { log, chromium: { launch: async () => { log.launches += 1; return browser; } } };
}
const reader = (pw, extra = {}) => createReader({ chromium: pw.chromium, check: (u) => checkUrl(u, publicLookup), options: { ...fastOpts, ...extra.options }, sleep: instant, ...extra.deps });

test('reader: načte text po dosednutí (délka se ustálí), vrátí titulek, adresu a vyčištěný text; kontext se zavře', async () => {
  const pw = fakePlaywright({ texts: ['kratky', LONG + ' dalsi', LONG + ' dalsi'] });
  const r = await reader(pw).read('https://shop.example.com/p');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Titulek');
  assert.ok(r.text.endsWith('dalsi'));
  assert.equal(r.finalUrl, 'https://shop.example.com/p');
  assert.equal(pw.log.closedContexts, 1);
  assert.equal(pw.log.contexts[0].locale, 'cs-CZ');
});

test('reader: nepovolená hlavní adresa se nenačítá, prohlížeč se ani nespustí', async () => {
  const pw = fakePlaywright();
  const r = await reader(pw).read('http://127.0.0.1:5678/webhook/x');
  assert.equal(r.ok, false);
  assert.match(r.duvod, /nen[ií] povolen/);
  assert.equal(pw.log.launches, 0);
});

test('reader: route zahazuje obrázky/písma, interní adresy a cizí protokoly; veřejné a data: pouští', async () => {
  const pw = fakePlaywright();
  await reader(pw).read('https://shop.example.com/p');
  const handler = pw.log.routes[0];
  const run = async (url, resourceType = 'script') => {
    const out = { aborted: null, continued: false };
    await handler({ request: () => ({ url: () => url, resourceType: () => resourceType }), abort: async (why) => { out.aborted = why || 'abort'; }, continue: async () => { out.continued = true; } });
    return out;
  };
  assert.equal((await run('https://cdn.example.com/a.js')).continued, true);
  assert.equal((await run('data:text/plain,hi')).continued, true);
  assert.ok((await run('https://cdn.example.com/a.png', 'image')).aborted);
  assert.ok((await run('https://cdn.example.com/f.woff', 'font')).aborted);
  assert.ok((await run('http://127.0.0.1:5678/rest/workflows', 'fetch')).aborted);
  assert.ok((await run('http://localhost:5678/', 'xhr')).aborted);
  assert.ok((await run('ftp://x.cz/a')).aborted);
});

test('reader: stránka s ověřením (CAPTCHA) se nahlásí a neobchází; chybový stav a prázdná stránka také selžou', async () => {
  const blocked = await reader(fakePlaywright({ texts: ['Sorry, we have detected unusual traffic from your network. ' + 'x'.repeat(400)] })).read('https://shop.example.com/p');
  assert.equal(blocked.ok, false);
  assert.match(blocked.duvod, /ověření/);
  const err = await reader(fakePlaywright({ status: 404 })).read('https://shop.example.com/p');
  assert.equal(err.ok, false);
  assert.match(err.duvod, /404/);
  const empty = await reader(fakePlaywright({ texts: ['kratky'] })).read('https://shop.example.com/p');
  assert.equal(empty.ok, false);
  assert.match(empty.duvod, /pr[aá]zdn/);
});

test('reader: přesměrování na interní adresu = selhání', async () => {
  const r = await reader(fakePlaywright({ finalUrl: 'http://192.168.1.1/admin' })).read('https://shop.example.com/p');
  assert.equal(r.ok, false);
  assert.match(r.duvod, /přesměrování/);
});

test('reader: tvrdý časový strop ukončí zavěšenou stránku a zavře kontext', async () => {
  const pw = fakePlaywright({ gotoImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await reader(pw, { options: { totalMs: 60 } }).read('https://shop.example.com/p');
  assert.equal(r.ok, false);
  assert.match(r.duvod, /vypr/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(pw.log.closedContexts, 1);
});

test('reader: chyba goto -> ok:false; prohlížeč se spouští jednou a znovu až po odpojení', async () => {
  const bad = fakePlaywright({ gotoImpl: async () => { throw new Error('net::ERR_FAILED'); } });
  const r = await reader(bad).read('https://shop.example.com/p');
  assert.equal(r.ok, false);
  const pw = fakePlaywright({ connected: [true, false] });
  const rd = reader(pw);
  await rd.read('https://shop.example.com/a');
  await rd.read('https://shop.example.com/b'); // isConnected() = true -> stejný prohlížeč
  assert.equal(pw.log.launches, 1);
  await rd.read('https://shop.example.com/c'); // isConnected() = false -> nový start
  assert.equal(pw.log.launches, 2);
});

// ---------- HTTP handler ----------
async function withServer(deps, fn) {
  const server = http.createServer(createHandler(deps));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, body, headers = {}) => fetch(base + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nakupni-Semafor': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('handler: health, neznámá cesta a metoda; povinná hlavička, content-type, JSON, adresa a velikost těla', async () => {
  await withServer({ read: async () => ({ ok: true }) }, async (base) => {
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true });
    assert.equal((await fetch(base + '/nic')).status, 404);
    assert.equal((await fetch(base + '/read')).status, 404);
    assert.equal((await post(base, { url: 'https://x.cz/' }, { 'X-Nakupni-Semafor': '0' })).status, 403);
    assert.equal((await fetch(base + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"url":"https://x.cz/"}' })).status, 403);
    assert.equal((await post(base, '{"url":"https://x.cz/"}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(base, '{nejson')).status, 400);
    assert.equal((await post(base, {})).status, 400);
    assert.equal((await post(base, { url: 5 })).status, 400);
    assert.equal((await post(base, { url: 'https://x.cz/' + 'a'.repeat(2100) })).status, 400);
    assert.equal((await post(base, { url: 'https://x.cz/', pad: 'x'.repeat(5000) })).status, 413);
  });
});

test('handler: úspěch vrací výsledek čtečky; chyba čtečky = 200 s ok:false; žádné detaily výjimky', async () => {
  let seen = null;
  await withServer({ read: async (u) => { seen = u; return { ok: true, text: 'abc' }; } }, async (base) => {
    assert.deepEqual(await (await post(base, { url: 'https://x.cz/p' })).json(), { ok: true, text: 'abc' });
    assert.equal(seen, 'https://x.cz/p');
  });
  await withServer({ read: async () => { throw new Error('tajná interní cesta C:\\x'); } }, async (base) => {
    const res = await post(base, { url: 'https://x.cz/p' });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.equal(JSON.stringify(j).includes('tajná'), false);
  });
});

test('handler: požadavky běží po jednom a když se fronta zaplní, vrací 429', async () => {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const read = () => new Promise((resolve) => { active += 1; maxActive = Math.max(maxActive, active); releases.push(() => { active -= 1; resolve({ ok: true }); }); });
  await withServer({ read, queueMax: 2 }, async (base) => {
    const reqs = [1, 2, 3].map(() => post(base, { url: 'https://x.cz/p' }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(releases.length, 1, 'běží jen jeden');
    const over = await post(base, { url: 'https://x.cz/p' });
    assert.equal(over.status, 429);
    while (releases.length) { releases.shift()(); await new Promise((r) => setTimeout(r, 50)); }
    for (const r of await Promise.all(reqs)) assert.equal(r.status, 200);
    assert.equal(maxActive, 1);
  });
});

test('handler: čtečka, která se nevrací, skončí limitem handleru jako ok:false', async () => {
  await withServer({ read: () => new Promise(() => {}), handlerMs: 60 }, async (base) => {
    const j = await (await post(base, { url: 'https://x.cz/p' })).json();
    assert.equal(j.ok, false);
    assert.match(j.duvod, /vypr/);
  });
});
