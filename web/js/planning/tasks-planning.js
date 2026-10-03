"use strict";

/* ============================================================
   Gestion du Tableau Taches des assistantes
   ============================================================ */

import { escapeHtml } from '../core/utils.js';
import { getDocument, setDocument } from '../core/api.js';
import { couleurTache, attributsCouleur } from './couleurs.js';

/* Les tâches sont en base (document "taches") : aucun nom dans le code. */

let brouillon = null; // copie en cours d'édition (fenêtre ouverte)

function normaliserTaches(doc) {
    const d = (doc && typeof doc === "object") ? doc : {};
    return {
        header1: d.header1 || "",
        header2: d.header2 || "",
        note: d.note || "",
        rows: Array.isArray(d.rows) ? d.rows.map(r => ({
            task: r.task || "", nature: r.nature || "", col1: r.col1 || "", col2: r.col2 || ""
        })) : []
    };
}

export function getTasksData() {
    return brouillon || normaliserTaches(getDocument("taches"));
}

export function saveTasksData() {
    if (brouillon) setDocument("taches", brouillon);
    brouillon = null;
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
    html += `<th class="day-header" style="width: 20%;"><input type="text" class="assistant-input" style="width: 100%; text-align: center; font-weight: bold; background: transparent; border: none; color: black; font-family: inherit;" value="${escapeHtml(data.header1 || '')}" onchange="updateTasksHeader('header1', this.value)"></th>`;
    html += `<th class="day-header" style="width: 10%;"><input type="text" class="assistant-input" style="width: 100%; text-align: center; font-weight: bold; background: transparent; border: none; color: black; font-family: inherit;" value="${escapeHtml(data.header2 || '')}" onchange="updateTasksHeader('header2', this.value)"></th>`;
    html += `<th class="day-header" style="width: 10%;"><button class="btn-add-col" onclick="addTasksRow()">+ Ligne</button></th>`;
    html += '</tr></thead><tbody>';

    data.rows.forEach((row, idx) => {

        html += '<tr>';
        html += `<th class="assistant-header" style="vertical-align: middle; padding: 5px;">
                    <textarea class="cell-input" style="width: 100%; height: 60px; font-weight: bold; resize: vertical; background: transparent; font-family: inherit;" onchange="updateTasksCell(${idx}, 'task', this.value)">${escapeHtml(row.task || '')}</textarea>
                 </th>`;
        html += `<td style="vertical-align: middle; padding: 5px;">
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; font-family: inherit;" onchange="updateTasksCell(${idx}, 'nature', this.value)">${escapeHtml(row.nature || '')}</textarea>
                 </td>`;
        html += `<td ${attributsCouleur(couleurTache(row.col1), "vertical-align: middle; padding: 5px;")}>
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; color: inherit; font-family: inherit;" onchange="updateTasksCell(${idx}, 'col1', this.value)">${escapeHtml(row.col1 || '')}</textarea>
                 </td>`;
        html += `<td ${attributsCouleur(couleurTache(row.col2), "vertical-align: middle; padding: 5px; position: relative;")}>
                    <textarea class="cell-input" style="width: 100%; height: 60px; resize: vertical; background: transparent; color: inherit; font-family: inherit;" onchange="updateTasksCell(${idx}, 'col2', this.value)">${escapeHtml(row.col2 || '')}</textarea>
                    <button class="btn-remove-col" onclick="removeTasksRow(${idx})" title="Supprimer la ligne">✕</button>
                 </td>`;
        html += '</tr>';
    });

    html += '</tbody></table></div>';
    document.getElementById(containerId).innerHTML = html;
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
            btnSaveTasks.addEventListener("click", () => {
                saveTasksData();
                alert("Tâches sauvegardées avec succès !");
                document.getElementById("tasks-overlay").classList.add("hidden");
                updateTasksPreview();
            });
        }
    }, 100);
}

window.updateTasksPreview = updateTasksPreview;
