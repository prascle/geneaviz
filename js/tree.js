/**
 * tree.js — Vue arbre combiné ascendants/descendants (D3).
 *
 * Layout :
 *  - Ascendants (gauche) : fan-out par générations (layout d3.tree).
 *    Les deux parents d'un même enfant sont reliés par un crochet d'union
 *    (petits traits horizontaux + trait vertical) et la filiation vers
 *    l'enfant part du milieu de ce crochet. Parent inconnu → carte fantôme.
 *  - Descendants (droite) : chaque individu est affiché avec ses conjoints
 *    empilés en dessous (remariages → pile, conjoint inconnu → fantôme),
 *    reliés par un trait vertical ; les filiations partent du milieu du
 *    segment individu–conjoint.
 *  - Branches ajoutées (M6a) : la fratrie d'un individu (via le registre
 *    d'éditions) est empilée sous sa carte, conjoints inclus, avec
 *    filiation depuis l'union de ses parents si elle est affichée.
 *  - Fonds selon le sexe (bleu clair homme, rose clair femme, blanc inconnu).
 *    Dates estimées : préfixe « ≈ », cadre en tirets.
 *  - M6c : solveur de collisions unifié — après le placement (base +
 *    éditions), les cartes qui se chevauchent sont écartées verticalement,
 *    puis la géométrie de tous les liens est générée depuis les positions
 *    finales (liens logiques référençant les cartes).
 *  - Infobulle au survol (détail complet) + surbrillance de la famille
 *    (proches en évidence, reste estompé).
 *  - Réglages (générations, recentrage) pilotés par la barre de vues (app.js).
 */
import * as d3 from 'd3';
import { logger } from './logger.js';
import { siblingIds, editPillColors, PILL_BASE_COLOR } from './edits.js';

const log = logger('tree');

/** Dimensions d'une carte individu et espacements du layout (px). */
const NODE_W = 152;
const NODE_H = 44;
const GAP_Y = 16;    // espace vertical minimum entre cartes
const GAP_X = 60;    // espace horizontal entre générations
const STACK_STEP = NODE_H + GAP_Y;             // pas vertical de la pile des conjoints
const ANCESTOR_ROW = 2 * NODE_H + 2 * GAP_Y;   // espacement vertical ancêtres

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
export function buildAncestorTree(index, rootId, maxGen, seenInit = null) {
  const rootPerson = index.getIndividual(rootId);
  if (!rootPerson) return null;
  const seen = new Set([rootId]);
  if (seenInit) for (const id of seenInit) seen.add(id);
  const build = (person, gen) => {
    const node = { id: person.id, person, gen, children: [] };
    if (gen > maxGen) return node;   // la racine est gen 1 : maxGen niveaux
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
    if (gen > maxGen) return node;
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
/* Helpers                                                             */
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
 * Ensemble des ids de la « famille » d'un individu : conjoints, enfants,
 * parents, fratrie (pour la surbrillance au survol).
 * @param {Object} index - index applicatif
 * @param {Object} person - individu normalisé
 * @returns {Set<string>}
 */
function familySet(index, person) {
  const s = new Set([person.id]);
  for (const fid of person.familyAsSpouse) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    if (fam.husband) s.add(fam.husband);
    if (fam.wife) s.add(fam.wife);
    fam.children.forEach((c) => c && s.add(c));
  }
  for (const fid of person.childInFamilies) {
    const fam = index.getFamily(fid);
    if (!fam) continue;
    if (fam.husband) s.add(fam.husband);
    if (fam.wife) s.add(fam.wife);
    fam.children.forEach((c) => c && s.add(c));   // fratrie incluse
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* M6c : solveur de collisions unifié + rendu des liens logiques        */
/* ------------------------------------------------------------------ */

/**
 * Écarte verticalement les cartes qui se chevauchent, colonne par colonne.
 * Ne pousse que vers le bas : les positions de référence du layout sont
 * conservées, seules les cartes en collision glissent sous l'existant
 * (itéré jusqu'à point fixe). Remplace les mécanismes partiels d'avant
 * M6c (décalage du fan-out up, clearColumn sur la 1re colonne down).
 * @param {Object} out - {cards: Map<key, card>} (cartes modifiées en place)
 */
function solveCollisions(out) {
  const byCol = new Map();
  for (const c of out.cards.values()) {
    const k = Math.round(c.cx);
    if (!byCol.has(k)) byCol.set(k, []);
    byCol.get(k).push(c);
  }
  let moved = true, guard = 0;
  while (moved && guard++ < 200) {
    moved = false;
    for (const arr of byCol.values()) {
      arr.sort((a, b) => a.cy - b.cy);
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].cy - arr[i - 1].cy < NODE_H + GAP_Y) {
          arr[i].cy = arr[i - 1].cy + NODE_H + GAP_Y;
          moved = true;
        }
      }
    }
  }
}

/**
 * Génère la géométrie réelle des liens (traits d'union, filiations) à
 * partir des positions FINALES des cartes (après solveCollisions).
 * Spécifications logiques :
 *  - pile    : {aKey, bKey}                 trait vertical individu↔conjoint
 *  - bracket : {aKey, bKey|null}            crochet d'union de parents
 *  - fil     : {kind, aKey, bKey, childKey} filiation (bêzier)
 *  - bus     : {origin:{kind,aKey,bKey}, targetKey} bus de fratrie
 * @param {Object} out - {cards, linkSpecs}
 * @returns {{unions: Array, filiation: Array}}
 */
function renderLinks(out) {
  const cards = out.cards;
  const get = (k) => cards.get(k);
  const xUof = (a) => a.cx + NODE_W / 2 + GAP_X / 2;
  const originXY = (o) => {
    const a = get(o.aKey);
    const b = o.bKey ? get(o.bKey) : null;
    if (!a) return null;
    return {
      x: o.kind === 'bracket' ? xUof(a) : a.cx + NODE_W / 2,
      y: b ? (a.cy + b.cy) / 2 : a.cy,
    };
  };
  const unions = [], filiation = [];
  for (const s of out.linkSpecs) {
    if (s.type === 'pile') {
      const a = get(s.aKey), b = get(s.bKey);
      if (!a || !b) continue;
      unions.push({ x1: a.cx + NODE_W / 2, y1: a.cy,
                    x2: a.cx + NODE_W / 2, y2: b.cy, ids: s.ids });
    } else if (s.type === 'bracket') {
      const a = get(s.aKey);
      const b = s.bKey ? get(s.bKey) : null;
      if (!a) continue;
      const xU = xUof(a);
      unions.push({ x1: a.cx + NODE_W / 2, y1: a.cy, x2: xU, y2: a.cy, ids: s.ids });
      if (b) {
        unions.push({ x1: b.cx + NODE_W / 2, y1: b.cy, x2: xU, y2: b.cy, ids: s.ids });
        unions.push({ x1: xU, y1: a.cy, x2: xU, y2: b.cy, ids: s.ids });
      }
    } else if (s.type === 'fil') {
      const a = get(s.aKey), ch = get(s.childKey);
      const b = s.bKey ? get(s.bKey) : null;
      if (!a || !ch) continue;
      const x1 = s.kind === 'bracket' ? xUof(a) : a.cx + NODE_W / 2;
      const y1 = b ? (a.cy + b.cy) / 2 : a.cy;
      filiation.push({ d: filiationPath(x1, y1, ch.cx - NODE_W / 2, ch.cy),
                       ids: s.ids });
    } else if (s.type === 'bus') {
      const o = originXY(s.origin);
      const t = get(s.targetKey);
      if (!o || !t) continue;
      filiation.push({ d: `M ${o.x} ${o.y} L ${o.x} ${t.cy}` +
                            ` L ${t.cx - NODE_W / 2} ${t.cy}`, ids: s.ids });
    }
  }
  return { unions, filiation };
}

/* ------------------------------------------------------------------ */
/* Vue                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Initialise la vue « arbre combiné ascendants/descendants ».
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {Object} options.index - index applicatif
 * @param {number} [options.upGen=3] - générations d'ascendants initiales
 * @param {number} [options.downGen=3] - générations de descendants initiales
 * @param {Function} [options.onSelectNode] - callback clic sur un individu
 * @param {Function} [options.onContextPerson] - callback clic droit
 * @param {Function} [options.getEdits] - accès au registre d'éditions (M6)
 * @returns {{update: Function, getRootId: Function,
 *            setGenerations: Function, reset: Function}} API de la vue
 */
export function initTree({ container, index, upGen = 3, downGen = 3, onSelectNode, onContextPerson, getEdits }) {
  container.innerHTML = '';
  let currentRootId = null;
  let markEdited = false;   // cartes créées pendant une édition → hachurées
  let markPill = PILL_BASE_COLOR;   // couleur de pastille courante (édition)

  const svg = d3.select(container).append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.05, 3])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  // infobulle de survol (partagée avec la vue chronologique)
  const tipHost = document.getElementById('workspace') ?? document.body;   // visible en plein écran
  let tip = d3.select(tipHost).select('div.tree-tip');
  if (tip.empty()) tip = d3.select(tipHost).append('div').attr('class', 'tree-tip');

  /** Positionne l'infobulle : ancrée au coin bas-gauche de la fenêtre
   *  (jamais au-dessus du graphe, position stable pendant le survol). */
  function positionTip(event) {
    const node = tip.node();
    const h = node.offsetHeight;
    tip.style('left', '12px')
       .style('top', Math.max(12, window.innerHeight - h - 12) + 'px');
  }

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

  /** Contenu HTML de l'infobulle (complet : dates, unions, enfants).
   *  M8b : ligne de contexte supplémentaire (profession, lieux). */
  function buildTooltipHtml(p) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const dHtml = (d) => yearLabel(d)
      + (d.status === 'estimated' && d.estimatedFrom
          ? ` <small>(${esc(d.estimatedFrom)})</small>` : '');
    const rawKids = p.raw?.children ?? [];
    const occu = rawKids.find((c) => c.tag === 'OCCU');
    const plac = (tag) => rawKids.find((c) => c.tag === tag)
      ?.children?.find((c) => c.tag === 'PLAC')?.value;
    const short = (s) => (s ?? '').split(',')[0].trim() || null;
    const parts = [];
    if (occu?.value) parts.push(esc(occu.value));
    const b = short(plac('BIRT'));
    if (b) parts.push(`° <span title="lieu de naissance">${esc(b)}</span>`);
    const d = short(plac('DEAT'));
    if (d) parts.push(`† <span title="lieu de décès">${esc(d)}</span>`);
    const extra = parts.length ? `<div class="tip-extra">${parts.join(' · ')}</div>` : '';
    const rows = [
      `<div class="tip-name">${esc((p.name.surname || '?').toUpperCase())} ${esc(p.name.given)}</div>`,
      `<div class="tip-dates">naissance ${dHtml(p.birth)}`
        + (p.death.status === 'living' ? ' · vivant·e'
           : ` · décès ${dHtml(p.death)}`) + '</div>',
      extra,
    ];
    for (const famId of p.familyAsSpouse) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      const sid = fam.husband === p.id ? fam.wife : fam.husband;
      const sp = sid ? index.getIndividual(sid) : null;
      rows.push(`<div class="tip-fam">union : ${sp
        ? `${esc(sp.name.surname.toUpperCase())} ${esc(sp.name.given)}` : 'inconnu·e'}`
        + (fam.marriage.value ? ` — mariage ${dHtml(fam.marriage)}` : '')
        + (fam.children.length ? ` — ${fam.children.length} enfant(s)` : '') + '</div>');
    }
    rows.push(`<div class="tip-id">${esc(p.id)}</div>`);
    return rows.join('');
  }

  /** Estompe le graphe hors famille de l'individu survolé. */
  function highlightFamily(person) {
    const fam = familySet(index, person);
    gView.selectAll('g.tree-node')
      .classed('dim', (n) => !n.ghost && !fam.has(n.id))
      .classed('hl', (n) => !n.ghost && fam.has(n.id) && n.id !== person.id);
    gView.selectAll('path.tree-link').classed('dim', (l) => !l.ids.every((i) => fam.has(i)));
    gView.selectAll('line.spouse-link').classed('dim', (l) => !l.ids.every((i) => fam.has(i)));
  }

  /** Rétablit l'opacité normale. */
  function clearHighlight() {
    gView.selectAll('g.tree-node').classed('dim', false).classed('hl', false);
    gView.selectAll('path.tree-link, line.spouse-link').classed('dim', false);
  }

  /** Ajoute rect + textes + interactions à une sélection de cartes. */
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

    // cartes issues d'une édition : fond hachuré par-dessus (M6)
    sel.filter((d) => d.edited).append('rect')
      .attr('class', 'hatch')
      .attr('width', NODE_W - 2).attr('height', NODE_H - 2)
      .attr('x', 1).attr('y', 1).attr('rx', 5)
      .style('pointer-events', 'none');

    // pastille(s) de famille / branche (M6d) : bande verticale sur le bord
    // droit, une bande horizontale par couleur (pivot multi-éditions).
    // Styles inline obligatoires : le CSS .tree-node rect écrase l'attribut
    // fill (la pastille resterait blanche).
    sel.each(function (d) {
      const colors = d.pill ?? [PILL_BASE_COLOR];
      const g = d3.select(this);
      const ph = NODE_H - 10;
      const bh = ph / colors.length;
      for (let i = 0; i < colors.length; i++) {
        g.append('rect')
          .attr('x', NODE_W - 11).attr('width', 8)
          .attr('y', 5 + i * bh).attr('height', bh)
          .attr('rx', 2)
          .style('fill', colors[i])
          .style('stroke', 'none')
          .style('pointer-events', 'none');
      }
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
      })
      .on('pointerover', (event, d) => {
        tip.html(buildTooltipHtml(d.person)).style('display', 'block');
        positionTip(event);
        highlightFamily(d.person);
      })
      .on('pointermove', positionTip)
      .on('pointerout', () => {
        tip.style('display', 'none');
        clearHighlight();
      })
      .on('contextmenu', (event, d) => {
        if (onContextPerson) onContextPerson(d.person, event);
      });
  }

  /* ---------- layout descendant : individu + conjoints empilés ---------- */

  /**
   * Construit une unité descendante et mesure son sous-arbre.
   * @returns {{person: Object, rows: number, blockH: number, h: number,
   *            unions: Array<{famId, spouseId, hasRow, ghost, children: Object[]}>}}
   */
  function buildDownUnit(personId, depth, seen, maxGen = downGen) {
    const person = index.getIndividual(personId);
    const unit = { person, rows: 1, blockH: 0, h: NODE_H, unions: [] };
    if (!person || seen.has(personId) || depth >= maxGen) return unit;
    seen.add(personId);

    for (const famId of person.familyAsSpouse) {
      const fam = index.getFamily(famId);
      if (!fam) continue;
      const spouseId = fam.husband === personId ? fam.wife : fam.husband;
      const childrenIds = fam.children.filter(Boolean);
      if (!spouseId && childrenIds.length === 0) continue;

      let hasRow = false, ghost = false;
      if (spouseId && !seen.has(spouseId)) { hasRow = true; seen.add(spouseId); }
      else if (!spouseId && childrenIds.length > 0) { hasRow = true; ghost = true; }

      const children = [];
      for (const cid of childrenIds) {
        if (seen.has(cid)) continue;
        children.push(buildDownUnit(cid, depth + 1, seen, maxGen));
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
   * puis récursion sur les enfants (colonne suivante). Les liens sont
   * émis en « logique » (références aux cartes), la géométrie réelle est
   * générée après le solveur de collisions (M6c). Retourne la clé de la
   * carte de l'individu.
   */
  function placeDown(unit, xLeft, yCenter, out) {
    const nRows = unit.rows;
    const stackH = nRows * NODE_H + (nRows - 1) * GAP_Y;
    const top = yCenter - stackH / 2;
    const rowY = (r) => top + NODE_H / 2 + r * STACK_STEP;

    const key0 = unit.person.id + '@' + xLeft + ',' + Math.round(rowY(0));
    out.cards.set(key0, {
      key: key0,
      id: unit.person.id, person: unit.person, ghost: false,
      isRoot: unit.person.id === currentRootId,
      cx: xLeft + NODE_W / 2, cy: rowY(0), edited: markEdited,
      pill: [markEdited ? markPill : PILL_BASE_COLOR],
    });

    let r = 0;
    const origins = [];
    let lastRowKey = null;
    for (const u of unit.unions) {
      if (u.hasRow) {
        r++;
        let kKey;
        if (u.ghost) {
          kKey = 'ghost:' + u.famId;
          out.cards.set(kKey, {
            key: kKey,
            id: 'ghost:' + u.famId, person: null, ghost: true, isRoot: false,
            cx: xLeft + NODE_W / 2, cy: rowY(r), edited: markEdited,
            pill: [markEdited ? markPill : PILL_BASE_COLOR],
          });
        } else {
          kKey = u.spouseId + '@' + xLeft + ',' + Math.round(rowY(r));
          out.cards.set(kKey, {
            key: kKey,
            id: u.spouseId, person: index.getIndividual(u.spouseId), ghost: false,
            isRoot: false, cx: xLeft + NODE_W / 2, cy: rowY(r), edited: markEdited,
            pill: [markEdited ? markPill : PILL_BASE_COLOR],
          });
        }
        lastRowKey = kKey;
        origins.push({ union: u, bKey: kKey });
      } else {
        origins.push({ union: u, bKey: null });
      }
    }
    if (nRows > 1 && lastRowKey) {
      out.linkSpecs.push({ type: 'pile', aKey: key0, bKey: lastRowKey,
        ids: [unit.person.id,
              ...unit.unions.filter((u) => u.spouseId)
                            .map((u) => u.spouseId)] });
    }

    let acc = yCenter - unit.blockH / 2, first = true;
    for (const o of origins) {
      for (const c of o.union.children) {
        if (!first) acc += GAP_Y;
        const yc = acc + c.h / 2;
        acc += c.h; first = false;
        const xChild = xLeft + NODE_W + GAP_X;
        const cKey = placeDown(c, xChild, yc, out);
        out.linkSpecs.push({
          type: 'fil', kind: 'edge', aKey: key0, bKey: o.bKey, childKey: cKey,
          ids: [unit.person.id, o.union.spouseId, c.person.id].filter(Boolean) });
      }
    }
    return key0;
  }

  /* ---------- layout ascendant : d3.tree + crochets d'union ---------- */

  /**
   * Dessine le côté ascendant : fan-out d3.tree, crochets de couple entre
   * co-parents d'un même enfant, fantôme si parent inconnu, filiation
   * partant du milieu du crochet. L'origine de chaque filiation est
   * mémorisée (out.filiationOrigin) pour les branches ajoutées (M6).
   */
  function placeUp(rootId, out, anchor = null, maxGen = upGen, shownIds = null, dy = 0, anchorKey = null) {
    const rootCx = anchor ? anchor.cx : NODE_W / 2;
    const rootCy = anchor ? anchor.cy : 0;
    const data = buildAncestorTree(index, rootId, maxGen, shownIds);
    if (!data || !data.children.length) return;

    const h = d3.hierarchy(data, (d) => d.children);
    d3.tree().nodeSize([ANCESTOR_ROW, NODE_W + GAP_X])(h);
    const nodes = h.descendants();
    const rootNode = nodes[0];
    const shift = rootNode.x;
    const cardX = (n) => rootCx - n.y;
    const Y = (n) => n.x - shift + rootCy + dy;
    const byId = new Map();
    for (const n of nodes) if (n.depth > 0) byId.set(n.data.id, n);

    for (const n of nodes) {
      if (n.depth === 0) continue;
      const k = n.data.id + '@a';
      out.cards.set(k, {
        key: k,
        id: n.data.id, person: n.data.person, ghost: false, isRoot: false,
        cx: cardX(n), cy: Y(n), edited: markEdited,
        pill: [markEdited ? markPill : PILL_BASE_COLOR],
      });
    }

    const ancUnions = new Map();
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
        } else {
          ancUnions.set(famId, { a: n, b: null });
        }
      }
    }

    const drawnEdges = new Set();
    const drawnBrackets = new Set();
    const ghostCount = new Map();
    for (const n of nodes) {
      if (n.depth === 0) continue;
      const childNode = n.parent;
      const child = childNode.data.person;
      let famId = null;
      for (const fid of child.childInFamilies) {
        const fam = index.getFamily(fid);
        if (fam && (fam.husband === n.data.id || fam.wife === n.data.id)) { famId = fid; break; }
      }
      const childKey = childNode.depth === 0
        ? anchorKey : childNode.data.id + '@a';

      const u = famId != null ? ancUnions.get(famId) : null;
      if (u) {
        const edgeKey = 'u:' + famId + ':' + child.id;
        if (drawnEdges.has(edgeKey)) continue;
        drawnEdges.add(edgeKey);

        const aKey = u.a.data.id + '@a';
        const ay = Y(u.a);
        let by;
        let bKey = null;
        if (u.b) {
          by = Y(u.b);
          bKey = u.b.data.id + '@a';
        } else {
          const fam2 = index.getFamily(famId);
          const other = fam2 ? (fam2.husband === u.a.data.id ? fam2.wife : fam2.husband) : null;
          if (other && shownIds && shownIds.has(other)) {
            by = ay;   // déjà affiché ailleurs : ni fantôme ni crochet vertical
          } else {
            const k = ghostCount.get(u.a.data.id) ?? 0;
            ghostCount.set(u.a.data.id, k + 1);
            by = ay - (k + 1) * STACK_STEP;
            bKey = 'ghost:' + famId;
            out.cards.set(bKey, {
              key: bKey,
              id: 'ghost:' + famId, person: null, ghost: true, isRoot: false,
              cx: cardX(u.a), cy: by, edited: markEdited,
              pill: [markEdited ? markPill : PILL_BASE_COLOR],
            });
          }
        }
        if (!drawnBrackets.has(famId)) {
          drawnBrackets.add(famId);
          const ids = [u.a.data.id, u.b ? u.b.data.id : null].filter(Boolean);
          out.linkSpecs.push({ type: 'bracket', aKey, bKey, ids });
        }
        out.linkSpecs.push({ type: 'fil', kind: 'bracket', aKey, bKey, childKey,
                             ids: [u.a.data.id, u.b ? u.b.data.id : null, childNode.data.id]
                               .filter(Boolean) });
        out.filiationOrigin.set(childNode.data.id, { kind: 'bracket', aKey, bKey });
      } else {
        const nKey = n.data.id + '@a';
        out.linkSpecs.push({ type: 'fil', kind: 'edge', aKey: nKey, bKey: null,
                             childKey, ids: [n.data.id, childNode.data.id] });
        out.filiationOrigin.set(childNode.data.id,
                                { kind: 'edge', aKey: nKey, bKey: null });
      }
    }
  }

  /** Dessine l'arbre combiné centré sur la racine donnée. */
  function update(rootId) {
    if (!rootId) return;
    currentRootId = rootId;
    tip.style('display', 'none');
    gView.selectAll('*').remove();

    // motif de hachures pour les cartes issues d'une édition (M6)
    gView.append('defs').append('pattern')
      .attr('id', 'hatchEdit')
      .attr('width', 6).attr('height', 6)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('patternTransform', 'rotate(45)')
      .append('line')
      .attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
      .attr('stroke', '#94a3b8').attr('stroke-width', 1.5);

    const rootPerson = index.getIndividual(rootId);
    if (!rootPerson) {
      gView.append('text').attr('x', 8).attr('y', 16)
        .text('Individu introuvable : ' + rootId);
      return;
    }

    const out = { cards: new Map(), linkSpecs: [], filiationOrigin: new Map() };

    let rootDrawn = false;
    let rootKey = null;
    if (downGen > 0) {
      const unit = buildDownUnit(rootId, 0, new Set());
      rootKey = placeDown(unit, 0, (unit.rows - 1) * STACK_STEP / 2, out);
      rootDrawn = true;
    }
    if (!rootDrawn) {
      rootKey = rootId + '@0,0';
      out.cards.set(rootKey, {
        key: rootKey,
        id: rootId, person: rootPerson, ghost: false, isRoot: true,
        cx: NODE_W / 2, cy: 0, pill: [PILL_BASE_COLOR],
      });
    }
    if (upGen > 0) placeUp(rootId, out, null, upGen, null, 0, rootKey);

    /** Mini-solveur : cy d'une nouvelle carte dans la colonne cx,
     *  en partant du haut topY et en repoussant sous chaque carte
     *  existante qui la chevaucherait (marge GAP_Y). */
    const nextCy = (cx, topY) => {
      let top = topY;
      let changed = true;
      while (changed) {
        changed = false;
        for (const c of out.cards.values()) {
          if (Math.abs(c.cx - cx) >= 1) continue;
          if (top < c.cy + NODE_H / 2 + GAP_Y
              && c.cy - NODE_H / 2 < top + NODE_H + GAP_Y) {
            top = c.cy + NODE_H / 2 + GAP_Y;
            changed = true;
          }
        }
      }
      return top + NODE_H / 2;
    };

    // (M6c) plus besoin de clearColumn : le solveur de collisions unifié
    // écarte toutes les cartes après le placement, toutes passes confondues.

    // couleurs de pastille (M6d) : base = bleu, une couleur vive par pivot
    const pillOf = editPillColors(getEdits ? getEdits() : []);
    /** Empile une bande de couleur sur la pastille d'une carte existante. */
    const addPillBand = (card, color) => {
      if (card && !card.pill.includes(color)) card.pill.push(color);
    };

    // ---------- branches ajoutées (M6a/M6b) : passes jusqu'à point fixe ----------
    // Une édition peut porter sur un individu introduit par une autre édition
    // (récursivité : fratrie d'un ascendant ajouté, descendants d'un membre
    // d'une fratrie ajoutée...). On traite les éditions en passes : chaque
    // édition devient traitée quand son pivot est affiché, jusqu'à ce qu'une
    // passe n'aboutisse plus — l'ordre des clics devient indifférent.
    // Dans chaque passe : up/down d'abord, fratrie ensuite (la fratrie d'un
    // ascendant venant d'être ajouté est ainsi traitée dans la même passe).
    for (const e of (getEdits ? getEdits() : [])) e._done = false;
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;

      // ---------- ascendants / descendants (M6b) ----------
      for (const e of (getEdits ? getEdits() : [])) {
        if ((e.type !== 'up' && e.type !== 'down') || e._done) continue;
        const pivotCard = [...out.cards.values()].find((c) => c.id === e.pivot);
        if (!pivotCard) continue;
        const shownIds = new Set([...out.cards.values()].map((c) => c.id));
        if (e.type === 'up') {
          // ascendants du pivot : fan-out dans les colonnes à gauche.
          // Le fan-out d3.tree ignore les cartes déjà présentes : on
          // simule le groupe pour calculer un décalage vertical sans
          // collision, puis on le dessine décalé.
          let dy = 0;
          const sim = buildAncestorTree(index, e.pivot, e.depth, shownIds);
          if (sim && sim.children.length) {
            const hh = d3.hierarchy(sim, (d) => d.children);
            d3.tree().nodeSize([ANCESTOR_ROW, NODE_W + GAP_X])(hh);
            const simNodes = hh.descendants();
            const simShift = simNodes[0].x;
            const existing = [...out.cards.values()];
            let guard = 0;
            for (;;) {
              let need = 0;
              for (const n of simNodes) {
                if (n.depth === 0) continue;
                const cx = pivotCard.cx - n.y;
                const cy = n.x - simShift + pivotCard.cy + dy;
                for (const c of existing) {
                  if (Math.abs(c.cx - cx) >= 1) continue;
                  if (Math.abs(c.cy - cy) < NODE_H + GAP_Y) {
                    need = Math.max(need, c.cy + NODE_H / 2 + GAP_Y - (cy - NODE_H / 2));
                  }
                }
              }
              if (need <= 0 || guard++ > 50) break;
              dy += need;
            }
          }
          markEdited = true;
          markPill = pillOf(e.pivot);
          placeUp(e.pivot, out, { cx: pivotCard.cx, cy: pivotCard.cy }, e.depth,
                  shownIds, dy, pivotCard.key);
          addPillBand(pivotCard, markPill);
          markEdited = false;
          markPill = PILL_BASE_COLOR;
        } else {
          // descendants du pivot : nouveaux conjoints empilés sous sa pile,
          // enfants dans les colonnes à droite (profondeur e.depth)
          const seen = new Set(shownIds);
          seen.delete(e.pivot);
          const unit = buildDownUnit(e.pivot, 0, seen, e.depth);
          // bas de la pile contiguë du pivot
          const col = [...out.cards.values()]
            .filter((c) => c.cx === pivotCard.cx && c.cy >= pivotCard.cy)
            .sort((a, b) => a.cy - b.cy);
          let bottom = pivotCard.cy + NODE_H / 2;
          for (const c of col) {
            if (c.cy - NODE_H / 2 <= bottom + GAP_Y + 1) bottom = Math.max(bottom, c.cy + NODE_H / 2);
            else break;
          }
          markEdited = true;
          markPill = pillOf(e.pivot);
          const spouseCys = [];
          let sy = bottom + GAP_Y;
          for (const u of unit.unions) {
            if (!u.hasRow) continue;
            const cy = nextCy(pivotCard.cx, sy);
            sy = cy + NODE_H / 2 + GAP_Y;
            let sKey;
            if (u.ghost) {
              sKey = 'ghost:' + u.famId;
              out.cards.set(sKey, { key: sKey, id: 'ghost:' + u.famId, person: null,
                ghost: true, isRoot: false, cx: pivotCard.cx, cy, edited: true,
                pill: [markPill] });
            } else {
              sKey = u.spouseId + '@sib';
              out.cards.set(sKey, { key: sKey, id: u.spouseId,
                person: index.getIndividual(u.spouseId), ghost: false, isRoot: false,
                cx: pivotCard.cx, cy, edited: true, pill: [markPill] });
            }
            spouseCys.push({ u, cy, key: sKey });
          }
          if (spouseCys.length) {
            out.linkSpecs.push({
              type: 'pile', aKey: pivotCard.key,
              bKey: spouseCys[spouseCys.length - 1].key,
              ids: [e.pivot,
                    ...spouseCys.map((s) => s.u.spouseId).filter(Boolean)] });
          }
          // enfants : à droite, empilés vers le bas depuis la hauteur du pivot
          // (le solveur M6c écarte ensuite ce qui chevauche l'existant)
          let cursorY = pivotCard.cy;
          const xChild = pivotCard.cx + NODE_W / 2 + GAP_X;
          for (const o of spouseCys) {
            for (const c of o.u.children) {
              const yc = cursorY + c.h / 2;
              cursorY = yc + c.h / 2 + GAP_Y;
              const cKey = placeDown(c, xChild, yc, out);
              out.linkSpecs.push({
                type: 'fil', kind: 'edge', aKey: pivotCard.key, bKey: o.key,
                childKey: cKey,
                ids: [e.pivot, o.u.spouseId, c.person.id].filter(Boolean) });
            }
          }
          // unions sans ligne de conjoint mais avec enfants
          for (const u of unit.unions) {
            if (u.hasRow) continue;
            for (const c of u.children) {
              const yc = cursorY + c.h / 2;
              cursorY = yc + c.h / 2 + GAP_Y;
              const cKey = placeDown(c, xChild, yc, out);
              out.linkSpecs.push({
                type: 'fil', kind: 'edge', aKey: pivotCard.key, bKey: null,
                childKey: cKey,
                ids: [e.pivot, u.spouseId, c.person.id].filter(Boolean) });
            }
          }
          addPillBand(pivotCard, markPill);
          markEdited = false;
          markPill = PILL_BASE_COLOR;
        }
        e._done = true; changed = true;
      }

      // ---------- fratrie (M6a) ----------
      // L'ajout d'une fratrie inclut les parents du pivot s'ils ne sont pas
      // déjà affichés ; ils sont placés dans la colonne de GAUCHE (côté
      // ascendants), la fratrie sous la pile contiguë du pivot, chaque carte
      // repoussée par un mini-solveur sous les cartes déjà présentes de sa
      // colonne (pas de chevauchement avec les cousins existants).
      for (const e of (getEdits ? getEdits() : [])) {
        if (e.type !== 'siblings' || e._done) continue;
        const pivotCard = [...out.cards.values()].find((c) => c.id === e.pivot);
        if (!pivotCard) continue;
        const shown = new Set([...out.cards.values()].map((c) => c.id));
        const sibs = siblingIds(index, e.pivot).filter((k) => !shown.has(k));
        if (!sibs.length) { e._done = true; changed = true; continue; }
        markPill = pillOf(e.pivot);
        addPillBand(pivotCard, markPill);

        const parentCx = pivotCard.cx - (NODE_W + GAP_X);  // colonne de gauche

        // bas de la pile contiguë du pivot (carte + conjoints empilés)
        const col = [...out.cards.values()]
          .filter((c) => c.cx === pivotCard.cx && c.cy >= pivotCard.cy)
          .sort((a, b) => a.cy - b.cy);
        let bottom = pivotCard.cy + NODE_H / 2;
        for (const c of col) {
          if (c.cy - NODE_H / 2 <= bottom + GAP_Y + 1) bottom = Math.max(bottom, c.cy + NODE_H / 2);
          else break;
        }

        // parents du pivot : crochet existant s'ils sont déjà affichés,
        // sinon ajoutés dans la colonne de gauche, alignés sur le pivot
        let origin = out.filiationOrigin.get(e.pivot) ?? null;
        let originNew = false;
        if (!origin) {
          const piv = index.getIndividual(e.pivot);
          for (const fid of piv.childInFamilies) {
            const fam = index.getFamily(fid);
            if (!fam) continue;
            const parRows = [];
            let top = pivotCard.cy - NODE_H / 2;   // départ : hauteur du pivot
            for (const id of [fam.husband, fam.wife]) {
              if (!id || shown.has(id) || !index.getIndividual(id)) continue;
              const cy = nextCy(parentCx, top);
              top = cy + NODE_H / 2 + GAP_Y;
              shown.add(id);
              const pk = id + '@sib';
              out.cards.set(pk, {
                key: pk, id, person: index.getIndividual(id), ghost: false,
                isRoot: false, cx: parentCx, cy, edited: true, pill: [markPill],
              });
              parRows.push({ id, cy, key: pk });
            }
            if (!parRows.length) continue;
            origin = { kind: 'bracket', aKey: parRows[0].key,
                       bKey: parRows.length === 2 ? parRows[1].key : null };
            // crochet d'union étendu jusqu'au bus de filiation (comme dans
            // placeUp) : sinon le bus des enfants reste déconnecté des parents
            out.linkSpecs.push({ type: 'bracket', aKey: origin.aKey,
                                 bKey: origin.bKey,
                                 ids: parRows.map((r) => r.id) });
            originNew = true;
            break;
          }
          // parents introuvables : fratrie ajoutée sans bus de filiation
        }

        // fratrie : cartes sous le pivot (mini-solveur anti-chevauchement),
        // conjoints empilés dessous, bus vertical depuis l'union des parents
        let cursorY = bottom + GAP_Y;
        for (const k of sibs) {
          const kp = index.getIndividual(k);
          const kcy = nextCy(pivotCard.cx, cursorY);
          cursorY = kcy + NODE_H / 2 + GAP_Y;
          const kk = k + '@sib';
          out.cards.set(kk, {
            key: kk, id: k, person: kp, ghost: false, isRoot: false,
            cx: pivotCard.cx, cy: kcy, edited: true, pill: [markPill],
          });
          if (origin) {
            out.linkSpecs.push({ type: 'bus', origin, targetKey: kk, ids: [k] });
          }
          let sy = cursorY;
          for (const sfid of kp.familyAsSpouse) {
            const sf = index.getFamily(sfid);
            if (!sf) continue;
            const sid = sf.husband === k ? sf.wife : sf.husband;
            if (!sid || !index.getIndividual(sid) || shown.has(sid)) continue;
            const scy = nextCy(pivotCard.cx, sy);
            sy = scy + NODE_H / 2 + GAP_Y;
            shown.add(sid);
            const sk = sid + '@sib';
            out.cards.set(sk, {
              key: sk, id: sid, person: index.getIndividual(sid), ghost: false,
              isRoot: false, cx: pivotCard.cx, cy: scy, edited: true,
              pill: [markPill],
            });
            out.linkSpecs.push({ type: 'pile', aKey: kk, bKey: sk, ids: [k, sid] });
          }
          cursorY = sy + GAP_Y;
        }

        // parents nouvellement ajoutés : bus vers le pivot aussi
        if (origin && originNew) {
          out.linkSpecs.push({ type: 'bus', origin, targetKey: pivotCard.key,
                               ids: [e.pivot] });
        }
        markPill = PILL_BASE_COLOR;
        e._done = true; changed = true;
      }

      if (!changed) break;
    }

    // ---------- M6c : solveur de collisions + géométrie des liens ----------
    // Toutes les cartes sont posées (base + éditions) : on écarte celles
    // qui se chevauchent, puis on génère les traits depuis les positions
    // finales (les liens logiques suivent leurs cartes).
    solveCollisions(out);
    const { unions, filiation } = renderLinks(out);

    gView.selectAll(null)
      .data(filiation)
      .join('path')
      .attr('class', 'tree-link')
      .attr('d', (d) => d.d);
    gView.selectAll(null)
      .data(unions)
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

    resetView(false);
    log.info('Vue combinée dessinée : ' + out.cards.size + ' carte(s), ' +
      unions.length + ' trait(s) d\'union, ' + upGen + ' gén. ascendants, ' +
      downGen + ' gén. descendants');
  }

  log.info('Vue arbre combiné initialisée (' + upGen + '/' + downGen + ' générations)');
  return {
    update,
    getRootId: () => currentRootId,
    setGenerations: (up, down) => { upGen = up; downGen = down; update(currentRootId); },
    reset: () => resetView(true),
  };
}
