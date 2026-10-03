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

export function parsePeremption(dateStr) {
    if (!dateStr) return null;
    let closestDate = null;
    const parts = String(dateStr).split(/[,;\s]+/).filter(p => p.trim() !== "");
    for (const p of parts) {
        let d = null;
        let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(p.trim());
        if (m) {
            d = dateStricte(+m[3], +m[2], +m[1]);
        } else {
            m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(p.trim());
            if (m) d = dateStricte(+m[1], +m[2], +m[3]);
        }
        if (d) {
            if (!closestDate || d.getTime() < closestDate.getTime()) {
                closestDate = d;
            }
        }
    }
    return closestDate;
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

export function showMessage(title, text) {
    return new Promise(resolve => {
        const overlay = document.getElementById("msg-overlay");
        document.getElementById("msg-title").textContent = title;
        document.getElementById("msg-text").textContent = text;
        overlay.classList.remove("hidden");

        const btn = document.getElementById("msg-ok");
        const done = () => {
            overlay.classList.add("hidden");
            btn.removeEventListener("click", done);
            resolve();
        };
        btn.addEventListener("click", done);
        btn.focus();
    });
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

