/**
 * Tests du dialogue d'ajout / modification de produit
 * (js/features/product-edit.js) : pré-remplissage, saisie des lots et
 * enregistrement vers le stock.
 */

import { jest } from '@jest/globals';
import { openEditDialog, saveEditDialog } from '../js/features/product-edit.js';
import { setDbCache, loadDB } from '../js/core/database.js';
import { getStock } from '../js/features/stock.js';

const MARKUP = `
    <div id="edit-overlay" class="hidden">
        <h3 id="edit-title"></h3>
        <div class="dialog-body">
            <input id="edit-ref">
            <input id="edit-nom">
            <input type="hidden" id="edit-scannette">
            <div id="edit-scannette-container"></div>
            <input id="edit-groupe" list="groups-list">
            <select id="edit-user"></select>
            <select id="edit-type-stockage">
                <option value="unite">À l'unité</option>
                <option value="carton">En cartons</option>
                <option value="boite">En boîtes</option>
            </select>
            <div id="cond-fields">
                <label id="lbl-qte-par-contenant"></label>
                <input type="number" id="edit-qte-par-contenant" value="1">
                <label id="lbl-nb-contenants"></label>
                <input type="number" id="edit-nb-contenants" value="0">
            </div>
            <label id="lbl-edit-qte"></label>
            <input type="number" id="edit-qte" value="0">
            <input type="number" id="edit-min" value="0">
            <input type="checkbox" id="edit-alerte">
            <input type="checkbox" id="edit-alerte-peremption">
            <input type="number" id="edit-delai-peremption" value="30">
            <div id="edit-lots-container"></div>
            <div id="edit-lots-total"></div>
            <input id="edit-prix-ht">
            <input id="edit-prix-ttc">
            <input id="edit-fournisseur">
            <input type="checkbox" id="edit-en-commande">
            <input id="edit-date-commande">
        </div>
    </div>
    <datalist id="groups-list"></datalist>
    <div id="msg-overlay" class="hidden">
        <h3 id="msg-title"></h3><div id="msg-text"></div>
        <button id="msg-ok"></button>
    </div>
    <div id="placard-overlay" class="hidden">
        <span id="placard-title-bar"></span><h3 id="placard-title"></h3>
        <input id="filter-fichier"><input id="filter-ref">
        <input id="filter-scannette"><input id="filter-nom">
        <input id="filter-groupe"><input id="filter-qte">
        <table id="placard-table">
            <thead><tr><th class="col-user hidden"></th></tr></thead>
            <tbody id="placard-tbody"></tbody>
        </table>
    </div>
    <button id="btn-alertes-stock" class="hidden"></button>
    <button id="btn-alertes-peremp" class="hidden"></button>
    <div id="postit-container" class="hidden">
        <div id="postit-rupture"><span class="postit-title"></span></div>
        <ul id="postit-list"></ul>
    </div>
`;

function baseVide(produits = [], stock = []) {
    return {
        produits, stock, transactions: [], autoclave: [], historique_prix: [],
        nextTxId: 1, nextAutoId: 1
    };
}

function preparer(produits = [], stock = []) {
    document.body.innerHTML = MARKUP;
    setDbCache(baseVide(produits, stock));
}

function saisir(id, valeur) { document.getElementById(id).value = valeur; }
function cocher(id, etat) { document.getElementById(id).checked = etat; }

const tick = () => new Promise(r => setTimeout(r, 0));

/** Enregistre en fermant automatiquement les messages affichés. */
async function enregistrer() {
    const promesse = saveEditDialog();
    let termine = false;
    promesse.then(() => { termine = true; }, () => { termine = true; });
    for (let i = 0; i < 40 && !termine; i++) {
        await tick();
        if (!document.getElementById('msg-overlay').classList.contains('hidden')) {
            document.getElementById('msg-ok').click();
        }
    }
    return promesse;
}

function dateDansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const pad = x => String(x).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function ligneStock() {
    return getStock('Cabinet 1')[0];
}

describe('ouverture en ajout', () => {

    beforeEach(() => {
        preparer();
        openEditDialog();
    });

    test('le titre annonce un ajout', () => {
        expect(document.getElementById('edit-title').textContent)
            .toBe('Ajouter un produit');
    });

    test('tous les champs sont vides ou neutres', () => {
        expect(document.getElementById('edit-ref').value).toBe('');
        expect(document.getElementById('edit-nom').value).toBe('');
        expect(document.getElementById('edit-qte').value).toBe('0');
        expect(document.getElementById('edit-min').value).toBe('0');
        expect(document.getElementById('edit-alerte').checked).toBe(false);
    });

    test('la liste des espaces est remplie', () => {
        const options = document.querySelectorAll('#edit-user option');
        expect(options.length).toBeGreaterThanOrEqual(7);
    });

    test('l\'alerte de péremption est active par défaut sur un nouveau produit', () => {
        expect(document.getElementById('edit-alerte-peremption').checked).toBe(true);
        expect(document.getElementById('edit-delai-peremption').value).toBe('30');
    });

    test('une ligne de code-barres vide est proposée', () => {
        expect(document.querySelectorAll('.edit-scannette-val')).toHaveLength(1);
    });

    test('aucune ligne de lot n\'est proposée', () => {
        expect(document.getElementById('edit-lots-container').children).toHaveLength(0);
    });

    test('la boîte devient visible', () => {
        expect(document.getElementById('edit-overlay').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('ouverture en modification', () => {

    function ouvrirSur(extra = {}) {
        preparer(
            [Object.assign({ reference: 'REF1', nom: 'Gant', groupe: 'Protection',
                             ref_scannette: '3401, 3402', type_stockage: 'unite',
                             quantite_par_carton: 1 }, extra.produit || {})],
            [Object.assign({ reference: 'REF1', utilisateur: 'Cabinet 1',
                             quantite: 12, stock_minimum: 3, alerte_active: 1,
                             alerte_peremption_active: 0, delai_peremption: 45,
                             date_peremption: '', date_import: '', fournisseur: 'GACD',
                             en_commande: 1, date_commande: '01/03/2026', lot: '',
                             prix_unitaire_ht: 1.5, prix_unitaire_ttc: 1.8,
                             lots_details: '[]' }, extra.stock || {})]);
        openEditDialog(getStock('Cabinet 1')[0]);
    }

    test('le titre annonce une modification', () => {
        ouvrirSur();
        expect(document.getElementById('edit-title').textContent)
            .toBe('Modifier le produit');
    });

    test('les champs sont pré-remplis', () => {
        ouvrirSur();
        expect(document.getElementById('edit-ref').value).toBe('REF1');
        expect(document.getElementById('edit-nom').value).toBe('Gant');
        expect(document.getElementById('edit-groupe').value).toBe('Protection');
        expect(document.getElementById('edit-user').value).toBe('Cabinet 1');
        expect(document.getElementById('edit-qte').value).toBe('12');
        expect(document.getElementById('edit-min').value).toBe('3');
        expect(document.getElementById('edit-fournisseur').value).toBe('GACD');
        expect(document.getElementById('edit-prix-ht').value).toBe('1.5');
    });

    test('les cases à cocher reprennent l\'état enregistré', () => {
        ouvrirSur();
        expect(document.getElementById('edit-alerte').checked).toBe(true);
        expect(document.getElementById('edit-alerte-peremption').checked).toBe(false);
        expect(document.getElementById('edit-delai-peremption').value).toBe('45');
        expect(document.getElementById('edit-en-commande').checked).toBe(true);
        expect(document.getElementById('edit-date-commande').value).toBe('01/03/2026');
    });

    test('une ligne par code-barres enregistré', () => {
        ouvrirSur();
        const valeurs = Array.from(document.querySelectorAll('.edit-scannette-val'))
            .map(i => i.value);
        expect(valeurs).toEqual(['3401', '3402']);
    });

    test('la référence et l\'espace d\'origine sont mémorisés', () => {
        ouvrirSur();
        expect(document.getElementById('edit-ref').dataset.originalRef).toBe('REF1');
        expect(document.getElementById('edit-user').dataset.originalUser)
            .toBe('Cabinet 1');
    });

    test('un conditionnement groupé est éclaté en contenants et vrac', () => {
        ouvrirSur({
            produit: { type_stockage: 'carton', quantite_par_carton: 10 },
            stock: { quantite: 32 }
        });
        expect(document.getElementById('edit-qte-par-contenant').value).toBe('10');
        expect(document.getElementById('edit-nb-contenants').value).toBe('3');
        expect(document.getElementById('edit-qte').value).toBe('2');
        expect(document.getElementById('cond-fields').classList.contains('hidden'))
            .toBe(false);
    });

    test('ouvrir le dialogue ne reventile pas la quantité', () => {
        ouvrirSur({
            produit: { type_stockage: 'carton', quantite_par_carton: 10 },
            stock: { quantite: 32 }
        });
        const nb = parseInt(document.getElementById('edit-nb-contenants').value, 10);
        const vrac = parseInt(document.getElementById('edit-qte').value, 10);
        expect(nb * 10 + vrac).toBe(32);
    });

    test('les lots enregistrés sont réaffichés avec leur quantité', () => {
        ouvrirSur({ stock: {
            quantite: 8, lot: 'A, B', date_peremption: '01/01/2027, 31/12/2030',
            lots_details: JSON.stringify([
                { lot: 'A', date: '01/01/2027', qte: 3 },
                { lot: 'B', date: '31/12/2030', qte: 5 }
            ])
        } });
        const rows = document.getElementById('edit-lots-container').children;
        expect(rows).toHaveLength(2);
        expect(rows[0].querySelector('.lot-val').value).toBe('A');
        expect(rows[0].querySelector('.qte-val').value).toBe('3');
        expect(document.getElementById('edit-lots-total').textContent)
            .toContain('8 unité(s)');
    });

    test('un stock décrit par les seuls champs lot/date est converti en lignes', () => {
        ouvrirSur({ stock: {
            quantite: 6, lot: 'ANCIEN', date_peremption: '01/06/2027',
            lots_details: '[]'
        } });
        const rows = document.getElementById('edit-lots-container').children;
        expect(rows).toHaveLength(1);
        expect(rows[0].querySelector('.lot-val').value).toBe('ANCIEN');
        expect(rows[0].querySelector('.date-val').value).toBe('01/06/2027');
    });
});

describe('lignes de code-barres', () => {

    beforeEach(() => {
        preparer();
        openEditDialog();
    });

    test('la touche Entrée ajoute une ligne', () => {
        const champ = document.querySelector('.edit-scannette-val');
        champ.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(document.querySelectorAll('.edit-scannette-val')).toHaveLength(2);
    });

    test('supprimer la dernière ligne en recrée une vide', () => {
        const conteneur = document.getElementById('edit-scannette-container');
        conteneur.querySelector('button').click();
        expect(conteneur.children).toHaveLength(1);
        expect(conteneur.querySelector('.edit-scannette-val').value).toBe('');
    });

    test('coller une liste de codes la découpe en lignes', async () => {
        const champ = document.querySelector('.edit-scannette-val');
        champ.value = '111; 222, 333';
        champ.dispatchEvent(new Event('paste'));
        await tick();
        const valeurs = Array.from(document.querySelectorAll('.edit-scannette-val'))
            .map(i => i.value);
        expect(valeurs).toEqual(['111', '222', '333']);
    });
});

describe('lignes de lots', () => {

    beforeEach(() => {
        preparer();
        openEditDialog();
        window.renderEditLots([{ lot: 'A', date: '01/01/2027', qte: 3 }]);
    });

    test('le total des lots est affiché', () => {
        expect(document.getElementById('edit-lots-total').textContent)
            .toContain('3 unité(s)');
    });

    test('saisir une quantité de lot met à jour la quantité en stock', () => {
        const champ = document.querySelector('#edit-lots-container .qte-val');
        champ.value = '7';
        champ.dispatchEvent(new Event('input'));
        expect(document.getElementById('edit-qte').value).toBe('7');
        expect(document.getElementById('edit-lots-total').textContent)
            .toContain('7 unité(s)');
    });

    test('la synchronisation ne s\'applique pas en conditionnement groupé', () => {
        const sel = document.getElementById('edit-type-stockage');
        sel.value = 'carton';
        window.toggleCondFields();
        document.getElementById('edit-qte').value = '2';

        const champ = document.querySelector('#edit-lots-container .qte-val');
        champ.value = '7';
        champ.dispatchEvent(new Event('input'));
        expect(document.getElementById('edit-qte').value).toBe('2');
    });

    test('supprimer une ligne de lot met le total à jour', () => {
        document.querySelector('#edit-lots-container button').click();
        expect(document.getElementById('edit-lots-container').children).toHaveLength(0);
        expect(document.getElementById('edit-lots-total').textContent).toBe('');
    });

    test('totalLotsSaisis ignore les quantités vides ou nulles', () => {
        window.renderEditLots([
            { lot: 'A', qte: 3 }, { lot: 'B', qte: '' }, { lot: 'C', qte: 0 }
        ]);
        expect(window.totalLotsSaisis()).toBe(3);
    });
});

describe('enregistrement', () => {

    function remplirNouveauProduit() {
        saisir('edit-ref', 'REF9');
        saisir('edit-nom', 'Compresse');
        saisir('edit-groupe', 'Soin');
        document.querySelector('.edit-scannette-val').value = '3401';
        document.getElementById('edit-user').value = 'Cabinet 1';
        saisir('edit-qte', '15');
        saisir('edit-min', '4');
        cocher('edit-alerte', true);
        saisir('edit-prix-ht', '1,50');
        saisir('edit-prix-ttc', '1,80');
        saisir('edit-fournisseur', 'GACD');
    }

    beforeEach(() => {
        preparer();
        openEditDialog();
    });

    test('un nouveau produit est créé avec sa ligne de stock', async () => {
        remplirNouveauProduit();
        await enregistrer();

        const db = loadDB();
        expect(db.produits.find(p => p.reference === 'REF9'))
            .toMatchObject({ nom: 'Compresse', groupe: 'Soin', ref_scannette: '3401' });
        expect(ligneStock()).toMatchObject({
            reference: 'REF9', quantite: 15, stock_minimum: 4,
            alerte_active: 1, fournisseur: 'GACD'
        });
    });

    test('les prix au format français sont convertis', async () => {
        remplirNouveauProduit();
        await enregistrer();
        expect(ligneStock().prix_unitaire_ht).toBeCloseTo(1.5, 4);
        expect(ligneStock().prix_unitaire_ttc).toBeCloseTo(1.8, 4);
    });

    test('une référence vide est refusée', async () => {
        remplirNouveauProduit();
        saisir('edit-ref', '   ');
        await enregistrer();
        expect(loadDB().stock).toHaveLength(0);
        expect(document.getElementById('msg-text').textContent)
            .toContain('référence ne peut pas être vide');
    });

    test('la quantité totale d\'un conditionnement groupé est recomposée', async () => {
        remplirNouveauProduit();
        const sel = document.getElementById('edit-type-stockage');
        sel.value = 'carton';
        window.toggleCondFields();
        saisir('edit-qte-par-contenant', '10');
        saisir('edit-nb-contenants', '3');
        saisir('edit-qte', '2');
        await enregistrer();
        expect(ligneStock().quantite).toBe(32);
    });

    test('les lots saisis sont enregistrés avec leurs dates', async () => {
        remplirNouveauProduit();
        saisir('edit-qte', '8');
        window.renderEditLots([
            { lot: 'A', date: '01/01/2027', qte: 3 },
            { lot: 'B', date: '31/12/2030', qte: 5 }
        ]);
        await enregistrer();

        const s = ligneStock();
        expect(s.lot).toBe('A, B');
        expect(s.date_peremption).toBe('01/01/2027, 31/12/2030');
        expect(JSON.parse(s.lots_details)).toHaveLength(2);
    });

    test('une somme de lots supérieure à la quantité est refusée', async () => {
        remplirNouveauProduit();
        saisir('edit-qte', '4');
        window.renderEditLots([{ lot: 'A', date: '01/01/2027', qte: 10 }]);
        document.getElementById('edit-qte').value = '4';
        await enregistrer();

        expect(loadDB().stock).toHaveLength(0);
        expect(document.getElementById('msg-title').textContent)
            .toContain('Quantités incohérentes');
    });

    test('une date déjà dépassée force l\'alerte de péremption', async () => {
        remplirNouveauProduit();
        cocher('edit-alerte-peremption', false);
        window.renderEditLots([{ lot: 'A', date: dateDansNJours(-3), qte: 1 }]);
        saisir('edit-qte', '15');
        await enregistrer();

        expect(ligneStock().alerte_peremption_active).toBe(1);
    });

    test('le délai de pré-alerte saisi est enregistré', async () => {
        remplirNouveauProduit();
        saisir('edit-delai-peremption', '60');
        await enregistrer();
        expect(ligneStock().delai_peremption).toBe(60);
    });

    test('changer d\'espace déplace la ligne et trace la sortie', async () => {
        preparer(
            [{ reference: 'REF1', nom: 'Gant', groupe: 'G', ref_scannette: '3401',
               type_stockage: 'unite', quantite_par_carton: 1 }],
            [{ reference: 'REF1', utilisateur: 'Cabinet 1', quantite: 5,
               stock_minimum: 0, alerte_active: 0, alerte_peremption_active: 0,
               delai_peremption: 30, date_peremption: '', date_import: '',
               fournisseur: '', lot: '', lots_details: '[]',
               prix_unitaire_ht: 0, prix_unitaire_ttc: 0 }]);
        openEditDialog(getStock('Cabinet 1')[0]);
        document.getElementById('edit-user').value = 'Cabinet 2';
        await enregistrer();

        const db = loadDB();
        expect(db.stock.filter(s => s.utilisateur === 'Cabinet 1')).toHaveLength(0);
        expect(db.stock.find(s => s.utilisateur === 'Cabinet 2').quantite).toBe(5);
        expect(db.transactions.map(t => t.type_transaction))
            .toContain('SORTIE (Modification Réf/Espace)');
    });

    test('renommer la référence déplace également la ligne', async () => {
        preparer(
            [{ reference: 'REF1', nom: 'Gant', groupe: 'G', ref_scannette: '3401',
               type_stockage: 'unite', quantite_par_carton: 1 }],
            [{ reference: 'REF1', utilisateur: 'Cabinet 1', quantite: 5,
               stock_minimum: 0, alerte_active: 0, alerte_peremption_active: 0,
               delai_peremption: 30, date_peremption: '', date_import: '',
               fournisseur: '', lot: '', lots_details: '[]',
               prix_unitaire_ht: 0, prix_unitaire_ttc: 0 }]);
        openEditDialog(getStock('Cabinet 1')[0]);
        saisir('edit-ref', 'REF1-BIS');
        await enregistrer();

        const refs = loadDB().stock.map(s => s.reference);
        expect(refs).toEqual(['REF1-BIS']);
    });

    test('la boîte se ferme après un enregistrement réussi', async () => {
        remplirNouveauProduit();
        await enregistrer();
        expect(document.getElementById('edit-overlay').classList.contains('hidden'))
            .toBe(true);
    });

    test('sans code-barres, la saisie proposée est retenue', async () => {
        saisir('edit-ref', 'REF9');
        saisir('edit-qte', '1');
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue('7777');
        await enregistrer();
        expect(loadDB().produits[0].ref_scannette).toBe('7777');
        saisie.mockRestore();
    });

    test('l\'enregistrement sans code-barres peut être forcé', async () => {
        saisir('edit-ref', 'REF9');
        saisir('edit-qte', '1');
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue('');
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        await enregistrer();
        expect(loadDB().stock).toHaveLength(1);
        saisie.mockRestore();
        confirmer.mockRestore();
    });

    test('refuser interrompt l\'enregistrement', async () => {
        saisir('edit-ref', 'REF9');
        saisir('edit-qte', '1');
        const saisie = jest.spyOn(window, 'prompt').mockReturnValue(null);
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        await enregistrer();
        expect(loadDB().stock).toHaveLength(0);
        saisie.mockRestore();
        confirmer.mockRestore();
    });

    test('les codes en double sont dédoublonnés', async () => {
        remplirNouveauProduit();
        window.renderEditScannettes('3401, 3402, 3401');
        await enregistrer();
        expect(loadDB().produits[0].ref_scannette).toBe('3401, 3402');
    });
});
