/**
 * timeline.js — Jalon M5 v2 : vue chronologique généalogique.
 *
 * L'arbre combiné (ascendants/descendants/conjoints) est « déformé » sur
 * l'axe du temps :
 *  - X : temps — chaque boîte va de la naissance au décès (tirets si date
 *    estimée, flèche jusqu'à aujourd'hui si vivant présumé) ;
 *  - Y : bandes de générations (ascendants en haut, racine, descendants
 *    en bas) ; les conjoints occupent la bande de leur époux/épouse ;
 *  - liens de filiation partant de la date de mariage quand elle est
 *    connue (sinon : moyenne des naissances des parents + 25 ans) ;
 *  - anti-chevauchement : packing d'intervalles en sous-lignes par bande.
 *
 * Tooltip au survol (détail complet), clic → callback de sélection.
 */
import * as d3 from 'd3';
import { logger } from './logger.js';
import { buildAncestorTree, buildDescendantTree } from './tree.js';

const log = logger('timeline');

/** Dimensions du layout (px). */
const ROW_H = 18;      // hauteur d'une ligne de vie
const BOX_GAP = 6;     // écart horizontal minimum entre boîtes d'une même ligne
const MIN_BOX_W = 16;  // largeur minimale d'une boîte
const BAND_GAP = 26;   // espace vertical entre bandes (passage des filiations)
const TOP_PAD = 26;    // place pour l'axe des années

/**
 * Initialise la vue chronologique généalogique.
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte du SVG
 * @param {HTMLElement} [options.controls] - conteneur des infos/contrôles
 * @param {Object} options.index - index applicatif
 * @param {number} [options.upGen=6] - générations d'ascendants
 * @param {number} [options.downGen=6] - générations de descendants
 * @param {Function} [options.onSelectPerson] - callback clic sur une boîte
 * @returns {{update: Function}} API de la vue
 */
export function initTimeline({ container, controls, index, upGen = 6, downGen = 6, onSelectPerson }) {
  container.innerHTML = '';
  let currentRootId = null;

  const svg = d3.select(container).append('svg')
    .attr('width', '100%');
  const gZoom = svg.append('g');
  const gView = gZoom.append('g');

  const zoomBeh = d3.zoom().scaleExtent([0.15, 20])
    .on('zoom', (event) => gZoom.attr('transform', event.transform));
  svg.call(zoomBeh);

  // infobulle partagée avec l'arbre (même classe, même style)
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

  if (controls) {
    controls.innerHTML = '';
    d3.select(controls).append('span')
      .text('Axe horizontal = temps · molette = zoom · glisser = déplacer · survol = détail');
  }

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

  /** Collecte les individus du périmètre avec leur bande (depth signée). */
  function collectPersons(rootId) {
    const map = new Map();   // id -> {person, depth}
    const addWalk = (data, sign) => {
      if (!data) return;
      (function walk(n) {
        const depth = sign * (n.gen - 1);
        if (!map.has(n.id)) map.set(n.id, { person: n.person, depth });
        n.children.forEach(walk);
      })(data);
    };
    addWalk(buildAncestorTree(index, rootId, upGen), -1);
    addWalk(buildDescendantTree(index, rootId, downGen), +1);
    if (!map.has(rootId)) {
      const p = index.getIndividual(rootId);
      if (p) map.set(rootId, { person: p, depth: 0 });
    }
    // conjoints : même bande que leur époux/épouse
    for (const { person, depth } of [...map.values()]) {
      for (const famId of person.familyAsSpouse) {
        const fam = index.getFamily(famId);
        if (!fam) continue;
        const sid = fam.husband === person.id ? fam.wife : fam.husband;
        if (sid && !map.has(sid)) {
          const sp = index.getIndividual(sid);
          if (sp) map.set(sid, { person: sp, depth });
        }
      }
    }
    return map;
  }

  /** Bornes temporelles d'un individu ; null si aucune date exploitable. */
  function lifeYears(person, nowYear) {
    const bY = person.birth.value?.year ?? null;
    const dY = person.death.value?.year ?? null;
    let x1 = bY, x2 = dY, alive = false;
    if (bY == null && dY == null) return null;
    if (bY != null && dY != null) return { x1: bY, x2: dY, alive: false };
    if (bY != null) {
      alive = person.death.status === 'living';
      return { x1: bY, x2: alive ? nowYear : Math.min(bY + 100, nowYear), alive };
    }
    return { x1: Math.max(dY - 100, 0), x2: dY, alive: false };
  }

  /** Dessine la vue chronologique pour la racine donnée. */
  function update(rootId) {
    currentRootId = rootId;
    gView.selectAll('*').remove();
    tip.style('display', 'none');
    if (!rootId || !index.getIndividual(rootId)) return;

    const nowYear = new Date().getFullYear();
    const persons = collectPersons(rootId);

    // ---------- années extrêmes et échelle ----------
    let minYear = Infinity, maxYear = -Infinity;
    const entries = [];   // {id, person, depth, x1, x2, alive}
    let skipped = 0;
    for (const [id, { person, depth }] of persons) {
      const span = lifeYears(person, nowYear);
      if (!span) { skipped++; continue; }
      entries.push({ id, person, depth, ...span });
      minYear = Math.min(minYear, span.x1);
      maxYear = Math.max(maxYear, span.x2);
    }
    if (!entries.length) { log.info('Frise : aucune date exploitable'); return; }

    const avail = Math.max(container.clientWidth || 800, 400) - 40;
    const pxPerYear = Math.min(14, Math.max(2.5, avail / (maxYear - minYear + 10)));
    const X = (year) => (year - minYear + 5) * pxPerYear;

    // ---------- bandes : depth -> sous-lignes (packing d'intervalles) ----------
    const byDepth = new Map();
    for (const e of entries) {
      if (!byDepth.has(e.depth)) byDepth.set(e.depth, []);
      byDepth.get(e.depth).push(e);
    }
    const depths = [...byDepth.keys()].sort((a, b) => a - b);

    // pack : chaque bande = liste de sous-lignes de boîtes sans chevauchement
    const bands = new Map();   // depth -> {rows: [[entry]], top, h}
    for (const d of depths) {
      const list = byDepth.get(d).sort((a, b) => a.x1 - b.x1 || a.x2 - b.x2);
      const rows = [];
      for (const e of list) {
        const x1 = X(e.x1), x2 = Math.max(X(e.x2), X(e.x1) + MIN_BOX_W);
        e.px1 = x1; e.px2 = x2;
        let placed = false;
        for (const row of rows) {
          const last = row[row.length - 1];
          if (last.px2 + BOX_GAP <= x1) { row.push(e); placed = true; break; }
        }
        if (!placed) rows.push([e]);
      }
      bands.set(d, { rows, top: 0, h: rows.length * ROW_H });
    }

    // positions verticales : bandes empilées dans l'ordre des depths
    let y = TOP_PAD;
    for (const d of depths) {
      const b = bands.get(d);
      b.top = y;
      y += b.h + BAND_GAP;
    }
    const totalH = y - BAND_GAP + TOP_PAD;
    const totalW = X(maxYear) + 40;

    svg.attr('height', Math.max(totalH, 80))
       .attr('viewBox', `0 0 ${totalW} ${Math.max(totalH, 80)}`)
       .attr('preserveAspectRatio', 'xMinYMin meet');
    container.style.height = Math.min(totalH, 720) + 'px';

    // ---------- axe des années ----------
    const span = maxYear - minYear;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    const ticks = [];
    for (let t = Math.ceil(minYear / step) * step; t <= maxYear; t += step) ticks.push(t);
    const tickSel = gView.selectAll('g.tl-tick').data(ticks).join('g')
      .attr('transform', (t) => `translate(${X(t)},0)`);
    tickSel.append('line').attr('class', 'tl-grid')
      .attr('y1', 14).attr('y2', totalH - TOP_PAD + 10);
    tickSel.append('text').attr('class', 'tl-tick')
      .attr('y', 10).attr('text-anchor', 'middle').text((t) => t);

    // ---------- liens de filiation ----------
    // pour chaque individu de profondeur d, parents attendus en bande d-1
    const inBand = new Map();   // id -> depth réelle
    for (const e of entries) inBand.set(e.id, e.depth);
    const eById = new Map(entries.map((e) => [e.id, e]));

    for (const e of entries) {
      if (e.depth === -0 && e.id === rootId) { /* racine : parents en -1 */ }
      const parentsBand = e.depth - 1;
      if (!bands.has(parentsBand)) continue;
      const parentBand = bands.get(parentsBand);
      const bandBottom = parentBand.top + parentBand.h;

      for (const famId of e.person.childInFamilies) {
        const fam = index.getFamily(famId);
        if (!fam) continue;
        const pIn = [fam.husband, fam.wife].filter((pid) => inBand.get(pid) === parentsBand);
        if (!pIn.length) continue;
        // X de départ : date de mariage si connue, sinon heuristique
        let mYear = fam.marriage.value?.year ?? null;
        if (mYear == null) {
          const births = pIn.map((pid) => eById.get(pid)).map((pe) => pe?.x1).filter((v) => v != null);
          mYear = births.length ? Math.round(births.reduce((s, v) => s + v, 0) / births.length) + 25
                                : e.x1;
        }
        const mx = X(mYear);
        const childX = e.px1, childY = bands.get(e.depth).top
          + findRowIndex(bands.get(e.depth), e) * ROW_H;
        gView.append('path').attr('class', 'tl-link')
          .attr('d', `M ${mx} ${bandBottom} C ${mx} ${bandBottom + 12}, ${childX} ${childY - 12}, ${childX} ${childY}`);
        // repère de mariage : petit trait orange
        gView.append('line').attr('class', 'tl-marry')
          .attr('x1', mx).attr('y1', bandBottom - 6)
          .attr('x2', mx).attr('y2', bandBottom + 2);
      }
    }

    /** Index de sous-ligne d'une entrée dans sa bande. */
    function findRowIndex(band, e) {
      for (let i = 0; i < band.rows.length; i++) {
        if (band.rows[i].includes(e)) return i;
      }
      return 0;
    }

    // ---------- boîtes ----------
    for (const d of depths) {
      const band = bands.get(d);
      band.rows.forEach((row, ri) => {
        const sel = gView.selectAll(null).data(row).join('g')
          .attr('class', 'tl-box')
          .attr('transform', (e) => `translate(${e.px1},${band.top + ri * ROW_H})`);

        sel.append('rect')
          .attr('width', (e) => e.px2 - e.px1)
          .attr('height', ROW_H - 4)
          .attr('rx', 3)
          .attr('class', (e) => {
            const cls = [e.person.sex === 'M' ? 'm' : e.person.sex === 'F' ? 'f' : null];
            if (e.id === currentRootId) cls.push('root');
            if (e.person.birth.status === 'estimated' || e.person.death.status === 'estimated') cls.push('est');
            if (e.alive) cls.push('alive');
            return cls.filter(Boolean).join(' ');
          });

        // nom si la place le permet
        sel.filter((e) => e.px2 - e.px1 > 34).append('text')
          .attr('x', 3).attr('y', ROW_H / 2 - 1)
          .text((e) => {
            const maxCh = Math.floor((e.px2 - e.px1 - 6) / 5.6);
            const s = ((e.person.name.given || '') + ' ' + (e.person.name.surname || '?').toUpperCase()).trim();
            return s.length > maxCh ? s.slice(0, maxCh - 1) + '…' : s;
          });

        sel.on('click', (event, e) => {
          log.debug('Clic frise sur ' + e.id);
          if (onSelectPerson) onSelectPerson(e.id);
        })
          .on('pointerover', (event, e) => {
            tip.html(buildTooltipHtml(e.person)).style('display', 'block');
            positionTip(event);
          })
          .on('pointermove', positionTip)
          .on('pointerout', () => tip.style('display', 'none'));
      });
    }

    svg.call(zoomBeh.transform, d3.zoomIdentity);   // vue non zoomée à chaque update
    log.info(`Frise chronologique : ${entries.length} boîte(s) sur ${depths.length} bande(s)`
      + `${skipped ? `, ${skipped} sans dates ignoré(es)` : ''}`);
  }

  log.info('Vue chronologique généalogique initialisée');
  return { update };
}