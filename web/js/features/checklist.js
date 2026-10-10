"use strict";

/* ============================================================
   Checklist d'ouverture et de fermeture du cabinet (widget de l'accueil)

   Document "checklist" en base :
   {
     modele: [ { id, moment: "ouverture" | "fermeture", libelle } ],
     jour:   "AAAA-MM-JJ"   (jour auquel se rapportent les cases cochées)
     fait:   { <id>: { qui, heure: "HH:MM" } }
   }
   Les cases repartent à zéro automatiquement chaque jour : une coche
   d'un autre jour n'est jamais affichée.
   ============================================================ */

import { getDocument, modifierDocument, maintenantServeur } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

export const CLE_CHECKLIST = "checklist";
export const MOMENTS = ["ouverture", "fermeture"];
const CLE_QUI = "bj-checklist-qui";      // prénom retenu sur ce poste (localStorage)

let brouillon = null;        // modèle en cours d'édition
// Onglet choisi à la main : vaut jusqu'au prochain changement de moment (13 h, minuit)
let ongletChoisi = null;     // { moment, pour: <moment par défaut au moment du choix>, jour }

const pad = n => String(n).padStart(2, "0");

// Heure du serveur : tous les postes changent de jour ensemble, même si
// l'horloge de l'un d'eux avance ou retarde de quelques minutes.
const maintenantCabinet = () => new Date(maintenantServeur());

export function dateDuJour(maintenant = maintenantCabinet()) {
    return `${maintenant.getFullYear()}-${pad(maintenant.getMonth() + 1)}-${pad(maintenant.getDate())}`;
}

export function heureCourte(maintenant = maintenantCabinet()) {
    return `${pad(maintenant.getHours())}:${pad(maintenant.getMinutes())}`;
}

/** Le matin on montre l'ouverture, l'après-midi la fermeture. */
export function momentParDefaut(maintenant = maintenantCabinet()) {
    return maintenant.getHours() < 13 ? "ouverture" : "fermeture";
}

export function normaliserChecklist(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const modele = (Array.isArray(d.modele) ? d.modele : [])
        .filter(t => t && typeof t.libelle === "string" && t.libelle.trim() !== "")
        .map((t, i) => ({
            id: String(t.id || `t${i}`),
            moment: MOMENTS.includes(t.moment) ? t.moment : "ouverture",
            libelle: t.libelle.trim().slice(0, 120)
        }));
    const fait = (d.fait && typeof d.fait === "object" && !Array.isArray(d.fait)) ? d.fait : {};
    return { modele, jour: typeof d.jour === "string" ? d.jour : "", fait };
}

/** Coches valables aujourd'hui (celles d'un autre jour sont ignorées). */
export function cochesDuJour(doc, maintenant = maintenantCabinet()) {
    return doc.jour === dateDuJour(maintenant) ? doc.fait : {};
}

export function progression(doc, moment, maintenant = maintenantCabinet()) {
    const taches = doc.modele.filter(t => t.moment === moment);
    const coches = cochesDuJour(doc, maintenant);
    return { faits: taches.filter(t => coches[t.id]).length, total: taches.length };
}

function lire() {
    return normaliserChecklist(getDocument(CLE_CHECKLIST));
}

/** Coche ou décoche une tâche pour aujourd'hui. Renvoie le nouvel état (true = cochée). */
export function basculerTache(id, qui = "", maintenant = maintenantCabinet()) {
    const actuel = lire();
    if (!actuel.modele.some(t => t.id === id)) return null;
    const jour = dateDuJour(maintenant);
    // État voulu, décidé sur ce qu'affiche l'écran : rejouée sur la version
    // d'un autre poste, la modification ne touche que cette tâche.
    const coche = !cochesDuJour(actuel, maintenant)[id];
    const coche_ = { qui: String(qui || "").trim().slice(0, 40), heure: heureCourte(maintenant) };
    modifierDocument(CLE_CHECKLIST, valeur => {
        const doc = normaliserChecklist(valeur);
        if (doc.jour !== jour) {
            doc.jour = jour;
            doc.fait = {};
        }
        if (coche) doc.fait[id] = coche_;
        else delete doc.fait[id];
        return doc;
    });
    return coche;
}

/** Remplace la liste des tâches (les coches des tâches supprimées disparaissent). */
export function enregistrerModele(modele) {
    const propre = normaliserChecklist({ modele }).modele;
    const ids = new Set(propre.map(t => t.id));
    modifierDocument(CLE_CHECKLIST, valeur => {
        const doc = normaliserChecklist(valeur);
        const fait = {};
        for (const [id, v] of Object.entries(doc.fait)) if (ids.has(id)) fait[id] = v;
        return { modele: propre, jour: doc.jour, fait };
    });
    return propre;
}

/** Prénoms proposés : les assistantes du planning. */
export function prenomsDuPlanning() {
    const planning = getDocument("planning") || {};
    const noms = new Set();
    for (const parite of ["even", "odd"]) {
        for (const ligne of (Array.isArray(planning[parite]) ? planning[parite] : [])) {
            const nom = ligne && typeof ligne.assistant === "string" ? ligne.assistant.trim() : "";
            if (nom) noms.add(nom);
        }
    }
    return [...noms].sort((a, b) => a.localeCompare(b, "fr"));
}

function lireLocal(cle) {
    try { return localStorage.getItem(cle) || ""; } catch (e) { return ""; }
}

function ecrireLocal(cle, valeur) {
    try { localStorage.setItem(cle, valeur); } catch (e) { /* stockage indisponible */ }
}

/* ---------------- Affichage du widget ---------------- */

export function ongletActif(maintenant = maintenantCabinet()) {
    const defaut = momentParDefaut(maintenant);
    if (ongletChoisi && ongletChoisi.pour === defaut && ongletChoisi.jour === dateDuJour(maintenant)) {
        return ongletChoisi.moment;
    }
    return defaut;
}

export function choisirOnglet(moment, maintenant = maintenantCabinet()) {
    if (!MOMENTS.includes(moment)) return;
    ongletChoisi = { moment, pour: momentParDefaut(maintenant), jour: dateDuJour(maintenant) };
}

export function afficherChecklist(doc = document, maintenant = maintenantCabinet()) {
    const liste = doc.getElementById("checklist-liste");
    if (!liste) return;
    const donnees = lire();
    const coches = cochesDuJour(donnees, maintenant);
    const moment = ongletActif(maintenant);

    // Onglets avec compteur
    doc.querySelectorAll("#checklist-onglets [data-moment]").forEach(b => {
        const p = progression(donnees, b.dataset.moment, maintenant);
        b.classList.toggle("actif", b.dataset.moment === moment);
        const compteur = b.querySelector(".bj-compte");
        if (compteur) compteur.textContent = p.total ? `${p.faits}/${p.total}` : "";
        b.classList.toggle("bj-complet", p.total > 0 && p.faits === p.total);
    });

    const p = progression(donnees, moment, maintenant);
    const barre = doc.getElementById("checklist-barre");
    if (barre) barre.style.width = p.total ? `${Math.round(p.faits / p.total * 100)}%` : "0%";

    const taches = donnees.modele.filter(t => t.moment === moment);
    if (taches.length === 0) {
        liste.innerHTML = `<li class="bj-vide">Aucune tâche. « Modifier la liste » pour en ajouter.</li>`;
        return;
    }
    liste.innerHTML = taches.map(t => {
        const c = coches[t.id];
        const detail = c ? [c.qui, c.heure].filter(Boolean).join(" · ") : "";
        return `
            <li>
                <button type="button" class="bj-tache${c ? " fait" : ""}" data-id="${escapeHtml(t.id)}"
                        role="checkbox" aria-checked="${c ? "true" : "false"}">
                    <span class="bj-coche" aria-hidden="true"></span>
                    <span class="bj-tache-libelle">${escapeHtml(t.libelle)}</span>
                    <span class="bj-tache-detail">${escapeHtml(detail)}</span>
                </button>
            </li>`;
    }).join("");
}

function remplirPrenoms(doc) {
    const datalist = doc.getElementById("checklist-qui-liste");
    if (datalist) {
        datalist.innerHTML = prenomsDuPlanning().map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
    }
}

/* ---------------- Éditeur de la liste ---------------- */

function afficherEditeur(doc = document) {
    const zone = doc.getElementById("checklist-editeur");
    if (!zone || !brouillon) return;
    zone.innerHTML = brouillon.map((t, i) => `
        <div class="bj-editeur-ligne" data-index="${i}">
            <input type="text" class="input" data-champ="libelle" value="${escapeHtml(t.libelle)}" maxlength="120" placeholder="Tâche">
            <select class="input" data-champ="moment">
                <option value="ouverture"${t.moment === "ouverture" ? " selected" : ""}>Ouverture</option>
                <option value="fermeture"${t.moment === "fermeture" ? " selected" : ""}>Fermeture</option>
            </select>
            <button type="button" class="btn btn-small" data-supprimer="${i}" title="Supprimer">✕</button>
        </div>`).join("") || `<p class="bj-aide">La liste est vide.</p>`;
}

export function ouvrirEditeur(doc = document) {
    brouillon = lire().modele.map(t => ({ ...t }));
    afficherEditeur(doc);
    const overlay = doc.getElementById("checklist-overlay");
    if (overlay) overlay.classList.remove("hidden");
}

/* ---------------- Initialisation ---------------- */

export function initChecklist(doc = document) {
    ongletChoisi = null;

    const qui = doc.getElementById("checklist-qui");
    if (qui) {
        qui.value = lireLocal(CLE_QUI);
        qui.addEventListener("change", () => ecrireLocal(CLE_QUI, qui.value.trim()));
    }
    remplirPrenoms(doc);

    doc.querySelectorAll("#checklist-onglets [data-moment]").forEach(b => {
        b.addEventListener("click", () => {
            choisirOnglet(b.dataset.moment);
            afficherChecklist(doc);
        });
    });

    const liste = doc.getElementById("checklist-liste");
    if (liste) {
        liste.addEventListener("click", e => {
            const b = e.target.closest(".bj-tache[data-id]");
            if (!b) return;
            const nom = qui ? qui.value.trim() : "";
            if (qui) ecrireLocal(CLE_QUI, nom);
            basculerTache(b.dataset.id, nom);
            afficherChecklist(doc);
        });
    }

    const modifier = doc.getElementById("checklist-modifier");
    if (modifier) modifier.addEventListener("click", () => ouvrirEditeur(doc));

    const zone = doc.getElementById("checklist-editeur");
    if (zone) {
        const saisir = e => {
            const ligne = e.target.closest("[data-index]");
            if (!ligne || !brouillon) return;
            const t = brouillon[Number(ligne.dataset.index)];
            if (t && e.target.dataset.champ) t[e.target.dataset.champ] = e.target.value;
        };
        zone.addEventListener("input", saisir);
        zone.addEventListener("change", saisir);
        zone.addEventListener("click", e => {
            const b = e.target.closest("[data-supprimer]");
            if (!b || !brouillon) return;
            brouillon.splice(Number(b.dataset.supprimer), 1);
            afficherEditeur(doc);
        });
    }

    const ajouter = doc.getElementById("checklist-ajouter");
    if (ajouter) {
        ajouter.addEventListener("click", () => {
            if (!brouillon) return;
            brouillon.push({ id: `t${Date.now().toString(36)}`, moment: ongletActif(), libelle: "" });
            afficherEditeur(doc);
            const champs = doc.querySelectorAll("#checklist-editeur [data-champ='libelle']");
            if (champs.length) champs[champs.length - 1].focus();
        });
    }

    const enregistrer = doc.getElementById("checklist-enregistrer");
    if (enregistrer) {
        enregistrer.addEventListener("click", () => {
            if (!brouillon) return;
            enregistrerModele(brouillon);
            brouillon = null;
            doc.getElementById("checklist-overlay")?.classList.add("hidden");
            afficherChecklist(doc);
        });
    }
    doc.querySelectorAll('[data-close="checklist-overlay"]').forEach(b =>
        b.addEventListener("click", () => { brouillon = null; }));

    afficherChecklist(doc);
    // Passage ouverture → fermeture à 13 h, remise à zéro à minuit
    setInterval(() => afficherChecklist(doc), 60000);
}

/** Après une modification faite sur un autre poste. */
export function rafraichirChecklist(doc = document) {
    remplirPrenoms(doc);
    afficherChecklist(doc);
}
