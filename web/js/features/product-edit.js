"use strict";

/* ============================================================
   Ajout / modification de produit (ProductEditDialog)
   ============================================================ */

import { USERS, CONDITIONNEMENTS, estConditionnementGroupe } from '../core/constants.js';
import { loadDB, saveDB, addTransaction, persister } from '../core/database.js';
import { setStockAbsolu } from './stock.js';
import { normalizeLots, lotsFromStrings } from './lots.js';
import { fillGroupsDatalist, showMessage, parsePeremption, daysUntil, parseBarcodes, formatBarcodes } from '../core/utils.js';
import { checkAlerts } from './alerts.js';
import { refreshPlacardTable, placardUser } from './placard.js';

/**
 * Reventile la quantité quand on change de conditionnement.
 *
 * En mode groupé, la quantité est éclatée à l'écran en « nombre de contenants »
 * + « unités en vrac ». Sans reventilation, passer de « En cartons » à
 * « À l'unité » laissait `edit-qte` sur le seul reliquat de vrac : 12 cartons
 * de 10 + 3 (123 unités) étaient enregistrés comme 3 unités.
 */
function reventilerQuantite(ancienType, nouveauType) {
    if (ancienType === nouveauType) return;

    const qteInput = document.getElementById("edit-qte");
    const nbInput = document.getElementById("edit-nb-contenants");
    const parContenantInput = document.getElementById("edit-qte-par-contenant");
    if (!qteInput || !nbInput || !parContenantInput) return;

    const vrac = parseInt(qteInput.value, 10) || 0;
    const nbContenants = parseInt(nbInput.value, 10) || 0;
    const parContenant = parseInt(parContenantInput.value, 10) || 1;

    const ancienGroupe = estConditionnementGroupe(ancienType);
    const nouveauGroupe = estConditionnementGroupe(nouveauType);

    // Total réel en unités, quel que soit l'affichage d'origine
    const total = ancienGroupe ? (nbContenants * parContenant) + vrac : vrac;

    if (nouveauGroupe) {
        // On re-éclate le total dans le nouveau conditionnement
        nbInput.value = parContenant > 0 ? Math.floor(total / parContenant) : 0;
        qteInput.value = parContenant > 0 ? total % parContenant : total;
    } else {
        // Retour à l'unité : tout repasse dans la quantité, plus de contenants
        nbInput.value = 0;
        qteInput.value = total;
    }
}

window.toggleCondFields = function() {
    const sel = document.getElementById("edit-type-stockage");
    const cFields = document.getElementById("cond-fields");
    const lbl = document.getElementById("lbl-edit-qte");

    // Le type précédemment affiché est mémorisé sur le <select> lui-même :
    // openEditDialog le pose avant son premier appel, donc l'ouverture du
    // dialogue ne déclenche aucune reventilation.
    reventilerQuantite(sel.dataset.previousType, sel.value);
    sel.dataset.previousType = sel.value;

    const cond = CONDITIONNEMENTS[sel.value];
    if (cond && cond.groupe) {
        cFields.classList.remove("hidden");
        document.getElementById("lbl-qte-par-contenant").textContent = cond.labelQteParContenant;
        document.getElementById("lbl-nb-contenants").textContent = cond.labelNbContenants;
        lbl.textContent = cond.labelVrac;
    } else {
        cFields.classList.add("hidden");
        lbl.textContent = "Quantité (Stock Absolu) :";
    }
};

window.createScannetteRow = function(val = "") {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "10px";
    row.style.alignItems = "center";

    const inScan = document.createElement("input");
    inScan.type = "text";
    inScan.className = "input edit-scannette-val";
    inScan.placeholder = "Scanner ou saisir un code-barres...";
    inScan.value = val;
    inScan.style.flex = "1";

    // Si on appuie sur Entrée (douchette), on ajoute automatiquement une nouvelle ligne et on focus
    inScan.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const container = document.getElementById("edit-scannette-container");
            const newRow = window.createScannetteRow();
            container.appendChild(newRow);
            const nextInput = newRow.querySelector(".edit-scannette-val");
            if (nextInput) nextInput.focus();
        }
    });

    // Découpage automatique si collage d'une liste
    inScan.addEventListener("paste", (e) => {
        setTimeout(() => {
            const raw = inScan.value;
            const parsed = parseBarcodes(raw);
            if (parsed.length > 1) {
                inScan.value = parsed[0];
                const container = document.getElementById("edit-scannette-container");
                for (let i = 1; i < parsed.length; i++) {
                    const extraRow = window.createScannetteRow(parsed[i]);
                    container.appendChild(extraRow);
                }
            }
        }, 0);
    });

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn";
    btnDel.textContent = "✕";
    btnDel.title = "Supprimer ce code-barres";
    btnDel.onclick = () => {
        const container = document.getElementById("edit-scannette-container");
        row.remove();
        if (container.children.length === 0) {
            container.appendChild(window.createScannetteRow());
        }
    };

    row.append(inScan, btnDel);
    return row;
};

window.renderEditScannettes = function(codesArray) {
    const container = document.getElementById("edit-scannette-container");
    if (!container) return;
    container.innerHTML = "";
    const list = parseBarcodes(codesArray);
    if (list.length === 0) {
        container.appendChild(window.createScannetteRow(""));
    } else {
        list.forEach(code => {
            container.appendChild(window.createScannetteRow(code));
        });
    }
};

/** Une ligne de lot : numéro, péremption et quantité du lot. */
window.createLotRow = function(pair = {}) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "10px";

    const inLot = document.createElement("input");
    inLot.type = "text";
    inLot.className = "input lot-val";
    inLot.placeholder = "Numéro de lot";
    inLot.value = pair.lot || "";
    inLot.style.flex = "1";

    const inDate = document.createElement("input");
    inDate.type = "text";
    inDate.className = "input date-val";
    inDate.placeholder = "Péremption (JJ/MM/AAAA)";
    inDate.value = pair.date || "";
    inDate.style.flex = "1";

    // Quantité présente sur ce lot
    const inQte = document.createElement("input");
    inQte.type = "number";
    inQte.className = "input qte-val";
    inQte.placeholder = "Qté";
    inQte.min = 0;
    inQte.title = "Quantité en stock pour ce lot";
    inQte.value = (pair.qte !== undefined && pair.qte !== null && pair.qte !== "") ? pair.qte : "";
    inQte.style.width = "80px";
    inQte.style.flex = "0 0 80px";
    inQte.addEventListener("input", () => window.syncLotsQuantite());

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn";
    btnDel.textContent = "X";
    btnDel.onclick = () => {
        row.remove();
        window.updateLotsTotalLabel();
    };

    row.append(inLot, inDate, inQte, btnDel);
    return row;
};

/** Somme des quantités saisies sur les lots. */
window.totalLotsSaisis = function() {
    const container = document.getElementById("edit-lots-container");
    if (!container) return 0;
    let total = 0;
    for (const row of container.children) {
        const q = parseInt(row.querySelector(".qte-val").value, 10);
        if (!isNaN(q) && q > 0) total += q;
    }
    return total;
};

/** Met à jour le libellé "Total des lots" (sans toucher à la quantité). */
window.updateLotsTotalLabel = function() {
    const info = document.getElementById("edit-lots-total");
    if (!info) return 0;
    const total = window.totalLotsSaisis();
    info.textContent = total > 0 ? `Total des lots : ${total} unité(s)` : "";
    return total;
};

/** Saisie d'une quantité de lot : la somme des lots devient la quantité en stock. */
window.syncLotsQuantite = function() {
    const total = window.updateLotsTotalLabel();
    const typeSel = document.getElementById("edit-type-stockage");
    const qteInput = document.getElementById("edit-qte");
    if (total > 0 && qteInput && typeSel && !estConditionnementGroupe(typeSel.value)) {
        qteInput.value = total;
    }
};

window.renderEditLots = function(lotsArray) {
    const container = document.getElementById("edit-lots-container");
    container.innerHTML = "";
    lotsArray.forEach(pair => {
        container.appendChild(window.createLotRow(pair));
    });
    window.updateLotsTotalLabel();
};

document.addEventListener("DOMContentLoaded", () => {
    const btnAddScan = document.getElementById("btn-add-scannette");
    if (btnAddScan) {
        btnAddScan.addEventListener("click", () => {
            const container = document.getElementById("edit-scannette-container");
            const newRow = window.createScannetteRow();
            container.appendChild(newRow);
            const input = newRow.querySelector(".edit-scannette-val");
            if (input) input.focus();
        });
    }

    const btnAddLot = document.getElementById("btn-add-lot");
    if (btnAddLot) {
        btnAddLot.addEventListener("click", () => {
            const container = document.getElementById("edit-lots-container");
            const row = window.createLotRow();
            container.appendChild(row);
            const inLot = row.querySelector(".lot-val");
            if (inLot) inLot.focus();
        });
    }
});

export function openEditDialog(row = null) {
    fillGroupsDatalist();

    const isEdit = row !== null;
    document.getElementById("edit-title").textContent = isEdit ? "Modifier le produit" : "Ajouter un produit";

    const refInput = document.getElementById("edit-ref");
    refInput.value = isEdit ? row.reference : "";
    // refInput.readOnly = isEdit;
    refInput.dataset.originalRef = isEdit ? row.reference : "";

    document.getElementById("edit-nom").value = isEdit ? row.nom : "";
    const scannetteVal = isEdit ? (row.ref_scannette || "") : "";
    const hiddenScannette = document.getElementById("edit-scannette");
    if (hiddenScannette) hiddenScannette.value = formatBarcodes(scannetteVal);
    window.renderEditScannettes(scannetteVal);

    document.getElementById("edit-groupe").value = isEdit ? row.groupe : (window.isTrousseSecours ? "trousse de secours" : (window.isMEOPA ? "MEOPA" : ""));

    // Populate and set edit-user
    const userSelect = document.getElementById("edit-user");
    userSelect.innerHTML = "";
    USERS.forEach(u => {
        const opt = document.createElement("option");
        opt.value = u;
        opt.textContent = u;
        userSelect.appendChild(opt);
    });

    if (isEdit) {
        userSelect.value = row.utilisateur;
        userSelect.dataset.originalUser = row.utilisateur;
    } else {
        userSelect.value = (placardUser && placardUser !== "TOUS") ? placardUser : USERS[0];
        userSelect.dataset.originalUser = "";
    }

    const typeStockageSelect = document.getElementById("edit-type-stockage");
    typeStockageSelect.value = isEdit && row.type_stockage ? row.type_stockage : "unite";
    // Aligner previousType sur la valeur affichée : toggleCondFields() ne doit
    // pas reventiler la quantité au simple chargement du dialogue.
    typeStockageSelect.dataset.previousType = typeStockageSelect.value;
    document.getElementById("edit-qte-par-contenant").value = isEdit && row.quantite_par_carton ? row.quantite_par_carton : 1;

    if (isEdit && estConditionnementGroupe(row.type_stockage) && row.quantite_par_carton > 0) {
        document.getElementById("edit-nb-contenants").value = Math.floor(row.quantite / row.quantite_par_carton);
        document.getElementById("edit-qte").value = row.quantite % row.quantite_par_carton;
    } else {
        document.getElementById("edit-nb-contenants").value = 0;
        document.getElementById("edit-qte").value = isEdit ? row.quantite : 0;
    }
    window.toggleCondFields();
    document.getElementById("edit-min").value = isEdit ? row.stock_minimum : 0;
    document.getElementById("edit-alerte").checked = isEdit ? Boolean(row.alerte_active) : false;
    const delaiInput = document.getElementById("edit-delai-peremption");
    if (delaiInput) {
        delaiInput.value = isEdit && row.delai_peremption !== undefined && row.delai_peremption !== null && row.delai_peremption !== "" ? row.delai_peremption : 30;
    }
    const alertePerempInput = document.getElementById("edit-alerte-peremption");
    if (alertePerempInput) {
        alertePerempInput.checked = (isEdit && row.alerte_peremption_active !== undefined)
            ? Boolean(row.alerte_peremption_active)
            : true;
    }

    let lotsArray = [];
    if (isEdit) {
        if (Array.isArray(row.lots) && row.lots.length > 0) {
            // Lots déjà quantifiés par getStock()
            lotsArray = row.lots.map(l => ({ lot: l.lot, date: l.date, qte: l.qte }));
        } else {
            lotsArray = normalizeLots(row.lots_details, row.quantite);
            if (lotsArray.length === 0 && (row.lot || row.date_peremption)) {
                lotsArray = lotsFromStrings(row.lot, row.date_peremption, row.quantite);
            }
        }
    }
    window.renderEditLots(lotsArray);

    const prixHtInput = document.getElementById("edit-prix-ht");
    if (prixHtInput) prixHtInput.value = isEdit ? (row.prix_unitaire_ht || "") : "";

    const prixTtcInput = document.getElementById("edit-prix-ttc");
    if (prixTtcInput) prixTtcInput.value = isEdit ? (row.prix_unitaire_ttc || "") : "";

    document.getElementById("edit-fournisseur").value = isEdit ? (row.fournisseur || "") : "";
    document.getElementById("edit-en-commande").checked = isEdit ? !!row.en_commande : false;
    document.getElementById("edit-date-commande").value = isEdit ? (row.date_commande || "") : "";

    document.getElementById("edit-overlay").classList.remove("hidden");

    const dialogBody = document.querySelector("#edit-overlay .dialog-body");
    if (dialogBody) {
        dialogBody.scrollTop = 0;
    }
}

export async function saveEditDialog() {
    const { showMessage } = await import('../core/utils.js');
    
    const ref = document.getElementById("edit-ref").value.trim();
    if (!ref) {
        await showMessage("Erreur", "La référence ne peut pas être vide.");
        return;
    }

    const container = document.getElementById("edit-scannette-container");
    let codes = [];
    if (container) {
        const inputs = container.querySelectorAll(".edit-scannette-val");
        for (const inp of inputs) {
            codes.push(...parseBarcodes(inp.value));
        }
    }
    codes = Array.from(new Set(codes));
    let ref_scannette = formatBarcodes(codes);

    if (!ref_scannette) {
        const promptVal = window.prompt("Ce produit n'a pas de code-barres. Veuillez scanner ou saisir le code-barres :");
        if (promptVal && promptVal.trim() !== "") {
            ref_scannette = formatBarcodes(promptVal);
            window.renderEditScannettes(ref_scannette);
        } else {
            const bypass = window.confirm("Aucun code-barres saisi. Voulez-vous vraiment enregistrer ce produit sans code-barres ?");
            if (!bypass) {
                await showMessage("Attention", "L'enregistrement a été annulé.");
                return;
            }
            ref_scannette = ""; // L'utilisateur a choisi de forcer sans code-barres
        }
    }

    const hiddenScannette = document.getElementById("edit-scannette");
    if (hiddenScannette) hiddenScannette.value = ref_scannette;

    const userSelect = document.getElementById("edit-user");
    const newUser = userSelect.value;
    const oldUser = userSelect.dataset.originalUser;
    const oldRef = document.getElementById("edit-ref").dataset.originalRef;

    if (oldRef && oldUser && (oldRef !== ref || oldUser !== newUser)) {
        let db = loadDB();
        const idx = db.stock.findIndex(s => s.reference === oldRef && s.utilisateur === oldUser);
        if (idx !== -1) {
            const oldQte = db.stock[idx].quantite;
            db.stock.splice(idx, 1);
            addTransaction(db, oldRef, oldUser, "SORTIE (Modification Réf/Espace)", oldQte);
            persister("deleteStockItem", oldRef, oldUser);
            saveDB(db);
        }
    }

    const parsePrix = (val) => {
        if (!val || typeof val !== "string") return null;
        const cleaned = val.replace(/\s/g, "").replace(",", ".");
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
    };
    const prixHtInput = document.getElementById("edit-prix-ht");
    const prixHtVal = prixHtInput && prixHtInput.value !== "" ? parsePrix(prixHtInput.value) : null;
    const prixTtcInput = document.getElementById("edit-prix-ttc");
    const prixTtcVal = prixTtcInput && prixTtcInput.value !== "" ? parsePrix(prixTtcInput.value) : null;

    const type_stockage = document.getElementById("edit-type-stockage").value;
    const quantite_par_carton = parseInt(document.getElementById("edit-qte-par-contenant").value, 10) || 1;
    let totalQte = parseInt(document.getElementById("edit-qte").value, 10) || 0;
    
    if (estConditionnementGroupe(type_stockage)) {
        const nb_contenants = parseInt(document.getElementById("edit-nb-contenants").value, 10) || 0;
        totalQte = (nb_contenants * quantite_par_carton) + totalQte;
    }

    // Lots saisis, avec la quantité présente sur chacun d'eux.
    // Quantité laissée vide => null : elle sera déduite du reliquat de la quantité totale.
    const lotsSaisis = Array.from(document.getElementById("edit-lots-container").children)
        .map(row => {
            const qteBrute = row.querySelector(".qte-val").value.trim();
            return {
                lot: row.querySelector(".lot-val").value.trim(),
                date: row.querySelector(".date-val").value.trim(),
                qte: qteBrute === "" ? null : (parseInt(qteBrute, 10) || 0)
            };
        })
        .filter(a => a.lot || a.date || (a.qte !== null && a.qte > 0));

    const datePeremptionVal = lotsSaisis.map(a => a.date).filter(Boolean).join(", ");
    const lotVal = lotsSaisis.map(a => a.lot).filter(Boolean).join(", ");
    const lotsDetailsVal = JSON.stringify(lotsSaisis);
    const sommeLots = lotsSaisis.reduce((s, a) => s + (a.qte || 0), 0);

    if (sommeLots > totalQte) {
        await showMessage(
            "Quantités incohérentes",
            `La somme des quantités par lot (${sommeLots}) dépasse la quantité en stock saisie (${totalQte}).\n\nCorrigez la quantité des lots ou la quantité totale.`
        );
        return;
    }

    let alertePerempChecked = document.getElementById("edit-alerte-peremption") ? document.getElementById("edit-alerte-peremption").checked : true;
    
    // Alerte immédiate si la date de péremption est déjà passée
    if (datePeremptionVal) {
        const pDate = parsePeremption(datePeremptionVal);
        if (pDate) {
            const delta = daysUntil(pDate);
            if (delta < 0) {
                alertePerempChecked = true;
                await showMessage(
                    "⚠️ Attention - Produit Périmé",
                    `Attention : la date de péremption saisie (${datePeremptionVal}) est déjà dépassée depuis ${Math.abs(delta)} jour(s) !\n\nCe produit sera marqué comme périmé avec une alerte active.`
                );
            }
        }
    }

    setStockAbsolu(ref, totalQte, {
        nom: document.getElementById("edit-nom").value.trim(),
        ref_scannette: ref_scannette,
        groupe: document.getElementById("edit-groupe").value.trim(),
        type_stockage: type_stockage,
        quantite_par_carton: quantite_par_carton,
        stock_minimum: parseInt(document.getElementById("edit-min").value, 10) || 0,
        alerte_active: document.getElementById("edit-alerte").checked ? 1 : 0,
        alerte_peremption_active: alertePerempChecked ? 1 : 0,
        delai_peremption: document.getElementById("edit-delai-peremption") ? (parseInt(document.getElementById("edit-delai-peremption").value, 10) || 30) : 30,
        utilisateur: newUser,
        date_peremption: datePeremptionVal,
        lot: lotVal,
        lots_details: lotsDetailsVal,
        prix_unitaire_ht: prixHtVal,
        prix_unitaire_ttc: prixTtcVal,
        fournisseur: document.getElementById("edit-fournisseur").value.trim(),
        en_commande: document.getElementById("edit-en-commande").checked ? 1 : 0,
        date_commande: document.getElementById("edit-date-commande").value.trim()
    });

    document.getElementById("edit-overlay").classList.add("hidden");
    refreshPlacardTable();
    checkAlerts();
}

// Export to window for global access
window.openEditDialog = openEditDialog;
window.saveEditDialog = saveEditDialog;
