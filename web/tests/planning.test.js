/**
 * Tests du planning : horloge / numéro de semaine (js/planning/clock.js),
 * planning des binômes (js/planning/team-planning.js), couleurs
 * (js/planning/couleurs.js) et tableau des tâches (js/planning/tasks-planning.js).
 *
 * Les données viennent du serveur (documents "planning", "planning_couleurs",
 * "taches") : les noms utilisés ici sont fictifs.
 */

import { jest } from '@jest/globals';
import { getWeekNumber, updateClock } from '../js/planning/clock.js';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const MARKUP = `
    <div id="clock"></div>
    <div id="date-display"></div>
    <div id="calendar-preview-content"></div>
    <button id="btn-preview-even"></button>
    <button id="btn-preview-odd"></button>
    <div id="calendar-overlay" class="hidden">
        <button id="btn-tab-even"></button>
        <button id="btn-tab-odd"></button>
        <button id="btn-tab-couleurs"></button>
        <div id="calendar-legende"></div>
        <div id="calendar-container-even"></div>
        <div id="calendar-container-odd"></div>
        <div id="calendar-container-couleurs" class="hidden"></div>
        <button id="fermer-calendrier" data-close="calendar-overlay"></button>
    </div>
    <div id="tasks-overlay" class="hidden">
        <div id="tasks-container"></div>
        <textarea id="tasks-note"></textarea>
    </div>
    <div id="tasks-preview-content"></div>
`;

const JOURS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];

function ligne(assistant, valeur = '') {
    const days = {};
    JOURS.forEach(j => { days[j] = { am: valeur, pm: valeur }; });
    return { assistant, days };
}

const ROUGE = '#cf2727', ROSE = '#ff6e9e', BLEU = '#bbdefb', ORANGE = '#ff9900', VERT = '#a2d9ce';

const PLANNING = {
    even: [ligne('Assistante A', 'Dr Alpha'), ligne('Assistante B', 'Dr Beta')],
    odd: [ligne('Assistante C', 'Dr Gamma')]
};

const COULEURS = {
    legende: [{ libelle: 'Cabinet 1', couleur: ROUGE }],
    regles: [
        { cible: 'praticien', nom: 'Dr Alpha', jour: '', creneau: '', couleur: ROUGE },
        { cible: 'praticien', nom: 'Dr Beta', jour: '', creneau: '', couleur: BLEU },
        { cible: 'praticien', nom: 'Dr Beta', jour: 'MARDI', creneau: '', couleur: ORANGE },
        { cible: 'praticien', nom: 'Dr Beta', jour: 'JEUDI', creneau: 'am', couleur: ROSE },
        { cible: 'assistante', nom: 'Assistante V', jour: '', creneau: '', couleur: VERT },
        { cible: 'tache', nom: 'Assistante A', jour: '', creneau: '', couleur: BLEU },
        { cible: 'tache', nom: 'Assistante', jour: '', creneau: '', couleur: ROSE }
    ]
};

const TACHES = {
    header1: 'Période 1',
    header2: 'Période 2',
    note: 'Consigne générale',
    rows: [
        { task: 'Tâche 1', nature: 'Nature 1', col1: 'Assistante A', col2: '' },
        { task: 'Tâche 2', nature: 'Nature 2', col1: 'Assistante B', col2: '' },
        { task: 'Tâche 3', nature: 'Nature 3', col1: '', col2: '' },
        { task: 'Tâche 4', nature: 'Nature 4', col1: '', col2: '' },
        { task: 'Tâche 5', nature: 'Nature 5', col1: '', col2: '' }
    ]
};

let serveur;

async function charger(module, documents = { planning: PLANNING, planning_couleurs: COULEURS, taches: TACHES }) {
    document.body.innerHTML = MARKUP;
    jest.resetModules();
    serveur = installerServeurFactice({ documents: JSON.parse(JSON.stringify(documents)) });
    const api = await import('../js/core/api.js');
    await api.chargerEtat();
    return import(module);
}

const chargerTeam = (docs) => charger('../js/planning/team-planning.js', docs);
const chargerTasks = (docs) => charger('../js/planning/tasks-planning.js', docs);
const chargerCouleurs = (docs) => charger('../js/planning/couleurs.js', docs);

describe('getWeekNumber (norme ISO 8601)', () => {

    test('le 4 janvier appartient toujours à la semaine 1', () => {
        for (const annee of [2024, 2025, 2026, 2027, 2028]) {
            expect(getWeekNumber(new Date(annee, 0, 4))).toBe(1);
        }
    });

    test('le 1er janvier 2026 (jeudi) est en semaine 1', () => {
        expect(getWeekNumber(new Date(2026, 0, 1))).toBe(1);
    });

    test('le 1er janvier 2023 (dimanche) appartient à la semaine 52 de 2022', () => {
        expect(getWeekNumber(new Date(2023, 0, 1))).toBe(52);
    });

    test('2026 compte 53 semaines', () => {
        expect(getWeekNumber(new Date(2026, 11, 31))).toBe(53);
    });

    test('les jours d\'une même semaine ISO portent le même numéro', () => {
        const lundi = new Date(2026, 2, 9);
        const numeros = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(lundi);
            d.setDate(lundi.getDate() + i);
            numeros.push(getWeekNumber(d));
        }
        expect(new Set(numeros).size).toBe(1);
    });

    test('le numéro augmente d\'une unité d\'une semaine à l\'autre', () => {
        const a = getWeekNumber(new Date(2026, 5, 1));
        const b = getWeekNumber(new Date(2026, 5, 8));
        expect(b - a).toBe(1);
    });
});

describe('updateClock', () => {
    beforeEach(() => {
        document.body.innerHTML = MARKUP;
        delete window.lastWeekNo;
        delete window.lastDay;
        delete window.updateTeamPlanning;
    });

    test('affiche l\'heure sur deux chiffres', () => {
        updateClock();
        expect(document.getElementById('clock').textContent)
            .toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    test('affiche la date et le numéro de semaine', () => {
        updateClock();
        expect(document.getElementById('date-display').textContent)
            .toMatch(/^\d{2}\/\d{2}\/\d{4} , Semaine \d{1,2}$/);
    });

    test('prévient le planning des binômes au premier appel', () => {
        const maj = jest.fn();
        window.updateTeamPlanning = maj;
        updateClock();
        expect(maj).toHaveBeenCalledWith(getWeekNumber(new Date()));
    });

    test('ne re-notifie pas le planning si ni le jour ni la semaine n\'ont changé', () => {
        const maj = jest.fn();
        window.updateTeamPlanning = maj;
        updateClock();
        updateClock();
        expect(maj).toHaveBeenCalledTimes(1);
    });

    test('fonctionne même sans zone d\'affichage de la date', () => {
        document.getElementById('date-display').remove();
        expect(() => updateClock()).not.toThrow();
    });
});

describe('couleurs du planning (règles en base)', () => {
    let couleurs;
    beforeEach(async () => { couleurs = await chargerCouleurs(); });

    test('case vide, tiret, repos ou école : inactive', () => {
        for (const v of ['', '   ', '-', 'Repos', 'repos', 'École', 'ecole']) {
            expect(couleurs.couleurCellule(v, 'Assistante A', 'LUNDI', 'am').inactif).toBe(true);
        }
    });

    test('couleur générale d\'un praticien', () => {
        expect(couleurs.couleurCellule('Dr Alpha', 'Assistante A', 'LUNDI', 'am').couleur).toBe(ROUGE);
        expect(couleurs.couleurCellule('Dr Beta', 'Assistante A', 'LUNDI', 'am').couleur).toBe(BLEU);
    });

    test('la casse et les espaces autour du nom sont ignorés', () => {
        expect(couleurs.couleurCellule('  DR ALPHA  ', 'Assistante A', 'LUNDI', 'am').couleur).toBe(ROUGE);
    });

    test('la règle la plus précise (jour, puis jour + créneau) l\'emporte', () => {
        expect(couleurs.couleurCellule('Dr Beta', '', 'MARDI', 'pm').couleur).toBe(ORANGE);
        expect(couleurs.couleurCellule('Dr Beta', '', 'JEUDI', 'am').couleur).toBe(ROSE);
        expect(couleurs.couleurCellule('Dr Beta', '', 'JEUDI', 'pm').couleur).toBe(BLEU);
    });

    test('repli sur la couleur de l\'assistante', () => {
        expect(couleurs.couleurCellule('Inconnu', 'Assistante V', 'LUNDI', 'am').couleur).toBe(VERT);
        expect(couleurs.couleurCellule('Inconnu', 'Assistante A', 'LUNDI', 'am').couleur).toBe('');
        expect(couleurs.couleurCellule('Inconnu', '', 'LUNDI', 'am').couleur).toBe('');
    });

    test('tableau des tâches : première règle qui correspond, dans l\'ordre', () => {
        expect(couleurs.couleurTache('Assistante A / Assistante B').couleur).toBe(BLEU);
        expect(couleurs.couleurTache('Assistante B').couleur).toBe(ROSE);
        expect(couleurs.couleurTache('Personne').couleur).toBe('');
        expect(couleurs.couleurTache('Repos').inactif).toBe(true);
    });

    test('sans document, la légende par défaut est fournie et aucune règle', async () => {
        const c = await chargerCouleurs({});
        expect(c.getCouleurs().legende.length).toBeGreaterThan(0);
        expect(c.getCouleurs().regles).toEqual([]);
    });

    test('les couleurs sont appliquées en style dans les cases', async () => {
        const team = await chargerTeam();
        team.updateTeamPlanning(10);
        expect(document.getElementById('calendar-preview-content').innerHTML)
            .toContain(`background-color: ${ROUGE}`);
    });

    test('getCellClass reste compatible ("cell-inactive" ou "")', async () => {
        const team = await chargerTeam();
        expect(team.getCellClass('Repos', 'Assistante A', 'LUNDI', 'am')).toBe('cell-inactive');
        expect(team.getCellClass('Dr Alpha', 'Assistante A', 'LUNDI', 'am')).toBe('');
    });

    test('l\'éditeur de couleurs modifie le brouillon puis l\'enregistre', async () => {
        const team = await chargerTeam();
        team.openCalendarModal();
        team.switchCalendarModalTab('couleurs');
        document.getElementById('btn-add-regle').click();
        const nom = [...document.querySelectorAll('#calendar-container-couleurs [data-champ="nom"]')].at(-1);
        nom.value = 'Dr Delta';
        nom.dispatchEvent(new Event('input'));
        team.saveCalendarData();
        await attendreEcritures();
        const envoi = appelsVers(serveur, 'PUT', '/api/documents/planning_couleurs');
        expect(envoi).toHaveLength(1);
        expect(envoi[0].corps.regles.at(-1).nom).toBe('Dr Delta');
    });
});

describe('données du calendrier', () => {
    let team;
    beforeEach(async () => { team = await chargerTeam(); });

    test('le planning vient du serveur', () => {
        const data = team.getCalendarData();
        expect(data.even.map(l => l.assistant)).toEqual(['Assistante A', 'Assistante B']);
        expect(data.odd).toHaveLength(1);
    });

    test('sans document, le planning est vide (aucun nom par défaut)', async () => {
        const vide = await chargerTeam({});
        expect(vide.getCalendarData()).toEqual({ even: [], odd: [] });
    });

    test('chaque ligne couvre les six jours travaillés', () => {
        for (const l of team.getCalendarData().even) {
            expect(Object.keys(l.days)).toEqual(JOURS);
            for (const jour of Object.values(l.days)) {
                expect(jour).toHaveProperty('am');
                expect(jour).toHaveProperty('pm');
            }
        }
    });

    test('un planning incomplet est complété', async () => {
        const t = await chargerTeam({ planning: { even: [{ assistant: 'X', days: { LUNDI: { am: 'Dr Alpha' } } }] } });
        const data = t.getCalendarData();
        expect(data.odd).toEqual([]);
        expect(data.even[0].days.LUNDI).toEqual({ am: 'Dr Alpha', pm: '' });
        expect(data.even[0].days.SAMEDI).toEqual({ am: '', pm: '' });
    });

    test('les modifications sont envoyées au serveur à l\'enregistrement', async () => {
        team.openCalendarModal();
        team.getCalendarData().even[0].assistant = 'Nouvelle';
        team.saveCalendarData();
        await attendreEcritures();
        const envoi = appelsVers(serveur, 'PUT', '/api/documents/planning');
        expect(envoi).toHaveLength(1);
        expect(envoi[0].corps.even[0].assistant).toBe('Nouvelle');
        expect(team.getCalendarData().even[0].assistant).toBe('Nouvelle');
    });

    test('fermer sans enregistrer abandonne les modifications', () => {
        delete window._teamPlanningInitialized;
        team.initTeamPlanning();
        team.openCalendarModal();
        team.getCalendarData().even[0].assistant = 'Brouillon';
        document.getElementById('fermer-calendrier').click();
        expect(team.getCalendarData().even[0].assistant).toBe('Assistante A');
        expect(appelsVers(serveur, 'PUT', '/api/documents/planning')).toHaveLength(0);
    });

    test('noms du planning proposés en suggestion', () => {
        expect(team.nomsDuPlanning()).toEqual(expect.arrayContaining(['Assistante A', 'Dr Alpha', 'Dr Beta']));
    });
});

describe('parité de la semaine', () => {
    let team;
    beforeEach(async () => { team = await chargerTeam(); });

    test('semaine paire / impaire', () => {
        team.updateTeamPlanning(10);
        expect(team.getActualParity()).toBe('even');
        team.updateTeamPlanning(11);
        expect(team.getActualParity()).toBe('odd');
    });

    test('l\'aperçu suit la parité réelle par défaut', () => {
        team.updateTeamPlanning(12);
        expect(team.getPreviewParity()).toBe('even');
    });

    test('l\'aperçu peut être forcé sur l\'autre parité', () => {
        team.updateTeamPlanning(12);
        team.setPreviewParity('odd');
        expect(team.getPreviewParity()).toBe('odd');
        expect(team.getActualParity()).toBe('even');
    });

    test('les boutons de parité marquent la semaine réelle d\'une étoile', () => {
        team.updateTeamPlanning(10);
        expect(document.getElementById('btn-preview-even').innerHTML).toBe('Paire ★');
        expect(document.getElementById('btn-preview-odd').innerHTML).toBe('Impaire');
    });

    test('un dimanche, la parité est celle du lundi suivant', () => {
        const dimanche = new Date(2026, 2, 8, 12);   // 08/03/2026 est un dimanche
        jest.useFakeTimers().setSystemTime(dimanche);
        const semaineDuDimanche = getWeekNumber(dimanche);
        const lundi = new Date(dimanche);
        lundi.setDate(lundi.getDate() + 1);
        const semaineDuLundi = getWeekNumber(lundi);

        team.updateTeamPlanning(semaineDuDimanche);
        expect(team.getActualParity())
            .toBe(semaineDuLundi % 2 === 0 ? 'even' : 'odd');
        jest.useRealTimers();
    });
});

describe('aperçu et tableaux du planning', () => {
    let team;
    beforeEach(async () => { team = await chargerTeam(); });

    test('l\'aperçu affiche une ligne par assistante', () => {
        team.updateTeamPlanning(10);
        const html = document.getElementById('calendar-preview-content').innerHTML;
        for (const l of team.getCalendarData().even) {
            expect(html).toContain(l.assistant);
        }
    });

    test('une demi-journée sans praticien affiche « Repos »', async () => {
        const t = await chargerTeam({ planning: { even: [ligne('Assistante A', '')], odd: [] } });
        t.updateTeamPlanning(10);
        expect(document.getElementById('calendar-preview-content').innerHTML).toContain('Repos');
    });

    test('un planning vide invite à le remplir', async () => {
        const t = await chargerTeam({});
        t.updateTeamPlanning(10);
        expect(document.getElementById('calendar-preview-content').textContent)
            .toContain('Planning vide');
    });

    test('les flèches de navigation changent le jour affiché', () => {
        team.updateTeamPlanning(10);
        const avant = document.getElementById('calendar-preview-content').innerHTML;
        window.navPlanningDay(1);
        const apres = document.getElementById('calendar-preview-content').innerHTML;
        expect(apres).not.toBe(avant);

        window.navPlanningDay(-1);
        expect(document.getElementById('calendar-preview-content').innerHTML).toBe(avant);
    });

    test('revenir à aujourd\'hui annule le décalage de jour', () => {
        team.updateTeamPlanning(10);
        const initial = document.getElementById('calendar-preview-content').innerHTML;
        window.navPlanningDay(3);
        window.resetPlanningDay();
        expect(document.getElementById('calendar-preview-content').innerHTML).toBe(initial);
    });

    test('renderCalendarTable produit un tableau éditable', () => {
        team.renderCalendarTable('even', 'calendar-container-even');
        const conteneur = document.getElementById('calendar-container-even');
        expect(conteneur.querySelectorAll('.assistant-input').length)
            .toBe(team.getCalendarData().even.length);
        expect(conteneur.querySelectorAll('.cell-input').length)
            .toBe(team.getCalendarData().even.length * 12);   // 6 jours x 2 demi-journées
    });

    test('ajouter puis retirer une ligne', () => {
        team.openCalendarModal();
        const avant = team.getCalendarData().even.length;
        window.addCalendarRow('even');
        expect(team.getCalendarData().even).toHaveLength(avant + 1);
        expect(team.getCalendarData().even[avant].assistant).toBe('Nouveau');

        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        window.removeCalendarRow('even', avant);
        expect(team.getCalendarData().even).toHaveLength(avant);
        confirmer.mockRestore();
    });

    test('la suppression d\'une ligne peut être annulée', () => {
        team.openCalendarModal();
        const avant = team.getCalendarData().even.length;
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        window.removeCalendarRow('even', 0);
        expect(team.getCalendarData().even).toHaveLength(avant);
        confirmer.mockRestore();
    });

    test('modifier une cellule et le nom d\'une assistante', () => {
        team.openCalendarModal();
        window.updateCalendarRow('even', 0, 'assistant', 'Test');
        window.updateCalendarCell('even', 0, 'LUNDI', 'am', 'Dr Beta');
        expect(team.getCalendarData().even[0].assistant).toBe('Test');
        expect(team.getCalendarData().even[0].days.LUNDI.am).toBe('Dr Beta');
    });

    test('le nom des assistantes est échappé (anti-XSS)', () => {
        team.openCalendarModal();
        team.getCalendarData().even[0].assistant = '<img src=x onerror=alert(1)>';
        team.renderCalendarTable('even', 'calendar-container-even');
        expect(document.querySelector('#calendar-container-even img')).toBeNull();
    });

    test('la fenêtre du planning s\'ouvre sur l\'onglet de la parité courante', () => {
        team.updateTeamPlanning(11);            // impaire
        team.openCalendarModal();
        expect(document.getElementById('calendar-overlay').classList.contains('hidden'))
            .toBe(false);
        expect(document.getElementById('calendar-container-odd').classList.contains('hidden'))
            .toBe(false);
        expect(document.getElementById('calendar-container-even').classList.contains('hidden'))
            .toBe(true);
    });

    test('changer d\'onglet bascule les tableaux', () => {
        team.openCalendarModal();
        team.switchCalendarModalTab('even');
        expect(document.getElementById('calendar-container-even').classList.contains('hidden'))
            .toBe(false);
        team.switchCalendarModalTab('couleurs');
        expect(document.getElementById('calendar-container-even').classList.contains('hidden'))
            .toBe(true);
        expect(document.getElementById('calendar-container-couleurs').classList.contains('hidden'))
            .toBe(false);
    });
});

describe('tableau des tâches', () => {
    let tasks;
    beforeEach(async () => { tasks = await chargerTasks(); });

    test('les tâches viennent du serveur', () => {
        const data = tasks.getTasksData();
        expect(data.rows).toHaveLength(5);
        expect(data.header1).toBe('Période 1');
        expect(data.note).toBe('Consigne générale');
    });

    test('sans document, aucune tâche (aucun nom par défaut)', async () => {
        const vide = await chargerTasks({});
        expect(vide.getTasksData().rows).toEqual([]);
    });

    test('ouvrir la fenêtre affiche les lignes et la consigne', () => {
        tasks.ouvrirTaches();
        expect(document.querySelectorAll('#tasks-container tbody tr')).toHaveLength(5);
        expect(document.getElementById('tasks-note').value).toBe('Consigne générale');
    });

    test('les modifications sont envoyées au serveur à l\'enregistrement', async () => {
        tasks.ouvrirTaches();
        tasks.getTasksData().rows[0].col1 = 'Assistante Z';
        tasks.saveTasksData();
        await attendreEcritures();
        const envoi = appelsVers(serveur, 'PUT', '/api/documents/taches');
        expect(envoi).toHaveLength(1);
        expect(envoi[0].corps.rows[0].col1).toBe('Assistante Z');
        expect(tasks.getTasksData().rows[0].col1).toBe('Assistante Z');
    });

    test('l\'aperçu se limite à trois lignes et annonce le reste', () => {
        tasks.updateTasksPreview();
        const html = document.getElementById('tasks-preview-content').innerHTML;
        expect(html).toContain('et 2 autres tâches');
    });

    test('l\'aperçu concatène les deux colonnes d\'affectation', async () => {
        const docs = JSON.parse(JSON.stringify({ taches: TACHES }));
        docs.taches.rows[0].col2 = 'Assistante B';
        const t = await chargerTasks(docs);
        t.updateTasksPreview();
        expect(document.getElementById('tasks-preview-content').innerHTML)
            .toContain('Assistante A / Assistante B');
    });

    test('renderTasksTable affiche toutes les lignes', () => {
        tasks.renderTasksTable('tasks-container');
        const lignes = document.querySelectorAll('#tasks-container tbody tr');
        expect(lignes.length).toBe(tasks.getTasksData().rows.length);
    });

    test('ajouter puis retirer une ligne de tâche', () => {
        tasks.ouvrirTaches();
        const avant = tasks.getTasksData().rows.length;
        window.addTasksRow();
        expect(tasks.getTasksData().rows).toHaveLength(avant + 1);

        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(true);
        window.removeTasksRow(avant);
        expect(tasks.getTasksData().rows).toHaveLength(avant);
        confirmer.mockRestore();
    });

    test('modifier une cellule et un en-tête de période', () => {
        tasks.ouvrirTaches();
        window.updateTasksCell(0, 'task', 'Nouvelle tâche');
        window.updateTasksHeader('header1', '01/01/2027 au 31/03/2027');
        expect(tasks.getTasksData().rows[0].task).toBe('Nouvelle tâche');
        expect(tasks.getTasksData().header1).toBe('01/01/2027 au 31/03/2027');
    });

    test('le contenu des tâches est échappé (anti-XSS)', async () => {
        const docs = JSON.parse(JSON.stringify({ taches: TACHES }));
        docs.taches.rows[0].task = '<img src=x onerror=alert(1)>';
        const t = await chargerTasks(docs);
        t.updateTasksPreview();
        expect(document.querySelector('#tasks-preview-content img')).toBeNull();
    });
});
