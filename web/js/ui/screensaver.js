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
        if (screensaver && !screensaver.classList.contains('hidden') && !hideScreensaverTimeout) {
            screensaver.style.opacity = '0';
            // Le voile, déjà invisible, ne doit plus bloquer les clics pendant le fondu.
            // Et le fondu n'est lancé qu'une fois : sinon, tant que la souris bouge, il
            // ne finit jamais et l'accueil semble figé.
            screensaver.style.pointerEvents = 'none';
            hideScreensaverTimeout = setTimeout(() => {
                screensaver.classList.add('hidden');
                hideScreensaverTimeout = null;
            }, 1000);
            window.noterJournal?.("sortie de veille");
        }
        inactivityTimer = setTimeout(showScreensaver, INACTIVITY_LIMIT);
    }

    function showScreensaver() {
        const screensaver = document.getElementById('screensaver-overlay');
        if (screensaver) {
            screensaver.style.pointerEvents = '';
            window.noterJournal?.("entrée en veille");
            // L'animation lit le planning à son chargement : la recharger pour la demi-journée en cours
            try {
                screensaver.querySelector('iframe')?.contentWindow?.location.reload();
            } catch (e) { /* page pas encore chargée : elle lira le planning d'elle-même */ }
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
