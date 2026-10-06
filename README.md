# GeneaViz — Visualisation généalogique 2D/3D

Application web 100 % client (JavaScript ES modules + HTML) pour l'exploration d'arbres
généalogiques au format GEDCOM. Trois vues prévues : arbre générationnel (D3),
chronologique, et 3D (Three.js). Voir le cahier des charges pour le détail.

## État : jalon M0

- `js/logger.js` — traces module par module, niveaux DEBUG/INFO/WARN/ERROR.
- `js/utils.js` — parsing/formatage des dates GEDCOM (y compris ABT/BEF/AFT), debounce.
- `js/gedcomLoader.js` — lecture du fichier (File API) + parsing GEDCOM en mémoire.
- `js/gedcomIndex.js` — index des individus, familles, patronymes, liens parents/enfants.
- `js/dateEstimator.js` — estimation des dates manquantes (règles réglables, cf. JSDoc).

## Utilisation

Ouvrir `index.html` dans un navigateur (un simple serveur local suffit, ex. `python -m http.server`).
Sélectionner un fichier `.ged`. Les résultats du jalon M0 s'affichent dans la page
et dans la console : nombre d'individus, familles, patronymes, dates estimées.

Niveau de trace : ajouter `?log=DEBUG` à l'URL (ou `localStorage.setItem('genea:logLevel','DEBUG')`).

## Inspection en console

Après chargement d'un fichier :
- `genea.index.getIndividual(id)` — fiche individuelle complète.
- `genea.index.searchByName('DUPONT', 'jean')` — recherche (pré-version M1).
- `genea.index.stats()` — statistiques de chargement et d'estimation.

## Conventions

- JSDoc sur chaque fonction exportée.
- Chaque module instancie son logger : `const log = logger('monModule')`.
- Git : une branche par module, commits atomiques, tag `m0` à ce jalon.

## Notes techniques

- Le parsing GEDCOM de M0 est un parseur interne minimal (niveaux/xrefs/CONT/CONC).
  L'intégration de `read-gedcom` (dates riches, approximations, sources) est prévue
  en itération suivante pour l'extraction détaillée des champs.
