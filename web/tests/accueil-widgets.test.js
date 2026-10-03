/**
 * Tests des widgets de l'accueil partagés entre postes :
 * notes de l'équipe, checklist du jour et minuteurs
 * (js/features/notes.js, checklist.js, minuteurs.js).
 *
 * Les documents sont en base : un serveur factice les fournit.
 * Les prénoms utilisés sont fictifs.
 */

import { jest } from '@jest/globals';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

const MARKUP = `
    <ul id="notes-liste"></ul>
    <span id="notes-compte"></span>
    <button id="notes-annuler" class="hidden"></button>
    <form id="notes-form"><input id="notes-saisie"><button type="submit"></button></form>

    <div id="checklist-onglets">
        <button data-moment="ouverture"><span class="bj-compte"></span></button>
        <button data-moment="fermeture"><span class="bj-compte"></span></button>
    </div>
    <span id="checklist-barre"></span>
    <ul id="checklist-liste"></ul>
    <input id="checklist-qui">
    <datalist id="checklist-qui-liste"></datalist>
    <button id="checklist-modifier"></button>
    <div id="checklist-overlay" class="hidden">
        <div id="checklist-editeur"></div>
        <button id="checklist-ajouter"></button>
        <button id="checklist-enregistrer"></button>
        <button data-close="checklist-overlay"></button>
    </div>

    <aside id="minuteurs">
        <button id="minuteurs-bouton"></button>
        <span id="minuteurs-compte"></span>
        <div id="minuteurs-actifs"></div>
        <div id="minuteurs-panneau" class="hidden">
            <button id="minuteurs-modifier"></button>
            <div id="minuteurs-preselections"></div>
            <form id="minuteurs-form">
                <input id="minuteurs-nom"><input id="minuteurs-duree">
                <input type="checkbox" id="minuteurs-garder">
                <button type="submit"></button>
            </form>
        </div>
    </aside>
`;

const MODELE = [
    { id: 'o1', moment: 'ouverture', libelle: 'Purge des units' },
    { id: 'o2', moment: 'ouverture', libelle: 'Test autoclave' },
    { id: 'f1', moment: 'fermeture', libelle: 'Désinfection fauteuils' }
];

let serveur;
let api;

async function charger(chemin, documents = {}) {
    document.body.innerHTML = MARKUP;
    localStorage.clear();
    jest.resetModules();
    serveur = installerServeurFactice({ documents });
    api = await import('../js/core/api.js');
    await api.chargerEtat();
    return import(chemin);
}

afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

/* ================================================================ */
describe('notes de l\'équipe', () => {
    let notes;
    beforeEach(async () => {
        jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
        notes = await charger('../js/features/notes.js');
    });

    test('une note ajoutée est enregistrée en base', async () => {
        notes.ajouterNote('  Livraison jeudi  ', 1000);
        await attendreEcritures();
        const puts = appelsVers(serveur, 'PUT', '/api/documents/notes');
        expect(puts).toHaveLength(1);
        expect(puts[0].corps.items[0]).toMatchObject({ texte: 'Livraison jeudi', cree_le: 1000, epingle: false });
    });

    test('une note vide est ignorée', () => {
        expect(notes.ajouterNote('   ')).toBeNull();
        expect(appelsVers(serveur, 'PUT', '/api/documents/notes')).toHaveLength(0);
    });

    test('les notes épinglées passent devant, puis les plus récentes', () => {
        const tri = notes.trierNotes([
            { id: 'a', cree_le: 1, epingle: false },
            { id: 'b', cree_le: 3, epingle: false },
            { id: 'c', cree_le: 2, epingle: true }
        ]);
        expect(tri.map(n => n.id)).toEqual(['c', 'b', 'a']);
    });

    test('épingler puis désépingler', () => {
        const n = notes.ajouterNote('Technicien lundi');
        expect(notes.basculerEpingle(n.id)).toBe(true);
        expect(notes.basculerEpingle(n.id)).toBe(false);
        expect(notes.basculerEpingle('inconnue')).toBeNull();
    });

    test('effacer puis annuler remet la note à sa place', () => {
        const a = notes.ajouterNote('A', 1);
        const b = notes.ajouterNote('B', 2);
        notes.supprimerNote(a.id);
        expect(api.getDocument('notes').items.map(n => n.id)).toEqual([b.id]);
        expect(notes.annulerSuppression()).toBe(true);
        expect(api.getDocument('notes').items.map(n => n.id)).toEqual([b.id, a.id]);
        expect(notes.annulerSuppression()).toBe(false);
    });

    test('au-delà de la limite, la plus ancienne non épinglée disparaît', () => {
        const premiere = notes.ajouterNote('première', 1);
        notes.basculerEpingle(premiere.id);
        const deuxieme = notes.ajouterNote('deuxième', 2);
        for (let i = 0; i < notes.MAX_NOTES - 1; i++) notes.ajouterNote(`n${i}`, 10 + i);
        const ids = api.getDocument('notes').items.map(n => n.id);
        expect(ids).toHaveLength(notes.MAX_NOTES);
        expect(ids).toContain(premiere.id);
        expect(ids).not.toContain(deuxieme.id);
    });

    test('le texte est échappé, **gras** et retours à la ligne gérés', () => {
        expect(notes.formaterTexte('<b>x</b> **urgent**\n- gants'))
            .toBe('&lt;b&gt;x&lt;/b&gt; <strong>urgent</strong><br>• gants');
    });

    test('âge lisible de la note', () => {
        const maintenant = new Date(2026, 9, 3, 15, 0).getTime();
        const min = 60000;
        expect(notes.formaterAge(maintenant - 20000, maintenant)).toBe('à l\'instant');
        expect(notes.formaterAge(maintenant - 5 * min, maintenant)).toBe('il y a 5 min');
        expect(notes.formaterAge(maintenant - 130 * min, maintenant)).toBe('il y a 2 h');
        expect(notes.formaterAge(new Date(2026, 9, 2, 18, 0).getTime(), maintenant)).toBe('hier');
        expect(notes.formaterAge(new Date(2026, 8, 28, 9, 0).getTime(), maintenant)).toBe('le 28/09');
        expect(notes.formaterAge(0, maintenant)).toBe('');
    });

    test('saisie, affichage, épingle et effacement depuis le widget', () => {
        notes.initNotes();
        const saisie = document.getElementById('notes-saisie');
        saisie.value = 'Commander des gants';
        document.getElementById('notes-form').dispatchEvent(new Event('submit', { cancelable: true }));
        expect(saisie.value).toBe('');
        expect(document.querySelectorAll('#notes-liste li[data-id]')).toHaveLength(1);
        expect(document.getElementById('notes-compte').textContent).toBe('1');

        document.querySelector('[data-action="epingler"]').click();
        expect(document.querySelector('.bj-note-epinglee')).not.toBeNull();

        document.querySelector('[data-action="effacer"]').click();
        expect(document.querySelectorAll('#notes-liste li[data-id]')).toHaveLength(0);
        expect(document.getElementById('notes-annuler').classList.contains('hidden')).toBe(false);

        document.getElementById('notes-annuler').click();
        expect(document.querySelectorAll('#notes-liste li[data-id]')).toHaveLength(1);
    });

    test('une note ne peut pas injecter de code dans la page', () => {
        notes.ajouterNote('<img src=x onerror="alert(1)">');
        notes.afficherNotes();
        expect(document.querySelector('#notes-liste img')).toBeNull();
    });
});

/* ================================================================ */
describe('checklist du jour', () => {
    let checklist;
    const matin = new Date(2026, 9, 3, 8, 15);
    const apresMidi = new Date(2026, 9, 3, 17, 40);

    beforeEach(async () => {
        jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
        jest.setSystemTime(matin);
        checklist = await charger('../js/features/checklist.js', {
            checklist: { modele: MODELE, jour: '', fait: {} },
            planning: {
                even: [{ assistant: 'Chloé', days: {} }, { assistant: 'Alice', days: {} }],
                odd: [{ assistant: 'Alice', days: {} }, { assistant: '', days: {} }]
            }
        });
    });

    test('date et heure courtes', () => {
        expect(checklist.dateDuJour(matin)).toBe('2026-10-03');
        expect(checklist.heureCourte(matin)).toBe('08:15');
    });

    test('le matin l\'ouverture, l\'après-midi la fermeture', () => {
        expect(checklist.momentParDefaut(matin)).toBe('ouverture');
        expect(checklist.momentParDefaut(apresMidi)).toBe('fermeture');
    });

    test('cocher enregistre qui et quand, pour aujourd\'hui', async () => {
        expect(checklist.basculerTache('o1', 'Alice', matin)).toBe(true);
        await attendreEcritures();
        const doc = api.getDocument('checklist');
        expect(doc.jour).toBe('2026-10-03');
        expect(doc.fait.o1).toEqual({ qui: 'Alice', heure: '08:15' });
        expect(appelsVers(serveur, 'PUT', '/api/documents/checklist')).toHaveLength(1);
    });

    test('recliquer décoche', () => {
        checklist.basculerTache('o1', 'Alice', matin);
        expect(checklist.basculerTache('o1', 'Alice', matin)).toBe(false);
        expect(api.getDocument('checklist').fait.o1).toBeUndefined();
    });

    test('une tâche inconnue est ignorée', () => {
        expect(checklist.basculerTache('zz', 'Alice', matin)).toBeNull();
    });

    test('les coches de la veille ne comptent plus et sont effacées à la première coche du jour', () => {
        const hier = new Date(2026, 9, 2, 18, 0);
        checklist.basculerTache('o1', 'Alice', hier);
        checklist.basculerTache('o2', 'Alice', hier);
        const doc = checklist.normaliserChecklist(api.getDocument('checklist'));
        expect(checklist.progression(doc, 'ouverture', matin)).toEqual({ faits: 0, total: 2 });

        checklist.basculerTache('o2', 'Chloé', matin);
        const apres = api.getDocument('checklist');
        expect(Object.keys(apres.fait)).toEqual(['o2']);
        expect(apres.jour).toBe('2026-10-03');
    });

    test('progression par moment', () => {
        checklist.basculerTache('o1', '', matin);
        const doc = checklist.normaliserChecklist(api.getDocument('checklist'));
        expect(checklist.progression(doc, 'ouverture', matin)).toEqual({ faits: 1, total: 2 });
        expect(checklist.progression(doc, 'fermeture', matin)).toEqual({ faits: 0, total: 1 });
    });

    test('modifier la liste retire les coches des tâches supprimées', () => {
        checklist.basculerTache('o1', 'Alice', matin);
        checklist.basculerTache('o2', 'Alice', matin);
        checklist.enregistrerModele([MODELE[1], { id: 'n1', moment: 'fermeture', libelle: '  Nouvelle  ' }, { id: 'vide', libelle: ' ' }]);
        const doc = api.getDocument('checklist');
        expect(doc.modele.map(t => t.id)).toEqual(['o2', 'n1']);
        expect(doc.modele[1].libelle).toBe('Nouvelle');
        expect(Object.keys(doc.fait)).toEqual(['o2']);
    });

    test('les prénoms proposés viennent du planning, sans doublon', () => {
        expect(checklist.prenomsDuPlanning()).toEqual(['Alice', 'Chloé']);
    });

    test('le widget affiche l\'onglet du moment et coche au clic avec le prénom saisi', () => {
        checklist.initChecklist();
        const items = document.querySelectorAll('#checklist-liste .bj-tache');
        expect(items).toHaveLength(2);   // ouverture, le matin
        expect(document.querySelector('[data-moment="ouverture"]').classList.contains('actif')).toBe(true);
        expect(document.querySelectorAll('#checklist-qui-liste option')).toHaveLength(2);

        document.getElementById('checklist-qui').value = 'Chloé';
        items[0].click();
        const coche = document.querySelector('#checklist-liste .bj-tache');
        expect(coche.classList.contains('fait')).toBe(true);
        expect(coche.getAttribute('aria-checked')).toBe('true');
        expect(coche.querySelector('.bj-tache-detail').textContent).toBe('Chloé · 08:15');
        expect(document.querySelector('[data-moment="ouverture"] .bj-compte').textContent).toBe('1/2');
        expect(document.getElementById('checklist-barre').style.width).toBe('50%');
        expect(localStorage.getItem('bj-checklist-qui')).toBe('Chloé');
    });

    test('changer d\'onglet à la main', () => {
        checklist.initChecklist();
        document.querySelector('[data-moment="fermeture"]').click();
        expect(document.querySelectorAll('#checklist-liste .bj-tache')).toHaveLength(1);
        expect(checklist.ongletActif(matin)).toBe('fermeture');
        // À 13 h le choix manuel cède la place au moment par défaut
        expect(checklist.ongletActif(new Date(2026, 9, 3, 13, 5))).toBe('fermeture');
        checklist.choisirOnglet('ouverture', new Date(2026, 9, 3, 14, 0));
        expect(checklist.ongletActif(new Date(2026, 9, 4, 8, 0))).toBe('ouverture');
        expect(checklist.ongletActif(new Date(2026, 9, 4, 14, 0))).toBe('fermeture');
    });

    test('l\'éditeur ajoute, modifie, supprime puis enregistre', () => {
        checklist.initChecklist();
        document.getElementById('checklist-modifier').click();
        expect(document.getElementById('checklist-overlay').classList.contains('hidden')).toBe(false);
        expect(document.querySelectorAll('.bj-editeur-ligne')).toHaveLength(3);

        document.querySelector('[data-supprimer="0"]').click();
        document.getElementById('checklist-ajouter').click();
        const lignes = document.querySelectorAll('.bj-editeur-ligne');
        const champ = lignes[lignes.length - 1].querySelector('[data-champ="libelle"]');
        champ.value = 'Vider les poubelles';
        champ.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('checklist-enregistrer').click();

        const libelles = api.getDocument('checklist').modele.map(t => t.libelle);
        expect(libelles).toEqual(['Test autoclave', 'Désinfection fauteuils', 'Vider les poubelles']);
        expect(document.getElementById('checklist-overlay').classList.contains('hidden')).toBe(true);
    });

    test('liste vide : message d\'aide', () => {
        checklist.enregistrerModele([]);
        checklist.afficherChecklist(document, matin);
        expect(document.querySelector('#checklist-liste .bj-vide')).not.toBeNull();
    });
});

/* ================================================================ */
describe('minuteurs', () => {
    let min;
    const T0 = new Date(2026, 9, 3, 10, 0, 0).getTime();

    beforeEach(async () => {
        jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate'] });
        jest.setSystemTime(T0);
        min = await charger('../js/features/minuteurs.js', {
            minuteurs: { actifs: [], preselections: [{ libelle: 'Bain à ultrasons', minutes: 10 }] }
        });
    });

    test.each([
        ['10', 10], ['2,5', 2.5], ['1:30', 1.5], ['1h20', 80], ['2 h', 120], ['15 min', 15],
        ['', null], ['abc', null]
    ])('durée « %s » → %s min', (texte, attendu) => {
        expect(min.lireDuree(texte)).toBe(attendu);
    });

    test('affichage du temps restant', () => {
        expect(min.formaterRestant(9 * 60000 + 41000)).toBe('09:41');
        expect(min.formaterRestant(3900000)).toBe('1:05:00');
        expect(min.formaterRestant(-5000)).toBe('00:00');
        expect(min.formaterRestant(1)).toBe('00:01');
    });

    test('affichage d\'une durée de préréglage', () => {
        expect(min.formaterMinutes(10)).toBe('10 min');
        expect(min.formaterMinutes(2.5)).toBe('2,5 min');
        expect(min.formaterMinutes(60)).toBe('1 h');
        expect(min.formaterMinutes(80)).toBe('1 h 20');
        expect(min.formaterMinutes(0.5)).toBe('30 s');
    });

    test('lancer un minuteur l\'enregistre en base et le marque comme lancé ici', async () => {
        const m = min.lancerMinuteur('Trempage', 15, T0);
        await attendreEcritures();
        expect(m.fin - m.debut).toBe(15 * 60000);
        expect(api.getDocument('minuteurs').actifs).toHaveLength(1);
        expect(appelsVers(serveur, 'PUT', '/api/documents/minuteurs')).toHaveLength(1);
        expect(min.estLanceIci(m.id)).toBe(true);
    });

    test('durée invalide refusée, durée excessive bornée', () => {
        expect(min.lancerMinuteur('x', 0)).toBeNull();
        expect(min.lancerMinuteur('x', -3)).toBeNull();
        const m = min.lancerMinuteur('long', 99999, T0);
        expect(m.minutes).toBe(min.MAX_MINUTES);
    });

    test('nom par défaut', () => {
        expect(min.lancerMinuteur('  ', 5, T0).libelle).toBe('Minuteur');
    });

    test('arrêter un minuteur', () => {
        const m = min.lancerMinuteur('Trempage', 15, T0);
        expect(min.arreterMinuteur(m.id)).toBe(true);
        expect(api.getDocument('minuteurs').actifs).toHaveLength(0);
        expect(min.arreterMinuteur(m.id)).toBe(false);
    });

    test('les minuteurs terminés depuis longtemps sont retirés', () => {
        min.lancerMinuteur('vieux', 1, T0);
        min.lancerMinuteur('récent', 20, T0);
        expect(min.nettoyer(T0 + 60000 + min.GARDE_APRES_FIN)).toBe(1);
        expect(api.getDocument('minuteurs').actifs.map(m => m.libelle)).toEqual(['récent']);
        expect(min.nettoyer(T0 + 60000 + min.GARDE_APRES_FIN)).toBe(0);
    });

    test('préréglages : ajout sans doublon, suppression', () => {
        expect(min.ajouterPreselection('Temps de pose', 3)).toBe(true);
        expect(min.ajouterPreselection('bain à ultrasons', 12)).toBe(true);
        const p = api.getDocument('minuteurs').preselections;
        expect(p.map(x => x.libelle)).toEqual(['Temps de pose', 'bain à ultrasons']);
        expect(p[1].minutes).toBe(12);
        expect(min.supprimerPreselection(0)).toBe(true);
        expect(min.supprimerPreselection(5)).toBe(false);
        expect(min.ajouterPreselection('', 3)).toBe(false);
    });

    test('compte à rebours, puis « Terminé » et titre de l\'onglet', () => {
        document.title = 'Cabinet';
        min.lancerMinuteur('Temps de pose', 0.5, T0);
        min.afficherMinuteurs(document, T0 + 10000);
        expect(document.querySelector('.bj-minuteur-temps').textContent).toBe('00:20');
        expect(document.getElementById('minuteurs-compte').textContent).toBe('1');

        // Une seconde plus tard, la même pastille est mise à jour (pas recréée)
        const pastille = document.querySelector('.bj-minuteur');
        min.afficherMinuteurs(document, T0 + 11000);
        expect(document.querySelector('.bj-minuteur')).toBe(pastille);
        expect(pastille.querySelector('.bj-minuteur-temps').textContent).toBe('00:19');

        min.afficherMinuteurs(document, T0 + 31000);
        expect(document.querySelector('.bj-minuteur').classList.contains('fini')).toBe(true);
        expect(document.querySelector('.bj-minuteur-temps').textContent).toBe('Terminé');
        expect(document.getElementById('minuteurs').classList.contains('bj-sonne')).toBe(true);
        expect(document.title).toBe('⏰ Temps de pose — terminé');

        min.arreterMinuteur(document.querySelector('.bj-minuteur').dataset.id);
        min.afficherMinuteurs(document, T0 + 32000);
        expect(document.title).toBe('Cabinet');
        min.couperSonnerie();
    });

    test('un minuteur lancé sur un autre poste s\'affiche aussi', async () => {
        min = await charger('../js/features/minuteurs.js', {
            minuteurs: { actifs: [{ id: 'autre1', libelle: 'Séchage', debut: T0, fin: T0 + 20 * 60000, minutes: 20 }], preselections: [] }
        });
        min.afficherMinuteurs(document, T0 + 60000);
        expect(document.querySelector('.bj-minuteur-nom').textContent).toBe('Séchage');
        expect(document.querySelector('.bj-minuteur-temps').textContent).toBe('19:00');
        expect(min.estLanceIci('autre1')).toBe(false);
    });

    test('depuis le panneau : préréglage, durée libre gardée en préréglage, arrêt', () => {
        min.initMinuteurs();
        document.getElementById('minuteurs-bouton').click();
        expect(document.getElementById('minuteurs-panneau').classList.contains('hidden')).toBe(false);

        document.querySelector('[data-preselection="0"]').click();
        expect(api.getDocument('minuteurs').actifs[0].libelle).toBe('Bain à ultrasons');

        document.getElementById('minuteurs-nom').value = 'Temps de pose';
        document.getElementById('minuteurs-duree').value = '3';
        document.getElementById('minuteurs-garder').checked = true;
        document.getElementById('minuteurs-form').dispatchEvent(new Event('submit', { cancelable: true }));
        const doc = api.getDocument('minuteurs');
        expect(doc.actifs).toHaveLength(2);
        expect(doc.preselections.map(p => p.libelle)).toContain('Temps de pose');
        expect(document.querySelectorAll('#minuteurs-preselections [data-preselection]')).toHaveLength(2);

        document.querySelector('[data-arreter]').click();
        expect(api.getDocument('minuteurs').actifs).toHaveLength(1);
    });

    test('durée illisible : rien n\'est lancé', () => {
        min.initMinuteurs();
        document.getElementById('minuteurs-duree').value = 'bientôt';
        document.getElementById('minuteurs-form').dispatchEvent(new Event('submit', { cancelable: true }));
        expect(api.getDocument('minuteurs').actifs).toHaveLength(0);
    });

    test('mode « Modifier » : on retire un préréglage sans le lancer', () => {
        min.initMinuteurs();
        document.getElementById('minuteurs-modifier').click();
        document.querySelector('[data-supprimer-preselection="0"]').click();
        const doc = api.getDocument('minuteurs');
        expect(doc.preselections).toHaveLength(0);
        expect(doc.actifs).toHaveLength(0);
    });

    test('le compte à rebours avance tout seul', () => {
        min.initMinuteurs();
        min.lancerMinuteur('Trempage', 15, T0);
        jest.advanceTimersByTime(2000);
        expect(document.querySelector('.bj-minuteur-temps').textContent).toBe('14:58');
    });
});
