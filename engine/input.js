const MAX_TEXT = 20000;
const MAX_SHOTS = 4;
const MAX_SHOT_CHARS = 5500000;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rebrand.ly', 's.click.aliexpress.com', 'a.aliexpress.com', 'temu.to'];
const MARKETPLACES = ['temu.com', 'aliexpress.com', 'aliexpress.us', 'allegro.cz', 'allegro.pl', 'amazon.com', 'amazon.de', 'amazon.pl', 'ebay.com', 'ebay.de', 'shein.com', 'joom.com', 'vinted.cz'];

function normalizeUrl(raw) {
  if (!raw || !String(raw).trim()) return null;
  let s = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, duvod: 'neplatný odkaz' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, duvod: 'neplatný odkaz' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (SHORTENERS.includes(host)) return { ok: false, duvod: 'zkrácený odkaz – vložte plný odkaz nebo screenshot' };
  const isMarketplace = MARKETPLACES.some((m) => host === m || host.endsWith('.' + m));
  return { ok: true, url: u.href, host, rezim: isMarketplace ? 'marketplace' : 'eshop' };
}

function validateInput(body) {
  const b = body || {};
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const shots = Array.isArray(b.screenshoty) ? b.screenshoty : [];
  const url = normalizeUrl(b.odkaz);
  if (!text && !shots.length && !url) return { ok: false, status: 400, chyba: 'Vložte odkaz, text nabídky nebo screenshot.' };
  if (!text && !shots.length && url && url.ok === false) return { ok: false, status: 400, chyba: 'Odkaz nelze použít: ' + url.duvod + '.' };
  if (text.length > MAX_TEXT) return { ok: false, status: 413, chyba: 'Text je příliš dlouhý (max ' + MAX_TEXT + ' znaků).' };
  if (shots.length > MAX_SHOTS) return { ok: false, status: 413, chyba: 'Nahrajte nejvýše ' + MAX_SHOTS + ' screenshoty.' };
  for (const sh of shots) {
    if (!sh || !MIMES.includes(sh.mime) || typeof sh.data !== 'string') return { ok: false, status: 400, chyba: 'Nepodporovaný formát obrázku (PNG, JPEG, WEBP).' };
    if (sh.data.length > MAX_SHOT_CHARS) return { ok: false, status: 413, chyba: 'Screenshot je příliš velký.' };
  }
  return { ok: true, input: { text, screenshoty: shots, url: url && url.ok ? url : null } };
}

function htmlToText(html, max = 15000) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

function checkQuota(state, nowMs, max) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.count = 0; }
  if (state.count >= max) return { ok: false };
  state.count += 1;
  return { ok: true };
}

if (typeof module !== 'undefined') module.exports = { normalizeUrl, validateInput, htmlToText, checkQuota };
