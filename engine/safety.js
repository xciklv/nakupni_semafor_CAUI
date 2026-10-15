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

if (typeof module !== 'undefined') module.exports = { safetySignals };
