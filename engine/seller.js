if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

const SELLER_EU = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];

// Časté dvouúrovňové veřejné přípony: registrovatelná doména má pak tři části.
const SELLER_SLD = ['co.uk', 'org.uk', 'com.pl', 'com.au', 'co.jp', 'ne.jp', 'com.br', 'co.nz', 'co.za', 'com.tr'];

function registrable(host) {
  const labels = String(host).toLowerCase().replace(/^www\./, '').split('.');
  const n = labels.length >= 3 && SELLER_SLD.includes(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
}

function sellerDecode(s) {
  return s.replace(/&(nbsp|amp|lt|gt|quot|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (all, n) => {
    const k = n.toLowerCase();
    if (k === 'nbsp') return ' ';
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    const cp = k.charAt(1) === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
  });
}

// Text prvního <p>...</p> v řetězci (indexOf, každý znak nejvýše jednou); bez uzavření vrací ''.
function sellerFirstP(rest) {
  let pos = 0;
  for (;;) {
    const i = rest.indexOf('<p', pos);
    if (i === -1) return '';
    const c = rest.charAt(i + 2);
    if (c !== '>' && !/\s/.test(c)) { pos = i + 2; continue; }
    const gt = rest.indexOf('>', i);
    if (gt === -1) return '';
    const close = rest.indexOf('</p>', gt + 1);
    if (close === -1) return '';
    return sellerDecode(rest.slice(gt + 1, close).replace(/<[^<>]*>/g, ' ').replace(/[<>]/g, ' ')).replace(/\s+/g, ' ').trim();
  }
}

// Lineární parser: stránka se rozdělí na úseky podle začátků list_titles, každý znak se čte nejvýše jednou.
// Výsledek je objekt bez prototypu (klíče jako constructor nejsou zásah).
function parseCoi(html) {
  const list = Object.create(null);
  const src = String(html);
  const startRe = /<p class\s*=\s*"list_titles">/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(src))) starts.push({ at: m.index, bodyAt: m.index + m[0].length });
  for (let i = 0; i < starts.length; i++) {
    const seg = src.slice(starts[i].bodyAt, i + 1 < starts.length ? starts[i + 1].at : src.length);
    const titleEnd = seg.indexOf('</p>');
    if (titleEnd === -1) continue;
    const spanAt = seg.indexOf('<span>');
    if (spanAt === -1 || spanAt >= titleEnd) continue;
    const spanEnd = seg.indexOf('</span>', spanAt + 6);
    if (spanEnd === -1 || spanEnd >= titleEnd) continue;
    const spanText = seg.slice(spanAt + 6, spanEnd);
    let rest = seg.slice(titleEnd + 4);
    const artEnd = rest.indexOf('</article>');
    if (artEnd !== -1) rest = rest.slice(0, artEnd);
    const text = sellerFirstP(rest);
    sellerDecode(spanText).split(/[,;\s]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter((d) => /\./.test(d)).forEach((d) => { list[d] = text; });
  }
  return list;
}

function rdapAgeDays(rdap, nowMs) {
  const ev = rdap && Array.isArray(rdap.events) ? rdap.events.find((e) => e.eventAction === 'registration') : null;
  const t = ev && typeof ev.eventDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ev.eventDate) ? Date.parse(ev.eventDate) : NaN;
  const age = Number.isFinite(t) ? Math.floor((nowMs - t) / 86400000) : null;
  return age !== null && age >= 0 ? age : null;
}

function isValidIco(s) {
  if (!/^\d{8}$/.test(String(s))) return false;
  const d = String(s).split('').map(Number);
  const sum = d.slice(0, 7).reduce((a, v, i) => a + v * (8 - i), 0);
  let c = 11 - (sum % 11);
  if (c === 10) c = 0;
  if (c === 11) c = 1;
  return c === d[7];
}

function rdapUrl(host) {
  const h = registrable(host);
  if (h.indexOf('.') === -1) return null;
  return h.endsWith('.cz') ? 'https://rdap.nic.cz/domain/' + h : 'https://rdap.org/domain/' + h;
}

// Zavolá zdroj a nikdy nevyhodí: { ok, value }. Volání zdroje začne synchronně, takže víc zdrojů v Promise.all běží souběžně.
async function sellerTry(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, value: null }; }
}
const sellerAgo = (n) => 'před ' + n + (n === 1 ? ' dnem' : ' dny');
const sellerDays = (n) => n + (n === 1 ? ' den' : Number.isInteger(n) && n >= 2 && n <= 4 ? ' dny' : ' dní');
const sellerDec = (n) => String(n).replace('.', ',');

// Vrací { status, signals, external, skipped }: external = uspěl aspoň jeden externí zdroj (RDAP, ČOI, ARES),
// skipped = zdroje, které se zkusily, ale nebyly dostupné. coiList smí být i promise (seznam ČOI se stahuje souběžně).
async function sellerSignals({ x, rezim, host, fetchers, coiList, nowMs }) {
  const out = [];
  const skipped = [];
  let checks = 0;
  let external = false;
  const add = (id, severity, title, evidence, source, hard = false) => out.push(signal({ id, module: 'seller', severity, title, evidence, source, hard }));
  const s = x.prodejce;
  const eshopHost = rezim === 'eshop' && !!host;
  const rdapOn = eshopHost && registrable(host).indexOf('.') !== -1;
  const icoValid = !!s.ico && isValidIco(s.ico);

  // RDAP, seznam ČOI a ARES se čekají souběžně; každá větev si chybu ošetří sama.
  const [rdapRes, coiRes, aresRes] = await Promise.all([
    rdapOn ? sellerTry(() => fetchers.rdap(host)) : null,
    sellerTry(() => coiList),
    icoValid ? sellerTry(() => fetchers.ares(s.ico)) : null,
  ]);

  if (rdapOn) {
    const age = rdapRes.ok ? rdapAgeDays(rdapRes.value, nowMs) : null;
    if (age != null) {
      checks++;
      external = true;
      if (age < 30) add('domena_nova', 'high', 'Doména e-shopu je velmi nová', 'Doména ' + registrable(host) + ' byla zaregistrována ' + sellerAgo(age) + '.', 'RDAP');
      else if (age < 180) add('domena_mlada', 'medium', 'Doména e-shopu je mladá', 'Doména ' + registrable(host) + ' byla zaregistrována ' + sellerAgo(age) + '.', 'RDAP');
    } else skipped.push('RDAP (stáří domény)');
  }
  if (eshopHost) {
    const list = coiRes.ok ? coiRes.value : null;
    if (list) {
      checks++;
      external = true;
      const key = [host.toLowerCase().replace(/^www\./, ''), registrable(host)].find((k) => Object.prototype.hasOwnProperty.call(list, k));
      if (key) add('coi_seznam', 'high', 'E-shop je na seznamu rizikových webů ČOI', list[key] || 'Web je uveden na seznamu České obchodní inspekce.', 'ČOI', true);
    } else skipped.push('seznam ČOI');
  }

  if (s.ico) {
    if (!icoValid) { checks++; add('ico_neplatne', 'low', 'IČO je neplatné', 'Uvedené IČO ' + s.ico + ' neprojde kontrolou čísla.', 'kontrola IČO'); }
    else {
      const body = aresRes.ok ? aresRes.value : undefined;
      // použitelná odpověď: null (404 = nenalezeno) nebo objekt; cokoli jiného (chyba, text, pole) je nedostupný zdroj
      if (aresRes.ok && (body === null || (typeof body === 'object' && !Array.isArray(body)))) {
        checks++;
        external = true;
        if (body === null) add('ico_neexistuje', 'low', 'IČO nenalezeno v českém registru ARES', 'IČO nebylo nalezeno v českém registru ARES; u zahraničních (např. slovenských) firem je to běžné.', 'ARES');
        else if (typeof body.datumZaniku === 'string' && /^\d{4}-\d{2}-\d{2}/.test(body.datumZaniku)) add('subjekt_zanikl', 'high', 'Uvedený subjekt zanikl', (body.obchodniJmeno || s.ico) + ' zanikl dne ' + body.datumZaniku + '.', 'ARES');
      } else skipped.push('ARES');
    }
  }

  const known = (v) => v !== null && v !== undefined;
  // složený signál (mimo EU + chybí kontakt/provozovatel) nahrazuje jednotlivé kontakt_chybi/provozovatel_chybi: bez dvojího počítání
  const missingContact = s.kontakt_uveden === false || s.provozovatel_uveden === false;
  const outsideEu = !!s.zeme_odeslani && !SELLER_EU.includes(s.zeme_odeslani) && missingContact;
  if (known(s.provozovatel_uveden)) { checks++; if (s.provozovatel_uveden === false && !outsideEu) add('provozovatel_chybi', 'medium', 'Chybí provozovatel', 'Na webu není uvedeno, kdo ho provozuje.', 'analýza nabídky'); }
  if (known(s.kontakt_uveden)) { checks++; if (s.kontakt_uveden === false && !outsideEu) add('kontakt_chybi', 'medium', 'Chybí kontakt', 'Prodejce neuvádí kontaktní údaje.', 'analýza nabídky'); }
  if (known(s.podminky_uvedeny)) { checks++; if (s.podminky_uvedeny === false) add('podminky_chybi', 'low', 'Chybí obchodní podmínky', 'Nejsou dostupné obchodní podmínky.', 'analýza nabídky'); }
  // hodnocení 0 = bez hodnocení (ne špatné hodnocení): nevyhodnocuje se
  if (known(s.hodnoceni) && s.hodnoceni > 0) { checks++; if (s.hodnoceni < 4.0) add('hodnoceni_nizke', 'medium', 'Nízké hodnocení prodejce', 'Hodnocení prodejce je ' + sellerDec(s.hodnoceni) + '.', 'analýza nabídky'); }
  if (known(s.pocet_prodeju)) { checks++; if (s.pocet_prodeju < 50) add('malo_prodeju', 'low', 'Prodejce má málo prodejů', 'Počet prodejů: ' + s.pocet_prodeju + '.', 'analýza nabídky'); }
  if (known(s.stari_obchodu_dny)) { checks++; if (s.stari_obchodu_dny < 90) add('obchod_novy', 'medium', 'Obchod je nový', 'Obchod je starý ' + sellerDays(s.stari_obchodu_dny) + '.', 'analýza nabídky'); }
  if (outsideEu) {
    add('mimo_eu_bez_kontaktu', 'medium', 'Odeslání mimo EU bez kontaktu', 'Zboží se odesílá ze země ' + s.zeme_odeslani + ' a chybí kontakt nebo provozovatel.', 'analýza nabídky');
  }
  return { status: checks > 0 ? 'ok' : 'unchecked', signals: out, external, skipped };
}

if (typeof module !== 'undefined') module.exports = { SELLER_EU, SELLER_SLD, registrable, parseCoi, rdapAgeDays, isValidIco, rdapUrl, sellerSignals };
