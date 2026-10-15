const m = $('Moduly').first().json;
const explanation = parseExplanation($input.first().json);
const odpoved = buildResponse({ verdict: m.verdict, signals: m.signals, explanation });
return [{ json: { status: 200, odpoved } }];
