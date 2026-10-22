/**
 * view3d.js — Vue 3D (M7a) : squelette Three.js du graphe de base.
 *
 * Axes : oX = temps (comme la vue chrono), oY = générations (ascendants
 * au-dessus de la racine, descendants en dessous), oZ = profondeur (réservé
 * aux plans des éditions, M7b). Le placement oX/oY est calculé par le
 * module partagé layout.js — exactement celui de la vue chronologique.
 *  - chaque individu = barre temporelle (naissance → décès, flèche si
 *    vivant présumé), couleurs identiques aux vues 2D (sexe, racine,
 *    dates estimées translucides) ;
 *  - pastille = cube de couleur à droite de la barre (palette edits.js) ;
 *  - étiquette = texture texte appliquée sur les faces de la barre (nom +
 *    dates sur une seule ligne, le long de la barre) ; l'infobulle de survol
 *    reste le recours quand la texture est trop petite pour être lue ;
 *  - liens de filiation / repères de mariage = lignes ;
 *  - grille des années au « sol », presets caméra (frise / dessus /
 *    perspective), OrbitControls (rotation, zoom, pan).
 * Interactions : clic gauche = détail, clic droit = menu contextuel,
 * double-clic = viser l'individu, survol = surbrillance de famille.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { logger } from './logger.js';
import { PILL_BASE_COLOR } from './edits.js';
import { createFamilyLayout } from './layout.js';
import { buildTooltipHtml } from './tooltip.js';

const log = logger('view3d');

/** Dimensions du monde (unités arbitraires). */
const YEAR_W = 8;        // largeur d'une année
const MIN_BAR_W = 26;    // largeur minimale d'une barre
const BAR_H = 15;        // épaisseur verticale (3× — futur paramètre du panneau M7b)
const BAR_D = 8;         // profondeur (oZ)
const GAP_ROW = 5;        // écart entre les barres d'un couple (métrique layout)
const BAND_GAP = 18;      // écart entre un couple et ses enfants (métrique layout)
const LINK_COL = 0x94a3b8;
const MARR_COL = 0xb45309;

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

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50000);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(500, 900, 700);
  scene.add(dir);

  const content = new THREE.Group();   // tout le graphe (vidé à chaque update)
  scene.add(content);

  /** Barres interactives (picking). */
  let bars = [];

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
  // ligne de layout [y, y+BAR_H] correspond exactement à une barre.
  // ATTENTION : le layout travaille en coordonnées écran (y vers le bas,
  // comme le SVG de la frise) alors que l'axe oY de Three.js pointe vers
  // le haut — tout y est donc retourné au moment du dessin (Y = -(y + h/2)).
  const layout = createFamilyLayout({
    index, getEdits, upGen, downGen,
    metrics: { rowH: BAR_H, gapRow: GAP_ROW, bandGap: BAND_GAP },
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
    const h = Math.max(24, Math.round(BAR_H * ppu));
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
    if (!rootId || !index.getIndividual(rootId)) return;
    const L = layout.run(rootId);
    const rows = L.rows;
    const links = L.links;
    if (!rows.size) { log.info('Vue 3D : aucune date exploitable'); return; }
    for (const r of rows.values()) {   // temps (années) → unités monde
      r.x1 = r.t1 * YEAR_W;
      r.x2 = r.t2 * YEAR_W;
    }

    // bornes du contenu (y retourné : oY Three pointe vers le haut)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of rows.values()) {
      const cy = -(r.y + BAR_H / 2);   // centre de la barre en monde
      minX = Math.min(minX, r.x1); maxX = Math.max(maxX, r.x2);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    }

    // ---------- grille des années au sol ----------
    const floorY = minY - 44;
    const minT = Math.floor(minX / YEAR_W), maxT = Math.ceil(maxX / YEAR_W);
    const span = maxT - minT;
    const step = span > 400 ? 100 : span > 150 ? 50 : span > 60 ? 25 : 10;
    for (let t = Math.ceil(minT / step) * step; t <= maxT; t += step) {
      const x = t * YEAR_W;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, floorY, -70), new THREE.Vector3(x, floorY, 70)]);
      const line = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0xdbe2ea }));
      content.add(line);
      const spr = makeSprite(
        [{ text: String(t), font: 'bold 40px system-ui, sans-serif', color: '#94a3b8', dy: 46 }],
        { w: 256, h: 64, scaleW: 46, scaleH: 12 });
      spr.position.set(x, floorY + 8, 76);
      content.add(spr);
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
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, BAR_H, BAR_D), mat);
      mesh.position.set(r.x1 + w / 2, -(r.y + BAR_H / 2), 0);   // y retourné
      mesh.userData = { row: r, ids: [r.id], op0: mat.opacity };
      content.add(mesh);
      bars.push(mesh);

      // flèche « vivant·e présumé·e » : à droite de la pastille (plus
      // petite que la barre, transparente pour suivre le grisé au survol)
      if (r.alive) {
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(BAR_H * 0.4, 7, 12),
          new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true }));
        cone.rotation.z = -Math.PI / 2;
        cone.position.set(r.x2 + 12, -(r.y + BAR_H / 2), 0);
        cone.userData = { ids: [r.id], op0: 1 };
        content.add(cone);
      }

      // pastille(s) : cube(s) de couleur à droite de la barre, à gauche
      // du cône des vivant·e·s (transparent : suit le grisé au survol)
      const pc = r.pill ?? [PILL_BASE_COLOR];
      const n = pc.length;
      pc.forEach((cHex, i) => {
        const bh = BAR_H / n;
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(4.5, bh, 4.5),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(cHex),
                                        transparent: true }));
        cube.position.set(r.x2 + 5, -(r.y + bh / 2 + i * bh), 0);
        cube.userData = { ids: [r.id], op0: 1 };
        content.add(cube);
      });
    }

    // ---------- repères de mariage + filiations (émis par layout.js) ----------
    for (const l of links) {
      const x = l.year * YEAR_W;
      if (l.kind === 'marr') {
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, -(l.rowA.y + BAR_H / 2), 0),
          new THREE.Vector3(x, -(l.rowB.y + BAR_H / 2), 0)]);
        const line = new THREE.Line(geo,
          new THREE.LineBasicMaterial({ color: MARR_COL, transparent: true }));
        line.userData = { ids: l.ids, op0: 1 };
        content.add(line);
      } else {
        const cr = l.childRow;
        if (!cr) continue;
        const cy = -(cr.y + BAR_H / 2);   // centre de la barre enfant (retourné)
        const yFrom = -l.yFrom;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x, yFrom, 0),
          new THREE.Vector3(x, (yFrom + cy) / 2, 0),
          new THREE.Vector3(cr.x1 + 12, cy, 0)]);
        const line = new THREE.Line(geo,
          new THREE.LineBasicMaterial({ color: LINK_COL, transparent: true }));
        line.userData = { ids: l.ids, op0: 1 };
        content.add(line);
      }
    }

    setCamera('face');
    log.info(`Vue 3D : ${rows.size} individu(s), ${links.length} lien(s) ` +
      `(${upGen} gén. ascendants, ${downGen} gén. descendants)`);
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
    (2 * Math.tan((camera.fov * Math.PI / 180) / 2));

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
  }

  /* ------------------- interactions ------------------- */

  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hovered = null;

  const pick = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ptr.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ptr.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(ptr, camera);
    const hits = ray.intersectObjects(bars, false);
    return hits.length ? hits[0].object.userData.row : null;
  };

  /** Survol : surbrillance de la famille, le reste est estompé. */
  function applyHighlight(person) {
    const fam = familySet(index, person);
    content.traverse((o) => {
      if (!o.material || !o.userData.ids) return;
      const inFam = o.userData.ids.every((i) => fam.has(i));
      o.material.opacity = inFam ? o.userData.op0 : 0.1;
    });
  }
  const clearHighlight = () => {
    content.traverse((o) => {
      if (o.material && o.userData.ids) o.material.opacity = o.userData.op0;
    });
  };

  renderer.domElement.addEventListener('pointermove', (ev) => {
    const hit = pick(ev);
    if (hit !== hovered) {
      hovered = hit;
      if (hit) {
        showTip(hit.person);
        applyHighlight(hit.person);
        renderer.domElement.style.cursor = 'pointer';
      } else {
        hideTip();
        clearHighlight();
        renderer.domElement.style.cursor = '';
      }
    }
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    hovered = null; hideTip(); clearHighlight();
    renderer.domElement.style.cursor = '';
  });
  renderer.domElement.addEventListener('click', (ev) => {
    const hit = pick(ev);
    if (hit && onSelectPerson) onSelectPerson(hit.person.id);
  });
  renderer.domElement.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const hit = pick(ev);
    if (hit && onContextPerson) onContextPerson(hit.person, ev);
  });
  renderer.domElement.addEventListener('dblclick', (ev) => {
    const hit = pick(ev);
    if (hit) {
      controls.target.set((hit.x1 + hit.x2) / 2, -(hit.y + BAR_H / 2), 0);
      controls.update();
    }
  });

  /* ------------------- boucle + redimensionnement ------------------- */

  const resize = () => {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 400;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(container);
  }
  window.addEventListener('resize', resize);
  resize();

  const loop = () => {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  log.info('Vue 3D initialisée (Three.js)');
  return {
    update,
    setGenerations: (u, d) => { upGen = u; downGen = d; layout.setGenerations(u, d); update(currentRootId); },
    reset: () => setCamera('face'),
  };
}
