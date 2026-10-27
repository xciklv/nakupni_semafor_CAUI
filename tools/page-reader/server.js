#!/usr/bin/env node
'use strict';
// Lokální služba čtečky stránek pro Nákupní semafor. Poslouchá jen na 127.0.0.1 (výchozí port 5687). Všechny POST cesty vyžadují
// hlavičku X-Nakupni-Semafor: 1 a Content-Type: application/json; požadavky se zpracovávají po jednom (jeden prohlížeč).
//   POST /read     {"url":"https://..."}        ->  {ok:true,text,title,finalUrl,status,ms} | {ok:false,duvod}
//   POST /collect  {"url":"https://..."}        ->  {ok:true,dossier} | {ok:false,duvod,blokace?:{druh,dodavatel}}   (dossier@0-spike, viz tools/page-collector)
//   POST /images   {"urls":["https://...",...]} ->  {ok:true,obrazky:[{url,mime,data,dhash}],vynechano?:[{url,duvod}]} | {ok:false,duvod}   (nejvýše 8, jen https)
//   GET  /health   ->  {ok:true}
// Spuštění: npm run reader   (potřebuje Playwright a Chromium, viz tools/page-reader/README.md)
//
// Proměnné prostředí: PAGE_READER_PORT (5687), PLAYWRIGHT_PATH (cesta k modulu playwright, když není nainstalovaný v projektu).
const http = require('node:http');
const path = require('node:path');
const { createReader } = require('./reader');
const { checkUrl } = require('./guard');
const { createImageService, openPixelTool, validateImageUrls } = require('./images');

const MAX_BODY = 4096;
const MAX_BODY_IMAGES = 24000; // osm adres po 2048 znacích
const MAX_URL = 2048;
const QUEUE_MAX = 2; // kolik dalších požadavků smí čekat za právě běžícím
const HANDLER_MS = 45000;

// Výstup sběrače (dossier@0-spike) -> odpověď cesty /collect. Blokace (CAPTCHA, přihlašovací zeď) se jen nahlásí, dossier se v tom případě nevrací.
function collectResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, duvod: 'sběr dat selhal' };
  const b = raw.blocked && typeof raw.blocked === 'object' ? raw.blocked : null;
  if (b) {
    const druh = typeof b.kind === 'string' && b.kind ? b.kind : 'neznámá';
    const duvod = druh === 'login-wall' ? 'stránka vyžaduje přihlášení, čtečka se nepřihlašuje'
      : druh === 'http-error' ? 'stránka vrátila chybu' + (b.status ? ' ' + b.status : '')
        : 'stránka vyžaduje ověření (ochrana proti robotům), čtečka ho neobchází';
    return { ok: false, duvod, blokace: { druh, dodavatel: typeof b.vendor === 'string' && b.vendor ? b.vendor : null } };
  }
  if (raw.ok === true) return { ok: true, dossier: raw };
  return { ok: false, duvod: typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 200) : 'sběr nenašel údaje nabídky' };
}

// Cesty: parse(body) -> { arg } | { status, duvod }; run(arg). Cesta bez dodané funkce (collect, images) je neznámá.
function createHandler({ read, collect, images, check = checkUrl, queueMax = QUEUE_MAX, handlerMs = HANDLER_MS }) {
  let chain = Promise.resolve();
  let pending = 0;
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const urlArg = (body) => (typeof body.url !== 'string' || !body.url || body.url.length > MAX_URL ? { status: 400, duvod: 'chybí platná adresa' } : { arg: body.url });
  const routes = {
    '/read': read && { maxBody: MAX_BODY, parse: urlArg, run: read, chyba: 'čtení stránky selhalo' },
    '/collect': collect && {
      maxBody: MAX_BODY, parse: urlArg, chyba: 'sběr dat selhal',
      run: async (url) => {
        const g = await check(url);
        if (!g || !g.ok) return { ok: false, duvod: 'adresa není povolená: ' + ((g && g.duvod) || 'neznámý důvod') };
        return collect(url);
      },
    },
    '/images': images && {
      maxBody: MAX_BODY_IMAGES, chyba: 'zpracování obrázků selhalo', run: images,
      parse: (body) => { const v = validateImageUrls(body.urls); return v.ok ? { arg: v.urls } : { status: 400, duvod: v.duvod }; },
    },
  };
  return async function handler(req, res) {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
    const route = req.method === 'POST' && Object.prototype.hasOwnProperty.call(routes, req.url) ? routes[req.url] : null;
    if (!route) return send(res, 404, { ok: false, duvod: 'neznámá cesta' });
    // Vlastní hlavička vynutí CORS preflight, takže požadavek nemůže poslat cizí webová stránka z prohlížeče.
    if (req.headers['x-nakupni-semafor'] !== '1') return send(res, 403, { ok: false, duvod: 'chybí povinná hlavička' });
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { ok: false, duvod: 'očekává se application/json' });
    let raw = '';
    let tooBig = false;
    req.setEncoding('utf8');
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > route.maxBody) { tooBig = true; break; }
    }
    if (tooBig) return send(res, 413, { ok: false, duvod: 'tělo je příliš velké' });
    let body;
    try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { ok: false, duvod: 'neplatný JSON' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { ok: false, duvod: 'neplatný JSON' });
    const parsed = route.parse(body);
    if (parsed.status) return send(res, parsed.status, { ok: false, duvod: parsed.duvod });
    if (pending > queueMax) return send(res, 429, { ok: false, duvod: 'čtečka je zaneprázdněná, zkuste to za chvíli' });
    pending += 1;
    const run = chain.then(() => route.run(parsed.arg));
    chain = run.catch(() => {});
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, duvod: 'čas vypršel' }), handlerMs); });
    try {
      const result = await Promise.race([run, limit]);
      return send(res, 200, result && typeof result === 'object' ? result : { ok: false, duvod: 'prázdná odpověď' });
    } catch (e) {
      return send(res, 200, { ok: false, duvod: route.chyba });
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
  const chromium = loadPlaywright();
  const reader = createReader({ chromium });
  // Sběrač se načítá až při prvním požadavku: jeho browser.js si bere loadPlaywright z tohoto souboru.
  const collect = async (url) => collectResponse(await require('../page-collector/collect').collectDossier(url, { chromium }));
  const images = createImageService({ openTool: () => openPixelTool(chromium) });
  const server = http.createServer(createHandler({ read: reader.read, collect, images }));
  server.listen(port, '127.0.0.1', () => console.log('Čtečka stránek poslouchá na http://127.0.0.1:' + port + ' (/read, /collect, /images)'));
  const stop = () => { server.close(); reader.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { createHandler, collectResponse, loadPlaywright };

if (require.main === module) main();
