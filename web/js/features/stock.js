"use strict";

/* ============================================================
   Stock Management - Gestion du stock
   ============================================================ */

import { loadDB, saveDB, findProduit, findStockEntry, ajouterProduit, addTransaction, persister } from '../core/database.js';
import {
    normalizeLots, serializeLots, mergeLots, totalLots, lotsToString, datesToString,
    lotsLabel, lotsFromStrings, retirerDesLots, retirerFEFO, appliquerLots, toInt
} from './lots.js';

/**
 * Lots quantifiés d'une ligne de stock.
 * - lots_details renseigné : les quantités manquantes sont réparties sur la quantité totale.
 * - anciennes lignes sans lots_details mais avec des n° de lot en clair :
 *   on les convertit en lots quantifiés pour pouvoir les gérer à l'unité.
 */
function lotsDeLEntree(entry) {
    if (!entry) return [];
    const qte = Math.max(0, toInt(entry.quantite));
    const lots = normalizeLots(entry.lots_details, qte);
    if (lots.length > 0) return lots;
    if (qte > 0 && entry.lot && String(entry.lot).trim() !== "") {
        return lotsFromStrings(entry.lot, entry.date_peremption, qte);
    }
    return [];
}

/** Retourne [{reference, nom, quantite, groupe, stock_minimum, alerte_active, date_peremption, date_import}, ...] */
export function getStock(utilisateur = "Commun") {
    const db = loadDB();
    // Ne jamais filtrer sur la quantité : une ligne devenue négative (base
    // corrompue, import fautif) disparaissait complètement du placard et
    // devenait donc impossible à corriger depuis l'interface. On l'affiche
    // désormais, ramenée à 0.
    const filterFn = utilisateur === "TOUS"
        ? () => true
        : s => s.utilisateur === utilisateur;

    return db.stock
        .filter(filterFn)
        .map(s => {
            const p = findProduit(db, s.reference);
            // Lots avec quantités (les anciennes bases sans "qte" sont complétées)
            const lots = lotsDeLEntree(s);

            let datePeremp = s.date_peremption || "";
            let lotVal = s.lot || "";
            if (lots.length > 0) {
                if (!datePeremp) datePeremp = datesToString(lots);
                if (!lotVal) lotVal = lotsToString(lots);
            }

            return {
                utilisateur: s.utilisateur,
                reference: s.reference,
                nom: (p && p.nom) || "",
                quantite: Math.max(0, toInt(s.quantite)),
                groupe: (p && p.groupe) || "",
                ref_scannette: (p && p.ref_scannette) || "",
                type_stockage: (p && p.type_stockage) || "unite",
                quantite_par_carton: (p && p.quantite_par_carton) || 1,
                arrete: (p && p.arrete) ? 1 : 0,
                stock_minimum: s.stock_minimum || 0,
                alerte_active: s.alerte_active || 0,
                alerte_peremption_active: s.alerte_peremption_active !== undefined ? s.alerte_peremption_active : 0,
                delai_peremption: (s.delai_peremption !== undefined && s.delai_peremption !== null && s.delai_peremption !== "") ? s.delai_peremption : 30,
                date_peremption: datePeremp,
                date_import: s.date_import || "",
                fournisseur: s.fournisseur || "",
                en_commande: s.en_commande || 0,
                date_commande: s.date_commande || "",
                lot: lotVal,
                prix_unitaire_ht: s.prix_unitaire_ht || 0,
                prix_unitaire_ttc: s.prix_unitaire_ttc || 0,
                lots_details: lots.length > 0 ? serializeLots(lots) : (s.lots_details || "[]"),
                // Détail des lots (quantité par lot) + libellé d'affichage "LOT-A ×5"
                lots: lots,
                lot_label: lots.length > 0 ? lotsLabel(lots) : lotVal,
                quantite_lots: totalLots(lots),
                quantite_sans_lot: Math.max(0, toInt(s.quantite) - totalLots(lots))
            };
        });
}

export function ajouterStock(reference, quantite, { nom = "", groupe = "", ref_scannette = "", type_stockage = "unite", quantite_par_carton = 1, stock_minimum = undefined, alerte_active = undefined, alerte_peremption_active = undefined, delai_peremption = undefined, type_transaction = "ENTREE", utilisateur = "Commun", date_peremption = "", date_import = "", fournisseur = "", prix_unitaire_ht = null, prix_unitaire_ttc = null, lot = "", lots_details = "[]" } = {}) {
    const db = loadDB();
    ajouterProduit(db, reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton);

    if (utilisateur === "Salle de chir" && quantite > 0) {
        if (!lot) {
            lot = window.prompt(`Saisir le numéro de lot pour ${reference} (laisser vide si aucun) :`) || "";
        }
    }

    const entry = findStockEntry(db, reference, utilisateur);
    if (entry) {
        let ancienne_qte = Math.max(0, entry.quantite);
        // Lots existants : quantités lues AVANT la mise à jour de la quantité totale
        const lotsExistants = lotsDeLEntree(entry);
        // Bornage à 0 : une entrée négative plus grande que le stock rendait la
        // quantité négative, et la ligne devenait invisible dans le placard.
        entry.quantite = Math.max(0, ancienne_qte + quantite);
        let nouvelle_qte_totale = entry.quantite;

        // Seuls les réglages effectivement transmis sont écrasés : le reste des
        // champs suit déjà cette règle, et un appelant qui ne repasse pas les
        // seuils remettait auparavant stock_minimum et alerte_active à 0.
        if (stock_minimum !== undefined) entry.stock_minimum = stock_minimum;
        if (alerte_active !== undefined) entry.alerte_active = alerte_active;
        if (alerte_peremption_active !== undefined) entry.alerte_peremption_active = alerte_peremption_active;
        if (delai_peremption !== undefined) entry.delai_peremption = delai_peremption;
        if (date_import !== "") entry.date_import = date_import;
        if (fournisseur !== "") entry.fournisseur = fournisseur;

        if (lots_details && lots_details !== "[]") {
            // Les quantités des lots entrants sont additionnées à celles déjà en stock
            const lotsEntrants = normalizeLots(lots_details, quantite);
            const merged = mergeLots(lotsExistants, lotsEntrants);
            appliquerLots(entry, merged);
        } else if (lot !== "" && quantite > 0) {
            // Saisie simple : on la convertit en lot quantifié pour garder
            // une quantité par lot exploitable à la sortie
            const merged = mergeLots(lotsExistants, lotsFromStrings(lot, date_peremption, quantite));
            appliquerLots(entry, merged);
        } else {
            if (date_peremption !== "") {
                let existingDates = (entry.date_peremption || "").split(/[,;]+/).map(p => p.trim()).filter(p => p !== "");
                let newDates = date_peremption.split(/[,;]+/).map(p => p.trim()).filter(p => p !== "");
                for (let d of newDates) {
                    if (!existingDates.includes(d)) existingDates.push(d);
                }
                entry.date_peremption = existingDates.join(", ");
            }
            if (lot !== "") {
                let lotsArr = (entry.lot || "").split(/[,;]+/).map(p => p.trim()).filter(p => p !== "");
                let newLots = lot.split(/[,;]+/).map(p => p.trim()).filter(p => p !== "");
                for (let l of newLots) {
                    if (!lotsArr.includes(l)) lotsArr.push(l);
                }
                entry.lot = lotsArr.join(", ");
            }
        }

        // Calcul du CUMP (Coût Unitaire Moyen Pondéré)
        if (nouvelle_qte_totale > 0 && quantite > 0) {
            if (prix_unitaire_ht !== null) {
                let ancien_prix_ht = entry.prix_unitaire_ht || 0;
                entry.prix_unitaire_ht = ((ancienne_qte * ancien_prix_ht) + (quantite * prix_unitaire_ht)) / nouvelle_qte_totale;
            }
            if (prix_unitaire_ttc !== null) {
                let ancien_prix_ttc = entry.prix_unitaire_ttc || 0;
                entry.prix_unitaire_ttc = ((ancienne_qte * ancien_prix_ttc) + (quantite * prix_unitaire_ttc)) / nouvelle_qte_totale;
            }
        } else if (nouvelle_qte_totale <= 0 || quantite <= 0) {
            // Si on ne fait pas d'entrée (quantité <= 0) ou que le stock est vide/négatif,
            // on conserve la valeur de l'ancien prix ou on écrase par le nouveau si applicable
            if (prix_unitaire_ht !== null) entry.prix_unitaire_ht = prix_unitaire_ht;
            if (prix_unitaire_ttc !== null) entry.prix_unitaire_ttc = prix_unitaire_ttc;
        }
    } else {
        const activePeremp = alerte_peremption_active !== undefined ? alerte_peremption_active : (date_peremption ? 1 : 0);
        const dPeremp = (delai_peremption !== undefined && delai_peremption !== null && delai_peremption !== "") ? delai_peremption : 30;

        // Nouvelle ligne de stock : on quantifie les lots dès la création
        let lotsNouveaux = normalizeLots(lots_details, quantite);
        if (lotsNouveaux.length === 0 && lot !== "" && quantite > 0) {
            lotsNouveaux = lotsFromStrings(lot, date_peremption, quantite);
        }
        const lotsJson = lotsNouveaux.length > 0 ? serializeLots(lotsNouveaux) : "[]";
        const lotFinal = lotsNouveaux.length > 0 ? lotsToString(lotsNouveaux) : lot;
        const dateFinale = (lotsNouveaux.length > 0 && datesToString(lotsNouveaux) !== "")
            ? datesToString(lotsNouveaux)
            : date_peremption;

        db.stock.push({ reference, utilisateur, quantite: Math.max(0, toInt(quantite)), stock_minimum: stock_minimum ?? 0, alerte_active: alerte_active ?? 0, alerte_peremption_active: activePeremp, delai_peremption: dPeremp, date_peremption: dateFinale, date_import, fournisseur, prix_unitaire_ht: prix_unitaire_ht ?? 0, prix_unitaire_ttc: prix_unitaire_ttc ?? 0, date_commande: "", lot: lotFinal, lots_details: lotsJson });
    }

    if (prix_unitaire_ht !== null || prix_unitaire_ttc !== null) {
        if (!db.historique_prix) db.historique_prix = [];
        const histItem = {
            reference: reference,
            date: new Date().toISOString(),
            prix_ht: prix_unitaire_ht,
            prix_ttc: prix_unitaire_ttc,
            fournisseur: fournisseur
        };
        db.historique_prix.push(histItem);
        persister("addHistoriquePrix", JSON.stringify(histItem));
    }

    addTransaction(db, reference, utilisateur, type_transaction, quantite, lot);

    // Réinitialiser la date de péremption si le stock est <= 0
    const e = findStockEntry(db, reference, utilisateur);
    if (e && e.quantite <= 0 && (!e.lots_details || e.lots_details === "[]")) e.date_peremption = "";

    persister("updateStockItem", JSON.stringify(e || { reference, utilisateur, quantite: Math.max(0, toInt(quantite)), stock_minimum: stock_minimum ?? 0, alerte_active: alerte_active ?? 0, alerte_peremption_active: 0, delai_peremption: 30, date_peremption, date_import, fournisseur, prix_unitaire_ht: prix_unitaire_ht ?? 0, prix_unitaire_ttc: prix_unitaire_ttc ?? 0, date_commande: "", lot, lots_details }));
    saveDB(db);
}

export function setStockAbsolu(reference, quantite, { nom = "", groupe = "", ref_scannette = "", type_stockage = "unite", quantite_par_carton = 1, stock_minimum = 0, alerte_active = 0, alerte_peremption_active = 0, delai_peremption = 30, utilisateur = "Commun", date_peremption = "", date_import = "", fournisseur = "", en_commande = 0, date_commande = "", lot = "", prix_unitaire_ht = null, prix_unitaire_ttc = null, lots_details = null } = {}) {
    const db = loadDB();
    ajouterProduit(db, reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton);

    const entry = findStockEntry(db, reference, utilisateur);
    const oldQte = entry ? entry.quantite : 0;
    const diff = quantite - oldQte;

    if (utilisateur === "Salle de chir" && diff > 0) {
        if (!lot) {
            lot = window.prompt(`Saisir le numéro de lot pour ${reference} (laisser vide si aucun) :`) || "";
        }
    }

    if (entry) {
        entry.nom = nom;
        entry.groupe = groupe;
        entry.quantite = quantite;
        entry.stock_minimum = stock_minimum;
        entry.alerte_active = alerte_active;
        entry.alerte_peremption_active = alerte_peremption_active;
        entry.delai_peremption = delai_peremption;
        entry.date_peremption = date_peremption;
        entry.en_commande = en_commande;
        entry.date_commande = date_commande;
        if (date_import !== "") entry.date_import = date_import;
        if (fournisseur !== "") entry.fournisseur = fournisseur;
        if (prix_unitaire_ht !== null) entry.prix_unitaire_ht = prix_unitaire_ht;
        if (prix_unitaire_ttc !== null) entry.prix_unitaire_ttc = prix_unitaire_ttc;
        entry.lot = lot;
        if (lots_details !== null) {
            // Les quantités par lot sont normalisées sur la quantité absolue saisie
            const lotsNorm = normalizeLots(lots_details, quantite);
            entry.lots_details = serializeLots(lotsNorm);
            if (lotsNorm.length > 0) {
                entry.lot = lotsToString(lotsNorm);
                entry.date_peremption = datesToString(lotsNorm);
            }
        }

        if (entry.quantite <= 0) {
            entry.quantite = 0;
            entry.date_peremption = "";
            entry.lot = "";
            entry.lots_details = "[]";
        }
    } else {
        const finalQte = Math.max(0, quantite);
        const lotsNorm = finalQte > 0 ? normalizeLots(lots_details, finalQte) : [];
        db.stock.push({
            reference, utilisateur, nom, groupe,
            quantite: finalQte,
            stock_minimum, alerte_active, alerte_peremption_active, delai_peremption,
            en_commande, date_commande,
            date_peremption: finalQte > 0 ? date_peremption : "",
            date_import, fournisseur,
            lot: finalQte > 0 ? lot : "",
            lots_details: serializeLots(lotsNorm),
            prix_unitaire_ht: prix_unitaire_ht ?? 0,
            prix_unitaire_ttc: prix_unitaire_ttc ?? 0
        });
    }

    // Pas de transaction quand la quantité n'a pas bougé (édition du nom, du
    // fournisseur, d'un lot...) : l'historique restait pollué de lignes à 0.
    if (diff !== 0) {
        addTransaction(db, reference, utilisateur, "AJUSTEMENT_MANUEL", diff, lot);
    }
    persister("updateStockItem", JSON.stringify(findStockEntry(db, reference, utilisateur)));
    saveDB(db);
}

/**
 * Entrée de stock lot par lot : ajoute X unités sur chacun des lots fournis.
 * Les lots inconnus sont créés, les lots déjà présents sont incrémentés.
 *
 * @param {string} reference
 * @param {string} utilisateur
 * @param {Array}  entrees  [{ lot, date, qte }]
 * @returns {{ok: boolean, message: string, entrees: Array, total: number}}
 */
export function ajouterStockParLots(reference, utilisateur, entrees, options = {}) {
    const db = loadDB();
    const entry = findStockEntry(db, reference, utilisateur);
    if (!entry) return { ok: false, message: "Article introuvable dans cet espace.", entrees: [], total: 0 };

    const propres = (entrees || [])
        .map(e => ({ lot: String(e.lot ?? "").trim(), date: String(e.date ?? "").trim(), qte: toInt(e.qte) }))
        .filter(e => e.qte > 0);

    if (propres.length === 0) {
        return { ok: false, message: "Aucune quantité à ajouter.", entrees: [], total: 0 };
    }

    const ancienneQte = Math.max(0, toInt(entry.quantite));
    const lotsExistants = lotsDeLEntree(entry);
    const total = propres.reduce((s, e) => s + e.qte, 0);

    // Date(s) de péremption déjà enregistrées sans numéro de lot : elles ne
    // doivent pas disparaître (et donc désactiver l'alerte) en ajoutant un lot
    const datesSansLot = (lotsExistants.length === 0 && ancienneQte > 0)
        ? String(entry.date_peremption || "").split(/[,;]+/).map(d => d.trim()).filter(Boolean)
        : [];

    entry.quantite = ancienneQte + total;
    appliquerLots(entry, mergeLots(lotsExistants, propres));

    if (datesSansLot.length > 0) {
        const dejaLa = String(entry.date_peremption || "").split(/[,;]+/).map(d => d.trim()).filter(Boolean);
        const aGarder = datesSansLot.filter(d => !dejaLa.includes(d));
        if (aGarder.length > 0) entry.date_peremption = dejaLa.concat(aGarder).join(", ");
    }

    const type_transaction = options.type_transaction || "ENTREE_LOT";
    for (const e of propres) {
        addTransaction(db, reference, utilisateur, type_transaction, e.qte, e.lot, e.date);
    }

    persister("updateStockItem", JSON.stringify(entry));
    saveDB(db);
    return { ok: true, message: "", entrees: propres, total };
}

/**
 * Sortie de stock, avec ventilation par lot.
 *
 * @param {string} reference
 * @param {number} quantite     quantité totale à sortir (ignorée si options.sorties est fourni)
 * @param {string} utilisateur
 * @param {object} options
 *   - sorties : [{ index?, lot, date, qte }] quantités à sortir lot par lot.
 *               La quantité totale sortie devient la somme de ces quantités
 *               (plus options.hors_lot le cas échéant).
 *   - hors_lot : quantité sortie sans numéro de lot (stock non ventilé en lots).
 *   - lot / date : sortie de la totalité de `quantite` sur ce seul lot.
 *   - type_transaction : libellé de la transaction (défaut "SORTIE_STOCK").
 *   Sans lot précisé, la sortie est ventilée automatiquement en FEFO
 *   (le lot qui périme le plus tôt est consommé en premier).
 *
 * @returns {{ok: boolean, message: string, sorties: Array}}
 */
export function sortirStockDetail(reference, quantite, utilisateur = "Commun", options = {}) {
    const db = loadDB();
    const entry = findStockEntry(db, reference, utilisateur);
    const type_transaction = options.type_transaction || "SORTIE_STOCK";

    const demandesExplicites = Array.isArray(options.sorties)
        ? options.sorties.filter(d => toInt(d.qte) > 0)
        : null;

    const sommeExplicite = demandesExplicites
        ? demandesExplicites.reduce((s, d) => s + toInt(d.qte), 0)
        : 0;
    const horsLotDemande = toInt(options.hors_lot);

    let qteTotale = (sommeExplicite > 0 || horsLotDemande > 0)
        ? sommeExplicite + horsLotDemande
        : toInt(quantite);

    if (!entry) return { ok: false, message: "Article introuvable dans cet espace.", sorties: [] };
    if (qteTotale <= 0) return { ok: false, message: "La quantité à sortir doit être supérieure à 0.", sorties: [] };
    if (entry.quantite < qteTotale) {
        return { ok: false, message: `Quantité insuffisante : ${entry.quantite} en stock, ${qteTotale} demandé(s).`, sorties: [] };
    }

    const lots = lotsDeLEntree(entry);
    let sorties = [];
    let lotsRestants = lots;

    if (lots.length > 0) {
        let demandes = demandesExplicites;
        if (!demandes || demandes.length === 0) {
            // La part explicitement sortie hors lot n'est pas prélevée sur les lots
            const qteSurLots = qteTotale - horsLotDemande;
            if (qteSurLots <= 0) {
                demandes = [];
            } else if (options.lot !== undefined && options.lot !== null && options.lot !== "") {
                demandes = [{ lot: options.lot, date: options.date, qte: qteSurLots }];
            } else {
                demandes = retirerFEFO(lots, qteSurLots).demandes;
            }
        }
        const res = retirerDesLots(lots, demandes);
        if (!res.ok) return { ok: false, message: res.message, sorties: [] };
        sorties = res.sorties;
        lotsRestants = res.lots;
    } else if (options.lot && qteTotale - horsLotDemande > 0) {
        // Pas de lot enregistré : on trace tout de même le lot saisi
        sorties = [{ lot: options.lot, date: options.date || "", qte: qteTotale - horsLotDemande }];
    }

    entry.quantite -= qteTotale;
    if (entry.quantite <= 0) {
        entry.quantite = 0;
        entry.date_peremption = "";
        entry.lot = "";
        entry.lots_details = "[]";
    } else if (lots.length > 0) {
        appliquerLots(entry, lotsRestants);
    }

    // Une transaction par lot sorti : l'historique reste exploitable
    if (sorties.length > 0) {
        for (const s of sorties) {
            addTransaction(db, reference, utilisateur, type_transaction, s.qte, s.lot, s.date || "");
        }
        const horsLot = qteTotale - sorties.reduce((s, x) => s + toInt(x.qte), 0);
        if (horsLot > 0) {
            addTransaction(db, reference, utilisateur, type_transaction, horsLot, "", "");
        }
    } else {
        addTransaction(db, reference, utilisateur, type_transaction, qteTotale, "", options.date || "");
    }

    persister("updateStockItem", JSON.stringify(entry));
    saveDB(db);
    return { ok: true, message: "", sorties };
}

/** Version booléenne (compatibilité) : voir sortirStockDetail. */
export function sortirStock(reference, quantite, utilisateur = "Commun", options = {}) {
    return sortirStockDetail(reference, quantite, utilisateur, options).ok;
}
