#!/usr/bin/env node
'use strict';
// Lokální služba čtečky stránek pro Nákupní kontrolu. Poslouchá jen na 127.0.0.1 (výchozí port 5687).
//   POST /read   hlavička X-Nakupni-Kontrola: 1, tělo {"url":"https://..."}  ->  {ok:true,text,title,finalUrl,status,ms} | {ok:false,duvod}
//   GET  /health ->  {ok:true}
// Spuštění: npm run reader   (potřebuje Playwright a Chromium, viz tools/page-reader/README.md)
//
// Proměnné prostředí: PAGE_READER_PORT (5687), PLAYWRIGHT_PATH (cesta k modulu playwright, když není nainstalovaný v projektu).
const http = require('node:http');
const path = require('node:path');
const { createReader } = require('./reader');

const MAX_BODY = 4096;
const MAX_URL = 2048;
const QUEUE_MAX = 2; // kolik dalších požadavků smí čekat za právě běžícím
const HANDLER_MS = 45000;

// deps.read(url) -> Promise<{ok,...}>. Požadavky se zpracovávají po jednom (jeden prohlížeč, žádný souběh).
function createHandler({ read, queueMax = QUEUE_MAX, handlerMs = HANDLER_MS }) {
  let chain = Promise.resolve();
  let pending = 0;
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  };
  return async function handler(req, res) {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/read') return send(res, 404, { ok: false, duvod: 'neznámá cesta' });
    // Vlastní hlavička vynutí CORS preflight, takže požadavek nemůže poslat cizí webová stránka z prohlížeče.
    if (req.headers['x-nakupni-kontrola'] !== '1') return send(res, 403, { ok: false, duvod: 'chybí povinná hlavička' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, duvod: 'očekává se application/json' });
    let raw = '';
    let tooBig = false;
    req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) { tooBig = true; break; }
    }
    if (tooBig) return send(res, 413, { ok: false, duvod: 'tělo je příliš velké' });
    let url;
    try { url = JSON.parse(raw).url; } catch (e) { return send(res, 400, { ok: false, duvod: 'neplatný JSON' }); }
    if (typeof url !== 'string' || !url || url.length > MAX_URL) return send(res, 400, { ok: false, duvod: 'chybí platná adresa' });
    if (pending > queueMax) return send(res, 429, { ok: false, duvod: 'čtečka je zaneprázdněná, zkuste to za chvíli' });
    pending += 1;
    const run = chain.then(() => read(url));
    chain = run.catch(() => {});
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, duvod: 'čas vypršel' }), handlerMs); });
    try {
      const result = await Promise.race([run, limit]);
      return send(res, 200, result && typeof result === 'object' ? result : { ok: false, duvod: 'prázdná odpověď' });
    } catch (e) {
      return send(res, 200, { ok: false, duvod: 'čtení stránky selhalo' });
    } finally {
      clearTimeout(timer);
      pending -= 1;
    }
  };
}

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_PATH,
    'playwright',
    // Záloha pro vývoj na tomto počítači: Playwright z vedlejšího projektu contact-screening-project.
    path.join(__dirname, '..', '..', '..', 'contact-screening-project', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).chromium; } catch (e) { /* další kandidát */ }
  }
  throw new Error('Playwright nenalezen. Spusťte "npm i playwright" a "npx playwright install chromium", nebo nastavte PLAYWRIGHT_PATH.');
}

function main() {
  const port = Number(process.env.PAGE_READER_PORT) || 5687;
  const reader = createReader({ chromium: loadPlaywright() });
  const server = http.createServer(createHandler({ read: reader.read }));
  server.listen(port, '127.0.0.1', () => console.log('Čtečka stránek poslouchá na http://127.0.0.1:' + port + '/read'));
  const stop = () => { server.close(); reader.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main();

module.exports = { createHandler, loadPlaywright };
