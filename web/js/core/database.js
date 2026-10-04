"use strict";

/* ============================================================
   Database Layer - Gestion de la base de données
   Cache en mémoire de la base ; chaque modification est envoyée
   au serveur (python/base.py) par persister() (voir api.js).

   Structure :
   {
     produits:     [ { reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton } ],
                   type_stockage : 'unite' | 'carton' | 'boite' (cf. CONDITIONNEMENTS)
                   quantite_par_carton : nombre d'unités par contenant (carton ou boîte)
     stock:        [ { reference, utilisateur, quantite, stock_minimum,
                       alerte_active, date_peremption, date_import, ... } ],
     transactions: [ { id, date, reference, utilisateur, type_transaction, quantite, lot, peremption_sortie } ],
     autoclave:    [ { id, date, utilisateur, commentaire, machine } ],
     historique_prix: [ { id, reference, date, prix_ht, prix_ttc, fournisseur } ],
     nextTxId, nextAutoId
   }
   ============================================================ */

import { formatBarcodes } from './utils.js';
import { persister } from './api.js';

export { persister };

let _dbCache = null;

export function setDbCache(db) {
    _dbCache = db;
}

export function initDB() {
    /* Les tables sont créées par le serveur (python/base.py). */
}

export function loadDB() {
    if (_dbCache && typeof _dbCache === "object") return _dbCache;
    // Cache vide : on le crée une fois pour que les écritures faites avant
    // le chargement (ou dans les tests) ne se perdent pas.
    _dbCache = { produits: [], stock: [], transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1 };
    return _dbCache;
}

export function saveDB(db) {
    _dbCache = db;
}

export function findProduit(db, reference) {
    return db.produits.find(p => p.reference === reference);
}

export function findStockEntry(db, reference, utilisateur) {
    return db.stock.find(s => s.reference === reference && s.utilisateur === utilisateur);
}

export function addTransaction(db, reference, utilisateur, type_transaction, quantite, lot = "", peremption_sortie = "") {
    const newTx = {
        id: db.nextTxId++,
        date: new Date().toISOString(),
        reference,
        utilisateur,
        type_transaction,
        quantite,
        lot,
        peremption_sortie
    };
    db.transactions.push(newTx);
    persister("addTransaction", JSON.stringify(newTx));
}

export function getAllGroups() {
    const db = loadDB();
    const groups = new Set();
    for (const p of db.produits) {
        if (p.groupe) groups.add(p.groupe);
    }
    return [...groups];
}

export function getStockInfo(reference, utilisateur = "Commun") {
    const db = loadDB();
    const p = findProduit(db, reference);
    const s = findStockEntry(db, reference, utilisateur);
    return {
        groupe: (p && p.groupe) || "",
        ref_scannette: (p && p.ref_scannette) || "",
        type_stockage: (p && p.type_stockage) || "unite",
        quantite_par_carton: (p && p.quantite_par_carton) || 1,
        stock_minimum: (s && s.stock_minimum) || 0,
        alerte_active: (s && s.alerte_active) || 0,
        alerte_peremption_active: (s && s.alerte_peremption_active !== undefined) ? s.alerte_peremption_active : 0,
        delai_peremption: (s && s.delai_peremption !== undefined && s.delai_peremption !== null && s.delai_peremption !== "") ? s.delai_peremption : 30,
        date_peremption: (s && s.date_peremption) || ""
    };
}

/** « Ne plus commander » : produit arrêté, hors post-it, alertes et liste de courses. */
export function setProduitArrete(reference, arrete) {
    const db = loadDB();
    const p = findProduit(db, reference);
    if (!p) return;
    const valeur = arrete ? 1 : 0;
    if ((p.arrete ? 1 : 0) === valeur) return;
    p.arrete = valeur;
    persister("updateProduit", JSON.stringify(p));
}

export function ajouterProduit(db, reference, nom = "", groupe = "", ref_scannette = "", type_stockage = "unite", quantite_par_carton = 1) {
    const p = findProduit(db, reference);
    const formattedScannette = formatBarcodes(ref_scannette);
    if (!p) {
        db.produits.push({ reference, nom, groupe, ref_scannette: formattedScannette, type_stockage, quantite_par_carton });
    } else {
        // Comme l'upsert SQL : ne remplace que si non vide
        if (nom !== "") p.nom = nom;
        if (groupe !== "") p.groupe = groupe;
        if (ref_scannette !== "") p.ref_scannette = formattedScannette;
        p.type_stockage = type_stockage;
        p.quantite_par_carton = quantite_par_carton;
    }
    persister("updateProduit", JSON.stringify(findProduit(db, reference)));
}
