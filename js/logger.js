/**
 * logger.js — Système de trace centralisé.
 *
 * Chaque module instancie son logger : `const log = logger('gedcomIndex')`.
 * Niveau global activé via `?log=DEBUG` dans l'URL ou
 * `localStorage.setItem('genea:logLevel', 'DEBUG')`.
 * Les traces sont émises vers `console` ; un `appender` alternatif peut être
 * branché via `setAppender` (ex. tampon mémoire pour export).
 */

/** Niveaux de trace, ordre croissant de gravité. */
export const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

let minLevel = LEVELS.INFO;
let appender = (level, module, args) => {
  const fn = level === 'ERROR' ? console.error
    : level === 'WARN' ? console.warn
    : level === 'DEBUG' ? console.debug
    : console.log;
  fn(`[${level}][${module}]`, ...args);
};

/**
 * Initialise le niveau minimal de trace.
 * @param {string} level - 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
 * @returns {void}
 */
export function setLevel(level) {
  if (!(level in LEVELS)) throw new Error(`Niveau de trace inconnu: ${level}`);
  minLevel = LEVELS[level];
}

/**
 * Remplace le mécanisme d'émission (utile pour les tests ou l'export).
 * @param {(level: string, module: string, args: any[]) => void} fn
 * @returns {void}
 */
export function setAppender(fn) { appender = fn; }

/**
 * Lit le niveau demandé depuis l'URL (?log=) puis localStorage.
 * @returns {string|null} nom du niveau ou null si absent
 */
export function readConfiguredLevel() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('log');
    return (fromUrl && fromUrl.toUpperCase()) ||
      localStorage.getItem('genea:logLevel');
  } catch { return null; }
}

/**
 * Fabrique un logger nommé par module.
 * @param {string} moduleName - nom du module émetteur (préfixe des traces)
 * @returns {{debug: Function, info: Function, warn: Function, error: Function,
 *            time: (label: string) => () => number}}
 */
export function logger(moduleName) {
  const emit = (level, ...args) => {
    if (LEVELS[level] >= minLevel) appender(level, moduleName, args);
  };
  return {
    debug: (...a) => emit('DEBUG', ...a),
    info: (...a) => emit('INFO', ...a),
    warn: (...a) => emit('WARN', ...a),
    error: (...a) => emit('ERROR', ...a),
    /**
     * Chronomètre simple. Usage : `const stop = log.time('parse'); ... stop();`
     * retourne la durée en ms.
     */
    time: (label) => {
      const t0 = performance.now();
      return () => {
        const dt = performance.now() - t0;
        emit('DEBUG', `${label}: ${dt.toFixed(1)} ms`);
        return dt;
      };
    },
  };
}

// Auto-configuration depuis l'URL / localStorage au chargement du module.
const cfg = readConfiguredLevel();
if (cfg) {
  try { setLevel(cfg); } catch { /* niveau invalide : on garde INFO */ }
}
