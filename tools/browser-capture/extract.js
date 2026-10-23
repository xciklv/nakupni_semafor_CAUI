// Čtení stránky: vkládá se do stránky (chrome.scripting.executeScript, svět ISOLATED) před každým čtením, proto je tu jen `function`
// (`const`/`let` na nejvyšší úrovni by při druhém vložení do téže karty spadly na „already declared“). Jen čte DOM, nic neklikne ani nerozbaluje.
// Čisté funkce cleanUrl, cleanImageUrl, trimToSentences a dropPageChrome se testují v tests/browser-capture.test.js (module.exports na konci).

// Allowlist: z adresy zůstane jen host, cesta a parametry, které určují nabídku nebo variantu (např. Allegro offerId, Temu goods_id).
// Všechno ostatní se zahodí, i neznámé parametry: sledovací (fbclid, msclkid, gclid, utm_*), relace a osobní (token, sid, e-mail), fragment
// a přihlašovací údaje. Identifikátory v cestě (/item/123.html, /dp/ASIN) zůstávají. Jen pro odkaz na nabídku; adresy obrázků viz cleanImageUrl.
function cleanUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  let u;
  try { u = new URL(raw); } catch (e) { return raw; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
  const allowed = /^(offerId|id|p|pid|product|sku|item|product_id|productId|id_product|goods_id|item_id|itemId|sku_id|variant|route)$/i;
  const kept = u.search.replace(/^\?/, '').split('&').filter((p) => p && allowed.test(p.split('=')[0]));
  return u.origin + u.pathname + (kept.length ? '?' + kept.join('&') : '');
}

// Adresa obrázku: odstraní jen známé sledovací parametry, fragment a přihlašovací údaje. Ostatní zůstane, protože u CDN je v query podpis,
// rozměr nebo samotný obrázek (?v=, ?w=&s=, imageView2/…, ?file=a.jpg); allowlist by obrázky rozbil nebo sloučil.
function cleanImageUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  let u;
  try { u = new URL(raw); } catch (e) { return raw; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
  const tracking = /^(utm_.*|gclid|dclid|gbraid|wbraid|gad_source|fbclid|msclkid|yclid|igshid|mc_eid|mc_cid|_gl|pvid|scm|spm|algo_pvid|algo_exp_id|pdp_ext_f|pdp_npi|curPageLogUid|share_token)$/i;
  const kept = u.search.replace(/^\?/, '').split('&').filter((p) => p && !tracking.test(p.split('=')[0]));
  return u.origin + u.pathname + (kept.length ? '?' + kept.join('&') : '');
}

// Zkrátí text na nejvýš `max` znaků na hranici věty (jinak řádku, jinak slova), takže nekončí uprostřed věty.
function trimToSentences(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const probe = s.slice(0, max + 1);
  let best = 0;
  const re = /[.!?…](?=\s|$)/g;
  let m;
  while ((m = re.exec(probe)) !== null) if (m.index + 1 <= max) best = Math.max(best, m.index + 1);
  const nl = probe.lastIndexOf('\n');
  if (nl > best) best = nl;
  if (best >= max * 0.5) return s.slice(0, best).trimEnd();
  const ws = probe.search(/\s\S*$/);
  if (ws > 0) return s.slice(0, ws).trimEnd();
  return s.slice(0, max);
}

// Odstraní z textu stránky hlavičku a menu: vše před prvním výskytem titulku nabídky a řádky s menu a účtem. Jméno přihlášeného
// uživatele (např. „Martina“ vedle „Můj účet“) tak z prohlížeče neodchází. Když se titulek v textu nenajde, odstraní se jen rozpoznané řádky.
function dropPageChrome(text, title) {
  let s = String(text == null ? '' : text);
  if (!s) return '';
  const t = String(title == null ? '' : title).trim();
  let anchored = false;
  if (t) {
    const parts = t.split(/\s+[|\-–—·:]+\s+/).map((x) => x.trim()).filter((x) => x.length >= 10 && x !== t);
    const longest = parts.slice().sort((a, b) => b.length - a.length)[0];
    const candidates = [t].concat(parts.slice(0, 1), longest ? [longest] : []).filter((c) => c.length >= 4);
    for (const c of candidates) {
      const i = s.indexOf(c);
      if (i >= 0) { s = s.slice(i); anchored = true; break; }
    }
  }
  const words = 'můj účet|moje konto|moje allegro|moje objednávky|účet|my account|your account|account|my orders|orders|sign in|log in|login|sign up|register|log out|sign out|odhlásit se|odhlásit|přihlásit se|přihlášení|registrace|zaregistrovat se|zaloguj się|nákupní košík|košík|shopping cart|cart|koszyk|oblíbené|wishlist|favorites|menu|kategorie|všechny kategorie|categories|pomoc|help|zákaznická podpora|customer service';
  const menuLine = new RegExp('^(' + words + ')$', 'i');
  const hasWord = new RegExp('(^|[\\s/|·•›])(' + words + ')($|[\\s/|·•›])', 'i');
  const greeting = /^(ahoj|dobrý den|dobrý večer|dobré ráno|vítejte|vítej|hello|hi|welcome|witaj|cześć)\s*[,!]\s*\S[^.]{0,40}$/i;
  const nameLine = /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽŁŚŹŻ][\p{L}'.-]{1,20}(\s+[\p{L}'.-]{1,20})?$/u;
  const out = [];
  let head = 0; // počet řádků hlavičky, ve kterých se ještě hledá jméno nad „Můj účet“ (jen bez titulku jako opory)
  for (const line of s.split('\n')) {
    const l = line.trim();
    const isChrome = l.length > 0 && l.length <= 120 && (menuLine.test(l) || greeting.test(l) || (l.split(/\s[/|·•›]\s/).length >= 3 && hasWord.test(l)));
    if (isChrome) {
      const prev = out.length ? out[out.length - 1].trim() : '';
      if (!anchored && head < 15 && prev && prev.length <= 30 && nameLine.test(prev) && !menuLine.test(prev)) out.pop();
      head++;
      continue;
    }
    out.push(line);
    head++;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Čte aktuální stránku. Vrací { odkaz, titulek, text, obrazky, jsonld, vlozena, diagnostika }; obrázky a JSON-LD jdou do kontroly
// jako samostatná pole, ne v textu.
function nakupniKontrolaExtract() {
  const LIMIT = 20000;
  const LD_LIMIT = 4000;
  const MAX_OBRAZKU = 8;
  const MAX_OBRAZEK_URL = 500;
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const diag = { sirkaTextuPuvodni: 0, sirkaTextuPoOdstraneni: 0, jsonLd: 0, vlozenaData: [], obrazkuNalezeno: 0 };

  const odkaz = cleanUrl(location.href);
  const titulek = document.title || '';

  // JSON-LD (Product, AggregateRating, Review...) – už je v DOM. Zhutní se (bez mezer) a vezme se po celých blocích do 4 000 znaků.
  const jsonLd = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const t = (s.textContent || '').trim();
    if (!t) return;
    let c = t;
    try { c = JSON.stringify(JSON.parse(t)); } catch (e) { /* neplatný JSON zůstane, jak je */ }
    jsonLd.push(c);
  });
  diag.jsonLd = jsonLd.length;
  const ldPart = [];
  let ldLen = 0;
  jsonLd.forEach((c) => {
    const add = (ldPart.length ? 1 : 0) + c.length;
    if (ldLen + add <= LD_LIMIT) { ldPart.push(c); ldLen += add; }
  });
  const jsonld = (ldPart.length ? ldPart.join('\n') : (jsonLd[0] || '')).slice(0, LD_LIMIT);

  // Vložená data (Next.js, window.runParams apod.): jen nalezení v <script> a velikost.
  const vlozena = [];
  document.querySelectorAll('script:not([src])').forEach((s) => {
    const t = s.textContent || '';
    if (t.length < 200) return;
    let jmeno = null;
    if (s.id === '__NEXT_DATA__') jmeno = '__NEXT_DATA__';
    else if (/window\.runParams\s*=/.test(t)) jmeno = 'window.runParams';
    else if (/_d_c_\.DCData|window\._d_c_/.test(t)) jmeno = 'window._d_c_';
    else if (/__INITIAL_STATE__|__PRELOADED_STATE__/.test(t)) jmeno = '__INITIAL_STATE__';
    else if (s.type === 'application/json' && /price|rating|review|product|offer/i.test(t)) jmeno = 'application/json#' + (s.id || '');
    if (jmeno) { vlozena.push({ jmeno, delka: t.length }); diag.vlozenaData.push(jmeno + ' (' + t.length + ')'); }
  });

  // Obrázky produktu: og:image + JSON-LD + největší <img> v dokumentu. Jen https, bez sledovacích parametrů, adresa do 500 znaků, nejvýše 8.
  const kandidati = new Map();
  const pridej = (u, skore) => {
    if (!u || /^data:|\.svg(\?|$)|sprite|logo|icon|avatar|pixel|1x1/i.test(u)) return;
    try { u = new URL(u, location.href).href; } catch (e) { return; }
    if (!/^https:/.test(u)) return;
    u = cleanImageUrl(u.replace(/_\d+x\d+[^/]*$/, '')); // AliExpress: varianty téhož obrázku (…jpg_960x960q75.jpg_.avif) sloučit na originál
    if (u.length > MAX_OBRAZEK_URL) return;
    if (!kandidati.has(u) || kandidati.get(u) < skore) kandidati.set(u, skore);
  };
  document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach((m) => pridej(m.content, 1e9));
  jsonLd.forEach((t) => { (t.match(/"image"\s*:\s*(\[[^\]]*\]|"[^"]+")/g) || []).forEach((m) => (m.match(/https?:[^"\\]+/g) || []).forEach((u) => pridej(u, 9e8))); });
  document.querySelectorAll('img').forEach((im) => {
    const w = im.naturalWidth || im.width || 0, h = im.naturalHeight || im.height || 0;
    if (w < 200 || h < 200) return;
    pridej(im.currentSrc || im.src, w * h);
  });
  diag.obrazkuNalezeno = kandidati.size;
  const obrazky = [...kandidati.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_OBRAZKU).map((e) => e[0]);

  // Viditelný text bez hlavičky a menu (včetně jména přihlášeného účtu).
  const surovy = clean(document.body ? document.body.innerText : '');
  diag.sirkaTextuPuvodni = surovy.length;
  const bezMenu = dropPageChrome(surovy, titulek);
  diag.sirkaTextuPoOdstraneni = bezMenu.length;

  const hlava = 'Zdroj: sběr z prohlížeče uživatele (stránku otevřel a prošel člověk).\nOdkaz: ' + odkaz + '\nTitulek: ' + titulek + '\n\n[Text stránky]\n';
  const text = hlava + trimToSentences(bezMenu, Math.max(2000, LIMIT - hlava.length));
  return { odkaz, titulek, text: trimToSentences(text, LIMIT), obrazky, jsonld, vlozena, diagnostika: diag };
}

if (typeof module !== 'undefined') module.exports = { cleanUrl, cleanImageUrl, trimToSentences, dropPageChrome, nakupniKontrolaExtract };
