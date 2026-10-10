/**
 * Documents partagés entre postes (js/core/api.js) : versions, rejeu d'une
 * modification après un conflit, échec d'écriture, rechargement pendant une
 * saisie, heure du serveur ; et leurs usages (notes, checklist, minuteurs,
 * rappels, planning).
 */

import { jest } from '@jest/globals';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

let serveur;
let api;

async function demarrer(documents = {}, base) {
    document.body.innerHTML = "";
    jest.resetModules();
    serveur = installerServeurFactice({ documents: JSON.parse(JSON.stringify(documents)), base });
    api = await import('../js/core/api.js');
    await api.chargerEtat();
}

beforeEach(() => {
    global.alert = jest.fn();
    global.confirm = jest.fn(() => true);
});

describe('modifierDocument : rejeu sur la version d\'un autre poste', () => {
    test('la version lue est envoyée avec l\'écriture', async () => {
        await demarrer({ notes: { items: [] } });
        api.modifierDocument('notes', d => { d.items.push({ id: 'a' }); });
        await attendreEcritures();
        const [envoi] = appelsVers(serveur, 'PUT', '/api/documents/notes');
        expect(envoi.corps.items).toEqual([{ id: 'a' }]);
        expect(api.versionDocument('notes')).toBe(2);
    });

    test('un autre poste a écrit entre-temps : sa modification est conservée', async () => {
        await demarrer({ notes: { items: [{ id: 'a' }] } });
        serveur.ecrireAilleurs('notes', { items: [{ id: 'a' }, { id: 'b' }] });
        api.modifierDocument('notes', d => { d.items.push({ id: 'c' }); });
        await attendreEcritures();
        expect(serveur.documents.notes.items.map(n => n.id)).toEqual(['a', 'b', 'c']);
        expect(api.getDocument('notes').items.map(n => n.id)).toEqual(['a', 'b', 'c']);
    });

    test('deux modifications rapprochées partent ensemble, dans l\'ordre', async () => {
        await demarrer({ notes: { items: [] } });
        api.modifierDocument('notes', d => { d.items.push({ id: '1' }); });
        api.modifierDocument('notes', d => { d.items.push({ id: '2' }); });
        expect(api.getDocument('notes').items).toHaveLength(2);
        await attendreEcritures();
        expect(serveur.documents.notes.items.map(n => n.id)).toEqual(['1', '2']);
    });

    test('échec d\'écriture : l\'écran revient à la valeur enregistrée et prévient', async () => {
        await demarrer({ notes: { items: [] } });
        serveur.echecDocuments = true;
        const prevenu = jest.fn();
        window.addEventListener('donnees-modifiees', prevenu);
        const r = await api.modifierDocument('notes', d => { d.items.push({ id: 'x' }); });
        expect(r).toBeNull();
        expect(api.getDocument('notes').items).toEqual([]);
        expect(global.alert).toHaveBeenCalled();
        expect(prevenu).toHaveBeenCalled();
        window.removeEventListener('donnees-modifiees', prevenu);
    });

    test('serveur sans versions (ancien serveur) : écriture sans contrôle', async () => {
        await demarrer({ notes: { items: [] } });
        serveur.versions = {};
        await api.chargerEtat();
        await api.modifierDocument('notes', d => { d.items.push({ id: 'z' }); });
        const [envoi] = appelsVers(serveur, 'PUT', '/api/documents/notes');
        expect(envoi).toBeDefined();
        expect(serveur.documents.notes.items).toEqual([{ id: 'z' }]);
    });
});

describe('enregistrerEdition (fenêtres planning, tâches)', () => {
    test('conflit refusé par l\'utilisateur : rien n\'est écrit', async () => {
        await demarrer({ taches: { rows: [] } });
        const lue = api.versionDocument('taches');
        serveur.ecrireAilleurs('taches', { rows: [{ task: 'autre poste' }] });
        global.confirm = jest.fn(() => false);
        const ok = await api.enregistrerEdition('taches', { rows: [{ task: 'moi' }] }, lue, 'Le tableau');
        expect(ok).toBe(false);
        expect(serveur.documents.taches.rows[0].task).toBe('autre poste');
    });

    test('conflit accepté : la saisie remplace la version de l\'autre poste', async () => {
        await demarrer({ taches: { rows: [] } });
        const lue = api.versionDocument('taches');
        serveur.ecrireAilleurs('taches', { rows: [{ task: 'autre poste' }] });
        const ok = await api.enregistrerEdition('taches', { rows: [{ task: 'moi' }] }, lue, 'Le tableau');
        expect(ok).toBe(true);
        expect(serveur.documents.taches.rows[0].task).toBe('moi');
    });
});

describe('surveillance des autres postes', () => {
    test('un rechargement reçu pendant une écriture est ignoré', async () => {
        await demarrer({ notes: { items: [] } });
        serveur.ecrireAilleurs('notes', { items: [{ id: 'distant' }] });
        const rechargement = api.chargerEtat();
        api.modifierDocument('notes', d => { d.items.push({ id: 'local' }); });
        expect(await rechargement).toBeNull();
        expect(api.getDocument('notes').items.map(n => n.id)).toContain('local');
        await attendreEcritures();
    });

    test('pendant une saisie, les données ne sont pas rechargées', async () => {
        await demarrer({ notes: { items: [] } });
        api.definirPauseSurveillance(() => true);
        serveur.ecrireAilleurs('notes', { items: [{ id: 'distant' }] });
        await api.verifierRevision();
        expect(api.getDocument('notes').items).toEqual([]);
        api.definirPauseSurveillance(null);
        await api.verifierRevision();
        expect(api.getDocument('notes').items).toEqual([{ id: 'distant' }]);
    });

    test('l\'heure du serveur corrige l\'horloge du poste', async () => {
        await demarrer();
        serveur.heure = Date.now() + 3600000;
        await api.verifierRevision();
        expect(Math.abs(api.maintenantServeur() - (Date.now() + 3600000))).toBeLessThan(2000);
    });
});

describe('usages : modifications rejouées', () => {
    test('checklist : deux postes cochent deux tâches différentes', async () => {
        const jour = new Date();
        const pad = n => String(n).padStart(2, '0');
        const aujourdhui = `${jour.getFullYear()}-${pad(jour.getMonth() + 1)}-${pad(jour.getDate())}`;
        const modele = [{ id: 't1', moment: 'ouverture', libelle: 'A' }, { id: 't2', moment: 'ouverture', libelle: 'B' }];
        await demarrer({ checklist: { modele, jour: aujourdhui, fait: {} } });
        const checklist = await import('../js/features/checklist.js');
        serveur.ecrireAilleurs('checklist', { modele, jour: aujourdhui, fait: { t1: { qui: 'X', heure: '08:00' } } });
        checklist.basculerTache('t2', 'Moi', jour);
        await attendreEcritures();
        expect(Object.keys(serveur.documents.checklist.fait).sort()).toEqual(['t1', 't2']);
    });

    test('minuteurs : le nettoyage n\'efface pas un minuteur lancé ailleurs', async () => {
        const maintenant = Date.now();
        const vieux = { id: 'vieux', libelle: 'Vieux', debut: maintenant - 3600000, fin: maintenant - 3000000, minutes: 10 };
        await demarrer({ minuteurs: { actifs: [vieux], preselections: [] } });
        const minuteurs = await import('../js/features/minuteurs.js');
        const nouveau = { id: 'neuf', libelle: 'Neuf', debut: maintenant, fin: maintenant + 600000, minutes: 10 };
        serveur.ecrireAilleurs('minuteurs', { actifs: [vieux, nouveau], preselections: [] });
        expect(minuteurs.nettoyer(maintenant)).toBe(1);
        await attendreEcritures();
        expect(serveur.documents.minuteurs.actifs.map(m => m.id)).toEqual(['neuf']);
    });

    test('notes : épingler rejoué ne bascule pas deux fois', async () => {
        await demarrer({ notes: { items: [{ id: 'n1', texte: 'x', cree_le: 1, epingle: false }] } });
        const notes = await import('../js/features/notes.js');
        serveur.ecrireAilleurs('notes', { items: [{ id: 'n1', texte: 'x', cree_le: 1, epingle: true }, { id: 'n2', texte: 'y', cree_le: 2, epingle: false }] });
        notes.basculerEpingle('n1');
        await attendreEcritures();
        expect(serveur.documents.notes.items.find(n => n.id === 'n1').epingle).toBe(true);
        expect(serveur.documents.notes.items).toHaveLength(2);
    });

    test('rappel mire : la validation d\'une radio garde celle d\'un autre poste', async () => {
        await demarrer({ rappels_mire: {} });
        const mire = await import('../js/machines/mire-alert.js');
        serveur.ecrireAilleurs('rappels_mire', { 'Radio Cabinet 2': { nextTime: 123, lastDone: 1, intervalDays: 30 } });
        mire.saveMireDataForMachine('Radio Cabinet 1', 456, 30);
        await attendreEcritures();
        expect(Object.keys(serveur.documents.rappels_mire).sort()).toEqual(['Radio Cabinet 1', 'Radio Cabinet 2']);
    });

    test('rappel au format date ISO : traité comme une vraie échéance', async () => {
        await demarrer({ rappels_mire: { 'Radio Cabinet 1': { nextTime: '2000-01-01' } } });
        const mire = await import('../js/machines/mire-alert.js');
        expect(mire.getMireStatus('Radio Cabinet 1').isDue).toBe(true);
        expect(mire.getMireStatus('Radio Cabinet 1').dateStr).toBe('01/01/2000');
    });
});

describe('parité des semaines (année de 53 semaines)', () => {
    let clock;
    beforeAll(async () => { clock = await import('../js/planning/clock.js'); });

    test('2026 : identique au numéro de semaine ISO', () => {
        for (let jour = 0; jour < 364; jour += 7) {
            const d = new Date(2026, 0, 5 + jour);
            const iso = clock.getWeekNumber(d) % 2 === 0 ? 'even' : 'odd';
            expect(clock.pariteSemaine(d)).toBe(iso);
        }
    });

    test('semaine 53 puis semaine 1 : l\'alternance continue', () => {
        expect(clock.pariteSemaine(new Date(2026, 11, 30))).toBe('odd');   // semaine 53
        expect(clock.pariteSemaine(new Date(2027, 0, 6))).toBe('even');    // semaine 1 de 2027
    });

    test('mode « iso » : deux semaines impaires de suite', () => {
        expect(clock.pariteSemaine(new Date(2026, 11, 30), 'iso')).toBe('odd');
        expect(clock.pariteSemaine(new Date(2027, 0, 6), 'iso')).toBe('odd');
    });
});
