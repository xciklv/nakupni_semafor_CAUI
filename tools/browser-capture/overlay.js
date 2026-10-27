// Spouští se ve stránce: vykreslí překryv ve Shadow DOM (nedědí CSS stránky). Kořen je 'closed' a drží se v globální proměnné izolovaného světa
// rozšíření, takže stránka na okno nedosáhne přes host.shadowRoot. Není to hranice proti škodlivé stránce: ta vidí, že hostitel existuje,
// a může ho odstranit nebo překrýt; jde o to, aby běžný skript stránky nepřečetl sebraný text.
// Argument je stav { faze: 'nahled'|'odesilam'|'vysledek'|'chyba', ... }. Tlačítka posílají zprávy backgroundu.
function nakupniKontrolaOverlay(stav) {
  // Skript se vkládá znovu před každým vykreslením, proto se kořen nedrží v closure, ale v globálu izolovaného světa (stránka ho nevidí).
  // U closed kořene nejde z hostitele kořen znovu získat; když ho svět ztratil, hostitel se zahodí a vytvoří se nový.
  let host = document.getElementById('nakupni-semafor-host');
  if (host && !globalThis.nakupniKontrolaKoren) { host.remove(); host = null; }
  if (!host) {
    host = document.createElement('div');
    host.id = 'nakupni-semafor-host';
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;';
    document.documentElement.appendChild(host);
    globalThis.nakupniKontrolaKoren = host.attachShadow({ mode: 'closed' });
  }
  const root = globalThis.nakupniKontrolaKoren;
  root.replaceChildren();
  const css = document.createElement('style');
  css.textContent = ':host{all:initial}.box{font:14px/1.45 system-ui,sans-serif;color:#1a1a1a;background:#fff;border:1px solid #bbb;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);width:420px;max-height:80vh;overflow:auto;padding:12px 14px}h3{margin:0 0 6px;font-size:15px}p{margin:6px 0}small{color:#666}button{font:inherit;margin:6px 6px 0 0;padding:5px 10px;border:1px solid #888;border-radius:6px;background:#f4f4f4;cursor:pointer}button.p{background:#1b5e20;color:#fff;border-color:#1b5e20}.x{float:right;margin:0}.l{display:inline-block;padding:2px 10px;border-radius:10px;color:#fff;font-weight:600}.zelená{background:#2e7d32}.oranžová{background:#e65100}.červená{background:#c62828}.šedá{background:#616161}li{margin:2px 0}.sig{border-left:3px solid #999;padding-left:8px;margin:6px 0}.sig.high{border-color:#c62828}.sig.medium{border-color:#e65100}.sig.low{border-color:#f9a825}.sev{display:inline-block;margin-right:6px;padding:0 6px;border-radius:8px;background:#eee;color:#444;font-size:12px}.sig.high .sev{background:#c62828;color:#fff}.sig.medium .sev{background:#e65100;color:#fff}.sig.low .sev{background:#f9a825;color:#1a1a1a}summary{cursor:pointer;font-weight:600;margin:10px 0 2px}.pozn{color:#555;margin:4px 0}h4{margin:10px 0 2px;font-size:13px}pre{font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;background:#f6f6f6;border:1px solid #ddd;border-radius:6px;padding:6px;margin:2px 0}';
  const box = document.createElement('div');
  box.className = 'box';
  const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
  const zavrit = el('button', '×', 'x');
  zavrit.onclick = () => host.remove();
  box.append(zavrit, el('h3', 'Nákupní semafor'));
  const tlacitko = (txt, akce, cls) => { const b = el('button', txt, cls); b.onclick = () => chrome.runtime.sendMessage({ akce }); return b; };

  const MAX_KARET = 6; // zbytek skupiny je pod „+N dalších“, nic se neořezává
  const sbalene = (nadpis, obsah) => { const d = el('details'); d.append(el('summary', nadpis), ...obsah); return d; };
  const SEVERITY = ['info', 'low', 'medium', 'high'];
  const STITEK = { info: 'Informace', low: 'Nízká', medium: 'Střední', high: 'Vysoká' };
  // Karta nálezu: štítek závažnosti, titul a důkaz. Co se nepodařilo ověřit (nelze_overit) nemá štítek ani barvu varování.
  const karta = (n, nelze) => {
    const zav = nelze ? 'info' : (SEVERITY.includes(n.zavaznost) ? n.zavaznost : 'low');
    const d = el('div', null, 'sig ' + zav);
    const hlavicka = el('div');
    if (!nelze) hlavicka.append(el('span', STITEK[zav], 'sev'));
    hlavicka.append(el('b', String(n.titul || '')));
    d.append(hlavicka);
    if (n.dukaz) d.append(el('div', String(n.dukaz)));
    return d;
  };
  // Stejné skupiny jako webovka: tvrzení, která nesedí; rizika; nepodařilo se ověřit (sbalené). Starší odpověď bez `nalezy` se ukáže ze `signaly`.
  const vykresliNalezy = (r) => {
    const signaly = (Array.isArray(r.signaly) ? r.signaly : []).filter((s) => s && typeof s === 'object');
    const nalezy = (Array.isArray(r.nalezy) ? r.nalezy : []).filter((n) => n && typeof n === 'object' && (n.titul || n.dukaz));
    const skupina = (nadpis, seznam) => { if (!seznam.length) return; const g = el('div', null, 'skupina'); g.append(el('h4', nadpis), ...seznam.slice(0, MAX_KARET).map((n) => karta(n, false))); if (seznam.length > MAX_KARET) g.append(sbalene('+' + (seznam.length - MAX_KARET) + ' dalších', seznam.slice(MAX_KARET).map((n) => karta(n, false)))); box.append(g); };
    if (Array.isArray(r.nalezy) && (nalezy.length || !signaly.length)) {
      skupina('Tvrzení, která nesedí', nalezy.filter((n) => n.druh === 'nesmysl' || n.druh === 'rozpor'));
      skupina('Rizika', nalezy.filter((n) => n.druh !== 'nesmysl' && n.druh !== 'rozpor' && n.druh !== 'nelze_overit'));
      const nelze = nalezy.filter((n) => n.druh === 'nelze_overit');
      if (nelze.length) {
        const det = el('details');
        det.append(el('summary', 'Nepodařilo se ověřit (' + nelze.length + ')'), el('p', 'Nenalezení údaje není podezření na nabídku, jen jsme ho nemohli potvrdit.', 'pozn'), ...nelze.map((n) => karta(n, true)));
        box.append(det);
      }
    } else if (signaly.length) {
      skupina('Zjištěné signály', signaly);
    }
  };

  if (stav.faze === 'nahled') {
    const d = stav.diagnostika;
    const p = stav.payload;
    box.append(el('p', 'Sběr: ' + stav.sbirka.length + ' ' + (stav.sbirka.length === 1 ? 'stránka' : stav.sbirka.length < 5 ? 'stránky' : 'stránek') + '. Právě přidáno: ' + d.sirkaTextuPoOdstraneni + ' znaků textu (po odstranění hlavičky a menu), JSON-LD ' + d.jsonLd + ', vložená data: ' + (d.vlozenaData.join(', ') || 'žádná') + '.'));
    const ol = el('ol');
    stav.sbirka.forEach((s) => ol.append(el('li', (s.titulek || s.odkaz).slice(0, 70) + ' (' + s.znaku + ' zn.)')));
    box.append(ol);
    box.append(el('b', 'Tohle se odešle do kontroly. Nic jiného z karty neodchází, nic se zatím neodeslalo.'));
    box.append(el('h4', 'Odkaz'), el('pre', p.odkaz));
    box.append(el('h4', 'Text (' + p.text.length + ' znaků)'), el('pre', p.text));
    if (p.obrazky.length) box.append(el('h4', 'Adresy obrázků (' + p.obrazky.length + ')'), el('pre', p.obrazky.join('\n')));
    if (p.jsonld) box.append(el('h4', 'JSON-LD (' + p.jsonld.length + ' znaků)'), el('pre', p.jsonld));
    box.append(el('small', 'Přejděte na další stránku (např. prodejce) a klikněte na ikonu znovu, nebo spusťte kontrolu. První stránka je nabídka; po odeslání se sběr vyprázdní.'));
    box.append(document.createElement('br'), tlacitko('Zkontrolovat', 'odeslat', 'p'), tlacitko('Vymazat sběr', 'vymazat'));
  } else if (stav.faze === 'prazdno') {
    box.append(el('p', 'Sběr je prázdný. Klikněte na ikonu na stránce nabídky.'));
  } else if (stav.faze === 'odesilam') {
    box.append(el('p', 'Kontrola běží (' + stav.stran + ' str.)… obvykle 20–60 s'));
  } else if (stav.faze === 'chyba') {
    box.append(el('p', stav.chyba), el('small', 'Sběr zůstal uložený, jde to zkusit znovu.'), document.createElement('br'), tlacitko('Zkusit znovu', 'odeslat', 'p'), tlacitko('Vymazat sběr', 'vymazat'));
  } else if (stav.faze === 'vysledek') {
    const r = stav.odpoved || {};
    if (r.stav === 'chyba') box.append(el('p', String(r.chyba || 'Kontrola selhala.')));
    else if (r.stav === 'potrebuji_vice') box.append(el('p', String(r.zprava || 'Kontrola potřebuje víc podkladů.')));
    else {
      const sem = ['zelená', 'oranžová', 'červená', 'šedá'].includes(r.semafor) ? r.semafor : 'šedá';
      box.append(el('span', { 'zelená': 'Nízké riziko', 'oranžová': 'Střední riziko', 'červená': 'Vysoké riziko', 'šedá': 'Nelze posoudit' }[sem], 'l ' + sem));
      box.append(el('p', String(r.shrnuti || '')), el('small', 'Jistota kontroly: ' + String(r.jistota || '')));
      const nezkontrolovano = (Array.isArray(r.nezkontrolovano) ? r.nezkontrolovano : []).filter((x) => typeof x === 'string' && x.trim());
      if (nezkontrolovano.length) box.append(el('p', 'Nezkontrolováno: ' + nezkontrolovano.join(', '), 'pozn'));
      vykresliNalezy(r);
      const ul = el('ul');
      (Array.isArray(r.co_delat) ? r.co_delat : []).forEach((t) => ul.append(el('li', String(t))));
      box.append(ul);
    }
    box.append(el('small', 'Sběr je vyprázdněný; další kontrola začíná kliknutím na ikonu na stránce nabídky.'));
  }
  root.append(css, box);
}
