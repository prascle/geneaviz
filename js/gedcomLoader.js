/**
 * gedcomLoader.js — Lecture d'un fichier GEDCOM via la bibliothèque read-gedcom.
 *
 * M0 : parseur interne minimal (remplacé depuis).
 * M8a : la lecture et le parsing sont délégués à `read-gedcom` (zéro dépendance,
 * navigateur natif) — détection d'encodage intégrée (UTF-8/UTF-16, BOM, CP1252,
 * ANSEL, MacRoman, CP850), CONT/CONC fusionnés dans les valeurs, structure
 * validée (HEAD en tête, TRLR en fin, niveaux cohérents).
 *
 * Le texte n'est plus décodé à la main : on passe l'ArrayBuffer du fichier à
 * la bibliothèque, qui décode selon l'en-tête CHAR du fichier.
 */
import { readGedcom } from 'read-gedcom';
import { logger } from './logger.js';
const log = logger('gedcomLoader');

/**
 * Lit et parse un fichier choisi par l'utilisateur (File API).
 * @param {File} file - fichier `.ged` (ou `.gedcom`)
 * @returns {Promise<Object>} sélection read-gedcom (racine du GEDCOM parsé)
 * @throws {Error} si le fichier est vide, illisible, mal formé
 *                ou sans aucun individu (INDI)
 */
export async function readGedcomFile(file) {
  const stop = log.time(`lecture ${file.name}`);
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (e) {
    const err = new Error(`Lecture impossible : ${file.name} — ${e.message}`);
    log.error(err.message);
    throw err;
  }
  stop();
  if (!buffer || buffer.byteLength === 0) {
    const err = new Error(`Fichier vide : ${file.name}`);
    log.error(err.message);
    throw err;
  }

  let gedcom;
  try {
    gedcom = readGedcom(new Uint8Array(buffer));
  } catch (e) {
    // Erreurs de read-gedcom (ErrorInvalidFileType, ErrorTreeStructure,
    // ErrorTokenization…) : message compréhensible pour l'utilisateur.
    const err = new Error(`Fichier GEDCOM invalide : ${e.message}`);
    log.error(err.message);
    throw err;
  }

  const nIndi = gedcom.getIndividualRecord().length;
  const nFam = gedcom.getFamilyRecord().length;
  log.info(`Parsing : ${nIndi} individus, ${nFam} familles`);
  if (nIndi === 0) {
    const err = new Error('Aucun individu (INDI) trouvé — fichier GEDCOM invalide ?');
    log.error(err.message);
    throw err;
  }
  return gedcom;
}
