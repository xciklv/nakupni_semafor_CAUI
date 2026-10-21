// Service worker: každé kliknutí na ikonu přidá aktuální stránku do sbírky (platí napříč kartami);
// „Zkontrolovat“ pošle všechny sebrané stránky najednou jako jeden text do kontroly.
// Odesílá z workeru (ne ze stránky), takže se na něj nevztahuje CSP stránky; stačí host_permissions.
const API = 'http://127.0.0.1:5678/webhook/nakupni-kontrola';
const LIMIT = 20000;
const HLAVNI = 12000; // první stránka (nabídka) dostane víc, ostatní si dělí zbytek

// Ořez na celé věty (nebo aspoň řádky), stejně jako v extract.js.
function orez(s, max) {
  if (s.length <= max) return s;
  const kus = s.slice(0, max);
  const i = Math.max(kus.lastIndexOf('. '), kus.lastIndexOf('.\n'), kus.lastIndexOf('! '), kus.lastIndexOf('? '), kus.lastIndexOf('\n'));
  return i > max * 0.5 ? kus.slice(0, i + 1) : kus;
}

function sestavText(sbirka) {
  if (sbirka.length === 1) return sbirka[0].text;
  const ostatni = sbirka.length - 1;
  const podil = Math.floor((LIMIT - HLAVNI - 200 * sbirka.length) / ostatni);
  return sbirka.map((s, i) => '=== Stránka ' + (i + 1) + ' z ' + sbirka.length + (i === 0 ? ' (nabídka)' : '') + ' ===\n' + orez(s.text, i === 0 ? HLAVNI : podil)).join('\n\n').slice(0, LIMIT);
}

async function nactiSbirku() { return (await chrome.storage.session.get('sbirka')).sbirka || []; }
async function ulozSbirku(s) { await chrome.storage.session.set({ sbirka: s }); }

function hlasit(tabId, stav) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] })
    .then(() => chrome.scripting.executeScript({ target: { tabId }, func: (s) => nakupniKontrolaOverlay(s), args: [stav] }));
}

const prehled = (sbirka) => sbirka.map((s) => ({ odkaz: s.odkaz, titulek: s.titulek, znaku: s.text.length }));

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => nakupniKontrolaExtract() });
    const sbirka = (await nactiSbirku()).filter((s) => s.odkaz !== result.odkaz); // stejná stránka se přepíše
    sbirka.push(result);
    await ulozSbirku(sbirka);
    await hlasit(tab.id, { faze: 'nahled', sbirka: prehled(sbirka), diagnostika: result.diagnostika, obrazky: result.obrazky.length });
  } catch (e) {
    // Např. chrome:// stránky nebo Chrome Web Store: skripty tam vložit nejde.
    console.warn('Záchyt selhal:', e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    const sbirka = await nactiSbirku();
    if (msg.akce === 'odeslat' && sbirka.length) await odeslat(tabId, sbirka);
    if (msg.akce === 'ulozit') await ulozit(sbirka);
    if (msg.akce === 'vymazat') { await ulozSbirku([]); await chrome.storage.session.remove('vysledek'); await hlasit(tabId, { faze: 'prazdno' }); }
  })();
});

async function odeslat(tabId, sbirka) {
  await hlasit(tabId, { faze: 'odesilam', stran: sbirka.length });
  const t0 = Date.now();
  const text = sestavText(sbirka);
  // Service worker MV3 se po ~30 s bez události ukončí; kontrola trvá déle, tak ho během čekání udržujeme při životě.
  const zivy = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const vysledek = { odeslanyText: text, stran: sbirka.length };
  try {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ odkaz: sbirka[0].odkaz, text }), signal: AbortSignal.timeout(180000) });
    const odpoved = await res.json();
    Object.assign(vysledek, { odpoved, http: res.status, ms: Date.now() - t0 });
    await chrome.storage.session.set({ vysledek });
    await hlasit(tabId, { faze: 'vysledek', odpoved, stran: sbirka.length });
  } catch (e) {
    vysledek.chyba = String(e);
    await chrome.storage.session.set({ vysledek });
    await hlasit(tabId, { faze: 'chyba', chyba: 'Kontrola není dostupná (' + e + '). Běží n8n na 127.0.0.1:5678?' });
  } finally {
    clearInterval(zivy);
  }
}

async function ulozit(sbirka) {
  const { vysledek } = await chrome.storage.session.get('vysledek');
  const obsah = JSON.stringify({ sbirka, vysledek }, null, 2);
  await chrome.downloads.download({ url: 'data:application/json;charset=utf-8,' + encodeURIComponent(obsah), filename: 'browser-capture-sbirka-' + sbirka.length + 'str-' + Date.now() + '.json', saveAs: false });
}
