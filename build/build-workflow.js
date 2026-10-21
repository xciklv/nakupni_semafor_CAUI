const fs = require('node:fs');
const path = require('node:path');

const ENGINE = ['signals', 'scoring', 'input', 'llm', 'dossier', 'offer', 'seller', 'identity', 'safety', 'plausibility', 'images', 'explain'];
const root = path.join(__dirname, '..');
// Výchozí modely mají jediný zdroj pravdy v enginu (testované konstanty).
const MODEL_EXTRACT_DEFAULT = require('../engine/llm').LLM_MODEL_EXTRACT_DEFAULT;
const MODEL_EXPLAIN_DEFAULT = require('../engine/explain').LLM_MODEL_EXPLAIN_DEFAULT;
const MODEL_PLAUSIBILITY_DEFAULT = require('../engine/plausibility').LLM_MODEL_PLAUSIBILITY_DEFAULT;
const MODEL_IMAGES_DEFAULT = require('../engine/images').LLM_MODEL_IMAGES_DEFAULT;
const CRED_NAME_DEFAULT = 'Anthropic account';
// Čtečka stránek (tools/page-reader): lokální služba, kterou krok "Vstup a načtení" volá pro marketplace. Smí mířit jen na 127.0.0.1.
const PAGE_READER_URL_DEFAULT = 'http://127.0.0.1:5687/read';

// Spojí moduly enginu do jednoho scope; jednořádkové require/module.exports guardy odstraní.
function buildBundle() {
  return ENGINE
    .map((f) => fs.readFileSync(path.join(root, 'engine', f + '.js'), 'utf8'))
    .join('\n')
    .replace(/^if \(typeof (require|module) !== 'undefined'.*$/gm, '');
}

const QUOTA_DEFAULT = 200;
// Denní limit kontrol (1..100000). Neplatná hodnota -> výchozí 200 s varováním; nedefinovaná/prázdná hodnota -> výchozí bez varování.
function resolveQuota(v, warn = console.warn) {
  if (v === undefined || v === null || v === '') return QUOTA_DEFAULT;
  const t = String(v).trim();
  const n = /^[0-9]+$/.test(t) ? Number(t) : NaN;
  if (Number.isInteger(n) && n >= 1 && n <= 100000) return n;
  warn('QUOTA_PER_DAY="' + v + '" není celé číslo 1..100000, použije se ' + QUOTA_DEFAULT + '.');
  return QUOTA_DEFAULT;
}

// Id modelu (LLM_MODEL_EXTRACT / _EXPLAIN / _PLAUSIBILITY / _IMAGES): /^[A-Za-z0-9._:-]{1,64}$/. Neplatná hodnota -> výchozí s varováním; nedefinovaná/prázdná -> výchozí bez varování.
function resolveModel(v, def, envName, warn = console.warn) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v)) {
    if (!v.startsWith('claude-')) warn(envName + ': ' + v + ' is not a Claude model; the request always sends output_config (effort low, json_schema format) and may be rejected with HTTP 400 — override only with Claude 5.5 models (claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5).');
    return v;
  }
  warn(envName + '="' + String(v).slice(0, 80) + '" není platné id modelu (A-Z a-z 0-9 . _ : -, 1..64 znaků), použije se ' + def + '.');
  return def;
}

// Adresa čtečky stránek (PAGE_READER_URL): jen http://127.0.0.1:PORT/read; '' nebo 'off' = vypnuto; nedefinovaná = výchozí; jiná hodnota -> výchozí s varováním.
function resolvePageReaderUrl(v, warn = console.warn) {
  if (v === undefined || v === null) return PAGE_READER_URL_DEFAULT;
  if (v === '' || v === 'off') return '';
  if (typeof v === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/read$/.test(v)) return v;
  warn('PAGE_READER_URL="' + String(v).slice(0, 80) + '" není http://127.0.0.1:PORT/read ani off, použije se ' + PAGE_READER_URL_DEFAULT + '.');
  return PAGE_READER_URL_DEFAULT;
}

// Hodnota limitu a ids modelů se dosazují do zdroje glue při sestavení (v běhu Code nodu žádný přístup k env není).
// Modely jsou ověřené regulárním výrazem (bez uvozovek a zpětných lomítek), replacer-funkce chrání před speciálními vzory v náhradě.
const glue = (f, o = {}) => fs.readFileSync(path.join(__dirname, 'glue', f), 'utf8')
  .replace(/^(\s*const MAX_DENNE = )\d+;/m, (m, p) => p + (o.quota === undefined ? QUOTA_DEFAULT : o.quota) + ';')
  .replace(/^(\s*const PAGE_READER_URL = )'[^']*';/m, (m, p) => p + "'" + (o.pageReaderUrl === undefined ? PAGE_READER_URL_DEFAULT : o.pageReaderUrl) + "';")
  .replace(/^(\s*const MODEL_EXTRACT = )'[^']*';/m, (m, p) => p + "'" + (o.modelExtract || MODEL_EXTRACT_DEFAULT) + "';")
  .replace(/^(\s*const MODEL_EXPLAIN = )'[^']*';/m, (m, p) => p + "'" + (o.modelExplain || MODEL_EXPLAIN_DEFAULT) + "';")
  .replace(/^(\s*const MODEL_PLAUSIBILITY = )'[^']*';/m, (m, p) => p + "'" + (o.modelPlausibility || MODEL_PLAUSIBILITY_DEFAULT) + "';")
  .replace(/^(\s*const MODEL_IMAGES = )'[^']*';/m, (m, p) => p + "'" + (o.modelImages || MODEL_IMAGES_DEFAULT) + "';");
// Code nody nesdílejí scope, proto KAŽDÝ nese celý bundle enginu.
const code = (name, file, pos, o) => ({
  id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: buildBundle() + '\n' + glue(file, o) },
});
const llm = (name, pos, credId, credName) => ({
  id: name, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, onError: 'continueRegularOutput',
  parameters: {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.llmRequest) }}',
    options: { timeout: 60000 },
  },
  credentials: { anthropicApi: { id: credId, name: credName } },
});

// Ukládání exekucí (volba SAVE_EXECUTIONS): 'all' = ukládá se vše (ladění, výchozí), 'none' = nic se po doběhu neukládá (soukromí).
const SAVE_EXECUTIONS_DEFAULT = 'all';
function resolveSaveExecutions(v, warn = console.warn) {
  if (v === undefined || v === null || v === '') return SAVE_EXECUTIONS_DEFAULT;
  if (v === 'all' || v === 'none') return v;
  warn('SAVE_EXECUTIONS="' + String(v).slice(0, 40) + '" není all ani none, použije se ' + SAVE_EXECUTIONS_DEFAULT + '.');
  return SAVE_EXECUTIONS_DEFAULT;
}

// IF uzel s jednou booleovskou podmínkou (strict): pravda = výstup 0, nepravda = výstup 1.
const boolIf = (name, pos, condId, leftValue, operation) => ({
  id: name, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
    conditions: [{ id: condId, leftValue, rightValue: operation === 'true', operator: { type: 'boolean', operation, singleValue: true } }], combinator: 'and' } },
});

function buildWorkflow({ credId, credName = CRED_NAME_DEFAULT, quotaPerDay, modelExtract, modelExplain, modelPlausibility, modelImages, saveExecutions, pageReaderUrl }) {
  const quota = resolveQuota(quotaPerDay);
  const reader = resolvePageReaderUrl(pageReaderUrl);
  const save = resolveSaveExecutions(saveExecutions);
  const mExtract = resolveModel(modelExtract, MODEL_EXTRACT_DEFAULT, 'LLM_MODEL_EXTRACT');
  const mExplain = resolveModel(modelExplain, MODEL_EXPLAIN_DEFAULT, 'LLM_MODEL_EXPLAIN');
  const mPlausibility = resolveModel(modelPlausibility, MODEL_PLAUSIBILITY_DEFAULT, 'LLM_MODEL_PLAUSIBILITY');
  const mImages = resolveModel(modelImages, MODEL_IMAGES_DEFAULT, 'LLM_MODEL_IMAGES');
  const nodes = [
    // allowedOrigins '*': HTML servírované z webhooku běží v CSP sandboxu bez allow-same-origin (n8n-core html-sandbox.js),
    // takže jeho origin je 'null' a fetch na tento webhook je cross-origin.
    { id: 'Webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [80, 0], webhookId: '2477b1ff-1caf-474d-9db3-1104c8e3ca48',
      parameters: { httpMethod: 'POST', path: 'nakupni-kontrola', responseMode: 'responseNode', options: { allowedOrigins: '*' } } },
    code('Vstup a načtení', '01-vstup.js', [224, 0], { quota, pageReaderUrl: reader }),
    boolIf('Stačí vstup?', [368, 0], 'c1', '={{ $json.zkratka }}', 'false'),
    // Čtečka vrátila hotový dossier: extrakce textu modelem se přeskočí.
    boolIf('Máme dossier?', [512, 0], 'c3', '={{ !!$json.dossier }}', 'true'),
    // Bez obsahu (jen URL e-shopu) se LLM extrakce přeskočí: Moduly provedou aspoň kontroly hostitele.
    boolIf('Je obsah?', [656, -16], 'c2', '={{ $json.obsah }}', 'true'),
    code('Sestavit extrakci', '02-extrakce-req.js', [864, -96], { modelExtract: mExtract }),
    llm('LLM – extrakce', [1056, -96], credId, credName),
    code('Moduly', '03-moduly.js', [1264, 0]),
    code('Sestavit věrohodnost', '05-verohodnost.js', [1408, 0], { modelPlausibility: mPlausibility }),
    llm('LLM – věrohodnost', [1552, 0], credId, credName),
    // Obrázky jdou k analýze jen tehdy, když je dossier má; výraz čte Moduly, protože výstupem předchozího uzlu je odpověď modelu.
    boolIf('Jsou obrázky?', [1696, 0], 'c4', "={{ $('Moduly').first().json.mameObrazky }}", 'true'),
    code('Obrázky – příprava', '06-obrazky.js', [1888, -96], { modelImages: mImages, pageReaderUrl: reader }),
    llm('LLM – obrázky', [2080, -96], credId, credName),
    code('Souhrn', '07-souhrn.js', [2304, 0], { modelExplain: mExplain }),
    llm('LLM – vysvětlení', [2448, 0], credId, credName),
    code('Odpověď', '04-odpoved.js', [2592, 0]),
    { id: 'Respond', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [2736, 0],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.odpoved) }}', options: { responseCode: '={{ $json.status }}' } } },
    { id: 'Respond – více vstupu', name: 'Respond – více vstupu', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [512, 128],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.odpoved) }}', options: { responseCode: '={{ $json.status }}' } } },
  ];
  const link = (a, b, out = 0) => ({ [a]: { main: [...Array(out).fill([]), [{ node: b, type: 'main', index: 0 }]] } });
  // IF: [cíl při pravdě, cíl při nepravdě]
  const branch = (a, whenTrue, whenFalse) => ({ [a]: { main: [[{ node: whenTrue, type: 'main', index: 0 }], [{ node: whenFalse, type: 'main', index: 0 }]] } });
  const connections = {
    ...link('Webhook', 'Vstup a načtení'),
    ...link('Vstup a načtení', 'Stačí vstup?'),
    ...branch('Stačí vstup?', 'Máme dossier?', 'Respond – více vstupu'),
    ...branch('Máme dossier?', 'Moduly', 'Je obsah?'),
    ...branch('Je obsah?', 'Sestavit extrakci', 'Moduly'),
    ...link('Sestavit extrakci', 'LLM – extrakce'),
    ...link('LLM – extrakce', 'Moduly'),
    ...link('Moduly', 'Sestavit věrohodnost'),
    ...link('Sestavit věrohodnost', 'LLM – věrohodnost'),
    ...link('LLM – věrohodnost', 'Jsou obrázky?'),
    ...branch('Jsou obrázky?', 'Obrázky – příprava', 'Souhrn'),
    ...link('Obrázky – příprava', 'LLM – obrázky'),
    ...link('LLM – obrázky', 'Souhrn'),
    ...link('Souhrn', 'LLM – vysvětlení'),
    ...link('LLM – vysvětlení', 'Odpověď'),
    ...link('Odpověď', 'Respond'),
  };
  return { name: 'Nákupní kontrola', nodes, connections, settings: {
    executionOrder: 'v1',
    // Ukládání exekucí řídí SAVE_EXECUTIONS: 'all' (výchozí, ladění; rozhodnutí 2026-10-17) ukládá nabídky, screenshoty i výsledky lokálně v n8n,
    // 'none' nic neukládá (soukromí). Průběh se neukládá ani v jednom režimu.
    saveDataSuccessExecution: save, saveDataErrorExecution: save, saveManualExecutions: save === 'all', saveExecutionProgress: false,
  } };
}

// Webová stránka je samostatný workflow (jeden webhook = jeden workflow): GET webhook vrací web/index.html a nic jiného. Nezávisí na API ani na credentialech,
// importuje se a aktivuje zvlášť. Stránka si adresu API odvodí ze své adresy (nakupni-kontrola-web -> nakupni-kontrola), takže cesty obou webhooků musí zůstat.
// Úspěšné načtení stránky se neukládá (nezaplevelí seznam exekucí API), chyby ano. responseBody je text bez výrazu (nezačíná '=', nemá '{{').
function buildWebWorkflow() {
  const nodes = [
    { id: 'Webhook – stránka', name: 'Webhook – stránka', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: '6f1c3a52-9b7e-4d2a-8c41-3e5b7a9d0f26',
      parameters: { httpMethod: 'GET', path: 'nakupni-kontrola-web', responseMode: 'responseNode', options: {} } },
    { id: 'Respond – stránka', name: 'Respond – stránka', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [220, 0],
      parameters: { respondWith: 'text', responseBody: fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8'),
        options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] } } } },
  ];
  const connections = { 'Webhook – stránka': { main: [[{ node: 'Respond – stránka', type: 'main', index: 0 }]] } };
  return { name: 'Nákupní kontrola – web', nodes, connections, settings: {
    executionOrder: 'v1', saveDataSuccessExecution: 'none', saveDataErrorExecution: 'all', saveManualExecutions: false, saveExecutionProgress: false,
  } };
}

// Volby sestavení z prostředí. Bez id credentialu (ANTHROPIC_CRED_ID, záloha CRED_ID) vrací null.
function cliOptions(env) {
  const credId = env.ANTHROPIC_CRED_ID || env.CRED_ID;
  if (!credId) return null;
  return { credId, credName: env.ANTHROPIC_CRED_NAME || CRED_NAME_DEFAULT, quotaPerDay: env.QUOTA_PER_DAY, modelExtract: env.LLM_MODEL_EXTRACT, modelExplain: env.LLM_MODEL_EXPLAIN, modelPlausibility: env.LLM_MODEL_PLAUSIBILITY, modelImages: env.LLM_MODEL_IMAGES, saveExecutions: env.SAVE_EXECUTIONS, pageReaderUrl: env.PAGE_READER_URL };
}

if (require.main === module) {
  const opts = cliOptions(process.env);
  if (!opts) { console.error('Nastav ANTHROPIC_CRED_ID (id credentialu typu anthropicApi z n8n; záloha: CRED_ID).'); process.exit(1); }
  const wf = buildWorkflow(opts);
  fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify(wf, null, 2));
  console.log('workflow.json (API) zapsán, nodů:', wf.nodes.length);
  const web = buildWebWorkflow();
  fs.writeFileSync(path.join(root, 'workflow-web.json'), JSON.stringify(web, null, 2));
  console.log('workflow-web.json (stránka) zapsán, nodů:', web.nodes.length);
}

module.exports = { buildBundle, buildWorkflow, buildWebWorkflow, resolveQuota, resolveModel, resolveSaveExecutions, resolvePageReaderUrl, cliOptions, PAGE_READER_URL_DEFAULT, MODEL_EXTRACT_DEFAULT, MODEL_EXPLAIN_DEFAULT, MODEL_PLAUSIBILITY_DEFAULT, MODEL_IMAGES_DEFAULT };
