"use strict";

/* ============================================================
   Constants - Configuration globale de l'application
   ============================================================ */

export const USERS = ["Commun", "Cabinet 1", "Cabinet 2", "Cabinet 4", "Cabinet 5", "Salle de chir", "Bureau"];

/* Conditionnements possibles d'un produit.
   `groupe: true` = le produit arrive dans des contenants (carton, boîte...)
   regroupant chacun `quantite_par_carton` unités. Le stock reste toujours
   compté en unités : le contenant n'est qu'une aide à la saisie. */
export const CONDITIONNEMENTS = {
    unite: {
        label: "À l'unité",
        labelCourt: "Unité",
        groupe: false
    },
    carton: {
        label: "En cartons",
        labelCourt: "Carton",
        groupe: true,
        labelQteParContenant: "Quantité par carton :",
        labelNbContenants: "Nombre de cartons (entiers) :",
        labelVrac: "Unités en vrac (carton entamé) - Optionnel :"
    },
    boite: {
        label: "En boîtes",
        labelCourt: "Boîte",
        groupe: true,
        labelQteParContenant: "Quantité par boîte :",
        labelNbContenants: "Nombre de boîtes (entières) :",
        labelVrac: "Unités en vrac (boîte entamée) - Optionnel :"
    }
};

/** Vrai si le type de conditionnement regroupe plusieurs unités par contenant. */
export function estConditionnementGroupe(type) {
    const cond = CONDITIONNEMENTS[type];
    return Boolean(cond && cond.groupe);
}

/* Espaces où le numéro de lot est systématiquement demandé
   à l'entrée comme à la sortie (traçabilité chirurgie). */
export const ESPACES_SUIVI_LOT = ["Salle de chir"];

export const PHASE_CLASSES = {
    1: "phase-chauffage",
    2: "phase-plateau",
    3: "phase-sechage",
    4: "phase-terminee"
};

export const MACHINE_CYCLES = {
    "Autoclave Euronda": [
        { nom: "Chauffage (134°C, 10 min)", dureeSecondes: 600, phase: 1 },
        { nom: "Plateau (134°C, 4 min)", dureeSecondes: 240, phase: 2 },
        { nom: "Séchage (40 min)", dureeSecondes: 2400, phase: 3 },
        { nom: "Terminé", dureeSecondes: 0, phase: 4 }
    ],
    "Autoclave Lisa": [
        { nom: "Chauffage (121°C, 8 min)", dureeSecondes: 480, phase: 1 },
        { nom: "Plateau (121°C, 15 min)", dureeSecondes: 900, phase: 2 },
        { nom: "Séchage (20 min)", dureeSecondes: 1200, phase: 3 },
        { nom: "Terminé", dureeSecondes: 0, phase: 4 }
    ],
    "Bain Ultrason": [
        { nom: "Nettoyage (15 min)", dureeSecondes: 900, phase: 1 },
        { nom: "Terminé", dureeSecondes: 0, phase: 4 }
    ]
};

export const DEFAULT_CALENDAR_DATA = {
    pairWeek: [
        { assistant: "Assistante A", lun_matin: "A", lun_aprem: "A", mar_matin: "A", mar_aprem: "A", mer_matin: "A", mer_aprem: "A", jeu_matin: "A", jeu_aprem: "A", ven_matin: "A", ven_aprem: "A", sam_matin: "", sam_aprem: "" },
        { assistant: "Assistante B", lun_matin: "B", lun_aprem: "B", mar_matin: "B", mar_aprem: "B", mer_matin: "B", mer_aprem: "B", jeu_matin: "B", jeu_aprem: "B", ven_matin: "B", ven_aprem: "B", sam_matin: "", sam_aprem: "" }
    ],
    oddWeek: [
        { assistant: "Assistante C", lun_matin: "C", lun_aprem: "C", mar_matin: "C", mar_aprem: "C", mer_matin: "C", mer_aprem: "C", jeu_matin: "C", jeu_aprem: "C", ven_matin: "C", ven_aprem: "C", sam_matin: "", sam_aprem: "" }
    ]
};

export const DRAGGABLE_ELEMENT_SELECTORS = [
    "#zone-action",
    "#actions-rapides",
    "#post-it-ruptures",
    "#info-alertes",
    "#zone-planning",
    "#annuaire-link"
];

export const RESIZABLE_BG_SELECTORS = [
    "#cabinet-background"
];
