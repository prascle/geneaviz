/**
 * utils.js — Utilitaires transverses : dates GEDCOM, noms, debounce.
 * Modules purs, sans dépendance au DOM.
 */
import { logger } from './logger.js';
const log = logger('utils');

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/**
 * Parse une date GEDCOM en valeur numérique comparable.
 * Formats gérés : "12 JAN 1873", "JAN 1873", "1873",
 * qualificatifs "ABT", "CAL", "EST", "BEF", "AFT", "BET ... AND ..." (borne inf.).
 *
 * @param {string} raw - valeur GEDCOM brute (ex. "ABT 1850")
 * @returns {{year: number|null, month: number|null, day: number|null,
 *            qualifier: string|null,
 *            iso: string|null}} `iso` est normalisé "YYYY-MM-DD" (partiel si incomplet) ;
 *            `qualifier` vaut 'ABT'|'BEF'|'AFT'|'CAL'|'EST' ou null (date certaine).
 */
export function parseGedcomDate(raw) {
  const result = { year: null, month: null, day: null, qualifier: null, iso: null };
  if (!raw || typeof raw !== 'string') return result;
  let s = raw.trim();
  const qualMatch = s.match(/^(ABT|CAL|EST|BEF|AFT)\b/i);
  if (qualMatch) { result.qualifier = qualMatch[1].toUpperCase(); s = s.slice(qualMatch[0].length).trim(); }
  const betMatch = s.match(/^BET\b/i);
  if (betMatch) { result.qualifier = 'BET'; s = s.slice(4).trim().split(/\bAND\b/i)[0]; }
  const tokens = s.split(/\s+/);
  for (const tok of tokens) {
    if (/^\d{4}$/.test(tok)) result.year = Number(tok);
    else if (/^\d{1,2}$/.test(tok) && !result.day) result.day = Number(tok);
    else if (MONTHS[tok.toUpperCase()]) result.month = MONTHS[tok.toUpperCase()];
  }
  if (result.year != null) {
    result.iso = [result.year, result.month, result.day]
      .filter(v => v != null).map((v, i) => String(v).padStart(i === 0 ? 4 : 2, '0')).join('-');
  }
  return result;
}

/**
 * Formate une date pour affichage compact.
 * @param {{year: number|null, month: number|null, day: number|null,
 *          qualifier: string|null}} d
 * @returns {string} ex. "12 janv. 1873", "≈ 1850", "—"
 */
export function formatDate(d) {
  if (!d || d.year == null) return '—';
  const MONTH_FR = ['', 'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
    'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  const body = [d.day, d.month && MONTH_FR[d.month], d.year].filter(Boolean).join(' ');
  const prefix = d.qualifier === 'BEF' ? '< '
    : d.qualifier === 'AFT' ? '> '
    : (d.qualifier === 'ABT' || d.qualifier === 'EST' || d.qualifier === 'CAL' || d.qualifier === 'BET') ? '≈ ' : '';
  return prefix + body;
}

/**
 * Convertit une date en valeur numérique (année décimale) pour comparaisons
 * et estimations. Retourne -Infinity si inconnue.
 * @param {{year: number|null, month: number|null, day: number|null}} d
 * @returns {number}
 */
export function dateToValue(d) {
  if (!d || d.year == null) return -Infinity;
  return d.year + ((d.month ?? 0) - 0.5) / 12 + ((d.day ?? 0) - 0.5) / 365.25;
}

/**
 * Ajoute n années à une date GEDCOM parse (utilisé par dateEstimator).
 * @param {{year: number|null, month: number|null, day: number|null}} d
 * @param {number} years - années (peut être négatif)
 * @returns {{year: number, month: number|null, day: number|null}}
 */
export function addYears(d, years) {
  return { year: d.year + years, month: d.month, day: d.day };
}

/* ------------------------------------------------------------------ */
/* Noms                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Normalise un nom GEDCOM "Prénom /PATRONYME/ Suffixe" en composants.
 * @param {string} raw - valeur brute de NAME
 * @returns {{given: string, surname: string, suffix: string}}
 */
export function parseName(raw) {
  const s = (raw ?? '').trim();
  const m = s.match(/^(.*?)\s*\/(.*?)\/\s*(.*)$/);
  if (m) return { given: m[1].trim(), surname: m[2].trim(), suffix: m[3].trim() };
  return { given: s, surname: '', suffix: '' };
}

/**
 * Normalise une chaîne pour la recherche insensible à la casse/accents.
 * @param {string} s
 * @returns {string}
 */
export function normalize(s) {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* ------------------------------------------------------------------ */
/* Divers                                                               */
/* ------------------------------------------------------------------ */

/**
 * Retarde l'exécution jusqu'à `delay` ms sans invocation intermédiaire.
 * @param {Function} fn
 * @param {number} [delay=200]
 * @returns {Function} fonction annulable
 */
export function debounce(fn, delay = 200) {
  let t;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

log.debug('utils chargé');
