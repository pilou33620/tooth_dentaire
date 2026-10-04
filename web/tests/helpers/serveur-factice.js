/**
 * Serveur factice pour les tests : remplace fetch() et simule l'API de
 * serveur.py en mémoire (état, documents, écritures).
 *
 *   const serveur = installerServeurFactice({ documents: { planning: {...} } });
 *   await chargerEtat();           // l'interface lit l'état factice
 *   ...                            // actions testées
 *   await attendreEcritures();     // laisse partir les requêtes en file
 *   appelsVers(serveur, "POST", "/api/stock")  // requêtes reçues
 *
 * Les lots (POST /api/lot) sont aussi détaillés dans serveur.appels, une
 * entrée par opération, avec la route d'origine (POST /api/stock...).
 * serveur.conflitSur = "REF|Espace" : le prochain lot qui écrit cette ligne
 * est refusé en conflit (409), comme si un autre poste l'avait modifiée.
 */

const ROUTES_LOT = {
    updateProduit: () => ["POST", "/api/produit"],
    updateStockItem: () => ["POST", "/api/stock"],
    addTransaction: () => ["POST", "/api/transaction"],
    addAutoclave: () => ["POST", "/api/maintenance"],
    addHistoriquePrix: () => ["POST", "/api/historique-prix"],
    deleteStockItem: d => ["DELETE", `/api/stock?reference=${encodeURIComponent(d.reference)}&utilisateur=${encodeURIComponent(d.utilisateur)}`],
    deleteProduit: d => ["DELETE", `/api/produit?reference=${encodeURIComponent(d.reference)}`]
};

import { jest } from '@jest/globals';

export function installerServeurFactice({ base, documents } = {}) {
    const etat = {
        base: base || { produits: [], stock: [], transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1 },
        documents: { ...(documents || {}) },
        revision: 0,
        appels: [],
        lots: [],
        conflitSur: null
    };

    global.fetch = jest.fn(async (url, options = {}) => {
        const methode = options.method || "GET";
        const corps = options.body ? JSON.parse(options.body) : undefined;
        const route = String(url).split("?")[0];
        etat.appels.push({ methode, url: String(url), corps });

        let data = {};
        if (route === "/api/lot") {
            const operations = corps.operations || [];
            etat.lots.push(operations);
            const enConflit = etat.conflitSur && operations.some(op =>
                op.action === "updateStockItem"
                && `${op.donnees.reference}|${op.donnees.utilisateur}` === etat.conflitSur);
            if (enConflit) {
                etat.conflitSur = null;
                return {
                    ok: false,
                    status: 409,
                    json: async () => ({ status: "error", conflit: true, message: "Conflit" })
                };
            }
            data.resultats = operations.map(op => {
                const [m, u] = ROUTES_LOT[op.action](op.donnees);
                etat.appels.push({ methode: m, url: u, corps: op.donnees });
                return op.action === "updateStockItem"
                    ? { reference: op.donnees.reference, utilisateur: op.donnees.utilisateur, version: (op.donnees.version ?? 0) + 1 }
                    : {};
            });
            etat.revision++;
        } else if (route === "/api/etat") {
            // Copie : comme un vrai serveur, l'état renvoyé n'est pas l'objet modifié par l'interface
            data = JSON.parse(JSON.stringify({ base: etat.base, documents: etat.documents }));
        } else if (route.startsWith("/api/documents/")) {
            const cle = decodeURIComponent(route.slice("/api/documents/".length));
            if (methode === "PUT") {
                etat.documents[cle] = corps;
                etat.revision++;
            } else {
                data = { valeur: etat.documents[cle] ?? null };
            }
        } else if (methode !== "GET") {
            etat.revision++;
        }

        return {
            ok: true,
            status: 200,
            json: async () => ({ status: "ok", revision: `test-${etat.revision}`, ...data })
        };
    });

    return etat;
}

/** Laisse s'exécuter la file d'écriture (promesses en attente). */
export async function attendreEcritures() {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

/** Requêtes reçues pour une méthode et une route (paramètres ignorés). */
export function appelsVers(etat, methode, route) {
    return etat.appels.filter(a => a.methode === methode && a.url.split("?")[0] === route);
}
