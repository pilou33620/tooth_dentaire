"use strict";

/* ============================================================
   Placard (PlacardDialog)
   ============================================================ */

import { ESPACES_SUIVI_LOT } from '../core/constants.js';
import { loadDB, saveDB, findProduit, persister } from '../core/database.js';
import { getStock, sortirStock, setStockAbsolu, ajouterStockParLots } from './stock.js';
import { openLotMoveDialog } from './lot-moves.js';
import { parsePeremption, daysUntil, showMessage } from '../core/utils.js';
import { checkAlerts } from './alerts.js';

export let placardUser = null;
export let placardSort = { col: null, asc: true };

window.isTrousseSecours = false;
window.isMEOPA = false;

export function openPlacard(utilisateur, searchRef = null) {
    window.isTrousseSecours = false;
    window.isMEOPA = false;
    placardUser = utilisateur;
    placardSort = { col: null, asc: true };
    const isTous = utilisateur === "TOUS";
    document.getElementById("placard-title-bar").textContent = isTous ? "Recherche Globale" : `Placard - ${utilisateur}`;
    document.getElementById("placard-title").textContent = isTous ? "Tous les espaces" : `Contenu du Placard (${utilisateur})`;

    const thUser = document.querySelector("#placard-table th.col-user");
    if (isTous) thUser.classList.remove("hidden");
    else thUser.classList.add("hidden");

    for (const id of ["filter-ref", "filter-scannette", "filter-nom", "filter-groupe", "filter-qte"]) {
        document.getElementById(id).value = "";
    }
    if (searchRef) document.getElementById("filter-ref").value = searchRef;

    refreshPlacardTable();
    document.getElementById("placard-overlay").classList.remove("hidden");
}

export function refreshPlacardTable() {
    const tbody = document.getElementById("placard-tbody");
    tbody.innerHTML = "";

    let stock = getStock(placardUser);

    // Tri (clic sur l'en-tête de colonne)
    if (placardSort.col !== null) {
        // Doit rester aligné sur les data-col des <th> de #placard-table
        const keys = ["fournisseur", "reference", "ref_scannette", "nom", "groupe", "quantite", "lot", "date_peremption", "date_import", "utilisateur"];
        const k = keys[placardSort.col];
        stock = [...stock].sort((a, b) => {
            let cmp;
            if (k === "quantite") {
                cmp = a[k] - b[k];
            } else if (k === "date_peremption" || k === "date_import") {
                const da = parsePeremption(a[k]);
                const db_ = parsePeremption(b[k]);
                cmp = (da ? da.getTime() : 0) - (db_ ? db_.getTime() : 0);
            } else {
                cmp = String(a[k] ?? "").localeCompare(String(b[k] ?? ""));
            }
            return placardSort.asc ? cmp : -cmp;
        });
    }

    if (stock.length === 0) {
        const tr = document.createElement("tr");
        tr.className = "empty-row";
        tr.innerHTML = `<td colspan="12">Aucun article dans ce placard.</td>`;
        tbody.appendChild(tr);
        return;
    }

    let numRow = 0;
    for (const row of stock) {
        numRow++;
        const tr = document.createElement("tr");

        // Couleur de ligne : péremption puis stock bas
        let rowClass = "";
        let peremptionText = row.date_peremption || "";

        const pDate = parsePeremption(row.date_peremption);
        const alertePerempActive = row.alerte_peremption_active !== undefined ? Boolean(row.alerte_peremption_active) : true;
        const delaiPeremp = (row.delai_peremption !== undefined && row.delai_peremption !== null && row.delai_peremption !== "")
            ? parseInt(row.delai_peremption, 10)
            : 30;

        if (pDate) {
            const delta = daysUntil(pDate);
            if (delta < 0) {
                rowClass = "row-red";
                peremptionText = `${row.date_peremption} ⚠️ (Périmé)`;
            } else if (alertePerempActive) {
                if (delta === 0) {
                    rowClass = "row-red";
                    peremptionText = `${row.date_peremption} ⚠️ (Aujourd'hui)`;
                } else if (delta <= 1) {
                    rowClass = "row-red";
                    peremptionText = `${row.date_peremption} ⚠️ (J-${delta})`;
                } else if (delta <= delaiPeremp) {
                    rowClass = "row-orange";
                    peremptionText = `${row.date_peremption} ⚠️ (J-${delta})`;
                }
            }
        }

        let qteText = String(row.quantite);
        
        if (row.alerte_active && row.quantite <= row.stock_minimum) {
            qteText = `${qteText} ⚠️ (Min: ${row.stock_minimum})`;
            if (!rowClass) rowClass = "row-pink";
        }

        if (rowClass) tr.className = rowClass;

        const tdNum = document.createElement("td");
        tdNum.className = "rownum";
        tdNum.textContent = numRow;
        const tdFile = document.createElement("td");
        tdFile.textContent = row.fournisseur || "";
        tdFile.title = row.fournisseur || "";
        tdFile.style.maxWidth = "150px";
        tdFile.style.overflow = "hidden";
        tdFile.style.textOverflow = "ellipsis";
        tdFile.style.whiteSpace = "nowrap";
        const tdRef = document.createElement("td");
        tdRef.textContent = row.reference;
        const tdScannette = document.createElement("td");
        tdScannette.textContent = row.ref_scannette || "";
        const tdNom = document.createElement("td");
        tdNom.textContent = row.nom;
        tdNom.title = row.nom;
        tdNom.className = "td-nom";
        const tdGrp = document.createElement("td");
        tdGrp.textContent = row.groupe;

        // Quantité avec boutons - / +
        const tdQte = document.createElement("td");
        tdQte.className = "qte-cell";
        const btnMinus = document.createElement("button");
        btnMinus.className = "qte-btn qte-minus";
        btnMinus.textContent = "-";
        btnMinus.addEventListener("dblclick", (e) => e.stopPropagation());
        btnMinus.addEventListener("click", async (e) => {
            e.stopPropagation();

            // Plusieurs lots (ou espace à traçabilité) : on demande sur quel(s) lot(s) prélever
            if ((Array.isArray(row.lots) && row.lots.length > 1) || ESPACES_SUIVI_LOT.includes(row.utilisateur)) {
                if (await openLotMoveDialog(row, "sortie", { prefill: 1 })) {
                    refreshPlacardTable();
                    checkAlerts();
                }
                return;
            }

            if (row.date_peremption) {
                const parts = row.date_peremption.split(/[,;\s]+/).filter(p => p.trim() !== "");
                if (parts.length > 1) {
                    const closest = parsePeremption(row.date_peremption);
                    if (closest) {
                        const dateStr = `${String(closest.getDate()).padStart(2, '0')}/${String(closest.getMonth() + 1).padStart(2, '0')}/${closest.getFullYear()}`;
                        await showMessage("Multiples dates", `Ce produit a plusieurs dates de péremption (${row.date_peremption}).\nAssurez-vous d'avoir pris celui qui périme le plus tôt (le ${dateStr}).`);
                    }
                }
            }

            if (sortirStock(row.reference, 1, row.utilisateur)) {
                refreshPlacardTable();
                checkAlerts();
            }
        });
        const lblQte = document.createElement("span");
        lblQte.textContent = qteText;
        const btnPlus = document.createElement("button");
        btnPlus.className = "qte-btn qte-plus";
        btnPlus.textContent = "+";
        btnPlus.addEventListener("dblclick", (e) => e.stopPropagation());
        btnPlus.addEventListener("click", async (e) => {
            e.stopPropagation();

            // Plusieurs lots (ou espace à traçabilité) : on demande sur quel(s) lot(s) ajouter
            if ((Array.isArray(row.lots) && row.lots.length > 1) || ESPACES_SUIVI_LOT.includes(row.utilisateur)) {
                if (await openLotMoveDialog(row, "entree")) {
                    refreshPlacardTable();
                    checkAlerts();
                }
                return;
            }

            // Un seul lot : l'unité ajoutée lui est directement rattachée
            if (Array.isArray(row.lots) && row.lots.length === 1) {
                ajouterStockParLots(row.reference, row.utilisateur, [{
                    lot: row.lots[0].lot, date: row.lots[0].date, qte: 1
                }]);
                refreshPlacardTable();
                checkAlerts();
                return;
            }

            setStockAbsolu(row.reference, row.quantite + 1, {
                nom: row.nom, groupe: row.groupe, ref_scannette: row.ref_scannette,
                type_stockage: row.type_stockage, quantite_par_carton: row.quantite_par_carton,
                stock_minimum: row.stock_minimum, alerte_active: row.alerte_active,
                alerte_peremption_active: row.alerte_peremption_active,
                delai_peremption: row.delai_peremption,
                utilisateur: row.utilisateur, date_peremption: row.date_peremption,
                en_commande: row.en_commande, date_commande: row.date_commande,
                lot: row.lot, lots_details: row.lots_details
            });
            refreshPlacardTable();
            checkAlerts();
        });
        tdQte.append(btnMinus, lblQte, btnPlus);

        const tdLot = document.createElement("td");
        tdLot.textContent = row.lot_label || row.lot || "";
        tdLot.title = row.lot_label || row.lot || "";

        const tdPeremption = document.createElement("td");
        tdPeremption.textContent = peremptionText;
        const tdImport = document.createElement("td");
        tdImport.textContent = row.date_import;

        const tdUser = document.createElement("td");
        tdUser.className = "col-user";
        tdUser.textContent = row.utilisateur;
        if (placardUser !== "TOUS") tdUser.classList.add("hidden");

        const tdAction = document.createElement("td");
        tdAction.className = "center";
        
        const btnEdit = document.createElement("button");
        btnEdit.className = "btn btn-small";
        btnEdit.textContent = "✏️";
        btnEdit.title = "Modifier";
        btnEdit.addEventListener("dblclick", (e) => e.stopPropagation());
        btnEdit.addEventListener("click", (e) => {
            e.stopPropagation();
            if (typeof window.openEditDialog === "function") {
                window.openEditDialog(row);
            }
        });
        
        const btnEntree = document.createElement("button");
        btnEntree.className = "btn btn-small";
        btnEntree.textContent = "📥";
        btnEntree.title = "Entrer X quantités sur un lot (ou créer un lot)";
        btnEntree.style.marginLeft = "5px";
        btnEntree.addEventListener("dblclick", (e) => e.stopPropagation());
        btnEntree.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (await openLotMoveDialog(row, "entree")) {
                refreshPlacardTable();
                checkAlerts();
            }
        });

        const btnSortie = document.createElement("button");
        btnSortie.className = "btn btn-small";
        btnSortie.textContent = "📤";
        btnSortie.title = "Sortir X quantités d'un lot précis";
        btnSortie.style.marginLeft = "5px";
        btnSortie.addEventListener("dblclick", (e) => e.stopPropagation());
        btnSortie.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (row.quantite <= 0) {
                await showMessage("Stock vide", `Aucune unité en stock pour ${row.reference}.`);
                return;
            }
            if (await openLotMoveDialog(row, "sortie")) {
                refreshPlacardTable();
                checkAlerts();
            }
        });

        const btnDelete = document.createElement("button");
        btnDelete.className = "btn btn-small";
        btnDelete.textContent = "❌";
        btnDelete.title = "Supprimer la référence définitivement";
        btnDelete.style.marginLeft = "5px";
        btnDelete.addEventListener("dblclick", (e) => e.stopPropagation());
        btnDelete.addEventListener("click", (e) => {
            e.stopPropagation();
            if (window.confirm(`Voulez-vous vraiment supprimer définitivement la référence ${row.reference} ?\nAttention : Cela la supprimera de tous les espaces.`)) {
                const db = loadDB();
                // Retirer des produits
                const pIdx = db.produits.findIndex(p => p.reference === row.reference);
                if (pIdx !== -1) db.produits.splice(pIdx, 1);
                
                // Retirer du stock local
                db.stock = db.stock.filter(s => s.reference !== row.reference);
                
                persister("deleteProduit", row.reference);
                saveDB(db);
                refreshPlacardTable();
                checkAlerts();
            }
        });
        
        tdAction.appendChild(btnEdit);
        tdAction.appendChild(btnEntree);
        tdAction.appendChild(btnSortie);
        tdAction.appendChild(btnDelete);

        tr.append(tdNum, tdFile, tdRef, tdScannette, tdNom, tdGrp, tdQte, tdLot, tdPeremption, tdImport, tdUser, tdAction);
        tr.addEventListener("dblclick", () => {
            if (typeof window.openEditDialog === "function") {
                window.openEditDialog(row);
            }
        });
        tbody.appendChild(tr);
    }

    filterPlacardTable();
}

export function filterPlacardTable() {
    const filters = [
        (document.getElementById("filter-fichier")?.value || "").toLowerCase(),
        document.getElementById("filter-ref").value.toLowerCase(),
        document.getElementById("filter-scannette").value.toLowerCase(),
        document.getElementById("filter-nom").value.toLowerCase(),
        document.getElementById("filter-groupe").value.toLowerCase(),
        document.getElementById("filter-qte").value.toLowerCase()
    ];

    for (const tr of document.querySelectorAll("#placard-tbody tr")) {
        if (tr.classList.contains("empty-row")) continue;
        let match = true;
        for (let col = 0; col < filters.length; col++) {
            // +1 : la première colonne est le numéro de ligne
            if (filters[col] && !tr.cells[col + 1].textContent.toLowerCase().includes(filters[col])) {
                match = false;
                break;
            }
        }
        tr.style.display = match ? "" : "none";
    }
}

// Export to window for global access
window.openPlacard = openPlacard;
window.refreshPlacardTable = refreshPlacardTable;
window.filterPlacardTable = filterPlacardTable;
