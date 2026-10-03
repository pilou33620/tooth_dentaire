/**
 * Tests du placard (js/features/placard.js) : rendu du tableau, codes couleur,
 * boutons +/-, filtres et suppression de référence.
 */

import { jest } from '@jest/globals';
import { openPlacard, refreshPlacardTable, filterPlacardTable } from '../js/features/placard.js';
import { setDbCache, loadDB } from '../js/core/database.js';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const MARKUP = `
    <div id="placard-overlay" class="hidden">
        <span id="placard-title-bar"></span>
        <h3 id="placard-title"></h3>
        <input id="filter-fichier"><input id="filter-ref">
        <input id="filter-scannette"><input id="filter-nom">
        <input id="filter-groupe"><input id="filter-qte">
        <table id="placard-table">
            <thead><tr><th class="col-user hidden">Espace</th></tr></thead>
            <tbody id="placard-tbody"></tbody>
        </table>
    </div>
    <button id="btn-alertes-stock" class="hidden"></button>
    <button id="btn-alertes-peremp" class="hidden"></button>
    <div id="postit-container" class="hidden">
        <div id="postit-rupture"><span class="postit-title"></span></div>
        <ul id="postit-list"></ul>
    </div>
    <div id="msg-overlay" class="hidden">
        <h3 id="msg-title"></h3><div id="msg-text"></div>
        <button id="msg-ok"></button>
    </div>
`;

function ligne(extra = {}) {
    return Object.assign({
        reference: 'REF1', utilisateur: 'Cabinet 1', quantite: 10,
        stock_minimum: 2, alerte_active: 0, alerte_peremption_active: 1,
        delai_peremption: 30, date_peremption: '', date_import: '01/01/2026',
        fournisseur: 'GACD', en_commande: 0, date_commande: '',
        lot: '', prix_unitaire_ht: 0, prix_unitaire_ttc: 0, lots_details: '[]'
    }, extra);
}

function dateDansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const pad = x => String(x).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function preparer(stock, produits = [{ reference: 'REF1', nom: 'Gant',
                                       groupe: 'Protection', ref_scannette: '123' }]) {
    document.body.innerHTML = MARKUP;
    setDbCache({
        produits, stock, transactions: [], autoclave: [], historique_prix: [],
        nextTxId: 1, nextAutoId: 1
    });
}

function lignes() {
    return Array.from(document.querySelectorAll('#placard-tbody tr'));
}

function visibles() {
    return lignes().filter(tr => tr.style.display !== 'none');
}

function cellules(tr) {
    return Array.from(tr.cells).map(td => td.textContent.trim());
}

/** Boutons de la colonne Actions : ✏️ modifier, 📥 entrée, 📤 sortie, ❌ supprimer. */
function boutonsAction(tr) {
    const btns = tr.querySelectorAll('.btn.btn-small');
    return { modifier: btns[0], entree: btns[1], sortie: btns[2], supprimer: btns[3] };
}

describe('ouverture du placard', () => {

    test('titre pour un espace donné', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        expect(document.getElementById('placard-title-bar').textContent)
            .toBe('Placard - Cabinet 1');
        expect(document.getElementById('placard-title').textContent)
            .toContain('Cabinet 1');
    });

    test('titre en recherche globale', () => {
        preparer([ligne()]);
        openPlacard('TOUS');
        expect(document.getElementById('placard-title-bar').textContent)
            .toBe('Recherche Globale');
        expect(document.getElementById('placard-title').textContent)
            .toBe('Tous les espaces');
    });

    test('la colonne « Espace » n\'apparaît qu\'en recherche globale', () => {
        preparer([ligne()]);
        const th = document.querySelector('#placard-table th.col-user');
        openPlacard('Cabinet 1');
        expect(th.classList.contains('hidden')).toBe(true);
        openPlacard('TOUS');
        expect(th.classList.contains('hidden')).toBe(false);
    });

    test('les filtres sont vidés à l\'ouverture', () => {
        preparer([ligne()]);
        document.getElementById('filter-nom').value = 'ancien';
        openPlacard('Cabinet 1');
        expect(document.getElementById('filter-nom').value).toBe('');
    });

    test('une référence peut être pré-filtrée à l\'ouverture', () => {
        preparer([ligne({ reference: 'REF1' }), ligne({ reference: 'REF2' })],
                 [{ reference: 'REF1', nom: 'Gant' }, { reference: 'REF2', nom: 'Coton' }]);
        openPlacard('Cabinet 1', 'REF2');
        expect(document.getElementById('filter-ref').value).toBe('REF2');
        expect(visibles()).toHaveLength(1);
        expect(cellules(visibles()[0])).toContain('REF2');
    });

    test('la boîte devient visible', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        expect(document.getElementById('placard-overlay').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('rendu du tableau', () => {

    test('une ligne par article, numérotée', () => {
        preparer([ligne({ reference: 'REF1' }), ligne({ reference: 'REF2' })],
                 [{ reference: 'REF1', nom: 'A' }, { reference: 'REF2', nom: 'B' }]);
        openPlacard('Cabinet 1');
        expect(lignes()).toHaveLength(2);
        expect(lignes()[0].querySelector('.rownum').textContent).toBe('1');
        expect(lignes()[1].querySelector('.rownum').textContent).toBe('2');
    });

    test('placard vide : message dédié', () => {
        preparer([]);
        openPlacard('Cabinet 1');
        expect(lignes()).toHaveLength(1);
        expect(lignes()[0].classList.contains('empty-row')).toBe(true);
        expect(lignes()[0].textContent).toContain('Aucun article');
    });

    test('les colonnes reprennent les données du produit et du stock', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        const c = cellules(lignes()[0]);
        expect(c[1]).toBe('GACD');        // fournisseur
        expect(c[2]).toBe('REF1');        // référence
        expect(c[3]).toBe('123');         // code scannette
        expect(c[4]).toBe('Gant');        // nom
        expect(c[5]).toBe('Protection');  // groupe
        expect(c[9]).toBe('01/01/2026');  // date d'import
    });

    test('seul l\'espace demandé est listé', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1' }),
            ligne({ utilisateur: 'Cabinet 2' })
        ]);
        openPlacard('Cabinet 1');
        expect(lignes()).toHaveLength(1);
    });

    test('la recherche globale liste tous les espaces', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1' }),
            ligne({ utilisateur: 'Cabinet 2' })
        ]);
        openPlacard('TOUS');
        expect(lignes()).toHaveLength(2);
    });

    test('une quantité négative est affichée ramenée à zéro, pas masquée', () => {
        preparer([ligne({ quantite: -3 })]);
        openPlacard('Cabinet 1');
        expect(lignes()).toHaveLength(1);
        expect(lignes()[0].querySelector('.qte-cell').textContent).toContain('0');
    });
});

describe('codes couleur et libellés', () => {

    test('produit périmé : ligne rouge', () => {
        preparer([ligne({ date_peremption: dateDansNJours(-2) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-red');
        expect(cellules(lignes()[0])[8]).toContain('(Périmé)');
    });

    test('périme aujourd\'hui : ligne rouge', () => {
        preparer([ligne({ date_peremption: dateDansNJours(0) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-red');
        expect(cellules(lignes()[0])[8]).toContain("(Aujourd'hui)");
    });

    test('périme demain : ligne rouge avec compte à rebours', () => {
        preparer([ligne({ date_peremption: dateDansNJours(1) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-red');
        expect(cellules(lignes()[0])[8]).toContain('(J-1)');
    });

    test('dans le délai de pré-alerte : ligne orange', () => {
        preparer([ligne({ date_peremption: dateDansNJours(10) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-orange');
        expect(cellules(lignes()[0])[8]).toContain('(J-10)');
    });

    test('hors délai : aucune couleur', () => {
        preparer([ligne({ date_peremption: dateDansNJours(120) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('');
    });

    test('alerte de péremption désactivée : pas de mise en couleur', () => {
        preparer([ligne({ date_peremption: dateDansNJours(10),
                          alerte_peremption_active: 0 })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('');
    });

    test('stock bas surveillé : ligne rose et rappel du seuil', () => {
        preparer([ligne({ quantite: 1, stock_minimum: 5, alerte_active: 1 })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-pink');
        expect(lignes()[0].querySelector('.qte-cell').textContent).toContain('Min: 5');
    });

    test('la péremption l\'emporte sur le stock bas pour la couleur', () => {
        preparer([ligne({ quantite: 1, stock_minimum: 5, alerte_active: 1,
                          date_peremption: dateDansNJours(-1) })]);
        openPlacard('Cabinet 1');
        expect(lignes()[0].className).toBe('row-red');
    });

    test('le libellé des lots affiche les quantités par lot', () => {
        preparer([ligne({
            quantite: 8, lot: 'A, B', date_peremption: '01/01/2027, 31/12/2030',
            lots_details: JSON.stringify([
                { lot: 'A', date: '01/01/2027', qte: 3 },
                { lot: 'B', date: '31/12/2030', qte: 5 }
            ])
        })]);
        openPlacard('Cabinet 1');
        expect(cellules(lignes()[0])[7]).toMatch(/A/);
        expect(cellules(lignes()[0])[7]).toMatch(/3/);
    });
});

describe('boutons + et -', () => {

    beforeEach(() => {
        preparer([ligne({ quantite: 5 })]);
        openPlacard('Cabinet 1');
    });

    test('le bouton + incrémente la quantité', () => {
        document.querySelector('.qte-plus').click();
        expect(loadDB().stock[0].quantite).toBe(6);
    });

    test('le bouton - décrémente la quantité', async () => {
        document.querySelector('.qte-minus').click();
        await Promise.resolve();
        expect(loadDB().stock[0].quantite).toBe(4);
    });

    test('le tableau est réaffiché après un ajout', () => {
        document.querySelector('.qte-plus').click();
        expect(document.querySelector('.qte-cell').textContent).toContain('6');
    });

    test('un ajout sur une ligne à lot unique rattache l\'unité à ce lot', () => {
        preparer([ligne({
            quantite: 4, lot: 'A', date_peremption: '01/01/2027',
            lots_details: JSON.stringify([{ lot: 'A', date: '01/01/2027', qte: 4 }])
        })]);
        openPlacard('Cabinet 1');
        document.querySelector('.qte-plus').click();

        const s = loadDB().stock[0];
        expect(s.quantite).toBe(5);
        expect(JSON.parse(s.lots_details)[0].qte).toBe(5);
    });
});

describe('suppression d\'une référence', () => {

    test('supprime le produit et toutes ses lignes de stock', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1' }),
            ligne({ utilisateur: 'Cabinet 2' }),
            ligne({ reference: 'REF2', utilisateur: 'Cabinet 1' })
        ], [{ reference: 'REF1', nom: 'Gant' }, { reference: 'REF2', nom: 'Coton' }]);
        openPlacard('Cabinet 1');

        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        boutonsAction(lignes()[0]).supprimer.click();
        confirmer.mockRestore();

        const db = loadDB();
        expect(db.produits.map(p => p.reference)).toEqual(['REF2']);
        expect(db.stock.map(s => s.reference)).toEqual(['REF2']);
    });

    test('la suppression peut être annulée', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        boutonsAction(lignes()[0]).supprimer.click();
        confirmer.mockRestore();
        expect(loadDB().stock).toHaveLength(1);
    });

    test('la suppression est envoyée au serveur', async () => {
        const serveur = installerServeurFactice();
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        boutonsAction(lignes()[0]).supprimer.click();
        confirmer.mockRestore();
        await attendreEcritures();
        const appels = appelsVers(serveur, 'DELETE', '/api/produit');
        expect(appels).toHaveLength(1);
        expect(appels[0].url).toBe('/api/produit?reference=REF1');
    });
});

describe('édition depuis le placard', () => {

    test('le bouton ✏️ ouvre le dialogue de modification', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        const ouvrir = jest.fn();
        window.openEditDialog = ouvrir;
        boutonsAction(lignes()[0]).modifier.click();
        expect(ouvrir).toHaveBeenCalledWith(expect.objectContaining({ reference: 'REF1' }));
        delete window.openEditDialog;
    });

    test('un double-clic sur la ligne ouvre aussi la modification', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        const ouvrir = jest.fn();
        window.openEditDialog = ouvrir;
        lignes()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(ouvrir).toHaveBeenCalled();
        delete window.openEditDialog;
    });
});

describe('filtres', () => {

    beforeEach(() => {
        preparer([
            ligne({ reference: 'REF1', fournisseur: 'GACD' }),
            ligne({ reference: 'REF2', fournisseur: 'Henry Schein' }),
            ligne({ reference: 'AUTRE', fournisseur: 'GACD' })
        ], [
            { reference: 'REF1', nom: 'Gant nitrile', groupe: 'Protection', ref_scannette: '111' },
            { reference: 'REF2', nom: 'Compresse', groupe: 'Soin', ref_scannette: '222' },
            { reference: 'AUTRE', nom: 'Coton', groupe: 'Soin', ref_scannette: '333' }
        ]);
        openPlacard('Cabinet 1');
    });

    test('filtre par référence', () => {
        document.getElementById('filter-ref').value = 'REF';
        filterPlacardTable();
        expect(visibles()).toHaveLength(2);
    });

    test('filtre insensible à la casse', () => {
        document.getElementById('filter-nom').value = 'gant';
        filterPlacardTable();
        expect(visibles()).toHaveLength(1);
    });

    test('filtre par groupe', () => {
        document.getElementById('filter-groupe').value = 'Soin';
        filterPlacardTable();
        expect(visibles()).toHaveLength(2);
    });

    test('filtre par fournisseur', () => {
        document.getElementById('filter-fichier').value = 'gacd';
        filterPlacardTable();
        expect(visibles()).toHaveLength(2);
    });

    test('filtre par code scannette', () => {
        document.getElementById('filter-scannette').value = '222';
        filterPlacardTable();
        expect(visibles()).toHaveLength(1);
    });

    test('les filtres se cumulent', () => {
        document.getElementById('filter-groupe').value = 'Soin';
        document.getElementById('filter-nom').value = 'coton';
        filterPlacardTable();
        expect(visibles()).toHaveLength(1);
    });

    test('aucun résultat : toutes les lignes sont masquées', () => {
        document.getElementById('filter-ref').value = 'zzzz';
        filterPlacardTable();
        expect(visibles()).toHaveLength(0);
    });

    test('vider les filtres réaffiche tout', () => {
        document.getElementById('filter-ref').value = 'REF1';
        filterPlacardTable();
        document.getElementById('filter-ref').value = '';
        filterPlacardTable();
        expect(visibles()).toHaveLength(3);
    });

    test('la ligne « aucun article » n\'est jamais filtrée', () => {
        preparer([]);
        openPlacard('Cabinet 1');
        document.getElementById('filter-ref').value = 'zzz';
        filterPlacardTable();
        expect(visibles()).toHaveLength(1);
    });
});

describe('tri par colonne', () => {

    test('refreshPlacardTable conserve l\'ordre naturel sans tri demandé', () => {
        preparer([
            ligne({ reference: 'REF2' }),
            ligne({ reference: 'REF1' })
        ], [{ reference: 'REF1', nom: 'A' }, { reference: 'REF2', nom: 'B' }]);
        openPlacard('Cabinet 1');
        expect(lignes().map(tr => cellules(tr)[2])).toEqual(['REF2', 'REF1']);
    });

    test('refreshPlacardTable peut être rappelé sans état résiduel', () => {
        preparer([ligne()]);
        openPlacard('Cabinet 1');
        refreshPlacardTable();
        refreshPlacardTable();
        expect(lignes()).toHaveLength(1);
    });
});
