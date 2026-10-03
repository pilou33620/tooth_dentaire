/**
 * Tests des équipements : cycles machines et journal de maintenance
 * (js/machines/machines.js, js/machines/maintenance-data.js).
 */

import { jest } from '@jest/globals';
import {
    setupMachine, openMaintenanceDialog, refreshMaintenanceTable, addMaintenanceEntry
} from '../js/machines/machines.js';
import {
    addAutoclaveMaintenance, getAutoclaveMaintenance
} from '../js/machines/maintenance-data.js';
import { setDbCache, loadDB } from '../js/core/database.js';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const MARKUP = `
    <div class="autoclave machine" data-machine="Autoclave Lisa" data-type="autoclave">
        <div class="autoclave-title">Autoclave Lisa</div>
        <div class="autoclave-status">Prêt</div>
        <button class="autoclave-start">Démarrer</button>
    </div>
    <div class="autoclave machine" data-machine="Radio Panoramique" data-type="radio">
        <div class="autoclave-title">Radio</div>
        <div class="autoclave-status">Prêt</div>
        <button class="autoclave-start">Démarrer</button>
    </div>
    <div class="autoclave machine machine-trousse" data-machine="Trousse">
        <div class="autoclave-title">Trousse</div>
        <div class="autoclave-status">Prêt</div>
        <button class="autoclave-start">Démarrer</button>
    </div>
    <div id="maintenance-overlay" class="hidden">
        <select id="maint-machine">
            <option value="Autoclave Lisa">Autoclave Lisa</option>
            <option value="Autoclave Euronda">Autoclave Euronda</option>
        </select>
        <input id="maint-date" type="date">
        <input id="maint-user">
        <input id="maint-comment">
        <table><tbody id="maintenance-tbody"></tbody></table>
    </div>
    <div id="msg-overlay" class="hidden">
        <h3 id="msg-title"></h3><div id="msg-text"></div>
        <button id="msg-ok"></button>
    </div>
`;

function baseAvecJournal(autoclave = []) {
    return {
        produits: [], stock: [], transactions: [], autoclave,
        historique_prix: [], nextTxId: 1,
        nextAutoId: autoclave.length ? Math.max(...autoclave.map(a => a.id)) + 1 : 1
    };
}

function preparer(autoclave = []) {
    document.body.innerHTML = MARKUP;
    setDbCache(baseAvecJournal(autoclave));
}

function machine(selecteur) {
    return document.querySelector(selecteur);
}

describe('cycles machines', () => {

    beforeEach(() => {
        preparer();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('le bouton passe en « En cours... » au démarrage', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        const btn = frame.querySelector('.autoclave-start');
        btn.click();
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('En cours...');
    });

    test('le statut suit les phases du cycle', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        frame.querySelector('.autoclave-start').click();

        jest.advanceTimersByTime(800);
        expect(frame.querySelector('.autoclave-status').textContent).toContain('Chauffe');

        jest.advanceTimersByTime(800 * 9);
        expect(frame.querySelector('.autoclave-status').textContent)
            .toContain('Stérilisation');

        jest.advanceTimersByTime(800 * 8);
        expect(frame.querySelector('.autoclave-status').textContent).toContain('Séchage');
    });

    test('la classe de phase change et reste unique', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        frame.querySelector('.autoclave-start').click();
        jest.advanceTimersByTime(800);
        expect(frame.classList.contains('autoclave-heat')).toBe(true);

        jest.advanceTimersByTime(800 * 9);
        expect(frame.classList.contains('autoclave-heat')).toBe(false);
        expect(frame.className).toMatch(/autoclave-steril-[ab]/);
    });

    test('le cycle se termine et le bouton se rouvre', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        const btn = frame.querySelector('.autoclave-start');
        btn.click();
        jest.advanceTimersByTime(800 * 30);

        expect(frame.querySelector('.autoclave-status').textContent).toBe('🟢 Terminé');
        expect(frame.classList.contains('autoclave-done')).toBe(true);
        expect(btn.disabled).toBe(false);
        expect(btn.textContent).toBe('Nouveau Cycle');
    });

    test('un second clic pendant le cycle est sans effet', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        const btn = frame.querySelector('.autoclave-start');
        btn.click();
        jest.advanceTimersByTime(800 * 4);
        const etape = frame.querySelector('.autoclave-status').textContent;
        btn.click();
        jest.advanceTimersByTime(0);
        expect(frame.querySelector('.autoclave-status').textContent).toBe(etape);
    });

    test('chaque machine a son propre cycle', () => {
        const autoclave = machine('[data-type="autoclave"]');
        const radio = machine('[data-type="radio"]');
        setupMachine(autoclave);
        setupMachine(radio);

        autoclave.querySelector('.autoclave-start').click();
        jest.advanceTimersByTime(800 * 3);
        expect(radio.querySelector('.autoclave-status').textContent).toBe('Prêt');
        expect(radio.querySelector('.autoclave-start').disabled).toBe(false);
    });

    test('le cycle radio a ses propres libellés', () => {
        const radio = machine('[data-type="radio"]');
        setupMachine(radio);
        radio.querySelector('.autoclave-start').click();
        jest.advanceTimersByTime(800);
        expect(radio.querySelector('.autoclave-status').textContent)
            .toContain('Positionnement');
        jest.advanceTimersByTime(800 * 30);
        expect(radio.querySelector('.autoclave-status').textContent).toBe('🟢 Cliché prêt');
    });

    test('démarrer une radio déclenche le contrôle Mire', () => {
        const checkMire = jest.fn();
        window.checkMireAlert = checkMire;
        const radio = machine('[data-type="radio"]');
        setupMachine(radio);
        radio.querySelector('.autoclave-start').click();
        expect(checkMire).toHaveBeenCalled();
        delete window.checkMireAlert;
    });

    test('la panoramique déclenche aussi le contrôle dosimètres', () => {
        const checkDosi = jest.fn();
        window.checkMireAlert = jest.fn();
        window.checkDosiAlert = checkDosi;
        const radio = machine('[data-machine="Radio Panoramique"]');
        setupMachine(radio);
        radio.querySelector('.autoclave-start').click();
        expect(checkDosi).toHaveBeenCalled();
        delete window.checkMireAlert;
        delete window.checkDosiAlert;
    });

    test('les pseudo-machines (trousse, MEOPA) sont ignorées', () => {
        const trousse = machine('.machine-trousse');
        setupMachine(trousse);
        trousse.querySelector('.autoclave-start').click();
        jest.advanceTimersByTime(800 * 5);
        expect(trousse.querySelector('.autoclave-status').textContent).toBe('Prêt');
    });

    test('un clic sur le titre ouvre le journal de maintenance de la machine', () => {
        const frame = machine('[data-type="autoclave"]');
        setupMachine(frame);
        frame.querySelector('.autoclave-title').click();
        expect(document.getElementById('maintenance-overlay').classList.contains('hidden'))
            .toBe(false);
        expect(document.getElementById('maint-machine').value).toBe('Autoclave Lisa');
    });
});

describe('journal de maintenance', () => {

    const JOURNAL = [
        { id: 1, date: '01/03/2026', machine: 'Autoclave Lisa',
          utilisateur: 'Personne A', commentaire: 'Filtre changé' },
        { id: 2, date: '05/03/2026', machine: 'Autoclave Euronda',
          utilisateur: 'Personne B', commentaire: 'Cycle test' },
        { id: 3, date: '03/03/2026', machine: 'Autoclave Lisa',
          utilisateur: 'Personne C', commentaire: 'Nettoyage cuve' }
    ];

    test('le tableau liste toutes les entrées sans filtre', () => {
        preparer(JOURNAL);
        refreshMaintenanceTable();
        expect(document.querySelectorAll('#maintenance-tbody tr')).toHaveLength(3);
    });

    test('le filtre par machine ne garde que ses entrées', () => {
        preparer(JOURNAL);
        refreshMaintenanceTable('Autoclave Lisa');
        const lignes = document.querySelectorAll('#maintenance-tbody tr');
        expect(lignes).toHaveLength(2);
        for (const tr of lignes) {
            expect(tr.cells[2].textContent).toBe('Autoclave Lisa');
        }
    });

    test('une entrée sans machine reste visible quel que soit le filtre', () => {
        preparer([{ id: 1, date: '01/03/2026', machine: '',
                    utilisateur: 'Personne A', commentaire: 'Ancienne entrée' }]);
        refreshMaintenanceTable('Autoclave Lisa');
        const lignes = document.querySelectorAll('#maintenance-tbody tr');
        expect(lignes).toHaveLength(1);
        expect(lignes[0].cells[2].textContent).toBe('—');
    });

    test('les lignes sont numérotées après filtrage', () => {
        preparer(JOURNAL);
        refreshMaintenanceTable('Autoclave Lisa');
        const nums = Array.from(document.querySelectorAll('#maintenance-tbody .rownum'))
            .map(td => td.textContent);
        expect(nums).toEqual(['1', '2']);
    });

    test('journal vide : tableau vide', () => {
        preparer([]);
        refreshMaintenanceTable();
        expect(document.querySelectorAll('#maintenance-tbody tr')).toHaveLength(0);
    });

    test('le contenu est inséré comme texte, jamais comme HTML', () => {
        preparer([{ id: 1, date: '01/03/2026', machine: 'M',
                    utilisateur: 'X', commentaire: '<img src=x onerror=alert(1)>' }]);
        refreshMaintenanceTable();
        expect(document.querySelector('#maintenance-tbody img')).toBeNull();
    });

    test('ouvrir le journal préremplit la date du jour', () => {
        preparer(JOURNAL);
        openMaintenanceDialog('Autoclave Euronda');
        const saisie = document.getElementById('maint-date').value;
        const aujourdhui = new Date().toISOString().slice(0, 10);
        expect(saisie).toBe(aujourdhui);
    });

    test('ouvrir le journal filtre sur la machine demandée', () => {
        preparer(JOURNAL);
        openMaintenanceDialog('Autoclave Euronda');
        expect(document.querySelectorAll('#maintenance-tbody tr')).toHaveLength(1);
    });

    test('changer de machine dans la liste rafraîchit le tableau', () => {
        preparer(JOURNAL);
        document.dispatchEvent(new Event('DOMContentLoaded'));
        const select = document.getElementById('maint-machine');
        select.value = 'Autoclave Lisa';
        select.dispatchEvent(new Event('change'));
        expect(document.querySelectorAll('#maintenance-tbody tr')).toHaveLength(2);
    });
});

describe('ajout d\'une entrée de maintenance', () => {

    beforeEach(() => preparer([]));

    async function remplirEtValider({ user = 'Personne A', comment = 'Filtre changé',
                                      date = '2026-03-09',
                                      machineSel = 'Autoclave Lisa' } = {}) {
        document.getElementById('maint-user').value = user;
        document.getElementById('maint-comment').value = comment;
        document.getElementById('maint-date').value = date;
        document.getElementById('maint-machine').value = machineSel;
        await addMaintenanceEntry();
    }

    test('l\'entrée est ajoutée avec la date au format JJ/MM/AAAA', async () => {
        await remplirEtValider();
        const journal = loadDB().autoclave;
        expect(journal).toHaveLength(1);
        expect(journal[0]).toMatchObject({
            date: '09/03/2026', machine: 'Autoclave Lisa',
            utilisateur: 'Personne A', commentaire: 'Filtre changé'
        });
    });

    test('le champ commentaire est vidé après ajout', async () => {
        await remplirEtValider();
        expect(document.getElementById('maint-comment').value).toBe('');
    });

    test('le tableau est rafraîchi après ajout', async () => {
        await remplirEtValider();
        expect(document.querySelectorAll('#maintenance-tbody tr')).toHaveLength(1);
    });

    test('sans nom, rien n\'est enregistré', async () => {
        const promesse = remplirEtValider({ user: '   ' });
        document.getElementById('msg-ok').click();
        await promesse;
        expect(loadDB().autoclave).toHaveLength(0);
        expect(document.getElementById('msg-text').textContent).toContain('nom');
    });

    test('sans commentaire, rien n\'est enregistré', async () => {
        const promesse = remplirEtValider({ comment: '' });
        document.getElementById('msg-ok').click();
        await promesse;
        expect(loadDB().autoclave).toHaveLength(0);
        expect(document.getElementById('msg-text').textContent).toContain('commentaire');
    });

    test('une date illisible retombe sur la date du jour', async () => {
        await remplirEtValider({ date: '' });
        expect(loadDB().autoclave[0].date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });

    test('les identifiants sont incrémentés', async () => {
        await remplirEtValider({ comment: 'Un' });
        await remplirEtValider({ comment: 'Deux' });
        expect(loadDB().autoclave.map(a => a.id)).toEqual([1, 2]);
    });

    test('l\'entrée est envoyée au serveur', async () => {
        const serveur = installerServeurFactice();
        await remplirEtValider({ comment: 'Filtre changé' });
        await attendreEcritures();
        const appels = appelsVers(serveur, 'POST', '/api/maintenance');
        expect(appels).toHaveLength(1);
        expect(appels[0].corps.commentaire).toBe('Filtre changé');
    });
});

describe('maintenance-data : tri du journal', () => {

    test('les entrées sont rendues de la plus récente à la plus ancienne', () => {
        preparer([
            { id: 1, date: '01/03/2026', machine: 'M', utilisateur: 'A', commentaire: '1' },
            { id: 2, date: '15/03/2026', machine: 'M', utilisateur: 'B', commentaire: '2' },
            { id: 3, date: '05/02/2026', machine: 'M', utilisateur: 'C', commentaire: '3' }
        ]);
        expect(getAutoclaveMaintenance().map(a => a.date))
            .toEqual(['15/03/2026', '01/03/2026', '05/02/2026']);
    });

    test('le tri respecte les changements d\'année', () => {
        preparer([
            { id: 1, date: '31/12/2025', machine: 'M', utilisateur: 'A', commentaire: '' },
            { id: 2, date: '01/01/2026', machine: 'M', utilisateur: 'B', commentaire: '' }
        ]);
        expect(getAutoclaveMaintenance()[0].date).toBe('01/01/2026');
    });

    test('à date égale, le plus grand identifiant passe en premier', () => {
        preparer([
            { id: 1, date: '01/03/2026', machine: 'M', utilisateur: 'A', commentaire: '' },
            { id: 2, date: '01/03/2026', machine: 'M', utilisateur: 'B', commentaire: '' }
        ]);
        expect(getAutoclaveMaintenance().map(a => a.id)).toEqual([2, 1]);
    });

    test('une date mal formée ne fait pas planter le tri', () => {
        preparer([
            { id: 1, date: 'inconnue', machine: 'M', utilisateur: 'A', commentaire: '' },
            { id: 2, date: '01/03/2026', machine: 'M', utilisateur: 'B', commentaire: '' }
        ]);
        const journal = getAutoclaveMaintenance();
        expect(journal).toHaveLength(2);
        // Faute de clé AAAA-MM-JJ, la valeur brute est comparée telle quelle :
        // « inconnue » passe donc devant les dates valides. Comportement admis
        // tant qu'aucune date non conforme n'est saisissable depuis l'interface.
        expect(journal[0].date).toBe('inconnue');
    });

    test('le tri ne modifie pas la base', () => {
        preparer([
            { id: 1, date: '01/03/2026', machine: 'M', utilisateur: 'A', commentaire: '' },
            { id: 2, date: '15/03/2026', machine: 'M', utilisateur: 'B', commentaire: '' }
        ]);
        getAutoclaveMaintenance();
        expect(loadDB().autoclave.map(a => a.id)).toEqual([1, 2]);
    });

    test('addAutoclaveMaintenance ajoute et incrémente le compteur', () => {
        preparer([]);
        addAutoclaveMaintenance('09/03/2026', 'Personne A', 'RAS', 'Autoclave Lisa');
        const db = loadDB();
        expect(db.autoclave).toHaveLength(1);
        expect(db.autoclave[0].id).toBe(1);
        expect(db.nextAutoId).toBe(2);
    });

    test('la machine est facultative', () => {
        preparer([]);
        addAutoclaveMaintenance('09/03/2026', 'Personne A', 'RAS');
        expect(loadDB().autoclave[0].machine).toBe('');
    });
});
