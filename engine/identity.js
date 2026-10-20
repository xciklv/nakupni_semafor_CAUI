if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

// Identita produktu: platnost čárového kódu (GTIN), prefix GS1 a shoda značky s katalogem Icecat. Co Icecat nezná, je „nelze ověřit“, nikdy podezření.
const IDN_LENGTHS = [8, 12, 13, 14];
const IDN_LOOKUP_MAX = 2;
const IDN_NAME_CITE_MAX = 100;
const IDN_ICECAT_URL = 'https://live.icecat.biz/api?shopname=openIcecat-live&lang=cz&GTIN=';
const IDN_ICECAT_SOURCE = 'Icecat (otevřený katalog výrobců)';
const IDN_BRAND_ROW_RE = /^(brand|brand name|značka|znacka|model|model number|číslo modelu|cislo modelu)$/i;

// Prefixy GS1 (první tři číslice 13místného kódu): země, která prefix přidělila; neurčují zemi původu výrobku.
const IDN_GS1_COUNTRIES = [
  [0, 19, 'US'], [30, 39, 'US'], [60, 139, 'US'], [300, 379, 'FR'], [400, 440, 'DE'], [450, 459, 'JP'], [490, 499, 'JP'],
  [500, 509, 'GB'], [590, 590, 'PL'], [599, 599, 'HU'], [690, 699, 'CN'], [800, 839, 'IT'], [840, 849, 'ES'], [858, 858, 'SK'],
  [859, 859, 'CZ'], [870, 879, 'NL'], [880, 880, 'KR'], [900, 919, 'AT'],
];
// Rozsahy, které nejsou čísla produktů výrobců: interní 02x a 2xx, knihy 978/979, kupóny 99x.
const IDN_GS1_INTERNAL = [[20, 29], [200, 299], [978, 979], [990, 999]];

function checkGtin(code) {
  if (typeof code !== 'string') return { ok: false, delka: 0, duvod: 'kód není text' };
  const s = code.trim();
  if (!/^\d+$/.test(s)) return { ok: false, delka: s.length, duvod: 'obsahuje znaky, které nejsou číslice' };
  if (!IDN_LENGTHS.includes(s.length)) return { ok: false, delka: s.length, duvod: 'délka ' + s.length + ' číslic (kód má mít 8, 12, 13 nebo 14)' };
  const d = s.split('').map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((acc, x, i) => acc + x * (i % 2 ? 1 : 3), 0);
  const expected = (10 - (sum % 10)) % 10;
  if (expected !== check) return { ok: false, delka: s.length, duvod: 'nesedí kontrolní číslice (je ' + check + ', má být ' + expected + ')' };
  return { ok: true, delka: s.length, duvod: null };
}

function gs1Prefix(code) {
  const s = typeof code === 'string' ? code.trim() : '';
  if (!/^\d+$/.test(s) || !IDN_LENGTHS.includes(s.length)) return { prefix: '', zeme: null, vnitrni: false };
  const full = s.length === 12 ? '0' + s : s.length === 14 ? s.slice(1) : s;
  const prefix = full.slice(0, 3);
  const n = Number(prefix);
  const inRange = ([from, to]) => n >= from && n <= to;
  if (IDN_GS1_INTERNAL.some(inRange)) return { prefix, zeme: null, vnitrni: true };
  const hit = IDN_GS1_COUNTRIES.find(inRange);
  return { prefix, zeme: hit ? hit[2] : null, vnitrni: false };
}

function icecatUrl(gtin) {
  return IDN_ICECAT_URL + encodeURIComponent(gtin);
}

const idnStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function parseIcecat(body) {
  const info = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data.GeneralInfo : null;
  if (!info || typeof info !== 'object') return { nalezeno: false, znacka: null, kodVyrobce: null, nazev: null };
  return { nalezeno: true, znacka: idnStr(info.Brand), kodVyrobce: idnStr(info.BrandPartCode), nazev: idnStr(info.Title) };
}

const idnTokens = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const idnCut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Posloupnost tokenů needle musí ležet v hay vcelku a po sobě (celá slova: Philipsen není Philips).
function idnHasSeq(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

// Co o výrobku říká sama nabídka: název, značka a model ze specifikace a kódy jiné než EAN. Bez názvu a značky se nic neporovnává.
function idnOfferTokens(d) {
  const spec = (Array.isArray(d.specifikace) ? d.specifikace : []).filter((r) => r && typeof r.nazev === 'string' && IDN_BRAND_ROW_RE.test(r.nazev.trim()) && typeof r.hodnota === 'string');
  if (!idnStr(d.nazev) && !spec.length) return null;
  const codes = (Array.isArray(d.identifikatory) ? d.identifikatory : []).filter((i) => i && i.druh !== 'ean' && typeof i.hodnota === 'string').map((i) => i.hodnota);
  return idnTokens([d.nazev || ''].concat(spec.map((r) => r.hodnota), codes).join(' '));
}

// Kódy k ověření: EAN podle označení nabídky (neplatné se jen nahlásí) a 12 až 14místné číselné kódy z jiných polí (model, kód výrobce), pokud projdou kontrolou.
function idnCandidates(d) {
  const ids = (Array.isArray(d.identifikatory) ? d.identifikatory : []).filter((i) => i && typeof i.hodnota === 'string');
  const invalid = [], lookup = [];
  const add = (list, v) => { if (!list.includes(v) && !invalid.includes(v) && !lookup.includes(v)) list.push(v); };
  for (const i of ids.filter((x) => x.druh === 'ean')) {
    const v = i.hodnota.trim();
    add(checkGtin(v).ok ? lookup : invalid, v);
  }
  for (const i of ids.filter((x) => x.druh !== 'ean')) {
    const v = i.hodnota.trim();
    if (/^\d{12,14}$/.test(v) && checkGtin(v).ok) add(lookup, v);
  }
  return { invalid, lookup: lookup.slice(0, IDN_LOOKUP_MAX) };
}

function idnInvalidSignal(codes, checks) {
  return signal({
    id: 'ean_neplatny', module: 'identity', severity: 'low', druh: 'riziko', jistota: 'stredni',
    title: 'Kód označený jako EAN neprochází kontrolou',
    evidence: codes.map((c, i) => c + ': ' + checks[i].duvod).join('; ') + '. U skutečného čárového kódu by kontrola prošla; může jít i o překlep v nabídce.',
    citace: codes.join('; '),
    vysvetleni: 'Čárový kód (EAN) má pevnou délku a poslední číslici, která se z ostatních dopočítá. Tento kód tou kontrolou neprojde, takže jde o překlep nebo o vymyšlené číslo.',
    otazka: 'Můžete mi napsat správný EAN tohoto produktu?',
    source: 'kontrola čárového kódu (GTIN)',
  });
}

function idnNotFoundSignal(codes) {
  return signal({
    id: 'ean_nenalezen', module: 'identity', severity: 'info', druh: 'nelze_overit',
    title: 'Kód produktu se nepodařilo ověřit v katalogu výrobců',
    evidence: 'Katalog Icecat kód ' + codes.join(', ') + ' nezná. Pokrývá jen vybrané značky, takže to o nabídce nic neříká.',
    citace: codes.join('; '),
    source: IDN_ICECAT_SOURCE,
  });
}

function idnMismatchSignal(code, d, ice) {
  const offer = idnCut(String(d.nazev || ''), IDN_NAME_CITE_MAX);
  const znacka = ice.znacka || ice.nazev;
  return signal({
    id: 'identifikator_nesedi', module: 'identity', severity: 'medium', druh: 'rozpor', jistota: 'stredni',
    title: 'Značka u kódu v nabídce nesedí',
    evidence: 'Podle katalogu Icecat patří kód ' + code + ' značce ' + znacka + ', ale nabídka tuto značku neuvádí.',
    citace: 'Nabídka: „' + offer + '“. Icecat k EAN ' + code + ': ' + idnCut([ice.znacka, ice.nazev].filter(Boolean).join(' – '), IDN_NAME_CITE_MAX) + '.',
    vysvetleni: 'Kód z nabídky katalog výrobců přiřazuje značce ' + znacka + ', která se v nabídce neobjevuje. Může jít o kompatibilní příslušenství s převzatým kódem, o překlep nebo o zaměněný produkt.',
    otazka: 'Patří kód ' + code + ' opravdu k tomuto produktu? Od jaké značky je vyrobený?',
    source: IDN_ICECAT_SOURCE,
  });
}

async function identitySignals({ dossier, fetchers }) {
  const d = dossier && typeof dossier === 'object' ? dossier : {};
  const { invalid, lookup } = idnCandidates(d);
  const signals = [];
  const skipped = [];
  if (invalid.length) signals.push(idnInvalidSignal(invalid, invalid.map(checkGtin)));
  let answered = 0;
  if (lookup.length) {
    const icecat = fetchers && typeof fetchers.icecat === 'function' ? fetchers.icecat : null;
    const results = await Promise.all(lookup.map(async (code) => {
      if (!icecat) return null;
      try { return parseIcecat(await icecat(code)); } catch (e) { return null; }
    }));
    if (results.some((r) => r === null)) skipped.push('Icecat');
    answered = results.filter((r) => r !== null).length;
    const unknown = lookup.filter((c, i) => results[i] && !results[i].nalezeno);
    if (unknown.length) signals.push(idnNotFoundSignal(unknown));
    const offer = idnOfferTokens(d);
    const i = offer ? lookup.findIndex((c, k) => results[k] && results[k].nalezeno && (results[k].znacka || results[k].kodVyrobce)) : -1;
    if (i >= 0) {
      const ice = results[i];
      const brandOk = ice.znacka && idnHasSeq(offer, idnTokens(ice.znacka));
      const codeOk = ice.kodVyrobce && idnHasSeq(offer, idnTokens(ice.kodVyrobce));
      if (!brandOk && !codeOk) signals.push(idnMismatchSignal(lookup[i], d, ice));
    }
  }
  return { status: signals.length || answered ? 'ok' : 'unchecked', signals, skipped };
}

if (typeof module !== 'undefined') module.exports = { checkGtin, gs1Prefix, icecatUrl, parseIcecat, identitySignals };
