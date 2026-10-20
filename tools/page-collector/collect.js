#!/usr/bin/env node
'use strict';
// Sběrač produktové stránky marketplace (spike): deterministicky (bez LLM) prokliká sekce a složí z nich JSON dossier důkazů.
//   node tools/page-collector/collect.js <url> [--out dossier.json] [--raw složka] [--no-store] [--quiet]
// Dossier jde na stdout, souhrn měření na stderr. Žádné stealth, žádné přihlašování, nic se nekupuje; ověření (CAPTCHA) a přihlašovací
// zeď se jen rozpoznají a nahlásí v poli `blocked`. Adresy hlídá tools/page-reader/guard.js (SSRF).
const fs = require('node:fs');
const { checkUrl } = require('../page-reader/guard');
const { openSession, settle } = require('./browser');
const { detectBlock } = require('./blocked');
const { createTrail, clip } = require('./adapters/common');
const ali = require('./adapters/aliexpress');
const generic = require('./adapters/generic');
const { fromLabeledRow, fromFreeText, collectIdentifiers } = require('./identifiers');

const PRICES = { haiku: { in: 0.10, out: 0.50 }, sonnet: { in: 2, out: 10 } }; // USD za milion tokenů (zadání)

function platformOf(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (/(^|\.)aliexpress\.(com|us)$/.test(h)) return 'aliexpress';
  if (/(^|\.)temu\.com$/.test(h)) return 'temu';
  if (/(^|\.)allegro\.(cz|pl|sk)$/.test(h)) return 'allegro';
  return 'other';
}

// Odhad tokenů ze znaků: angličtina ~4 znaky/token, JSON s interpunkcí a češtinou ~3 znaky/token (skutečný tokenizer se neměřil).
function estimate(chars, promptTokens = 1000, outTokens = 800) {
  const tokLow = Math.ceil(chars / 4);
  const tokHigh = Math.ceil(chars / 3);
  const cost = (p, tok) => +(((tok + promptTokens) * p.in + outTokens * p.out) / 1e6).toFixed(5);
  return { chars, tokensLow: tokLow, tokensHigh: tokHigh, assumptions: { promptTokens, outTokens }, costUsd: { haiku: { low: cost(PRICES.haiku, tokLow), high: cost(PRICES.haiku, tokHigh) }, sonnet: { low: cost(PRICES.sonnet, tokLow), high: cost(PRICES.sonnet, tokHigh) } } };
}

// Dvojice „název / hodnota“ z textu okna se specifikací (řádky se střídají).
function overlayRows(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^(Specifications|View more|Close)$/i.test(l));
  const rows = [];
  for (let i = 0; i + 1 < lines.length; i += 2) rows.push({ name: lines[i], value: lines[i + 1] });
  return rows;
}

async function collectDossier(url, { store = true, rawDir = null, chromium } = {}) {
  const started = Date.now();
  const trail = createTrail(rawDir);
  const dossier = { schema: 'nakupni-kontrola/dossier@0-spike', collectedAt: new Date().toISOString(), url, finalUrl: null, platform: null, ok: false, blocked: null };
  let platform;
  try { platform = platformOf(url); } catch (e) { dossier.error = 'neplatná adresa'; return dossier; }
  dossier.platform = platform;
  const g = await checkUrl(url);
  if (!g.ok) { dossier.error = 'adresa není povolená: ' + g.duvod; return dossier; }

  const session = await openSession({ chromium });
  try {
    const { page } = session;
    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = resp ? resp.status() : null;
    } catch (e) { dossier.error = 'načtení stránky selhalo: ' + clip(e.message, 120); return dossier; }
    await settle(page);
    dossier.finalUrl = page.url();
    const fin = await checkUrl(dossier.finalUrl);
    if (!fin.ok) { dossier.error = 'přesměrování na nepovolenou adresu'; return dossier; }
    const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
    const html = await page.content().catch(() => '');
    const title = await page.title().catch(() => '');
    trail.raw('page.html', html);
    const block = detectBlock({ status, finalUrl: dossier.finalUrl, title, text, html });
    if (block) {
      dossier.blocked = block;
      dossier.pageTitle = clip(title, 120);
      trail.gap('celá stránka', (block.kind === 'captcha' ? 'výzva k ověření (CAPTCHA)' : block.kind === 'login-wall' ? 'přihlašovací zeď' : 'chyba') + (block.vendor ? ' – ' + block.vendor : '') + ': nahlášeno, neobcházeno');
      return finish(dossier, trail, session, started);
    }

    let parts;
    if (platform === 'aliexpress') {
      const { snap, variantPrices } = await ali.collect(session, trail);
      const p = ali.parse(snap);
      Object.assign(dossier, { title: p.title, price: p.price, sold: p.sold, headerSeller: p.headerSeller, brand: null });
      if (snap.jsonLd) {
        const ld = [].concat(snap.jsonLd).find((x) => x && /Product/.test(x['@type']));
        if (ld) dossier.structuredData = { source: { section: 'JSON-LD v hlavičce stránky', quote: clip(JSON.stringify({ name: ld.name, brand: ld.brand, offers: ld.offers && { price: ld.offers.price, priceCurrency: ld.offers.priceCurrency }, aggregateRating: ld.aggregateRating }), 250) }, jsonLd: ld };
        if (ld && ld.brand && ld.brand.name) dossier.brand = { value: ld.brand.name, source: { section: 'JSON-LD Product.brand', quote: ld.brand.name } };
      }
      dossier.variants = p.variants && { ...p.variants, optionPrices: variantPrices };
      // Specifikace: z okna „View more“, pokud se otevřelo a má víc řádků
      let spec = p.specifications;
      if (snap.specOverlay) {
        const rows = overlayRows(snap.specOverlay);
        if (rows.length > (spec ? spec.rows.length : 0)) spec = { ...(spec || {}), rows, truncatedBeforeViewMore: false, source: { section: 'Specifications – okno po „View more“', quote: clip(snap.specOverlay, 160) } };
      }
      dossier.specifications = spec;
      dossier.description = { aiOverview: p.aiOverview, sellerDescription: { ...p.sellerDescription, frameText: snap.frameDescription ? clip(snap.frameDescription, 3000) : null } };
      const items = ali.parseReviews(snap.reviewItemsAll || snap.review.items);
      dossier.reviews = { ...p.reviews, items, shown: items.length, complete: p.reviews.count != null ? items.length >= p.reviews.count : null, source: { section: 'sekce recenzí (#nav-review)', quote: clip(snap.review.text, 160) } };
      dossier.seller = p.seller ? { ...p.seller, registration: p.compliance ? { soldBy: p.compliance.soldBy, processedBy: p.compliance.processedBy, logisticsBy: p.compliance.logisticsBy, source: p.compliance.source } : null, headerLine: p.headerSeller } : null;
      dossier.delivery = p.delivery;
      dossier.returns = p.returns && { ...p.returns, detail: snap.overlays['Return & refund policy'] ? clip(snap.overlays['Return & refund policy'], 1500) : null };
      dossier.overlays = Object.fromEntries(Object.entries(snap.overlays).map(([k, v]) => [k, clip(v, 1500)]));
      dossier.compliance = p.compliance;
      parts = [
        ...(spec ? spec.rows.flatMap((r) => fromLabeledRow(r.name, r.value, 'Specifications')) : []),
        ...fromFreeText(p.title ? p.title.value : '', 'název'),
        ...(p.aiOverview ? fromFreeText(p.aiOverview.bullets.join('\n'), 'AI přehled') : []),
        ...(snap.description.text ? fromFreeText(snap.description.text.slice(0, 4000), 'Description') : []),
        ...(snap.frameDescription ? fromFreeText(snap.frameDescription.slice(0, 4000), 'Description (iframe)') : []),
      ];
      if (!snap.description.sellerText && !snap.frameDescription) trail.gap('popis prodejce', 'prázdný (#product-description bez textu; zřejmě jen obrázky nebo se nedotáhl)');
      if (p.seller && !dossier.seller.registration) trail.gap('registrační údaje prodejce', 'platforma je na stránce produktu nezveřejňuje');
      trail.gap('doba existence obchodu', 'na stránce produktu není; hledá se na stránce obchodu');
      if (store && p.seller && p.seller.storeUrl) await collectStore(session, trail, dossier, p.seller.storeUrl);
    } else {
      const { snap } = await generic.collect(session, trail);
      const p = generic.parse(snap);
      Object.assign(dossier, { title: p.title, price: p.price, reviews: p.reviews, specifications: p.specifications, description: p.description && { generic: p.description } });
      parts = [
        ...(p.specifications ? p.specifications.rows.flatMap((r) => fromLabeledRow(r.name, r.value, 'parametry')) : []),
        ...fromFreeText(p.title ? p.title.value : '', 'název'),
      ];
      if (p.jsonLdIds) for (const [k, type] of [['gtin', 'ean'], ['mpn', 'manufacturer-code'], ['sku', 'sku']]) if (p.jsonLdIds[k]) parts.push({ type, value: String(p.jsonLdIds[k]), label: 'JSON-LD ' + k, section: 'JSON-LD', quote: k + ': ' + p.jsonLdIds[k], via: 'json-ld' });
      trail.gap('recenze, prodejce, dodání, vrácení', 'pro tuto platformu není adaptér (nutné doplnit pevné kroky nebo agentní krok)');
    }
    dossier.identifiers = collectIdentifiers(parts || []);
    dossier.ok = !!(dossier.title && dossier.title.value);
    return finish(dossier, trail, session, started);
  } catch (e) {
    dossier.error = 'sběr selhal: ' + clip(e && e.message, 200);
    return finish(dossier, trail, session, started);
  } finally {
    await session.close();
  }
}

async function collectStore(session, trail, dossier, storeUrl) {
  const g = await checkUrl(storeUrl);
  if (!g.ok) { trail.gap('stránka obchodu', 'adresa není povolená'); return; }
  const sp = await session.newPage();
  try {
    const resp = await sp.goto(storeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await settle(sp, { maxMs: 8000, minChars: 200 });
    const snap = await sp.evaluate(ali.STORE_SNAPSHOT);
    const html = await sp.content().catch(() => '');
    const block = detectBlock({ status: resp ? resp.status() : null, finalUrl: sp.url(), title: snap.title, text: snap.body, html });
    trail.evidenceFor('store-page', 'dom', snap.body);
    if (block) { dossier.store = { blocked: block }; trail.gap('stránka obchodu', (block.kind === 'captcha' ? 'výzva k ověření' : block.kind) + ' – nahlášeno, neobcházeno'); return; }
    dossier.store = { url: sp.url(), ...ali.parseStore(snap) };
    trail.act('stránka obchodu načtena', true, snap.body.length + ' znaků');
    if (!dossier.store.openSince) trail.gap('doba existence obchodu', 'na stránce obchodu není uvedena');
  } catch (e) {
    trail.gap('stránka obchodu', clip(e.message, 120));
  } finally { await sp.close().catch(() => {}); }
}

function finish(dossier, trail, session, started) {
  dossier.challenge = trail.challenge || null;
  dossier.gaps = trail.gaps;
  dossier.actions = trail.actions;
  dossier.evidenceIndex = trail.evidence;
  const net = session.net;
  dossier.stats = { ms: Date.now() - started, jsonResponsesSeen: net.length, jsonBytesSeen: net.reduce((a, n) => a + n.bytes, 0) };
  const chars = JSON.stringify(dossier).length;
  dossier.stats.dossier = estimate(chars);
  dossier.stats.dossier.charsPretty = JSON.stringify(dossier, null, 1).length;
  return dossier;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const out = flag('--out');
  const raw = flag('--raw');
  const noStore = args.includes('--no-store');
  const quiet = args.includes('--quiet');
  const url = args.find((a) => /^https?:\/\//.test(a));
  if (!url) { console.error('Použití: node tools/page-collector/collect.js <url> [--out soubor.json] [--raw složka] [--no-store] [--quiet]'); process.exit(2); }
  const d = await collectDossier(url, { store: !noStore, rawDir: raw });
  const json = JSON.stringify(d, null, 2);
  if (out) fs.writeFileSync(out, json); else process.stdout.write(json + '\n');
  if (!quiet) {
    const s = d.stats || {};
    console.error(`[collector] ${d.platform} ok=${d.ok} ${s.ms || 0} ms, dossier ${s.dossier ? s.dossier.chars : 0} znaků (~${s.dossier ? s.dossier.tokensLow + '–' + s.dossier.tokensHigh : 0} tokenů)` + (d.blocked ? `, BLOKACE: ${d.blocked.kind}${d.blocked.vendor ? ' (' + d.blocked.vendor + ')' : ''}` : '') + (d.error ? ', chyba: ' + d.error : ''));
  }
  process.exit(d.ok || d.blocked ? 0 : 1);
}

if (require.main === module) main();

module.exports = { collectDossier, estimate, platformOf, overlayRows };
