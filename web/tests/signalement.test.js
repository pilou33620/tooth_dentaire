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
        corps: { type: 'bug', description: 'Le placard ne s\'ouvre plus', auteur: 'Léa' } });
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
    expect($('signalement-etat').textContent).toContain('Clé GitHub non saisie');
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
