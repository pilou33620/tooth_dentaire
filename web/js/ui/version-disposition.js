"use strict";

/* Réinitialisation UNIQUE des positions après un changement de structure de l'interface.
   Les positions de l'ancienne interface n'ont pas de sens dans la nouvelle : on repart
   d'une disposition vide ("{}" et non une suppression, sinon la disposition importée
   de l'ancienne application serait rechargée par le mode personnalisation).
   Fichier séparé (et non script dans la page) : la politique de sécurité (CSP)
   n'autorise aucun script écrit dans le HTML. */
(function () {
    const LAYOUT_VERSION = "layout-bonjourr-2026-10";
    try {
        if (localStorage.getItem("ui-layout-version") !== LAYOUT_VERSION) {
            localStorage.setItem("ui-positions", "{}");
            localStorage.setItem("ui-layout-version", LAYOUT_VERSION);
        }
    } catch (e) {
        /* stockage du navigateur indisponible : rien à réinitialiser */
    }
})();
