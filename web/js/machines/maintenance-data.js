"use strict";

/* ============================================================
   Maintenance Data - Gestion des données de maintenance
   ============================================================ */

import { loadDB, saveDB, persister } from '../core/database.js';

export function addAutoclaveMaintenance(dateStr, utilisateur, commentaire, machine) {
    const db = loadDB();
    const newAuto = { id: db.nextAutoId++, date: dateStr, machine: machine || "", utilisateur, commentaire };
    db.autoclave.push(newAuto);
    persister("addAutoclave", JSON.stringify(newAuto));
    saveDB(db);
}

export function getAutoclaveMaintenance() {
    const db = loadDB();
    // ORDER BY date DESC, id DESC (dates au format JJ/MM/AAAA)
    const key = (d) => {
        const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
        return m ? `${m[3]}-${m[2]}-${m[1]}` : (d || "");
    };
    return [...db.autoclave].sort((a, b) => {
        const cmp = key(b.date).localeCompare(key(a.date));
        return cmp !== 0 ? cmp : b.id - a.id;
    });
}
