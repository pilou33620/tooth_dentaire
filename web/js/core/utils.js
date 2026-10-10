"use strict";

/* ============================================================
   Utils - Fonctions utilitaires
   ============================================================ */

import { getAllGroups } from './database.js';
import { USERS } from './constants.js';

/**
 * Construit une date en refusant les jours qui n'existent pas.
 * `new Date(2026, 1, 31)` glisse silencieusement au 3 mars : on vérifie donc
 * que la date obtenue redonne bien le jour/mois/année demandés.
 */
function dateStricte(annee, mois, jour) {
    if (mois < 1 || mois > 12 || jour < 1 || jour > 31) return null;
    const d = new Date(annee, mois - 1, jour);
    if (d.getFullYear() !== annee || d.getMonth() !== mois - 1 || d.getDate() !== jour) {
        return null;
    }
    return d;
}

/** Dernier jour d'un mois (un produit marqué « 05/2027 » périme fin mai). */
function finDeMois(annee, mois) {
    if (mois < 1 || mois > 12) return null;
    return new Date(annee, mois, 0);
}

/**
 * Date d'une péremption écrite seule, ou null. Formats acceptés (les mêmes
 * que le serveur, python/base.py date_peremption) : JJ/MM/AAAA, JJ/MM/AA,
 * AAAA-MM-JJ, MM/AAAA et AAAA-MM (fin du mois).
 */
export function dateDePeremption(texte) {
    const p = String(texte ?? "").trim();
    let m;
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(p))) return dateStricte(+m[3], +m[2], +m[1]);
    if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(p))) return dateStricte(2000 + +m[3], +m[2], +m[1]);
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(p))) return dateStricte(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})\/(\d{4})$/.exec(p))) return finDeMois(+m[2], +m[1]);
    if ((m = /^(\d{4})-(\d{1,2})$/.exec(p))) return finDeMois(+m[1], +m[2]);
    return null;
}

function partiesPeremption(dateStr) {
    return String(dateStr ?? "").split(/[,;\s]+/).map(p => p.trim()).filter(p => p !== "");
}

/** Plus proche date de péremption d'un texte (plusieurs dates possibles). */
export function parsePeremption(dateStr) {
    if (!dateStr) return null;
    let closestDate = null;
    for (const p of partiesPeremption(dateStr)) {
        const d = dateDePeremption(p);
        if (d && (!closestDate || d.getTime() < closestDate.getTime())) closestDate = d;
    }
    return closestDate;
}

/**
 * Parties illisibles d'une saisie de péremption (vide = tout est lisible).
 * Une date illisible n'aurait jamais déclenché d'alerte de péremption.
 */
export function datesIllisibles(dateStr) {
    return partiesPeremption(dateStr).filter(p => !dateDePeremption(p));
}

export const MESSAGE_FORMATS_DATE =
    "Formats acceptés : JJ/MM/AAAA (15/03/2027), MM/AAAA (03/2027), AAAA-MM-JJ.";

/**
 * Échéance d'un rappel en millisecondes, ou null : accepte un nombre, un
 * nombre écrit en texte ou une date ISO (« 2027-01-15 »). Une valeur
 * illisible est traitée comme « non définie » (et non comme jamais due).
 */
export function tempsRappel(valeur) {
    if (valeur === null || valeur === undefined || valeur === "" || typeof valeur === "boolean") return null;
    let t = Number(valeur);
    if (!Number.isFinite(t) && typeof valeur === "string") t = Date.parse(valeur);
    return Number.isFinite(t) && t > 0 ? t : null;
}

export function daysUntil(date) {
    if (!date) return 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
}

export function todayFR() {
    const n = new Date();
    const pad = x => String(x).padStart(2, "0");
    return `${pad(n.getDate())}/${pad(n.getMonth() + 1)}/${n.getFullYear()}`;
}

// Fermeture du message affiché (null s'il n'y en a pas)
let fermerMessageCourant = null;

export function showMessage(title, text) {
    // Un message encore ouvert est fermé proprement (sa promesse est résolue)
    if (fermerMessageCourant) fermerMessageCourant();
    return new Promise(resolve => {
        const overlay = document.getElementById("msg-overlay");
        document.getElementById("msg-title").textContent = title;
        document.getElementById("msg-text").textContent = text;
        overlay.classList.remove("hidden");

        const btn = document.getElementById("msg-ok");
        const done = () => {
            overlay.classList.add("hidden");
            btn.removeEventListener("click", done);
            if (fermerMessageCourant === done) fermerMessageCourant = null;
            resolve();
        };
        fermerMessageCourant = done;
        btn.addEventListener("click", done);
        btn.focus();
    });
}

/**
 * Ferme le message affiché comme un clic sur OK : le code qui attend
 * showMessage() continue (masquer seulement la fenêtre le laissait bloqué).
 */
export function fermerMessage() {
    if (fermerMessageCourant) {
        fermerMessageCourant();
    } else {
        document.getElementById("msg-overlay")?.classList.add("hidden");
    }
}

export function fillUserSelect(select, selected) {
    select.innerHTML = "";
    for (const u of USERS) {
        const opt = document.createElement("option");
        opt.value = u;
        opt.textContent = u;
        if (u === selected) opt.selected = true;
        select.appendChild(opt);
    }
}

export function fillGroupsDatalist() {
    const dl = document.getElementById("groups-list");
    dl.innerHTML = "";
    for (const g of getAllGroups()) {
        const opt = document.createElement("option");
        opt.value = g;
        dl.appendChild(opt);
    }
}

export function parseNombreFR(s) {
    if (typeof s === "number") return s;
    if (!s) return 0;
    let str = String(s).trim();
    if (str.includes(",")) {
        str = str.replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
    } else {
        str = str.replace(/\s/g, "");
    }
    return parseFloat(str) || 0;
}

export function round2(n) {
    return Math.round(n * 100) / 100;
}

export function round4(n) {
    return Math.round(n * 10000) / 10000;
}

/**
 * Découpe une chaîne ou un tableau de références scannette en une liste de codes uniques et nettoyés.
 * Accepte les séparateurs virgule, point-virgule, retours à la ligne ou espaces multiples.
 */
export function parseBarcodes(val) {
    if (!val) return [];
    const rawList = Array.isArray(val) ? val : [val];
    const result = [];
    const seen = new Set();

    for (const item of rawList) {
        if (!item) continue;
        const parts = String(item).split(/[,;\n\r\t]+/).map(s => s.trim()).filter(Boolean);
        for (const p of parts) {
            if (!seen.has(p)) {
                seen.add(p);
                result.push(p);
            }
        }
    }
    return result;
}

/**
 * Formate une ou plusieurs références scannette en une chaîne standardisée séparée par des virgules.
 */
export function formatBarcodes(val) {
    return parseBarcodes(val).join(", ");
}

/**
 * Fusionne deux ensembles de références scannette sans doublons.
 */
export function mergeBarcodes(val1, val2) {
    const list1 = parseBarcodes(val1);
    const list2 = parseBarcodes(val2);
    return formatBarcodes([...list1, ...list2]);
}

/**
 * Vérifie si un code scanné correspond à l'un des codes d'une référence scannette.
 */
export function matchesBarcode(refScannette, code) {
    if (!code) return false;
    const target = String(code).trim().toLowerCase();
    if (!target) return false;
    const codes = parseBarcodes(refScannette);
    return codes.some(c => c.toLowerCase() === target);
}

/**
 * Assainit une chaîne pour affichage sécurisé dans du code HTML (évite les attaques XSS).
 */
export function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

if (typeof window !== "undefined") {
    window.escapeHtml = escapeHtml;
}

