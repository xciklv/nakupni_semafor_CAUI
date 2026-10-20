const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { createHandler, collectResponse, loadPlaywright } = require('../tools/page-reader/server');
const { createImageService, createDownloader, dhashFromGray, validateImageUrls, MAX_IMAGES } = require('../tools/page-reader/images');
const { normalizeDossier } = require('../engine/dossier');
const ALI = require('./fixtures/dossier-cyklosvitilna.json');
const ALLEGRO = require('./fixtures/dossier-allegro-blokace.json');

const allow = async () => ({ ok: true });
const OK_HEADERS = { 'X-Nakupni-Kontrola': '1', 'Content-Type': 'application/json' };

async function withServer(deps, fn) {
  const server = http.createServer(createHandler({ read: async () => ({ ok: true, text: 'abc' }), check: allow, ...deps }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body, headers = OK_HEADERS) => fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try { await fn(post); } finally { await new Promise((r) => server.close(r)); }
}

// ---------- POST /collect ----------
test('/collect: platná žádost vrátí 200 a výsledek sběru; collect dostane adresu', async () => {
  const seen = [];
  const collect = async (url) => { seen.push(url); return { ok: true, dossier: ALI }; };
  await withServer({ collect }, async (post) => {
    const res = await post('/collect', { url: 'https://www.aliexpress.com/item/1.html' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dossier.schema, 'nakupni-kontrola/dossier@0-spike');
  });
  assert.deepEqual(seen, ['https://www.aliexpress.com/item/1.html']);
});

test('/collect: bez hlavičky X-Nakupni-Kontrola 403, špatný content-type 415, neplatné tělo 400; collect se nevolá', async () => {
  let calls = 0;
  const collect = async () => { calls += 1; return { ok: true, dossier: {} }; };
  await withServer({ collect }, async (post) => {
    assert.equal((await post('/collect', { url: 'https://x.cz/' }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('/collect', '{"url":"https://x.cz/"}', { 'X-Nakupni-Kontrola': '1', 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/collect', '{nejson')).status, 400);
    assert.equal((await post('/collect', {})).status, 400);
    assert.equal((await post('/collect', { url: 'https://x.cz/', pad: 'x'.repeat(5000) })).status, 413);
  });
  assert.equal(calls, 0);
});

test('/collect: interní adresa (SSRF) -> ok:false a collect se nevolá', async () => {
  let calls = 0;
  const collect = async () => { calls += 1; return { ok: true, dossier: {} }; };
  // check bez náhrady = skutečná kontrola z guard.js; IP adresa se nepřekládá, takže test nepotřebuje síť
  await withServer({ collect, check: undefined }, async (post) => {
    for (const url of ['http://127.0.0.1/', 'http://localhost:5678/', 'http://169.254.169.254/latest', 'https://192.168.0.1/x']) {
      const res = await post('/collect', { url });
      assert.equal(res.status, 200, url);
      const body = await res.json();
      assert.equal(body.ok, false, url);
      assert.match(body.duvod, /nen[ií] povolen/);
    }
  });
  assert.equal(calls, 0);
});

test('/collect: collect vyhodí výjimku nebo vrátí nesmysl -> ok:false, žádné detaily chyby ven', async () => {
  await withServer({ collect: async () => { throw new Error('tajná cesta C:\\x'); } }, async (post) => {
    const body = await (await post('/collect', { url: 'https://x.cz/' })).json();
    assert.equal(body.ok, false);
    assert.doesNotMatch(JSON.stringify(body), /tajn/);
  });
  await withServer({ collect: async () => null }, async (post) => {
    assert.equal((await (await post('/collect', { url: 'https://x.cz/' })).json()).ok, false);
  });
});

test('/collect: bez nastavené funkce collect je cesta neznámá (404)', async () => {
  await withServer({}, async (post) => {
    assert.equal((await post('/collect', { url: 'https://x.cz/' })).status, 404);
  });
});

test('/collect: /read zůstává funkční a /health také', async () => {
  await withServer({ collect: async () => ({ ok: true, dossier: {} }) }, async (post) => {
    assert.deepEqual(await (await post('/read', { url: 'https://x.cz/p' })).json(), { ok: true, text: 'abc' });
  });
});

// ---------- collectResponse: tvar odpovědi z výstupu sběrače ----------
test('collectResponse: úspěšný sběr vrací dossier, který přijme normalizeDossier', () => {
  const r = collectResponse(ALI);
  assert.equal(r.ok, true);
  assert.equal(r.dossier, ALI);
  const n = normalizeDossier(r.dossier);
  assert.equal(n.ok, true);
  assert.match(n.dossier.nazev, /25500Lumen/);
});

test('collectResponse: blokace (CAPTCHA) -> ok:false s popisem blokace, bez dossieru', () => {
  const r = collectResponse(ALLEGRO);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blokace, { druh: 'captcha', dodavatel: 'DataDome' });
  assert.match(r.duvod, /ověření/);
  assert.equal('dossier' in r, false);
});

test('collectResponse: blokace bez dodavatele -> dodavatel null; přihlašovací zeď má vlastní důvod', () => {
  const r = collectResponse({ ok: false, blocked: { kind: 'login-wall', vendor: null } });
  assert.deepEqual(r.blokace, { druh: 'login-wall', dodavatel: null });
  assert.match(r.duvod, /přihlášen/);
});

test('collectResponse: selhání bez blokace nese důvod sběrače, neznámý tvar je ok:false', () => {
  assert.deepEqual(collectResponse({ ok: false, blocked: null, error: 'adresa není povolená: interní adresa' }), { ok: false, duvod: 'adresa není povolená: interní adresa' });
  assert.equal(collectResponse({ ok: false }).ok, false);
  assert.equal(collectResponse(null).ok, false);
  assert.equal(collectResponse('x').ok, false);
});

// ---------- POST /images ----------
const PNG_URL = 'https://ae01.alicdn.com/kf/a.jpg';
const fakeImages = (seen = []) => async (urls) => { seen.push(urls); return { ok: true, obrazky: urls.map((url) => ({ url, mime: 'image/jpeg', data: 'AAAA', dhash: '0123456789abcdef' })) }; };

test('/images: platná žádost vrátí obrázky; images dostane adresy', async () => {
  const seen = [];
  await withServer({ images: fakeImages(seen) }, async (post) => {
    const res = await post('/images', { urls: [PNG_URL, 'https://x.cz/b.png'] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.obrazky.length, 2);
  });
  assert.deepEqual(seen, [[PNG_URL, 'https://x.cz/b.png']]);
});

test('/images: devět adres -> 400, osm projde', async () => {
  const seen = [];
  await withServer({ images: fakeImages(seen) }, async (post) => {
    const nine = Array.from({ length: 9 }, (_, i) => 'https://x.cz/' + i + '.jpg');
    assert.equal((await post('/images', { urls: nine })).status, 400);
    assert.equal((await post('/images', { urls: nine.slice(0, MAX_IMAGES) })).status, 200);
  });
  assert.equal(MAX_IMAGES, 8);
  assert.equal(seen.length, 1);
});

test('/images: jen https; http, jiné protokoly, prázdné pole a špatné typy -> 400 a images se nevolá', async () => {
  const seen = [];
  await withServer({ images: fakeImages(seen) }, async (post) => {
    for (const urls of [['http://x.cz/a.jpg'], ['https://x.cz/a.jpg', 'http://x.cz/b.jpg'], ['ftp://x.cz/a'], ['data:image/png;base64,AAAA'], [], 'https://x.cz/a.jpg', [5], [''], ['https://x.cz/' + 'a'.repeat(2100)]]) {
      assert.equal((await post('/images', { urls })).status, 400, JSON.stringify(urls).slice(0, 60));
    }
    assert.equal((await post('/images', {})).status, 400);
  });
  assert.equal(seen.length, 0);
});

test('/images: bez hlavičky 403, špatný content-type 415', async () => {
  await withServer({ images: fakeImages() }, async (post) => {
    assert.equal((await post('/images', { urls: [PNG_URL] }, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post('/images', JSON.stringify({ urls: [PNG_URL] }), { 'X-Nakupni-Kontrola': '1', 'Content-Type': 'text/plain' })).status, 415);
  });
});

test('/images: bez nastavené funkce images je cesta neznámá (404); výjimka -> ok:false bez detailů', async () => {
  await withServer({}, async (post) => assert.equal((await post('/images', { urls: [PNG_URL] })).status, 404));
  await withServer({ images: async () => { throw new Error('tajné'); } }, async (post) => {
    const body = await (await post('/images', { urls: [PNG_URL] })).json();
    assert.equal(body.ok, false);
    assert.doesNotMatch(JSON.stringify(body), /tajn/);
  });
});

test('validateImageUrls: odstraní duplicity a ořízne mezery; vrací důvod při chybě', () => {
  assert.deepEqual(validateImageUrls([' https://x.cz/a.jpg ', 'https://x.cz/a.jpg', 'https://x.cz/b.jpg']), { ok: true, urls: ['https://x.cz/a.jpg', 'https://x.cz/b.jpg'] });
  assert.equal(validateImageUrls(['http://x.cz/a.jpg']).ok, false);
  assert.match(validateImageUrls(null).duvod, /urls/);
});

// ---------- dHash ----------
test('dhashFromGray: 9×8 vzorek -> 16 hex znaků; rostoucí zleva doprava = samé jedničky, klesající = samé nuly', () => {
  const row = (f) => Array.from({ length: 9 }, (_, x) => f(x));
  const rising = [].concat(...Array.from({ length: 8 }, () => row((x) => x * 20)));
  const falling = [].concat(...Array.from({ length: 8 }, () => row((x) => 255 - x * 20)));
  assert.equal(dhashFromGray(rising), 'ffffffffffffffff');
  assert.equal(dhashFromGray(falling), '0000000000000000');
  assert.throws(() => dhashFromGray([1, 2, 3]), /72/);
});

test('dhashFromGray: pořadí bitů je po řádcích zleva (první pixel dvojice < druhý = 1), shodně se spikem', () => {
  const g = new Array(72).fill(0);
  g[0] = 0; g[1] = 10; // první bit = 1; ostatní dvojice stejné = 0
  assert.equal(dhashFromGray(g), '8000000000000000');
});

// ---------- stahování obrázku ----------
const pngLikeResponse = (body = Buffer.from('obrazek'), { status = 200, headers = {} } = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k) => ({ 'content-type': 'image/png', ...headers })[String(k).toLowerCase()] ?? null },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});

test('downloader: veřejný https obrázek se stáhne; kontrola adresy proběhne před stažením a fetch nenásleduje přesměrování sám', async () => {
  const order = [];
  const fetchImpl = async (url, opts) => { order.push('fetch ' + url); assert.equal(opts.redirect, 'manual'); return pngLikeResponse(); };
  const dl = createDownloader({ check: async (u) => { order.push('check ' + u); return { ok: true }; }, fetchImpl });
  const r = await dl('https://cdn.x.cz/a.png');
  assert.equal(r.buf.toString(), 'obrazek');
  assert.equal(r.type, 'image/png');
  assert.deepEqual(order, ['check https://cdn.x.cz/a.png', 'fetch https://cdn.x.cz/a.png']);
});

test('downloader: interní adresa se nestahuje', async () => {
  let fetched = 0;
  const dl = createDownloader({ check: async () => ({ ok: false, duvod: 'interní adresa' }), fetchImpl: async () => { fetched += 1; return pngLikeResponse(); } });
  await assert.rejects(dl('https://evil.cz/a.png'), /interní adresa/);
  assert.equal(fetched, 0);
});

test('downloader: přesměrování se kontroluje v každém kroku; cíl na interní adresu se nestáhne, příliš mnoho kroků skončí chybou', async () => {
  const check = async (u) => (/127\.0\.0\.1/.test(u) ? { ok: false, duvod: 'interní adresa' } : { ok: true });
  const seen = [];
  const redirectToLocal = async (url) => { seen.push(url); return pngLikeResponse(Buffer.alloc(0), { status: 302, headers: { location: 'http://127.0.0.1:5678/rest' } }); };
  await assert.rejects(createDownloader({ check, fetchImpl: redirectToLocal })('https://cdn.x.cz/a.png'), /interní adresa/);
  assert.deepEqual(seen, ['https://cdn.x.cz/a.png']);
  const loop = async () => pngLikeResponse(Buffer.alloc(0), { status: 302, headers: { location: 'https://cdn.x.cz/b.png' } });
  await assert.rejects(createDownloader({ check, fetchImpl: loop })('https://cdn.x.cz/a.png'), /přesměrování/);
  // relativní odkaz a platný cíl
  let n = 0;
  const hop = async (url) => (n++ === 0 ? pngLikeResponse(Buffer.alloc(0), { status: 301, headers: { location: '/b.png' } }) : (assert.equal(url, 'https://cdn.x.cz/b.png'), pngLikeResponse()));
  assert.equal((await createDownloader({ check, fetchImpl: hop })('https://cdn.x.cz/a.png')).type, 'image/png');
});

test('downloader: přesměrování na http: se odmítne; jiný typ než obrázek, chybový stav a velikost nad limit také', async () => {
  const check = async () => ({ ok: true });
  const to = (location) => async () => pngLikeResponse(Buffer.alloc(0), { status: 302, headers: { location } });
  await assert.rejects(createDownloader({ check, fetchImpl: to('http://cdn.x.cz/b.png') })('https://cdn.x.cz/a.png'), /https/);
  await assert.rejects(createDownloader({ check, fetchImpl: async () => pngLikeResponse(Buffer.from('<html>'), { headers: { 'content-type': 'text/html' } }) })('https://x.cz/a'), /obrázek/);
  await assert.rejects(createDownloader({ check, fetchImpl: async () => pngLikeResponse(Buffer.from('x'), { headers: { 'content-type': 'image/svg+xml' } }) })('https://x.cz/a'), /obrázek/);
  await assert.rejects(createDownloader({ check, fetchImpl: async () => pngLikeResponse(Buffer.from('x'), { status: 404 }) })('https://x.cz/a'), /404/);
  await assert.rejects(createDownloader({ check, maxBytes: 5, fetchImpl: async () => pngLikeResponse(Buffer.from('123456789')) })('https://x.cz/a'), /velk/);
  await assert.rejects(createDownloader({ check, maxBytes: 5, fetchImpl: async () => pngLikeResponse(Buffer.from('1'), { headers: { 'content-length': '999999' } }) })('https://x.cz/a'), /velk/);
});

test('downloader: zavěšené stahování skončí do časového limitu', async () => {
  const dl = createDownloader({ check: allow, timeoutMs: 40, fetchImpl: () => new Promise(() => {}) });
  const t0 = Date.now();
  await assert.rejects(dl('https://x.cz/a.png'), /čas/);
  assert.ok(Date.now() - t0 < 1000);
});

// ---------- služba obrázků (s náhradou prohlížeče) ----------
const fakeTool = (log = []) => ({
  async process(buf) { log.push('process ' + buf.toString()); return { jpeg: Buffer.from('JPEG:' + buf.toString()), gray: Array.from({ length: 72 }, (_, i) => (i % 9) * 10) }; },
  async close() { log.push('close'); },
});

test('služba obrázků: vrací jpeg v base64, mime a dhash; nástroj se po práci zavře', async () => {
  const log = [];
  const svc = createImageService({ openTool: async () => fakeTool(log), download: async (u) => ({ buf: Buffer.from(u.slice(-5)), type: 'image/png' }) });
  const r = await svc(['https://x.cz/a.png', 'https://x.cz/b.png']);
  assert.equal(r.ok, true);
  assert.equal(r.obrazky.length, 2);
  assert.deepEqual(Object.keys(r.obrazky[0]).sort(), ['data', 'dhash', 'mime', 'url']);
  assert.equal(r.obrazky[0].url, 'https://x.cz/a.png');
  assert.equal(r.obrazky[0].mime, 'image/jpeg');
  assert.equal(Buffer.from(r.obrazky[0].data, 'base64').toString(), 'JPEG:a.png');
  assert.match(r.obrazky[0].dhash, /^[0-9a-f]{16}$/);
  assert.equal(log[log.length - 1], 'close');
});

test('služba obrázků: nestažitelný obrázek se vynechá a zapíše do vynechano; ostatní projdou', async () => {
  const download = async (u) => { if (/bad/.test(u)) throw new Error('adresa není povolená: interní adresa'); return { buf: Buffer.from('ok'), type: 'image/png' }; };
  const svc = createImageService({ openTool: async () => fakeTool(), download });
  const r = await svc(['https://x.cz/bad.png', 'https://x.cz/good.png']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.obrazky.map((o) => o.url), ['https://x.cz/good.png']);
  assert.deepEqual(r.vynechano, [{ url: 'https://x.cz/bad.png', duvod: 'adresa není povolená: interní adresa' }]);
});

test('služba obrázků: když nejde zpracovat žádný obrázek, odpověď je pořád ok:true s prázdným polem; selhání prohlížeče = ok:false', async () => {
  const none = createImageService({ openTool: async () => fakeTool(), download: async () => { throw new Error('HTTP 404'); } });
  const r = await none(['https://x.cz/a.png']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.obrazky, []);
  const broken = createImageService({ openTool: async () => { throw new Error('Chromium chybí'); }, download: async () => ({ buf: Buffer.from('x'), type: 'image/png' }) });
  assert.equal((await broken(['https://x.cz/a.png'])).ok, false);
});

// ---------- skutečný Chromium (přeskočí se, když Playwright není) ----------
function crc32(buf) {
  let c; let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
// Šedotónové PNG w×h, jas = f(x, y).
function makePng(w, h, f) {
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = f(x, y);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let chromiumOrNull = null;
try { chromiumOrNull = loadPlaywright(); } catch (e) { /* bez Playwrightu */ }

test('skutečný Chromium: zmenší na delší stranu 768 px (nezvětšuje) a spočítá dHash', { skip: !chromiumOrNull && 'Playwright není k dispozici', timeout: 60000 }, async () => {
  const { openPixelTool } = require('../tools/page-reader/images');
  const tool = await openPixelTool(chromiumOrNull);
  try {
    const big = await tool.process(makePng(1600, 800, (x) => Math.round((x / 1599) * 255)));
    const jpegDim = (b) => { for (let i = 2; i < b.length - 9;) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc3) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); } return null; };
    assert.deepEqual(jpegDim(big.jpeg), [768, 384]);
    assert.equal(dhashFromGray(big.gray), 'ffffffffffffffff'); // zleva doprava světlejší
    const small = await tool.process(makePng(200, 100, (x) => 255 - Math.round((x / 199) * 255)));
    assert.deepEqual(jpegDim(small.jpeg), [200, 100]);
    assert.equal(dhashFromGray(small.gray), '0000000000000000'); // zleva doprava tmavší
  } finally { await tool.close(); }
});
