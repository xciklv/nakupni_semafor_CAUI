if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

// Text se porovnává bez diakritiky a malými písmeny (viz safetyNorm), proto regexy diakritiku nemají.
const SAFETY_CE_RE = /nabijec|charger|powerbank|power bank|elektr|\bkabel(?!k)|adapter|svitidl|reproduktor|sluchatk|headphone|earphone|earbud|smartwatch|hodink|drone|\bdron(?:y|u|ovi|em|ech|ami|e)?\b|\blamp(?!ion|as)|zasuvk|telefon|\bmobil(?!iar)/;
// Slovní kotvy: \bmobil (ne automobil; mobiliář je nábytek), \blamp(?!ion|as) (ne lampion/lampas), \bdron (ne androns).
const SAFETY_TOY_RE = /\b(?:hrack\w*|hracek|toys?)\b/;
const SAFETY_LED_RE = /\bled\b/;
const SAFETY_LED_NEG_RE = /forma na led|kostk|led do|na led/;
const SAFETY_BATERIE_RE = /baterie|baterii/;
const SAFETY_BATERIE_NEG_RE = /koupeln|umyvadl|\bvan[ay]?\b|drez|sprch/;
const SAFETY_SHODA_RE = /\bce\b|eu conformity|declaration of conformity|prohlaseni o shode/;

const safetyNorm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Kategorie vyžaduje CE, pokud je v textu spouštěč; LED a baterie mají negativní kontext (led na led, baterie vodovodní).
function safetyApplies(hay) {
  if (SAFETY_CE_RE.test(hay) || SAFETY_TOY_RE.test(hay)) return true;
  if (SAFETY_LED_RE.test(hay) && !SAFETY_LED_NEG_RE.test(hay)) return true;
  return SAFETY_BATERIE_RE.test(hay) && !SAFETY_BATERIE_NEG_RE.test(hay);
}

const SAFETY_GPSR_FIELDS = ['vyrobce_uveden', 'adresa_vyrobce', 'odpovedna_osoba_eu'];

// opts.uplny: true jen u úplného čtení stránky čtečkou. U vloženého textu, screenshotu nebo rozšíření vidíme jen část nabídky, takže „nic nenalezeno“
// je jen informace (info, do skóre se nepočítá), ne nízké riziko.
function safetySignals(x, opts) {
  const uplny = !!(opts && typeof opts === 'object' && opts.uplny === true);
  const severity = uplny ? 'low' : 'info';
  const p = x.produkt;
  if (!p.kategorie && !p.nazev) return { status: 'unchecked', signals: [] };
  const hay = safetyNorm((p.kategorie || '') + ' ' + (p.nazev || ''));
  const claimsCe = p.tvrzeni_certifikace.some((t) => SAFETY_SHODA_RE.test(safetyNorm(t)));
  const signals = [];
  if (safetyApplies(hay) && !claimsCe) {
    const toy = SAFETY_TOY_RE.test(hay);
    signals.push(signal({
      id: 'ce_chybi', module: 'safety', severity, druh: uplny ? 'riziko' : 'nelze_overit',
      title: 'Nabídka nezmiňuje shodu s předpisy EU',
      evidence: (toy
        ? 'U hraček je označení CE povinné, nabídka o něm mlčí.'
        : 'U této kategorie zboží je obvykle povinné označení CE, nabídka o něm mlčí.')
        + (uplny ? '' : ' Máme jen část nabídky, takže údaj nemusí chybět; ověřte ho na stránce nabídky.'),
      source: 'analýza nabídky',
    }));
  }
  const g = x.gpsr && typeof x.gpsr === 'object' ? x.gpsr : {};
  if (SAFETY_GPSR_FIELDS.some((k) => g[k] === 'ne')) {
    signals.push(signal({
      id: 'gpsr_chybi', module: 'safety', severity, druh: uplny ? 'riziko' : 'nelze_overit',
      title: 'Nabídka neuvádí údaje o výrobci požadované nařízením GPSR',
      evidence: 'Nařízení EU o bezpečnosti výrobků (GPSR) vyžaduje u zboží uvést výrobce, jeho adresu a odpovědnou osobu v EU; nabídka některý z těchto údajů neuvádí.'
        + (uplny ? '' : ' Máme jen část nabídky, takže údaj nemusí chybět; ověřte ho na stránce nabídky.'),
      source: 'analýza nabídky',
    }));
  }
  return { status: 'ok', signals };
}

// --- EU Safety Gate: slabý signál gated značkou (volitelné obohacení, selhání volání nic nemění) ---
const SAFETY_GATE_QUERY_MAX = 60;
const SAFETY_GATE_EXAMPLE_CAP = { ref: 24, name: 50, risk: 30 };

const safetyClean = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' ').replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
const safetyTokens = (s) => (typeof s === 'string' ? safetyNorm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean) : []);
const safetyCut = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Generická slova, která nejsou značka (porovnává se normalizovaná celá značka i značka složená jen z takových slov).
const SAFETY_GENERIC_BRANDS = new Set(['unbranded', 'no brand', 'nobrand', 'brand', 'generic', 'noname', 'no name', 'original', 'universal', 'oem', 'unknown', 'none', 'n/a', 'na', 'other', 'others', 'brandless', 'bez značky', 'neznámá', 'vlastní značka', 'private label', 'handmade', 'mini', 'power', 'smart', 'pro', 'plus', 'max', 'new', 'hot', 'best', 'top', 'super'].map((w) => safetyTokens(w).join(' ')));
const safetyIsGenericBrand = (tok) => SAFETY_GENERIC_BRANDS.has(tok.join(' ')) || tok.every((t) => SAFETY_GENERIC_BRANDS.has(t));

// Použitelná značka+model, nebo null: značka není generická; značka <3 znaky jen s použitelným modelem; model je použitelný, jen když má písmeno/číslici a není čistě číselný kratší než 3 číslice (jinak se ignoruje).
function safetyGateParts(p) {
  if (!p || typeof p.znacka !== 'string') return null;
  const brandTok = safetyTokens(p.znacka);
  if (!brandTok.length || safetyIsGenericBrand(brandTok)) return null;
  const mTok = typeof p.model === 'string' ? safetyTokens(p.model) : [];
  const modelTok = mTok.length && !/^\d{1,2}$/.test(mTok.join('')) ? mTok : null;
  if (brandTok.join(' ').length < 3 && !modelTok) return null;
  return { brandTok, modelTok, model: modelTok ? p.model : null };
}

// Posloupnost tokenů needle musí ležet v hay vcelku a po sobě (celá slova, ne podřetězce: Anker != Tanker).
function safetyHasSeq(hay, needle) {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length && ok; j++) ok = hay[i + j] === needle[j];
    if (ok) return true;
  }
  return false;
}

function safetyGateQuery(x) {
  const parts = safetyGateParts(x && x.produkt);
  if (!parts) return null;
  const text = safetyClean(x.produkt.znacka + (parts.model ? ' ' + parts.model : '')).slice(0, SAFETY_GATE_QUERY_MAX).trim();
  return text.length >= 2 ? { fullTextSearch: text } : null;
}

function safetyAlertMatches(a, brandTok, modelTok) {
  const pr = a && a.product;
  if (!pr || typeof pr !== 'object') return false;
  const brands = Array.isArray(pr.brands) ? pr.brands : [];
  if (!brands.some((b) => b && safetyHasSeq(safetyTokens(b.brand), brandTok))) return false;
  if (modelTok === null) return true;
  return safetyHasSeq(safetyTokens(pr.name), modelTok) || safetyHasSeq(safetyTokens(pr.nameSpecific), modelTok);
}

function safetyGateSignals(alerts, x) {
  const p = x && x.produkt;
  const parts = Array.isArray(alerts) ? safetyGateParts(p) : null;
  if (!parts) return [];
  const { brandTok, modelTok } = parts;
  const hits = alerts.filter((a) => safetyAlertMatches(a, brandTok, modelTok));
  if (!hits.length) return [];
  const a = hits[0], pr = a.product;
  const ref = typeof a.reference === 'string' ? safetyCut(a.reference, SAFETY_GATE_EXAMPLE_CAP.ref) : '';
  const name = [pr.nameSpecific, pr.name].find((v) => typeof v === 'string' && v.trim());
  const risks = a.risk && Array.isArray(a.risk.riskType) ? a.risk.riskType.map((r) => (r && typeof r.name === 'string' ? r.name.trim() : '')).filter(Boolean) : [];
  const example = [
    [ref, name ? safetyCut(name, SAFETY_GATE_EXAMPLE_CAP.name) : ''].filter(Boolean).join(' – '),
    risks.length ? safetyCut(risks.join('/'), SAFETY_GATE_EXAMPLE_CAP.risk) : '',
  ].filter(Boolean).join(', ');
  return [signal({
    id: 'safety_gate', module: 'safety', severity: 'low',
    title: 'Značka byla v EU nahlášena v databázi nebezpečných výrobků',
    evidence: 'Safety Gate: nalezeno ' + hits.length + ' upozornění k značce ' + safetyCut(p.znacka, SAFETY_GATE_QUERY_MAX)
      + (example ? ' (např. ' + example + ')' : '') + '. Netýká se nutně této nabídky, ověřte konkrétní model.',
    source: 'EU Safety Gate (CC BY 4.0)',
  })];
}

if (typeof module !== 'undefined') module.exports = { safetySignals, safetyGateQuery, safetyGateSignals };
