"use strict";

/* ============================================================
   Autoclave (AutoclaveWidget + AutoclaveMaintenanceDialog)
   ============================================================ */

import { loadDB } from '../core/database.js';
import { todayFR, showMessage } from '../core/utils.js';

const PHASE_CLASSES = ["autoclave-heat", "autoclave-steril-a", "autoclave-steril-b", "autoclave-dry", "autoclave-done",
    "radio-pos", "radio-scan", "radio-proc",
    "dac-clean", "dac-lube-a", "dac-lube-b", "dac-steril",
    "thermo-prewash", "thermo-wash-a", "thermo-wash-b", "thermo-rinse", "thermo-dry",
    "cafe-grind", "cafe-extract", "cafe-ready",
    "fauteuil-install", "fauteuil-soin", "fauteuil-rincage",
    "camera-init", "camera-scan", "camera-calc"];

const MACHINE_CYCLES = {
    autoclave: {
        steps: [
            { until: 8, labels: ["♨️ Chauffe", "♨️ Chauffe.", "♨️ Chauffe..", "♨️ Chauffe..."], phases: ["autoclave-heat"] },
            { until: 16, labels: ["💨 Stérilisation"], phases: ["autoclave-steril-a", "autoclave-steril-b"] },
            { until: 22, labels: ["❄️ Séchage", "❄️ Séchage.", "❄️ Séchage..", "❄️ Séchage..."], phases: ["autoclave-dry"] }
        ],
        done: "🟢 Terminé"
    },
    radio: {
        steps: [
            { until: 6, labels: ["🧍 Positionnement", "🧍 Positionnement.", "🧍 Positionnement..", "🧍 Positionnement..."], phases: ["radio-pos"] },
            { until: 16, labels: ["📸 Acquisition"], phases: ["radio-scan"] },
            { until: 22, labels: ["🖥️ Traitement", "🖥️ Traitement.", "🖥️ Traitement..", "🖥️ Traitement..."], phases: ["radio-proc"] }
        ],
        done: "🟢 Cliché prêt"
    },
    dac: {
        steps: [
            { until: 6, labels: ["🫧 Nettoyage", "🫧 Nettoyage.", "🫧 Nettoyage..", "🫧 Nettoyage..."], phases: ["dac-clean"] },
            { until: 14, labels: ["💧 Lubrification", "💧 Lubrification."], phases: ["dac-lube-a", "dac-lube-b"] },
            { until: 22, labels: ["🔥 Stérilisation", "🔥 Stérilisation.", "🔥 Stérilisation..", "🔥 Stérilisation..."], phases: ["dac-steril"] }
        ],
        done: "✅ Terminé"
    },
    cafe: {
        steps: [
            { until: 6, labels: ["☕ Broyage", "☕ Broyage.", "☕ Broyage..", "☕ Broyage..."], phases: ["cafe-grind"] },
            { until: 16, labels: ["☕ Extraction", "☕ Extraction.", "☕ Extraction.."], phases: ["cafe-extract"] },
            { until: 22, labels: ["♨️ Prêt", "♨️ Prêt.", "♨️ Prêt.."], phases: ["cafe-ready"] }
        ],
        done: "✅ Terminé"
    },
    thermo: {
        steps: [
            { until: 8, labels: ["🚿 Prélavage", "🚿 Prélavage.", "🚿 Prélavage..", "🚿 Prélavage..."], phases: ["thermo-prewash"] },
            { until: 16, labels: ["🧼 Lavage", "🧼 Lavage.", "🧼 Lavage.."], phases: ["thermo-wash-a", "thermo-wash-b"] },
            { until: 22, labels: ["♨️ Rinçage Thermique"], phases: ["thermo-rinse"] },
            { until: 28, labels: ["💨 Séchage", "💨 Séchage.", "💨 Séchage..", "💨 Séchage..."], phases: ["thermo-dry"] }
        ],
        done: "🟢 Terminé"
    },
    fauteuil: {
        steps: [
            { until: 6, labels: ["🧍 Installation", "🧍 Installation.", "🧍 Installation.."], phases: ["fauteuil-install"] },
            { until: 16, labels: ["🦷 Soin en cours", "🦷 Soin en cours.", "🦷 Soin en cours.."], phases: ["fauteuil-soin"] },
            { until: 22, labels: ["💧 Rinçage", "💧 Rinçage.", "💧 Rinçage.."], phases: ["fauteuil-rincage"] }
        ],
        done: "✅ Terminé"
    },
    camera: {
        steps: [
            { until: 6, labels: ["🔌 Initialisation", "🔌 Initialisation.", "🔌 Initialisation.."], phases: ["camera-init"] },
            { until: 16, labels: ["📸 Scan en cours", "📸 Scan en cours.", "📸 Scan en cours.."], phases: ["camera-scan"] },
            { until: 22, labels: ["🖥️ Calcul 3D", "🖥️ Calcul 3D.", "🖥️ Calcul 3D.."], phases: ["camera-calc"] }
        ],
        done: "✅ Modèle prêt"
    }
};

/* Chaque machine (.autoclave.machine) a son propre cycle indépendant. */
export function setupMachine(frame) {
    if (frame.classList.contains('machine-trousse') || frame.classList.contains('machine-meopa')) return;
    const status = frame.querySelector(".autoclave-status");
    const btn = frame.querySelector(".autoclave-start");
    const title = frame.querySelector(".autoclave-title");
    const machineName = frame.dataset.machine || "Autoclave";
    const cycle = MACHINE_CYCLES[frame.dataset.type] || MACHINE_CYCLES.autoclave;

    let timer = null;
    let step = 0;
    let running = false;

    function setPhase(phase) {
        frame.classList.remove(...PHASE_CLASSES);
        if (phase) frame.classList.add(phase);
    }

    function animate() {
        step++;

        const current = cycle.steps.find(s => step < s.until);
        if (current) {
            status.textContent = current.labels[step % current.labels.length];
            setPhase(current.phases[step % current.phases.length]);
        } else {
            clearInterval(timer);
            running = false;
            status.textContent = cycle.done;
            setPhase("autoclave-done");
            btn.disabled = false;
            btn.textContent = "Nouveau Cycle";
        }
    }

    btn.addEventListener("click", () => {
        if (frame.dataset.type === "radio" && typeof window.checkMireAlert === 'function') {
            window.checkMireAlert();
            if (machineName === "Radio Panoramique" && typeof window.checkDosiAlert === 'function') { window.checkDosiAlert(); }
        }
        if (running) return;
        running = true;
        step = 0;
        btn.disabled = true;
        btn.textContent = "En cours...";
        timer = setInterval(animate, 800);
    });

    title.addEventListener("click", () => openMaintenanceDialog(machineName));
}

export function openMaintenanceDialog(machineName) {
    if (machineName) {
        document.getElementById("maint-machine").value = machineName;
    }
    const selectedMachine = document.getElementById("maint-machine").value;
    refreshMaintenanceTable(selectedMachine);
    document.getElementById("maint-date").valueAsDate = new Date();
    document.getElementById("maintenance-overlay").classList.remove("hidden");
}

export function refreshMaintenanceTable(filterMachine = null) {
    const tbody = document.getElementById("maintenance-tbody");
    tbody.innerHTML = "";
    let numLog = 0;
    
    // Import getAutoclaveMaintenance dynamically to avoid circular dependency
    const db = loadDB();
    const logs = db.autoclave || [];
    
    for (const log of logs) {
        if (filterMachine && log.machine && log.machine !== filterMachine) continue;
        numLog++;
        const tr = document.createElement("tr");
        const tdNum = document.createElement("td");
        tdNum.className = "rownum";
        tdNum.textContent = numLog;
        tr.appendChild(tdNum);
        for (const c of [log.date, log.machine || "—", log.utilisateur, log.commentaire]) {
            const td = document.createElement("td");
            td.textContent = c;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
}

// Add event listener so that changing the select box updates the table immediately
document.addEventListener("DOMContentLoaded", () => {
    const maintMachineSelect = document.getElementById("maint-machine");
    if (maintMachineSelect) {
        maintMachineSelect.addEventListener("change", (e) => {
            refreshMaintenanceTable(e.target.value);
        });
    }
});

export async function addMaintenanceEntry() {
    const dateVal = document.getElementById("maint-date").value; // AAAA-MM-JJ
    const user = document.getElementById("maint-user").value.trim();
    const comment = document.getElementById("maint-comment").value.trim();

    if (!user) {
        await showMessage("Erreur", "Veuillez entrer le nom de la personne.");
        return;
    }
    if (!comment) {
        await showMessage("Erreur", "Veuillez entrer un commentaire de maintenance.");
        return;
    }

    let dateStr = todayFR();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateVal);
    if (m) dateStr = `${m[3]}/${m[2]}/${m[1]}`;

    const machine = document.getElementById("maint-machine").value;
    
    // Import addAutoclaveMaintenance dynamically
    const { addAutoclaveMaintenance } = await import('./maintenance-data.js');
    addAutoclaveMaintenance(dateStr, user, comment, machine);
    
    document.getElementById("maint-comment").value = "";
    refreshMaintenanceTable(machine);
}

// Export to window for global access
window.setupMachine = setupMachine;
window.openMaintenanceDialog = openMaintenanceDialog;
window.addMaintenanceEntry = addMaintenanceEntry;
