const MAX_DENNE = 200;
const body = $input.first().json.body || {};
const state = $getWorkflowStaticData('global');
const v = validateInput(body);
if (!v.ok) return [{ json: { zkratka: true, status: v.status, odpoved: { stav: 'chyba', chyba: v.chyba } } }];
const q = checkQuota(state, Date.now(), MAX_DENNE);
if (!q.ok) return [{ json: { zkratka: true, status: 429, odpoved: { stav: 'chyba', chyba: 'Dnešní limit kontrol byl vyčerpán. Zkuste to prosím zítra.' } } }];

const input = v.input;
let pageText = '';
let pageStatus = 'bez_odkazu';
if (input.url) {
  try {
    // Přesměrování se nenásledují (cíl by mohl být interní adresa, kterou normalizeUrl zablokoval).
    const r = await this.helpers.httpRequest({
      url: input.url.url, method: 'GET', timeout: 10000, encoding: 'text',
      disableFollowRedirect: true, ignoreHttpStatusErrors: true, returnFullResponse: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (NakupniKontrola)', 'Accept-Language': 'cs' },
    });
    if (r && r.statusCode >= 200 && r.statusCode < 300) {
      pageText = htmlToText(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      pageStatus = pageText.length >= 300 ? 'nacteno' : 'prilis_kratke';
    } else {
      pageStatus = 'nenacteno';
    }
  } catch (e) { pageStatus = 'nenacteno'; }
}
if (pageStatus !== 'nacteno') pageText = '';
const hasUsable = input.text || input.screenshoty.length || pageStatus === 'nacteno';
if (!hasUsable) {
  const zprava = 'Stránku se nepodařilo načíst (marketplace často blokují automatické čtení). Vložte prosím screenshot nabídky nebo zkopírovaný text.';
  return [{ json: { zkratka: true, status: 200, odpoved: needMoreInput(zprava) } }];
}
return [{ json: { zkratka: false, input, pageText, rezim: input.url ? input.url.rezim : 'neznámé', host: input.url ? input.url.host : null } }];
