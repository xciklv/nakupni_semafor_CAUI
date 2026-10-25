const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Upozornění o soukromí pod formulářem kontroly (web/index.html) musí odpovídat tomu, co kontrola opravdu dělá (README, část „Data a mazání“).
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const upozorneni = (() => {
  const m = html.match(/<p class="hint">([^<]*Anthropic[^<]*)<\/p>/);
  return m ? m[1].replace(/\s+/g, ' ') : '';
})();

test('soukromí: upozornění je na stránce právě jednou', () => {
  assert.ok(upozorneni, 'upozornění o Anthropic nenalezeno');
  assert.equal((html.match(/službě Anthropic/g) || []).length, 1);
});

test('soukromí: říká, že Anthropic dostane odkaz, text stránky s recenzemi, screenshoty i obrázky nabídky', () => {
  for (const re of [/odkaz/, /text stránky/, /recenz/, /screenshot/, /obrázk/]) assert.match(upozorneni, re);
  assert.doesNotMatch(upozorneni, /se screenshoty a odkazy odesílají/, 'stará, neúplná formulace');
});

test('soukromí: průběh se ukládá lokálně v n8n, jde smazat a ukládání jde vypnout', () => {
  assert.match(upozorneni, /ukládá lokálně v n8n/);
  assert.match(upozorneni, /npm run purge/);
  assert.match(upozorneni, /README/);
  assert.match(upozorneni, /SAVE_EXECUTIONS=none/);
});

test('soukromí: ostatním službám jdou jen veřejné identifikátory a výsledek není právní verdikt', () => {
  assert.match(upozorneni, /jen veřejné identifikátory/);
  assert.ok(upozorneni.includes('Do veřejných rejstříků (ARES, VIES, RDAP, Icecat, EU Safety Gate)'));
  assert.match(upozorneni, /značka či model z nabídky/);
  assert.match(upozorneni, /nikdy vaše texty ani screenshoty/);
  assert.match(upozorneni, /ne právní verdikt/);
});
