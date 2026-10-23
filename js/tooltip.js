/**
 * tooltip.js — Contenu HTML de l'infobulle de survol, partagé par les vues
 * (frise chronologique, vue 3D) : nom, dates (« vivant·e » si vivant·e
 * présumé·e au lieu du décès, préfixe ≈ si estimée), unions (conjoint,
 * mariage, nombre d'enfants), identifiant. M8b : une ligne supplémentaire
 * de contexte (profession, lieux de naissance/décès, extraits du nœud brut
 * read-gedcom). La vue arbre (tree.js) garde sa copie équivalente.
 */

/** Échappe le HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Ligne de contexte M8b : profession (premier OCCU), lieux naissance/décès
 *  (premier segment de PLAC), extraits du nœud brut read-gedcom. */
function extraContextHtml(p) {
  const rawKids = p.raw?.children ?? [];
  const occu = rawKids.find((c) => c.tag === 'OCCU');
  const plac = (tag) => rawKids.find((c) => c.tag === tag)
    ?.children?.find((c) => c.tag === 'PLAC')?.value;
  const short = (s) => (s ?? '').split(',')[0].trim() || null;
  const parts = [];
  if (occu?.value) parts.push(esc(occu.value));
  const b = short(plac('BIRT'));
  if (b) parts.push(`° <span title="lieu de naissance">${esc(b)}</span>`);
  const d = short(plac('DEAT'));
  if (d) parts.push(`† <span title="lieu de décès">${esc(d)}</span>`);
  return parts.length ? `<div class="tip-extra">${parts.join(' · ')}</div>` : '';
}

/**
 * Contenu HTML de l'infobulle (complet : dates, unions, enfants).
 * @param {Object} index - index applicatif
 * @param {Object} p - individu normalisé
 * @returns {string} HTML
 */
export function buildTooltipHtml(index, p) {
  const dHtml = (d) => {
    if (!d.value) return d.status === 'living' ? 'vivant·e' : '—';
    return (d.status === 'estimated' ? '≈ ' : '') + d.value.year
      + (d.estimatedFrom ? ` <small>(${esc(d.estimatedFrom)})</small>` : '');
  };
  const rows = [
    `<div class="tip-name">${esc((p.name.surname || '?').toUpperCase())} ${esc(p.name.given)}</div>`,
    `<div class="tip-dates">naissance ${dHtml(p.birth)}`
      + (p.death.status === 'living' ? ' · vivant·e'
         : ` · décès ${dHtml(p.death)}`) + '</div>',
    extraContextHtml(p),
  ];
  for (const famId of p.familyAsSpouse) {
    const fam = index.getFamily(famId);
    if (!fam) continue;
    const sid = fam.husband === p.id ? fam.wife : fam.husband;
    const sp = sid ? index.getIndividual(sid) : null;
    rows.push(`<div class="tip-fam">union : ${sp
      ? `${esc(sp.name.surname.toUpperCase())} ${esc(sp.name.given)}` : 'inconnu·e'}`
      + (fam.marriage.value ? ` — mariage ${dHtml(fam.marriage)}` : '')
      + (fam.children.length ? ` — ${fam.children.length} enfant(s)` : '') + '</div>');
  }
  rows.push(`<div class="tip-id">${esc(p.id)}</div>`);
  return rows.join('');
}
