// Service worker: každé kliknutí na ikonu přidá aktuální stránku do sbírky (platí napříč kartami); uživatel pak vidí celý text, který odejde,
// a „Zkontrolovat“ pošle sebrané stránky najednou do kontroly. Po odeslání se sbírka vyprázdní.
// Odesílá z workeru (ne ze stránky), takže se na něj nevztahuje CSP stránky; stačí host_permissions.
importScripts('extract.js'); // trimToSentences
const API = 'http://127.0.0.1:5678/webhook/nakupni-kontrola';
const LIMIT = 20000;
const HLAVNI = 12000; // první stránka (nabídka) dostane víc, ostatní si dělí zbytek
const CEKANI_MS = 180000;
let odesila = false; // jedna kontrola najednou (dvojklik na „Zkontrolovat“)

function sestavText(sbirka) {
  if (sbirka.length === 1) return sbirka[0].text;
  const ostatni = sbirka.length - 1;
  const podil = Math.floor((LIMIT - HLAVNI - 200 * sbirka.length) / ostatni);
  const spojeno = sbirka.map((s, i) => '=== Stránka ' + (i + 1) + ' z ' + sbirka.length + (i === 0 ? ' (nabídka)' : '') + ' ===\n' + trimToSentences(s.text, i === 0 ? HLAVNI : podil)).join('\n\n');
  return trimToSentences(spojeno, LIMIT);
}

// Přesně to, co odejde do kontroly a co uživatel vidí v náhledu: { odkaz, text, obrazky, jsonld }. Obrázky a JSON-LD jsou z první stránky (nabídky).
function sestavPayload(sbirka) {
  return { odkaz: sbirka[0].odkaz, text: sestavText(sbirka), obrazky: sbirka[0].obrazky || [], jsonld: sbirka[0].jsonld || '' };
}

async function nactiSbirku() { return (await chrome.storage.session.get('sbirka')).sbirka || []; }
async function ulozSbirku(s) { await chrome.storage.session.set({ sbirka: s }); }

function hlasit(tabId, stav) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] })
    .then(() => chrome.scripting.executeScript({ target: { tabId }, func: (s) => nakupniKontrolaOverlay(s), args: [stav] }));
}
// Karta mohla mezitím zaniknout nebo přejít jinam; to nesmí zabránit vyprázdnění sbírky.
const hlasitTise = (tabId, stav) => hlasit(tabId, stav).catch((e) => console.warn('Překryv nelze zobrazit:', e));

const prehled = (sbirka) => sbirka.map((s) => ({ odkaz: s.odkaz, titulek: s.titulek, znaku: s.text.length }));

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['extract.js'] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => nakupniKontrolaExtract() });
    const sbirka = (await nactiSbirku()).filter((s) => s.odkaz !== result.odkaz); // stejná stránka se přepíše
    sbirka.push(result);
    await ulozSbirku(sbirka);
    await hlasit(tab.id, { faze: 'nahled', sbirka: prehled(sbirka), diagnostika: result.diagnostika, payload: sestavPayload(sbirka) });
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
    if (msg.akce === 'vymazat') { await ulozSbirku([]); await hlasitTise(tabId, { faze: 'prazdno' }); }
  })();
});

async function odeslat(tabId, sbirka) {
  if (odesila) return;
  odesila = true;
  try {
    await hlasitTise(tabId, { faze: 'odesilam', stran: sbirka.length });
    const payload = sestavPayload(sbirka);
    // Service worker MV3 se po ~30 s bez události ukončí; kontrola trvá déle, tak ho během čekání udržujeme při životě.
    const zivy = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
    let res = null;
    let spojeni = null;
    try {
      res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(CEKANI_MS) });
    } catch (e) {
      spojeni = e;
    } finally {
      clearInterval(zivy);
    }
    if (spojeni) {
      // Nic nedorazilo, sbírka zůstane pro další pokus.
      await hlasitTise(tabId, { faze: 'chyba', chyba: 'Kontrola není dostupná (' + spojeni + '). Běží n8n na 127.0.0.1:5678?' });
      return;
    }
    await ulozSbirku([]); // server odpověděl, obsah je u něj: sbírka se vyprázdní
    let odpoved;
    try { odpoved = await res.json(); } catch (e) { odpoved = { stav: 'chyba', chyba: 'Kontrola vrátila nečekanou odpověď (HTTP ' + res.status + ').' }; }
    await hlasitTise(tabId, { faze: 'vysledek', odpoved, stran: sbirka.length });
  } finally {
    odesila = false;
  }
}
