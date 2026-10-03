"use strict";

/* ============================================================
Gestion du Planning des Binômes (Calendrier)

Les données (assistantes, praticiens, couleurs) sont en base, dans les
documents "planning" et "planning_couleurs" : rien n'est écrit dans le code.
============================================================ */

import { escapeHtml } from '../core/utils.js';
import { getDocument, setDocument } from '../core/api.js';
import { getWeekNumber } from './clock.js';
import {
    JOURS, couleurCellule, attributsCouleur, renderLegende, renderEditeurCouleurs,
    commencerEditionCouleurs, terminerEditionCouleurs
} from './couleurs.js';

let brouillon = null; // copie en cours d'édition (fenêtre ouverte)

function joursVides() {
    const jours = {};
    JOURS.forEach(j => { jours[j] = { am: "", pm: "" }; });
    return jours;
}

/** Complète un planning lu en base (lignes et jours manquants). */
export function normaliserPlanning(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const resultat = {};
    for (const parite of ["even", "odd"]) {
        resultat[parite] = (Array.isArray(d[parite]) ? d[parite] : []).map(row => {
            const days = joursVides();
            for (const j of JOURS) {
                const src = row && row.days && row.days[j];
                if (src) days[j] = { am: src.am || "", pm: src.pm || "" };
            }
            return { assistant: (row && row.assistant) || "", days };
        });
    }
    return resultat;
}

export function getCalendarData() {
    return brouillon || normaliserPlanning(getDocument("planning"));
}

export function saveCalendarData() {
    const donnees = brouillon || getCalendarData();
    const couleurs = terminerEditionCouleurs();
    brouillon = null;
    setDocument("planning", donnees);
    if (couleurs) setDocument("planning_couleurs", couleurs);
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
let currentDayOffset = 0; // 0 = aujourd'hui (ou lundi si dimanche)

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

    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Dimanche, 1 = Lundi, ...

    // Si c'est dimanche (0), la prochaine journée travaillée est lundi (semaine suivante !)
    let effectiveWeekNo = currentActualWeekNo;
    let baseDayIndex = dayOfWeek - 1; // 0 pour Lundi, 5 pour Samedi
    if (baseDayIndex < 0 || baseDayIndex > 5) {
        baseDayIndex = 0; // Lundi par défaut
        if (dayOfWeek === 0) {
            // On lit le numéro ISO du lundi suivant au lieu de faire « +1 » :
            // à cheval sur une année de 53 semaines, +1 donnait 54 (parité
            // paire) alors que le lundi tombait en semaine 1 (parité impaire).
            const lundiSuivant = new Date(now);
            lundiSuivant.setDate(lundiSuivant.getDate() + 1);
            effectiveWeekNo = getWeekNumber(lundiSuivant);
        }
    }

    currentActualParity = (effectiveWeekNo % 2 === 0) ? 'even' : 'odd';

    // Parité affichée dans l'aperçu
    const activeParity = currentPreviewParity || currentActualParity;

    // Mise à jour des boutons de switch sur le widget
    updateWidgetParityButtons(activeParity, currentActualParity);

    const previewContainer = document.getElementById("calendar-preview-content");
    if (previewContainer) {
        // L'aperçu montre toujours le planning enregistré, pas un brouillon
        const data = normaliserPlanning(getDocument("planning"))[activeParity];
        const allShortDays = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM"];

        let displayDayIndex = (baseDayIndex + currentDayOffset) % 6;
        if (displayDayIndex < 0) displayDayIndex += 6;

        const dayName = JOURS[displayDayIndex];
        const shortDay = allShortDays[displayDayIndex];

        let html = '<div style="overflow-x: hidden; padding-bottom: 5px;">';
        html += '<table class="calendar-table calendar-preview-table" style="width: 100%; min-width: 250px; font-size: 15px;">';

        // En-tête : Jour avec navigation ◀ JOUR ▶
        html += '<thead><tr>';
        html += '<th style="background-color: transparent; border: none; min-width: 40px;"></th>';
        html += `<th class="day-header" style="font-size: 1em; padding: 4px; border-right: 2px solid #2c3e50; user-select: none;">`;
        html += `<span onclick="window.navPlanningDay(-1, event)" style="cursor: pointer; padding: 2px 8px; font-size: 0.9em; opacity: 0.8;" title="Jour précédent">◀</span> `;
        html += `<span onclick="window.resetPlanningDay(event)" style="cursor: pointer;" title="Revenir à aujourd'hui">${shortDay}</span> `;
        html += `<span onclick="window.navPlanningDay(1, event)" style="cursor: pointer; padding: 2px 8px; font-size: 0.9em; opacity: 0.8;" title="Jour suivant">▶</span>`;
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
    html += '<th class="day-header" style="width: 100px;"><button class="btn-add-col" onclick="addCalendarRow(\'' + parity + '\')">+ Ligne</button></th>';
    html += '</tr></thead><tbody>';

    data.forEach((row, idx) => {
        // MATIN
        html += '<tr>';
        html += `<th rowspan="2" class="assistant-header" style="vertical-align: middle; border-bottom: 2px solid #2c3e50; border-right: 2px solid #2c3e50;">
                    <input type="text" class="assistant-input" value="${escapeHtml(row.assistant || '')}" onchange="updateCalendarRow('${parity}', ${idx}, 'assistant', this.value)" placeholder="Assistante" style="width: 100%; text-align: center; font-weight: bold;">
                 </th>`;
        JOURS.forEach(day => {
            const dentistAm = row.days[day] ? row.days[day].am : "";
            html += `<td ${attributsCouleur(couleurCellule(dentistAm, row.assistant, day, 'am'))}>
                <div style="font-size:0.75em; opacity:0.6;">Matin</div>
                <input type="text" class="cell-input" value="${escapeHtml(dentistAm)}" onchange="updateCalendarCell('${parity}', ${idx}, '${day}', 'am', this.value)" placeholder="Repos">
            </td>`;
        });
        html += `<td rowspan="2" style="background-color: transparent; border: none; vertical-align: middle; text-align: center; border-bottom: 2px solid #2c3e50;">
                    <button class="btn-remove-col" onclick="removeCalendarRow('${parity}', ${idx})" title="Supprimer la ligne">✕</button>
                 </td>`;
        html += '</tr>';

        // APRES MIDI
        html += '<tr>';
        JOURS.forEach(day => {
            const dentistPm = row.days[day] ? row.days[day].pm : "";
            html += `<td ${attributsCouleur(couleurCellule(dentistPm, row.assistant, day, 'pm'), 'border-bottom: 2px solid #2c3e50;')}>
                <div style="font-size:0.75em; opacity:0.6;">A-M</div>
                <input type="text" class="cell-input" value="${escapeHtml(dentistPm)}" onchange="updateCalendarCell('${parity}', ${idx}, '${day}', 'pm', this.value)" placeholder="Repos">
            </td>`;
        });
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    document.getElementById(containerId).innerHTML = html;
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
    commencerEditionCouleurs();
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
            if (!e.target.closest(".day-header span")) {
                openCalendarModal();
            }
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
        btnSaveCal.addEventListener("click", () => {
            saveCalendarData();
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
