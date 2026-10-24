/**
 * gedcomIndex.js — Construction du modèle normalisé à partir d'un GEDCOM read-gedcom.
 *
 * M8a : l'indexation itère sur les sélections read-gedcom (INDI/FAM) au lieu
 * des nœuds du parseur interne M0. Les formes `person` et `fam` sont
 * STRICTEMENT inchangées (les vues n'ont pas à être modifiées) :
 *  - `person` : { id, xref, name: {given, surname, suffix}, sex: 'M'|'F'|null,
 *      birth: DateInfo, death: DateInfo, deathEvidence: boolean,
 *      parentOfChildIds: string[], childInFamilies: string[],
 *      familyAsSpouse: string[], events: [{type, date}], raw: node }
 *  - `fam` : { id, xref, husband, wife, children: string[],
 *      marriage: DateInfo, raw: node }
 *
 * Les dates sont toujours parsées par `utils.parseGedcomDate` à partir de la
 * valeur brute read-gedcom ("12 JAN 1873", "ABT 1875", "AFT 1930"…) : l'estimateur
 * (dateEstimator.js) et les vues conservent exactement le même comportement.
 *
 * Sémantique héritée du parseur M0 : en cas de valeurs multiples (SEX, BIRT,
 * DEAT, MARR), la DERNIÈRE occurrence porteuse d'une date gagne. EXCEPTION
 * NAME (correctif 2026-10-24) : priorité au NAME de TYPE birth, sinon le
 * PREMIER NAME — le nom de naissance / nom de jeune fille doit primer sur les
 * noms ultérieurs (nom de femme mariée en 2e position, etc.).
 * `events[].date` est la valeur du nœud événement (pas son DATE enfant), la fiche
 * M8b fera l'extraction riche.
 */
import { logger } from './logger.js';
import { parseGedcomDate, parseName, normalize } from './utils.js';
import { makeDateInfo, estimateDates } from './dateEstimator.js';
const log = logger('gedcomIndex');

/** Première valeur d'une sélection, ou null si vide. */
function first(selection) {
  return selection.value()[0] ?? null;
}

/**
 * Construit l'index applicatif complet.
 * @param {Object} gedcom - sélection read-gedcom (racine, sortie de readGedcomFile)
 * @returns {Object} index
 */
export function buildIndex(gedcom) {
  const stop = log.time('index');
  const people = new Map();
  const families = new Map();

  // ---------- Individus ----------
  const indiSels = gedcom.getIndividualRecord().arraySelect();
  for (const sel of indiSels) {
    const xref = sel.pointer()[0];
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
      raw: sel[0],   // nœud brut read-gedcom { tag, pointer, value, children }
    };

    // NAME : priorité au nom de naissance (TYPE birth), sinon le PREMIER NAME.
    // (Le DERNIER gagnait auparavant : un nom de femme mariée en 2e position
    // écrasait le nom de jeune fille.)
    const nameNodes = sel.getName().arraySelect();
    let nameValue = nameNodes.length ? nameNodes[0].value()[0] ?? null : null;
    for (const n of nameNodes) {
      if ((n.get('TYPE').value()[0] ?? '').toLowerCase() === 'birth') {
        nameValue = n.value()[0];
        break;
      }
    }
    if (nameValue != null) person.name = parseName(nameValue);

    // SEX : la dernière occurrence gagne.
    const sexValue = sel.getSex().value().at(-1);
    person.sex = /^M/i.test(sexValue ?? '') ? 'M' : /^F/i.test(sexValue ?? '') ? 'F' : null;

    // BIRT / DEAT : dernière occurrence avec DATE gagne.
    for (const ev of sel.getEventBirth().arraySelect()) {
      const d = first(ev.getDate());
      if (d) person.birth = makeDateInfo(parseGedcomDate(d));
    }
    const deathEvents = sel.getEventDeath();
    if (deathEvents.length > 0) person.deathEvidence = true; // évènement présent, même sans date
    for (const ev of deathEvents.arraySelect()) {
      const d = first(ev.getDate());
      if (d) person.death = makeDateInfo(parseGedcomDate(d));
    }

    // Évènements annexes (forme M0 : valeur du nœud, pas son DATE enfant).
    const evTags = [
      ['BAPM', sel.getEventBaptism()],
      ['CHR', sel.getEventChristening()],
      ['BURI', sel.getEventBurial()],
      ['CREM', sel.getEventCremation()],
    ];
    for (const [type, evSel] of evTags) {
      for (const ev of evSel.arraySelect()) {
        person.events.push({ type, date: first(ev) });
      }
    }

    // Liens familles (xrefs des nœuds FAMC/FAMS).
    person.childInFamilies.push(...sel.getFamilyAsChild().pointer());
    person.familyAsSpouse.push(...sel.getFamilyAsSpouse().pointer());

    people.set(xref, person);
  }

  // ---------- Familles ----------
  const famSels = gedcom.getFamilyRecord().arraySelect();
  for (const sel of famSels) {
    const xref = sel.pointer()[0];
    const fam = {
      id: xref, xref,
      husband: first(sel.getHusband()),
      wife: first(sel.getWife()),
      children: [...sel.getChild().value()],
      marriage: makeDateInfo(null),
      raw: sel[0],
    };
    // MARR : dernière occurrence avec DATE gagne.
    for (const marr of sel.getEventMarriage().arraySelect()) {
      const d = first(marr.getDate());
      if (d) fam.marriage = makeDateInfo(parseGedcomDate(d));
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
  return makeIndexApi({ gedcom, people, families, surnameIndex, estimationStats });
}

/** Fabrique l'objet API exposé par l'index. */
function makeIndexApi({ gedcom, people, families, surnameIndex, estimationStats }) {
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
     * Sélection read-gedcom racine (pour l'extraction riche M8b).
     * @returns {Object}
     */
    getGedcom() { return gedcom; },

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
