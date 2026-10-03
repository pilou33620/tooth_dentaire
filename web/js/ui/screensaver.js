"use strict";

/* ============================================================
   ECRAN DE VEILLE (SCREENSAVER)
   ============================================================ */

export function initScreensaver() {
    let inactivityTimer;
    let hideScreensaverTimeout;
    const INACTIVITY_LIMIT = 30 * 60 * 1000; // 30 minutes

    function resetInactivityTimer() {
        clearTimeout(inactivityTimer);
        const screensaver = document.getElementById('screensaver-overlay');
        if (screensaver && !screensaver.classList.contains('hidden')) {
            screensaver.style.opacity = '0';
            clearTimeout(hideScreensaverTimeout);
            hideScreensaverTimeout = setTimeout(() => screensaver.classList.add('hidden'), 1000);
        }
        inactivityTimer = setTimeout(showScreensaver, INACTIVITY_LIMIT);
    }

    function showScreensaver() {
        const screensaver = document.getElementById('screensaver-overlay');
        if (screensaver) {
            clearTimeout(hideScreensaverTimeout);
            screensaver.classList.remove('hidden');
            setTimeout(() => {
                screensaver.style.opacity = '1';
            }, 10);
        }
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt =>
        document.addEventListener(evt, resetInactivityTimer, true)
    );
    resetInactivityTimer();
}
