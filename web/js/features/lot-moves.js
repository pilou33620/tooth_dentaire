"use strict";

/* ============================================================
   Entrée / Sortie de stock lot par lot (LotMoveDialog)

   - Mode "entree" : saisir X quantités à ajouter sur chaque lot
                     (et créer de nouveaux lots au besoin).
   - Mode "sortie" : sortir X quantités d'un ou plusieurs lots précis.
   ============================================================ */

import { parsePeremption, daysUntil, showMessage } from '../core/utils.js';
import { sortLotsFEFO, toInt, lotsPerimesEntrants, messageLotsPerimes } from './lots.js';
import { sortirStockDetail, ajouterStockParLots } from './stock.js';

/** Lignes de saisie du dialogue en cours. */
let lignes = [];
let modeCourant = "sortie";

function el(id) {
    return document.getElementById(id);
}

/** Classe de ligne (rouge / orange) selon la date de péremption. */
function classePeremption(dateStr, delai) {
    const d = parsePeremption(dateStr);
    if (!d) return "";
    const delta = daysUntil(d);
    if (delta < 0) return "row-red";
    if (delta <= 1) return "row-red";
    if (delta <= (parseInt(delai, 10) || 30)) return "row-orange";
    return "";
}

/** Suffixe informatif sur la péremption ("périmé", "J-5"...). */
function infoPeremption(dateStr) {
    const d = parsePeremption(dateStr);
    if (!d) return "";
    const delta = daysUntil(d);
    if (delta < 0) return " ⚠️ périmé";
    if (delta === 0) return " ⚠️ aujourd'hui";
    if (delta <= 30) return ` (J-${delta})`;
    return "";
}

function creerInputQte(max) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "input lot-move-qte";
    input.min = 0;
    if (max !== null && max !== undefined) input.max = max;
    input.value = 0;
    input.addEventListener("input", majTotal);
    input.addEventListener("focus", () => input.select());
    return input;
}

function creerInputTexte(valeur, placeholder, cls) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = `input ${cls}`;
    input.placeholder = placeholder;
    input.value = valeur || "";
    return input;
}

/** Ajoute une ligne dans le tableau du dialogue. */
function ajouterLigne(cfg) {
    const tbody = el("lot-move-tbody");
    const tr = document.createElement("tr");

    const ligne = {
        index: cfg.index !== undefined ? cfg.index : null,
        lot: cfg.lot || "",
        date: cfg.date || "",
        dispo: cfg.dispo,
        horsLot: !!cfg.horsLot,
        libre: !!cfg.libre,
        nouveau: !!cfg.nouveau,
        lotInput: null,
        dateInput: null,
        qteInput: null
    };

    const rowClass = cfg.libre || cfg.nouveau ? "" : classePeremption(cfg.date, cfg.delai);
    if (rowClass) tr.className = rowClass;

    // N° de lot
    const tdLot = document.createElement("td");
    if (cfg.libre || cfg.nouveau) {
        ligne.lotInput = creerInputTexte(cfg.lot, "Numéro de lot", "lot-move-lot");
        tdLot.appendChild(ligne.lotInput);
    } else {
        tdLot.textContent = cfg.lot && cfg.lot.trim() !== "" ? cfg.lot : "(sans n° de lot)";
        if (cfg.premierFEFO) {
            const badge = document.createElement("span");
            badge.className = "lot-move-badge";
            badge.textContent = "à sortir en premier";
            tdLot.appendChild(badge);
        }
    }

    // Péremption
    const tdDate = document.createElement("td");
    if (cfg.libre || cfg.nouveau) {
        ligne.dateInput = creerInputTexte(cfg.date, "JJ/MM/AAAA", "lot-move-date");
        tdDate.appendChild(ligne.dateInput);
    } else {
        tdDate.textContent = (cfg.date || "—") + infoPeremption(cfg.date);
    }

    // Quantité en stock
    const tdDispo = document.createElement("td");
    tdDispo.className = "center";
    tdDispo.textContent = cfg.dispo === null || cfg.dispo === undefined ? "—" : String(cfg.dispo);

    // Quantité à sortir / à ajouter
    const tdQte = document.createElement("td");
    tdQte.className = "center";
    ligne.qteInput = creerInputQte(modeCourant === "sortie" ? cfg.dispo : null);
    tdQte.appendChild(ligne.qteInput);

    // Action de la ligne
    const tdAction = document.createElement("td");
    tdAction.className = "center";
    if (cfg.nouveau) {
        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "btn btn-small";
        btnDel.textContent = "✕";
        btnDel.title = "Retirer cette ligne";
        btnDel.onclick = () => {
            lignes = lignes.filter(l => l !== ligne);
            tr.remove();
            majTotal();
        };
        tdAction.appendChild(btnDel);
    } else if (modeCourant === "sortie" && cfg.dispo > 0) {
        const btnAll = document.createElement("button");
        btnAll.type = "button";
        btnAll.className = "btn btn-small";
        btnAll.textContent = "Tout";
        btnAll.title = "Sortir la totalité de ce lot";
        btnAll.onclick = () => {
            ligne.qteInput.value = cfg.dispo;
            majTotal();
        };
        tdAction.appendChild(btnAll);
    }

    tr.append(tdLot, tdDate, tdDispo, tdQte, tdAction);
    tbody.appendChild(tr);
    lignes.push(ligne);
    return ligne;
}

/** Recalcule et affiche le total saisi. */
function majTotal() {
    let total = 0;
    for (const l of lignes) {
        total += toInt(l.qteInput.value);
    }
    const libelle = modeCourant === "sortie" ? "Total à sortir" : "Total à ajouter";
    el("lot-move-total").textContent = `${libelle} : ${total} unité(s)`;
    return total;
}

/**
 * Ouvre le dialogue de mouvement par lot.
 * @param {object} row     ligne de stock issue de getStock()
 * @param {string} mode    "sortie" (défaut) ou "entree"
 * @param {object} options { prefill } quantité pré-remplie sur le 1er lot (mode sortie)
 * @returns {Promise<boolean>} true si un mouvement a été enregistré
 */
export function openLotMoveDialog(row, mode = "sortie", options = {}) {
    modeCourant = mode === "entree" ? "entree" : "sortie";
    lignes = [];

    const overlay = el("lot-move-overlay");
    const tbody = el("lot-move-tbody");
    tbody.innerHTML = "";

    const estSortie = modeCourant === "sortie";
    el("lot-move-title").textContent = estSortie ? "Sortie de stock par lot" : "Entrée de stock par lot";
    el("lot-move-th-qte").textContent = estSortie ? "Qté à sortir" : "Qté à ajouter";
    el("lot-move-save").textContent = estSortie ? "Sortir" : "Ajouter";
    el("lot-move-save").className = estSortie ? "btn btn-blue" : "btn btn-green";

    const nom = row.nom ? ` — ${row.nom}` : "";
    el("lot-move-info").textContent =
        `${row.reference}${nom} (${row.utilisateur}) · Stock total : ${row.quantite} unité(s)`;

    const lots = Array.isArray(row.lots) ? row.lots : [];
    const lotsOrdonnes = sortLotsFEFO(lots);

    lotsOrdonnes.forEach((l, i) => {
        ajouterLigne({
            index: lots.indexOf(l),
            lot: l.lot,
            date: l.date,
            dispo: toInt(l.qte),
            delai: row.delai_peremption,
            premierFEFO: estSortie && i === 0 && lotsOrdonnes.length > 1
        });
    });

    // Quantité en stock non rattachée à un lot
    const sansLot = toInt(row.quantite_sans_lot);
    if (estSortie && lots.length > 0 && sansLot > 0) {
        ajouterLigne({ lot: "", date: "", dispo: sansLot, horsLot: true, delai: row.delai_peremption });
    }

    // Aucun lot enregistré : saisie libre (traçabilité) en sortie,
    // nouvelle ligne de lot en entrée
    if (lots.length === 0) {
        if (estSortie) {
            ajouterLigne({ lot: "", date: row.date_peremption || "", dispo: toInt(row.quantite), libre: true });
        } else {
            ajouterLigne({ lot: "", date: "", dispo: null, nouveau: true });
        }
    }

    // Pré-remplissage (clic sur "-" : 1 unité sur le lot le plus urgent)
    const prefill = toInt(options.prefill);
    if (prefill > 0 && lignes.length > 0) {
        const cible = lignes.find(l => l.dispo === null || l.dispo >= prefill) || lignes[0];
        cible.qteInput.value = prefill;
    }

    const btnAdd = el("lot-move-add");
    if (estSortie) {
        btnAdd.classList.add("hidden");
    } else {
        btnAdd.classList.remove("hidden");
    }

    majTotal();
    overlay.classList.remove("hidden");
    const premier = lignes.length > 0 ? lignes[0].qteInput : null;
    if (premier) premier.focus();

    return new Promise(resolve => {
        const btnSave = el("lot-move-save");
        const btnAnnuler = el("lot-move-cancel");
        const btnClose = el("lot-move-close");

        const fermer = (resultat) => {
            overlay.classList.add("hidden");
            btnSave.removeEventListener("click", onSave);
            btnAnnuler.removeEventListener("click", onCancel);
            btnClose.removeEventListener("click", onCancel);
            btnAdd.removeEventListener("click", onAdd);
            lignes = [];
            resolve(resultat);
        };

        const onCancel = () => fermer(false);

        const onAdd = () => {
            ajouterLigne({ lot: "", date: "", dispo: null, nouveau: true });
            majTotal();
        };

        const onSave = async () => {
            const res = estSortie ? await validerSortie(row) : await validerEntree(row);
            if (res) fermer(true);
        };

        btnSave.addEventListener("click", onSave);
        btnAnnuler.addEventListener("click", onCancel);
        btnClose.addEventListener("click", onCancel);
        btnAdd.addEventListener("click", onAdd);
    });
}

/** Valide et exécute la sortie. Retourne true si le stock a été modifié. */
async function validerSortie(row) {
    const sorties = [];
    let horsLot = 0;
    let lotLibre = "";
    let dateLibre = "";
    let total = 0;

    for (const l of lignes) {
        const qte = toInt(l.qteInput.value);
        if (qte <= 0) continue;

        if (l.dispo !== null && qte > l.dispo) {
            const nom = l.lot || (l.horsLot ? "sans n° de lot" : "ce lot");
            await showMessage("Quantité trop élevée", `Le lot ${nom} ne contient que ${l.dispo} unité(s).`);
            return false;
        }

        total += qte;

        if (l.libre) {
            lotLibre = (l.lotInput.value || "").trim();
            dateLibre = (l.dateInput.value || "").trim();
            if (lotLibre === "") horsLot += qte;
        } else if (l.horsLot) {
            horsLot += qte;
        } else {
            sorties.push({ index: l.index, lot: l.lot, date: l.date, qte });
        }
    }

    if (total <= 0) {
        await showMessage("Aucune quantité", "Saisir la quantité à sortir sur au moins un lot.");
        return false;
    }

    const res = sortirStockDetail(row.reference, total, row.utilisateur, {
        sorties,
        hors_lot: horsLot,
        lot: lotLibre,
        date: dateLibre
    });

    if (!res.ok) {
        await showMessage("Sortie impossible", res.message);
        return false;
    }
    return true;
}

/** Valide et exécute l'entrée. Retourne true si le stock a été modifié. */
async function validerEntree(row) {
    const entrees = [];
    let total = 0;

    for (const l of lignes) {
        const qte = toInt(l.qteInput.value);
        if (qte <= 0) continue;

        const lot = l.lotInput ? (l.lotInput.value || "").trim() : l.lot;
        const date = l.dateInput ? (l.dateInput.value || "").trim() : l.date;

        if (l.nouveau && lot === "" && date === "") {
            await showMessage("Lot incomplet", "Saisir un numéro de lot (ou une date de péremption) pour la nouvelle ligne.");
            return false;
        }
        if (date !== "" && !parsePeremption(date)) {
            await showMessage("Date invalide", `La date de péremption « ${date} » n'est pas au format JJ/MM/AAAA.`);
            return false;
        }

        entrees.push({ lot, date, qte });
        total += qte;
    }

    if (total <= 0) {
        await showMessage("Aucune quantité", "Saisir la quantité à ajouter sur au moins un lot.");
        return false;
    }

    // Un produit déjà périmé ne peut pas entrer en stock
    const perimes = lotsPerimesEntrants([], entrees);
    if (perimes.length > 0) {
        await showMessage("⛔ Produit périmé", messageLotsPerimes(perimes));
        return false;
    }

    const res = ajouterStockParLots(row.reference, row.utilisateur, entrees);
    if (!res.ok) {
        await showMessage("Entrée impossible", res.message);
        return false;
    }
    return true;
}

// Export to window for global access
window.openLotMoveDialog = openLotMoveDialog;
