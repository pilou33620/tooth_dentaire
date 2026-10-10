"use strict";

/* ============================================================
Gestion du Planning des Binômes (Calendrier)

Les données (assistantes, praticiens, couleurs) sont en base, dans les
documents "planning" et "planning_couleurs" : rien n'est écrit dans le code.
============================================================ */

import { escapeHtml } from '../core/utils.js';
import { getDocument, versionDocument, enregistrerEdition } from '../core/api.js';
import { getWeekNumber, pariteSemaine } from './clock.js';
import {
    JOURS, couleurCellule, attributsCouleur, renderLegende, renderEditeurCouleurs,
    commencerEditionCouleurs, terminerEditionCouleurs, couleursEnEdition
} from './couleurs.js';

let brouillon = null; // copie en cours d'édition (fenêtre ouverte)
// Versions des documents lues à l'ouverture de la fenêtre : un enregistrement
// fait ailleurs entre-temps est signalé au lieu d'être écrasé sans le dire.
let versionsLues = { planning: null, couleurs: null };

function joursVides() {
    const jours = {};
    JOURS.forEach(j => { jours[j] = { am: "", pm: "" }; });
    return jours;
}

/** Complète un planning lu en base (lignes et jours manquants). */
export function normaliserPlanning(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const texte = v => (v === null || v === undefined) ? "" : String(v);
    const resultat = {};
    for (const parite of ["even", "odd"]) {
        resultat[parite] = (Array.isArray(d[parite]) ? d[parite] : [])
            .filter(row => row && typeof row === "object" && !Array.isArray(row))
            .map(row => {
                const days = joursVides();
                for (const j of JOURS) {
                    const src = row.days && row.days[j];
                    if (src && typeof src === "object") days[j] = { am: texte(src.am), pm: texte(src.pm) };
                }
                return { assistant: texte(row.assistant), days };
            });
    }
    // Alternance des semaines (voir pariteSemaine) : "continue" par défaut
    resultat.alternance = d.alternance === "iso" ? "iso" : "continue";
    return resultat;
}

export function getCalendarData() {
    return brouillon || normaliserPlanning(getDocument("planning"));
}

/**
 * Enregistre le planning (et ses couleurs) saisis dans la fenêtre.
 * Résolue avec true si tout est enregistré ; sinon la saisie est gardée.
 */
export async function saveCalendarData() {
    const donnees = brouillon || getCalendarData();
    const couleurs = couleursEnEdition();
    if (!await enregistrerEdition("planning", donnees, versionsLues.planning, "Le planning")) return false;
    versionsLues.planning = versionDocument("planning");
    if (couleurs) {
        if (!await enregistrerEdition("planning_couleurs", couleurs, versionsLues.couleurs,
            "Les couleurs du planning")) return false;
        versionsLues.couleurs = versionDocument("planning_couleurs");
    }
    brouillon = null;
    terminerEditionCouleurs();
    return true;
}

function abandonnerEdition() {
    brouillon = null;
    terminerEditionCouleurs();
}

/** Noms présents dans le planning (suggestions de saisie). */
export function nomsDuPlanning() {
    const noms = new Set();
    const data = getCalendarData();
    for (const parite of ["even", "odd"]) {
        for (const row of data[parite]) {
            if (row.assistant) noms.add(row.assistant.trim());
            for (const j of JOURS) {
                for (const v of [row.days[j].am, row.days[j].pm]) {
                    const t = (v || "").trim();
                    if (t && !["-", "repos", "école", "ecole"].includes(t.toLowerCase())) noms.add(t);
                }
            }
        }
    }
    return [...noms];
}

let currentActualWeekNo = null;
let currentActualParity = 'even';
let currentPreviewParity = null; // null = suit la parité réelle
let currentDayOffset = 0; // 0 = aujourd'hui (ou lundi si dimanche), en jours travaillés

/** Jour affiché par l'aperçu : aujourd'hui (le dimanche, lundi) + décalage, dimanches sautés. */
export function jourAffiche(decalage = currentDayOffset, maintenant = new Date()) {
    const d = new Date(maintenant);
    d.setHours(12, 0, 0, 0);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    let reste = decalage;
    while (reste !== 0) {
        const pas = reste > 0 ? 1 : -1;
        d.setDate(d.getDate() + pas);
        if (d.getDay() !== 0) reste -= pas;
    }
    return d;
}

function alternance() {
    return (brouillon || normaliserPlanning(getDocument("planning"))).alternance;
}

export function getActualParity() {
    return currentActualParity;
}

export function getPreviewParity() {
    return currentPreviewParity || currentActualParity;
}

export function setPreviewParity(parity) {
    currentPreviewParity = parity;
    if (currentActualWeekNo !== null) {
        updateTeamPlanning(currentActualWeekNo);
    }
}

function updateWidgetParityButtons(activeParity, actualParity) {
    const btnEven = document.getElementById("btn-preview-even");
    const btnOdd = document.getElementById("btn-preview-odd");

    if (btnEven && btnOdd) {
        const isEven = (activeParity === 'even');
        // Classe lue par le thème (css/bonjourr.css) pour marquer la semaine affichée
        btnEven.classList.toggle("actif", isEven);
        btnOdd.classList.toggle("actif", !isEven);

        if (isEven) {
            btnEven.style.background = "#2980b9";
            btnEven.style.color = "white";
            btnEven.style.boxShadow = "0 2px 4px rgba(41, 128, 185, 0.4)";

            btnOdd.style.background = "transparent";
            btnOdd.style.color = "#555";
            btnOdd.style.boxShadow = "none";
        } else {
            btnOdd.style.background = "#8e44ad";
            btnOdd.style.color = "white";
            btnOdd.style.boxShadow = "0 2px 4px rgba(142, 68, 173, 0.4)";

            btnEven.style.background = "transparent";
            btnEven.style.color = "#555";
            btnEven.style.boxShadow = "none";
        }

        btnEven.innerHTML = (actualParity === 'even') ? 'Paire ★' : 'Paire';
        btnOdd.innerHTML = (actualParity === 'odd') ? 'Impaire ★' : 'Impaire';

        btnEven.title = (actualParity === 'even') ? "Semaine Paire (semaine actuelle)" : "Afficher la Semaine Paire";
        btnOdd.title = (actualParity === 'odd') ? "Semaine Impaire (semaine actuelle)" : "Afficher la Semaine Impaire";
    }
}

export function updateTeamPlanning(weekNo) {
    if (typeof weekNo === "number") {
        currentActualWeekNo = weekNo;
    } else if (currentActualWeekNo === null) {
        currentActualWeekNo = getWeekNumber(new Date());
    }

    // Parité calculée sur la date réelle : le dimanche, c'est le lundi qui
    // suit ; en naviguant (◀ ▶), le samedi est suivi du lundi de l'autre semaine.
    const mode = normaliserPlanning(getDocument("planning")).alternance;
    currentActualParity = pariteSemaine(jourAffiche(0), mode);
    const affiche = jourAffiche();
    const displayDayIndex = (affiche.getDay() + 6) % 7;      // 0 = lundi

    // Parité affichée dans l'aperçu
    const activeParity = currentPreviewParity || pariteSemaine(affiche, mode);

    // Mise à jour des boutons de switch sur le widget
    updateWidgetParityButtons(activeParity, currentActualParity);

    const previewContainer = document.getElementById("calendar-preview-content");
    if (previewContainer) {
        // L'aperçu montre toujours le planning enregistré, pas un brouillon
        const data = normaliserPlanning(getDocument("planning"))[activeParity];
        const allShortDays = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM"];

        const dayName = JOURS[displayDayIndex];
        const shortDay = allShortDays[displayDayIndex];

        let html = '<div style="overflow-x: hidden; padding-bottom: 5px;">';
        html += '<table class="calendar-table calendar-preview-table" style="width: 100%; min-width: 250px; font-size: 15px;">';

        // En-tête : Jour avec navigation ◀ JOUR ▶
        html += '<thead><tr>';
        html += '<th style="background-color: transparent; border: none; min-width: 40px;"></th>';
        html += `<th class="day-header" style="font-size: 1em; padding: 4px; border-right: 2px solid #2c3e50; user-select: none;">`;
        const pad = n => String(n).padStart(2, "0");
        const titreJour = `${pad(affiche.getDate())}/${pad(affiche.getMonth() + 1)} - revenir à aujourd'hui`;
        html += `<span data-nav="-1" style="cursor: pointer; padding: 2px 8px; font-size: 0.9em; opacity: 0.8;" title="Jour précédent">◀</span> `;
        html += `<span data-nav="0" style="cursor: pointer;" title="${titreJour}">${shortDay}</span> `;
        html += `<span data-nav="1" style="cursor: pointer; padding: 2px 8px; font-size: 0.9em; opacity: 0.8;" title="Jour suivant">▶</span>`;
        html += `</th>`;
        html += '</tr></thead><tbody>';

        if (data.length === 0) {
            html += `<tr><td colspan="2" style="text-align: center; padding: 8px; color: #7f8c8d; font-style: italic;">Planning vide : cliquez pour le remplir</td></tr>`;
        }

        // Lignes : Assistantes
        data.forEach((row) => {
            // Matin
            html += '<tr>';
            html += `<th rowspan="2" class="assistant-header" style="font-size: 0.9em; padding: 4px; border-right: 2px solid #2c3e50; vertical-align: middle;">${escapeHtml(row.assistant || "-")}</th>`;
            const dAm = row.days[dayName] ? row.days[dayName].am : "";
            const cAm = couleurCellule(dAm, row.assistant, dayName, 'am');
            html += `<td ${attributsCouleur(cAm, `font-size: 0.95em; padding: 4px 6px; text-align: center; color: black; border-right: 2px solid #2c3e50; ${cAm.inactif ? 'opacity: 0.5; font-style: italic;' : ''}`)} title="${escapeHtml(dAm || 'Repos')}">
                ${escapeHtml(dAm || "Repos")}
            </td>`;
            html += '</tr>';

            // Après-midi
            html += '<tr>';
            const dPm = row.days[dayName] ? row.days[dayName].pm : "";
            const cPm = couleurCellule(dPm, row.assistant, dayName, 'pm');
            html += `<td ${attributsCouleur(cPm, `font-size: 0.95em; padding: 4px 6px; text-align: center; color: black; border-bottom: 2px solid #2c3e50; border-right: 2px solid #2c3e50; ${cPm.inactif ? 'opacity: 0.5; font-style: italic;' : ''}`)} title="${escapeHtml(dPm || 'Repos')}">
                ${escapeHtml(dPm || "Repos")}
            </td>`;
            html += '</tr>';
        });

        html += '</tbody></table></div>';
        previewContainer.innerHTML = html;
    }
}

/** Compatibilité : classe CSS d'une case ("cell-inactive" ou ""). */
export function getCellClass(dentist, assistant, day, shift) {
    return couleurCellule(dentist, assistant, day, shift).inactif ? "cell-inactive" : "";
}

export function renderCalendarTable(parity, containerId) {
    const data = getCalendarData()[parity];

    let html = '<div class="calendar-wrapper"><table class="calendar-table"><thead><tr>';
    html += '<th style="background-color: transparent; border: none; width: 120px;"></th>';
    JOURS.forEach(day => {
        html += `<th class="day-header">${day}</th>`;
    });
    html += '<th class="day-header" style="width: 100px;"><button class="btn-add-col" data-ajouter-ligne>+ Ligne</button></th>';
    html += '</tr></thead><tbody>';

    data.forEach((row, idx) => {
        // MATIN
        html += '<tr>';
        html += `<th rowspan="2" class="assistant-header" style="vertical-align: middle; border-bottom: 2px solid #2c3e50; border-right: 2px solid #2c3e50;">
                    <input type="text" class="assistant-input" value="${escapeHtml(row.assistant || '')}" data-ligne="${idx}" data-champ="assistant" placeholder="Assistante" style="width: 100%; text-align: center; font-weight: bold;">
                 </th>`;
        JOURS.forEach(day => {
            const dentistAm = row.days[day] ? row.days[day].am : "";
            html += `<td ${attributsCouleur(couleurCellule(dentistAm, row.assistant, day, 'am'))}>
                <div style="font-size:0.75em; opacity:0.6;">Matin</div>
                <input type="text" class="cell-input" value="${escapeHtml(dentistAm)}" data-ligne="${idx}" data-jour="${day}" data-creneau="am" placeholder="Repos">
            </td>`;
        });
        html += `<td rowspan="2" style="background-color: transparent; border: none; vertical-align: middle; text-align: center; border-bottom: 2px solid #2c3e50;">
                    <button class="btn-remove-col" data-supprimer-ligne="${idx}" title="Supprimer la ligne">✕</button>
                 </td>`;
        html += '</tr>';

        // APRES MIDI
        html += '<tr>';
        JOURS.forEach(day => {
            const dentistPm = row.days[day] ? row.days[day].pm : "";
            html += `<td ${attributsCouleur(couleurCellule(dentistPm, row.assistant, day, 'pm'), 'border-bottom: 2px solid #2c3e50;')}>
                <div style="font-size:0.75em; opacity:0.6;">A-M</div>
                <input type="text" class="cell-input" value="${escapeHtml(dentistPm)}" data-ligne="${idx}" data-jour="${day}" data-creneau="pm" placeholder="Repos">
            </td>`;
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    const conteneur = document.getElementById(containerId);
    conteneur.innerHTML = html;
    ecouterTableau(conteneur, parity);
}

/**
 * Écouteurs posés une fois sur le conteneur (délégation) : le HTML généré ne
 * contient aucun gestionnaire en ligne (onclick...), ce qui permet une
 * politique de sécurité (CSP) qui interdit tout script en ligne.
 */
function ecouterTableau(conteneur, parity) {
    if (conteneur.dataset.ecoute === parity) return;
    conteneur.dataset.ecoute = parity;
    conteneur.addEventListener("click", e => {
        if (e.target.closest("[data-ajouter-ligne]")) {
            window.addCalendarRow(parity);
            return;
        }
        const suppr = e.target.closest("[data-supprimer-ligne]");
        if (suppr) window.removeCalendarRow(parity, Number(suppr.dataset.supprimerLigne));
    });
    conteneur.addEventListener("change", e => {
        const champ = e.target.closest("input[data-ligne]");
        if (!champ) return;
        const idx = Number(champ.dataset.ligne);
        if (champ.dataset.champ === "assistant") {
            window.updateCalendarRow(parity, idx, "assistant", champ.value);
        } else if (champ.dataset.jour && champ.dataset.creneau) {
            window.updateCalendarCell(parity, idx, champ.dataset.jour, champ.dataset.creneau, champ.value);
        }
    });
}

window.addCalendarRow = function (parity) {
    getCalendarData()[parity].push({ assistant: "Nouveau", days: joursVides() });
    renderAllCalendars();
};

window.removeCalendarRow = function (parity, idx) {
    if (confirm("Supprimer cette ligne ?")) {
        getCalendarData()[parity].splice(idx, 1);
        renderAllCalendars();
    }
};

window.updateCalendarRow = function (parity, idx, field, value) {
    getCalendarData()[parity][idx][field] = value;
};

window.updateCalendarCell = function (parity, idx, day, shift, value) {
    getCalendarData()[parity][idx].days[day][shift] = value;
};

export function renderAllCalendars() {
    renderCalendarTable('even', 'calendar-container-even');
    renderCalendarTable('odd', 'calendar-container-odd');
    renderLegende('calendar-legende');
}

window.navPlanningDay = function (dir, event) {
    if (event) event.stopPropagation();
    currentDayOffset += dir;
    if (currentActualWeekNo !== null) {
        updateTeamPlanning(currentActualWeekNo);
    }
};

window.resetPlanningDay = function (event) {
    if (event) event.stopPropagation();
    currentDayOffset = 0;
    if (currentActualWeekNo !== null) {
        updateTeamPlanning(currentActualWeekNo);
    }
};

window.setPlanningParity = function (parity, event) {
    if (event) event.stopPropagation();
    setPreviewParity(parity);
};

export function openCalendarModal() {
    const modal = document.getElementById("calendar-overlay");
    if (!modal) return;
    brouillon = normaliserPlanning(getDocument("planning"));
    versionsLues = { planning: versionDocument("planning"), couleurs: versionDocument("planning_couleurs") };
    commencerEditionCouleurs();
    const iso = document.getElementById("planning-alternance-iso");
    if (iso) iso.checked = brouillon.alternance === "iso";
    renderAllCalendars();
    switchCalendarModalTab(getPreviewParity());
    modal.classList.remove("hidden");
}

/** Onglets de la fenêtre : 'even', 'odd' ou 'couleurs'. */
export function switchCalendarModalTab(onglet) {
    const conteneurs = {
        even: document.getElementById("calendar-container-even"),
        odd: document.getElementById("calendar-container-odd"),
        couleurs: document.getElementById("calendar-container-couleurs")
    };
    const boutons = {
        even: document.getElementById("btn-tab-even"),
        odd: document.getElementById("btn-tab-odd"),
        couleurs: document.getElementById("btn-tab-couleurs")
    };

    if (onglet === "couleurs") {
        renderEditeurCouleurs("calendar-container-couleurs", nomsDuPlanning());
    } else if (conteneurs.couleurs && !conteneurs.couleurs.classList.contains("hidden")) {
        // Retour du réglage des couleurs : on redessine avec les nouvelles couleurs
        renderAllCalendars();
    }

    for (const cle of Object.keys(conteneurs)) {
        const actif = cle === onglet;
        if (conteneurs[cle]) conteneurs[cle].classList.toggle("hidden", !actif);
        const btn = boutons[cle];
        if (!btn) continue;
        if (actif) {
            btn.classList.add("btn-blue");
            btn.style.background = "";
            btn.style.color = "";
        } else {
            btn.classList.remove("btn-blue");
            btn.style.background = "#bdc3c7";
            btn.style.color = "white";
        }
    }
}

export function initTeamPlanning() {
    if (window._teamPlanningInitialized) return;
    window._teamPlanningInitialized = true;

    const btnEven = document.getElementById("btn-preview-even");
    if (btnEven) {
        btnEven.addEventListener("click", (e) => {
            window.setPlanningParity('even', e);
        });
    }

    const btnOdd = document.getElementById("btn-preview-odd");
    if (btnOdd) {
        btnOdd.addEventListener("click", (e) => {
            window.setPlanningParity('odd', e);
        });
    }

    const btnOpen = document.getElementById("btn-open-calendar");
    if (btnOpen) {
        btnOpen.addEventListener("click", () => {
            openCalendarModal();
        });
    }

    const previewContainer = document.getElementById("calendar-preview-content");
    if (previewContainer) {
        previewContainer.addEventListener("click", (e) => {
            const nav = e.target.closest("[data-nav]");
            if (nav) {
                const pas = Number(nav.dataset.nav);
                if (pas === 0) window.resetPlanningDay(e);
                else window.navPlanningDay(pas, e);
                return;
            }
            if (!e.target.closest(".day-header span")) {
                openCalendarModal();
            }
        });
    }

    const iso = document.getElementById("planning-alternance-iso");
    if (iso) {
        iso.addEventListener("change", () => {
            if (brouillon) brouillon.alternance = iso.checked ? "iso" : "continue";
        });
    }

    for (const onglet of ["even", "odd", "couleurs"]) {
        const btn = document.getElementById(`btn-tab-${onglet}`);
        if (btn) btn.addEventListener("click", () => switchCalendarModalTab(onglet));
    }

    // Fermer sans sauvegarder abandonne les modifications
    document.querySelectorAll('[data-close="calendar-overlay"]').forEach(btn => {
        btn.addEventListener("click", abandonnerEdition);
    });

    const btnSaveCal = document.getElementById("btn-save-calendar");
    if (btnSaveCal) {
        btnSaveCal.addEventListener("click", async () => {
            btnSaveCal.disabled = true;
            let ok;
            try {
                ok = await saveCalendarData();
            } finally {
                btnSaveCal.disabled = false;
            }
            // Échec ou conflit : la fenêtre reste ouverte avec la saisie
            if (!ok) return;
            alert("Planning sauvegardé avec succès !");
            document.getElementById("calendar-overlay").classList.add("hidden");
            updateTeamPlanning(currentActualWeekNo ?? undefined);
            if (typeof window.updateTasksPreview === "function") window.updateTasksPreview();
        });
    }
}

// Export global pour accès depuis d'autres modules ou scripts non-modulaires
window.updateTeamPlanning = updateTeamPlanning;
window.renderAllCalendars = renderAllCalendars;
window.openCalendarModal = openCalendarModal;
window.switchCalendarModalTab = switchCalendarModalTab;
window.initTeamPlanning = initTeamPlanning;
