// Denní kvóta: počítá se po validaci vstupu a PŘED načtením stránky, takže i odpověď 'potrebuji_vice' spotřebuje jednu kontrolu.
// Stav je ve workflow static data a souběžné běhy ho čtou/zapisují bez zámku, proto je limit pouze přibližný.
const MAX_DENNE = 200;
const FETCH_DEADLINE_MS = 10000;
try {
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
      // Deadline: abortSignal (zastaví stahování, pokud ho runtime předá) + Promise.race (omezí čekání v každém případě).
      const req = Promise.resolve(this.helpers.httpRequest({
        url: input.url.url, method: 'GET', timeout: FETCH_DEADLINE_MS, encoding: 'text',
        disableFollowRedirect: true, ignoreHttpStatusErrors: true, returnFullResponse: true,
        abortSignal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_DEADLINE_MS) : undefined,
        headers: { 'User-Agent': 'Mozilla/5.0 (NakupniKontrola)', 'Accept-Language': 'cs' },
      }));
      req.catch(() => {});
      let timer;
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), FETCH_DEADLINE_MS); });
      let r;
      try { r = await Promise.race([req, deadline]); } finally { clearTimeout(timer); }
      if (r && r.statusCode >= 200 && r.statusCode < 300) {
        pageText = htmlToText(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        pageStatus = pageText.length >= 300 ? 'nacteno' : 'prilis_kratke';
      } else {
        pageStatus = 'nenacteno';
      }
    } catch (e) { pageStatus = 'nenacteno'; }
  }
  if (pageStatus !== 'nacteno') pageText = '';
  // Kontroly hostitele e-shopu (ČOI, RDAP, ARES) nepotřebují ani LLM, ani obsah stránky: stačí URL e-shopu.
  const hasContent = input.text || input.screenshoty.length || pageStatus === 'nacteno';
  const hostCheckable = input.url && input.url.rezim === 'eshop';
  if (!hasContent && !hostCheckable) {
    const zprava = 'Stránku se nepodařilo načíst (marketplace často blokují automatické čtení). Vložte prosím screenshot nabídky nebo zkopírovaný text.';
    return [{ json: { zkratka: true, status: 200, odpoved: needMoreInput(zprava) } }];
  }
  return [{ json: { zkratka: false, input, pageText, rezim: input.url ? input.url.rezim : 'neznámé', host: input.url ? input.url.host : null, obsah: !!hasContent } }];
} catch (e) {
  // Žádné detaily chyby ven: obecná hláška, aby webhook nikdy neodpověděl prázdným 200.
  return [{ json: { zkratka: true, status: 500, odpoved: { stav: 'chyba', chyba: 'Kontrola se nepodařila. Zkuste to prosím znovu.' } } }];
}
