"use strict";

/* ============================================================
   GESTION DES DOSIMÈTRES
   Module de gestion du suivi des dosimètres du cabinet dentaire.
   ============================================================ */

import { getDocument, setDocument, modifierDocument } from '../core/api.js';
import { tempsRappel } from '../core/utils.js';
import { escapeHtml } from '../core/utils.js';
import { nomsDuPlanning } from '../planning/team-planning.js';

/* Données en base (document "dosimetres") : aucun nom dans le code. */

let currentSearchTerm = "";

/**
 * Données des dosimètres (copie du document enregistré).
 */
export function getDosimetresData() {
    return normaliserDosimetres(getDocument("dosimetres"));
}

export function normaliserDosimetres(valeur) {
    const d = (valeur && typeof valeur === "object" && !Array.isArray(valeur)) ? valeur : {};
    return {
        manager: typeof d.manager === "string" ? d.manager : "",
        generalNote: typeof d.generalNote === "string" ? d.generalNote : "",
        // Une entrée invalide (null...) ne doit pas empêcher d'afficher les autres
        dosimetres: (Array.isArray(d.dosimetres) ? d.dosimetres : [])
            .filter(x => x && typeof x === "object" && !Array.isArray(x))
    };
}

/**
 * Enregistre les données en base et met à jour l'interface.
 * `data` : le document complet, ou une fonction qui modifie le document
 * (rejouée sur la version d'un autre poste s'il a écrit entre-temps).
 */
export function saveDosimetresData(data) {
    if (typeof data === "function") {
        modifierDocument("dosimetres", valeur => {
            const doc = normaliserDosimetres(valeur);
            data(doc);
            return doc;
        });
    } else {
        setDocument("dosimetres", data);
    }
    updateDosimetresBadge();
}

/**
 * Met à jour le badge sur le widget de la page principale.
 */
export function updateDosimetresBadge() {
    const data = getDosimetresData();
    const count = (data.dosimetres || []).length;
    const badge = document.getElementById("dosimetre-widget-badge");
    if (badge) {
        badge.textContent = `${count} suivi${count > 1 ? 's' : ''}`;
    }
    const totalBadge = document.getElementById("dosi-total-count-badge");
    if (totalBadge) {
        totalBadge.textContent = `${count} dosimètre${count > 1 ? 's' : ''}`;
    }
}

/**
 * Met à jour l'indicateur du statut de renouvellement / alerte.
 */
function updateAlertStatusBadge() {
    const nextTime = tempsRappel((getDocument("rappel_dosimetres") || {}).nextTime);
    const badge = document.getElementById('dosi-next-alert-badge');
    if (!badge) return;

    if (!nextTime) {
        badge.textContent = "⚠️ Échéance immédiate";
        badge.style.background = "#fee2e2";
        badge.style.color = "#b91c1c";
        return;
    }

    const now = Date.now();
    if (now >= nextTime) {
        badge.textContent = "⚠️ Renouvellement à faire";
        badge.style.background = "#fee2e2";
        badge.style.color = "#b91c1c";
    } else {
        const diffDays = Math.ceil((nextTime - now) / (1000 * 60 * 60 * 24));
        badge.textContent = `✅ OK (dans ${diffDays} j)`;
        badge.style.background = "#dcfce7";
        badge.style.color = "#15803d";
    }
}

/**
 * Affiche le tableau des dosimètres selon le filtre de recherche.
 */
function renderDosimetresTable() {
    const tbody = document.getElementById("dosi-table-body");
    if (!tbody) return;

    const data = getDosimetresData();
    const items = data.dosimetres || [];
    const term = currentSearchTerm.toLowerCase().trim();

    const filtered = items.filter(item => {
        if (!term) return true;
        const num = (item.number || "").toLowerCase();
        const user = (item.user || "").toLowerCase();
        const note = (item.note || "").toLowerCase();
        return num.includes(term) || user.includes(term) || note.includes(term);
    });

    tbody.innerHTML = "";

    if (filtered.length === 0) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td colspan="4" style="text-align: center; padding: 25px; color: #64748b; font-style: italic;">
                ${term ? "Aucun dosimètre ne correspond à votre recherche." : "Aucun dosimètre enregistré pour le moment. Remplissez le formulaire ci-dessus pour en ajouter."}
            </td>
        `;
        tbody.appendChild(tr);
        return;
    }

    filtered.forEach(item => {
        const tr = document.createElement("tr");
        tr.style.borderBottom = "1px solid #e2e8f0";
        tr.style.transition = "background-color 0.15s ease";
        tr.onmouseover = () => tr.style.backgroundColor = "#f8fafc";
        tr.onmouseout = () => tr.style.backgroundColor = "transparent";

        tr.innerHTML = `
            <td style="padding: 10px 12px; font-weight: bold; color: #1e293b;">
                <span style="display: inline-flex; align-items: center; gap: 6px;">
                    <span style="color: #f39c12; font-size: 1.1em;">☢️</span>
                    ${escapeHtml(item.number || "Sans n°")}
                </span>
            </td>
            <td style="padding: 10px 12px; color: #0284c7; font-weight: 600;">
                👤 ${escapeHtml(item.user || "Non attribué")}
            </td>
            <td style="padding: 10px 12px; color: #475569;">
                ${escapeHtml(item.note || "-")}
            </td>
            <td style="padding: 10px 12px; text-align: center;">
                <button class="btn btn-blue btn-edit-dosi" data-id="${escapeHtml(item.id)}" title="Modifier ce dosimètre" style="padding: 4px 8px; font-size: 0.85em; margin-right: 4px;">✏️</button>
                <button class="btn btn-red btn-delete-dosi" data-id="${escapeHtml(item.id)}" title="Supprimer ce dosimètre" style="padding: 4px 8px; font-size: 0.85em;">🗑️</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // Écouteurs pour les boutons Modifier et Supprimer
    tbody.querySelectorAll(".btn-edit-dosi").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = parseInt(btn.dataset.id, 10);
            startEditDosimetre(id);
        });
    });

    tbody.querySelectorAll(".btn-delete-dosi").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = parseInt(btn.dataset.id, 10);
            deleteDosimetre(id);
        });
    });
}

/**
 * Prépare le formulaire pour l'édition d'un dosimètre.
 */
function startEditDosimetre(id) {
    const data = getDosimetresData();
    const item = (data.dosimetres || []).find(d => d.id === id);
    if (!item) return;

    document.getElementById("dosi-edit-id").value = item.id;
    document.getElementById("dosi-number-input").value = item.number || "";
    document.getElementById("dosi-user-input").value = item.user || "";
    document.getElementById("dosi-note-input").value = item.note || "";

    const formTitle = document.getElementById("dosi-form-title");
    if (formTitle) formTitle.textContent = "✏️ Modifier le dosimètre";

    const submitBtn = document.getElementById("dosi-submit-btn");
    if (submitBtn) {
        submitBtn.textContent = "💾 Mettre à jour";
        submitBtn.className = "btn btn-blue";
    }

    const cancelBtn = document.getElementById("dosi-cancel-edit-btn");
    if (cancelBtn) cancelBtn.classList.remove("hidden");

    document.getElementById("dosi-number-input").focus();
}

/**
 * Réinitialise le formulaire d'ajout.
 */
function resetDosimetreForm() {
    document.getElementById("dosi-edit-id").value = "";
    document.getElementById("dosi-number-input").value = "";
    document.getElementById("dosi-user-input").value = "";
    document.getElementById("dosi-note-input").value = "";

    const formTitle = document.getElementById("dosi-form-title");
    if (formTitle) formTitle.textContent = "➕ Ajouter un dosimètre";

    const submitBtn = document.getElementById("dosi-submit-btn");
    if (submitBtn) {
        submitBtn.textContent = "➕ Ajouter";
        submitBtn.className = "btn btn-green";
    }

    const cancelBtn = document.getElementById("dosi-cancel-edit-btn");
    if (cancelBtn) cancelBtn.classList.add("hidden");
}

/**
 * Supprime un dosimètre après confirmation.
 */
function deleteDosimetre(id) {
    const data = getDosimetresData();
    const item = (data.dosimetres || []).find(d => d.id === id);
    const label = item ? `${item.number} (${item.user})` : "ce dosimètre";

    if (confirm(`Confirmez-vous la suppression de ${label} ?`)) {
        saveDosimetresData(doc => { doc.dosimetres = doc.dosimetres.filter(d => d.id !== id); });
        renderDosimetresTable();
        resetDosimetreForm();
    }
}

/**
 * Enregistre le formulaire d'ajout / modification de dosimètre.
 */
function handleDosimetreSubmit() {
    const editIdStr = document.getElementById("dosi-edit-id").value;
    const number = document.getElementById("dosi-number-input").value.trim();
    const user = document.getElementById("dosi-user-input").value.trim();
    const note = document.getElementById("dosi-note-input").value.trim();

    if (!number && !user) {
        alert("Veuillez renseigner au minimum un numéro de dosimètre ou un nom d'utilisateur.");
        return;
    }

    if (editIdStr) {
        // Mode Modification
        const editId = parseInt(editIdStr, 10);
        const modifie = { id: editId, number: number || "Sans n°", user: user || "Non attribué", note };
        saveDosimetresData(doc => {
            const index = doc.dosimetres.findIndex(d => d.id === editId);
            if (index !== -1) doc.dosimetres[index] = { ...modifie };
        });
    } else {
        // Mode Ajout
        const newId = Date.now();
        saveDosimetresData(doc => {
            doc.dosimetres.push({
                id: newId,
                number: number || `Dosi #${doc.dosimetres.length + 1}`,
                user: user || "Non attribué",
                note
            });
        });
    }
    renderDosimetresTable();
    resetDosimetreForm();
}

/**
 * Enregistre le responsable et la note générale.
 */
function handleSaveGeneralInfo() {
    const managerInput = document.getElementById("dosi-manager-input");
    const generalNoteInput = document.getElementById("dosi-general-note");
    const manager = managerInput ? managerInput.value.trim() : null;
    const generalNote = generalNoteInput ? generalNoteInput.value.trim() : null;

    // Seuls ces deux champs : la liste des dosimètres n'est pas réécrite
    saveDosimetresData(doc => {
        if (manager !== null) doc.manager = manager;
        if (generalNote !== null) doc.generalNote = generalNote;
    });
    
    // Feedback visuel sur le bouton
    const saveBtn = document.getElementById("dosi-save-global-btn");
    if (saveBtn) {
        const originalText = saveBtn.textContent;
        saveBtn.textContent = "✅ Enregistré !";
        saveBtn.style.background = "#10b981";
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.background = "";
        }, 1800);
    }
}

/**
 * Ouvre la boîte de dialogue de gestion des dosimètres.
 */
export function openDosimetresDialog() {
    const overlay = document.getElementById("dosimetres-overlay");
    if (!overlay) return;

    const data = getDosimetresData();

    // Remplir les champs généraux
    const managerInput = document.getElementById("dosi-manager-input");
    if (managerInput) managerInput.value = data.manager || "";

    const generalNoteInput = document.getElementById("dosi-general-note");
    if (generalNoteInput) generalNoteInput.value = data.generalNote || "";

    // Mettre à jour la datalist des utilisateurs suggérés
    populateUsersDatalist();

    // Mettre à jour l'état d'alerte et le tableau
    updateAlertStatusBadge();
    resetDosimetreForm();
    renderDosimetresTable();

    overlay.classList.remove("hidden");
}

/**
 * Remplir la liste de suggestions pour les utilisateurs.
 */
function populateUsersDatalist() {
    const datalist = document.getElementById("dosi-users-datalist");
    if (!datalist) return;

    // Suggestions : les personnes du planning et les porteurs déjà saisis
    const usersSet = new Set(nomsDuPlanning());

    const data = getDosimetresData();
    (data.dosimetres || []).forEach(d => {
        if (d.user && d.user !== "Non attribué") usersSet.add(d.user);
    });

    datalist.innerHTML = "";
    Array.from(usersSet).sort().forEach(user => {
        const opt = document.createElement("option");
        opt.value = user;
        datalist.appendChild(opt);
    });
}

/**
 * Initialise le module et attache les événements.
 */
export function initDosimetres() {
    // Bouton / Widget sur la page principale
    const widget = document.getElementById("btn-dosimetre");
    if (widget) {
        widget.addEventListener("click", () => {
            openDosimetresDialog();
        });
    }

    // Soumission du formulaire (Ajout / Modif)
    const submitBtn = document.getElementById("dosi-submit-btn");
    if (submitBtn) {
        submitBtn.addEventListener("click", (e) => {
            e.preventDefault();
            handleDosimetreSubmit();
        });
    }

    // Touche Entrée dans les champs du formulaire
    ["dosi-number-input", "dosi-user-input", "dosi-note-input"].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener("keyup", (e) => {
                if (e.key === "Enter") handleDosimetreSubmit();
            });
        }
    });

    // Annuler l'édition
    const cancelBtn = document.getElementById("dosi-cancel-edit-btn");
    if (cancelBtn) {
        cancelBtn.addEventListener("click", (e) => {
            e.preventDefault();
            resetDosimetreForm();
        });
    }

    // Recherche / Filtre dans le tableau
    const searchInput = document.getElementById("dosi-table-search");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            currentSearchTerm = e.target.value;
            renderDosimetresTable();
        });
    }

    // Sauvegarder tout
    const saveBtn = document.getElementById("dosi-save-global-btn");
    if (saveBtn) {
        saveBtn.addEventListener("click", handleSaveGeneralInfo);
    }

    // Changement direct sur responsable ou note générale : auto-sauvegarde au blur
    const managerInput = document.getElementById("dosi-manager-input");
    if (managerInput) {
        managerInput.addEventListener("blur", handleSaveGeneralInfo);
    }
    const generalNoteInput = document.getElementById("dosi-general-note");
    if (generalNoteInput) {
        generalNoteInput.addEventListener("blur", handleSaveGeneralInfo);
    }

    // Bouton configurer le rappel (ouvre le dialogue d'alerte dosimètre existant)
    const alertConfigBtn = document.getElementById("dosi-config-alert-btn");
    if (alertConfigBtn) {
        alertConfigBtn.addEventListener("click", () => {
            const dosiOverlay = document.getElementById("dosi-overlay");
            if (dosiOverlay) {
                dosiOverlay.classList.remove("hidden");
            }
        });
    }

    // Mettre à jour le badge au démarrage
    updateDosimetresBadge();
    updateAlertStatusBadge();

    // Rendre disponible globalement si besoin
    window.openDosimetresDialog = openDosimetresDialog;
}
