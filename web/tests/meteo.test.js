/**
 * Tests de la météo de l'accueil (js/ui/meteo.js) : interprétation,
 * affichage à côté de la date, attributs qui pilotent le fond, et réglage
 * de la commune du cabinet. Le serveur (et donc MET Norway) est simulé.
 */

import { jest } from '@jest/globals';

const MARKUP = `
    <span id="bj-meteo" class="hidden"></span>
    <canvas id="bj-meteo-canvas"></canvas>
    <input id="bj-meteo-recherche">
    <button id="bj-meteo-chercher"></button>
    <ul id="bj-meteo-resultats"></ul>
    <p id="bj-meteo-etat"></p>
    <button id="bj-meteo-retirer" class="hidden"></button>
`;

const PLUIE = { categorie: 'pluie', intensite: 'forte', nuit: null, libelle: 'Forte pluie', temperature: 9 };

let reponses;
let appels;
let meteo;

function installerFetch() {
    appels = [];
    global.fetch = jest.fn(async (url, options = {}) => {
        const methode = options.method || 'GET';
        const route = String(url).split('?')[0];
        appels.push({ methode, url: String(url), corps: options.body ? JSON.parse(options.body) : undefined });
        let statut = 200;
        let data = {};
        if (route === '/api/etat') data = { base: {}, documents: reponses.documents };
        else if (route === '/api/meteo') data = reponses.meteo;
        else if (route === '/api/meteo/communes') ({ statut, data } = reponses.communes);
        else if (route.startsWith('/api/documents/') && methode === 'PUT') {
            reponses.documents[decodeURIComponent(route.slice(15))] = JSON.parse(options.body);
        }
        return {
            ok: statut < 400,
            status: statut,
            json: async () => ({ status: statut < 400 ? 'ok' : 'error', revision: 'x-1', ...data })
        };
    });
}

beforeEach(async () => {
    document.body.innerHTML = MARKUP;
    document.documentElement.dataset.bjFond = 'dynamique';
    document.documentElement.dataset.bjMeteoFond = 'oui';
    reponses = {
        documents: { meteo_lieu: { nom: '', lat: null, lon: null } },
        meteo: { meteo: null, raison: 'lieu', lieu: '' },
        communes: { statut: 200, data: { communes: [] } }
    };
    installerFetch();
    jest.resetModules();
    const api = await import('../js/core/api.js');
    await api.chargerEtat();
    meteo = await import('../js/ui/meteo.js');
});

const racine = () => document.documentElement.dataset;

describe('interprétation', () => {
    test('texte affiché', () => {
        expect(meteo.texteMeteo(PLUIE)).toBe('9° · Forte pluie');
        expect(meteo.texteMeteo({ libelle: 'Couvert', temperature: null })).toBe('Couvert');
        expect(meteo.texteMeteo(null)).toBe('');
    });

    test('jour ou nuit : le symbole d\'abord, sinon l\'heure', () => {
        const midi = new Date(2026, 9, 3, 12, 0);
        const minuit = new Date(2026, 9, 3, 23, 30);
        expect(meteo.estNuitMeteo({ nuit: true }, midi)).toBe(true);
        expect(meteo.estNuitMeteo({ nuit: false }, minuit)).toBe(false);
        expect(meteo.estNuitMeteo({ nuit: null }, minuit)).toBe(true);
        expect(meteo.estNuitMeteo({ nuit: null }, midi)).toBe(false);
    });

    test('particules selon le temps', () => {
        expect(meteo.particulesPour('pluie', 'faible')).toEqual({ type: 'pluie', nombre: 70 });
        expect(meteo.particulesPour('pluie', 'forte').nombre).toBeGreaterThan(meteo.particulesPour('pluie').nombre);
        expect(meteo.particulesPour('orage').type).toBe('pluie');
        expect(meteo.particulesPour('neige').type).toBe('neige');
        expect(meteo.particulesPour('clair', 'moyenne', true).type).toBe('etoiles');
        expect(meteo.particulesPour('clair', 'moyenne', false)).toBeNull();
        expect(meteo.particulesPour('couvert')).toBeNull();
    });

    test('une icône par temps, version nuit quand elle existe', () => {
        expect(meteo.iconeMeteo('clair')).toContain('<svg');
        expect(meteo.iconeMeteo('clair', true)).not.toBe(meteo.iconeMeteo('clair'));
        expect(meteo.iconeMeteo('pluie', true)).toBe(meteo.iconeMeteo('pluie'));
        expect(meteo.iconeMeteo('inconnu')).toBe('');
    });
});

describe('affichage', () => {
    test('le fond et la ligne de date suivent la météo', () => {
        meteo.appliquerMeteo(PLUIE, document, new Date(2026, 9, 3, 10, 0));
        expect(racine().bjMeteo).toBe('pluie');
        expect(racine().bjMeteoIntensite).toBe('forte');
        expect(racine().bjMeteoNuit).toBe('non');
        const zone = document.getElementById('bj-meteo');
        expect(zone.classList.contains('hidden')).toBe(false);
        expect(zone.textContent).toBe('9° · Forte pluie');
        expect(zone.querySelector('svg')).not.toBeNull();
    });

    test('sans météo, rien ne s\'affiche et le fond suit l\'heure', () => {
        meteo.appliquerMeteo(PLUIE);
        meteo.appliquerMeteo(null);
        expect(racine().bjMeteo).toBe('');
        expect(document.getElementById('bj-meteo').classList.contains('hidden')).toBe(true);
    });

    test('fond « Paysage » : le décor est dessiné avec la météo', () => {
        document.body.insertAdjacentHTML('beforeend', '<div id="bj-paysage"></div>');
        document.documentElement.dataset.bjFond = 'paysage';
        document.documentElement.dataset.bjPhase = 'jour';
        meteo.appliquerMeteo({ categorie: 'neige', intensite: 'moyenne', nuit: false, libelle: 'Neige', temperature: -1 });
        expect(document.querySelector('#bj-paysage svg')).not.toBeNull();
        expect(document.querySelector('#bj-paysage .bj-p-soleil')).toBeNull();
    });

    test('une catégorie inconnue est ignorée', () => {
        meteo.appliquerMeteo({ categorie: 'tempete-de-sable', temperature: 30 });
        expect(racine().bjMeteo).toBe('');
    });

    test('le libellé ne peut pas injecter de code', () => {
        meteo.appliquerMeteo({ ...PLUIE, libelle: '<img src=x onerror=alert(1)>' });
        expect(document.querySelector('#bj-meteo img')).toBeNull();
    });
});

describe('chargement depuis le serveur', () => {
    test('aucune commune : message dans les réglages', async () => {
        await meteo.chargerMeteo();
        expect(racine().bjMeteo).toBe('');
        expect(document.getElementById('bj-meteo-etat').textContent).toMatch(/Aucune commune/);
    });

    test('météo reçue', async () => {
        reponses.documents.meteo_lieu = { nom: 'Saint-André-de-Cubzac', lat: 45, lon: -0.44 };
        const api = await import('../js/core/api.js');
        await api.chargerEtat();
        reponses.meteo = { meteo: PLUIE, raison: null, lieu: 'Saint-André-de-Cubzac' };
        await meteo.chargerMeteo();
        expect(racine().bjMeteo).toBe('pluie');
        expect(document.getElementById('bj-meteo').title).toBe('Météo à Saint-André-de-Cubzac');
        expect(document.getElementById('bj-meteo-etat').textContent).toBe('Saint-André-de-Cubzac : 9° · Forte pluie.');
        expect(document.getElementById('bj-meteo-retirer').classList.contains('hidden')).toBe(false);
    });

    test('serveur sans internet : on garde la dernière météo connue', async () => {
        reponses.meteo = { meteo: PLUIE, raison: null, lieu: 'X' };
        await meteo.chargerMeteo();
        global.fetch = jest.fn(async () => { throw new Error('réseau'); });
        await meteo.chargerMeteo();
        expect(racine().bjMeteo).toBe('pluie');
        expect(meteo.meteoCourante()).toEqual(PLUIE);
    });
});

describe('commune du cabinet', () => {
    test('recherche puis choix : enregistré en base pour tous les postes', async () => {
        reponses.communes = { statut: 200, data: { communes: [
            { nom: 'Saint-André-de-Cubzac', detail: '33240 · Gironde', lat: 45.0, lon: -0.44 }
        ] } };
        meteo.initMeteo();
        const champ = document.getElementById('bj-meteo-recherche');
        champ.value = 'Saint-André';
        document.getElementById('bj-meteo-chercher').click();
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));

        const appelRecherche = appels.find(a => a.url.startsWith('/api/meteo/communes'));
        expect(appelRecherche.url).toBe('/api/meteo/communes?q=Saint-Andr%C3%A9');
        const bouton = document.querySelector('#bj-meteo-resultats [data-index="0"]');
        expect(bouton.textContent).toContain('Saint-André-de-Cubzac');

        reponses.meteo = { meteo: PLUIE, raison: null, lieu: 'Saint-André-de-Cubzac' };
        bouton.click();
        for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
        const put = appels.find(a => a.methode === 'PUT' && a.url === '/api/documents/meteo_lieu');
        expect(put.corps).toEqual({ nom: 'Saint-André-de-Cubzac', lat: 45.0, lon: -0.44 });
        expect(racine().bjMeteo).toBe('pluie');
        expect(document.getElementById('bj-meteo-resultats').innerHTML).toBe('');
    });

    test('recherche impossible : le message du serveur est affiché', async () => {
        reponses.communes = { statut: 503, data: { message: 'Recherche impossible : le serveur n\'a pas accès à internet.' } };
        meteo.initMeteo();
        document.getElementById('bj-meteo-recherche').value = 'Bordeaux';
        document.getElementById('bj-meteo-chercher').click();
        for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
        expect(document.getElementById('bj-meteo-etat').textContent).toMatch(/internet/);
    });

    test('retirer la commune', async () => {
        await meteo.choisirCommune(null);
        const put = appels.find(a => a.methode === 'PUT' && a.url === '/api/documents/meteo_lieu');
        expect(put.corps).toEqual({ nom: '', lat: null, lon: null });
    });
});
