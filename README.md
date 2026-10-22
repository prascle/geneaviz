# GeneaViz — Visualisation généalogique 2D/3D

Application web 100 % client (JavaScript ES modules + HTML) pour l'exploration d'arbres
généalogiques au format GEDCOM. Trois vues : arbre générationnel (D3),
chronologique, et 3D (Three.js). Voir le cahier des charges pour le détail.

## État : jalon M7a — vue 3D (squelette du graphe de base)

- `js/logger.js` — traces module par module, niveaux DEBUG/INFO/WARN/ERROR.
- `js/utils.js` — parsing/formatage des dates GEDCOM (y compris ABT/BEF/AFT), debounce.
- `js/gedcomLoader.js` — lecture du fichier (File API) + parsing GEDCOM en mémoire.
- `js/gedcomIndex.js` — index des individus, familles, patronymes, liens parents/enfants.
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

## Utilisation

Ouvrir `index.html` dans un navigateur (un simple serveur local suffit, ex. `python -m http.server`).
Sélectionner un fichier `.ged`, rechercher un individu (M1) : son détail s'affiche et
son arbre combiné se dessine (M3). Les nombres de générations d'ascendants et de
descendants se règlent indépendamment au-dessus de l'arbre ; molette = zoom,
glisser = déplacement. Cliquer un individu affiche son détail dans le panneau.
**Clic droit** sur un individu : détail, « Définir comme racine », et éditions
d'affichage M6 — ajouter/retirer sa fratrie, ses ascendants ou ses descendants
(nombre de générations libre), de façon récursive sur tout individu affiché ;
les branches ajoutées portent un marquage distinctif (hachures + pastille
  colorée, une couleur par pivot d'édition ; le pivot empile une bande par
  édition sur sa pastille) et ne modifient jamais le GEDCOM. Le bouton ⛶ bascule le plein écran.
Le bouton **3D** de la barre de vues active la vue 3D : molette = zoom, glisser =
rotation, presets caméra (Frise / Dessus / Perspective) en haut à droite du cadre ;
clic (détail), clic droit (menu contextuel) et double-clic (centrer) y sont
fonctionnels comme dans les autres vues, ainsi que le survol (surbrillance de
famille + infobulle).

Niveau de trace : ajouter `?log=DEBUG` à l'URL (ou `localStorage.setItem('genea:logLevel','DEBUG')`).

## Inspection en console

Après chargement d'un fichier :
- `genea.index.getIndividual(id)` — fiche individuelle complète.
- `genea.index.searchByName('DUPONT', 'jean')` — recherche par patronyme/prénom (M1).
- `genea.index.stats()` — statistiques de chargement et d'estimation.
- `genea.tree.update(id)` — recentre l'arbre combiné sur un individu.
- `genea.timeline.update(id)` — reconstruit la frise chronologique sur un individu.
- `genea.view3d.update(id)` — reconstruit la vue 3D sur un individu.

## Conventions

- JSDoc sur chaque fonction exportée.
- Chaque module instancie son logger : `const log = logger('monModule')`.
- Git : une branche par module, commits atomiques, tag `m0` à ce jalon.

## Notes techniques

- Le parsing GEDCOM de M0 est un parseur interne minimal (niveaux/xrefs/CONT/CONC).
  L'intégration de `read-gedcom` (dates riches, approximations, sources) est prévue
  en itération suivante pour l'extraction détaillée des champs.