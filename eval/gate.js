// Kritérium stability testovací sady (Spec §13 bod 7). Čisté funkce nad záznamy z eval/report.js,
// běží v plain Node, do n8n workflow se nebundluje. Model nejde nastavit na deterministický výstup,
// proto jeden běh stabilitu neukáže: kritérium se vyhodnocuje nad opakovanými běhy (--repeat N).
//
// Pravidla:
//   1. U případů s labelem ok nebo podvod dá aspoň ceil(0,8 × repeat) běhů stejný výsledek „problém / v pořádku“
//      (oranžová a červená = problém, zelená = v pořádku). Šedá, „potřebuji víc“ ani chyba se nepočítají
//      jako shoda se žádnou stranou.
//   2. Při repeat ≥ 5 smí kolísat nejvýš jeden případ z osmi: ceil(n / 8) případů z n (1 pro 1 až 8 případů, 2 pro 9 až 16).
//      Kolísá případ, jehož běhy mají víc než jednu třídu výsledku (ok / rizikove / neurceno / chyba); počítají
//      se všechny opakované případy včetně sporných.
//   3. Sporný případ skupiny produkt s marketplace odkazem (AliExpress, Temu, Allegro, ...) nedá zelenou
//      v žádném běhu, v němž modul prodejce není zkontrolován (záznam běhu má v `nezkontrolovano` položku obsahující
//      „prodejce“, nebo pole chybí): bez údajů o prodejci je jediná poctivá odpověď „pozor“ nebo „nelze posoudit“.
//      Zelená při zkontrolovaném prodejci (dostatek údajů) sama gate neshodí; kolísání šedá/zelená mezi běhy
//      se ale dál počítá jako nestabilita podle pravidla 2.
const { resultClass } = require('./metrics');

const FLUCTUATION_MIN_REPEAT = 5;
const FLUCTUATION_PER = 8;

// Marketplace: doména odkazu (včetně subdomén) nebo explicitní příznak u případu, který odkaz nemá (vložený text).
const MARKETPLACE_HOST = /(^|\.)(aliexpress|allegro|temu|amazon|ebay|shein|alibaba|wish)\.[a-z]{2,3}(\.[a-z]{2})?$/;

function isMarketplaceCase(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.marketplace === true) return true;
  if (typeof c.odkaz !== 'string') return false;
  let host;
  try {
    host = new URL(c.odkaz).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return MARKETPLACE_HOST.test(host);
}

// ceil(0,8 × repeat) v celých číslech (0,8 × 3 v plovoucí řádce není přesně 2,4).
function requiredAgreement(repeat) {
  return Math.ceil((repeat * 4) / 5);
}

function groupById(results) {
  const by = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== 'object' || !r.id) continue;
    if (!by.has(r.id)) by.set(r.id, []);
    by.get(r.id).push(r);
  }
  return by;
}

const countClass = (runs, cls) => runs.filter((r) => resultClass(r) === cls).length;

// Prodejce je zkontrolován, jen když záznam má pole nezkontrolovano (pole) a žádná jeho položka se prodejce netýká.
const sellerUnchecked = (r) => !Array.isArray(r.nezkontrolovano) || r.nezkontrolovano.some((x) => typeof x === 'string' && /prodejce/i.test(x));

function evaluateGate(results, opts) {
  const repeat = opts && opts.repeat;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('evaluateGate: repeat musí být celé číslo ≥ 1');
  const need = requiredAgreement(repeat);
  const by = groupById(results);
  const duvody = [];
  if (by.size === 0) duvody.push('Žádné výsledky k vyhodnocení.');

  const fluctuating = [];
  for (const [id, runs] of by) {
    const label = runs[0].label;
    if (runs.length !== repeat) duvody.push(id + ': ' + runs.length + ' běhů místo ' + repeat + '.');
    if (new Set(runs.map(resultClass)).size > 1) fluctuating.push(id);

    if (label === 'ok' || label === 'podvod') {
      const problem = countClass(runs, 'rizikove');
      const ok = countClass(runs, 'ok');
      if (Math.max(problem, ok) < need) {
        duvody.push(id + ' (' + label + '): shoda jen ' + Math.max(problem, ok) + ' z ' + repeat + ' běhů (potřeba ' + need + '); problém ' + problem + '×, v pořádku ' + ok + '×, nelze posoudit nebo chyba ' + (runs.length - problem - ok) + '×.');
      }
    }

    if (label === 'sporne' && runs[0].skupina === 'produkt' && runs.some((r) => r.marketplace === true)) {
      const greens = runs.filter((r) => resultClass(r) === 'ok' && sellerUnchecked(r)).length;
      if (greens > 0) duvody.push(id + ' (sporne, marketplace): zelená ' + greens + '× z ' + runs.length + ' běhů při nezkontrolovaném prodejci, sporná nabídka z marketplace bez údajů o prodejci nesmí dostat zelenou.');
    }
  }

  if (repeat >= FLUCTUATION_MIN_REPEAT) {
    const allowed = Math.ceil(by.size / FLUCTUATION_PER);
    if (fluctuating.length > allowed) {
      duvody.push('Kolísá ' + fluctuating.length + ' z ' + by.size + ' případů (' + fluctuating.join(', ') + '); smí nejvýš ' + allowed + ' (1 z ' + FLUCTUATION_PER + ').');
    }
  }

  return { pass: duvody.length === 0, duvody };
}

function formatGate(g) {
  return g.pass ? ['PASS'] : ['FAIL', ...g.duvody.map((d) => '- ' + d)];
}

module.exports = { evaluateGate, isMarketplaceCase, formatGate, requiredAgreement, MARKETPLACE_HOST };
