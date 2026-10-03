/**
 * Tests de non-régression pour les bugs corrigés lors de l'audit.
 * Chaque describe porte le numéro du bug pour retrouver le contexte.
 */

import { jest } from '@jest/globals';
import { getStock, ajouterStock, setStockAbsolu } from '../js/features/stock.js';
import { setDbCache, loadDB } from '../js/core/database.js';
import { parsePeremption } from '../js/core/utils.js';
import { parseInvoiceText } from '../js/parsers/pdf-parser.js';
import { getWeekNumber } from '../js/planning/clock.js';

const bridgeStub = {
    updateProduit: jest.fn((data, cb) => cb('{"status":"ok"}')),
    updateStockItem: jest.fn((data, cb) => cb('{"status":"ok"}')),
    addTransaction: jest.fn((data, cb) => cb('{"status":"ok"}')),
    addHistoriquePrix: jest.fn((data, cb) => cb('{"status":"ok"}'))
};

function baseDb(stock = []) {
    return {
        produits: [{ reference: 'REF001', nom: 'Produit 1', groupe: 'G', ref_scannette: '1', type_stockage: 'unite', quantite_par_carton: 1 }],
        stock,
        transactions: [],
        autoclave: [],
        historique_prix: [],
        nextTxId: 1,
        nextAutoId: 1
    };
}

const ligne = (extra = {}) => ({
    reference: 'REF001', utilisateur: 'Commun', quantite: 10, stock_minimum: 5,
    alerte_active: 1, date_peremption: '', date_import: '', fournisseur: '',
    lot: '', lots_details: '[]', prix_unitaire_ht: 0, prix_unitaire_ttc: 0, ...extra
});

describe('Bug #3 - une quantité négative ne doit pas faire disparaître la ligne', () => {
    beforeEach(() => {
        global.window = { prompt: jest.fn(() => ''), alert: jest.fn(), pyBridge: bridgeStub };
    });

    test('ajouterStock borne la quantité à 0 au lieu de passer en négatif', () => {
        setDbCache(baseDb([ligne({ quantite: 5 })]));
        ajouterStock('REF001', -8, { utilisateur: 'Commun' });
        expect(loadDB().stock[0].quantite).toBe(0);
    });

    test('la ligne reste visible dans getStock après une sortie excessive', () => {
        setDbCache(baseDb([ligne({ quantite: 5 })]));
        ajouterStock('REF001', -8, { utilisateur: 'Commun' });
        expect(getStock('Commun')).toHaveLength(1);
    });

    test('une ligne déjà négative en base est affichée, ramenée à 0', () => {
        setDbCache(baseDb([ligne({ quantite: -4 })]));
        const rows = getStock('Commun');
        expect(rows).toHaveLength(1);
        expect(rows[0].quantite).toBe(0);
    });

    test('une ligne négative apparaît aussi dans la recherche globale', () => {
        setDbCache(baseDb([ligne({ quantite: -4 })]));
        expect(getStock('TOUS')).toHaveLength(1);
    });
});

describe("Bug #10 - ajouterStock ne doit pas écraser les réglages non transmis", () => {
    beforeEach(() => {
        global.window = { prompt: jest.fn(() => ''), alert: jest.fn(), pyBridge: bridgeStub };
        setDbCache(baseDb([ligne({ quantite: 10, stock_minimum: 4, alerte_active: 1 })]));
    });

    test('stock_minimum et alerte_active survivent à une entrée sans options', () => {
        ajouterStock('REF001', 2, { utilisateur: 'Commun' });
        const entry = loadDB().stock[0];
        expect(entry.stock_minimum).toBe(4);
        expect(entry.alerte_active).toBe(1);
    });

    test('les réglages explicitement fournis sont bien appliqués', () => {
        ajouterStock('REF001', 2, { utilisateur: 'Commun', stock_minimum: 9, alerte_active: 0 });
        const entry = loadDB().stock[0];
        expect(entry.stock_minimum).toBe(9);
        expect(entry.alerte_active).toBe(0);
    });

    test('une nouvelle ligne retombe sur 0 par défaut', () => {
        ajouterStock('REF001', 3, { utilisateur: 'Cabinet 1' });
        const entry = loadDB().stock.find(s => s.utilisateur === 'Cabinet 1');
        expect(entry.stock_minimum).toBe(0);
        expect(entry.alerte_active).toBe(0);
    });
});

describe("Bug #14 - pas de transaction d'ajustement quand la quantité ne bouge pas", () => {
    beforeEach(() => {
        global.window = { prompt: jest.fn(() => ''), alert: jest.fn(), pyBridge: bridgeStub };
        setDbCache(baseDb([ligne({ quantite: 7 })]));
    });

    test('aucune transaction pour une édition sans changement de quantité', () => {
        setStockAbsolu('REF001', 7, { utilisateur: 'Commun', nom: 'Nouveau nom' });
        expect(loadDB().transactions).toHaveLength(0);
    });

    test('une transaction est bien enregistrée quand la quantité change', () => {
        setStockAbsolu('REF001', 12, { utilisateur: 'Commun' });
        const tx = loadDB().transactions;
        expect(tx).toHaveLength(1);
        expect(tx[0].type_transaction).toBe('AJUSTEMENT_MANUEL');
        expect(tx[0].quantite).toBe(5);
    });
});

describe('Bug #16 - parsePeremption doit refuser les dates impossibles', () => {
    test('le 31 février est rejeté au lieu de glisser en mars', () => {
        expect(parsePeremption('31/02/2026')).toBeNull();
    });

    test('le 31 avril est rejeté', () => {
        expect(parsePeremption('31/04/2026')).toBeNull();
    });

    test('un 29 février non bissextile est rejeté', () => {
        expect(parsePeremption('29/02/2026')).toBeNull();
    });

    test('un 29 février bissextile est accepté', () => {
        const d = parsePeremption('29/02/2024');
        expect(d).not.toBeNull();
        expect(d.getMonth()).toBe(1);
        expect(d.getDate()).toBe(29);
    });

    test('un mois hors bornes est rejeté', () => {
        expect(parsePeremption('01/13/2026')).toBeNull();
    });

    test('les dates valides restent acceptées (JJ/MM/AAAA et ISO)', () => {
        expect(parsePeremption('31/12/2026').getDate()).toBe(31);
        expect(parsePeremption('2026-12-31').getDate()).toBe(31);
    });

    test('une date invalide est ignorée mais les autres sont conservées', () => {
        const d = parsePeremption('31/02/2026, 15/06/2026');
        expect(d.getMonth()).toBe(5);
        expect(d.getDate()).toBe(15);
    });
});

describe("Bug #9 - une TVA à 0 % ne doit pas être traitée comme 20 %", () => {
    /**
     * Ligne Henry Schein : réf | désignation | QTE CMD | QTE LIVREE |
     * tarif U.HT | tarif U.TTC | prix unit. net TTC | prix tot. net TTC | TVA
     */
    const ligne = (tva) =>
        `HENRY SCHEIN FACTURE 123-4567 ARTICLE TEST 2.0 2.0 100.00 100.00 100.00 200.00 ${tva}`;

    test("TVA 0 % : le HT est égal au TTC", () => {
        const [item] = parseInvoiceText(ligne("0.0"));
        expect(item).toBeDefined();
        expect(item.prix_unitaire_ht).toBeCloseTo(100, 2);
        expect(item.prix_total_ht).toBeCloseTo(200, 2);
    });

    test("TVA 20 % : le HT est bien déduit", () => {
        const [item] = parseInvoiceText(ligne("20.0"));
        expect(item.prix_unitaire_ht).toBeCloseTo(83.3333, 3);
    });

    test("TVA 5.5 % (arrondie à un chiffre par la facture) reste distincte", () => {
        const [item] = parseInvoiceText(ligne("5.5"));
        expect(item.prix_unitaire_ht).toBeCloseTo(94.7867, 3);
    });
});

describe("Bug #17 - parité de semaine le dimanche à cheval sur l'année", () => {
    /** Reproduit le calcul de updateTeamPlanning() pour un dimanche. */
    function pariteLundiSuivant(dimanche) {
        const lundi = new Date(dimanche);
        lundi.setDate(lundi.getDate() + 1);
        return getWeekNumber(lundi) % 2 === 0 ? 'even' : 'odd';
    }

    test("le lundi suivant un dimanche de fin d'année est en semaine 1", () => {
        // 2027-01-03 est un dimanche : le lundi suivant (04/01) est en semaine 1
        const dimanche = new Date(2027, 0, 3);
        expect(dimanche.getDay()).toBe(0);
        const lundi = new Date(2027, 0, 4);
        expect(getWeekNumber(lundi)).toBe(1);
        expect(pariteLundiSuivant(dimanche)).toBe('odd');
    });

    test("la parité suit le numéro ISO réel, pas un simple +1", () => {
        // 2026-12-27 (dimanche) est en semaine 52 ; le lundi 28/12 est en 53.
        const dimanche = new Date(2026, 11, 27);
        expect(dimanche.getDay()).toBe(0);
        expect(getWeekNumber(dimanche)).toBe(52);
        expect(getWeekNumber(new Date(2026, 11, 28))).toBe(53);
        expect(pariteLundiSuivant(dimanche)).toBe('odd');
    });

    test("un dimanche en milieu d'année passe bien à la semaine suivante", () => {
        const dimanche = new Date(2026, 5, 7); // 07/06/2026
        expect(dimanche.getDay()).toBe(0);
        expect(getWeekNumber(new Date(2026, 5, 8))).toBe(getWeekNumber(dimanche) + 1);
    });
});
