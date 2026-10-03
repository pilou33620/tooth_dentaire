/**
 * Tests unitaires pour le module database.js
 * Framework: Jest (ou peut être exécuté avec Mocha/Chai)
 */

import { jest } from '@jest/globals';

// Mock du window.pyBridge pour les tests
global.window = {
    pyBridge: {
        updateProduit: jest.fn((data, callback) => callback('{"status":"ok"}')),
        updateStockItem: jest.fn((data, callback) => callback('{"status":"ok"}')),
        deleteStockItem: jest.fn((data, callback) => callback('{"status":"ok"}')),
        deleteProduit: jest.fn((ref, callback) => callback('{"status":"ok"}')),
        addTransaction: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addAutoclave: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addHistoriquePrix: jest.fn((data, callback) => callback('{"status":"ok"}'))
    }
};

import { 
    setDbCache, 
    loadDB, 
    saveDB, 
    findProduit, 
    findStockEntry,
    addTransaction,
    getAllGroups,
    getStockInfo,
    ajouterProduit
} from '../js/core/database.js';

describe('Database Module Tests', () => {
    let testDb;
    
    beforeEach(() => {
        // Initialiser une base de données de test
        testDb = {
            produits: [
                { reference: 'REF001', nom: 'Produit 1', groupe: 'Groupe A', ref_scannette: '123', type_stockage: 'unite', quantite_par_carton: 1 },
                { reference: 'REF002', nom: 'Produit 2', groupe: 'Groupe B', ref_scannette: '456', type_stockage: 'carton', quantite_par_carton: 10 }
            ],
            stock: [
                { reference: 'REF001', utilisateur: 'Cabinet 1', quantite: 10, stock_minimum: 5, alerte_active: 1, date_peremption: '31/12/2026', date_import: '27/08/2026' },
                { reference: 'REF002', utilisateur: 'Cabinet 2', quantite: 20, stock_minimum: 10, alerte_active: 0, date_peremption: '', date_import: '27/08/2026' }
            ],
            transactions: [],
            autoclave: [],
            historique_prix: [],
            nextTxId: 1,
            nextAutoId: 1
        };
        
        setDbCache(testDb);
    });
    
    test('loadDB should return the cached database', () => {
        const db = loadDB();
        expect(db).toBeDefined();
        expect(db.produits).toHaveLength(2);
        expect(db.stock).toHaveLength(2);
    });
    
    test('loadDB should return default structure if no cache', () => {
        setDbCache(null);
        const db = loadDB();
        expect(db).toBeDefined();
        expect(db.produits).toEqual([]);
        expect(db.stock).toEqual([]);
        expect(db.transactions).toEqual([]);
    });
    
    test('findProduit should find existing product', () => {
        const db = loadDB();
        const produit = findProduit(db, 'REF001');
        expect(produit).toBeDefined();
        expect(produit.nom).toBe('Produit 1');
        expect(produit.groupe).toBe('Groupe A');
    });
    
    test('findProduit should return undefined for non-existing product', () => {
        const db = loadDB();
        const produit = findProduit(db, 'REF999');
        expect(produit).toBeUndefined();
    });
    
    test('findStockEntry should find existing stock entry', () => {
        const db = loadDB();
        const stock = findStockEntry(db, 'REF001', 'Cabinet 1');
        expect(stock).toBeDefined();
        expect(stock.quantite).toBe(10);
        expect(stock.stock_minimum).toBe(5);
    });
    
    test('findStockEntry should return undefined for non-existing entry', () => {
        const db = loadDB();
        const stock = findStockEntry(db, 'REF999', 'Cabinet 1');
        expect(stock).toBeUndefined();
    });
    
    test('addTransaction should add transaction to database', () => {
        const db = loadDB();
        const initialLength = db.transactions.length;
        const initialNextId = db.nextTxId;
        
        addTransaction(db, 'REF001', 'Cabinet 1', 'ENTREE_STOCK', 5, 'LOT123', '');
        
        expect(db.transactions).toHaveLength(initialLength + 1);
        expect(db.transactions[0].reference).toBe('REF001');
        expect(db.transactions[0].type_transaction).toBe('ENTREE_STOCK');
        expect(db.transactions[0].quantite).toBe(5);
        expect(db.nextTxId).toBe(initialNextId + 1);
    });
    
    test('getAllGroups should return unique groups', () => {
        const groups = getAllGroups();
        expect(groups).toContain('Groupe A');
        expect(groups).toContain('Groupe B');
        expect(groups).toHaveLength(2);
    });
    
    test('getStockInfo should return stock information', () => {
        const info = getStockInfo('REF001', 'Cabinet 1');
        expect(info).toBeDefined();
        expect(info.groupe).toBe('Groupe A');
        expect(info.stock_minimum).toBe(5);
        expect(info.alerte_active).toBe(1);
        expect(info.type_stockage).toBe('unite');
    });
    
    test('getStockInfo should return default values for non-existing stock', () => {
        const info = getStockInfo('REF999', 'Cabinet 1');
        expect(info.groupe).toBe('');
        expect(info.stock_minimum).toBe(0);
        expect(info.alerte_active).toBe(0);
    });
    
    test('ajouterProduit should add new product', () => {
        const db = loadDB();
        const initialLength = db.produits.length;
        
        ajouterProduit(db, 'REF003', 'Produit 3', 'Groupe C', '789', 'unite', 1);
        
        expect(db.produits).toHaveLength(initialLength + 1);
        const newProduit = findProduit(db, 'REF003');
        expect(newProduit).toBeDefined();
        expect(newProduit.nom).toBe('Produit 3');
        expect(newProduit.groupe).toBe('Groupe C');
    });
    
    test('ajouterProduit should update existing product', () => {
        const db = loadDB();
        const initialLength = db.produits.length;
        
        ajouterProduit(db, 'REF001', 'Produit 1 Modifié', 'Groupe A Modifié', '999', 'carton', 12);
        
        // Length should remain the same (update, not add)
        expect(db.produits).toHaveLength(initialLength);
        
        const produit = findProduit(db, 'REF001');
        expect(produit.nom).toBe('Produit 1 Modifié');
        expect(produit.groupe).toBe('Groupe A Modifié');
        expect(produit.quantite_par_carton).toBe(12);
    });
    
    test('saveDB should update cache', () => {
        const newDb = { ...testDb, produits: [...testDb.produits, { reference: 'NEW', nom: 'New' }] };
        saveDB(newDb);
        
        const loadedDb = loadDB();
        expect(loadedDb.produits).toHaveLength(3);
    });

    test('ajouterProduit should format multiple barcodes cleanly', () => {
        const db = loadDB();
        ajouterProduit(db, 'REF_MULTI', 'Produit Multi', 'Groupe M', 'CODE1, CODE2; CODE3', 'unite', 1);
        const p = findProduit(db, 'REF_MULTI');
        expect(p).toBeDefined();
        expect(p.ref_scannette).toBe('CODE1, CODE2, CODE3');

        const info = getStockInfo('REF_MULTI', 'Cabinet 1');
        expect(info.ref_scannette).toBe('CODE1, CODE2, CODE3');
    });

    test('ajouterProduit should update barcodes with multiple values', () => {
        const db = loadDB();
        ajouterProduit(db, 'REF001', '', '', '123, 789, 999');
        const p = findProduit(db, 'REF001');
        expect(p.ref_scannette).toBe('123, 789, 999');
    });
});
