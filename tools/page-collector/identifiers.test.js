'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { checkGtin, fromLabeledRow, collectIdentifiers } = require('./identifiers');

test('platné GTIN různých délek', () => {
  assert.strictEqual(checkGtin('4006381333931').valid, true); // EAN-13
  assert.strictEqual(checkGtin('73513537').valid, true); // EAN-8
  assert.strictEqual(checkGtin('036000291452').valid, true); // UPC-A
  assert.strictEqual(checkGtin('4006381333931').kind, 'EAN-13');
});

test('špatná kontrolní číslice a délka', () => {
  const bad = checkGtin('4006381333932');
  assert.strictEqual(bad.valid, false);
  assert.match(bad.reason, /kontrolní číslice/);
  // kód výrobce z Allegra je formálně platný EAN-13: kontrola číslice ověří jen tvar, ne příslušnost k výrobku
  assert.strictEqual(checkGtin('0198222626846').valid, true);
  assert.match(checkGtin('12345').reason, /délka 5/);
});

test('popisek model / kód výrobce dá kandidáta a ověří se jako GTIN', () => {
  const c = fromLabeledRow('model/kód výrobce', '0198222626846', 'Parametry');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].type, 'manufacturer-code');
  const all = collectIdentifiers(c);
  assert.strictEqual(all[0].gtin.valid, checkGtin('0198222626846').valid);
});

test('pole bez popisku identifikátoru se nebere', () => {
  assert.deepStrictEqual(fromLabeledRow('Item Weight', '2KG', 'Specifications'), []);
});
