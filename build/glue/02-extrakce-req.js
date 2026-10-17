// Id modelu se dosazuje při sestavení (LLM_MODEL_EXTRACT); výchozí hodnota = LLM_MODEL_EXTRACT_DEFAULT v engine/llm.js.
const MODEL_EXTRACT = 'gpt-6.1-sol';
try {
  const c = $input.first().json;
  return [{ json: { llmRequest: buildExtractRequest(c.input, c.pageText, MODEL_EXTRACT) } }];
} catch (e) {
  // Bez požadavku LLM node selže, tok degraduje (Moduly berou chybu modelu jako nezkontrolované moduly).
  return [{ json: { llmRequest: null } }];
}
