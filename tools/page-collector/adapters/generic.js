'use strict';
// Záložní adaptér pro marketplace bez vlastního adaptéru (Allegro, Temu, …): strukturovaná data (JSON-LD, meta), tabulky parametrů a text.
// Nic neproklikává, protože rozložení není známé: to je přesně místo pro „agentní krok pro doplnění mezer“ (viz zpráva).
const { clip } = require('./common');

const SNAPSHOT = () => {
  const norm = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const meta = (n) => { const m = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`); return m ? m.content : null; };
  const lds = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => { try { return JSON.parse(s.textContent); } catch (e) { return null; } }).filter(Boolean);
  const rows = [];
  document.querySelectorAll('table tr').forEach((tr) => { const c = [...tr.children].map((x) => norm(x.innerText)); if (c.length === 2 && c[0] && c[1]) rows.push({ name: c[0], value: c[1] }); });
  document.querySelectorAll('dl').forEach((dl) => { const dts = [...dl.querySelectorAll('dt')]; dts.forEach((dt) => { const dd = dt.nextElementSibling; if (dd && dd.tagName === 'DD') rows.push({ name: norm(dt.innerText), value: norm(dd.innerText) }); }); });
  const h1 = document.querySelector('h1');
  return { title: document.title, h1: h1 ? norm(h1.innerText) : null, ogTitle: meta('og:title'), ogDescription: meta('og:description'), lds, rows: rows.slice(0, 200), body: norm(document.body ? document.body.innerText : '') };
};

function flatProducts(lds) {
  const out = [];
  const walk = (x) => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); if (/Product/.test([].concat(x['@type'] || []).join(','))) out.push(x); if (x['@graph']) walk(x['@graph']); };
  walk(lds);
  return out;
}

function parse(snap) {
  const prod = flatProducts(snap.lds)[0] || null;
  const offer = prod && prod.offers ? [].concat(prod.offers)[0] : null;
  const title = snap.h1 || (prod && prod.name) || snap.ogTitle || snap.title;
  return {
    title: title ? { value: title, source: { section: snap.h1 ? 'h1' : prod ? 'JSON-LD Product.name' : 'meta/title', quote: clip(title, 200) } } : null,
    price: offer && offer.price != null ? { amount: Number(offer.price), currency: offer.priceCurrency || null, text: offer.price + ' ' + (offer.priceCurrency || ''), source: { section: 'JSON-LD Product.offers', quote: JSON.stringify({ price: offer.price, priceCurrency: offer.priceCurrency }) } } : null,
    reviews: prod && prod.aggregateRating ? { count: Number(prod.aggregateRating.reviewCount || prod.aggregateRating.ratingCount) || null, average: Number(prod.aggregateRating.ratingValue) || null, source: { section: 'JSON-LD Product.aggregateRating', quote: JSON.stringify(prod.aggregateRating).slice(0, 160) } } : null,
    specifications: snap.rows.length ? { rows: snap.rows, source: { section: 'tabulka/seznam parametrů (table, dl)', quote: clip(snap.rows.slice(0, 3).map((r) => r.name + ': ' + r.value).join(' | '), 200) } } : null,
    jsonLdIds: prod ? { gtin: prod.gtin || prod.gtin13 || prod.gtin8 || prod.gtin12 || prod.gtin14 || null, mpn: prod.mpn || null, sku: prod.sku || null, brand: prod.brand && (prod.brand.name || prod.brand) || null } : null,
    description: prod && prod.description ? { text: prod.description, source: { section: 'JSON-LD Product.description', quote: clip(prod.description, 160) } } : null,
  };
}

async function collect(session, trail) {
  const { page } = session;
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 1000); await session.sleep(400); }
  const snap = await page.evaluate(SNAPSHOT);
  trail.evidenceFor('snapshot-body', 'dom', snap.body);
  return { snap };
}

module.exports = { collect, parse, SNAPSHOT };
