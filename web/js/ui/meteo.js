"use strict";

/* ============================================================
   Météo de l'accueil : le fond « selon l'heure » suit aussi le temps
   qu'il fait (nuages, pluie, neige, orage, brouillard, soleil, étoiles),
   et la température s'affiche à côté de la date.

   Les prévisions sont demandées par le serveur (python/meteo.py,
   MET Norway) pour la commune du cabinet (document "meteo_lieu",
   la même pour tous les postes). Sans internet : fond selon l'heure.
   ============================================================ */

import { api, setDocument, getDocument } from '../core/api.js';
import { escapeHtml } from '../core/utils.js';
import { phaseDuJour } from './bonjourr.js';
import { majPaysage } from './paysage.js';

export const CATEGORIES = ["clair", "voile", "nuageux", "couvert", "brouillard", "pluie", "neige", "orage"];
export const INTERVALLE = 10 * 60 * 1000;   // le serveur garde de toute façon 10 min en cache

const etat = {
    meteo: null,
    raison: null,
    lieu: "",
    minuterie: null,
    animation: null
};

/* ---------------- Icônes (traits, couleur du texte) ---------------- */

const NUAGE = '<path d="M7 18h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 9.3 4.3 4.3 0 0 0 7 18z"/>';
const SOLEIL_PETIT = '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.3M2 8h1.3M3.8 3.8l.9.9M12.2 3.8l-.9.9"/>';
const ICONES = {
    "clair": '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    "clair-nuit": '<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>',
    "voile": SOLEIL_PETIT + '<path d="M9 19h8.5a3.3 3.3 0 0 0 .5-6.56A4.6 4.6 0 0 0 9.4 12a3.5 3.5 0 0 0-.4 7z"/>',
    "voile-nuit": '<path d="M12.3 8.4A4.6 4.6 0 0 1 6.4 2.6a4.6 4.6 0 1 0 5.9 5.8z"/><path d="M9 19h8.5a3.3 3.3 0 0 0 .5-6.56A4.6 4.6 0 0 0 9.4 12a3.5 3.5 0 0 0-.4 7z"/>',
    "nuageux": SOLEIL_PETIT + NUAGE,
    "nuageux-nuit": '<path d="M12.3 8.4A4.6 4.6 0 0 1 6.4 2.6a4.6 4.6 0 1 0 5.9 5.8z"/>' + NUAGE,
    "couvert": NUAGE,
    "brouillard": '<path d="M4 9h16M3 13h18M5 17h14M8 21h8"/>',
    "pluie": '<path d="M7 14h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.3 4.3 4.3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    "neige": '<path d="M7 14h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.3 4.3 4.3 0 0 0 7 14z"/><path d="M8 18h.01M12 20h.01M16 18h.01M10 21.5h.01M14 21.5h.01"/>',
    "orage": '<path d="M7 14h10a4 4 0 0 0 .6-7.96A5.5 5.5 0 0 0 7.1 5.3 4.3 4.3 0 0 0 7 14z"/><path d="M12.5 14.5l-2.5 3.8h3.2L11 22"/>'
};

export function iconeMeteo(categorie, nuit = false) {
    const cle = (nuit && ICONES[`${categorie}-nuit`]) ? `${categorie}-nuit` : categorie;
    const traits = ICONES[cle];
    return traits ? `<svg class="bj-ico" viewBox="0 0 24 24" aria-hidden="true">${traits}</svg>` : "";
}

/* ---------------- Interprétation ---------------- */

/** Le symbole dit s'il fait nuit ; sinon on suit l'heure. */
export function estNuitMeteo(meteo, date = new Date()) {
    if (meteo && typeof meteo.nuit === "boolean") return meteo.nuit;
    return phaseDuJour(date) === "nuit";
}

export function texteMeteo(meteo) {
    if (!meteo) return "";
    const t = Number.isFinite(meteo.temperature) ? `${meteo.temperature}°` : "";
    return [t, meteo.libelle || ""].filter(Boolean).join(" · ");
}

/** Particules à dessiner sur le fond selon le temps. */
export function particulesPour(categorie, intensite = "moyenne", nuit = false) {
    const parIntensite = (faible, moyenne, forte) =>
        intensite === "faible" ? faible : intensite === "forte" ? forte : moyenne;
    switch (categorie) {
        case "pluie": return { type: "pluie", nombre: parIntensite(70, 140, 240) };
        case "orage": return { type: "pluie", nombre: parIntensite(150, 200, 260) };
        case "neige": return { type: "neige", nombre: parIntensite(60, 110, 180) };
        case "clair":
        case "voile": return nuit ? { type: "etoiles", nombre: categorie === "clair" ? 140 : 70 } : null;
        default: return null;
    }
}

/* ---------------- Animation (pluie, neige, étoiles) ---------------- */

function animationPossible() {
    return typeof window !== "undefined"
        && typeof window.requestAnimationFrame === "function"
        && !/jsdom/i.test(navigator.userAgent || "");
}

function mouvementReduit() {
    try {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
        return false;
    }
}

function arreterAnimation() {
    const a = etat.animation;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    window.removeEventListener("resize", a.redimensionner);
    a.ctx.clearRect(0, 0, a.canvas.width, a.canvas.height);
    etat.animation = null;
}

function demarrerAnimation(canvas, spec) {
    const cle = spec ? `${spec.type}-${spec.nombre}` : "";
    if (etat.animation && etat.animation.cle === cle) return;
    arreterAnimation();
    if (!spec || !canvas || !animationPossible()) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const a = { cle, canvas, ctx, raf: 0, dernier: 0, particules: [], l: 0, h: 0, t: 0 };
    const hasard = (min, max) => min + Math.random() * (max - min);

    function creer(p, depart) {
        if (spec.type === "pluie") {
            p.x = hasard(-0.1, 1.1) * a.l;
            p.y = depart ? hasard(0, a.h) : hasard(-60, -10);
            p.v = hasard(0.9, 1.4) * a.h * 0.9;     // px par seconde
            p.long = hasard(10, 22);
            p.a = hasard(0.18, 0.45);
        } else if (spec.type === "neige") {
            p.x = hasard(0, a.l);
            p.y = depart ? hasard(0, a.h) : hasard(-20, -4);
            p.v = hasard(25, 70);
            p.r = hasard(1, 3.2);
            p.ph = hasard(0, Math.PI * 2);
            p.a = hasard(0.5, 0.95);
        } else {
            p.x = hasard(0, a.l);
            p.y = hasard(0, a.h * 0.62);
            p.r = hasard(0.5, 1.4);
            p.ph = hasard(0, Math.PI * 2);
            p.vit = hasard(0.6, 1.8);
        }
        return p;
    }

    a.redimensionner = () => {
        const dpr = Math.min(1.5, window.devicePixelRatio || 1);
        a.l = window.innerWidth;
        a.h = window.innerHeight;
        canvas.width = Math.round(a.l * dpr);
        canvas.height = Math.round(a.h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        a.particules = Array.from({ length: spec.nombre }, () => creer({}, true));
    };
    a.redimensionner();
    window.addEventListener("resize", a.redimensionner);

    const pas = spec.type === "etoiles" ? 1000 / 12 : 1000 / 30;   // images par seconde
    const statique = mouvementReduit();

    function dessiner(dt) {
        ctx.clearRect(0, 0, a.l, a.h);
        a.t += dt;
        if (spec.type === "pluie") {
            ctx.lineWidth = 1.1;
            ctx.lineCap = "round";
            for (const p of a.particules) {
                p.y += p.v * dt;
                p.x += p.v * 0.12 * dt;
                if (p.y - p.long > a.h) creer(p, false);
                ctx.strokeStyle = `rgba(220, 235, 255, ${p.a})`;
                ctx.beginPath();
                ctx.moveTo(p.x, p.y);
                ctx.lineTo(p.x - p.long * 0.12, p.y - p.long);
                ctx.stroke();
            }
        } else if (spec.type === "neige") {
            for (const p of a.particules) {
                p.y += p.v * dt;
                p.x += Math.sin(a.t * 0.8 + p.ph) * 18 * dt;
                if (p.y - p.r > a.h) creer(p, false);
                ctx.fillStyle = `rgba(255, 255, 255, ${p.a})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            for (const p of a.particules) {
                const scintille = 0.55 + 0.45 * Math.sin(a.t * p.vit + p.ph);
                ctx.fillStyle = `rgba(255, 255, 255, ${(0.25 + 0.6 * scintille).toFixed(3)})`;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    function boucle(t) {
        a.raf = requestAnimationFrame(boucle);
        if (document.hidden) { a.dernier = t; return; }
        if (t - a.dernier < pas) return;
        const dt = a.dernier ? Math.min(0.1, (t - a.dernier) / 1000) : 0;
        a.dernier = t;
        dessiner(dt);
    }

    etat.animation = a;
    if (statique) dessiner(0);
    else a.raf = requestAnimationFrame(boucle);
}

/* ---------------- Rendu ---------------- */

export function appliquerMeteo(meteo, doc = document, date = new Date()) {
    const racine = doc.documentElement;
    const valide = meteo && CATEGORIES.includes(meteo.categorie);
    const nuit = valide ? estNuitMeteo(meteo, date) : false;

    racine.dataset.bjMeteo = valide ? meteo.categorie : "";
    racine.dataset.bjMeteoIntensite = valide ? (meteo.intensite || "moyenne") : "";
    racine.dataset.bjMeteoNuit = nuit ? "oui" : "non";

    const zone = doc.getElementById("bj-meteo");
    if (zone) {
        if (valide) {
            zone.innerHTML = `${iconeMeteo(meteo.categorie, nuit)}<span>${escapeHtml(texteMeteo(meteo))}</span>`;
            zone.title = etat.lieu ? `Météo à ${etat.lieu}` : "Météo";
        } else {
            zone.innerHTML = "";
        }
        zone.classList.toggle("hidden", !valide);
    }

    // Particules seulement avec les fonds « selon l'heure » ou « paysage » et la météo activée.
    // Le paysage dessine lui-même ses étoiles : on n'y garde que la pluie et la neige.
    const fond = racine.dataset.bjFond;
    const actif = (fond === "dynamique" || fond === "paysage") && racine.dataset.bjMeteoFond !== "non";
    let spec = valide && actif ? particulesPour(meteo.categorie, meteo.intensite, nuit) : null;
    if (spec && fond === "paysage" && spec.type === "etoiles") spec = null;
    majPaysage(doc);
    demarrerAnimation(doc.getElementById("bj-meteo-canvas"), spec);
}

function afficherEtatReglages(doc = document) {
    const el = doc.getElementById("bj-meteo-etat");
    if (!el) return;
    const lieu = getDocument("meteo_lieu") || {};
    if (!lieu.nom) {
        el.textContent = "Aucune commune : le fond suit seulement l'heure.";
    } else if (etat.raison === "hors-ligne") {
        el.textContent = `${lieu.nom} : météo indisponible (le serveur n'a pas accès à internet ?).`;
    } else if (etat.meteo) {
        el.textContent = `${lieu.nom} : ${texteMeteo(etat.meteo)}.`;
    } else {
        el.textContent = `${lieu.nom} : météo en cours de chargement…`;
    }
    const retirer = doc.getElementById("bj-meteo-retirer");
    if (retirer) retirer.classList.toggle("hidden", !lieu.nom);
}

export async function chargerMeteo(doc = document) {
    try {
        const data = await api("GET", "/api/meteo");
        etat.meteo = data.meteo || null;
        etat.raison = data.raison || null;
        etat.lieu = data.lieu || "";
    } catch (e) {
        etat.raison = "hors-ligne";   // on garde la dernière météo connue
    }
    appliquerMeteo(etat.meteo, doc);
    afficherEtatReglages(doc);
    return etat.meteo;
}

export function meteoCourante() {
    return etat.meteo;
}

/* ---------------- Réglage de la commune ---------------- */

export async function chercherCommunes(texte) {
    const data = await api("GET", `/api/meteo/communes?q=${encodeURIComponent(texte)}`);
    return Array.isArray(data.communes) ? data.communes : [];
}

export async function choisirCommune(commune, doc = document) {
    const lieu = commune
        ? { nom: String(commune.nom || ""), lat: Number(commune.lat), lon: Number(commune.lon) }
        : { nom: "", lat: null, lon: null };
    await setDocument("meteo_lieu", lieu);
    etat.meteo = null;
    return chargerMeteo(doc);
}

function brancherReglages(doc) {
    const champ = doc.getElementById("bj-meteo-recherche");
    const bouton = doc.getElementById("bj-meteo-chercher");
    const liste = doc.getElementById("bj-meteo-resultats");
    const info = doc.getElementById("bj-meteo-etat");
    if (!champ || !bouton || !liste) return;
    let resultats = [];

    async function rechercher() {
        const texte = champ.value.trim();
        if (texte.length < 2) return;
        bouton.disabled = true;
        liste.innerHTML = "";
        try {
            resultats = await chercherCommunes(texte);
            liste.innerHTML = resultats.length
                ? resultats.map((c, i) => `
                    <li><button type="button" class="bj-resultat" data-index="${i}">
                        <strong>${escapeHtml(c.nom)}</strong><small>${escapeHtml(c.detail || "")}</small>
                    </button></li>`).join("")
                : `<li class="bj-aide">Aucune commune trouvée.</li>`;
        } catch (e) {
            if (info) info.textContent = e.message;
        } finally {
            bouton.disabled = false;
        }
    }

    bouton.addEventListener("click", rechercher);
    champ.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            rechercher();
        }
    });
    liste.addEventListener("click", async e => {
        const b = e.target.closest("[data-index]");
        if (!b) return;
        const c = resultats[Number(b.dataset.index)];
        if (!c) return;
        liste.innerHTML = "";
        champ.value = "";
        await choisirCommune(c, doc);
    });
    doc.getElementById("bj-meteo-retirer")?.addEventListener("click", () => choisirCommune(null, doc));
}

export function initMeteo(doc = document) {
    brancherReglages(doc);
    // Les réglages d'apparence (fond, météo sur le fond) changent les particules
    window.addEventListener("bj-apparence", () => appliquerMeteo(etat.meteo, doc));
    // Une autre commune choisie depuis un autre poste
    window.addEventListener("donnees-modifiees", () => {
        const lieu = getDocument("meteo_lieu") || {};
        if ((lieu.nom || "") !== etat.lieu) chargerMeteo(doc);
    });
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) appliquerMeteo(etat.meteo, doc);
    });

    chargerMeteo(doc);
    clearInterval(etat.minuterie);
    etat.minuterie = setInterval(() => chargerMeteo(doc), INTERVALLE);
    // Jour / nuit quand le symbole ne le précise pas
    setInterval(() => appliquerMeteo(etat.meteo, doc), 5 * 60 * 1000);
}
