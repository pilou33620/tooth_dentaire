"use strict";

/* ============================================================
   DOSIMETRES ALERT
   L'échéance est en base (document "rappel_dosimetres").
   ============================================================ */

import { getDocument, setDocument, pret } from '../core/api.js';

function prochaineEcheance() {
    const doc = getDocument("rappel_dosimetres") || {};
    const n = parseInt(doc.nextTime, 10);
    return Number.isFinite(n) ? n : null;
}

// Meme principe que pour la Mire : "Ignorer pour l'instant" suspend la
// surveillance periodique jusqu'au prochain demarrage.
let dosiSnoozed = false;
// L'ouverture automatique n'a lieu qu'une fois par echeance : la surveillance
// tourne toutes les 60 s et re-affichait la popup en boucle par-dessus le
// travail en cours si l'utilisateur l'avait fermee autrement qu'avec un bouton
// [data-close] (clic hors modale, Echap...).
let dosiPopupDejaOuverte = false;

function setDosiSnoozed(value) {
    dosiSnoozed = value;
}

export function checkDosiAlert(force = false) {
    const nextTime = prochaineEcheance();
    const isDue = (!nextTime || Date.now() >= nextTime);

    // Bouton d'alerte de l'ecran principal
    const mainBtn = document.getElementById('btn-alertes-dosi');
    if (mainBtn) {
        if (isDue) {
            mainBtn.classList.remove('hidden');
        } else {
            mainBtn.classList.add('hidden');
        }
    }

    // L'echeance est repoussee : la prochaine sera de nouveau annoncee.
    if (!isDue) {
        dosiPopupDejaOuverte = false;
        return;
    }

    // force=true (clic manuel) passe outre la mise en veille et le fait que la
    // popup ait deja ete presentee.
    if (force || (!dosiSnoozed && !dosiPopupDejaOuverte)) {
        const overlay = document.getElementById('dosi-overlay');
        if (overlay) overlay.classList.remove('hidden');
        dosiPopupDejaOuverte = true;
    }
}

document.addEventListener("DOMContentLoaded", () => pret.then(() => {

    //Etat visuel du bouton present sur la fiche machine
    function updateDosiIconStatus() {
        const nextTime = prochaineEcheance();
        const due = (!nextTime || Date.now() >= nextTime);

        document.querySelectorAll('.btn-dosi-icon').forEach(btn => {
            if (due) {
                btn.style.color = '#c0392b';
                btn.style.borderColor = '#c0392b';
                btn.innerHTML = '<span class="dosi-icon-status">⚠️</span> Alerte Dosimètres (À faire)';
            } else {
                btn.style.color = '#555';
                btn.style.borderColor = '#ddd';
                btn.innerHTML = '<span class="dosi-icon-status">🔔</span> Alerte Dosimètres (Ok)';
            }
        });
    }

    updateDosiIconStatus();

    document.querySelectorAll('.btn-dosi-icon').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof checkDosiAlert === 'function') checkDosiAlert(true);
        });
    });

    const btnDosiValidate = document.getElementById('dosi-validate-btn');
    if (btnDosiValidate) {
        btnDosiValidate.addEventListener('click', () => {
            const select = document.getElementById('dosi-rappel-select');
            const days = parseInt(select.value, 10) || 1;
            const nextTime = Date.now() + days * 24 * 60 * 60 * 1000;
            setDocument("rappel_dosimetres", { nextTime });
            const overlay = document.getElementById('dosi-overlay');
            if (overlay) overlay.classList.add('hidden');
            setDosiSnoozed(false);
            updateDosiIconStatus();
            const nextAlertBadge = document.getElementById('dosi-next-alert-badge');
            if (nextAlertBadge) {
                nextAlertBadge.textContent = `✅ OK (dans ${days} j)`;
                nextAlertBadge.style.background = "#dcfce7";
                nextAlertBadge.style.color = "#15803d";
            }
            checkDosiAlert(); // masque le bouton d'alerte de l'ecran principal
        });
    }

    // Bouton d'alerte sur l'ecran principal : ouvre la popup et retire la mise en veille
    const mainDosiBtn = document.getElementById('btn-alertes-dosi');
    if (mainDosiBtn) {
        mainDosiBtn.addEventListener('click', () => {
            setDosiSnoozed(false);
            const overlay = document.getElementById('dosi-overlay');
            if (overlay) overlay.classList.remove('hidden');
        });
    }

    // Fermer la popup sans valider = mise en veille jusqu'au prochain demarrage
    document.querySelectorAll('#dosi-overlay [data-close="dosi-overlay"]').forEach(btn => {
        btn.addEventListener('click', () => setDosiSnoozed(true));
    });

    // Surveillance periodique : la popup arrive sur l'ecran principal
    // des que le delai est ecoule, sans attendre d'ouvrir la zone sterilisation.
    checkDosiAlert();
    setInterval(() => { checkDosiAlert(); }, 60000);
}));

// Export to window for global access
window.checkDosiAlert = checkDosiAlert;
