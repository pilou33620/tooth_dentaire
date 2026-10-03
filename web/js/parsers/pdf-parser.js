"use strict";

/* ============================================================
   PDF Parser - Extraction de données depuis les factures PDF
   Équivalent de pdf_parser.py, via PDF.js
   ============================================================ */

import { parseNombreFR, round2, round4 } from '../core/utils.js';

/* Renvoie { items, erreur } : jamais de données inventées. L'ancienne version
   retombait sur un jeu d'essai en dur (CARTON-A1 x50, BOITE-B2 x200) quand
   PDF.js manquait — l'URL CDN étant morte, tout import proposait ces deux
   lignes fictives à l'enregistrement. Une erreur explicite vaut mieux. */
export async function extractStockFromPdf(file) {
    if (typeof pdfjsLib === "undefined") {
        return { items: [], erreur: "PDF.js n'a pas pu être chargé (web/vendor/pdf.min.js manquant ?). L'import de factures est indisponible." };
    }

    try {
        pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({
            data: buffer,
            isEvalSupported: false,
            disableFontFace: true
        }).promise;


        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(it => it.str).join(" ") + " ";
        }

        text = text.replace(/\n/g, " ");

        return { items: parseInvoiceText(text), erreur: null };
    } catch (e) {
        console.error("Erreur lors de la lecture du PDF :", e);
        return { items: [], erreur: `${file.name} : lecture impossible (${e && e.message ? e.message : e}).` };
    }
}

/* ------------------------------------------------------------
   Parsing des factures : on détecte d'abord le fournisseur,
   puis on applique UNIQUEMENT son parseur. (Avant, les deux
   regex tournaient sur tous les PDF, ce qui créait des doublons
   et des lignes fantômes suivant le fournisseur.)
   ------------------------------------------------------------ */

/* Exporté pour être testable sans PDF réel (cf. web/tests/regressions.test.js). */
export function parseInvoiceText(text) {
    const upper = text.toUpperCase();
    let items = [];

    if (upper.includes("HENRY SCHEIN")) {
        items = parseHenrySchein(text);
    } else if (upper.includes("GACD")) {
        items = parseGACD(text);
    } else {
        // Fournisseur inconnu : on tente les deux, HS d'abord
        items = parseHenrySchein(text);
        if (items.length === 0) items = parseGACD(text);
    }

    return mergeDuplicateItems(items);
}

function parseHenrySchein(text) {
    const results = [];

    // On ne garde que la partie "facture" : tout ce qui suit les
    // bons de colisage / étiquettes retour est ignoré, sinon on
    // récupère des doublons avec de mauvaises quantités.
    let zone = text;
    for (const marker of ["ETIQUETTE RETOUR", "Bon de colisage"]) {
        const idx = zone.indexOf(marker);
        if (idx !== -1) zone = zone.slice(0, idx);
    }

    // Colonnes HS : réf "999–9999" | désignation | QTE CMD | QTE LIVREE |
    // PRIX TARIF U.H.T | PRIX TARIF U.T.T.C | [REMISE%] |
    // PRIX UNIT. NET T.T.C | PRIX TOT. NET T.T.C | TVA.
    // Les quantités ont toujours 1 décimale (2.0, 10.0) et les prix 2
    // (69.99) : c'est le discriminant qui évite d'accrocher l'adresse
    // "2-4 RUE..." ou les téléphones de l'en-tête.
    const pattern = /(\d{3}[-–]\d{4})\s+(.{1,150}?)\s+(\d+\.\d)\s+(\d+\.\d)\s+(\d+\.\d{2})\s+(\d+\.\d{2})\s+(?:(\d+\.\d{2})%\s+)?(\d+\.\d{2})\s+(\d+\.\d{2})\s+(\d+\.\d)/g;

    let m;
    while ((m = pattern.exec(zone)) !== null) {
        const ref = m[1].replace(/–/g, "-").trim().toUpperCase();
        const designation = m[2].replace(/\s{2,}/g, " ").trim();
        const qte = Math.trunc(parseFloat(m[4])); // QTE LIVREE
        const prixUnitTTC = parseFloat(m[8]);
        const prixTotalTTC = parseFloat(m[9]);
        // `parseFloat(m[10]) || 20` transformait une ligne exonérée (TVA 0.0)
        // en ligne à 20 %, faussant le HT déduit et donc le CUMP.
        const tvaLue = parseFloat(m[10]);
        const tva = Number.isFinite(tvaLue) ? tvaLue : 20;
        // HS n'affiche pas le HT net par ligne : on le déduit du taux de TVA
        const prixUnitHT = round4(prixUnitTTC / (1 + tva / 100));
        const prixTotalHT = round2(prixTotalTTC / (1 + tva / 100));

        if (qte > 0 && !/FRAIS DE PORT/i.test(designation)) {
            results.push({
                fournisseur: "Henry Schein", reference: ref, designation, quantite: qte,
                prix_unitaire_ht: prixUnitHT, prix_unitaire_ttc: prixUnitTTC,
                prix_total_ht: prixTotalHT, prix_total_ttc: prixTotalTTC
            });
        }
    }
    return results;
}

function parseGACD(text) {
    const results = [];

    // On démarre au tableau des articles (première ligne "Commande ... du")
    // pour ignorer l'en-tête (montants TVA, IBAN, etc.).
    let zone = text;
    const start = zone.search(/Commande\s+\d+\s+du\s+\d{2}\.\d{2}\.\d{4}/);
    if (start !== -1) zone = zone.slice(start);

    // Colonnes GACD : réf numérique "103-41801" OU alphanumérique
    // "CS-2789" | désignation | quantité | prix unitaire réf TTC |
    // [remise %] | prix unitaire net TTC | prix total net TTC |
    // prix total net HT. Montants au format FR "1.234,56".
    const NUM = "\\d{1,4}(?:\\.\\d{3})*,\\d{2}";
    const pattern = new RegExp(
        "((?:[A-Z]{2,3}|\\d{1,4})[-–]\\d{1,6})\\s+(.{1,150}?)\\s+(\\d{1,4})\\s+(" + NUM + ")\\s+" +
        "(?:\\d{1,3},\\d{2}\\s*%\\s+)?(" + NUM + ")\\s+(" + NUM + ")\\s+(" + NUM + ")", "g");

    let m;
    while ((m = pattern.exec(zone)) !== null) {
        const ref = m[1].replace(/–/g, "-").trim().toUpperCase();
        const designation = m[2].replace(/\s{2,}/g, " ").trim();
        const qte = parseInt(m[3], 10);
        const prixUnitTTC = parseNombreFR(m[5]);
        const prixTotalTTC = parseNombreFR(m[6]);
        const prixTotalHT = parseNombreFR(m[7]);
        // GACD n'affiche pas le HT unitaire : on le déduit du total HT
        const prixUnitHT = qte > 0 ? round4(prixTotalHT / qte) : 0;

        if (qte > 0 && ref !== "200-000" && !/FRAIS DE PORT/i.test(designation)) {
            results.push({
                fournisseur: "GACD", reference: ref, designation, quantite: qte,
                prix_unitaire_ht: prixUnitHT, prix_unitaire_ttc: prixUnitTTC,
                prix_total_ht: prixTotalHT, prix_total_ttc: prixTotalTTC
            });
        }
    }
    return results;
}

/* Une même réf peut apparaître sur plusieurs commandes d'une même
   facture (ex : GACD n° 2402298301) : on additionne quantités et
   totaux au lieu de créer deux lignes d'import. Les prix unitaires
   sont conservés (identiques d'une commande à l'autre). */
function mergeDuplicateItems(items) {
    const map = new Map();
    for (const it of items) {
        const key = it.fournisseur + "|" + it.reference;
        if (map.has(key)) {
            const e = map.get(key);
            e.quantite += it.quantite;
            e.prix_total_ht = round2(e.prix_total_ht + it.prix_total_ht);
            e.prix_total_ttc = round2(e.prix_total_ttc + it.prix_total_ttc);
        } else {
            map.set(key, Object.assign({}, it));
        }
    }
    return Array.from(map.values());
}
