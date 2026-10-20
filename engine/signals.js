// info = ukazuje se uživateli, do skóre se nepočítá (váha 0)
const WEIGHT = { info: 0, low: 1, medium: 3, high: 6 };
const SIGNAL_EVIDENCE_MAX = 300;
// Nález = signál rozšířený o druh, citaci z nabídky, vysvětlení pro laika a otázku pro prodejce.
const DRUHY = ['nesmysl', 'rozpor', 'riziko', 'nelze_overit'];
const JISTOTY = ['vysoka', 'stredni', 'nizka'];
const SIGNAL_CITACE_MAX = 300;
const SIGNAL_VYSVETLENI_MAX = 400;
const SIGNAL_OTAZKA_MAX = 200;
const SIGNAL_VYPOCET_MAX = 300;
const SIGNAL_ODKAZY_MAX = 3;
const SIGNAL_ODKAZ_TEXT_MAX = 80;

function signal({ id, module, severity, title, evidence, source = null, hard = false, druh = 'riziko', citace = null, vysvetleni = null, otazka = null, vypocet = null, jistota = null, odkazy = [] }) {
  if (!Object.hasOwn(WEIGHT, severity)) throw new Error('Neplatná závažnost: ' + severity);
  if (!DRUHY.includes(druh)) throw new Error('Neplatný druh: ' + druh);
  if (jistota !== null && !JISTOTY.includes(jistota)) throw new Error('Neplatná jistota: ' + jistota);
  const cap = (v, n) => (typeof v === 'string' && v.length > n ? v.slice(0, n - 1) + '…' : v);
  const links = (Array.isArray(odkazy) ? odkazy : [])
    .filter((o) => o && typeof o.url === 'string' && o.url.startsWith('https://') && typeof o.text === 'string')
    .slice(0, SIGNAL_ODKAZY_MAX)
    .map((o) => ({ text: cap(o.text, SIGNAL_ODKAZ_TEXT_MAX), url: o.url }));
  return {
    id, module, severity, title: cap(title, 120), evidence: cap(evidence, SIGNAL_EVIDENCE_MAX), source, hard,
    druh, citace: cap(citace, SIGNAL_CITACE_MAX), vysvetleni: cap(vysvetleni, SIGNAL_VYSVETLENI_MAX), otazka: cap(otazka, SIGNAL_OTAZKA_MAX),
    vypocet: cap(vypocet, SIGNAL_VYPOCET_MAX), jistota, odkazy: links,
  };
}

if (typeof module !== 'undefined') module.exports = { WEIGHT, DRUHY, signal };
