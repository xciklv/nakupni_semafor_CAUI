'use strict';
// Analýza obrázků jedné nabídky přes n8n webhook (workflow „Test – obrázky spike“, cesta test-obrazky-spike, klíč drží n8n, tady není).
// Vstup: složka z fetch-page.js + select-images.js (images.json, NN.jpg, page-text.txt).
//   node tools/image-check/analyze.js <dir> [--model haiku|sonnet] [--runs 3] [--only 1,3] [--edge 768] [--count]
//        [--start 4] [--title "text nabídky místo skutečného"] [--url http://127.0.0.1:5678/webhook/test-obrazky-spike] [--tag nazev]
// --count        jen spočítá vstupní tokeny (endpoint count_tokens, zdarma), nic negeneruje
// --start       číslo prvního opakování v názvu souboru (aby další dávka nepřepsala předchozí)
// --only         jen vybraná čísla obrázků (jeden obrázek: --only 2)
// --title        přepíše text nabídky (negativní kontrola: obrázky patří k jiné nabídce)
// Výstupy: <dir>/runs/<tag>-<model>-e<edge>-<k>.json (odpověď API + usage + cena).
const fs = require('node:fs');
const path = require('node:path');
const { buildRequest, cost } = require('./prompt');
const { openPixelTool } = require('./lib');

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' };
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

// Text nabídky pro model: titulek + prvních ~2000 znaků viditelného textu stránky (cena, parametry, popis).
function offerTextOf(dir, max = 2200) {
  const t = fs.readFileSync(path.join(dir, 'page-text.txt'), 'utf8');
  return t.slice(0, max);
}

async function callWebhook(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { error: { message: 'neplatná odpověď webhooku: ' + text.slice(0, 200) } }; }
}

async function main() {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) { console.error('použití: node analyze.js <dir> [--model haiku|sonnet] [--runs N] [--only 1,2] [--edge 768] [--count] [--title ...]'); process.exit(2); }
  const model = MODELS[arg('model', 'haiku')];
  if (!model) { console.error('model: haiku nebo sonnet'); process.exit(2); }
  const runs = Number(arg('runs', 1)), edge = Number(arg('edge', 768)), count = arg('count', false) === true;
  const url = arg('url', 'http://127.0.0.1:5678/webhook/test-obrazky-spike');
  const tag = arg('tag', 'a');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'images.json'), 'utf8'));
  let items = meta.items.filter((x) => x.file);
  const only = arg('only', null);
  if (only && only !== true) { const set = new Set(String(only).split(',').map((s) => s.padStart(2, '0'))); items = items.filter((x) => set.has(x.n)); }
  if (!items.length) { console.error('žádné obrázky'); process.exit(2); }

  // Obrázek se posílá v požadované velikosti: 768 = uložený NN.jpg, jinak se znovu zmenší z orig/.
  const images = [];
  let tool = null;
  try {
    for (const it of items) {
      if (edge === 768) { images.push({ mime: 'image/jpeg', data: fs.readFileSync(path.join(dir, it.file)).toString('base64') }); continue; }
      tool = tool || await openPixelTool();
      const origName = fs.readdirSync(path.join(dir, 'orig')).find((f) => f.startsWith(it.n + '.'));
      const r = await tool.resize(fs.readFileSync(path.join(dir, 'orig', origName)), edge);
      images.push({ mime: 'image/jpeg', data: r.buf.toString('base64') });
    }
  } finally { if (tool) await tool.close(); }

  const titleOverride = arg('title', null);
  const offerText = titleOverride && titleOverride !== true ? titleOverride : offerTextOf(dir);
  const outDir = path.join(dir, 'runs');
  fs.mkdirSync(outDir, { recursive: true });
  const { countOnly, ...req } = buildRequest({ model, images, offerText, countOnly: count });
  let total = 0;
  const start = Number(arg('start', 1));
  for (let k = start; k < start + (count ? 1 : runs); k++) {
    const t0 = Date.now();
    const res = await callWebhook(url, { ...req, countOnly: count });
    const ms = Date.now() - t0;
    if (res.error || res.type === 'error') { console.error('chyba API:', JSON.stringify(res.error || res).slice(0, 400)); process.exit(1); }
    if (count) { console.log(JSON.stringify({ model, images: images.length, edge, input_tokens: res.input_tokens })); return; }
    const usage = res.usage || {};
    const c = cost(model, usage);
    total += c;
    const textBlock = (res.content || []).find((b) => b.type === 'text');
    let parsed = null;
    try { parsed = JSON.parse(textBlock.text); } catch (e) { /* zůstane null */ }
    fs.writeFileSync(path.join(outDir, tag + '-' + model.replace('claude-', '') + '-e' + edge + '-' + k + '.json'), JSON.stringify({ model, edge, images: items.map((x) => x.n), stop_reason: res.stop_reason, usage, cost_usd: c, ms, parsed, raw: parsed ? undefined : res }, null, 1));
    console.log(JSON.stringify({ run: k, model, images: images.length, edge, in: usage.input_tokens, out: usage.output_tokens, usd: +c.toFixed(5), ms, stop: res.stop_reason, ok: !!parsed }));
  }
  if (!count) console.log('cena celkem USD ' + total.toFixed(5));
}
main().catch((e) => { console.error(e.message); process.exit(1); });
