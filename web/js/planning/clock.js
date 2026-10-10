"use strict";

/* ============================================================
   Horloge temps réel
   ============================================================ */

export function getWeekNumber(d) {
    const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return weekNo;
}

// Lundi de la semaine 1 (ISO) de 2026, semaine « impaire ».
const LUNDI_REFERENCE = Date.UTC(2025, 11, 29);
const SEMAINE_MS = 7 * 86400000;

/**
 * Parité de la semaine pour la rotation des binômes ("even" / "odd").
 * - "continue" (défaut) : l'alternance ne s'interrompt jamais. Avec le
 *   numéro ISO, une année de 53 semaines donne deux semaines impaires de
 *   suite (semaine 53 puis semaine 1) : le 04/01/2027 serait « impaire »
 *   comme la semaine précédente. Identique au numéro ISO en 2026.
 * - "iso" : parité du numéro de semaine officiel.
 */
export function pariteSemaine(date, alternance = "continue") {
    if (alternance === "iso") return getWeekNumber(date) % 2 === 0 ? "even" : "odd";
    const jour = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const lundi = jour - ((new Date(jour).getUTCDay() + 6) % 7) * 86400000;
    const semaines = Math.round((lundi - LUNDI_REFERENCE) / SEMAINE_MS);
    return ((semaines % 2) + 2) % 2 === 0 ? "odd" : "even";
}

export function updateClock() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    document.getElementById("clock").textContent =
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const dateDisplay = document.getElementById("date-display");
    if (dateDisplay) {
        const weekNo = getWeekNumber(now);
        dateDisplay.textContent = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} , Semaine ${weekNo}`;
        // Mise à jour du module binômes si la semaine a changé ou au premier appel
        const currentDayOfWeek = now.getDay();
        if (!window.lastWeekNo || window.lastWeekNo !== weekNo || window.lastDay !== currentDayOfWeek) {
            window.lastWeekNo = weekNo;
            window.lastDay = currentDayOfWeek;
            if (typeof window.updateTeamPlanning === "function") {
                window.updateTeamPlanning(weekNo);
            }
        }
    }
}
