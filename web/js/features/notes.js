"use strict";

/* ============================================================
   Notes de l'équipe (widget de l'accueil)

   Petits messages partagés entre tous les postes du cabinet :
   « Livraison jeudi », « Technicien fauteuil 2 lundi »...
   Document "notes" en base : { items: [ { id, texte, cree_le, epingle } ] }
   ============================================================ */

import { getDocument, modifierDocument } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

export const CLE_NOTES = "notes";
export const MAX_NOTES = 60;
export const MAX_TEXTE = 500;
const DELAI_ANNULATION = 6000; // ms

let derniereSupprimee = null;   // { note, index } pour « Annuler »
let minuterieAnnulation = null;

export function nouvelId(maintenant = Date.now()) {
    return maintenant.toString(36) + Math.random().toString(36).slice(2, 7);
}

export function normaliserNotes(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const items = Array.isArray(d.items) ? d.items : [];
    return {
        items: items
            .filter(n => n && typeof n.texte === "string" && n.texte.trim() !== "")
            .map(n => ({
                id: String(n.id || nouvelId()),
                texte: n.texte.trim().slice(0, MAX_TEXTE),
                cree_le: Number(n.cree_le) || 0,
                epingle: n.epingle === true
            }))
    };
}

/** Épinglées d'abord, puis les plus récentes. */
export function trierNotes(items) {
    return [...items].sort((a, b) =>
        (b.epingle - a.epingle) || (b.cree_le - a.cree_le));
}

/** Texte sûr à afficher : **gras**, retours à la ligne, tirets en puces. */
export function formaterTexte(texte) {
    return escapeHtml(texte)
        .split("\n")
        .map(l => l.replace(/^\s*[-*]\s+/, "• "))
        .join("<br>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const pad = n => String(n).padStart(2, "0");

/** « à l'instant », « il y a 5 min », « il y a 2 h », « hier », « le 03/10 ». */
export function formaterAge(cree_le, maintenant = Date.now()) {
    if (!cree_le) return "";
    const ecart = Math.max(0, maintenant - cree_le);
    const min = Math.floor(ecart / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return `il y a ${min} min`;
    const d = new Date(cree_le);
    const auj = new Date(maintenant);
    const memeJour = d.toDateString() === auj.toDateString();
    if (memeJour) return `il y a ${Math.floor(min / 60)} h`;
    const hier = new Date(maintenant);
    hier.setDate(hier.getDate() - 1);
    if (d.toDateString() === hier.toDateString()) return "hier";
    return `le ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

function lire() {
    return normaliserNotes(getDocument(CLE_NOTES));
}

/**
 * Chaque modification est décrite par une fonction appliquée au document :
 * si un autre poste a écrit entre-temps, elle est rejouée sur sa version
 * (deux notes ajoutées en même temps sont toutes les deux gardées).
 */
function modifier(fonction) {
    return modifierDocument(CLE_NOTES, valeur => {
        const doc = normaliserNotes(valeur);
        fonction(doc);
        return doc;
    });
}

export function ajouterNote(texte, maintenant = Date.now()) {
    const propre = String(texte || "").trim().slice(0, MAX_TEXTE);
    if (!propre) return null;
    const note = { id: nouvelId(maintenant), texte: propre, cree_le: maintenant, epingle: false };
    modifier(doc => {
        doc.items.unshift({ ...note });
        // Au-delà de la limite, on retire les plus anciennes non épinglées
        while (doc.items.length > MAX_NOTES) {
            const i = doc.items.map(n => n.epingle).lastIndexOf(false);
            doc.items.splice(i === -1 ? doc.items.length - 1 : i, 1);
        }
    });
    return note;
}

export function supprimerNote(id) {
    const index = lire().items.findIndex(n => n.id === id);
    if (index === -1) return null;
    const note = lire().items[index];
    modifier(doc => {
        const i = doc.items.findIndex(n => n.id === id);
        if (i !== -1) doc.items.splice(i, 1);
    });
    derniereSupprimee = { note, index };
    return note;
}

/** Remet la dernière note effacée (bouton « Annuler »). */
export function annulerSuppression() {
    if (!derniereSupprimee) return false;
    const { note, index } = derniereSupprimee;
    if (!lire().items.some(n => n.id === note.id)) {
        modifier(doc => {
            if (!doc.items.some(n => n.id === note.id)) {
                doc.items.splice(Math.min(index, doc.items.length), 0, { ...note });
            }
        });
    }
    derniereSupprimee = null;
    return true;
}

export function basculerEpingle(id) {
    const note = lire().items.find(n => n.id === id);
    if (!note) return null;
    const epingle = !note.epingle;
    modifier(doc => {
        const n = doc.items.find(x => x.id === id);
        if (n) n.epingle = epingle;
    });
    return epingle;
}

/* ---------------- Affichage ---------------- */

export function afficherNotes(doc = document, maintenant = Date.now()) {
    const liste = doc.getElementById("notes-liste");
    if (!liste) return;
    const items = trierNotes(lire().items);

    if (items.length === 0) {
        liste.innerHTML = `<li class="bj-vide">Aucune note. Écrivez un message pour toute l'équipe.</li>`;
    } else {
        liste.innerHTML = items.map(n => `
            <li class="bj-note${n.epingle ? " bj-note-epinglee" : ""}" data-id="${escapeHtml(n.id)}">
                <div class="bj-note-texte">${formaterTexte(n.texte)}</div>
                <div class="bj-note-pied">
                    <span class="bj-note-age">${formaterAge(n.cree_le, maintenant)}</span>
                    <span class="bj-note-actions">
                        <button type="button" class="bj-mini" data-action="epingler" title="${n.epingle ? "Désépingler" : "Épingler en haut"}" aria-pressed="${n.epingle}">📌</button>
                        <button type="button" class="bj-mini" data-action="effacer" title="Effacer la note">✓</button>
                    </span>
                </div>
            </li>`).join("");
    }

    const compte = doc.getElementById("notes-compte");
    if (compte) compte.textContent = items.length ? String(items.length) : "";

    const annuler = doc.getElementById("notes-annuler");
    if (annuler) annuler.classList.toggle("hidden", !derniereSupprimee);
}

export function initNotes(doc = document) {
    const form = doc.getElementById("notes-form");
    const saisie = doc.getElementById("notes-saisie");
    const liste = doc.getElementById("notes-liste");
    const annuler = doc.getElementById("notes-annuler");

    if (form && saisie) {
        form.addEventListener("submit", e => {
            e.preventDefault();
            if (ajouterNote(saisie.value)) {
                saisie.value = "";
                afficherNotes(doc);
            }
        });
    }

    if (liste) {
        liste.addEventListener("click", e => {
            const bouton = e.target.closest("button[data-action]");
            const li = e.target.closest("li[data-id]");
            if (!bouton || !li) return;
            if (bouton.dataset.action === "epingler") {
                basculerEpingle(li.dataset.id);
            } else if (bouton.dataset.action === "effacer") {
                supprimerNote(li.dataset.id);
                clearTimeout(minuterieAnnulation);
                minuterieAnnulation = setTimeout(() => {
                    derniereSupprimee = null;
                    afficherNotes(doc);
                }, DELAI_ANNULATION);
            }
            afficherNotes(doc);
        });
    }

    if (annuler) {
        annuler.addEventListener("click", () => {
            clearTimeout(minuterieAnnulation);
            annulerSuppression();
            afficherNotes(doc);
        });
    }

    afficherNotes(doc);
    // L'âge des notes (« il y a 5 min ») avance tout seul
    setInterval(() => afficherNotes(doc), 60000);
}
