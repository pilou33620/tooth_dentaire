"use strict";

/* ============================================================
   ECRAN DE VEILLE (SCREENSAVER)
   ============================================================ */

export function initScreensaver() {
    let inactivityTimer;
    let hideScreensaverTimeout;
    const INACTIVITY_LIMIT = 30 * 60 * 1000; // 30 minutes

    // L'animation du cabinet n'est chargée que pendant la veille : chargée en
    // permanence, elle occupait le processeur alors que personne ne la voyait.
    function animation(active) {
        const iframe = document.querySelector('#screensaver-overlay iframe');
        if (!iframe) return;
        const source = iframe.dataset.src || "";
        if (active && source && iframe.getAttribute('src') !== source) iframe.setAttribute('src', source);
        if (!active && iframe.hasAttribute('src')) iframe.removeAttribute('src');
    }

    function resetInactivityTimer() {
        clearTimeout(inactivityTimer);
        const screensaver = document.getElementById('screensaver-overlay');
        if (screensaver && !screensaver.classList.contains('hidden')) {
            screensaver.style.opacity = '0';
            clearTimeout(hideScreensaverTimeout);
            hideScreensaverTimeout = setTimeout(() => {
                screensaver.classList.add('hidden');
                animation(false);
            }, 1000);
        }
        inactivityTimer = setTimeout(showScreensaver, INACTIVITY_LIMIT);
    }

    function showScreensaver() {
        const screensaver = document.getElementById('screensaver-overlay');
        if (screensaver) {
            clearTimeout(hideScreensaverTimeout);
            animation(true);
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
