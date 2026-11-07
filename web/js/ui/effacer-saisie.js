"use strict";

/* ============================================================
   Petite croix pour vider d'un coup la zone de texte active

   Une seule croix, posée par-dessus le champ qui a le focus : tous les
   champs en profitent, y compris ceux créés par JS, sans toucher à leur
   mise en page.
   ============================================================ */

const TYPES = ["text", "search", "email", "tel", "url", "password"];
const LARGEUR_MINI = 60;    // champs étroits (durée, quantité) : pas la place
const TAILLE = 18;

function estEffacable(el) {
    if (!el.matches?.("input, textarea") || el.readOnly || el.disabled) return false;
    return el.tagName === "TEXTAREA" || TYPES.includes(el.type);
}

function initEffacerSaisie() {
    const bouton = document.createElement("button");
    bouton.type = "button";
    bouton.textContent = "×";
    bouton.title = "Tout effacer";
    bouton.setAttribute("aria-label", "Tout effacer");
    bouton.tabIndex = -1;
    bouton.style.cssText = `display:none;position:fixed;z-index:10000;width:${TAILLE}px;height:${TAILLE}px;`
        + "padding:0;border:none;border-radius:50%;background:rgba(71,85,105,.85);color:#fff;"
        + "font:bold 14px/18px sans-serif;text-align:center;cursor:pointer;";
    // Même niveau que les fenêtres, mais avant le voile de veille dans la page pour rester dessous
    document.body.insertBefore(bouton, document.getElementById("screensaver-overlay"));

    let champ = null;
    let boucle = null;

    // Suivi à chaque image : le champ défile, se vide par script ou disparaît avec sa fenêtre
    function placer() {
        if (!champ.isConnected) return oublier();
        const r = champ.getBoundingClientRect();
        const visible = champ.value && r.width >= LARGEUR_MINI;
        bouton.style.display = visible ? "block" : "none";
        if (visible) {
            // champ.list : garder libre la flèche de la liste de suggestions
            bouton.style.left = (r.right - TAILLE - (champ.list ? 22 : 4)) + "px";
            bouton.style.top = (champ.tagName === "TEXTAREA" ? r.top + 4 : r.top + (r.height - TAILLE) / 2) + "px";
        }
        boucle = requestAnimationFrame(placer);
    }

    function oublier() {
        cancelAnimationFrame(boucle);
        champ = null;
        bouton.style.display = "none";
    }

    document.addEventListener("focusin", (e) => {
        oublier();
        if (estEffacable(e.target)) {
            champ = e.target;
            placer();
        }
    });
    document.addEventListener("focusout", oublier);

    // Le champ garde le focus quand on clique sur la croix
    bouton.addEventListener("mousedown", (e) => e.preventDefault());
    bouton.addEventListener("click", () => {
        if (!champ) return;
        champ.value = "";
        // input pour les filtres, change pour les champs enregistrés à la sortie (planning...)
        champ.dispatchEvent(new Event("input", { bubbles: true }));
        champ.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

initEffacerSaisie();
