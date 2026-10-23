/**
 * gedcomDetail.js — Fiche individu riche (M8b).
 *
 * Module pur : extraction **paresseuse** (aucun travail au chargement, tout est
 * calculé à l'ouverture de la fiche) à partir de l'index applicatif, qui
 * expose les nœuds bruts read-gedcom (`person.raw`, `fam.raw` — valeurs déjà
 * CONT/CONC rejoints) et la racine read-gedcom (`index.getGedcom()`, utilisée
 * uniquement pour résoudre les records NOTE et SOUR référencés par @xref@).
 *
 * `buildDetail(index, id)` retourne une structure normalisée consommable par
 * l'UI ; `detailHtml(detail)` en produit le rendu HTML (échappé).
 *
 * Contenu : identité (noms multiples avec TYPE, surnom, suffixe, sexe, xref,
 * date de modification CHAN), événements datés avec lieux et cause de décès
 * (BIRT/BAPM/CHR/DEAT/BURI/CREM), professions (OCCU datées), résidences
 * (RESI), familles (parents avec lien PEDI, unions avec mariage/divorce et
 * enfants), notes (inline ou records), sources (citations avec PAGE, titres
 * résolus).
 */
import { parseGedcomDate, formatDate, parseName } from './utils.js';

/* ------------------------------------------------------------------ */
/* Nœuds bruts read-gedcom (petits helpers purs)                       */
/* ------------------------------------------------------------------ */

/** Enfants directs d'un nœud brut portant un tag donné. */
function kids(node, tag) {
  return (node?.children ?? []).filter((c) => c.tag === tag);
}

/** Premier enfant direct d'un nœud brut portant un tag donné (ou null). */
function kid(node, tag) {
  return kids(node, tag)[0] ?? null;
}

/** Valeur textuelle d'un nœud brut (ou null). */
function val(node) {
  return node ? (node.value ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

/** Formate une date simple (ou '—' si non parsable). */
function fmtSimple(s) {
  return formatDate(parseGedcomDate(s));
}

/**
 * Formate une valeur DATE GEDCOM complète pour la fiche : périodes
 * FROM/TO (« de 1890 à 1910 », « depuis 1890 », « jusqu'en 1910 »),
 * fourchettes BET…AND (« entre 1890 et 1892 »), sinon formatDate
 * (« 12 janv. 1873 », « ≈ 1850 », « < 1930 »…).
 * @param {string} raw - valeur DATE brute (ex. "FROM 1890 TO 1910")
 * @returns {string|null} null si la valeur est absente
 */
export function formatGedcomDateRich(raw) {
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  let m = s.match(/^FROM\s+(.+?)(?:\s+TO\s+(.+))?$/i);
  if (m) {
    const a = fmtSimple(m[1]);
    const b = m[2] ? fmtSimple(m[2]) : null;
    return b && b !== '—' ? `de ${a} à ${b}` : `depuis ${a}`;
  }
  m = s.match(/^TO\s+(.+)$/i);
  if (m) return `jusqu'en ${fmtSimple(m[1])}`;
  m = s.match(/^BET\s+(.+?)\s+AND\s+(.+)$/i);
  if (m) return `entre ${fmtSimple(m[1])} et ${fmtSimple(m[2])}`;
  const out = fmtSimple(s);
  return out === '—' ? s : out;
}

/* ------------------------------------------------------------------ */
/* Résolution des records référencés (notes, sources)                  */
/* ------------------------------------------------------------------ */

/**
 * Fabrique des résolveurs xref → texte/titre sur les records read-gedcom
 * (map construite une seule fois, à la première résolution).
 */
function makeRecordResolver(gedcom, getter) {
  let map = null;
  return (xref) => {
    if (!gedcom) return null;
    if (map === null) {
      map = new Map();
      for (const rec of getter(gedcom).arraySelect()) {
        map.set(rec.pointer()[0], rec);
      }
    }
    return map.get(xref) ?? null;
  };
}

/** Résout le texte d'un record NOTE référencé. */
function noteText(resolve, xref) {
  const rec = resolve(xref);
  return rec ? (rec.value()[0] ?? null) : null;
}

/** Résout le titre (TITL) d'un record SOUR référencé. */
function sourceTitle(resolve, xref) {
  const rec = resolve(xref);
  if (!rec) return null;
  return rec.get('TITL').value()[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Libellés français                                                    */
/* ------------------------------------------------------------------ */

/** Libellés des types de nom (TYPE de NAME). */
const NAME_TYPE_FR = { birth: 'naissance', married: 'marié·e', aka: 'alias', alias: 'alias' };

/** Libellés des liens parentaux (PEDI de FAMC). */
const PEDI_FR = { adopted: 'adoption', foster: "famille d'accueil", sealing: 'scellement' };

/** Événements individuels affichés dans la fiche (tag → libellé). */
const EVENT_DEFS = [
  ['BIRT', 'Naissance'],
  ['BAPM', 'Baptême'],
  ['CHR', 'Baptême (chrême)'],
  ['DEAT', 'Décès'],
  ['BURI', 'Sépulture'],
  ['CREM', 'Crémation'],
];

/* ------------------------------------------------------------------ */
/* Extraction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Construit la fiche complète d'un individu (extraction paresseuse M8b).
 * @param {Object} index - index applicatif (buildIndex)
 * @param {string} id - xref de l'individu (ex. "@I1@")
 * @returns {Object|null} fiche normalisée, ou null si introuvable
 */
export function buildDetail(index, id) {
  const p = index.getIndividual(id);
  if (!p) return null;
  const gedcom = index.getGedcom?.() ?? null;
  const raw = p.raw ?? { children: [] };

  const resolveNote = makeRecordResolver(gedcom, (g) => g.getNoteRecord());
  const resolveSource = makeRecordResolver(gedcom, (g) => g.getSourceRecord());

  // ---------- Identité ----------
  const names = kids(raw, 'NAME').map((n) => {
    const parsed = parseName(val(n) ?? '');
    const type = val(kid(n, 'TYPE'));
    return { value: val(n) ?? '', ...parsed, type };
  });
  const primaryValue = names.length ? names[names.length - 1].value : null;

  const changedDate = formatGedcomDateRich(val(kid(kid(raw, 'CHAN'), 'DATE')));

  // ---------- Événements ----------
  const events = [];
  for (const [tag, label] of EVENT_DEFS) {
    for (const node of kids(raw, tag)) {
      events.push({
        type: tag,
        label,
        date: formatGedcomDateRich(val(kid(node, 'DATE'))),
        place: val(kid(node, 'PLAC')),
        cause: tag === 'DEAT' ? val(kid(node, 'CAUS')) : null,
      });
    }
  }

  // ---------- Professions / résidences ----------
  const occupations = kids(raw, 'OCCU').map((n) => ({
    value: val(n),
    date: formatGedcomDateRich(val(kid(n, 'DATE'))),
  }));
  const residences = kids(raw, 'RESI').map((n) => ({
    place: val(kid(n, 'PLAC')) ?? val(kid(n, 'ADDR')) ?? val(n),
    date: formatGedcomDateRich(val(kid(n, 'DATE'))),
  }));

  // ---------- Sources (citations de l'individu et de ses événements) ----------
  const sources = [];
  const pushCitations = (nodes, context) => {
    for (const s of nodes) {
      const v = val(s);
      if (v == null) continue;
      const page = val(kid(s, 'PAGE'));
      if (v.startsWith('@')) {
        sources.push({ xref: v, title: sourceTitle(resolveSource, v) ?? v, page, context });
      } else {
        sources.push({ xref: null, title: v, page, context });
      }
    }
  };
  pushCitations(kids(raw, 'SOUR'), 'individu');
  for (const [tag, label] of EVENT_DEFS) {
    for (const node of kids(raw, tag)) pushCitations(kids(node, 'SOUR'), label.toLowerCase());
  }

  // ---------- Familles ----------
  const personRef = (pid) => {
    if (!pid) return null;
    const q = index.getIndividual(pid);
    if (!q) return null;
    return { id: pid, given: q.name.given, surname: q.name.surname };
  };

  // Parents : un par FAMC, avec le lien PEDI éventuel.
  const parents = [];
  for (const famc of kids(raw, 'FAMC')) {
    const fid = val(famc);
    const fam = fid ? index.getFamily(fid) : null;
    if (!fam) continue;
    parents.push({
      familyId: fid,
      father: personRef(fam.husband),
      mother: personRef(fam.wife),
      pedi: val(kid(famc, 'PEDI')),
    });
  }

  // Unions : un par FAMS, avec mariage (dernier MARR avec DATE, comme
  // l'index), divorce et enfants.
  const unions = [];
  for (const fid of p.familyAsSpouse) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    const spouseId = fam.husband === id ? fam.wife : fam.husband;
    const marrs = kids(fam.raw, 'MARR');
    const marrNode = [...marrs].reverse().find((n) => val(kid(n, 'DATE'))) ?? marrs[marrs.length - 1] ?? null;
    const divNode = kid(fam.raw, 'DIV');
    unions.push({
      familyId: fid,
      spouse: personRef(spouseId),
      marriage: marrNode
        ? { date: formatGedcomDateRich(val(kid(marrNode, 'DATE'))), place: val(kid(marrNode, 'PLAC')) }
        : null,
      divorce: divNode
        ? { date: formatGedcomDateRich(val(kid(divNode, 'DATE'))), place: val(kid(divNode, 'PLAC')) }
        : null,
      children: fam.children.filter(Boolean).map(personRef).filter(Boolean),
    });
    if (marrNode) pushCitations(kids(marrNode, 'SOUR'), 'mariage');
    if (divNode) pushCitations(kids(divNode, 'SOUR'), 'divorce');
  }

  // ---------- Notes (inline ou record référencé) ----------
  const notes = [];
  for (const n of kids(raw, 'NOTE')) {
    const v = val(n);
    if (v == null || v === '') continue;
    notes.push(v.startsWith('@') ? (noteText(resolveNote, v) ?? v) : v);
  }

  return {
    id: p.id,
    name: p.name,
    sex: p.sex,
    names,
    primaryValue,
    nick: val(kid(raw, 'NICK')),
    changed: changedDate,
    events,
    occupations,
    residences,
    families: { parents, unions },
    notes,
    sources,
  };
}

/* ------------------------------------------------------------------ */
/* Rendu HTML                                                          */
/* ------------------------------------------------------------------ */

/** Échappe le HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Nom d'affichage « PATRONYME Prénom » d'une référence personne. */
const nameOf = (r) => r
  ? `${esc((r.surname || '?').toUpperCase())} ${esc(r.given)}`
  : '<span class="lab">inconnu·e</span>';

/**
 * Rendu HTML de la fiche (sections masquées si vides).
 * @param {Object} d - fiche normalisée (buildDetail)
 * @returns {string} HTML
 */
export function detailHtml(d) {
  const out = [];

  // ----- Identité -----
  out.push(`<div class="fiche-title">${esc((d.name.surname || '?').toUpperCase())} ${esc(d.name.given)}`
    + `${d.name.suffix ? ' ' + esc(d.name.suffix) : ''}</div>`);
  out.push(`<div class="fiche-sub">${d.sex === 'M' ? 'Masculin' : d.sex === 'F' ? 'Féminin' : 'Sexe inconnu'}`
    + ` · <code>${esc(d.id)}</code>${d.changed ? ` · modifié le ${esc(d.changed)}` : ''}</div>`);

  const altNames = d.names.filter((n) => n.value !== d.primaryValue);
  if (altNames.length || d.nick) {
    const lines = [];
    for (const n of altNames) {
      const t = n.type ? (NAME_TYPE_FR[n.type.toLowerCase()] ?? n.type) : null;
      lines.push(`<div class="fiche-line"><span class="lab">Nom</span> ${esc(n.value)}`
        + (t ? ` <span class="fiche-qual">(${esc(t)})</span>` : '') + '</div>');
    }
    if (d.nick) lines.push(`<div class="fiche-line"><span class="lab">Surnom</span> ${esc(d.nick)}</div>`);
    out.push(lines.join(''));
  }

  // ----- Événements -----
  const evLines = d.events.map((ev) => {
    let body = '';
    if (ev.date) body += `<strong>${esc(ev.date)}</strong>`;
    if (ev.place) body += (body ? ' · ' : '') + esc(ev.place);
    if (ev.cause) body += ` <span class="fiche-qual">(cause : ${esc(ev.cause)})</span>`;
    return `<div class="fiche-line"><span class="lab">${esc(ev.label)}</span> `
      + (body || '<span class="lab">—</span>') + '</div>';
  });
  out.push(section('Événements', evLines));

  // ----- Professions / résidences -----
  out.push(section('Professions', d.occupations.map((o) =>
    `<div class="fiche-line">${esc(o.value)}`
    + (o.date ? ` <span class="fiche-qual">(${esc(o.date)})</span>` : '') + '</div>')));
  out.push(section('Résidences', d.residences.map((r) =>
    `<div class="fiche-line">${esc(r.place || '—')}`
    + (r.date ? ` <span class="fiche-qual">(${esc(r.date)})</span>` : '') + '</div>')));

  // ----- Familles -----
  const famLines = [];
  for (const par of d.families.parents) {
    const pedi = par.pedi ? (PEDI_FR[par.pedi.toLowerCase()] ?? par.pedi) : null;
    famLines.push(`<div class="fiche-line"><span class="lab">Parents</span> ${nameOf(par.father)}`
      + ` + ${nameOf(par.mother)}`
      + (pedi ? ` <span class="fiche-qual">(lien : ${esc(pedi)})</span>` : '') + '</div>');
  }
  for (const u of d.families.unions) {
    let line = `<div class="fiche-line"><span class="lab">Union</span> ${nameOf(u.spouse)}`;
    if (u.marriage && (u.marriage.date || u.marriage.place)) {
      line += ` — mariage ${u.marriage.date ? esc(u.marriage.date) : '<span class="lab">date inconnue</span>'}`
        + (u.marriage.place ? ` · ${esc(u.marriage.place)}` : '');
    }
    if (u.divorce && u.divorce.date) line += ` — divorce ${esc(u.divorce.date)}`;
    if (u.children.length) line += ` — ${u.children.length} enfant(s)`;
    famLines.push(line + '</div>');
    if (u.children.length) {
      famLines.push(`<div class="fiche-line fiche-children"><span class="lab">Enfants</span> `
        + u.children.map(nameOf).join(' · ') + '</div>');
    }
  }
  out.push(section('Familles', famLines));

  // ----- Notes -----
  out.push(section('Notes', d.notes.map((n) => `<div class="fiche-note">${esc(n)}</div>`)));

  // ----- Sources -----
  out.push(section('Sources', d.sources.map((s) =>
    `<div class="fiche-src">• ${esc(s.title)}${s.page ? ` — ${esc(s.page)}` : ''}`
    + ` <span class="lab">(${esc(s.context)})</span></div>`)));

  return out.filter(Boolean).join('');
}

/** Section rendue seulement si elle a du contenu. */
function section(title, lines) {
  const content = lines.filter(Boolean);
  if (!content.length) return '';
  return `<div class="fiche-h">${esc(title)}</div>` + content.join('');
}
