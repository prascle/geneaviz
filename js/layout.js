/**
 * layout.js — Layout chronologique familial partagé (frise 2D + vue 3D).
 *
 * Extrait de la vue chronologique (timeline.js) pour que la vue 3D
 * (view3d.js) réutilise EXACTEMENT le même placement — les deux vues ne
 * peuvent plus diverger par construction :
 *  - axe X = temps : une ligne va de la naissance au décès ;
 *  - descendants : couple empilé (mari au-dessus de l'épouse), enfants
 *    posés SOUS le couple, dans l'ordre de naissance (l'aîné en premier,
 *    donc le plus proche du couple) ; chaque enfant reçoit comme plancher
 *    le haut du précédent, puis est poussé vers le bas en cas de
 *    chevauchement temporel avec un bloc déjà posé ;
 *  - ascendants : chaque couple de parents est centré sur la ligne de son
 *    enfant — le père au-dessus (conflits vers le haut), la mère en
 *    dessous (conflits vers le bas), récursivement ;
 *  - branches d'édition M6a/M6b (fratrie, ascendants, descendants) :
 *    passes jusqu'à point fixe, solveur anti-chevauchement commun ;
 *  - liens émis en années + références de lignes posées : unions
 *    (kind 'marr') et filiations (kind 'fil', point de départ yFrom).
 *
 * Les métriques (hauteur de ligne, écarts) sont paramétrables : la frise
 * travaille en pixels (TL_METRICS), la vue 3D en unités monde.
 */
import { siblingIds, editPillColors, PILL_BASE_COLOR } from './edits.js';

/** Métriques canoniques de la vue chronologique (px). */
export const TL_METRICS = { rowH: 18, gapRow: 4, bandGap: 26 };

/** Bornes d'une vie ; null si aucune date exploitable. */
export function lifeYears(p, nowYear) {
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

/** Année de mariage heuristique : moyenne des naissances + 25 ans. */
function heuristicMarr(rows) {
  const b = rows.map((r) => r?.t1).filter((v) => v != null);
  return b.length ? Math.round(b.reduce((s, v) => s + v, 0) / b.length) + 25 : null;
}

/**
 * Crée un layout familial réutilisable (frise 2D et vue 3D).
 * @param {Object} options
 * @param {Object} options.index - index applicatif
 * @param {Function} [options.getEdits] - accès au registre d'éditions (M6)
 * @param {number} [options.upGen=3] - générations d'ascendants initiales
 * @param {number} [options.downGen=3] - générations de descendants initiales
 * @param {{rowH: number, gapRow: number, bandGap: number}}
 *   [options.metrics=TL_METRICS] - dimensions d'une ligne et écarts
 * @returns {{run: Function, setGenerations: Function}}
 */
export function createFamilyLayout({ index, getEdits = null, upGen = 3, downGen = 3,
                                     metrics = TL_METRICS }) {
  const { rowH, gapRow, bandGap } = metrics;
  const placed = [];          // blocs déjà posés (détection de chevauchements)
  const rowMap = new Map();   // id -> première ligne posée
  const allRows = [];         // lignes dans l'ordre de placement
  const links = [];           // liens émis (unions + filiations)
  let markEdited = false;     // lignes créées pendant une édition → contour
  let markPill = PILL_BASE_COLOR;   // couleur de pastille courante (édition)

  /** Ajoute la ligne d'un individu au bloc (mari inséré en tête). */
  function addPersonRow(node, p, nowYear) {
    if (!p) return null;
    const l = lifeYears(p, nowYear);
    if (!l) return null;
    const row = { id: p.id, person: p, gen: node.gen,
                  edited: markEdited,
                  pill: [markEdited ? markPill : PILL_BASE_COLOR], ...l };
    if (p.sex === 'M' && node.rows.length) node.rows.unshift(row);
    else node.rows.push(row);
    node.h = node.rows.length * rowH + (node.rows.length - 1) * gapRow;
    node.t1 = Math.min(node.t1, l.t1);
    node.t2 = Math.max(node.t2, l.t2);
    return row;
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

  /* ---------------- construction descendants ---------------- */

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

  /* ---------------- placement ---------------- */

  /** Chevauchement d'un bloc (y, h, t1..t2) avec un bloc déjà posé ? */
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
        y = c.yBot + gapRow;
      }
    }
    node.yTop = y;
    let ry = y;
    for (const r of node.rows) {
      r.y = ry;
      placed.push({ yTop: r.y, yBot: r.y + rowH, t1: r.t1, t2: r.t2, label: r.id });
      ry += rowH + gapRow;
    }
    const blockBottom = y + node.h;
    let prevTop = -Infinity;
    for (const sub of node.subs) {
      const start = Math.max(blockBottom + bandGap, prevTop);
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
        return l ? { id, person: index.getIndividual(id), gen,
                     edited: markEdited,
                     pill: [markEdited ? markPill : PILL_BASE_COLOR], ...l } : null;
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
        let y = childRow.y - bandGap - rowH, guard = 0, c;
        while ((c = conflicts(y, rowH, u.upRow.t1, u.upRow.t2)) && guard++ < 500) {
          y = c.yTop - rowH - gapRow;
        }
        u.upRow.y = y;
        placed.push({ yTop: y, yBot: y + rowH, t1: u.upRow.t1, t2: u.upRow.t2, label: u.upRow.id });
        placeAncestors(u.upRow.branch, u.upRow);
      }
      if (u.downRow) {
        let y = childRow.y + rowH + gapRow, guard = 0, c;
        while ((c = conflicts(y, rowH, u.downRow.t1, u.downRow.t2)) && guard++ < 500) {
          y = c.yBot + gapRow;
        }
        u.downRow.y = y;
        placed.push({ yTop: y, yBot: y + rowH, t1: u.downRow.t1, t2: u.downRow.t2, label: u.downRow.id });
        placeAncestors(u.downRow.branch, u.downRow);
      }
    }
  }

  /* ---------------- collecte / pastilles ---------------- */

  /** Empile une bande de couleur sur la pastille d'une ligne existante. */
  const addPillBand = (row, color) => {
    if (row && !row.pill.includes(color)) row.pill.push(color);
  };
  /** Première occurrence seulement (les unions partagées retouchent). */
  const collectInto = (row) => {
    if (row && !rowMap.has(row.id)) { rowMap.set(row.id, row); allRows.push(row); }
  };

  /* ---------------- émission des liens ---------------- */

  /** Repère d'union : trait vertical entre les deux lignes du couple. */
  const emitMarr = (rowA, rowB, marr, ids) => {
    if (!rowA || !rowB || marr == null) return;
    links.push({ kind: 'marr', year: marr, rowA, rowB, ids });
  };

  /** Filiation : du point d'union (année, hauteur yFrom) vers l'enfant. */
  const emitFil = (year, yFrom, childId, ids) => {
    const cr = rowMap.get(childId);
    if (!cr || year == null) return;
    links.push({ kind: 'fil', year, yFrom, childRow: cr, ids });
  };

  /* ---------------- passe complète ---------------- */

  /**
   * Calcule tout le layout pour la racine donnée.
   * @param {string} rootId - xref de la racine
   * @returns {{rows: Map, allRows: Array, links: Array,
   *            bounds: {minT: number, maxT: number,
   *                      minY: number, maxY: number}|null}}
   */
  function run(rootId) {
    placed.length = 0; rowMap.clear(); allRows.length = 0; links.length = 0;
    markEdited = false; markPill = PILL_BASE_COLOR;
    if (!rootId || !index.getIndividual(rootId)) {
      return { rows: rowMap, allRows, links, bounds: null };
    }
    const nowYear = new Date().getFullYear();
    const pillOf = editPillColors(getEdits ? getEdits() : []);

    // ---------- descendants : construction + placement ----------
    const downRoot = buildDown(rootId, 0, new Set());
    placeDown(downRoot, 0, 0);
    const collectDown = (n) => {
      n.rows.forEach(collectInto);
      n.subs.forEach(collectDown);
    };
    collectDown(downRoot);

    // ---------- ascendants symétriques : construction + placement ----------
    const ancUnits = buildUpAncestors(rootId, 0, new Set([rootId]));
    const rootRow = rowMap.get(rootId);
    if (rootRow) placeAncestors(ancUnits, rootRow);
    const collectAnc = (u) => {
      [u.upRow, u.downRow].forEach(collectInto);
      if (u.upRow) u.upRow.branch.forEach(collectAnc);
      if (u.downRow) u.downRow.branch.forEach(collectAnc);
    };
    ancUnits.forEach(collectAnc);

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
        markEdited = true;
        markPill = pillOf(e.pivot);
        const units = buildUpAncestors(e.pivot, 0, seen, e.depth, pivRow.gen);
        placeAncestors(units, pivRow);
        addPillBand(pivRow, markPill);
        markEdited = false;
        markPill = PILL_BASE_COLOR;
        units.forEach(collectAnc);
        ancUnits.push(...units);   // l'émission dessinera unions + filiations
        e._done = true; changed = true;
      }

      // ---------- descendants (M6b) ----------
      for (const e of (getEdits ? getEdits() : [])) {
        if (e.type !== 'down' || e._done) continue;
        const pivRow = rowMap.get(e.pivot);
        if (!pivRow) continue;
        const seen = new Set([...rowMap.keys()]);
        seen.delete(e.pivot);
        markEdited = true;
        markPill = pillOf(e.pivot);
        const node = buildDown(e.pivot, 0, seen, e.depth, pivRow.gen);
        markEdited = false;
        addPillBand(pivRow, markPill);
        markPill = PILL_BASE_COLOR;
        // nouveaux conjoints du pivot : sous sa ligne (solveur)
        let y = pivRow.y + rowH + gapRow;
        for (const r of node.rows) {
          if (rowMap.has(r.id)) continue;
          let guard = 0, c;
          while ((c = conflicts(y, rowH, r.t1, r.t2)) && guard++ < 500) y = c.yBot + gapRow;
          r.y = y;
          placed.push({ yTop: y, yBot: y + rowH, t1: r.t1, t2: r.t2, label: r.id });
          rowMap.set(r.id, r); allRows.push(r);
          y += rowH + gapRow;
        }
        // enfants : blocs sous le couple
        let cursor = y + bandGap;
        for (const sub of node.subs) {
          placeDown(sub, cursor, cursor);
          cursor = (sub.yBot ?? cursor) + bandGap;
        }
        const collectSub = (n) => {
          n.rows.forEach(collectInto);
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
        markPill = pillOf(e.pivot);
        addPillBand(pivRow, markPill);
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
                           gen: pivRow.gen - 1, edited: true,
                           pill: [markPill], ...l } : null;
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
            [u.upRow, u.downRow].forEach(collectInto);
            ancUnits.push(u);   // l'émission dessinera union + filiation
            parentsUnit = u;
            break;
          }
        }
        let cursor = pivRow.y + rowH + gapRow;
        for (const k of siblingIds(index, e.pivot)) {
          if (rowMap.has(k)) continue;
          const kp = index.getIndividual(k);
          const unit = { personId: k, rows: [], smarr: null };
          const kl = lifeYears(kp, nowYear);
          if (kl) unit.rows.push({ id: k, person: kp, gen: pivRow.gen, edited: true, pill: [markPill], ...kl });
          for (const sfid of kp.familyAsSpouse) {
            const sf = index.getFamily(sfid);
            if (!sf) continue;
            const sid = sf.husband === k ? sf.wife : sf.husband;
            if (!sid || rowMap.has(sid) || !index.getIndividual(sid)) continue;
            const sp = index.getIndividual(sid);
            const sl = lifeYears(sp, nowYear);
            if (!sl) continue;
            const srow = { id: sid, person: sp, gen: pivRow.gen, edited: true, pill: [markPill], ...sl };
            if (sp.sex === 'M') unit.rows.unshift(srow); else unit.rows.push(srow);
            if (unit.smarr == null) unit.smarr = sf.marriage.value?.year ?? null;
          }
          if (!unit.rows.length) continue;
          // placement avec solveur anti-chevauchement, sous la ligne du pivot
          const h = unit.rows.length * rowH + (unit.rows.length - 1) * gapRow;
          const t1 = Math.min(...unit.rows.map((r) => r.t1));
          const t2 = Math.max(...unit.rows.map((r) => r.t2));
          let y = cursor, guard = 0, c;
          while ((c = conflicts(y, h, t1, t2)) && guard++ < 500) y = c.yBot + gapRow;
          let ry = y;
          for (const r of unit.rows) {
            r.y = ry;
            placed.push({ yTop: r.y, yBot: r.y + rowH, t1: r.t1, t2: r.t2, label: r.id });
            rowMap.set(r.id, r); allRows.push(r);
            ry += rowH + gapRow;
          }
          cursor = y + h + bandGap;
          sibPlacements.push({ unit, parentsUnit });
        }
        markPill = PILL_BASE_COLOR;
        e._done = true; changed = true;
      }

      if (!changed) break;
    }

    // ---------- liens : unions + filiations ----------
    // descendants : union du couple + filiation vers chaque sous-arbre
    (function walkDown(node) {
      const mainRow = node.rows.find((r) => r.id === node.pid) ?? node.rows[0];
      for (const u of node.unions) {
        const marr = u.marr ?? heuristicMarr([mainRow, u.spouseRow]);
        emitMarr(mainRow, u.spouseRow, marr,
          [mainRow?.id, u.spouseRow?.id].filter(Boolean));
      }
      for (const sub of node.subs) {
        const pu = sub.parentUnion;
        const marr = pu.marr ?? heuristicMarr([mainRow, pu.spouseRow]);
        if (marr != null && mainRow) {
          const yFrom = pu.spouseRow
            ? (mainRow.y + pu.spouseRow.y) / 2 + rowH / 2
            : mainRow.y + node.h;
          emitFil(marr, yFrom, sub.pid,
            [mainRow.id, pu.spouseRow?.id, sub.pid].filter(Boolean));
        }
        walkDown(sub);
      }
    })(downRoot);

    // ascendants : union du couple + filiation vers l'enfant
    const walkAnc = (u) => {
      const ids = [u.upRow?.id, u.downRow?.id, u.childId].filter(Boolean);
      const marr = u.marr ?? heuristicMarr([u.upRow, u.downRow]);
      if (marr != null) {
        if (u.upRow && u.downRow) {
          emitMarr(u.upRow, u.downRow, marr, ids);
        }
        const r = u.upRow ?? u.downRow;
        if (r) {
          const midY = u.upRow && u.downRow
            ? (u.upRow.y + u.downRow.y) / 2 + rowH / 2
            : r.y + rowH / 2;
          emitFil(marr, midY, u.childId, ids);
        }
      }
      if (u.upRow) u.upRow.branch.forEach(walkAnc);
      if (u.downRow) u.downRow.branch.forEach(walkAnc);
    };
    ancUnits.forEach(walkAnc);

    // branches fratrie ajoutées : union du couple + filiation
    // depuis le mariage des parents du pivot (si affichés)
    for (const { unit, parentsUnit } of sibPlacements) {
      if (unit.rows.length === 2) {
        const marr = unit.smarr ?? heuristicMarr(unit.rows);
        emitMarr(unit.rows[0], unit.rows[1], marr,
          [unit.rows[0].id, unit.rows[1].id]);
      }
      if (parentsUnit) {
        const ids = [parentsUnit.upRow?.id, parentsUnit.downRow?.id,
                     unit.personId].filter(Boolean);
        const marr = parentsUnit.marr
          ?? heuristicMarr([parentsUnit.upRow, parentsUnit.downRow].filter(Boolean));
        if (marr != null) {
          const midY = parentsUnit.upRow && parentsUnit.downRow
            ? (parentsUnit.upRow.y + parentsUnit.downRow.y) / 2 + rowH / 2
            : (parentsUnit.upRow ?? parentsUnit.downRow).y + rowH / 2;
          emitFil(marr, midY, unit.personId, ids);
        }
      }
    }

    // branches descendants ajoutées : unions + filiations (M6b)
    // récursif : le placement (placeDown) descend dans les sous-arbres,
    // l'émission des liens doit faire de même — sinon les liens des
    // niveaux 2+ (petits-enfants d'un ajout) ne sont jamais émis
    const walkExtraDown = (n) => {
      const mainRow = rowMap.get(n.pid) ?? rowMap.get(n.rows[0]?.id);
      if (!mainRow) return;
      for (const u of n.unions) {
        const sr = u.spouseRow && rowMap.has(u.spouseRow.id) ? u.spouseRow : null;
        const marr = u.marr ?? heuristicMarr([mainRow, sr]);
        emitMarr(mainRow, sr, marr, [mainRow.id, sr?.id].filter(Boolean));
      }
      for (const sub of n.subs) {
        const pu = sub.parentUnion;
        const sr = pu.spouseRow && rowMap.has(pu.spouseRow.id) ? pu.spouseRow : null;
        const marr = pu.marr ?? heuristicMarr([mainRow, sr]);
        if (marr != null) {
          const yFrom = sr ? (mainRow.y + sr.y) / 2 + rowH / 2 : mainRow.y + rowH;
          emitFil(marr, yFrom, sub.pid,
            [mainRow.id, sr?.id, sub.pid].filter(Boolean));
        }
        walkExtraDown(sub);
      }
    };
    for (const node of extraDownNodes) walkExtraDown(node);

    // ---------- bornes ----------
    let minT = Infinity, maxT = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of allRows) {
      minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + rowH);
      minT = Math.min(minT, r.t1); maxT = Math.max(maxT, r.t2);
    }
    const bounds = allRows.length ? { minT, maxT, minY, maxY } : null;
    return { rows: rowMap, allRows, links, bounds };
  }

  return {
    run,
    setGenerations: (u, d) => { upGen = u; downGen = d; },
  };
}
