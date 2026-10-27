# browser-capture: rozšíření do Chrome (další cesta sběru dat, ověření konceptu)

Rozšíření pro Chrome (Manifest V3), které po kliknutí přečte stránku, kterou už uživatel otevřel a prošel, **ukáže celý text, který odejde**, a po potvrzení ho pošle do Nákupního semaforu (`POST http://127.0.0.1:5678/webhook/nakupni-kontrola`, tělo `{ odkaz, text, obrazky, jsonld }`). Jen čte: na stránce nic neklikne, nerozbalí ani nevyplní. Proč právě rozšíření: čte to, co člověk vidí, takže prochází i Allegro, které server blokuje.

## Instalace (1 minuta)

1. Spusťte n8n lokálně (`127.0.0.1:5678`) a ověřte, že workflow „Nákupní kontrola“ je aktivní a nasazené s aktuálním `build/glue/01-vstup.js`.
2. V Chrome otevřete `chrome://extensions` a vpravo nahoře zapněte „Režim pro vývojáře“.
3. Klikněte na „Načíst rozbalené“ a vyberte složku `tools/browser-capture` (ta, kde leží `manifest.json`).
4. V seznamu se objeví „Nákupní semafor – sběr stránky“ (verze 0.2.0). Bez chybové hlášky u karty rozšíření je instalace v pořádku. Přišpendlete ikonu (puzzle na liště, špendlík u rozšíření).
5. Po každé změně souborů v této složce klikněte u rozšíření na „Znovu načíst“ (kruhová šipka) a na otevřených stránkách obnovte kartu.

## Použití

1. Otevřete stránku nabídky (Allegro, AliExpress, Temu…). Případně sami rozbalte recenze, parametry a popis: rozšíření nic nerozbaluje, přečte jen to, co je na stránce.
2. Klikněte na ikonu rozšíření. Vpravo nahoře se ukáže okno „Nákupní semafor“ s **celým textem, který by se odeslal** (odkaz, text, adresy obrázků, JSON-LD). Nic se zatím neodeslalo.
3. „Zkontrolovat“ odešle přesně to, co vidíte. Po 10 až 60 s se v okně ukáže semafor, shrnutí a nálezy ve stejných skupinách jako na webovce (tvrzení, která nesedí; rizika; „nepodařilo se ověřit“ sbalené a bez barvy varování). Kontrola stojí řádově 0,01 až 0,03 USD.
4. „Vymazat sběr“ zahodí sebrané stránky bez odeslání. Okno zavřete tlačítkem ×.

Víc stránek najednou: po kliknutí na ikonu přejděte třeba na stránku prodejce a klikněte znovu. Každé kliknutí přidá stránku do sbírky (drží se do zavření prohlížeče, stejná adresa se přepíše), „Zkontrolovat“ pošle všechny stránky jako jeden text. První stránka je nabídka (dostane až 12 000 znaků z 20 000, obrázky a JSON-LD se berou z ní). **Po provedené kontrole se sbírka vyprázdní.** Když kontrola neproběhne (n8n neběží, denní limit, příliš velký text, chyba serveru), sbírka zůstane pro další pokus a okno řekne proč.

## Co se odesílá a co ne

- `odkaz`: adresa karty jen s parametry, které určují nabídku (allowlist: `offerId`, `id`, `p`, `pid`, `product`, `sku`, `item`, `product_id`, `productId`, `id_product`, `goods_id`, `item_id`, `itemId`, `sku_id`, `variant`, `route`). Všechny ostatní parametry (sledovací jako `fbclid`, `gclid`, `utm_*`, relační a osobní jako `token`, `sid`, e-mail, i neznámé), `#fragment` a přihlašovací údaje se zahodí; identifikátory v cestě (`/item/123.html`) zůstávají.
- `text`: viditelný text stránky bez hlavičky a menu (vše před titulkem nabídky a řádky typu „Můj účet“, „Košík“, pozdrav se jménem), ořezaný na celé věty, nejvýše 20 000 znaků.
- `obrazky`: nejvýše 8 adres `https://` (každá do 500 znaků, z adresy se odstraní jen známé sledovací parametry (`utm_*`, `gclid`, `fbclid`, `msclkid`…), podpis, rozměr nebo `?file=` zůstanou, protože u CDN určují obrázek). Jen adresy, obrázky se nestahují z prohlížeče.
- `jsonld`: strukturovaná data stránky (cena, hodnocení, recenze), nejvýše 4 000 znaků.
- Nečte se: cookies, `localStorage`, hesla, formuláře, jiné karty. Oprávnění `activeTab` platí jen pro kartu, na kterou kliknete; `host_permissions` jen pro lokální n8n.
- Stránky ve sbírce jsou v `chrome.storage.session` (jen v paměti prohlížeče, zmizí při zavření).

## Co zkontrolovat při ručním ověření (první spuštění ve vašem Chrome)

1. Rozšíření se načte bez chyby (`chrome://extensions`, žádné „Chyby“ u karty) a ikona jde kliknout na stránce Allegra i AliExpressu.
2. **Allegro** (nabídka s `offerId`, např. OneBlade): v okně je celý text; v textu ani v odkazu **není jméno vašeho účtu** (hledejte ho klávesou Ctrl+F v okně, i v části JSON-LD), v odkazu zůstalo `offerId`; adresy obrázků jsou `https://…allegroimg.com/…`.
3. **AliExpress** (např. cyklosvítilna 1005011759581041): v odkazu nejsou `spm` ani `algo_pvid`; v textu je cena, hodnocení a prodejce; JSON-LD obsahuje Product.
4. „Zkontrolovat“: okno ukáže průběh a po dokončení semafor. Spusťte to u dlouhé kontroly (nad 30 s): výsledek se musí zobrazit (oprava service workeru ze spiku).
5. V n8n u průběhu (Executions → „Vstup a načtení“): `odkaz`, `text`, `obrazky`, `jsonld` jsou v těle žádosti; uzel nevolal čtečku ani HEAD/GET (žádné požadavky na allegro.cz ani aliexpress.com); jméno účtu v uloženém těle není.
6. Po odeslání kliknutí na ikonu na jiné stránce začíná **nová** sbírka (v okně je „Sběr: 1 stránka“).

## Soubory

- `manifest.json`: MV3, oprávnění `activeTab`, `scripting`, `storage`, `host_permissions` jen pro `http://127.0.0.1:5678/*`.
- `background.js`: service worker: ikona, vkládání skriptů, sbírka v `chrome.storage.session`, odeslání z workeru (nevztahuje se na něj CSP stránky). Při dlouhé kontrole se worker udržuje při životě (`getPlatformInfo` každých 20 s) a čekání má limit 180 s.
- `extract.js`: čtení stránky a čisté funkce `cleanUrl`, `trimToSentences`, `dropPageChrome` (testy: `tests/browser-capture.test.js`).
- `overlay.js`: okno ve Shadow DOM (nedědí CSS stránky; kořen je `closed`, takže ho skript stránky nepřečte přes `shadowRoot`; škodlivá stránka ho ale může odstranit nebo překrýt), jen `textContent`, žádné `innerHTML`.
- `bookmarklet.html`: sonda ze spiku (zdarma, posílá `{}` a čeká 400). Bookmarklet není podporovaná cesta: Chrome blokuje přístup z webu do místní sítě.

## Omezení

- Instalace v režimu pro vývojáře je pro demo; pro skutečné uživatele je nutný Chrome Web Store a `host_permissions` na veřejnou adresu API.
- Text bez jména účtu se spoléhá na rozpoznání řádků menu a titulku nabídky. Je-li jméno na stránce na jiném místě (např. v textu recenze), zůstane: proto se celý odesílaný text před odesláním ukazuje.
- Úplnost závisí na uživateli: co nerozbalí (recenze, parametry), v textu nebude. Popisek prodejce na AliExpressu v `innerText` není.
