/**
 * view3d.js — Vue 3D (M7a/M7b) : graphe Three.js sur plans d'édition.
 *
 * Axes : oX = temps (comme la vue chrono), oY = générations (ascendants
 * au-dessus de la racine, descendants en dessous), oZ = profondeur : les
 * branches introduites par une édition (M6a/M6b) vivent sur des plans
 * parallèles décalés — un plan par pivot d'édition, dans l'ordre de
 * création, tous derrière le plan de base (z = 0) ; chaque plan est
 * teinté de la couleur de sa pastille et matérialisé par une surface
 * translucide. Le placement oX/oY est calculé par le module partagé
 * layout.js — exactement celui de la vue chronologique.
 *  - chaque individu = barre temporelle (naissance → décès, flèche si
 *    vivant présumé), couleurs identiques aux vues 2D (sexe, racine,
 *    dates estimées translucides) ;
 *  - pastille = cube de couleur à droite de la barre (palette edits.js) ;
 *  - étiquette = texture texte appliquée sur les faces de la barre (nom +
 *    dates sur une seule ligne, le long de la barre) ; l'infobulle de survol
 *    reste le recours quand la texture est trop petite pour être lue ;
 *  - liens de filiation / repères de mariage = lignes épaisses (Line2/
 *    LineMaterial, M9a : épaisseur réglable, grossies au survol, en
 *    diagonale entre plans) ;
 *  - grille des années au « sol », presets caméra (frise / dessus /
 *    perspective), OrbitControls (rotation, zoom, pan) ;
 *  - panneau de réglages (M7b/M9a/M9b) : épaisseur des barres, écarts
 *    couple / couple-enfants, échelle du temps, épaisseur des liens,
 *    brouillard de profondeur (bornes recalculées par rapport à la
 *    caméra), bascule caméra perspective ↔ orthographique.
 * Interactions : clic gauche = détail, clic droit = menu contextuel,
 * double-clic = viser l'individu, survol = surbrillance de famille,
 * clic sur la surface d'un plan d'édition = isoler ce plan (M9b : les
 * autres plans sont estompés), clic sur le fond = tous rétablir.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { logger } from './logger.js';
import { PILL_BASE_COLOR, editPillColors } from './edits.js';
import { createFamilyLayout } from './layout.js';
import { buildTooltipHtml } from './tooltip.js';

const log = logger('view3d');

/** Dimensions du monde (unités arbitraires). */
const MIN_BAR_W = 26;    // largeur minimale d'une barre
const BAR_D = 8;         // profondeur d'une barre (oZ)
const LINK_COL = 0x94a3b8;
const MARR_COL = 0xb45309;
const PLANE_GAP = 60;    // écart entre plans d'édition le long de oZ (M7b)

/** Réglages utilisateur (panneau M7b/M9a, ajustables à l'exécution). */
const settings = {
  barH: 15,     // épaisseur verticale d'une barre (métrique layout rowH)
  gapRow: 5,    // écart entre les barres d'un couple (métrique layout)
  bandGap: 18,  // écart entre un couple et ses enfants (métrique layout)
  yearW: 8,     // largeur d'une année (échelle du temps)
  linkW: 2,     // épaisseur des liens de mariage/filiation (px CSS)
  fog: 0,       // brouillard de profondeur, 0 (off) à 100 (fort)
};

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
 * Initialise la vue 3D.
 * @param {Object} options
 * @param {HTMLElement} options.container - élément hôte
 * @param {Object} options.index - index applicatif
 * @param {number} [options.upGen=3] - générations d'ascendants
 * @param {number} [options.downGen=3] - générations de descendants
 * @param {Function} [options.onSelectPerson] - callback clic gauche
 * @param {Function} [options.onContextPerson] - callback clic droit
 * @param {Function} [options.getEdits] - registre d'éditions (M6/M7b)
 * @returns {{update: Function, setGenerations: Function, reset: Function}}
 */
export function initView3d({ container, index, upGen = 3, downGen = 3,
                            onSelectPerson, onContextPerson, getEdits }) {
  container.innerHTML = '';
  let currentRootId = null;

  /* ------------------- scène ------------------- */

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  Object.assign(renderer.domElement.style,
    { width: '100%', height: '100%', display: 'block' });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  scene.fog = new THREE.Fog(0xffffff, 2000, 9000);

  const FOV = 50;    // champ de la perspective — référence du cadrage (M9b)
  const perspCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50000);
  // Frustum orthographique recalé à la volée (M9b) : bornes unitaires
  // ici, syncFrustum() y applique le cadrage de la perspective.
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
  let camera = perspCam;   // caméra active (bascule du panneau Réglages)

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  /**
   * Recale le frustum orthographique (M9b) sur le cadrage qu'aurait la
   * perspective à la même distance : demi-hauteur = tan(fov/2) ×
   * distance, demi-largeur = demi-hauteur × aspect du cadre. Appelée à
   * la bascule, au resize (aspect) et aux presets (distance) — jamais
   * au pan ni au zoom molette en ortho (OrbitControls joue alors sur
   * camera.zoom, indépendant du frustum : la taille apparente est
   * stable, comme attendu en orthographique).
   */
  function syncFrustum() {
    const d = orthoCam.position.distanceTo(controls.target);
    const h = Math.tan((FOV * Math.PI / 180) / 2) * d;
    const w = h * (container.clientWidth || 1) / (container.clientHeight || 1);
    orthoCam.left = -w; orthoCam.right = w;
    orthoCam.top = h; orthoCam.bottom = -h;
    orthoCam.updateProjectionMatrix();
  }

  /** Bascule perspective ↔ orthographique (M9b) — même point de vue. */
  function setOrtho(on) {
    const to = on ? orthoCam : perspCam;
    if (camera === to) return;
    to.position.copy(camera.position);
    to.quaternion.copy(camera.quaternion);
    to.zoom = 1;
    camera = to;
    controls.object = camera;
    if (on) syncFrustum();
    controls.update();
    log.info('Vue 3D : caméra ' + (on ? 'orthographique' : 'perspective'));
  }

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(500, 900, 700);
  scene.add(dir);

  const content = new THREE.Group();   // tout le graphe (vidé à chaque update)
  scene.add(content);

  /** Barres interactives (picking). */
  let bars = [];

  /** Surfaces translucides des plans d'édition (picking M9b). */
  let planeSurfs = [];

  /**
   * Isolation de plan (M9b) : undefined = aucune, null = plan de base,
   * sinon l'id du pivot du plan isolé. Conservée d'un rendu à l'autre
   * (panneau Réglages) ; annulée si le plan isolé disparaît.
   */
  let isolated = undefined;

  /** Lignes et plans du dernier rendu (API planeOf/planeCount, M9b). */
  let lastRows = new Map();
  let planePivots = new Set();

  /** Matériaux des liens épais (Line2) : résolution à suivre au resize. */
  const linkMats = [];

  /** Largeur d'un lien en pixels du tampon de rendu (px CSS × pixelRatio). */
  const linkWidth = () => settings.linkW * renderer.getPixelRatio();

  /** Crée un lien épais (mariage ou filiation, polyligne quelconque). */
  function makeLink(points, color) {
    const geo = new LineGeometry().setPositions(
      points.flatMap((v) => [v.x, v.y, v.z]));
    const mat = new LineMaterial({
      color, transparent: true, linewidth: linkWidth() });
    const c = renderer.domElement;
    mat.resolution.set(c.width, c.height);
    linkMats.push(mat);
    return new Line2(geo, mat);
  }

  /** Resynchronise la résolution des liens après un resize. */
  const syncLinkRes = () => {
    const c = renderer.domElement;
    for (const m of linkMats) m.resolution.set(c.width, c.height);
  };

  /**
   * Brouillard de profondeur (M9a) : bornes recalculées par rapport à la
   * distance caméra-cible pour que le réglage reste cohérent au zoom.
   * 0 = désactivé (repoussé à l'infini) ; 100 = brume marquée.
   */
  function applyFog() {
    const f = settings.fog / 100;
    if (f <= 0) { scene.fog.near = 1e9; scene.fog.far = 1e9 + 1; return; }
    const d = camera.position.distanceTo(controls.target);
    scene.fog.near = Math.max(1, d * (1 - 0.35 * f));
    scene.fog.far = d * (1 + 2.2 * f);
  }

  /* ------------------- presets caméra ------------------- */

  const presets = document.createElement('div');
  presets.id = 'view3d-presets';
  for (const [label, fn] of [['Frise', () => setCamera('face')],
                             ['Dessus', () => setCamera('top')],
                             ['Persp.', () => setCamera('iso')]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    presets.appendChild(b);
  }
  container.appendChild(presets);

  /* ------------------- panneau de réglages (M7b/M9a) ------------------- */

  // Réglages de layout (M7b) : recalcule tout le placement partagé.
  // Réglages de rendu (M9a) : appliqués sans relayout — épaisseur des
  // liens (Line2) et brouillard de profondeur.
  const panel = document.createElement('details');
  panel.id = 'view3d-settings';
  panel.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Réglages';
  panel.appendChild(summary);

  /** Applique un réglage après changement du slider correspondant. */
  function applySetting(key) {
    if (key === 'barH' || key === 'gapRow' || key === 'bandGap'
        || key === 'yearW') {
      layout.setMetrics({
        rowH: settings.barH, gapRow: settings.gapRow, bandGap: settings.bandGap });
      update(currentRootId);
    } else if (key === 'linkW') {
      const w = linkWidth();
      content.traverse((o) => {
        if (o.userData?.lw0 == null) return;
        o.userData.lw0 = w;
        o.material.linewidth = w;
      });
      applyLook();   // re-surbrillance / isolation après changement d'épaisseur
    } else if (key === 'fog') {
      applyFog();
    }
  }

  for (const [key, label, min, max, step] of [
    ['barH', 'Épaisseur barres', 6, 30, 1],
    ['gapRow', 'Écart couple', 2, 20, 1],
    ['bandGap', 'Écart couple–enfants', 5, 60, 1],
    ['yearW', 'Échelle du temps', 1, 20, 0.5],
    ['linkW', 'Épaisseur des liens', 0.5, 6, 0.5],
    ['fog', 'Brouillard (profondeur)', 0, 100, 1],
  ]) {
    const row = document.createElement('div');
    row.className = 'v3d-set-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const val = document.createElement('span');
    val.textContent = String(settings[key]);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(settings[key]);
    input.addEventListener('input', () => { val.textContent = input.value; });
    input.addEventListener('change', () => {
      settings[key] = parseFloat(input.value);
      applySetting(key);
    });
    row.append(lab, val, input);
    panel.appendChild(row);
  }
  // Bascule de caméra (M9b) : perspective ↔ orthographique.
  {
    const row = document.createElement('div');
    row.className = 'v3d-set-row';
    const lab = document.createElement('label');
    lab.textContent = 'Caméra orthographique';
    const val = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => setOrtho(input.checked));
    row.append(lab, val, input);
    panel.appendChild(row);
  }
  container.appendChild(panel);

  /* ------------------- infobulle ------------------- */

  const tipHost = document.getElementById('workspace') ?? document.body;
  let tipEl = tipHost.querySelector('div.tree-tip');
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tree-tip';
    tipHost.appendChild(tipEl);
  }
  const showTip = (person) => {
    tipEl.innerHTML = buildTooltipHtml(index, person);   // identique à la frise
    tipEl.style.display = 'block';
    tipEl.style.left = '12px';
    tipEl.style.top =
      Math.max(12, window.innerHeight - tipEl.offsetHeight - 12) + 'px';
  };
  const hideTip = () => { tipEl.style.display = 'none'; };

  /* ------------------- layout partagé (layout.js) ------------------- */

  // Placement identique à la vue chronologique par construction : le module
  // partagé gère couples (mari au-dessus de l'épouse), enfants sous le
  // couple dans l'ordre de naissance, parents centrés sur la ligne de leur
  // enfant, solveur anti-chevauchement et branches d'édition M6a/M6b.
  // La 3D fournit ses métriques en unités monde (barres épaisses) ; une
  // ligne de layout [y, y+barH] correspond exactement à une barre.
  // ATTENTION : le layout travaille en coordonnées écran (y vers le bas,
  // comme le SVG de la frise) alors que l'axe oY de Three.js pointe vers le
  // haut — tout y est donc retourné au moment du dessin (Y = -(y + h/2)).
  const layout = createFamilyLayout({
    index, getEdits, upGen, downGen,
    metrics: { rowH: settings.barH, gapRow: settings.gapRow, bandGap: settings.bandGap },
  });

  /* ------------------- rendu ------------------- */

  /** Nettoie le contenu (géométries, matériaux, textures). */
  function clearContent() {
    content.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? [].concat(o.material) : [];
      for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
    });
    content.clear();
    bars = [];
    planeSurfs = [];
    lastRows = new Map();
    planePivots = new Set();
    linkMats.length = 0;
  }

  /** Sprite texte générique (billboard). */
  function makeSprite(lines, opts = {}) {
    const w = opts.w ?? 512, h = opts.h ?? 128;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    let y = 0;
    for (const ln of lines) {
      g.font = ln.font;
      g.fillStyle = ln.color;
      y += ln.dy;
      g.fillText(ln.text, w / 2, y);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true }));
    spr.scale.set(opts.scaleW ?? 140, opts.scaleH ?? 35, 1);
    spr.userData.op0 = 1;
    return spr;
  }

  /** Texture d'étiquette peinte sur les faces de la barre : nom + dates
   *  sur une seule ligne (fond pâle selon le sexe, liseré bleu = racine,
   *  dates ambre si estimées). Le canvas respecte l'aspect de la face
   *  (même échelle px/unité en x et y) : les caractères gardent leurs
   *  proportions en vue « Frise », quelle que soit la longueur de la
   *  barre ; le texte est tronqué si la barre est trop courte. */
  function makeBarTexture(row, wWorld) {
    const ppu = Math.min(16, 4096 / Math.max(wWorld, 1)); // px par unité monde
    const w = Math.max(24, Math.round(wWorld * ppu));
    const h = Math.max(24, Math.round(settings.barH * ppu));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const sex = row.person.sex;
    g.fillStyle = sex === 'M' ? '#dbeafe' : sex === 'F' ? '#fce7f3' : '#eef2f7';
    g.fillRect(0, 0, w, h);
    if (row.id === currentRootId) {           // liseré bleu autour de la barre racine
      g.strokeStyle = '#2563eb';
      g.lineWidth = Math.max(2, Math.round(h * 0.09));
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2,
        w - g.lineWidth, h - g.lineWidth);
    }
    const name = `${(row.person.name.surname || '?').toUpperCase()} ` +
      `${row.person.name.given}`.trim();
    const dates = (row.est ? '≈ ' : '') + row.t1 +
      (row.alive ? ' →' : ' – ' + row.t2);
    g.textBaseline = 'middle';
    const pad = Math.round(h * 0.22);
    // nom à gauche, dates à droite, sur la même ligne
    g.textAlign = 'left';
    g.font = `bold ${Math.round(h * 0.62)}px system-ui, sans-serif`;
    g.fillStyle = '#1f2937';
    g.fillText(name, pad, h / 2, w * 0.58);
    g.textAlign = 'right';
    g.font = `${Math.round(h * 0.54)}px system-ui, sans-serif`;
    g.fillStyle = row.est ? '#b45309' : '#555';
    g.fillText(dates, w - pad, h / 2, w * 0.38);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /** Dessine le graphe pour la racine donnée. */
  function update(rootId) {
    currentRootId = rootId;
    clearContent();
    hideTip();
    hovered = null;
    if (!rootId || !index.getIndividual(rootId)) return;
    const L = layout.run(rootId);
    const rows = L.rows;
    const links = L.links;
    if (!rows.size) { log.info('Vue 3D : aucune date exploitable'); return; }
    for (const r of rows.values()) {   // temps (années) → unités monde
      r.x1 = r.t1 * settings.yearW;
      r.x2 = r.t2 * settings.yearW;
    }

    // ---------- plans d'édition (M7b) : un plan oZ par pivot ----------
    // Ordre de création des éditions, tous derrière le plan de base.
    // Les individus déjà affichés dans le plan de base y restent (le
    // layout garantit « première occurrence ») ; les lignes introduites
    // par une édition rejoignent le plan de leur pivot (r.pivot).
    const pillOf = editPillColors(getEdits ? getEdits() : []);
    const planeIdx = new Map();
    for (const e of (getEdits ? getEdits() : [])) {
      if (!planeIdx.has(e.pivot)) planeIdx.set(e.pivot, planeIdx.size);
    }
    const usedPivots = new Set();
    let zMin = 0;
    for (const r of rows.values()) {
      const idx = r.pivot != null ? planeIdx.get(r.pivot) : undefined;
      if (idx != null) {
        r.z = -PLANE_GAP * (idx + 1);
        usedPivots.add(r.pivot);
        zMin = Math.min(zMin, r.z);
      } else {
        r.z = 0;
      }
    }
    planePivots = new Set(usedPivots);
    lastRows = rows;
    if (isolated !== undefined && isolated !== null
        && !usedPivots.has(isolated)) {
      isolated = undefined;   // le plan isolé a disparu (édition retirée)
    }

    // bornes du contenu (y retourné : oY Three pointe vers le haut)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rows.values()) {
      const cy = -(r.y + settings.barH / 2);   // centre de la barre en monde
      minX = Math.min(minX, r.x1); maxX = Math.max(maxX, r.x2);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    }

    // ---------- grille des années au sol ----------
    const floorY = minY - 44;
    const minT = Math.floor(minX / settings.yearW),
          maxT = Math.ceil(maxX / settings.yearW);
    const span = maxT - minT;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) {
      const x = t * settings.yearW;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, floorY, Math.min(-70, zMin - 50)),
        new THREE.Vector3(x, floorY, 70)]);
      const line = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0xdbe2ea }));
      content.add(line);
      const spr = makeSprite(
        [{ text: String(t), font: 'bold 40px system-ui, sans-serif', color: '#94a3b8', dy: 46 }],
        { w: 256, h: 64, scaleW: 46, scaleH: 12 });
      spr.position.set(x, floorY + 8, 76);
      content.add(spr);
    }

    // ---------- surfaces translucides des plans d'édition (M7b) ----------
    // Une surface par plan réellement utilisé, teintée de la couleur de
    // la pastille du pivot (remplissage très pâle + contour), ajoutée
    // AVANT les barres (pas de userData.ids : jamais grisées au survol ;
    // M9b : userData.plane, pickables pour isoler le plan au clic).
    const padX = 40, padY = 30;
    for (const piv of usedPivots) {
      let px1 = Infinity, px2 = -Infinity, py1 = Infinity, py2 = -Infinity;
      for (const r of rows.values()) {
        if (r.pivot !== piv) continue;
        px1 = Math.min(px1, r.x1); px2 = Math.max(px2, r.x2);
        py1 = Math.min(py1, r.y); py2 = Math.max(py2, r.y + settings.barH);
      }
      const w = (px2 + padX) - (px1 - padX);
      const h = (py2 + padY) - (py1 - padY);
      const z = -PLANE_GAP * (planeIdx.get(piv) + 1);
      const col = new THREE.Color(pillOf(piv));
      const geo = new THREE.PlaneGeometry(w, h);
      const surf = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: col, transparent: true, opacity: 0.05,
        depthWrite: false, side: THREE.DoubleSide }));
      surf.position.set((px1 + px2) / 2, -(py1 + py2) / 2, z);
      surf.userData = { plane: piv, surf: true, op0: 0.05 };   // pickable (M9b)
      content.add(surf);
      planeSurfs.push(surf);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.35 }));
      edges.position.copy(surf.position);
      edges.userData = { plane: piv, edges: true, op0: 0.35 };
      content.add(edges);
    }

    // ---------- barres + pastilles + étiquettes ----------
    for (const r of rows.values()) {
      const w = Math.max(r.x2 - r.x1, MIN_BAR_W);
      // étiquette = texture sur les faces de la barre (le fond pâle de la
      // texture remplace la teinte pleine par sexe des débuts de M7a)
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff, map: makeBarTexture(r, w),
        transparent: true, opacity: r.est ? 0.72 : 1 });
      if (r.id === currentRootId) mat.emissive = new THREE.Color(0x1d4ed8);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, settings.barH, BAR_D), mat);
      mesh.position.set(r.x1 + w / 2, -(r.y + settings.barH / 2), r.z);   // y retourné
      mesh.userData = { row: r, ids: [r.id], op0: mat.opacity,
                         plane: r.pivot ?? null };
      content.add(mesh);
      bars.push(mesh);

      // flèche « vivant·e présumé·e » : à droite de la pastille (plus
      // petite que la barre, transparente pour suivre le grisé au survol)
      if (r.alive) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(settings.barH * 0.4, 7, 12),
          new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true }));
        cone.rotation.z = -Math.PI / 2;
        cone.position.set(r.x2 + 12, -(r.y + settings.barH / 2), r.z);
        cone.userData = { ids: [r.id], op0: 1, plane: r.pivot ?? null };
        content.add(cone);
      }

      // pastille(s) : cube(s) de couleur à droite de la barre, à gauche
      // du cône des vivant·e·s (transparent : suit le grisé au survol)
      const pc = r.pill ?? [PILL_BASE_COLOR];
      const n = pc.length;
      pc.forEach((cHex, i) => {
        const bh = settings.barH / n;
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(4.5, bh, 4.5),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(cHex),
                                        transparent: true }));
        cube.position.set(r.x2 + 5, -(r.y + bh / 2 + i * bh), r.z);
        cube.userData = { ids: [r.id], op0: 1, plane: r.pivot ?? null };
        content.add(cube);
      });
    }

    // ---------- repères de mariage + filiations (émis par layout.js) ----------
    // Liens épais (Line2/LineMaterial, M9a) : diagonales quand les
    // extrémités sont sur des plans différents (M7b) — le mariage relie
    // les z des deux conjoints, la filiation part du z moyen des lignes
    // du couple source. lw0 = épaisseur de référence (surbrillance au
    // survol : ×2,5 sur les liens de la famille).
    for (const l of links) {
      const x = l.year * settings.yearW;
      if (l.kind === 'marr') {
        const line = makeLink([
          new THREE.Vector3(x, -(l.rowA.y + settings.barH / 2), l.rowA.z),
          new THREE.Vector3(x, -(l.rowB.y + settings.barH / 2), l.rowB.z)],
          MARR_COL);
        line.userData = { ids: l.ids, op0: 1, lw0: linkWidth(),
          planes: [l.rowA.pivot ?? null, l.rowB.pivot ?? null] };
        content.add(line);
      } else {
        const cr = l.childRow;
        if (!cr) continue;
        const cy = -(cr.y + settings.barH / 2);   // centre de la barre enfant (retourné)
        const yFrom = -l.yFrom;
        const fromRows = (l.fromRows ?? []).filter(Boolean);
        const zFrom = fromRows.length
          ? fromRows.reduce((s, fr) => s + fr.z, 0) / fromRows.length
          : cr.z;
        const line = makeLink([
          new THREE.Vector3(x, yFrom, zFrom),
          new THREE.Vector3(x, (yFrom + cy) / 2, (zFrom + cr.z) / 2),
          new THREE.Vector3(cr.x1 + 12, cy, cr.z)], LINK_COL);
        line.userData = { ids: l.ids, op0: 1, lw0: linkWidth(),
          planes: [...fromRows.map((fr) => fr.pivot ?? null), cr.pivot ?? null] };
        content.add(line);
      }
    }

    applyLook();   // état d'isolation conservé d'un rendu à l'autre (M9b)
    setCamera('face');
    log.info(`Vue 3D : ${rows.size} individu(s), ${links.length} lien(s)` +
      (usedPivots.size ? `, ${usedPivots.size} plan(s) d'édition` : '') +
      ` (${upGen} gén. ascendants, ${downGen} gén. descendants)`);
  }

  /* ------------------- caméra ------------------- */

  const contentBox = () => {
    const box = new THREE.Box3().setFromObject(content);
    const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
    const size = box.isEmpty() ? new THREE.Vector3(100, 60, 10) : box.getSize(new THREE.Vector3());
    return { c, size };
  };
  const fitDist = (size) =>
    Math.max(size.x, size.y * 1.6, 150) * 1.15 /
    (2 * Math.tan((FOV * Math.PI / 180) / 2));

  /** Place la caméra selon un preset (frise / dessus / perspective). */
  function setCamera(preset) {
    const { c, size } = contentBox();
    const d = fitDist(size);
    if (preset === 'top') {
      camera.position.set(c.x, c.y + d, 0.001);
    } else if (preset === 'iso') {
      camera.position.set(c.x + size.x * 0.35, c.y + size.y * 0.45 + d * 0.2, d * 0.85);
    } else {
      camera.position.set(c.x, c.y, d);
    }
    controls.target.copy(c);
    controls.update();
    if (camera === orthoCam) syncFrustum();   // cadrage à la nouvelle distance
  }

  /* ------------------- interactions ------------------- */

  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hovered = null;
  let downX = 0, downY = 0;   // départ du pointerdown (clic vs rotation)

  const castAt = (ev, objects) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hits = ray.intersectObjects(objects, false);
    return hits.length ? hits[0].object : null;
  };

  const pick = (ev) => {
    const o = castAt(ev, bars);
    return o ? o.userData.row : null;
  };
  const pickPlane = (ev) => {
    const o = castAt(ev, planeSurfs);
    return o ? o.userData.plane : null;
  };

  /** Le plan de l'objet est-il actif ? (M9b : isolation de plan) */
  function planeActive(o) {
    if (isolated === undefined) return true;
    if (o.userData.plane !== undefined) return o.userData.plane === isolated;
    if (o.userData.planes) return o.userData.planes.includes(isolated);
    return true;
  }

  /**
   * Recalcule l'aspect de tout le contenu — un seul endroit, appelé au
   * survol comme à l'isolation. Survol : surbrillance de famille, liens
   * épaissis (M9a), le reste estompé (opacité 0,1). Isolation (M9b) :
   * les objets des autres plans sont estompés (opacité 0,07) —
   * prioritaire sur le survol ; les surfaces de plans suivent (plan
   * isolé renforcé, autres plans quasi effacés).
   */
  function applyLook() {
    const fam = hovered ? familySet(index, hovered.person) : null;
    content.traverse((o) => {
      if (!o.material) return;
      const ud = o.userData;
      if (ud.surf || ud.edges) {   // plans d'édition (jamais au survol)
        o.material.opacity = isolated === undefined ? ud.op0
          : planeActive(o) ? (ud.surf ? 0.1 : 0.55)
          : (ud.surf ? 0.015 : 0.05);
        return;
      }
      if (!ud.ids) return;
      const act = planeActive(o);
      const inFam = !!fam && ud.ids.every((i) => fam.has(i));
      o.material.opacity = !act ? Math.min(ud.op0, 0.07)
        : fam && !inFam ? 0.1 : ud.op0;
      if (ud.lw0 != null) {
        o.material.linewidth = inFam && act ? ud.lw0 * 2.5 : ud.lw0;
      }
    });
  }

  renderer.domElement.addEventListener('pointermove', (ev) => {
    const hit = pick(ev);
    if (hit !== hovered) {
      hovered = hit;
      if (hit) showTip(hit.person);
      else hideTip();
      applyLook();
    }
    renderer.domElement.style.cursor = hit ? 'pointer'
      : planeSurfs.length && pickPlane(ev) != null ? 'pointer' : '';
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    hovered = null; hideTip(); applyLook();
    renderer.domElement.style.cursor = '';
  });
  renderer.domElement.addEventListener('pointerdown', (ev) => {
    downX = ev.clientX; downY = ev.clientY;
  });
  renderer.domElement.addEventListener('click', (ev) => {
    const hit = pick(ev);
    if (hit) {
      if (onSelectPerson) onSelectPerson(hit.person.id);
      return;
    }
    // M9b : clic (pas une rotation terminée) sur la surface d'un plan =
    // isoler ce plan ; clic sur le fond = rétablir tous les plans.
    if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
    const plane = pickPlane(ev);
    if (plane != null) {
      isolated = plane;
      applyLook();
      log.info('Vue 3D : plan isolé (pivot ' + plane + ')');
    } else if (isolated !== undefined) {
      isolated = undefined;
      applyLook();
      log.info('Vue 3D : tous les plans rétablis');
    }
  });
  renderer.domElement.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const hit = pick(ev);
    if (hit && onContextPerson) onContextPerson(hit.person, ev);
  });
  renderer.domElement.addEventListener('dblclick', (ev) => {
    const hit = pick(ev);
    if (hit) {
      controls.target.set((hit.x1 + hit.x2) / 2, -(hit.y + settings.barH / 2), hit.z);
      controls.update();
    }
  });

  /* ------------------- boucle + redimensionnement ------------------- */

  const resize = () => {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 400;
    renderer.setSize(w, h);
    perspCam.aspect = w / h;
    perspCam.updateProjectionMatrix();
    if (camera === orthoCam) syncFrustum();   // aspect du frustum (M9b)
    syncLinkRes();
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(container);
  }
  window.addEventListener('resize', resize);
  resize();

  const loop = () => {
    requestAnimationFrame(loop);
    controls.update();
    applyFog();   // bornes du brouillard : suivent la distance caméra (M9a)
    renderer.render(scene, camera);
  };
  loop();

  log.info('Vue 3D initialisée (Three.js)');
  return {
    update,
    setGenerations: (u, d) => { upGen = u; downGen = d; layout.setGenerations(u, d); update(currentRootId); },
    reset: () => setCamera('face'),
    /** Nombre de plans dessinés, plan de base inclus (M9b). */
    planeCount: () => (lastRows.size ? 1 + planePivots.size : 0),
    /** Plan de l'individu : null = plan de base, sinon id du pivot (M9b). */
    planeOf: (id) => { const r = lastRows.get(id); return r ? (r.pivot ?? null) : null; },
    /** Isolation courante : undefined = aucune, null = base, sinon pivot (M9b). */
    getIsolation: () => isolated,
    /** Isole le plan de l'individu donné (M9b). */
    isolatePlane: (id) => {
      const r = lastRows.get(id);
      if (!r) return;
      isolated = r.pivot ?? null;
      applyLook();
    },
    /** Rétablit tous les plans (M9b). */
    clearIsolation: () => { isolated = undefined; applyLook(); },
  };
}
