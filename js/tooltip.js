/**
 * tooltip.js — Contenu HTML de l'infobulle de survol, partagé par les vues
 * (frise chronologique, vue 3D) : nom, dates (« vivant·e » si vivant·e
 * présumé·e au lieu du décès, préfixe ≈ si estimée), unions (conjoint,
 * mariage, nombre d'enfants), identifiant. La vue arbre (tree.js) garde
 * sa copie équivalente.
 */

/** Échappe le HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
