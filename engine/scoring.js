if (typeof require !== 'undefined' && typeof WEIGHT === 'undefined') { var { WEIGHT } = require('./signals'); }

const MODULE_KEYS = ['offer', 'seller', 'safety'];
// Přeskočené moduly mimo MODULE_KEYS (věrohodnost, obrázky, identita): bez nich nelze říct, že je nabídka bez nálezů, takže zelená se mění na šedou.
// Nedostupné zdroje prodejce (ČOI, ARES, VIES, RDAP) zelenou dál nebrání, jen snižují jistotu.
const GREEN_BLOCKING_SKIPPED = ['ověření věrohodnosti', 'analýza obrázků', 'Icecat'];

// opts: { external: bool (uspěl aspoň jeden externí zdroj), skipped: string[] (zdroje, které se zkusily, ale nebyly dostupné),
//   marketplace: bool (nabídka z tržiště: bez externího ověření prodejce, tj. ARES, VIES, ČOI nebo RDAP, nesmí být zelená) }
function computeVerdict(signals, modules, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const okCount = MODULE_KEYS.filter((k) => modules[k] === 'ok').length;
  const allOk = okCount === MODULE_KEYS.length;
  const skipped = Array.isArray(o.skipped) ? o.skipped.filter((x) => typeof x === 'string') : [];
  // fail closed: a severity that is not an own key of WEIGHT counts as the highest weight
  const known = (x) => Object.hasOwn(WEIGHT, x.severity);
  const score = signals.reduce((sum, x) => sum + (known(x) ? WEIGHT[x.severity] : WEIGHT.high), 0);
  const hard = signals.some((x) => x.hard);
  const elevated = signals.some((x) => !known(x) || x.severity === 'medium' || x.severity === 'high');
  let confidence;
  if (allOk && o.external === true && skipped.length === 0) confidence = 'vysoká';
  else if (okCount >= 2) confidence = 'střední';
  else confidence = 'nízká';
  let semafor;
  if (hard || score >= 6) semafor = 'červená';
  else if (score >= 3 && (elevated || score >= 4)) semafor = 'oranžová';
  else semafor = allOk && !skipped.some((x) => GREEN_BLOCKING_SKIPPED.includes(x)) ? 'zelená' : 'šedá';
  // Na tržišti prodejce z textových údajů nic neověřuje: zelená jen z nálezů bez externího ověření prodejce se mění na šedou (oranžová a červená zůstávají).
  const sellerUnverified = semafor === 'zelená' && o.marketplace === true && o.external !== true;
  if (sellerUnverified) semafor = 'šedá';
  const unchecked = MODULE_KEYS.filter((k) => modules[k] !== 'ok');
  return { semafor, score, confidence, unchecked, skipped, ...(sellerUnverified ? { sellerUnverified: true } : {}) };
}

if (typeof module !== 'undefined') module.exports = { computeVerdict, GREEN_BLOCKING_SKIPPED };
