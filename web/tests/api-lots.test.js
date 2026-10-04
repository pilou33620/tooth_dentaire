/**
 * Tests des écritures groupées et des conflits entre postes (js/core/api.js).
 *
 * Une action de l'interface (sortie de stock + ses transactions) part en un
 * seul lot ; chaque ligne de stock porte la version lue. Si un autre poste a
 * modifié la ligne entre-temps, le serveur refuse le lot : rien n'est
 * enregistré, l'écran est rechargé et l'utilisateur est prévenu.
 */

import { jest } from '@jest/globals';
import { chargerEtat, persister, MESSAGE_CONFLIT } from '../js/core/api.js';
import { loadDB } from '../js/core/database.js';
import { sortirStock, ajouterStock } from '../js/features/stock.js';
import { installerServeurFactice, attendreEcritures } from './helpers/serveur-factice.js';

function ligneStock(extra = {}) {
    return Object.assign({
        reference: 'REF1', utilisateur: 'Commun', quantite: 10,
        stock_minimum: 0, alerte_active: 0, alerte_peremption_active: 0,
        delai_peremption: 30, date_peremption: '', date_import: '',
        fournisseur: '', en_commande: 0, date_commande: '', lot: '',
        prix_unitaire_ht: 0, prix_unitaire_ttc: 0, lots_details: '[]', version: 3
    }, extra);
}

function baseDeTest(stock) {
    return {
        produits: [{ reference: 'REF1', nom: 'Gants', groupe: '', ref_scannette: '', type_stockage: 'unite', quantite_par_carton: 1 }],
        stock, transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1
    };
}

let serveur;

afterEach(() => jest.restoreAllMocks());

beforeEach(async () => {
    serveur = installerServeurFactice({ base: baseDeTest([ligneStock()]) });
    window.alert = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await chargerEtat();
});

test('une sortie de stock part en un seul lot (stock + transaction)', async () => {
    sortirStock('REF1', 2, 'Commun');
    await attendreEcritures();
    expect(serveur.lots).toHaveLength(1);
    expect(serveur.lots[0].map(op => op.action).sort()).toEqual(['addTransaction', 'updateStockItem']);
});

test('la version lue est envoyée avec la ligne de stock', async () => {
    sortirStock('REF1', 2, 'Commun');
    await attendreEcritures();
    const maj = serveur.lots[0].find(op => op.action === 'updateStockItem');
    expect(maj.donnees.version).toBe(3);
});

test('deux actions rapprochées : la seconde envoie la version obtenue par la première', async () => {
    sortirStock('REF1', 1, 'Commun');
    await Promise.resolve();               // le premier lot part
    sortirStock('REF1', 1, 'Commun');      // calculé avant la réponse du serveur
    await attendreEcritures();
    const versions = serveur.lots.map(lot => lot.find(op => op.action === 'updateStockItem').donnees.version);
    expect(versions).toEqual([3, 4]);
    expect(loadDB().stock[0].version).toBe(5);
});

test('une ligne nouvelle est envoyée sans version (null)', async () => {
    ajouterStock('REF2', 5, { utilisateur: 'Commun' });
    await attendreEcritures();
    const maj = serveur.lots[0].find(op => op.action === 'updateStockItem');
    expect(maj.donnees.version).toBeNull();
});

test('conflit : message, données rechargées depuis le serveur', async () => {
    serveur.conflitSur = 'REF1|Commun';
    const modifiees = jest.fn();
    window.addEventListener('donnees-modifiees', modifiees);

    sortirStock('REF1', 4, 'Commun');
    expect(loadDB().stock[0].quantite).toBe(6);      // affichage optimiste
    await attendreEcritures();

    expect(window.alert).toHaveBeenCalledWith(MESSAGE_CONFLIT);
    expect(loadDB().stock[0].quantite).toBe(10);     // état du serveur
    expect(modifiees).toHaveBeenCalled();
    window.removeEventListener('donnees-modifiees', modifiees);
});

test('conflit : les écritures déjà en file sont abandonnées', async () => {
    serveur.conflitSur = 'REF1|Commun';
    sortirStock('REF1', 1, 'Commun');
    await Promise.resolve();
    const seconde = persister('addTransaction', { reference: 'REF1', utilisateur: 'Commun', type_transaction: 'SORTIE_STOCK', quantite: 1 });
    await attendreEcritures();
    expect(await seconde).toBeNull();
    expect(serveur.lots).toHaveLength(1);
});

test('les suppressions passent aussi par le lot', async () => {
    persister('deleteStockItem', 'REF1', 'Commun');
    persister('deleteProduit', 'REF1');
    await attendreEcritures();
    expect(serveur.lots[0]).toEqual([
        { action: 'deleteStockItem', donnees: { reference: 'REF1', utilisateur: 'Commun' } },
        { action: 'deleteProduit', donnees: { reference: 'REF1' } }
    ]);
});
