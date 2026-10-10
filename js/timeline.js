/**
 * timeline.js — Vue chronologique généalogique (layout récursif par familles).
 *
 * L'axe X est le temps : chaque boîte va de la naissance au décès (tirets si
 * date estimée, flèche si vivant présumé). Le placement vertical suit la
 * structure des familles :
 *  - descendants : couple empilé (mari au-dessus de la femme), enfants posés
 *    SOUS le couple, dans l'ordre de naissance ; chaque enfant reçoit comme
 *    plancher le haut du frère précédent (ordre préservé), puis est poussé
 *    vers le bas en cas de chevauchement temporel avec un bloc déjà posé ;
 *  - ascendants : couples de parents au-dessus de l'enfant, itérés jusqu'à
 *    la profondeur demandée, avec la même contrainte anti-chevauchement ;
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

  function highlightFamily(person) {
    const fam = familySet(index, person);
    gView.selectAll('g.tl-box')
      .classed('dim', (b) => !fam.has(b.id))
      .classed('hl', (b) => fam.has(b.id) && b.id !== person.id);
    gView.selectAll('path.tl-link, line.tl-marry')
      .classed('dim', (l) => !(l.ids && l.ids.some((i) => fam.has(i))));
  }
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
   * haut) et les sous-arbres de ses enfants, triés par naissance.
   */
  function buildDown(pid, depth, seen) {
    const p = index.getIndividual(pid);
    const node = { pid, rows: [], unions: [], subs: [],
                   h: 0, t1: Infinity, t2: -Infinity };
    if (!p || seen.has(pid) || depth >= downGen) {
      addPersonRow(node, p);
      return node;
    }
    seen.add(pid);
    addPersonRow(node, p);
    for (const u of unionsOf(p)) {
      let spouseRow = null;
      if (u.spouseId && !seen.has(u.spouseId)) {
        const sp = index.getIndividual(u.spouseId);
        seen.add(u.spouseId);
        spouseRow = addPersonRow(node, sp);
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

  /** Ajoute la ligne d'un individu au bloc (retourne la ligne, ou null). */
  function addPersonRow(node, p) {
    const nowYear = new Date().getFullYear();
    if (!p) return null;
    const l = lifeYears(p, nowYear);
    if (!l) return null;
    const row = { id: p.id, person: p, ...l };
    const isMale = p.sex === 'M';
    if (node.rows.length && isMale && !node.rows[0].isMain) node.rows.unshift(row);
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
    for (const b of placed) {
      if (t1 <= b.t2 && b.t1 <= t2 && y < b.yBot && b.yTop < y + h) return b;
    }
    return null;
  }

  /** Pose un bloc descendant ; les enfants sous le couple, en ordre. */
  function placeDown(node, desiredY, floorY) {
    let y = Math.max(desiredY, floorY);
    if (node.h > 0) {
      let guard = 0, c;
      while ((c = conflicts(y, node.h, node.t1, node.t2)) && guard++ < 500) {
        y = c.yBot + GAP_ROW;
      }
      placed.push({ yTop: y, yBot: y + node.h, t1: node.t1, t2: node.t2, label: node.pid });
    }
    node.yTop = y;
    let ry = y;
    for (const r of node.rows) {
      r.y = ry;
      placed.push({ yTop: r.y, yBot: r.y + ROW_H, t1: r.t1, t2: r.t2, label: r.id });
      ry += ROW_H + GAP_ROW;
    }
    const coupleBottom = y + node.h;
    let prevTop = -Infinity;
    for (const sub of node.subs) {
      placeDown(sub, coupleBottom + BAND_GAP, Math.max(coupleBottom + BAND_GAP, prevTop));
      prevTop = sub.yTop;
    }
    node.yBot = Math.max(y + node.h, ...node.subs.map((s) => s.yBot ?? 0));
  }

  /** Blocs ascendants : couples de parents (mari en haut), au-dessus. */
  function buildUpCouple(childPid, depth, seen) {
    const p = index.getIndividual(childPid);
    const out = [];
    if (!p) return out;
    for (const fid of p.childInFamilies) {
      const fam = index.getFamily(fid);
      if (!fam) continue;
      const rows = [];
      const cand = [fam.husband, fam.wife].filter(Boolean)
        .sort((a, b) => (index.getIndividual(a)?.sex === 'M' ? 0 : 1)
                      - (index.getIndividual(b)?.sex === 'M' ? 0 : 1));
      for (const pid of cand) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const par = index.getIndividual(pid);
        const nowYear = new Date().getFullYear();
        const l = lifeYears(par, nowYear);
        if (l) rows.push({ id: pid, person: par, ...l });
      }
      if (!rows.length) continue;
      const node = { rows, subs: [], childPid,
                     marr: fam.marriage.value?.year ?? null,
                     h: rows.length * ROW_H + (rows.length - 1) * GAP_ROW,
                     t1: Math.min(...rows.map((r) => r.t1)),
                     t2: Math.max(...rows.map((r) => r.t2)) };
      if (depth + 1 < upGen) {
        for (const r of rows) node.subs.push(...buildUpCouple(r.id, depth + 1, seen));
      }
      out.push(node);
    }
    return out;
  }

  /** Pose un bloc ascendant (conflits résolus vers le haut). */
  function placeUp(node, maxYBottom) {
    let y = maxYBottom - BAND_GAP - node.h, guard = 0, c;
    while ((c = conflicts(y, node.h, node.t1, node.t2)) && guard++ < 500) {
      y = c.yTop - node.h - GAP_ROW;
    }
    let ry = y;
    for (const r of node.rows) {
      r.y = ry;
      placed.push({ yTop: r.y, yBot: r.y + ROW_H, t1: r.t1, t2: r.t2, label: r.id });
      ry += ROW_H + GAP_ROW;
    }
    node.yTop = y;
    for (const sub of node.subs) placeUp(sub, node.yTop);
  }

  /* ---------------- dessin ---------------- */

  function update(rootId) {
    currentRootId = rootId;
    gView.selectAll('*').remove();
    tip.style('display', 'none');
    placed = [];
    if (!rootId || !index.getIndividual(rootId)) return;

    // ---------- construction et placement ----------
    const down = buildDown(rootId, 0, new Set());
    placeDown(down, 0, 0);
    const anc = buildUpCouple(rootId, 0, new Set([rootId]));
    for (const a of anc) placeUp(a, down.yTop);

    // ---------- collecte des lignes ----------
    const rowMap = new Map();     // id -> première ligne
    const allRows = [];
    const collect = (rows, subs) => {
      for (const r of rows) {
        if (!rowMap.has(r.id)) { rowMap.set(r.id, r); allRows.push(r); }
      }
      subs.forEach((s) => collect(s.rows, s.subs));
    };
    collect(down.rows, down.subs);
    for (const a of anc) {
      (function walkA(n) { collect(n.rows, []); n.subs.forEach(walkA); })(a);
    }
    if (!allRows.length) { log.info('Frise : aucune date exploitable'); return; }

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

    // ---------- axe ----------
    const span = maxT - minT;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    const ticks = [];
    for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) ticks.push(t);
    const tickSel = gView.selectAll('g.tl-tick').data(ticks).join('g')
      .attr('transform', (t) => `translate(${X(t)},${offY - minY})`);
    tickSel.append('line').attr('class', 'tl-grid')
      .attr('y1', minY - 14).attr('y2', maxY);
    tickSel.append('text').attr('class', 'tl-tick')
      .attr('y', minY - 20).attr('text-anchor', 'middle').text((t) => t);

    // ---------- repères de mariage + filiations ----------
    const heuristicMarr = (rows) => {
      const b = rows.map((r) => r.t1).filter((v) => v != null);
      return b.length ? Math.round(b.reduce((s, v) => s + v, 0) / b.length) + 25 : null;
    };

    /** Repère d'union entre deux lignes de couple. */
    function drawMarry(rowA, rowB, marr, ids) {
      if (!rowA || !rowB || marr == null) return;
      const y1 = Math.max(rowA.y, rowB.y) - ROW_H + 2;
      const y2 = Math.min(rowA.y, rowB.y) + ROW_H - 2;
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

    // descendants : unions du bloc + filiation vers chaque sous-arbre
    (function walkDown(node) {
      const mainRow = node.rows.find((r) => r.id === node.pid) ?? node.rows[0];
      let ui = 0;
      for (const u of node.unions) {
        const spouseRow = u.spouseRow;
        const marr = u.marr ?? heuristicMarr([mainRow, spouseRow].filter(Boolean));
        if (marr != null && mainRow && spouseRow) {
          drawMarry(mainRow, spouseRow, marr,
            [mainRow.id, spouseRow.id].filter(Boolean));
        }
        ui++;
      }
      for (const sub of node.subs) {
        const pu = sub.parentUnion;
        const marr = pu.marr
          ?? heuristicMarr([mainRow, pu.spouseRow].filter(Boolean));
        if (marr != null && mainRow) {
          const yFrom = mainRow && pu.spouseRow
            ? (mainRow.y + pu.spouseRow.y) / 2 + ROW_H / 2
            : mainRow.y + ROW_H;
          drawFiliation(X(marr), yFrom, sub.pid,
            [mainRow.id, pu.spouseRow?.id, sub.pid].filter(Boolean));
        }
        walkDown(sub);
      }
    })(down);

    // ascendants : union du couple + filiation vers l'enfant
    for (const a of anc) {
      (function walkUp(n) {
        const marr = n.marr ?? heuristicMarr(n.rows);
        if (marr != null && n.rows.length === 2) {
          drawMarry(n.rows[0], n.rows[1], marr, [n.rows[0].id, n.rows[1].id]);
        }
        if (marr != null) {
          const yFrom = n.rows.length === 2
            ? (n.rows[0].y + n.rows[1].y) / 2 + ROW_H / 2
            : n.rows[0].y;
          const childRow = rowMap.get(n.childPid);
          if (childRow) {
            const cy = childRow.y + ROW_H / 2;
            const cx = X(childRow.t1);
            const dy = (yFrom - cy) / 2;
            gView.append('path').attr('class', 'tl-link')
              .datum({ ids: [...n.rows.map((r) => r.id), n.childPid] })
              .attr('d', `M ${X(marr)} ${yFrom} C ${X(marr)} ${yFrom - dy}, ${cx} ${cy + dy}, ${cx} ${cy}`);
          }
        }
        n.subs.forEach(walkUp);
      })(a);
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
    log.info(`Frise récursive : ${boxes.length} boîte(s)` +
      (down.subs.length ? `, ${down.subs.length} sous-famille(s) descendant(es)` : ''));
  }

  log.info('Vue chronologique généalogique initialisée');
  return {
    update,
    setGenerations: (u, d) => { upGen = u; downGen = d; update(currentRootId); },
    reset: () => svg.call(zoomBeh.transform, d3.zoomIdentity),
  };
}