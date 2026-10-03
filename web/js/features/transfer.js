"use strict";

/* ============================================================
   Transfert Espace
   ============================================================ */

import { USERS } from '../core/constants.js';
import { loadDB, saveDB, findStockEntry, findProduit, addTransaction, persister } from '../core/database.js';
import { checkAlerts } from './alerts.js';
import { todayFR } from '../core/utils.js';
import { normalizeLots, lotsFromStrings, mergeLots, retirerFEFO, retirerDesLots, appliquerLots, serializeLots, lotsToString, datesToString } from './lots.js';

export function openTransferDialog() {
    document.getElementById("transfer-ref").value = "";
    document.getElementById("transfer-qte").value = "1";

    const selSource = document.getElementById("transfer-source");
    const selDest = document.getElementById("transfer-dest");
    selSource.innerHTML = "";
    selDest.innerHTML = "";

    USERS.forEach(u => {
        selSource.insertAdjacentHTML("beforeend", `<option value="${u}">${u}</option>`);
        selDest.insertAdjacentHTML("beforeend", `<option value="${u}">${u}</option>`);
    });

    document.getElementById("transfer-overlay").classList.remove("hidden");
}

export function saveTransferDialog() {
    const ref = document.getElementById("transfer-ref").value.trim();
    const source = document.getElementById("transfer-source").value;
    const dest = document.getElementById("transfer-dest").value;
    const qte = parseInt(document.getElementById("transfer-qte").value, 10);

    if (!ref) {
        alert("Veuillez saisir une référence.");
        return;
    }
    if (source === dest) {
        alert("La source et la destination doivent être différentes.");
        return;
    }
    if (isNaN(qte) || qte <= 0) {
        alert("La quantité doit être supérieure à 0.");
        return;
    }

    let db = loadDB();

    let sourceEntry = findStockEntry(db, ref, source);
    if (!sourceEntry || sourceEntry.quantite < qte) {
        alert("Quantité insuffisante dans l'espace source.");
        return;
    }

    // Les lots transférés sont prélevés en FEFO (péremption la plus proche d'abord)
    let lotsSource = normalizeLots(sourceEntry.lots_details, sourceEntry.quantite);
    if (lotsSource.length === 0 && sourceEntry.lot && String(sourceEntry.lot).trim() !== "") {
        lotsSource = lotsFromStrings(sourceEntry.lot, sourceEntry.date_peremption, sourceEntry.quantite);
    }

    let lotsTransferes = [];
    if (lotsSource.length > 0) {
        const res = retirerDesLots(lotsSource, retirerFEFO(lotsSource, qte).demandes);
        if (!res.ok) {
            alert(res.message);
            return;
        }
        lotsTransferes = res.sorties;
        appliquerLots(sourceEntry, res.lots);
    }

    sourceEntry.quantite -= qte;
    if (sourceEntry.quantite <= 0) {
        sourceEntry.quantite = 0;
        sourceEntry.date_peremption = "";
        sourceEntry.lot = "";
        sourceEntry.lots_details = "[]";
    }
    for (const l of lotsTransferes) {
        addTransaction(db, ref, source, "Sortie (Transfert)", l.qte, l.lot, l.date || "");
    }
    const qteHorsLot = qte - lotsTransferes.reduce((acc, l) => acc + l.qte, 0);
    if (qteHorsLot > 0 || lotsTransferes.length === 0) {
        addTransaction(db, ref, source, "Sortie (Transfert)", qteHorsLot > 0 ? qteHorsLot : qte);
    }

    let destEntry = findStockEntry(db, ref, dest);
    if (destEntry) {
        destEntry.quantite += qte;
        if (!destEntry.fournisseur && sourceEntry.fournisseur) destEntry.fournisseur = sourceEntry.fournisseur;
        if (!destEntry.prix_unitaire_ht && sourceEntry.prix_unitaire_ht) destEntry.prix_unitaire_ht = sourceEntry.prix_unitaire_ht;
        if (!destEntry.prix_unitaire_ttc && sourceEntry.prix_unitaire_ttc) destEntry.prix_unitaire_ttc = sourceEntry.prix_unitaire_ttc;
        if (lotsTransferes.length > 0) {
            // Les quantités transférées sont ajoutées aux lots de destination
            let destLots = normalizeLots(destEntry.lots_details, destEntry.quantite - qte);
            if (destLots.length === 0 && destEntry.lot && String(destEntry.lot).trim() !== "") {
                destLots = lotsFromStrings(destEntry.lot, destEntry.date_peremption, destEntry.quantite - qte);
            }
            appliquerLots(destEntry, mergeLots(destLots, lotsTransferes));
        } else if (sourceEntry.date_peremption || sourceEntry.lot) {
            if (!destEntry.date_peremption) destEntry.date_peremption = sourceEntry.date_peremption;
            if (!destEntry.lot) destEntry.lot = sourceEntry.lot;
        }
    } else {
        db.stock.push({
            reference: ref,
            utilisateur: dest,
            quantite: qte,
            stock_minimum: sourceEntry.stock_minimum || 0,
            alerte_active: sourceEntry.alerte_active || false,
            alerte_peremption_active: sourceEntry.alerte_peremption_active !== undefined ? sourceEntry.alerte_peremption_active : 0,
            delai_peremption: sourceEntry.delai_peremption !== undefined ? sourceEntry.delai_peremption : 30,
            date_peremption: lotsTransferes.length > 0 ? datesToString(lotsTransferes) : (sourceEntry.date_peremption || ""),
            // todayFR() et non toISOString() : partout ailleurs date_import est
            // au format JJ/MM/AAAA, et une date ISO cassait le tri de la
            // colonne « Date Import » du placard en plus de s'afficher brute.
            date_import: sourceEntry.date_import || todayFR(),
            fournisseur: sourceEntry.fournisseur || "",
            prix_unitaire_ht: sourceEntry.prix_unitaire_ht || 0,
            prix_unitaire_ttc: sourceEntry.prix_unitaire_ttc || 0,
            lot: lotsTransferes.length > 0 ? lotsToString(lotsTransferes) : (sourceEntry.lot || ""),
            lots_details: lotsTransferes.length > 0 ? serializeLots(lotsTransferes) : "[]"
        });

        let prod = findProduit(db, ref);
        if (!prod) {
            const newProd = { reference: ref, nom: "Inconnu", groupe: "Général" };
            db.produits.push(newProd);
            persister("updateProduit", JSON.stringify(newProd));
        }
    }
    if (lotsTransferes.length > 0) {
        for (const l of lotsTransferes) {
            addTransaction(db, ref, dest, "Entrée (Transfert)", l.qte, l.lot, l.date || "");
        }
        if (qteHorsLot > 0) {
            addTransaction(db, ref, dest, "Entrée (Transfert)", qteHorsLot);
        }
    } else {
        addTransaction(db, ref, dest, "Entrée (Transfert)", qte);
    }

    persister("updateStockItem", JSON.stringify(sourceEntry));
    persister("updateStockItem", JSON.stringify(findStockEntry(db, ref, dest)));

    saveDB(db);
    document.getElementById("transfer-overlay").classList.add("hidden");

    if (typeof window.refreshPlacardTable === "function") {
        window.refreshPlacardTable();
    }
    checkAlerts();
}

// Export to window for global access
window.openTransferDialog = openTransferDialog;
window.saveTransferDialog = saveTransferDialog;
