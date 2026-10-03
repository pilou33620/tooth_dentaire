/**
 * Tests du suivi des dosimètres (js/features/dosimetres.js) et de l'alerte
 * périodique associée (js/machines/dosi-alert.js).
 *
 * Les données sont en base (documents "dosimetres" et "rappel_dosimetres") :
 * un serveur factice les fournit. Les noms utilisés sont fictifs.
 */

import { jest } from '@jest/globals';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const JOUR = 24 * 60 * 60 * 1000;

const MARKUP = `
    <span id="dosimetre-widget-badge"></span>
    <button id="btn-dosimetre"></button>
    <div id="dosimetres-overlay" class="hidden">
        <span id="dosi-total-count-badge"></span>
        <span id="dosi-next-alert-badge"></span>
        <input id="dosi-manager-input">
        <textarea id="dosi-general-note"></textarea>
        <datalist id="dosi-users-datalist"></datalist>
        <h3 id="dosi-form-title"></h3>
        <input id="dosi-edit-id" type="hidden">
        <input id="dosi-number-input">
        <input id="dosi-user-input">
        <input id="dosi-note-input">
        <button id="dosi-submit-btn"></button>
        <button id="dosi-cancel-edit-btn" class="hidden"></button>
        <button id="dosi-save-global-btn">Enregistrer</button>
        <button id="dosi-config-alert-btn"></button>
        <input id="dosi-table-search">
        <table><tbody id="dosi-table-body"></tbody></table>
    </div>
    <div id="dosi-overlay" class="hidden">
        <select id="dosi-rappel-select"><option value="30">30</option></select>
        <button id="dosi-validate-btn"></button>
        <button data-close="dosi-overlay"></button>
    </div>
    <button id="btn-alertes-dosi" class="hidden"></button>
    <button class="btn-dosi-icon"></button>
`;

const JOURS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
function lignePlanning(assistant, praticien) {
    const days = {};
    JOURS.forEach(j => { days[j] = { am: praticien, pm: '' }; });
    return { assistant, days };
}

let serveur;
let api;

async function chargerModule(documents = {}) {
    document.body.innerHTML = MARKUP;
    jest.resetModules();
    serveur = installerServeurFactice({ documents });
    api = await import('../js/core/api.js');
    await api.chargerEtat();
    return import('../js/features/dosimetres.js');
}

/** Laisse passer les promesses en attente (compatible horloge factice). */
async function microtaches() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

function saisir(id, valeur) {
    document.getElementById(id).value = valeur;
}

function lignesTableau() {
    return Array.from(document.querySelectorAll('#dosi-table-body tr'));
}

describe('getDosimetresData / saveDosimetresData', () => {

    test('sans document, la liste est vide (aucun nom par défaut)', async () => {
        const dosi = await chargerModule();
        expect(dosi.getDosimetresData()).toEqual({ manager: '', generalNote: '', dosimetres: [] });
    });

    test('les données enregistrées sont relues', async () => {
        const dosi = await chargerModule({
            dosimetres: {
                manager: 'Responsable X', generalNote: 'note',
                dosimetres: [{ id: 1, number: 'D1', user: 'Porteur A', note: '' }]
            }
        });
        expect(dosi.getDosimetresData().manager).toBe('Responsable X');
        expect(dosi.getDosimetresData().dosimetres).toHaveLength(1);
    });

    test('un document invalide est complété', async () => {
        const dosi = await chargerModule({ dosimetres: { manager: 'Y' } });
        expect(dosi.getDosimetresData().dosimetres).toEqual([]);
    });

    test('saveDosimetresData envoie les données au serveur', async () => {
        const dosi = await chargerModule();
        dosi.saveDosimetresData({ manager: 'X', generalNote: '', dosimetres: [] });
        await attendreEcritures();
        const envoi = appelsVers(serveur, 'PUT', '/api/documents/dosimetres');
        expect(envoi).toHaveLength(1);
        expect(envoi[0].corps.manager).toBe('X');
        expect(dosi.getDosimetresData().manager).toBe('X');
    });
});

describe('badges de comptage', () => {
    let dosi;
    beforeEach(async () => { dosi = await chargerModule(); });

    test('le badge affiche le nombre de dosimètres au pluriel', () => {
        dosi.saveDosimetresData({ dosimetres: [{ id: 1 }, { id: 2 }, { id: 3 }] });
        expect(document.getElementById('dosimetre-widget-badge').textContent)
            .toBe('3 suivis');
        expect(document.getElementById('dosi-total-count-badge').textContent)
            .toBe('3 dosimètres');
    });

    test('un seul dosimètre reste au singulier', () => {
        dosi.saveDosimetresData({ dosimetres: [{ id: 1 }] });
        expect(document.getElementById('dosimetre-widget-badge').textContent)
            .toBe('1 suivi');
    });

    test('zéro dosimètre', () => {
        dosi.saveDosimetresData({ dosimetres: [] });
        expect(document.getElementById('dosimetre-widget-badge').textContent)
            .toBe('0 suivi');
    });
});

describe('formulaire ajout / modification / suppression', () => {
    let dosi;

    beforeEach(async () => {
        dosi = await chargerModule({ dosimetres: { manager: 'Responsable X', generalNote: '', dosimetres: [] } });
        dosi.initDosimetres();
        dosi.openDosimetresDialog();
    });

    test('ajout d\'un dosimètre', () => {
        saisir('dosi-number-input', 'Dosi #9');
        saisir('dosi-user-input', 'Porteur B');
        saisir('dosi-note-input', 'Cab 5');
        document.getElementById('dosi-submit-btn').click();

        const liste = dosi.getDosimetresData().dosimetres;
        expect(liste).toHaveLength(1);
        expect(liste[0]).toMatchObject({ number: 'Dosi #9', user: 'Porteur B', note: 'Cab 5' });
    });

    test('le formulaire est vidé après ajout', () => {
        saisir('dosi-number-input', 'Dosi #9');
        document.getElementById('dosi-submit-btn').click();
        expect(document.getElementById('dosi-number-input').value).toBe('');
        expect(document.getElementById('dosi-edit-id').value).toBe('');
    });

    test('formulaire vide : refus avec message, rien n\'est enregistré', () => {
        const alerte = jest.spyOn(window, 'alert').mockImplementation(() => {});
        document.getElementById('dosi-submit-btn').click();
        expect(alerte).toHaveBeenCalled();
        expect(dosi.getDosimetresData().dosimetres).toHaveLength(0);
        alerte.mockRestore();
    });

    test('numéro seul : l\'utilisateur devient « Non attribué »', () => {
        saisir('dosi-number-input', 'Dosi #1');
        document.getElementById('dosi-submit-btn').click();
        expect(dosi.getDosimetresData().dosimetres[0].user).toBe('Non attribué');
    });

    test('utilisateur seul : le numéro est généré', () => {
        saisir('dosi-user-input', 'Porteur A');
        document.getElementById('dosi-submit-btn').click();
        expect(dosi.getDosimetresData().dosimetres[0].number).toBe('Dosi #1');
    });

    test('la touche Entrée valide le formulaire', () => {
        saisir('dosi-number-input', 'Dosi #7');
        document.getElementById('dosi-number-input')
            .dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        expect(dosi.getDosimetresData().dosimetres).toHaveLength(1);
    });

    test('modification d\'un dosimètre existant', () => {
        saisir('dosi-number-input', 'Dosi #1');
        saisir('dosi-user-input', 'Porteur A');
        document.getElementById('dosi-submit-btn').click();

        document.querySelector('.btn-edit-dosi').click();
        expect(document.getElementById('dosi-user-input').value).toBe('Porteur A');
        expect(document.getElementById('dosi-cancel-edit-btn').classList.contains('hidden'))
            .toBe(false);

        saisir('dosi-user-input', 'Porteur B');
        document.getElementById('dosi-submit-btn').click();

        const liste = dosi.getDosimetresData().dosimetres;
        expect(liste).toHaveLength(1);
        expect(liste[0].user).toBe('Porteur B');
    });

    test('annuler l\'édition réinitialise le formulaire', () => {
        saisir('dosi-number-input', 'Dosi #1');
        document.getElementById('dosi-submit-btn').click();
        document.querySelector('.btn-edit-dosi').click();
        document.getElementById('dosi-cancel-edit-btn').click();

        expect(document.getElementById('dosi-edit-id').value).toBe('');
        expect(document.getElementById('dosi-number-input').value).toBe('');
        expect(document.getElementById('dosi-cancel-edit-btn').classList.contains('hidden'))
            .toBe(true);
    });

    test('suppression confirmée', () => {
        saisir('dosi-number-input', 'Dosi #1');
        document.getElementById('dosi-submit-btn').click();
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        document.querySelector('.btn-delete-dosi').click();
        expect(dosi.getDosimetresData().dosimetres).toHaveLength(0);
        confirmer.mockRestore();
    });

    test('suppression annulée : la ligne reste', () => {
        saisir('dosi-number-input', 'Dosi #1');
        document.getElementById('dosi-submit-btn').click();
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        document.querySelector('.btn-delete-dosi').click();
        expect(dosi.getDosimetresData().dosimetres).toHaveLength(1);
        confirmer.mockRestore();
    });

    test('le responsable et la note générale sont enregistrés', () => {
        saisir('dosi-manager-input', 'Responsable Y');
        saisir('dosi-general-note', 'Renvoi trimestriel');
        document.getElementById('dosi-save-global-btn').click();
        const data = dosi.getDosimetresData();
        expect(data.manager).toBe('Responsable Y');
        expect(data.generalNote).toBe('Renvoi trimestriel');
    });
});

describe('tableau et recherche', () => {
    let dosi;

    beforeEach(async () => {
        dosi = await chargerModule({
            planning: { even: [lignePlanning('Assistante P', 'Dr Planning')], odd: [] },
            dosimetres: {
                manager: '', generalNote: '',
                dosimetres: [
                    { id: 1, number: 'Dosi #1', user: 'Porteur A', note: 'Cabinet 1' },
                    { id: 2, number: 'Dosi #2', user: 'Porteur B', note: 'Panoramique' },
                    { id: 3, number: 'Dosi #3', user: 'Porteur C', note: 'Chirurgie' }
                ]
            }
        });
        dosi.initDosimetres();
        dosi.openDosimetresDialog();
    });

    test('une ligne par dosimètre', () => {
        expect(lignesTableau()).toHaveLength(3);
    });

    test('recherche par nom d\'utilisateur', () => {
        const champ = document.getElementById('dosi-table-search');
        champ.value = 'porteur b';
        champ.dispatchEvent(new Event('input'));
        expect(lignesTableau()).toHaveLength(1);
        expect(lignesTableau()[0].textContent).toContain('Dosi #2');
    });

    test('recherche par note, insensible à la casse', () => {
        const champ = document.getElementById('dosi-table-search');
        champ.value = 'PANO';
        champ.dispatchEvent(new Event('input'));
        expect(lignesTableau()).toHaveLength(1);
    });

    test('recherche sans résultat : message dédié', () => {
        const champ = document.getElementById('dosi-table-search');
        champ.value = 'zzzz';
        champ.dispatchEvent(new Event('input'));
        expect(lignesTableau()[0].textContent).toContain('Aucun dosimètre ne correspond');
    });

    test('liste vide : message d\'invitation', () => {
        dosi.saveDosimetresData({ dosimetres: [] });
        dosi.openDosimetresDialog();
        expect(lignesTableau()[0].textContent).toContain('Aucun dosimètre enregistré');
    });

    test('le HTML des champs est échappé (anti-XSS)', () => {
        dosi.saveDosimetresData({
            dosimetres: [{ id: 1, number: '<img src=x onerror=alert(1)>',
                           user: '<script>', note: '' }]
        });
        dosi.openDosimetresDialog();
        const tbody = document.getElementById('dosi-table-body');
        expect(tbody.querySelector('img')).toBeNull();
        expect(tbody.querySelector('script')).toBeNull();
        expect(tbody.innerHTML).toContain('&lt;script&gt;');
    });

    test('la datalist propose le planning et les porteurs, triés et sans doublon', () => {
        const valeurs = Array.from(
            document.querySelectorAll('#dosi-users-datalist option')).map(o => o.value);
        expect(valeurs).toContain('Porteur A');
        expect(valeurs).toContain('Assistante P');
        expect(valeurs).toContain('Dr Planning');
        expect(new Set(valeurs).size).toBe(valeurs.length);
        expect([...valeurs].sort()).toEqual(valeurs);
    });

    test('« Non attribué » n\'entre pas dans la liste de suggestions', () => {
        dosi.saveDosimetresData({
            dosimetres: [{ id: 1, number: 'D', user: 'Non attribué', note: '' }] });
        dosi.openDosimetresDialog();
        const valeurs = Array.from(
            document.querySelectorAll('#dosi-users-datalist option')).map(o => o.value);
        expect(valeurs).not.toContain('Non attribué');
    });

    test('le widget d\'accueil ouvre la boîte de dialogue', () => {
        document.getElementById('dosimetres-overlay').classList.add('hidden');
        document.getElementById('btn-dosimetre').click();
        expect(document.getElementById('dosimetres-overlay').classList.contains('hidden'))
            .toBe(false);
    });

    test('le bouton « configurer le rappel » ouvre la popup d\'alerte', () => {
        document.getElementById('dosi-config-alert-btn').click();
        expect(document.getElementById('dosi-overlay').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('badge d\'échéance du renouvellement', () => {

    function badge() {
        return document.getElementById('dosi-next-alert-badge').textContent;
    }

    test('aucune échéance enregistrée', async () => {
        const dosi = await chargerModule();
        dosi.openDosimetresDialog();
        expect(badge()).toContain('immédiate');
    });

    test('échéance dépassée', async () => {
        const dosi = await chargerModule({ rappel_dosimetres: { nextTime: Date.now() - JOUR } });
        dosi.openDosimetresDialog();
        expect(badge()).toContain('Renouvellement à faire');
    });

    test('échéance à venir : nombre de jours restants', async () => {
        const dosi = await chargerModule({ rappel_dosimetres: { nextTime: Date.now() + 10 * JOUR } });
        dosi.openDosimetresDialog();
        expect(badge()).toMatch(/OK \(dans 10 j\)/);
    });
});

describe('alerte périodique dosimètres (dosi-alert.js)', () => {
    let dosiAlert;

    async function chargerAlerte(nextTime = null) {
        document.body.innerHTML = MARKUP;
        jest.resetModules();
        serveur = installerServeurFactice({
            documents: nextTime === null ? {} : { rappel_dosimetres: { nextTime } }
        });
        api = await import('../js/core/api.js');
        await api.chargerEtat();
        jest.useFakeTimers();
        dosiAlert = await import('../js/machines/dosi-alert.js');
    }

    /** Déclenche l'initialisation du module (attend le chargement des données). */
    async function initialiser() {
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await microtaches();
    }

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    function bouton() { return document.getElementById('btn-alertes-dosi'); }
    function overlay() { return document.getElementById('dosi-overlay'); }

    test('sans échéance, l\'alerte est due : bouton visible et popup ouverte', async () => {
        await chargerAlerte();
        dosiAlert.checkDosiAlert();
        expect(bouton().classList.contains('hidden')).toBe(false);
        expect(overlay().classList.contains('hidden')).toBe(false);
    });

    test('échéance future : bouton masqué, popup fermée', async () => {
        await chargerAlerte(Date.now() + JOUR);
        dosiAlert.checkDosiAlert();
        expect(bouton().classList.contains('hidden')).toBe(true);
        expect(overlay().classList.contains('hidden')).toBe(true);
    });

    test('échéance passée : alerte due', async () => {
        await chargerAlerte(Date.now() - JOUR);
        dosiAlert.checkDosiAlert();
        expect(bouton().classList.contains('hidden')).toBe(false);
    });

    test('la popup ne se rouvre pas toute seule après une fermeture manuelle', async () => {
        await chargerAlerte();
        dosiAlert.checkDosiAlert();
        overlay().classList.add('hidden');
        dosiAlert.checkDosiAlert();          // passage périodique suivant
        expect(overlay().classList.contains('hidden')).toBe(true);
    });

    test('un clic manuel (force) rouvre la popup malgré tout', async () => {
        await chargerAlerte();
        dosiAlert.checkDosiAlert();
        overlay().classList.add('hidden');
        dosiAlert.checkDosiAlert(true);
        expect(overlay().classList.contains('hidden')).toBe(false);
    });

    test('valider un rappel repousse l\'échéance, l\'envoie au serveur et masque le bouton', async () => {
        await chargerAlerte();
        await initialiser();
        document.getElementById('dosi-rappel-select').value = '30';
        document.getElementById('dosi-validate-btn').click();
        await microtaches();

        const echeance = api.getDocument('rappel_dosimetres').nextTime;
        expect(echeance).toBeGreaterThan(Date.now() + 29 * JOUR);
        // Les modules rechargés d'un test à l'autre gardent leurs écouteurs sur
        // le document : on vérifie la valeur envoyée, pas le nombre d'envois.
        const envois = appelsVers(serveur, 'PUT', '/api/documents/rappel_dosimetres');
        expect(envois.length).toBeGreaterThan(0);
        expect(envois.at(-1).corps.nextTime).toBe(echeance);
        expect(overlay().classList.contains('hidden')).toBe(true);
        expect(bouton().classList.contains('hidden')).toBe(true);
        expect(document.getElementById('dosi-next-alert-badge').textContent)
            .toContain('dans 30 j');
    });

    test('l\'icône de la fiche machine reflète l\'état', async () => {
        await chargerAlerte(Date.now() + JOUR);
        await initialiser();
        expect(document.querySelector('.btn-dosi-icon').innerHTML).toContain('Ok');
    });

    test('un clic sur l\'icône de la fiche machine ouvre la popup', async () => {
        await chargerAlerte(Date.now() - JOUR);
        await initialiser();
        overlay().classList.add('hidden');
        document.querySelector('.btn-dosi-icon').click();
        expect(overlay().classList.contains('hidden')).toBe(false);
    });

    test('le bouton d\'accueil rouvre la popup après une mise en veille', async () => {
        await chargerAlerte();
        await initialiser();
        document.querySelector('#dosi-overlay [data-close="dosi-overlay"]').click();
        overlay().classList.add('hidden');
        bouton().click();
        expect(overlay().classList.contains('hidden')).toBe(false);
    });

    test('la surveillance périodique tourne toutes les 60 s', async () => {
        await chargerAlerte(Date.now() + 2 * JOUR);
        await initialiser();
        expect(bouton().classList.contains('hidden')).toBe(true);

        api.setDocument('rappel_dosimetres', { nextTime: Date.now() - 1 });
        jest.advanceTimersByTime(60000);
        expect(bouton().classList.contains('hidden')).toBe(false);
    });
});
