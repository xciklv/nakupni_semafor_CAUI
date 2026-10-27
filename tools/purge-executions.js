#!/usr/bin/env node
'use strict';
// Mazání uložených průběhů Nákupního semaforu z lokálního n8n.
//
// Proč: n8n si pro ladění ukládá průběhy kontrol včetně odeslaných textů stránek (u Allegra může text obsahovat jméno
// přihlášeného účtu). Lokální uložení je v pořádku, ale data musí jít odstranit. Jsou na to tři cesty:
//   1. Ukládání vypnout: sestavit workflow s SAVE_EXECUTIONS=none (SAVE_EXECUTIONS=none node build/build-workflow.js a znovu
//      nasadit; viz resolveSaveExecutions v build/build-workflow.js). Průběhy kontroly se pak neukládají.
//   2. Staré průběhy mazat samo: nastavení n8n EXECUTIONS_DATA_PRUNE=true a EXECUTIONS_DATA_MAX_AGE=<hodiny>
//      (např. 24 = nechat jen poslední den). Platí pro všechny workflow v dané instanci n8n.
//   3. Tento skript: smaže průběhy obou workflow Nákupního semaforu přes veřejné API n8n.
//
// Použití (bez --yes se nic nesmaže, jen se vypíše, kolik průběhů by se smazalo):
//   N8N_API_KEY=<klíč> node tools/purge-executions.js                          výpis (dry-run)
//   N8N_API_KEY=<klíč> node tools/purge-executions.js --yes                    smaže všechny průběhy
//   N8N_API_KEY=<klíč> node tools/purge-executions.js --yes --older-than-hours 24   smaže jen starší než 24 hodin
//   (v PowerShellu: $env:N8N_API_KEY = '<klíč>'; node tools/purge-executions.js)
// Klíč se vytvoří v n8n (Settings → n8n API) a čte se jen z proměnné prostředí N8N_API_KEY; repo ho nikdy nečte ani
// neukládá a skript ho nikam nevypisuje. Skript mluví jen s 127.0.0.1 nebo localhost (výchozí http://127.0.0.1:5678).
// Při --older-than-hours se průběh bez čitelného času startu nemaže.
// ID workflow platí, jen když se workflow importovala podle README. Skript proto nejdřív ověří, že existují; když žádné z nich ne, najde workflow
// podle názvu, a když ani to nevyjde, řekne to nahlas (jinak by „smazáno 0“ vypadalo jako úspěch).
// ID a názvy zapisuje do workflow build, odtud je čteme, aby se nerozešly.
const { WORKFLOW_API, WORKFLOW_WEB } = require('../build/build-workflow');
const WORKFLOWS = [WORKFLOW_API, WORKFLOW_WEB].map(({ id, name }) => ({ id, name }));
const WORKFLOW_IDS = WORKFLOWS.map((w) => w.id);
const WORKFLOW_NAMES = WORKFLOWS.map((w) => w.name);
const DEFAULT_BASE_URL = 'http://127.0.0.1:5678';
const PAGE_LIMIT = 100;
const MAX_PAGES = 1000;

// Hodnota klíče se z textu vždy vyřízne; chybové zprávy z API ani ze sítě ji tak nemohou prozradit.
function redact(text, apiKey) {
  const s = String(text);
  return apiKey ? s.split(apiKey).join('***') : s;
}

function checkBaseUrl(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch (e) { throw new Error('baseUrl není platná adresa'); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password
    || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) {
    throw new Error('baseUrl smí mířit jen na 127.0.0.1 nebo localhost');
  }
  return u.origin;
}

async function listExecutions({ origin, apiKey, workflowId, fetchImpl }) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${origin}/api/v1/executions?workflowId=${encodeURIComponent(workflowId)}&limit=${PAGE_LIMIT}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'X-N8N-API-KEY': apiKey, Accept: 'application/json' } });
    } catch (e) {
      throw new Error(`výpis průběhů selhal: ${redact(e && e.message, apiKey)}`);
    }
    if (!res.ok) throw new Error(`výpis průběhů selhal: HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch (e) { throw new Error('výpis průběhů selhal: odpověď není JSON'); }
    const data = body && Array.isArray(body.data) ? body.data : [];
    for (const ex of data) if (ex && ex.id !== undefined && ex.id !== null) out.push({ id: ex.id, startedAt: ex.startedAt });
    const next = body && body.nextCursor;
    if (!next) return out;
    if (seen.has(next)) throw new Error('stránkování se zacyklilo (kurzor se opakuje)');
    seen.add(next);
    cursor = next;
  }
  throw new Error('stránkování přesáhlo bezpečný počet stránek');
}

async function apiGet({ origin, apiKey, path, fetchImpl, co }) {
  try {
    return await fetchImpl(`${origin}${path}`, { headers: { 'X-N8N-API-KEY': apiKey, Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`${co} selhalo: ${redact(e && e.message, apiKey)}`);
  }
}

// Ověří, že workflow existují. Každé workflow se hledá podle ID z README; kterému ID v n8n neodpovídá nic, to se dohledá podle názvu
// (jen čtení, použije se jen id a název; shodných názvů může být víc, použijí se všechny). Vrací { ids, nenalezena, podleNazvu }:
// ids = workflow, jejichž průběhy se mají mazat; nenalezena = workflow, která není ani podle ID, ani podle názvu; podleNazvu = dohledaná id.
// Když se nenašlo žádné, vyhodí chybu.
async function resolveWorkflowIds({ baseUrl = DEFAULT_BASE_URL, apiKey, workflows, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('chybí apiKey (proměnná prostředí N8N_API_KEY)');
  if (!Array.isArray(workflows) || !workflows.length) throw new Error('chybí seznam workflow (workflows)');
  const origin = checkBaseUrl(baseUrl);
  const ids = [];
  const hledat = [];
  for (const w of workflows) {
    const res = await apiGet({ origin, apiKey, path: `/api/v1/workflows/${encodeURIComponent(w.id)}`, fetchImpl, co: 'ověření workflow' });
    if (res.ok) ids.push(w.id);
    else if (res.status === 404) hledat.push(w);
    else throw new Error(`ověření workflow selhalo: HTTP ${res.status}`);
  }
  const podleNazvu = [];
  const nenalezena = [];
  if (hledat.length) {
    const vsechna = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await apiGet({ origin, apiKey, path: `/api/v1/workflows?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, fetchImpl, co: 'výpis workflow' });
      if (!res.ok) throw new Error(`výpis workflow selhal: HTTP ${res.status}`);
      let body;
      try { body = await res.json(); } catch (e) { throw new Error('výpis workflow selhal: odpověď není JSON'); }
      for (const x of body && Array.isArray(body.data) ? body.data : []) if (x && x.id !== undefined && x.id !== null) vsechna.push({ id: String(x.id), name: x.name });
      const next = body && body.nextCursor;
      if (!next) break;
      if (seen.has(next)) throw new Error('stránkování workflow se zacyklilo (kurzor se opakuje)');
      seen.add(next);
      cursor = next;
    }
    for (const w of hledat) {
      const nalezena = vsechna.filter((x) => x.name === w.name).map((x) => x.id).filter((id) => !ids.includes(id));
      if (nalezena.length) { ids.push(...nalezena); podleNazvu.push(...nalezena); } else nenalezena.push(w);
    }
  }
  if (!ids.length) {
    throw new Error(`workflow Nákupního semaforu v n8n (${origin}) nenalezena: ID ${workflows.map((w) => w.id).join(', ')} neexistují a podle názvu (${workflows.map((w) => `„${w.name}“`).join(', ')}) se také nic nenašlo. Nic se nesmazalo. Je to ta správná instance n8n a jsou workflow naimportovaná?`);
  }
  return { ids, nenalezena, podleNazvu };
}

async function purgeExecutions({ baseUrl = DEFAULT_BASE_URL, apiKey, workflowIds, olderThanHours = 0, dryRun = true, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('chybí apiKey (proměnná prostředí N8N_API_KEY)');
  if (!Array.isArray(workflowIds) || !workflowIds.length) throw new Error('chybí seznam workflow (workflowIds)');
  if (typeof olderThanHours !== 'number' || !Number.isFinite(olderThanHours) || olderThanHours < 0) {
    throw new Error('olderThanHours musí být nezáporné číslo');
  }
  const origin = checkBaseUrl(baseUrl);

  const found = [];
  for (const workflowId of workflowIds) found.push(...await listExecutions({ origin, apiKey, workflowId, fetchImpl }));

  const cutoff = Date.now() - olderThanHours * 3600 * 1000;
  const targets = olderThanHours > 0
    ? found.filter((ex) => { const t = Date.parse(ex.startedAt); return Number.isFinite(t) && t <= cutoff; })
    : found;

  const result = { nalezeno: targets.length, smazano: 0, chyby: [] };
  if (dryRun) return result;

  for (const ex of targets) {
    try {
      const res = await fetchImpl(`${origin}/api/v1/executions/${encodeURIComponent(ex.id)}`, {
        method: 'DELETE',
        headers: { 'X-N8N-API-KEY': apiKey, Accept: 'application/json' },
      });
      if (res.ok) result.smazano++;
      else result.chyby.push(`průběh ${ex.id}: HTTP ${res.status}`);
    } catch (e) {
      result.chyby.push(`průběh ${ex.id}: ${redact(e && e.message, apiKey)}`);
    }
  }
  return result;
}

function parseArgs(argv) {
  const out = { yes: false, olderThanHours: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') { out.yes = true; continue; }
    let value;
    if (a === '--older-than-hours') value = argv[++i];
    else if (a.startsWith('--older-than-hours=')) value = a.slice('--older-than-hours='.length);
    else throw new Error('neznámý argument; použití: node tools/purge-executions.js [--yes] [--older-than-hours N]');
    const n = Number(value);
    if (value === undefined || value === '' || !Number.isFinite(n) || n < 0) throw new Error('--older-than-hours vyžaduje nezáporné číslo');
    out.olderThanHours = n;
  }
  return out;
}

async function main(argv, env, { fetchImpl } = {}) {
  const apiKey = env.N8N_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    console.error('Chybí proměnná prostředí N8N_API_KEY (klíč k API n8n, Settings → n8n API). Klíč se nikam neukládá.');
    return 1;
  }
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  const kdy = args.olderThanHours > 0 ? ` starších než ${args.olderThanHours} h` : '';
  try {
    const w = await resolveWorkflowIds({ apiKey, workflows: WORKFLOWS, fetchImpl });
    if (w.podleNazvu.length) console.log(`ID workflow z README v n8n neexistují; použila se workflow nalezená podle názvu (${w.podleNazvu.join(', ')}).`);
    const r = await purgeExecutions({ apiKey, workflowIds: w.ids, olderThanHours: args.olderThanHours, dryRun: !args.yes, fetchImpl });
    let kod = 0;
    if (!args.yes) console.log(`Nalezeno ${r.nalezeno} průběhů${kdy}. Nic se nesmazalo; pro smazání přidej --yes.`);
    else console.log(`Nalezeno ${r.nalezeno} průběhů${kdy}, smazáno ${r.smazano}.`);
    for (const c of r.chyby) { console.error(`Chyba: ${c}`); kod = 1; }
    for (const n of w.nenalezena) {
      console.error(`Chyba: workflow „${n.name}“ (ID ${n.id}) není v n8n ani podle ID, ani podle názvu; jeho průběhy nejsou ve výpisu ani se nemazaly. Zkontrolujte, že je naimportované.`);
      kod = 1;
    }
    return kod;
  } catch (e) {
    console.error(`Chyba: ${redact(e.message, apiKey)}`);
    return 1;
  }
}

module.exports = { purgeExecutions, resolveWorkflowIds, parseArgs, main, WORKFLOW_IDS, WORKFLOW_NAMES, WORKFLOWS };

if (require.main === module) main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
