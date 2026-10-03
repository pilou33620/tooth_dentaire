"use strict";

/* ============================================================
   Lots - Gestion des quantités par numéro de lot

   Format stocké dans stock.lots_details (JSON) :
     [ { lot: "LOT-A", date: "31/12/2026", qte: 5 }, ... ]

   Les anciennes entrées (sans "qte") sont complétées à la lecture :
   la quantité totale de l'article est répartie sur les lots qui
   n'ont pas de quantité, afin de rester compatible avec les bases
   déjà en place.
   ============================================================ */

import { parsePeremption } from '../core/utils.js';

/** Convertit une valeur en entier >= 0, ou null si non renseignée. */
function toQte(val) {
    if (val === undefined || val === null || val === "") return null;
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 0) return null;
    return n;
}

/** Convertit une valeur en entier >= 0 (0 si invalide). */
export function toInt(val) {
    const n = parseInt(val, 10);
    return (isNaN(n) || n < 0) ? 0 : n;
}

/**
 * Lit lots_details (chaîne JSON ou tableau) et retourne
 * [{ lot, date, qte }] où qte peut être null (quantité inconnue).
 */
export function parseLots(raw) {
    let arr = [];
    if (Array.isArray(raw)) {
        arr = raw;
    } else if (typeof raw === "string" && raw.trim() !== "") {
        try {
            arr = JSON.parse(raw);
        } catch (e) {
            arr = [];
        }
    }
    if (!Array.isArray(arr)) return [];

    return arr
        .filter(x => x && typeof x === "object")
        .map(x => ({
            lot: String(x.lot ?? "").trim(),
            date: String(x.date ?? "").trim(),
            qte: toQte(x.qte)
        }))
        .filter(x => x.lot !== "" || x.date !== "" || x.qte !== null);
}

/**
 * Comme parseLots, mais complète les quantités manquantes en
 * répartissant le reliquat de la quantité totale de l'article.
 */
export function normalizeLots(raw, quantiteTotale = null) {
    const lots = parseLots(raw);
    if (lots.length === 0) return [];

    const sansQte = lots.filter(l => l.qte === null);
    if (sansQte.length === 0) return lots;

    if (quantiteTotale === null || quantiteTotale === undefined || quantiteTotale === "") {
        sansQte.forEach(l => { l.qte = 0; });
        return lots;
    }

    const connu = lots.reduce((s, l) => s + (l.qte || 0), 0);
    let reste = Math.max(0, toInt(quantiteTotale) - connu);

    const base = Math.floor(reste / sansQte.length);
    let extra = reste - base * sansQte.length;
    sansQte.forEach(l => {
        l.qte = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
    });
    return lots;
}

/** Sérialise une liste de lots pour la colonne lots_details. */
export function serializeLots(lots) {
    const clean = (lots || [])
        .map(l => ({
            lot: String(l.lot ?? "").trim(),
            date: String(l.date ?? "").trim(),
            qte: toInt(l.qte)
        }))
        .filter(l => l.lot !== "" || l.date !== "" || l.qte > 0);
    return JSON.stringify(clean);
}

/** Somme des quantités des lots. */
export function totalLots(lots) {
    return (lots || []).reduce((s, l) => s + toInt(l.qte), 0);
}

/** "LOT-A, LOT-B" - valeur stockée dans stock.lot (sans quantités). */
export function lotsToString(lots) {
    return (lots || []).map(l => l.lot).filter(l => l && l.trim() !== "").join(", ");
}

/** "31/12/2026, 15/06/2027" - valeur stockée dans stock.date_peremption. */
export function datesToString(lots) {
    return (lots || []).map(l => l.date).filter(d => d && d.trim() !== "").join(", ");
}

/** Libellé d'affichage avec les quantités : "LOT-A ×5, LOT-B ×3". */
export function lotsLabel(lots) {
    return (lots || [])
        .filter(l => (l.lot && l.lot.trim() !== "") || toInt(l.qte) > 0)
        .map(l => {
            const nom = (l.lot && l.lot.trim() !== "") ? l.lot : "sans n°";
            return `${nom} ×${toInt(l.qte)}`;
        })
        .join(", ");
}

/**
 * Construit des lots quantifiés depuis une saisie "à l'ancienne"
 * (chaînes "LOT-A, LOT-B" et "31/12/2026, 15/06/2027").
 * La quantité est répartie équitablement sur les lots saisis.
 */
export function lotsFromStrings(lotStr, dateStr, quantite) {
    const split = v => String(v ?? "").split(/[,;]+/).map(s => s.trim()).filter(s => s !== "");
    const lots = split(lotStr);
    const dates = split(dateStr);
    const nb = Math.max(lots.length, dates.length);
    if (nb === 0) return [];

    const total = toInt(quantite);
    const base = Math.floor(total / nb);
    let extra = total - base * nb;

    const result = [];
    for (let i = 0; i < nb; i++) {
        const part = base + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
        result.push({ lot: lots[i] || "", date: dates[i] || "", qte: part });
    }
    return result;
}

/** Trie les lots par péremption la plus proche (FEFO), sans date en dernier. */
export function sortLotsFEFO(lots) {
    return [...(lots || [])].sort((a, b) => {
        const da = parsePeremption(a.date);
        const db = parsePeremption(b.date);
        if (da && db) return da.getTime() - db.getTime();
        if (da) return -1;
        if (db) return 1;
        return 0;
    });
}

function memeLot(a, b) {
    return String(a.lot ?? "").trim() === String(b.lot ?? "").trim()
        && String(a.date ?? "").trim() === String(b.date ?? "").trim();
}

/**
 * Fusionne deux listes de lots : les quantités des lots identiques
 * (même numéro ET même péremption) sont additionnées.
 */
export function mergeLots(existants, nouveaux) {
    const result = (existants || []).map(l => ({ lot: l.lot, date: l.date, qte: toInt(l.qte) }));
    for (const n of (nouveaux || [])) {
        const cible = result.find(l => memeLot(l, n));
        if (cible) {
            cible.qte += toInt(n.qte);
        } else {
            result.push({ lot: String(n.lot ?? "").trim(), date: String(n.date ?? "").trim(), qte: toInt(n.qte) });
        }
    }
    return result;
}

/** Regroupe les sorties portant sur le même lot. */
function fusionnerSorties(sorties) {
    const result = [];
    for (const s of sorties) {
        const cible = result.find(x => memeLot(x, s));
        if (cible) cible.qte += toInt(s.qte);
        else result.push({ lot: s.lot, date: s.date, qte: toInt(s.qte) });
    }
    return result;
}

/**
 * Retire des quantités sur des lots précis.
 * @param {Array}  lots     liste normalisée [{lot, date, qte}]
 * @param {Array}  demandes [{ index?, lot?, date?, qte }]
 * @returns {{ok, message, lots, sorties}} lots = liste restante (lots vidés supprimés)
 */
export function retirerDesLots(lots, demandes) {
    const restants = (lots || []).map(l => ({ lot: l.lot, date: l.date, qte: toInt(l.qte) }));
    const sorties = [];

    for (const d of (demandes || [])) {
        const qte = toInt(d.qte);
        if (qte <= 0) continue;

        let cible = null;
        if (Number.isInteger(d.index) && restants[d.index]) {
            cible = restants[d.index];
        } else {
            cible = restants.find(l => memeLot(l, d));
        }

        if (!cible) {
            return {
                ok: false,
                message: `Lot introuvable : ${d.lot || "(sans numéro)"}.`,
                lots: (lots || []).map(l => ({ ...l })),
                sorties: []
            };
        }
        if (cible.qte < qte) {
            const nom = cible.lot || "(sans numéro)";
            return {
                ok: false,
                message: `Quantité insuffisante sur le lot ${nom} : ${cible.qte} en stock, ${qte} demandé(s).`,
                lots: (lots || []).map(l => ({ ...l })),
                sorties: []
            };
        }

        cible.qte -= qte;
        sorties.push({ lot: cible.lot, date: cible.date, qte });
    }

    return {
        ok: true,
        message: "",
        lots: restants.filter(l => l.qte > 0),
        sorties: fusionnerSorties(sorties)
    };
}

/**
 * Répartit automatiquement une sortie sur les lots, du plus proche
 * de la péremption au plus lointain (FEFO).
 * @returns {{demandes, reste}} reste = quantité non couverte par les lots
 */
export function retirerFEFO(lots, quantite) {
    let reste = toInt(quantite);
    const demandes = [];

    for (const l of sortLotsFEFO(lots)) {
        if (reste <= 0) break;
        const dispo = toInt(l.qte);
        if (dispo <= 0) continue;
        const prise = Math.min(dispo, reste);
        demandes.push({ index: lots.indexOf(l), lot: l.lot, date: l.date, qte: prise });
        reste -= prise;
    }

    return { demandes, reste };
}

/**
 * Applique une liste de lots sur une entrée de stock :
 * met à jour lots_details, lot et date_peremption de façon cohérente.
 */
export function appliquerLots(entry, lots) {
    const clean = (lots || []).filter(l => toInt(l.qte) > 0 || (l.lot && l.lot.trim() !== "") || (l.date && l.date.trim() !== ""));
    entry.lots_details = serializeLots(clean);
    entry.lot = lotsToString(clean);
    entry.date_peremption = datesToString(clean);
}
