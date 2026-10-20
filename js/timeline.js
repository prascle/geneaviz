/**
 * timeline.js — Vue chronologique généalogique (layout récursif par familles).
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
import { siblingIds } from './edits.js';

const log = logger('timeline');

/** Dimensions du layout (px). */
const ROW_H = 18;      // hauteur d'une ligne de vie
const GAP_ROW = 4;     // écart vertical entre les lignes d'un couple
const BAND_GAP = 26;   // écart entre un couple et ses enfants
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

  const svg = d3.select(container).append('svg').attr('width', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.15, 20])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  // recalcul de la hauteur en entrée/sortie du plein écran
  document.addEventListener('fullscreenchange', () => {
    if (currentRootId) update(currentRootId);
  });

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

  /** Contenu HTML de l'infobulle (complet : dates, unions, enfants). */
  function buildTooltipHtml(p) {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const dHtml = (d) => {
      if (!d.value) return d.status === 'living' ? 'vivant·e' : '—';
      return (d.status === 'estimated' ? '≈ ' : '') + d.value.year
        + (d.estimatedFrom ? ` <small>(${esc(d.estimatedFrom)})</small>` : '');
    };
    const rows = [
      `<div class="tip-name">${esc((p.name.surname || '?').toUpperCase())} ${esc(p.name.given)}</div>`,
      `<div class="tip-dates">naissance ${dHtml(p.birth)}`
        + (p.death.status === 'living' ? ' · vivant·e'
           : ` · décès ${dHtml(p.death)}`) + '</div>',
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

  /** Survol : famille en évidence + code couleur relatif à l'individu
   *  survolé (g0 = sa génération, g-1 = parents, g1 = enfants). */
  function highlightFamily(person) {
    const fam = familySet(index, person);
    const hRow = [...rowMap.values()].find((r) => r.id === person.id);
    const hGen = hRow?.gen;
    gView.selectAll('g.tl-box')
      .classed('dim', (b) => !fam.has(b.id))
      .classed('hl', (b) => fam.has(b.id) && b.id !== person.id);
    // couleurs de génération relatives au survolé
    gView.selectAll('g.tl-box').select('rect')
      .classed('g-1', (b) => hGen != null && b.gen === hGen - 1)
      .classed('g0',  (b) => hGen != null && b.gen === hGen)
      .classed('g1',  (b) => hGen != null && b.gen === hGen + 1);
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('dim', (l) => !(l.ids && l.ids.every((i) => fam.has(i))));
  }

  /** Rétablit l'opacité normale. */
  function clearHighlight() {
    gView.selectAll('g.tl-box').classed('dim', false).classed('hl', false);
    gView.selectAll('g.tl-box').select('rect').classed('g-1', false).classed('g0', false).classed('g1', false);
    gView.selectAll('path.tl-link, line.tl-marry').classed('dim', false);
  }

  /* ---------------- données temporelles ---------------- */

  /** Bornes d'une vie ; null si aucune date exploitable. */
  function lifeYears(p, nowYear) {
    const bY = p.birth.value?.year ?? null;
    const dY = p.death.value?.year ?? null;
    const est = p.birth.status === 'estimated' || p.death.status === 'estimated';
    if (bY != null && dY != null) return { t1: bY, t2: dY, alive: false, est };
    if (bY != null) {
      const alive = p.death.status === 'living';
      return { t1: bY, t2: alive ? nowYear : Math.min(bY + 100, nowYear), alive, est };
    }
    if (dY != null) return { t1: Math.max(dY - 100, 0), t2: dY, alive: false, est: true };
    return null;
  }

  /** Unions d'un individu : conjoint + enfants (ids existants). */
  function unionsOf(p) {
    const out = [];
    for (const fid of p.familyAsSpouse) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const spouseId = fam.husband === p.id ? fam.wife : fam.husband;
      const kids = fam.children.filter((c) => index.getIndividual(c));
      if (spouseId || kids.length) {
        out.push({ famId: fid, spouseId, kids,
                   marr: fam.marriage.value?.year ?? null });
      }
    }
    return out;
  }

  /* ---------------- construction descendant ---------------- */

  /**
   * Construit le bloc d'un individu : ses lignes (lui + conjoints, mari en
   * haut), la liste de ses unions, et les sous-arbres de ses enfants,
   * triés par naissance.
   */
  function buildDown(pid, depth, seen, maxGen = downGen, genBase = null) {
    const nowYear = new Date().getFullYear();
    const p = index.getIndividual(pid);
    const node = { pid, gen: depth, rows: [], unions: [], subs: [],
                   h: 0, t1: Infinity, t2: -Infinity };
    if (genBase != null) node.gen = genBase + depth;
    if (!p) return node;

    addPersonRow(node, p, nowYear);
    if (seen.has(pid) || depth >= maxGen) return node;
    seen.add(pid);

    for (const u of unionsOf(p)) {
      let spouseRow = null;
      if (u.spouseId && !seen.has(u.spouseId)) {
        const sp = index.getIndividual(u.spouseId);
        seen.add(u.spouseId);
        spouseRow = addPersonRow(node, sp, nowYear);
      }
      node.unions.push({ marr: u.marr, spouseRow, spouseId: u.spouseId });
      const kids = u.kids.filter((k) => !seen.has(k))
        .map((k) => ({ k, y: index.getIndividual(k).birth.value?.year ?? 9999 }))
        .sort((a, b) => a.y - b.y).map((x) => x.k);
      for (const k of kids) {
        const sub = buildDown(k, depth + 1, seen, maxGen, genBase);
        sub.parentUnion = { pid, spouseRow, marr: u.marr };
        node.subs.push(sub);
      }
    }
    return node;
  }

  /** Ajoute la ligne d'un individu au bloc (mari inséré en tête). */
  function addPersonRow(node, p, nowYear) {
    if (!p) return null;
    const l = lifeYears(p, nowYear);
    if (!l) return null;
    const row = { id: p.id, person: p, gen: node.gen, ...l };
    if (p.sex === 'M' && node.rows.length) node.rows.unshift(row);
    else node.rows.push(row);
    node.h = node.rows.length * ROW_H + (node.rows.length - 1) * GAP_ROW;
    node.t1 = Math.min(node.t1, l.t1);
    node.t2 = Math.max(node.t2, l.t2);
    return row;
  }

  /* ---------------- placement ---------------- */

  /** Blocs déjà posés, pour la détection de chevauchements. */
  let placed = [];
  let rowMap = new Map();
  function conflicts(y, h, t1, t2) {
    if (t1 == null || t2 == null) return null;
    for (const b of placed) {
      if (t1 <= b.t2 && b.t1 <= t2 && y < b.yBot && b.yTop < y + h) return b;
    }
    return null;
  }

  /** Pose un bloc descendant ; les enfants sous le couple, en ordre. */
  function placeDown(node, desiredY, floorY) {
    let y = Math.max(desiredY, floorY);
    if (node.rows.length) {
      let guard = 0, c;
      while ((c = conflicts(y, node.h, node.t1, node.t2)) && guard++ < 500) {
        y = c.yBot + GAP_ROW;
      }
    }
    node.yTop = y;
    let ry = y;
    for (const r of node.rows) {
      r.y = ry;
      placed.push({ yTop: r.y, yBot: r.y + ROW_H, t1: r.t1, t2: r.t2, label: r.id });
      ry += ROW_H + GAP_ROW;
    }
    const blockBottom = y + node.h;
    let prevTop = -Infinity;
    for (const sub of node.subs) {
      const start = Math.max(blockBottom + BAND_GAP, prevTop);
      placeDown(sub, start, start);
      prevTop = sub.yTop;
    }
    node.yBot = Math.max(blockBottom, ...node.subs.map((s) => s.yBot ?? blockBottom));
  }

  /* ---------------- ascendants symétriques ---------------- */

  /**
   * Construit la branche ascendante : pour chaque individu, son père et sa
   * mère (chacun une ligne), et récursivement leurs propres parents.
   * Le placement centrera chaque couple sur la ligne de son enfant :
   * père au-dessus, mère en dessous (symétrie de la vue classique).
   * @returns {Array<{childId, marr, upRow, downRow}>} upRow/downRow portent
   *   chacun une éventuelle sous-branche `.branch`
   */
  function buildUpAncestors(pid, depth, seen, maxGen = upGen, genBase = null) {
    const p = index.getIndividual(pid);
    const out = [];
    if (!p || depth >= maxGen) return out;
    for (const fid of p.childInFamilies) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const nowYear = new Date().getFullYear();
      const unit = { childId: pid,
                     marr: fam.marriage.value?.year ?? null,
                     upRow: null, downRow: null };
      const gen = genBase == null ? -(depth + 1) : genBase - (depth + 1);
      const mkRow = (id) => {
        if (!id || seen.has(id) || !index.getIndividual(id)) return null;
        seen.add(id);
        const l = lifeYears(index.getIndividual(id), nowYear);
        return l ? { id, person: index.getIndividual(id), gen, ...l } : null;
      };
      unit.upRow = mkRow(fam.husband);     // père : au-dessus de l'enfant
      unit.downRow = mkRow(fam.wife);       // mère : en dessous
      if (!unit.upRow && !unit.downRow) continue;
      if (unit.upRow) unit.upRow.branch = buildUpAncestors(unit.upRow.id, depth + 1, seen, maxGen, genBase);
      if (unit.downRow) unit.downRow.branch = buildUpAncestors(unit.downRow.id, depth + 1, seen, maxGen, genBase);
      out.push(unit);
    }
    return out;
  }

  /**
   * Pose les ascendants symétriquement : chaque couple centré sur la ligne
   * de son enfant — le père au-dessus (conflits vers le haut), la mère en
   * dessous (conflits vers le bas) — récursivement.
   */
  function placeAncestors(units, childRow) {
    for (const u of units) {
      if (u.upRow) {
        let y = childRow.y - BAND_GAP - ROW_H, guard = 0, c;
        while ((c = conflicts(y, ROW_H, u.upRow.t1, u.upRow.t2)) && guard++ < 500) {
          y = c.yTop - ROW_H - GAP_ROW;
        }
        u.upRow.y = y;
        placed.push({ yTop: y, yBot: y + ROW_H, t1: u.upRow.t1, t2: u.upRow.t2, label: u.upRow.id });
        placeAncestors(u.upRow.branch, u.upRow);
      }
      if (u.downRow) {
        let y = childRow.y + ROW_H + GAP_ROW, guard = 0, c;
        while ((c = conflicts(y, ROW_H, u.downRow.t1, u.downRow.t2)) && guard++ < 500) {
          y = c.yBot + GAP_ROW;
        }
        u.downRow.y = y;
        placed.push({ yTop: y, yBot: y + ROW_H, t1: u.downRow.t1, t2: u.downRow.t2, label: u.downRow.id });
        placeAncestors(u.downRow.branch, u.downRow);
      }
    }
  }

  /* ---------------- dessin ---------------- */

  /** Dessine la vue chronologique pour la racine donnée. */
  function update(rootId) {
    currentRootId = rootId;
    gView.selectAll('*').remove();
    tip.style('display', 'none');
    placed = [];
    if (!rootId || !index.getIndividual(rootId)) return;
    const nowYear = new Date().getFullYear();

    // ---------- descendants : construction + placement ----------
    const down = buildDown(rootId, 0, new Set());
    placeDown(down, 0, 0);

    // ---------- collecte des lignes descendantes ----------
    rowMap = new Map();     // id -> première ligne
    const allRows = [];
    const collectDown = (n) => {
      for (const r of n.rows) {
        if (!rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
      }
      n.subs.forEach(collectDown);
    };
    collectDown(down);

    // ---------- ascendants symétriques : construction + placement ----------
    const ancUnits = buildUpAncestors(rootId, 0, new Set([rootId]));
    const rootRow = rowMap.get(rootId);
    if (rootRow) placeAncestors(ancUnits, rootRow);
    const collectAnc = (u) => {
      for (const r of [u.upRow, u.downRow]) {
        if (r && !rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
      }
      if (u.upRow) u.upRow.branch.forEach(collectAnc);
      if (u.downRow) u.downRow.branch.forEach(collectAnc);
    };
    for (const u of ancUnits) collectAnc(u);

    // ---------- branches ajoutées : fratrie (M6a) ----------
    /** Cherche l'unité ascendante dont l'enfant est childId (récursif). */
    const findAncUnit = (units, childId) => {
      for (const u of units) {
        if (u.childId === childId) return u;
        const inUp = u.upRow ? findAncUnit(u.upRow.branch, childId) : null;
        if (inUp) return inUp;
        const inDown = u.downRow ? findAncUnit(u.downRow.branch, childId) : null;
        if (inDown) return inDown;
      }
      return null;
    };

    // ---------- branches ajoutées (M6a/M6b) : passes jusqu'à point fixe ----------
    // Une édition peut porter sur un individu introduit par une autre édition
    // (récursivité : fratrie d'un conjoint, puis descendants d'un membre de
    // cette fratrie...). On traite les éditions en passes : chaque édition
    // devient traitée quand son pivot est affiché, jusqu'à ce qu'une passe
    // n'aboutisse plus — l'ordre des clics devient indifférent.
    for (const e of (getEdits ? getEdits() : [])) e._done = false;
    const extraDownNodes = [];
    const sibPlacements = [];
    for (let pass = 0; pass < 10; pass++) {
      let changed = false;

      // ---------- ascendants (M6b) ----------
      for (const e of (getEdits ? getEdits() : [])) {
        if (e.type !== 'up' || e._done) continue;
        const pivRow = rowMap.get(e.pivot);
        if (!pivRow) continue;
        const seen = new Set([...rowMap.keys()]);
        const units = buildUpAncestors(e.pivot, 0, seen, e.depth, pivRow.gen);
        placeAncestors(units, pivRow);
        const collect = (u) => {
          for (const r of [u.upRow, u.downRow]) {
            if (r && !rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
          }
          if (u.upRow) u.upRow.branch.forEach(collect);
          if (u.downRow) u.downRow.branch.forEach(collect);
        };
        units.forEach(collect);
        ancUnits.push(...units);   // walkAnc dessinera unions + filiations
        e._done = true; changed = true;
      }

      // ---------- descendants (M6b) ----------
      for (const e of (getEdits ? getEdits() : [])) {
        if (e.type !== 'down' || e._done) continue;
        const pivRow = rowMap.get(e.pivot);
        if (!pivRow) continue;
        const seen = new Set([...rowMap.keys()]);
        seen.delete(e.pivot);
        const node = buildDown(e.pivot, 0, seen, e.depth, pivRow.gen);
        // nouveaux conjoints du pivot : sous sa ligne (solveur)
        let y = pivRow.y + ROW_H + GAP_ROW;
        for (const r of node.rows) {
          if (rowMap.has(r.id)) continue;
          let guard = 0, c;
          while ((c = conflicts(y, ROW_H, r.t1, r.t2)) && guard++ < 500) y = c.yBot + GAP_ROW;
          r.y = y;
          placed.push({ yTop: y, yBot: y + ROW_H, t1: r.t1, t2: r.t2, label: r.id });
          rowMap.set(r.id, r); allRows.push(r);
          y += ROW_H + GAP_ROW;
        }
        // enfants : blocs sous le couple
        let cursor = y + BAND_GAP;
        for (const sub of node.subs) {
          placeDown(sub, cursor, cursor);
          cursor = (sub.yBot ?? cursor) + BAND_GAP;
        }
        // collecte des lignes des sous-arbres dans rowMap/allRows (sinon
        // elles sont placées mais jamais dessinées)
        const collectSub = (n) => {
          for (const r of n.rows) {
            if (!rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
          }
          n.subs.forEach(collectSub);
        };
        node.subs.forEach(collectSub);
        extraDownNodes.push(node);
        e._done = true; changed = true;
      }

      // ---------- fratrie (M6a) ----------
      for (const e of (getEdits ? getEdits() : [])) {
        if (e.type !== 'siblings' || e._done) continue;
        const pivRow = rowMap.get(e.pivot);
        const pivPerson = index.getIndividual(e.pivot);
        if (!pivRow || !pivPerson) continue;
        // parents du pivot : unité existante (déjà liée) ou ajoutée ici
        let parentsUnit = findAncUnit(ancUnits, e.pivot);
        if (!parentsUnit) {
          for (const fid of pivPerson.childInFamilies) {
            const fam = index.getFamily(fid);
            if (!fam) continue;
            const mkRow = (id) => {
              if (!id || rowMap.has(id) || !index.getIndividual(id)) return null;
              const l = lifeYears(index.getIndividual(id), nowYear);
              return l ? { id, person: index.getIndividual(id),
                           gen: pivRow.gen - 1, edited: true, ...l } : null;
            };
            const u = { childId: e.pivot,
                        marr: fam.marriage.value?.year ?? null,
                        upRow: mkRow(fam.husband), downRow: mkRow(fam.wife) };
            if (!u.upRow && !u.downRow) continue;
            if (u.upRow) u.upRow.branch = [];
            if (u.downRow) u.downRow.branch = [];
            // convention symétrique : père au-dessus de la ligne du pivot,
            // mère en dessous (solveur anti-chevauchement)
            placeAncestors([u], pivRow);
            for (const r of [u.upRow, u.downRow]) {
              if (r && !rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
            }
            ancUnits.push(u);   // walkAnc dessinera union + filiation vers le pivot
            parentsUnit = u;
            break;
          }
        }
        let cursor = pivRow.y + ROW_H + GAP_ROW;
        for (const k of siblingIds(index, e.pivot)) {
          if (rowMap.has(k)) continue;
          const kp = index.getIndividual(k);
          const unit = { personId: k, rows: [], smarr: null };
          const kl = lifeYears(kp, nowYear);
          if (kl) unit.rows.push({ id: k, person: kp, gen: pivRow.gen, edited: true, ...kl });
          for (const sfid of kp.familyAsSpouse) {
            const sf = index.getFamily(sfid);
            if (!sf) continue;
            const sid = sf.husband === k ? sf.wife : sf.husband;
            if (!sid || rowMap.has(sid) || !index.getIndividual(sid)) continue;
            const sp = index.getIndividual(sid);
            const sl = lifeYears(sp, nowYear);
            if (!sl) continue;
            const srow = { id: sid, person: sp, gen: pivRow.gen, edited: true, ...sl };
            if (sp.sex === 'M') unit.rows.unshift(srow); else unit.rows.push(srow);
            if (unit.smarr == null) unit.smarr = sf.marriage.value?.year ?? null;
          }
          if (!unit.rows.length) continue;
          // placement avec solveur anti-chevauchement, sous la ligne du pivot
          const h = unit.rows.length * ROW_H + (unit.rows.length - 1) * GAP_ROW;
          const t1 = Math.min(...unit.rows.map((r) => r.t1));
          const t2 = Math.max(...unit.rows.map((r) => r.t2));
          let y = cursor, guard = 0, c;
          while ((c = conflicts(y, h, t1, t2)) && guard++ < 500) y = c.yBot + GAP_ROW;
          let ry = y;
          for (const r of unit.rows) {
            r.y = ry;
            placed.push({ yTop: r.y, yBot: r.y + ROW_H, t1: r.t1, t2: r.t2, label: r.id });
            rowMap.set(r.id, r); allRows.push(r);
            ry += ROW_H + GAP_ROW;
          }
          cursor = y + h + BAND_GAP;
          sibPlacements.push({ unit, parentsUnit });
        }
        e._done = true; changed = true;
      }

      if (!changed) break;
    }

    if (!allRows.length) { log.info('Frise : aucune date exploitable'); return; }

    // ---------- échelle ----------
    let minY = Infinity, maxY = -Infinity, minT = Infinity, maxT = -Infinity;
    for (const r of allRows) {
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + ROW_H);
      minT = Math.min(minT, r.t1); maxT = Math.max(maxT, r.t2);
    }
    const avail = Math.max(container.clientWidth || 800, 400) - 2 * SIDE_PAD;
    const pxPerYear = Math.min(14, Math.max(2.5, avail / (maxT - minT + 10)));
    const X = (t) => SIDE_PAD + (t - minT + 5) * pxPerYear;

    const offY = TOP_PAD - minY;   // décalage : tout devient positif
    const totalH = maxY - minY + TOP_PAD + BOTTOM_PAD;
    const totalW = X(maxT) + SIDE_PAD;
    svg.attr('height', Math.max(totalH, 80))
       .attr('viewBox', `0 0 ${totalW} ${Math.max(totalH, 80)}`)
       .attr('preserveAspectRatio', 'xMinYMin meet');
    // hauteur du conteneur : plafonnée en fenêtre normale, remplie en plein écran
    const inFs = document.fullscreenElement != null;
    const capH = inFs ? Math.max(window.innerHeight - 150, 320) : 720;
    container.style.height = Math.max(Math.min(totalH, capH), 80) + 'px';

    // ---------- axe des années ----------
    const span = maxT - minT;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    const ticks = [];
    for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) ticks.push(t);
    const tickSel = gView.selectAll('g.tl-tick').data(ticks).join('g')
      .attr('transform', (t) => `translate(${X(t)},0)`);
    tickSel.append('line').attr('class', 'tl-grid')
      .attr('y1', minY - 14 + offY).attr('y2', maxY + offY);
    tickSel.append('text').attr('class', 'tl-tick')
      .attr('y', minY - 20 + offY).attr('text-anchor', 'middle').text((t) => t);

    // ---------- repères de mariage + filiations ----------
    /** Année de mariage heuristique : moyenne des naissances + 25 ans. */
    const heuristicMarr = (rows) => {
      const b = rows.map((r) => r?.t1).filter((v) => v != null);
      return b.length ? Math.round(b.reduce((s, v) => s + v, 0) / b.length) + 25 : null;
    };

    /** Repère d'union : trait vertical entre les deux lignes du couple. */
    function drawMarry(rowA, rowB, marr, ids) {
      if (!rowA || !rowB || marr == null) return;
      gView.append('line').attr('class', 'tl-marry')
        .datum({ ids })
        .attr('x1', X(marr)).attr('y1', rowA.y + ROW_H / 2)
        .attr('x2', X(marr)).attr('y2', rowB.y + ROW_H / 2);
    }

    /** Filiation : du point d'union vers la ligne de l'enfant. */
    function drawFiliation(x, yFrom, childId, ids) {
      const cr = rowMap.get(childId);
      if (!cr) return;
      const cy = cr.y + ROW_H / 2;
      const cx = X(cr.t1);
      const dy = (cy - yFrom) / 2;
      gView.append('path').attr('class', 'tl-link')
        .datum({ ids })
        .attr('d', `M ${x} ${yFrom} C ${x} ${yFrom + dy}, ${cx} ${cy - dy}, ${cx} ${cy}`);
    }

    // descendants : union du couple + filiation vers chaque sous-arbre
    (function walkDown(node) {
      const mainRow = node.rows.find((r) => r.id === node.pid) ?? node.rows[0];
      for (const u of node.unions) {
        const marr = u.marr ?? heuristicMarr([mainRow, u.spouseRow]);
        drawMarry(mainRow, u.spouseRow, marr,
          [mainRow?.id, u.spouseRow?.id].filter(Boolean));
      }
      for (const sub of node.subs) {
        const pu = sub.parentUnion;
        const marr = pu.marr ?? heuristicMarr([mainRow, pu.spouseRow]);
        if (marr != null && mainRow) {
          const yFrom = pu.spouseRow
            ? (mainRow.y + pu.spouseRow.y) / 2 + ROW_H / 2
            : mainRow.y + node.h;
          drawFiliation(X(marr), yFrom, sub.pid,
            [mainRow.id, pu.spouseRow?.id, sub.pid].filter(Boolean));
        }
        walkDown(sub);
      }
    })(down);

    // ascendants : union du couple + filiation vers l'enfant
    const walkAnc = (u) => {
      const ids = [u.upRow?.id, u.downRow?.id, u.childId].filter(Boolean);
      const marr = u.marr ?? heuristicMarr([u.upRow, u.downRow]);
      if (marr != null) {
        let midY;
        if (u.upRow && u.downRow) {
          gView.append('line').attr('class', 'tl-marry')
            .datum({ ids })
            .attr('x1', X(marr)).attr('y1', u.upRow.y + ROW_H / 2)
            .attr('x2', X(marr)).attr('y2', u.downRow.y + ROW_H / 2);
          midY = (u.upRow.y + u.downRow.y) / 2 + ROW_H / 2;
        } else {
          const r = u.upRow ?? u.downRow;
          midY = r.y + ROW_H / 2;
        }
        drawFiliation(X(marr), midY, u.childId, ids);
      }
      if (u.upRow) u.upRow.branch.forEach(walkAnc);
      if (u.downRow) u.downRow.branch.forEach(walkAnc);
    };
    ancUnits.forEach(walkAnc);

    // branches fratrie ajoutées : union du couple + filiation
    // depuis le mariage des parents du pivot (si affichés)
    for (const sp of sibPlacements) {
      const { unit, parentsUnit } = sp;
      if (unit.rows.length === 2) {
        const marr = unit.smarr ?? heuristicMarr(unit.rows);
        drawMarry(unit.rows[0], unit.rows[1], marr,
          [unit.rows[0].id, unit.rows[1].id]);
      }
      if (parentsUnit) {
        const ids = [parentsUnit.upRow?.id, parentsUnit.downRow?.id,
                     unit.personId].filter(Boolean);
        const marr = parentsUnit.marr
          ?? heuristicMarr([parentsUnit.upRow, parentsUnit.downRow].filter(Boolean));
        if (marr != null) {
          const midY = parentsUnit.upRow && parentsUnit.downRow
            ? (parentsUnit.upRow.y + parentsUnit.downRow.y) / 2 + ROW_H / 2
            : (parentsUnit.upRow ?? parentsUnit.downRow).y + ROW_H / 2;
          drawFiliation(X(marr), midY, unit.personId, ids);
        }
      }
    }

    // branches descendants ajoutées : unions + filiations (M6b)
    for (const node of extraDownNodes) {
      const mainRow = rowMap.get(node.pid);
      if (!mainRow) continue;
      for (const u of node.unions) {
        const sr = u.spouseRow && rowMap.has(u.spouseRow.id) ? u.spouseRow : null;
        const marr = u.marr ?? heuristicMarr([mainRow, sr]);
        drawMarry(mainRow, sr, marr, [mainRow.id, sr?.id].filter(Boolean));
      }
      for (const sub of node.subs) {
        const pu = sub.parentUnion;
        const sr = pu.spouseRow && rowMap.has(pu.spouseRow.id) ? pu.spouseRow : null;
        const marr = pu.marr ?? heuristicMarr([mainRow, sr]);
        if (marr != null) {
          const yFrom = sr ? (mainRow.y + sr.y) / 2 + ROW_H / 2 : mainRow.y + ROW_H;
          drawFiliation(X(marr), yFrom, sub.pid,
            [mainRow.id, sr?.id, sub.pid].filter(Boolean));
        }
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

    sel.filter((b) => Math.max(X(b.t2) - X(b.t1), MIN_BOX_W) > 34).append('text')
      .attr('x', 3).attr('y', ROW_H / 2 - 1)
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
        tip.html(buildTooltipHtml(b.person)).style('display', 'block');
        positionTip(event);
        highlightFamily(b.person);
      })
      .on('pointermove', positionTip)
      .on('pointerout', () => { tip.style('display', 'none'); clearHighlight(); })
      .on('contextmenu', (event, b) => {
        if (onContextPerson) onContextPerson(b.person, event);
      });

    svg.call(zoomBeh.transform, d3.zoomIdentity);
    log.info(`Frise chronologique : ${boxes.length} boîte(s) ` +
      `(${upGen} gén. ascendants symétriques, ${downGen} gén. descendants)`);
  }

  log.info('Vue chronologique généalogique initialisée');
  return {
    update,
    setGenerations: (u, d) => { upGen = u; downGen = d; update(currentRootId); },
    reset: () => svg.call(zoomBeh.transform, d3.zoomIdentity),
  };
}