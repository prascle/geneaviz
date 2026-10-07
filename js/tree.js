/**
 * tree.js — Jalon M4 : vue combinée ascendants/descendants (D3).
 *
 * Layout :
 *  - Ascendants (gauche) : fan-out par générations (layout d3.tree, comme M3).
 *    Les deux parents d'un même enfant sont reliés par un crochet d'union
 *    (petits traits horizontaux + trait vertical) et la filiation vers l'enfant
 *    part du milieu de ce crochet. Parent inconnu → carte fantôme au-dessus,
 *    pour que la filiation parte toujours d'un couple.
 *  - Descendants (droite) : layout dédié — chaque individu est affiché avec
 *    ses conjoints empilés en dessous (remariages → pile, conjoint inconnu →
 *    fantôme), reliés par un trait vertical ; les liens de filiation partent
 *    du milieu du segment individu-concerné.
 *  - Fonds selon le sexe (bleu clair homme, rose clair femme, blanc inconnu).
 *    Dates estimées : préfixe « ≈ », cadre en tirets.
 *  - Bouton « Recentrer » : ajuste zoom et position pour tout revoir.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';

const log = logger('tree');

/** Dimensions d'une carte individu et espacements du layout (px). */
const NODE_W = 152;
const NODE_H = 44;
const GAP_Y = 16;    // espace vertical minimum entre cartes
const GAP_X = 60;    // espace horizontal entre générations
const STACK_STEP = NODE_H + GAP_Y;             // pas vertical de la pile des conjoints
const ANCESTOR_ROW = 2 * NODE_H + 2 * GAP_Y;   // espacement vertical ancêtres
                                               // (laisse la place aux fantômes)

/* ------------------------------------------------------------------ */
/* Hiérarchies (API publique, utile en console)                        */
/* ------------------------------------------------------------------ */

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
  const build = (person, gen) => {
    const node = { id: person.id, person, gen, children: [] };
    if (gen >= maxGen) return node;
    for (const famId of person.childInFamilies) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      for (const parentId of [fam.husband, fam.wife]) {
        if (!parentId || seen.has(parentId)) continue;
        const parent = index.getIndividual(parentId);
        if (!parent) continue;
        seen.add(parentId);
        node.children.push(build(parent, gen + 1));
      }
    }
    return node;
  };
  return build(rootPerson, 1);
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
  const build = (person, gen) => {
    const node = { id: person.id, person, gen, children: [] };
    if (gen >= maxGen) return node;
    for (const famId of person.familyAsSpouse) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      for (const childId of fam.children) {
        if (!childId || seen.has(childId)) continue;
        const child = index.getIndividual(childId);
        if (!child) continue;
        seen.add(childId);
        node.children.push(build(child, gen + 1));
      }
    }
    return node;
  };
  return build(rootPerson, 1);
}

/* ------------------------------------------------------------------ */
/* Vue                                                                 */
/* ------------------------------------------------------------------ */

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

/** Classe CSS de fond selon le sexe : 'm', 'f' ou null. */
function sexClass(person) {
  return person.sex === 'M' ? 'm' : person.sex === 'F' ? 'f' : null;
}

/** Courbe de filiation (bezier horizontale). */
function filiationPath(x1, y1, x2, y2) {
  const dx = (x2 - x1) / 2;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * Initialise la vue « arbre combiné ascendants/descendants ».
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {HTMLElement} [options.controls] - conteneur des sélecteurs et du bouton
 * @param {Object} options.index - index applicatif
 * @param {Function} [options.onSelectNode] - callback clic sur un individu
 * @returns {{update: Function, getRootId: Function,
 *            setGenerations: Function}} API de la vue
 */
export function initTree({ container, controls, index, onSelectNode }) {
  container.innerHTML = '';
  let upGen = 6;      // générations d'ascendants (0 = aucune)
  let downGen = 6;    // générations de descendants (0 = aucune)
  let currentRootId = null;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.05, 3])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  /** Ajuste zoom et translation pour voir tout le graphe. */
  function resetView(animated = true) {
    let t = d3.zoomIdentity.translate(container.clientWidth / 2 - NODE_W / 2,
                                      container.clientHeight / 2);
    try {
      const b = gView.node().getBBox();
      if (b.width > 0 && b.height > 0) {
        const pad = 40;
        const k = Math.min(
          (container.clientWidth - 2 * pad) / b.width,
          (container.clientHeight - 2 * pad) / b.height,
          1.2,
        );
        const tx = container.clientWidth / 2 - k * (b.x + b.width / 2);
        const ty = container.clientHeight / 2 - k * (b.y + b.height / 2);
        t = d3.zoomIdentity.translate(tx, ty).scale(k);
      }
    } catch (e) { /* getBBox indisponible : vue par défaut */ }
    if (animated) svg.transition().duration(350).call(zoomBeh.transform, t);
    else svg.call(zoomBeh.transform, t);
  }

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
    wrap.append('button')
      .attr('type', 'button')
      .attr('class', 'tree-reset')
      .text('⟲ Recentrer')
      .on('click', () => resetView(true));
  }

  /** Ajoute rect + textes + clic à une sélection de cartes. */
  function drawCards(sel) {
    sel.append('rect')
      .attr('width', NODE_W).attr('height', NODE_H).attr('rx', 6)
      .attr('class', (d) => {
        const cls = [];
        if (d.ghost) cls.push('ghost');
        else {
          if (sexClass(d.person)) cls.push(sexClass(d.person));
          if (d.isRoot) cls.push('root');
          else if (hasEstimatedDate(d.person)) cls.push('est');
        }
        return cls.join(' ') || null;
      });

    sel.append('text')
      .attr('class', 'node-name')
      .attr('x', 10).attr('y', 18)
      .text((d) => d.ghost ? '?' : nameLabel(d.person));

    sel.append('text')
      .attr('class', (d) => d.ghost ? 'node-dates ghost-label'
        : (hasEstimatedDate(d.person) ? 'node-dates est' : 'node-dates'))
      .attr('x', 10).attr('y', 34)
      .text((d) => d.ghost ? 'inconnu·e'
        : yearLabel(d.person.birth) + ' – ' + yearLabel(d.person.death));

    sel.filter((d) => !d.ghost)
      .on('click', (event, d) => {
        log.debug('Clic sur ' + d.id);
        if (onSelectNode) onSelectNode(d.id);
      });
  }

  /* ---------- layout descendant : individu + conjoints empilés ---------- */

  /**
   * Construit une unité descendante et mesure son sous-arbre.
   * @param {string} personId
   * @param {number} depth
   * @param {Set<string>} seen - anti-doublons (personnes et conjoints)
   * @returns {{person: Object, rows: number, blockH: number, h: number,
   *            unions: Array<{famId, spouseId, hasRow, ghost, children: Object[]}>}}
   */
  function buildDownUnit(personId, depth, seen) {
    const person = index.getIndividual(personId);
    const unit = { person, rows: 1, blockH: 0, h: NODE_H, unions: [] };
    if (!person || seen.has(personId) || depth >= downGen) return unit;
    seen.add(personId);

    for (const famId of person.familyAsSpouse) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      const spouseId = fam.husband === personId ? fam.wife : fam.husband;
      const childrenIds = fam.children.filter(Boolean);
      if (!spouseId && childrenIds.length === 0) continue;

      // ligne de conjoint : réelle, fantôme (inconnu avec enfants), ou aucune
      let hasRow = false, ghost = false;
      if (spouseId && !seen.has(spouseId)) { hasRow = true; seen.add(spouseId); }
      else if (!spouseId && childrenIds.length > 0) { hasRow = true; ghost = true; }

      const children = [];
      for (const cid of childrenIds) {
        if (seen.has(cid)) continue;
        children.push(buildDownUnit(cid, depth + 1, seen));
      }
      if (hasRow || children.length > 0) {
        unit.unions.push({ famId, spouseId, hasRow, ghost, children });
      }
    }

    const nRows = 1 + unit.unions.filter((u) => u.hasRow).length;
    let blockH = 0, first = true;
    for (const u of unit.unions) {
      for (const c of u.children) { blockH += (first ? 0 : GAP_Y) + c.h; first = false; }
    }
    unit.rows = nRows;
    unit.blockH = blockH;
    unit.h = Math.max(NODE_H, nRows * NODE_H + (nRows - 1) * GAP_Y, blockH);
    return unit;
  }

  /**
   * Place une unité descendante : pile individu+conjoints, filiations,
   * puis récursion sur les enfants (colonne suivante).
   * @param {Object} unit - sortie de buildDownUnit
   * @param {number} xLeft - bord gauche de la colonne
   * @param {number} yCenter - centre vertical alloué à l'unité
   * @param {Object} out - accumulateur {cards, unions, filiation}
   */
  function placeDown(unit, xLeft, yCenter, out) {
    const nRows = unit.rows;
    const stackH = nRows * NODE_H + (nRows - 1) * GAP_Y;
    const top = yCenter - stackH / 2;
    const rowY = (r) => top + NODE_H / 2 + r * STACK_STEP;

    out.cards.set(unit.person.id + '@' + xLeft + ',' + Math.round(rowY(0)), {
      id: unit.person.id, person: unit.person, ghost: false,
      isRoot: unit.person.id === currentRootId,
      cx: xLeft + NODE_W / 2, cy: rowY(0),
    });

    // pile des conjoints + origine de filiation de chaque union
    let r = 0;
    const origins = [];
    for (const u of unit.unions) {
      if (u.hasRow) {
        r++;
        if (u.ghost) {
          out.cards.set('ghost:' + u.famId, {
            id: 'ghost:' + u.famId, person: null, ghost: true, isRoot: false,
            cx: xLeft + NODE_W / 2, cy: rowY(r),
          });
        } else {
          out.cards.set(u.spouseId + '@' + xLeft + ',' + Math.round(rowY(r)), {
            id: u.spouseId, person: index.getIndividual(u.spouseId), ghost: false,
            isRoot: false, cx: xLeft + NODE_W / 2, cy: rowY(r),
          });
        }
        origins.push({ union: u, x: xLeft + NODE_W, y: (rowY(0) + rowY(r)) / 2 });
      } else {
        // conjoint déjà affiché ailleurs : filiation part de l'individu
        origins.push({ union: u, x: xLeft + NODE_W, y: rowY(0) });
      }
    }
    if (nRows > 1) {
      out.unions.push({ x1: xLeft + NODE_W, y1: rowY(0),
                        x2: xLeft + NODE_W, y2: rowY(nRows - 1) });
    }

    // enfants de toutes les unions, empilés et centrés sur l'unité
    let acc = yCenter - unit.blockH / 2, first = true;
    for (const o of origins) {
      for (const c of o.union.children) {
        if (!first) acc += GAP_Y;
        const yc = acc + c.h / 2;
        acc += c.h; first = false;
        const xChild = xLeft + NODE_W + GAP_X;
        out.filiation.push(filiationPath(o.x, o.y, xChild, yc));
        placeDown(c, xChild, yc, out);
      }
    }
  }

  /* ---------- layout ascendant : d3.tree + crochets d'union ---------- */

  /**
   * Dessine le côté ascendant : fan-out d3.tree (comme M3), crochets de
   * couple entre co-parents d'un même enfant, fantôme si parent inconnu,
   * filiation partant du milieu du crochet.
   * @param {string} rootId
   * @param {Object} out - accumulateur {cards, unions, filiation}
   */
  function placeUp(rootId, out) {
    const data = buildAncestorTree(index, rootId, upGen);
    if (!data || !data.children.length) return;

    const h = d3.hierarchy(data, (d) => d.children);
    d3.tree().nodeSize([ANCESTOR_ROW, NODE_W + GAP_X])(h);
    const nodes = h.descendants();
    const rootNode = nodes[0];
    const shift = rootNode.x;   // aligne le milieu des parents de la racine sur y=0
    const cardX = (n) => NODE_W / 2 - n.y;
    const byId = new Map();
    for (const n of nodes) if (n.depth > 0) byId.set(n.data.id, n);

    // cartes
    for (const n of nodes) {
      if (n.depth === 0) continue;
      out.cards.set(n.data.id + '@a', {
        id: n.data.id, person: n.data.person, ghost: false, isRoot: false,
        cx: cardX(n), cy: n.x - shift,
      });
    }

    // unions par famille (co-parents d'un même enfant de l'arbre)
    const ancUnions = new Map();   // famId -> {a: nœud, b: nœud|null}
    for (const n of nodes) {
      if (n.depth === 0) continue;
      const child = n.parent.data.person;
      for (const famId of child.childInFamilies) {
        const fam = index.getFamily(famId);
        if (!fam || (fam.husband !== n.data.id && fam.wife !== n.data.id)) continue;
        const other = fam.husband === n.data.id ? fam.wife : fam.husband;
        if (other) {
          const on = byId.get(other);
          if (on && on.parent === n.parent) ancUnions.set(famId, { a: n, b: on });
          // conjoint existant mais placé ailleurs : pas de crochet
        } else {
          ancUnions.set(famId, { a: n, b: null });   // parent inconnu → fantôme
        }
      }
    }

    // filiations (une par arête enfant→parent, ou une par couple)
    const drawnEdges = new Set();
    const drawnBrackets = new Set();
    const ghostCount = new Map();   // nodeId -> nombre de fantômes déjà posés
    for (const n of nodes) {
      if (n.depth === 0) continue;
      const childNode = n.parent;
      const child = childNode.data.person;
      let famId = null;
      for (const fid of child.childInFamilies) {
        const fam = index.getFamily(fid);
        if (fam && (fam.husband === n.data.id || fam.wife === n.data.id)) { famId = fid; break; }
      }
      const childY = childNode.depth === 0 ? 0 : childNode.x - shift;
      const childLeftX = childNode.depth === 0 ? 0 : -childNode.y;

      const u = famId != null ? ancUnions.get(famId) : null;
      if (u) {
        const edgeKey = 'u:' + famId + ':' + child.id;
        if (drawnEdges.has(edgeKey)) continue;
        drawnEdges.add(edgeKey);

        const xU = cardX(u.a) + NODE_W / 2 + GAP_X / 2;
        const ay = u.a.x - shift;
        let by;
        if (u.b) {
          by = u.b.x - shift;
        } else {
          const k = ghostCount.get(u.a.data.id) ?? 0;
          ghostCount.set(u.a.data.id, k + 1);
          by = ay - (k + 1) * STACK_STEP;   // fantôme au-dessus du parent connu
          out.cards.set('ghost:' + famId, {
            id: 'ghost:' + famId, person: null, ghost: true, isRoot: false,
            cx: cardX(u.a), cy: by,
          });
        }
        if (!drawnBrackets.has(famId)) {
          drawnBrackets.add(famId);
          out.unions.push({ x1: cardX(u.a) + NODE_W / 2, y1: ay, x2: xU, y2: ay });
          out.unions.push({ x1: cardX(u.a) + NODE_W / 2, y1: by, x2: xU, y2: by });
          out.unions.push({ x1: xU, y1: Math.min(ay, by), x2: xU, y2: Math.max(ay, by) });
        }
        out.filiation.push(filiationPath(xU, (ay + by) / 2, childLeftX, childY));
      } else {
        // pas de couple identifiable : filiation directe depuis le parent
        out.filiation.push(filiationPath(cardX(n) + NODE_W / 2, n.x - shift,
                                         childLeftX, childY));
      }
    }
  }

  /** Dessine l'arbre combiné centré sur la racine donnée. */
  function update(rootId) {
    if (!rootId) return;
    currentRootId = rootId;
    gView.selectAll('*').remove();

    const rootPerson = index.getIndividual(rootId);
    if (!rootPerson) {
      gView.append('text').attr('x', 8).attr('y', 16)
        .text('Individu introuvable : ' + rootId);
      return;
    }

    const out = { cards: new Map(), unions: [], filiation: [] };

    // ---------- côté descendants ----------
    let rootDrawn = false;
    if (downGen > 0) {
      const unit = buildDownUnit(rootId, 0, new Set());
      placeDown(unit, 0, (unit.rows - 1) * STACK_STEP / 2, out);
      rootDrawn = true;
    }
    if (!rootDrawn) {
      out.cards.set(rootId + '@0,0', {
        id: rootId, person: rootPerson, ghost: false, isRoot: true,
        cx: NODE_W / 2, cy: 0,
      });
    }

    // ---------- côté ascendants ----------
    if (upGen > 0) placeUp(rootId, out);

    // ---------- rendu ----------
    gView.selectAll(null)
      .data(out.filiation)
      .join('path')
      .attr('class', 'tree-link')
      .attr('d', (d) => d);
    gView.selectAll(null)
      .data(out.unions)
      .join('line')
      .attr('class', 'spouse-link')
      .attr('x1', (d) => d.x1).attr('y1', (d) => d.y1)
      .attr('x2', (d) => d.x2).attr('y2', (d) => d.y2);

    const node = gView.selectAll(null)
      .data([...out.cards.values()], (d) => d.key)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', (d) =>
        'translate(' + (d.cx - NODE_W / 2) + ',' + (d.cy - NODE_H / 2) + ')');
    drawCards(node);

    resetView(false);   // chaque nouvelle racine recadre la vue
    log.info('Vue combinée dessinée : ' + out.cards.size + ' carte(s), ' +
      out.unions.length + ' trait(s) d\'union, ' + upGen + ' gén. ascendants, ' +
      downGen + ' gén. descendants');
  }

  log.info('Vue arbre combiné initialisée (' + upGen + '/' + downGen + ' générations)');
  return {
    update,
    getRootId: () => currentRootId,
    setGenerations: (up, down) => { upGen = up; downGen = down; update(currentRootId); },
  };
}