const MAX_TEXT = 20000;
const MAX_SHOTS = 4;
const MAX_SHOT_CHARS = 5000000;
const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'cutt.ly', 'rebrand.ly', 's.click.aliexpress.com', 'a.aliexpress.com', 'temu.to'];
const MARKETPLACES = ['temu.com', 'aliexpress.com', 'aliexpress.us', 'allegro.cz', 'allegro.pl', 'amazon.com', 'amazon.de', 'amazon.pl', 'ebay.com', 'ebay.de', 'shein.com', 'joom.com', 'vinted.cz'];
const INP_MAX_HTML = 2000000;
const INP_PORTS = ['', '80', '443'];
const INP_MAX_URL = 2048;
const INP_ASCII_RE = /^[\x21-\x5b\x5d-\x7e]+$/; // tisknutelné ASCII bez mezery a bez zpětného lomítka
const INP_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const INP_TLD_RE = /^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const INP_OCTET_RE = /^(0|[1-9][0-9]{0,2})$/;
const INP_PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'svc', 'home', 'corp', 'intranet', 'private', 'test', 'invalid', 'example'];
// Veřejné wildcard-DNS služby (libovolný název se přeloží na zadanou IP, tedy i na interní): host === d nebo pod d.
const INP_REBIND_DOMAINS = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'traefik.me', 'local.gd', 'vcap.me', 'lacolhost.com', '1u.ms'];
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

// Hostitel (malá písmena, bez koncových teček): { ip: [a,b,c,d] } pro IPv4 literál, { name: true } pro doménu, jinak null.
// IPv4 je jen přesně čtyři kanonické desítkové oktety; hex, osmičkové, jednočíselné a zkrácené zápisy se odmítají.
function inpParseHost(host) {
  if (host.length > 253) return null;
  const labels = host.split('.');
  if (!labels.every((l) => INP_LABEL_RE.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (/^[0-9]+$/.test(tld)) {
    if (labels.length !== 4 || !labels.every((l) => INP_OCTET_RE.test(l) && Number(l) <= 255)) return null;
    return { ip: labels.map(Number) };
  }
  if (labels.length < 2 || !INP_TLD_RE.test(tld)) return null;
  return { name: true };
}

// Ruční parser: v Code nodu n8n globál URL není. Záměrně přísnější než normalizace URL (jen ASCII, žádné IPv6,
// žádné userinfo ani procenta v authority, jen porty 80/443, jen kanonické IPv4).
function normalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const bad = (duvod) => ({ ok: false, duvod });
  const s = raw.trim();
  if (s.length > INP_MAX_URL) return bad('odkaz je příliš dlouhý');
  if (!INP_ASCII_RE.test(s)) return bad('neplatný odkaz (použijte adresu v ASCII tvaru nebo vložte text či screenshot)');
  let scheme = 'https';
  let rest = s;
  const sm = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (sm) {
    scheme = sm[1].toLowerCase();
    rest = s.slice(sm[0].length);
  } else if (/^[a-z][a-z0-9+.-]*:(?![0-9]+(?:[/?#]|$))/i.test(s)) {
    return bad('nepodporovaný protokol (jen http a https)');
  }
  if (scheme !== 'http' && scheme !== 'https') return bad('nepodporovaný protokol (jen http a https)');
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  let tail = cut === -1 ? '' : rest.slice(cut);
  const hash = tail.indexOf('#');
  if (hash !== -1) tail = tail.slice(0, hash);
  if (tail.charAt(0) !== '/') tail = '/' + tail;
  if (authority.indexOf('@') !== -1) return bad('odkaz nesmí obsahovat přihlašovací údaje');
  if (/[%[\]]/.test(authority)) return bad('neplatná adresa');
  const parts = authority.split(':');
  if (parts.length > 2) return bad('neplatná adresa');
  if (parts.length === 2 && INP_PORTS.indexOf(parts[1]) === -1) return bad('nepodporovaný port');
  if (parts.length === 2 && ((scheme === 'http' && parts[1] === '443') || (scheme === 'https' && parts[1] === '80'))) return bad('nesprávný port');
  const fullHost = parts[0].toLowerCase().replace(/\.+$/, '');
  const interni = bad('odkaz míří na interní nebo neveřejnou adresu');
  if (INP_PRIVATE_SUFFIXES.concat(INP_REBIND_DOMAINS).some((x) => fullHost === x || fullHost.endsWith('.' + x))) return interni;
  const kind = inpParseHost(fullHost);
  if (kind === null) return bad('neplatná adresa');
  if (kind.ip && inpIpv4Blocked(kind.ip[0], kind.ip[1])) return interni;
  const host = fullHost.replace(/^www\./, '');
  const inList = (list) => list.some((d) => host === d || host.endsWith('.' + d));
  if (inList(SHORTENERS)) return bad('zkrácený odkaz – vložte plný odkaz nebo screenshot');
  return { ok: true, url: scheme + '://' + fullHost + tail, host, rezim: inList(MARKETPLACES) ? 'marketplace' : 'eshop' };
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
