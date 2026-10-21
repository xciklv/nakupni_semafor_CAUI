const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWorkflow } = require('../build/build-workflow');
const { runCodeNode } = require('./sandbox');

// Glue krok „Vstup a načtení“ s vloženým obsahem z rozšíření v prohlížeči. Čtečka stránek je tu ZAPNUTÁ (výchozí adresa),
// aby test dokázal, že se server nepokouší stránku stáhnout ani přes ni.
const WF = buildWorkflow({ credId: 'C', credName: 'N' });
const code = WF.nodes.find((n) => n.name === 'Vstup a načtení').parameters.jsCode;
const run = (body, o = {}) => runCodeNode(code, { json: { body }, ...o });
const stub404 = () => ({ statusCode: 404, headers: {}, body: '' });

const dlouhyText = (n) => ('Powerbanka 50000 mAh za 199 Kč. ').repeat(Math.ceil(n / 32)).slice(0, n);

test('glue 01: marketplace odkaz + text ≥ 300 znaků -> server nestahuje (ani čtečka, ani HEAD/GET)', async () => {
  for (const odkaz of ['https://allegro.cz/produkt/x?offerId=1', 'https://www.aliexpress.com/item/1005011759581041.html', 'https://www.temu.com/p-1.html']) {
    const { out, calls } = await run({ odkaz, text: dlouhyText(300) }, { httpStub: stub404 });
    assert.equal(calls.length, 0, odkaz);
    assert.equal(out.obsah, true, odkaz);
    assert.equal(out.zkratka, false, odkaz);
    assert.equal(out.rezim, 'marketplace', odkaz);
    assert.equal(out.pageText, '', odkaz);
    assert.equal(out.dossier, null, odkaz);
  }
});

test('glue 01: totéž platí pro e-shop s odkazem a dlouhým textem', async () => {
  const { out, calls } = await run({ odkaz: 'https://example.cz/p', text: dlouhyText(5000) }, { httpStub: stub404 });
  assert.equal(calls.length, 0);
  assert.equal(out.obsah, true);
  assert.equal(out.rezim, 'eshop');
  assert.equal(out.host, 'example.cz');
});

test('glue 01: text kratší než 300 znaků se serverem doplňuje jako dřív', async () => {
  const { out, calls } = await run({ odkaz: 'https://allegro.cz/produkt/x?offerId=1', text: dlouhyText(299) }, { httpStub: stub404 });
  assert.ok(calls.length > 0, 'čtečka nebo stažení stránky se zkouší');
  assert.equal(out.obsah, true, 'text sám je obsah');
});

test('glue 01: obrázky a JSON-LD z rozšíření dojdou v input až do dalších kroků', async () => {
  const { out } = await run({ odkaz: 'https://allegro.cz/produkt/x?offerId=1', text: dlouhyText(400), obrazky: ['https://a.cz/1.jpg', 'http://x', 5], jsonld: '{"@type":"Product"}' });
  assert.deepEqual(out.input.obrazky, ['https://a.cz/1.jpg']);
  assert.equal(out.input.jsonld, '{"@type":"Product"}');
});
