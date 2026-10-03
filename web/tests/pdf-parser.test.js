/**
 * Tests du parseur de factures (js/parsers/pdf-parser.js).
 *
 * Le texte brut sert d'entrée : aucun PDF réel n'est nécessaire. Les colonnes
 * reproduisent la mise en page réelle des factures Henry Schein et GACD.
 */

import { jest } from '@jest/globals';
import { parseInvoiceText, extractStockFromPdf } from '../js/parsers/pdf-parser.js';

/* ------------------------------------------------------------------
   Fabriques de texte de facture
   ------------------------------------------------------------------ */

/** Ligne Henry Schein : ref | désignation | cmd | livrée | tarif HT | tarif TTC
 *  | [remise%] | PU net TTC | total net TTC | TVA */
function ligneHS({ ref = '123-4567', designation = 'GANT NITRILE M', cmd = '2.0',
                   livree = '2.0', tarifHT = '10.00', tarifTTC = '12.00',
                   remise = null, puTTC = '12.00', totalTTC = '24.00',
                   tva = '20.0' } = {}) {
    const cols = [ref, designation, cmd, livree, tarifHT, tarifTTC];
    if (remise !== null) cols.push(remise + '%');
    cols.push(puTTC, totalTTC, tva);
    return cols.join(' ');
}

function factureHS(...lignes) {
    return 'HENRY SCHEIN FRANCE FACTURE N 12345 ' + lignes.join(' ');
}

/** Ligne GACD : ref | désignation | qté | PU réf TTC | [remise %] |
 *  PU net TTC | total net TTC | total net HT (montants au format FR) */
function ligneGACD({ ref = '103-41801', designation = 'COTON SALIVAIRE', qte = '4',
                     puRefTTC = '12,00', remise = null, puNetTTC = '10,00',
                     totalTTC = '40,00', totalHT = '33,33' } = {}) {
    const cols = [ref, designation, qte, puRefTTC];
    if (remise !== null) cols.push(remise + ' %');
    cols.push(puNetTTC, totalTTC, totalHT);
    return cols.join(' ');
}

function factureGACD(...lignes) {
    return 'GACD SAS Facture Commande 2402298301 du 15.01.2026 ' + lignes.join(' ');
}

describe('parseInvoiceText - Henry Schein', () => {

    test('extrait une ligne complète', () => {
        const items = parseInvoiceText(factureHS(ligneHS()));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            fournisseur: 'Henry Schein',
            reference: '123-4567',
            designation: 'GANT NITRILE M',
            quantite: 2,
            prix_unitaire_ttc: 12,
            prix_total_ttc: 24
        });
    });

    test('déduit le HT du taux de TVA', () => {
        const [item] = parseInvoiceText(factureHS(ligneHS()));
        expect(item.prix_unitaire_ht).toBeCloseTo(10, 4);
        expect(item.prix_total_ht).toBeCloseTo(20, 2);
    });

    test('une TVA à 0 % ne devient pas 20 %', () => {
        const [item] = parseInvoiceText(factureHS(ligneHS({ tva: '0.0' })));
        expect(item.prix_unitaire_ht).toBeCloseTo(12, 4);
        expect(item.prix_total_ht).toBeCloseTo(24, 2);
    });

    test('gère la TVA réduite à 5,5 %', () => {
        const [item] = parseInvoiceText(factureHS(ligneHS({ tva: '5.5' })));
        expect(item.prix_unitaire_ht).toBeCloseTo(12 / 1.055, 4);
    });

    test('retient la quantité LIVRÉE et non la quantité COMMANDÉE', () => {
        const [item] = parseInvoiceText(
            factureHS(ligneHS({ cmd: '10.0', livree: '4.0' })));
        expect(item.quantite).toBe(4);
    });

    test('accepte une colonne remise optionnelle', () => {
        const items = parseInvoiceText(factureHS(ligneHS({ remise: '15.00' })));
        expect(items).toHaveLength(1);
        expect(items[0].quantite).toBe(2);
    });

    test('accepte le tiret demi-cadratin dans la référence et le normalise', () => {
        const [item] = parseInvoiceText(factureHS(ligneHS({ ref: '123–4567' })));
        expect(item.reference).toBe('123-4567');
    });

    test('met la référence en majuscules', () => {
        const items = parseInvoiceText(factureHS(ligneHS({ ref: '999-0001' })));
        expect(items[0].reference).toBe('999-0001');
    });

    test('ignore une ligne non livrée', () => {
        expect(parseInvoiceText(factureHS(ligneHS({ livree: '0.0' })))).toHaveLength(0);
    });

    test('ignore les frais de port', () => {
        const items = parseInvoiceText(factureHS(
            ligneHS(),
            ligneHS({ ref: '999-9999', designation: 'FRAIS DE PORT' })));
        expect(items.map(i => i.reference)).toEqual(['123-4567']);
    });

    test('ignore la casse de "frais de port"', () => {
        const items = parseInvoiceText(factureHS(
            ligneHS({ ref: '999-9999', designation: 'Frais de Port forfaitaires' })));
        expect(items).toHaveLength(0);
    });

    test('ignore tout ce qui suit une étiquette retour', () => {
        const texte = factureHS(ligneHS()) + ' ETIQUETTE RETOUR '
            + ligneHS({ ref: '888-8888', designation: 'RETOUR' });
        expect(parseInvoiceText(texte).map(i => i.reference)).toEqual(['123-4567']);
    });

    test('ignore tout ce qui suit un bon de colisage', () => {
        const texte = factureHS(ligneHS()) + ' Bon de colisage '
            + ligneHS({ ref: '777-7777', designation: 'COLIS' });
        expect(parseInvoiceText(texte).map(i => i.reference)).toEqual(['123-4567']);
    });

    test("n'accroche pas les adresses ni les téléphones de l'en-tête", () => {
        const texte = 'HENRY SCHEIN FRANCE 2-4 RUE DE LA PAIX 75000 PARIS '
            + 'TEL 01-2345 6789 FAX 01-2345 ' + ligneHS();
        expect(parseInvoiceText(texte)).toHaveLength(1);
    });

    test('compacte les espaces multiples de la désignation', () => {
        const [item] = parseInvoiceText(
            factureHS(ligneHS({ designation: 'GANT     NITRILE     M' })));
        expect(item.designation).toBe('GANT NITRILE M');
    });

    test('extrait plusieurs lignes distinctes', () => {
        const items = parseInvoiceText(factureHS(
            ligneHS({ ref: '111-1111' }),
            ligneHS({ ref: '222-2222' }),
            ligneHS({ ref: '333-3333' })));
        expect(items.map(i => i.reference)).toEqual(['111-1111', '222-2222', '333-3333']);
    });
});

describe('parseInvoiceText - GACD', () => {

    test('extrait une ligne complète', () => {
        const items = parseInvoiceText(factureGACD(ligneGACD()));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            fournisseur: 'GACD',
            reference: '103-41801',
            quantite: 4,
            prix_unitaire_ttc: 10,
            prix_total_ttc: 40,
            prix_total_ht: 33.33
        });
    });

    test('déduit le prix unitaire HT du total HT', () => {
        const [item] = parseInvoiceText(factureGACD(ligneGACD()));
        expect(item.prix_unitaire_ht).toBeCloseTo(33.33 / 4, 4);
    });

    test('lit les montants au format français avec séparateur de milliers', () => {
        const [item] = parseInvoiceText(factureGACD(ligneGACD({
            qte: '1', puRefTTC: '1.234,56', puNetTTC: '1.234,56',
            totalTTC: '1.234,56', totalHT: '1.028,80' })));
        expect(item.prix_unitaire_ttc).toBeCloseTo(1234.56, 2);
        expect(item.prix_total_ht).toBeCloseTo(1028.80, 2);
    });

    test('accepte une référence alphanumérique', () => {
        const [item] = parseInvoiceText(factureGACD(ligneGACD({ ref: 'CS-2789' })));
        expect(item.reference).toBe('CS-2789');
    });

    test('accepte une colonne remise optionnelle', () => {
        const items = parseInvoiceText(factureGACD(ligneGACD({ remise: '10,00' })));
        expect(items).toHaveLength(1);
        expect(items[0].prix_unitaire_ttc).toBe(10);
    });

    test('ignore la ligne de port 200-000', () => {
        const items = parseInvoiceText(factureGACD(
            ligneGACD(),
            ligneGACD({ ref: '200-000', designation: 'PARTICIPATION' })));
        expect(items.map(i => i.reference)).toEqual(['103-41801']);
    });

    test('ignore les frais de port', () => {
        const items = parseInvoiceText(factureGACD(
            ligneGACD({ ref: '900-1', designation: 'FRAIS DE PORT' })));
        expect(items).toHaveLength(0);
    });

    test('ignore une quantité nulle', () => {
        expect(parseInvoiceText(factureGACD(ligneGACD({ qte: '0' })))).toHaveLength(0);
    });

    test("ignore l'en-tête situé avant le tableau des commandes", () => {
        const enTete = 'GACD SAS TVA 20,00 % IBAN FR76 1234 5678 90 '
            + '999-999 TOTAL TVA 1 100,00 20,00 120,00 100,00 ';
        const items = parseInvoiceText(enTete + factureGACD(ligneGACD()));
        expect(items.map(i => i.reference)).toEqual(['103-41801']);
    });
});

describe('parseInvoiceText - détection du fournisseur', () => {

    test("n'applique que le parseur du fournisseur détecté", () => {
        const items = parseInvoiceText(factureHS(ligneHS()));
        expect(items.every(i => i.fournisseur === 'Henry Schein')).toBe(true);
    });

    test('la détection est insensible à la casse', () => {
        const items = parseInvoiceText('Henry Schein France ' + ligneHS());
        expect(items).toHaveLength(1);
        expect(items[0].fournisseur).toBe('Henry Schein');
    });

    test('fournisseur inconnu : Henry Schein est tenté en premier', () => {
        const items = parseInvoiceText('FOURNISSEUR X SARL ' + ligneHS());
        expect(items).toHaveLength(1);
        expect(items[0].fournisseur).toBe('Henry Schein');
    });

    test('fournisseur inconnu : repli sur GACD si Henry Schein ne trouve rien', () => {
        const items = parseInvoiceText('FOURNISSEUR X SARL ' + ligneGACD());
        expect(items).toHaveLength(1);
        expect(items[0].fournisseur).toBe('GACD');
    });

    test('texte vide ou sans ligne exploitable', () => {
        for (const texte of ['', '   ', 'Facture sans aucun tableau']) {
            expect(parseInvoiceText(texte)).toEqual([]);
        }
    });
});

describe('parseInvoiceText - fusion des doublons', () => {

    test('additionne quantités et totaux pour une même référence', () => {
        const items = parseInvoiceText(factureHS(
            ligneHS({ livree: '2.0', totalTTC: '24.00' }),
            ligneHS({ livree: '3.0', totalTTC: '36.00' })));
        expect(items).toHaveLength(1);
        expect(items[0].quantite).toBe(5);
        expect(items[0].prix_total_ttc).toBeCloseTo(60, 2);
        expect(items[0].prix_total_ht).toBeCloseTo(50, 2);
    });

    test('conserve le prix unitaire lors de la fusion', () => {
        const [item] = parseInvoiceText(factureHS(ligneHS(), ligneHS()));
        expect(item.prix_unitaire_ttc).toBe(12);
    });

    test('ne fusionne pas deux références différentes', () => {
        const items = parseInvoiceText(factureHS(
            ligneHS({ ref: '111-1111' }), ligneHS({ ref: '222-2222' })));
        expect(items).toHaveLength(2);
    });

    test('fusionne trois occurrences de la même référence', () => {
        const items = parseInvoiceText(factureGACD(
            ligneGACD({ qte: '1', totalTTC: '10,00', totalHT: '8,33' }),
            ligneGACD({ qte: '2', totalTTC: '20,00', totalHT: '16,67' }),
            ligneGACD({ qte: '3', totalTTC: '30,00', totalHT: '25,00' })));
        expect(items).toHaveLength(1);
        expect(items[0].quantite).toBe(6);
        expect(items[0].prix_total_ttc).toBeCloseTo(60, 2);
    });
});

describe('extractStockFromPdf', () => {

    afterEach(() => {
        delete global.pdfjsLib;
        if (console.error.mockRestore) console.error.mockRestore();
    });

    test("renvoie une erreur explicite quand PDF.js n'est pas chargé", async () => {
        const res = await extractStockFromPdf({ name: 'facture.pdf' });
        expect(res.items).toEqual([]);
        expect(res.erreur).toMatch(/PDF\.js/);
    });

    test("n'invente jamais de lignes de démonstration", async () => {
        const res = await extractStockFromPdf({ name: 'facture.pdf' });
        expect(JSON.stringify(res.items)).not.toMatch(/CARTON-A1|BOITE-B2/);
    });

    test('remonte une erreur nommant le fichier illisible', async () => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        global.pdfjsLib = {
            GlobalWorkerOptions: {},
            getDocument: () => ({ promise: Promise.reject(new Error('PDF corrompu')) })
        };
        const fichier = {
            name: 'abimee.pdf',
            arrayBuffer: async () => new ArrayBuffer(8)
        };
        const res = await extractStockFromPdf(fichier);
        expect(res.items).toEqual([]);
        expect(res.erreur).toContain('abimee.pdf');
        expect(res.erreur).toContain('PDF corrompu');
    });

    test('concatène le texte de toutes les pages puis le parse', async () => {
        const pages = [
            { items: [{ str: 'HENRY SCHEIN' }] },
            { items: [{ str: ligneHS() }] }
        ];
        global.pdfjsLib = {
            GlobalWorkerOptions: {},
            getDocument: () => ({
                promise: Promise.resolve({
                    numPages: 2,
                    getPage: async (n) => ({ getTextContent: async () => pages[n - 1] })
                })
            })
        };
        const res = await extractStockFromPdf({
            name: 'ok.pdf', arrayBuffer: async () => new ArrayBuffer(8)
        });
        expect(res.erreur).toBeNull();
        expect(res.items).toHaveLength(1);
        expect(res.items[0].reference).toBe('123-4567');
    });

    test('désactive eval et les polices embarquées à la lecture', async () => {
        let optionsRecues = null;
        global.pdfjsLib = {
            GlobalWorkerOptions: {},
            getDocument: (opts) => {
                optionsRecues = opts;
                return {
                    promise: Promise.resolve({
                        numPages: 1,
                        getPage: async () => ({ getTextContent: async () => ({ items: [] }) })
                    })
                };
            }
        };
        await extractStockFromPdf({
            name: 'ok.pdf', arrayBuffer: async () => new ArrayBuffer(8)
        });
        expect(optionsRecues.isEvalSupported).toBe(false);
        expect(optionsRecues.disableFontFace).toBe(true);
    });
});
