/**
 * Tests du suivi des contrôles Mire (js/machines/mire-alert.js).
 *
 * Le module garde de l'état interne (mise en veille, machine courante) : chaque
 * bloc le réimporte à neuf après jest.resetModules().
 */

import { jest } from '@jest/globals';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const JOUR = 24 * 60 * 60 * 1000;
let serveur;

/** Recharge le module avec un serveur factice (échéances en base). */
async function chargerModule(documents = {}) {
    jest.resetModules();
    serveur = installerServeurFactice({ documents });
    const api = await import('../js/core/api.js');
    await api.chargerEtat();
    return import('../js/machines/mire-alert.js');
}

describe('MIRE_RADIOS / getMireConfig', () => {
    let mire;
    beforeEach(async () => { mire = await chargerModule(); });

    test('les cinq radios sont déclarées', () => {
        expect(mire.MIRE_RADIOS).toHaveLength(5);
        expect(mire.MIRE_RADIOS.map(r => r.machine)).toContain('Radio Panoramique');
    });

    test('la panoramique se contrôle tous les 6 mois, les cabinets tous les mois', () => {
        expect(mire.getMireConfig('Radio Panoramique').defaultDays).toBe(180);
        expect(mire.getMireConfig('Radio Cabinet 1').defaultDays).toBe(30);
    });

    test('la configuration se retrouve par machine, par cabinet ou par libellé', () => {
        expect(mire.getMireConfig('Radio Cabinet 4').cabinet).toBe('Cabinet 4');
        expect(mire.getMireConfig('Cabinet 4').machine).toBe('Radio Cabinet 4');
        expect(mire.getMireConfig('Radio Panoramique').cabinet)
            .toBe('Zone panoramique (Pano)');
    });

    test('une machine inconnue reçoit une configuration par défaut à 30 jours', () => {
        const cfg = mire.getMireConfig('Radio Cabinet 9');
        expect(cfg).toMatchObject({
            machine: 'Radio Cabinet 9', cabinet: 'Radio Cabinet 9', defaultDays: 30
        });
    });
});

describe('formatage et lecture des dates', () => {
    let mire;
    beforeEach(async () => { mire = await chargerModule(); });

    test('formatDateFR produit du JJ/MM/AAAA', () => {
        const t = new Date(2026, 2, 9, 12).getTime();
        expect(mire.formatDateFR(t)).toBe('09/03/2026');
    });

    test('formatDateFR complète les chiffres seuls', () => {
        expect(mire.formatDateFR(new Date(2026, 0, 5, 12).getTime())).toBe('05/01/2026');
    });

    test('formatDateFR sans date exploitable', () => {
        for (const val of [null, undefined, 0, '', NaN]) {
            expect(mire.formatDateFR(val)).toBe('Non définie');
        }
    });

    test('formatDateInput produit du AAAA-MM-JJ pour un <input type=date>', () => {
        expect(mire.formatDateInput(new Date(2026, 11, 31, 12).getTime()))
            .toBe('2026-12-31');
    });

    test('formatDateInput sans date renvoie une chaîne vide', () => {
        expect(mire.formatDateInput(null)).toBe('');
        expect(mire.formatDateInput(0)).toBe('');
    });

    test('parseDateInput relit une saisie de <input type=date> à midi', () => {
        const t = mire.parseDateInput('2026-03-09');
        const d = new Date(t);
        expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()])
            .toEqual([2026, 2, 9, 12]);
    });

    test('parseDateInput refuse une saisie mal formée', () => {
        for (const val of ['', null, '09/03/2026', '2026-03', 'abc']) {
            expect(mire.parseDateInput(val)).toBeNull();
        }
    });

    test('aller-retour formatDateInput -> parseDateInput', () => {
        const depart = new Date(2027, 6, 14, 12).getTime();
        expect(mire.parseDateInput(mire.formatDateInput(depart))).toBe(depart);
    });
});

describe('stockage en base', () => {
    let mire;
    beforeEach(async () => { mire = await chargerModule(); });

    test('aucune donnée : échéance nulle et intervalle par défaut', () => {
        expect(mire.getMireDataForMachine('Radio Cabinet 1'))
            .toMatchObject({ nextTime: null, intervalDays: 30 });
        expect(mire.getMireDataForMachine('Radio Panoramique').intervalDays).toBe(180);
    });

    test('sauvegarde puis relecture', () => {
        const echeance = Date.now() + 10 * JOUR;
        mire.saveMireDataForMachine('Radio Cabinet 2', echeance, 45);
        const data = mire.getMireDataForMachine('Radio Cabinet 2');
        expect(data.nextTime).toBe(echeance);
        expect(data.intervalDays).toBe(45);
        expect(typeof data.lastDone).toBe('number');
    });

    test("l'intervalle déjà enregistré est conservé si on ne le repasse pas", () => {
        mire.saveMireDataForMachine('Radio Cabinet 2', Date.now(), 45);
        mire.saveMireDataForMachine('Radio Cabinet 2', Date.now() + JOUR);
        expect(mire.getMireDataForMachine('Radio Cabinet 2').intervalDays).toBe(45);
    });

    test('les machines sont indépendantes les unes des autres', () => {
        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() + JOUR, 30);
        expect(mire.getMireDataForMachine('Radio Cabinet 2').nextTime).toBeNull();
    });

    test('un document invalide ne fait pas planter la lecture', async () => {
        const m = await chargerModule({ rappels_mire: 'cassé' });
        expect(m.getAllMireData()).toEqual({});
    });

    test('les échéances enregistrées en base sont relues', async () => {
        const t = Date.now() + 3 * JOUR;
        const m = await chargerModule({
            rappels_mire: { 'Radio Cabinet 5': { nextTime: t, lastDone: null, intervalDays: 30 } }
        });
        expect(m.getMireDataForMachine('Radio Cabinet 5').nextTime).toBe(t);
    });

    test('une échéance enregistrée est envoyée au serveur', async () => {
        const t = Date.now() + 180 * JOUR;
        mire.saveMireDataForMachine('Radio Panoramique', t, 180);
        await attendreEcritures();
        const envoi = appelsVers(serveur, 'PUT', '/api/documents/rappels_mire');
        expect(envoi).toHaveLength(1);
        expect(envoi[0].corps['Radio Panoramique'].nextTime).toBe(t);
    });
});

describe('getMireStatus', () => {
    let mire;
    beforeEach(async () => { mire = await chargerModule(); });

    test('sans échéance, le contrôle est dû', () => {
        expect(mire.getMireStatus('Radio Cabinet 1').isDue).toBe(true);
    });

    test('échéance future : pas dû', () => {
        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() + JOUR, 30);
        const s = mire.getMireStatus('Radio Cabinet 1');
        expect(s.isDue).toBe(false);
        expect(s.dateStr).not.toBe('Non définie');
    });

    test('échéance passée : dû', () => {
        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() - JOUR, 30);
        expect(mire.getMireStatus('Radio Cabinet 1').isDue).toBe(true);
    });

    test('le jour même de l\'échéance, le contrôle est dû', () => {
        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() - 1, 30);
        expect(mire.getMireStatus('Radio Cabinet 1').isDue).toBe(true);
    });
});

describe('checkMireAlert et affichage', () => {
    let mire;

    beforeEach(async () => {
        document.body.innerHTML = `
            <div id="mire-alerts-container" class="hidden"></div>
            <button id="btn-alertes-mire" class="hidden"></button>
            <div id="mire-overlay" class="hidden">
                <div id="mire-dialog-headline"></div>
                <div id="mire-cabinet-display"></div>
            </div>
            <button class="btn-mire-icon" data-machine="Radio Cabinet 1"></button>
            <div id="plan-container">
                <div class="piece" data-nom="Cabinet 1"></div>
            </div>
        `;
        mire = await chargerModule();
    });

    test('un bouton par radio en retard', () => {
        mire.checkMireAlert();
        const boutons = document.querySelectorAll('.btn-mire-main-alert');
        expect(boutons).toHaveLength(5);   // aucune échéance enregistrée
        expect(document.getElementById('mire-alerts-container').classList.contains('hidden'))
            .toBe(false);
    });

    test('aucune alerte quand toutes les échéances sont à jour', () => {
        for (const r of mire.MIRE_RADIOS) {
            mire.saveMireDataForMachine(r.machine, Date.now() + 30 * JOUR, r.defaultDays);
        }
        mire.checkMireAlert();
        expect(document.querySelectorAll('.btn-mire-main-alert')).toHaveLength(0);
        expect(document.getElementById('mire-alerts-container').classList.contains('hidden'))
            .toBe(true);
    });

    test('la popup s\'ouvre automatiquement sur la première radio en retard', () => {
        mire.checkMireAlert();
        expect(document.getElementById('mire-overlay').classList.contains('hidden'))
            .toBe(false);
    });

    test('« Ignorer pour l\'instant » empêche la réouverture automatique', () => {
        mire.checkMireAlert();
        document.getElementById('mire-overlay').classList.add('hidden');
        mire.setMireSnoozed(true);
        mire.checkMireAlert();
        expect(document.getElementById('mire-overlay').classList.contains('hidden'))
            .toBe(true);
    });

    test('cibler une machine ouvre directement sa fiche', () => {
        mire.checkMireAlert(false, 'Radio Cabinet 4');
        expect(document.getElementById('mire-overlay').classList.contains('hidden'))
            .toBe(false);
        expect(document.getElementById('mire-cabinet-display').textContent)
            .toContain('Cabinet 4');
    });

    test('le bouton de la fiche machine passe en rouge quand le contrôle est dû', () => {
        mire.updateMireIconStatus();
        const btn = document.querySelector('.btn-mire-icon');
        expect(btn.innerHTML).toContain('À faire');
        expect(btn.title).toContain('Radio Cabinet 1');
    });

    test('le bouton repasse au vert une fois le contrôle enregistré', () => {
        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() + 30 * JOUR, 30);
        mire.updateMireIconStatus();
        expect(document.querySelector('.btn-mire-icon').innerHTML).toContain('Ok');
    });

    test('la pièce du plan est surlignée puis dé-surlignée', () => {
        const piece = document.querySelector('#plan-container .piece[data-nom="Cabinet 1"]');
        mire.updateMireIconStatus();
        expect(piece.classList.contains('mire-alert-active')).toBe(true);

        mire.saveMireDataForMachine('Radio Cabinet 1', Date.now() + 30 * JOUR, 30);
        mire.updateMireIconStatus();
        expect(piece.classList.contains('mire-alert-active')).toBe(false);
    });

    test('un clic sur une alerte ouvre la fiche de la bonne radio', () => {
        mire.checkMireAlert();
        document.getElementById('mire-overlay').classList.add('hidden');
        const btn = document.querySelector('.btn-mire-main-alert[data-machine="Radio Cabinet 5"]');
        btn.click();
        expect(document.getElementById('mire-overlay').classList.contains('hidden'))
            .toBe(false);
        expect(document.getElementById('mire-cabinet-display').textContent)
            .toContain('Cabinet 5');
    });

    test('repli sur le bouton unique si le conteneur est absent', () => {
        document.getElementById('mire-alerts-container').remove();
        mire.checkMireAlert();
        const legacy = document.getElementById('btn-alertes-mire');
        expect(legacy.classList.contains('hidden')).toBe(false);
        expect(legacy.textContent).toContain('Alertes Mire');
    });
});
