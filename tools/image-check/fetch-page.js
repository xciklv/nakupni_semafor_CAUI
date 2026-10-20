'use strict';
// Krok 1 spiku: načte stránku nabídky (headless Chromium, výchozí nastavení Playwrightu, žádné stealth, SSRF kontrola z guard.js)
// a uloží to, co o obrázcích stránka sama řekne, do <outDir>/page-dump.json + page-text.txt. Stránku načte JEDNOU; výběr galerie
// a stahování obrázků se pak dělají z dumpu (select-images.js), bez dalšího načítání.
//   node tools/image-check/fetch-page.js <url> <outDir>
// Ověření (CAPTCHA, „unusual traffic“) se jen rozpozná a nahlásí, nikdy se neobchází.
const fs = require('node:fs');
const path = require('node:path');
const { checkUrl, looksBlocked } = require('../page-reader/guard');
const { loadPlaywright } = require('./lib');

async function main() {
  const [url, outDir] = process.argv.slice(2);
  if (!url || !outDir) { console.error('použití: node fetch-page.js <url> <outDir>'); process.exit(2); }
  const g = await checkUrl(url);
  if (!g.ok) { console.error('adresa zamítnuta: ' + g.duvod); process.exit(3); }
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await loadPlaywright().launch({ headless: true });
  const context = await browser.newContext(); // výchozí nastavení
  const verdicts = new Map();
  const allowed = (u) => {
    let key; try { const x = new URL(u); key = x.protocol + '//' + x.hostname; } catch (e) { return false; }
    if (!verdicts.has(key)) verdicts.set(key, Promise.resolve(checkUrl(u)).then((r) => !!(r && r.ok), () => false));
    return verdicts.get(key);
  };
  await context.route('**/*', async (route) => {
    try {
      const req = route.request();
      if (['media', 'font'].includes(req.resourceType())) return await route.abort();
      if (!(await allowed(req.url()))) return await route.abort('blockedbyclient');
      return await route.continue();
    } catch (e) { return undefined; }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 600); await page.waitForTimeout(800); } // dokreslení líně načítaného obsahu
    await page.waitForTimeout(2000);
    const dump = await page.evaluate(() => {
      const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
      const imgs = [...document.images].map((im) => {
        const r = im.getBoundingClientRect();
        const chain = [];
        for (let e = im.parentElement, n = 0; e && n < 4; e = e.parentElement, n++) chain.push((e.tagName + '.' + String(e.className || '').split(/\s+/).slice(0, 2).join('.')).slice(0, 60));
        return { src: abs(im.currentSrc || im.src), alt: im.alt || '', nw: im.naturalWidth, nh: im.naturalHeight, x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height), chain };
      }).filter((i) => i.src && !i.src.startsWith('data:'));
      const meta = (n) => (document.querySelector('meta[property="' + n + '"],meta[name="' + n + '"]') || {}).content || null;
      const html = document.documentElement.outerHTML;
      const lists = [];
      for (const m of html.matchAll(/"imagePathList"\s*:\s*(\[[^\]]*\])/g)) { try { lists.push(JSON.parse(m[1])); } catch (e) { /* ignorovat */ } }
      const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 20000));
      return { title: document.title, ogImage: meta('og:image'), ogTitle: meta('og:title'), imagePathLists: lists, ld, imgs, text: document.body ? document.body.innerText : '', htmlLen: html.length, htmlHead: html.length < 6000 ? html : undefined };
    });
    const blocked = looksBlocked(dump.text) || /captcha-delivery.com|datadome/i.test(dump.htmlHead || ''); // DataDome kreslí výzvu do iframe, bez textu
    const text = dump.text;
    delete dump.text;
    fs.writeFileSync(path.join(outDir, 'page-dump.json'), JSON.stringify({ url, finalUrl: page.url(), at: new Date().toISOString(), blocked, ...dump }, null, 1));
    fs.writeFileSync(path.join(outDir, 'page-text.txt'), (dump.title || '') + '\n\n' + text.slice(0, 8000));
    console.log(JSON.stringify({ url, finalUrl: page.url(), title: dump.title, blocked, imgs: dump.imgs.length, imagePathLists: dump.imagePathLists.map((l) => l.length), textChars: text.length }));
  } finally { await context.close().catch(() => {}); await browser.close().catch(() => {}); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
