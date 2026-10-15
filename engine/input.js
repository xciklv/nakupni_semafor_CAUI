const MAX_TEXT = 20000;
const MAX_SHOTS = 4;
const MAX_SHOT_CHARS = 5500000;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rebrand.ly', 's.click.aliexpress.com', 'a.aliexpress.com', 'temu.to'];
const MARKETPLACES = ['temu.com', 'aliexpress.com', 'aliexpress.us', 'allegro.cz', 'allegro.pl', 'amazon.com', 'amazon.de', 'amazon.pl', 'ebay.com', 'ebay.de', 'shein.com', 'joom.com', 'vinted.cz'];
const INP_MAX_HTML = 2000000;
const INP_PORTS = ['', '80', '443'];
const INP_PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa'];
// Jedna linearní průchozí regex: komentář, nebo otevírací script/style/noscript.
const INP_SKIP_RE = /<!--|<(script|style|noscript)(?![a-z0-9_:-])/gi;
const INP_RAW_CLOSE = {
  script: /<\/script(?![a-z0-9_:-])/gi,
  style: /<\/style(?![a-z0-9_:-])/gi,
  noscript: /<\/noscript(?![a-z0-9_:-])/gi,
};

function inpIpv4Blocked(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

// Vrátí pole 8 čísel (skupin IPv6) nebo null, pokud literál nejde rozparsovat.
function inpExpandIpv6(s) {
  let str = s.toLowerCase();
  if (str.indexOf('.') !== -1) {
    const cut = str.lastIndexOf(':');
    const v4 = str.slice(cut + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !(n >= 0 && n <= 255))) return null;
    str = str.slice(0, cut + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const tail = halves[1] === '' ? [] : halves[1].split(':');
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = head.concat(new Array(fill).fill('0'), tail);
  }
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

function inpIpv6Blocked(g) {
  if (g.slice(0, 6).every((n) => n === 0)) return true; // ::, ::1, ::a.b.c.d
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return inpIpv4Blocked(g[6] >> 8, g[6] & 0xff); // ::ffff:<v4>
  }
  return false;
}

// host: lowercase, bez tečky na konci, u IPv6 s hranatými závorkami.
function inpIsBlockedHost(host) {
  if (host.charAt(0) === '[') {
    const g = inpExpandIpv6(host.slice(1, -1));
    return g === null || inpIpv6Blocked(g);
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (o.some((n) => n > 255)) return true;
    return inpIpv4Blocked(o[0], o[1]);
  }
  if (INP_PRIVATE_SUFFIXES.some((x) => host === x || host.endsWith('.' + x))) return true;
  // Poslední štítek číselný (dec/hex) = IP literál v nestandardním zápisu; TLD nikdy není číselný.
  if (/(^|\.)(\d+|0x[0-9a-f]*)$/i.test(host)) return true;
  return false;
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { ok: false, duvod: 'neplatný odkaz' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, duvod: 'neplatný odkaz' };
  if (u.username || u.password) return { ok: false, duvod: 'odkaz nesmí obsahovat přihlašovací údaje' };
  if (INP_PORTS.indexOf(u.port) === -1) return { ok: false, duvod: 'nepodporovaný port' };
  let host = u.hostname.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (inpIsBlockedHost(host)) return { ok: false, duvod: 'odkaz míří na interní nebo neveřejnou adresu' };
  host = host.replace(/^www\./, '');
  const inList = (list) => list.some((d) => host === d || host.endsWith('.' + d));
  if (inList(SHORTENERS)) return { ok: false, duvod: 'zkrácený odkaz – vložte plný odkaz nebo screenshot' };
  return { ok: true, url: u.href, host, rezim: inList(MARKETPLACES) ? 'marketplace' : 'eshop' };
}

function validateInput(body) {
  const b = body || {};
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  if (b.screenshoty !== undefined && b.screenshoty !== null && !Array.isArray(b.screenshoty)) {
    return { ok: false, status: 400, chyba: 'Nepodporovaný formát screenshotů.' };
  }
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

// Odstraní komentáře a obsah script/style/noscript. Neuzavřený blok zahodí zbytek dokumentu.
function inpStripRaw(s) {
  let out = '';
  let pos = 0;
  for (;;) {
    INP_SKIP_RE.lastIndex = pos;
    const m = INP_SKIP_RE.exec(s);
    if (!m) return out + s.slice(pos);
    out += s.slice(pos, m.index) + ' ';
    if (m[1] === undefined) { // <!-- komentář
      const end = s.indexOf('-->', m.index + 4);
      if (end === -1) return out;
      pos = end + 3;
    } else {
      const re = INP_RAW_CLOSE[m[1].toLowerCase()];
      re.lastIndex = m.index + m[0].length;
      const c = re.exec(s);
      if (!c) return out;
      const gt = s.indexOf('>', c.index + c[0].length);
      if (gt === -1) return out;
      pos = gt + 1;
    }
  }
}

function htmlToText(html, max = 15000) {
  const src = (html === null || html === undefined ? '' : String(html)).slice(0, INP_MAX_HTML);
  return inpStripRaw(src)
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
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
