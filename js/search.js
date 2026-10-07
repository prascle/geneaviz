/**
 * search.js — Service de recherche d'individus (UC2).
 *
 * Recherche par patronyme (préfixe) et partie de prénom, avec scoring de
 * pertinence pour lever les homonymies. Chaque résultat est annoté des
 * dates de naissance et de décès (avec statut estimé/vivant, UC7) pour
 * aider l'utilisateur à choisir.
 */
import { logger } from './logger.js';
import { normalize } from './utils.js';
const log = logger('search');

/** Nombre maximum de résultats retournés par une recherche. */
export const MAX_RESULTS = 50;

/**
 * Initialise le service de recherche sur un index applicatif.
 * @param {Object} index - index produit par buildIndex (gedcomIndex.js)
 * @returns {{search: Function, surnameSuggestions: Function}} API de recherche
 */
export function initSearch(index) {
  const stop = log.time('init search');

  // ---------- Préparation des entrées normalisées ----------
  const entries = [];
  for (const p of index.getAllPeople()) {
    entries.push({
      id: p.id,
      surname: p.name.surname,
      given: p.name.given,
      sex: p.sex,
      birth: p.birth,
      death: p.death,
      normSurname: normalize(p.name.surname),
      normGivens: p.name.given.split(/\s+/).filter(Boolean).map(normalize),
    });
  }

  // ---------- Patronymes triés par fréquence (pour les suggestions) ----------
  const surnameCounts = new Map();
  for (const e of entries) {
    if (e.normSurname) surnameCounts.set(e.normSurname, (surnameCounts.get(e.normSurname) ?? 0) + 1);
  }
  const surnamesByFreq = [...surnameCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  stop();
  log.info(`Service de recherche prêt : ${entries.length} individus, ${surnamesByFreq.length} patronymes`);

  /**
   * Recherche d'individus.
   * @param {Object} query
   * @param {string} query.surname - patronyme : préfixe ou correspondance exacte
   * @param {string} [query.given=''] - partie de prénom (sous-chaîne, insensible casse/accents)
   * @returns {Array<Object>} résultats triés par pertinence décroissante puis
   *   année de naissance croissante ; chaque résultat porte un champ `score`.
   */
  function search({ surname, given = '' }) {
    const ns = normalize(surname).trim();
    const ng = normalize(given).trim();
    if (!ns && !ng) return [];

    const results = [];
    for (const e of entries) {
      // --- Correspondance patronyme : exact > préfixe > absent ---
      let surnameScore = 0;
      if (ns) {
        if (e.normSurname === ns) surnameScore = 4;
        else if (e.normSurname.startsWith(ns)) surnameScore = 2;
        else continue;                      // patronyme demandé mais non correspondant
      }

      // --- Correspondance prénom : exact (1er prénom) > préfixe > sous-chaîne ---
      let givenScore = 0;
      if (ng) {
        const [first, ...rest] = e.normGivens;
        if (first === ng) givenScore = 3;
        else if (first.startsWith(ng)) givenScore = 2;
        else if (rest.some(g => g === ng)) givenScore = 2;
        else if (e.normGivens.some(g => g.startsWith(ng) || g.includes(ng))) givenScore = 1;
        else if (ns) continue;              // prénom demandé mais non correspondant
      }

      const score = surnameScore * 10 + givenScore;
      results.push({ ...e, score });
    }

    results.sort((a, b) => b.score - a.score ||
      (a.birth.value?.year ?? 9999) - (b.birth.value?.year ?? 9999));
    const trimmed = results.slice(0, MAX_RESULTS);
    log.info(`Recherche "${surname}" + "${given}": ${results.length} trouvé(s), ${trimmed.length} affiché(s)`);
    return trimmed;
  }

  /**
   * Suggestions de patronymes pour l'autocomplétion.
   * @param {string} [prefix=''] - préfixe saisi (normalisé en interne)
   * @param {number} [limit=20] - nombre maximum de suggestions
   * @returns {Array<{surname: string, count: number}>}
   */
  function surnameSuggestions(prefix = '', limit = 20) {
    const np = normalize(prefix).trim();
    return surnamesByFreq
      .filter(([s]) => !np || s.startsWith(np))
      .slice(0, limit)
      .map(([s, count]) => ({ surname: s, count }));
  }

  return { search, surnameSuggestions };
}
