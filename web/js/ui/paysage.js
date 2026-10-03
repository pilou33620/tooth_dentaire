"use strict";

/* ============================================================
   Fond « Paysage » de l'accueil

   Petit décor dessiné : ciel, soleil ou lune à sa place selon l'heure,
   nuages qui défilent, collines et le cabinet avec sa dent en enseigne.
   Le décor suit le moment de la journée et la météo :
   fenêtres allumées le soir et par mauvais temps, neige sur le toit et
   les collines, brume, nuages d'orage.

   Aucune dépendance : l'état est lu sur <html>, où il est déjà posé par
     - bonjourr.js : data-bj-fond, data-bj-phase, data-bj-meteo-fond
     - meteo.js    : data-bj-meteo, data-bj-meteo-nuit
   La pluie, la neige et les éclairs viennent des calques communs
   (canvas et éclair) gérés par meteo.js.
   ============================================================ */

export const MOMENTS = ["aube", "jour", "crepuscule", "nuit"];
export const METEOS = ["clair", "voile", "nuageux", "couvert", "brouillard", "pluie", "neige", "orage"];
const MAUVAIS = ["couvert", "brouillard", "pluie", "neige", "orage"];

/* ---------------- Palettes ---------------- */

const CIEL = {
    aube: ["#4d5f96", "#c98ba8", "#f6b38f"],
    jour: ["#3f95d1", "#7fc2e6", "#c9eaf2"],
    crepuscule: ["#2f2766", "#a0558a", "#f2955f"],
    nuit: ["#060a22", "#141b44", "#283062"]
};
const CIEL_METEO = {
    couvert: { jour: ["#6f7f8d", "#98a6b1", "#c3ccd3"], nuit: ["#10151d", "#1d252f", "#2f3842"] },
    brouillard: { jour: ["#8e99a3", "#b4bcc3", "#d8dde0"], nuit: ["#141a21", "#252d36", "#3b434c"] },
    pluie: { jour: ["#4b5864", "#717e88", "#9ca7af"], nuit: ["#0b1117", "#18212b", "#29323c"] },
    orage: { jour: ["#22263a", "#3d4257", "#5e6277"], nuit: ["#05070d", "#11131d", "#1f2230"] },
    neige: { jour: ["#8597ab", "#b4c2cf", "#e1e8ee"], nuit: ["#141e2c", "#273447", "#3e4c61"] }
};
const COLLINES = {
    aube: ["#7a6f93", "#4d5674", "#323a56"],
    jour: ["#6aa89a", "#3f8571", "#2d6655"],
    crepuscule: ["#7a4f73", "#4c3654", "#2f2340"],
    nuit: ["#1b2740", "#131c30", "#0c1322"]
};
const COLLINES_GRIS = { jour: ["#7f948f", "#5a7069", "#435650"], nuit: ["#1c2430", "#141b25", "#0d131b"] };
const COLLINES_ORAGE = ["#4e5a5c", "#384345", "#283133"];
const COLLINES_NEIGE = { jour: ["#b4c2cf", "#c3cfda", "#d0dae3"], nuit: ["#8796ab", "#a1afc1", "#b7c3d2"] };

/** Position du soleil ou de la lune dans le décor (1280 × 720). */
const ASTRE = { aube: [230, 430], jour: [1010, 120], crepuscule: [1150, 395], nuit: [1000, 110] };

/* ---------------- Choix du décor ---------------- */

/**
 * Tout ce qui varie dans le décor, à partir du moment et de la météo.
 * `meteo` vide ou inconnue : beau temps (le décor suit seulement l'heure).
 * `nuit` : nuit selon la météo (symbole MET Norway) ; par défaut, selon l'heure.
 */
export function decor(moment, meteo = "", nuit = null) {
    const m = MOMENTS.includes(moment) ? moment : "jour";
    const temps = METEOS.includes(meteo) ? meteo : "clair";
    const estNuit = typeof nuit === "boolean" ? nuit : m === "nuit";
    const jn = estNuit ? "nuit" : "jour";
    const mauvais = MAUVAIS.includes(temps);

    let collines = COLLINES[estNuit ? "nuit" : m];
    if (temps === "neige") collines = COLLINES_NEIGE[jn];
    else if (temps === "orage" && !estNuit) collines = COLLINES_ORAGE;
    else if (mauvais) collines = COLLINES_GRIS[jn];

    let astre = null;
    if (!mauvais) astre = estNuit ? "lune" : "soleil";

    return {
        moment: m,
        meteo: temps,
        nuit: estNuit,
        ciel: mauvais ? CIEL_METEO[temps][jn] : CIEL[estNuit ? "nuit" : m],
        collines,
        astre,
        etoiles: estNuit && (temps === "clair" || temps === "voile"),
        fenetresAllumees: m !== "jour" || estNuit || temps === "pluie" || temps === "orage",
        toitEnneige: temps === "neige",
        brouillard: temps === "brouillard"
    };
}

/* ---------------- Dessin ---------------- */

function nuage(x, y, echelle, couleur, duree, decalage) {
    return `<g class="bj-p-derive" style="animation-duration:${duree}s;animation-delay:-${decalage}s">`
        + `<g transform="translate(${x} ${y}) scale(${echelle})" fill="${couleur}">`
        + `<ellipse cx="0" cy="18" rx="70" ry="24"/><circle cx="-28" cy="6" r="28"/>`
        + `<circle cx="10" cy="-4" r="38"/><circle cx="44" cy="10" r="26"/></g></g>`;
}

function nuages(d) {
    const blanc = d.nuit ? "rgba(170,180,205,.35)" : "rgba(255,255,255,.88)";
    const gris = d.nuit ? "rgba(70,80,96,.75)" : "rgba(214,221,228,.92)";
    const neige = d.nuit ? "rgba(120,135,160,.6)" : "rgba(236,241,246,.95)";
    const sombre = d.nuit ? "rgba(30,34,46,.9)" : "rgba(90,96,114,.92)";
    const couvrant = [[120, 80, 1.6, 200], [520, 60, 1.8, 230], [900, 110, 1.5, 210], [330, 190, 1.3, 180], [760, 220, 1.2, 190]];
    const orageux = [[120, 90, 1.7, 220], [520, 60, 1.9, 240], [900, 110, 1.6, 230], [330, 200, 1.4, 200], [760, 220, 1.3, 210]];
    const plan = {
        voile: [[[300, 150, .8, 160]], blanc],
        nuageux: [[[200, 140, 1.1, 150], [760, 90, .9, 190], [520, 230, .7, 170]], blanc],
        couvert: [couvrant, gris],
        brouillard: [couvrant, gris],
        pluie: [couvrant, gris],
        neige: [couvrant, neige],
        orage: [orageux, sombre]
    }[d.meteo];
    if (!plan) return "";
    const [liste, couleur] = plan;
    return liste.map(([x, y, s, duree], i) => nuage(x, y, s, couleur, duree, i * 29)).join("");
}

function etoiles() {
    let points = "";
    for (let i = 0; i < 70; i++) {
        const x = (i * 197.3) % 1280;
        const y = (i * 83.7) % 380;
        const r = 0.6 + ((i * 7) % 10) / 10;
        const o = 0.35 + ((i * 13) % 10) / 16;
        points += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" opacity="${o.toFixed(2)}"/>`;
    }
    // Deux groupes qui scintillent en décalé
    return `<g class="bj-p-etoiles" fill="#fff">${points}</g>`;
}

function astre(d) {
    if (!d.astre) return "";
    const [x, y] = ASTRE[d.nuit ? "nuit" : d.moment];
    if (d.astre === "lune") {
        return `<g class="bj-p-lune" transform="translate(${x} ${y})">`
            + `<circle r="70" fill="rgba(220,230,255,.08)"/><circle r="38" fill="#f4f1e2"/>`
            + `<circle cx="16" cy="-10" r="34" fill="${d.ciel[0]}"/></g>`;
    }
    const c = d.moment === "jour" ? "#fff6d4" : "#ffd59a";
    return `<g class="bj-p-soleil" transform="translate(${x} ${y})">`
        + `<circle r="150" fill="${c}" opacity=".18"/><circle r="85" fill="${c}" opacity=".28"/>`
        + `<circle r="46" fill="${c}"/></g>`;
}

function cabinet(d) {
    const fenetre = d.fenetresAllumees ? "#ffd27a" : (MAUVAIS.includes(d.meteo) ? "#c7d3db" : "#a9d6ea");
    const mur = d.nuit ? "#2c3549" : d.moment === "crepuscule" ? "#e9d9cf" : "#f3efe8";
    const toit = d.toitEnneige ? (d.nuit ? "#c9d3df" : "#ffffff") : d.nuit ? "#3b3346" : "#c06a47";
    const porte = d.nuit ? "#1b2232" : "#5b6b78";
    const lueur = d.fenetresAllumees ? ' class="bj-p-fenetre-allumee"' : "";
    return `<g class="bj-p-cabinet" transform="translate(975 378) scale(.45)">`
        + `<rect x="0" y="0" width="230" height="110" fill="${mur}"/>`
        + `<path d="M-14 4 L115 -66 L244 4 Z" fill="${toit}"/>`
        + `<rect x="88" y="40" width="54" height="70" rx="3" fill="${porte}"/>`
        + `<rect${lueur} x="22" y="30" width="40" height="34" rx="3" fill="${fenetre}"/>`
        + `<rect${lueur} x="168" y="30" width="40" height="34" rx="3" fill="${fenetre}"/>`
        + `<g transform="translate(115 -22)">`
        + `<rect x="-24" y="-17" width="48" height="34" rx="9" fill="#ffffff"/>`
        + `<path d="M-9 -9 C -14 -9 -15 -3 -13 3 C -11 9 -9 11 -7 6 C -5 1 -2 1 0 6 C 2 1 5 1 7 6 `
        + `C 9 11 11 9 13 3 C 15 -3 14 -9 9 -9 C 5 -9 3 -7 0 -7 C -3 -7 -5 -9 -9 -9 Z" `
        + `fill="none" stroke="#2f98b4" stroke-width="2.4" stroke-linejoin="round"/></g></g>`;
}

function brume(d) {
    if (!d.brouillard) return "";
    const c1 = d.nuit ? "rgba(110,120,135,.45)" : "rgba(240,244,247,.65)";
    const c2 = d.nuit ? "rgba(110,120,135,.5)" : "rgba(240,244,247,.75)";
    return `<g class="bj-p-brume">`
        + `<rect x="-100" y="380" width="1480" height="160" fill="${c1}" filter="url(#bj-p-flou)"/>`
        + `<rect x="-100" y="560" width="1480" height="160" fill="${c2}" filter="url(#bj-p-flou)"/></g>`;
}

/** Le décor complet en SVG (chaîne). Le sol reste toujours en bas de l'écran. */
export function dessinerPaysage(d) {
    const [c0, c1, c2] = d.collines;
    return `<svg viewBox="0 0 1280 720" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">`
        + `<defs><linearGradient id="bj-p-ciel" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${d.ciel[0]}"/><stop offset=".55" stop-color="${d.ciel[1]}"/>`
        + `<stop offset="1" stop-color="${d.ciel[2]}"/></linearGradient>`
        + `<filter id="bj-p-flou" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="22"/></filter></defs>`
        // Le ciel déborde vers le haut : sur un écran plus haut que 16:9, le haut reste du ciel
        + `<rect x="-200" y="-1200" width="1680" height="1920" fill="url(#bj-p-ciel)"/>`
        + (d.etoiles ? etoiles() : "")
        + astre(d)
        + nuages(d)
        + `<path d="M0 470 C 180 400, 330 430, 480 455 C 650 485, 780 395, 960 420 C 1100 440, 1200 410, 1280 425 L1280 720 L0 720 Z" fill="${c0}"/>`
        + `<path d="M0 560 C 220 500, 380 545, 560 560 C 760 575, 900 520, 1080 540 C 1180 552, 1240 545, 1280 548 L1280 720 L0 720 Z" fill="${c1}"/>`
        + cabinet(d)
        + `<path d="M0 640 C 260 610, 520 650, 780 640 C 1000 632, 1160 650, 1280 645 L1280 720 L0 720 Z" fill="${c2}"/>`
        + brume(d)
        + `</svg>`;
}

/* ---------------- Mise à jour ---------------- */

let dernierDecor = "";

/** État du décor lu sur <html> (null si le fond « Paysage » n'est pas choisi). */
export function etatCourant(doc = document) {
    const ds = doc.documentElement.dataset;
    if (ds.bjFond !== "paysage") return null;
    const avecMeteo = ds.bjMeteoFond !== "non" && METEOS.includes(ds.bjMeteo || "");
    const moment = MOMENTS.includes(ds.bjPhase) ? ds.bjPhase : "jour";
    return avecMeteo
        ? decor(moment, ds.bjMeteo, ds.bjMeteoNuit === "oui")
        : decor(moment);
}

/** Redessine le paysage si le moment ou la météo a changé. Renvoie true s'il a été redessiné. */
export function majPaysage(doc = document) {
    const calque = doc.getElementById("bj-paysage");
    if (!calque) return false;
    const d = etatCourant(doc);
    if (!d) {
        if (calque.firstChild) calque.innerHTML = "";
        dernierDecor = "";
        return false;
    }
    const cle = `${d.moment}|${d.meteo}|${d.nuit}`;
    if (cle === dernierDecor && calque.firstChild) return false;
    dernierDecor = cle;
    calque.innerHTML = dessinerPaysage(d);
    return true;
}
