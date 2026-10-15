if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

// Text se porovnává bez diakritiky a malými písmeny (viz safetyNorm), proto regexy diakritiku nemají.
const SAFETY_CE_RE = /nabijec|powerbank|power bank|elektr|kabel|adapter|svitidl|\bled\b|hrack|hracek|detsk|baterie|reproduktor|sluchatk|hodink/;
const SAFETY_CHILD_RE = /hrack|hracek|detsk|kojen/;
const SAFETY_SHODA_RE = /\bce\b|eu conformity|declaration of conformity|prohlaseni o shode/;

const safetyNorm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function safetySignals(x) {
  const p = x.produkt;
  if (!p.kategorie && !p.nazev) return { status: 'unchecked', signals: [] };
  const hay = safetyNorm((p.kategorie || '') + ' ' + (p.nazev || ''));
  const claimsCe = p.tvrzeni_certifikace.some((t) => SAFETY_SHODA_RE.test(safetyNorm(t)));
  const signals = [];
  if (SAFETY_CE_RE.test(hay) && !claimsCe) {
    signals.push(signal({
      id: 'ce_chybi', module: 'safety', severity: SAFETY_CHILD_RE.test(hay) ? 'medium' : 'low',
      title: 'Nabídka nezmiňuje shodu s předpisy EU',
      evidence: 'U této kategorie zboží je obvykle povinné označení CE, nabídka o něm mlčí.', source: 'analýza nabídky',
    }));
  }
  return { status: 'ok', signals };
}

if (typeof module !== 'undefined') module.exports = { safetySignals };
