/**
 * app.js — Point d'entrée. Jalon M0 :
 * charger un fichier, indexer, estimer les dates, afficher les statistiques.
 */
import { logger } from './logger.js';
import { readGedcomFile, parseGedcom } from './gedcomLoader.js';
import { buildIndex } from './gedcomIndex.js';
import { formatDate } from './utils.js';

const log = logger('app');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');

/**
 * Affiche un message de statut dans la page.
 * @param {string} msg - message à afficher
 * @param {boolean} [isError=false] - style d'erreur
 */
function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

/**
 * Traite un fichier GEDCOM sélectionné : lecture → parsing → index → estimation.
 * @param {File} file
 * @returns {Promise<void>}
 */
async function handleFile(file) {
  setStatus(`Chargement de « ${file.name} »…`);
  outputEl.textContent = '';
  try {
    const t0 = performance.now();
    const text = await readGedcomFile(file);
    const parsed = parseGedcom(text);
    const index = buildIndex(parsed);
    const dt = performance.now() - t0;

    window.genea = { index };   // inspection en console
    setStatus(`✔ ${file.name} chargé en ${dt.toFixed(0)} ms — ` +
      `${index.peopleCount} individus, ${index.familyCount} familles.`);
    log.info(`Fichier chargé : ${index.peopleCount} individus en ${dt.toFixed(0)} ms`);

    const s = index.stats();
    outputEl.textContent =
`Statistiques (M0)
  Individus           : ${s.people}
  Familles            : ${s.families}
  Patronymes distincts: ${s.surnames}
  Naissances estimées : ${s.birthEstimated}
  Décès estimés       : ${s.deathEstimated}
  Vivants présumés    : ${s.livingAssumed}

Exemples d'individus (dates estimées repérées « ≈ » / statut) :
${samplePeople(index).join('\n')}

Dans la console :
  genea.index.searchByName('PATRONYME', 'prénom')
  genea.index.getIndividual('@I1@')`;
  } catch (err) {
    log.error('Échec du chargement :', err);
    setStatus(`✘ Erreur : ${err.message}`, true);
  }
}

/**
 * Produit quelques lignes d'exemple d'individus (les 15 premiers).
 * @param {Object} index
 * @returns {string[]}
 */
function samplePeople(index) {
  return [...Array(15).keys()].map(i => {
    const p = index.getIndividual(`@I${i + 1}@`);
    if (!p) return null;
    const birth = p.birth.value
      ? (p.birth.status === 'estimated' ? '≈ ' : '') + formatDate(p.birth.value)
      : p.birth.status === 'living' ? '' : '—';
    const death = p.death.value
      ? (p.death.status === 'estimated' ? '≈ ' : '') + formatDate(p.death.value)
      : p.death.status === 'living' ? 'vivant' : '—';
    return `  ${p.name.surname.toUpperCase()} ${p.name.given} (${p.sex ?? '?'}) ` +
           `${birth} → ${death}`;
  }).filter(Boolean);
}

document.getElementById('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

log.info('GeneaViz M0 prêt — sélectionner un fichier .ged');
