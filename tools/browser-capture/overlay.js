// Spouští se ve stránce: vykreslí překryv ve Shadow DOM (stránka na něj nedosáhne a on nedědí její CSS).
// Argument je stav { faze: 'nahled'|'odesilam'|'vysledek'|'chyba', ... }. Tlačítka posílají zprávy backgroundu.
function nakupniKontrolaOverlay(stav) {
  let host = document.getElementById('nakupni-kontrola-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'nakupni-kontrola-host';
    host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;';
    document.documentElement.appendChild(host);
    host.attachShadow({ mode: 'open' });
  }
  const root = host.shadowRoot;
  root.replaceChildren();
  const css = document.createElement('style');
  css.textContent = ':host{all:initial}.box{font:14px/1.45 system-ui,sans-serif;color:#1a1a1a;background:#fff;border:1px solid #bbb;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.3);width:360px;max-height:80vh;overflow:auto;padding:12px 14px}h3{margin:0 0 6px;font-size:15px}p{margin:6px 0}small{color:#666}button{font:inherit;margin:6px 6px 0 0;padding:5px 10px;border:1px solid #888;border-radius:6px;background:#f4f4f4;cursor:pointer}button.p{background:#1b5e20;color:#fff;border-color:#1b5e20}.x{float:right;margin:0}.l{display:inline-block;padding:2px 10px;border-radius:10px;color:#fff;font-weight:600}.zelená{background:#2e7d32}.oranžová{background:#e65100}.červená{background:#c62828}.šedá{background:#616161}li{margin:2px 0}.sig{border-left:3px solid #999;padding-left:8px;margin:6px 0}';
  const box = document.createElement('div');
  box.className = 'box';
  const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
  const zavrit = el('button', '×', 'x');
  zavrit.onclick = () => host.remove();
  box.append(zavrit, el('h3', 'Nákupní kontrola'));
  const tlacitko = (txt, akce, cls) => { const b = el('button', txt, cls); b.onclick = () => chrome.runtime.sendMessage({ akce }); return b; };

  if (stav.faze === 'nahled') {
    const d = stav.diagnostika;
    box.append(el('p', 'Sběr: ' + stav.sbirka.length + ' ' + (stav.sbirka.length === 1 ? 'stránka' : stav.sbirka.length < 5 ? 'stránky' : 'stránek') + '. Právě přidáno: ' + d.sirkaTextuPuvodni + ' znaků textu, obrázků ' + stav.obrazky + ', JSON-LD ' + d.jsonLd + ', vložená data: ' + (d.vlozenaData.join(', ') || 'žádná') + '.'));
    const ol = el('ol');
    stav.sbirka.forEach((s) => ol.append(el('li', (s.titulek || s.odkaz).slice(0, 70) + ' (' + s.znaku + ' zn.)')));
    box.append(ol);
    box.append(el('small', 'Nic se zatím neodeslalo. Přejděte na další stránku (např. prodejce) a klikněte na ikonu znovu, nebo spusťte kontrolu. První stránka je nabídka.'));
    box.append(document.createElement('br'), tlacitko('Zkontrolovat sběr', 'odeslat', 'p'), tlacitko('Vymazat sběr', 'vymazat'), tlacitko('Uložit náhled (JSON)', 'ulozit'));
  } else if (stav.faze === 'prazdno') {
    box.append(el('p', 'Sběr je prázdný. Klikněte na ikonu na stránce nabídky.'));
  } else if (stav.faze === 'odesilam') {
    box.append(el('p', 'Kontrola běží (' + stav.stran + ' str.)… obvykle 20–60 s'));
  } else if (stav.faze === 'chyba') {
    box.append(el('p', stav.chyba), tlacitko('Uložit náhled (JSON)', 'ulozit'));
  } else if (stav.faze === 'vysledek') {
    const r = stav.odpoved || {};
    if (r.stav === 'chyba') box.append(el('p', String(r.chyba || 'Kontrola selhala.')));
    else if (r.stav === 'potrebuji_vice') box.append(el('p', String(r.zprava || 'Kontrola potřebuje víc podkladů.')));
    else {
      const sem = ['zelená', 'oranžová', 'červená', 'šedá'].includes(r.semafor) ? r.semafor : 'šedá';
      box.append(el('span', { 'zelená': 'Nízké riziko', 'oranžová': 'Střední riziko', 'červená': 'Vysoké riziko', 'šedá': 'Nelze posoudit' }[sem], 'l ' + sem));
      box.append(el('p', String(r.shrnuti || '')), el('small', 'Jistota kontroly: ' + String(r.jistota || '')));
      (Array.isArray(r.signaly) ? r.signaly : []).slice(0, 6).forEach((s) => { const d = el('div', null, 'sig'); d.append(el('b', String(s.titul || '')), el('div', String(s.dukaz || ''))); box.append(d); });
      const ul = el('ul');
      (Array.isArray(r.co_delat) ? r.co_delat : []).forEach((t) => ul.append(el('li', String(t))));
      box.append(ul);
    }
    box.append(tlacitko('Uložit náhled (JSON)', 'ulozit'));
  }
  root.append(css, box);
}
