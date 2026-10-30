"use strict";

/* ============================================================
   Journal du navigateur (script classique chargé avant tout le reste)

   Garde sur ce poste les erreurs JavaScript, les console.error/warn et
   les chargements de page, pour les joindre aux signalements de bug
   (js/ui/signalement.js). Conservé d'un chargement à l'autre : un bug
   vu au démarrage reste dans le journal après un F5.
   ============================================================ */

(function () {
    const CLE = "journal-navigateur";
    const MAX = 200;               // entrées gardées
    const LONGUEUR = 1000;         // caractères par entrée

    function lire() {
        try {
            const liste = JSON.parse(localStorage.getItem(CLE) || "[]");
            return Array.isArray(liste) ? liste : [];
        } catch (e) {
            return [];
        }
    }

    function texte(valeur) {
        if (valeur instanceof Error) return `${valeur.message}\n${valeur.stack || ""}`;
        if (typeof valeur === "string") return valeur;
        try { return JSON.stringify(valeur); } catch (e) { return String(valeur); }
    }

    function noter(niveau, ...valeurs) {
        const ligne = `${new Date().toISOString()} [${niveau}] ${valeurs.map(texte).join(" ")}`;
        const liste = lire();
        liste.push(ligne.slice(0, LONGUEUR));
        try {
            localStorage.setItem(CLE, JSON.stringify(liste.slice(-MAX)));
        } catch (e) { /* stockage plein ou bloqué : le journal se perd, pas la page */ }
    }

    for (const niveau of ["error", "warn"]) {
        const origine = console[niveau].bind(console);
        console[niveau] = (...valeurs) => {
            noter(niveau, ...valeurs);
            origine(...valeurs);
        };
    }

    // Phase de capture : attrape aussi les fichiers (script, image) qui ne se chargent pas
    window.addEventListener("error", e => {
        if (e.error || e.message) {
            noter("erreur", e.error || e.message, `(${e.filename || "?"}:${e.lineno || 0})`);
        } else if (e.target && e.target !== window) {
            noter("chargement", `${e.target.tagName} ${e.target.src || e.target.href || ""}`);
        }
    }, true);
    window.addEventListener("unhandledrejection", e => noter("promesse", e.reason));

    noter("page", `chargée : ${location.href}`);

    window.noterJournal = (message) => noter("info", message);
    window.lireJournal = () => lire().join("\n");
})();
