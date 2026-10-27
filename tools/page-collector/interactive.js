#!/usr/bin/env node
'use strict';
// Spike: sběr s člověkem v okruhu. Otevře VIDITELNÉ Chromium (trvalý profil mimo repo), a když stránku zastaví výzva k ověření
// (CAPTCHA, posuvná skládačka), jen to oznámí v konzoli a čeká, až ji člověk v okně sám projde; pak sběr pokračuje v témže okně.
//   node tools/page-collector/interactive.js <url> [--out vysledek.json] [--raw složka] [--no-store] [--max-wait-min 10]
// Pravidla (pevná): výzvu skript nikdy neřeší ani nenapomáhá (žádné klikání do ní, žádné služby, žádné obcházení detekce); během výzvy
// se v okně nic neklikne ani nevyplní. Žádné stealth přepínače, žádné úpravy User-Agentu, navigator.webdriver ani otisku: jediné odchylky od
// výchozího Playwrightu jsou headless:false, trvalý profil a locale cs-CZ. Nic se nekupuje, nikde se nepřihlašuje. Přihlašovací zeď = konec.
const fs = require('node:fs');
const path = require('node:path');
const { checkUrl } = require('../page-reader/guard');
const { loadPlaywright } = require('../page-reader/server');
const { settle } = require('./browser');
const { detectBlock, detectChallenge } = require('./blocked');
const { overlayRows, platformOf } = require('./collect');
const { createTrail, clip, readOverlay, closeOverlay, clickByText, declineCookies } = require('./adapters/common');
const ali = require('./adapters/aliexpress');
const generic = require('./adapters/generic');

const BASE_DIR = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'nakupni-semafor');
const PROFILE_DIR = process.env.NK_PROFILE_DIR || path.join(BASE_DIR, 'browser-profile');
const LEDGER = path.join(BASE_DIR, 'spike-visits.json'); // hlídá limit spiku: nejvýš 3 načtení téže adresy, odstup aspoň 30 s
const MAX_VISITS = 3;
const MIN_GAP_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (ms) => { const s = Math.round(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

// Konec běhu z jiného důvodu než „hotovo“: closed (okno zavřeno), login-wall, timeout (člověk výzvu neprošel), error, limit (limit spiku).
class Stop extends Error { constructor(reason, detail) { super(reason + (detail ? ': ' + detail : '')); this.reason = reason; this.detail = detail; } }

function createCtx(page, { log = () => {}, maxWaitMs = 600000, pollMs = 2000, confirmMs = 2000 } = {}) {
  const ctx = { page, log, maxWaitMs, pollMs, confirmMs, maxEpisodes: 8, clickingStopped: false, closed: false, lastStatus: null, episodes: [], t0: Date.now(), ignored: 0 };
  page.on('response', (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) ctx.lastStatus = r.status(); } catch (e) { /* zanikla */ } });
  page.on('close', () => { ctx.closed = true; });
  return ctx;
}

// Stav stránky: clear | challenge | login-wall | error | transient (stránka se právě přepíná) | closed.
async function assess(ctx) {
  const { page } = ctx;
  if (ctx.closed || page.isClosed()) return { kind: 'closed' };
  try {
    const url = page.url();
    const [title, text, html] = await Promise.all([page.title(), page.evaluate(() => (document.body ? document.body.innerText : '')), page.content()]);
    const ch = await detectChallenge(page);
    const block = detectBlock({ status: ctx.lastStatus, finalUrl: url, title, text, html });
    if (block && block.kind === 'login-wall') return { kind: 'login-wall', block };
    // Tvrdá blokace: stránka jen oznámí zákaz, není co projít (člověk nemá co udělat) -> konec, nečekat.
    if (!ch && /Byli jste zablokováni|You have been blocked|Sorry, you have been blocked|Přístup byl odepřen|Access denied/i.test(text.slice(0, 2000))) return { kind: 'hard-block', evidence: clip(text, 160) };
    // blocked.js pojmenuje každý iframe jako AliExpress; tady se dodavatel určí podle skutečného obsahu.
    const vendorOf = (fallback) => (/captcha-delivery.com|datadome/i.test(html) ? 'DataDome' : /punish|baxia|x5secdata/i.test(url + ' ' + html.slice(0, 20000)) ? 'AliExpress baxia' : fallback);
    if (ch) return { kind: 'challenge', vendor: vendorOf(ch.vendor || (block && block.vendor) || null), evidence: ch.evidence };
    if (block && block.kind === 'captcha') {
      // DataDome a baxia se v blocked.js poznají i jen z HTML/adresy. Na plné stránce (hodně textu) bez viditelného překryvu to je jen
      // skript dodavatele vložený do běžné stránky, ne výzva.
      const htmlOnly = block.vendor === 'DataDome' || block.vendor === 'AliExpress baxia/punish';
      if (htmlOnly && text.length > 3000) { ctx.ignored += 1; return { kind: 'clear' }; }
      return { kind: 'challenge', vendor: vendorOf(block.vendor), evidence: block.evidence };
    }
    if (block && block.kind === 'http-error') return { kind: 'error', block };
    return { kind: 'clear', textChars: text.length };
  } catch (e) {
    if (ctx.closed || page.isClosed()) return { kind: 'closed' };
    return { kind: 'transient', error: clip(e.message, 100) };
  }
}

// Počká, až stránka nebude zastavená výzvou. Při výzvě jen vypíše zprávu a každé 2 s kontroluje (nic neklikne). graceMs = jak dlouho
// ještě sledovat čistou stránku, protože výzva často přijde se zpožděním po načtení nebo po kliknutí.
// -> { state: clear|closed|login-wall|error|timeout, hadEpisode }
async function ensureClear(ctx, stage, { graceMs = 0 } = {}) {
  const out = { state: 'clear', hadEpisode: false };
  const graceEnd = Date.now() + graceMs;
  let ep = null;
  let lastRemind = 0;
  for (;;) {
    const a = await assess(ctx);
    if (a.kind === 'closed') { if (ep) ep.outcome = 'okno zavřeno'; return { ...out, state: 'closed' }; }
    if (a.kind === 'login-wall') return { ...out, state: 'login-wall', block: a.block };
    if (a.kind === 'hard-block') { if (!out.hadEpisode) { ctx.episodes.push({ stage, vendor: null, evidence: a.evidence, appearedAtMs: Date.now() - ctx.t0, startedAt: Date.now(), durationMs: null, outcome: 'tvrdá blokace (není co projít)' }); } return { ...out, state: 'hard-block', block: { evidence: a.evidence } }; }
    if (a.kind === 'error') return { ...out, state: 'error', block: a.block };
    if (ep && Date.now() - ep.startedAt > ctx.maxWaitMs) { ep.outcome = 'vypršel limit'; return { ...out, state: 'timeout' }; }
    if (a.kind === 'challenge') {
      if (!ep) {
        ep = { stage, vendor: a.vendor, evidence: a.evidence, appearedAtMs: Date.now() - ctx.t0, startedAt: Date.now(), durationMs: null, outcome: null };
        ctx.episodes.push(ep);
        out.hadEpisode = true;
        process.stdout.write('\x07');
        ctx.log('VÝZVA K OVĚŘENÍ' + (a.vendor ? ' (' + a.vendor + ')' : '') + ' – ' + stage);
        ctx.log('Projděte prosím ověření v otevřeném okně; čekám až ' + Math.round(ctx.maxWaitMs / 60000) + ' minut. Nic v okně neklikám ani nevyplňuji. (Když se po ověření stránka sama nenačte, obnovte ji klávesou F5.)');
        await ctx.page.bringToFront().catch(() => {});
        lastRemind = Date.now();
      } else if (Date.now() - lastRemind > 60000) {
        lastRemind = Date.now();
        ctx.log('stále čekám na ověření, zbývá asi ' + Math.max(0, Math.round((ctx.maxWaitMs - (Date.now() - ep.startedAt)) / 60000)) + ' min');
      }
      await sleep(ctx.pollMs);
      continue;
    }
    if (ep) { // výzva zmizela (nebo se stránka přepíná): potvrdit, že se hned nevrátila
      if (a.kind === 'transient') { await sleep(500); continue; }
      await sleep(ctx.confirmMs);
      const b = await assess(ctx);
      if (b.kind === 'challenge' || b.kind === 'transient') continue;
      ep.durationMs = Date.now() - ep.startedAt - ctx.confirmMs;
      ep.outcome = 'prošla';
      ctx.log('Ověření prošlo po ' + mmss(ep.durationMs) + '; pokračuji ve sběru.');
      await settle(ctx.page, { maxMs: 8000, minChars: 200 });
      return out;
    }
    if (Date.now() < graceEnd) { await sleep(500); continue; }
    return out;
  }
}

// Brána před krokem a po něm: při výzvě čeká na člověka, při konci (zavřené okno, přihlašovací zeď, vypršení) ukončí běh.
async function gate(ctx, stage, opts) {
  const r = await ensureClear(ctx, stage, opts);
  if (r.state !== 'clear') throw new Stop(r.state, r.block ? (r.block.evidence || r.block.url) : undefined);
  return r;
}

// Krok, který něco klikne nebo čte. Když výzva přišla těsně před klikem nebo po něm, krok se po jejím projití jednou zopakuje.
async function step(ctx, label, fn, { grace = 1200, click = true } = {}) {
  if (click && ctx.clickingStopped) { ctx.trail.act(label, false, 'přeskočeno: výzva se vrací příliš často (limit ' + ctx.maxEpisodes + ')'); return undefined; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const pre = await gate(ctx, label);
    const out = await fn();
    const post = await gate(ctx, 'po kroku: ' + label, { graceMs: grace });
    if (click && ctx.episodes.length >= ctx.maxEpisodes && !ctx.clickingStopped) { ctx.clickingStopped = true; ctx.log('Výzva se vrátila už ' + ctx.episodes.length + '×; dál už NEKLIKÁM (zbytek jen čtu), abych uživatele neotravoval.'); ctx.trail.gap('další proklikávání', 'zastaveno po ' + ctx.episodes.length + ' výzvách (limit ' + ctx.maxEpisodes + ')'); }
    if (!(pre.hadEpisode || post.hadEpisode) || attempt === 1 || !post.hadEpisode) return out;
    ctx.trail.act(label + ': zopakováno po ověření', true);
  }
  return undefined;
}

async function safeEval(ctx, fn, arg) {
  for (let i = 0; i < 4; i++) {
    try { return await ctx.page.evaluate(fn, arg); } catch (e) {
      if (ctx.closed || ctx.page.isClosed()) throw new Stop('closed');
      await sleep(1000);
    }
  }
  throw new Error('čtení stránky se nepovedlo (stránka se stále přepíná)');
}

// Návštěvy téže adresy v rámci spiku: nejvýš MAX_VISITS a odstup MIN_GAP_MS (počká).
function readLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) { return {}; } }
async function beforeLoad(ctx, url) {
  const key = String(url).split('#')[0];
  const led = readLedger();
  const times = led[key] || [];
  if (times.length >= MAX_VISITS) throw new Stop('limit', 'adresa už byla ve spiku načtena ' + times.length + '×');
  const wait = times.length ? times[times.length - 1] + MIN_GAP_MS - Date.now() : 0;
  if (wait > 0) { ctx.log('odstup mezi načteními téže stránky: čekám ' + Math.ceil(wait / 1000) + ' s'); await sleep(wait); }
  times.push(Date.now());
  led[key] = times;
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(led, null, 1));
  return times.length;
}

async function go(ctx, url) {
  const n = await beforeLoad(ctx, url);
  ctx.log('načítám (' + n + '. načtení v tomto spiku): ' + url.slice(0, 110));
  const g = await checkUrl(url);
  if (!g.ok) throw new Stop('error', 'adresa není povolená: ' + g.duvod);
  try {
    const resp = await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    ctx.lastStatus = resp ? resp.status() : null;
  } catch (e) {
    if (ctx.closed) throw new Stop('closed');
    if (/^about:blank/.test(ctx.page.url())) throw new Stop('error', 'načtení selhalo: ' + clip(e.message, 120));
    ctx.log('upozornění při načtení: ' + clip(e.message, 100));
  }
  await settle(ctx.page, { maxMs: 10000, minChars: 200 });
  const fin = await checkUrl(ctx.page.url());
  if (!fin.ok) throw new Stop('error', 'přesměrování na nepovolenou adresu');
}

async function scrollThrough(ctx, steps = 8) {
  for (let i = 0; i < steps; i++) { await ctx.page.mouse.wheel(0, 1100); await sleep(450); }
  await ctx.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// Stejné kroky jako adapters/aliexpress.js, každý za bránou na výzvu.
async function collectAliexpress(ctx, { store }) {
  const { page, trail } = ctx;
  await step(ctx, 'rolování stránkou', () => scrollThrough(ctx));
  const snap = await safeEval(ctx, ali.SNAPSHOT);
  const st = ctx.st = { snap, reviewItems: snap.review.items, reviewOverlayOpened: false, variantPrices: [], clicks: 0, fin: null };
  trail.evidenceFor('snapshot-body', 'dom', snap.body);
  await step(ctx, 'cookies', () => declineCookies(page, trail));

  if (snap.aiOverview && snap.aiOverview.hasMore) {
    await step(ctx, 'AI přehled: View More', async () => { const ok = await clickByText(page, '[class*="seo-sellpoints--btnWrap"]', /view more/i); trail.act('AI přehled: View More', ok); if (ok) await sleep(600); });
  }
  if (snap.spec.hasMore) {
    await step(ctx, 'Specifications: View more', async () => {
      const ok = await clickByText(page, '#nav-specification', /view more/i);
      await sleep(900);
      const ov = ok ? await readOverlay(page) : null;
      trail.act('Specifications: View more', ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'bez okna');
      if (ov) { trail.evidenceFor('specifications-overlay', 'dom-overlay', ov.text); snap.specOverlay = ov.text; await closeOverlay(page); await sleep(400); }
    });
  }
  for (const f of page.frames().filter((x) => x !== page.mainFrame())) {
    try {
      const t = await f.evaluate(() => (document.body ? document.body.innerText.trim() : ''));
      if (t && t.length > 30 && /description|product|detail/i.test(f.url() + t.slice(0, 200)) && !/punish|captcha/i.test(f.url())) { snap.frameDescription = (snap.frameDescription || '') + t + '\n'; trail.evidenceFor('description-iframe', 'dom-iframe', t); }
    } catch (e) { /* cizí iframe */ }
  }
  if (snap.review.hasMore) {
    await step(ctx, 'Reviews: View more', async () => {
      const ok = await clickByText(page, '#nav-review', /view more/i);
      await sleep(1200);
      const ov = ok ? await readOverlay(page) : null;
      trail.act('Reviews: View more', ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'beze změny');
      if (ov) {
        st.reviewOverlayOpened = true;
        trail.evidenceFor('reviews-overlay', 'dom-overlay', ov.text);
        let prev = -1;
        for (let i = 0; i < 8; i++) {
          const n = await safeEval(ctx, () => { const els = [...document.querySelectorAll('[class*="list--itemBox"]')]; const last = els[els.length - 1]; if (last) last.scrollIntoView({ block: 'end' }); return els.length; });
          await sleep(700);
          if (n === prev) break;
          prev = n;
        }
        const all = await safeEval(ctx, () => [...document.querySelectorAll('[class*="list--itemBox"]')].map((it) => {
          const T = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
          const q = (s) => it.querySelector(s);
          return { rating: it.querySelectorAll('[class*="comet-icon-starreviewfilled"]').length + 0.5 * it.querySelectorAll('[class*="comet-icon-starhalfreview"]').length, variant: T(q('[class*="list--itemSku"]')), text: T(q('[class*="list--itemReview"]')), info: T(q('[class*="list--itemInfo"]')), helpful: T(q('[class*="list--itemHelpText"]')), photos: it.querySelectorAll('[class*="list--itemThumbnails"] img').length };
        }));
        st.reviewItems = snap.review.items.concat(all);
        await closeOverlay(page);
        await sleep(400);
      }
    });
  }
  const variantPrices = st.variantPrices;
  const multi = snap.props.some((p) => p.options.length > 1);
  if (multi) {
    for (let pi = 0; pi < snap.props.length && st.clicks < 10; pi++) {
      const p = snap.props[pi];
      if (p.options.length < 2) continue;
      for (let oi = 0; oi < p.options.length && st.clicks < 10; oi++) {
        st.clicks++;
        const rec = await step(ctx, 'varianta ' + p.title.split(':')[0] + ' #' + (oi + 1), async () => {
          try {
            const h = await page.evaluateHandle(({ pi, oi }) => {
              const prop = document.querySelectorAll('[class*="sku-item--property"]')[pi];
              return prop ? prop.querySelectorAll('[class*="sku-item--skus"] > div')[oi] || null : null;
            }, { pi, oi });
            const el = h.asElement();
            if (!el) throw new Error('možnost nenalezena');
            await el.click({ timeout: 2500 });
            await sleep(500);
            const after = await page.evaluate(() => {
              const T = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
              return { price: T(document.querySelector('[class*="price-default--current"]')), props: [...document.querySelectorAll('[class*="sku-item--property"]')].map((x) => T(x.querySelector('[class*="sku-item--title"]'))) };
            });
            return { property: p.title.split(':')[0], optionIndex: oi, option: p.options[oi].label, selectedAfterClick: after.props, price: after.price };
          } catch (e) { trail.gap('klik na variantu ' + p.title.split(':')[0] + ' #' + (oi + 1), clip(String(e.message).split('\n')[0], 100)); return null; }
        });
        if (rec) variantPrices.push(rec);
      }
    }
    if (st.clicks) trail.act('Varianty: ' + st.clicks + ' kliků', variantPrices.length > 0, variantPrices.length + ' cen zaznamenáno');
  } else trail.act('Varianty: žádná vlastnost nemá víc než jednu možnost', true);
  for (const [label, scope, re] of [['Return & refund policy', '[class*="shipping--wrap"], [class*="shipping--item"]', /Return & refund policy/i], ['Delivery detail', '[class*="dynamic-shipping"]', /Delivery/i], ['Product compliance information', null, /Product compliance information/i], ['Trader', null, /^\(?Trader\)?$/i]]) {
    await step(ctx, 'klik: ' + label, async () => {
      const ok = await clickByText(page, scope, re);
      await sleep(900);
      const ov = ok ? await readOverlay(page) : null;
      trail.act('klik: ' + label, ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'bez okna');
      if (ov) { trail.evidenceFor('overlay-' + label, 'dom-overlay', ov.text); snap['overlay_' + label] = ov.text; await closeOverlay(page); await sleep(300); }
    });
  }
  await gate(ctx, 'konečné čtení', { graceMs: 500 });
  st.fin = await safeEval(ctx, ali.SNAPSHOT);
  trail.evidenceFor('snapshot-final', 'dom', st.fin.body);
  const res = aliResult(ctx);
  const p = res.p;
  if (store && p.seller && p.seller.storeUrl) {
    // Stránka obchodu se načte ve stejném okně a na stejné kartě (jedna stránka najednou); hlavní data jsou už přečtená.
    res.store = await step(ctx, 'stránka obchodu', async () => {
      await go(ctx, p.seller.storeUrl);
      await gate(ctx, 'po načtení stránky obchodu', { graceMs: 6000 });
      const ss = await safeEval(ctx, ali.STORE_SNAPSHOT);
      trail.evidenceFor('store-page', 'dom', ss.body);
      return { url: ctx.page.url(), ...ali.parseStore(ss), bodyChars: ss.body.length };
    }, { grace: 0, click: false });
  }
  delete res.p;
  return res;
}

// Metriky z toho, co se zatím nasbíralo (volá se i při předčasném konci, aby se částečná data neztratila).
function aliResult(ctx) {
  const st = ctx.st;
  const snap = st.snap;
  const fin = st.fin || snap;
  const overlays = Object.keys(snap).filter((k) => k.startsWith('overlay_')).reduce((a, k) => { a[k.slice(8)] = snap[k]; return a; }, {});
  const merged = { ...fin, specOverlay: snap.specOverlay, frameDescription: snap.frameDescription, overlays, reviewItemsAll: st.reviewItems.concat(st.fin ? st.fin.review.items : []) };
  const p = ali.parse(merged);
  const items = ali.parseReviews(merged.reviewItemsAll);
  let specRows = p.specifications ? p.specifications.rows.length : 0;
  if (merged.specOverlay) specRows = Math.max(specRows, overlayRows(merged.specOverlay).length);
  const prices = st.variantPrices.map((v) => v.price).filter(Boolean);
  const metrics = {
    complete: !!st.fin,
    title: p.title && clip(p.title.value, 80), price: p.price && p.price.text,
    specRows, specRowsBeforeViewMore: snap.spec.rows.length, specViewMoreOpened: !!merged.specOverlay,
    reviewsDeclared: p.reviews.count, reviewsAverage: p.reviews.average, reviewTexts: items.length, reviewTextsOnPage: snap.review.items.length, reviewOverlayOpened: st.reviewOverlayOpened,
    variantClicks: st.clicks, variantPricesRead: st.variantPrices.length, variantPricesDistinct: new Set(prices).size,
    aiBullets: p.aiOverview ? p.aiOverview.bullets.length : 0, overlaysOpened: Object.keys(overlays),
    sellerDescriptionChars: (merged.description.sellerText || '').length + (merged.frameDescription || '').length,
    seller: p.seller && { name: p.seller.name, type: p.seller.type, positiveFeedbackPct: p.seller.positiveFeedbackPct, followers: p.seller.followers },
  };
  return { p, metrics, store: null, parsed: { title: p.title, price: p.price, variants: p.variants, specifications: merged.specOverlay ? { rows: overlayRows(merged.specOverlay) } : p.specifications, reviews: { ...p.reviews, items }, seller: p.seller, variantPrices: st.variantPrices } };
}

// Allegro a ostatní: obecný adaptér (rolování a čtení JSON-LD, tabulek, textu); rozložení se nezkouší proklikávat.
async function collectGeneric(ctx) {
  const { trail } = ctx;
  await gate(ctx, 'před čtením', { graceMs: 1000 });
  await step(ctx, 'rolování stránkou', () => generic.collect({ page: ctx.page, sleep }, trail).then((r) => { ctx.genericSnap = r.snap; }), { grace: 2000 });
  const snap = await safeEval(ctx, generic.SNAPSHOT);
  const p = generic.parse(snap);
  const body = snap.body;
  const metrics = {
    title: p.title && clip(p.title.value, 80), price: p.price && p.price.text, bodyChars: body.length,
    specRows: p.specifications ? p.specifications.rows.length : 0, jsonLdProducts: p.jsonLdIds ? 1 : 0,
    reviewsDeclared: p.reviews && p.reviews.count, reviewsAverage: p.reviews && p.reviews.average,
    reviewWordsInText: (body.match(/opini[ei]|recenz/gi) || []).length,
    jsonLdIds: p.jsonLdIds,
  };
  return { metrics, parsed: { title: p.title, price: p.price, specifications: p.specifications, reviews: p.reviews, bodyHead: clip(body, 600) } };
}

async function run(url, { out = null, raw = null, store = true, maxWaitMs = 600000, channel = process.env.NK_BROWSER_CHANNEL || null } = {}) {
  const started = Date.now();
  const chromium = loadPlaywright();
  const result = { schema: 'nakupni-semafor/interactive-spike@0', url, platform: null, startedAt: new Date().toISOString(), outcome: null, outcomeDetail: null, profileDir: PROFILE_DIR };
  try { result.platform = platformOf(url); } catch (e) { result.outcome = 'error'; result.outcomeDetail = 'neplatná adresa'; return result; }
  const g = await checkUrl(url);
  if (!g.ok) { result.outcome = 'error'; result.outcomeDetail = 'adresa není povolená: ' + g.duvod; return result; }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const log0 = (m) => console.log('[' + mmss(Date.now() - started) + '] ' + m);
  log0('OTEVÍRÁM VIDITELNÉ OKNO CHROMIA (profil ' + PROFILE_DIR + '). Pokud se objeví výzva k ověření, projděte ji v tomto okně.');
  // Jediné odchylky od výchozího stavu Playwrightu: headless:false, trvalý profil, locale cs-CZ (a případně --channel, když není stažené
  // Chromium od Playwrightu: pak se použije nainstalovaný Chrome/Edge, jinak se nic nemění).
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, locale: 'cs-CZ', ...(channel ? { channel } : {}) });
  const cached = new Map();
  const allowed = (u) => { // ochrana proti SSRF (guard.js) pro každý podpožadavek; nic se neblokuje podle typu (obrázky jsou potřeba pro ověření)
    let key;
    try { const x = new URL(u); key = x.protocol + '//' + x.hostname; } catch (e) { return false; }
    if (!cached.has(key)) cached.set(key, Promise.resolve(checkUrl(u)).then((r) => !!(r && r.ok), () => false));
    return cached.get(key);
  };
  await context.route('**/*', async (route) => { try { return (await allowed(route.request().url())) ? await route.continue() : await route.abort('blockedbyclient'); } catch (e) { return undefined; } });
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(8000);
  const ctx = createCtx(page, { log: log0, maxWaitMs });
  ctx.t0 = started;
  ctx.trail = createTrail(raw);
  context.on('close', () => { ctx.closed = true; });
  let data = null;
  try {
    await go(ctx, url);
    result.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    result.navigatorWebdriver = await page.evaluate(() => navigator.webdriver).catch(() => null); // jen přečteno, nic se nemění
    await gate(ctx, 'po načtení stránky', { graceMs: 8000 });
    const text0 = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (text0 < 500 && ctx.episodes.length) {
      log0('Stránka po ověření zůstala prázdná (' + text0 + ' znaků), čekám až 20 s, pak ji jednou obnovím (jako by ji obnovil člověk).');
      await settle(page, { maxMs: 20000, minChars: 500 });
      const t1 = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
      if (t1 < 500) { result.reloadedAfterChallenge = true; await go(ctx, url); await gate(ctx, 'po obnovení stránky', { graceMs: 8000 }); }
    }
    result.finalUrl = page.url();
    data = result.platform === 'aliexpress' ? await collectAliexpress(ctx, { store }) : await collectGeneric(ctx);
    result.outcome = 'ok';
    ctx.log('Sběr dokončen.');
  } catch (e) {
    if (ctx.st) { try { data = aliResult(ctx); delete data.p; data.partial = true; } catch (x) { /* nic nenasbíráno */ } }
    if (e instanceof Stop) { result.outcome = e.reason; result.outcomeDetail = e.detail || null; ctx.log('KONEC: ' + ({ closed: 'okno bylo zavřeno', 'login-wall': 'přihlašovací zeď (nepřihlašuji se)', timeout: 'ověření nebylo prošlo v limitu', 'hard-block': 'tvrdá blokace (stránka jen oznamuje zákaz, není co projít)', error: 'chyba', limit: 'limit spiku' }[e.reason] || e.reason) + (e.detail ? ' – ' + e.detail : '')); }
    else { result.outcome = 'error'; result.outcomeDetail = clip(e && e.stack || e.message, 300); ctx.log('CHYBA: ' + clip(e && e.message, 200)); }
  }
  result.totalMs = Date.now() - started;
  result.challengeEpisodes = ctx.episodes.map((e) => ({ stage: e.stage, vendor: e.vendor, appearedAtMs: e.appearedAtMs, durationMs: e.durationMs, outcome: e.outcome, evidence: e.evidence }));
  result.challengeCount = ctx.episodes.length;
  result.ignoredHtmlOnlyMatches = ctx.ignored;
  result.humanWaitMs = ctx.episodes.reduce((a, e) => a + (e.durationMs || (e.outcome ? Date.now() - e.startedAt : 0)), 0);
  Object.assign(result, data || {});
  result.actions = ctx.trail.actions;
  result.gaps = ctx.trail.gaps;
  if (!ctx.closed) { ctx.log('Zavírám okno za 3 s (uloží se profil).'); await sleep(3000); }
  await context.close().catch(() => {});
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  return result;
}

function summary(r) {
  const m = r.metrics || {};
  const lines = ['', '=== SOUHRN ===', `${r.platform} · výsledek: ${r.outcome}${r.outcomeDetail ? ' (' + r.outcomeDetail + ')' : ''} · celkem ${mmss(r.totalMs)} (z toho čekání na člověka ${mmss(r.humanWaitMs)})`, `výzev: ${r.challengeCount}` + r.challengeEpisodes.map((e, i) => `\n  ${i + 1}. ${e.stage}: objevila se v ${mmss(e.appearedAtMs)}, ${e.outcome}${e.durationMs != null ? ', ' + mmss(e.durationMs) : ''}${e.vendor ? ' (' + e.vendor + ')' : ''}`).join('')];
  if (r.metrics) lines.push(JSON.stringify(m));
  if (r.gaps && r.gaps.length) lines.push('mezery: ' + r.gaps.map((x) => x.what + ' – ' + x.why).join('; '));
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const out = flag('--out');
  const raw = flag('--raw');
  const wait = flag('--max-wait-min');
  const channel = flag('--channel');
  const noStore = args.includes('--no-store');
  const url = args.find((a) => /^https?:\/\//.test(a));
  if (!url) { console.error('Použití: node tools/page-collector/interactive.js <url> [--out vysledek.json] [--raw složka] [--no-store] [--max-wait-min 10] [--channel chrome|msedge]'); process.exit(2); }
  const r = await run(url, { out, raw, store: !noStore, maxWaitMs: (Number(wait) || 10) * 60000, channel: channel || undefined });
  console.log(summary(r));
  process.exit(r.outcome === 'ok' ? 0 : 1);
}

if (require.main === module) main();

module.exports = { run, createCtx, assess, ensureClear, gate, step, Stop, PROFILE_DIR, LEDGER };
