"use strict";

/* ============================================================
   Main Initialization - Point d'entrée principal de l'application
   ============================================================ */

import { USERS } from './core/constants.js';
import { initDB, loadDB } from './core/database.js';
import { demarrer } from './core/api.js';
import { openPlacard, filterPlacardTable, placardSort, refreshPlacardTable } from './features/placard.js';
import { openEditDialog, saveEditDialog } from './features/product-edit.js';
import { openTransferDialog, saveTransferDialog } from './features/transfer.js';
import { showAlertsDialog } from './ui/alerts-dialog.js';
import { alertsStock, alertsPeremption, checkAlerts } from './features/alerts.js';
import { setupMachine } from './machines/machines.js';
import { addMaintenanceEntry } from './machines/machines.js';
import { onPdfSelected, validateImport } from './features/invoice-import.js';
import { updateClock } from './planning/clock.js';
import { updateTeamPlanning, initTeamPlanning } from './planning/team-planning.js';
import { initTasksPlanning, updateTasksPreview } from './planning/tasks-planning.js';
import { checkMireAlert } from './machines/mire-alert.js';
import { checkDosiAlert } from './machines/dosi-alert.js';
import { checkFauteuilAlert, updateFauteuilIconStatus } from './machines/fauteuil-alert.js';
import { initDosimetres, updateDosimetresBadge } from './features/dosimetres.js';
import { refreshMaintenanceTable } from './machines/machines.js';
import { initCustomizationMode } from './ui/customization.js';
import { initZoomIndicator } from './ui/zoom-indicator.js';
import { initScreensaver } from './ui/screensaver.js';
import { initPostitHover, updatePostitListHeight } from './features/alerts.js';
import { getStock } from './features/stock.js';
import { showMessage } from './core/utils.js';
import './features/barcode-scanner.js';

// Expose functions needed by other modules (clock.js, settings.js, animation.js)
window.updateTeamPlanning = updateTeamPlanning;
window.loadDB = loadDB;
window.getStock = getStock;
window.USERS = USERS;
window.showMessage = showMessage;

/* ============================================================
   Rafraîchissement quand un autre poste a modifié les données
   ============================================================ */

function estOuvert(id) {
    const el = document.getElementById(id);
    return Boolean(el && !el.classList.contains("hidden"));
}

function rafraichirApresModificationDistante() {
    checkAlerts();
    // On ne redessine pas un tableau pendant qu'une saisie est en cours dessus
    const saisieEnCours = ["edit-overlay", "lot-move-overlay", "transfer-overlay", "import-overlay"].some(estOuvert);
    if (estOuvert("placard-overlay") && !saisieEnCours) refreshPlacardTable();
    if (!estOuvert("calendar-overlay")) updateTeamPlanning();
    if (!estOuvert("tasks-overlay")) updateTasksPreview();
    if (estOuvert("maintenance-overlay")) {
        refreshMaintenanceTable(document.getElementById("maint-machine").value);
    }
    updateDosimetresBadge();
    if (typeof window.updateMireIconStatus === "function") window.updateMireIconStatus();
    if (typeof window.checkMireAlert === "function") window.checkMireAlert();
    if (typeof window.updateFauteuilIconStatus === "function") window.updateFauteuilIconStatus();
    if (typeof window.checkFauteuilAlert === "function") window.checkFauteuilAlert();
    if (typeof window.checkDosiAlert === "function") window.checkDosiAlert();
}

window.addEventListener("donnees-modifiees", rafraichirApresModificationDistante);

/* ============================================================
   Initialisation
   ============================================================ */

document.addEventListener("DOMContentLoaded", async () => {
    initDB();
    try {
        await demarrer();
    } catch (e) {
        console.error("Chargement des données impossible :", e);
        await showMessage("Serveur injoignable",
            `Les données n'ont pas pu être chargées.

${e.message}

Rechargez la page (F5) une fois le serveur relancé.`);
        return;
    }

    // --- Grille de sélection d'espace ---
    const grid = document.getElementById("user-grid");

    const btnTous = document.createElement("button");
    btnTous.className = "user-btn btn-green";
    btnTous.textContent = "🔍 Tous les espaces";
    btnTous.addEventListener("click", () => {
        document.getElementById("user-overlay").classList.add("hidden");
        openPlacard("TOUS");
    });
    grid.appendChild(btnTous);

    for (const user of USERS) {
        const btn = document.createElement("button");
        btn.className = "user-btn";
        btn.textContent = user;
        btn.addEventListener("click", () => {
            document.getElementById("user-overlay").classList.add("hidden");
            openPlacard(user);
        });
        grid.appendChild(btn);
    }

    // --- Placard ---
    document.getElementById("btn-placard").addEventListener("click", () => {
        document.getElementById("user-overlay").classList.remove("hidden");
    });

    // --- Placard Maintenance & Cabinet ---
    document.getElementById("btn-maintenance-cabinet").addEventListener("click", () => {
        document.getElementById("maintenance-cabinet-overlay").classList.remove("hidden");
        const machinesContainer = document.getElementById("machines-container");
        if (machinesContainer) machinesContainer.classList.add("hidden");
        const planContainer = document.getElementById("plan-container");
        if (planContainer) planContainer.classList.remove("hidden");
        document.querySelectorAll('#maintenance-cabinet-overlay .piece').forEach(p => p.classList.remove('actif'));
        if (typeof window.updateFauteuilIconStatus === 'function') {
            window.updateFauteuilIconStatus();
        }
        if (typeof window.updateMireIconStatus === 'function') {
            window.updateMireIconStatus();
        }
    });

    // Interaction with the cabinet plan pieces
    document.querySelectorAll('#maintenance-cabinet-overlay .piece').forEach(piece => {
        piece.addEventListener('click', () => {
            document.querySelectorAll('#maintenance-cabinet-overlay .piece').forEach(p => p.classList.remove('actif'));
            piece.classList.add('actif');
            const nom = piece.getAttribute('data-nom');
            const machinesContainer = document.getElementById('machines-container');
            const planContainer = document.getElementById('plan-container');
            if (machinesContainer && planContainer) {
                const allMachines = machinesContainer.querySelectorAll('.machine');
                const fauteuilsMap = {
                    'Cabinet 5': 'Fauteuil OVIS',
                    'Cabinet 1': 'Fauteuil Sinius',
                    'Salle de chirurgie': 'Fauteuil Planmeca',
                    'Cabinet 2': 'Fauteuil Planmeca compact',
                    'Cabinet 4': 'Fauteuil Anthos'
                };
                const radiosMap = {
                    'Cabinet 5': 'Radio Cabinet 5',
                    'Cabinet 1': 'Radio Cabinet 1',
                    'Cabinet 2': 'Radio Cabinet 2',
                    'Cabinet 4': 'Radio Cabinet 4'
                };
                
                if (nom === 'Zone stérilisation (Sté)') {
                    // Show all machines EXCEPT panoramic radio, coffee machine, fauteuils, camera, and trousse
                    allMachines.forEach(m => {
                        if (m.classList.contains('machine-radio') || m.classList.contains('machine-cafe') || m.classList.contains('machine-fauteuil') || m.classList.contains('machine-camera') || m.classList.contains('machine-trousse')) {
                            m.style.display = 'none';
                        } else {
                            m.style.display = '';
                        }
                    });
                    machinesContainer.classList.remove('hidden');
                    planContainer.classList.add('hidden');
                } else if (nom === 'Zone panoramique (Pano)') {
                    // Show ONLY panoramic radio
                    allMachines.forEach(m => {
                        if (m.dataset.machine === 'Radio Panoramique') {
                            m.style.display = '';
                        } else {
                            m.style.display = 'none';
                        }
                    });
                    machinesContainer.classList.remove('hidden');
                    planContainer.classList.add('hidden');
                    // ADDED: Mire alert logic
                    if (typeof checkMireAlert === 'function') {
                        checkMireAlert();
                        if (typeof checkDosiAlert === 'function') { checkDosiAlert(); }
                    }
                } else if (nom === 'Salle de repos') {
                    // Show ONLY coffee machine AND trousse
                    allMachines.forEach(m => {
                        if (m.classList.contains('machine-cafe') || m.classList.contains('machine-trousse')) {
                            m.style.display = '';
                        } else {
                            m.style.display = 'none';
                        }
                    });
                    machinesContainer.classList.remove('hidden');
                    planContainer.classList.add('hidden');
                } else if (fauteuilsMap[nom]) {
                    const hasCamera = (nom === 'Cabinet 1' || nom === 'Cabinet 4' || nom === 'Cabinet 5');
                    const radioName = radiosMap[nom];
                    // Show specific fauteuil, specific radio (if applicable), AND the camera if applicable
                    allMachines.forEach(m => {
                        if (m.classList.contains('machine-fauteuil')) {
                            m.style.display = (m.dataset.machine === fauteuilsMap[nom]) ? '' : 'none';
                        } else if (radioName && m.dataset.machine === radioName) {
                            m.style.display = '';
                        } else if (m.classList.contains('machine-camera') && hasCamera) {
                            m.style.display = '';
                        } else {
                            m.style.display = 'none'; 
                        }
                    });
                    machinesContainer.classList.remove('hidden');
                    planContainer.classList.add('hidden');
                    if (typeof window.updateMireIconStatus === 'function') {
                        window.updateMireIconStatus();
                    }
                    if (typeof window.updateFauteuilIconStatus === 'function') {
                        window.updateFauteuilIconStatus();
                    }
                } else {
                    // Do nothing for other rooms right now
                }
            }
        });
    });

    // Retour au plan
    const btnRetourPlan = document.getElementById("btn-retour-plan");
    if (btnRetourPlan) {
        btnRetourPlan.addEventListener("click", () => {
            const machinesContainer = document.getElementById("machines-container");
            if (machinesContainer) machinesContainer.classList.add("hidden");
            const planContainer = document.getElementById("plan-container");
            if (planContainer) planContainer.classList.remove("hidden");
            document.querySelectorAll('#maintenance-cabinet-overlay .piece').forEach(p => p.classList.remove('actif'));
            if (typeof window.updateFauteuilIconStatus === 'function') {
                window.updateFauteuilIconStatus();
            }
            if (typeof window.updateMireIconStatus === 'function') {
                window.updateMireIconStatus();
            }
        });
    }

    const mainSearchInput = document.getElementById("main-global-search");
    let searchTimeout;

    function triggerSearch() {
        const val = mainSearchInput.value.trim();
        if (val) {
            openPlacard("TOUS");
            document.getElementById("filter-scannette").value = val;
            filterPlacardTable();
            mainSearchInput.value = "";
        }
    }

    mainSearchInput.addEventListener("keyup", (e) => {
        if (e.key === "Enter") {
            clearTimeout(searchTimeout);
            triggerSearch();
        }
    });

    mainSearchInput.addEventListener("input", () => {
        clearTimeout(searchTimeout);
        // Automatically trigger search 300ms after the last input (useful for scanners)
        searchTimeout = setTimeout(() => {
            triggerSearch();
        }, 300);
    });

    document.getElementById("btn-add-product-main").addEventListener("click", () => {
        window.isTrousseSecours = false;
        window.isMEOPA = false;
        openEditDialog();
    });
    document.getElementById("btn-add-product").addEventListener("click", () => openEditDialog());
    document.getElementById("edit-save").addEventListener("click", saveEditDialog);

    document.getElementById("btn-transfer-space").addEventListener("click", openTransferDialog);
    document.getElementById("transfer-save").addEventListener("click", saveTransferDialog);

    for (const id of ["filter-fichier", "filter-ref", "filter-scannette", "filter-nom", "filter-groupe", "filter-qte"]) {
        document.getElementById(id).addEventListener("input", filterPlacardTable);
    }

    document.querySelectorAll("#placard-table th.sortable").forEach(th => {
        th.addEventListener("click", () => {
            const col = parseInt(th.dataset.col, 10);
            if (placardSort.col === col) {
                placardSort.asc = !placardSort.asc;
            } else {
                placardSort.col = col;
                placardSort.asc = true;
            }
            refreshPlacardTable();
        });
    });

    // --- Alertes ---
    document.getElementById("btn-alertes-stock").addEventListener("click",
        () => showAlertsDialog("Alertes de Stock", alertsStock));
    document.getElementById("btn-alertes-peremp").addEventListener("click",
        () => showAlertsDialog("Alertes de Péremption", alertsPeremption));

    // --- Autoclave ---
    document.querySelectorAll(".autoclave.machine").forEach(setupMachine);

    // --- Trousse de secours ---
    const btnTrousse = document.querySelector(".machine-trousse");
    if (btnTrousse) {
        btnTrousse.addEventListener("click", () => {
            const overlay = document.getElementById("maintenance-cabinet-overlay");
            if (overlay) overlay.classList.add("hidden");
            openPlacard("TOUS");
            window.isTrousseSecours = true;
            window.isMEOPA = false;
            const groupeFilter = document.getElementById("filter-groupe");
            if (groupeFilter) {
                groupeFilter.value = "trousse de secours";
                if (typeof filterPlacardTable === "function") filterPlacardTable();
            }
        });
    }

    // --- MEOPA ---
    const btnMeopa = document.querySelector(".machine-meopa");
    if (btnMeopa) {
        btnMeopa.addEventListener("click", () => {
            const overlay = document.getElementById("maintenance-cabinet-overlay");
            if (overlay) overlay.classList.add("hidden");
            openPlacard("TOUS");
            window.isTrousseSecours = false;
            window.isMEOPA = true;
            const groupeFilter = document.getElementById("filter-groupe");
            if (groupeFilter) {
                groupeFilter.value = "MEOPA";
                if (typeof filterPlacardTable === "function") filterPlacardTable();
            }
        });
    }

    document.getElementById("maint-add").addEventListener("click", addMaintenanceEntry);

    // --- Import facture ---
    const fileInput = document.getElementById("pdf-file");
    document.getElementById("btn-import").addEventListener("click", () => {
        fileInput.value = "";
        fileInput.click();
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) onPdfSelected(fileInput.files);
    });
    document.getElementById("import-validate").addEventListener("click", validateImport);

    // --- Boutons de fermeture des dialogs ---
    document.querySelectorAll("[data-close]").forEach(btn => {
        btn.addEventListener("click", () => {
            const dialogId = btn.dataset.close;
            document.getElementById(dialogId).classList.add("hidden");
            if (dialogId === "placard-overlay") {
                window.isTrousseSecours = false;
                window.isMEOPA = false;
            }
        });
    });

    // --- Horloge ---
    updateClock();
    setInterval(updateClock, 1000);

    // --- Initialisation des modules UI ---
    initCustomizationMode();
    initZoomIndicator();
    initScreensaver();
    initPostitHover();
    updatePostitListHeight();

    // --- Alertes au démarrage ---
    checkAlerts();
    checkFauteuilAlert();

    // --- Planning binômes ---
    initTeamPlanning();

    // --- Taches assistantes ---
    initTasksPlanning();

    // --- Gestion des dosimètres ---
    initDosimetres();
});
