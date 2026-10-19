// Denní kvóta: počítá se po validaci vstupu a PŘED načtením stránky, takže i odpověď 'potrebuji_vice' spotřebuje jednu kontrolu.
// Stav je ve workflow static data a souběžné běhy ho čtou/zapisují bez zámku, proto je limit pouze přibližný.
const MAX_DENNE = 200;
const FETCH_DEADLINE_MS = 10000;
const FETCH_HEAD_DEADLINE_MS = 5000;
// Čtečka stránek (tools/page-reader): lokální služba se skutečným prohlížečem. Marketplace se kreslí JavaScriptem, obyčejné stažení z nich
// dostane jen kostru bez ceny, prodejce a recenzí. Adresa se dosazuje při sestavení (PAGE_READER_URL); prázdný řetězec = vypnuto.
// Běží-li služba hůř nebo vůbec, pokračuje se obyčejným stažením jako dřív.
const PAGE_READER_URL = 'http://127.0.0.1:5687/read';
const PAGE_READER_DEADLINE_MS = 45000;
const PAGE_READER_MAX_CHARS = 15000;
const PAGE_READER_MIN_CHARS = 300;
// Stahování stránky: n8n-core vynucuje neomezený maxContentLength a AbortSignal v runtime chybí, proto velikost a typ hlídá předběžný HEAD
// (typ jiný než HTML nebo Content-Length nad limitem = nestahovat) a GET žádá jen prvních ~2 MB (Range).
const FETCH_MAX_BYTES = 3000000;
const FETCH_RANGE_END = 2000000;
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
    // Deadline: abortSignal (zastaví stahování, pokud ho runtime předá) + Promise.race (omezí čekání v každém případě).
    const abortSignal = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
    const call = async (opts, ms) => {
      const req = Promise.resolve(this.helpers.httpRequest(opts));
      req.catch(() => {});
      let timer;
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); });
      try { return await Promise.race([req, deadline]); } finally { clearTimeout(timer); }
    };
    // Marketplace nejdřív přes čtečku (skutečný prohlížeč). Adresa už prošla normalizeUrl; čtečka ji kontroluje znovu (SSRF) i u každého podpožadavku.
    if (PAGE_READER_URL && input.url.rezim === 'marketplace') {
      try {
        const r = await call({ method: 'POST', url: PAGE_READER_URL, headers: { 'X-Nakupni-Kontrola': '1' }, body: { url: input.url.url }, json: true,
          timeout: PAGE_READER_DEADLINE_MS, abortSignal: abortSignal(PAGE_READER_DEADLINE_MS), ignoreHttpStatusErrors: true, returnFullResponse: true }, PAGE_READER_DEADLINE_MS);
        const b = r && r.statusCode === 200 ? r.body : null;
        if (b && b.ok === true && typeof b.text === 'string' && b.text.length >= PAGE_READER_MIN_CHARS) {
          pageText = b.text.slice(0, PAGE_READER_MAX_CHARS);
          pageStatus = 'nacteno';
        }
      } catch (e) { /* služba neběží nebo vypršel čas: pokračuje se obyčejným stažením */ }
    }
    if (pageStatus !== 'nacteno') {
      try {
        // Přesměrování se nenásledují (cíl by mohl být interní adresa, kterou normalizeUrl zablokoval).
        const lowerKeys = (h) => { const o = {}; if (h && typeof h === 'object') Object.keys(h).forEach((k) => { o[String(k).toLowerCase()] = h[k]; }); return o; };
        const common = { url: input.url.url, disableFollowRedirect: true, ignoreHttpStatusErrors: true, returnFullResponse: true };
        // Předběžný HEAD: 2xx s jiným content-type než HTML nebo s velkým content-length -> nestahovat. Selhání/405/ne-2xx -> pokračuje GET.
        let preskocit = false;
        try {
          const h = await call({ ...common, method: 'HEAD', timeout: FETCH_HEAD_DEADLINE_MS, abortSignal: abortSignal(FETCH_HEAD_DEADLINE_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 (NakupniKontrola)', 'Accept-Language': 'cs' } }, FETCH_HEAD_DEADLINE_MS);
          if (h && h.statusCode >= 200 && h.statusCode < 300) {
            const hd = lowerKeys(h.headers);
            const ct = hd['content-type'] === undefined || hd['content-type'] === null ? '' : String(hd['content-type']).trim();
            if (ct && !/^(text\/html|application\/xhtml\+xml)\s*(;|$)/i.test(ct)) preskocit = true;
            const cl = hd['content-length'] === undefined || hd['content-length'] === null ? '' : String(hd['content-length']).trim();
            if (/^[0-9]+$/.test(cl) && Number(cl) > FETCH_MAX_BYTES) preskocit = true;
          }
        } catch (e) { /* HEAD selhal nebo vypršel: pokračuje se GET */ }
        if (preskocit) {
          pageStatus = 'nenacteno';
        } else {
          const r = await call({ ...common, method: 'GET', timeout: FETCH_DEADLINE_MS, encoding: 'text', abortSignal: abortSignal(FETCH_DEADLINE_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 (NakupniKontrola)', 'Accept-Language': 'cs', 'Accept': 'text/html,application/xhtml+xml', 'Range': 'bytes=0-' + FETCH_RANGE_END } }, FETCH_DEADLINE_MS);
          if (r && r.statusCode >= 200 && r.statusCode < 300) {
            pageText = htmlToText(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
            pageStatus = pageText.length >= 300 ? 'nacteno' : 'prilis_kratke';
          } else {
            pageStatus = 'nenacteno';
          }
        }
      } catch (e) { pageStatus = 'nenacteno'; }
    }
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
