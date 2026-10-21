// Id modelu vysvětlení se dosazuje při sestavení (LLM_MODEL_EXPLAIN); výchozí hodnota = LLM_MODEL_EXPLAIN_DEFAULT v engine/explain.js.
const MODEL_EXPLAIN = 'claude-haiku-5-5';
// Uzel, který v tomto běhu neproběhl (větev bez obrázků), se čte jako null; n8n při přístupu k němu vyhodí chybu.
const ranNode = (get) => {
  try { const n = get().first(); return n && n.json && typeof n.json === 'object' ? n.json : null; } catch (e) { return null; }
};
try {
  const m = $('Moduly').first().json;
  const skipped = m.verdict.skipped.slice();
  const signals = m.signals.slice();

  // Věrohodnost: bez dat k posouzení se nic nezapisuje (nebylo co ověřovat); chyba modelu nebo nepoužitelná odpověď = přeskočené ověření.
  const prep = ranNode(() => $('Sestavit věrohodnost'));
  if (!(prep && prep.bezDat === true)) {
    const pla = ranNode(() => $('LLM – věrohodnost'));
    const parsed = parsePlausibility(pla || {});
    if (parsed.ok) signals.push(...plausibilitySignals(parsed));
    else skipped.push('ověření věrohodnosti');
  }

  // Obrázky: $input patří obrázkům jen tehdy, když proběhla jejich příprava (jinak je to odpověď věrohodnosti z větve bez obrázků).
  const img = ranNode(() => $('Obrázky – příprava'));
  if (img) {
    const runs = $input.all().map((i) => parseImages(i.json || {})).filter((r) => r.ok).map((r) => r.data);
    if (runs.length >= IMG_MIN_VOTES) signals.push(...imagesSignals(consolidateImages(runs, m.dossier, img.obrazky)));
    else skipped.push('analýza obrázků');
  }

  // Prodejce působí věrohodně: modul prodejce je zkontrolovaný a žádný jeho nález není střední, vysoký ani tvrdý.
  const prodejceDuveryhodny = m.moduly.seller === 'ok' && !m.signals.some((s) => s.module === 'seller' && (s.hard || s.severity === 'medium' || s.severity === 'high'));
  const verdict = computeVerdict(signals, m.moduly, { external: m.external, skipped });
  return [{ json: { verdict, signals, llmRequest: buildExplainRequest(verdict, signals, MODEL_EXPLAIN, { prodejceDuveryhodny }) } }];
} catch (e) {
  // Degradace místo pádu: bez dat z modulů vznikne šedý verdikt a běh pokračuje k vysvětlení.
  const verdict = computeVerdict([], { offer: 'unchecked', seller: 'unchecked', safety: 'unchecked' });
  return [{ json: { verdict, signals: [], llmRequest: buildExplainRequest(verdict, [], MODEL_EXPLAIN) } }];
}
