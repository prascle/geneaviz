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
 *  - liens de filiation partant de la date de mariage (sinon : naissances
 *    des parents + 25 ans), repère orange au point de mariage.
 *
 * Infobulle au survol + surbrillance de la famille. Réglages (générations,
 * recentrage) pilotés par la barre de vues (app.js).
 */
import * as d3 from 'd3';
import { logger } from './logger.js';

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
 * @returns {{update: Function, setGenerations: Function, reset: Function}}
 */
export function initTimeline({ container, index, upGen = 3, downGen = 3, onSelectPerson }) {
  container.innerHTML = '';
  let currentRootId = null;

  const svg = d3.select(container).append('svg').attr('width', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.15, 20])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  // infobulle partagée avec la vue arbre
  let tip = d3.select('body').select('div.tree-tip');
  if (tip.empty()) tip = d3.select('body').append('div').attr('class', 'tree-tip');
  const positionTip = (event) => {
    const node = tip.node();
    const w = node.offsetWidth, h = node.offsetHeight;
    let x = event.clientX + 14, y = event.clientY + 14;
    if (x + w > window.innerWidth - 8) x = event.clientX - w - 14;
    if (y + h > window.innerHeight - 8) y = event.clientY - h - 14;
    tip.style('left', x + 'px').style('top', y + 'px');
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
      `<div class="tip-dates">naissance ${dHtml(p.birth)} · décès ${dHtml(p.death)}</div>`,
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

  /** Estompe la frise hors famille de l'individu survolé. */
  function highlightFamily(person) {
    const fam = familySet(index, person);
    gView.selectAll('g.tl-box')
      .classed('dim', (b) => !fam.has(b.id))
      .classed('hl', (b) => fam.has(b.id) && b.id !== person.id);
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('dim', (l) => !(l.ids && l.ids.some((i) => fam.has(i))));
  }

  /** Rétablit l'opacité normale. */
  function clearHighlight() {
    gView.selectAll('g.tl-box').classed('dim', false).classed('hl', false);
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
  function buildDown(pid, depth, seen) {
    const nowYear = new Date().getFullYear();
    const p = index.getIndividual(pid);
    const node = { pid, rows: [], unions: [], subs: [],
                   h: 0, t1: Infinity, t2: -Infinity };
    if (!p) return node;

    addPersonRow(node, p, nowYear);
    if (seen.has(pid) || depth >= downGen) return node;
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
        const sub = buildDown(k, depth + 1, seen);
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
    const row = { id: p.id, person: p, ...l };
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
  function buildUpAncestors(pid, depth, seen) {
    const p = index.getIndividual(pid);
    const out = [];
    if (!p || depth >= upGen) return out;
    for (const fid of p.childInFamilies) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const nowYear = new Date().getFullYear();
      const unit = { childId: pid,
                     marr: fam.marriage.value?.year ?? null,
                     upRow: null, downRow: null };
      const mkRow = (id) => {
        if (!id || seen.has(id) || !index.getIndividual(id)) return null;
        seen.add(id);
        const l = lifeYears(index.getIndividual(id), nowYear);
        return l ? { id, person: index.getIndividual(id), ...l } : null;
      };
      unit.upRow = mkRow(fam.husband);     // père : au-dessus de l'enfant
      unit.downRow = mkRow(fam.wife);       // mère : en dessous
      if (!unit.upRow && !unit.downRow) continue;
      if (unit.upRow) unit.upRow.branch = buildUpAncestors(unit.upRow.id, depth + 1, seen);
      if (unit.downRow) unit.downRow.branch = buildUpAncestors(unit.downRow.id, depth + 1, seen);
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

    // ---------- descendants : construction + placement ----------
    const down = buildDown(rootId, 0, new Set());
    placeDown(down, 0, 0);

    // ---------- collecte des lignes descendantes ----------
    const rowMap = new Map();     // id -> première ligne
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
    container.style.height = Math.min(totalH, 720) + 'px';

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
        if (b.alive) cls.push('alive');
        return cls.filter(Boolean).join(' ');
      });

    sel.filter((b) => Math.max(X(b.t2) - X(b.t1), MIN_BOX_W) > 34).append('text')
      .attr('x', 3).attr('y', ROW_H / 2 - 1)
      .text((b) => {
        const w = Math.max(X(b.t2) - X(b.t1), MIN_BOX_W);
        const maxCh = Math.floor((w - 6) / 5.6);
        const s = ((b.person.name.given || '') + ' '
          + (b.person.name.surname || '?').toUpperCase()).trim();
        return s.length > maxCh ? s.slice(0, maxCh - 1) + '…' : s;
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
      .on('pointerout', () => { tip.style('display', 'none'); clearHighlight(); });

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