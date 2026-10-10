"use strict";

/* ============================================================
   API - Communication avec le serveur Python (serveur.py)

   - chargerEtat()      : charge toute la base + les documents (GET /api/etat)
   - persister(...)     : écrit une modification (file d'attente ordonnée).
                          Les écritures d'une même action (sortie de stock +
                          ses transactions...) partent en un seul lot, tout
                          ou rien ; une ligne de stock modifiée entre-temps
                          par un autre poste fait refuser le lot (conflit).
   - getDocument / modifierDocument / setDocument : planning, tâches,
                          dosimètres, rappels... Chaque document a une version :
                          une modification faite sur une copie périmée est
                          refusée par le serveur (409) puis rejouée sur la
                          version à jour, au lieu d'écraser l'autre poste.
   - surveillance       : recharge les données quand un autre poste
                          du cabinet a modifié quelque chose (sauf pendant une
                          saisie : la fenêtre ouverte garde les données lues).
   ============================================================ */

import { setDbCache, loadDB, findStockEntry } from './database.js';

const INTERVALLE_SURVEILLANCE = 4000; // ms

// Documents : vue affichée = dernière valeur confirmée par le serveur
// + modifications de ce poste pas encore confirmées (rejouées dans l'ordre).
let documents = {};
let confirmes = {};          // cle -> { valeur, version } (version null : inconnue)
let enAttente = {};          // cle -> [fonctions de modification pas encore envoyées]
let enCours = {};            // cle -> [fonctions en cours d'envoi]
const envoisPrevus = new Map();
let revisionConnue = null;
// Écart entre l'horloge du serveur et celle de ce poste (ms)
let decalageHorloge = 0;
// Fonction qui indique qu'une saisie est en cours (surveillance suspendue)
let pauseSurveillance = null;
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
export async function api(methode, route, corps, entetes = {}) {
    const options = { method: methode, headers: { ...entetes } };
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
        erreur.data = data;
        throw erreur;
    }
    return data;
}

/** Heure du serveur (ms), estimée à partir des réponses reçues. */
export function maintenantServeur() {
    return Date.now() + decalageHorloge;
}

function noterHeureServeur(data, debut, fin) {
    const heure = Number(data && data.heure);
    if (Number.isFinite(heure) && heure > 0) decalageHorloge = heure - (debut + fin) / 2;
}

/** Une écriture de ce poste est-elle en préparation ou en route ? */
function ecritureEnAttente() {
    return lotCourant !== null || ecrituresEnCours > 0;
}

/**
 * Charge (ou recharge) toutes les données depuis le serveur.
 * Si ce poste a commencé une écriture pendant la requête, l'état reçu est
 * ignoré (renvoie null) : il effacerait la modification qui vient d'être
 * faite à l'écran ; la surveillance rechargera après l'écriture.
 * `force` : rechargement après un échec (les écritures en file sont abandonnées).
 */
export async function chargerEtat({ force = false } = {}) {
    const debut = Date.now();
    const data = await api("GET", "/api/etat");
    if (!force && revisionConnue !== null && ecritureEnAttente()) return null;
    noterHeureServeur(data, debut, Date.now());
    setDbCache(data.base);
    versionsSuivies = new Map();
    const versions = data.versions_documents || {};
    confirmes = {};
    for (const [cle, valeur] of Object.entries(data.documents || {})) {
        confirmes[cle] = { valeur, version: Number.isInteger(versions[cle]) ? versions[cle] : null };
    }
    for (const cle of new Set([...Object.keys(confirmes), ...Object.keys(documents)])) recalculerVue(cle);
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
        await chargerEtat({ force: true });
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

function appliquer(fonctions, valeur) {
    let v = copie(valeur);
    for (const f of fonctions) {
        const r = f(v);
        if (r !== undefined) v = r;
    }
    return v;
}

/** Vue d'un document = valeur confirmée + modifications locales en attente. */
function recalculerVue(cle) {
    const fonctions = [...(enCours[cle] || []), ...(enAttente[cle] || [])];
    if (!confirmes[cle] && fonctions.length === 0) {
        delete documents[cle];
        return;
    }
    documents[cle] = appliquer(fonctions, confirmes[cle] ? confirmes[cle].valeur : null);
}

/** Copie du document en cache (les modifications ne sont pas enregistrées). */
export function getDocument(cle, defaut = null) {
    return cle in documents ? copie(documents[cle]) : copie(defaut);
}

/** Version du document connue par ce poste (null si le serveur ne la donne pas). */
export function versionDocument(cle) {
    return confirmes[cle] ? confirmes[cle].version : null;
}

function entetesVersion(version) {
    return Number.isInteger(version) ? { "X-Version-Document": String(version) } : {};
}

async function relireDocument(cle) {
    const data = await api("GET", `/api/documents/${enc(cle)}`);
    confirmes[cle] = { valeur: data.valeur, version: Number.isInteger(data.version) ? data.version : null };
}

function apresEchecDocument(cle, e) {
    console.error(`Erreur d'enregistrement du document « ${cle} » :`, e);
    recalculerVue(cle);
    window.dispatchEvent(new CustomEvent("donnees-modifiees"));
    alert(`Erreur de sauvegarde : ${e.message}\n\nCette modification n'a pas été enregistrée.`);
}

/** Envoie les modifications en attente d'un document (dans la file d'écriture). */
async function envoyerDocument(cle) {
    enCours[cle] = enAttente[cle] || [];
    enAttente[cle] = [];
    try {
        for (let essai = 0; essai < 4; essai++) {
            const confirme = confirmes[cle];
            const valeur = appliquer(enCours[cle], confirme.valeur);
            try {
                const data = await api("PUT", `/api/documents/${enc(cle)}`, valeur, entetesVersion(confirme.version));
                suivreRevision(data);
                confirmes[cle] = {
                    valeur,
                    version: Number.isInteger(data.version) ? data.version
                        : (Number.isInteger(confirme.version) ? confirme.version + 1 : null)
                };
                enCours[cle] = [];
                recalculerVue(cle);
                return data;
            } catch (e) {
                if (!e.conflit || essai === 3) throw e;
                // Un autre poste a écrit entre-temps : on rejoue sur sa version.
                await relireDocument(cle);
                recalculerVue(cle);
            }
        }
        return null;
    } catch (e) {
        enCours[cle] = [];
        apresEchecDocument(cle, e);
        return null;
    }
}

/**
 * Modifie un document : `modification(copie)` reçoit une copie de la valeur
 * et la modifie (ou renvoie la nouvelle valeur). Appliquée tout de suite à
 * l'écran, puis envoyée au serveur ; si un autre poste a écrit le document
 * entre-temps, elle est rejouée sur sa version au lieu de l'écraser.
 * Résolue avec la réponse du serveur, ou null en cas d'échec.
 */
export function modifierDocument(cle, modification) {
    if (!confirmes[cle]) {
        // Document jamais reçu du serveur : on part de la valeur affichée
        confirmes[cle] = { valeur: cle in documents ? copie(documents[cle]) : null, version: null };
    }
    if (!enAttente[cle]) enAttente[cle] = [];
    enAttente[cle].push(modification);
    recalculerVue(cle);
    if (envoisPrevus.has(cle)) return envoisPrevus.get(cle);
    ecrituresEnCours++;
    const tache = fileEcriture.then(async () => {
        envoisPrevus.delete(cle);
        try {
            return await envoyerDocument(cle);
        } finally {
            ecrituresEnCours--;
        }
    });
    fileEcriture = tache;
    envoisPrevus.set(cle, tache);
    return tache;
}

/** Remplace tout le document (la dernière écriture l'emporte). */
export function setDocument(cle, valeur) {
    const nouvelle = copie(valeur);
    return modifierDocument(cle, () => copie(nouvelle));
}

/**
 * Enregistre un document édité dans une fenêtre (planning, tâches...) à
 * condition qu'il n'ait pas changé depuis `versionLue` (versionDocument() à
 * l'ouverture). Résolue avec { conflit: true } si un autre poste l'a
 * modifié entre-temps : rien n'est écrit, l'appelant demande quoi faire.
 */
export function enregistrerBrouillon(cle, valeur, versionLue) {
    ecrituresEnCours++;
    const tache = fileEcriture.then(async () => {
        try {
            const data = await api("PUT", `/api/documents/${enc(cle)}`, valeur, entetesVersion(versionLue));
            suivreRevision(data);
            confirmes[cle] = {
                valeur: copie(valeur),
                version: Number.isInteger(data.version) ? data.version : null
            };
            recalculerVue(cle);
            return data;
        } catch (e) {
            if (e.conflit) return { conflit: true };
            apresEchecDocument(cle, e);
            return null;
        } finally {
            ecrituresEnCours--;
        }
    });
    fileEcriture = tache;
    return tache;
}

/**
 * Enregistre ce qui a été saisi dans une fenêtre d'édition. Si le document
 * a été modifié ailleurs depuis l'ouverture, on demande avant d'écraser.
 * Résolue avec true si c'est enregistré.
 */
export async function enregistrerEdition(cle, valeur, versionLue, libelle) {
    const r = await enregistrerBrouillon(cle, valeur, versionLue);
    if (r && r.conflit) {
        const ecraser = confirm(`${libelle} vient d'être modifié sur un autre poste pendant votre saisie.\n\n`
            + "OK : enregistrer votre version (les modifications de l'autre poste seront remplacées).\n"
            + "Annuler : ne rien enregistrer et revenir à votre saisie.");
        if (!ecraser) return false;
        return Boolean(await setDocument(cle, valeur));
    }
    return Boolean(r);
}

/** Recharge tout depuis le serveur et prévient l'interface (après un conflit...). */
export async function recharger() {
    try {
        if (await chargerEtat({ force: true })) window.dispatchEvent(new CustomEvent("donnees-modifiees"));
    } catch (e) {
        /* serveur injoignable : on garde l'affichage actuel */
    }
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

/**
 * `fonction()` vraie pendant une saisie (fenêtre de modification ouverte) :
 * les données ne sont alors pas rechargées sous la fenêtre. L'enregistrement
 * part avec la version lue à l'ouverture ; si un autre poste a modifié la
 * même ligne entre-temps, le serveur le refuse (conflit) au lieu d'écraser.
 */
export function definirPauseSurveillance(fonction) {
    pauseSurveillance = typeof fonction === "function" ? fonction : null;
}

function enPause() {
    try {
        return Boolean(pauseSurveillance && pauseSurveillance());
    } catch (e) {
        return false;
    }
}

export async function verifierRevision() {
    if (ecrituresEnCours > 0 || document.hidden || enPause()) return;
    try {
        const debut = Date.now();
        const data = await api("GET", "/api/revision");
        noterHeureServeur(data, debut, Date.now());
        if (revisionConnue !== null && data.revision !== revisionConnue
                && ecrituresEnCours === 0 && !enPause()) {
            if (await chargerEtat()) window.dispatchEvent(new CustomEvent("donnees-modifiees"));
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
    window.modifierDocument = modifierDocument;
    window.exporter = exporter;
    window.donneesPretes = pret;
}
