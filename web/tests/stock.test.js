/**
 * Tests unitaires pour le module stock.js
 */

import { jest } from '@jest/globals';
import { getStock, ajouterStock, setStockAbsolu, sortirStock } from '../js/features/stock.js';
import { setDbCache, loadDB } from '../js/core/database.js';

// Mock window.prompt et window.confirm
global.window = {
    prompt: jest.fn(() => 'LOT123'),
    confirm: jest.fn(() => true),
    alert: jest.fn(),
    pyBridge: {
        updateStockItem: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addTransaction: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addHistoriquePrix: jest.fn((data, callback) => callback('{"status":"ok"}'))
    }
};

describe('Stock Module Tests', () => {
    let testDb;
    
    beforeEach(() => {
        testDb = {
            produits: [
                { reference: 'REF001', nom: 'Produit 1', groupe: 'Groupe A', ref_scannette: '123', type_stockage: 'unite', quantite_par_carton: 1 },
                { reference: 'REF002', nom: 'Produit 2', groupe: 'Groupe B', ref_scannette: '456', type_stockage: 'carton', quantite_par_carton: 10 }
            ],
            stock: [
                { reference: 'REF001', utilisateur: 'Cabinet 1', quantite: 10, stock_minimum: 5, alerte_active: 1, date_peremption: '31/12/2026', date_import: '27/08/2026', fournisseur: 'Henry Schein', lot: '', lots_details: '[]', prix_unitaire_ht: 10, prix_unitaire_ttc: 12 },
                { reference: 'REF002', utilisateur: 'Cabinet 2', quantite: 20, stock_minimum: 10, alerte_active: 0, date_peremption: '', date_import: '27/08/2026', fournisseur: 'GACD', lot: '', lots_details: '[]', prix_unitaire_ht: 5, prix_unitaire_ttc: 6 }
            ],
            transactions: [],
            autoclave: [],
            historique_prix: [],
            nextTxId: 1,
            nextAutoId: 1
        };
        
        setDbCache(testDb);
    });
    
    test('getStock should return stock for specific user', () => {
        const stock = getStock('Cabinet 1');
        expect(stock).toHaveLength(1);
        expect(stock[0].reference).toBe('REF001');
        expect(stock[0].utilisateur).toBe('Cabinet 1');
        expect(stock[0].quantite).toBe(10);
    });
    
    test('getStock should return all stock for TOUS', () => {
        const stock = getStock('TOUS');
        expect(stock).toHaveLength(2);
    });
    
    test('getStock should include product details', () => {
        const stock = getStock('Cabinet 1');
        expect(stock[0].nom).toBe('Produit 1');
        expect(stock[0].groupe).toBe('Groupe A');
    });
    
    test('ajouterStock should add stock to existing entry', () => {
        const db = loadDB();
        const initialQuantite = db.stock[0].quantite;
        
        ajouterStock('REF001', 5, {
            utilisateur: 'Cabinet 1',
            prix_unitaire_ht: 11,
            prix_unitaire_ttc: 13.2
        });
        
        const updatedDb = loadDB();
        const stockEntry = updatedDb.stock[0];
        expect(stockEntry.quantite).toBe(initialQuantite + 5);
    });
    
    test('ajouterStock should calculate CUMP correctly', () => {
        const db = loadDB();
        // Stock actuel: 10 unités à 10€ HT = 100€
        // Ajout: 5 unités à 12€ HT = 60€
        // Total: 15 unités pour 160€ = 10.67€/unité (arrondi 4 décimales)
        
        ajouterStock('REF001', 5, {
            utilisateur: 'Cabinet 1',
            prix_unitaire_ht: 12,
            prix_unitaire_ttc: 14.4
        });
        
        const updatedDb = loadDB();
        const stockEntry = updatedDb.stock[0];
        
        // CUMP = (10 * 10 + 5 * 12) / 15 = 160 / 15 = 10.6666...
        expect(stockEntry.prix_unitaire_ht).toBeCloseTo(10.6667, 3);
    });
    
    test('ajouterStock should create new stock entry if not exists', () => {
        const db = loadDB();
        const initialLength = db.stock.length;
        
        ajouterStock('REF001', 5, {
            utilisateur: 'Cabinet 3',
            stock_minimum: 3,
            alerte_active: 1,
            prix_unitaire_ht: 10,
            prix_unitaire_ttc: 12
        });
        
        const updatedDb = loadDB();
        expect(updatedDb.stock).toHaveLength(initialLength + 1);
        
        const newEntry = updatedDb.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 3');
        expect(newEntry).toBeDefined();
        expect(newEntry.quantite).toBe(5);
    });
    
    test('ajouterStock should add transaction', () => {
        const db = loadDB();
        const initialTxLength = db.transactions.length;
        
        ajouterStock('REF001', 5, {
            utilisateur: 'Cabinet 1',
            type_transaction: 'ENTREE_STOCK'
        });
        
        const updatedDb = loadDB();
        expect(updatedDb.transactions).toHaveLength(initialTxLength + 1);
        expect(updatedDb.transactions[0].type_transaction).toBe('ENTREE_STOCK');
    });
    
    test('setStockAbsolu should set absolute quantity', () => {
        setStockAbsolu('REF001', 15, {
            utilisateur: 'Cabinet 1',
            nom: 'Produit 1',
            groupe: 'Groupe A'
        });
        
        const db = loadDB();
        const stockEntry = db.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        expect(stockEntry.quantite).toBe(15);
    });
    
    test('setStockAbsolu should clear date_peremption if quantity is 0', () => {
        setStockAbsolu('REF001', 0, {
            utilisateur: 'Cabinet 1',
            date_peremption: '31/12/2026'
        });
        
        const db = loadDB();
        const stockEntry = db.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        expect(stockEntry.quantite).toBe(0);
        expect(stockEntry.date_peremption).toBe('');
    });
    
    test('setStockAbsolu should add AJUSTEMENT_MANUEL transaction', () => {
        const db = loadDB();
        const initialTxLength = db.transactions.length;
        const oldQte = db.stock[0].quantite; // 10
        
        setStockAbsolu('REF001', 15, { utilisateur: 'Cabinet 1' });
        
        const updatedDb = loadDB();
        expect(updatedDb.transactions).toHaveLength(initialTxLength + 1);
        expect(updatedDb.transactions[0].type_transaction).toBe('AJUSTEMENT_MANUEL');
        expect(updatedDb.transactions[0].quantite).toBe(5); // diff = 15 - 10
    });
    
    test('sortirStock should decrease stock quantity', () => {
        const result = sortirStock('REF001', 3, 'Cabinet 1');
        
        expect(result).toBe(true);
        
        const db = loadDB();
        const stockEntry = db.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        expect(stockEntry.quantite).toBe(7); // 10 - 3
    });
    
    test('sortirStock should fail if insufficient stock', () => {
        const result = sortirStock('REF001', 15, 'Cabinet 1');
        
        expect(result).toBe(false);
        
        const db = loadDB();
        const stockEntry = db.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        expect(stockEntry.quantite).toBe(10); // Unchanged
    });
    
    test('sortirStock should add SORTIE_STOCK transaction', () => {
        const db = loadDB();
        const initialTxLength = db.transactions.length;
        
        sortirStock('REF001', 3, 'Cabinet 1');
        
        const updatedDb = loadDB();
        expect(updatedDb.transactions).toHaveLength(initialTxLength + 1);
        expect(updatedDb.transactions[0].type_transaction).toBe('SORTIE_STOCK');
        expect(updatedDb.transactions[0].quantite).toBe(3);
    });
    
    test('sortirStock should clear date_peremption, lot, and lots_details if quantity reaches 0', () => {
        const db0 = loadDB();
        const s0 = db0.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        s0.lot = 'LOT-ABC';
        s0.lots_details = JSON.stringify([{ lot: 'LOT-ABC', date: '31/12/2026' }]);

        sortirStock('REF001', 10, 'Cabinet 1');
        
        const db = loadDB();
        const stockEntry = db.stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
        expect(stockEntry.quantite).toBe(0);
        expect(stockEntry.date_peremption).toBe('');
        expect(stockEntry.lot).toBe('');
        expect(stockEntry.lots_details).toBe('[]');
    });
});
