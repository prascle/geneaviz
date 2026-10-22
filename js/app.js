/**
 * app.js — Point d'entrée. Jalons M5/M5.1/M6 :
 * charger un fichier, indexer, estimer les dates, rechercher un individu,
 * afficher son détail et naviguer entre les vues : arbre combiné (D3) et
 * vue chronologique. Barre de vues partagée : générations, recentrage,
 * plein écran. Menu contextuel (clic droit) : détail, racine, et éditions
 * d'affichage M6 (branches extensibles, registre partagé par les vues).
 */
import { logger } from './logger.js';
import { readGedcomFile, parseGedcom } from './gedcomLoader.js';
import { buildIndex } from './gedcomIndex.js';
import { initSearch } from './search.js';
import { initSearchBar } from './searchBar.js';
import { initTree } from './tree.js';
import { initTimeline } from './timeline.js';
import { initView3d } from './view3d.js';
import { formatDate } from './utils.js';
import { initContextMenu } from './contextmenu.js';
import { createEdits, siblingIds, baseScope, potentialIds } from './edits.js';

const log = logger('app');
let treeApi = null;         // vue arbre combiné
let timelineApi = null;     // vue chronologique
let view3dApi = null;       // vue 3D (M7)
const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const searchSection = document.getElementById('search-section');
const detailSection = document.getElementById('detail-section');
const treeSection = document.getElementById('tree-section');
const timelineSection = document.getElementById('timeline-section');
const view3dSection = document.getElementById('view3d-section');
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
 * puis active la recherche et les vues.
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

    // ---------- Éditions d'affichage (M6 : branches extensibles) ----------
    const edits = createEdits();
    let currentRootId = null;

    /** Sélectionne la racine courante et resynchronise les deux vues.
     *  Un changement de racine retire toutes les éditions. */
    function setRoot(id) {
      edits.clear();
      currentRootId = id;
      window.genea.state = { rootId: id };
      treeApi.update(id);
      timelineApi.update(id);
      view3dApi.update(id);
    }

    /** Rafraîchit les deux vues après une édition (racine inchangée). */
    function refreshViews() {
      if (currentRootId) {
        treeApi.update(currentRootId);
        timelineApi.update(currentRootId);
        view3dApi.update(currentRootId);
      }
    }

    // ---------- Menu contextuel (partagé par les deux vues) ----------
    const ctxMenu = initContextMenu();
    const onContextPerson = (person, event) => {
      const items = [
        { label: 'Voir le détail', action: () => showDetails(index, person.id) },
        { label: 'Définir comme racine',
          action: () => { showDetails(index, person.id); setRoot(person.id); } },
      ];
      let sep = false;
      const pushSep = () => { if (!sep) { items.push({ separator: true }); sep = true; } };
      const gens = () => ({
        u: Number(document.getElementById('gen-up').value),
        d: Number(document.getElementById('gen-down').value),
      });
      const { u, d } = currentRootId ? gens() : { u: 3, d: 3 };
      const scope = currentRootId ? baseScope(index, currentRootId, u, d) : new Set();

      // ---- ajouts (M6a fratrie + M6b ascendants/descendants) ----
      const sibs = siblingIds(index, person.id);
      if (sibs.some((s) => !scope.has(s))) {
        pushSep();
        items.push({ label: `Ajouter la fratrie (${sibs.length})`,
          action: () => { edits.add(person.id, 'siblings'); refreshViews(); } });
      }
      if (!edits.get(person.id, 'up')
          && [...potentialIds(index, person.id, 'up', u)].some((id) => !scope.has(id))) {
        pushSep();
        items.push({ editor: { label: 'Ajouter les ascendants', min: 1, max: 10,
          def: u, onValidate: (n) => { edits.add(person.id, 'up', n); refreshViews(); } } });
      }
      if (!edits.get(person.id, 'down')
          && [...potentialIds(index, person.id, 'down', d)].some((id) => !scope.has(id))) {
        pushSep();
        items.push({ editor: { label: 'Ajouter les descendants', min: 1, max: 10,
          def: d, onValidate: (n) => { edits.add(person.id, 'down', n); refreshViews(); } } });
      }

      // ---- retraits : une entrée par édition active dont ce pivot est l'origine ----
      const names = { siblings: 'fratrie', up: 'ascendants', down: 'descendants' };
      for (const t of ['siblings', 'up', 'down']) {
        const ed = edits.get(person.id, t);
        if (!ed) continue;
        pushSep();
        items.push({ label: 'Retirer : ' + names[t]
          + (t !== 'siblings' ? ` (${ed.depth} gén.)` : ''),
          action: () => { edits.remove(person.id, t); refreshViews(); } });
      }
      ctxMenu.show(event, items);
    };
    
    // ---------- Vues (arbre + chronologique) : réglages partagés ----------
    treeApi = initTree({
      container: document.getElementById('tree-container'),
      index,
      onSelectNode: (id) => showDetails(index, id),
      onContextPerson,
      getEdits: () => edits.all(),
    });
    timelineApi = initTimeline({
      container: document.getElementById('timeline-container'),
      index,
      onSelectPerson: (id) => showDetails(index, id),   // clic gauche : détail seul (racine via menu contextuel)
      onContextPerson,
      getEdits: () => edits.all(),
    });
    window.genea.tree = treeApi;
    window.genea.timeline = timelineApi;

    // ---------- Vue 3D (M7a : squelette du graphe de base) ----------
    view3dApi = initView3d({
      container: document.getElementById('view3d-container'),
      index,
      onSelectPerson: (id) => showDetails(index, id),   // détail seul, comme la chrono
      onContextPerson,
      getEdits: () => edits.all(),
    });
    window.genea.view3d = view3dApi;

    // ---------- Barre de recherche (M1) ----------
    const container = document.getElementById('search-container');
    container.innerHTML = '';
    initSearchBar({
      container,
      searchService,
      onSelect: (id) => { showDetails(index, id); setRoot(id); },
    });
    searchSection.hidden = false;
    detailSection.hidden = false;

    // ---------- Barre de vues ----------
    const workspace = document.getElementById('workspace');
    const btnFs = document.getElementById('btn-fullscreen');
    const setFsLabel = () => {
      btnFs.textContent = document.fullscreenElement
        ? '⛶ Quitter plein écran' : '⛶ Plein écran';
    };
    btnFs.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else workspace.requestFullscreen().catch(() =>
        setStatus('✘ Plein écran non disponible dans ce navigateur.', true));
    });
    document.addEventListener('fullscreenchange', setFsLabel);
    // Hauteur des cadres en plein écran : l'espace réellement disponible
    // sous la barre de vues et le titre de section (mesuré après relayout,
    // d'où le requestAnimationFrame — la règle CSS calc(100vh - 6rem) était
    // une approximation fausse dès que la barre de vues passe sur 2 lignes).
    const viewContainers = {
      tree: document.getElementById('tree-container'),
      chrono: document.getElementById('timeline-container'),
      view3d: document.getElementById('view3d-container'),
    };
    function sizeViewContainers() {
      const fs = document.fullscreenElement != null;
      for (const [name, cont] of Object.entries(viewContainers)) {
        if (fs) {
          if (viewSections[name].hidden) continue;   // pas de mise en page si masqué
          const top = cont.getBoundingClientRect().top;
          cont.style.height = Math.max(window.innerHeight - top - 12, 240) + 'px';
        } else {
          cont.style.height = '';   // retour au CSS / hauteur calculée par la vue
        }
      }
    }
    function onFrameResize() {
      sizeViewContainers();
      if (document.fullscreenElement != null) {
        // réajuster le zoom de la vue active au nouveau cadre
        activeApi().reset();
      } else if (currentRootId) {
        timelineApi.update(currentRootId);   // la frise recalcule sa hauteur
      }
    }
    document.addEventListener('fullscreenchange',
      () => requestAnimationFrame(onFrameResize));
    window.addEventListener('resize',
      () => { if (document.fullscreenElement != null) requestAnimationFrame(onFrameResize); });
    const genUpSel = document.getElementById('gen-up');
    const genDownSel = document.getElementById('gen-down');
    const btnReset = document.getElementById('btn-reset');
    const viewBtns = [...document.querySelectorAll('.view-btn')];
    const viewSections = { tree: treeSection, chrono: timelineSection, view3d: view3dSection };
    let activeView = 'tree';
    /** API de la vue active (arbre, chrono ou 3D). */
    const activeApi = () =>
      activeView === 'tree' ? treeApi : activeView === 'chrono' ? timelineApi : view3dApi;

    for (const sel of [genUpSel, genDownSel]) {
      for (let n = 0; n <= 10; n++) {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = n === 0 ? 'aucune' : String(n);
        sel.appendChild(o);
      }
    }
    genUpSel.value = '3'; genDownSel.value = '3';   // défaut partagé

    const applyGens = () => {
      edits.clear();   // un changement de génération invalide les éditions
      const u = Number(genUpSel.value), d = Number(genDownSel.value);
      treeApi.setGenerations(u, d);
      timelineApi.setGenerations(u, d);
      view3dApi.setGenerations(u, d);
    };
    genUpSel.addEventListener('change', applyGens);
    genDownSel.addEventListener('change', applyGens);

    function showView(name) {
      activeView = name;
      viewBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
      for (const [k, s] of Object.entries(viewSections)) s.hidden = k !== name;
      if (document.fullscreenElement != null) {
        sizeViewContainers();   // en plein écran, le cadre doit être retaillé
        if (currentRootId) activeApi().reset();
      }
    }
    viewBtns.forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    btnReset.addEventListener('click', () => activeApi().reset());
    document.getElementById('view-bar').hidden = false;
    showView('tree');

    const s = index.stats();
    outputEl.textContent =
`Statistiques (M5)
  Individus           : ${s.people}
  Familles            : ${s.families}
  Patronymes distincts: ${s.surnames}
  Naissances estimées : ${s.birthEstimated}
  Décès estimés       : ${s.deathEstimated}
  Vivants présumés    : ${s.livingAssumed}

Dans la console :
  genea.searchService.search({ surname: 'DUPONT', given: 'je' })
  genea.index.getIndividual('@I1@')
  genea.tree.update('@I1@')   — arbre combiné ascendants/descendants
  genea.timeline.update('@I1@')   — frise chronologique
  genea.view3d.update('@I1@')   — vue 3D`;
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

log.info('GeneaViz M6 prêt — sélectionner un fichier .ged');
