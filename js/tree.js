/**
 * tree.js — Jalon M4 : vue combinée ascendants/descendants (D3)
 * avec conjoints et distinction visuelle hommes/femmes.
 *
 * Depuis l'individu racine sélectionné en M1, dessine ses ascendants à gauche
 * et ses descendants à droite, sur un nombre de générations réglable de part
 * et d'autre. Chaque individu affiché dont le conjoint n'est pas déjà dans
 * l'arbre reçoit une carte conjoint attachée, reliée par un trait horizontal.
 * Fond des cartes : bleu clair (homme), rose clair (femme), blanc (inconnu).
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
const GAP_Y = 16;    // espace vertical minimum entre cartes
const GAP_X = 60;    // espace horizontal entre générations
const SPOUSE_DX = 24; // espace entre une carte et son conjoint

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
  log.info('Ascendants de ' + rootId + ' : ' + nodes + ' individu(s) sur ≤ ' + maxGen + ' générations');
  return root;
}

/**
 * Construit la hiérarchie des descendants d'un individu.
 * @param {Object} index - index applicatif (getIndividual, getFamily)
 * @param {string} rootId - xref de l'individu racine
 * @param {number} maxGen - nombre maximal de générations affichées (≥ 1)
 * @returns {Object|null} racine {id, person, gen, children[]} ou null
 */
export function buildDescendantTree(index, rootId, maxGen) {
  const rootPerson = index.getIndividual(rootId);
  if (!rootPerson) return null;
  const seen = new Set([rootId]);
  let nodes = 0;

  const build = (id, person, gen) => {
    nodes++;
    const node = { id, person, gen, children: [] };
    if (gen >= maxGen) return node;
    for (const famId of person.familyAsSpouse) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      for (const childId of fam.children) {
        if (!childId || seen.has(childId)) continue;
        const child = index.getIndividual(childId);
        if (!child) continue;
        seen.add(childId);
        node.children.push(build(childId, child, gen + 1));
      }
    }
    return node;
  };

  const root = build(rootId, rootPerson, 1);
  log.info('Descendants de ' + rootId + ' : ' + nodes + ' individu(s) sur ≤ ' + maxGen + ' générations');
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

/** Classe CSS de fond selon le sexe : 'm' (homme), 'f' (femme), null (inconnu). */
function sexClass(person) {
  return person.sex === 'M' ? 'm' : person.sex === 'F' ? 'f' : null;
}

/**
 * Liste les conjoints d'un individu (xref de l'autre parent de chaque famille).
 * @param {Object} index - index applicatif
 * @param {Object} person - individu normalisé
 * @returns {string[]} xrefs des conjoints trouvés
 */
function spouseIds(index, person) {
  const out = [];
  for (const famId of person.familyAsSpouse) {
    const fam = index.getFamily(famId);
    if (!fam) continue;
    const sid = fam.husband === person.id ? fam.wife : fam.husband;
    if (sid) out.push(sid);
  }
  return out;
}

/**
 * Initialise la vue « arbre combiné ascendants/descendants ».
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {HTMLElement} [options.controls] - conteneur des sélecteurs de profondeur
 * @param {Object} options.index - index applicatif
 * @param {Function} [options.onSelectNode] - callback clic sur un individu
 * @returns {{update: Function, getRootId: Function,
 *            setGenerations: Function}} API de la vue
 */
export function initTree({ container, controls, index, onSelectNode }) {
  container.innerHTML = '';
  let upGen = 6;      // générations d'ascendants (0 = aucun)
  let downGen = 6;    // générations de descendants (0 = aucun)
  let currentRootId = null;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g').attr('transform', 'translate(12, 260)');
  svg.call(d3.zoom().scaleExtent([0.1, 3])
    .on('zoom', (event) => gZoom.attr('transform', event.transform)));

  if (controls) {
    controls.innerHTML = '';
    const wrap = d3.select(controls);
    const mkSelect = (labelText, initial, onChange) => {
      const label = wrap.append('label');
      label.append('span').text(labelText);
      const sel = label.append('select');
      sel.selectAll('option')
        .data([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
        .join('option')
        .attr('value', (d) => d)
        .text((d) => d === 0 ? 'aucune' : String(d))
        .property('selected', (d) => d === initial);
      sel.on('change', () => onChange(Number(sel.node().value)));
    };
    mkSelect('↑ Ascendants : ', upGen, (v) => { upGen = v; update(currentRootId); });
    mkSelect('↓ Descendants : ', downGen, (v) => { downGen = v; update(currentRootId); });
  }

  /** Ajoute rect + textes + clic à une sélection de cartes. */
  function drawCards(sel) {
    sel.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 6)
      .attr('class', (d) => {
        const cls = [sexClass(d.person)];
        if (d.isRoot) cls.push('root');
        else if (hasEstimatedDate(d.person)) cls.push('est');
        return cls.filter(Boolean).join(' ') || null;
      });

    sel.append('text')
      .attr('class', 'node-name')
      .attr('x', 10).attr('y', 18)
      .text((d) => nameLabel(d.person));

    sel.append('text')
      .attr('class', (d) => hasEstimatedDate(d.person) ? 'node-dates est' : 'node-dates')
      .attr('x', 10).attr('y', 34)
      .text((d) => yearLabel(d.person.birth) + ' – ' + yearLabel(d.person.death));

    sel.on('click', (event, d) => {
      log.debug('Clic sur ' + d.id);
      if (onSelectNode) onSelectNode(d.id);
    });
  }

  /** Dessine l'arbre combiné centré sur la racine donnée. */
  function update(rootId) {
    if (!rootId) return;
    currentRootId = rootId;
    gView.selectAll('*').remove();

    const rootPerson = index.getIndividual(rootId);
    if (!rootPerson) {
      gView.append('text')
        .attr('x', 8).attr('y', 16)
        .text('Individu introuvable : ' + rootId);
      return;
    }

    // ---------- Layouts des deux côtés ----------
    const sides = [];   // { h: hiérarchie D3, sign: -1 (gauche) | +1 (droite) }
    if (upGen > 0) {
      const data = buildAncestorTree(index, rootId, upGen);
      if (data) {
        const h = d3.hierarchy(data, (d) => d.children);
        d3.tree().nodeSize([NODE_H + GAP_Y, NODE_W + GAP_X])(h);
        sides.push({ h, sign: -1 });
      }
    }
    if (downGen > 0) {
      const data = buildDescendantTree(index, rootId, downGen);
      if (data) {
        const h = d3.hierarchy(data, (d) => d.children);
        d3.tree().nodeSize([NODE_H + GAP_Y, NODE_W + GAP_X])(h);
        sides.push({ h, sign: +1 });
      }
    }

    // ---------- Liens parent → enfant ----------
    for (const { h, sign } of sides) {
      gView.selectAll(null)
        .data(h.links(), (d) => d.source.data.id + '>' + d.target.data.id)
        .join('path')
        .attr('class', 'tree-link')
        .attr('d', d3.linkHorizontal().x((d) => sign * d.y).y((d) => d.x));
    }

    // ---------- Cartes (racine + ancêtres + descendants) ----------
    const cards = [{ id: rootId, person: rootPerson, isRoot: true, px: 0, py: 0 }];
    for (const { h, sign } of sides) {
      for (const d of h.descendants()) {
        if (d.depth === 0) continue;   // la racine est dessinée une seule fois
        cards.push({ id: d.data.id, person: d.data.person, isRoot: false,
                     px: sign * d.y, py: d.x });
      }
    }

    // ---------- Conjoints non déjà affichés (M4) ----------
    const displayed = new Set(cards.map((c) => c.id));
    const usedAsSpouse = new Set();
    const spouseLinks = [];
    for (const c of cards) {
      for (const sid of spouseIds(index, c.person)) {
        if (displayed.has(sid) || usedAsSpouse.has(sid)) continue;
        const sp = index.getIndividual(sid);
        if (!sp) continue;
        usedAsSpouse.add(sid);
        // conjoint placé à l'extérieur de la carte (gauche côté ascendants,
        // droite pour la racine et les descendants)
        const dir = c.px < 0 ? -1 : +1;
        const sx = c.px + dir * (NODE_W + SPOUSE_DX);
        spouseLinks.push({ from: c, x1: c.px + dir * NODE_W / 2, y1: c.py,
                           x2: sx - dir * NODE_W / 2, y2: c.py });
        cards.push({ id: sid, person: sp, isRoot: false, px: sx, py: c.py });
      }
    }
    for (const l of spouseLinks) {
      gView.append('line')
        .attr('class', 'spouse-link')
        .attr('x1', l.x1).attr('y1', l.y1)
        .attr('x2', l.x2).attr('y2', l.y2);
    }

    const node = gView.selectAll(null)
      .data(cards, (d) => d.id + '|' + d.px + ',' + d.py)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', (d) =>
        'translate(' + (d.px - NODE_W / 2) + ',' + (d.py - NODE_H / 2) + ')');
    drawCards(node);

    log.info('Vue combinée dessinée : ' + cards.length + ' carte(s) dont ' +
      usedAsSpouse.size + ' conjoint(s), ' + upGen + ' gén. ascendants, ' +
      downGen + ' gén. descendants');
  }

  log.info('Vue arbre combiné initialisée (' + upGen + '/' + downGen + ' générations)');
  return {
    update,
    getRootId: () => currentRootId,
    setGenerations: (up, down) => { upGen = up; downGen = down; update(currentRootId); },
  };
}