try {
  const ctx = $('Vstup a načtení').first().json;
  const nowMs = Date.now();
  const parsed = parseLlmJson($input.first().json);
  const x = normalizeExtraction(parsed.ok ? parsed.data : {});

  const cache = $getWorkflowStaticData('global');
  const fetchers = {
    rdap: async (host) => this.helpers.httpRequest({ url: rdapUrl(host), json: true, timeout: 8000 }),
    ares: async (ico) => {
      const r = await this.helpers.httpRequest({ url: 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico, json: true, timeout: 8000, ignoreHttpStatusErrors: true, returnFullResponse: true });
      if (r.statusCode === 404) return null;
      if (r.statusCode >= 400) throw new Error('ARES ' + r.statusCode);
      return r.body;
    },
  };
  let coiList = null;
  if (ctx.rezim === 'eshop') {
    if (cache.coi && nowMs - cache.coi.at < 6 * 3600 * 1000) coiList = cache.coi.list;
    else {
      try {
        const html = await this.helpers.httpRequest({ url: 'https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/', timeout: 15000 });
        const list = parseCoi(String(html));
        if (Object.keys(list).length > 100) { cache.coi = { at: nowMs, list }; coiList = list; }
      } catch (e) { coiList = null; }
    }
  }

  const offer = parsed.ok ? offerSignals(x) : { status: 'unchecked', signals: [] };
  const safety = parsed.ok ? safetySignals(x) : { status: 'unchecked', signals: [] };
  const seller = parsed.ok ? await sellerSignals({ x, rezim: ctx.rezim, host: ctx.host, fetchers, coiList, nowMs }) : { status: 'unchecked', signals: [] };

  const signals = [...offer.signals, ...seller.signals, ...safety.signals];
  const verdict = computeVerdict(signals, { offer: offer.status, seller: seller.status, safety: safety.status });
  return [{ json: { verdict, signals, llmRequest: buildExplainRequest(verdict, signals) } }];
} catch (e) {
  // Degradace místo pádu: bez dat z modulů vznikne šedý verdikt a běh pokračuje k vysvětlení.
  const verdict = computeVerdict([], { offer: 'unchecked', seller: 'unchecked', safety: 'unchecked' });
  return [{ json: { verdict, signals: [], llmRequest: buildExplainRequest(verdict, []) } }];
}
