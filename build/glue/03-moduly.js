// Safety Gate je volitelné obohacení: jakákoli chyba/timeout/divná odpověď = žádný signál. Deadline je celkový (wall-clock), request má vlastní timeout 8 s.
const SAFETY_GATE_DEADLINE_MS = 9000;
// Wall-clock deadline zdrojů prodejce (n8n timeout je jen idle/socket timeout; pomalý server by kontrolu držel déle). Deadline = selhání zdroje.
const COI_DEADLINE_MS = 10000;
const RDAP_DEADLINE_MS = 6500;
const ARES_DEADLINE_MS = 6500;
const VIES_DEADLINE_MS = 6500;
const ICECAT_DEADLINE_MS = 6500;
// Spustí request hned; opuštěný request má .catch (pozdní odmítnutí není unhandled), timer se vždy uklidí.
const glueDeadline = (make, ms) => {
  let req;
  try { req = Promise.resolve(make()); } catch (e) { return Promise.reject(e); }
  req.catch(() => {});
  let timer;
  const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), ms); });
  return Promise.race([req, deadline]).finally(() => clearTimeout(timer));
};
try {
  const ctx = $('Vstup a načtení').first().json;
  const nowMs = Date.now();
  // Čtečka vrátila dossier: x se z něj odvodí (dossierToExtraction). Jinak x pochází z extrakce modelu a dossier se z ní složí (extractionToDossier).
  // Blokovaný nebo neplatný dossier se bere jako žádný: bez dat je výsledek šedý, nikdy zelený.
  const nd = ctx.dossier ? normalizeDossier(ctx.dossier) : null;
  const fromReader = nd && nd.ok && nd.dossier && !nd.dossier.blokace ? nd.dossier : null;
  let x, dossier;
  if (fromReader) {
    dossier = fromReader;
    x = dossierToExtraction(dossier);
  } else {
    const parsed = parseLlmJson($input.first().json);
    x = normalizeExtraction(parsed.ok ? parsed.data : {});
    dossier = extractionToDossier(x, ctx.input);
  }

  const cache = $getWorkflowStaticData('global');
  const fetchers = {
    rdap: async (host) => glueDeadline(() => this.helpers.httpRequest({ url: rdapUrl(host), json: true, timeout: 6000 }), RDAP_DEADLINE_MS),
    ares: async (ico) => {
      const r = await glueDeadline(() => this.helpers.httpRequest({ url: 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico, json: true, timeout: 6000, ignoreHttpStatusErrors: true, returnFullResponse: true }), ARES_DEADLINE_MS);
      if (r.statusCode === 404) return null;
      if (r.statusCode >= 400) throw new Error('ARES ' + r.statusCode);
      return r.body;
    },
    // VIES (ověření DIČ): jen 200 s tělem; cokoli jiného je nedostupný zdroj. cc a číslo prošly kontrolou tvaru v sellerSignals.
    vies: async (cc, cislo) => {
      const r = await glueDeadline(() => this.helpers.httpRequest({ url: 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms/' + cc + '/vat/' + cislo, json: true, timeout: 6000, ignoreHttpStatusErrors: true, returnFullResponse: true }), VIES_DEADLINE_MS);
      if (r.statusCode !== 200) throw new Error('VIES ' + r.statusCode);
      return r.body;
    },
    // Icecat odpovídá 400 (GTIN nenalezen), 403 (značka mimo Open Icecat) a 404 tělem: je to "nelze ověřit", ne chyba služby. Ostatní stavy (429, 5xx) jsou nedostupný zdroj.
    icecat: async (gtin) => {
      const r = await glueDeadline(() => this.helpers.httpRequest({ url: icecatUrl(gtin), json: true, timeout: 6000, ignoreHttpStatusErrors: true, returnFullResponse: true }), ICECAT_DEADLINE_MS);
      const body = r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : null;
      if (r.statusCode === 400 || r.statusCode === 403 || r.statusCode === 404) return body || {};
      if (r.statusCode !== 200 || !body) throw new Error('Icecat ' + r.statusCode);
      return body;
    },
  };
  // Seznam ČOI se stahuje souběžně s RDAP, ARES a Safety Gate: promise se spustí hned a čeká se na něj až v sellerSignals.
  // Čerstvá cache (< 6 h) se použije bez stahování; když obnova selže (i deadline), použije se i stará cache (coiStale); bez cache je výsledek null.
  let coiStale = false;
  const loadCoi = async () => {
    const cached = cache.coi && cache.coi.list && typeof cache.coi.at === 'number' ? cache.coi : null;
    if (cached && nowMs - cached.at < 6 * 3600 * 1000) return cached.list;
    try {
      const html = await glueDeadline(() => this.helpers.httpRequest({ url: 'https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/', timeout: 10000 }), COI_DEADLINE_MS);
      const list = parseCoi(String(html));
      if (Object.keys(list).length > 100) { cache.coi = { at: nowMs, list }; return list; }
    } catch (e) { /* obnova selhala */ }
    if (cached) coiStale = true;
    return cached ? cached.list : null;
  };
  const coiList = ctx.rezim === 'eshop' ? loadCoi().catch(() => null) : Promise.resolve(null);

  const safetyGateFetch = async (q) => {
    try {
      const req = Promise.resolve(this.helpers.httpRequest({
        url: 'https://ec.europa.eu/safety-gate-alerts/public/api/search', method: 'POST', json: true, timeout: 8000,
        ignoreHttpStatusErrors: true, returnFullResponse: true, headers: { 'Content-Type': 'application/json' },
        body: { criteria: {}, pagination: { sortField: 'PUBLICATION_DATE', sortOrder: 'DESC', totalElements: 0, page: 0, numberElements: 20 }, fullTextSearch: q.fullTextSearch, language: 'en' },
      }));
      req.catch(() => {});
      let timer;
      const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('deadline')), SAFETY_GATE_DEADLINE_MS); });
      let r;
      try { r = await Promise.race([req, deadline]); } finally { clearTimeout(timer); }
      const b = r && r.statusCode === 200 ? r.body : null;
      return b && typeof b === 'object' && !Array.isArray(b) ? safetyGateSignals(b.content, x) : [];
    } catch (e) { return []; }
  };

  // Bez extrakce je x prázdné: nabídka a bezpečnost vrátí 'unchecked' samy, prodejce stále provede kontroly hostitele (eshop).
  const offer = offerSignals(x);
  // Chybějící údaje (CE, GPSR) se počítají do skóre jen při úplném čtení stránky čtečkou; vložený text a screenshot vidí jen část nabídky.
  // Úplné čtení = dossier ze čtečky bez mezery ve specifikaci, popisu, AI přehledu nebo registračních údajích (jinak by „nabídka mlčí“ nemuselo platit).
  const safety = safetySignals(x, { uplny: !!fromReader && !dossierGapsHideSafety(dossier) });
  const gateQuery = safetyGateQuery(x);
  const [seller, gate, identity] = await Promise.all([
    sellerSignals({ x, rezim: ctx.rezim, host: ctx.host, fetchers, coiList, nowMs, uplny: !!fromReader || (ctx.rezim === 'eshop' && !!ctx.pageText) }),
    gateQuery ? safetyGateFetch(gateQuery) : [],
    identitySignals({ dossier, fetchers }).catch(() => ({ status: 'unchecked', signals: [], skipped: [] })),
  ]);

  const signals = [...offer.signals, ...seller.signals, ...identity.signals, ...safety.signals, ...gate];
  const moduly = { offer: offer.status, seller: seller.status, safety: safety.status };
  // Odkaz bez čtitelné stránky a bez vloženého obsahu: kontrolovala se jen adresa prodejce, nabídku nikdo nečetl (výsledek to musí říct).
  const skipped = (coiStale ? seller.skipped.concat(['seznam ČOI (neaktuální)']) : seller.skipped).concat(identity.skipped).concat(ctx.strankaNenactena === true ? ['čtení stránky'] : []);
  // Tržiště: z odkazu, a bez odkazu z textu nebo z platformy, kterou poznala extrakce (screenshot).
  const marketplace = detectMarketplace({ rezim: ctx.rezim, text: ctx.input && ctx.input.text, pageText: ctx.pageText, platforma: x.produkt && x.produkt.platforma });
  // Čtečkový dossier IČO ani DIČ prodejce nenese (kolektor je nedodává), takže u marketplace přes čtečku se registr nezkouší; verdikt to řekne pravdivě.
  const sellerIds = !!(x.prodejce && (x.prodejce.ico || x.prodejce.dic));
  const verdict = computeVerdict(signals, moduly, { external: seller.external, skipped, marketplace, sellerIds });
  // Souhrn přepočítá verdikt po věrohodnosti a obrázcích; potřebuje k tomu stavy modulů a zda uspěl externí zdroj.
  return [{ json: { verdict, signals, dossier, x, moduly, external: seller.external, marketplace, sellerIds, mameObrazky: Array.isArray(dossier.obrazky) && dossier.obrazky.length > 0 } }];
} catch (e) {
  // Degradace místo pádu: bez dat z modulů vznikne šedý verdikt a běh pokračuje k vysvětlení.
  const moduly = { offer: 'unchecked', seller: 'unchecked', safety: 'unchecked' };
  return [{ json: { verdict: computeVerdict([], moduly), signals: [], dossier: null, x: null, moduly, external: false, mameObrazky: false } }];
}
