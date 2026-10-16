// Metriky testovací sady (čisté funkce, běží v plain Node; do n8n workflow se nebundluje).
const LABELS = ['ok', 'sporne', 'podvod'];
const CLASSES = ['ok', 'rizikove', 'neurceno', 'chyba'];

// Semafor -> predikovaná třída. Cokoli neznámé je 'neurceno' (nikdy ne 'ok').
function predictedClass(semafor) {
  if (semafor === 'zelená') return 'ok';
  if (semafor === 'oranžová' || semafor === 'červená') return 'rizikove';
  return 'neurceno';
}

// Třída jednoho výsledku. Selhaný požadavek (stav 'chyba' nebo pole chyba) je zvláštní třída 'chyba':
// nepočítá se jako neurčeno, ale u podvodu ani u ok se nepočítá jako správně zachycený případ.
// Odpověď 'potrebuji_vice' je 'neurceno'.
function resultClass(r) {
  if (!r || typeof r !== 'object') return 'chyba';
  if (r.stav === 'chyba' || r.chyba) return 'chyba';
  if (r.stav === 'potrebuji_vice') return 'neurceno';
  return predictedClass(r.semafor);
}

function count(arr, cls) {
  return arr.filter((r) => resultClass(r) === cls).length;
}

function share(arr, cls) {
  return arr.length ? count(arr, cls) / arr.length : null;
}

function computeMetrics(results) {
  const list = Array.isArray(results) ? results : [];
  const by = (l) => list.filter((r) => r && r.label === l);
  const podvody = by('podvod');
  const oks = by('ok');
  const per_label_counts = { ok: oks.length, sporne: by('sporne').length, podvod: podvody.length };
  return {
    total: list.length,
    per_label_counts,
    recall_podvod: share(podvody, 'rizikove'),
    falesny_poplach: share(oks, 'rizikove'),
    neurceno: share(list, 'neurceno'),
    neurceno_podvod: share(podvody, 'neurceno'),
    neurceno_ok: share(oks, 'neurceno'),
    chyby: list.filter((r) => resultClass(r) === 'chyba').length,
    // Čitatelé podílů nahoře (jmenovatele jsou per_label_counts.podvod / .ok a total); pro výpis x/y.
    pocty: {
      recall_podvod: count(podvody, 'rizikove'),
      falesny_poplach: count(oks, 'rizikove'),
      neurceno: count(list, 'neurceno'),
      neurceno_podvod: count(podvody, 'neurceno'),
      neurceno_ok: count(oks, 'neurceno'),
    },
  };
}

// Metriky po skupinách (pole skupina u výsledku). Skupina 'coi' je kruhová (verdikt vychází ze stejného
// seznamu ČOI), proto 'detection' je spočtená bez ní. Výsledek bez skupiny spadne do 'nezarazeno'.
const CIRCULAR_GROUP = 'coi';
function computeMetricsByGroup(results) {
  const list = Array.isArray(results) ? results : [];
  const buckets = {};
  for (const r of list) {
    const g = r && typeof r.skupina === 'string' && r.skupina ? r.skupina : 'nezarazeno';
    (buckets[g] = buckets[g] || []).push(r);
  }
  const groups = {};
  for (const g of Object.keys(buckets)) groups[g] = computeMetrics(buckets[g]);
  return {
    overall: computeMetrics(list),
    groups,
    detection: computeMetrics(list.filter((r) => !(r && r.skupina === CIRCULAR_GROUP))),
  };
}

// Matice label x predikovaná třída (ok, rizikove, neurceno, chyba).
function confusion(results) {
  const m = {};
  for (const l of LABELS) {
    m[l] = {};
    for (const c of CLASSES) m[l][c] = 0;
  }
  for (const r of Array.isArray(results) ? results : []) {
    if (r && m[r.label]) m[r.label][resultClass(r)] += 1;
  }
  return m;
}

// Nejčastější signály (počet případů, kde se signál objevil; v jednom případu se počítá nejvýš jednou).
function topSignals(results, n = 10) {
  const acc = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !Array.isArray(r.signaly)) continue;
    const ids = new Set(r.signaly.map((s) => (s && typeof s === 'object' ? s.id : s)).filter((s) => typeof s === 'string' && s));
    for (const id of ids) {
      if (!acc.has(id)) acc.set(id, { id, count: 0, per_label: { ok: 0, sporne: 0, podvod: 0 } });
      const e = acc.get(id);
      e.count += 1;
      if (e.per_label[r.label] !== undefined) e.per_label[r.label] += 1;
    }
  }
  return [...acc.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, n);
}

module.exports = { LABELS, CLASSES, predictedClass, resultClass, computeMetrics, computeMetricsByGroup, confusion, topSignals };
