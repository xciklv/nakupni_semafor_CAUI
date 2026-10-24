#!/usr/bin/env node
// Náhled webové stránky bez n8n a bez volání LLM: server na localhostu servíruje web/index.html a místo API vrací hotové odpovědi.
// Spuštění: node tools/preview-web.js [port]    (výchozí port 8765; stránka se při každém načtení čte znovu, takže úpravy stačí obnovit)
// Adresy: /zelena /oranzova /cervena /seda (výsledek se po načtení sám odešle), /formular, /prvni-pomoc#prvni-pomoc/eshop-nedoruceno
// Přepínač motivu: ?tema=tmavy nebo ?tema=svetly (bez něj podle systému).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'web', 'index.html');
const PORT = Number(process.argv[2]) || 8765;
const UPOZORNENI = 'Nákupní semafor je pomůcka založená na rizikových signálech, ne právní verdikt ani tvrzení o prodejci.';

const nalezy = [
  { id: 'nesmysl_v_nabidce', modul: 'věrohodnost', druh: 'nesmysl', zavaznost: 'medium', titul: 'Tvrzení v nabídce nedává smysl',
    dukaz: 'Svítivost 25 500 lm při příkonu 10 W.', citace: 'Svítivost až 25 500 lm při příkonu 10 W',
    vysvetleni: 'Za 10 W nejde fyzikálně získat tolik světla. Běžné LED svítilny dávají zlomek.',
    vypocet: '25 500 lm ÷ 10 W = 2 550 lm/W; nejlepší běžné LED dávají kolem 200 lm/W',
    otazka: 'Jaký je skutečný světelný tok svítilny v lumenech a jaký má příkon ve wattech?', jistota: 'stredni', odkazy: [], zdroj: 'analýza nabídky' },
  { id: 'obrazek_cislo_rozpor', modul: 'obrázky', druh: 'rozpor', zavaznost: 'low', titul: 'Číslo na obrázku nesedí s nabídkou',
    dukaz: 'Na fotce je 2 000 lm.', citace: 'Na fotce: 2 000 lm', vysvetleni: 'Fotka uvádí jiný výkon než text nabídky. Jeden z údajů je nepravdivý.',
    vypocet: null, otazka: 'Který údaj platí: 2 000 lm, nebo 25 500 lm?', jistota: 'stredni',
    odkazy: [{ text: 'Fotka v Google Lens', url: 'https://lens.google.com/uploadbyurl?url=x' }], zdroj: 'analýza obrázků' },
  { id: 'ce_chybi', modul: 'bezpečnost', druh: 'riziko', zavaznost: 'low', titul: 'Nabídka nezmiňuje shodu s předpisy EU',
    dukaz: 'V textu ani ve specifikaci není značka CE ani prohlášení o shodě.', citace: null, vysvetleni: null, vypocet: null, otazka: null, jistota: null, odkazy: [], zdroj: 'analýza nabídky' },
  { id: 'ares_nedostupny', modul: 'prodejce', druh: 'nelze_overit', zavaznost: 'info', titul: 'Prodejce se nepodařilo ověřit v ARES',
    dukaz: 'ARES nebyl dostupný.', citace: null, vysvetleni: null, vypocet: null, otazka: null, jistota: null, odkazy: [], zdroj: 'ARES' },
];
const ODPOVEDI = {
  zelena: { stav: 'ok', semafor: 'zelená', skore: 0, jistota: 'střední', shrnuti: 'Kontrola nenašla rizikové signály.',
    co_delat: ['Přesto plaťte kartou nebo způsobem s ochranou kupujícího.', 'Uschovejte si potvrzení objednávky.'],
    signaly: [], nalezy: [], nezkontrolovano: [], upozorneni: UPOZORNENI },
  oranzova: { stav: 'ok', semafor: 'oranžová', skore: 5, jistota: 'střední',
    shrnuti: 'Prodejce působí věrohodně, ale text nabídky obsahuje rozpor v parametrech svítilny. Zeptejte se prodejce, které údaje platí.',
    co_delat: ['Zeptejte se prodejce, jaký je skutečný výkon svítilny.', 'Pokud se rozhodnete koupit, plaťte kartou nebo způsobem s ochranou kupujícího.', 'Zkuste srovnat nabídku u jiného prodejce.'],
    signaly: [], nalezy, nezkontrolovano: [], upozorneni: UPOZORNENI },
  cervena: { stav: 'ok', semafor: 'červená', skore: 11, jistota: 'vysoká',
    shrnuti: 'Kontrola našla závažné rizikové signály: e-shop je na seznamu rizikových e-shopů ČOI.',
    co_delat: ['Nákup raději nedokončujte.', 'Neplaťte převodem ani platbou předem.', 'Hledejte stejné zboží u ověřeného prodejce.'],
    signaly: [], nezkontrolovano: [], upozorneni: UPOZORNENI,
    nalezy: [{ id: 'coi_seznam', modul: 'prodejce', druh: 'riziko', zavaznost: 'high', titul: 'E-shop je na seznamu rizikových webů ČOI',
      dukaz: 'Doména obchod.example je na seznamu ČOI.', citace: null, vysvetleni: 'Česká obchodní inspekce vede seznam e-shopů, na které si lidé stěžovali. Tenhle e-shop na něm je.',
      vypocet: null, otazka: null, jistota: 'vysoka', odkazy: [{ text: 'Seznam ČOI', url: 'https://coi.gov.cz/pro-spotrebitele/rizikove-e-shopy/' }], zdroj: 'seznam ČOI' }, nalezy[2]] },
  seda: { stav: 'ok', semafor: 'šedá', skore: 1, jistota: 'nízká', shrnuti: 'Z dostupných dat nelze nabídku spolehlivě posoudit.',
    co_delat: ['Vložte více údajů, například screenshot celé nabídky včetně prodejce.', 'Do rozhodnutí berte výsledek jen jako orientační.'],
    signaly: [], nalezy: [nalezy[3]], nezkontrolovano: ['prodejce: ARES'], upozorneni: UPOZORNENI },
};

function stranka(jmeno, tema) {
  let html = fs.readFileSync(PAGE, 'utf8');
  if (tema === 'svetly') html = html.replace('(prefers-color-scheme: dark)', '(prefers-color-scheme: nikdy)');
  if (tema === 'tmavy') html = html.replace('(prefers-color-scheme: dark)', 'all');
  const odpoved = ODPOVEDI[jmeno];
  if (!odpoved) return html;
  const fetchMock = '<script>window.fetch = async () => ({ json: async () => (' + JSON.stringify(odpoved) + ') });</script>\n';
  const odeslat = '<script>document.getElementById("odkaz").value = "https://obchod.example/svitilna"; document.getElementById("f").requestSubmit();</script>\n';
  return html.replace('<script>', () => fetchMock + '<script>').replace(/<\/script>\s*<\/body>/, () => '</script>\n' + odeslat + '</body>');
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const jmeno = u.pathname.replace(/^\/+|\/+$/g, '') || 'formular';
  if (![...Object.keys(ODPOVEDI), 'formular', 'prvni-pomoc'].includes(jmeno)) { res.writeHead(404); return res.end('Nenalezeno'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(stranka(jmeno, u.searchParams.get('tema')));
}).listen(PORT, '127.0.0.1', () => console.log('Náhled: http://127.0.0.1:' + PORT + '/oranzova  (také /zelena /cervena /seda /formular /prvni-pomoc#prvni-pomoc)'));
