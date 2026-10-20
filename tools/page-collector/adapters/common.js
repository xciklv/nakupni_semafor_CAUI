'use strict';
// Společné kroky adaptérů: bezpečné klikání (jen čtecí prvky stránky), zachycení vyskakovacích oken, zápis důkazů a mezer.

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// Kontext jednoho sběru: důkazy (surové útržky textu), akce (co se kliklo) a mezery (co se nepodařilo a proč).
function createTrail(rawDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (rawDir) fs.mkdirSync(rawDir, { recursive: true });
  const trail = { evidence: [], actions: [], gaps: [], t0: Date.now() };
  trail.evidenceFor = (section, via, text) => {
    const id = 'e' + (trail.evidence.length + 1);
    trail.evidence.push({ id, section, via, chars: String(text).length, head: clip(text, 160) });
    if (rawDir) fs.writeFileSync(path.join(rawDir, id + '-' + section.replace(/[^\w]+/g, '_').slice(0, 40) + '.txt'), String(text));
    return id;
  };
  trail.act = (what, ok, note) => trail.actions.push({ what, ok, note: note || undefined, tMs: Date.now() - trail.t0 });
  trail.gap = (what, why) => trail.gaps.push({ what, why });
  trail.raw = (name, content) => { if (rawDir) fs.writeFileSync(path.join(rawDir, name), content); };
  return trail;
}

// Text nejvyššího viditelného překryvu (modální okno, šuplík, popup); null, pokud žádný není.
async function readOverlay(page) {
  return page.evaluate(() => {
    const sels = ['[role=dialog]', '[class*="modal-wrap"]', '[class*="comet-v2-modal"]', '[class*="drawer"]', '[class*="popup"]', '[class*="Popup"]', '[class*="dialog"]'];
    const seen = new Set();
    let best = null;
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 200 || r.height < 120 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const t = el.innerText.trim();
        if (t.length < 20) continue;
        if (!best || t.length > best.text.length) best = { text: t.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n'), cls: String(el.className).slice(0, 80) };
      }
    }
    return best;
  }).catch(() => null);
}

async function closeOverlay(page) {
  try {
    const closer = await page.$('[class*="modal-close"], [class*="close-icon"], [aria-label=Close], [class*="drawer-close"], [class*="popup-close"], [class*="closeBtn"]');
    if (closer) { await closer.click({ timeout: 2000 }); return; }
    await page.keyboard.press('Escape');
  } catch (e) { /* okno už je zavřené */ }
}

// Klikne na první viditelný prvek v rozsahu `scope`, jehož text odpovídá `re`. Vrací true/false, nikdy nevyhazuje.
async function clickByText(page, scope, re, { timeout = 3000 } = {}) {
  try {
    const handle = await page.evaluateHandle(({ scope, src, flags }) => {
      const re = new RegExp(src, flags);
      const root = scope ? document.querySelector(scope) : document.body;
      if (!root) return null;
      const cands = [...root.querySelectorAll('button, a, [role=button], [role=tab], span, div')];
      for (const el of cands) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 60 || !re.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const kids = [...el.children].filter((k) => re.test((k.innerText || '').trim()));
        if (kids.length) continue; // klikne se na nejhlubší shodu
        return el;
      }
      return null;
    }, { scope, src: re.source, flags: re.flags });
    const el = handle.asElement();
    if (!el) return false;
    await el.scrollIntoViewIfNeeded({ timeout });
    await el.click({ timeout });
    return true;
  } catch (e) { return false; }
}

// Odmítnutí cookies (nejsoukromější volba); jiné souhlasy se nepotvrzují.
async function declineCookies(page, trail) {
  const clicked = await clickByText(page, null, /^(Odmítnout vše|Odmítnout všechny|Reject all|Reject cookies|Decline all|Odmítnout)$/i, { timeout: 1500 });
  if (clicked) trail.act('odmítnuto cookies (jen nepovinné)', true);
  return clicked;
}

module.exports = { clip, createTrail, readOverlay, closeOverlay, clickByText, declineCookies };
