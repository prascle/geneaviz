/**
 * gedcomLoader.js — Lecture et parsing d'un fichier GEDCOM.
 *
 * M0 : parseur interne minimal mais robuste (niveaux, xrefs, CONT/CONC),
 * suffisant pour l'indexation. L'intégration de `read-gedcom` est prévue en
 * itération suivante pour l'extraction riche des champs.
 */
import { logger } from './logger.js';
const log = logger('gedcomLoader');

/**
 * Lit un fichier choisi par l'utilisateur (File API) et retourne son texte.
 * @param {File} file - fichier `.ged` (ou `.gedcom`)
 * @returns {Promise<string>} contenu texte (décodé en UTF-8)
 * @throws {Error} si le fichier est vide ou en erreur de lecture
 */
export async function readGedcomFile(file) {
  const stop = log.time(`lecture ${file.name}`);
  const text = await file.text();
  stop();
  if (!text.trim()) {
    const err = new Error(`Fichier vide : ${file.name}`);
    log.error(err.message);
    throw err;
  }
  return text;
}

/**
 * Parse un texte GEDCOM en arbre de nœuds.
 * Chaque nœud : `{ tag, value, xref, children: [] }` (CONT/CONC fusionnés dans `value`).
 *
 * @param {string} text - contenu GEDCOM complet
 * @returns {{individuals: Object<string, Node>, families: Object<string, Node>,
 *            header: Node|null}}
 *   `individuals` : map xref (@I123@) → nœud INDI ;
 *   `families` : map xref (@F45@) → nœud FAM.
 * @throws {Error} si aucune ligne exploitable ou aucun INDI trouvé
 */
export function parseGedcom(text) {
  const stop = log.time('parse');
  const lines = text.split(/\r?\n/);
  const root = { tag: 'ROOT', value: '', xref: null, children: [] };
  const stack = [{ level: -1, node: root }];
  const individuals = {}, families = {};
  let header = null, badLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d+)\s+(?:@([^@]+)@\s+)?(\w+)(?:\s(.*))?$/);
    if (!m) { badLines++; continue; }
    const level = Number(m[1]);
    const node = { tag: m[3], value: (m[4] ?? '').trim(), xref: m[2] ? `@${m[2]}@` : null, children: [] };

    // Recherche du parent : dernier nœud de niveau < level.
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1].node;

    // GEDCOM : CONT = nouvelle ligne, CONC = concaténation sans espace.
    if (node.tag === 'CONT' && parent) {
      parent.value += '\n' + node.value;
      continue;
    }
    if (node.tag === 'CONC' && parent) {
      parent.value += node.value;
      continue;
    }

    if (level === 0) {
      if (node.tag === 'INDI') individuals[node.xref] = node;
      else if (node.tag === 'FAM') families[node.xref] = node;
      else if (node.tag === 'HEAD') header = node;
    }
    parent.children.push(node);
    stack.push({ level, node });
  }

  if (badLines > 0) log.warn(`${badLines} ligne(s) non conforme(s) ignorée(s)`);
  stop();
  log.info(`Parsing : ${Object.keys(individuals).length} individus, ` +
           `${Object.keys(families).length} familles`);
  if (Object.keys(individuals).length === 0) {
    throw new Error('Aucun individu (INDI) trouvé — fichier GEDCOM invalide ?');
  }
  return { individuals, families, header };
}
