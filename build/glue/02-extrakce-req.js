const c = $input.first().json;
return [{ json: { llmRequest: buildExtractRequest(c.input, c.pageText) } }];
