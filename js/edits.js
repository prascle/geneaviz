/**
 * edits.js — Registre des éditions d'affichage (M6 : branches extensibles).
 *
 * Le GEDCOM n'est jamais modifié : une « édition » est une branche ajoutée
 * au graphe affiché. Chaque édition {id, pivot, type, depth} est tracée et
 * la provenance de chaque individu (base + éditions) permet de retirer une
 * branche sans détruire les individus partagés avec d'autres sources.
 *
 * Types : 'siblings' (fratrie, M6a), 'up'/'down' (M6b). Les éditions sont
 * récursives : elles peuvent porter sur un individu introduit par une
 * autre édition.
 */

let seq = 1;

/** Crée un registre d'éditions vide. */
export function createEdits() {
  const list = [];
  return {
    /** Liste (copie) des éditions actives. */
    all: () => [...list],
    /** Ajoute ou met à jour l'édition (une seule par pivot+type). */
    add(pivot, type, depth = 1) {
      const e = list.find((x) => x.pivot === pivot && x.type === type);
      if (e) e.depth = depth;
      else list.push({ id: 'e' + seq++, pivot, type, depth });
    },
    /** Retire l'édition (pivot, type). */
    remove(pivot, type) {
      const i = list.findIndex((x) => x.pivot === pivot && x.type === type);
      if (i >= 0) list.splice(i, 1);
    },
    /** Édition (pivot, type) ou null. */
    get(pivot, type) {
      return list.find((x) => x.pivot === pivot && x.type === type) ?? null;
    },
    /** Retire tout (changement de racine ou de sélecteurs). */
    clear() { list.length = 0; },
  };
}

/* ------------------------------------------------------------------ */
/* M6d : pastilles de famille / branche                                */
/* ------------------------------------------------------------------ */

/** Couleur de pastille du graphe de base (tous les individus). */
export const PILL_BASE_COLOR = '#2563eb';

/** Palette de couleurs vives, une par pivot d'édition (cyclique). */
const PILL_PALETTE = [
  '#e11d48', // rose
  '#f97316', // orange
  '#059669', // émeraude
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#ca8a04', // jaune doré
  '#db2777', // fuchsia
  '#65a30d', // vert lime
  '#4f46e5', // indigo
];

/**
 * Attribue une couleur de pastille par pivot d'édition, dans l'ordre de
 * création des éditions. Un même pivot garde la même couleur pour toutes
 * ses éditions (ascendants, descendants, fratrie) ; chaque nouveau pivot
 * reçoit la couleur suivante de la palette.
 * @param {Array} edits - liste d'éditions actives (getEdits())
 * @returns {function(string): string} pivot -> couleur de pastille
 */
export function editPillColors(edits) {
  const byPivot = new Map();
  for (const e of edits) {
    if (!byPivot.has(e.pivot)) {
      byPivot.set(e.pivot, PILL_PALETTE[byPivot.size % PILL_PALETTE.length]);
    }
  }
  return (pivot) => byPivot.get(pivot) ?? PILL_BASE_COLOR;
}

/**
 * Frères et sœurs d'un individu (ids existants, lui-même exclu).
 * @param {Object} index - index applicatif
 * @param {string} pid - xref de l'individu
 * @returns {string[]}
 */
export function siblingIds(index, pid) {
  const p = index.getIndividual(pid);
  const out = [];
  if (!p) return out;
  for (const fid of p.childInFamilies) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    for (const c of fam.children) {
      if (c && c !== pid && index.getIndividual(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/**
 * Calcule le périmètre affiché par le graphe de base : id -> sources.
 * Représente la couverture des vues (racine + upGen ascendants + downGen
 * descendants + conjoints) sans les éditions — sert à détecter si une
 * action d'ajout apporterait de nouveaux individus.
 * @returns {Set<string>} ids couverts par le graphe de base
 */
export function baseScope(index, rootId, upGen, downGen) {
  const ids = new Set();
  const root = index.getIndividual(rootId);
  if (!root) return ids;
  ids.add(rootId);

  const walkDown = (pid, depth, seen) => {
    if (depth >= downGen) return;
    const p = index.getIndividual(pid);
    if (!p || seen.has(pid)) return;
    seen.add(pid);
    for (const fid of p.familyAsSpouse) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const sid = fam.husband === pid ? fam.wife : fam.husband;
      if (sid && index.getIndividual(sid) && !seen.has(sid)) {
        seen.add(sid);
        ids.add(sid);
      }
      for (const c of fam.children) {
        if (c && index.getIndividual(c) && !seen.has(c)) {
          ids.add(c);
          walkDown(c, depth + 1, seen);
        }
      }
    }
  };
  walkDown(rootId, 0, new Set([rootId]));

  const walkUp = (pid, depth, seen) => {
    if (depth >= upGen) return;
    const p = index.getIndividual(pid);
    if (!p) return;
    for (const fid of p.childInFamilies) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      for (const par of [fam.husband, fam.wife]) {
        if (!par || !index.getIndividual(par) || seen.has(par)) continue;
        seen.add(par);
        ids.add(par);
        walkUp(par, depth + 1, seen);
      }
    }
  };
  walkUp(rootId, 0, new Set([rootId]));
  return ids;
}

/**
 * Ids potentiels apportés par une édition up/down depuis un pivot
 * (pour n'afficher l'action que si elle apporte de nouveaux individus).
 * @param {Object} index - index applicatif
 * @param {string} pivot - xref de l'individu pivot
 * @param {string} type - 'up' | 'down'
 * @param {number} depth - générations potentielles
 * @returns {Set<string>}
 */
export function potentialIds(index, pivot, type, depth) {
  const ids = new Set();
  const walkUp = (pid, d, seen) => {
    if (d >= depth) return;
    const p = index.getIndividual(pid);
    if (!p) return;
    for (const fid of p.childInFamilies) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      for (const par of [fam.husband, fam.wife]) {
        if (!par || !index.getIndividual(par) || seen.has(par)) continue;
        seen.add(par); ids.add(par);
        walkUp(par, d + 1, seen);
      }
    }
  };
  const walkDown = (pid, d, seen) => {
    if (d >= depth) return;
    const p = index.getIndividual(pid);
    if (!p) return;
    for (const fid of p.familyAsSpouse) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const sid = fam.husband === pid ? fam.wife : fam.husband;
      if (sid && index.getIndividual(sid) && !seen.has(sid)) {
        seen.add(sid); ids.add(sid);
      }
      for (const c of fam.children) {
        if (!c || !index.getIndividual(c) || seen.has(c)) continue;
        seen.add(c); ids.add(c);
        walkDown(c, d + 1, seen);
      }
    }
  };
  if (type === 'up') walkUp(pivot, 0, new Set([pivot]));
  if (type === 'down') walkDown(pivot, 0, new Set([pivot]));
  return ids;
}