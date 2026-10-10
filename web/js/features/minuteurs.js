"use strict";

/* ============================================================
   Minuteurs (coin haut droit de l'accueil)

   Partagés entre les postes : un minuteur lancé en stérilisation est
   visible à l'accueil. La sonnerie ne retentit que sur le poste qui l'a
   lancé ; les autres le voient passer en « terminé ».

   Document "minuteurs" en base :
   {
     actifs:        [ { id, libelle, debut, fin, minutes } ]   (heures en ms)
     preselections: [ { libelle, minutes } ]
   }
   ============================================================ */

import { getDocument, modifierDocument, maintenantServeur } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

export const CLE_MINUTEURS = "minuteurs";
export const MAX_MINUTES = 600;
export const MAX_ACTIFS = 12;
export const MAX_PRESELECTIONS = 8;
/** Un minuteur terminé reste affiché ce temps-là avant d'être retiré. */
export const GARDE_APRES_FIN = 15 * 60 * 1000;
const CLE_LOCAUX = "bj-minuteurs-locaux";   // ids lancés depuis ce poste
const DUREE_SONNERIE = 60 * 1000;
/** Onglet en arrière-plan : le navigateur ralentit les minuteries ; un
 *  minuteur fini pendant que la page était ouverte sonne quand même. */
const RETARD_MAX_SONNERIE = 10 * 60 * 1000;

const etat = {
    sonnes: new Set(),       // ids déjà annoncés sur ce poste
    sonnerie: null,          // { id, fin, intervalle }
    audio: null,
    edition: false,
    titreOrigine: null,
    ouverture: 0             // heure d'ouverture de la page
};

// Heure du serveur : la fin d'un minuteur est calculée par le poste qui le
// lance ; tous les postes le voient se terminer au même moment.
const maintenant_ = () => maintenantServeur();

/* ---------------- Données ---------------- */

function borne(n, min, max) {
    return Math.min(max, Math.max(min, n));
}

export function normaliserMinuteurs(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const actifs = (Array.isArray(d.actifs) ? d.actifs : [])
        .filter(m => m && Number.isFinite(Number(m.fin)) && Number(m.fin) > 0)
        .map(m => ({
            id: String(m.id || ""),
            libelle: String(m.libelle || "Minuteur").trim().slice(0, 40) || "Minuteur",
            debut: Number(m.debut) || Number(m.fin),
            fin: Number(m.fin),
            minutes: Number(m.minutes) || 0
        }))
        .filter(m => m.id);
    const preselections = (Array.isArray(d.preselections) ? d.preselections : [])
        .filter(p => p && String(p.libelle || "").trim() && Number(p.minutes) > 0)
        .map(p => ({
            libelle: String(p.libelle).trim().slice(0, 40),
            minutes: borne(Math.round(Number(p.minutes) * 10) / 10, 0.1, MAX_MINUTES)
        }))
        .slice(0, MAX_PRESELECTIONS);
    return { actifs, preselections };
}

/** Lit une durée saisie : « 10 », « 2,5 », « 1:30 » (min:s) ou « 1h20 ». Renvoie des minutes. */
export function lireDuree(texte) {
    const t = String(texte || "").trim().toLowerCase().replace(",", ".");
    if (!t) return null;
    let m;
    if ((m = t.match(/^(\d+)\s*h\s*(\d{1,2})?\s*(?:min|m)?$/))) {
        return Number(m[1]) * 60 + Number(m[2] || 0);
    }
    if ((m = t.match(/^(\d+):(\d{1,2})$/))) {
        return Number(m[1]) + Number(m[2]) / 60;
    }
    if ((m = t.match(/^(\d+(?:\.\d+)?)\s*(?:min|mn|m)?$/))) {
        return Number(m[1]);
    }
    return null;
}

/** « 09:41 », ou « 1:05:00 » au-delà d'une heure. */
export function formaterRestant(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const min = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${pad(min)}:${pad(s)}`;
}

export function formaterMinutes(minutes) {
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} h`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)}`;
    if (minutes < 1) return `${Math.round(minutes * 60)} s`;
    return `${String(minutes).replace(".", ",")} min`;
}

function lire() {
    return normaliserMinuteurs(getDocument(CLE_MINUTEURS));
}

/**
 * Modification décrite par une fonction : rejouée sur la version d'un autre
 * poste si elle a changé entre-temps (deux minuteurs lancés en même temps
 * sur deux postes sont tous les deux gardés).
 */
function modifier(fonction) {
    return modifierDocument(CLE_MINUTEURS, valeur => {
        const doc = normaliserMinuteurs(valeur);
        fonction(doc);
        return doc;
    });
}

function lireLocaux() {
    try { return new Set(JSON.parse(localStorage.getItem(CLE_LOCAUX) || "[]")); } catch (e) { return new Set(); }
}

function ecrireLocaux(ids) {
    try { localStorage.setItem(CLE_LOCAUX, JSON.stringify([...ids].slice(-30))); } catch (e) { /* rien */ }
}

export function estLanceIci(id) {
    return lireLocaux().has(id);
}

export function lancerMinuteur(libelle, minutes, maintenant = maintenant_()) {
    const duree = Number(minutes);
    if (!Number.isFinite(duree) || duree <= 0) return null;
    const min = borne(duree, 1 / 60, MAX_MINUTES);
    const m = {
        id: maintenant.toString(36) + Math.random().toString(36).slice(2, 6),
        libelle: String(libelle || "").trim().slice(0, 40) || "Minuteur",
        debut: maintenant,
        fin: maintenant + Math.round(min * 60000),
        minutes: min
    };
    modifier(doc => {
        doc.actifs.push({ ...m });
        doc.actifs = doc.actifs.slice(-MAX_ACTIFS);
    });
    const locaux = lireLocaux();
    locaux.add(m.id);
    ecrireLocaux(locaux);
    return m;
}

export function arreterMinuteur(id) {
    if (!lire().actifs.some(m => m.id === id)) return false;
    modifier(doc => { doc.actifs = doc.actifs.filter(m => m.id !== id); });
    if (etat.sonnerie && etat.sonnerie.id === id) couperSonnerie();
    return true;
}

/** Retire les minuteurs terminés depuis longtemps. Renvoie le nombre retiré. */
export function nettoyer(maintenant = maintenant_()) {
    const garder = m => maintenant - m.fin < GARDE_APRES_FIN;
    const actifs = lire().actifs;
    const retires = actifs.length - actifs.filter(garder).length;
    // Le filtre est rejoué sur la version à jour : un minuteur qui vient
    // d'être lancé sur un autre poste n'est jamais effacé.
    if (retires > 0) modifier(doc => { doc.actifs = doc.actifs.filter(garder); });
    return retires;
}

export function ajouterPreselection(libelle, minutes) {
    const p = normaliserMinuteurs({ preselections: [{ libelle, minutes }] }).preselections[0];
    if (!p) return false;
    modifier(doc => {
        doc.preselections = doc.preselections.filter(x => x.libelle.toLowerCase() !== p.libelle.toLowerCase());
        doc.preselections.push({ ...p });
        doc.preselections = doc.preselections.slice(-MAX_PRESELECTIONS);
    });
    return true;
}

export function supprimerPreselection(index) {
    const visibles = lire().preselections;
    if (index < 0 || index >= visibles.length) return false;
    // Par libellé et non par position : la liste a pu changer sur un autre poste
    const cible = visibles[index].libelle.toLowerCase();
    modifier(doc => {
        doc.preselections = doc.preselections.filter(x => x.libelle.toLowerCase() !== cible);
    });
    return true;
}

/* ---------------- Sonnerie (générée, aucun fichier son) ---------------- */

function contexteAudio() {
    const Ctx = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return null;
    if (!etat.audio) etat.audio = new Ctx();
    if (etat.audio.state === "suspended") etat.audio.resume();
    return etat.audio;
}

/** À appeler lors d'un clic : les navigateurs n'autorisent le son qu'après une action. */
export function preparerSon() {
    try { contexteAudio(); } catch (e) { /* pas de son sur ce poste */ }
}

function bip(ctx, debut, frequence) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequence;
    gain.gain.setValueAtTime(0.0001, debut);
    gain.gain.exponentialRampToValueAtTime(0.35, debut + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, debut + 0.28);
    osc.connect(gain).connect(ctx.destination);
    osc.start(debut);
    osc.stop(debut + 0.3);
}

function carillon() {
    try {
        const ctx = contexteAudio();
        if (!ctx) return;
        const t = ctx.currentTime + 0.02;
        bip(ctx, t, 880);
        bip(ctx, t + 0.32, 1175);
        bip(ctx, t + 0.64, 1568);
    } catch (e) { /* son indisponible */ }
}

function sonner(id) {
    couperSonnerie();
    carillon();
    etat.sonnerie = {
        id,
        fin: Date.now() + DUREE_SONNERIE,
        intervalle: setInterval(() => {
            if (!etat.sonnerie || Date.now() > etat.sonnerie.fin) return couperSonnerie();
            carillon();
        }, 2500)
    };
}

export function couperSonnerie() {
    if (etat.sonnerie) clearInterval(etat.sonnerie.intervalle);
    etat.sonnerie = null;
}

/* ---------------- Affichage ---------------- */

export function afficherMinuteurs(doc = document, maintenant = maintenant_()) {
    const zone = doc.getElementById("minuteurs-actifs");
    if (!zone) return;
    const donnees = lire();
    const termines = [];

    const lignes = donnees.actifs
        .slice()
        .sort((a, b) => a.fin - b.fin)
        .map(m => {
            const restant = m.fin - maintenant;
            const fini = restant <= 0;
            if (fini) termines.push(m);
            const total = Math.max(1, m.fin - m.debut);
            const avance = fini ? 100 : Math.min(100, Math.max(0, (1 - restant / total) * 100));
            return { m, fini, avance, temps: fini ? "Terminé" : formaterRestant(restant) };
        });

    // Même liste qu'à la seconde précédente : on ne change que les chiffres,
    // pour ne pas recréer les boutons sous le doigt (un clic serait perdu).
    const signature = lignes.map(l => `${l.m.id}:${l.fini}`).join("|");
    if (zone.dataset.signature === signature) {
        const parId = new Map([...zone.querySelectorAll(".bj-minuteur")].map(el => [el.dataset.id, el]));
        for (const l of lignes) {
            const el = parId.get(l.m.id);
            if (!el) continue;
            el.style.setProperty("--avance", `${l.avance.toFixed(1)}%`);
            const t = el.querySelector(".bj-minuteur-temps");
            if (t && t.textContent !== l.temps) t.textContent = l.temps;
        }
    } else {
        zone.dataset.signature = signature;
        zone.innerHTML = lignes.map(({ m, fini, avance, temps }) => `
                <div class="bj-minuteur${fini ? " fini" : ""}" data-id="${escapeHtml(m.id)}" style="--avance:${avance.toFixed(1)}%">
                    <span class="bj-minuteur-nom">${escapeHtml(m.libelle)}</span>
                    <span class="bj-minuteur-temps">${temps}</span>
                    <button type="button" class="bj-mini" data-arreter="${escapeHtml(m.id)}"
                            title="${fini ? "OK, retirer" : "Arrêter"}" aria-label="${fini ? "Retirer" : "Arrêter"} ${escapeHtml(m.libelle)}">${fini ? "✓" : "✕"}</button>
                </div>`).join("");
    }

    const compteur = doc.getElementById("minuteurs-compte");
    if (compteur) compteur.textContent = donnees.actifs.length ? String(donnees.actifs.length) : "";
    const racine = doc.getElementById("minuteurs");
    if (racine) racine.classList.toggle("bj-sonne", termines.length > 0);

    // Annonce des minuteurs qui viennent de se terminer
    const locaux = lireLocaux();
    for (const m of termines) {
        if (etat.sonnes.has(m.id)) continue;
        etat.sonnes.add(m.id);
        // Pas de sonnerie pour un minuteur déjà fini depuis longtemps (page
        // rechargée) ; mais un minuteur fini pendant que la page était ouverte
        // sonne même si l'onglet en arrière-plan l'a remarqué en retard.
        const recent = maintenant - m.fin < DUREE_SONNERIE;
        const finiPageOuverte = etat.ouverture && m.fin >= etat.ouverture
            && maintenant - m.fin < RETARD_MAX_SONNERIE;
        if (locaux.has(m.id) && (recent || finiPageOuverte)) sonner(m.id);
    }

    // Le titre de l'onglet signale un minuteur terminé
    if (typeof doc.title === "string") {
        if (etat.titreOrigine === null) etat.titreOrigine = doc.title;
        doc.title = termines.length ? `⏰ ${termines[0].libelle} — terminé` : etat.titreOrigine;
    }
}

function afficherPreselections(doc = document) {
    const zone = doc.getElementById("minuteurs-preselections");
    if (!zone) return;
    const { preselections } = lire();
    zone.innerHTML = preselections.map((p, i) => `
        <button type="button" class="bj-puce" data-preselection="${i}" title="Lancer ${escapeHtml(p.libelle)} (${formaterMinutes(p.minutes)})">
            ${escapeHtml(p.libelle)} <small>${formaterMinutes(p.minutes)}</small>
            ${etat.edition ? `<span class="bj-puce-suppr" data-supprimer-preselection="${i}" title="Retirer ce préréglage">✕</span>` : ""}
        </button>`).join("");
    const modifier = doc.getElementById("minuteurs-modifier");
    if (modifier) modifier.textContent = etat.edition ? "Terminé" : "Modifier";
}

export function rafraichirMinuteurs(doc = document) {
    afficherPreselections(doc);
    afficherMinuteurs(doc);
}

export function initMinuteurs(doc = document) {
    const racine = doc.getElementById("minuteurs");
    if (!racine) return;
    etat.ouverture = maintenant_();

    const ouvrir = doc.getElementById("minuteurs-bouton");
    const panneau = doc.getElementById("minuteurs-panneau");
    if (ouvrir && panneau) {
        ouvrir.addEventListener("click", () => {
            preparerSon();
            const ouvert = panneau.classList.toggle("hidden") === false;
            ouvrir.setAttribute("aria-expanded", String(ouvert));
        });
    }

    doc.getElementById("minuteurs-preselections")?.addEventListener("click", e => {
        const suppr = e.target.closest("[data-supprimer-preselection]");
        if (suppr) {
            e.stopPropagation();
            supprimerPreselection(Number(suppr.dataset.supprimerPreselection));
            afficherPreselections(doc);
            return;
        }
        const b = e.target.closest("[data-preselection]");
        if (!b || etat.edition) return;
        const p = lire().preselections[Number(b.dataset.preselection)];
        if (!p) return;
        preparerSon();
        lancerMinuteur(p.libelle, p.minutes);
        afficherMinuteurs(doc);
    });

    doc.getElementById("minuteurs-modifier")?.addEventListener("click", () => {
        etat.edition = !etat.edition;
        afficherPreselections(doc);
    });

    const form = doc.getElementById("minuteurs-form");
    if (form) {
        form.addEventListener("submit", e => {
            e.preventDefault();
            const nom = doc.getElementById("minuteurs-nom");
            const duree = doc.getElementById("minuteurs-duree");
            const garder = doc.getElementById("minuteurs-garder");
            const minutes = lireDuree(duree ? duree.value : "");
            if (!minutes || minutes <= 0 || minutes > MAX_MINUTES) {
                if (duree) {
                    duree.setCustomValidity("Durée en minutes : 10, 2,5, 1:30 ou 1h20");
                    duree.reportValidity?.();
                }
                return;
            }
            if (duree) duree.setCustomValidity("");
            preparerSon();
            const libelle = nom ? nom.value : "";
            lancerMinuteur(libelle, minutes);
            if (garder && garder.checked && libelle.trim()) {
                ajouterPreselection(libelle, minutes);
                garder.checked = false;
            }
            if (nom) nom.value = "";
            if (duree) duree.value = "";
            rafraichirMinuteurs(doc);
        });
        doc.getElementById("minuteurs-duree")?.addEventListener("input", e => e.target.setCustomValidity(""));
    }

    doc.getElementById("minuteurs-actifs")?.addEventListener("click", e => {
        const b = e.target.closest("[data-arreter]");
        if (!b) return;
        arreterMinuteur(b.dataset.arreter);
        afficherMinuteurs(doc);
    });

    rafraichirMinuteurs(doc);
    setInterval(() => afficherMinuteurs(doc), 1000);
    // Retour sur l'onglet : afficher (et sonner) tout de suite
    doc.addEventListener?.("visibilitychange", () => { if (!doc.hidden) afficherMinuteurs(doc); });
    setInterval(() => { if (nettoyer() > 0) afficherMinuteurs(doc); }, 60000);
}
