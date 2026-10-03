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

    // Fonction pour détecter le zoom du navigateur
    function getZoomLevel() {
        // Créer un élément de référence pour calculer le zoom
        const testEl = document.createElement('div');
        testEl.style.cssText = 'width: 100vw; height: 1px; position: absolute; top: -9999px; left: -9999px; visibility: hidden;';
        document.body.appendChild(testEl);

        // Calculer le nombre de pixels CSS par pixel physique
        const cssWidth = testEl.getBoundingClientRect().width;
        document.body.removeChild(testEl);

        if (cssWidth > 0) {
            // window.innerWidth est en pixels physiques, cssWidth est en pixels CSS
            // Le zoom = pixels physiques / pixels CSS * 100
            return Math.round(window.innerWidth / cssWidth * 100);
        }
        return 100;
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
    document.addEventListener('wheel', showZoomIndicator, { passive: true });

    // Afficher le zoom initial
    showZoomIndicator();

    console.log("Zoom indicator initialized");
}
