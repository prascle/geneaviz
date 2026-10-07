/**
 * app.js — Point d'entrée. Jalon M1 :
 * charger un fichier, indexer, estimer les dates, rechercher un individu,
 * le sélectionner et afficher son détail.
 */
import { logger } from './logger.js';
import { readGedcomFile, parseGedcom } from './gedcomLoader.js';
import { buildIndex } from './gedcomIndex.js';
import { initSearch } from './search.js';
import { initSearchBar } from './searchBar.js';
import { formatDate } from './utils.js';

const log = logger('app');
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const searchSection = document.getElementById('search-section');
const detailSection = document.getElementById('detail-section');
const detailsEl = document.getElementById('details');

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
 * Traite un fichier GEDCOM sélectionné : lecture → parsing → index → estimation,
 * puis active la recherche.
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

    const searchService = initSearch(index);
    window.genea = { index, searchService };   // inspection console
    setStatus(`✔ ${file.name} chargé en ${dt.toFixed(0)} ms — ` +
      `${index.peopleCount} individus, ${index.familyCount} familles, ` +
      `${index.surnameCount} patronymes.`);

    // ---------- Barre de recherche (M1) ----------
    const container = document.getElementById('search-container');
    container.innerHTML = '';
    initSearchBar({
      container,
      searchService,
      onSelect: (id) => showDetails(index, id),
    });
    searchSection.hidden = false;
    detailSection.hidden = false;

    const s = index.stats();
    outputEl.textContent =
`Statistiques (M1)
  Individus           : ${s.people}
  Familles            : ${s.families}
  Patronymes distincts: ${s.surnames}
  Naissances estimées : ${s.birthEstimated}
  Décès estimés       : ${s.deathEstimated}
  Vivants présumés    : ${s.livingAssumed}

Dans la console :
  genea.searchService.search({ surname: 'DUPONT', given: 'je' })
  genea.index.getIndividual('@I1@')`;
  } catch (err) {
    log.error('Échec du chargement :', err);
    setStatus(`✘ Erreur : ${err.message}`, true);
  }
}

/**
 * Affiche le détail complet d'un individu dans le panneau dédié.
 * @param {Object} index - index applicatif
 * @param {string} id - xref de l'individu sélectionné
 * @returns {void}
 */
function showDetails(index, id) {
  const p = index.getIndividual(id);
  if (!p) { detailsEl.textContent = `Individu introuvable : ${id}`; return; }
  window.genea.state = { rootId: id };   // racine future de l'arbre (M2)

  const dateHtml = (d, livingLabel) => {
    if (!d.value) return d.status === 'living'
      ? `<em>${livingLabel}</em>`
      : '<span title="inconnue">—</span>';
    const cls = d.status === 'estimated' ? ' class="est" title="date estimée"' : '';
    return `<span${cls}>${d.status === 'estimated' ? '≈ ' : ''}${formatDate(d.value)}</span>`
      + (d.status === 'estimated' && d.estimatedFrom ? ` <small>(${d.estimatedFrom})</small>` : '');
  };

  const famRows = [];
  for (const fid of p.familyAsSpouse) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    const spouseId = fam.husband === id ? fam.wife : fam.husband;
    const spouse = spouseId ? index.getIndividual(spouseId) : null;
    const spouseLabel = spouse
      ? `${spouse.name.surname.toUpperCase()} ${spouse.name.given}`
      : '(inconnu·e)';
    famRows.push(`<tr><td>Famille</td><td>Union avec <strong>${spouseLabel}</strong>`
      + (fam.marriage.value ? ` — mariage ${dateHtml(fam.marriage, '?')}` : '')
      + (fam.children.length ? ` — ${fam.children.length} enfant(s)` : '')
      + `</td></tr>`);
  }

  detailsEl.innerHTML = `<table>
    <tr><td>Identité</td><td><strong>${(p.name.surname || '?').toUpperCase()} ${p.name.given}</strong>${p.name.suffix ? ' ' + p.name.suffix : ''}</td></tr>
    <tr><td>Sexe</td><td>${p.sex === 'M' ? 'Masculin' : p.sex === 'F' ? 'Féminin' : 'Inconnu'}</td></tr>
    <tr><td>Naissance</td><td>${dateHtml(p.birth, 'vivant·e (présumé)')}</td></tr>
    <tr><td>Décès</td><td>${dateHtml(p.death, 'vivant·e (présumé)')}</td></tr>
    ${famRows.join('')}
    <tr><td>Identifiant</td><td><code>${p.id}</code></td></tr>
  </table>`;
  log.info(`Détail affiché pour ${p.id}`);
}

document.getElementById('file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
});

log.info('GeneaViz M1 prêt — sélectionner un fichier .ged');
