/**
 * searchBar.js — Composant UI de recherche d'individus (UC2).
 *
 * Construit dans un conteneur DOM :
 *  - un champ patronyme avec autocomplétion (datalist des patronymes du fichier),
 *  - un champ partie de prénom,
 *  - la liste des résultats (nom, prénoms, naissance – décès, avec ≈ pour les
 *    dates estimées et « vivant » pour les vivants présumés, UC7),
 *  - un clic sur un résultat déclenche le callback onSelect.
 */
import { logger } from './logger.js';
import { debounce } from './utils.js';
import { normalize } from './utils.js';
const log = logger('searchBar');

/**
 * Initialise la barre de recherche.
 * @param {Object} options
 * @param {HTMLElement} options.container - élément DOM hôte
 * @param {ReturnType<typeof import('./search.js').initSearch>} options.searchService
 *   service de recherche (initSearch)
 * @param {(person: Object) => void} options.onSelect - callback sélection d'un résultat
 * @returns {{setSelected: (id: string|null) => void, destroy: () => void}}
 */
export function initSearchBar({ container, searchService, onSelect }) {
  const stop = log.time('init searchBar');

  // ---------- Construction du DOM ----------
  container.innerHTML = `
    <div class="search-fields">
      <input type="text" id="search-surname" list="surname-list"
             placeholder="Patronyme (ex. DUPONT)" autocomplete="off">
      <datalist id="surname-list"></datalist>
      <input type="text" id="search-given"
             placeholder="Partie du prénom (ex. jea)" autocomplete="off">
      <button id="search-btn">Rechercher</button>
    </div>
    <div id="search-status" class="search-status"></div>
    <ul id="search-results" class="search-results"></ul>`;

  const surnameInput = container.querySelector('#search-surname');
  const givenInput = container.querySelector('#search-given');
  const surnameList = container.querySelector('#surname-list');
  const resultsEl = container.querySelector('#search-results');
  const statusEl = container.querySelector('#search-status');
  const btn = container.querySelector('#search-btn');

  let selectedId = null;

  // ---------- Suggestions de patronymes (rafraîchies à la saisie) ----------
  const refreshSuggestions = () => {
    const suggestions = searchService.surnameSuggestions(surnameInput.value, 20);
    surnameList.innerHTML = suggestions
      .map(s => `<option value="${s.surname}"></option>`).join('');
  };
  surnameInput.addEventListener('input', refreshSuggestions);
  refreshSuggestions();

  // ---------- Rendu d'une date (naissance ou décès) ----------
  const dateLabel = (d, livingLabel) => {
    if (!d.value) return d.status === 'living' ? livingLabel : '—';
    const prefix = d.status === 'estimated' ? '≈ ' : (d.qualifier === 'ABT' || d.qualifier === 'EST') ? '≈ ' : '';
    const y = d.value.year;
    return prefix + y;
  };

  // ---------- Recherche et affichage des résultats ----------
  const runSearch = () => {
    const surname = surnameInput.value.trim();
    const given = givenInput.value.trim();
    if (normalize(surname).length < 1 && normalize(given).length < 1) {
      statusEl.textContent = 'Saisir un patronyme et/ou une partie de prénom.';
      resultsEl.innerHTML = '';
      return;
    }
    const results = searchService.search({ surname, given });
    if (results.length === 0) {
      statusEl.textContent = 'Aucun individu ne correspond à cette recherche.';
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.textContent = `${results.length} individu(s) trouvé(s) — cliquez pour sélectionner :`;
    resultsEl.innerHTML = results.map(r => `
      <li data-id="${r.id}" class="search-result ${r.id === selectedId ? 'selected' : ''} sex-${r.sex ?? 'U'}">
        <span class="result-name">${(r.surname || '?').toUpperCase()} ${r.given}</span>
        <span class="result-dates">${dateLabel(r.birth, 'née le ?')} – ${dateLabel(r.death, 'vivant·e')}</span>
      </li>`).join('');
    log.debug(`${results.length} résultats affichés`);
  };

  const debouncedSearch = debounce(runSearch, 200);
  surnameInput.addEventListener('input', debouncedSearch);
  givenInput.addEventListener('input', debouncedSearch);
  btn.addEventListener('click', runSearch);
  givenInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

  // ---------- Sélection ----------
  resultsEl.addEventListener('click', e => {
    const li = e.target.closest('.search-result');
    if (!li) return;
    selectedId = li.dataset.id;
    resultsEl.querySelectorAll('.search-result').forEach(el =>
      el.classList.toggle('selected', el.dataset.id === selectedId));
    log.info(`Individu sélectionné : ${selectedId}`);
    onSelect(selectedId);
  });

  stop();

  return {
    /**
     * Marque un individu comme sélectionné (synchronisation externe).
     * @param {string|null} id
     */
    setSelected(id) { selectedId = id; },
    /** Détache les écouteurs (non nécessaire en M1, prévu pour la suite). */
    destroy() { container.innerHTML = ''; },
  };
}
