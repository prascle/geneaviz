# GeneaViz — Visualisation généalogique 2D/3D

Application web 100 % client (JavaScript ES modules + HTML) pour l'exploration d'arbres
généalogiques au format GEDCOM. Trois vues prévues : arbre générationnel (D3),
chronologique, et 3D (Three.js). Voir le cahier des charges pour le détail.

## État : jalon M3

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

## Utilisation

Ouvrir `index.html` dans un navigateur (un simple serveur local suffit, ex. `python -m http.server`).
Sélectionner un fichier `.ged`, rechercher un individu (M1) : son détail s'affiche et
son arbre combiné se dessine (M3). Les nombres de générations d'ascendants et de
descendants se règlent indépendamment au-dessus de l'arbre ; molette = zoom,
glisser = déplacement. Cliquer un individu affiche son détail dans le panneau.

Niveau de trace : ajouter `?log=DEBUG` à l'URL (ou `localStorage.setItem('genea:logLevel','DEBUG')`).

## Inspection en console

Après chargement d'un fichier :
- `genea.index.getIndividual(id)` — fiche individuelle complète.
- `genea.index.searchByName('DUPONT', 'jean')` — recherche par patronyme/prénom (M1).
- `genea.index.stats()` — statistiques de chargement et d'estimation.
- `genea.tree.update(id)` — recentre l'arbre combiné sur un individu.

## Conventions

- JSDoc sur chaque fonction exportée.
- Chaque module instancie son logger : `const log = logger('monModule')`.
- Git : une branche par module, commits atomiques, tag `m0` à ce jalon.

## Notes techniques

- Le parsing GEDCOM de M0 est un parseur interne minimal (niveaux/xrefs/CONT/CONC).
  L'intégration de `read-gedcom` (dates riches, approximations, sources) est prévue
  en itération suivante pour l'extraction détaillée des champs.