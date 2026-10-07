/**
 * gedcomIndex.js — Construction du modèle normalisé à partir du GEDCOM parsé.
 *
 * Produit :
 *  - `people` : Map id → individu normalisé
 *    { id, xref, name: {given, surname, suffix}, sex: 'M'|'F'|null,
 *      birth: DateInfo, death: DateInfo, deathEvidence: boolean,
 *      parentOfChildIds: string[], familyAsSpouse: string[],
 *      events: [], raw: Node }
 *  - index patronyme → ids, index recherche rapide ;
 *  - liens familles (mariages, enfants) ;
 *  - estimation des dates manquantes via dateEstimator.
 */
import { logger } from './logger.js';
import { parseGedcomDate, parseName, normalize } from './utils.js';
import { makeDateInfo, estimateDates } from './dateEstimator.js';
const log = logger('gedcomIndex');

/**
 * Construit l'index applicatif complet.
 * @param {{individuals: Object, families: Object}} parsed - sortie de parseGedcom
 * @returns {Object} index
 */
export function buildIndex(parsed) {
  const stop = log.time('index');
  const people = new Map();
  const families = new Map();

  // ---------- Individus ----------
  for (const [xref, node] of Object.entries(parsed.individuals)) {
    const person = {
      id: xref, xref,
      name: { given: '', surname: '', suffix: '' },
      sex: null,
      birth: makeDateInfo(null),
      death: makeDateInfo(null),
      deathEvidence: false,
      parentOfChildIds: [],
      childInFamilies: [],
      familyAsSpouse: [],
      events: [],
      raw: node,
    };
    for (const c of node.children) {
      switch (c.tag) {
        case 'NAME':
          person.name = parseName(c.value);
          break;
        case 'SEX':
          person.sex = /^M/i.test(c.value) ? 'M' : /^F/i.test(c.value) ? 'F' : null;
          break;
        case 'BIRT': {
          const d = findTag(c, 'DATE');
          if (d) person.birth = makeDateInfo(parseGedcomDate(d.value));
          break;
        }
        case 'DEAT': {
          const d = findTag(c, 'DATE');
          if (d) person.death = makeDateInfo(parseGedcomDate(d.value));
          person.deathEvidence = true; // évènement DEAT présent, même sans date
          break;
        }
        case 'BAPM': case 'CHR': case 'BURI': case 'CREM':
          person.events.push({ type: c.tag, date: c.value ?? null });
          break;
        case 'FAMC': person.childInFamilies.push(c.value); break;
        case 'FAMS': person.familyAsSpouse.push(c.value); break;
      }
    }
    people.set(xref, person);
  }

  // ---------- Familles ----------
  for (const [xref, node] of Object.entries(parsed.families)) {
    const fam = { id: xref, xref, husband: null, wife: null, children: [],
                  marriage: makeDateInfo(null), raw: node };
    for (const c of node.children) {
      if (c.tag === 'HUSB') fam.husband = c.value;
      else if (c.tag === 'WIFE') fam.wife = c.value;
      else if (c.tag === 'CHIL') fam.children.push(c.value);
      else if (c.tag === 'MARR') {
        const d = findTag(c, 'DATE');
        if (d) fam.marriage = makeDateInfo(parseGedcomDate(d.value));
      }
    }
    families.set(xref, fam);
  }

  // ---------- Liens parents → enfants (pour l'estimation des dates) ----------
  for (const fam of families.values()) {
    for (const parentId of [fam.husband, fam.wife]) {
      const p = people.get(parentId);
      if (p) p.parentOfChildIds.push(...fam.children.filter(Boolean));
    }
  }

  // ---------- Dates estimées ----------
  const estimationStats = estimateDates({ people });

  // ---------- Index de recherche ----------
  const surnameIndex = new Map(); // patronyme normalisé → ids
  for (const [id, p] of people) {
    const key = normalize(p.name.surname);
    if (key) {
      if (!surnameIndex.has(key)) surnameIndex.set(key, []);
      surnameIndex.get(key).push(id);
    }
  }

  stop();
  log.info(`Index : ${people.size} individus, ${families.size} familles, ` +
           `${surnameIndex.size} patronymes`);
  return makeIndexApi({ people, families, surnameIndex, estimationStats });
}

/** Cherche un sous-nœud par tag (profondeur 1). */
function findTag(node, tag) {
  return node.children.find(c => c.tag === tag) ?? null;
}

/** Fabrique l'objet API exposé par l'index. */
function makeIndexApi({ people, families, surnameIndex, estimationStats }) {
  return {
    /** @returns {number} nombre d'individus */
    get peopleCount() { return people.size; },
    /** @returns {number} nombre de familles */
    get familyCount() { return families.size; },
    /** @returns {number} nombre de patronymes distincts */
    get surnameCount() { return surnameIndex.size; },

    /**
     * Fiche d'un individu.
     * @param {string} id - xref de l'individu
     * @returns {Object|null} l'individu normalisé ou null
     */
    getIndividual(id) { return people.get(id) ?? null; },

    /**
     * Toutes les fiches individus normalisées (itération pour la recherche).
     * @returns {Object[]} individus (références directes, ne pas muter)
     */
    getAllPeople() { return [...people.values()]; },

    /**
     * Liste des patronymes présents dans le fichier.
     * @returns {string[]} patronymes normalisés, triés
     */
    getSurnames() { return [...surnameIndex.keys()].sort(); },

    /**
     * Recherche par patronyme et début de prénom.
     * @param {string} surname - patronyme (insensible casse/accents)
     * @param {string} [givenPrefix=''] - préfixe de prénom
     * @returns {Array<{id: string, given: string, surname: string,
     *                  birth: DateInfo, death: DateInfo, sex: string|null}>}
     */
    searchByName(surname, givenPrefix = '') {
      const ids = surnameIndex.get(normalize(surname)) ?? [];
      const pref = normalize(givenPrefix);
      return ids
        .map(id => people.get(id))
        .filter(Boolean)
        .filter(p => !pref || normalize(p.name.given).startsWith(pref))
        .map(p => ({ id: p.id, given: p.name.given, surname: p.name.surname,
                     sex: p.sex, birth: p.birth, death: p.death }));
    },

    /**
     * Famille par xref.
     * @param {string} id
     * @returns {Object|null}
     */
    getFamily(id) { return families.get(id) ?? null; },

    /**
     * Statistiques de chargement et d'estimation (pour l'affichage M0).
     * @returns {Object}
     */
    stats() {
      return {
        people: people.size,
        families: families.size,
        surnames: surnameIndex.size,
        ...estimationStats,
      };
    },
  };
}
