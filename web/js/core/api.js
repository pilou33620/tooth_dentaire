"use strict";

/* ============================================================
   API - Communication avec le serveur Python (serveur.py)

   - chargerEtat()      : charge toute la base + les documents (GET /api/etat)
   - persister(...)     : écrit une modification (file d'attente ordonnée)
   - getDocument / setDocument : planning, tâches, dosimètres, rappels...
   - surveillance       : recharge les données quand un autre poste
                          du cabinet a modifié quelque chose.
   ============================================================ */

import { setDbCache } from './database.js';

const INTERVALLE_SURVEILLANCE = 4000; // ms

let documents = {};
let revisionConnue = null;
let fileEcriture = Promise.resolve();
let ecrituresEnCours = 0;
let resoudrePret;

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
        throw new Error(data.message || `Erreur ${reponse.status}`);
    }
    return data;
}

/** Charge (ou recharge) toutes les données depuis le serveur. */
export async function chargerEtat() {
    const data = await api("GET", "/api/etat");
    setDbCache(data.base);
    documents = data.documents || {};
    revisionConnue = data.revision;
    resoudrePret();
    return data;
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
            const n = numeroRevision(data.revision, revisionConnue);
            const attendu = numeroRevision(revisionConnue, revisionConnue);
            // Révision suivante attendue : rien d'autre n'a changé entre-temps.
            if (n !== null && attendu !== null && n === attendu + 1) {
                revisionConnue = data.revision;
            }
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

/**
 * Persiste une modification de la base (remplace l'ancien pont Qt).
 * Les arguments JSON peuvent être passés en chaîne ou en objet.
 */
export function persister(action, ...args) {
    const obj = (v) => (typeof v === "string" ? JSON.parse(v) : v);
    switch (action) {
        case "updateProduit": return ecrire("POST", "/api/produit", obj(args[0]));
        case "updateStockItem": return ecrire("POST", "/api/stock", obj(args[0]));
        case "deleteStockItem": return ecrire("DELETE", `/api/stock?reference=${enc(args[0])}&utilisateur=${enc(args[1])}`);
        case "deleteProduit": return ecrire("DELETE", `/api/produit?reference=${enc(args[0])}`);
        case "addTransaction": return ecrire("POST", "/api/transaction", obj(args[0]));
        case "addAutoclave": return ecrire("POST", "/api/maintenance", obj(args[0]));
        case "addHistoriquePrix": return ecrire("POST", "/api/historique-prix", obj(args[0]));
        default:
            console.error("Action de persistance inconnue :", action);
            return Promise.resolve(null);
    }
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
