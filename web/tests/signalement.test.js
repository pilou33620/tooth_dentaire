/**
 * Tests du formulaire « Signaler un bug / proposer une idée » (js/ui/signalement.js).
 */

import { jest } from '@jest/globals';

const MARKUP = `
    <button id="btn-settings"></button>
    <button id="signalement-ouvrir"></button>
    <form id="signalement-form" class="hidden">
        <select id="signalement-type"><option value="bug">Bug</option><option value="idee">Idée</option></select>
        <textarea id="signalement-description"></textarea>
        <input id="signalement-auteur">
        <button type="submit" id="signalement-envoyer"></button>
        <button type="button" id="signalement-annuler"></button>
    </form>
    <p id="signalement-etat"></p>
    <a id="signalement-gmail" class="hidden"></a>
    <div class="bj-widget" data-widget="notes"></div>
    <div id="signalement-cle" class="hidden">
        <ol id="signalement-cle-guide"></ol>
        <input id="signalement-cle-saisie">
        <button id="signalement-cle-enregistrer"></button>
    </div>
`;

let requetes;
let reponses;

function installerFetch() {
    requetes = [];
    globalThis.fetch = async (route, options = {}) => {
        const corps = options.body ? JSON.parse(options.body) : undefined;
        requetes.push({ methode: options.method, route, corps });
        const r = reponses[`${options.method} ${route}`];
        const data = typeof r === 'function' ? r(corps) : r;
        return { ok: data.status !== 'error', status: data.status === 'error' ? 400 : 200, json: async () => data };
    };
}

const attendre = () => new Promise(r => setTimeout(r, 0));
const $ = (id) => document.getElementById(id);
const visible = (id) => !$(id).classList.contains('hidden');

async function charger(etat) {
    document.body.innerHTML = MARKUP;
    reponses = {
        'GET /api/signalements': etat,
        'POST /api/signalements': { status: 'ok', envoye: true },
        'POST /api/signalements/cle': { status: 'ok', cle_configuree: true, en_attente: 0, cle_modifiable: true }
    };
    installerFetch();
    jest.resetModules();
    const m = await import('../js/ui/signalement.js');
    m.initSignalement();
    await attendre();
}

test('envoi d\'un bug : le formulaire part au serveur puis se referme', async () => {
    await charger({ status: 'ok', cle_configuree: true, en_attente: 0, cle_modifiable: false });
    expect(visible('signalement-cle')).toBe(false);
    $('signalement-ouvrir').click();
    expect(visible('signalement-form')).toBe(true);
    $('signalement-description').value = 'Le placard ne s\'ouvre plus';
    $('signalement-auteur').value = 'Léa';
    $('signalement-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await attendre();
    expect(requetes.at(-1)).toEqual({ methode: 'POST', route: '/api/signalements',
        corps: { type: 'bug', description: 'Le placard ne s\'ouvre plus', auteur: 'Léa',
            journaux: expect.stringContaining('Widgets : notes 0x0') } });
    expect(visible('signalement-form')).toBe(false);
    expect($('signalement-description').value).toBe('');
    expect($('signalement-etat').textContent).toContain('bien été envoyé');
});

test('sans internet : le signalement est gardé et on le dit', async () => {
    await charger({ status: 'ok', cle_configuree: true, en_attente: 0, cle_modifiable: false });
    reponses['POST /api/signalements'] = { status: 'ok', envoye: false, en_attente: 1 };
    $('signalement-ouvrir').click();
    $('signalement-description').value = 'Une idée';
    $('signalement-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await attendre();
    expect($('signalement-etat').textContent).toContain('partira dès que possible');
});

test('erreur du serveur : le formulaire reste ouvert avec le message', async () => {
    await charger({ status: 'ok', cle_configuree: true, en_attente: 0, cle_modifiable: false });
    reponses['POST /api/signalements'] = { status: 'error', message: 'Décrire le problème.' };
    $('signalement-ouvrir').click();
    $('signalement-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await attendre();
    expect(visible('signalement-form')).toBe(true);
    expect($('signalement-etat').textContent).toContain('Décrire le problème.');
});

test('poste serveur sans clé : la saisie de la clé est proposée et enregistrée', async () => {
    await charger({ status: 'ok', cle_configuree: false, en_attente: 2, cle_modifiable: true });
    expect(visible('signalement-cle')).toBe(true);
    expect(visible('signalement-cle-guide')).toBe(true);
    expect($('signalement-etat').textContent).toBe('');
    $('signalement-cle-saisie').value = 'github_pat_x';
    $('signalement-cle-enregistrer').click();
    await attendre();
    expect(requetes.at(-1).corps).toEqual({ cle: 'github_pat_x' });
    expect($('signalement-cle-saisie').value).toBe('');
    expect($('signalement-etat').textContent).toContain('Clé GitHub enregistrée');
    // Clé en place : plus de guide, le champ reste pour la remplacer
    expect(visible('signalement-cle-guide')).toBe(false);
    expect(visible('signalement-cle')).toBe(true);
});

test('sans clé GitHub : Gmail s\'ouvre avec le message prêt pour le développeur', async () => {
    await charger({ status: 'ok', cle_configuree: false, en_attente: 0, cle_modifiable: false });
    reponses['POST /api/signalements'] = { status: 'ok', envoye: false,
        ticket: { title: '[Bug] Widgets absents', body: 'Au démarrage\n\nJournal…' } };
    const ouvertes = [];
    window.open = (url) => { ouvertes.push(url); return null; };
    window.lireJournal = () => '2026-10-30T08:00:00Z [erreur] boum';
    $('signalement-ouvrir').click();
    $('signalement-description').value = 'Widgets absents';
    $('signalement-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await attendre();
    expect(requetes.at(-1).corps.journaux).toContain('[erreur] boum');
    const url = new URL(ouvertes[0]);
    expect(url.host).toBe('mail.google.com');
    expect(url.searchParams.get('to')).toBe('pilou33620@gmail.com');
    expect(url.searchParams.get('su')).toBe('[Bug] Widgets absents');
    expect(url.searchParams.get('body')).toBe('Au démarrage\n\nJournal…');
    expect(visible('signalement-gmail')).toBe(true);
    expect($('signalement-gmail').href).toBe(ouvertes[0]);
    expect($('signalement-etat').textContent).toContain('cliquer « Envoyer »');
});

test('message trop long pour Gmail : raccourci, la version complète sera jointe', async () => {
    const { lienGmail } = await import('../js/ui/signalement.js');
    const court = lienGmail({ title: 'T', body: 'court' });
    expect(court.coupe).toBe(false);
    const long = lienGmail({ title: 'T', body: 'é'.repeat(20000) }, 3000);
    expect(long.coupe).toBe(true);
    expect(long.url.length).toBeLessThanOrEqual(3000);
    expect(new URL(long.url).searchParams.get('body')).toContain('suite dans le fichier joint');
});
