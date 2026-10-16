try {
  const c = $input.first().json;
  return [{ json: { llmRequest: buildExtractRequest(c.input, c.pageText) } }];
} catch (e) {
  // Bez požadavku Claude node selže, tok degraduje (Moduly berou chybu modelu jako nezkontrolované moduly).
  return [{ json: { llmRequest: null } }];
}
