"use strict";

/* ============================================================
   FAUTEUIL MAINTENANCE ALERT (Gestion par Cabinet & Fauteuil)
   Permet à l'utilisateur de définir librement la date de rappel
   de maintenance pour chaque fauteuil dentaire du cabinet, avec
   alertes automatiques et notifications sur l'accueil principal.
   Les échéances sont en base (document "rappels_fauteuils").
   ============================================================ */

import { getDocument, modifierDocument, pret } from '../core/api.js';
import { tempsRappel } from '../core/utils.js';

export const FAUTEUILS = [
    { machine: "Fauteuil Sinius", cabinet: "Cabinet 1", label: "Cabinet 1 (Sinius)", shortLabel: "Cab 1 - Sinius", defaultDays: 180 },
    { machine: "Fauteuil Planmeca compact", cabinet: "Cabinet 2", label: "Cabinet 2 (Planmeca compact)", shortLabel: "Cab 2 - Planmeca", defaultDays: 180 },
    { machine: "Fauteuil Anthos", cabinet: "Cabinet 4", label: "Cabinet 4 (Anthos)", shortLabel: "Cab 4 - Anthos", defaultDays: 180 },
    { machine: "Fauteuil OVIS", cabinet: "Cabinet 5", label: "Cabinet 5 (OVIS)", shortLabel: "Cab 5 - OVIS", defaultDays: 180 },
    { machine: "Fauteuil Planmeca", cabinet: "Salle de chirurgie", label: "Salle de chirurgie (Planmeca)", shortLabel: "Chirurgie - Planmeca", defaultDays: 180 }
];

// Trouver la configuration d'un fauteuil par nom de machine ou cabinet
export function getFauteuilConfig(machineOrCabinet) {
    return FAUTEUILS.find(f => f.machine === machineOrCabinet || f.cabinet === machineOrCabinet || f.label === machineOrCabinet) || {
        machine: machineOrCabinet,
        cabinet: machineOrCabinet,
        label: machineOrCabinet,
        shortLabel: machineOrCabinet,
        defaultDays: 180
    };
}

// Formatage de dates en JJ/MM/AAAA
export function formatDateFR(timestamp) {
    if (!timestamp) return "Non définie";
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return "Non définie";
    const pad = x => String(x).padStart(2, "0");
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Formatage pour champ input type="date" (YYYY-MM-DD)
export function formatDateInput(timestamp) {
    if (!timestamp) return "";
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return "";
    const pad = x => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Parse input type="date" (YYYY-MM-DD) en millisecondes (calé à midi pour éviter les décalages de fuseau)
export function parseDateInput(str) {
    if (!str) return null;
    const parts = str.split("-");
    if (parts.length !== 3) return null;
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
    return isNaN(d.getTime()) ? null : d.getTime();
}

// État de mise en veille (snooze) pour la session active
// Machines dont la popup a été écartée (« Ignorer pour l'instant ») : elle ne
// se rouvre pas pour elles, mais une NOUVELLE échéance la rouvre (poste qui
// reste allumé des semaines).
const fauteuilEcartees = new Set();
let currentFauteuilMachine = "Fauteuil Sinius";

export function setFauteuilSnoozed(value) {
    if (value) {
        for (const m of machinesEnRetardFauteuil()) fauteuilEcartees.add(m);
    }
}

// Toutes les échéances enregistrées en base
export function getAllFauteuilData() {
    const data = getDocument("rappels_fauteuils");
    return (data && typeof data === "object") ? data : {};
}

// Récupération des données pour un fauteuil donné
export function getFauteuilDataForMachine(machineName) {
    const all = getAllFauteuilData();
    if (all[machineName] && typeof all[machineName] === "object") {
        return { ...all[machineName], nextTime: tempsRappel(all[machineName].nextTime) };
    }
    return {
        nextTime: null,
        lastDone: null,
        intervalDays: 180,
        note: ""
    };
}

// Sauvegarde des données pour un fauteuil donné
export function saveFauteuilDataForMachine(machineName, nextTime, intervalDays = null, note = null) {
    const lastDone = Date.now();
    // Seul ce fauteuil est modifié (rejoué sur la version d'un autre poste)
    modifierDocument("rappels_fauteuils", valeur => {
        const all = (valeur && typeof valeur === "object" && !Array.isArray(valeur)) ? valeur : {};
        const existing = (all[machineName] && typeof all[machineName] === "object") ? all[machineName] : {};
        all[machineName] = {
            ...existing,
            nextTime,
            lastDone,
            intervalDays: intervalDays || existing.intervalDays || 180,
            note: note !== null ? note : (existing.note || "")
        };
        return all;
    });
}

function machinesEnRetardFauteuil() {
    return FAUTEUILS.map(f => f.machine).filter(m => getFauteuilStatus(m).isDue);
}

/** Date choisie déjà passée (avant aujourd'hui) : l'échéance resterait due. */
export function dateRappelPassee(temps, maintenant = Date.now()) {
    const debutDuJour = new Date(maintenant);
    debutDuJour.setHours(0, 0, 0, 0);
    return Boolean(temps) && temps < debutDuJour.getTime();
}

// Calcul du statut d'échéance de maintenance pour un fauteuil
export function getFauteuilStatus(machineName) {
    const data = getFauteuilDataForMachine(machineName);
    const now = Date.now();
    // Si aucune date définie, on considère qu'une première maintenance est à planifier / à faire
    const isDue = (!data.nextTime || now >= data.nextTime);
    return {
        machine: machineName,
        nextTime: data.nextTime,
        lastDone: data.lastDone,
        intervalDays: data.intervalDays,
        note: data.note || "",
        isDue: isDue,
        dateStr: formatDateFR(data.nextTime)
    };
}

// Mise à jour visuelle des boutons sur les fiches machines et du plan du cabinet
export function updateFauteuilIconStatus() {
    document.querySelectorAll('.btn-fauteuil-maint-icon').forEach(btn => {
        const machine = btn.dataset.machine || btn.closest('[data-machine]')?.dataset.machine || "Fauteuil Sinius";
        const status = getFauteuilStatus(machine);

        if (status.isDue) {
            btn.style.color = '#c0392b';
            btn.style.borderColor = '#c0392b';
            btn.style.background = '#fff5f5';
            btn.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="fauteuil-icon-status">⚠️</span> <span style="font-weight: bold;">Maint. Fauteuil (À faire)</span>
                    </div>
                    <div class="fauteuil-icon-date" style="font-size: 11px; font-weight: 500; opacity: 0.9;">
                        Date : ${status.dateStr}
                    </div>
                </div>
            `;
            btn.title = `Maintenance à planifier / échue pour ${machine} (Échéance : ${status.dateStr})`;
        } else {
            btn.style.color = '#555';
            btn.style.borderColor = '#ddd';
            btn.style.background = '#fdfdfd';
            btn.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="fauteuil-icon-status">🔔</span> <span>Maint. Fauteuil (Ok)</span>
                    </div>
                    <div class="fauteuil-icon-date" style="font-size: 11px; font-weight: 500; color: #16a34a;">
                        Prochaine : ${status.dateStr}
                    </div>
                </div>
            `;
            btn.title = `Maintenance à jour pour ${machine} (Prochaine échéance : ${status.dateStr})`;
        }
    });

    // Mise à jour visuelle sur le plan du cabinet
    FAUTEUILS.forEach(item => {
        const piece = document.querySelector(`#plan-container .piece[data-nom="${item.cabinet}"]`);
        if (piece) {
            const status = getFauteuilStatus(item.machine);
            if (status.isDue) {
                piece.classList.add('fauteuil-alert-active');
            } else {
                piece.classList.remove('fauteuil-alert-active');
            }
        }
    });
}

// Mise à jour du dialogue Fauteuil pour le fauteuil sélectionné
function refreshFauteuilDialogUI() {
    const cfg = getFauteuilConfig(currentFauteuilMachine);
    const status = getFauteuilStatus(currentFauteuilMachine);

    const headline = document.getElementById('fauteuil-dialog-headline');
    if (headline) {
        headline.textContent = status.isDue ? "⚠️ RAPPEL MAINTENANCE FAUTEUIL" : "🔔 STATUT MAINTENANCE FAUTEUIL";
        headline.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    const cabinetDisplay = document.getElementById('fauteuil-cabinet-display');
    if (cabinetDisplay) {
        cabinetDisplay.textContent = cfg.label;
        cabinetDisplay.style.color = status.isDue ? "#c0392b" : "#2c3e50";
    }

    const statusBadge = document.getElementById('fauteuil-dialog-status-badge');
    if (statusBadge) {
        statusBadge.textContent = status.isDue ? "⚠️ À faire (Échue ou non définie)" : "✅ À jour (Ok)";
        statusBadge.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    const alertDate = document.getElementById('fauteuil-dialog-alert-date');
    if (alertDate) {
        alertDate.textContent = status.dateStr;
        alertDate.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    // Sélecteur de fauteuil / cabinet
    const cabSelect = document.getElementById('fauteuil-cabinet-select');
    if (cabSelect) {
        cabSelect.innerHTML = "";
        FAUTEUILS.forEach(f => {
            const fStatus = getFauteuilStatus(f.machine);
            const opt = document.createElement('option');
            opt.value = f.machine;
            opt.textContent = `${fStatus.isDue ? '⚠️' : '🔔'} ${f.label} - ${fStatus.dateStr}`;
            if (f.machine === currentFauteuilMachine) opt.selected = true;
            cabSelect.appendChild(opt);
        });
    }

    // Champ date personnalisée : si déjà une date future, on l'affiche, sinon date par défaut
    const customDateInput = document.getElementById('fauteuil-custom-date');
    const rappelSelect = document.getElementById('fauteuil-rappel-select');
    if (customDateInput) {
        // Échéance à venir : on la propose ; échéance passée : on propose
        // la prochaine (aujourd'hui + délai), sinon « Valider » la garderait.
        if (status.nextTime && status.nextTime > Date.now()) {
            customDateInput.value = formatDateInput(status.nextTime);
        } else {
            const days = parseInt(rappelSelect?.value, 10) || cfg.defaultDays || 180;
            const targetTime = Date.now() + days * 24 * 60 * 60 * 1000;
            customDateInput.value = formatDateInput(targetTime);
        }
    }

    // Champ note optionnelle
    const noteInput = document.getElementById('fauteuil-maint-note');
    if (noteInput) {
        noteInput.value = status.note || "";
    }
}

// Ouvrir la boîte de dialogue pour un fauteuil ciblé ou par défaut
export function openFauteuilDialog(targetMachine = null) {
    if (targetMachine) {
        currentFauteuilMachine = targetMachine;
    } else {
        // Sélectionner en priorité le premier fauteuil en alerte
        const firstOverdue = FAUTEUILS.find(f => getFauteuilStatus(f.machine).isDue);
        currentFauteuilMachine = firstOverdue ? firstOverdue.machine : "Fauteuil Sinius";
    }

    refreshFauteuilDialogUI();

    const overlay = document.getElementById('fauteuil-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
    }
    setFauteuilSnoozed(false);
}

// Vérification globale et affichage des alertes sur l'accueil principal
export function checkFauteuilAlert(force = false, targetMachine = null) {
    if (targetMachine) {
        openFauteuilDialog(targetMachine);
        return;
    }

    const overdueList = [];
    FAUTEUILS.forEach(f => {
        const status = getFauteuilStatus(f.machine);
        if (status.isDue) {
            overdueList.push({ ...f, ...status });
        }
    });

    // 1. Mise à jour de l'accueil principal (Notifications de rappel maintenance)
    const alertsContainer = document.getElementById('fauteuil-alerts-container');
    const legacyBtn = document.getElementById('btn-alertes-fauteuil');

    if (alertsContainer) {
        alertsContainer.innerHTML = "";
        if (overdueList.length > 0) {
            alertsContainer.classList.remove('hidden');
            overdueList.forEach(item => {
                const btn = document.createElement('button');
                btn.className = 'btn btn-red btn-fauteuil-main-alert';
                btn.dataset.machine = item.machine;
                btn.style.cssText = "font-size: 0.9em; padding: 6px 12px; width: max-content; flex: 0 0 auto; white-space: nowrap; margin-bottom: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.15);";
                btn.textContent = `⚠️ Maint. Fauteuil : ${item.shortLabel}`;
                btn.title = `Rappel Maintenance Fauteuil - ${item.label} (Échéance : ${item.dateStr})`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openFauteuilDialog(item.machine);
                });
                alertsContainer.appendChild(btn);
            });
            if (legacyBtn) legacyBtn.classList.add('hidden');
        } else {
            alertsContainer.classList.add('hidden');
            if (legacyBtn) legacyBtn.classList.add('hidden');
        }
    } else if (legacyBtn) {
        if (overdueList.length === 1) {
            legacyBtn.textContent = `⚠️ Maint. Fauteuil : ${overdueList[0].shortLabel}`;
            legacyBtn.title = `Rappel Maintenance - ${overdueList[0].label} (Échéance : ${overdueList[0].dateStr})`;
            legacyBtn.classList.remove('hidden');
        } else if (overdueList.length > 1) {
            legacyBtn.textContent = `⚠️ Maint. Fauteuils (${overdueList.length} en attente)`;
            legacyBtn.title = `${overdueList.length} maintenances fauteuils à faire`;
            legacyBtn.classList.remove('hidden');
        } else {
            legacyBtn.classList.add('hidden');
        }
    }

    // 2. Mise à jour des fiches machines et du plan
    updateFauteuilIconStatus();

    // 3. Popup automatique pour une échéance qui n'a pas déjà été écartée
    const enRetard = new Set(overdueList.map(o => o.machine));
    for (const m of [...fauteuilEcartees]) if (!enRetard.has(m)) fauteuilEcartees.delete(m);
    const nouvelles = overdueList.filter(o => !fauteuilEcartees.has(o.machine));
    if (nouvelles.length > 0) {
        openFauteuilDialog(nouvelles[0].machine);
    }
}

// Navigation vers le cabinet correspondant dans l'interface Maintenance
export function navigateToFauteuilCabinet(cabinetName) {
    const overlay = document.getElementById('fauteuil-overlay');
    if (overlay) overlay.classList.add('hidden');
    // On va voir le fauteuil : la popup ne doit pas revenir par-dessus
    setFauteuilSnoozed(true);

    const btnMaint = document.getElementById('btn-maintenance-cabinet');
    if (btnMaint) btnMaint.click();

    setTimeout(() => {
        const piece = document.querySelector(`#maintenance-cabinet-overlay .piece[data-nom="${cabinetName}"]`);
        if (piece) {
            piece.click();
        }
    }, 150);
}

// Initialisation des écouteurs au chargement du DOM
if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => pret.then(() => {
        updateFauteuilIconStatus();

        // Clic sur les boutons de maintenance des fiches fauteuils
        document.querySelectorAll('.btn-fauteuil-maint-icon').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const machine = btn.dataset.machine || btn.closest('[data-machine]')?.dataset.machine;
                openFauteuilDialog(machine);
            });
        });

        // Changement de fauteuil dans la boîte de dialogue
        const cabSelect = document.getElementById('fauteuil-cabinet-select');
        if (cabSelect) {
            cabSelect.addEventListener('change', () => {
                currentFauteuilMachine = cabSelect.value;
                refreshFauteuilDialogUI();
            });
        }

        // Changement de délai prédéfini -> préremplit immédiatement la date personnalisée
        const select = document.getElementById('fauteuil-rappel-select');
        if (select) {
            select.addEventListener('change', () => {
                const days = parseInt(select.value, 10) || 180;
                const targetTime = Date.now() + days * 24 * 60 * 60 * 1000;
                const customDateInput = document.getElementById('fauteuil-custom-date');
                if (customDateInput) {
                    customDateInput.value = formatDateInput(targetTime);
                }
            });
        }

        // Validation pour le fauteuil en cours
        const btnValidate = document.getElementById('fauteuil-validate-btn');
        if (btnValidate) {
            btnValidate.addEventListener('click', () => {
                const customDateInput = document.getElementById('fauteuil-custom-date');
                const customTime = parseDateInput(customDateInput ? customDateInput.value : "");
                const noteInput = document.getElementById('fauteuil-maint-note');
                const note = noteInput ? noteInput.value.trim() : "";
                if (dateRappelPassee(customTime)) {
                    alert("La date de la prochaine maintenance est déjà passée : choisissez une date à venir.");
                    return;
                }

                let nextTime;
                let days = 180;
                if (customTime) {
                    nextTime = customTime;
                    days = Math.max(1, Math.round((nextTime - Date.now()) / (24 * 60 * 60 * 1000)));
                } else {
                    const sel = document.getElementById('fauteuil-rappel-select');
                    days = parseInt(sel?.value, 10) || 180;
                    nextTime = Date.now() + days * 24 * 60 * 60 * 1000;
                }

                saveFauteuilDataForMachine(currentFauteuilMachine, nextTime, days, note);

                const overlay = document.getElementById('fauteuil-overlay');
                if (overlay) overlay.classList.add('hidden');

                setFauteuilSnoozed(false);
                updateFauteuilIconStatus();
                checkFauteuilAlert();
            });
        }

        // Validation globale : appliquer ce rappel à tous les fauteuils
        const btnValidateAll = document.getElementById('fauteuil-validate-all-btn');
        if (btnValidateAll) {
            btnValidateAll.addEventListener('click', () => {
                const customDateInput = document.getElementById('fauteuil-custom-date');
                const customTime = parseDateInput(customDateInput ? customDateInput.value : "");
                const noteInput = document.getElementById('fauteuil-maint-note');
                const note = noteInput ? noteInput.value.trim() : "";
                if (dateRappelPassee(customTime)) {
                    alert("La date de la prochaine maintenance est déjà passée : choisissez une date à venir.");
                    return;
                }

                let nextTime;
                let days = 180;
                if (customTime) {
                    nextTime = customTime;
                    days = Math.max(1, Math.round((nextTime - Date.now()) / (24 * 60 * 60 * 1000)));
                } else {
                    const sel = document.getElementById('fauteuil-rappel-select');
                    days = parseInt(sel?.value, 10) || 180;
                    nextTime = Date.now() + days * 24 * 60 * 60 * 1000;
                }

                FAUTEUILS.forEach(f => {
                    saveFauteuilDataForMachine(f.machine, nextTime, days, note);
                });

                const overlay = document.getElementById('fauteuil-overlay');
                if (overlay) overlay.classList.add('hidden');

                setFauteuilSnoozed(false);
                updateFauteuilIconStatus();
                checkFauteuilAlert();
            });
        }

        // Bouton pour ouvrir le cabinet directement depuis la modale
        const btnGotoCab = document.getElementById('fauteuil-goto-cabinet-btn');
        if (btnGotoCab) {
            btnGotoCab.addEventListener('click', () => {
                const cfg = getFauteuilConfig(currentFauteuilMachine);
                navigateToFauteuilCabinet(cfg.cabinet);
            });
        }

        // Bouton de secours / clic direct accueil
        const mainFauteuilBtn = document.getElementById('btn-alertes-fauteuil');
        if (mainFauteuilBtn) {
            mainFauteuilBtn.addEventListener('click', () => {
                openFauteuilDialog();
            });
        }

        // Fermer la popup sans valider = mise en veille jusqu'au prochain démarrage
        document.querySelectorAll('#fauteuil-overlay [data-close="fauteuil-overlay"]').forEach(btn => {
            btn.addEventListener('click', () => setFauteuilSnoozed(true));
        });

        // Surveillance périodique toutes les minutes
        checkFauteuilAlert();
        setInterval(() => { checkFauteuilAlert(); }, 60000);
    }));
}

// Exportations globales pour compatibilité et appel depuis d'autres modules
if (typeof window !== "undefined") {
    window.checkFauteuilAlert = checkFauteuilAlert;
    window.openFauteuilDialog = openFauteuilDialog;
    window.navigateToFauteuilCabinet = navigateToFauteuilCabinet;
    window.updateFauteuilIconStatus = updateFauteuilIconStatus;
}
