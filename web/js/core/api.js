"use strict";

/* ============================================================
   API - Communication avec le serveur Python (serveur.py)

   - chargerEtat()      : charge toute la base + les documents (GET /api/etat)
   - persister(...)     : écrit une modification (file d'attente ordonnée).
                          Les écritures d'une même action (sortie de stock +
                          ses transactions...) partent en un seul lot, tout
                          ou rien ; une ligne de stock modifiée entre-temps
                          par un autre poste fait refuser le lot (conflit).
   - getDocument / setDocument : planning, tâches, dosimètres, rappels...
   - surveillance       : recharge les données quand un autre poste
                          du cabinet a modifié quelque chose.
   ============================================================ */

import { setDbCache, loadDB, findStockEntry } from './database.js';

const INTERVALLE_SURVEILLANCE = 4000; // ms

let documents = {};
let revisionConnue = null;
let fileEcriture = Promise.resolve();
let ecrituresEnCours = 0;
let resoudrePret;
// Lot en cours de constitution (écritures demandées dans la même tâche JS).
let lotCourant = null;
// Incrémentée après un échec : les lots encore en file, calculés sur des
// données périmées, sont abandonnés au lieu d'écraser l'état du serveur.
let generation = 0;
// Versions des lignes de stock que ce poste a lui-même fait évoluer :
// "ref|espace" -> Map(version envoyée -> version obtenue).
let versionsSuivies = new Map();

export const MESSAGE_CONFLIT =
    "Un autre poste vient de modifier ce produit pendant votre saisie.\n\n" +
    "Votre dernière opération n'a PAS été enregistrée, pour ne pas effacer la sienne. " +
    "Les données à jour viennent d'être rechargées : vérifiez puis recommencez.";

/** Résolue quand les données ont été chargées une première fois. */
export const pret = new Promise(resolve => { resoudrePret = resolve; });

function copie(valeur) {
    return valeur === undefined ? undefined : JSON.parse(JSON.stringify(valeur));
}

/** Numéro d'ordre d'une révision "demarrage-n" (null si autre démarrage). */
function numeroRevision(revision, reference) {
    if (!revision || !reference) return null;
    const [boot, n] = String(revision).split("-");
    const [bootRef] = String(reference).split("-");
    return boot === bootRef ? parseInt(n, 10) : null;
}

/** Appel JSON au serveur. Rejette avec un message lisible en cas d'erreur. */
export async function api(methode, route, corps) {
    const options = { method: methode, headers: {} };
    if (corps !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(corps);
    }
    let reponse;
    try {
        reponse = await fetch(route, options);
    } catch (e) {
        throw new Error("Serveur injoignable. Vérifiez que serveur.py tourne sur le poste principal.");
    }
    let data = {};
    try {
        data = await reponse.json();
    } catch (e) {
        data = {};
    }
    if (!reponse.ok || data.status === "error") {
        const erreur = new Error(data.message || `Erreur ${reponse.status}`);
        erreur.status = reponse.status;
        erreur.conflit = Boolean(data.conflit);
        throw erreur;
    }
    return data;
}

/** Charge (ou recharge) toutes les données depuis le serveur. */
export async function chargerEtat() {
    const data = await api("GET", "/api/etat");
    setDbCache(data.base);
    versionsSuivies = new Map();
    documents = data.documents || {};
    revisionConnue = data.revision;
    resoudrePret();
    return data;
}

/** Retient la révision renvoyée si rien d'autre n'a changé entre-temps. */
function suivreRevision(data) {
    const n = numeroRevision(data.revision, revisionConnue);
    const attendu = numeroRevision(revisionConnue, revisionConnue);
    if (n !== null && attendu !== null && n === attendu + 1) {
        revisionConnue = data.revision;
    }
}

/**
 * Écriture ordonnée : les requêtes partent l'une après l'autre, dans l'ordre
 * où l'interface les a demandées (une sortie de stock suit son transfert...).
 */
function ecrire(methode, route, corps) {
    ecrituresEnCours++;
    const tache = fileEcriture.then(async () => {
        try {
            const data = await api(methode, route, corps);
            suivreRevision(data);
            return data;
        } catch (e) {
            console.error(`Erreur d'enregistrement [${methode} ${route}] :`, e);
            alert(`Erreur de sauvegarde : ${e.message}`);
            return null;
        } finally {
            ecrituresEnCours--;
        }
    });
    fileEcriture = tache;
    return tache;
}

const enc = encodeURIComponent;
const cleLigne = (d) => `${d.reference}|${d.utilisateur}`;

/** Version attendue par le serveur : celle lue, avancée de nos propres écritures. */
function versionAttendue(donnees) {
    let version = (donnees.version === undefined || donnees.version === null) ? null : donnees.version;
    const suivi = versionsSuivies.get(cleLigne(donnees));
    const vues = new Set();
    while (suivi && suivi.has(String(version)) && !vues.has(String(version))) {
        vues.add(String(version));
        version = suivi.get(String(version));
    }
    return version;
}

/** Note la nouvelle version d'une ligne écrite par ce poste. */
function retenirVersion(envoyee, resultat) {
    if (!resultat || resultat.version === undefined || !resultat.reference) return;
    const cle = cleLigne(resultat);
    if (!versionsSuivies.has(cle)) versionsSuivies.set(cle, new Map());
    versionsSuivies.get(cle).set(String(envoyee), resultat.version);
    const ligne = findStockEntry(loadDB(), resultat.reference, resultat.utilisateur);
    if (ligne && (ligne.version === undefined || ligne.version === null || ligne.version === envoyee)) {
        ligne.version = resultat.version;
    }
}

/** Après un échec : l'écran est resynchronisé sur le serveur, puis on prévient. */
async function apresEchec(e) {
    generation++;
    try {
        await chargerEtat();
        window.dispatchEvent(new CustomEvent("donnees-modifiees"));
    } catch (erreur) {
        /* serveur injoignable : on garde l'affichage actuel */
    }
    alert(e.conflit ? MESSAGE_CONFLIT : `Erreur de sauvegarde : ${e.message}\n\nCette opération n'a pas été enregistrée.`);
}

/** Envoie le lot constitué pendant la tâche JS qui vient de se terminer. */
function envoyerLot() {
    const ops = lotCourant;
    lotCourant = null;
    const gen = generation;
    fileEcriture = fileEcriture.then(async () => {
        try {
            if (gen !== generation) {
                ops.forEach(o => o.resolve(null));     // calculé avant un échec : abandonné
                return;
            }
            const envoyees = ops.map(o => (o.action === "updateStockItem"
                ? { ...o.donnees, version: versionAttendue(o.donnees) }
                : o.donnees));
            const data = await api("POST", "/api/lot", {
                operations: ops.map((o, i) => ({ action: o.action, donnees: envoyees[i] }))
            });
            suivreRevision(data);
            const resultats = data.resultats || [];
            ops.forEach((o, i) => {
                if (o.action === "updateStockItem") retenirVersion(envoyees[i].version, resultats[i]);
                o.resolve({ status: "ok", revision: data.revision, ...(resultats[i] || {}) });
            });
        } catch (e) {
            console.error("Erreur d'enregistrement :", e);
            ops.forEach(o => o.resolve(null));
            await apresEchec(e);
        } finally {
            ecrituresEnCours -= ops.length;
        }
    });
}

/**
 * Persiste une modification de la base (remplace l'ancien pont Qt).
 * Les arguments JSON peuvent être passés en chaîne ou en objet.
 * Résolue avec le résultat de l'opération, ou null si elle a échoué.
 */
export function persister(action, ...args) {
    const obj = (v) => (typeof v === "string" ? JSON.parse(v) : v);
    let donnees;
    switch (action) {
        case "updateProduit":
        case "updateStockItem":
        case "addTransaction":
        case "addAutoclave":
        case "addHistoriquePrix":
            donnees = obj(args[0]);
            break;
        case "deleteStockItem": donnees = { reference: args[0], utilisateur: args[1] }; break;
        case "deleteProduit": donnees = { reference: args[0] }; break;
        default:
            console.error("Action de persistance inconnue :", action);
            return Promise.resolve(null);
    }
    if (lotCourant === null) {
        lotCourant = [];
        queueMicrotask(envoyerLot);
    }
    ecrituresEnCours++;
    return new Promise(resolve => lotCourant.push({ action, donnees, resolve }));
}

/* ---------------- Documents (planning, tâches, rappels...) ---------------- */

/** Copie du document en cache (les modifications ne sont pas enregistrées). */
export function getDocument(cle, defaut = null) {
    return cle in documents ? copie(documents[cle]) : copie(defaut);
}

/** Enregistre un document (cache local immédiat + envoi au serveur). */
export function setDocument(cle, valeur) {
    documents[cle] = copie(valeur);
    return ecrire("PUT", `/api/documents/${enc(cle)}`, valeur);
}

/* ---------------- Fichiers ---------------- */

/** Déclenche le téléchargement d'un fichier reçu en base64. */
export function telechargerBase64(nomFichier, contenuBase64, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const binaire = atob(contenuBase64);
    const octets = new Uint8Array(binaire.length);
    for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([octets], { type }));
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = nomFichier;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Demande un export Excel au serveur et télécharge le fichier. */
export async function exporter(type, parametres = {}) {
    const data = await api("POST", `/api/export/${type}`, parametres);
    if (data.status === "Succès" && data.contenu_base64) {
        telechargerBase64(data.nom_fichier, data.contenu_base64);
    }
    return data;
}

/* ---------------- Surveillance des autres postes ---------------- */

async function verifierRevision() {
    if (ecrituresEnCours > 0 || document.hidden) return;
    try {
        const data = await api("GET", "/api/revision");
        if (revisionConnue !== null && data.revision !== revisionConnue && ecrituresEnCours === 0) {
            await chargerEtat();
            window.dispatchEvent(new CustomEvent("donnees-modifiees"));
        }
    } catch (e) {
        /* serveur momentanément injoignable : on réessaiera */
    }
}

/** Premier chargement + démarrage de la surveillance. */
export async function demarrer() {
    await chargerEtat();
    setInterval(verifierRevision, INTERVALLE_SURVEILLANCE);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) verifierRevision();
    });
}

// Accès pour les scripts classiques (settings.js, animation.js)
// et les pages en iframe (carnet d'adresses, animation du cabinet).
if (typeof window !== "undefined") {
    window.api = api;
    window.getDocument = getDocument;
    window.setDocument = setDocument;
    window.exporter = exporter;
    window.donneesPretes = pret;
}
