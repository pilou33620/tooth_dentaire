/**
 * Tests de l'import de factures (js/features/invoice-import.js) :
 * détection des fichiers en double, remplissage du tableau d'import et
 * validation vers le stock.
 */

import { jest } from '@jest/globals';
import { onPdfSelected, populateImportTable, validateImport, importItems }
    from '../js/features/invoice-import.js';
import { setDbCache, loadDB } from '../js/core/database.js';

const MARKUP = `
    <div id="import-overlay" class="hidden">
        <table><tbody id="import-tbody"></tbody></table>
    </div>
    <datalist id="groups-list"></datalist>
    <div id="msg-overlay" class="hidden">
        <h3 id="msg-title"></h3><div id="msg-text"></div>
        <button id="msg-ok"></button>
    </div>
    <button id="btn-alertes-stock" class="hidden"></button>
    <button id="btn-alertes-peremp" class="hidden"></button>
    <div id="postit-container" class="hidden">
        <div id="postit-rupture"><span class="postit-title"></span></div>
        <ul id="postit-list"></ul>
    </div>
`;

function article(extra = {}) {
    return Object.assign({
        fournisseur: 'GACD', reference: 'REF1', designation: 'Gant nitrile',
        quantite: 10, prix_unitaire_ht: 1, prix_unitaire_ttc: 1.2,
        prix_total_ht: 10, prix_total_ttc: 12
    }, extra);
}

function baseVide(produits = [], stock = []) {
    return {
        produits, stock, transactions: [], autoclave: [], historique_prix: [],
        nextTxId: 1, nextAutoId: 1
    };
}

/** Prépare la page, la base et le tableau d'import pour les articles donnés. */
function preparerImport(articles, produits = [], stock = []) {
    document.body.innerHTML = MARKUP;
    setDbCache(baseVide(produits, stock));
    importItems.length = 0;
    articles.forEach(a => importItems.push(a));
    populateImportTable();
}

function lignes() {
    return Array.from(document.querySelectorAll('#import-tbody tr'));
}

/** Renseigne un code-barres sur une ligne pour éviter la demande de saisie. */
function poserCodeBarres(tr, code) {
    tr.querySelector('.import-scannette').value = code;
}

/** Laisse tourner la boucle d'évènements (les imports dynamiques du module ne
 *  se résolvent pas sur un simple vidage de microtâches). */
const tick = () => new Promise(r => setTimeout(r, 0));

/** Ferme les boîtes de message tant que l'action en cours n'est pas terminée. */
async function fermerLesMessages(promesse) {
    let termine = false;
    promesse.then(() => { termine = true; }, () => { termine = true; });
    for (let i = 0; i < 40 && !termine; i++) {
        await tick();
        const overlay = document.getElementById('msg-overlay');
        if (!overlay.classList.contains('hidden')) {
            document.getElementById('msg-ok').click();
        }
    }
    return promesse;
}

/** Valide l'import en fermant automatiquement les messages qui s'affichent. */
function validerAvecMessages() {
    return fermerLesMessages(validateImport());
}

describe('remplissage du tableau d\'import', () => {

    test('une ligne par article, numérotée', () => {
        preparerImport([article({ reference: 'A' }), article({ reference: 'B' })]);
        expect(lignes()).toHaveLength(2);
        expect(lignes()[0].querySelector('.rownum').textContent).toBe('1');
    });

    test('fournisseur, référence, désignation et quantité sont repris', () => {
        preparerImport([article()]);
        const tr = lignes()[0];
        expect(tr.cells[1].textContent).toBe('GACD');
        expect(tr.cells[2].textContent).toBe('REF1');
        expect(tr.querySelector('.import-qte-base').value).toBe('10');
    });

    test('l\'espace de destination est « Commun » par défaut', () => {
        preparerImport([article()]);
        expect(lignes()[0].querySelector('.import-user').value).toBe('Commun');
    });

    test('les paramètres d\'un produit déjà connu sont préchargés', () => {
        preparerImport([article()],
            [{ reference: 'REF1', nom: 'Gant', groupe: 'Protection',
               ref_scannette: '3401', type_stockage: 'boite',
               quantite_par_carton: 50 }],
            [{ reference: 'REF1', utilisateur: 'Commun', quantite: 5,
               stock_minimum: 7, alerte_active: 1 }]);
        const tr = lignes()[0];
        expect(tr.querySelector('.import-type-stock').value).toBe('boite');
        expect(tr.querySelector('.import-qte-cond').value).toBe('50');
        expect(tr.querySelector('.import-min').value).toBe('7');
        expect(tr.querySelector('.import-alerte').checked).toBe(true);
        expect(tr.querySelector('.import-scannette').value).toBe('3401');
    });

    test('un produit inconnu part sur les valeurs neutres', () => {
        preparerImport([article()]);
        const tr = lignes()[0];
        expect(tr.querySelector('.import-type-stock').value).toBe('unite');
        expect(tr.querySelector('.import-min').value).toBe('0');
        expect(tr.querySelector('.import-alerte').checked).toBe(false);
        expect(tr.querySelector('.import-groupe').value).toBe('');
    });

    test('le champ « quantité par contenant » n\'apparaît qu\'en conditionnement groupé', () => {
        preparerImport([article()]);
        const tr = lignes()[0];
        expect(tr.querySelector('.import-qte-cond').style.display).toBe('none');

        const sel = tr.querySelector('.import-type-stock');
        sel.value = 'carton';
        sel.dispatchEvent(new Event('change'));
        expect(tr.querySelector('.import-qte-cond').style.display).toBe('');
    });

    test('passer en conditionnement groupé bascule la quantité facturée sur le contenant', () => {
        preparerImport([article({ quantite: 24 })]);
        const tr = lignes()[0];
        const sel = tr.querySelector('.import-type-stock');
        sel.value = 'carton';
        sel.dispatchEvent(new Event('change'));
        expect(tr.querySelector('.import-qte-cond').value).toBe('24');
        expect(tr.querySelector('.import-qte-base').value).toBe('1');
    });

    test('un nouvel appel remplace le contenu du tableau', () => {
        preparerImport([article(), article({ reference: 'B' })]);
        populateImportTable();
        expect(lignes()).toHaveLength(2);
    });
});

describe('validation de l\'import', () => {

    test('la ligne est ajoutée au stock avec ses prix et son fournisseur', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        await validerAvecMessages();

        const s = loadDB().stock.find(x => x.reference === 'REF1');
        expect(s).toMatchObject({
            utilisateur: 'Commun', quantite: 10, fournisseur: 'GACD',
            prix_unitaire_ht: 1, prix_unitaire_ttc: 1.2
        });
    });

    test('une transaction ENTREE_FACTURE est tracée', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        await validerAvecMessages();
        expect(loadDB().transactions.map(t => t.type_transaction))
            .toContain('ENTREE_FACTURE');
    });

    test('le produit est créé avec sa désignation et son groupe', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        lignes()[0].querySelector('.import-groupe').value = 'Protection';
        await validerAvecMessages();

        expect(loadDB().produits.find(p => p.reference === 'REF1'))
            .toMatchObject({ nom: 'Gant nitrile', groupe: 'Protection',
                             ref_scannette: '3401' });
    });

    test('la quantité saisie prime sur la quantité facturée', async () => {
        preparerImport([article({ quantite: 10 })]);
        poserCodeBarres(lignes()[0], '3401');
        lignes()[0].querySelector('.import-qte-base').value = '4';
        await validerAvecMessages();
        expect(loadDB().stock[0].quantite).toBe(4);
    });

    test('une quantité à zéro écarte la ligne sans rien ajouter', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        lignes()[0].querySelector('.import-qte-base').value = '0';
        await validerAvecMessages();

        expect(loadDB().stock).toHaveLength(0);
        expect(document.getElementById('msg-title').textContent)
            .toContain('Aucun article importé');
    });

    test('une quantité négative interrompt tout l\'import', async () => {
        preparerImport([article({ reference: 'A' }), article({ reference: 'B' })]);
        lignes().forEach(tr => poserCodeBarres(tr, '3401'));
        lignes()[0].querySelector('.import-qte-base').value = '-2';
        await validerAvecMessages();

        expect(loadDB().stock).toHaveLength(0);
        expect(document.getElementById('msg-title').textContent)
            .toContain('Quantité invalide');
    });

    test('un champ quantité vide retombe sur la quantité facturée', async () => {
        preparerImport([article({ quantite: 7 })]);
        poserCodeBarres(lignes()[0], '3401');
        lignes()[0].querySelector('.import-qte-base').value = '';
        await validerAvecMessages();
        expect(loadDB().stock[0].quantite).toBe(7);
    });

    test('en conditionnement groupé, la quantité est multipliée et le prix divisé', async () => {
        preparerImport([article({ quantite: 3, prix_unitaire_ht: 50,
                                  prix_unitaire_ttc: 60 })]);
        const tr = lignes()[0];
        poserCodeBarres(tr, '3401');
        tr.querySelector('.import-type-stock').value = 'carton';
        tr.querySelector('.import-qte-cond').value = '10';
        tr.querySelector('.import-qte-base').value = '3';
        await validerAvecMessages();

        const s = loadDB().stock[0];
        expect(s.quantite).toBe(30);
        expect(s.prix_unitaire_ht).toBeCloseTo(5, 4);
        expect(s.prix_unitaire_ttc).toBeCloseTo(6, 4);
    });

    test('la destination choisie est respectée', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        lignes()[0].querySelector('.import-user').value = 'Cabinet 2';
        await validerAvecMessages();
        expect(loadDB().stock[0].utilisateur).toBe('Cabinet 2');
    });

    test('le seuil et l\'alerte saisis sont enregistrés', async () => {
        preparerImport([article()]);
        const tr = lignes()[0];
        poserCodeBarres(tr, '3401');
        tr.querySelector('.import-min').value = '5';
        tr.querySelector('.import-alerte').checked = true;
        await validerAvecMessages();

        expect(loadDB().stock[0]).toMatchObject({ stock_minimum: 5, alerte_active: 1 });
    });

    test('plusieurs lignes sont importées en une passe', async () => {
        preparerImport([
            article({ reference: 'A', quantite: 2 }),
            article({ reference: 'B', quantite: 3 })
        ]);
        lignes().forEach(tr => poserCodeBarres(tr, '3401'));
        await validerAvecMessages();

        const parRef = Object.fromEntries(
            loadDB().stock.map(s => [s.reference, s.quantite]));
        expect(parRef).toEqual({ A: 2, B: 3 });
    });

    test('la date d\'import est au format JJ/MM/AAAA', async () => {
        preparerImport([article()]);
        poserCodeBarres(lignes()[0], '3401');
        await validerAvecMessages();
        expect(loadDB().stock[0].date_import).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });

    test('la fenêtre d\'import se referme après un import réussi', async () => {
        document.body.innerHTML = MARKUP;
        preparerImport([article()]);
        document.getElementById('import-overlay').classList.remove('hidden');
        poserCodeBarres(lignes()[0], '3401');
        await validerAvecMessages();
        expect(document.getElementById('import-overlay').classList.contains('hidden'))
            .toBe(true);
    });
});

describe('code-barres manquant', () => {

    test('la saisie proposée est enregistrée', async () => {
        preparerImport([article()]);
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue('9876');
        await validerAvecMessages();
        expect(loadDB().produits[0].ref_scannette).toBe('9876');
        saisie.mockRestore();
    });

    test('l\'import peut se poursuivre sans code-barres si l\'utilisateur confirme', async () => {
        preparerImport([article()]);
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue('');
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        await validerAvecMessages();
        expect(loadDB().stock).toHaveLength(1);
        expect(loadDB().produits[0].ref_scannette).toBe('');
        saisie.mockRestore();
        confirmer.mockRestore();
    });

    test('refuser interrompt l\'import', async () => {
        preparerImport([article()]);
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue(null);
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        await validerAvecMessages();
        expect(loadDB().stock).toHaveLength(0);
        saisie.mockRestore();
        confirmer.mockRestore();
    });
});

describe('factures en double', () => {

    /** Fichier factice : arrayBuffer() renvoie le contenu passé en octets. */
    function fichier(nom, contenu) {
        const octets = new Uint8Array([...contenu].map(c => c.charCodeAt(0)));
        return { name: nom, arrayBuffer: async () => octets.buffer };
    }

    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        setDbCache(baseVide());
        importItems.length = 0;
        global.pdfjsLib = {
            GlobalWorkerOptions: {},
            getDocument: () => ({
                promise: Promise.resolve({
                    numPages: 1,
                    getPage: async () => ({
                        getTextContent: async () => ({ items: [{
                            str: 'HENRY SCHEIN 123-4567 GANT 2.0 2.0 10.00 12.00 '
                                 + '12.00 24.00 20.0'
                        }] })
                    })
                })
            })
        };
    });

    afterEach(() => { delete global.pdfjsLib; });

    function selectionner(fichiers) {
        return fermerLesMessages(onPdfSelected(fichiers));
    }

    test('deux fichiers au contenu identique ne comptent qu\'une fois', async () => {
        await selectionner([fichier('a.pdf', 'MEME CONTENU'),
                            fichier('b.pdf', 'MEME CONTENU')]);
        expect(importItems).toHaveLength(1);
    });

    test('deux fichiers différents sont tous les deux lus', async () => {
        await selectionner([fichier('a.pdf', 'CONTENU A'),
                            fichier('b.pdf', 'CONTENU B')]);
        // La fusion des doublons est faite par facture, pas entre factures :
        // deux commandes distinctes restent deux lignes à valider.
        expect(importItems).toHaveLength(2);
    });

    test('une sélection vide ne fait rien', async () => {
        await selectionner([]);
        expect(document.getElementById('import-overlay').classList.contains('hidden'))
            .toBe(true);
    });

    test('un fichier sans référence reconnue est signalé', async () => {
        global.pdfjsLib.getDocument = () => ({
            promise: Promise.resolve({
                numPages: 1,
                getPage: async () => ({
                    getTextContent: async () => ({ items: [{ str: 'facture illisible' }] })
                })
            })
        });
        await selectionner([fichier('vide.pdf', 'X')]);
        expect(importItems).toHaveLength(0);
    });

    test('la fenêtre d\'import s\'ouvre quand des lignes ont été extraites', async () => {
        await selectionner([fichier('a.pdf', 'CONTENU')]);
        expect(document.getElementById('import-overlay').classList.contains('hidden'))
            .toBe(false);
        expect(lignes()).toHaveLength(1);
    });
});
