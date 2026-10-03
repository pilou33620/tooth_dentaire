/**
 * Serveur factice pour les tests : remplace fetch() et simule l'API de
 * serveur.py en mémoire (état, documents, écritures).
 *
 *   const serveur = installerServeurFactice({ documents: { planning: {...} } });
 *   await chargerEtat();           // l'interface lit l'état factice
 *   ...                            // actions testées
 *   await attendreEcritures();     // laisse partir les requêtes en file
 *   appelsVers(serveur, "POST", "/api/stock")  // requêtes reçues
 */

import { jest } from '@jest/globals';

export function installerServeurFactice({ base, documents } = {}) {
    const etat = {
        base: base || { produits: [], stock: [], transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1 },
        documents: { ...(documents || {}) },
        revision: 0,
        appels: []
    };

    global.fetch = jest.fn(async (url, options = {}) => {
        const methode = options.method || "GET";
        const corps = options.body ? JSON.parse(options.body) : undefined;
        const route = String(url).split("?")[0];
        etat.appels.push({ methode, url: String(url), corps });

        let data = {};
        if (route === "/api/etat") {
            data = { base: etat.base, documents: etat.documents };
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
