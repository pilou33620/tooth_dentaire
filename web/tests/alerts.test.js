/**
 * Tests des alertes (js/features/alerts.js) et de leur boîte de dialogue
 * (js/ui/alerts-dialog.js) : stock bas, péremption, post-it « à commander ».
 */

import { jest } from '@jest/globals';
import { checkAlerts, alertsStock, alertsPeremption } from '../js/features/alerts.js';
import { showAlertsDialog } from '../js/ui/alerts-dialog.js';
import { setDbCache, loadDB } from '../js/core/database.js';

const MARKUP = `
    <button id="btn-alertes-stock" class="hidden"></button>
    <button id="btn-alertes-peremp" class="hidden"></button>
    <div id="postit-container" class="hidden">
        <div id="postit-rupture"><span class="postit-title"></span></div>
        <ul id="postit-list"></ul>
    </div>
    <div id="alerts-overlay" class="hidden">
        <h3 id="alerts-title"></h3>
        <table><tbody id="alerts-tbody"></tbody></table>
    </div>
    <input id="filter-ref"><input id="filter-nom">
    <input id="filter-groupe"><input id="filter-qte">
`;

/** Date au format JJ/MM/AAAA décalée de n jours par rapport à aujourd'hui. */
function dateDansNJours(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const pad = x => String(x).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function ligne(extra = {}) {
    return Object.assign({
        reference: 'REF1', utilisateur: 'Cabinet 1', quantite: 10,
        stock_minimum: 2, alerte_active: 0, alerte_peremption_active: 1,
        delai_peremption: 30, date_peremption: '', date_import: '',
        fournisseur: '', en_commande: 0, date_commande: '',
        lot: '', prix_unitaire_ht: 0, prix_unitaire_ttc: 0, lots_details: '[]'
    }, extra);
}

function base(stock, produits = [{ reference: 'REF1', nom: 'Gant' }]) {
    return {
        produits, stock, transactions: [], autoclave: [], historique_prix: [],
        nextTxId: 1, nextAutoId: 1
    };
}

function preparer(stock, produits) {
    document.body.innerHTML = MARKUP;
    setDbCache(base(stock, produits));
    checkAlerts();
}

describe('alertes de stock bas', () => {

    test('déclenchée quand la quantité passe au niveau du seuil', () => {
        preparer([ligne({ quantite: 2, stock_minimum: 2, alerte_active: 1 })]);
        expect(alertsStock).toHaveLength(1);
        expect(alertsStock[0].reason).toBe('Stock bas');
        expect(alertsStock[0].user).toBe('Cabinet 1');
    });

    test('déclenchée sous le seuil', () => {
        preparer([ligne({ quantite: 0, stock_minimum: 2, alerte_active: 1 })]);
        expect(alertsStock).toHaveLength(1);
    });

    test('pas d\'alerte au-dessus du seuil', () => {
        preparer([ligne({ quantite: 3, stock_minimum: 2, alerte_active: 1 })]);
        expect(alertsStock).toHaveLength(0);
    });

    test('pas d\'alerte si la surveillance est désactivée', () => {
        preparer([ligne({ quantite: 0, stock_minimum: 2, alerte_active: 0 })]);
        expect(alertsStock).toHaveLength(0);
    });

    test('une alerte par espace concerné', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1', quantite: 0, alerte_active: 1 }),
            ligne({ utilisateur: 'Cabinet 2', quantite: 0, alerte_active: 1 }),
            ligne({ utilisateur: 'Bureau', quantite: 9, alerte_active: 1 })
        ]);
        expect(alertsStock.map(a => a.user).sort()).toEqual(['Cabinet 1', 'Cabinet 2']);
    });

    test('le bouton affiche le compte et sort de l\'ombre', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1', quantite: 0, alerte_active: 1 }),
            ligne({ utilisateur: 'Cabinet 2', quantite: 0, alerte_active: 1 })
        ]);
        const btn = document.getElementById('btn-alertes-stock');
        expect(btn.classList.contains('hidden')).toBe(false);
        expect(btn.textContent).toContain('2 Alerte(s) Stock');
    });

    test('le bouton reste masqué sans alerte', () => {
        preparer([ligne({ quantite: 50, alerte_active: 1 })]);
        expect(document.getElementById('btn-alertes-stock').classList.contains('hidden'))
            .toBe(true);
    });
});

describe('alertes de péremption', () => {

    test('produit périmé', () => {
        preparer([ligne({ date_peremption: dateDansNJours(-5) })]);
        expect(alertsPeremption).toHaveLength(1);
        expect(alertsPeremption[0].reason).toContain('Périmé depuis 5 jour(s)');
    });

    test('produit périmant aujourd\'hui', () => {
        preparer([ligne({ date_peremption: dateDansNJours(0) })]);
        expect(alertsPeremption[0].reason).toContain("Périme aujourd'hui");
    });

    test('produit périmant demain', () => {
        preparer([ligne({ date_peremption: dateDansNJours(1) })]);
        expect(alertsPeremption[0].reason).toContain('Périme dans 1 jour(s)');
    });

    test('produit dans le délai de pré-alerte', () => {
        preparer([ligne({ date_peremption: dateDansNJours(10), delai_peremption: 30 })]);
        expect(alertsPeremption[0].reason).toContain('délai: 30j');
    });

    test('produit au-delà du délai de pré-alerte', () => {
        preparer([ligne({ date_peremption: dateDansNJours(60), delai_peremption: 30 })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('le délai de pré-alerte est respecté à la borne', () => {
        preparer([ligne({ date_peremption: dateDansNJours(30), delai_peremption: 30 })]);
        expect(alertsPeremption).toHaveLength(1);
        preparer([ligne({ date_peremption: dateDansNJours(31), delai_peremption: 30 })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('un délai personnalisé est pris en compte', () => {
        preparer([ligne({ date_peremption: dateDansNJours(50), delai_peremption: 60 })]);
        expect(alertsPeremption).toHaveLength(1);
    });

    test('alerte désactivée : plus de pré-alerte', () => {
        preparer([ligne({ date_peremption: dateDansNJours(10),
                          alerte_peremption_active: 0 })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('un produit déjà périmé est signalé même alerte désactivée', () => {
        preparer([ligne({ date_peremption: dateDansNJours(-1),
                          alerte_peremption_active: 0 })]);
        expect(alertsPeremption).toHaveLength(1);
    });

    test('un stock à zéro ne génère pas d\'alerte de péremption', () => {
        preparer([ligne({ quantite: 0, date_peremption: dateDansNJours(-10) })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('sans date de péremption, aucune alerte', () => {
        preparer([ligne({ date_peremption: '' })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('une date illisible est ignorée sans planter', () => {
        preparer([ligne({ date_peremption: '32/13/2026' })]);
        expect(alertsPeremption).toHaveLength(0);
    });

    test('plusieurs dates : la plus proche fait foi', () => {
        preparer([ligne({
            date_peremption: `${dateDansNJours(400)}, ${dateDansNJours(3)}`
        })]);
        expect(alertsPeremption).toHaveLength(1);
        expect(alertsPeremption[0].reason).toContain('3 jour(s)');
    });

    test('le bouton affiche le compte des péremptions', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1', date_peremption: dateDansNJours(-1) }),
            ligne({ utilisateur: 'Cabinet 2', date_peremption: dateDansNJours(2) })
        ]);
        const btn = document.getElementById('btn-alertes-peremp');
        expect(btn.classList.contains('hidden')).toBe(false);
        expect(btn.textContent).toContain('2 Alerte(s) Péremption');
    });
});

describe('post-it « à commander »', () => {

    function textesPostit() {
        return Array.from(document.querySelectorAll('#postit-list li'))
            .map(li => li.textContent.trim());
    }

    test('les ruptures sont listées avec une croix', () => {
        preparer([ligne({ quantite: 0 })]);
        expect(textesPostit()[0]).toContain('❌');
        expect(textesPostit()[0]).toContain('Gant');
    });

    test('les stocks bas surveillés sont listés avec un avertissement', () => {
        preparer([ligne({ quantite: 1, stock_minimum: 5, alerte_active: 1 })]);
        expect(textesPostit()[0]).toContain('⚠️');
    });

    test('un produit en stock et sans alerte n\'y figure pas', () => {
        preparer([ligne({ quantite: 50, alerte_active: 1, stock_minimum: 2 })]);
        expect(document.querySelector('.postit-title').textContent).toContain('Bravo');
    });

    test('un produit « ne plus commander » n\'y figure pas, même à 0, ni dans les alertes', () => {
        preparer(
            [ligne({ quantite: 0, stock_minimum: 5, alerte_active: 1 })],
            [{ reference: 'REF1', nom: 'Gant', arrete: 1 }]
        );
        expect(document.querySelector('.postit-title').textContent).toContain('Bravo');
        expect(alertsStock).toHaveLength(0);
    });

    test('le total est calculé tous espaces confondus', () => {
        preparer([
            ligne({ utilisateur: 'Cabinet 1', quantite: 0 }),
            ligne({ utilisateur: 'Cabinet 2', quantite: 5 })
        ]);
        expect(document.querySelector('.postit-title').textContent).toContain('Bravo');
    });

    test('au plus cinq lignes, puis un compteur du reste', () => {
        const produits = [];
        const stock = [];
        for (let i = 0; i < 8; i++) {
            produits.push({ reference: 'R' + i, nom: 'Produit ' + i });
            stock.push(ligne({ reference: 'R' + i, quantite: 0 }));
        }
        preparer(stock, produits);
        expect(document.querySelectorAll('#postit-list .postit-item')).toHaveLength(5);
        expect(document.querySelector('.postit-more').textContent)
            .toContain('et 3 de plus');
    });

    test('un clic sur « et N de plus » déplie toute la liste, puis la replie', () => {
        const produits = [];
        const stock = [];
        for (let i = 0; i < 8; i++) {
            produits.push({ reference: 'R' + i, nom: 'Produit ' + i });
            stock.push(ligne({ reference: 'R' + i, quantite: 0 }));
        }
        preparer(stock, produits);

        document.querySelector('.postit-more').click();
        expect(document.querySelectorAll('#postit-list .postit-item')).toHaveLength(8);
        const reduire = document.querySelector('.postit-more');
        expect(reduire.textContent).toContain('Réduire');
        expect(reduire.getAttribute('aria-expanded')).toBe('true');

        reduire.click();
        expect(document.querySelectorAll('#postit-list .postit-item')).toHaveLength(5);
        expect(document.querySelector('.postit-more').textContent).toContain('et 3 de plus');
    });

    test('sans dépassement, pas de compteur du reste', () => {
        preparer([ligne({ quantite: 0 })]);
        expect(document.querySelector('.postit-more')).toBeNull();
    });

    test('une ligne déjà commandée affiche sa date et coche la case', () => {
        preparer([ligne({ quantite: 0, en_commande: 1, date_commande: '01/03/2026' })]);
        expect(textesPostit()[0]).toContain('Commandé le 01/03/2026');
        expect(document.querySelector('#postit-list input[type=checkbox]').checked)
            .toBe(true);
    });

    test('cocher la case marque la référence comme commandée', () => {
        preparer([ligne({ quantite: 0 })]);
        const caseACocher = document.querySelector('#postit-list input[type=checkbox]');
        caseACocher.checked = true;
        caseACocher.dispatchEvent(new Event('change'));

        const s = loadDB().stock.find(x => x.reference === 'REF1');
        expect(s.en_commande).toBe(1);
        expect(s.date_commande).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });

    test('décocher la case annule la commande', () => {
        preparer([ligne({ quantite: 0, en_commande: 1, date_commande: '01/03/2026' })]);
        const caseACocher = document.querySelector('#postit-list input[type=checkbox]');
        caseACocher.checked = false;
        caseACocher.dispatchEvent(new Event('change'));

        const s = loadDB().stock.find(x => x.reference === 'REF1');
        expect(s.en_commande).toBe(0);
        expect(s.date_commande).toBe('');
    });

    test('markReferencesAsOrdered marque plusieurs références d\'un coup', () => {
        preparer([
            ligne({ reference: 'R1', quantite: 0 }),
            ligne({ reference: 'R2', quantite: 0 }),
            ligne({ reference: 'R3', quantite: 0 })
        ], [{ reference: 'R1' }, { reference: 'R2' }, { reference: 'R3' }]);

        window.markReferencesAsOrdered(['R1', 'R3']);
        const parRef = Object.fromEntries(
            loadDB().stock.map(s => [s.reference, s.en_commande]));
        expect(parRef).toEqual({ R1: 1, R2: 0, R3: 1 });
    });

    test('cliquer sur une ligne ouvre le placard filtré sur la référence', () => {
        preparer([ligne({ quantite: 0 })]);
        const ouvrir = jest.fn();
        const filtrer = jest.fn();
        window.openPlacard = ouvrir;
        window.filterPlacardTable = filtrer;

        document.querySelector('#postit-list .postit-item span').click();
        expect(ouvrir).toHaveBeenCalledWith('TOUS');
        expect(document.getElementById('filter-ref').value).toBe('REF1');
        expect(filtrer).toHaveBeenCalled();

        delete window.openPlacard;
        delete window.filterPlacardTable;
    });

    test('le nom du produit est inséré comme texte, jamais comme HTML', () => {
        preparer([ligne({ quantite: 0 })],
                 [{ reference: 'REF1', nom: '<img src=x onerror=alert(1)>' }]);
        expect(document.querySelector('#postit-list img')).toBeNull();
        expect(textesPostit()[0]).toContain('<img src=x onerror=alert(1)>');
    });

    test('la référence sert de libellé quand le produit n\'a pas de nom', () => {
        preparer([ligne({ quantite: 0 })], [{ reference: 'REF1', nom: '' }]);
        expect(textesPostit()[0]).toContain('REF1');
    });
});

describe('boîte de dialogue des alertes', () => {

    const ALERTES = [
        { user: 'Cabinet 1', reason: 'Stock bas',
          data: { reference: 'R1', nom: 'Gant', quantite: 0 } },
        { user: 'Cabinet 2', reason: 'Périmé depuis 3 jour(s)',
          data: { reference: 'R2', nom: 'Compresse', quantite: 5 } }
    ];

    beforeEach(() => { document.body.innerHTML = MARKUP; });

    test('une ligne numérotée par alerte', () => {
        showAlertsDialog('Alertes Stock', ALERTES);
        const lignes = document.querySelectorAll('#alerts-tbody tr');
        expect(lignes).toHaveLength(2);
        expect(lignes[0].querySelector('.rownum').textContent).toBe('1');
        expect(lignes[1].querySelector('.rownum').textContent).toBe('2');
    });

    test('le titre et les colonnes reprennent les données de l\'alerte', () => {
        showAlertsDialog('Alertes Stock', ALERTES);
        expect(document.getElementById('alerts-title').textContent).toBe('Alertes Stock');
        const cellules = Array.from(document.querySelectorAll('#alerts-tbody tr:first-child td'))
            .map(td => td.textContent.trim());
        expect(cellules.slice(0, 5))
            .toEqual(['1', 'Cabinet 1', 'R1', 'Gant', 'Stock bas']);
    });

    test('la boîte devient visible', () => {
        showAlertsDialog('Alertes', ALERTES);
        expect(document.getElementById('alerts-overlay').classList.contains('hidden'))
            .toBe(false);
    });

    test('liste vide : tableau vide, boîte tout de même ouverte', () => {
        showAlertsDialog('Alertes', []);
        expect(document.querySelectorAll('#alerts-tbody tr')).toHaveLength(0);
        expect(document.getElementById('alerts-overlay').classList.contains('hidden'))
            .toBe(false);
    });

    test('le bouton « Aller » ferme la boîte et ouvre le bon placard', () => {
        const ouvrir = jest.fn();
        window.openPlacard = ouvrir;
        showAlertsDialog('Alertes', ALERTES);
        document.querySelectorAll('#alerts-tbody tr')[1].querySelector('button').click();

        expect(document.getElementById('alerts-overlay').classList.contains('hidden'))
            .toBe(true);
        expect(ouvrir).toHaveBeenCalledWith('Cabinet 2', 'R2');
        delete window.openPlacard;
    });

    test('le contenu est inséré en texte, jamais en HTML', () => {
        showAlertsDialog('Alertes', [{
            user: 'Cabinet 1', reason: '<b>bold</b>',
            data: { reference: '<img src=x>', nom: '<script>a</script>', quantite: 1 }
        }]);
        const tbody = document.getElementById('alerts-tbody');
        expect(tbody.querySelector('img')).toBeNull();
        expect(tbody.querySelector('script')).toBeNull();
        expect(tbody.textContent).toContain('<img src=x>');
    });

    test('un appel remplace le contenu précédent', () => {
        showAlertsDialog('Alertes', ALERTES);
        showAlertsDialog('Alertes', [ALERTES[0]]);
        expect(document.querySelectorAll('#alerts-tbody tr')).toHaveLength(1);
    });
});
