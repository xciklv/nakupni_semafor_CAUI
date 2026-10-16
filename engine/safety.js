if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

// Text se porovnává bez diakritiky a malými písmeny (viz safetyNorm), proto regexy diakritiku nemají.
const SAFETY_CE_RE = /nabijec|charger|powerbank|power bank|elektr|\bkabel(?!k)|adapter|svitidl|reproduktor|sluchatk|headphone|earphone|earbud|smartwatch|hodink|drone|dron|lamp|zasuvk|telefon|mobil/;
const SAFETY_TOY_RE = /\b(hracek|hracka|hracky|toys?)\b/;
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

function safetySignals(x) {
  const p = x.produkt;
  if (!p.kategorie && !p.nazev) return { status: 'unchecked', signals: [] };
  const hay = safetyNorm((p.kategorie || '') + ' ' + (p.nazev || ''));
  const claimsCe = p.tvrzeni_certifikace.some((t) => SAFETY_SHODA_RE.test(safetyNorm(t)));
  const signals = [];
  if (safetyApplies(hay) && !claimsCe) {
    const toy = SAFETY_TOY_RE.test(hay);
    signals.push(signal({
      id: 'ce_chybi', module: 'safety', severity: toy ? 'medium' : 'low',
      title: 'Nabídka nezmiňuje shodu s předpisy EU',
      evidence: toy
        ? 'U hraček je označení CE povinné, nabídka o něm mlčí.'
        : 'U této kategorie zboží je obvykle povinné označení CE, nabídka o něm mlčí.',
      source: 'analýza nabídky',
    }));
  }
  return { status: 'ok', signals };
}

// --- EU Safety Gate: slabý signál gated značkou (volitelné obohacení, selhání volání nic nemění) ---
const SAFETY_GATE_QUERY_MAX = 60;
const SAFETY_GATE_EXAMPLE_CAP = { ref: 24, name: 50, risk: 30 };

const safetyClean = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
const safetyTokens = (s) => (typeof s === 'string' ? safetyNorm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean) : []);
const safetyCut = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

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
  const p = x && x.produkt;
  if (!p || typeof p.znacka !== 'string' || !p.znacka.trim()) return null;
  const parts = [p.znacka];
  if (typeof p.model === 'string' && p.model.trim()) parts.push(p.model);
  const text = safetyClean(parts.join(' ')).slice(0, SAFETY_GATE_QUERY_MAX).trim();
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
  if (!Array.isArray(alerts) || !p || typeof p.znacka !== 'string') return [];
  const brandTok = safetyTokens(p.znacka);
  if (!brandTok.length) return [];
  const hasModel = typeof p.model === 'string' && p.model.trim() !== '';
  const modelTok = hasModel ? safetyTokens(p.model) : null;
  if (hasModel && !modelTok.length) return [];
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
