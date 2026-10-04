"use strict";

/* ============================================================
   MODE PERSONNALISATION (Drag & Drop Universel)
   Les positions sont propres à chaque poste (localStorage du navigateur) :
   les écrans du cabinet n'ont pas tous la même taille. Un poste qui n'a
   encore rien enregistré reprend la disposition importée de l'ancienne
   application (document "positions_interface").
   ============================================================ */

import { getDocument } from '../core/api.js';

let isCustomizationModeActive = false;
const DRAGGABLE_ELEMENT_SELECTORS = [
    "#datetime-container",
    "#team-planning-container",
    "#tasks-planning-container",
    "#postit-wrapper",
    "#checklist-widget",
    "#notes-widget",
    "#btn-annuaire-container",
    "#btn-dosimetre-container",
    ".action-area",
    "#btn-placard",
    "#btn-maintenance-cabinet"
];
const RESIZABLE_BG_SELECTORS = [
    ".backsplash"
];

export function initCustomizationMode() {
    if (localStorage.getItem("ui-positions") === null) {
        const importees = getDocument("positions_interface");
        if (importees && typeof importees === "object" && Object.keys(importees).length > 0) {
            localStorage.setItem("ui-positions", JSON.stringify(importees));
        }
    }

    // Also try to migrate old post-it pos if present
    const oldPostItPos = localStorage.getItem("postit-pos");
    if (oldPostItPos) {
        try {
            let positions = JSON.parse(localStorage.getItem("ui-positions") || "{}");
            if (!positions["postit-wrapper"]) {
                positions["postit-wrapper"] = JSON.parse(oldPostItPos);
                localStorage.setItem("ui-positions", JSON.stringify(positions));
            }
        } catch (e) { }
        localStorage.removeItem("postit-pos");
    }

    // La zone du bas n'est plus redimensionnable : on oublie sa hauteur enregistree,
    // c'est elle qui pouvait rendre la page plus haute que la fenetre.
    try {
        const stored = JSON.parse(localStorage.getItem("ui-positions") || "{}");
        if (stored.countertop) {
            delete stored.countertop;
            localStorage.setItem("ui-positions", JSON.stringify(stored));
        }
    } catch (e) { }
    document.querySelectorAll(".countertop").forEach(el => {
        el.style.minHeight = "";
        el.style.flex = "";
    });

    loadElementPositions();

    const banner = document.getElementById("customization-banner");
    const btnExit = document.getElementById("btn-exit-customization");
    const btnReset = document.getElementById("btn-reset-customization");

    if (btnExit) btnExit.addEventListener("click", () => toggleCustomizationMode(false));
    if (btnReset) btnReset.addEventListener("click", resetElementPositions);

    let isDragging = false;
    let isResizing = false;
    let currentDragEl = null;
    let currentResizeEl = null;
    let startX, startY, initialLeft, initialTop, initialScaleX, initialScaleY, initialWidth, initialHeight;
    let initialSlack = 0;

    document.addEventListener("mousedown", (e) => {
        if (!isCustomizationModeActive) return;

        if (e.target.classList.contains('bg-resize-handle')) {
            isResizing = true;
            currentResizeEl = e.target.parentElement;
            currentResizeEl.dataset.isBg = "true";
            startX = e.clientX;
            startY = e.clientY;

            initialHeight = currentResizeEl.offsetHeight;
            // Place encore disponible avant que la page ne devienne scrollable
            initialSlack = window.innerHeight - document.documentElement.scrollHeight;
            e.preventDefault();
            return;
        }

        if (e.target.classList.contains('resize-handle')) {
            isResizing = true;
            currentResizeEl = e.target.parentElement;
            startX = e.clientX;
            startY = e.clientY;

            initialScaleX = parseFloat(currentResizeEl.getAttribute('data-scale-x')) || parseFloat(currentResizeEl.getAttribute('data-scale')) || 1;
            initialScaleY = parseFloat(currentResizeEl.getAttribute('data-scale-y')) || parseFloat(currentResizeEl.getAttribute('data-scale')) || 1;
            initialWidth = currentResizeEl.offsetWidth;
            initialHeight = currentResizeEl.offsetHeight;

            e.preventDefault();
            return;
        }

        let dragItem = null;
        for (const selector of DRAGGABLE_ELEMENT_SELECTORS) {
            const el = e.target.closest(selector);
            if (el && document.body.contains(el)) {
                dragItem = el;
                break;
            }
        }

        if (!dragItem) return;

        isDragging = true;
        currentDragEl = dragItem;

        if (currentDragEl.style.position !== "absolute") {
            const rect = currentDragEl.getBoundingClientRect();
            const computed = window.getComputedStyle(currentDragEl);
            // rect.* est en pixels ecran (donc multiplie par le zoom 0.85 du
            // conteneur) ; offsetWidth/offsetHeight sont en pixels CSS.
            const cssWidth = currentDragEl.offsetWidth;
            const cssHeight = currentDragEl.offsetHeight;

            const placeholder = document.createElement("div");
            placeholder.className = "customization-placeholder";
            placeholder.style.width = cssWidth + "px";
            placeholder.style.height = cssHeight + "px";
            placeholder.style.flex = computed.flex;
            if (computed.margin) placeholder.style.margin = computed.margin;
            currentDragEl.parentNode.insertBefore(placeholder, currentDragEl);

            currentDragEl.style.width = cssWidth + "px";
            currentDragEl.style.height = cssHeight + "px";
            currentDragEl.style.boxSizing = "border-box";

            const oldTransition = currentDragEl.style.transition;
            currentDragEl.style.transition = "none";

            currentDragEl.style.position = "absolute";
            currentDragEl.style.margin = "0";
            currentDragEl.style.zIndex = "50";

            currentDragEl.style.left = "0px";
            currentDragEl.style.top = "0px";

            // Force layout recalculation before measuring zeroRect
            currentDragEl.offsetHeight;

            const zeroRect = currentDragEl.getBoundingClientRect();

            const leftPx = rect.left - zeroRect.left;
            const topPx = rect.top - zeroRect.top;

            const offsetParent = currentDragEl.offsetParent || document.documentElement;
            const cw = offsetParent.clientWidth || 1;
            const ch = offsetParent.clientHeight || 1;
            currentDragEl.style.left = ((leftPx / cw) * 100) + "%";
            currentDragEl.style.top = ((topPx / ch) * 100) + "%";

            currentDragEl.offsetHeight; // Force layout before restoring transition
            currentDragEl.style.transition = oldTransition;
        }

        const compStyle = window.getComputedStyle(currentDragEl);
        initialLeft = parseFloat(compStyle.left) || 0;
        initialTop = parseFloat(compStyle.top) || 0;

        startX = e.clientX;
        startY = e.clientY;

        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (isResizing && currentResizeEl) {
            if (currentResizeEl.dataset.isBg === "true") {
                const dy = e.clientY - startY;
                // Plafond : on ne peut agrandir que de la place restante,
                // la page ne redevient donc jamais scrollable.
                const maxHeight = Math.max(50, initialHeight + Math.max(0, initialSlack));
                const newHeight = Math.max(50, Math.min(initialHeight + dy, maxHeight));
                currentResizeEl.style.minHeight = newHeight + "px";
                currentResizeEl.style.flex = "none";
                return;
            }

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const startScaledWidth = initialWidth * initialScaleX;
            const startScaledHeight = initialHeight * initialScaleY;

            const newScaledWidth = startScaledWidth + dx;
            const newScaledHeight = startScaledHeight + dy;

            let newScaleX = newScaledWidth / initialWidth;
            let newScaleY = newScaledHeight / initialHeight;

            if (newScaleX < 0.2) newScaleX = 0.2;
            if (newScaleX > 5) newScaleX = 5;
            if (newScaleY < 0.2) newScaleY = 0.2;
            if (newScaleY > 5) newScaleY = 5;

            currentResizeEl.setAttribute('data-scale-x', newScaleX);
            currentResizeEl.setAttribute('data-scale-y', newScaleY);
            currentResizeEl.style.transform = `scale(${newScaleX}, ${newScaleY})`;
            currentResizeEl.style.transformOrigin = 'top left';
            return;
        }

        if (!isDragging || !currentDragEl) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        const offsetParent = currentDragEl.offsetParent || document.documentElement;
        const cw = offsetParent.clientWidth || 1;
        const ch = offsetParent.clientHeight || 1;

        const GRID_SIZE = 20;
        let newLeftPx = initialLeft + dx;
        let newTopPx = initialTop + dy;

        newLeftPx = Math.round(newLeftPx / GRID_SIZE) * GRID_SIZE;
        newTopPx = Math.round(newTopPx / GRID_SIZE) * GRID_SIZE;

        currentDragEl.style.left = ((newLeftPx / cw) * 100) + "%";
        currentDragEl.style.top = ((newTopPx / ch) * 100) + "%";
    });

    document.addEventListener("click", (e) => {
        if (!isCustomizationModeActive) return;
        if (e.target.closest("#customization-banner")) return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    document.addEventListener("mouseup", () => {
        if (isResizing && currentResizeEl) {
            isResizing = false;
            saveElementPosition(currentResizeEl);
            if (currentResizeEl.dataset.isBg) {
                currentResizeEl.removeAttribute('data-is-bg');
            }
            currentResizeEl = null;
            return;
        }

        if (!isDragging || !currentDragEl) return;
        isDragging = false;

        saveElementPosition(currentDragEl);
        currentDragEl = null;
    });
}

function saveElementPosition(el) {
    let positions = JSON.parse(localStorage.getItem("ui-positions") || "{}");
    const key = el.id || el.className.replace('draggable-item', '').replace('resizable-bg-item', '').trim().split(/\s+/).join('.');

    if (el.classList.contains('resizable-bg-item')) {
        positions[key] = {
            minHeight: el.style.minHeight,
            flex: el.style.flex
        };
    } else {
        positions[key] = {
            left: el.style.left,
            top: el.style.top,
            scaleX: el.getAttribute('data-scale-x') || el.getAttribute('data-scale') || 1,
            scaleY: el.getAttribute('data-scale-y') || el.getAttribute('data-scale') || 1
        };
    }

    localStorage.setItem("ui-positions", JSON.stringify(positions));
}

function loadElementPositions() {
    let positions = JSON.parse(localStorage.getItem("ui-positions") || "{}");

    for (const selector of DRAGGABLE_ELEMENT_SELECTORS) {
        const els = document.querySelectorAll(selector);
        els.forEach(el => {
            const key = el.id || el.className.replace('draggable-item', '').trim().split(/\s+/).join('.');
            // Une ancienne entree "hauteur de fond" (sans left/top) ne doit pas passer en absolu
            if (positions[key] && positions[key].left) {
                const applyPosition = () => {
                    const computed = window.getComputedStyle(el);
                    // Pixels CSS (sans le zoom du parent), sinon le widget
                    // rapetissait a chaque chargement des positions.
                    const cssWidth = el.offsetWidth;
                    const cssHeight = el.offsetHeight;

                    const placeholder = document.createElement("div");
                    placeholder.className = "customization-placeholder";
                    if (cssWidth > 0) placeholder.style.width = cssWidth + "px";
                    if (cssHeight > 0) placeholder.style.height = cssHeight + "px";
                    placeholder.style.flex = computed.flex;
                    if (computed.margin) placeholder.style.margin = computed.margin;
                    el.parentNode.insertBefore(placeholder, el);

                    if (cssWidth > 0) el.style.width = cssWidth + "px";
                    if (cssHeight > 0) el.style.height = cssHeight + "px";
                    el.style.boxSizing = "border-box";

                    el.style.position = "absolute";
                    el.style.left = positions[key].left;
                    el.style.top = positions[key].top;
                    el.style.margin = "0";
                    el.style.zIndex = "50";

                    if (positions[key].scaleX !== undefined || positions[key].scale !== undefined) {
                        const scaleX = positions[key].scaleX || positions[key].scale || 1;
                        const scaleY = positions[key].scaleY || positions[key].scale || 1;

                        el.setAttribute('data-scale-x', scaleX);
                        el.setAttribute('data-scale-y', scaleY);
                        el.style.transform = `scale(${scaleX}, ${scaleY})`;
                        el.style.transformOrigin = 'top left';
                    }
                };
                
                if (el.getBoundingClientRect().width === 0) {
                    setTimeout(applyPosition, 300);
                } else {
                    applyPosition();
                }
            }
        });
    }

    for (const selector of RESIZABLE_BG_SELECTORS) {
        const els = document.querySelectorAll(selector);
        els.forEach(el => {
            const key = el.id || el.className.replace('resizable-bg-item', '').trim().split(/\s+/).join('.');
            if (positions[key] && positions[key].minHeight) {
                el.style.minHeight = positions[key].minHeight;
                if (positions[key].flex) {
                    el.style.flex = positions[key].flex;
                }
            }
        });
    }
}

function resetElementPositions() {
    if (!confirm("Voulez-vous vraiment réinitialiser les positions de tous les éléments ?")) return;
    // Objet vide plutôt que suppression : la disposition importée ne doit
    // pas revenir au rechargement.
    localStorage.setItem("ui-positions", "{}");
    window.location.reload();
}

window.toggleCustomizationMode = function (active) {
    isCustomizationModeActive = active;

    const banner = document.getElementById("customization-banner");

    if (active) {
        if (banner) banner.classList.remove("hidden");
        document.body.classList.add("customization-active");

        for (const selector of DRAGGABLE_ELEMENT_SELECTORS) {
            document.querySelectorAll(selector).forEach(el => {
                el.classList.add("draggable-item");
                if (!el.querySelector('.resize-handle')) {
                    const handle = document.createElement('div');
                    handle.className = 'resize-handle';
                    handle.innerHTML = '⤡';
                    handle.title = 'Redimensionner';
                    el.appendChild(handle);
                }
            });
        }
        for (const selector of RESIZABLE_BG_SELECTORS) {
            document.querySelectorAll(selector).forEach(el => {
                el.classList.add("resizable-bg-item");
                if (!el.querySelector('.bg-resize-handle')) {
                    const handle = document.createElement('div');
                    handle.className = 'bg-resize-handle';
                    handle.innerHTML = '↕';
                    handle.title = 'Redimensionner la hauteur';
                    el.appendChild(handle);
                }
            });
        }
    } else {
        if (banner) banner.classList.add("hidden");
        document.body.classList.remove("customization-active");

        for (const selector of DRAGGABLE_ELEMENT_SELECTORS) {
            document.querySelectorAll(selector).forEach(el => {
                el.classList.remove("draggable-item");
                const handle = el.querySelector('.resize-handle');
                if (handle) handle.remove();
            });
        }
        for (const selector of RESIZABLE_BG_SELECTORS) {
            document.querySelectorAll(selector).forEach(el => {
                el.classList.remove("resizable-bg-item");
                const handle = el.querySelector('.bg-resize-handle');
                if (handle) handle.remove();
            });
        }
    }
};
