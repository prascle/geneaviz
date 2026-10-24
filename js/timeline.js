/**
 * timeline.js — Vue chronologique généalogique (dessin SVG ; le placement
 * est calculé par le module partagé layout.js, réutilisé tel quel par la
 * vue 3D — les deux vues ne peuvent plus diverger).
 *
 * L'axe X est le temps : chaque boîte va de la naissance au décès (tirets si
 * date estimée, flèche si vivant présumé). Le placement vertical :
 *  - descendants : couple empilé (mari au-dessus de la femme), enfants posés
 *    SOUS le couple, dans l'ordre de naissance ; chaque enfant reçoit comme
 *    plancher le haut du frère précédent (ordre préservé), puis est poussé
 *    vers le bas en cas de chevauchement temporel avec un bloc déjà posé ;
 *  - ascendants : symétrie « vue classique » — chaque couple de parents est
 *    centré sur la ligne de son enfant : le père au-dessus, la mère en
 *    dessous, récursivement (l'axe de la racine sépare les deux branches) ;
 *  - branches ajoutées (M6a) : la fratrie d'un individu (registre d'éditions)
 *    est posée sous sa ligne (solveur anti-chevauchement), conjoints inclus,
 *    avec filiation depuis le mariage de ses parents si affiché ;
 *  - liens de filiation partant de la date de mariage (sinon : naissances
 *    des parents + 25 ans), repère orange au point de mariage.
 *
 * Infobulle au survol + surbrillance de la famille + couleurs de génération
 * relatives à l'individu survolé. Réglages pilotés par la barre de vues.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';
import { PILL_BASE_COLOR } from './edits.js';
import { createFamilyLayout, TL_METRICS } from './layout.js';
import { buildTooltipHtml } from './tooltip.js';

const log = logger('timeline');

/** Dimensions du dessin (px) — le placement lui-même vit dans layout.js. */
const { rowH: ROW_H } = TL_METRICS;   // hauteur d'une ligne de vie
const MIN_BOX_W = 16;  // largeur minimale d'une boîte
const TOP_PAD = 34;    // marge haute (axe des années)
const BOTTOM_PAD = 16;
const SIDE_PAD = 24;

/**
 * Ensemble des ids de la « famille » d'un individu (surbrillance au survol).
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
    fam.children.forEach((c) => c && s.add(c));
  }
  return s;
}

/**
 * Initialise la vue chronologique généalogique.
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {Object} options.index - index applicatif
 * @param {number} [options.upGen=3] - générations d'ascendants initiales
 * @param {number} [options.downGen=3] - générations de descendants initiales
 * @param {Function} [options.onSelectPerson] - callback clic sur une boîte
 * @param {Function} [options.onContextPerson] - callback clic droit
 * @param {Function} [options.getEdits] - accès au registre d'éditions (M6)
 * @returns {{update: Function, setGenerations: Function, reset: Function}}
 */
export function initTimeline({ container, index, upGen = 3, downGen = 3, onSelectPerson, onContextPerson, getEdits }) {
  container.innerHTML = '';
  let currentRootId = null;
  const layout = createFamilyLayout({ index, getEdits, upGen, downGen });

  const svg = d3.select(container).append('svg').attr('width', '100%').attr('height', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.15, 20])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  /** Cadre courant du dessin (pour le recentrage). */
  let fitW = 0, fitH = 0;

  /** Ajuste zoom et translation pour voir toute la frise : ajustement
   *  horizontal ET vertical, contenu centré (bouton ⟲ Recentrer). */
  function fitView(animated = false) {
    if (!fitW || !fitH) return;
    const cw = container.clientWidth || 800;
    const ch = container.clientHeight || 400;
    const k = Math.min(cw / fitW, ch / fitH, 1.4);
    const t = d3.zoomIdentity.translate((cw - fitW * k) / 2, (ch - fitH * k) / 2).scale(k);
    if (animated) svg.transition().duration(350).call(zoomBeh.transform, t);
    else svg.call(zoomBeh.transform, t);
  }

  // le redimensionnement plein écran / changement de vue est piloté par
  // app.js, qui seule connaît la vue active (les sections masquées n'ont
  // pas de mise en page : getBoundingClientRect() y renvoie 0)

  // infobulle partagée avec la vue arbre
  const tipHost = document.getElementById('workspace') ?? document.body;   // visible en plein écran
  let tip = d3.select(tipHost).select('div.tree-tip');
  if (tip.empty()) tip = d3.select(tipHost).append('div').attr('class', 'tree-tip');
  // infobulle ancrée au coin bas-gauche (jamais sur le graphe)
  const positionTip = (event) => {
    const node = tip.node();
    const h = node.offsetHeight;
    tip.style('left', '12px')
       .style('top', Math.max(12, window.innerHeight - h - 12) + 'px');
  };

  /* ---------------- chaîne de parenté A→B (M9c) ---------------- */

  /** Ids des membres et paires des liens consécutifs — null = aucune. */
  let chainIds = null;
  let chainPairs = null;

  const inChain = (id) => !!chainIds && chainIds.has(id);

  /** Le lien relie-t-il deux membres consécutifs de la chaîne ? */
  function linkInChain(l) {
    if (!chainPairs || !l.ids) return false;
    for (let i = 0; i < l.ids.length; i++) {
      for (let j = i + 1; j < l.ids.length; j++) {
        const k = l.ids[i] < l.ids[j]
          ? l.ids[i] + '|' + l.ids[j] : l.ids[j] + '|' + l.ids[i];
        if (chainPairs.has(k)) return true;
      }
    }
    return false;
  }

  /** Surbrillance persistante de la chaîne (M9c) : membres et liens de
   *  la chaîne en évidence, le reste estompé. */
  function applyChain() {
    gView.selectAll('g.tl-box')
      .classed('chain', (b) => inChain(b.id))
      .classed('dim', (b) => chainIds && !inChain(b.id));
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('chain', (l) => linkInChain(l))
      .classed('dim', (l) => chainIds && !linkInChain(l));
  }

  /** Survol : famille en évidence + code couleur relatif à l'individu
   *  survolé (g0 = sa génération, g-1 = parents, g1 = enfants).
   *  (Contenu de l'infobulle : module partagé tooltip.js ; les membres
   *  de la chaîne restent en évidence, M9c.) */
  function highlightFamily(person) {
    const fam = familySet(index, person);
    const hRow = [...rowMap.values()].find((r) => r.id === person.id);
    const hGen = hRow?.gen;
    gView.selectAll('g.tl-box')
      .classed('dim', (b) => !fam.has(b.id) && !inChain(b.id))
      .classed('hl', (b) => fam.has(b.id) && b.id !== person.id);
    // couleurs de génération relatives au survolé
    gView.selectAll('g.tl-box').select('rect')
      .classed('g-1', (b) => hGen != null && b.gen === hGen - 1)
      .classed('g0',  (b) => hGen != null && b.gen === hGen)
      .classed('g1',  (b) => hGen != null && b.gen === hGen + 1);
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('dim', (l) => !(l.ids && l.ids.every((i) => fam.has(i))) && !linkInChain(l));
  }

  /** Rétablit l'opacité normale (hors chaîne persistante, M9c). */
  function clearHighlight() {
    gView.selectAll('g.tl-box')
      .classed('dim', (b) => chainIds && !inChain(b.id))
      .classed('hl', false);
    gView.selectAll('g.tl-box').select('rect').classed('g-1', false).classed('g0', false).classed('g1', false);
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('dim', (l) => chainIds && !linkInChain(l));
  }

  /* ---------------- layout partagé (layout.js) ---------------- */

  // Le placement (descendants, ascendants symétriques, solveur
  // anti-chevauchement, éditions M6a/M6b, liens) est calculé par layout.js.
  let rowMap = new Map();   // id -> ligne posée (surbrillance au survol)

  /* ---------------- dessin ---------------- */

  /** Dessine la vue chronologique pour la racine donnée. */
  function update(rootId) {
    currentRootId = rootId;
    gView.selectAll('*').remove();
    tip.style('display', 'none');
    if (!rootId || !index.getIndividual(rootId)) return;

    // ---------- layout partagé : lignes + liens + bornes ----------
    const L = layout.run(rootId);
    rowMap = L.rows;
    if (!L.allRows.length) { log.info('Frise : aucune date exploitable'); return; }
    const { minT, maxT, minY, maxY } = L.bounds;

    // ---------- échelle ----------
    const avail = Math.max(container.clientWidth || 800, 400) - 2 * SIDE_PAD;
    const pxPerYear = Math.min(14, Math.max(2.5, avail / (maxT - minT + 10)));
    const X = (t) => SIDE_PAD + (t - minT + 5) * pxPerYear;

    const offY = TOP_PAD - minY;   // décalage : tout devient positif
    const totalH = maxY - minY + TOP_PAD + BOTTOM_PAD;
    const totalW = X(maxT) + SIDE_PAD;
    fitW = totalW;
    fitH = Math.max(totalH, 80);
    // tout le contenu est décalé de offY vers le bas : les ascendants
    // symétriques ont des y négatifs (plus de contenu coupé en haut ni
    // de bande vide en bas)
    gView.attr('transform', `translate(0,${offY})`);
    // hauteur du conteneur : en fenêtre normale, plafonnée selon le contenu ;
    // en plein écran, elle est pilotée par app.js (hauteur réellement
    // disponible sous la barre de vues et le titre de section)
    if (document.fullscreenElement == null) {
      container.style.height = Math.max(Math.min(totalH, 720), 80) + 'px';
    }

    // ---------- axe des années ----------
    const span = maxT - minT;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    const ticks = [];
    for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) ticks.push(t);
    const tickSel = gView.selectAll('g.tl-tick').data(ticks).join('g')
      .attr('transform', (t) => `translate(${X(t)},0)`);
    // lignes de dates sur toute la hauteur, dates marquées en haut et en bas
    tickSel.append('line').attr('class', 'tl-grid')
      .attr('y1', 24 - offY).attr('y2', fitH - 4 - offY);
    tickSel.append('text').attr('class', 'tl-tick')
      .attr('y', 16 - offY).attr('text-anchor', 'middle').text((t) => t);
    tickSel.append('text').attr('class', 'tl-tick')
      .attr('y', fitH - 6 - offY).attr('text-anchor', 'middle').text((t) => t);

    // ---------- repères de mariage + filiations (émis par layout.js) ----------
    for (const l of L.links) {
      if (l.kind === 'marr') {
        gView.append('line').attr('class', 'tl-marry')
          .datum({ ids: l.ids })
          .attr('x1', X(l.year)).attr('y1', l.rowA.y + ROW_H / 2)
          .attr('x2', X(l.year)).attr('y2', l.rowB.y + ROW_H / 2);
      } else {
        const cy = l.childRow.y + ROW_H / 2;
        const cx = X(l.childRow.t1);
        const dy = (cy - l.yFrom) / 2;
        gView.append('path').attr('class', 'tl-link')
          .datum({ ids: l.ids })
          .attr('d', `M ${X(l.year)} ${l.yFrom} C ${X(l.year)} ${l.yFrom + dy}, ${cx} ${cy - dy}, ${cx} ${cy}`);
      }
    }

    // ---------- boîtes ----------
    const boxes = [...rowMap.values()];
    const sel = gView.selectAll('g.tl-box').data(boxes, (b) => b.id).join('g')
      .attr('class', 'tl-box')
      .attr('transform', (b) => `translate(${X(b.t1)},${b.y})`);

    sel.append('rect')
      .attr('width', (b) => Math.max(X(b.t2) - X(b.t1), MIN_BOX_W))
      .attr('height', ROW_H - 4)
      .attr('rx', 3)
      .attr('class', (b) => {
        const cls = [b.person.sex === 'M' ? 'm' : b.person.sex === 'F' ? 'f' : null];
        if (b.id === currentRootId) cls.push('root');
        if (b.est) cls.push('est');
        if (b.edited) cls.push('edit');
        if (b.alive) cls.push('alive');
        return cls.filter(Boolean).join(' ');
      });

    // pastille(s) de famille / branche (M6d) : bande verticale sur le bord
    // droit de la boîte. Styles inline obligatoires : le CSS .tl-box rect
    // écrase l'attribut fill (la pastille resterait blanche).
    sel.each(function (b) {
      const colors = b.pill ?? [PILL_BASE_COLOR];
      const g = d3.select(this);
      const w = Math.max(X(b.t2) - X(b.t1), MIN_BOX_W);
      const ph = ROW_H - 6;
      const bh = ph / colors.length;
      for (let i = 0; i < colors.length; i++) {
        g.append('rect')
          .attr('x', w - 8).attr('y', 1 + i * bh)
          .attr('width', 6).attr('height', bh)
          .attr('rx', 1.5)
          .style('fill', colors[i])
          .style('stroke', 'none')
          .style('pointer-events', 'none');
      }
    });

    sel.filter((b) => Math.max(X(b.t2) - X(b.t1), MIN_BOX_W) > 34).append('text')      .attr('x', 3).attr('y', ROW_H / 2 - 1)
      .text((b) => {
        const w = Math.max(X(b.t2) - X(b.t1), MIN_BOX_W);
        const date = ' ' + b.t1 + (b.alive ? '→' : '–' + +b.t2);
        const maxCh = Math.floor((w - 6) / 5.6);
        const name = ((b.person.name.given || '') + ' '
          + (b.person.name.surname || '?').toUpperCase()).trim();
        // nom tronqué si besoin pour laisser place aux dates
        const nameCh = Math.max(1, maxCh - date.length);
        const s = name.length > nameCh ? name.slice(0, nameCh - 1) + '…' : name;
        return s + date;
      });

    sel.on('click', (event, b) => {
      log.debug('Clic frise sur ' + b.id);
      if (onSelectPerson) onSelectPerson(b.id);
    })
      .on('pointerover', (event, b) => {
        tip.html(buildTooltipHtml(index, b.person)).style('display', 'block');
        positionTip(event);
        highlightFamily(b.person);
      })
      .on('pointermove', positionTip)
      .on('pointerout', () => { tip.style('display', 'none'); clearHighlight(); })
      .on('contextmenu', (event, b) => {
        if (onContextPerson) onContextPerson(b.person, event);
      });

    fitView(false);
    applyChain();   // chaîne A→B persistante d'un rendu à l'autre (M9c)
    log.info(`Frise chronologique : ${boxes.length} boîte(s) ` +
      `(${upGen} gén. ascendants symétriques, ${downGen} gén. descendants)`);
  }

  log.info('Vue chronologique généalogique initialisée');
  return {
    update,
    /** Racine courante (M10 : re-rendu au changement de thème si besoin). */
    getRootId: () => currentRootId,
    setGenerations: (u, d) => { upGen = u; downGen = d; layout.setGenerations(u, d); update(currentRootId); },
    reset: () => fitView(true),
    /** Définit/efface la chaîne de parenté (M9c) : ids (Set) des membres
     *  + paires « idA|idB » des liens consécutifs, null = aucune. */
    setChain: (ids, pairs) => { chainIds = ids; chainPairs = pairs; applyChain(); },
  };
}
