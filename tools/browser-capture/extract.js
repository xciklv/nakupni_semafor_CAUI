// Spouští se ve stránce (chrome.scripting.executeScript, svět ISOLATED). Jen čte DOM, nic neklikne ani nerozbaluje.
// Vrací { odkaz, titulek, text, obrazky, vlozena, diagnostika }.
function nakupniKontrolaExtract() {
  const LIMIT = 20000;
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Ořez na celé věty (nebo aspoň řádky), aby text nekončil uprostřed slova.
  const orez = (s, max) => {
    if (s.length <= max) return s;
    const kus = s.slice(0, max);
    const i = Math.max(kus.lastIndexOf('. '), kus.lastIndexOf('.\n'), kus.lastIndexOf('! '), kus.lastIndexOf('? '), kus.lastIndexOf('\n'));
    return i > max * 0.5 ? kus.slice(0, i + 1) : kus;
  };
  const diag = { sirkaTextuPuvodni: 0, jsonLd: 0, vlozenaData: [], obrazkuNalezeno: 0 };

  const odkaz = location.href;
  const titulek = document.title || '';

  // JSON-LD (Product, AggregateRating, Review...) – už je v DOM.
  const jsonLd = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    const t = (s.textContent || '').trim();
    if (t) jsonLd.push(t.length > 6000 ? t.slice(0, 6000) : t);
  });
  diag.jsonLd = jsonLd.length;

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

  // Obrázky produktu: og:image + JSON-LD + největší <img> v dokumentu, max 8.
  const kandidati = new Map();
  const pridej = (u, skore) => {
    if (!u || /^data:|\.svg(\?|$)|sprite|logo|icon|avatar|pixel|1x1/i.test(u)) return;
    try { u = new URL(u, location.href).href; } catch (e) { return; }
    if (!/^https?:/.test(u)) return;
    u = u.replace(/_\d+x\d+[^/]*$/, ''); // AliExpress: varianty téhož obrázku (…jpg_960x960q75.jpg_.avif) sloučit na originál
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
  const obrazky = [...kandidati.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);

  // Viditelný text.
  const surovy = clean(document.body ? document.body.innerText : '');
  diag.sirkaTextuPuvodni = surovy.length;

  // Skládání: hlavička, JSON-LD a obrázky mají rezervu, zbytek dostane text stránky.
  const hlavicka = 'Zdroj: sběr z prohlížeče uživatele (stránku otevřel a prošel člověk).\nOdkaz: ' + odkaz + '\nTitulek: ' + titulek + '\n';
  const ld = jsonLd.length ? '\n[JSON-LD]\n' + orez(jsonLd.join('\n'), 4000) + '\n' : '';
  const img = obrazky.length ? '\n[Obrázky produktu]\n' + obrazky.join('\n') + '\n' : '';
  const hlava = hlavicka + ld + img + '\n[Text stránky]\n';
  const text = hlava + orez(surovy, Math.max(2000, LIMIT - hlava.length));
  return { odkaz, titulek, text: orez(text, LIMIT), obrazky, vlozena, diagnostika: diag };
}
