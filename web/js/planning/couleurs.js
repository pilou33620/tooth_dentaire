"use strict";

/* ============================================================
   Couleurs du planning et du tableau des tâches

   Les couleurs ne sont plus écrites dans le code en fonction des
   prénoms : elles viennent du document "planning_couleurs" en base.

   {
     legende: [ { libelle: "Cabinet 1", couleur: "#cf2727" }, ... ],
     regles:  [ { cible: "praticien" | "assistante" | "tache",
                  nom: "...", jour: "" | "LUNDI"..., creneau: "" | "am" | "pm",
                  couleur: "#rrggbb" } ]
   }

   - cible "praticien"  : la case du planning contient ce nom
                          (règle la plus précise d'abord : jour + créneau,
                          puis jour, puis créneau, puis générale) ;
   - cible "assistante" : à défaut, la ligne de l'assistante contient ce nom ;
   - cible "tache"      : tableau des tâches, la case contient ce nom
                          (première règle qui correspond, dans l'ordre).
   ============================================================ */

import { getDocument } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';

export const JOURS = ["LUNDI", "MARDI", "MERCREDI", "JEUDI", "VENDREDI", "SAMEDI"];

/** Légende par défaut : les espaces du cabinet, sans aucun nom de personne. */
export const LEGENDE_DEFAUT = [
    { libelle: "Cabinet 1", couleur: "#cf2727" },
    { libelle: "Cabinet 2", couleur: "#ff6e9e" },
    { libelle: "Cabinet 4", couleur: "#ff9900" },
    { libelle: "Cabinet 5", couleur: "#bbdefb" }
];

const MOTS_INACTIFS = ["", "-", "repos", "ecole", "école"];

let brouillon = null; // copie en cours d'édition (fenêtre du planning ouverte)

function norm(s) {
    return String(s ?? "").trim().toLowerCase();
}

/** Document des couleurs, complété si besoin. */
export function normaliserCouleurs(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    return {
        legende: Array.isArray(d.legende) && d.legende.length > 0 ? d.legende : LEGENDE_DEFAUT.map(l => ({ ...l })),
        regles: Array.isArray(d.regles) ? d.regles : []
    };
}

export function getCouleurs() {
    return brouillon || normaliserCouleurs(getDocument("planning_couleurs"));
}

export function commencerEditionCouleurs() {
    brouillon = normaliserCouleurs(getDocument("planning_couleurs"));
    return brouillon;
}

export function terminerEditionCouleurs() {
    const resultat = brouillon;
    brouillon = null;
    return resultat;
}

export function estInactif(valeur) {
    return MOTS_INACTIFS.includes(norm(valeur));
}

function specificite(r) {
    return (r.jour ? 2 : 0) + (r.creneau ? 1 : 0);
}

/** Couleur d'une case du planning (case = nom du praticien). */
export function couleurCellule(praticien, assistante, jour, creneau, couleurs = getCouleurs()) {
    if (estInactif(praticien)) return { inactif: true, couleur: "" };
    const nom = norm(praticien);
    const regle = couleurs.regles
        .filter(r => r.cible === "praticien" && norm(r.nom) === nom
            && (!r.jour || r.jour === jour) && (!r.creneau || r.creneau === creneau))
        .sort((a, b) => specificite(b) - specificite(a))[0];
    if (regle) return { inactif: false, couleur: regle.couleur || "" };

    const ligne = norm(assistante);
    if (ligne) {
        const parAssistante = couleurs.regles.find(r => r.cible === "assistante" && norm(r.nom) && ligne.includes(norm(r.nom)));
        if (parAssistante) return { inactif: false, couleur: parAssistante.couleur || "" };
    }
    return { inactif: false, couleur: "" };
}

/** Couleur d'une case du tableau des tâches (noms des personnes assignées). */
export function couleurTache(texte, couleurs = getCouleurs()) {
    const t = norm(texte);
    if (!t) return { inactif: false, couleur: "" };
    if (t === "-" || t === "repos") return { inactif: true, couleur: "" };
    const regle = couleurs.regles.find(r => r.cible === "tache" && norm(r.nom) && t.includes(norm(r.nom)));
    return { inactif: false, couleur: regle ? (regle.couleur || "") : "" };
}

/**
 * Couleur CSS sûre à insérer dans un style (#rgb, nom, rgb()/hsl()), sinon "".
 * Une valeur comme "red; background-image: url(...)" ne doit pas passer.
 */
export function couleurSure(couleur) {
    const c = String(couleur ?? "").trim();
    return /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([\d\s.,%/a-z]*\))$/i.test(c) ? c : "";
}

/** Attributs HTML (class + style) d'une case colorée. */
export function attributsCouleur(resultat, styleEnPlus = "") {
    const classe = resultat.inactif ? "cell-inactive" : "";
    const couleur = couleurSure(resultat.couleur);
    const fond = couleur ? `background-color: ${escapeHtml(couleur)};` : "";
    return `class="${classe}" style="${fond}${styleEnPlus}"`;
}

/* ------------------------------------------------------------
   Légende affichée au-dessus du planning
   ------------------------------------------------------------ */
export function renderLegende(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = getCouleurs().legende.map(l => `
        <div style="display: flex; align-items: center; gap: 8px;">
            <div style="width: 16px; height: 16px; background-color: ${escapeHtml(couleurSure(l.couleur))}; border-radius: 3px; border: 1px solid #ddd;"></div>
            <span>${escapeHtml(l.libelle)}</span>
        </div>`).join("");
}

/* ------------------------------------------------------------
   Éditeur (onglet "Couleurs" de la fenêtre du planning)
   ------------------------------------------------------------ */
export function renderEditeurCouleurs(containerId, nomsSuggeres = []) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const c = getCouleurs();

    const optionsJour = (val) => ['<option value="">Tous les jours</option>']
        .concat(JOURS.map(j => `<option value="${j}" ${val === j ? "selected" : ""}>${j}</option>`)).join("");
    const optionsCreneau = (val) => [["", "Matin et A-M"], ["am", "Matin"], ["pm", "Après-midi"]]
        .map(([v, l]) => `<option value="${v}" ${val === v ? "selected" : ""}>${l}</option>`).join("");
    const optionsCible = (val) => [["praticien", "Praticien (case)"], ["assistante", "Assistante (ligne)"], ["tache", "Tableau des tâches"]]
        .map(([v, l]) => `<option value="${v}" ${val === v ? "selected" : ""}>${l}</option>`).join("");

    let html = `<datalist id="couleurs-legende-list">${c.legende.map(l => `<option value="${escapeHtml(l.couleur)}"></option>`).join("")}</datalist>`;
    html += `<datalist id="couleurs-noms-list">${[...new Set(nomsSuggeres.filter(Boolean))].sort().map(n => `<option value="${escapeHtml(n)}"></option>`).join("")}</datalist>`;

    html += `<h3 style="margin: 0 0 8px;">Légende</h3>
        <table class="couleurs-table"><thead><tr><th>Libellé</th><th>Couleur</th><th></th></tr></thead><tbody>`;
    c.legende.forEach((l, i) => {
        html += `<tr>
            <td><input type="text" class="input" value="${escapeHtml(l.libelle)}" data-legende="${i}" data-champ="libelle"></td>
            <td><input type="color" value="${escapeHtml(l.couleur)}" data-legende="${i}" data-champ="couleur"></td>
            <td><button class="btn-remove-col" data-suppr-legende="${i}" title="Supprimer">✕</button></td>
        </tr>`;
    });
    html += `</tbody></table>
        <div style="text-align: center; margin-top: 6px;"><button class="btn-add-col" id="btn-add-legende">+ Ajouter une couleur à la légende</button></div>`;

    html += `<h3 style="margin: 24px 0 8px;">Règles de couleur</h3>
        <p style="margin: 0 0 8px; color: #555; font-size: 0.9em;">Pour un même nom, la règle la plus précise (jour + créneau) l'emporte. Les règles « Tableau des tâches » sont lues dans l'ordre.</p>
        <table class="couleurs-table"><thead><tr><th>S'applique à</th><th>Nom</th><th>Jour</th><th>Créneau</th><th>Couleur</th><th></th></tr></thead><tbody>`;
    c.regles.forEach((r, i) => {
        html += `<tr>
            <td><select class="combo" data-regle="${i}" data-champ="cible">${optionsCible(r.cible)}</select></td>
            <td><input type="text" class="input" list="couleurs-noms-list" value="${escapeHtml(r.nom)}" data-regle="${i}" data-champ="nom"></td>
            <td><select class="combo" data-regle="${i}" data-champ="jour">${optionsJour(r.jour || "")}</select></td>
            <td><select class="combo" data-regle="${i}" data-champ="creneau">${optionsCreneau(r.creneau || "")}</select></td>
            <td><input type="color" list="couleurs-legende-list" value="${escapeHtml(r.couleur || "#ffffff")}" data-regle="${i}" data-champ="couleur"></td>
            <td><button class="btn-remove-col" data-suppr-regle="${i}" title="Supprimer">✕</button></td>
        </tr>`;
    });
    html += `</tbody></table>
        <div style="text-align: center; margin-top: 6px;"><button class="btn-add-col" id="btn-add-regle">+ Ajouter une règle</button></div>`;

    el.innerHTML = html;

    el.querySelectorAll("[data-legende]").forEach(input => {
        input.addEventListener("input", () => {
            c.legende[+input.dataset.legende][input.dataset.champ] = input.value;
        });
    });
    el.querySelectorAll("[data-regle]").forEach(input => {
        const evt = input.tagName === "SELECT" ? "change" : "input";
        input.addEventListener(evt, () => {
            c.regles[+input.dataset.regle][input.dataset.champ] = input.value;
        });
    });
    el.querySelectorAll("[data-suppr-legende]").forEach(btn => btn.addEventListener("click", () => {
        c.legende.splice(+btn.dataset.supprLegende, 1);
        renderEditeurCouleurs(containerId, nomsSuggeres);
    }));
    el.querySelectorAll("[data-suppr-regle]").forEach(btn => btn.addEventListener("click", () => {
        c.regles.splice(+btn.dataset.supprRegle, 1);
        renderEditeurCouleurs(containerId, nomsSuggeres);
    }));
    el.querySelector("#btn-add-legende").addEventListener("click", () => {
        c.legende.push({ libelle: "", couleur: "#cccccc" });
        renderEditeurCouleurs(containerId, nomsSuggeres);
    });
    el.querySelector("#btn-add-regle").addEventListener("click", () => {
        c.regles.push({ cible: "praticien", nom: "", jour: "", creneau: "", couleur: c.legende[0]?.couleur || "#cccccc" });
        renderEditeurCouleurs(containerId, nomsSuggeres);
    });
}
