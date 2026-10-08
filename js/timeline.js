/**
 * timeline.js — Jalon M5 : vue chronologique (frise des vies).
 *
 * Chaque individu du périmètre est une barre horizontale allant de son
 * année de naissance à son année de décès :
 *  - dates connues   : barre pleine (fond selon le sexe) ;
 *  - dates estimées  : barre en tirets orangés (préfixe ≈ dans les étiquettes) ;
 *  - vivant présumé  : barre prolongée jusqu'à l'année courante, flèche.
 *
 * Périmètre : « arbre courant » (racine sélectionnée + ascendants et
 * descendants aux mêmes profondeurs que la vue arbre + conjoints) ou
 * « tout le fichier ». Tri par année de naissance croissante.
 *
 * Interactions : zoom horizontal (molette), glisser ; clic sur une barre
 * → callback (détail + recentrage de l'arbre) ; racine surlignée.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';
import { buildAncestorTree, buildDescendantTree } from './tree.js';

const log = logger('timeline');

/** Dimensions du layout (px). */
const NAME_W = 190;   // colonne des noms à gauche
const ROW_H = 20;     // hauteur d'une ligne de vie
const HEADER_H = 28;  // espace pour l'axe temporel
const PAD = 12;

/**
 * Initialise la vue chronologique.
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {HTMLElement} [options.controls] - conteneur du sélecteur de périmètre
 * @param {Object} options.index - index applicatif
 * @param {number} [options.upGen=6] - générations d'ascendants (périmètre « arbre »)
 * @param {number} [options.downGen=6] - générations de descendants
 * @param {Function} [options.onSelectPerson] - callback clic sur une barre
 * @returns {{update: Function, getScope: Function}} API de la vue
 */
export function initTimeline({ container, controls, index, upGen = 6, downGen = 6, onSelectPerson }) {
  container.innerHTML = '';
  let scope = 'tree';          // 'tree' | 'all'
  let currentRootId = null;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  const gZoom = svg.append('g');
  const gAxis = gZoom.append('g');   // axe temporel (suit le zoom)
  const gRows = gZoom.append('g');

  const zoomBeh = d3.zoom()
    .scaleExtent([0.3, 40])
    .on('zoom', (event) => {
      gZoom.attr('transform',
        `translate(${event.transform.x},${HEADER_H}) scale(${event.transform.k},1)`);
    });
  svg.call(zoomBeh);

  if (controls) {
    controls.innerHTML = '';
    const wrap = d3.select(controls);
    wrap.append('span').text('Périmètre :');
    const sel = wrap.append('select');
    sel.selectAll('option')
      .data([['tree', 'arbre courant'], ['all', 'tout le fichier']])
      .join('option')
      .attr('value', (d) => d[0])
      .text((d) => d[1]);
    sel.on('change', () => { scope = sel.node().value; update(currentRootId); });
  }

  /** Ensemble des ids du périmètre courant (arbre : ascendants+descendants+conjoints). */
  function collectIds(rootId) {
    const ids = new Set();
    const addTree = (data) => {
      if (!data) return;
      (function walk(n) {
        ids.add(n.id);
        const person = index.getIndividual(n.id);
        if (person) {
          // conjoints des membres de l'arbre
          for (const famId of person.familyAsSpouse) {
            const fam = index.getFamily(famId);
            if (!fam) continue;
            const sid = fam.husband === n.id ? fam.wife : fam.husband;
            if (sid && index.getIndividual(sid)) ids.add(sid);
          }
        }
        n.children.forEach(walk);
      })(data);
    };
    addTree(buildAncestorTree(index, rootId, upGen));
    addTree(buildDescendantTree(index, rootId, downGen));
    return ids;
  }

  /** Ligne de vie dérivée d'un individu (bornes de barre). */
  function lifeSpan(person, nowYear) {
    const b = person.birth, d = person.death;
    const bYear = b.value?.year ?? null;
    const dYear = d.value?.year ?? null;
    let x1 = bYear, x2 = dYear, estimated = false, alive = false;

    if (bYear != null && dYear != null) {
      estimated = b.status === 'estimated' || d.status === 'estimated';
    } else if (bYear != null) {
      x2 = d.status === 'living' ? nowYear : bYear + 100;
      alive = d.status === 'living';
      estimated = b.status === 'estimated' || d.status !== 'living';
    } else if (dYear != null) {
      x1 = dYear - 100;
      estimated = true;
    } else {
      return null;   // aucune date du tout : hors frise
    }
    if (x2 < x1) x2 = x1 + 1;
    return { x1, x2, estimated, alive };
  }

  /** Dessine la frise pour la racine donnée (ou tout le fichier). */
  function update(rootId) {
    currentRootId = rootId;
    gAxis.selectAll('*').remove();
    gRows.selectAll('*').remove();
    if (!rootId || scope === 'tree') {
      if (!rootId) return;
    }

    // ---------- collecte ----------
    let people;
    if (scope === 'all') {
      people = index.getAllPeople();
    } else {
      const ids = collectIds(rootId);
      people = [...ids].map((id) => index.getIndividual(id)).filter(Boolean);
    }
    const nowYear = new Date().getFullYear();
    const rows = [];
    let skipped = 0;
    for (const p of people) {
      const span = lifeSpan(p, nowYear);
      if (!span) { skipped++; continue; }
      rows.push({ id: p.id, person: p, ...span });
    }
    rows.sort((a, b) => a.x1 - b.x1 || a.x2 - b.x2);
    log.info(`Frise : ${rows.length} ligne(s) de vie${skipped ? ` (${skipped} sans dates, ignoré(es))` : ''}`);
    if (!rows.length) return;

    // ---------- échelle temporelle ----------
    const minYear = Math.min(...rows.map((r) => r.x1));
    const maxYear = Math.max(...rows.map((r) => r.x2));
    const x = d3.scaleLinear()
      .domain([minYear - 10, maxYear + 10])
      .range([NAME_W, NAME_W + (maxYear - minYear + 20)]);   // 1 an = 1 px (zoom ensuite)

    const height = Math.max(HEADER_H + rows.length * ROW_H + PAD, 120);
    svg.attr('viewBox', `0 0 1000 ${height}`)
       .attr('preserveAspectRatio', 'none');
    container.style.height = Math.min(height, 480) + 'px';

    // ---------- axe ----------
    const spanYears = maxYear - minYear;
    const step = spanYears > 400 ? 100 : spanYears > 150 ? 50 : spanYears > 60 ? 25 : 10;
    const ticks = [];
    for (let y = Math.ceil((minYear - 10) / step) * step; y <= maxYear + 10; y += step) ticks.push(y);
    gAxis.selectAll('g')
      .data(ticks)
      .join('g')
      .attr('transform', (t) => `translate(${x(t)},0)`)
      .call((g) => {
        g.append('line').attr('class', 'tl-grid')
          .attr('y1', 0).attr('y2', rows.length * ROW_H);
        g.append('text').attr('class', 'tl-tick')
          .attr('y', -8).attr('text-anchor', 'middle')
          .text((t) => t);
      });

    // ---------- lignes de vie ----------
    const row = gRows.selectAll('g.tl-row')
      .data(rows, (r) => r.id)
      .join('g')
      .attr('class', 'tl-row')
      .attr('transform', (r, i) => `translate(0,${i * ROW_H})`);

    row.append('text')
      .attr('class', 'tl-name')
      .attr('x', NAME_W - 6)
      .attr('y', ROW_H / 2 + 4)
      .attr('text-anchor', 'end')
      .text((r) => {
        const s = ((r.person.name.surname || '?') + ' ' + r.person.name.given).trim();
        return s.length > 26 ? s.slice(0, 25) + '…' : s;
      });

    row.append('line')
      .attr('class', (r) => r.estimated ? 'tl-bar est' : 'tl-bar')
      .classed('root', (r) => r.id === currentRootId)
      .attr('x1', (r) => x(r.x1))
      .attr('x2', (r) => x(r.x2))
      .attr('y1', ROW_H / 2)
      .attr('y2', ROW_H / 2);

    row.filter((r) => r.alive).append('path')
      .attr('class', 'tl-arrow')
      .attr('transform', (r) => `translate(${x(r.x2) - 8},${ROW_H / 2})`)
      .attr('d', 'M 0 -4 L 8 0 L 0 4 Z');

    row.on('click', (event, r) => {
      log.debug('Clic frise sur ' + r.id);
      if (onSelectPerson) onSelectPerson(r.id);
    });

    // largeur du SVG étendue pour le défilement/zoom
    svg.attr('viewBox', `0 0 ${Math.max(x(maxYear + 10) + PAD, 1000)} ${height}`);
  }

  log.info('Vue chronologique initialisée');
  return {
    update,
    getScope: () => scope,
  };
}