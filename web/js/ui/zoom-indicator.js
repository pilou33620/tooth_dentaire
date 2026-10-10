"use strict";

/* ============================================================
   Zoom Indicator - Indicateur de niveau de zoom
   ============================================================ */

// Indicateur de niveau de zoom
export function initZoomIndicator() {
    // Créer l'élément indicateur
    const zoomIndicator = document.createElement('div');
    zoomIndicator.id = 'zoom-indicator';
    zoomIndicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.75);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 14px;
        font-family: 'Segoe UI', sans-serif;
        z-index: 10000;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
    `;
    zoomIndicator.textContent = 'Zoom: 100%';
    document.body.appendChild(zoomIndicator);

    // Niveaux de zoom proposés par les navigateurs
    const NIVEAUX = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

    /**
     * Zoom du navigateur. outerWidth est en pixels de l'écran, innerWidth en
     * pixels CSS : leur rapport suit le zoom. (L'ancienne mesure comparait
     * deux largeurs en pixels CSS : toujours 100 %.) Les bordures de fenêtre
     * faussent un peu le rapport, d'où l'arrondi au niveau le plus proche.
     */
    function getZoomLevel() {
        const brut = (window.outerWidth > 0 && window.innerWidth > 0)
            ? window.outerWidth / window.innerWidth * 100
            : ((window.visualViewport && window.visualViewport.scale) || 1) * 100;
        const proche = NIVEAUX.reduce((a, b) => Math.abs(b - brut) < Math.abs(a - brut) ? b : a);
        return Math.abs(proche - brut) <= 4 ? proche : Math.round(brut);
    }

    // Variables pour le timeout
    let hideTimeout = null;
    let lastZoom = 0;

    // Fonction pour afficher l'indicateur
    function showZoomIndicator() {
        const currentZoom = getZoomLevel();

        if (currentZoom !== lastZoom || lastZoom === 0) {
            lastZoom = currentZoom;
            zoomIndicator.textContent = `Zoom: ${currentZoom}%`;
            zoomIndicator.style.opacity = '1';

            // Effacer le timeout précédent
            if (hideTimeout) {
                clearTimeout(hideTimeout);
            }

            // Masquer après 1.5 secondes d'inactivité
            hideTimeout = setTimeout(() => {
                zoomIndicator.style.opacity = '0';
            }, 1500);
        }
    }

    // Écouter les événements de redimensionnement
    window.addEventListener('resize', showZoomIndicator);

    // Écouter les événements de souris pour détecter les changements de zoom via Ctrl+molette
    // (Ctrl + molette : le redimensionnement suit juste après)
    document.addEventListener('wheel', e => {
        if (e.ctrlKey) setTimeout(showZoomIndicator, 100);
    }, { passive: true });

    // Afficher le zoom initial
    showZoomIndicator();

}
