/**
 * Tests du transfert entre espaces (js/features/transfer.js).
 *
 * Règles vérifiées : contrôles de saisie, prélèvement FEFO des lots,
 * fusion côté destination, traçabilité des transactions.
 */

import { jest } from '@jest/globals';
import { openTransferDialog, saveTransferDialog } from '../js/features/transfer.js';
import { setDbCache, loadDB } from '../js/core/database.js';
import { getStock } from '../js/features/stock.js';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const MARKUP = `
    <div id="transfer-overlay" class="hidden">
        <input id="transfer-ref">
        <select id="transfer-source"></select>
        <select id="transfer-dest"></select>
        <input id="transfer-qte" value="1">
    </div>
    <button id="btn-alertes-stock" class="hidden"></button>
    <button id="btn-alertes-peremp" class="hidden"></button>
    <div id="postit-container" class="hidden">
        <div id="postit-rupture"><span class="postit-title"></span></div>
        <ul id="postit-list"></ul>
    </div>
`;

function ligneStock(extra = {}) {
    return Object.assign({
        reference: 'REF1', utilisateur: 'Cabinet 1', quantite: 10,
        stock_minimum: 2, alerte_active: 1, alerte_peremption_active: 1,
        delai_peremption: 30, date_peremption: '', date_import: '01/01/2026',
        fournisseur: 'GACD', en_commande: 0, date_commande: '',
        lot: '', prix_unitaire_ht: 1, prix_unitaire_ttc: 1.2, lots_details: '[]'
    }, extra);
}

function baseDeTest(stock) {
    return {
        produits: [{ reference: 'REF1', nom: 'Gant', groupe: 'Protection',
                     ref_scannette: '', type_stockage: 'unite', quantite_par_carton: 1 }],
        stock, transactions: [], autoclave: [], historique_prix: [],
        nextTxId: 1, nextAutoId: 1
    };
}

function remplirDialogue({ ref = 'REF1', source = 'Cabinet 1',
                           dest = 'Cabinet 2', qte = '3' } = {}) {
    document.getElementById('transfer-ref').value = ref;
    document.getElementById('transfer-source').value = source;
    document.getElementById('transfer-dest').value = dest;
    document.getElementById('transfer-qte').value = qte;
}

function entree(reference, utilisateur) {
    return loadDB().stock.find(
        s => s.reference === reference && s.utilisateur === utilisateur);
}

describe('openTransferDialog', () => {
    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseDeTest([ligneStock()]));
    });

    test('remet les champs à leur valeur initiale', () => {
        document.getElementById('transfer-ref').value = 'ANCIEN';
        document.getElementById('transfer-qte').value = '99';
        openTransferDialog();
        expect(document.getElementById('transfer-ref').value).toBe('');
        expect(document.getElementById('transfer-qte').value).toBe('1');
    });

    test('les deux listes proposent tous les espaces', () => {
        openTransferDialog();
        const source = document.querySelectorAll('#transfer-source option');
        const dest = document.querySelectorAll('#transfer-dest option');
        expect(source.length).toBe(dest.length);
        expect(source.length).toBeGreaterThanOrEqual(7);
        expect(Array.from(source).map(o => o.value)).toContain('Salle de chir');
    });

    test('la boîte de dialogue devient visible', () => {
        openTransferDialog();
        expect(document.getElementById('transfer-overlay').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('contrôles de saisie', () => {
    let alerte;

    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseDeTest([ligneStock()]));
        openTransferDialog();
        alerte = jest.spyOn(window, 'alert').mockImplementation(() => {});
    });

    afterEach(() => alerte.mockRestore());

    test('référence vide', () => {
        remplirDialogue({ ref: '   ' });
        saveTransferDialog();
        expect(alerte).toHaveBeenCalledWith(expect.stringContaining('référence'));
        expect(entree('REF1', 'Cabinet 1').quantite).toBe(10);
    });

    test('source et destination identiques', () => {
        remplirDialogue({ source: 'Cabinet 1', dest: 'Cabinet 1' });
        saveTransferDialog();
        expect(alerte).toHaveBeenCalledWith(expect.stringContaining('différentes'));
        expect(entree('REF1', 'Cabinet 1').quantite).toBe(10);
    });

    test('quantité nulle, négative ou illisible', () => {
        for (const qte of ['0', '-5', 'abc', '']) {
            alerte.mockClear();
            remplirDialogue({ qte });
            saveTransferDialog();
            expect(alerte).toHaveBeenCalledWith(expect.stringContaining('supérieure à 0'));
        }
        expect(entree('REF1', 'Cabinet 1').quantite).toBe(10);
    });

    test('quantité supérieure au stock source', () => {
        remplirDialogue({ qte: '11' });
        saveTransferDialog();
        expect(alerte).toHaveBeenCalledWith(expect.stringContaining('insuffisante'));
        expect(entree('REF1', 'Cabinet 1').quantite).toBe(10);
    });

    test('référence absente de l\'espace source', () => {
        remplirDialogue({ ref: 'INCONNUE' });
        saveTransferDialog();
        expect(alerte).toHaveBeenCalledWith(expect.stringContaining('insuffisante'));
    });

    test('la boîte de dialogue reste ouverte après un refus', () => {
        remplirDialogue({ qte: '999' });
        saveTransferDialog();
        expect(document.getElementById('transfer-overlay').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('transfert sans suivi de lot', () => {
    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseDeTest([ligneStock()]));
        openTransferDialog();
    });

    test('les quantités se déplacent d\'un espace à l\'autre', () => {
        remplirDialogue({ qte: '3' });
        saveTransferDialog();
        expect(entree('REF1', 'Cabinet 1').quantite).toBe(7);
        expect(entree('REF1', 'Cabinet 2').quantite).toBe(3);
    });

    test('le total reste constant', () => {
        remplirDialogue({ qte: '4' });
        saveTransferDialog();
        const total = loadDB().stock
            .filter(s => s.reference === 'REF1')
            .reduce((acc, s) => acc + s.quantite, 0);
        expect(total).toBe(10);
    });

    test('deux transactions sont tracées', () => {
        remplirDialogue({ qte: '3' });
        saveTransferDialog();
        const types = loadDB().transactions.map(t => t.type_transaction);
        expect(types).toContain('Sortie (Transfert)');
        expect(types).toContain('Entrée (Transfert)');
        expect(loadDB().transactions).toHaveLength(2);
    });

    test('la ligne de destination hérite des paramètres de la source', () => {
        remplirDialogue({ qte: '3' });
        saveTransferDialog();
        const dest = entree('REF1', 'Cabinet 2');
        expect(dest.fournisseur).toBe('GACD');
        expect(dest.stock_minimum).toBe(2);
        expect(dest.prix_unitaire_ht).toBe(1);
        expect(dest.date_import).toBe('01/01/2026');
    });

    test('transférer tout le stock vide la ligne source', () => {
        remplirDialogue({ qte: '10' });
        saveTransferDialog();
        const source = entree('REF1', 'Cabinet 1');
        expect(source.quantite).toBe(0);
        expect(source.date_peremption).toBe('');
        expect(source.lot).toBe('');
        expect(source.lots_details).toBe('[]');
    });

    test('la boîte de dialogue se ferme après un transfert réussi', () => {
        remplirDialogue({ qte: '1' });
        saveTransferDialog();
        expect(document.getElementById('transfer-overlay').classList.contains('hidden'))
            .toBe(true);
    });

    test('un produit inconnu est créé côté destination', () => {
        setDbCache({
            produits: [],
            stock: [ligneStock()],
            transactions: [], autoclave: [], historique_prix: [],
            nextTxId: 1, nextAutoId: 1
        });
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        const produit = loadDB().produits.find(p => p.reference === 'REF1');
        expect(produit).toMatchObject({ nom: 'Inconnu', groupe: 'Général' });
    });

    test('la date d\'import créée est au format JJ/MM/AAAA', () => {
        setDbCache(baseDeTest([ligneStock({ date_import: '' })]));
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        expect(entree('REF1', 'Cabinet 2').date_import)
            .toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });
});

describe('transfert avec suivi de lot (FEFO)', () => {
    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseDeTest([ligneStock({
            quantite: 8,
            lot: 'TOT, TARD',
            date_peremption: '01/01/2027, 31/12/2030',
            lots_details: JSON.stringify([
                { lot: 'TOT', date: '01/01/2027', qte: 3 },
                { lot: 'TARD', date: '31/12/2030', qte: 5 }
            ])
        })]));
        openTransferDialog();
    });

    test('le lot qui périme le plus tôt part en premier', () => {
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        const restants = JSON.parse(entree('REF1', 'Cabinet 1').lots_details);
        expect(restants.find(l => l.lot === 'TOT').qte).toBe(1);
        expect(restants.find(l => l.lot === 'TARD').qte).toBe(5);
    });

    test('un lot entièrement consommé disparaît de la source', () => {
        remplirDialogue({ qte: '3' });
        saveTransferDialog();
        const restants = JSON.parse(entree('REF1', 'Cabinet 1').lots_details);
        expect(restants.map(l => l.lot)).toEqual(['TARD']);
    });

    test('le prélèvement déborde sur le lot suivant', () => {
        remplirDialogue({ qte: '5' });
        saveTransferDialog();
        const source = JSON.parse(entree('REF1', 'Cabinet 1').lots_details);
        expect(source).toHaveLength(1);
        expect(source[0]).toMatchObject({ lot: 'TARD', qte: 3 });

        const dest = JSON.parse(entree('REF1', 'Cabinet 2').lots_details);
        expect(dest.find(l => l.lot === 'TOT').qte).toBe(3);
        expect(dest.find(l => l.lot === 'TARD').qte).toBe(2);
    });

    test('les lots arrivent à destination avec leurs dates', () => {
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        const dest = entree('REF1', 'Cabinet 2');
        expect(JSON.parse(dest.lots_details)).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 2 }
        ]);
        expect(dest.lot).toBe('TOT');
        expect(dest.date_peremption).toBe('01/01/2027');
    });

    test('une transaction par lot déplacé, numéro et péremption tracés', () => {
        remplirDialogue({ qte: '5' });
        saveTransferDialog();
        const sorties = loadDB().transactions
            .filter(t => t.type_transaction === 'Sortie (Transfert)');
        expect(sorties).toHaveLength(2);
        expect(sorties.map(t => t.lot).sort()).toEqual(['TARD', 'TOT']);
        expect(sorties.find(t => t.lot === 'TOT').peremption_sortie).toBe('01/01/2027');
    });

    test('les lots fusionnent avec ceux déjà présents à destination', () => {
        const db = loadDB();
        db.stock.push(ligneStock({
            utilisateur: 'Cabinet 2', quantite: 4, lot: 'TOT',
            date_peremption: '01/01/2027',
            lots_details: JSON.stringify([{ lot: 'TOT', date: '01/01/2027', qte: 4 }])
        }));
        setDbCache(db);

        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        const dest = JSON.parse(entree('REF1', 'Cabinet 2').lots_details);
        expect(dest).toHaveLength(1);
        expect(dest[0]).toMatchObject({ lot: 'TOT', qte: 6 });
        expect(entree('REF1', 'Cabinet 2').quantite).toBe(6);
    });

    test('la somme des lots reste égale à la quantité de chaque ligne', () => {
        remplirDialogue({ qte: '6' });
        saveTransferDialog();
        for (const espace of ['Cabinet 1', 'Cabinet 2']) {
            const ligne = entree('REF1', espace);
            const somme = JSON.parse(ligne.lots_details)
                .reduce((acc, l) => acc + l.qte, 0);
            expect(somme).toBe(ligne.quantite);
        }
    });

    test('un stock décrit par les seuls champs lot/date est converti en lots', () => {
        setDbCache(baseDeTest([ligneStock({
            quantite: 6, lot: 'ANCIEN', date_peremption: '01/06/2027',
            lots_details: '[]'
        })]));
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        const dest = JSON.parse(entree('REF1', 'Cabinet 2').lots_details);
        expect(dest).toEqual([{ lot: 'ANCIEN', date: '01/06/2027', qte: 2 }]);
    });

    test('getStock reflète le transfert dans les deux espaces', () => {
        remplirDialogue({ qte: '3' });
        saveTransferDialog();
        expect(getStock('Cabinet 1').find(s => s.reference === 'REF1').quantite).toBe(5);
        expect(getStock('Cabinet 2').find(s => s.reference === 'REF1').quantite).toBe(3);
    });
});

describe('effets de bord', () => {
    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseDeTest([ligneStock()]));
        openTransferDialog();
    });

    test('le tableau du placard est rafraîchi s\'il est ouvert', () => {
        const refresh = jest.fn();
        window.refreshPlacardTable = refresh;
        remplirDialogue({ qte: '1' });
        saveTransferDialog();
        expect(refresh).toHaveBeenCalled();
        delete window.refreshPlacardTable;
    });

    test('les alertes sont recalculées : passer sous le seuil déclenche l\'alerte', () => {
        remplirDialogue({ qte: '9' });   // il reste 1, seuil = 2
        saveTransferDialog();
        expect(document.getElementById('btn-alertes-stock').classList.contains('hidden'))
            .toBe(false);
    });

    test('les écritures sont envoyées au serveur', async () => {
        const serveur = installerServeurFactice();
        remplirDialogue({ qte: '2' });
        saveTransferDialog();
        await attendreEcritures();
        expect(appelsVers(serveur, 'POST', '/api/stock')).toHaveLength(2);
        expect(appelsVers(serveur, 'POST', '/api/transaction').length).toBeGreaterThanOrEqual(2);
    });
});
