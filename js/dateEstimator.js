/**
 * dateEstimator.js — Estimation des dates manquantes (UC7 du cahier des charges).
 *
 * Règles (toutes réglables via `RULES`) :
 *  1. Naissance inconnue d'un parent ≈ naissance du premier enfant − PARENT_AGE_AT_FIRST_CHILD (20 ans).
 *  2. Décès inconnu ≥ naissance du dernier enfant (+ marge MIN_YEARS_AFTER_LAST_CHILD).
 *  3. Espérance de vie plafonnée : décès ≤ naissance + MAX_LIFE (99 ans).
 *  4. Vivant présumé : né il y a moins de LIVING_CUTOFF_YEARS (110 ans) sans
 *     date de décès (ni témoignage de décès) → décès non estimé, statut « vivant ».
 *
 * Les estimations itèrent (dates d'enfants elles-mêmes estimées servant aux
 * parents), en point fixe borné à `MAX_PASSES` passes.
 *
 * Chaque date estimée est marquée : `status = 'estimated'` (vs 'known'),
 * avec `estimatedFrom` décrivant la règle appliquée. Les vues devront
 * la représenter graphiquement comme estimée (pointillés, « ≈ »).
 */
import { logger } from './logger.js';
import { dateToValue, addYears } from './utils.js';
const log = logger('dateEstimator');

/** Règles paramétrables. */
export const RULES = {
  PARENT_AGE_AT_FIRST_CHILD: 20,
  MIN_YEARS_AFTER_LAST_CHILD: 1,
  MAX_LIFE: 99,
  AVG_LIFE: 80,
  LIVING_CUTOFF_YEARS: 110,
  MAX_PASSES: 3,
};

/**
 * Date interne normalisée.
 * @typedef {{value: {year:number,month:number,day:number}|null,
 *            status: 'known'|'estimated'|'living'|null,
 *            estimatedFrom: string|null,
 *            qualifier: string|null}} DateInfo
 */

/**
 * Fabrique une DateInfo.
 * @param {Object} [parsed] - résultat de parseGedcomDate (date certaine) ou null
 * @returns {DateInfo}
 */
export function makeDateInfo(parsed) {
  return parsed && parsed.year != null
    ? { value: { year: parsed.year, month: parsed.month, day: parsed.day },
        status: 'known', estimatedFrom: null, qualifier: parsed.qualifier }
    : { value: null, status: null, estimatedFrom: null, qualifier: null };
}

/**
 * Estime les dates manquantes d'une collection d'individus.
 * @param {Object} options
 * @param {Map<string, Object>} options.people - id → individu
 *   (champs `birth: DateInfo`, `death: DateInfo`, `parentOfChildIds: string[]`)
 * @param {number} [options.now] - année courante (testabilité), défaut = année réelle
 * @returns {{birthEstimated: number, deathEstimated: number, livingAssumed: number}}
 *   compteurs de synthèse
 */
export function estimateDates({ people, now }) {
  const currentYear = now ?? new Date().getFullYear();
  const stats = { birthEstimated: 0, deathEstimated: 0, livingAssumed: 0 };

  for (let pass = 1; pass <= RULES.MAX_PASSES; pass++) {
    let changed = 0;

    for (const [id, p] of people) {
      // --- Règle 1 : naissance estimée depuis le premier enfant -----------
      if (!p.birth.value) {
        const childDates = p.parentOfChildIds
          .map(cid => people.get(cid))
          .filter(Boolean)
          .map(c => c.birth.value ? dateToValue(c.birth.value) : -Infinity)
          .filter(v => v !== -Infinity);
        if (childDates.length) {
          const firstChild = Math.min(...childDates);
          const year = Math.floor(firstChild - RULES.PARENT_AGE_AT_FIRST_CHILD);
          p.birth = { value: { year, month: null, day: null }, status: 'estimated',
                      estimatedFrom: `premier enfant − ${RULES.PARENT_AGE_AT_FIRST_CHILD} ans`,
                      qualifier: 'EST' };
          changed++; stats.birthEstimated++;
          log.debug(`${id}: naissance ≈ ${year} (1er enfant)`);
        }
      }

      // --- Règles 2-4 : décès estimé ---------------------------------------
      if (!p.death.value) {
        const bornRecently = p.birth.value &&
          currentYear - p.birth.value.year < RULES.LIVING_CUTOFF_YEARS;
        if (bornRecently && !p.deathEvidence) {
          // Règle 4 : présumé vivant — on n'estime pas.
          if (p.death.status !== 'living') {
            p.death = { value: null, status: 'living', estimatedFrom: 'né il y a < 110 ans', qualifier: null };
            stats.livingAssumed++;
          }
        } else if (p.birth.value) {
          // Règle 2 : après le dernier enfant ; Règle 3 : plafond < 100 ans.
          const childDates = p.parentOfChildIds
            .map(cid => people.get(cid))
            .filter(Boolean)
            .map(c => c.birth.value ? dateToValue(c.birth.value) : -Infinity)
            .filter(v => v !== -Infinity);
          const afterLastChild = childDates.length
            ? Math.max(...childDates) + RULES.MIN_YEARS_AFTER_LAST_CHILD
            : -Infinity;
          const birthYear = p.birth.value.year;
          const avgLife = birthYear + RULES.AVG_LIFE;
          const year = Math.min(
            Math.max(afterLastChild, avgLife),
            birthYear + RULES.MAX_LIFE,
          );
          p.death = { value: { year, month: null, day: null }, status: 'estimated',
                      estimatedFrom: `espérance de vie (plafond ${RULES.MAX_LIFE} ans)`,
                      qualifier: 'EST' };
          changed++; stats.deathEstimated++;
          log.debug(`${id}: décès ≈ ${year} (estimé)`);
        }
      }
    }

    log.info(`Passe ${pass}: ${changed} date(s) estimée(s)`);
    if (changed === 0) break;
  }

  log.info(`Estimation terminée : ${stats.birthEstimated} naissances, ` +
           `${stats.deathEstimated} décès estimés, ${stats.livingAssumed} vivants présumés`);
  return stats;
}
