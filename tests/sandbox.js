// Realistický sandbox pro testy: napodobuje globály, které Code node v n8n skutečně má.
// Živý test ukázal, že URL, AbortSignal a structuredClone tam NEJSOU (a Buffer, TextEncoder, fetch, require,
// process, URLSearchParams se berou jako nedostupné, dokud se neprokáže opak). Kontext je čerstvý vm kontext:
// má jen vestavěné objekty jazyka (Object, Array, String, Number, Boolean, Math, JSON, Date, RegExp, Promise,
// Error, Symbol, Map, Set, parseInt, ...) a z hostitele dostane pouze setTimeout a clearTimeout.
const vm = require('node:vm');

const FORBIDDEN_GLOBALS = [
  'URL', 'URLSearchParams', 'AbortSignal', 'structuredClone', 'Buffer', 'TextEncoder', 'TextDecoder',
  'fetch', 'require', 'process', 'module', 'window', 'document',
];
// (V8 dává každému kontextu vestavěný `console`; v testech se nepoužívá, takže ho mezi zakázané neřadíme.)

function createRealisticContext(extraGlobals = {}) {
  return vm.createContext({ setTimeout, clearTimeout, ...extraGlobals });
}

// Spustí kód jako skript v realistickém sandboxu a vrátí hodnotu posledního výrazu.
function runInRealisticSandbox(code, extraGlobals = {}) {
  return vm.runInContext(code, createRealisticContext(extraGlobals));
}

// Spustí jsCode Code nodu (async tělo s top-level return/await) tak, jak ho vykoná n8n:
// this.helpers.httpRequest, $input, $('Node'), $getWorkflowStaticData jsou stuby.
// nodes: { 'Název nodu': json | function (může vyhodit) }; $input můžeš předat celý přes opts.$input (např. vyhazující).
async function runCodeNode(jsCode, { json = {}, nodes = {}, state = {}, httpStub, $input, globals = {} } = {}) {
  const calls = [];
  const ctx = createRealisticContext({
    $input: $input || { first: () => ({ json }) },
    $: (name) => ({
      first: () => {
        const n = nodes[name];
        if (typeof n === 'function') return { json: n() };
        if (n === undefined) throw new Error('node ' + name + ' neexistuje');
        return { json: n };
      },
    }),
    $getWorkflowStaticData: () => state,
    ...globals,
  });
  const fn = vm.runInContext('(async function(){' + jsCode + '\n})', ctx);
  const self = { helpers: { httpRequest: async (opts) => { calls.push(opts); return httpStub ? httpStub(opts) : { statusCode: 200, body: '' }; } } };
  const out = await fn.call(self);
  return { out: JSON.parse(JSON.stringify(out))[0].json, calls, state };
}

module.exports = { FORBIDDEN_GLOBALS, createRealisticContext, runInRealisticSandbox, runCodeNode };
