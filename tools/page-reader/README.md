# Čtečka stránek (page-reader)

Malá lokální služba, která otevře veřejnou stránku ve skutečném headless Chromiu a vrátí její viditelný text.
Nákupní semafor ji volá pro **marketplace** (AliExpress, Temu, Allegro, …): ty se kreslí JavaScriptem, takže
obyčejné stažení HTML z nich dostane jen kostru bez ceny, prodejce a recenzí.

Není povinná. Neběží-li, workflow postupuje jako dřív (obyčejné stažení, případně výzva k vložení screenshotu).

## Spuštění

```bash
npm run reader
```

Poslouchá jen na `127.0.0.1:5687` (změna: `PAGE_READER_PORT`). Workflow na ni míří přes `PAGE_READER_URL`
při sestavení (`http://127.0.0.1:5687/read`, `off` = vypnuto). Port 5679 se nehodí: používá ho n8n (task broker pro Code nody).

Potřebuje Playwright a Chromium:

```bash
npm i playwright
npx playwright install chromium
```

nebo `PLAYWRIGHT_PATH=<cesta k modulu playwright>` (jinak se zkusí `playwright` a vedlejší projekt `contact-screening-project`).

## API

| Požadavek | Odpověď |
|---|---|
| `POST /read` s hlavičkou `X-Nakupni-Kontrola: 1` a tělem `{"url":"https://…"}` | `{ok:true, text, title, finalUrl, status, ms}` nebo `{ok:false, duvod}` |
| `POST /collect`, tělo `{"url":"https://…"}` (stejná hlavička) | `{ok:true, dossier}` (tvar `nakupni-kontrola/dossier@0-spike` ze sběrače `tools/page-collector`, přijme ho `normalizeDossier`) nebo `{ok:false, duvod, blokace?:{druh, dodavatel}}`; `blokace` je vyplněna, když stránka vyžaduje ověření (CAPTCHA) nebo přihlášení |
| `POST /images`, tělo `{"urls":["https://…", …]}` (1 až 8 adres, jen `https:`) | `{ok:true, obrazky:[{url, mime:'image/jpeg', data /* base64, delší strana nejvýše 768 px */, dhash /* 16 hex */}], vynechano?:[{url, duvod}]}`; nestažitelný obrázek se vynechá a vypíše do `vynechano` |
| `GET /health` | `{ok:true}` |

## Bezpečnost

- Jen `127.0.0.1`; povinná vlastní hlavička vynutí CORS preflight, takže požadavek nemůže poslat cizí webová stránka.
- SSRF: hlavní adresa, **každý podpožadavek stránky** i konečná adresa po přesměrování se kontrolují. Povoluje se jen veřejné
  http(s); jména se překládají a odmítne se vše, co míří na interní, loopback, link-local nebo jinak neveřejnou adresu
  (včetně IPv6 a wildcard-DNS služeb typu nip.io).
- Obrázky, média a písma se nenačítají (zrychlení; text nabídky je v HTML).
- Obrázky (`/images`): každá adresa i každý krok přesměrování se kontroluje (SSRF), přesměrování se nenásledují automaticky, jen `https:`, jen typy `image/*` (bez SVG), originál nejvýše 12 MB, 10 s na stažení. Zmenšení a dHash dělá Chromium bez sítě (`about:blank`).
- Jeden požadavek najednou, nejvýše dva čekají, pak `429`. Tvrdý limit 40 s na stránku, text max. 15 000 znaků.
- **Žádné obcházení ochrany proti robotům.** Pokud stránka vyžaduje ověření (CAPTCHA, „unusual traffic“), čtečka to jen
  nahlásí (`ok:false`) a workflow se vrátí k obyčejnému stažení / výzvě ke screenshotu.
- Text ze stránky je pro model nedůvěryhodná data (stejně jako dříve): v promptu se escapují `<` a `>`.
