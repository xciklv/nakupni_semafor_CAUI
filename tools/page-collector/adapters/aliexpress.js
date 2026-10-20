'use strict';
// Adaptér AliExpress (stránka /item/<id>.html). Pevné kroky bez LLM: kotvy sekcí (#nav-review, #nav-specification, #nav-description, #nav-store),
// třídy s hashem se berou jen přes předponu ([class*="sku-item--"]), protože přípona se při každém nasazení mění.
const { clip, readOverlay, closeOverlay, clickByText, declineCookies } = require('./common');
const { detectChallenge } = require('../blocked');
const { fromLabeledRow, fromFreeText } = require('../identifiers');

// Spouští se na stránce (page.evaluate): vrací jen syrová data a texty, žádný výklad.
const SNAPSHOT = () => {
  const norm = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  const T = (el) => (el ? norm(el.innerText) : '');
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const stars = (el) => qa('[class*="comet-icon-starreviewfilled"]', el).length + 0.5 * qa('[class*="comet-icon-starhalfreview"]', el).length;
  const body = norm(document.body.innerText);
  const price = q('[class*="price-default--wrap"]');
  const props = qa('[class*="sku-item--property"]').map((p) => ({
    title: T(q('[class*="sku-item--title"]', p)),
    options: qa('[class*="sku-item--skus"] > div', p).map((o) => ({
      label: o.getAttribute('title') || (q('img', o) && q('img', o).getAttribute('alt')) || T(o),
      selected: /selected/.test(String(o.className)),
    })),
  }));
  const ai = q('[class*="seo-sellpoints--title"]');
  const aiRoot = ai ? ai.parentElement : null;
  const store = q('[class*="store-detail--wrap"]');
  const nav = (id) => document.getElementById(id);
  const sd = q('#product-description');
  let ld = null;
  try { ld = JSON.parse((q('script[type="application/ld+json"]') || {}).textContent || 'null'); } catch (e) { /* bez JSON-LD */ }
  return {
    url: location.href,
    title: T(q('[data-pl=product-title]')) || T(qa('h1').find((h) => !/aliexpress|AI overview/i.test(h.innerText))),
    price: price ? { current: T(q('[class*="price-default--current"]', price)), discount: T(q('[class*="price-default--discount"]', price)), lowest30d: T(q('[class*="price--lastOrigin"]')), lowestLabel: T(q('[class*="price--last--"]')) } : null,
    body,
    props,
    aiOverview: aiRoot ? { disclaimer: T(q('[class*="seo-sellpoints--terms"]', aiRoot)), bullets: qa('li', aiRoot).map(T), hasMore: !!qa('button', aiRoot).find((b) => /view more/i.test(b.innerText)) } : null,
    spec: { text: T(nav('nav-specification')), rows: qa('#nav-specification [class*="specification--prop"]').map((r) => ({ name: T(q('[class*="specification--title"]', r)), value: T(q('[class*="specification--desc"]', r)) })), links: qa('#nav-specification a[href]').map((a) => ({ text: T(a), href: a.href })).slice(0, 10), hasMore: !!qa('#nav-specification button').find((b) => /view more/i.test(b.innerText)) },
    description: { text: T(nav('nav-description')), sellerText: T(sd), sellerImages: sd ? qa('img', sd).length : 0, iframes: qa('#nav-description iframe').length },
    review: { header: T(q('[class*="title--wrap"]', nav('nav-review') || document)), text: T(nav('nav-review')), hasMore: !!qa('#nav-review button').find((b) => /view more/i.test(b.innerText)), items: qa('#nav-review [class*="list--itemBox"]').map((it) => ({ rating: stars(it), variant: T(q('[class*="list--itemSku"]', it)), text: T(q('[class*="list--itemReview"]', it)), info: T(q('[class*="list--itemInfo"]', it)), helpful: T(q('[class*="list--itemHelpText"]', it)), photos: qa('[class*="list--itemThumbnails"] img', it).length })) },
    seller: store ? { text: T(store), href: store.getAttribute('href') || '', name: T(q('[class*="store-detail--storeName--"]', store)) } : null,
    storeBlock: nav('nav-store') ? { text: T(nav('nav-store')), href: (q('a[href*="/store/"]', nav('nav-store')) || {}).href || '', strongs: qa('strong', nav('nav-store')).map(T) } : null,
    jsonLd: ld,
  };
};

const money = (s) => {
  const m = /([A-Z]{3})\s*([\d.,]+)/.exec(String(s || '').replace(/ /g, ' '));
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(n) ? { currency: m[1], amount: n } : null;
};

function between(text, a, b) {
  const i = text.indexOf(a);
  if (i < 0) return '';
  const j = b ? text.indexOf(b, i + a.length) : -1;
  return text.slice(i, j < 0 ? undefined : j).trim();
}

// Zpracuje jedno čtení stránky (snapshot) na pole dossieru. section = kde na stránce údaj je (pro citaci).
function parse(snap) {
  const body = snap.body;
  const header = body.split(/AI overview of item|Customer Reviews/)[0];
  const out = { title: null, price: null, sold: null, reviews: null, seller: null, store: null, variants: null, aiOverview: null, specifications: null, sellerDescription: null, delivery: null, returns: null, compliance: null };
  if (snap.title) out.title = { value: snap.title, source: { section: 'hlavička produktu (h1 [data-pl=product-title])', quote: clip(snap.title, 200) } };
  if (snap.price && snap.price.current) {
    const m = money(snap.price.current);
    const vat = /Price includes VAT[^\n]*/.exec(body);
    out.price = { ...m, text: snap.price.current, discount: snap.price.discount || null, lowest30d: snap.price.lowest30d ? { text: snap.price.lowest30d, ...money(snap.price.lowest30d) } : null, note: vat ? vat[0].trim() : null, source: { section: 'cenový blok', quote: clip([snap.price.current, snap.price.discount, vat && vat[0]].filter(Boolean).join(' | '), 250) } };
  }
  const sold = /([\d.,+]+)\s+sold/.exec(header);
  if (sold) out.sold = { value: sold[1], source: { section: 'hlavička produktu', quote: sold[0] } };
  const byLine = /by\s*([^\n(]+?)\s*\(\s*(\d(?:\.\d)?)\s*\|\s*([\d.,+]+)\s*sold/.exec(header);
  out.headerSeller = byLine ? { name: byLine[1].trim(), rating: Number(byLine[2]), soldText: byLine[3], source: { section: 'hlavička produktu', quote: byLine[0] } } : null;
  // Hodnocení: „Reviews | 4.3“ + „4 ratings“ v sekci recenzí
  const rh = snap.review.header || '';
  const avg = /Reviews\s*\|\s*([\d.]+)/.exec(rh) || /Reviews\s*\|\s*([\d.]+)/.exec(snap.review.text);
  const cnt = /(\d[\d,]*)\s+ratings?/.exec(snap.review.text);
  const navCnt = /Customer Reviews \((\d[\d,]*)\)/.exec(body);
  out.reviews = { count: cnt ? Number(cnt[1].replace(/,/g, '')) : navCnt ? Number(navCnt[1]) : null, average: avg ? Number(avg[1]) : null, verifiedPurchasesOnly: /All from verified purchases/.test(snap.review.text), source: { section: 'sekce recenzí (#nav-review)', quote: clip(rh || snap.review.text, 160) } };
  // Varianty
  out.variants = snap.props.length ? {
    properties: snap.props.map((p) => {
      const mm = /^(.*?):\s*(.*)$/.exec(p.title);
      return { name: mm ? mm[1].trim() : p.title, selected: mm ? mm[2].trim() : null, options: p.options.map((o) => ({ label: String(o.label || '').trim(), selected: !!o.selected })) };
    }),
    source: { section: 'výběr variant (sku-item--*)', quote: clip(snap.props.map((p) => p.title).join(' | '), 250) },
  } : null;
  if (snap.aiOverview && snap.aiOverview.bullets.length) {
    out.aiOverview = { generatedByPlatform: true, disclaimer: snap.aiOverview.disclaimer, bullets: snap.aiOverview.bullets, viewMoreButtonPresent: snap.aiOverview.hasMore, source: { section: 'AI přehled platformy (seo-sellpoints--*)', quote: clip(snap.aiOverview.disclaimer, 120) } };
  }
  if (snap.spec.rows.length) {
    out.specifications = { rows: snap.spec.rows.filter((r) => r.name), documents: snap.spec.links.filter((l) => /pdf|manual|guide|document/i.test(l.text + l.href)), truncatedBeforeViewMore: snap.spec.hasMore, source: { section: 'Specifications (#nav-specification)', quote: clip(snap.spec.text, 160) } };
  }
  out.sellerDescription = { text: snap.description.sellerText || null, images: snap.description.sellerImages, iframes: snap.description.iframes, source: { section: 'Description (#nav-description / #product-description)', quote: clip(snap.description.text, 160) } };
  // Dodání, vrácení, soulad: z textu nákupního boxu
  const ship = between(body, 'Service commitment', 'Security & Privacy');
  if (ship) out.delivery = { text: ship.replace(/\n+/g, ' | '), lines: ship.split('\n').slice(1).filter(Boolean), source: { section: 'nákupní box (Service commitment)', quote: clip(ship, 220) } };
  const ret = /Return & refund policy[^\n]*/.exec(body);
  if (ret) out.returns = { label: ret[0].trim(), detail: null, source: { section: 'nákupní box (Return & refund policy)', quote: ret[0].trim() } };
  const comp = between(body, 'Additional regulatory information', 'Product compliance information');
  const soldBy = /Sold by ([^\n]*?)(?:, processed by ([^\n.]*?))?\.?(?:\s*Logistics by ([^\n.]*))?\.?\n/.exec(comp + '\n');
  if (comp) out.compliance = { regulatoryText: comp, soldBy: soldBy ? soldBy[1].replace(/\.$/, '') : null, processedBy: soldBy && soldBy[2] ? soldBy[2] : null, logisticsBy: soldBy && soldBy[3] ? soldBy[3] : null, source: { section: 'Additional regulatory information', quote: clip(comp.split('\n').slice(-1)[0], 200) } };
  // Prodejce
  if (snap.seller || snap.storeBlock) {
    const typ = snap.seller && /\((Trader|Business|Individual|Non-trader)[^)]*\)/i.exec(snap.seller.text);
    const sid = /store\/(\d+)/.exec((snap.seller && snap.seller.href) || (snap.storeBlock && snap.storeBlock.href) || '');
    const fb = snap.storeBlock && /([\d.]+)%\s*Positive Feedback/.exec(snap.storeBlock.text);
    const fol = snap.storeBlock && /([\d,]+)\s*Followers/.exec(snap.storeBlock.text);
    const name = (snap.seller && snap.seller.name) || (snap.storeBlock && /^(.+?)\n/.exec(snap.storeBlock.text) || [])[1] || null;
    out.seller = {
      name, type: typ ? typ[1] : null, storeId: sid ? sid[1] : null,
      storeUrl: sid ? 'https://www.aliexpress.com/store/' + sid[1] : null,
      positiveFeedbackPct: fb ? Number(fb[1]) : null, followers: fol ? Number(fol[1].replace(/,/g, '')) : null,
      source: { section: 'Sold By (store-detail--*) a blok obchodu (#nav-store)', quote: clip(((snap.seller && snap.seller.text) || '') + ' || ' + ((snap.storeBlock && snap.storeBlock.text) || '').split('\n').slice(0, 2).join(' '), 250) },
    };
  }
  return out;
}

function parseReviews(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const m = /^(.*?)\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*$/.exec(it.info || '');
    const rec = { rating: it.rating || null, text: it.text || null, author: m ? m[1].trim() : (it.info || null), date: m ? m[2] : null, variant: it.variant || null, helpful: it.helpful || null, photos: it.photos || 0 };
    const key = [rec.author, rec.date, rec.variant, rec.text].join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

// Pomalu sjede stránku dolů, aby se dokreslily líně načítané sekce.
async function scrollThrough(session, steps = 8) {
  for (let i = 0; i < steps; i++) { await session.page.mouse.wheel(0, 1100); await session.sleep(450); }
  await session.page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

async function collect(session, trail, opts = {}) {
  const { page, sleep } = session;
  const o = { maxVariantClicks: 10, maxReviewScrolls: 8, ...opts };
  // Před každým krokem, který by klikal, se ověří, že stránku nepřekrývá výzva k ověření. Když ano, nic se neklikne a zapíše se kdy a proč.
  const canInteract = async (stage) => {
    if (trail.challenge) { trail.act(stage, false, 'přeskočeno: stránku překrývá výzva k ověření'); return false; }
    const ch = await detectChallenge(page);
    if (ch) {
      trail.challenge = { ...ch, firstSeenBefore: stage, tMs: Date.now() - trail.t0 };
      trail.gap('proklikávání (View more, varianty, okna s podmínkami)', 'výzva k ověření (' + (ch.vendor || 'CAPTCHA') + ') překryla stránku před krokem „' + stage + '“; nahlášeno, neobcházeno');
      trail.act(stage, false, 'přeskočeno: výzva k ověření');
      return false;
    }
    return true;
  };
  const afterLoad = await detectChallenge(page);
  if (afterLoad) trail.challenge = { ...afterLoad, firstSeenBefore: 'po načtení stránky (před posunem)', tMs: Date.now() - trail.t0 };
  await scrollThrough(session);
  if (!trail.challenge) { const ch = await detectChallenge(page); if (ch) trail.challenge = { ...ch, firstSeenBefore: 'po posunu stránkou', tMs: Date.now() - trail.t0 }; }
  let snap = await page.evaluate(SNAPSHOT);
  trail.evidenceFor('snapshot-body', 'dom', snap.body);
  if (!trail.challenge) await declineCookies(page, trail);

  // 1) AI přehled: „View More“ rozbalí zbylé body
  if (snap.aiOverview && snap.aiOverview.hasMore && await canInteract('AI přehled: View More')) {
    const ok = await clickByText(page, '[class*="seo-sellpoints--btnWrap"]', /view more/i);
    trail.act('AI přehled: View More', ok);
    if (ok) await sleep(600);
  }
  // 2) Specifikace: „View more“ (může otevřít okno se všemi řádky)
  if (snap.spec.hasMore && await canInteract('Specifications: View more')) {
    const ok = await clickByText(page, '#nav-specification', /view more/i);
    await sleep(900);
    const ov = ok ? await readOverlay(page) : null;
    trail.act('Specifications: View more', ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'bez okna');
    if (ov) { trail.evidenceFor('specifications-overlay', 'dom-overlay', ov.text); snap.specOverlay = ov.text; await closeOverlay(page); await sleep(400); }
  }
  // 3) Popis prodejce: už je v DOM (#product-description), případně v iframe (jen čtení)
  for (const f of page.frames().filter((x) => x !== page.mainFrame())) {
    try {
      const t = await f.evaluate(() => (document.body ? document.body.innerText.trim() : ''));
      if (t && t.length > 30 && /description|product|detail/i.test(f.url() + t.slice(0, 200)) && !/punish|captcha/i.test(f.url())) { snap.frameDescription = (snap.frameDescription || '') + t + '\n'; trail.evidenceFor('description-iframe', 'dom-iframe', t); }
    } catch (e) { /* cizí iframe */ }
  }
  // 4) Recenze: View more → okno/šuplík, v něm se rolováním dotahují další
  let reviewItems = snap.review.items;
  if (snap.review.hasMore && await canInteract('Reviews: View more')) {
    const ok = await clickByText(page, '#nav-review', /view more/i);
    await sleep(1200);
    const urlAfter = page.url();
    const ov = ok ? await readOverlay(page) : null;
    trail.act('Reviews: View more', ok, ov ? 'okno ' + ov.text.length + ' znaků' : (urlAfter !== snap.url ? 'navigace na ' + urlAfter : 'beze změny'));
    if (ov) {
      trail.evidenceFor('reviews-overlay', 'dom-overlay', ov.text);
      let prev = -1;
      for (let i = 0; i < o.maxReviewScrolls; i++) {
        const n = await page.evaluate(() => { const els = [...document.querySelectorAll('[class*="list--itemBox"]')]; const last = els[els.length - 1]; if (last) last.scrollIntoView({ block: 'end' }); return els.length; });
        await sleep(700);
        if (n === prev) break;
        prev = n;
      }
      const all = await page.evaluate(() => [...document.querySelectorAll('[class*="list--itemBox"]')].map((it) => {
        const T = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : '');
        const q = (s) => it.querySelector(s);
        return { rating: it.querySelectorAll('[class*="comet-icon-starreviewfilled"]').length + 0.5 * it.querySelectorAll('[class*="comet-icon-starhalfreview"]').length, variant: T(q('[class*="list--itemSku"]')), text: T(q('[class*="list--itemReview"]')), info: T(q('[class*="list--itemInfo"]')), helpful: T(q('[class*="list--itemHelpText"]')), photos: it.querySelectorAll('[class*="list--itemThumbnails"] img').length };
      }));
      reviewItems = reviewItems.concat(all);
      await closeOverlay(page);
      await sleep(400);
    }
  }
  // 5) Varianty: u každé vlastnosti se zkusí kliknout na ostatní možnosti a zaznamená se cena (jen změna stavu stránky, nic se nekupuje)
  const variantPrices = [];
  let clicks = 0;
  const multi = snap.props.some((p) => p.options.length > 1);
  if (multi && await canInteract('Varianty')) {
    for (let pi = 0; pi < snap.props.length && clicks < o.maxVariantClicks; pi++) {
      const p = snap.props[pi];
      if (p.options.length < 2) continue;
      for (let oi = 0; oi < p.options.length && clicks < o.maxVariantClicks; oi++) {
        if (trail.challenge) break;
        clicks++;
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
            return { price: T(document.querySelector('[class*="price-default--current"]')), props: [...document.querySelectorAll('[class*="sku-item--property"]')].map((x) => T(x.querySelector('[class*="sku-item--title"]'))), avail: (document.body.innerText.match(/(\d+)\s+available|Max\. \d+ pcs\/shopper|Out of stock|Sold out/i) || [''])[0] };
          });
          variantPrices.push({ property: p.title.split(':')[0], optionIndex: oi, option: p.options[oi].label, selectedAfterClick: after.props, price: after.price, availability: after.avail || null });
        } catch (e) {
          trail.gap('klik na variantu ' + p.title.split(':')[0] + ' #' + (oi + 1), clip(String(e.message).split('\n')[0], 100));
          if (await detectChallenge(page)) { trail.challenge = trail.challenge || { vendor: 'AliExpress baxia (reCAPTCHA)', evidence: 'klik byl zablokován překryvem', firstSeenBefore: 'klik na variantu', tMs: Date.now() - trail.t0 }; break; }
        }
      }
    }
    if (clicks) trail.act('Varianty: ' + clicks + ' kliků', variantPrices.length > 0, variantPrices.length + ' cen zaznamenáno');
  } else if (!multi) trail.act('Varianty: žádná vlastnost nemá víc než jednu možnost', true);
  // 6) Dodání a vrácení: odkazy v nákupním boxu otevírají okno s podmínkami
  for (const [label, scope, re] of [['Return & refund policy', '[class*="shipping--wrap"], [class*="shipping--item"]', /Return & refund policy/i], ['Delivery detail', '[class*="dynamic-shipping"]', /Delivery/i]]) {
    if (!(await canInteract('klik: ' + label))) continue;
    const ok = await clickByText(page, scope, re);
    await sleep(900);
    const ov = ok ? await readOverlay(page) : null;
    trail.act('klik: ' + label, ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'bez okna');
    if (ov) { trail.evidenceFor('overlay-' + label, 'dom-overlay', ov.text); snap['overlay_' + label] = ov.text; await closeOverlay(page); await sleep(300); }
  }
  // 7) Prodejce / soulad: „Product compliance information“ a „(Trader)“ ukazují údaje obchodníka, pokud je platforma zveřejňuje
  for (const [label, re] of [['Product compliance information', /Product compliance information/i], ['Trader', /^\(?Trader\)?$/i]]) {
    if (!(await canInteract('klik: ' + label))) continue;
    const ok = await clickByText(page, null, re);
    await sleep(900);
    const ov = ok ? await readOverlay(page) : null;
    trail.act('klik: ' + label, ok, ov ? 'okno ' + ov.text.length + ' znaků' : 'bez okna');
    if (ov) { trail.evidenceFor('overlay-' + label, 'dom-overlay', ov.text); snap['overlay_' + label] = ov.text; await closeOverlay(page); await sleep(300); }
  }
  // Konečný snapshot po rozbalení
  const fin = await page.evaluate(SNAPSHOT);
  const overlays = Object.keys(snap).filter((k) => k.startsWith('overlay_')).reduce((a, k) => { a[k.slice(8)] = snap[k]; return a; }, {});
  const merged = { ...fin, specOverlay: snap.specOverlay, frameDescription: snap.frameDescription, overlays, reviewItemsAll: reviewItems.concat(fin.review.items) };
  // Co zůstalo sbalené, protože se nedalo kliknout
  if (fin.spec.hasMore && !snap.specOverlay) trail.gap('Specifications: řádky za „View more“', trail.challenge ? 'nerozbaleno (výzva k ověření)' : 'okno se nepodařilo otevřít');
  if (fin.review.hasMore && reviewItems.length === snap.review.items.length) trail.gap('Reviews: recenze za „View more“', trail.challenge ? 'nerozbaleno (výzva k ověření)' : 'okno se nepodařilo otevřít');
  trail.evidenceFor('snapshot-final', 'dom', fin.body);
  return { snap: merged, variantPrices };
}

// Z jedné stránky obchodu (už načtené a prověřené na blokaci) vytáhne údaje o obchodu.
const STORE_SNAPSHOT = () => {
  const norm = (s) => String(s || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: document.title, body: norm(document.body ? document.body.innerText : ''), links: [...document.querySelectorAll('a[href]')].map((a) => ({ text: norm(a.innerText).slice(0, 60), href: a.href })).filter((l) => /feedback|store-info|company|certif|policy|contactInfo|about/i.test(l.href + l.text)).slice(0, 15) };
};

function parseStore(s) {
  const t = s.body;
  const pick = (re) => { const m = re.exec(t); return m ? m[1].trim() : null; };
  return {
    positiveFeedback: pick(/([\d.]+)%\s*positive (?:feedback|reviews)/i), followers: pick(/([\d.,]+\s?[KkMm]?)\s*\n?\s*followers/i), openSince: pick(/(?:Open since|Opened|Store age|Since)[:\s]+([^\n]{3,30})/i),
    ratingLine: pick(/(Item as [Dd]escribed[^\n]*|Communication[^\n]*|Shipping [Ss]peed[^\n]*)/), links: s.links,
    source: { section: 'stránka obchodu', quote: clip(t, 200) },
  };
}

module.exports = { collect, parse, parseReviews, parseStore, STORE_SNAPSHOT, SNAPSHOT, between, money, fromLabeledRow, fromFreeText };
