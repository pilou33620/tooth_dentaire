/**
 * Tests de non-régression nécessitant le DOM (jsdom).
 * Chaque describe porte le numéro du bug de l'audit.
 */

import { jest } from '@jest/globals';

describe("Bug #1 - changer de conditionnement ne doit pas perdre de stock", () => {
    let toggleCondFields;

    beforeEach(async () => {
        document.body.innerHTML = `
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
        `;
        jest.resetModules();
        await import('../js/core/constants.js');
        // product-edit.js pose window.toggleCondFields à l'import
        const mod = await import('../js/features/product-edit.js');
        toggleCondFields = window.toggleCondFields;
        expect(typeof toggleCondFields).toBe('function');
        return mod;
    });

    /** Simule l'état du dialogue tel que le prépare openEditDialog(). */
    function etatDialogue(type, parContenant, nbContenants, vrac) {
        const sel = document.getElementById("edit-type-stockage");
        sel.value = type;
        sel.dataset.previousType = type;
        document.getElementById("edit-qte-par-contenant").value = String(parContenant);
        document.getElementById("edit-nb-contenants").value = String(nbContenants);
        document.getElementById("edit-qte").value = String(vrac);
    }

    /** Reproduit le calcul de saveEditDialog(). */
    function totalEnregistre() {
        const type = document.getElementById("edit-type-stockage").value;
        const vrac = parseInt(document.getElementById("edit-qte").value, 10) || 0;
        if (type === "carton" || type === "boite") {
            const parContenant = parseInt(document.getElementById("edit-qte-par-contenant").value, 10) || 1;
            const nb = parseInt(document.getElementById("edit-nb-contenants").value, 10) || 0;
            return nb * parContenant + vrac;
        }
        return vrac;
    }

    function changerType(nouveauType) {
        document.getElementById("edit-type-stockage").value = nouveauType;
        toggleCondFields();
    }

    test("carton -> unité conserve le total (12 cartons de 10 + 3 = 123)", () => {
        etatDialogue("carton", 10, 12, 3);
        changerType("unite");
        expect(totalEnregistre()).toBe(123);
        expect(document.getElementById("edit-qte").value).toBe("123");
        expect(document.getElementById("edit-nb-contenants").value).toBe("0");
    });

    test("unité -> carton conserve le total (123 = 12 cartons de 10 + 3)", () => {
        etatDialogue("unite", 10, 0, 123);
        changerType("carton");
        expect(totalEnregistre()).toBe(123);
        expect(document.getElementById("edit-nb-contenants").value).toBe("12");
        expect(document.getElementById("edit-qte").value).toBe("3");
    });

    test("carton -> boîte conserve le total", () => {
        etatDialogue("carton", 10, 12, 3);
        changerType("boite");
        expect(totalEnregistre()).toBe(123);
    });

    test("aller-retour carton -> unité -> carton est neutre", () => {
        etatDialogue("carton", 12, 5, 7); // 67 unités
        changerType("unite");
        changerType("carton");
        expect(totalEnregistre()).toBe(67);
    });

    test("ouvrir le dialogue (previousType déjà aligné) ne reventile rien", () => {
        etatDialogue("carton", 10, 12, 3);
        toggleCondFields(); // appel fait par openEditDialog
        expect(document.getElementById("edit-nb-contenants").value).toBe("12");
        expect(document.getElementById("edit-qte").value).toBe("3");
        expect(totalEnregistre()).toBe(123);
    });

    test("les champs de contenant sont masqués à l'unité, visibles en carton", () => {
        etatDialogue("carton", 10, 1, 0);
        toggleCondFields();
        expect(document.getElementById("cond-fields").classList.contains("hidden")).toBe(false);
        changerType("unite");
        expect(document.getElementById("cond-fields").classList.contains("hidden")).toBe(true);
    });
});

describe("Bug #4 - le post-it ne doit afficher que MAX_POSTIT lignes", () => {
    const MAX_POSTIT = 5;

    beforeEach(async () => {
        document.body.innerHTML = `
            <button id="btn-alertes-stock"></button>
            <button id="btn-alertes-peremp"></button>
            <div id="postit-container">
                <div id="postit-rupture"><span class="postit-title"></span></div>
            </div>
            <ul id="postit-list"></ul>
        `;
        jest.resetModules();
        const dbmod = await import('../js/core/database.js');
        const { checkAlerts } = await import('../js/features/alerts.js');

        // 12 références toutes en rupture (quantité 0)
        const refs = Array.from({ length: 12 }, (_, i) => `REF${String(i).padStart(3, '0')}`);
        dbmod.setDbCache({
            produits: refs.map(r => ({ reference: r, nom: `Produit ${r}`, groupe: '', ref_scannette: '' })),
            stock: refs.map(r => ({
                reference: r, utilisateur: 'Commun', quantite: 0, stock_minimum: 1,
                alerte_active: 1, date_peremption: '', lots_details: '[]'
            })),
            transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1
        });
        checkAlerts();
    });

    test("seules les 5 premières ruptures sont rendues (+ la ligne « et N de plus »)", () => {
        const items = document.querySelectorAll('#postit-list .postit-item');
        expect(items).toHaveLength(MAX_POSTIT);
    });

    test("la ligne de débordement annonce le bon reste", () => {
        const more = document.querySelector('#postit-list .postit-more');
        expect(more).not.toBeNull();
        expect(more.textContent).toContain('7'); // 12 - 5
    });

    test("le nombre total de <li> reste borné", () => {
        expect(document.querySelectorAll('#postit-list li')).toHaveLength(MAX_POSTIT + 1);
    });
});

describe("Bug #6 - un Enter tardif de la douchette ne doit pas perdre le scan", () => {
    let dateNow;
    let temps;

    beforeEach(async () => {
        document.body.innerHTML = `
            <div id="placard-overlay"></div>
            <input id="filter-ref">
        `;
        temps = 1000;
        dateNow = jest.spyOn(Date, 'now').mockImplementation(() => temps);

        window.filterPlacardTable = jest.fn();
        jest.resetModules();
        const dbmod = await import('../js/core/database.js');
        dbmod.setDbCache({
            produits: [{ reference: 'REF001', nom: 'P', groupe: '', ref_scannette: '3401234567890' }],
            stock: [], transactions: [], autoclave: [], historique_prix: [], nextTxId: 1, nextAutoId: 1
        });
        await import('../js/features/barcode-scanner.js');
    });

    afterEach(() => {
        dateNow.mockRestore();
        delete window.filterPlacardTable;
    });

    /** Tape `code` puis Enter, avec `delaiEnter` ms avant la touche Enter. */
    function scanner(code, delaiEnter) {
        for (const c of code) {
            temps += 20; // cadence d'une douchette
            document.dispatchEvent(new KeyboardEvent('keydown', { key: c, bubbles: true }));
        }
        temps += delaiEnter;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    test("un Enter à 250 ms est bien traité (le scan n'est plus perdu)", () => {
        scanner('3401234567890', 250);
        expect(window.filterPlacardTable).toHaveBeenCalled();
        expect(document.getElementById('filter-ref').value).toBe('REF001');
    });

    test("un Enter immédiat est traité (comportement d'origine préservé)", () => {
        scanner('3401234567890', 20);
        expect(window.filterPlacardTable).toHaveBeenCalled();
    });

    test("une frappe humaine lente ne s'accumule pas dans le buffer", () => {
        // Deux caractères espacés de plus de 100 ms : seul le dernier subsiste
        temps += 500;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        temps += 500;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
        temps += 50;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(document.getElementById('filter-ref').value).toBe('b');
    });

    test("un Enter sans rien avant ne déclenche aucune recherche", () => {
        temps += 50;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(window.filterPlacardTable).not.toHaveBeenCalled();
    });
});
