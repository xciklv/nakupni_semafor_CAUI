'use strict';
// Identifikátory zboží: kontrola GTIN (EAN-8/UPC-A/EAN-13/GTIN-14) a těžba kandidátů z polí dossieru.

// { valid, kind, reason }. Kontrolní číslice: váhy 3,1,3,1… zprava od číslice vedle kontrolní.
function checkGtin(value) {
  const s = String(value).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(s)) return { valid: false, kind: null, reason: 'obsahuje i jiné znaky než číslice' };
  const kinds = { 8: 'EAN-8', 12: 'UPC-A', 13: 'EAN-13', 14: 'GTIN-14' };
  if (!kinds[s.length]) return { valid: false, kind: null, reason: 'délka ' + s.length + ' (GTIN má 8, 12, 13 nebo 14 číslic)' };
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  const expected = (10 - (sum % 10)) % 10;
  if (expected !== check) return { valid: false, kind: kinds[s.length], reason: 'kontrolní číslice nesedí (je ' + check + ', má být ' + expected + ')' };
  return { valid: true, kind: kinds[s.length], reason: 'kontrolní číslice sedí' };
}

const LABELS = [
  [/\b(ean|gtin|upc|isbn|barcode|čárový kód|carovy kod)\b/i, 'ean'],
  [/(kód|kod)\s+výrobce|kód výrobce|kod vyrobce|\bmpn\b|manufacturer\s*(part\s*)?(number|code)|part\s*(number|no)\b|\bp\/n\b/i, 'manufacturer-code'],
  [/\bmodel\b|model number|číslo modelu|cislo modelu/i, 'model'],
  [/\boem\b/i, 'oem'],
  [/\bsku\b|item (number|no)\b|\bartikel/i, 'sku'],
];

function labelType(label) {
  for (const [re, type] of LABELS) if (re.test(label)) return type;
  return null;
}

// Kandidát z pole s názvem (specifikace, parametry): hodnoty „model/kód výrobce“ se berou celé; z hodnot typu EAN i čisté číslice.
function fromLabeledRow(name, value, section) {
  const type = labelType(name);
  if (!type) return [];
  const out = [];
  const raw = String(value).trim();
  const nums = raw.match(/\d[\d\s-]{6,16}\d/g) || [];
  const compact = raw.replace(/[\s-]/g, '');
  const wholeIsNumber = /^\d{6,16}$/.test(compact);
  if (wholeIsNumber) out.push({ type, value: compact, label: name, section, quote: name + ': ' + raw, via: 'labeled' });
  else if (type === 'ean') nums.forEach((n) => out.push({ type, value: n.replace(/[\s-]/g, ''), label: name, section, quote: name + ': ' + raw, via: 'labeled' }));
  else if (raw) out.push({ type, value: raw.slice(0, 80), label: name, section, quote: name + ': ' + raw, via: 'labeled' });
  return out;
}

// Čísla v textu bez popisku (název, popis): jen 8/12/13/14 číslic, jinak to jsou ceny, počty a identifikátory objednávek.
function fromFreeText(text, section) {
  const out = [];
  const re = /(?<![\d.,])(\d{8}|\d{12,14})(?![\d])/g;
  let m;
  while ((m = re.exec(text))) {
    const ctx = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).replace(/\s+/g, ' ');
    out.push({ type: 'number-in-text', value: m[1], label: null, section, quote: ctx, via: 'free-text' });
  }
  const model = /\b([A-Z]{1,4}[- ]?\d{3,6}[A-Z]?)\b/g;
  while ((m = model.exec(text))) {
    if (/^(IP|USB|LED|IPX)\d{0,2}$/i.test(m[1])) continue;
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20).replace(/\s+/g, ' ');
    out.push({ type: 'model-token-in-text', value: m[1], label: null, section, quote: ctx, via: 'free-text-heuristic' });
  }
  return out;
}

// Sloučí kandidáty (stejný typ + hodnota), ke každému přidá kontrolu GTIN u číselných hodnot.
function collectIdentifiers(parts) {
  const seen = new Map();
  for (const c of parts) {
    const key = c.type + '|' + c.value;
    if (seen.has(key)) { seen.get(key).seenIn.push(c.section); continue; }
    const digits = /^\d+$/.test(c.value.replace(/[\s-]/g, ''));
    seen.set(key, { ...c, seenIn: [c.section], gtin: digits ? checkGtin(c.value) : null });
  }
  return [...seen.values()];
}

module.exports = { checkGtin, labelType, fromLabeledRow, fromFreeText, collectIdentifiers };
