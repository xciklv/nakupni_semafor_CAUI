// Id modelu obrázků se dosazuje při sestavení (LLM_MODEL_IMAGES); výchozí hodnota = LLM_MODEL_IMAGES_DEFAULT v engine/images.js.
const MODEL_IMAGES = 'claude-haiku-5-5';
// Obrázky z nabídky stahuje a zmenšuje lokální čtečka (cesta /images; adresa se odvodí z PAGE_READER_URL, prázdný řetězec = vypnuto).
// Čtečka kontroluje adresy proti SSRF, n8n se k obrázkům nepřipojuje. Odpovědí je jedna položka na každé z IMG_RUNS opakování se stejným požadavkem
// (hlasování většinou ukáže jen to, co model vidí opakovaně). Selhání = jediná položka bez požadavku; Souhrn ji zapíše jako přeskočenou analýzu.
const PAGE_READER_URL = 'http://127.0.0.1:5687/read';
const PAGE_IMAGES_URL = PAGE_READER_URL.replace(/\/read$/, '/images');
const IMAGES_DEADLINE_MS = 45000;
const IMAGES_FETCH_MAX = 8;
try {
  const dossier = $('Moduly').first().json.dossier;
  const urls = (Array.isArray(dossier.obrazky) ? dossier.obrazky : []).map((i) => i && i.url).filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, IMAGES_FETCH_MAX);
  if (!PAGE_READER_URL || !urls.length) return [{ json: { llmRequest: null } }];
  const req = Promise.resolve(this.helpers.httpRequest({ method: 'POST', url: PAGE_IMAGES_URL, headers: { 'X-Nakupni-Kontrola': '1' }, body: { urls }, json: true,
    timeout: IMAGES_DEADLINE_MS, ignoreHttpStatusErrors: true, returnFullResponse: true }));
  req.catch(() => {});
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), IMAGES_DEADLINE_MS); });
  let r;
  try { r = await Promise.race([req, deadline]); } finally { clearTimeout(timer); }
  const b = r && r.statusCode === 200 && r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null;
  const obrazky = b && b.ok === true && Array.isArray(b.obrazky) ? b.obrazky.filter((o) => o && typeof o.url === 'string' && typeof o.data === 'string' && o.data) : [];
  if (!obrazky.length) return [{ json: { llmRequest: null } }];
  const llmRequest = buildImagesRequest(dossier, obrazky, MODEL_IMAGES);
  const odeslane = obrazky.slice(0, IMG_MAX).map((o) => ({ url: o.url }));
  return Array.from({ length: IMG_RUNS }, () => ({ json: { llmRequest, obrazky: odeslane } }));
} catch (e) {
  return [{ json: { llmRequest: null } }];
}
