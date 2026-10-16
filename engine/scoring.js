if (typeof require !== 'undefined' && typeof WEIGHT === 'undefined') { var { WEIGHT } = require('./signals'); }

const MODULE_KEYS = ['offer', 'seller', 'safety'];

// opts: { external: bool (uspěl aspoň jeden externí zdroj), skipped: string[] (zdroje, které se zkusily, ale nebyly dostupné) }
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
  else semafor = allOk ? 'zelená' : 'šedá';
  const unchecked = MODULE_KEYS.filter((k) => modules[k] !== 'ok');
  return { semafor, score, confidence, unchecked, skipped };
}

if (typeof module !== 'undefined') module.exports = { computeVerdict };
