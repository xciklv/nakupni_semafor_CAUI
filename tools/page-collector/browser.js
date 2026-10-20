'use strict';
// Sběrač stránek, vrstva prohlížeče: jedno okno headless Chromia (výchozí nastavení Playwrightu, žádné stealth) s ochranou proti SSRF
// z tools/page-reader/guard.js (kontrola hlavní adresy, každého podpožadavku i přesměrování) a záznamem JSON odpovědí, které si stránka
// sama stáhla (XHR/fetch). Nic se nepřihlašuje, nekupuje ani neobchází: ověření (CAPTCHA) se jen rozpozná a nahlásí.
const { checkUrl, looksBlocked } = require('../page-reader/guard');
const { loadPlaywright } = require('../page-reader/server');

const BLOCK_TYPES = new Set(['media', 'font']); // obrázky se stahují jen na požádání (--screenshot)
const MAX_JSON_BYTES = 1500000;

async function openSession({ chromium = loadPlaywright(), check = checkUrl, screenshot = false, locale = 'cs-CZ', timezone = 'Europe/Prague' } = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale, timezoneId: timezone, viewport: { width: 1366, height: 900 } });
  const verdicts = new Map();
  const allowed = (reqUrl) => {
    let key;
    try { const u = new URL(reqUrl); key = u.protocol + '//' + u.hostname; } catch (e) { return false; }
    if (!verdicts.has(key)) verdicts.set(key, Promise.resolve(check(reqUrl)).then((r) => !!(r && r.ok), () => false));
    return verdicts.get(key);
  };
  await context.route('**/*', async (route) => {
    try {
      const req = route.request();
      const t = req.resourceType();
      if (BLOCK_TYPES.has(t) || (t === 'image' && !screenshot)) return await route.abort();
      if (!(await allowed(req.url()))) return await route.abort('blockedbyclient');
      return await route.continue();
    } catch (e) { return undefined; }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const net = [];
  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      const ct = String(resp.headers()['content-type'] || '');
      if (!/json|javascript|text\/plain/i.test(ct)) return;
      const buf = await resp.body();
      if (buf.length > MAX_JSON_BYTES) { net.push({ url: resp.url(), status: resp.status(), bytes: buf.length, body: null }); return; }
      net.push({ url: resp.url(), status: resp.status(), bytes: buf.length, body: buf.toString('utf8') });
    } catch (e) { /* odpověď zanikla s navigací */ }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    page, net, sleep, allowed,
    // Další karta ve stejném (hlídaném) kontextu, např. pro stránku obchodu.
    newPage: async () => { const p = await context.newPage(); p.setDefaultTimeout(8000); return p; },
    async close() { await context.close().catch(() => {}); await browser.close().catch(() => {}); },
  };
}

// Počká, až se text stránky přestane měnit (marketplace dokreslují po částech).
async function settle(page, { maxMs = 10000, stableMs = 1500, pollMs = 400, minChars = 300 } = {}) {
  const read = async () => { try { return await page.evaluate(() => (document.body ? document.body.innerText.length : 0)); } catch (e) { return 0; } };
  let last = await read();
  let since = Date.now();
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, pollMs));
    const n = await read();
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since >= stableMs && n >= minChars) break;
  }
  return last;
}

module.exports = { openSession, settle, looksBlocked };
