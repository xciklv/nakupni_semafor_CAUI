# Nákupní semafor

Pomůcka, která před nákupem zkontroluje online nabídku a ukáže, co na ní nesedí a co se nepodařilo ověřit. Výsledkem je semafor (zelená, oranžová, červená, šedá), krátké vysvětlení pro laika a seznam nálezů.

## K čemu to je

Při nákupu na neznámém e-shopu nebo marketplace člověk neví, čemu věřit. Kontrola se dívá na dvě věci, které se dají poznat z dat už v nabídce:

- **Prodejce:** je firma v seznamu rizikových e-shopů ČOI, existuje v ARES, platí DIČ ve VIES, jak je stará doména.
- **Nabídka sama:** rozpory v textu, nesmyslné parametry (například fyzikálně nemožné), chybějící údaje o shodě (CE, GPSR), text na fotkách proti textu nabídky, cizí EAN.

U každého nálezu ukáže, **co nabídka tvrdí, proč to nesedí a jak si je kontrola jistá**, a u nesmyslu v textu i hotovou otázku pro prodejce.

Příklad (AliExpress, svítilna s „25 500 lm“ v titulku, variantou 2 000–3 000 lm a fotkou „MAX 12000 LM“): semafor **oranžová**, nález „tvrzení v nabídce nedává smysl“ s výpočtem („pro takový světelný výkon by bylo potřeba kolem 250 W, což malá svítilna nezvládne uchladit ani napájet“) a otázkou pro prodejce, kterou lze jedním kliknutím zkopírovat.

Výsledek je **pomůcka, ne právní verdikt**. „Nelze ověřit“ není podezření a kontrola nikoho neobviňuje.

## Jak to funguje

```
 odkaz / screenshoty / vložený text / rozšíření v prohlížeči
                       │
            ┌──────────┴───────────┐
            │  sběr dat → dossier  │  čtečka stránek (marketplace),
            │                      │  nebo extrakce textu / screenshotu (LLM)
            └──────────┬───────────┘
   ┌─────────┬─────────┼──────────┬───────────┬──────────┐
 nabídka  prodejce  bezpečnost  identita   věrohodnost  obrázky
 (pravidla) (ČOI,    (CE, GPSR,  (GTIN,     (LLM, Sonnet) (LLM, Haiku)
            ARES,    Safety      Icecat)
            RDAP,    Gate)
            VIES)
   └─────────┴─────────┴────┬─────┴───────────┴──────────┘
                            │  nálezy
                  skórování a semafor (pravidla, ne úsudek modelu)
                            │
          vysvětlení pro laika (LLM) → semafor, shrnutí, nálezy
```

Moduly jsou čisté funkce v [engine/](engine/) bez závislostí. Semafor počítají pravidla nad nálezy ([engine/scoring.js](engine/scoring.js)), model jen čte nestrukturovaná data a píše vysvětlení. Orchestraci dělá workflow v n8n (`node build/build-workflow.js` ho sestaví z `engine/` a `build/glue/`).

## Požadavky

- Node.js (vývoj běžel na v24.12.0)
- lokální **n8n 2.17.x**
- v n8n credential typu *Anthropic API* (klíč do repa nepatří; credential vytvoříte v n8n sami a jeho id vidíte v adrese při jeho otevření)
- volitelně Playwright a Chromium pro čtečku stránek

## Spuštění

**1. Sestavení workflow.** Vznikne `workflow.json` (API) a `workflow-web.json` (stránka); oba jsou v `.gitignore`.

```bash
ANTHROPIC_CRED_ID=<id credentialu> ANTHROPIC_CRED_NAME=Anthropic node build/build-workflow.js
```

V PowerShellu nejdřív `$env:ANTHROPIC_CRED_ID = '<id>'; $env:ANTHROPIC_CRED_NAME = 'Anthropic'` a pak `node build/build-workflow.js`.

**2. Import do n8n.** `n8n import:workflow` u nového workflow vyžaduje pole `id`. Použijte tato id, protože na ně míří i `npm run purge`:

```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path');for(const [f,id] of [['workflow.json','mHufaoyMTJDT3vQG'],['workflow-web.json','nkWebStrankaV1x7q']]){const w=JSON.parse(fs.readFileSync(f,'utf8'));w.id=id;const o=p.join(os.tmpdir(),id+'.json');fs.writeFileSync(o,JSON.stringify(w));console.log(o)}"
```

Příkaz vypíše dvě cesty k dočasným souborům. Každý importujte (`n8n import:workflow --input=<cesta>`) a oba workflow pak v editoru n8n **zapněte (Active)**. Technické identifikátory (cesty webhooků, názvy workflow, hlavička `X-Nakupni-Kontrola`, schéma dossieru) nesou název `nakupni-kontrola`; mají zůstat, jak jsou.

**3. Čtečka stránek** (volitelná; bez ní se u marketplace použije jednoduché stažení nebo výzva vložit text):

```bash
npm run reader
```

Poslouchá jen na `127.0.0.1:5687`. Potřebuje Playwright a Chromium (`npm i playwright`, `npx playwright install chromium`, nebo `PLAYWRIGHT_PATH`); podrobnosti jsou v [tools/page-reader/README.md](tools/page-reader/README.md).

## Použití

**Webovka:** otevřete `http://127.0.0.1:5678/webhook/nakupni-kontrola-web`, vložte odkaz na nabídku (případně až čtyři screenshoty) a klikněte na „Zkontrolovat“. Kontrola trvá asi 5 až 45 sekund. Výsledek ukáže semafor, shrnutí, co dělat a nálezy ve skupinách *Tvrzení, která nesedí*, *Rizika* a *Nepodařilo se ověřit*. Druhá záložka, **První pomoc při podvodu**, je statický návod pro čtyři situace (nedoručený e-shop, zmizelý prodejce, falešný kupující, vylákané údaje); nic neposílá modelu a obsah **není odborně zrevidovaný**.

**API:**

```bash
curl -s -X POST -H "Content-Type: application/json" -d '{"odkaz":"https://www.aliexpress.com/item/1005011759581041.html"}' http://127.0.0.1:5678/webhook/nakupni-kontrola
```

Tělo může nést `odkaz`, vložený `text` nebo `screenshoty`. Jedna kontrola zavolá model a stojí asi 0,01–0,03 USD.

**Rozšíření v prohlížeči:** pro nabídky, které server nedostane (Allegro, Temu), existuje rozšíření pro Chrome ([tools/browser-capture/](tools/browser-capture/README.md)). Přečte stránku, kterou jste otevřeli vy, ukáže celý text, který odejde, a teprve po potvrzení ho pošle do lokální kontroly. Je to zatím ověření konceptu.

## Konfigurace

Proměnné při sestavení workflow (`build-workflow.js`):

| Proměnná | Význam |
|---|---|
| `LLM_MODEL_EXTRACT` | extrakce textu a screenshotů (výchozí Claude Haiku 5.5, `claude-haiku-5-5`) |
| `LLM_MODEL_PLAUSIBILITY` | věrohodnost tvrzení: fyzika, rozpory (výchozí Claude Sonnet 5.5, `claude-sonnet-5-5`) |
| `LLM_MODEL_IMAGES` | analýza obrázků, 3 běhy (výchozí Claude Haiku 5.5) |
| `LLM_MODEL_EXPLAIN` | vysvětlení pro laika (výchozí Claude Haiku 5.5) |
| `QUOTA_PER_DAY` | denní limit kontrol (výchozí 200) |
| `PAGE_READER_URL` | adresa čtečky (výchozí `http://127.0.0.1:5687/read`, `off` čtečku vypne) |
| `SAVE_EXECUTIONS` | `all` (výchozí) nebo `none`, viz [Data a soukromí](#data-a-soukromí) |

Jedna kontrola stojí **asi 0,01–0,03 USD** (textová s Haiku nejméně, s věrohodností a obrázky asi 0,02 USD).

## Data a soukromí

n8n si lokálně ukládá průběhy kontrol včetně odeslaných textů (pro ladění; u Allegra může text obsahovat jméno přihlášeného účtu). Nic z toho neopouští počítač, kromě volání uvedených níže.

**Co kdo dostane.** Anthropic (poskytovatel modelu) dostává texty, screenshoty a odkazy z nabídky a adresy obrázků; webovka to uvádí. Ostatní třetí strany dostanou jen veřejné identifikátory a pojmy z nabídky: IČO (ARES), DIČ (VIES), EAN (Icecat), doménu (RDAP), značku a model (EU Safety Gate); seznam ČOI se jen stáhne. Texty ani screenshoty uživatele nikdy.

**Mazání dat:**

1. **Neukládat:** sestavit workflow s `SAVE_EXECUTIONS=none` a znovu ho nasadit.
2. **Mazat samo:** v nastavení n8n `EXECUTIONS_DATA_PRUNE=true` a `EXECUTIONS_DATA_MAX_AGE=<hodiny>` (platí pro všechna workflow v instanci).
3. **Smazat teď:** [tools/purge-executions.js](tools/purge-executions.js) smaže průběhy obou workflow přes API n8n. Klíč (Settings → n8n API) se čte jen z proměnné `N8N_API_KEY`, nikam se neukládá ani nevypisuje; skript mluví jen s `127.0.0.1` a `localhost`. Bez `--yes` jen vypíše, kolik by smazal.

```bash
N8N_API_KEY=<klíč> npm run purge
```

Se smazáním: `npm run purge -- --yes` (volitelně `--older-than-hours N`). V PowerShellu `$env:N8N_API_KEY = '<klíč>'` předem.

## Testy

```bash
npm test
```

Testy nevolají žádné API. **Eval** (sada 41 případů v [eval/cases.json](eval/cases.json)) volá skutečné API, tedy stojí peníze; spouští se proti běžícímu n8n:

```bash
node eval/run-eval.js --ids produkt-cyklosvitilna-odkaz,text-kabel-ok --repeat 3 --gate
```

Přepínače: `--only <label>`, `--ids a,b`, `--repeat N`, `--gate`. Proměnné `API`, `DELAY_MS`, `TIMEOUT_MS`. Výstup se zapíše do `eval/vysledky.md` a `eval/vysledky.json` (oba v `.gitignore`).

## Struktura repa

| Cesta | Obsah |
|---|---|
| `engine/` | moduly kontroly (čisté funkce, plain Node bez závislostí) |
| `build/` | sestavení n8n workflow (`build-workflow.js`, kód uzlů v `build/glue/`) |
| `web/index.html` | webovka (běží z n8n) |
| `tools/page-reader/` | lokální čtečka stránek a obrázků |
| `tools/browser-capture/` | rozšíření pro Chrome |
| `tools/purge-executions.js` | mazání uložených průběhů |
| `tools/page-collector/`, `tools/image-check/` | kód ze spiků, základ pro čtečku a obrázky |
| `eval/` | testovací sada, vyhodnocení a kritérium stability |
| `tests/` | testy (`node --test`) |

## Licence

Apache License 2.0, viz [LICENSE](LICENSE).
