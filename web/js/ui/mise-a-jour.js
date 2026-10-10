"use strict";

/* ============================================================
   Mises à jour de l'outil (python/mise_a_jour.py)

   Le serveur vérifie GitHub toutes les 4 heures. Chaque poste lui demande
   l'état régulièrement (requête locale, sans internet) et, si une nouvelle
   version existe, propose de l'installer dans un bandeau. Après
   l'installation le serveur redémarre : la page attend son retour puis se
   recharge. Les autres postes voient la nouvelle version et se rechargent
   aussi (bouton « Recharger »).
   ============================================================ */

import { api } from '../core/api.js';

const INTERVALLE_ETAT = 10 * 60 * 1000;        // ms : état demandé au serveur
const INTERVALLE_RETOUR = 2000;                // ms : attente du redémarrage
const DELAI_RETOUR_MAX = 3 * 60 * 1000;        // ms

let versionChargee = null;      // version du code chargé par cette page
let ignoreeJusqua = { version: null, quand: 0 };
let installationEnCours = false;

const $ = (id) => document.getElementById(id);

function formaterDate(secondes) {
    if (!secondes) return "jamais";
    return new Date(secondes * 1000).toLocaleString("fr-FR", {
        weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
}

function afficherBandeau(texte, boutons) {
    const bandeau = $("maj-bandeau");
    if (!bandeau) return;
    $("maj-texte").textContent = texte;
    $("maj-installer").classList.toggle("hidden", !boutons.installer);
    $("maj-recharger").classList.toggle("hidden", !boutons.recharger);
    $("maj-plus-tard").classList.toggle("hidden", !boutons.plusTard);
    bandeau.classList.remove("hidden");
}

function masquerBandeau() {
    $("maj-bandeau")?.classList.add("hidden");
}

/** Met à jour la section « Mises à jour » des Réglages. */
function afficherReglages(etat) {
    const zone = $("maj-reglages-etat");
    if (!zone) return;
    const lignes = [`Version installée : ${etat.version_locale || "inconnue"}`,
                    `Dernière vérification : ${formaterDate(etat.verifie_le)}`];
    if (etat.disponible) {
        lignes.push(`Nouvelle version disponible (${etat.nombre} changement${etat.nombre > 1 ? "s" : ""}).`);
        if (!installableIci(etat)) lignes.push("Elle s'installe depuis le poste qui fait tourner le serveur.");
    } else if (etat.raison) {
        lignes.push(etat.raison);
    } else if (etat.verifie_le) {
        lignes.push("L'outil est à jour.");
    }
    zone.textContent = lignes.join("\n");
    $("maj-reglages-installer")?.classList.toggle("hidden", !(etat.disponible && installableIci(etat)));
}

/** La mise à jour ne s'installe que depuis le poste serveur (ancien serveur : partout). */
function installableIci(etat) {
    return etat.installable_ici !== false;
}

/** Décide quoi montrer à partir de l'état renvoyé par le serveur. */
export function traiterEtat(etat, maintenant = Date.now()) {
    if (!etat || installationEnCours) return;
    afficherReglages(etat);

    if (versionChargee === null) versionChargee = etat.version_locale || "";
    if (etat.version_locale && versionChargee && etat.version_locale !== versionChargee) {
        // Un autre poste a installé la mise à jour : cette page a l'ancien code
        afficherBandeau("L'outil a été mis à jour.", { recharger: true });
        return;
    }
    if (!etat.disponible) {
        masquerBandeau();
        return;
    }
    const ignoree = ignoreeJusqua.version === etat.version_distante && maintenant < ignoreeJusqua.quand;
    if (ignoree) return;
    const n = etat.nombre || (Array.isArray(etat.nouveautes) ? etat.nouveautes.length : 0);
    const texte = `Mise à jour disponible (${n} changement${n > 1 ? "s" : ""}).`;
    if (installableIci(etat)) {
        afficherBandeau(texte, { installer: true, plusTard: true });
    } else {
        afficherBandeau(`${texte} Elle s'installe depuis le poste qui fait tourner le serveur.`, { plusTard: true });
    }
}

export async function rafraichirEtat() {
    try {
        traiterEtat(await api("GET", "/api/mise-a-jour"));
    } catch (e) {
        /* serveur injoignable : on réessaiera */
    }
}

/** Attend que le serveur redémarré réponde avec la nouvelle version, puis recharge. */
async function attendreRedemarrage(versionAvant) {
    const fin = Date.now() + DELAI_RETOUR_MAX;
    while (Date.now() < fin) {
        await new Promise(r => setTimeout(r, INTERVALLE_RETOUR));
        try {
            const info = await api("GET", "/api/info");
            if (info.commit && info.commit !== versionAvant) {
                window.location.reload();
                return true;
            }
        } catch (e) {
            /* le serveur redémarre */
        }
    }
    afficherBandeau("Le serveur ne répond pas après la mise à jour : relancez Lancer.bat sur le poste principal.",
                    { recharger: true });
    return false;
}

export async function installerMiseAJour() {
    let etat;
    try {
        etat = await api("GET", "/api/mise-a-jour");
    } catch (e) {
        alert(e.message);
        return;
    }
    if (!etat.disponible) {
        traiterEtat(etat);
        return;
    }
    const liste = (etat.nouveautes || []).map(t => "• " + t).join("\n");
    const message = "Installer la mise à jour maintenant ?\n\n" + (liste ? liste + "\n\n" : "") +
        "L'outil redémarre (environ 30 secondes) sur tous les postes. " +
        "Les données du cabinet ne sont pas modifiées.";
    if (!window.confirm(message)) return;

    installationEnCours = true;
    afficherBandeau("Installation de la mise à jour…", {});
    try {
        await api("POST", "/api/mise-a-jour/installer", {});
    } catch (e) {
        installationEnCours = false;
        afficherBandeau("Mise à jour impossible : " + e.message, { plusTard: true });
        return;
    }
    afficherBandeau("Mise à jour installée. Redémarrage de l'outil…", {});
    await attendreRedemarrage(etat.version_locale);
}

async function verifierMaintenant() {
    const bouton = $("maj-reglages-verifier");
    if (bouton) bouton.disabled = true;
    try {
        traiterEtat(await api("POST", "/api/mise-a-jour/verifier", {}));
    } catch (e) {
        const zone = $("maj-reglages-etat");
        if (zone) zone.textContent = "Vérification impossible : " + e.message;
    } finally {
        if (bouton) bouton.disabled = false;
    }
}

export function initMiseAJour() {
    $("maj-installer")?.addEventListener("click", installerMiseAJour);
    $("maj-reglages-installer")?.addEventListener("click", installerMiseAJour);
    $("maj-recharger")?.addEventListener("click", () => window.location.reload());
    $("maj-reglages-verifier")?.addEventListener("click", verifierMaintenant);
    $("maj-plus-tard")?.addEventListener("click", async () => {
        // « Plus tard » : on ne le repropose pas avant 4 heures (ou une version plus récente)
        try {
            const etat = await api("GET", "/api/mise-a-jour");
            ignoreeJusqua = { version: etat.version_distante, quand: Date.now() + 4 * 60 * 60 * 1000 };
        } catch (e) { /* rien */ }
        masquerBandeau();
    });

    rafraichirEtat();
    setInterval(rafraichirEtat, INTERVALLE_ETAT);
}

/** Pour les tests. */
export function _reinitialiser() {
    versionChargee = null;
    ignoreeJusqua = { version: null, quand: 0 };
    installationEnCours = false;
}
