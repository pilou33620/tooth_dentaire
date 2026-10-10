"use strict";

/* ============================================================
   Import de facture (ImportDialog)
   ============================================================ */

import { CONDITIONNEMENTS, estConditionnementGroupe } from '../core/constants.js';
import { getAllGroups, getStockInfo } from '../core/database.js';
import { fillUserSelect, todayFR, showMessage, parseBarcodes, formatBarcodes, datesIllisibles, MESSAGE_FORMATS_DATE } from '../core/utils.js';
import { getDocument, modifierDocument } from '../core/api.js';
import { ajouterStock } from './stock.js';
import { estPerime, messageLotsPerimes } from './lots.js';
import { checkAlerts } from './alerts.js';

export let importItems = [];
// Validation en cours : un double clic sur « Valider » importait deux fois
let importEnCours = false;

/* Factures déjà importées (document "factures_importees", partagé par les
   postes) : réimporter le même PDF un autre jour doublerait le stock. */
const CLE_FACTURES = "factures_importees";
const MAX_FACTURES_RETENUES = 300;

function facturesImportees() {
    const doc = getDocument(CLE_FACTURES) || {};
    return (Array.isArray(doc.empreintes) ? doc.empreintes : [])
        .filter(f => f && typeof f === "object" && typeof f.empreinte === "string");
}

function retenirFactures(fichiers) {
    if (fichiers.length === 0) return;
    const date = todayFR();
    modifierDocument(CLE_FACTURES, valeur => {
        const doc = (valeur && typeof valeur === "object" && !Array.isArray(valeur)) ? valeur : {};
        const liste = (Array.isArray(doc.empreintes) ? doc.empreintes : [])
            .filter(f => f && typeof f === "object" && !fichiers.some(n => n.empreinte === f.empreinte));
        for (const f of fichiers) liste.push({ empreinte: f.empreinte, fichier: f.fichier, date });
        return { ...doc, empreintes: liste.slice(-MAX_FACTURES_RETENUES) };
    });
}

/* Empreinte du contenu du fichier : deux téléchargements d'une même facture
   donnent la même empreinte, deux factures différentes non — même si elles
   portent les mêmes articles. On ne peut donc pas écarter à tort une commande
   réellement passée deux fois. */
async function empreinteFichier(file) {
    const buffer = await file.arrayBuffer();

    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
        const digest = await window.crypto.subtle.digest("SHA-256", buffer);
        return Array.from(new Uint8Array(digest))
            .map(b => b.toString(16).padStart(2, "0")).join("");
    }

    // Repli si crypto.subtle est indisponible : empreinte plus faible, mais
    // largement suffisante pour repérer deux copies d'un même fichier.
    const bytes = new Uint8Array(buffer);
    let h1 = 0x811c9dc5, h2 = 7;
    for (let i = 0; i < bytes.length; i++) {
        h1 = ((h1 ^ bytes[i]) * 0x01000193) >>> 0;
        h2 = ((h2 + bytes[i]) * 31) >>> 0;
    }
    return `${bytes.length}-${h1.toString(16)}-${h2.toString(16)}`;
}

export async function onPdfSelected(files) {
    if (!files || files.length === 0) return;

    // Import extractStockFromPdf dynamically
    const { extractStockFromPdf } = await import('../parsers/pdf-parser.js');

    let allItems = [];
    const erreurs = [];
    const doublons = [];
    const empreintesVues = new Map(); // empreinte -> nom du premier fichier
    const dejaImportees = new Map(facturesImportees().map(f => [f.empreinte, f]));
    const fichiers = [];

    for (const file of files) {
        const empreinte = await empreinteFichier(file);
        if (empreintesVues.has(empreinte)) {
            doublons.push(`• ${file.name} (identique à ${empreintesVues.get(empreinte)})`);
            continue;
        }
        empreintesVues.set(empreinte, file.name);
        fichiers.push({ file, empreinte });
    }

    // Factures déjà importées un autre jour (ou sur un autre poste)
    const anciennes = fichiers.filter(f => dejaImportees.has(f.empreinte));
    if (anciennes.length > 0) {
        const liste = anciennes.map(f => {
            const avant = dejaImportees.get(f.empreinte);
            return `• ${f.file.name} (importée le ${avant.date || "?"}${avant.fichier ? ` sous le nom ${avant.fichier}` : ""})`;
        }).join("\n");
        const reimporter = window.confirm(
            `Ces factures ont déjà été importées :\n\n${liste}\n\n`
            + "OK : les importer quand même (le stock sera ajouté une seconde fois).\n"
            + "Annuler : les ignorer.");
        if (!reimporter) {
            for (const f of anciennes) fichiers.splice(fichiers.indexOf(f), 1);
        }
    }

    for (const { file, empreinte } of fichiers) {
        const { items, erreur } = await extractStockFromPdf(file);
        if (erreur) {
            erreurs.push(`• ${erreur}`);
        } else if (items.length === 0) {
            erreurs.push(`• ${file.name} : aucune référence reconnue (fournisseur non géré ?).`);
        } else {
            for (const item of items) {
                item.empreinte = empreinte;
                item.fichier = file.name;
            }
            allItems = allItems.concat(items);
        }
    }

    if (doublons.length > 0) {
        await showMessage("Factures en double ignorées",
            "Ces fichiers ont un contenu strictement identique à un autre fichier "
            + "sélectionné, ils n'ont été comptés qu'une fois :\n\n" + doublons.join("\n"));
    }

    if (allItems.length === 0) {
        await showMessage("Aucun résultat",
            "Aucune référence n'a pu être extraite des factures."
            + (erreurs.length > 0 ? "\n\n" + erreurs.join("\n") : ""));
        return;
    }

    if (erreurs.length > 0) {
        await showMessage("Certaines factures n'ont pas été lues",
            erreurs.join("\n") + "\n\nLes autres sont proposées à l'import.");
    }

    importItems = allItems;
    populateImportTable();
    document.getElementById("import-overlay").classList.remove("hidden");
}

export function populateImportTable() {
    const tbody = document.getElementById("import-tbody");
    tbody.innerHTML = "";
    const groups = getAllGroups();

    const ESPACE_PAR_DEFAUT = "Commun";

    importItems.forEach((item, idx) => {
        const info = getStockInfo(item.reference, ESPACE_PAR_DEFAUT);
        const tr = document.createElement("tr");
        tr.dataset.row = idx;

        const tdNum = document.createElement("td");
        tdNum.className = "rownum";
        tdNum.textContent = idx + 1;

        const tdFile = document.createElement("td");
        tdFile.textContent = item.fournisseur || "";
        tdFile.title = item.fournisseur || "";
        tdFile.style.maxWidth = "150px";
        tdFile.style.overflow = "hidden";
        tdFile.style.textOverflow = "ellipsis";
        tdFile.style.whiteSpace = "nowrap";

        const tdRef = document.createElement("td");
        tdRef.textContent = item.reference || "";

        const tdScannette = document.createElement("td");
        tdScannette.className = "import-scannette-cell";

        const btnAddScan = document.createElement("button");
        btnAddScan.type = "button";
        btnAddScan.className = "btn btn-small";
        btnAddScan.textContent = "+";
        btnAddScan.title = "Ajouter un code-barres";
        btnAddScan.style.marginBottom = "5px";

        const scanDiv = document.createElement("div");
        scanDiv.style.display = "flex";
        scanDiv.style.flexDirection = "column";
        scanDiv.style.gap = "4px";

        function addScanRow(val = "") {
            const rowDiv = document.createElement("div");
            rowDiv.style.display = "flex";
            rowDiv.style.gap = "4px";
            rowDiv.style.alignItems = "center";

            const inScan = document.createElement("input");
            inScan.type = "text";
            inScan.className = "input import-scannette-val";
            inScan.value = val;
            inScan.placeholder = "Code...";
            inScan.style.width = "100px";

            // En appuyant sur Entrée (douchette), on ajoute automatiquement une nouvelle ligne
            inScan.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    addScanRow("");
                }
            });

            // Découpage automatique si collage d'une chaîne avec séparateurs
            inScan.addEventListener("paste", () => {
                setTimeout(() => {
                    const parsed = parseBarcodes(inScan.value);
                    if (parsed.length > 1) {
                        inScan.value = parsed[0];
                        for (let i = 1; i < parsed.length; i++) {
                            addScanRow(parsed[i]);
                        }
                    }
                }, 0);
            });

            const btnDel = document.createElement("button");
            btnDel.type = "button";
            btnDel.className = "btn btn-small";
            btnDel.textContent = "✕";
            btnDel.title = "Supprimer ce code";
            btnDel.onclick = () => {
                rowDiv.remove();
                if (scanDiv.children.length === 0) {
                    addScanRow("");
                }
            };

            rowDiv.append(inScan, btnDel);
            scanDiv.appendChild(rowDiv);
            if (val === "" && scanDiv.children.length > 1) {
                inScan.focus();
            }
        }

        btnAddScan.onclick = () => addScanRow("");

        const existingBarcodes = parseBarcodes(info.ref_scannette);
        if (existingBarcodes.length === 0) {
            addScanRow("");
        } else {
            existingBarcodes.forEach(b => addScanRow(b));
        }

        const inHiddenScannette = document.createElement("input");
        inHiddenScannette.type = "hidden";
        inHiddenScannette.className = "import-scannette";
        inHiddenScannette.value = formatBarcodes(existingBarcodes);

        tdScannette.append(btnAddScan, scanDiv, inHiddenScannette);

        const tdNom = document.createElement("td");
        tdNom.textContent = item.designation || "";
        tdNom.title = item.designation || "";
        tdNom.className = "td-nom";
        
        const tdTypeCond = document.createElement("td");
        const selTypeCond = document.createElement("select");
        selTypeCond.className = "combo import-type-stock";
        for (const [valeur, cond] of Object.entries(CONDITIONNEMENTS)) {
            const opt = document.createElement("option");
            opt.value = valeur; opt.textContent = cond.labelCourt;
            selTypeCond.appendChild(opt);
        }
        selTypeCond.value = info.type_stockage || "unite";
        tdTypeCond.appendChild(selTypeCond);

        const tdQteCond = document.createElement("td");
        const inQteCond = document.createElement("input");
        inQteCond.type = "number";
        inQteCond.className = "input import-qte-cond";
        inQteCond.min = 1;
        inQteCond.value = info.quantite_par_carton || 1;
        inQteCond.style.width = "60px";
        tdQteCond.appendChild(inQteCond);
        
        const tdQte = document.createElement("td");
        tdQte.className = "center";
        const inQteBase = document.createElement("input");
        inQteBase.type = "number";
        inQteBase.className = "input import-qte-base";
        inQteBase.min = 1;
        inQteBase.value = item.quantite || 0;
        inQteBase.style.width = "60px";
        tdQte.appendChild(inQteBase);

        function updQteCond(e) {
            if (estConditionnementGroupe(selTypeCond.value)) {
                inQteCond.style.display = "";
                if (e && e.type === "change") {
                    // La facture compte des cartons : on garde leur nombre et
                    // on laisse saisir le nombre d'unités par carton. (Avant :
                    // « 1 carton de N », et le prix unitaire divisé par N.)
                    inQteCond.value = 1;
                    inQteBase.value = item.quantite || 1;
                }
            } else {
                inQteCond.style.display = "none";
                if (e && e.type === "change") {
                    inQteBase.value = item.quantite || 0;
                }
            }
        }
        selTypeCond.addEventListener("change", updQteCond);
        updQteCond();

        // Utilisateur destination
        const tdUser = document.createElement("td");
        const selUser = document.createElement("select");
        selUser.className = "combo import-user";
        fillUserSelect(selUser, ESPACE_PAR_DEFAUT);
        tdUser.appendChild(selUser);

        // Groupe (texte libre + suggestions)
        const tdGroupe = document.createElement("td");
        const inGroupe = document.createElement("input");
        inGroupe.type = "text";
        inGroupe.className = "input import-groupe";
        inGroupe.value = ""; // Laisse vide par défaut comme demandé

        inGroupe.setAttribute("list", "groups-list");
        tdGroupe.appendChild(inGroupe);

        // Stock min
        const tdMin = document.createElement("td");
        const inMin = document.createElement("input");
        inMin.type = "number";
        inMin.className = "input import-min";
        inMin.min = 0;
        inMin.max = 9999;
        inMin.value = info.stock_minimum;
        tdMin.appendChild(inMin);

        // Alerte
        const tdAlerte = document.createElement("td");
        tdAlerte.className = "center";
        const label = document.createElement("label");
        label.className = "check-label-small";
        const inAlerte = document.createElement("input");
        inAlerte.type = "checkbox";
        inAlerte.className = "import-alerte";
        inAlerte.checked = Boolean(info.alerte_active);
        label.append(inAlerte, " Activer");
        tdAlerte.appendChild(label);

        // Lots et Péremptions
        const tdDate = document.createElement("td");
        tdDate.className = "import-lot-container";
        const btnAddImportLot = document.createElement("button");
        btnAddImportLot.type = "button";
        btnAddImportLot.className = "btn btn-small";
        btnAddImportLot.textContent = "+";
        btnAddImportLot.style.marginBottom = "5px";
        
        const importLotsDiv = document.createElement("div");
        importLotsDiv.style.display = "flex";
        importLotsDiv.style.flexDirection = "column";
        importLotsDiv.style.gap = "5px";
        
        btnAddImportLot.onclick = () => {
            const rowDiv = document.createElement("div");
            rowDiv.style.display = "flex";
            rowDiv.style.gap = "5px";
            const inLot = document.createElement("input");
            inLot.type = "text";
            inLot.className = "input lot-val";
            inLot.placeholder = "Lot";
            inLot.style.width = "70px";
            const inPer = document.createElement("input");
            inPer.type = "text";
            inPer.className = "input date-val";
            inPer.placeholder = "JJ/MM/AAAA";
            inPer.style.width = "85px";
            // Quantité reçue sur ce lot (vide = répartie automatiquement)
            const inQte = document.createElement("input");
            inQte.type = "number";
            inQte.className = "input qte-val";
            inQte.placeholder = "Qté";
            inQte.min = 0;
            inQte.title = "Quantité reçue sur ce lot (vide = répartition automatique)";
            inQte.style.width = "60px";
            const btnDel = document.createElement("button");
            btnDel.type = "button";
            btnDel.className = "btn btn-small";
            btnDel.textContent = "X";
            btnDel.onclick = () => rowDiv.remove();
            rowDiv.append(inLot, inPer, inQte, btnDel);
            importLotsDiv.appendChild(rowDiv);
        };
        
        // Add one default empty row
        btnAddImportLot.onclick();
        
        tdDate.append(btnAddImportLot, importLotsDiv);

        // Seuil, alerte et péremption sont propres à chaque espace : si on
        // change la destination, on recharge les valeurs de CET espace, sinon
        // l'import écraserait ses réglages avec ceux du Commun.
        selUser.addEventListener("change", () => {
            const infoUser = getStockInfo(item.reference, selUser.value);
            inMin.value = infoUser.stock_minimum;
            inAlerte.checked = Boolean(infoUser.alerte_active);
        });

        tr.append(tdNum, tdFile, tdRef, tdScannette, tdNom, tdTypeCond, tdQteCond, tdQte, tdUser, tdGroupe, tdMin, tdAlerte, tdDate);
        tbody.appendChild(tr);
    });
}

/** Lots saisis sur une ligne de l'import ; qte null = part du reste de la quantité. */
function lireLotsImport(tr) {
    const lotsArray = [];
    for (const row of tr.querySelectorAll(".import-lot-container > div > div")) {
        const lVal = row.querySelector(".lot-val").value.trim();
        const dVal = row.querySelector(".date-val").value.trim();
        const qInput = row.querySelector(".qte-val");
        const qVal = qInput ? qInput.value.trim() : "";
        if (lVal || dVal) {
            // qte null => la quantité importée est répartie sur les lots saisis
            lotsArray.push({ lot: lVal, date: dVal, qte: qVal === "" ? null : (parseInt(qVal, 10) || 0) });
        }
    }
    return lotsArray;
}

/** Message listant les articles de la facture qui portent un lot déjà périmé. */
function controlerPeremptionsImport(rows) {
    const messages = [];
    for (let idx = 0; idx < rows.length; idx++) {
        const item = importItems[idx];
        if (!item) continue;
        const qteSaisie = parseInt(rows[idx].querySelector(".import-qte-base").value, 10);
        if ((Number.isNaN(qteSaisie) ? item.quantite : qteSaisie) <= 0) continue;   // ligne écartée
        const perimes = lireLotsImport(rows[idx])
            .filter(l => (l.qte === null || l.qte > 0) && estPerime(l.date));
        if (perimes.length > 0) messages.push(messageLotsPerimes(perimes, `l'article ${item.reference}`));
    }
    return messages.join("\n\n");
}

export async function validateImport() {
    if (importEnCours) return;
    importEnCours = true;
    const bouton = document.getElementById("import-validate");
    if (bouton) bouton.disabled = true;
    try {
        await validerImport();
    } finally {
        importEnCours = false;
        if (bouton) bouton.disabled = false;
    }
}

/**
 * Deux passes : toutes les lignes sont contrôlées (quantités, lots, dates,
 * codes-barres) AVANT le premier ajout. Une erreur sur une ligne n'importe
 * donc rien : corriger puis revalider ne crée pas de doublons.
 */
async function validerImport() {
    const { loadDB, findProduit } = await import('../core/database.js');

    const rows = document.querySelectorAll("#import-tbody tr");
    const db = loadDB();

    // Contrôle avant tout ajout : la facture n'est pas importée à moitié
    const perimes = controlerPeremptionsImport(rows);
    if (perimes) {
        await showMessage("⛔ Produit périmé", `${perimes}\n\nAucun article n'a été importé.`);
        return;
    }

    const preparees = [];
    for (let idx = 0; idx < rows.length; idx++) {
        const tr = rows[idx];
        const item = importItems[idx];
        if (!item) continue;

        const userDest = tr.querySelector(".import-user").value;
        const groupe = tr.querySelector(".import-groupe").value.trim();
        const stockMin = parseInt(tr.querySelector(".import-min").value, 10) || 0;
        const alerte = tr.querySelector(".import-alerte").checked ? 1 : 0;

        const lotsArray = lireLotsImport(tr);
        const lotsDetailsJson = JSON.stringify(lotsArray);
        const datePeremption = lotsArray.map(a => a.date).filter(Boolean).join(", ");
        const lot = lotsArray.map(a => a.lot).filter(Boolean).join(", ");

        const designation = item.designation || "";
        const typeStockage = tr.querySelector(".import-type-stock").value;
        const qteParCarton = parseInt(tr.querySelector(".import-qte-cond").value, 10) || 1;
        // `parseInt(...) || item.quantite` reprenait la quantité facturée dès
        // que la saisie valait 0 : impossible d'écarter une ligne. On ne
        // retombe sur la facture que si le champ est vide/illisible, et une
        // quantité négative est refusée (elle rendait le stock négatif, donc
        // la ligne invisible dans le placard).
        const qteBaseSaisie = parseInt(tr.querySelector(".import-qte-base").value, 10);
        const qteBase = Number.isNaN(qteBaseSaisie) ? item.quantite : qteBaseSaisie;

        if (qteBase < 0) {
            await showMessage(
                "Quantité invalide",
                `Article ${item.reference} : la quantité ne peut pas être négative (${qteBase}).\n\nAucun article n'a été importé.`
            );
            return;
        }
        if (qteBase === 0) {
            // Ligne volontairement écartée par l'utilisateur
            continue;
        }

        let qteAjouter = qteBase;
        let pUHT = item.prix_unitaire_ht;
        let pUTTC = item.prix_unitaire_ttc;

        if (estConditionnementGroupe(typeStockage)) {
            qteAjouter = qteBase * qteParCarton;
            pUHT = item.prix_unitaire_ht / qteParCarton;
            pUTTC = item.prix_unitaire_ttc / qteParCarton;
        }

        const sommeLotsImport = lotsArray.reduce((acc, a) => acc + (a.qte || 0), 0);
        if (sommeLotsImport > qteAjouter) {
            await showMessage(
                "Quantités incohérentes",
                `Article ${item.reference} : la somme des quantités par lot (${sommeLotsImport}) dépasse la quantité importée (${qteAjouter}).\n\nAucun article n'a été importé.`
            );
            return;
        }

        const illisibles = datesIllisibles(datePeremption);
        if (illisibles.length > 0) {
            await showMessage(
                "Date de péremption illisible",
                `Article ${item.reference} : « ${illisibles.join(" », « ")} » n'est pas une date reconnue.\n\n${MESSAGE_FORMATS_DATE}\n\nAucun article n'a été importé.`
            );
            return;
        }

        const scanInputs = tr.querySelectorAll(".import-scannette-val");
        let rowCodes = [];
        for (const inp of scanInputs) {
            rowCodes.push(...parseBarcodes(inp.value));
        }
        if (rowCodes.length === 0) {
            const fallbackInput = tr.querySelector(".import-scannette");
            if (fallbackInput && fallbackInput.value) {
                rowCodes.push(...parseBarcodes(fallbackInput.value));
            }
        }
        rowCodes = Array.from(new Set(rowCodes));
        let ref_scannette = formatBarcodes(rowCodes);

        if (!ref_scannette) {
            const shortDesignation = designation.length > 50 ? designation.substring(0, 50) + "..." : designation;
            const promptVal = window.prompt(`L'article ${item.reference} (${shortDesignation}) n'a pas de code-barres. Veuillez scanner ou saisir un code-barres :`);
            if (promptVal && promptVal.trim() !== "") {
                ref_scannette = formatBarcodes(promptVal);
            } else {
                const bypass = window.confirm(`Aucun code-barres saisi pour l'article ${item.reference}. Voulez-vous vraiment l'importer sans code-barres ?`);
                if (!bypass) {
                    await showMessage("Attention", "L'importation est interrompue : aucun article n'a été importé.");
                    return;
                }
                ref_scannette = "";
            }
        }

        preparees.push({
            item, qteAjouter, ref_scannette,
            options: {
                nom: designation,
                groupe: groupe,
                ref_scannette: ref_scannette,
                type_stockage: typeStockage,
                quantite_par_carton: qteParCarton,
                stock_minimum: stockMin,
                alerte_active: alerte,
                type_transaction: "ENTREE_FACTURE",
                utilisateur: userDest,
                date_peremption: datePeremption,
                date_import: todayFR(),
                fournisseur: item.fournisseur || "",
                prix_unitaire_ht: (typeof pUHT === "number") ? pUHT : null,
                prix_unitaire_ttc: (typeof pUTTC === "number") ? pUTTC : null,
                lot: lot,
                lots_details: lotsDetailsJson
            },
            ligne: `- ${qteAjouter}x ${item.reference} (${designation}) -> ${userDest}`
        });
    }

    if (preparees.length === 0) {
        await showMessage("Aucun article importé", "Toutes les lignes étaient à une quantité de 0 : rien n'a été ajouté au stock.");
        return;
    }

    // Seconde passe : tout est valide, les ajouts partent ensemble (un seul lot)
    const fichiers = new Map();
    for (const p of preparees) {
        if (p.ref_scannette) {
            const produit = findProduit(db, p.item.reference);
            if (produit && !produit.ref_scannette) produit.ref_scannette = p.ref_scannette;
        }
        ajouterStock(p.item.reference, p.qteAjouter, p.options);
        if (p.item.empreinte) fichiers.set(p.item.empreinte, { empreinte: p.item.empreinte, fichier: p.item.fichier || "" });
    }
    retenirFactures([...fichiers.values()]);

    document.getElementById("import-overlay").classList.add("hidden");
    await showMessage("Import réussi", "Les articles suivants ont été importés :\n" + preparees.map(p => p.ligne).join("\n"));
    checkAlerts();
}

// Export to window for global access
window.onPdfSelected = onPdfSelected;
window.validateImport = validateImport;
