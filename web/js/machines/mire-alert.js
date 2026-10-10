"use strict";

/* ============================================================
   MIRE ALERT (Gestion indépendante par Cabinet & Radio)
   Les échéances sont en base (document "rappels_mire").
   ============================================================ */

import { getDocument, modifierDocument, pret } from '../core/api.js';
import { tempsRappel } from '../core/utils.js';

export const MIRE_RADIOS = [
    { machine: "Radio Cabinet 1", cabinet: "Cabinet 1", label: "Cabinet 1", defaultDays: 30 },
    { machine: "Radio Cabinet 2", cabinet: "Cabinet 2", label: "Cabinet 2", defaultDays: 30 },
    { machine: "Radio Cabinet 4", cabinet: "Cabinet 4", label: "Cabinet 4", defaultDays: 30 },
    { machine: "Radio Cabinet 5", cabinet: "Cabinet 5", label: "Cabinet 5", defaultDays: 30 },
    { machine: "Radio Panoramique", cabinet: "Zone panoramique (Pano)", label: "Radio Panoramique", defaultDays: 180 }
];

// Configuration par défaut ou trouvée
export function getMireConfig(machineOrCabinet) {
    return MIRE_RADIOS.find(r => r.machine === machineOrCabinet || r.cabinet === machineOrCabinet || r.label === machineOrCabinet) || {
        machine: machineOrCabinet,
        cabinet: machineOrCabinet,
        label: machineOrCabinet,
        defaultDays: 30
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

// Parse input type="date" en millisecondes
export function parseDateInput(str) {
    if (!str) return null;
    const parts = str.split("-");
    if (parts.length !== 3) return null;
    const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
    return isNaN(d.getTime()) ? null : d.getTime();
}

// "Ignorer pour l'instant" met en veille la popup automatique pendant la session
// Machines dont la popup a été écartée (« Ignorer pour l'instant ») : elle ne
// se rouvre pas pour elles, mais une NOUVELLE échéance la rouvre (poste qui
// reste allumé des semaines).
const mireEcartees = new Set();
let currentMireMachine = "Radio Cabinet 1";

export function setMireSnoozed(value) {
    if (value) {
        for (const m of machinesEnRetardMire()) mireEcartees.add(m);
    }
}

// --- Stockage en base (document "rappels_mire") ---
export function getAllMireData() {
    const data = getDocument("rappels_mire");
    return (data && typeof data === "object") ? data : {};
}

export function getMireDataForMachine(machineName) {
    const all = getAllMireData();
    if (all[machineName] && typeof all[machineName] === "object") {
        return { ...all[machineName], nextTime: tempsRappel(all[machineName].nextTime) };
    }
    return {
        nextTime: null,
        lastDone: null,
        intervalDays: machineName === 'Radio Panoramique' ? 180 : 30
    };
}

export function saveMireDataForMachine(machineName, nextTime, intervalDays = null) {
    const lastDone = Date.now();
    // Seule cette radio est modifiée : rejouée sur la version d'un autre
    // poste, la validation ne fait pas disparaître la sienne.
    modifierDocument("rappels_mire", valeur => {
        const all = (valeur && typeof valeur === "object" && !Array.isArray(valeur)) ? valeur : {};
        const existant = (all[machineName] && typeof all[machineName] === "object") ? all[machineName] : {};
        all[machineName] = {
            ...existant,
            nextTime,
            lastDone,
            intervalDays: intervalDays || existant.intervalDays || 30
        };
        return all;
    });
}

function machinesEnRetardMire() {
    return MIRE_RADIOS.map(r => r.machine).filter(m => getMireStatus(m).isDue);
}

/** Date choisie déjà passée (avant aujourd'hui) : l'échéance resterait due. */
export function dateRappelPassee(temps, maintenant = Date.now()) {
    const debutDuJour = new Date(maintenant);
    debutDuJour.setHours(0, 0, 0, 0);
    return Boolean(temps) && temps < debutDuJour.getTime();
}

export function getMireStatus(machineName) {
    const data = getMireDataForMachine(machineName);
    const now = Date.now();
    const isDue = (!data.nextTime || now >= data.nextTime);
    return {
        machine: machineName,
        nextTime: data.nextTime,
        lastDone: data.lastDone,
        intervalDays: data.intervalDays,
        isDue: isDue,
        dateStr: formatDateFR(data.nextTime)
    };
}

// Mise à jour visuelle des boutons et icônes sur chaque fiche machine
export function updateMireIconStatus() {
    document.querySelectorAll('.btn-mire-icon').forEach(btn => {
        const machine = btn.dataset.machine || btn.closest('[data-machine]')?.dataset.machine || "Radio Cabinet 1";
        const status = getMireStatus(machine);

        if (status.isDue) {
            btn.style.color = '#c0392b';
            btn.style.borderColor = '#c0392b';
            btn.style.background = '#fff5f5';
            btn.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="mire-icon-status">⚠️</span> <span style="font-weight: bold;">Alerte Mire (À faire)</span>
                    </div>
                    <div class="mire-icon-date" style="font-size: 11px; font-weight: 500; opacity: 0.9;">
                        Date : ${status.dateStr}
                    </div>
                </div>
            `;
            btn.title = `Contrôle Mire à faire pour ${machine} (Échéance : ${status.dateStr})`;
        } else {
            btn.style.color = '#555';
            btn.style.borderColor = '#ddd';
            btn.style.background = '#fdfdfd';
            btn.innerHTML = `
                <div style="display: flex; flex-direction: column; align-items: center; gap: 2px; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="mire-icon-status">🔔</span> <span>Alerte Mire (Ok)</span>
                    </div>
                    <div class="mire-icon-date" style="font-size: 11px; font-weight: 500; color: #16a34a;">
                        Prochaine : ${status.dateStr}
                    </div>
                </div>
            `;
            btn.title = `Contrôle Mire à jour pour ${machine} (Prochaine échéance : ${status.dateStr})`;
        }
    });

    // Mise à jour visuelle sur le plan du cabinet
    MIRE_RADIOS.forEach(item => {
        const piece = document.querySelector(`#plan-container .piece[data-nom="${item.cabinet}"]`);
        if (piece) {
            const status = getMireStatus(item.machine);
            if (status.isDue) {
                piece.classList.add('mire-alert-active');
            } else {
                piece.classList.remove('mire-alert-active');
            }
        }
    });
}

// Mise à jour de la boîte de dialogue Mire pour une machine donnée
function refreshMireDialogUI() {
    const cfg = getMireConfig(currentMireMachine);
    const status = getMireStatus(currentMireMachine);

    const headline = document.getElementById('mire-dialog-headline');
    if (headline) {
        headline.textContent = status.isDue ? "⚠️ RAPPEL CONTRÔLE MIRE" : "🔔 STATUT CONTRÔLE MIRE";
        headline.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    const cabinetDisplay = document.getElementById('mire-cabinet-display');
    if (cabinetDisplay) {
        cabinetDisplay.textContent = cfg.label;
        cabinetDisplay.style.color = status.isDue ? "#c0392b" : "#2c3e50";
    }

    const statusBadge = document.getElementById('mire-dialog-status-badge');
    if (statusBadge) {
        statusBadge.textContent = status.isDue ? "⚠️ À faire (Échue)" : "✅ À jour (Ok)";
        statusBadge.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    const alertDate = document.getElementById('mire-dialog-alert-date');
    if (alertDate) {
        alertDate.textContent = status.dateStr;
        alertDate.style.color = status.isDue ? "#c0392b" : "#16a34a";
    }

    // Sélecteur de cabinet (mise à jour des libellés avec ⚠️/🔔)
    const cabSelect = document.getElementById('mire-cabinet-select');
    if (cabSelect) {
        cabSelect.innerHTML = "";
        MIRE_RADIOS.forEach(r => {
            const rStatus = getMireStatus(r.machine);
            const opt = document.createElement('option');
            opt.value = r.machine;
            opt.textContent = `${rStatus.isDue ? '⚠️' : '🔔'} ${r.label} (${r.machine}) - ${rStatus.dateStr}`;
            if (r.machine === currentMireMachine) opt.selected = true;
            cabSelect.appendChild(opt);
        });
    }

    // Choix du rappel et date pré-calculée
    const rappelSelect = document.getElementById('mire-rappel-select');
    const customDateInput = document.getElementById('mire-custom-date');
    if (rappelSelect && customDateInput) {
        const days = parseInt(rappelSelect.value, 10) || cfg.defaultDays || 30;
        const targetTime = Date.now() + days * 24 * 60 * 60 * 1000;
        customDateInput.value = formatDateInput(targetTime);
    }
}

// Ouvrir la boîte de dialogue pour un cabinet / machine
export function openMireDialog(targetMachine = null) {
    if (targetMachine) {
        currentMireMachine = targetMachine;
    } else {
        // Sélectionner le premier cabinet en alerte ou le Cabinet 1 par défaut
        const firstOverdue = MIRE_RADIOS.find(r => getMireStatus(r.machine).isDue);
        currentMireMachine = firstOverdue ? firstOverdue.machine : "Radio Cabinet 1";
    }

    refreshMireDialogUI();

    const overlay = document.getElementById('mire-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
    }
    setMireSnoozed(false);
}

// Vérification globale et affichage des alertes sur l'accueil principal
export function checkMireAlert(force = false, targetMachine = null) {
    if (targetMachine) {
        openMireDialog(targetMachine);
        return;
    }

    const overdueList = [];
    MIRE_RADIOS.forEach(r => {
        const status = getMireStatus(r.machine);
        if (status.isDue) {
            overdueList.push({ ...r, ...status });
        }
    });

    // 1. Mise à jour de l'accueil principal (Alertes avec nom de cabinet)
    const alertsContainer = document.getElementById('mire-alerts-container');
    const legacyBtn = document.getElementById('btn-alertes-mire');

    if (alertsContainer) {
        alertsContainer.innerHTML = "";
        if (overdueList.length > 0) {
            alertsContainer.classList.remove('hidden');
            overdueList.forEach(item => {
                const btn = document.createElement('button');
                btn.className = 'btn btn-red btn-mire-main-alert';
                btn.dataset.machine = item.machine;
                btn.style.cssText = "font-size: 0.9em; padding: 6px 12px; width: max-content; flex: 0 0 auto; white-space: nowrap; margin-bottom: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.15);";
                btn.textContent = `⚠️ Mire : ${item.label}`;
                btn.title = `Rappel Mire - ${item.label} (Échéance : ${item.dateStr})`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openMireDialog(item.machine);
                });
                alertsContainer.appendChild(btn);
            });
            if (legacyBtn) legacyBtn.classList.add('hidden');
        } else {
            alertsContainer.classList.add('hidden');
            if (legacyBtn) legacyBtn.classList.add('hidden');
        }
    } else if (legacyBtn) {
        // Fallback si le conteneur n'est pas encore présent
        if (overdueList.length === 1) {
            legacyBtn.textContent = `⚠️ Mire : ${overdueList[0].label}`;
            legacyBtn.title = `Rappel Mire - ${overdueList[0].label} (Échéance : ${overdueList[0].dateStr})`;
            legacyBtn.classList.remove('hidden');
        } else if (overdueList.length > 1) {
            legacyBtn.textContent = `⚠️ Alertes Mire (${overdueList.map(o => o.label).join(', ')})`;
            legacyBtn.title = `${overdueList.length} alertes Mire en attente`;
            legacyBtn.classList.remove('hidden');
        } else {
            legacyBtn.classList.add('hidden');
        }
    }

    // 2. Mise à jour des fiches machines
    updateMireIconStatus();

    // 3. Popup automatique pour une échéance qui n'a pas déjà été écartée
    const enRetard = new Set(overdueList.map(o => o.machine));
    for (const m of [...mireEcartees]) if (!enRetard.has(m)) mireEcartees.delete(m);
    const nouvelles = overdueList.filter(o => !mireEcartees.has(o.machine));
    if (nouvelles.length > 0) {
        openMireDialog(nouvelles[0].machine);
    }
}

// Navigation vers le cabinet correspondant dans l'interface Maintenance
export function navigateToCabinet(cabinetName) {
    const overlay = document.getElementById('mire-overlay');
    if (overlay) overlay.classList.add('hidden');
    // On va voir la radio : la popup ne doit pas revenir par-dessus
    setMireSnoozed(true);

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
        updateMireIconStatus();

        // Clic sur les boutons Mire des fiches machines
        document.querySelectorAll('.btn-mire-icon').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const machine = btn.dataset.machine || btn.closest('[data-machine]')?.dataset.machine;
                openMireDialog(machine);
            });
        });

        // Changement de cabinet dans la boîte de dialogue
        const cabSelect = document.getElementById('mire-cabinet-select');
        if (cabSelect) {
            cabSelect.addEventListener('change', () => {
                currentMireMachine = cabSelect.value;
                refreshMireDialogUI();
            });
        }

        // Changement de délai prédéfini -> met à jour la date personnalisée
        const select = document.getElementById('mire-rappel-select');
        if (select) {
            select.addEventListener('change', () => {
                const days = parseInt(select.value, 10) || 30;
                const targetTime = Date.now() + days * 24 * 60 * 60 * 1000;
                const customDateInput = document.getElementById('mire-custom-date');
                if (customDateInput) {
                    customDateInput.value = formatDateInput(targetTime);
                }
            });
        }

        // Validation pour le cabinet en cours
        const btnMireValidate = document.getElementById('mire-validate-btn');
        if (btnMireValidate) {
            btnMireValidate.addEventListener('click', () => {
                const customDateInput = document.getElementById('mire-custom-date');
                const customTime = parseDateInput(customDateInput ? customDateInput.value : "");
                if (dateRappelPassee(customTime)) {
                    alert("La date du prochain contrôle est déjà passée : choisissez une date à venir.");
                    return;
                }

                let nextTime;
                let days = 30;
                if (customTime) {
                    nextTime = customTime;
                    days = Math.max(1, Math.round((nextTime - Date.now()) / (24 * 60 * 60 * 1000)));
                } else {
                    const sel = document.getElementById('mire-rappel-select');
                    days = parseInt(sel?.value, 10) || 30;
                    nextTime = Date.now() + days * 24 * 60 * 60 * 1000;
                }

                saveMireDataForMachine(currentMireMachine, nextTime, days);

                const overlay = document.getElementById('mire-overlay');
                if (overlay) overlay.classList.add('hidden');

                setMireSnoozed(false);
                updateMireIconStatus();
                checkMireAlert();
            });
        }

        // Validation globale : reporter tous les cabinets en alerte
        const btnMireValidateAll = document.getElementById('mire-validate-all-btn');
        if (btnMireValidateAll) {
            btnMireValidateAll.addEventListener('click', () => {
                const sel = document.getElementById('mire-rappel-select');
                const days = parseInt(sel?.value, 10) || 30;
                const nextTime = Date.now() + days * 24 * 60 * 60 * 1000;

                MIRE_RADIOS.forEach(r => {
                    const st = getMireStatus(r.machine);
                    if (st.isDue) {
                        saveMireDataForMachine(r.machine, nextTime, days);
                    }
                });

                const overlay = document.getElementById('mire-overlay');
                if (overlay) overlay.classList.add('hidden');

                setMireSnoozed(false);
                updateMireIconStatus();
                checkMireAlert();
            });
        }

        // Bouton pour ouvrir le cabinet directement depuis la modale
        const btnGotoCab = document.getElementById('mire-goto-cabinet-btn');
        if (btnGotoCab) {
            btnGotoCab.addEventListener('click', () => {
                const cfg = getMireConfig(currentMireMachine);
                navigateToCabinet(cfg.cabinet);
            });
        }

        // Bouton de secours / clic direct accueil
        const mainMireBtn = document.getElementById('btn-alertes-mire');
        if (mainMireBtn) {
            mainMireBtn.addEventListener('click', () => {
                openMireDialog();
            });
        }

        // Fermer la popup sans valider = mise en veille jusqu'au prochain démarrage
        document.querySelectorAll('#mire-overlay [data-close="mire-overlay"]').forEach(btn => {
            btn.addEventListener('click', () => setMireSnoozed(true));
        });

        // Surveillance périodique toutes les minutes
        checkMireAlert();
        setInterval(() => { checkMireAlert(); }, 60000);
    }));
}

// Exportations globales
if (typeof window !== "undefined") {
    window.checkMireAlert = checkMireAlert;
    window.openMireDialog = openMireDialog;
    window.navigateToCabinet = navigateToCabinet;
    window.updateMireIconStatus = updateMireIconStatus;
}
