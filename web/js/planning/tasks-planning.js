"use strict";

/* ============================================================
   Gestion du Tableau Taches des assistantes
   ============================================================ */

import { escapeHtml } from '../core/utils.js';
import { getDocument, versionDocument, enregistrerEdition } from '../core/api.js';
import { couleurTache, attributsCouleur } from './couleurs.js';

/* Les tâches sont en base (document "taches") : aucun nom dans le code. */

let brouillon = null; // copie en cours d'édition (fenêtre ouverte)
let versionLue = null; // version du document à l'ouverture de la fenêtre

export function normaliserTaches(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    const texte = v => (v === null || v === undefined) ? "" : String(v);
    return {
        header1: texte(d.header1),
        header2: texte(d.header2),
        note: texte(d.note),
        // Une ligne invalide (null...) est ignorée au lieu de bloquer l'affichage
        rows: (Array.isArray(d.rows) ? d.rows : [])
            .filter(r => r && typeof r === "object" && !Array.isArray(r))
            .map(r => ({ task: texte(r.task), nature: texte(r.nature), col1: texte(r.col1), col2: texte(r.col2) }))
    };
}

export function getTasksData() {
    return brouillon || normaliserTaches(getDocument("taches"));
}

/** Enregistre le tableau saisi. Résolue avec true si c'est enregistré. */
export async function saveTasksData() {
    if (!brouillon) return true;
    if (!await enregistrerEdition("taches", brouillon, versionLue, "Le tableau des tâches")) return false;
    brouillon = null;
    return true;
}

export function updateTasksPreview() {
    const previewContainer = document.getElementById("tasks-preview-content");
    if (previewContainer) {
        const data = normaliserTaches(getDocument("taches"));
        let html = '<div style="overflow-x: hidden; padding-bottom: 5px;">';
        html += '<table class="calendar-table calendar-preview-table" style="width: 100%; min-width: 250px; font-size: 15px;">';
        
        html += '<thead><tr>';
        html += `<th class="day-header" style="font-size: 1em; padding: 4px; border-right: 2px solid #2c3e50;">TACHES</th>`;
        html += `<th class="day-header" style="font-size: 1em; padding: 4px; border-right: 2px solid #2c3e50;">NATURE</th>`;
        html += `<th class="day-header" style="font-size: 1em; padding: 4px;">ASSIGNÉ(S)</th>`;
        html += '</tr></thead><tbody>';

        // Limit preview to first 3 rows for compactness
        const previewRows = data.rows.slice(0, 3);
        previewRows.forEach(row => {
            html += '<tr>';
            html += `<th class="assistant-header" style="font-size: 0.9em; padding: 4px; border-right: 2px solid #2c3e50; vertical-align: middle;">${escapeHtml(row.task || '')}</th>`;
            html += `<td style="font-size: 0.95em; padding: 4px 6px; text-align: center; color: black; border-right: 2px solid #2c3e50; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${escapeHtml(row.nature || '')}</td>`;
            let assignes = [row.col1, row.col2].filter(v => v && v.trim() !== "").join(" / ");
            html += `<td ${attributsCouleur(couleurTache(assignes), "font-size: 0.95em; padding: 4px 6px; text-align: center; color: black; font-style: italic;")}>${escapeHtml(assignes)}</td>`;
            html += '</tr>';
        });

        if (data.rows.length === 0) {
            html += `<tr><td colspan="3" style="text-align: center; padding: 6px; color: #7f8c8d; font-style: italic;">Aucune tâche : cliquez pour en ajouter</td></tr>`;
        }
        if (data.rows.length > 3) {
            html += `<tr><td colspan="3" style="text-align: center; padding: 4px; color: #7f8c8d; font-size: 0.9em; border: 1px solid black;">... et ${data.rows.length - 3} autres tâches</td></tr>`;
        }

        html += '</tbody></table></div>';
        previewContainer.innerHTML = html;
    }
}

export function renderTasksTable(containerId) {
    const data = getTasksData();
    let html = '<div class="calendar-wrapper"><table class="calendar-table" style="width: 100%; text-align: left;">';
    
    html += '<thead><tr>';
    html += `<th class="day-header" style="width: 20%;">TACHES</th>`;
    html += `<th class="day-header" style="width: 40%;">NATURE DE LA TACHE</th>`;
    html += `<th class="day-header" style="width: 20%;"><input type="text" class="assistant-input" style="width: 100%; text-align: center; font-weight: bold; background: transparent; border: none; color: black; font-family: inherit;" value="${escapeHtml(data.header1 || '')}" data-entete="header1"></th>`;
    html += `<th class="day-header" style="width: 10%;"><input type="text" class="assistant-input" style="width: 100%; text-align: center; font-weight: bold; background: transparent; border: none; color: black; font-family: inherit;" value="${escapeHtml(data.header2 || '')}" data-entete="header2"></th>`;
    html += `<th class="day-header" style="width: 10%;"><button class="btn-add-col" data-ajouter-tache>+ Ligne</button></th>`;
    html += '</tr></thead><tbody>';

    data.rows.forEach((row, idx) => {

        html += '<tr>';
        html += `<th class="assistant-header" style="vertical-align: middle; padding: 5px;">
                    <textarea class="cell-input" style="width: 100%; height: 60px; font-weight: bold; resize: vertical; background: transparent; font-family: inherit;" data-ligne="${idx}" data-champ="task">${escapeHtml(row.task || '')}</textarea>
                 </th>`;
        html += `<td style="vertical-align: middle; padding: 5px;">
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; font-family: inherit;" data-ligne="${idx}" data-champ="nature">${escapeHtml(row.nature || '')}</textarea>
                 </td>`;
        html += `<td ${attributsCouleur(couleurTache(row.col1), "vertical-align: middle; padding: 5px;")}>
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; color: inherit; font-family: inherit;" data-ligne="${idx}" data-champ="col1">${escapeHtml(row.col1 || '')}</textarea>
                 </td>`;
        html += `<td ${attributsCouleur(couleurTache(row.col2), "vertical-align: middle; padding: 5px; position: relative;")}>
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; color: inherit; font-family: inherit;" data-ligne="${idx}" data-champ="col2">${escapeHtml(row.col2 || '')}</textarea>
                    <button class="btn-remove-col" data-supprimer-tache="${idx}" title="Supprimer la ligne">✕</button>
                 </td>`;
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    const conteneur = document.getElementById(containerId);
    conteneur.innerHTML = html;
    ecouterTableau(conteneur);
}

/** Écouteurs délégués (aucun gestionnaire en ligne dans le HTML généré). */
function ecouterTableau(conteneur) {
    if (conteneur.dataset.ecoute) return;
    conteneur.dataset.ecoute = "1";
    conteneur.addEventListener("click", e => {
        if (e.target.closest("[data-ajouter-tache]")) {
            window.addTasksRow();
            return;
        }
        const suppr = e.target.closest("[data-supprimer-tache]");
        if (suppr) window.removeTasksRow(Number(suppr.dataset.supprimerTache));
    });
    conteneur.addEventListener("change", e => {
        const entete = e.target.closest("[data-entete]");
        if (entete) {
            window.updateTasksHeader(entete.dataset.entete, entete.value);
            return;
        }
        const cellule = e.target.closest("[data-ligne][data-champ]");
        if (cellule) window.updateTasksCell(Number(cellule.dataset.ligne), cellule.dataset.champ, cellule.value);
    });
}

window.addTasksRow = function () {
    getTasksData().rows.push({ task: "", nature: "", col1: "", col2: "" });
    renderTasksTable('tasks-container');
};

window.removeTasksRow = function (idx) {
    if (confirm("Supprimer cette tâche ?")) {
        getTasksData().rows.splice(idx, 1);
        renderTasksTable('tasks-container');
    }
};

window.updateTasksCell = function (idx, field, value) {
    getTasksData().rows[idx][field] = value;
};

window.updateTasksHeader = function (field, value) {
    getTasksData()[field] = value;
};

/** Ouvre la fenêtre d'édition sur une copie du tableau enregistré. */
export function ouvrirTaches() {
    brouillon = normaliserTaches(getDocument("taches"));
    versionLue = versionDocument("taches");
    const note = document.getElementById("tasks-note");
    if (note) note.value = brouillon.note;
    const overlay = document.getElementById("tasks-overlay");
    if (overlay) overlay.classList.remove("hidden");
    renderTasksTable('tasks-container');
}

export function initTasksPlanning() {
    setTimeout(() => {
        updateTasksPreview();

        const btnOpen = document.getElementById("btn-open-tasks");
        if (btnOpen) {
            btnOpen.addEventListener("click", ouvrirTaches);
        }

        // Fermer sans sauvegarder abandonne les modifications
        document.querySelectorAll('[data-close="tasks-overlay"]').forEach(btn => {
            btn.addEventListener("click", () => { brouillon = null; });
        });

        const noteInput = document.getElementById("tasks-note");
        if (noteInput) {
            noteInput.addEventListener("input", () => {
                if (brouillon) brouillon.note = noteInput.value;
            });
        }

        const btnSaveTasks = document.getElementById("btn-save-tasks");
        if (btnSaveTasks) {
            btnSaveTasks.addEventListener("click", async () => {
                btnSaveTasks.disabled = true;
                let ok;
                try {
                    ok = await saveTasksData();
                } finally {
                    btnSaveTasks.disabled = false;
                }
                // Échec ou conflit : la fenêtre reste ouverte avec la saisie
                if (!ok) return;
                alert("Tâches sauvegardées avec succès !");
                document.getElementById("tasks-overlay").classList.add("hidden");
                updateTasksPreview();
            });
        }
    }, 100);
}

window.updateTasksPreview = updateTasksPreview;
