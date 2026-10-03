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
