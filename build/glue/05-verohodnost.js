// Id modelu věrohodnosti se dosazuje při sestavení (LLM_MODEL_PLAUSIBILITY); výchozí hodnota = LLM_MODEL_PLAUSIBILITY_DEFAULT v engine/plausibility.js.
const MODEL_PLAUSIBILITY = 'claude-sonnet-5-5';
// Co model posuzuje: bez názvu, popisu, specifikace, tvrzení a AI přehledu není nad čím uvažovat (prázdný nebo blokovaný dossier, e-shop bez textu).
// Bez požadavku LLM node selže a Souhrn to jako přeskočení nezapíše (bezDat), protože nebylo co ověřovat.
try {
  const d = $input.first().json.dossier;
  const list = (v) => (Array.isArray(v) ? v : []);
  const maData = !!d && typeof d === 'object' && !!(d.nazev || d.popis || list(d.specifikace).length || list(d.tvrzeni).length || list(d.aiPrehled).length);
  if (!maData) return [{ json: { llmRequest: null, bezDat: true } }];
  return [{ json: { llmRequest: buildPlausibilityRequest(d, MODEL_PLAUSIBILITY), bezDat: false } }];
} catch (e) {
  // Požadavek se nepodařilo sestavit: LLM node selže a Souhrn zapíše přeskočení ověření věrohodnosti.
  return [{ json: { llmRequest: null, bezDat: false } }];
}
