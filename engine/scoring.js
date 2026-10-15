if (typeof require !== 'undefined' && typeof WEIGHT === 'undefined') { var { WEIGHT } = require('./signals'); }

const MODULE_KEYS = ['offer', 'seller', 'safety'];

function computeVerdict(signals, modules) {
  const okCount = MODULE_KEYS.filter((k) => modules[k] === 'ok').length;
  // fail closed: a severity that is not an own key of WEIGHT counts as the highest weight
  const score = signals.reduce((sum, x) => sum + (Object.hasOwn(WEIGHT, x.severity) ? WEIGHT[x.severity] : WEIGHT.high), 0);
  const hard = signals.some((x) => x.hard);
  const confidence = okCount >= 3 ? 'vysoká' : okCount === 2 ? 'střední' : 'nízká';
  let semafor;
  if (hard || score >= 6) semafor = 'červená';
  else if (score >= 3) semafor = 'oranžová';
  else semafor = confidence === 'nízká' ? 'šedá' : 'zelená';
  const unchecked = MODULE_KEYS.filter((k) => modules[k] !== 'ok');
  return { semafor, score, confidence, unchecked };
}

if (typeof module !== 'undefined') module.exports = { computeVerdict };
