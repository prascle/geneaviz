/**
 * tree.js — Jalon M2 : arbre générationnel des ascendants (D3).
 *
 * Depuis l'individu racine sélectionné en M1, construit l'arbre des ascendants
 * (père et mère à chaque génération) et le dessine en SVG avec d3 :
 * layout orienté gauche → droite, zoom (molette) et déplacement (glisser).
 *
 * Conformément à dateEstimator, les dates estimées sont mises en évidence :
 * préfixe « ≈ », style dédié, cadre en tirets si une date est estimée.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';

const log = logger('tree');

/** Dimensions d'une carte individu et espacements du layout (px). */
const NODE_W = 152;
const NODE_H = 44;
const GAP_Y = 16;   // espace vertical minimum entre cartes
const GAP_X = 60;   // espace horizontal entre générations

/**
 * Construit la hiérarchie des ascendants d'un individu.
 * @param {Object} index - index applicatif (getIndividual, getFamily)
 * @param {string} rootId - xref de l'individu racine
 * @param {number} maxGen - nombre maximal de générations affichées (≥ 1)
 * @returns {Object|null} racine {id, person, gen, children[]} ou null
 */
export function buildAncestorTree(index, rootId, maxGen) {
  const rootPerson = index.getIndividual(rootId);
  if (!rootPerson) return null;
  const seen = new Set([rootId]);
  let nodes = 0;

  const build = (id, person, gen) => {
    nodes++;
    const node = { id, person, gen, children: [] };
    if (gen >= maxGen) return node;
    for (const famId of person.childInFamilies) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      for (const parentId of [fam.husband, fam.wife]) {
        if (!parentId || seen.has(parentId)) continue;
        const parent = index.getIndividual(parentId);
        if (!parent) continue;
        seen.add(parentId);
        node.children.push(build(parentId, parent, gen + 1));
      }
    }
    return node;
  };

  const root = build(rootId, rootPerson, 1);
  log.info('Arbre de ' + rootId + ' : ' + nodes + ' individu(s) sur ≤ ' + maxGen + ' générations');
  return root;
}

/** Année d'affichage d'une DateInfo (préfixe ≈ si estimée). */
function yearLabel(d) {
  if (!d.value) return d.status === 'living' ? 'vivant·e' : '—';
  return (d.status === 'estimated' ? '≈ ' : '') + d.value.year;
}

/** Une des deux dates principales est-elle estimée ? */
function hasEstimatedDate(person) {
  return person.birth.status === 'estimated' || person.death.status === 'estimated';
}

/** Libellé nom complet tronqué pour tenir dans la carte. */
function nameLabel(person) {
  const s = ((person.name.surname || '?') + ' ' + person.name.given).trim();
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
}

/**
 * Initialise la vue « arbre des ascendants ».
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {HTMLElement} [options.controls] - conteneur du sélecteur de profondeur
 * @param {Object} options.index - index applicatif
 * @param {Function} [options.onSelectNode] - callback clic sur un ancêtre
 * @returns {{update: Function, getRootId: Function,
 *            setMaxGenerations: Function}} API de la vue
 */
export function initTree({ container, controls, index, onSelectNode }) {
  container.innerHTML = '';
  let maxGen = 6;
  let currentRootId = null;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g').attr('transform', 'translate(12, 220)');
  svg.call(d3.zoom().scaleExtent([0.15, 3])
    .on('zoom', (event) => gZoom.attr('transform', event.transform)));

  if (controls) {
    controls.innerHTML = '';
    const wrap = d3.select(controls);
    wrap.append('span').text('Générations :');
    const select = wrap.append('select');
    select.selectAll('option')
      .data([2, 3, 4, 5, 6, 7, 8, 9, 10])
      .join('option')
      .attr('value', (d) => d)
      .text((d) => d)
      .property('selected', (d) => d === maxGen);
    select.on('change', () => {
      maxGen = Number(select.node().value);
      update(currentRootId);
    });
  }

  /** Dessine l'arbre des ascendants de la racine donnée. */
  function update(rootId) {
    if (!rootId) return;
    currentRootId = rootId;
    gView.selectAll('*').remove();

    const treeData = buildAncestorTree(index, rootId, maxGen);
    if (!treeData) {
      gView.append('text')
        .attr('x', 8).attr('y', 16)
        .text('Individu introuvable : ' + rootId);
      return;
    }

    const h = d3.hierarchy(treeData, (d) => d.children);
    d3.tree().nodeSize([NODE_H + GAP_Y, NODE_W + GAP_X])(h);

    // Liens parent → enfant
    gView.selectAll('path.tree-link')
      .data(h.links())
      .join('path')
      .attr('class', 'tree-link')
      .attr('d', d3.linkHorizontal().x((d) => d.y).y((d) => d.x));

    // Cartes individu
    const node = gView.selectAll('g.tree-node')
      .data(h.descendants(), (d) => d.data.id)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', (d) =>
        'translate(' + (d.y - NODE_W / 2) + ',' + (d.x - NODE_H / 2) + ')');

    node.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 6)
      .attr('class', (d) => {
        if (d.depth === 0) return 'root';
        return hasEstimatedDate(d.data.person) ? 'est' : null;
      });

    node.append('text')
      .attr('class', 'node-name')
      .attr('x', 10).attr('y', 18)
      .text((d) => nameLabel(d.data.person));

    node.append('text')
      .attr('class', (d) => hasEstimatedDate(d.data.person) ? 'node-dates est' : 'node-dates')
      .attr('x', 10).attr('y', 34)
      .text((d) => {
        const p = d.data.person;
        return yearLabel(p.birth) + ' – ' + yearLabel(p.death);
      });

    node.on('click', (event, d) => {
      log.debug('Clic sur ' + d.data.id);
      if (onSelectNode) onSelectNode(d.data.id);
    });
  }

  log.info('Vue arbre initialisée (max ' + maxGen + ' générations)');
  return {
    update,
    getRootId: () => currentRootId,
    setMaxGenerations: (n) => { maxGen = n; update(currentRootId); },
  };
}