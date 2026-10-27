if (typeof require !== 'undefined' && typeof normalizeExtraction === 'undefined') { var { normalizeExtraction } = require('./llm'); }

// Dossier = jediná kanonická evidence o nabídce. Vzniká ze čtečky stránek (tvar nakupni-semafor/dossier@0-spike)
// nebo se skládá z extrakce vloženého textu a screenshotů; všechny moduly kontroly čtou jen jeho.
const DOS_SCHEMA_PREFIX = 'nakupni-semafor/dossier@';
const DOS_PROMPT_MAX_DEFAULT = 12000;
const DOS_PROMPT_MIN = 200;
const DOS_MEZERY_SHARE = 0.15; // část rozpory vyhrazená mezerám, které se do promptu vejdou vždy
const DOS_POPIS_SHARE = 0.4;
const DOS_LINE_MAX = 400;
const DOS_REVIEW_TEXT_MAX = 600;
const DOS_GAP_MAX = 160;
const DOS_GAPS_MAX = 12;
const DOS_IDENT_MAX = 10;
const DOS_IDENT_KEEP = 20;
const DOS_IMAGES_MAX = 20;
const DOS_IMAGE_URL_MAX = 500;
const DOS_JSONLD_MAX = 4000; // JSON-LD z rozšíření v prohlížeči (input.jsonld) jde do tvrzení jen jako text
const DOS_JSONLD_PREFIX = 'JSON-LD: ';
const DOS_BRAND_ROW_RE = /^(brand|brand name|značka|znacka)$/i;
const DOS_MODEL_ROW_RE = /^(model|model number|číslo modelu|cislo modelu)$/i;
const DOS_CERT_ROW_RE = /certif|conformity|prohlášení o shodě|prohlaseni o shode/i;
const DOS_NEGATIVE_RE = /^(none|no|n|ne|nic|-|n\/a)$/i;
const DOS_CERT_CLAIM_RE = /\bCE\b|RoHS|\bFCC\b/;
// Mezera, kvůli které nelze o CE a GPSR říct „nabídka o něm mlčí“: chybí nebo je zkrácená specifikace, popis, AI přehled, registrační údaje prodejce nebo celá stránka.
const DOS_SAFETY_GAP_RE = /specifikac|specification|popis|description|přehled|prehled|registra|celá stránka|cela stranka/i;
const DOS_CERT_SENTENCE_MAX = 200;
const DOS_RATING_PER_PERCENT = 20; // 100 % kladných hodnocení = 5 hvězd (škála extrakce 0 až 5)

const dosStr = (v) => {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && !Array.isArray(v)) return dosStr(v.value);
  return null;
};
const dosNum = (v) => {
  if (typeof v === 'string' && /^[-+]?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const dosNonNeg = (v) => { const n = dosNum(v); return n != null && n >= 0 ? n : null; };
const dosArr = (v) => (Array.isArray(v) ? v : []);
const dosObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const dosHttps = (v) => { const t = dosStr(v); return t && t.startsWith('https://') ? t : null; };
const dosRound = (n, p) => Math.round(n * p) / p;

function dosEmpty() {
  return {
    zdroj: 'dossier', platforma: null, nazev: null, cena: { castka: null, mena: null }, varianty: [], specifikace: [], tvrzeni: [], aiPrehled: [], popis: null,
    recenze: { pocet: null, prumer: null, uplne: false, polozky: [] },
    prodejce: { nazev: null, typ: null, hodnoceniProc: null, sledujici: null, odkaz: null },
    identifikatory: [], obrazky: [], mezery: [], blokace: null,
  };
}

function dosImageUrls(raw, ld) {
  const found = [];
  const take = (v) => {
    if (Array.isArray(v)) v.forEach(take);
    else if (v && typeof v === 'object') take(v.url || v.contentUrl);
    else if (typeof v === 'string') found.push(v.trim().startsWith('//') ? 'https:' + v.trim() : v.trim());
  };
  take(ld.image);
  take(dosObj(raw.images).urls);
  const seen = new Set();
  return found.filter((u) => u.startsWith('https://') && !seen.has(u) && seen.add(u)).slice(0, DOS_IMAGES_MAX).map((url) => ({ url }));
}

function dosReview(r) {
  const o = dosObj(r);
  const text = dosStr(o.text);
  const rating = dosNum(o.rating);
  return { hodnoceni: rating != null && rating >= 0 && rating <= 5 ? rating : null, text: text || '', datum: dosStr(o.date), varianta: dosStr(o.variant) };
}

function dosVariants(raw) {
  return dosArr(dosObj(raw.variants).properties).map((p) => {
    const o = dosObj(p);
    const nazev = dosStr(o.name);
    if (!nazev) return null;
    const options = dosArr(o.options).map((x) => dosObj(x));
    const chosen = dosStr(o.selected) || dosStr((options.find((x) => x.selected === true) || {}).label);
    return { nazev, vybrano: chosen, moznosti: options.map((x) => dosStr(x.label)).filter(Boolean) };
  }).filter(Boolean);
}

function dosSpecs(raw, brand) {
  const rows = dosArr(dosObj(raw.specifications).rows).map((r) => ({ nazev: dosStr(dosObj(r).name), hodnota: dosStr(dosObj(r).value) })).filter((r) => r.nazev && r.hodnota);
  // Značka z JSON-LD nemá v dossieru vlastní pole, proto jde mezi specifikace (jen když tam ještě není).
  if (brand && !rows.some((r) => DOS_BRAND_ROW_RE.test(r.nazev) || r.hodnota.toLowerCase() === brand.toLowerCase())) rows.push({ nazev: 'Brand', hodnota: brand });
  return rows;
}

function dosDescription(raw) {
  const desc = dosObj(raw.description);
  const parts = [dosStr(dosObj(desc.sellerDescription).text), dosStr(dosObj(desc.sellerDescription).frameText), dosStr(dosObj(desc.generic).text)].filter(Boolean);
  return parts.length ? parts.filter((t, i) => parts.indexOf(t) === i).join('\n') : null;
}

// Přijímá tvar nakupni-semafor/dossier@0-spike z čtečky stránek. Blokovaná stránka je platný dossier s vyplněným `blokace` a bez dat.
function normalizeDossier(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, dossier: null, duvod: 'dossier není objekt' };
  if (raw.schema !== undefined && !(typeof raw.schema === 'string' && raw.schema.startsWith(DOS_SCHEMA_PREFIX))) return { ok: false, dossier: null, duvod: 'neznámý tvar dossieru' };
  const blocked = raw.blocked && typeof raw.blocked === 'object' && !Array.isArray(raw.blocked) ? raw.blocked : null;
  if (raw.ok === false && !blocked) return { ok: false, dossier: null, duvod: 'sběr dat selhal' };
  const d = dosEmpty();
  d.platforma = dosStr(raw.platform);
  d.mezery = dosArr(raw.gaps).map((g) => ({ co: dosStr(dosObj(g).what), proc: dosStr(dosObj(g).why) })).filter((g) => g.co && g.proc);
  if (blocked) {
    d.blokace = { druh: dosStr(blocked.kind) || 'neznámá', dodavatel: dosStr(blocked.vendor) };
    return { ok: true, dossier: d };
  }
  const ld = dosObj(dosObj(raw.structuredData).jsonLd);
  const offer = dosObj([].concat(ld.offers)[0]);
  d.nazev = dosStr(raw.title) || dosStr(ld.name);
  const price = dosObj(raw.price);
  d.cena = { castka: dosNonNeg(price.amount != null ? price.amount : offer.price), mena: dosStr(price.currency) || dosStr(offer.priceCurrency) };
  d.varianty = dosVariants(raw);
  d.specifikace = dosSpecs(raw, dosStr(raw.brand) || dosStr(dosObj(ld.brand).name) || dosStr(ld.brand));
  d.aiPrehled = dosArr(dosObj(dosObj(raw.description).aiOverview).bullets).map(dosStr).filter(Boolean);
  d.popis = dosDescription(raw);
  const rev = dosObj(raw.reviews);
  const polozky = dosArr(rev.items).map(dosReview).filter((r) => r.text || r.hodnoceni != null);
  const avg = dosNum(rev.average);
  d.recenze = { pocet: dosNonNeg(rev.count), prumer: avg != null && avg >= 0 && avg <= 5 ? avg : null, uplne: rev.complete === true, polozky };
  const s = dosObj(raw.seller);
  d.prodejce = {
    nazev: dosStr(s.name) || dosStr(dosObj(raw.headerSeller).name), typ: dosStr(s.type),
    hodnoceniProc: dosNonNeg(s.positiveFeedbackPct), sledujici: dosNonNeg(s.followers), odkaz: dosHttps(s.storeUrl),
  };
  const seenId = new Set();
  d.identifikatory = dosArr(raw.identifiers).map((i) => ({ hodnota: dosStr(dosObj(i).value), druh: dosStr(dosObj(i).type) || 'neznamy' })).filter((i) => {
    if (!i.hodnota) return false;
    const k = i.druh + ':' + i.hodnota;
    return !seenId.has(k) && seenId.add(k);
  }).slice(0, DOS_IDENT_KEEP);
  d.obrazky = dosImageUrls(raw, ld);
  return { ok: true, dossier: d };
}

// true, když dossier hlásí mezeru ve specifikaci, popisu, AI přehledu, registračních údajích nebo na celé stránce (čtení pro bezpečnostní kontrolu není úplné).
function dossierGapsHideSafety(d) {
  const gaps = d && typeof d === 'object' && Array.isArray(d.mezery) ? d.mezery : [];
  return gaps.some((m) => m && typeof m.co === 'string' && DOS_SAFETY_GAP_RE.test(m.co));
}

// Věty z popisu a AI přehledu, které uvádějí CE (nebo RoHS, FCC): celý popis se do tvrzení o certifikaci nekopíruje.
function dosCertSentences(d) {
  const texts = [typeof d.popis === 'string' ? d.popis : ''].concat(dosArr(d.aiPrehled).filter((t) => typeof t === 'string'));
  const out = [];
  for (const text of texts) {
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const t = sentence.trim();
      if (t && DOS_CERT_CLAIM_RE.test(t) && !out.includes(t)) out.push(t.length > DOS_CERT_SENTENCE_MAX ? t.slice(0, DOS_CERT_SENTENCE_MAX - 1) + '…' : t);
    }
  }
  return out.slice(0, 5);
}

// Dossier -> ExtractionRecord (tvar výstupu normalizeExtraction), aby offer, seller a safety běžely beze změny. Co dossier neví, je null / [].
function dossierToExtraction(d) {
  const x = dosObj(d);
  const rows = dosArr(x.specifikace);
  const rowValue = (re) => (rows.find((r) => r && typeof r.nazev === 'string' && re.test(r.nazev.trim())) || {}).hodnota;
  const tvrzeni = dosArr(x.tvrzeni).filter((t) => typeof t === 'string');
  const certRows = rows.filter((r) => r && typeof r.nazev === 'string' && typeof r.hodnota === 'string' && DOS_CERT_ROW_RE.test(r.nazev) && !DOS_NEGATIVE_RE.test(r.hodnota.trim()))
    .map((r) => r.nazev + ': ' + r.hodnota);
  const cena = dosObj(x.cena), rec = dosObj(x.recenze), p = dosObj(x.prodejce);
  const polozky = dosArr(rec.polozky);
  const proc = dosNonNeg(p.hodnoceniProc);
  return normalizeExtraction({
    produkt: {
      nazev: x.nazev, znacka: rowValue(DOS_BRAND_ROW_RE), model: rowValue(DOS_MODEL_ROW_RE), cena: cena.castka, mena: cena.mena,
      tvrzene_parametry: tvrzeni, tvrzeni_certifikace: certRows.concat(tvrzeni.filter((t) => DOS_CERT_CLAIM_RE.test(t))).concat(dosCertSentences(x)),
    },
    // Z dossieru složeného z textu se předá všechno, co o prodejci opravdu obsahuje (jen vyplněné údaje; nic se nedomýšlí).
    prodejce: { nazev: p.nazev, hodnoceni: proc != null && proc <= 100 ? dosRound(proc / DOS_RATING_PER_PERCENT, 100) : null, pocet_prodeju: dosNonNeg(p.pocetProdeju), ico: dosStr(p.ico), dic: dosStr(p.dic) },
    recenze: { pocet: rec.pocet, prumer: rec.prumer, vsechny_5_hvezd: rec.uplne === true && polozky.length > 0 ? polozky.every((r) => r && r.hodnoceni === 5) : null },
  });
}

// ExtractionRecord (z textu nebo screenshotu) -> Dossier; `input` je výstup validateInput (z něj platforma marketplace, adresy obrázků a JSON-LD z rozšíření).
function extractionToDossier(x, input) {
  const e = normalizeExtraction(x);
  const p = e.produkt, s = e.prodejce, r = e.recenze;
  const d = dosEmpty();
  const url = dosObj(dosObj(input).url);
  const labels = typeof url.host === 'string' ? url.host.split('.') : [];
  d.zdroj = 'extrakce';
  d.platforma = url.rezim === 'marketplace' && labels.length >= 2 ? labels[labels.length - 2] : null;
  d.nazev = p.nazev;
  d.cena = { castka: p.cena, mena: p.mena };
  d.specifikace = [];
  if (p.znacka) d.specifikace.push({ nazev: 'Značka', hodnota: p.znacka });
  if (p.model) d.specifikace.push({ nazev: 'Model', hodnota: p.model });
  d.tvrzeni = p.tvrzene_parametry.slice();
  const ld = typeof dosObj(input).jsonld === 'string' ? dosObj(input).jsonld.trim().slice(0, DOS_JSONLD_MAX) : '';
  if (ld) d.tvrzeni.push(DOS_JSONLD_PREFIX + ld);
  const seen = new Set();
  d.obrazky = dosArr(dosObj(input).obrazky).map(dosHttps).filter((u) => u && u.length <= DOS_IMAGE_URL_MAX && !seen.has(u) && seen.add(u)).slice(0, DOS_IMAGES_MAX).map((url) => ({ url }));
  d.recenze = { pocet: r.pocet, prumer: r.prumer, uplne: false, polozky: [] };
  d.prodejce = { nazev: s.nazev, typ: null, hodnoceniProc: s.hodnoceni == null ? null : dosRound(s.hodnoceni * DOS_RATING_PER_PERCENT, 10), sledujici: null, odkaz: null, pocetProdeju: s.pocet_prodeju, ico: s.ico, dic: s.dic };
  // Pole z rozšířené extrakce (ean, kod_vyrobce) se přenesou, pokud je extrakce už má.
  if (typeof p.ean === 'string' && p.ean) d.identifikatory.push({ hodnota: p.ean, druh: 'ean' });
  if (typeof p.kod_vyrobce === 'string' && p.kod_vyrobce) d.identifikatory.push({ hodnota: p.kod_vyrobce, druh: 'manufacturer-code' });
  return d;
}

// Kandidáti na EAN/GTIN v textu: souvislé řady přesně 8, 12, 13 nebo 14 číslic (ne část větší řady ani desetinného čísla), bez duplicit.
function identifierCandidates(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const re = /(?<![\d.,])(\d{8}|\d{12,14})(?!\d|[.,]\d)/g;
  let m;
  while ((m = re.exec(text)) && out.length < DOS_IDENT_MAX) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// Data z cizí stránky: zalomení řádku se mění na mezeru (aby si nikdo nemohl dopsat vlastní nadpis sekce) a < > na ‹ ›.
const dosEsc = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›');

// Zkrácení na celou větu (jinak na celé slovo); n je nejvyšší délka výsledku včetně případné „…“.
function dosCutText(s, n) {
  if (s.length <= n) return s;
  const head = s.slice(0, n - 1);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= head.length * 0.5) return head.slice(0, end + 1);
  const sp = head.lastIndexOf(' ');
  return (sp > 0 ? head.slice(0, sp) : head) + '…';
}

// Text dossieru pro prompt modelu (nedůvěryhodná data). Zkracuje po celých položkách a větách, každé zkrácení zapíše do d.mezery
// (jednou) a mezery se v textu vypisují vždy, vyhrazené mají část rozpočtu.
function dossierPromptText(d, maxChars = DOS_PROMPT_MAX_DEFAULT) {
  const x = dosObj(d);
  if (!Array.isArray(x.mezery)) x.mezery = [];
  const max = Number.isFinite(maxChars) && maxChars >= DOS_PROMPT_MIN ? Math.floor(maxChars) : DOS_PROMPT_MAX_DEFAULT;
  const mainBudget = max - Math.floor(max * DOS_MEZERY_SHARE);
  const lines = [];
  let used = 0;
  let zkraceno = false;
  const push = (line, budget) => {
    if (used + line.length + 1 > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  const cutGap = (co) => {
    zkraceno = true;
    if (!x.mezery.some((m) => m && m.co === co && m.proc === 'zkráceno')) x.mezery.push({ co, proc: 'zkráceno' });
  };
  const line = (label, v) => (v ? label + ': ' + dosCutText(dosEsc(v), DOS_LINE_MAX) : null);
  const section = (co, header, items, budget = mainBudget) => {
    if (!items.length) return;
    if (!push(header, budget)) return cutGap(co);
    for (const it of items) if (!push(it, budget)) { cutGap(co); return; }
  };

  const cena = dosObj(x.cena), p = dosObj(x.prodejce), rec = dosObj(x.recenze), bl = dosObj(x.blokace);
  [
    line('Platforma', x.platforma),
    'Zdroj údajů: ' + (x.zdroj === 'extrakce' ? 'text nebo screenshot vložený uživatelem, ne živá stránka' : 'přímo ze stránky nabídky'),
    line('Název', x.nazev),
    cena.castka != null ? 'Cena: ' + cena.castka + (cena.mena ? ' ' + dosEsc(cena.mena) : '') : null,
    x.blokace ? 'Stránku nabídky se nepodařilo přečíst: ' + dosEsc(bl.druh || 'výzva k ověření') + (bl.dodavatel ? ' (' + dosEsc(bl.dodavatel) + ')' : '') + '. Údaje z ní nejsou k dispozici.' : null,
    p.nazev || p.hodnoceniProc != null || p.sledujici != null
      ? 'Prodejce: ' + [dosEsc(p.nazev || 'neuveden') + (p.typ ? ' (' + dosEsc(p.typ) + ')' : ''), p.hodnoceniProc != null ? 'kladných hodnocení ' + p.hodnoceniProc + ' %' : null, p.sledujici != null ? p.sledujici + ' sledujících' : null, p.pocetProdeju != null ? p.pocetProdeju + ' prodejů' : null].filter(Boolean).join(', ')
      : null,
  ].filter(Boolean).forEach((l) => push(l, mainBudget));

  section('varianty', 'Varianty:', dosArr(x.varianty).map((v) => {
    const o = dosObj(v);
    return '- ' + dosCutText(dosEsc(o.nazev || '') + ': ' + (o.vybrano ? 'vybráno „' + dosEsc(o.vybrano) + '“' : 'nic nevybráno') + (dosArr(o.moznosti).length ? '; možnosti: ' + dosArr(o.moznosti).map(dosEsc).join(', ') : ''), DOS_LINE_MAX);
  }));
  section('specifikace', 'Specifikace:', dosArr(x.specifikace).map((r) => '- ' + dosCutText(dosEsc(dosObj(r).nazev || '') + ': ' + dosEsc(dosObj(r).hodnota || ''), DOS_LINE_MAX)));
  section('tvrzení', 'Tvrzení z nabídky:', dosArr(x.tvrzeni).map((t) => '- ' + dosCutText(dosEsc(t), typeof t === 'string' && t.startsWith(DOS_JSONLD_PREFIX) ? DOS_JSONLD_MAX + DOS_JSONLD_PREFIX.length + 2 : DOS_LINE_MAX)));
  section('AI přehled', 'AI přehled platformy (generuje ho platforma, není to text prodejce):', dosArr(x.aiPrehled).map((t) => '- ' + dosCutText(dosEsc(t), DOS_LINE_MAX)));
  if (typeof x.popis === 'string' && x.popis.trim()) {
    const room = Math.min(Math.floor(max * DOS_POPIS_SHARE), mainBudget - used - 1);
    const label = 'Popis prodejce: ';
    const body = dosEsc(x.popis);
    if (room - label.length < 80) cutGap('popis');
    else {
      push(label + dosCutText(body, room - label.length), mainBudget);
      if (body.length > room - label.length) cutGap('popis');
    }
  }
  if (dosArr(x.identifikatory).length) section('identifikátory', 'Identifikátory v nabídce:', dosArr(x.identifikatory).map((i) => '- ' + dosEsc(dosObj(i).druh || '') + ': ' + dosEsc(dosObj(i).hodnota || '')));
  if (dosArr(x.obrazky).length) push('Počet obrázků v nabídce: ' + dosArr(x.obrazky).length, mainBudget);

  const polozky = dosArr(rec.polozky);
  if (rec.pocet != null || rec.prumer != null || polozky.length) {
    const hlava = 'Recenze: ' + [rec.pocet != null ? 'celkem ' + rec.pocet : null, rec.prumer != null ? 'průměr ' + rec.prumer + ' z 5' : null, 'přiloženo ' + polozky.length + (rec.uplne ? ' (všechny)' : ' (část)')].filter(Boolean).join(', ');
    section('recenze', hlava, polozky.map((r) => {
      const o = dosObj(r);
      const meta = [o.hodnoceni != null ? o.hodnoceni + '★' : null, o.datum ? dosEsc(o.datum) : null, o.varianta ? 'varianta ' + dosCutText(dosEsc(o.varianta), 80) : null].filter(Boolean).join(', ');
      return '- [' + meta + '] ' + (o.text ? dosCutText(dosEsc(o.text), DOS_REVIEW_TEXT_MAX) : '(bez textu)');
    }));
  }

  const gaps = dosArr(x.mezery).filter((m) => m && typeof m.co === 'string' && typeof m.proc === 'string');
  const ordered = gaps.filter((m) => m.proc === 'zkráceno').concat(gaps.filter((m) => m.proc !== 'zkráceno')).slice(0, DOS_GAPS_MAX);
  if (ordered.length) {
    push('Mezery (co se nepodařilo získat; chybějící údaj není důkaz o ničem):', max);
    ordered.forEach((m) => push('- ' + dosCutText(dosEsc(m.co) + ': ' + dosEsc(m.proc), DOS_GAP_MAX), max));
  }
  return { text: lines.join('\n'), zkraceno };
}

if (typeof module !== 'undefined') module.exports = { normalizeDossier, dossierGapsHideSafety, dossierToExtraction, extractionToDossier, identifierCandidates, dossierPromptText };
