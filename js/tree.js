/**
 * tree.js — Jalon M4 : vue combinée ascendants/descendants (D3).
 *
 * Layout généalogique dédié : chaque individu est affiché avec ses conjoints
 * empilés verticalement (remariages), les liens de filiation partant du
 * milieu du lien d'union du couple. Conjoint ou parent inconnu → carte
 * fantôme, pour que la filiation parte toujours d'un couple.
 *
 * Ascendants à gauche, descendants à droite de la racine (profondeurs
 * réglables indépendamment). Zoom molette, glisser-déplacer, bouton
 * « Recentrer » pour rétablir la vue.
 *
 * Fonds selon le sexe : bleu clair (homme), rose clair (femme), blanc
 * (inconnu). Dates estimées : préfixe « ≈ », cadre en tirets.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';

const log = logger('tree');

/** Dimensions d'une carte individu et espacements du layout (px). */
const NODE_W = 152;
const NODE_H = 44;
const GAP_Y = 16;     // espace vertical minimum entre cartes
const GAP_X = 60;     // espace horizontal entre générations
const SPOUSE_DX = 24; // espace entre deux conjoints d'un couple
const COUPLE_W = 2 * NODE_W + SPOUSE_DX;

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
/* Layout descendant : individu + unions empilées                      */
/* ------------------------------------------------------------------ */

/**
 * Unions d'un individu : conjoint et enfants par famille.
 * @returns {Array<{famId: string, spouseId: string|null,
 *                   children: string[]}>}
 */
function unionsOf(index, person) {
  const out = [];
  for (const famId of person.familyAsSpouse) {
    const fam = index.getFamily(famId);
    if (!fam) continue;
    const spouseId = fam.husband === person.id ? fam.wife : fam.husband;
    const children = fam.children.filter(Boolean);
    if (spouseId || children.length) out.push({ famId, spouseId, children });
  }
  return out;
}

/**
 * Construit l'unité de layout descendant (mesure récursive des hauteurs).
 * @returns {{person: Object|null, h: number,
 *            unions: Array<{famId, spouseId, ghost, children: Object[]}>}}
 */
function buildDownUnit(index, personId, depth, downGen, seen) {
  const person = index.getIndividual(personId);
  const unit = { person, h: NODE_H, unions: [] };
  if (!person || seen.has(personId) || depth >= downGen) return unit;
  seen.add(personId);

  for (const u of unionsOf(index, person)) {
    const children = [];
    for (const cid of u.children) {
      if (seen.has(cid)) continue;
      children.push(buildDownUnit(index, cid, depth + 1, downGen, seen));
    }
    unit.unions.push({
      famId: u.famId, spouseId: u.spouseId,
      ghost: !u.spouseId && children.length > 0,   // conjoint inconnu
      children,
    });
  }

  const nU = unit.unions.length;
  const stackH = nU ? nU * NODE_H + (nU - 1) * GAP_Y : NODE_H;
  let blockH = 0, first = true;
  for (const u of unit.unions) {
    for (const c of u.children) { blockH += (first ? 0 : GAP_Y) + c.h; first = false; }
  }
  unit.h = Math.max(NODE_H, stackH, blockH);
  return unit;
}

/** Hauteur du bloc enfants d'une unité (recalculée à l'identique du build). */
function childrenBlockH(unit) {
  let h = 0, first = true;
  for (const u of unit.unions) {
    for (const c of u.children) { h += (first ? 0 : GAP_Y) + c.h; first = false; }
  }
  return h;
}

/* ------------------------------------------------------------------ */
/* Layout ascendant : individu + couples de parents                    */
/* ------------------------------------------------------------------ */

/**
 * Construit l'unité de layout ascendant.
 * @returns {{person: Object|null, h: number,
 *            fams: Array<{famId, hUnit, wUnit, ghostH, ghostW, bandH}>}}
 */
function buildUpUnit(index, personId, depth, upGen, seen) {
  const person = index.getIndividual(personId);
  const unit = { person, h: NODE_H, fams: [] };
  if (!person || seen.has(personId) || depth >= upGen) return unit;
  seen.add(personId);

  for (const famId of person.childInFamilies) {
    const fam = index.getFamily(famId);
    if (!fam || (!fam.husband && !fam.wife)) continue;
    const hUnit = fam.husband && !seen.has(fam.husband)
      ? buildUpUnit(index, fam.husband, depth + 1, upGen, seen) : null;
    const wUnit = fam.wife && !seen.has(fam.wife)
      ? buildUpUnit(index, fam.wife, depth + 1, upGen, seen) : null;
    unit.fams.push({
      famId, hUnit, wUnit,
      ghostH: !fam.husband, ghostW: !fam.wife,
      bandH: Math.max(hUnit ? hUnit.h : NODE_H, wUnit ? wUnit.h : NODE_H),
    });
  }

  let famsH = 0;
  unit.fams.forEach((f, i) => { famsH += (i ? GAP_Y : 0) + f.bandH; });
  unit.h = Math.max(NODE_H, famsH);
  return unit;
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

/** Classe CSS de fond selon le sexe. */
function sexClass(person) {
  return person.sex === 'M' ? 'm' : person.sex === 'F' ? 'f' : null;
}

/** Courbe de filiation (bezier horizontale, dans les deux sens). */
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

  /** Rétablit la vue initiale (recentrage / remise à l'échelle). */
  function resetView(animated = true) {
    const t = d3.zoomIdentity.translate(24, container.clientHeight / 2);
    if (animated) {
      svg.transition().duration(350).call(zoomBeh.transform, t);
    } else {
      svg.call(zoomBeh.transform, t);
    }
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

  /* ---------- placement descendant ---------- */

  /**
   * Place une unité descendante et son sous-arbre.
   * @param {Object} unit - sortie de buildDownUnit
   * @param {number} xUnit - bord gauche de la carte de l'individu
   * @param {number} yc - centre vertical alloué à l'unité
   */
  function placeDown(unit, xUnit, yc, out) {
    out.cards.push({ id: unit.person.id, key: unit.person.id + '@' + xUnit + ',' + yc,
                     person: unit.person, ghost: false,
                     isRoot: unit.person.id === currentRootId,
                     cx: xUnit + NODE_W / 2, cy: yc });

    const nU = unit.unions.length;
    const mids = [];   // {x, y} point d'union de chaque mariage
    unit.unions.forEach((u, k) => {
      const spY = yc + (k - (nU - 1) / 2) * (NODE_H + GAP_Y);
      const spX = xUnit + NODE_W + SPOUSE_DX;
      let hasCard = false;
      if (u.ghost) {
        out.cards.push({ id: 'ghost:' + u.famId, key: 'ghost:' + u.famId + '@' + spX + ',' + spY,
                         person: null, ghost: true, isRoot: false, cx: spX + NODE_W / 2, cy: spY });
        hasCard = true;
      } else if (u.spouseId) {
        const sp = index.getIndividual(u.spouseId);
        if (sp && !out.displayed.has(u.spouseId)) {
          out.displayed.add(u.spouseId);
          out.cards.push({ id: u.spouseId, key: u.spouseId + '@' + spX + ',' + spY,
                           person: sp, ghost: false, isRoot: false,
                           cx: spX + NODE_W / 2, cy: spY });
          hasCard = true;
        }
      }
      if (hasCard) {
        out.spouseLinks.push({ x1: xUnit + NODE_W, y1: yc, x2: spX, y2: spY });
        mids.push({ x: xUnit + NODE_W + SPOUSE_DX / 2, y: (yc + spY) / 2 });
      } else {
        mids.push({ x: xUnit + NODE_W, y: yc });   // pas de carte conjoint
      }
    });

    // enfants de toutes les unions, empilés et centrés sur l'individu
    const blockH = childrenBlockH(unit);
    let acc = yc - blockH / 2, first = true, ui = 0;
    for (const u of unit.unions) {
      for (const c of u.children) {
        if (!first) acc += GAP_Y;
        const ycc = acc + c.h / 2;
        acc += c.h; first = false;
        const mid = mids[ui];
        const xChild = xUnit + COUPLE_W + GAP_X;
        out.filiation.push({ d: filiationPath(mid.x, mid.y, xChild, ycc) });
        placeDown(c, xChild, ycc, out);
      }
      ui++;
    }
  }

  /* ---------- placement ascendant ---------- */

  /**
   * Place une unité ascendante et ses parents.
   * @param {number} depth - profondeur (0 = racine)
   */
  function placeUp(unit, xUnit, yc, depth, out) {
    out.cards.push({ id: unit.person.id, key: unit.person.id + '@' + xUnit + ',' + yc,
                     person: unit.person, ghost: false,
                     isRoot: unit.person.id === currentRootId,
                     cx: xUnit + NODE_W / 2, cy: yc });

    if (depth >= upGen || !unit.fams.length) return;

    // couples de parents empilés, centrés sur l'individu
    let blockH = 0;
    unit.fams.forEach((f, i) => { blockH += (i ? GAP_Y : 0) + f.bandH; });
    let acc = yc - blockH / 2;
    for (const f of unit.fams) {
      acc += GAP_Y;                      // écarts : acc était pré-décalé
      acc -= GAP_Y;                      // (premier couple sans décalage)
    }
    acc = yc - blockH / 2;
    let i = 0;
    for (const f of unit.fams) {
      if (i++) acc += GAP_Y;
      const yb = acc + f.bandH / 2;
      acc += f.bandH;

      const xH = xUnit - COUPLE_W - GAP_X;          // bord gauche carte mari
      const xW = xH + NODE_W + SPOUSE_DX;           // bord gauche carte femme

      // cartes des parents (fantôme si inconnu)
      if (f.hUnit) placeUp(f.hUnit, xH, yb, depth + 1, out);
      else if (f.ghostH) out.cards.push({ id: 'ghost:' + f.famId + ':H',
        key: 'ghost:' + f.famId + ':H@' + xH + ',' + yb, person: null, ghost: true,
        isRoot: false, cx: xH + NODE_W / 2, cy: yb });
      if (f.wUnit) placeUp(f.wUnit, xW, yb, depth + 1, out);
      else if (f.ghostW) out.cards.push({ id: 'ghost:' + f.famId + ':W',
        key: 'ghost:' + f.famId + ':W@' + xW + ',' + yb, person: null, ghost: true,
        isRoot: false, cx: xW + NODE_W / 2, cy: yb });

      // lien d'union et point de départ de la filiation
      out.spouseLinks.push({ x1: xH + NODE_W, y1: yb, x2: xW, y2: yb });
      const mid = { x: xH + NODE_W + SPOUSE_DX / 2, y: yb };
      out.filiation.push({ d: filiationPath(xUnit, yc, mid.x, mid.y) });
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

    const out = { cards: [], spouseLinks: [], filiation: [], displayed: new Set([rootId]) };

    if (upGen > 0) {
      const upUnit = buildUpUnit(index, rootId, 0, upGen, new Set([rootId]));
      placeUp(upUnit, 0, 0, 0, out);
    } else {
      out.cards.push({ id: rootId, key: rootId + '@0,0', person: rootPerson,
                       ghost: false, isRoot: true, cx: NODE_W / 2, cy: 0 });
    }
    if (downGen > 0) {
      const downUnit = buildDownUnit(index, rootId, 0, downGen, new Set([rootId]));
      placeDown(downUnit, 0, 0, out);
    } else if (!out.cards.some((c) => c.key === rootId + '@0,0')) {
      out.cards.push({ id: rootId, key: rootId + '@0,0', person: rootPerson,
                       ghost: false, isRoot: true, cx: NODE_W / 2, cy: 0 });
    }

    // dédoublonnage (la racine peut être poussée par les deux côtés)
    const byKey = new Map();
    for (const c of out.cards) if (!byKey.has(c.key)) byKey.set(c.key, c);

    // liens de filiation puis d'union
    gView.selectAll(null)
      .data(out.filiation)
      .join('path')
      .attr('class', 'tree-link')
      .attr('d', (d) => d.d);
    gView.selectAll(null)
      .data(out.spouseLinks)
      .join('line')
      .attr('class', 'spouse-link')
      .attr('x1', (d) => d.x1).attr('y1', (d) => d.y1)
      .attr('x2', (d) => d.x2).attr('y2', (d) => d.y2);

    const node = gView.selectAll(null)
      .data([...byKey.values()], (d) => d.key)
      .join('g')
      .attr('class', 'tree-node')
      .attr('transform', (d) =>
        'translate(' + (d.cx - NODE_W / 2) + ',' + (d.cy - NODE_H / 2) + ')');
    drawCards(node);

    resetView(false);   // chaque nouvelle racine recentre la vue
    log.info('Vue combinée dessinée : ' + byKey.size + ' carte(s), ' +
      upGen + ' gén. ascendants, ' + downGen + ' gén. descendants');
  }

  log.info('Vue arbre combiné initialisée (' + upGen + '/' + downGen + ' générations)');
  return {
    update,
    getRootId: () => currentRootId,
    setGenerations: (up, down) => { upGen = up; downGen = down; update(currentRootId); },
  };
}