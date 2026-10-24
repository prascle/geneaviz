# GeneaViz — Visualisation généalogique 2D/3D

Application web 100 % client (JavaScript ES modules + HTML) pour l'exploration d'arbres
généalogiques au format GEDCOM. Trois vues : arbre générationnel (D3),
chronologique, et 3D (Three.js). Voir le cahier des charges pour le détail.

## Auteurs

Le **design de l'application et le pilotage du développement incrémental** —
cahiers des charges, découpage en jalons (M0 à M9), arbitrages fonctionnels,
tests d'ergonomie et validation à chaque étape — sont de **Paul Rascle**
(dépôt GitHub [`prascle/geneaviz`](https://github.com/prascle/geneaviz)).

Le **codage a intégralement été réalisé par Mistral AI** (agent Vibe, modèle
GLM), à partir des spécifications, des retours de test et des décisions de
Paul Rascle : 113 commits produits du 6 au 24 octobre 2026, relus et fusionnés
par Paul Rascle au fil de 20 pull requests (une par jalon ou correctif).

## État : jalon M10 — thème clair / sombre / automatique

- `js/logger.js` — traces module par module, niveaux DEBUG/INFO/WARN/ERROR.
- `js/utils.js` — parsing/formatage des dates GEDCOM (y compris ABT/BEF/AFT), debounce.
- `js/gedcomLoader.js` — lecture du fichier (File API) et parsing délégués à
  `read-gedcom` 0.3.2.
- `js/gedcomIndex.js` — index des individus, familles, patronymes, liens
  parents/enfants, construit sur la sélection read-gedcom.
- `js/dateEstimator.js` — estimation des dates manquantes (règles réglables, cf. JSDoc).
- M1 — `js/search.js` + `js/searchBar.js` : recherche par patronyme/prénom, sélection
  d'un individu, panneau de détails (dates exactes vs estimées).
- M2 — `js/tree.js` : arbre générationnel des ascendants (D3) depuis l'individu
  sélectionné, profondeur réglable, dates estimées mises en évidence (≈, tirets).
- M3 — `js/tree.js` : vue combinée — ascendants à gauche, descendants à droite de
  la racine, profondeurs réglables indépendamment (0 à 10 générations de chaque côté).
- M4 — `js/tree.js` : conjoints empilés verticalement (remariages), liens de
  filiation partant du point d'union du couple, carte fantôme pour conjoint ou
  parent inconnu, fonds selon le sexe (bleu clair homme, rose clair femme),
  bouton « Recentrer » (remise à l'échelle de la vue).
- M4.1 — infobulle au survol d'un individu dans l'arbre ; fix recherche (individus
  sans prénom, total tronqué affiché).
- M5 — `js/timeline.js` : vue chronologique — une barre par individu (naissance →
  décès), dates estimées en tirets orangés, vivants prolongés jusqu'à aujourd'hui,
  périmètre « arbre courant » ou « tout le fichier », zoom horizontal, clic
  synchronisé avec l'arbre.
- M5.1 — plein écran natif des vues (hauteur pilotée dynamiquement), menu
  contextuel (clic droit), surbrillance de famille au survol avec estompage,
  infobulle ancrée bas-gauche, couleurs de génération relatives en chrono.
- M6 — `js/edits.js` : branches extensibles — éditions d'affichage sans jamais
  modifier le GEDCOM, via le menu contextuel : ajout/retrait de la fratrie (M6a,
  parents inclus), des ascendants et descendants avec mini-éditeur de générations
  (M6b). Registre partagé par les deux vues, éditions récursives en passes à
  point fixe, marquage des individus ajoutés (fond hachuré en arbre, contour
  renforcé en chrono).
- M6c — `js/tree.js` : solveur de collisions unifié — après le placement (graphe
  de base + éditions), les cartes qui se chevauchent sont écartées verticalement
  (poussées vers le bas uniquement), puis la géométrie de tous les liens
  (filiations, crochets d'union, bus de fratrie) est générée depuis les positions
  finales : les liens sont logiques (références aux cartes) et suivent leurs
  cartes.
- M6d — pastilles de famille / branche : chaque individu porte une pastille
  colorée sur le bord droit de sa carte (arbre) ou de sa boîte de vie (chrono).
  Graphe de base = bleu ; chaque édition introduit une couleur vive par pivot
  (même couleur pour toutes les éditions d'un même pivot) ; le pivot empile
  une bande par édition — sa pastille multi-bandes le distingue sans badge
  dédié.
- M7a — `js/view3d.js` : vue 3D (Three.js) du graphe de base — une barre temporelle
  par individu (épaisse, texture texte sur les faces : nom à gauche, dates à droite,
  fond pâle selon le sexe, liseré bleu racine, dates ambre si estimées), pastilles
  couleur en cubes, cône « vivant·e présumé·e », liens de mariage/filiation, grille
  des années au sol, presets caméra (Frise / Dessus / Perspective), OrbitControls,
  interactions : clic = détail, clic droit = menu contextuel, double-clic = centrer,
  survol = surbrillance de famille + infobulle.
- M7a — factorisation : `js/layout.js` (placement chronologique partagé par la frise
  et la vue 3D, métriques paramétrables — même layout par construction, conventions
  identiques : mari au-dessus de l'épouse, enfants sous le couple dans l'ordre de
  naissance, parents centrés sur la ligne de leur enfant, solveur anti-chevauchement)
  et `js/tooltip.js` (infobulle partagée frise + 3D). Au passage, correctif des
  liens des branches « descendants » ajoutées au-delà du premier niveau (émission
  récursive), valable aussi pour la frise.
- M7b — `js/view3d.js` + `js/layout.js` : plans d'édition décalés en profondeur (oZ) —
  chaque branche ajoutée par une édition rejoint le plan de son pivot d'édition
  (ordre de création, derrière le plan de base qui reste prioritaire pour les
  individus multi-plans), un plan matérialisé par une surface translucide teintée
  de la couleur pastille du pivot ; liens de mariage/filiation en diagonale entre
  plans ; grille des années étendue à tous les plans ; panneau « Réglages »
  (épaisseur des barres, écart dans le couple, écart couple–enfants, échelle du
  temps) qui recalcule le layout partagé à la volée (la frise reste inchangée).
- M8a — `js/gedcomLoader.js` + `js/gedcomIndex.js` : lecture et parsing du GEDCOM
  migrés vers la bibliothèque `read-gedcom` 0.3.2 (zéro dépendance, navigateur
  natif) — détection d'encodage intégrée selon l'en-tête CHAR (UTF-8, UTF-16,
  CP1252/ANSI, ANSEL, MacRoman, CP850), CONT/CONC fusionnés, structure validée
  (HEAD en tête, TRLR en fin, imbrication des niveaux) ; index et vues
  inchangés (non-régression vérifiée champ à champ sur un banc de test),
  `index.getGedcom()` expose la sélection racine read-gedcom pour l'extraction
  riche à venir (M8b : fiche individu).
- M8b — `js/gedcomDetail.js` : fiche individu complète dans un panneau latéral
  escamotable à droite. Extraction **paresseuse** (à l'ouverture de la fiche,
  jamais au chargement — les gros fichiers ne ralentissent pas) depuis les
  nœuds bruts read-gedcom déjà conservés par l'index. Contenu : identité
  (noms multiples avec type naissance/marié·e/alias, surnom, sexe, xref, date
  de modification CHAN), événements datés au format complet « 12 janv. 1873 »
  avec qualificatifs (≈ < >, fourchettes « entre … et … », périodes
  « de … à … ») et lieux (naissance, baptêmes BAPM/CHR, décès avec cause,
  sépulture/crémation), professions et résidences datées (FROM/TO), familles
  (parents avec lien PEDI — adoption, famille d'accueil —, unions avec
  mariage, divorce et enfants), notes (inline ou records, retours à la ligne
  conservés), sources (PAGE + titre du record résolu). Ouverture : clic simple
  sur un individu, entrée « Fiche complète » du menu contextuel, ou bouton du
  panneau compact ; fermeture ✕ ou Échap ; en plein écran seule la fiche reste
  visible (cible privilégiée). Infobulle enrichie d'une ligne de contexte
  (profession, lieux de naissance/décès — `js/tooltip.js` et sa copie dans
  `js/tree.js`, donc les trois vues).
- M9a — `js/view3d.js` : liens de mariage/filiation en traits épais — migration de
  THREE.Line/LineBasicMaterial vers `Line2`/`LineMaterial`/`LineGeometry` (addons
  `three/addons/lines/`, importmap inchangée) ; épaisseur réglable en pixels CSS
  (0,5 à 6, défaut 1) ; au survol d'un individu les liens de sa famille sont
  épaissis (×2,5) pour accompagner la surbrillance ; brouillard de profondeur
  réglable (0–100, 0 = désactivé) dont les bornes sont recalculées à chaque image
  relativement à la distance caméra–cible (effet stable quel que soit le zoom) ;
  la grille des années et les contours de plans restent en fil fin. Deux nouveaux
  curseurs dans le panneau « Réglages » : « Épaisseur des liens » et « Brouillard ».
- M9b — `js/view3d.js` + `js/app.js` : isolation d'un plan d'édition — clic sur
  la surface translucide d'un plan, ou entrée « Isoler ce plan » du menu
  contextuel (« Isoler le plan de base » depuis le plan de base, « Rétablir
  tous les plans » tant qu'une isolation est active) ; les autres plans
  s'estompent (barres, pastilles et liens à 0,07, surfaces quasi effacées),
  le plan isolé est renforcé, la barre de son pivot reste visible et les
  liens en diagonale qui le rattachent au graphe restent nets ; l'isolation
  survit aux réglages (relayout) et s'annule si l'édition est retirée ; clic
  sur le fond = rétablir (un glisser-rotation ne déclenche rien). Bascule
  caméra perspective ↔ orthographique dans le panneau Réglages : même point
  de vue à la bascule (frustum calé sur le cadrage de la perspective,
  demi-hauteur = tan(fov/2) × distance), recalculé au resize et aux presets,
  taille apparente stable au pan et au zoom molette.
- M9c — `js/relation.js` (nouveau) + `js/app.js` + les trois vues : chaîne de
  parenté entre deux individus quelconques — parcours BFS sur l'index complet
  (parents, enfants, conjoints ; indépendant de la racine affichée et des
  éditions), plus court chemin traduit en libellés français orientés
  « X est le … de Y » (père, mère, fils, fille, conjoint·e — genre selon le
  sexe de X). A et B se définissent par le menu contextuel (« Chaîne :
  définir A », puis « définir B », avec rappel du choix courant) ; la chaîne
  se dessine en ambre dans les trois vues, le reste est estompé (liens de la
  chaîne épaissis ×2,5 en 3D), elle se compose avec le survol (un membre
  n'est jamais estompé) et survit aux réglages et changements de racine ;
  l'isolation d'un plan reste prioritaire (les membres hors du plan isolé
  sont estompés). Panneau dédié en bas à gauche : phrase complète (« A est
  le fils de X, qui est le père de Y, … ») et liste des liens, étirable par
  la poignée en bas à droite (vers la droite = élargir, vers le haut =
  agrandir) ; fermeture par ✕, Échap ou « Chaîne : effacer ».
- M10 — thème clair / sombre / automatique : sélecteur « Thème » en tête du
  bandeau de vues (Automatique / Clair / Sombre), mémorisé dans le navigateur ;
  le mode « Automatique » suit en direct les réglages de l'environnement
  (prefers-color-scheme), y compris pendant la session. Toute l'interface,
  l'arbre et la frise sont recolorés instantanément (palette en variables CSS,
  mode actif porté par html[data-theme], script inline anti-flash au
  chargement) ; la vue 3D, peinte au rendu, possède sa palette propre et est
  rebâtie à chaque changement de thème en conservant le point de vue (caméra +
  zoom), l'isolation de plan et la chaîne de parenté.

## Utilisation

Ouvrir `index.html` dans un navigateur (un simple serveur local suffit, ex. `python -m http.server`).
Sélectionner un fichier `.ged`, rechercher un individu (M1) : son détail s'affiche et
son arbre combiné se dessine (M3). Les nombres de générations d'ascendants et de
descendants se règlent indépendamment au-dessus de l'arbre ; molette = zoom,
glisser = déplacement. Cliquer un individu affiche son détail dans le panneau et
ouvre sa **fiche complète** dans le panneau latéral droit (M8b) : identité,
événements datés avec lieux, professions, résidences, familles (mariages,
divorces, parents/enfants, adoption), notes et sources ; fermeture par ✕ ou
Échap. **Clic droit** sur un individu : détail, « Fiche complète », « Définir
comme racine », et éditions
d'affichage M6 — ajouter/retirer sa fratrie, ses ascendants ou ses descendants
(nombre de générations libre), de façon récursive sur tout individu affiché ;
les branches ajoutées portent un marquage distinctif (hachures + pastille
  colorée, une couleur par pivot d'édition ; le pivot empile une bande par
  édition sur sa pastille) et ne modifient jamais le GEDCOM. Le bouton ⛶ bascule le plein écran.
Le bouton **3D** de la barre de vues active la vue 3D : molette = zoom, glisser =
rotation, presets caméra (Frise / Dessus / Perspective) en haut à droite du cadre ;
clic (détail + fiche), clic droit (menu contextuel) et double-clic (centrer) y sont
fonctionnels comme dans les autres vues, ainsi que le survol (surbrillance de
famille + infobulle enrichie d'une ligne de contexte : profession, lieux de
naissance/décès). Les éditions d'affichage s'y matérialisent par des plans
parallèles décalés en profondeur (une couleur par pivot, surface translucide),
reliés au graphe par des liens en diagonale ; le panneau « Réglages » (sous les
presets) ajuste l'épaisseur des barres, les écarts, l'échelle du temps, l'épaisseur des
liens (×2,5 sur la famille survolée) et bascule caméra perspective/orthographique. Dans cette vue, un clic sur la
surface d'un plan d'édition l'isole (les autres plans s'estompent, la barre du
pivot reste visible) ; le clic sur le fond ou l'entrée « Rétablir tous les
plans » du menu contextuel affiche de nouveau l'ensemble.
Le clic droit définit aussi une **chaîne de parenté** entre deux individus
(M9c) : « Chaîne : définir A » puis « définir B » sur deux individus
quelconques — le plus court chemin de parenté (père/mère, fils/fille,
conjoint·e) est mis en évidence en ambre dans les trois vues et détaillé dans
le panneau en bas à gauche (phrase complète et liste des liens) ; panneau
étirable par sa poignée en bas à droite, effacement par ✕, Échap ou « Chaîne :
effacer ».
Le sélecteur **Thème** du bandeau de vues bascule l'ensemble de l'application
en mode clair, sombre ou « Automatique » (suit les réglages de l'environnement,
même en cours de session) ; le choix est mémorisé d'une visite à l'autre et la
vue 3D conserve son cadrage au basculement.
Les fichiers anciens non-UTF-8 (CP1252/ANSI, UTF-16, ANSEL…) sont désormais
correctement décodés ; un fichier mal formé (sans en-tête HEAD, sans trailer
TRLR, niveaux incohérents) est refusé avec un message explicite.

Niveau de trace : ajouter `?log=DEBUG` à l'URL (ou `localStorage.setItem('genea:logLevel','DEBUG')`).

## Inspection en console

Après chargement d'un fichier :
- `genea.index.getIndividual(id)` — fiche individuelle complète.
- `genea.index.searchByName('DUPONT', 'jean')` — recherche par patronyme/prénom (M1).
- `genea.index.stats()` — statistiques de chargement et d'estimation.
- `genea.index.getGedcom()` — sélection read-gedcom racine (les nœuds bruts
  conservés dans l'index portent les mêmes valeurs).
- `genea.tree.update(id)` — recentre l'arbre combiné sur un individu.
- `genea.timeline.update(id)` — reconstruit la frise chronologique sur un individu.
- `genea.view3d.update(id)` — reconstruit la vue 3D sur un individu.

## Conventions

- JSDoc sur chaque fonction exportée.
- Chaque module instancie son logger : `const log = logger('monModule')`.
- Git : une branche par module, commits atomiques, tag `m0` à ce jalon.

## Notes techniques

- Le parsing GEDCOM est délégué à `read-gedcom` 0.3.2 (M8a) : décodage natif des
  encodages, validation stricte de la structure (HEAD en tête, TRLR en fin,
  imbrication des niveaux, pointeurs uniques), erreurs explicites. Les dates
  restent analysées par `js/utils.js` (comportement des vues et de l'estimateur
  strictement inchangé).
- La fiche individu (M8b) n'effectue aucune extraction au chargement :
  `js/gedcomDetail.js` est un module pur qui lit les nœuds bruts read-gedcom
  conservés par l'index (`person.raw`, `fam.raw` — valeurs CONT/CONC déjà
  fusionnées) uniquement à l'ouverture, et résout les notes et sources
  référencées par `@xref@` via la sélection racine (`index.getGedcom()`).
- Les liens 3D (M9a) utilisent `Line2`/`LineMaterial` (addons `three/addons/lines/`)
  dont l'épaisseur s'exprime en pixels du tampon de rendu (multipliée par le pixel
  ratio du navigateur) et dont la résolution doit suivre la taille du canvas à
  chaque redimensionnement (recalcul au resize).
- Caméra orthographique (M9b) : le frustum suit le cadrage de la perspective à
  même distance (demi-hauteur = tan(fov/2) × distance) ; en ortho, le zoom
  molette et le pan jouent sur camera.zoom (OrbitControls), indépendant du
  frustum — d'où un recalcul limité à la bascule, au resize et aux presets.
- Isolation des plans (M9b) : chaque objet porte son plan dans userData
  (plane / planes) et un seul parcours (applyLook) compose survol et
  isolation — l'isolation prime sur le survol ; les surfaces de plans sont
  pickables (raycast indépendant de l'opacité).
- Chaîne de parenté (M9c) : `js/relation.js` est un module pur (BFS
  parents/enfants/conjoints sur l'index complet, libellés orientés
  « from est le … de to », banc de test node) ; les vues reçoivent la chaîne
  par `setChain(ids, paires)` — membres + paires de liens consécutifs — et la
  composent avec le survol dans leur rendu ; en 3D, le parcours unique
  d'opacités compose survol, isolation et chaîne : l'isolation de plan reste
  prioritaire sur la chaîne (choix validé à l'usage).
- Thème (M10) : la palette vit en variables CSS (`:root` pour le clair,
  `html[data-theme="dark"]` pour le sombre, `color-scheme` pour les contrôles
  natifs) ; le mode actif est mémorisé dans localStorage (`genea:theme`) et
  posé avant le premier rendu par un script inline anti-flash ; la vue 3D
  (textures et matériaux peints au rendu) a sa palette JS (`v3dPalette()`) et
  est rebâtie à chaque changement de thème en conservant caméra, isolation et
  chaîne.
