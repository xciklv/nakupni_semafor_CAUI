'use strict';
// Ochrana čtečky stránek: prohlížeč smí jen na veřejné adresy (SSRF). Kontroluje se hlavní adresa i každý podřízený požadavek stránky
// a přesměrování, včetně překladu jména na IP (veřejné jméno nesmí mířit na interní adresu).
const dns = require('node:dns').promises;
const net = require('node:net');

const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'localdomain', 'lan', 'home.arpa', 'svc', 'home', 'corp', 'intranet', 'private', 'test', 'invalid', 'example'];
// Veřejné wildcard-DNS služby (libovolné jméno se přeloží na zadanou IP, tedy i na interní).
const REBIND_DOMAINS = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'traefik.me', 'local.gd', 'vcap.me', 'lacolhost.com', '1u.ms'];
const LOCAL_SCHEMES = ['data:', 'blob:', 'about:'];

function isPrivateIPv4(a, b) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

// true = interní, neveřejná nebo neplatná adresa; do neznámého se nikdy nejde.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return isPrivateIPv4(a, b);
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (hex) { const hi = parseInt(hex[1], 16); return isPrivateIPv4(hi >> 8, hi & 255); }
    if (/^f[cd]/.test(s)) return true; // fc00::/7
    if (/^fe[89ab]/.test(s)) return true; // fe80::/10
    return false;
  }
  return true;
}

function hostBlockedByName(host) {
  const h = String(host).toLowerCase().replace(/\.+$/, '');
  if (!h) return true;
  return PRIVATE_SUFFIXES.concat(REBIND_DOMAINS).some((x) => h === x || h.endsWith('.' + x));
}

// { ok:true } nebo { ok:false, duvod }. lookup je vyměnitelný kvůli testům (výchozí dns.lookup s all:true).
async function checkUrl(raw, lookup = dns.lookup) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { return { ok: false, duvod: 'neplatná adresa' }; }
  if (LOCAL_SCHEMES.includes(u.protocol)) return { ok: true, local: true };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, duvod: 'nepodporovaný protokol' };
  if (u.username || u.password) return { ok: false, duvod: 'adresa nesmí obsahovat přihlašovací údaje' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateIp(host) ? { ok: false, duvod: 'interní adresa' } : { ok: true };
  if (hostBlockedByName(host)) return { ok: false, duvod: 'interní adresa' };
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch (e) { return { ok: false, duvod: 'adresu se nepodařilo přeložit' }; }
  if (!Array.isArray(addrs) || !addrs.length || addrs.some((a) => isPrivateIp(a && a.address))) return { ok: false, duvod: 'interní adresa' };
  return { ok: true };
}

// Text ze stránky: řádky oříznuté, prázdné vyhozené, nezlomitelné mezery a tabulátory sjednocené, délka omezená.
function cleanText(s, max) {
  const lines = String(s == null ? '' : s).replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
  return lines.join('\n').slice(0, max);
}

// Stránka, kterou nelze číst (ochrana proti robotům). Čtečka ji pouze rozpozná a nahlásí, nikdy se ji nesnaží obejít.
const BLOCK_RE = /unusual traffic|captcha|verify you are human|slide to verify|access denied|are you a robot/i;
function looksBlocked(text) {
  return BLOCK_RE.test(String(text).slice(0, 1500));
}

module.exports = { isPrivateIp, hostBlockedByName, checkUrl, cleanText, looksBlocked, PRIVATE_SUFFIXES };
