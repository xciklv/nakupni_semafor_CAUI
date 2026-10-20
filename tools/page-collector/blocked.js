'use strict';
// Rozpoznání stránek, které sběrač nesmí a nebude obcházet: CAPTCHA / ověření robota a přihlašovací zeď.
// Jen rozpoznává a nahlašuje (druh, dodavatel, důkaz); žádné řešení, žádné opakování s jiným nastavením.
const { looksBlocked } = require('../page-reader/guard');

const CHECKS = [
  { kind: 'captcha', vendor: 'DataDome', test: (s) => /captcha-delivery\.com|datadome/i.test(s.html || '') },
  { kind: 'captcha', vendor: 'posuvná skládačka (Temu)', test: (s) => /Posuňte a dokončete skládačku|dokončete ověření|Ověření zabezpečení|Verify you are human|Drag the slider|slide to complete the puzzle/i.test(s.text || '') },
  { kind: 'captcha', vendor: 'AliExpress baxia/punish', test: (s) => /\/punish|x5secdata|baxia-dialog|nc_1_n1z/i.test((s.finalUrl || '') + ' ' + (s.html || '').slice(0, 5000)) && !/id="nav-specification"/.test(s.html || '') },
  { kind: 'login-wall', vendor: null, test: (s) => /\/(login|signin|passport)[./?]/i.test(s.finalUrl || '') || /Registrace\s*&(amp;)?\s*Přihlášení|Sign in\s*\|\s*Register/i.test(s.title || '') || /"page_id":"login"/.test((s.html || '').slice(0, 800000)) },
  { kind: 'captcha', vendor: null, test: (s) => looksBlocked(s.text || '') },
];

// -> null nebo { kind, vendor, evidence, status, url }
function detectBlock({ status, finalUrl, title, text, html }) {
  const state = { status, finalUrl, title, text, html };
  for (const c of CHECKS) {
    if (c.test(state)) {
      const evidence = String(text || '').split('\n').map((l) => l.trim()).filter((l) => /ověření|verify|captcha|přihlášení|sign in|robot|skládačk|slider/i.test(l)).slice(0, 3).join(' | ')
        || ('HTTP ' + status + (/captcha-delivery/i.test(html || '') ? ', stránka obsahuje iframe geo.captcha-delivery.com' : ''));
      return { kind: c.kind, vendor: c.vendor, evidence: evidence.slice(0, 300), status: status == null ? null : status, url: String(finalUrl || '').slice(0, 300) };
    }
  }
  if (status !== null && status >= 400) return { kind: 'http-error', vendor: null, evidence: 'HTTP ' + status, status, url: String(finalUrl || '').slice(0, 300) };
  return null;
}

// Výzva k ověření, která se objeví nad už načtenou stránkou (modální okno s reCAPTCHA apod.). Rozpozná se, nikdy se neřeší;
// sběrač pak přestane proklikávat a čte jen to, co je už vykresleno. -> null | { vendor, evidence }
async function detectChallenge(page) {
  try {
    return await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 80 && r.height > 80 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const frames = [...document.querySelectorAll('iframe')].filter((f) => /punish|recaptcha|captcha|baxia|x5secdata/i.test(f.src || '') && vis(f));
      if (frames.length) return { vendor: 'AliExpress baxia (reCAPTCHA)', evidence: 'viditelný iframe ' + String(frames[0].src).replace(/x5secdata=[^&]+/, 'x5secdata=…').slice(0, 140) };
      const t = document.body ? document.body.innerText.slice(0, 20000) : '';
      const m = /We need to check if you are a robot|Nejsem robot|verify you are human|unusual traffic/i.exec(t);
      return m ? { vendor: null, evidence: 'text na stránce: ' + m[0] } : null;
    });
  } catch (e) { return null; }
}

module.exports = { detectBlock, detectChallenge };
