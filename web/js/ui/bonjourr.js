"use strict";

/* ============================================================
   Accueil façon Bonjourr (https://bonjourr.fr)
   Horloge, salutation, citation, fond et widgets.

   Les réglages d'apparence sont propres à chaque poste (localStorage),
   comme les positions du mode personnalisation : les écrans du cabinet
   n'ont pas tous la même taille ni le même usage.
   ============================================================ */

import { getWeekNumber } from '../planning/clock.js';

export const CLE_OPTIONS = "bj-apparence";
export const CLE_IMAGE = "bj-fond-image";

export const DEFAUTS = Object.freeze({
    fond: "dynamique",          // dynamique | cabinet | image | uni
    couleur: "#24414f",
    flou: 0,                    // px
    luminosite: 85,             // % (100 = fond non assombri)
    horloge: "numerique",       // numerique | analogique
    taille: 100,                // % de la taille de base de l'horloge
    secondes: false,
    salutation: true,
    nom: "",
    citation: true,
    widgets: Object.freeze({
        planning: true, taches: true, ruptures: true,
        notes: true, checklist: true, minuteurs: true
    })
});

const FONDS = ["dynamique", "cabinet", "image", "uni"];
const HORLOGES = ["numerique", "analogique"];

/* Proverbes et auteurs du domaine public */
export const CITATIONS = Object.freeze([
    { texte: "Mieux vaut prévenir que guérir.", auteur: "Proverbe" },
    { texte: "Petit à petit, l'oiseau fait son nid.", auteur: "Proverbe" },
    { texte: "Rien ne sert de courir ; il faut partir à point.", auteur: "Jean de La Fontaine" },
    { texte: "On a souvent besoin d'un plus petit que soi.", auteur: "Jean de La Fontaine" },
    { texte: "Il faut cultiver notre jardin.", auteur: "Voltaire" },
    { texte: "Ce que l'on conçoit bien s'énonce clairement.", auteur: "Nicolas Boileau" },
    { texte: "Qui va lentement va sûrement.", auteur: "Proverbe" },
    { texte: "Chaque chose en son temps.", auteur: "Proverbe" },
    { texte: "L'union fait la force.", auteur: "Devise" },
    { texte: "Tout vient à point à qui sait attendre.", auteur: "Proverbe" },
    { texte: "Le travail éloigne de nous trois grands maux : l'ennui, le vice et le besoin.", auteur: "Voltaire" },
    { texte: "Il n'est pas de petites économies.", auteur: "Proverbe" }
]);

/* ------------------------------------------------------------
   Réglages
   ------------------------------------------------------------ */

function entier(valeur, min, max, defaut) {
    const n = Number(valeur);
    if (!Number.isFinite(n)) return defaut;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** Complète et borne des réglages lus (valeurs manquantes ou invalides → défaut). */
export function normaliserOptions(brut) {
    const o = (brut && typeof brut === "object") ? brut : {};
    const w = (o.widgets && typeof o.widgets === "object") ? o.widgets : {};
    return {
        fond: FONDS.includes(o.fond) ? o.fond : DEFAUTS.fond,
        couleur: /^#[0-9a-f]{6}$/i.test(o.couleur || "") ? o.couleur : DEFAUTS.couleur,
        flou: entier(o.flou, 0, 40, DEFAUTS.flou),
        luminosite: entier(o.luminosite, 30, 100, DEFAUTS.luminosite),
        horloge: HORLOGES.includes(o.horloge) ? o.horloge : DEFAUTS.horloge,
        taille: entier(o.taille, 60, 160, DEFAUTS.taille),
        secondes: typeof o.secondes === "boolean" ? o.secondes : DEFAUTS.secondes,
        salutation: typeof o.salutation === "boolean" ? o.salutation : DEFAUTS.salutation,
        nom: typeof o.nom === "string" ? o.nom.trim().slice(0, 40) : DEFAUTS.nom,
        citation: typeof o.citation === "boolean" ? o.citation : DEFAUTS.citation,
        widgets: Object.fromEntries(
            Object.keys(DEFAUTS.widgets).map(nom => [nom, w[nom] !== false]))
    };
}

export function lireOptions(stockage = globalThis.localStorage) {
    try {
        return normaliserOptions(JSON.parse(stockage.getItem(CLE_OPTIONS) || "{}"));
    } catch (e) {
        return normaliserOptions({});
    }
}

export function ecrireOptions(options, stockage = globalThis.localStorage) {
    const propres = normaliserOptions(options);
    try {
        stockage.setItem(CLE_OPTIONS, JSON.stringify(propres));
    } catch (e) {
        console.warn("Réglages d'apparence non enregistrés :", e);
    }
    return propres;
}

/* ------------------------------------------------------------
   Temps : salutation, moment de la journée, date, aiguilles
   ------------------------------------------------------------ */

/** "Bonjour", "Bon après-midi", "Bonsoir" ou "Bonne nuit", suivi du nom s'il y en a un. */
export function salutation(date, nom = "") {
    const h = date.getHours();
    let mot;
    if (h >= 5 && h < 12) mot = "Bonjour";
    else if (h >= 12 && h < 18) mot = "Bon après-midi";
    else if (h >= 18 && h < 22) mot = "Bonsoir";
    else mot = "Bonne nuit";
    const n = (nom || "").trim();
    return n ? `${mot}, ${n}` : mot;
}

/** Moment de la journée qui pilote les couleurs du fond dynamique. */
export function phaseDuJour(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h >= 6 && h < 9) return "aube";
    if (h >= 9 && h < 17.5) return "jour";
    if (h >= 17.5 && h < 21) return "crepuscule";
    return "nuit";
}

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
    "août", "septembre", "octobre", "novembre", "décembre"];

/** "samedi 3 octobre · semaine 40" */
export function formaterDate(date) {
    return `${JOURS[date.getDay()]} ${date.getDate()} ${MOIS[date.getMonth()]} · semaine ${getWeekNumber(date)}`;
}

/** Angles (degrés, 0 = midi) des trois aiguilles. */
export function anglesAiguilles(date) {
    const s = date.getSeconds();
    const m = date.getMinutes() + s / 60;
    const h = (date.getHours() % 12) + m / 60;
    return { h: h * 30, m: m * 6, s: s * 6 };
}

/** Citation du jour (la même toute la journée sur tous les postes), décalable au clic. */
export function citationDuJour(date, decalage = 0) {
    const debut = Date.UTC(date.getFullYear(), 0, 0);
    const jour = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - debut) / 86400000);
    const n = CITATIONS.length;
    return CITATIONS[(((jour + decalage) % n) + n) % n];
}

/* ------------------------------------------------------------
   Rendu
   ------------------------------------------------------------ */

const pad = n => String(n).padStart(2, "0");

export function majHorloge(date = new Date(), options = etat.options, doc = document) {
    const num = doc.getElementById("bj-heure-num");
    if (num) {
        const hm = num.querySelector(".bj-hm");
        const sec = num.querySelector(".bj-sec");
        if (hm) hm.textContent = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        if (sec) sec.textContent = options.secondes ? pad(date.getSeconds()) : "";
        num.setAttribute("datetime", date.toISOString());
    }
    if (options.horloge === "analogique") {
        const a = anglesAiguilles(date);
        for (const [cle, angle] of Object.entries(a)) {
            const aiguille = doc.getElementById(`bj-aiguille-${cle}`);
            if (aiguille) aiguille.setAttribute("transform", `rotate(${angle.toFixed(2)} 50 50)`);
        }
    }
    const dateEl = doc.getElementById("bj-date");
    if (dateEl) dateEl.textContent = formaterDate(date);
    const sal = doc.getElementById("bj-salutation");
    if (sal) sal.textContent = salutation(date, options.nom);

    const phase = phaseDuJour(date);
    if (doc.documentElement.dataset.bjPhase !== phase) doc.documentElement.dataset.bjPhase = phase;
}

export function afficherCitation(date = new Date(), decalage = 0, doc = document) {
    const c = citationDuJour(date, decalage);
    const texte = doc.getElementById("bj-citation-texte");
    const auteur = doc.getElementById("bj-citation-auteur");
    if (texte) texte.textContent = c.texte;
    if (auteur) auteur.textContent = c.auteur;
}

/** Applique les réglages à la page (fond, horloge, widgets visibles...). */
export function appliquerOptions(options, doc = document, stockage = globalThis.localStorage) {
    const racine = doc.documentElement;
    racine.dataset.bjFond = options.fond;
    racine.style.setProperty("--bj-flou", `${options.flou}px`);
    // Léger zoom du fond flouté pour que ses bords ne laissent pas voir de liseré
    racine.style.setProperty("--bj-echelle", String(1 + options.flou / 200));
    racine.style.setProperty("--bj-luminosite", String(options.luminosite / 100));
    racine.style.setProperty("--bj-couleur-unie", options.couleur);
    racine.style.setProperty("--bj-taille", String(options.taille / 100));

    // Image personnelle
    const calqueImage = doc.querySelector("#bj-fond .bj-fond-image");
    if (calqueImage) {
        let image = null;
        if (options.fond === "image") {
            try { image = stockage.getItem(CLE_IMAGE); } catch (e) { image = null; }
        }
        calqueImage.style.backgroundImage = image ? `url("${image}")` : "";
        racine.dataset.bjImage = image ? "oui" : "non";
    }

    // Animation du cabinet : chargée seulement quand elle sert de fond (elle consomme du processeur)
    const iframe = doc.querySelector("#background-animation iframe");
    if (iframe) {
        const voulu = iframe.dataset.src || "";
        if (options.fond === "cabinet") {
            if (voulu && iframe.getAttribute("src") !== voulu) iframe.setAttribute("src", voulu);
        } else if (iframe.hasAttribute("src")) {
            iframe.removeAttribute("src");
        }
    }

    // Horloge
    const num = doc.getElementById("bj-heure-num");
    const analog = doc.getElementById("bj-heure-analog");
    if (num) num.classList.toggle("hidden", options.horloge !== "numerique");
    if (analog) analog.classList.toggle("hidden", options.horloge !== "analogique");
    const aigS = doc.getElementById("bj-aiguille-s");
    if (aigS) aigS.classList.toggle("hidden", !options.secondes);

    const sal = doc.getElementById("bj-salutation");
    if (sal) sal.classList.toggle("hidden", !options.salutation);
    const citation = doc.getElementById("bj-citation");
    if (citation) citation.classList.toggle("hidden", !options.citation);

    // Widgets
    for (const [nom, visible] of Object.entries(options.widgets)) {
        doc.querySelectorAll(`.bj-widget[data-widget="${nom}"]`).forEach(el => {
            el.classList.toggle("bj-widget-masque", !visible);
        });
    }
}

/* ------------------------------------------------------------
   Image personnelle : réduite avant d'être gardée dans le navigateur
   ------------------------------------------------------------ */

/** Taille cible d'une image (côté le plus long limité à `max`). */
export function dimensionsReduites(largeur, hauteur, max = 1920) {
    if (!largeur || !hauteur) return { largeur: 0, hauteur: 0 };
    const k = Math.min(1, max / Math.max(largeur, hauteur));
    return { largeur: Math.round(largeur * k), hauteur: Math.round(hauteur * k) };
}

function reduireImage(fichier, max = 1920, qualite = 0.82) {
    return new Promise((resoudre, rejeter) => {
        const url = URL.createObjectURL(fichier);
        const img = new Image();
        img.onload = () => {
            const d = dimensionsReduites(img.naturalWidth, img.naturalHeight, max);
            const canvas = document.createElement("canvas");
            canvas.width = d.largeur;
            canvas.height = d.hauteur;
            canvas.getContext("2d").drawImage(img, 0, 0, d.largeur, d.hauteur);
            URL.revokeObjectURL(url);
            resoudre(canvas.toDataURL("image/jpeg", qualite));
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            rejeter(new Error("Ce fichier n'est pas une image lisible."));
        };
        img.src = url;
    });
}

/* ------------------------------------------------------------
   Initialisation
   ------------------------------------------------------------ */

const etat = {
    options: normaliserOptions({}),
    decalageCitation: 0,
    minuterie: null
};

function definir(options) {
    etat.options = ecrireOptions(options);
    appliquerOptions(etat.options);
    majHorloge(new Date(), etat.options);
    remplirReglages();
}

function remplirReglages(doc = document) {
    const o = etat.options;
    const val = (id, v) => { const el = doc.getElementById(id); if (el) el.value = v; };
    const coche = (id, v) => { const el = doc.getElementById(id); if (el) el.checked = v; };
    val("bj-opt-fond", o.fond);
    val("bj-opt-couleur", o.couleur);
    val("bj-opt-flou", o.flou);
    val("bj-opt-luminosite", o.luminosite);
    val("bj-opt-horloge", o.horloge);
    val("bj-opt-taille", o.taille);
    val("bj-opt-nom", o.nom);
    coche("bj-opt-secondes", o.secondes);
    coche("bj-opt-salutation", o.salutation);
    coche("bj-opt-citation", o.citation);
    doc.querySelectorAll("[data-bj-widget]").forEach(el => {
        el.checked = o.widgets[el.dataset.bjWidget] !== false;
    });
    doc.querySelectorAll("[data-si-fond]").forEach(el => {
        el.classList.toggle("hidden", el.dataset.siFond !== o.fond);
    });
}

function brancherReglages(doc = document) {
    const sur = (id, evt, f) => { const el = doc.getElementById(id); if (el) el.addEventListener(evt, f); };
    const maj = patch => definir({ ...etat.options, ...patch });

    sur("bj-opt-fond", "change", e => maj({ fond: e.target.value }));
    sur("bj-opt-couleur", "input", e => maj({ couleur: e.target.value }));
    sur("bj-opt-flou", "input", e => maj({ flou: e.target.value }));
    sur("bj-opt-luminosite", "input", e => maj({ luminosite: e.target.value }));
    sur("bj-opt-horloge", "change", e => maj({ horloge: e.target.value }));
    sur("bj-opt-taille", "input", e => maj({ taille: e.target.value }));
    sur("bj-opt-nom", "input", e => maj({ nom: e.target.value }));
    sur("bj-opt-secondes", "change", e => maj({ secondes: e.target.checked }));
    sur("bj-opt-salutation", "change", e => maj({ salutation: e.target.checked }));
    sur("bj-opt-citation", "change", e => maj({ citation: e.target.checked }));
    doc.querySelectorAll("[data-bj-widget]").forEach(el => {
        el.addEventListener("change", () => {
            maj({ widgets: { ...etat.options.widgets, [el.dataset.bjWidget]: el.checked } });
        });
    });

    sur("bj-opt-image", "change", async e => {
        const fichier = e.target.files && e.target.files[0];
        if (!fichier) return;
        try {
            const donnees = await reduireImage(fichier);
            localStorage.setItem(CLE_IMAGE, donnees);
            maj({ fond: "image" });
        } catch (err) {
            const texte = err && err.name === "QuotaExceededError"
                ? "Image trop lourde pour être gardée sur ce poste. Essayez une image plus petite."
                : (err && err.message) || String(err);
            if (typeof window.showMessage === "function") window.showMessage("Image de fond", texte);
        } finally {
            e.target.value = "";
        }
    });
    sur("bj-opt-image-retirer", "click", () => {
        try { localStorage.removeItem(CLE_IMAGE); } catch (e) { /* rien à retirer */ }
        maj({ fond: etat.options.fond === "image" ? "dynamique" : etat.options.fond });
    });
    sur("bj-opt-defaut", "click", () => {
        try { localStorage.removeItem(CLE_IMAGE); } catch (e) { /* rien à retirer */ }
        definir({});
    });
}

function brancherAccueil(doc = document) {
    // Citation : un clic en propose une autre
    const citation = doc.getElementById("bj-citation");
    if (citation) {
        citation.addEventListener("click", () => {
            etat.decalageCitation += 1;
            afficherCitation(new Date(), etat.decalageCitation);
        });
    }

    // Carnet d'adresses (iframe) : recharge les contacts à chaque ouverture
    const annuaire = doc.getElementById("btn-annuaire");
    if (annuaire) {
        annuaire.addEventListener("click", () => {
            const overlay = doc.getElementById("annuaire-overlay");
            if (overlay) overlay.classList.remove("hidden");
            const f = doc.querySelector("#annuaire-overlay iframe");
            if (f && f.contentWindow && typeof f.contentWindow.rechargerContacts === "function") {
                f.contentWindow.rechargerContacts();
            }
        });
    }

    // Carte des tâches accessible au clavier
    const taches = doc.getElementById("btn-open-tasks");
    if (taches) {
        taches.addEventListener("keydown", e => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                taches.click();
            }
        });
    }

    // Échap ferme la fenêtre ouverte au premier plan (comme le panneau de Bonjourr)
    doc.addEventListener("keydown", e => {
        if (e.key !== "Escape") return;
        const ouvertes = [...doc.querySelectorAll(".overlay:not(.hidden)")];
        if (ouvertes.length === 0) return;
        const dessus = ouvertes.reduce((a, b) =>
            (Number(getComputedStyle(b).zIndex) || 0) >= (Number(getComputedStyle(a).zIndex) || 0) ? b : a);
        const fermer = dessus.querySelector(`[data-close="${dessus.id}"], .dialog-close`);
        if (fermer) fermer.click();
    });
}

export function initBonjourr(doc = document) {
    etat.options = lireOptions();
    appliquerOptions(etat.options, doc);
    majHorloge(new Date(), etat.options, doc);
    afficherCitation(new Date(), 0, doc);
    remplirReglages(doc);
    brancherReglages(doc);
    brancherAccueil(doc);

    clearInterval(etat.minuterie);
    etat.minuterie = setInterval(() => majHorloge(new Date(), etat.options, doc), 1000);
    doc.documentElement.classList.add("bj-pret");
}
