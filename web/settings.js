"use strict";

/* ============================================================
   Réglages et exports (Excel)

   Les exports sont générés par le serveur (python/exports.py) et
   téléchargés par le navigateur du poste qui les demande.
   window.api / window.exporter sont fournis par js/core/api.js.
   ============================================================ */

const escapeHtml = (typeof window !== "undefined" && window.escapeHtml) ? window.escapeHtml : function(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

function afficherMessage(titre, texte) {
    if (typeof window.showMessage === "function") return window.showMessage(titre, texte);
    alert(texte);
    return Promise.resolve();
}

/** Lance un export, en indiquant l'attente sur le bouton. */
async function lancerExport(bouton, type, parametres, messageSucces) {
    const texteInitial = bouton ? bouton.textContent : "";
    if (bouton) {
        bouton.textContent = "Génération...";
        bouton.disabled = true;
    }
    try {
        const resultat = await window.exporter(type, parametres);
        if (resultat.status === "Succès") {
            await afficherMessage("Succès", messageSucces);
        } else {
            await afficherMessage("Information", resultat.status);
        }
        return resultat;
    } catch (e) {
        await afficherMessage("Erreur", e.message);
        return null;
    } finally {
        if (bouton) {
            bouton.textContent = texteInitial;
            bouton.disabled = false;
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const btnSettings = document.getElementById("btn-settings");
    const settingsOverlay = document.getElementById("settings-overlay");
    const dbPathInput = document.getElementById("settings-db-path");
    const btnSelectDb = document.getElementById("settings-btn-select-db");
    const dbInfo = document.getElementById("settings-db-info");

    if (btnSettings && settingsOverlay) {
        btnSettings.addEventListener("click", async () => {
            settingsOverlay.classList.remove("hidden");

            const adresses = document.getElementById("settings-adresses");
            const version = document.getElementById("settings-version");
            try {
                const info = await window.api("GET", "/api/info");
                if (adresses) {
                    adresses.textContent = info.adresses_reseau.length > 0
                        ? info.adresses_reseau.join("  ·  ")
                        : "Accès réseau désactivé (serveur lancé avec --local).";
                }
                if (version) version.textContent = `Version ${info.version}`;
            } catch (e) {
                if (adresses) adresses.textContent = e.message;
            }

            try {
                const base = await window.api("GET", "/api/base");
                dbPathInput.value = base.chemin || "";
                dbPathInput.readOnly = !base.modifiable;
                btnSelectDb.disabled = !base.modifiable;
                if (dbInfo) {
                    dbInfo.textContent = base.modifiable
                        ? "Saisir le chemin complet d'un fichier .db existant."
                        : "Le changement de base se fait sur le poste qui fait tourner le serveur.";
                }
            } catch (e) {
                dbPathInput.value = e.message;
            }
        });
    }

    if (btnSelectDb) {
        btnSelectDb.addEventListener("click", async () => {
            const chemin = dbPathInput.value.trim();
            if (!chemin) return;
            if (!confirm(`Utiliser la base :\n${chemin}\n\nTous les postes du cabinet passeront sur cette base.`)) return;
            btnSelectDb.disabled = true;
            try {
                const res = await window.api("POST", "/api/base", { chemin });
                dbPathInput.value = res.chemin;
                // Tous les postes rechargent les données à leur prochaine vérification ;
                // ce poste-ci recharge immédiatement.
                window.location.reload();
            } catch (e) {
                await afficherMessage("Base de données", e.message);
            } finally {
                btnSelectDb.disabled = false;
            }
        });
    }

    const btnCustomization = document.getElementById("settings-btn-customization");
    if (btnCustomization) {
        btnCustomization.addEventListener("click", () => {
            settingsOverlay.classList.add("hidden");
            if (typeof toggleCustomizationMode === "function") {
                toggleCustomizationMode(true);
            }
        });
    }

    const btnGenerateOrderList = document.getElementById("settings-btn-generate-order-list");
    if (btnGenerateOrderList) {
        btnGenerateOrderList.addEventListener("click", async () => {
            const resultat = await lancerExport(btnGenerateOrderList, "liste-courses", {},
                "La liste de courses a été générée et les articles ont été marqués comme commandés !");
            if (resultat && resultat.status === "Succès" && resultat.references && resultat.references.length > 0
                && typeof window.markReferencesAsOrdered === "function") {
                window.markReferencesAsOrdered(resultat.references);
            }
        });
    }

    const btnExtractChir = document.getElementById("settings-btn-extract-chir");
    if (btnExtractChir) {
        btnExtractChir.addEventListener("click", () => {
            const dateDebut = document.getElementById("settings-chir-debut").value;
            const dateFin = document.getElementById("settings-chir-fin").value;
            if (!dateDebut || !dateFin) {
                afficherMessage("Attention", "Veuillez sélectionner une date de début et une date de fin.");
                return;
            }
            lancerExport(btnExtractChir, "chirurgie", { date_debut: dateDebut, date_fin: dateFin },
                "L'extraction a été générée avec succès !");
        });
    }

    // Modal de preview
    let currentExportAction = null;
    const exportPreviewOverlay = document.getElementById("export-preview-overlay");
    const exportPreviewThead = document.getElementById("export-preview-thead");
    const exportPreviewTbody = document.getElementById("export-preview-tbody");
    const exportPreviewTfoot = document.getElementById("export-preview-tfoot");
    const exportPreviewDescription = document.getElementById("export-preview-description");
    const btnConfirmExport = document.getElementById("btn-confirm-export");

    function showExportPreview(type) {
        currentExportAction = type;
        if (!exportPreviewOverlay) return;

        exportPreviewThead.innerHTML = "";
        exportPreviewTbody.innerHTML = "";
        if (exportPreviewTfoot) exportPreviewTfoot.innerHTML = "";

        if (type === "stock") {
            exportPreviewDescription.textContent = "Aperçu de l'export du stock actuel :";

            const db = (typeof window.loadDB === "function") ? window.loadDB() : { stock: [], produits: [] };
            const stock = db.stock || [];
            const produits = db.produits || [];

            let grandTotalHT = 0;
            let grandTotalTTC = 0;

            stock.forEach(s => {
                const p = produits.find(prod => prod.reference === s.reference);
                const nom = p ? p.nom : "";

                const qte = s.quantite || 0;
                const prixHT = s.prix_unitaire_ht || 0;
                const prixTTC = s.prix_unitaire_ttc || 0;

                const valHT = qte * prixHT;
                const valTTC = qte * prixTTC;

                grandTotalHT += valHT;
                grandTotalTTC += valTTC;

                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${escapeHtml(s.utilisateur || "")}</td>
                    <td>${escapeHtml(s.reference || "")}</td>
                    <td>${escapeHtml(nom)}</td>
                    <td>${escapeHtml(qte)}</td>
                    <td>${escapeHtml(s.fournisseur || "")}</td>
                    <td>${escapeHtml(valHT.toFixed(2) + " €")}</td>
                    <td>${escapeHtml(valTTC.toFixed(2) + " €")}</td>
                `;
                exportPreviewTbody.appendChild(tr);
            });

            exportPreviewThead.innerHTML = `
                <tr style="background: #eee;">
                    <th colspan="5" style="text-align: right; padding-right: 20px;"><strong>TOTAL GLOBAL :</strong></th>
                    <th><strong>${grandTotalHT.toFixed(2)} €</strong></th>
                    <th><strong>${grandTotalTTC.toFixed(2)} €</strong></th>
                </tr>
                <tr><th>Espace</th><th>Référence</th><th>Nom</th><th>Quantité</th><th>Fournisseur</th><th>Valeur Totale HT</th><th>Valeur Totale TTC</th></tr>
            `;
        } else if (type === "stats") {
            exportPreviewDescription.textContent = "Aperçu brut des transactions de consommation qui seront analysées :";
            exportPreviewThead.innerHTML = `<tr><th>Date</th><th>Référence</th><th>Espace</th><th>Type</th><th>Quantité</th></tr>`;

            const db = (typeof window.loadDB === "function") ? window.loadDB() : { transactions: [] };
            const transactions = db.transactions || [];

            // Doit rester STRICTEMENT aligné sur est_consommation() dans
            // python/exports.py : sinon l'aperçu annonce des lignes (transferts,
            // changements de réf/espace) que l'Excel exclut ensuite.
            const consumptions = transactions.filter(t => {
                const typeTx = t.type_transaction || "";
                const upper = typeTx.toUpperCase();
                if (upper.includes("MODIFICATION") || upper.includes("TRANSFERT")) return false;
                if (typeTx === "SORTIE_STOCK" || typeTx.includes("Sortie")) return true;
                if (typeTx === "AJUSTEMENT_MANUEL" && t.quantite < 0) return true;
                return false;
            });

            // Seulement les 100 dernières pour garder un aperçu fluide
            const previewData = consumptions.slice(-100).reverse();

            previewData.forEach(t => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${escapeHtml(t.date ? t.date.substring(0, 10) : "")}</td>
                    <td>${escapeHtml(t.reference || "")}</td>
                    <td>${escapeHtml(t.utilisateur || "")}</td>
                    <td>${escapeHtml(t.type_transaction || "")}</td>
                    <td>${Math.abs(t.quantite || 0)}</td>
                `;
                exportPreviewTbody.appendChild(tr);
            });
        }

        exportPreviewOverlay.classList.remove("hidden");
    }

    if (btnConfirmExport) {
        btnConfirmExport.addEventListener("click", () => {
            exportPreviewOverlay.classList.add("hidden");
            if (currentExportAction === "stock") {
                lancerExport(null, "stock", {}, "L'export Excel a été généré avec succès !");
            } else if (currentExportAction === "stats") {
                lancerExport(null, "consommation", { references: ["TOUTES"] },
                    "L'export des statistiques a été généré avec succès !");
            }
        });
    }

    // Boutons du menu principal
    const btnExportMain = document.getElementById("btn-export-main");
    if (btnExportMain) {
        btnExportMain.addEventListener("click", () => showExportPreview("stock"));
    }

    const btnStatsMain = document.getElementById("btn-stats-main");
    if (btnStatsMain) {
        btnStatsMain.addEventListener("click", () => showExportPreview("stats"));
    }
});
