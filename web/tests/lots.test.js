/**
 * Tests unitaires pour la gestion des quantités par lot
 * (module lots.js + entrées/sorties par lot de stock.js)
 */

import { jest } from '@jest/globals';
import {
    parseLots, normalizeLots, serializeLots, totalLots, lotsLabel, lotsFromStrings,
    sortLotsFEFO, mergeLots, retirerDesLots, retirerFEFO, estPerime, lotsPerimesEntrants
} from '../js/features/lots.js';
import { getStock, ajouterStockParLots, sortirStockDetail } from '../js/features/stock.js';
import { setDbCache, loadDB } from '../js/core/database.js';

global.window = {
    prompt: jest.fn(() => ''),
    confirm: jest.fn(() => true),
    alert: jest.fn(),
    pyBridge: {
        updateStockItem: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addTransaction: jest.fn((data, callback) => callback('{"status":"ok"}')),
        updateProduit: jest.fn((data, callback) => callback('{"status":"ok"}')),
        addHistoriquePrix: jest.fn((data, callback) => callback('{"status":"ok"}'))
    }
};

describe('lots.js - helpers', () => {
    test('parseLots lit une chaîne JSON et nettoie les entrées', () => {
        const lots = parseLots('[{"lot":" A ","date":"31/12/2026","qte":"3"},{"lot":"","date":"","qte":null},null]');
        expect(lots).toHaveLength(1);
        expect(lots[0]).toEqual({ lot: 'A', date: '31/12/2026', qte: 3 });
    });

    test('parseLots retourne [] sur du JSON invalide', () => {
        expect(parseLots('pas du json')).toEqual([]);
        expect(parseLots('')).toEqual([]);
        expect(parseLots(null)).toEqual([]);
    });

    test('normalizeLots répartit la quantité totale sur les lots sans qte', () => {
        const lots = normalizeLots('[{"lot":"A","date":""},{"lot":"B","date":""}]', 7);
        expect(lots.map(l => l.qte)).toEqual([4, 3]);
        expect(totalLots(lots)).toBe(7);
    });

    test('normalizeLots complète uniquement le reliquat', () => {
        const lots = normalizeLots('[{"lot":"A","qte":6},{"lot":"B"}]', 10);
        expect(lots.map(l => l.qte)).toEqual([6, 4]);
    });

    test('lotsFromStrings apparie lots et dates et répartit la quantité', () => {
        const lots = lotsFromStrings('A, B', '31/12/2026, 15/06/2027', 5);
        expect(lots).toEqual([
            { lot: 'A', date: '31/12/2026', qte: 3 },
            { lot: 'B', date: '15/06/2027', qte: 2 }
        ]);
    });

    test('sortLotsFEFO trie par péremption la plus proche, sans date en dernier', () => {
        const lots = parseLots(JSON.stringify([
            { lot: 'SANS', date: '', qte: 1 },
            { lot: 'TARD', date: '31/12/2030', qte: 1 },
            { lot: 'TOT', date: '01/01/2027', qte: 1 }
        ]));
        expect(sortLotsFEFO(lots).map(l => l.lot)).toEqual(['TOT', 'TARD', 'SANS']);
    });

    test('mergeLots additionne les quantités des lots identiques', () => {
        const merged = mergeLots(
            [{ lot: 'A', date: '31/12/2026', qte: 2 }],
            [{ lot: 'A', date: '31/12/2026', qte: 3 }, { lot: 'B', date: '', qte: 1 }]
        );
        expect(merged).toEqual([
            { lot: 'A', date: '31/12/2026', qte: 5 },
            { lot: 'B', date: '', qte: 1 }
        ]);
    });

    test('retirerDesLots retire la quantité demandée et supprime les lots vidés', () => {
        const lots = [{ lot: 'A', date: '', qte: 4 }, { lot: 'B', date: '', qte: 2 }];
        const res = retirerDesLots(lots, [{ lot: 'A', date: '', qte: 4 }]);
        expect(res.ok).toBe(true);
        expect(res.lots).toEqual([{ lot: 'B', date: '', qte: 2 }]);
        expect(res.sorties).toEqual([{ lot: 'A', date: '', qte: 4 }]);
    });

    test('retirerDesLots refuse une quantité supérieure au stock du lot', () => {
        const lots = [{ lot: 'A', date: '', qte: 1 }];
        const res = retirerDesLots(lots, [{ lot: 'A', date: '', qte: 5 }]);
        expect(res.ok).toBe(false);
        expect(res.message).toContain('A');
        expect(res.lots).toEqual(lots);
    });

    test('retirerFEFO consomme d\'abord le lot qui périme le plus tôt', () => {
        const lots = [
            { lot: 'TARD', date: '31/12/2030', qte: 5 },
            { lot: 'TOT', date: '01/01/2027', qte: 2 }
        ];
        const { demandes, reste } = retirerFEFO(lots, 4);
        expect(reste).toBe(0);
        expect(demandes).toEqual([
            { index: 1, lot: 'TOT', date: '01/01/2027', qte: 2 },
            { index: 0, lot: 'TARD', date: '31/12/2030', qte: 2 }
        ]);
    });

    test('lotsLabel affiche la quantité de chaque lot', () => {
        expect(lotsLabel([{ lot: 'A', date: '', qte: 5 }, { lot: 'B', date: '', qte: 3 }]))
            .toBe('A ×5, B ×3');
    });

    test('serializeLots écrit un JSON exploitable par la base', () => {
        expect(serializeLots([{ lot: 'A', date: '31/12/2026', qte: '4' }]))
            .toBe('[{"lot":"A","date":"31/12/2026","qte":4}]');
    });
});

describe('stock.js - entrées / sorties par lot', () => {
    beforeEach(() => {
        setDbCache({
            produits: [
                { reference: 'REF001', nom: 'Produit 1', groupe: 'G', ref_scannette: '1', type_stockage: 'unite', quantite_par_carton: 1 }
            ],
            stock: [
                {
                    reference: 'REF001', utilisateur: 'Cabinet 1', quantite: 8,
                    stock_minimum: 2, alerte_active: 1, alerte_peremption_active: 1, delai_peremption: 30,
                    date_peremption: '01/01/2027, 31/12/2030', date_import: '', fournisseur: '',
                    lot: 'TOT, TARD',
                    lots_details: JSON.stringify([
                        { lot: 'TOT', date: '01/01/2027', qte: 3 },
                        { lot: 'TARD', date: '31/12/2030', qte: 5 }
                    ]),
                    prix_unitaire_ht: 1, prix_unitaire_ttc: 1.2
                }
            ],
            transactions: [],
            autoclave: [],
            historique_prix: [],
            nextTxId: 1,
            nextAutoId: 1
        });
    });

    const entry = () => loadDB().stock.find(s => s.reference === 'REF001' && s.utilisateur === 'Cabinet 1');
    const lotsOf = () => JSON.parse(entry().lots_details);

    test('getStock expose le détail des lots et le libellé avec quantités', () => {
        const row = getStock('Cabinet 1')[0];
        expect(row.lots).toHaveLength(2);
        expect(row.quantite_lots).toBe(8);
        expect(row.quantite_sans_lot).toBe(0);
        expect(row.lot_label).toBe('TOT ×3, TARD ×5');
    });

    test('sortie sur un lot précis ne touche pas les autres lots', () => {
        const res = sortirStockDetail('REF001', 0, 'Cabinet 1', {
            sorties: [{ lot: 'TARD', date: '31/12/2030', qte: 2 }]
        });
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(6);
        expect(lotsOf()).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 3 },
            { lot: 'TARD', date: '31/12/2030', qte: 3 }
        ]);
    });

    test('sortie sur un lot précis refusée si la quantité du lot est insuffisante', () => {
        const res = sortirStockDetail('REF001', 0, 'Cabinet 1', {
            sorties: [{ lot: 'TOT', date: '01/01/2027', qte: 4 }]
        });
        expect(res.ok).toBe(false);
        expect(entry().quantite).toBe(8);
        expect(loadDB().transactions).toHaveLength(0);
    });

    test('sortie sans lot précisé consomme en FEFO', () => {
        const res = sortirStockDetail('REF001', 4, 'Cabinet 1');
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(4);
        // Le lot TOT (périme le plus tôt) est vidé, puis 1 unité prise sur TARD
        expect(lotsOf()).toEqual([{ lot: 'TARD', date: '31/12/2030', qte: 4 }]);
        expect(entry().lot).toBe('TARD');
    });

    test('sortie multi-lots enregistre une transaction par lot', () => {
        const res = sortirStockDetail('REF001', 0, 'Cabinet 1', {
            sorties: [
                { lot: 'TOT', date: '01/01/2027', qte: 1 },
                { lot: 'TARD', date: '31/12/2030', qte: 2 }
            ]
        });
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(5);

        const tx = loadDB().transactions;
        expect(tx).toHaveLength(2);
        expect(tx.map(t => [t.lot, t.quantite, t.peremption_sortie])).toEqual([
            ['TOT', 1, '01/01/2027'],
            ['TARD', 2, '31/12/2030']
        ]);
        expect(tx.every(t => t.type_transaction === 'SORTIE_STOCK')).toBe(true);
    });

    test('sortie de la totalité vide les lots', () => {
        expect(sortirStockDetail('REF001', 8, 'Cabinet 1').ok).toBe(true);
        expect(entry().quantite).toBe(0);
        expect(entry().lots_details).toBe('[]');
        expect(entry().lot).toBe('');
        expect(entry().date_peremption).toBe('');
    });

    test('entrée par lot incrémente un lot existant', () => {
        const res = ajouterStockParLots('REF001', 'Cabinet 1', [{ lot: 'TOT', date: '01/01/2027', qte: 4 }]);
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(12);
        expect(lotsOf()).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 7 },
            { lot: 'TARD', date: '31/12/2030', qte: 5 }
        ]);
    });

    test('entrée par lot crée un nouveau lot et trace la transaction', () => {
        const res = ajouterStockParLots('REF001', 'Cabinet 1', [{ lot: 'NEUF', date: '30/06/2028', qte: 6 }]);
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(14);
        expect(lotsOf()).toHaveLength(3);
        expect(entry().lot).toBe('TOT, TARD, NEUF');

        const tx = loadDB().transactions;
        expect(tx).toHaveLength(1);
        expect(tx[0].lot).toBe('NEUF');
        expect(tx[0].quantite).toBe(6);
        expect(tx[0].type_transaction).toBe('ENTREE_LOT');
    });

    test('entrée par lot refusée sans quantité', () => {
        const res = ajouterStockParLots('REF001', 'Cabinet 1', [{ lot: 'NEUF', date: '', qte: 0 }]);
        expect(res.ok).toBe(false);
        expect(entry().quantite).toBe(8);
    });

    test('entrée par lot conserve une date de péremption déjà enregistrée sans lot', () => {
        const e = entry();
        e.lot = '';
        e.lots_details = '[]';
        e.date_peremption = '01/06/2027';

        const res = ajouterStockParLots('REF001', 'Cabinet 1', [{ lot: 'NEUF', date: '30/06/2028', qte: 2 }]);
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(10);
        expect(entry().date_peremption).toBe('30/06/2028, 01/06/2027');
        expect(JSON.parse(entry().lots_details)).toEqual([{ lot: 'NEUF', date: '30/06/2028', qte: 2 }]);
    });

    test('sortie hors lot ne modifie pas les lots suivis', () => {
        // 3 unités non ventilées en lot s'ajoutent au stock total
        const e = entry();
        e.quantite = 11;

        const res = sortirStockDetail('REF001', 0, 'Cabinet 1', { hors_lot: 2 });
        expect(res.ok).toBe(true);
        expect(entry().quantite).toBe(9);
        expect(lotsOf()).toEqual([
            { lot: 'TOT', date: '01/01/2027', qte: 3 },
            { lot: 'TARD', date: '31/12/2030', qte: 5 }
        ]);

        const tx = loadDB().transactions;
        expect(tx).toHaveLength(1);
        expect(tx[0].lot).toBe('');
        expect(tx[0].quantite).toBe(2);
    });
});


describe('produits périmés', () => {
    const jour = (n) => {
        const d = new Date();
        d.setDate(d.getDate() + n);
        const pad = x => String(x).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    };

    test('estPerime : hier oui, aujourd\'hui et demain non, vide ou illisible non', () => {
        expect(estPerime(jour(-1))).toBe(true);
        expect(estPerime(jour(0))).toBe(false);
        expect(estPerime(jour(1))).toBe(false);
        expect(estPerime('2020-01-31')).toBe(true);
        expect(estPerime('')).toBe(false);
        expect(estPerime('bientôt')).toBe(false);
    });

    test('lotsPerimesEntrants : nouveau lot périmé ou quantité qui augmente', () => {
        const vieux = { lot: 'V', date: jour(-5) };
        expect(lotsPerimesEntrants([], [{ ...vieux, qte: 3 }])).toEqual([{ ...vieux, qte: 3 }]);
        expect(lotsPerimesEntrants([{ ...vieux, qte: 3 }], [{ ...vieux, qte: 5 }])).toEqual([{ ...vieux, qte: 2 }]);
    });

    test('lotsPerimesEntrants : stock déjà là qui a périmé, ou qui diminue, accepté', () => {
        const vieux = { lot: 'V', date: jour(-5) };
        expect(lotsPerimesEntrants([{ ...vieux, qte: 3 }], [{ ...vieux, qte: 3 }])).toEqual([]);
        expect(lotsPerimesEntrants([{ ...vieux, qte: 3 }], [{ ...vieux, qte: 1 }])).toEqual([]);
        expect(lotsPerimesEntrants([], [{ lot: 'N', date: jour(30), qte: 9 }])).toEqual([]);
    });

    test('ajouterStockParLots refuse un lot périmé', () => {
        setDbCache({
            produits: [{ reference: 'R', nom: '', type_stockage: 'unite', quantite_par_carton: 1 }],
            stock: [{ reference: 'R', utilisateur: 'Commun', quantite: 0, lots_details: '[]', lot: '', date_peremption: '' }],
            transactions: [], historique_prix: [], nextTxId: 1
        });
        const res = ajouterStockParLots('R', 'Commun', [{ lot: 'V', date: jour(-1), qte: 2 }]);
        expect(res.ok).toBe(false);
        expect(res.message).toContain('Entrée refusée');
        expect(loadDB().stock[0].quantite).toBe(0);
    });
});
