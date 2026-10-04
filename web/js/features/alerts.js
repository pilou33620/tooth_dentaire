"use strict";

/* ============================================================
   Alertes (MainWindow.check_alerts)
   ============================================================ */

import { USERS } from '../core/constants.js';
import { loadDB, saveDB, findProduit, persister } from '../core/database.js';
import { getStock } from './stock.js';
import { parsePeremption, daysUntil, todayFR } from '../core/utils.js';

export let alertsStock = [];
export let alertsPeremption = [];

// Post-it « À commander » : replié, seules les MAX_POSTIT premières lignes
// sont rendues ; un clic sur « … et N de plus » affiche toute la liste.
let postitDeplie = false;

export function checkAlerts() {
    alertsStock = [];
    alertsPeremption = [];

    for (const user of USERS) {
        for (const row of getStock(user)) {
            if (row.alerte_active && !row.arrete && row.quantite <= row.stock_minimum) {
                alertsStock.push({ user, data: row, reason: "Stock bas" });
            }

            if (row.quantite > 0) {
                const pDate = parsePeremption(row.date_peremption);
                if (pDate) {
                    const delta = daysUntil(pDate);
                    const delai = (row.delai_peremption !== undefined && row.delai_peremption !== null && row.delai_peremption !== "")
                        ? parseInt(row.delai_peremption, 10)
                        : 30;
                    const isAlerteActive = row.alerte_peremption_active !== undefined ? Boolean(row.alerte_peremption_active) : true;

                    if (delta < 0) {
                        alertsPeremption.push({ user, data: row, reason: `Périmé depuis ${Math.abs(delta)} jour(s)` });
                    } else if (isAlerteActive) {
                        if (delta === 0) {
                            alertsPeremption.push({ user, data: row, reason: `Périme aujourd'hui !` });
                        } else if (delta <= 1) {
                            alertsPeremption.push({ user, data: row, reason: `Périme dans ${delta} jour(s) !` });
                        } else if (delta <= delai) {
                            alertsPeremption.push({ user, data: row, reason: `Périme dans ${delta} jour(s) (délai: ${delai}j)` });
                        }
                    }
                }
            }
        }
    }

    const btnStock = document.getElementById("btn-alertes-stock");
    const btnPeremp = document.getElementById("btn-alertes-peremp");

    if (alertsStock.length > 0) {
        btnStock.textContent = `🔔 ${alertsStock.length} Alerte(s) Stock`;
        btnStock.classList.remove("hidden");
    } else {
        btnStock.classList.add("hidden");
    }

    if (alertsPeremption.length > 0) {
        btnPeremp.textContent = `⚠️ ${alertsPeremption.length} Alerte(s) Péremption`;
        btnPeremp.classList.remove("hidden");
    } else {
        btnPeremp.classList.add("hidden");
    }

    // --- Post-it Ruptures ---
    window.markReferencesAsOrdered = function (refs) {
        const db = loadDB();
        let updated = false;
        const dateStr = todayFR();
        db.stock.forEach(s => {
            if (refs.includes(s.reference)) {
                s.en_commande = 1;
                s.date_commande = dateStr;
                updated = true;
                persister("updateStockItem", JSON.stringify(s));
            }
        });
        if (updated) {
            saveDB(db);
            checkAlerts();
            if (typeof window.filterPlacardTable === "function") window.filterPlacardTable();
        }
    };

    window.toggleEnCommande = function (ref, state) {
        const db = loadDB();
        let updated = false;
        db.stock.forEach(s => {
            if (s.reference === ref) {
                s.en_commande = state ? 1 : 0;
                if (state) s.date_commande = todayFR();
                else s.date_commande = "";
                updated = true;
                persister("updateStockItem", JSON.stringify(s));
            }
        });
        if (updated) {
            saveDB(db);
            checkAlerts();
            if (typeof window.filterPlacardTable === "function") window.filterPlacardTable();
        }
    };
    let infosGlobales = {};
    let commandesGlobales = {};
    const db = loadDB();
    for (const s of db.stock) {
        // Produit qu'on n'achète plus : jamais « à commander », même à 0
        const produit = findProduit(db, s.reference);
        if (produit && produit.arrete) continue;
        if (!infosGlobales[s.reference]) {
            infosGlobales[s.reference] = { qty: 0, hasAlert: false };
        }
        infosGlobales[s.reference].qty += s.quantite;
        if (s.alerte_active && s.quantite <= s.stock_minimum) {
            infosGlobales[s.reference].hasAlert = true;
        }
        if (s.en_commande) {
            commandesGlobales[s.reference] = s.date_commande || todayFR();
        }
    }

    let listRuptures = [];
    for (const [ref, info] of Object.entries(infosGlobales)) {
        if (info.qty <= 0 || info.hasAlert) {
            const p = findProduit(db, ref);
            listRuptures.push({
                ref: ref,
                nom: p ? (p.nom || ref) : ref,
                en_commande: !!commandesGlobales[ref],
                date_commande: commandesGlobales[ref] || "",
                is_rupture: info.qty <= 0
            });
        }
    }

    const postitContainer = document.getElementById("postit-container");
    const postitList = document.getElementById("postit-list");
    const postitTitle = document.querySelector("#postit-rupture .postit-title");

    postitContainer.classList.remove("hidden");

    if (listRuptures.length > 0) {
        if (postitTitle) postitTitle.textContent = "À commander 📌";
        postitList.innerHTML = "";
        const MAX_POSTIT = 5;
        const deplie = postitDeplie && listRuptures.length > MAX_POSTIT;
        document.getElementById("postit-wrapper")?.classList.toggle("postit-deplie", deplie);
        // Replié, on n'affiche que les MAX_POSTIT premières lignes : sans ce
        // découpage, toutes les ruptures étaient rendues ET suivies du « ... et N de plus ».
        (deplie ? listRuptures : listRuptures.slice(0, MAX_POSTIT)).forEach((item) => {
            const li = document.createElement("li");
            li.className = "postit-item";

            const textSpan = document.createElement("span");
            let cmdText = item.en_commande ? ` (Commandé le ${item.date_commande})` : "";
            let prefix = item.is_rupture ? "❌ " : "⚠️ ";
            textSpan.textContent = prefix + item.nom + cmdText;
            textSpan.style.cursor = "pointer";
            textSpan.title = "Cliquez pour ouvrir le stock";

            if (item.en_commande) {
                textSpan.style.color = "#d97706"; // orange
                textSpan.style.fontWeight = "bold";
            }

            textSpan.addEventListener("click", () => {
                if (typeof window.openPlacard === "function") window.openPlacard("TOUS");

                // Effacer tous les filtres avant d'appliquer la ref
                const filters = ["filter-ref", "filter-nom", "filter-groupe", "filter-qte"];
                filters.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.value = "";
                });

                const filterRef = document.getElementById("filter-ref");
                if (filterRef) {
                    filterRef.value = item.ref;
                    if (typeof window.filterPlacardTable === "function") window.filterPlacardTable();
                }
            });

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.title = "Marquer comme commandé";
            checkbox.checked = item.en_commande;
            checkbox.style.cursor = "pointer";
            checkbox.addEventListener("change", (e) => {
                if (typeof window.toggleEnCommande === "function") {
                    window.toggleEnCommande(item.ref, e.target.checked);
                }
            });

            li.appendChild(textSpan);
            li.appendChild(checkbox);
            postitList.appendChild(li);
        });
        if (listRuptures.length > MAX_POSTIT) {
            const moreLi = document.createElement("li");
            moreLi.className = deplie ? "postit-more postit-reduire" : "postit-more";
            moreLi.textContent = deplie
                ? "▲ Réduire la liste"
                : `... et ${listRuptures.length - MAX_POSTIT} de plus ▼`;
            moreLi.title = deplie ? "Ne garder que les premières lignes" : "Afficher toute la liste";
            moreLi.tabIndex = 0;
            moreLi.setAttribute("role", "button");
            moreLi.setAttribute("aria-expanded", String(deplie));
            const basculer = () => {
                postitDeplie = !deplie;
                checkAlerts();
            };
            moreLi.addEventListener("click", basculer);
            moreLi.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    basculer();
                }
            });
            postitList.appendChild(moreLi);
        }
    } else {
        postitDeplie = false;
        document.getElementById("postit-wrapper")?.classList.remove("postit-deplie");
        if (postitTitle) postitTitle.textContent = "Bravo ! 🎉";
        postitList.innerHTML = "<li style='text-align: center; margin-top: 20px; font-weight: bold; color: #333; list-style-type: none; pointer-events: none; margin-left: -20px; border-bottom: none;'>Tu sais gérer un stock !</li>";
    }
}

// Calcule la place reellement disponible sous la liste et la borne en
// consequence. getBoundingClientRect() est en pixels ecran (donc affecte par
// le zoom navigateur et par un eventuel scale du widget), alors que max-height
// s'exprime en pixels CSS : on divise par le facteur d'echelle mesure pour que
// la barre de defilement apparaisse au bon moment a tous les niveaux de zoom.
export function updatePostitListHeight() {
    const list = document.getElementById("postit-list");
    if (!list) return;

    const rect = list.getBoundingClientRect();
    if (rect.height <= 0) return;

    // Facteur d'echelle applique a l'element (zoom conteneur + scale eventuel)
    const scale = list.offsetHeight > 0 ? rect.height / list.offsetHeight : 1;
    if (!isFinite(scale) || scale <= 0) return;

    const MARGIN_BOTTOM = 24; // marge pour ne pas coller au bord de l'ecran
    const availableScreenPx = window.innerHeight - rect.top - MARGIN_BOTTOM;
    const availableCssPx = Math.floor(availableScreenPx / scale);

    // On garde un minimum lisible meme si le post-it est tres bas dans la page
    const maxHeight = Math.max(120, availableCssPx);
    list.style.setProperty("--postit-list-max-height", maxHeight + "px");
}

// Gestion du hover pour le post-it - version compatible avec tous les niveaux de zoom
export function initPostitHover() {
    const wrapper = document.getElementById("postit-wrapper");
    const postit = document.getElementById("postit-rupture");

    if (!wrapper || !postit) {
        console.warn("Post-it elements not found:", { wrapper, postit });
        return;
    }

    // Créer une fonction de mise à jour de l'état
    function setPostitHover(isHovered) {
        if (isHovered) {
            postit.style.width = "320px";
            postit.style.transform = "rotate(0deg)";
            postit.style.boxShadow = "6px 6px 18px rgba(0, 0, 0, 0.3)";
            wrapper.style.zIndex = "999";
            // La liste vient de passer en mode deploye : on mesure la place
            // disponible maintenant que sa position finale est connue.
            updatePostitListHeight();
            requestAnimationFrame(updatePostitListHeight);
        } else {
            postit.style.width = "260px";
            postit.style.transform = "rotate(3deg)";
            postit.style.boxShadow = "4px 4px 10px rgba(0, 0, 0, 0.2)";
            wrapper.style.zIndex = "10";
        }
    }

    // mouseenter/mouseleave sur le papier lui-meme (inclut la scrollbar dans
    // sa zone), pas sur le wrapper qui a un grand padding tampon.
    postit.addEventListener("mouseenter", function(e) {
        wrapper.classList.add("postit-hover-active");
        setPostitHover(true);
    });

    postit.addEventListener("mouseleave", function(e) {
        wrapper.classList.remove("postit-hover-active");
        setPostitHover(false);
    });

    // Recalcul groupe dans une frame : evite de forcer un reflow a chaque
    // evenement (la mesure lit getBoundingClientRect).
    let heightUpdateQueued = false;
    function queuePostitListHeightUpdate() {
        if (heightUpdateQueued) return;
        heightUpdateQueued = true;
        requestAnimationFrame(() => {
            heightUpdateQueued = false;
            updatePostitListHeight();
        });
    }

    // Zoom navigateur via Ctrl + molette. On ignore le defilement simple :
    // scroller dans la liste ne doit pas relancer la mesure.
    document.addEventListener("wheel", function(e) {
        if (e.ctrlKey) queuePostitListHeightUpdate();
    }, { passive: true });

    // Zoom clavier (Ctrl + / - / 0) et redimensionnement de la fenetre.
    document.addEventListener("keyup", function(e) {
        if (e.ctrlKey && ["+", "-", "=", "0"].includes(e.key)) {
            queuePostitListHeightUpdate();
        }
    });
    window.addEventListener("resize", queuePostitListHeightUpdate);

    console.log("Post-it hover initialized");
}
