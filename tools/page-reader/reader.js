'use strict';
// Čtečka stránek: otevře veřejnou stránku ve skutečném (headless) Chromiu a vrátí její viditelný text. Je určená pro marketplace,
// které se kreslí JavaScriptem, takže obyčejné stažení HTML z nich dostane jen kostru bez ceny, prodejce a recenzí.
// Žádné obcházení ochrany proti robotům: pokud stránka vyžaduje ověření, čtečka to jen nahlásí.
const { checkUrl, cleanText, looksBlocked } = require('./guard');

const DEFAULTS = {
  navTimeoutMs: 25000, // goto (domcontentloaded)
  settleMaxMs: 12000, // nejdéle se čeká na dokreslení textu
  settleStableMs: 1500, // text se nesmí 1,5 s měnit
  pollMs: 500,
  totalMs: 40000, // tvrdý strop jedné stránky
  maxChars: 15000,
  minChars: 300,
  blockTypes: ['image', 'media', 'font'], // text nabídky je v HTML, obrázky a písma jen zdržují
};

// chromium: objekt `chromium` z Playwrightu (v testech náhrada). check: kontrola adresy (SSRF).
function createReader({ chromium, check = checkUrl, options = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const o = { ...DEFAULTS, ...options };
  const blockTypes = new Set(o.blockTypes);
  let browserPromise = null;

  async function getBrowser() {
    if (browserPromise) {
      try {
        const b = await browserPromise;
        if (b.isConnected()) return b;
      } catch (e) { /* start se nepovedl: zkusí se znovu */ }
      browserPromise = null;
    }
    browserPromise = chromium.launch({ headless: true });
    try { return await browserPromise; } catch (e) { browserPromise = null; throw e; }
  }

  async function read(url) {
    const first = await check(url);
    if (!first.ok) return { ok: false, duvod: 'adresa není povolená: ' + first.duvod };
    const t0 = Date.now();
    let context = null;
    let timer;
    const verdicts = new Map();
    // Verdikt se pamatuje podle schématu a hostitele, aby se jedno jméno nepřekládalo pro každý podpožadavek zvlášť.
    const allowed = async (reqUrl) => {
      let key;
      try { const u = new URL(reqUrl); key = u.protocol + '//' + u.hostname; } catch (e) { return false; }
      if (!verdicts.has(key)) verdicts.set(key, Promise.resolve(check(reqUrl)).then((r) => !!(r && r.ok), () => false));
      return verdicts.get(key);
    };
    const work = (async () => {
      const browser = await getBrowser();
      context = await browser.newContext({ locale: 'cs-CZ', viewport: { width: 1280, height: 900 } });
      await context.route('**/*', async (route) => {
        try {
          const req = route.request();
          if (blockTypes.has(req.resourceType())) return await route.abort();
          if (!(await allowed(req.url()))) return await route.abort('blockedbyclient');
          return await route.continue();
        } catch (e) { /* stránka se mezitím zavřela */ return undefined; }
      });
      const page = await context.newPage();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: o.navTimeoutMs });
      const status = resp ? resp.status() : null;
      let text = '';
      const readText = async () => { try { return await page.evaluate(() => (document.body ? document.body.innerText : '')); } catch (e) { return text; } };
      text = await readText();
      let last = text.length;
      let stableSince = Date.now();
      const settleEnd = Date.now() + o.settleMaxMs;
      while (Date.now() < settleEnd) {
        await sleep(o.pollMs);
        text = await readText();
        if (text.length !== last) { last = text.length; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= o.settleStableMs && text.length >= o.minChars) break;
      }
      const finalUrl = page.url();
      if (!(await allowed(finalUrl))) return { ok: false, duvod: 'přesměrování na nepovolenou adresu' };
      let title = '';
      try { title = await page.title(); } catch (e) { /* bez titulku */ }
      const clean = cleanText(text, o.maxChars);
      if (looksBlocked(clean)) return { ok: false, duvod: 'stránka vyžaduje ověření (ochrana proti robotům), čtečka ji neobchází', status };
      if (status !== null && status >= 400) return { ok: false, duvod: 'stránka vrátila chybu ' + status, status };
      if (clean.length < o.minChars) return { ok: false, duvod: 'stránka je prázdná nebo se nedokreslila', status };
      return { ok: true, status, title: title.slice(0, 200), finalUrl: finalUrl.slice(0, 500), text: clean, ms: Date.now() - t0 };
    })();
    work.catch(() => {});
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, duvod: 'čas na načtení stránky vypršel' }), o.totalMs); });
    try {
      return await Promise.race([work, limit]);
    } catch (e) {
      return { ok: false, duvod: 'stránku se nepodařilo načíst' };
    } finally {
      clearTimeout(timer);
      if (context) await context.close().catch(() => {});
    }
  }

  async function close() {
    if (!browserPromise) return;
    try { const b = await browserPromise; await b.close(); } catch (e) { /* už je zavřený */ }
    browserPromise = null;
  }

  return { read, close };
}

module.exports = { createReader, DEFAULTS };
