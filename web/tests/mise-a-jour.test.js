/**
 * Tests du bandeau de mise à jour (js/ui/mise-a-jour.js).
 */

import { jest } from '@jest/globals';

const MARKUP = `
    <div id="maj-bandeau" class="hidden">
        <span id="maj-texte"></span>
        <button id="maj-installer" class="hidden"></button>
        <button id="maj-recharger" class="hidden"></button>
        <button id="maj-plus-tard" class="hidden"></button>
    </div>
    <div id="maj-reglages-etat"></div>
    <button id="maj-reglages-verifier"></button>
    <button id="maj-reglages-installer" class="hidden"></button>
`;

const A_JOUR = { disponible: false, nombre: 0, nouveautes: [], version_locale: 'aaaaaaa',
                 version_distante: 'aaaaaaa', verifie_le: 1791122400, raison: null };
const DISPONIBLE = { ...A_JOUR, disponible: true, nombre: 2, version_distante: 'bbbbbbb',
                     nouveautes: ['Ne plus commander', 'Correctif du post-it'] };

let maj;

beforeEach(async () => {
    document.body.innerHTML = MARKUP;
    jest.resetModules();
    maj = await import('../js/ui/mise-a-jour.js');
    maj._reinitialiser();
});

const visible = (id) => !document.getElementById(id).classList.contains('hidden');

test('à jour : pas de bandeau, les Réglages le disent', () => {
    maj.traiterEtat(A_JOUR);
    expect(visible('maj-bandeau')).toBe(false);
    expect(document.getElementById('maj-reglages-etat').textContent).toContain('à jour');
    expect(document.getElementById('maj-reglages-etat').textContent).toContain('aaaaaaa');
});

test('nouvelle version : le bandeau propose de mettre à jour', () => {
    maj.traiterEtat(DISPONIBLE);
    expect(visible('maj-bandeau')).toBe(true);
    expect(document.getElementById('maj-texte').textContent).toContain('2 changements');
    expect(visible('maj-installer')).toBe(true);
    expect(visible('maj-plus-tard')).toBe(true);
    expect(visible('maj-reglages-installer')).toBe(true);
});

test('raison affichée quand rien ne peut être proposé', () => {
    maj.traiterEtat({ ...A_JOUR, raison: "Ce dossier n'est pas un clone git" });
    expect(document.getElementById('maj-reglages-etat').textContent).toContain('clone git');
    expect(visible('maj-bandeau')).toBe(false);
});

test('installée depuis un autre poste : proposer de recharger la page', () => {
    maj.traiterEtat(A_JOUR);
    maj.traiterEtat({ ...A_JOUR, version_locale: 'ccccccc' });
    expect(visible('maj-bandeau')).toBe(true);
    expect(visible('maj-recharger')).toBe(true);
    expect(visible('maj-installer')).toBe(false);
});

test('installer : confirmation, appel au serveur puis attente du redémarrage', async () => {
    const appels = [];
    global.fetch = jest.fn(async (route, options = {}) => {
        appels.push(`${options.method || 'GET'} ${route}`);
        const corps = route === '/api/mise-a-jour' ? DISPONIBLE : { status: 'ok' };
        return { ok: true, status: 200, json: async () => corps };
    });
    window.confirm = jest.fn(() => true);
    jest.useFakeTimers();

    const promesse = maj.installerMiseAJour();
    await jest.advanceTimersByTimeAsync(0);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Ne plus commander'));
    expect(appels).toContain('POST /api/mise-a-jour/installer');
    expect(document.getElementById('maj-texte').textContent).toContain('Redémarrage');

    jest.useRealTimers();
    promesse.catch(() => {});
});

test('installer annulé : rien n\'est envoyé', async () => {
    const appels = [];
    global.fetch = jest.fn(async (route, options = {}) => {
        appels.push(`${options.method || 'GET'} ${route}`);
        return { ok: true, status: 200, json: async () => DISPONIBLE };
    });
    window.confirm = jest.fn(() => false);
    await maj.installerMiseAJour();
    expect(appels).not.toContain('POST /api/mise-a-jour/installer');
});
