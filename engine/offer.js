if (typeof require !== 'undefined' && typeof signal === 'undefined') { var { signal } = require('./signals'); }

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
    if (p.cena < ref.min * 0.25) add('cena_extremne_nizka', 'medium', 'Cena je extrémně nízká', 'Cena ' + p.cena + ' ' + p.mena + ' je pod čtvrtinou odhadované typické ceny (' + rozsah + ').', 'odhad modelu');
    else if (p.cena < ref.min * 0.5) add('cena_nizka', 'low', 'Cena je výrazně pod typickou', 'Cena ' + p.cena + ' ' + p.mena + ' je pod polovinou odhadované typické ceny (' + rozsah + ').', 'odhad modelu');
  }
  [
    ...uniq(x.nerealne_parametry).map((t) => ['nerealny_parametr', 'Nereálný parametr', t]),
    ...uniq(x.nesoulady).map((t) => ['nesoulad', 'Rozpor v nabídce', t]),
  ].slice(0, 3).forEach(([id, title, t]) => add(id, 'medium', title, t));
  if (o.nesoulad_s_popisem === true) add('nesoulad_obrazku', 'medium', 'Fotky neodpovídají popisu', 'Obrázky v nabídce neodpovídají popsanému produktu.');
  if (o.vypada_ai_nebo_katalog === true) add('obrazky_ai_katalog', 'low', 'Fotky vypadají jako AI nebo katalogové', 'Jde o odhad a nemusí být pravdivý.', 'odhad modelu');
  if (r.podobne_texty === true) add('recenze_podobne', 'medium', 'Recenze si jsou podezřele podobné', 'Několik recenzí má téměř stejný text.');
  if (r.vsechny_5_hvezd === true && (r.pocet || 0) >= 20) add('recenze_same_petky', 'low', 'Samé pětihvězdičkové recenze', r.pocet + ' recenzí a všechny mají 5 hvězd.');
  if (r.genericke === true) add('recenze_genericke', 'low', 'Recenze jsou obecné fráze', 'Recenze nezmiňují konkrétní vlastnosti produktu.');
  return { status: 'ok', signals: out };
}

if (typeof module !== 'undefined') module.exports = { offerSignals };
