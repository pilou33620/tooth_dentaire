"use strict";

/* ============================================================
   Gestion Scannette Code-Barre
   ============================================================ */

import { USERS } from '../core/constants.js';
import { loadDB, findStockEntry } from '../core/database.js';
import { matchesBarcode, fermerMessage } from '../core/utils.js';

let barcodeBuffer = "";
let lastKeyTime = 0;
// Délai maximal entre deux caractères d'une scannette (au-delà : frappe humaine)
const DELAI_SCAN = 100;

/** Champ de saisie : la douchette y tape directement, on ne l'intercepte pas. */
function estChampDeSaisie(cible) {
    if (!cible) return false;
    const balise = cible.tagName;
    // Un <select> changeait d'option ET lançait la recherche du code scanné
    return balise === "INPUT" || balise === "TEXTAREA" || balise === "SELECT" || Boolean(cible.isContentEditable);
}

document.addEventListener("keydown", (e) => {
    if (estChampDeSaisie(e.target)) {
        return;
    }

    const currentTime = Date.now();

    // Certaines douchettes terminent le code par Tab au lieu d'Entrée : on
    // ne le prend comme fin de scan que juste après une saisie rapide.
    const finParTab = e.key === "Tab" && barcodeBuffer.length >= 4
        && currentTime - lastKeyTime <= DELAI_SCAN;

    if (e.key === "Enter" || finParTab) {
        // L'Enter de fin de scan est traité AVANT tout test de délai : certaines
        // douchettes l'envoient plus de 100 ms après le dernier caractère, et le
        // buffer était alors vidé juste avant, faisant perdre le scan en silence.
        if (barcodeBuffer.length > 0) {
            e.preventDefault();
            traiterCodeBarre(barcodeBuffer);
            barcodeBuffer = "";
        }
    } else if (e.key.length === 1) { // Caractère normal (pas Shift, Ctrl...)
        // Une scannette tape très vite (généralement < 50 ms par caractère) :
        // au-delà de 100 ms entre deux caractères, c'était une frappe humaine.
        if (currentTime - lastKeyTime > DELAI_SCAN) {
            barcodeBuffer = "";
        }
        barcodeBuffer += e.key;
    }

    lastKeyTime = currentTime;
});

function traiterCodeBarre(code) {
    let codeNettoye = code.trim();
    if (!codeNettoye) return;

    const db = loadDB();

    // 0. A-t-on un produit dont l'une des ref_scannette correspond ?
    const prod = db.produits.find(p => matchesBarcode(p.ref_scannette, codeNettoye));
    if (prod) {
        codeNettoye = prod.reference; // On bascule sur la référence interne
    }

    const placardOverlay = document.getElementById("placard-overlay");

    if (!placardOverlay.classList.contains("hidden")) {
        // Un placard est déjà ouvert : on filtre simplement par cette référence
        document.getElementById("filter-ref").value = codeNettoye;
        if (typeof window.filterPlacardTable === "function") {
            window.filterPlacardTable();
        }
    } else {
        // Aucun placard n'est ouvert. On cherche où est le produit.
        let foundUser = null;

        // 1. On cherche en priorité si un emplacement a du stock
        for (const u of USERS) {
            const entry = findStockEntry(db, codeNettoye, u);
            if (entry && entry.quantite > 0) {
                foundUser = u;
                break;
            }
        }

        // 2. Sinon, a-t-il au moins une entrée de stock (même vide) quelque part ?
        if (!foundUser) {
            for (const u of USERS) {
                const entry = findStockEntry(db, codeNettoye, u);
                if (entry) {
                    foundUser = u;
                    break;
                }
            }
        }

        // 3. Par défaut, s'il est totalement inconnu, on ouvre "Commun"
        if (!foundUser) {
            foundUser = "Commun";
        }

        // Fermer les autres modales si besoin
        document.getElementById("user-overlay").classList.add("hidden");
        fermerMessage();
        document.getElementById("alerts-overlay").classList.add("hidden");
        document.getElementById("import-overlay").classList.add("hidden");

        // Ouvrir le placard avec la recherche pré-remplie
        if (typeof window.openPlacard === "function") {
            window.openPlacard(foundUser, codeNettoye);
        }
    }
}
