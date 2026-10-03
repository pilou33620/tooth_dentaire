/**
 * Tests du dialogue "Entrée / Sortie de stock par lot".
 * Le markup est extrait de index.html : un id renommé fait échouer ces tests.
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { openLotMoveDialog } from '../js/features/lot-moves.js';
import { getStock } from '../js/features/stock.js';
import { setDbCache, loadDB } from '../js/core/database.js';

const INDEX = fs.readFileSync(path.resolve('index.html'), 'utf-8');

/** Extrait un bloc <div id="..." ...> ... </div> de index.html. */
function extraireOverlay(id) {
    const debut = INDEX.indexOf(`<div id="${id}"`);
    expect(debut).toBeGreaterThan(-1);
    // Les overlays sont indentés de 4 espaces : la fermeture est la 1re "    </div>"
    const fin = INDEX.indexOf("\n    </div>", debut);
    expect(fin).toBeGreaterThan(debut);
    return INDEX.slice(debut, fin + "\n    </div>".length);
}

function stockDeTest() {
    return {
        produits: [{ reference: 'REF001', nom: 'Produit 1', groupe: 'G', ref_scannette: '1', type_stockage: 'unite', quantite_par_carton: 1 }],
        stock: [{
            reference: 'REF001', utilisateur: 'Cabinet 1', quantite: 8,
            stock_minimum: 2, alerte_active: 1, alerte_peremption_active: 1, delai_peremption: 30,
            date_peremption: '01/01/2027, 31/12/2030', date_import: '', fournisseur: '',
            lot: 'TOT, TARD',
            lots_details: JSON.stringify([
                { lot: 'TOT', date: '01/01/2027', qte: 3 },
                { lot: 'TARD', date: '31/12/2030', qte: 5 }
            ]),
            prix_unitaire_ht: 1, prix_unitaire_ttc: 1.2
        }],
        transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1
    };
}

describe('Dialogue mouvement par lot', () => {
    beforeEach(() => {
        document.body.innerHTML = extraireOverlay('lot-move-overlay') + extraireOverlay('msg-overlay');
        window.pyBridge = {
            updateStockItem: jest.fn((data, cb) => cb('{"status":"ok"}')),
            addTransaction: jest.fn((data, cb) => cb('{"status":"ok"}')),
            updateProduit: jest.fn((data, cb) => cb('{"status":"ok"}'))
        };
        setDbCache(stockDeTest());
    });

    const row = () => getStock('Cabinet 1')[0];
    const lignes = () => Array.from(document.querySelectorAll('#lot-move-tbody tr'));
    const entry = () => loadDB().stock.find(s => s.reference === 'REF001');

    test('mode sortie : une ligne par lot, triée en FEFO, quantités en stock affichées', async () => {
        const promesse = openLotMoveDialog(row(), 'sortie');

        expect(document.getElementById('lot-move-overlay').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('lot-move-title').textContent).toBe('Sortie de stock par lot');

        const rows = lignes();
        expect(rows).toHaveLength(2);
        expect(rows[0].cells[0].textContent).toContain('TOT');
        expect(rows[0].cells[0].textContent).toContain('à sortir en premier');
        expect(rows[0].cells[2].textContent).toBe('3');
        expect(rows[1].cells[0].textContent).toContain('TARD');
        expect(rows[1].cells[2].textContent).toBe('5');

        document.getElementById('lot-move-cancel').click();
        expect(await promesse).toBe(false);
        expect(document.getElementById('lot-move-overlay').classList.contains('hidden')).toBe(true);
    });

    test('mode sortie : sortir 2 unités du 2e lot ne touche pas le 1er', async () => {
        const promesse = openLotMoveDialog(row(), 'sortie');

        const inputs = document.querySelectorAll('#lot-move-tbody .lot-move-qte');
        inputs[1].value = '2';
        inputs[1].dispatchEvent(new window.Event('input'));
        expect(document.getElementById('lot-move-total').textContent).toBe('Total à sortir : 2 unité(s)');

        document.getElementById('lot-move-save').click();
        expect(await promesse).toBe(true);

        expect(entry().quantite).toBe(6);
        expect(JSON.parse(entry().lots_details)).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 3 },
            { lot: 'TARD', date: '31/12/2030', qte: 3 }
        ]);
        const tx = loadDB().transactions;
        expect(tx).toHaveLength(1);
        expect(tx[0].lot).toBe('TARD');
        expect(tx[0].quantite).toBe(2);
    });

    test('mode sortie : le bouton "Tout" reprend la quantité du lot', async () => {
        const promesse = openLotMoveDialog(row(), 'sortie');

        const boutonTout = lignes()[0].cells[4].querySelector('button');
        expect(boutonTout.textContent).toBe('Tout');
        boutonTout.click();
        expect(lignes()[0].querySelector('.lot-move-qte').value).toBe('3');

        document.getElementById('lot-move-save').click();
        expect(await promesse).toBe(true);
        expect(entry().quantite).toBe(5);
        expect(JSON.parse(entry().lots_details)).toEqual([{ lot: 'TARD', date: '31/12/2030', qte: 5 }]);
    });

    test('mode sortie : quantité supérieure au lot => message et stock inchangé', async () => {
        const promesse = openLotMoveDialog(row(), 'sortie');

        const input = lignes()[0].querySelector('.lot-move-qte');
        input.value = '99';
        input.dispatchEvent(new window.Event('input'));
        document.getElementById('lot-move-save').click();

        // Le dialogue reste ouvert et affiche un message
        await Promise.resolve();
        expect(document.getElementById('msg-overlay').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('msg-text').textContent).toContain('3 unité(s)');
        expect(entry().quantite).toBe(8);

        document.getElementById('msg-ok').click();
        document.getElementById('lot-move-cancel').click();
        expect(await promesse).toBe(false);
    });

    test('mode entrée : ajouter des quantités sur un lot existant', async () => {
        const promesse = openLotMoveDialog(row(), 'entree');

        expect(document.getElementById('lot-move-title').textContent).toBe('Entrée de stock par lot');
        expect(document.getElementById('lot-move-add').classList.contains('hidden')).toBe(false);

        const input = lignes()[0].querySelector('.lot-move-qte');
        input.value = '4';
        input.dispatchEvent(new window.Event('input'));
        expect(document.getElementById('lot-move-total').textContent).toBe('Total à ajouter : 4 unité(s)');

        document.getElementById('lot-move-save').click();
        expect(await promesse).toBe(true);

        expect(entry().quantite).toBe(12);
        expect(JSON.parse(entry().lots_details)).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 7 },
            { lot: 'TARD', date: '31/12/2030', qte: 5 }
        ]);
    });

    test('mode entrée : créer un nouveau lot via "+ Nouveau lot"', async () => {
        const promesse = openLotMoveDialog(row(), 'entree');

        document.getElementById('lot-move-add').click();
        const nouvelle = lignes()[2];
        nouvelle.querySelector('.lot-move-lot').value = 'NEUF';
        nouvelle.querySelector('.lot-move-date').value = '30/06/2028';
        const inputQte = nouvelle.querySelector('.lot-move-qte');
        inputQte.value = '6';
        inputQte.dispatchEvent(new window.Event('input'));

        document.getElementById('lot-move-save').click();
        expect(await promesse).toBe(true);

        expect(entry().quantite).toBe(14);
        expect(JSON.parse(entry().lots_details)).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 3 },
            { lot: 'TARD', date: '31/12/2030', qte: 5 },
            { lot: 'NEUF', date: '30/06/2028', qte: 6 }
        ]);
        expect(entry().lot).toBe('TOT, TARD, NEUF');
    });

    test('mode entrée : date de péremption invalide refusée', async () => {
        const promesse = openLotMoveDialog(row(), 'entree');

        document.getElementById('lot-move-add').click();
        const nouvelle = lignes()[2];
        nouvelle.querySelector('.lot-move-lot').value = 'NEUF';
        nouvelle.querySelector('.lot-move-date').value = 'bientot';
        nouvelle.querySelector('.lot-move-qte').value = '2';
        document.getElementById('lot-move-save').click();

        await Promise.resolve();
        expect(document.getElementById('msg-title').textContent).toBe('Date invalide');
        expect(entry().quantite).toBe(8);

        document.getElementById('msg-ok').click();
        document.getElementById('lot-move-cancel').click();
        expect(await promesse).toBe(false);
    });

    test('aucun lot enregistré : saisie libre du n° de lot à la sortie', async () => {
        const db = stockDeTest();
        db.stock[0].lot = '';
        db.stock[0].lots_details = '[]';
        db.stock[0].date_peremption = '';
        setDbCache(db);

        const promesse = openLotMoveDialog(row(), 'sortie');
        const rows = lignes();
        expect(rows).toHaveLength(1);
        expect(rows[0].querySelector('.lot-move-lot')).not.toBeNull();

        rows[0].querySelector('.lot-move-lot').value = 'LOT-LIBRE';
        rows[0].querySelector('.lot-move-date').value = '31/12/2027';
        const inputQte = rows[0].querySelector('.lot-move-qte');
        inputQte.value = '3';
        inputQte.dispatchEvent(new window.Event('input'));

        document.getElementById('lot-move-save').click();
        expect(await promesse).toBe(true);

        expect(entry().quantite).toBe(5);
        const tx = loadDB().transactions;
        expect(tx).toHaveLength(1);
        expect(tx[0].lot).toBe('LOT-LIBRE');
        expect(tx[0].peremption_sortie).toBe('31/12/2027');
        expect(tx[0].quantite).toBe(3);
    });
});
