// Čisté části běhu testovací sady (žádné síťové volání): sestavení těla požadavku,
// převod odpovědi na záznam, parsování argumentů a Markdown souhrn. I/O dělá run-eval.js.
const fs = require('node:fs');
const path = require('node:path');
const { LABELS, computeMetrics, computeMetricsByGroup, confusion, topSignals, resultClass } = require('./metrics');

const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function mimeFromName(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  const mime = m && MIMES[m[1].toLowerCase()];
  if (!mime) throw new Error('Nepodporovaný formát obrázku, očekávám příponu png, jpg, jpeg nebo webp: ' + name);
  return mime;
}

// Tělo POST požadavku pro jeden případ. Při chybě (chybějící soubor, špatný název, žádný vstup) vyhodí Error;
// run-eval.js z toho udělá záznam 'chyba' a pokračuje.
function buildRequestBody(c, screensDir) {
  const body = {};
  if (typeof c.odkaz === 'string' && c.odkaz) body.odkaz = c.odkaz;
  if (typeof c.text === 'string' && c.text) body.text = c.text;
  if (Array.isArray(c.screenshotFiles) && c.screenshotFiles.length) {
    body.screenshoty = c.screenshotFiles.map((f) => {
      if (typeof f !== 'string' || !f || path.basename(f) !== f) throw new Error('Neplatný název souboru screenshotu: ' + f);
      const mime = mimeFromName(f);
      let data;
      try {
        data = fs.readFileSync(path.join(screensDir, f)).toString('base64');
      } catch (e) {
        throw new Error('Screenshot ' + f + ' nelze přečíst (' + (e && e.code ? e.code : 'chyba') + ')');
      }
      return { mime, data };
    });
  }
  if (body.odkaz === undefined && body.text === undefined && body.screenshoty === undefined) throw new Error('Případ nemá žádný vstup (odkaz, text ani screenshotFiles)');
  return body;
}

// Skupina případu: explicitní 'skupina', jinak 'screens' pro screenshoty a 'synthetic' pro ostatní.
function caseGroup(c) {
  if (c && typeof c.skupina === 'string' && c.skupina) return c.skupina;
  return c && Array.isArray(c.screenshotFiles) && c.screenshotFiles.length ? 'screens' : 'synthetic';
}

function errorRecord(c, chyba) {
  return { id: c.id, label: c.label, skupina: caseGroup(c), stav: 'chyba', chyba: String(chyba).slice(0, 300) };
}

// Číselná proměnná prostředí; neplatná hodnota (prázdná, NaN, Infinity, záporná, u allowZero=false i 0) -> fallback.
function readNumberEnv(value, fallback, allowZero = true) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !allowZero)) return fallback;
  return n;
}

// Odpověď webhooku -> záznam výsledku. Nikdy nevyhazuje; cokoli nečekaného je stav 'chyba'.
function toResultRecord(c, j) {
  const base = { id: c.id, label: c.label, skupina: caseGroup(c) };
  const fail = (chyba) => errorRecord(c, chyba);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return fail('Neočekávaná odpověď (není JSON objekt)');
  if (j.stav === 'chyba') return fail(typeof j.chyba === 'string' && j.chyba ? j.chyba : 'Chyba bez popisu');
  if (j.stav === 'potrebuji_vice') return { ...base, stav: 'potrebuji_vice', zprava: typeof j.zprava === 'string' ? j.zprava : '' };
  if (j.stav === 'ok' && typeof j.semafor === 'string') {
    return {
      ...base,
      stav: 'ok',
      semafor: j.semafor,
      skore: j.skore,
      jistota: j.jistota,
      signaly: Array.isArray(j.signaly) ? j.signaly.map((s) => (s && typeof s === 'object' ? s.id : s)).filter((s) => typeof s === 'string') : [],
      nezkontrolovano: Array.isArray(j.nezkontrolovano) ? j.nezkontrolovano : [],
    };
  }
  return fail('Neočekávaná odpověď (stav ' + JSON.stringify(j.stav) + ')');
}

const MAX_REPEAT = 10;

function parseArgs(argv) {
  const out = { only: null, ids: null, repeat: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') {
      const v = argv[++i];
      if (!v) throw new Error('--only vyžaduje hodnotu (' + LABELS.join(', ') + ')');
      if (!LABELS.includes(v)) throw new Error('--only: neznámý label ' + v + ' (' + LABELS.join(', ') + ')');
      out.only = v;
    } else if (a === '--ids') {
      const v = argv[++i];
      if (!v) throw new Error('--ids vyžaduje seznam id oddělených čárkou');
      out.ids = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--repeat') {
      const v = argv[++i];
      if (!v || !/^[0-9]+$/.test(v) || Number(v) < 1 || Number(v) > MAX_REPEAT) throw new Error('--repeat vyžaduje celé číslo 1 až ' + MAX_REPEAT);
      out.repeat = Number(v);
    } else {
      throw new Error('Neznámý argument ' + a + ' (použití: --only <label> | --ids a,b | --repeat N)');
    }
  }
  return out;
}

function selectCases(cases, opts) {
  return cases.filter((c) => (!opts.only || c.label === opts.only) && (!opts.ids || opts.ids.includes(c.id)));
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
const sigText = (r) => (Array.isArray(r.signaly) && r.signaly.length ? r.signaly.join(', ') : 'žádné');
// x/y (p %); n/a, když není jmenovatel.
const frac = (x, y) => (y > 0 ? x + '/' + y + ' (' + Math.round((x / y) * 100) + ' %)' : 'n/a');

const COI_NOTE = 'Skupina ČOI je kruhová: verdikt vychází ze stejného seznamu, proto jde jen o kontrolu funkčnosti řetězce, ne o měřítko detekce. Zařazení na seznam ČOI znamená rizikového provozovatele, ne prokázaný podvod.';
const GROUP_ORDER = ['coi', 'legit', 'synthetic', 'produkt', 'screens'];
const GROUP_TITLE = { coi: 'ČOI (coi)', produkt: 'Konkrétní produktové stránky (produkt)' };

// Řádky s metrikami jedné množiny případů. Počítá se jen z vyhodnocených případů (bez chyb požadavků),
// chyby jsou uvedeny zvlášť: ev = metriky vyhodnocených, all = metriky včetně chyb.
function metricLines(ev, all) {
  const p = ev.pocty;
  return [
    '- Zachycené podvody (oranžová nebo červená): ' + frac(p.recall_podvod, ev.per_label_counts.podvod),
    '- Falešný poplach u legitimních nabídek: ' + frac(p.falesny_poplach, ev.per_label_counts.ok),
    '- Nelze posoudit (šedá nebo žádost o víc údajů): ' + frac(p.neurceno, ev.total),
    '- Nelze posoudit u podvodů: ' + frac(p.neurceno_podvod, ev.per_label_counts.podvod) + ', u legitimních nabídek: ' + frac(p.neurceno_ok, ev.per_label_counts.ok),
    '- Chyby požadavků: ' + all.chyby,
  ];
}

function outcomeKind(r) {
  const cls = resultClass(r);
  if (cls === 'chyba') return 'chyba';
  if (cls === 'neurceno') return 'neurčeno';
  return r.label === 'ok' ? 'falešný poplach' : 'zmeškaný podvod';
}

// Stabilita opakovaných běhů: pro každý případ rozdělení výsledků (semafor, jinak stav) a příznak, zda se výsledek mezi běhy liší.
// Pořadí případů podle prvního výskytu. Použité jen, když se případy opakují (--repeat N).
function stabilitySummary(results) {
  const rows = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.id) continue;
    if (!rows.has(r.id)) rows.set(r.id, { id: r.id, label: r.label, runs: 0, counts: {} });
    const row = rows.get(r.id);
    const outcome = resultClass(r) === 'chyba' ? 'chyba' : (r.semafor || r.stav || 'neznámé');
    row.runs += 1;
    row.counts[outcome] = (row.counts[outcome] || 0) + 1;
  }
  return [...rows.values()].map((row) => ({ ...row, stable: Object.keys(row.counts).length === 1 }));
}

const countsText = (counts) => Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? -1 : 1)).map((k) => k + '×' + counts[k]).join(', ');

// Řádky textu o stabilitě (konzole i report): nejdřív souhrn, pak nestabilní případy; stabilní jen jako počet.
function stabilityLines(results) {
  const rows = stabilitySummary(results);
  const unstable = rows.filter((r) => !r.stable);
  const L = [rows.length + ' případů, ' + unstable.length + ' z nich mění výsledek mezi opakováními.'];
  for (const r of unstable) L.push('⚠ ' + r.id + ' (' + r.label + '): ' + countsText(r.counts));
  return L;
}

// Markdown souhrn. Procenta se vždy tisknou s jmenovatelem (x/y). Sazby se počítají jen z vyhodnocených
// případů (stav jiný než chyba); computeMetrics v metrics.js zůstává definovaný nad všemi případy včetně chyb.
function renderReport(results, meta) {
  const list = Array.isArray(results) ? results : [];
  const evaluated = list.filter((r) => resultClass(r) !== 'chyba');
  const all = computeMetricsByGroup(list);
  const ev = computeMetricsByGroup(evaluated);
  const n = all.overall.total;
  const chyby = all.overall.chyby;
  const cm = confusion(list);
  const L = [];
  L.push('# Výsledky testovací sady', '');
  L.push('- Datum: ' + ((meta && meta.datum) || 'neuvedeno') + ', API: ' + ((meta && meta.api) || 'neuvedeno'));
  const pl = all.overall.per_label_counts;
  L.push('- Počet případů: ' + n + ' (ok: ' + pl.ok + ', sporné: ' + pl.sporne + ', podvod: ' + pl.podvod + ')', '');
  if (meta && meta.repeat > 1) L.push('Každý případ proběhl ' + meta.repeat + '× a metriky počítají každý běh zvlášť (n = počet běhů).');
  if (n < 100) L.push('Malý vzorek: výsledky jsou orientační (n = ' + n + ').');
  if (chyby > 0) {
    L.push('⚠ ' + chyby + ' z ' + n + ' požadavků skončilo chybou; metriky nejsou úplné.');
    L.push('Vyhodnoceno: ' + (n - chyby) + '/' + n);
  }
  if (chyby === n) L.push('Žádný případ nebyl vyhodnocen.');
  L.push('Procenta se počítají jen z vyhodnocených případů (bez chyb požadavků); chyby jsou uvedeny zvlášť.');
  L.push('', '## Detekce (bez skupiny ČOI)', '');
  L.push(...metricLines(ev.detection, all.detection));
  for (const g of Object.keys(all.groups).sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : a > b ? 1 : 0);
  })) {
    const evg = ev.groups[g] || computeMetricsByGroup([]).overall;
    L.push('', '## Skupina ' + (GROUP_TITLE[g] || g), '');
    L.push('- Počet případů: ' + all.groups[g].total);
    L.push(...metricLines(evg, all.groups[g]));
    if (g === 'coi') L.push('', COI_NOTE);
  }
  L.push('', '## Matice (skutečnost x výsledek, všechny skupiny)', '');
  L.push('| Skutečnost | zelená | oranžová/červená | neurčeno | chyba |', '|---|---|---|---|---|');
  for (const l of LABELS) L.push('| ' + l + ' | ' + cm[l].ok + ' | ' + cm[l].rizikove + ' | ' + cm[l].neurceno + ' | ' + cm[l].chyba + ' |');
  L.push('', '## Nejčastější signály', '');
  const top = topSignals(list, 10);
  if (!top.length) L.push('Žádné signály.');
  else {
    L.push('| Signál | Počet případů | ok / sporné / podvod |', '|---|---|---|');
    for (const t of top) L.push('| ' + t.id + ' | ' + t.count + ' | ' + t.per_label.ok + ' / ' + t.per_label.sporne + ' / ' + t.per_label.podvod + ' |');
  }
  L.push('', '## Případy mimo očekávání', '');
  const off = list.filter((r) => r && ((r.label === 'podvod' && resultClass(r) !== 'rizikove') || (r.label === 'ok' && resultClass(r) !== 'ok')));
  if (!off.length) L.push('Žádné.');
  for (const r of off) {
    const cls = resultClass(r);
    const got = cls === 'chyba' ? 'chyba' : (r.semafor || r.stav);
    const skore = cls !== 'chyba' && r.skore !== undefined && r.skore !== null ? ', skóre ' + r.skore : '';
    const detail = cls === 'chyba' ? oneLine(r.chyba || 'bez popisu') : 'signály: ' + sigText(r);
    L.push('- ' + r.id + ' [' + (r.skupina || 'nezarazeno') + '] (' + outcomeKind(r) + ': ' + r.label + ' -> ' + got + skore + '): ' + detail);
  }
  if (meta && meta.repeat > 1) {
    L.push('', '## Stabilita opakování (' + meta.repeat + '× na případ)', '');
    const rows = stabilitySummary(list);
    L.push(stabilityLines(list)[0], '');
    L.push('| Případ | Label | Výsledky |', '|---|---|---|');
    for (const r of rows) L.push('| ' + r.id + ' | ' + r.label + ' | ' + (r.stable ? '' : '⚠ ') + countsText(r.counts) + ' |');
  }
  const sporne = list.filter((r) => r && r.label === 'sporne');
  L.push('', '## Sporné případy (do metrik zachycení a falešného poplachu se nepočítají)', '');
  if (!sporne.length) L.push('Žádné.');
  for (const r of sporne) {
    const cls = resultClass(r);
    L.push('- ' + r.id + ': ' + (cls === 'chyba' ? 'chyba, ' + oneLine(r.chyba || 'bez popisu') : (r.semafor || r.stav) + ', signály: ' + sigText(r)));
  }
  return L.join('\n') + '\n';
}

module.exports = { mimeFromName, buildRequestBody, caseGroup, errorRecord, readNumberEnv, toResultRecord, parseArgs, selectCases, renderReport, stabilitySummary, stabilityLines, MAX_REPEAT };
