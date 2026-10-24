/**
 * relation.js — Chaîne de parenté entre deux individus (M9c).
 *
 * Parcours en largeur (BFS) du graphe de parenté au niveau de l'index :
 * parents, enfants et conjoints — indépendamment de la racine affichée
 * et des éditions d'affichage. Le plus court chemin (en nombre de
 * liens) entre A et B est reconstitué et traduit en libellés français
 * orientés « from est le … de to » : père, mère, fils, fille,
 * conjoint·e (le genre suit le sexe de l'individu `from`).
 */
import { logger } from './logger.js';

const log = logger('relation');

/**
 * Nom d'affichage d'un individu (patronyme en majuscules + prénom).
 * @param {Object} person - individu normalisé de l'index
 * @returns {string}
 */
function displayName(person) {
  return `${(person.name.surname || '?').toUpperCase()} ` +
    `${person.name.given}`.trim();
}

/**
 * Voisins d'un individu dans le graphe de parenté.
 * @param {Object} index - index applicatif
 * @param {Object} person - individu normalisé
 * @returns {Array<{id: string, rel: 'parent'|'child'|'spouse'}>}
 */
function neighbors(index, person) {
  const out = [];
  const push = (id, rel) => {
    if (id && index.getIndividual(id)) out.push({ id, rel });
  };
  for (const fid of person.childInFamilies) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    push(fam.husband, 'parent');
    push(fam.wife, 'parent');
  }
  for (const fid of person.familyAsSpouse) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    push(fam.husband === person.id ? fam.wife : fam.husband, 'spouse');
    for (const c of fam.children) push(c, 'child');
  }
  return out;
}

/**
 * Libellé FR de la relation de `from` vers `to` (M9c) :
 *  - `to` est un parent de `from` → « fils » / « fille » ;
 *  - `to` est un enfant de `from` → « père » / « mère » ;
 *  - conjoints → « conjoint » / « conjointe ».
 * @param {Object} index - index applicatif
 * @param {string} fromId - xref de l'individu décrit
 * @param {'parent'|'child'|'spouse'} rel - relation de from vers to
 * @returns {string}
 */
function labelFor(index, fromId, rel) {
  const from = index.getIndividual(fromId);
  const fem = !!from && from.sex === 'F';
  if (rel === 'parent') return fem ? 'fille' : 'fils';
  if (rel === 'child') return fem ? 'mère' : 'père';
  return fem ? 'conjointe' : 'conjoint';
}

/**
 * Chaîne de parenté la plus courte entre deux individus (BFS sur
 * l'index complet : parents / enfants / conjoints).
 * @param {Object} index - index applicatif
 * @param {string} idA - xref de l'individu A
 * @param {string} idB - xref de l'individu B
 * @returns {{ids: string[], steps: Array<{id: string, name: string,
 *             sex: string}>, links: Array<{from: string, to: string,
 *             rel: string, label: string}>, distance: number,
 *             same: boolean}|null} null si un individu est inconnu ;
 *           `same` vrai si A et B sont la même personne.
 */
export function findRelationChain(index, idA, idB) {
  const a = index.getIndividual(idA);
  const b = index.getIndividual(idB);
  if (!a || !b) return null;
  if (idA === idB) {
    return {
      ids: [idA],
      steps: [{ id: idA, name: displayName(a), sex: a.sex }],
      links: [], distance: 0, same: true,
    };
  }

  // BFS depuis A : prev = comment chaque sommet a été atteint.
  const prev = new Map();   // id -> { from, rel }
  const seen = new Set([idA]);
  const queue = [idA];
  while (queue.length) {
    const cur = queue.shift();
    for (const nb of neighbors(index, index.getIndividual(cur))) {
      if (seen.has(nb.id)) continue;
      seen.add(nb.id);
      prev.set(nb.id, { from: cur, rel: nb.rel });
      if (nb.id === idB) { queue.length = 0; break; }
      queue.push(nb.id);
    }
  }
  if (!prev.has(idB)) return null;   // aucun chemin de parenté

  // Reconstruction du chemin A → B (les entrées de prev forment un
  // arbre de BFS : remonter depuis B redonne le chemin le plus court).
  const pathIds = [];
  for (let cur = idB; ; cur = prev.get(cur).from) {
    pathIds.push(cur);
    if (cur === idA) break;
  }
  pathIds.reverse();

  const steps = pathIds.map((id) => {
    const p = index.getIndividual(id);
    return { id, name: displayName(p), sex: p.sex };
  });
  const links = [];
  for (let i = 0; i + 1 < pathIds.length; i++) {
    const from = pathIds[i], to = pathIds[i + 1];
    const rel = prev.get(to).rel;   // `to` a été découvert depuis `from`
    links.push({ from, to, rel, label: labelFor(index, from, rel) });
  }
  log.debug(`Chaîne ${idA} → ${idB} : ${links.length} lien(s)`);
  return { ids: pathIds, steps, links, distance: links.length, same: false };
}

/**
 * Phrase française décrivant la chaîne : « A est le fils de X, qui est
 * le père de Y, …, qui est le conjoint de B. »
 * @param {Object} chain - résultat de findRelationChain
 * @returns {string}
 */
export function chainToText(chain) {
  if (!chain) return '';
  if (chain.same) return 'Les deux individus sont la même personne.';
  const art = (label) =>
    (label === 'mère' || label === 'fille' || label === 'conjointe')
      ? 'la' : 'le';
  const l0 = chain.links[0];
  let s = `${chain.steps[0].name} est ${art(l0.label)} ${l0.label} de ` +
    `${chain.steps[1].name}`;
  for (let i = 1; i < chain.links.length; i++) {
    const l = chain.links[i];
    s += `, qui est ${art(l.label)} ${l.label} de ${chain.steps[i + 1].name}`;
  }
  return s + '.';
}
