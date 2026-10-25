if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

const OFFER_FREE_TEXT_MAX = 2;
const OFFER_LOW_RATING = 4;
const OFFER_RATING_MIN_COUNT = 3;

function offerSignals(x) {
  const p = x.produkt, r = x.recenze, o = x.obrazky;
  if (!p.nazev && !(p.cena > 0)) return { status: 'unchecked', signals: [] };
  const out = [];
  const uniq = (arr) => {
    const seen = new Set();
    return arr.filter((t) => {
      const k = t.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const add = (id, severity, title, evidence, source = 'analýza nabídky') => out.push(signal({ id, module: 'offer', severity, title, evidence, source }));
  const ref = p.referencni_cena_odhad;
  if (p.cena > 0 && ref && ref.min > 0 && ref.mena === p.mena) {
    const rozsah = ref.min + '–' + ref.max + ' ' + ref.mena;
    if (p.cena < ref.min * 0.25) add('cena_extremne_nizka', 'low', 'Cena je extrémně nízká', 'Cena ' + p.cena + ' ' + p.mena + ' je pod čtvrtinou odhadované typické ceny (' + rozsah + ').', 'odhad modelu');
    else if (p.cena < ref.min * 0.5) add('cena_nizka', 'info', 'Cena je výrazně pod typickou', 'Cena ' + p.cena + ' ' + p.mena + ' je pod polovinou odhadované typické ceny (' + rozsah + ').', 'odhad modelu');
  }
  // Volný text psaný modelem je nejméně spolehlivý signál: společně nejvýše OFFER_FREE_TEXT_MAX nízkých signálů, ať šum nepřebije tvrdá data.
  [
    ...uniq(x.nerealne_parametry).map((t) => ['nerealny_parametr', 'Nereálný parametr', t]),
    ...uniq(x.nesoulady).map((t) => ['nesoulad', 'Rozpor v nabídce', t]),
  ].slice(0, OFFER_FREE_TEXT_MAX).forEach(([id, title, t]) => add(id, 'low', title, t));
  if (o.nesoulad_s_popisem === true) add('nesoulad_obrazku', 'low', 'Fotky neodpovídají popisu', 'Obrázky v nabídce neodpovídají popsanému produktu.');
  if (o.vypada_ai_nebo_katalog === true) add('obrazky_ai_katalog', 'info', 'Fotky vypadají jako AI nebo katalogové', 'Jde o odhad a nemusí být pravdivý.', 'odhad modelu');
  if (r.podobne_texty === true) add('recenze_podobne', 'low', 'Recenze si jsou podezřele podobné', 'Několik recenzí má téměř stejný text.');
  if (r.vsechny_5_hvezd === true && (r.pocet || 0) >= 20) add('recenze_same_petky', 'low', 'Samé pětihvězdičkové recenze', r.pocet + ' recenzí a všechny mají 5 hvězd.');
  if (r.genericke === true) add('recenze_genericke', 'info', 'Recenze jsou obecné fráze', 'Recenze nezmiňují konkrétní vlastnosti produktu.');
  // Nižší hodnocení říká o kvalitě zboží, ne o podvodu: jen info (váha 0), barvu semaforu nemění. Při 1–2 hodnoceních je průměr šum.
  if (r.prumer != null && r.prumer < OFFER_LOW_RATING && (r.pocet == null || r.pocet >= OFFER_RATING_MIN_COUNT)) {
    const pocet = r.pocet != null ? ' (' + r.pocet + ' hodnocení)' : '';
    add('recenze_nizke_hodnoceni', 'info', 'Zákazníci hodnotí zboží hůř', 'Průměrné hodnocení je ' + String(r.prumer).replace('.', ',') + ' z 5' + pocet + '. Před koupí si přečtěte komentáře, hlavně ty nejhorší.');
  }
  return { status: 'ok', signals: out };
}

// Číslo nabídky z AliExpressu (od roku 2024 šestnáct číslic začínajících 1005) v poli „Kód“ jiného e-shopu: zboží může být přeprodávané z Číny.
// Čte přímo text stránky nebo vloženého textu (ne odpověď modelu), takže nekolísá. Jen info: přeprodej je legální, jen mění doručení, vrácení i záruku.
const RESELLER_ALI_LABELED = /(?:kód|kod|code|sku|id|číslo|cislo|artikl)[^\d\n]{0,25}(?<!\d)(1005\d{12})(?!\d)/gi;
const RESELLER_ALI_ID = /^1005\d{12}$/;
function resellerSignals({ text, x } = {}) {
  const ids = [];
  const src = typeof text === 'string' ? text : '';
  for (const m of src.matchAll(RESELLER_ALI_LABELED)) ids.push([m[1], m[0].trim()]);
  const p = (x && x.produkt) || {};
  [p.kod_vyrobce, p.ean].forEach((v) => { const t = typeof v === 'string' ? v.replace(/\s+/g, '') : ''; if (RESELLER_ALI_ID.test(t)) ids.push([t, 'Kód ' + t]); });
  if (!ids.length) return [];
  const [id, citace] = ids[0];
  return [signal({
    id: 'kod_z_aliexpressu', module: 'offer', severity: 'info', druh: 'riziko',
    title: 'Kód zboží vypadá jako číslo z AliExpressu',
    evidence: 'Kód ' + id + ' má tvar čísla nabídky z AliExpressu. Zboží může být přeprodávané z Číny: počítejte s delším doručením a ověřte si podmínky vrácení a záruky. Zkuste porovnat cenu.',
    citace, source: 'analýza nabídky',
    odkazy: [{ text: 'Nabídka na AliExpressu (může už neexistovat)', url: 'https://www.aliexpress.com/item/' + id + '.html' }],
  })];
}

if (typeof module !== 'undefined') module.exports = { offerSignals, resellerSignals };
