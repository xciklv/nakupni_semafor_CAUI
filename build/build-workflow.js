const fs = require('node:fs');
const path = require('node:path');

const ENGINE = ['signals', 'scoring', 'input', 'llm', 'offer', 'seller', 'safety', 'explain'];
const root = path.join(__dirname, '..');

// Spojí moduly enginu do jednoho scope; jednořádkové require/module.exports guardy odstraní.
function buildBundle() {
  return ENGINE
    .map((f) => fs.readFileSync(path.join(root, 'engine', f + '.js'), 'utf8'))
    .join('\n')
    .replace(/^if \(typeof (require|module) !== 'undefined'.*$/gm, '');
}

const glue = (f) => fs.readFileSync(path.join(__dirname, 'glue', f), 'utf8');
const code = (name, file, pos, withBundle = true) => ({
  id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos,
  parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: (withBundle ? buildBundle() + '\n' : '') + glue(file) },
});
const claude = (name, pos, credId, credName) => ({
  id: name, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: pos, onError: 'continueRegularOutput',
  parameters: {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'anthropicApi',
    sendHeaders: true, headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.llmRequest) }}',
    options: { timeout: 60000 },
  },
  credentials: { anthropicApi: { id: credId, name: credName } },
});

function buildWorkflow({ credId, credName }) {
  const nodes = [
    // allowedOrigins '*': HTML servírované z webhooku běží v CSP sandboxu bez allow-same-origin (n8n-core html-sandbox.js),
    // takže jeho origin je 'null' a fetch na tento webhook je cross-origin.
    { id: 'Webhook', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'nakupni-kontrola',
      parameters: { httpMethod: 'POST', path: 'nakupni-kontrola', responseMode: 'responseNode', options: { allowedOrigins: '*' } } },
    code('Vstup a načtení', '01-vstup.js', [220, 0]),
    { id: 'Stačí vstup?', name: 'Stačí vstup?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [440, 0],
      parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{ id: 'c1', leftValue: '={{ $json.zkratka }}', rightValue: false, operator: { type: 'boolean', operation: 'false', singleValue: true } }], combinator: 'and' } } },
    code('Sestavit extrakci', '02-extrakce-req.js', [660, -100], false),
    claude('Claude – extrakce', [880, -100], credId, credName),
    code('Moduly', '03-moduly.js', [1100, -100]),
    claude('Claude – vysvětlení', [1320, -100], credId, credName),
    code('Odpověď', '04-odpoved.js', [1540, -100]),
    { id: 'Respond', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [1760, -100],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.odpoved) }}', options: { responseCode: '={{ $json.status }}' } } },
    { id: 'Respond – více vstupu', name: 'Respond – více vstupu', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [660, 140],
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json.odpoved) }}', options: { responseCode: '={{ $json.status }}' } } },
  ];
  const link = (a, b, out = 0) => ({ [a]: { main: [...Array(out).fill([]), [{ node: b, type: 'main', index: 0 }]] } });
  const connections = {
    ...link('Webhook', 'Vstup a načtení'),
    ...link('Vstup a načtení', 'Stačí vstup?'),
    'Stačí vstup?': { main: [[{ node: 'Sestavit extrakci', type: 'main', index: 0 }], [{ node: 'Respond – více vstupu', type: 'main', index: 0 }]] },
    ...link('Sestavit extrakci', 'Claude – extrakce'),
    ...link('Claude – extrakce', 'Moduly'),
    ...link('Moduly', 'Claude – vysvětlení'),
    ...link('Claude – vysvětlení', 'Odpověď'),
    ...link('Odpověď', 'Respond'),
  };
  return { name: 'Nákupní kontrola', nodes, connections, settings: { executionOrder: 'v1' } };
}

if (require.main === module) {
  const credId = process.env.CRED_ID;
  if (!credId) { console.error('Nastav CRED_ID (id Anthropic credentialu z n8n).'); process.exit(1); }
  const wf = buildWorkflow({ credId, credName: process.env.CRED_NAME || 'Anthropic account' });
  fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify(wf, null, 2));
  console.log('workflow.json zapsán, nodů:', wf.nodes.length);
}

module.exports = { buildBundle, buildWorkflow };
