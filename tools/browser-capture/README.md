# browser-capture (spike)

Rozšíření pro Chrome (Manifest V3), které po kliknutí přečte stránku, kterou už uživatel otevřel a prošel, a pošle ji do Nákupní kontroly (`POST http://127.0.0.1:5678/webhook/nakupni-kontrola`, tělo `{ odkaz, text }`). Jen čte, na stránce nic neklikne ani nerozbaluje.

## Instalace (1 minuta)

1. V Chrome otevřete `chrome://extensions`, zapněte „Režim pro vývojáře“.
2. „Načíst rozbalené“ a vyberte tuto složku (`tools/browser-capture`).
3. Přišpendlete ikonu rozšíření na lištu.
4. n8n musí běžet na `127.0.0.1:5678` a workflow „Nákupní kontrola“ být aktivní.

## Použití

1. Otevřete stránku nabídky a projděte ověření / rozbalte recenze a parametry sami (rozšíření nic nerozbaluje).
2. Klikněte na ikonu. Vpravo nahoře se ukáže překryv: kolik znaků se přečetlo, kolik obrázků, JSON-LD a vložená data. Nic se zatím neodeslalo.
3. „Zkontrolovat“ odešle text do kontroly (stojí asi 0,02 USD), po 20–60 s se v překryvu ukáže semafor, shrnutí a signály.
4. „Uložit náhled (JSON)“ uloží do Stažených soubor `browser-capture-<doména>-<čas>.json` s odesílaným textem, diagnostikou a odpovědí (pro měření).

## Vícekrokový sběr

Každé kliknutí na ikonu přidá aktuální stránku do sbírky (platí napříč kartami a oknem, drží se do zavření prohlížeče; stejná adresa se přepíše). Typický postup: stránka nabídky → klik na ikonu → otevřít stránku prodejce / jeho hodnocení → klik na ikonu → „Zkontrolovat sběr“. První stránka je považovaná za nabídku (dostane až 12 000 znaků), ostatní si dělí zbytek do 20 000. „Vymazat sběr“ začne znovu.

## Soubory

- `manifest.json`: MV3, oprávnění `activeTab`, `scripting`, `downloads`, `storage`, `host_permissions` jen pro `http://127.0.0.1:5678/*`.
- `background.js`: ikona, vkládání skriptů, odeslání (z service workeru, takže se nevztahuje CSP stránky).
- `extract.js`: čtení stránky (text, titulek, URL, max 8 obrázků, JSON-LD, vložená data), text max 20 000 znaků ořezaný na celé věty.
- `overlay.js`: překryv ve Shadow DOM.
- `bookmarklet.html`: sonda bookmarkletu (zdarma, posílá `{}` a čeká 400), zjišťuje, jestli `fetch` ze stránky na 127.0.0.1 vůbec projde.
