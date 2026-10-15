if (typeof require !== 'undefined' && typeof WEIGHT === 'undefined') { var { WEIGHT } = require('./signals'); }

function computeVerdict(signals, modules) {
  const okCount = Object.values(modules).filter((s) => s === 'ok').length;
  const score = signals.reduce((sum, x) => sum + WEIGHT[x.severity], 0);
  const hard = signals.some((x) => x.hard);
  const confidence = okCount >= 3 ? 'vysoká' : okCount === 2 ? 'střední' : 'nízká';
  let semafor;
  if (hard || score >= 6) semafor = 'červená';
  else if (score >= 3) semafor = 'oranžová';
  else semafor = confidence === 'nízká' ? 'šedá' : 'zelená';
  const unchecked = Object.entries(modules).filter(([, st]) => st !== 'ok').map(([k]) => k);
  return { semafor, score, confidence, unchecked };
}

if (typeof module !== 'undefined') module.exports = { computeVerdict };
