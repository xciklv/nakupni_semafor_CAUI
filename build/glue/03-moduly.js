// Safety Gate je volitelné obohacení: jakákoli chyba/timeout/divná odpověď = žádný signál. Deadline je celkový (wall-clock), request má vlastní timeout 8 s.
const SAFETY_GATE_DEADLINE_MS = 9000;
try {
  const ctx = $('Vstup a načtení').first().json;
  const nowMs = Date.now();
  const parsed = parseLlmJson($input.first().json);
  const x = normalizeExtraction(parsed.ok ? parsed.data : {});

  const cache = $getWorkflowStaticData('global');
  const fetchers = {
    rdap: async (host) => this.helpers.httpRequest({ url: rdapUrl(host), json: true, timeout: 6000 }),
    ares: async (ico) => {
      const r = await this.helpers.httpRequest({ url: 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico, json: true, timeout: 6000, ignoreHttpStatusErrors: true, returnFullResponse: true });
      if (r.statusCode === 404) return null;
      if (r.statusCode >= 400) throw new Error('ARES ' + r.statusCode);
      return r.body;
    },
  };
  // Seznam ČOI se stahuje souběžně s RDAP, ARES a Safety Gate: promise se spustí hned a čeká se na něj až v sellerSignals.
  // Čerstvá cache (< 6 h) se použije bez stahování; když obnova selže, použije se i stará cache; bez cache je výsledek null.
  const loadCoi = async () => {
    const cached = cache.coi && cache.coi.list && typeof cache.coi.at === 'number' ? cache.coi : null;
    if (cached && nowMs - cached.at < 6 * 3600 * 1000) return cached.list;
    try {
      const html = await this.helpers.httpRequest({ url: 'https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/', timeout: 10000 });
      const list = parseCoi(String(html));
      if (Object.keys(list).length > 100) { cache.coi = { at: nowMs, list }; return list; }
    } catch (e) { /* obnova selhala */ }
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
  const safety = safetySignals(x);
  const gateQuery = safetyGateQuery(x);
  const [seller, gate] = await Promise.all([
    sellerSignals({ x, rezim: ctx.rezim, host: ctx.host, fetchers, coiList, nowMs }),
    gateQuery ? safetyGateFetch(gateQuery) : [],
  ]);

  const signals = [...offer.signals, ...seller.signals, ...safety.signals, ...gate];
  const verdict = computeVerdict(signals, { offer: offer.status, seller: seller.status, safety: safety.status }, { external: seller.external, skipped: seller.skipped });
  return [{ json: { verdict, signals, llmRequest: buildExplainRequest(verdict, signals) } }];
} catch (e) {
  // Degradace místo pádu: bez dat z modulů vznikne šedý verdikt a běh pokračuje k vysvětlení.
  const verdict = computeVerdict([], { offer: 'unchecked', seller: 'unchecked', safety: 'unchecked' });
  return [{ json: { verdict, signals: [], llmRequest: buildExplainRequest(verdict, []) } }];
}
