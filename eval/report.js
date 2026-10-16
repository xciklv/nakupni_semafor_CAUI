// Čisté části běhu testovací sady (žádné síťové volání): sestavení těla požadavku,
// převod odpovědi na záznam, parsování argumentů a Markdown souhrn. I/O dělá run-eval.js.
const fs = require('node:fs');
const path = require('node:path');
const { LABELS, computeMetrics, confusion, topSignals, resultClass } = require('./metrics');

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

// Odpověď webhooku -> záznam výsledku. Nikdy nevyhazuje; cokoli nečekaného je stav 'chyba'.
function toResultRecord(c, j) {
  const base = { id: c.id, label: c.label };
  const fail = (chyba) => ({ ...base, stav: 'chyba', chyba: String(chyba).slice(0, 300) });
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

function parseArgs(argv) {
  const out = { only: null, ids: null };
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
    } else {
      throw new Error('Neznámý argument ' + a + ' (použití: --only <label> | --ids a,b)');
    }
  }
  return out;
}

function selectCases(cases, opts) {
  return cases.filter((c) => (!opts.only || c.label === opts.only) && (!opts.ids || opts.ids.includes(c.id)));
}

const pct = (v) => (v === null || v === undefined ? 'n/a' : Math.round(v * 100) + ' %');
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
const sigText = (r) => (Array.isArray(r.signaly) && r.signaly.length ? r.signaly.join(', ') : 'žádné');

function renderReport(results, meta) {
  const list = Array.isArray(results) ? results : [];
  const m = computeMetrics(list);
  const cm = confusion(list);
  const L = [];
  L.push('# Výsledky testovací sady', '');
  L.push('- Datum: ' + ((meta && meta.datum) || 'neuvedeno') + ', API: ' + ((meta && meta.api) || 'neuvedeno'));
  L.push('- Počet případů: ' + m.total + ' (ok: ' + m.per_label_counts.ok + ', sporné: ' + m.per_label_counts.sporne + ', podvod: ' + m.per_label_counts.podvod + ')');
  L.push('- Zachycené podvody (oranžová nebo červená): ' + pct(m.recall_podvod));
  L.push('- Falešný poplach u legitimních nabídek: ' + pct(m.falesny_poplach));
  L.push('- Nelze posoudit (šedá nebo žádost o víc údajů), všechny případy: ' + pct(m.neurceno));
  L.push('- Nelze posoudit u podvodů: ' + pct(m.neurceno_podvod) + ', u legitimních nabídek: ' + pct(m.neurceno_ok));
  L.push('- Chyby požadavků: ' + m.chyby);
  L.push('', '## Matice (skutečnost x výsledek)', '');
  L.push('| Skutečnost | zelená | oranžová/červená | neurčeno | chyba |', '|---|---|---|---|---|');
  for (const l of LABELS) L.push('| ' + l + ' | ' + cm[l].ok + ' | ' + cm[l].rizikove + ' | ' + cm[l].neurceno + ' | ' + cm[l].chyba + ' |');
  L.push('', '## Nejčastější signály', '');
  const top = topSignals(list, 10);
  if (!top.length) L.push('Žádné signály.');
  else {
    L.push('| Signál | Počet případů | ok / sporné / podvod |', '|---|---|---|');
    for (const t of top) L.push('| ' + t.id + ' | ' + t.count + ' | ' + t.per_label.ok + ' / ' + t.per_label.sporne + ' / ' + t.per_label.podvod + ' |');
  }
  L.push('', '## Chybně zařazené případy', '');
  const wrong = list.filter((r) => r && ((r.label === 'podvod' && resultClass(r) !== 'rizikove') || (r.label === 'ok' && resultClass(r) !== 'ok')));
  if (!wrong.length) L.push('Žádné.');
  for (const r of wrong) {
    const cls = resultClass(r);
    const got = cls === 'chyba' ? 'chyba' : (r.semafor || r.stav);
    const detail = cls === 'chyba' ? oneLine(r.chyba || 'bez popisu') : 'signály: ' + sigText(r);
    L.push('- ' + r.id + ' (' + r.label + ' -> ' + got + (r.skore !== undefined && r.skore !== null ? ', skóre ' + r.skore : '') + '): ' + detail);
  }
  const sporne = list.filter((r) => r && r.label === 'sporne');
  L.push('', '## Sporné případy (do metrik se nepočítají)', '');
  if (!sporne.length) L.push('Žádné.');
  for (const r of sporne) {
    const cls = resultClass(r);
    L.push('- ' + r.id + ': ' + (cls === 'chyba' ? 'chyba, ' + oneLine(r.chyba || 'bez popisu') : (r.semafor || r.stav) + ', signály: ' + sigText(r)));
  }
  return L.join('\n') + '\n';
}

module.exports = { mimeFromName, buildRequestBody, toResultRecord, parseArgs, selectCases, renderReport };
