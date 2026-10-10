/**
 * Tests des modules d'interface : économiseur d'écran, indicateur de zoom
 * et mode personnalisation (js/ui/).
 */

import { jest } from '@jest/globals';

const MARKUP = `
    <div id="screensaver-overlay" class="hidden"></div>
    <div id="customization-banner" class="hidden">
        <button id="btn-exit-customization"></button>
        <button id="btn-reset-customization"></button>
    </div>
    <div id="datetime-container"></div>
    <div id="postit-wrapper"></div>
    <div id="checklist-widget"></div>
    <div id="notes-widget"></div>
    <div class="action-area"></div>
    <div class="backsplash"></div>
    <div class="countertop"></div>
`;

async function charger(chemin) {
    document.body.innerHTML = MARKUP;
    localStorage.clear();
    jest.resetModules();
    return import(chemin);
}

describe('économiseur d\'écran', () => {
    let screensaver;

    beforeEach(async () => {
        jest.useFakeTimers();
        screensaver = await charger('../js/ui/screensaver.js');
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    function voile() { return document.getElementById('screensaver-overlay'); }

    test('rien ne s\'affiche avant le délai d\'inactivité', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(29 * 60 * 1000);
        expect(voile().classList.contains('hidden')).toBe(true);
    });

    test('le voile apparaît après 30 minutes d\'inactivité', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000);
        expect(voile().classList.contains('hidden')).toBe(false);
    });

    test('le fondu d\'apparition est déclenché', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000 + 20);
        expect(voile().style.opacity).toBe('1');
    });

    test('une activité repousse le déclenchement', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(25 * 60 * 1000);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        jest.advanceTimersByTime(25 * 60 * 1000);
        expect(voile().classList.contains('hidden')).toBe(true);
    });

    test('chaque type d\'interaction réarme le compteur', () => {
        for (const type of ['mousedown', 'keydown', 'touchstart', 'scroll', 'click']) {
            document.body.innerHTML = MARKUP;
            jest.clearAllTimers();
            screensaver.initScreensaver();
            jest.advanceTimersByTime(29 * 60 * 1000);
            document.dispatchEvent(new Event(type, { bubbles: true }));
            jest.advanceTimersByTime(29 * 60 * 1000);
            expect(voile().classList.contains('hidden')).toBe(true);
        }
    });

    test('une activité pendant la veille la fait disparaître en fondu', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000 + 20);
        expect(voile().classList.contains('hidden')).toBe(false);

        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        expect(voile().style.opacity).toBe('0');

        jest.advanceTimersByTime(1000);
        expect(voile().classList.contains('hidden')).toBe(true);
    });

    test('l\'absence de voile dans la page ne fait rien planter', () => {
        document.getElementById('screensaver-overlay').remove();
        expect(() => {
            screensaver.initScreensaver();
            jest.advanceTimersByTime(31 * 60 * 1000);
        }).not.toThrow();
    });
});

describe('indicateur de zoom', () => {
    let zoom;

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        zoom = await charger('../js/ui/zoom-indicator.js');
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
        console.log.mockRestore();
    });

    function indicateur() { return document.getElementById('zoom-indicator'); }

    test('l\'indicateur est ajouté à la page', () => {
        zoom.initZoomIndicator();
        expect(indicateur()).not.toBeNull();
        expect(indicateur().textContent).toMatch(/^Zoom: \d+%$/);
    });

    test('il ne capte pas les clics', () => {
        zoom.initZoomIndicator();
        expect(indicateur().style.pointerEvents).toBe('none');
    });

    test('il s\'affiche puis se masque au bout d\'une seconde et demie', () => {
        zoom.initZoomIndicator();
        expect(indicateur().style.opacity).toBe('1');
        jest.advanceTimersByTime(1500);
        expect(indicateur().style.opacity).toBe('0');
    });

    test('un redimensionnement le réaffiche', () => {
        zoom.initZoomIndicator();
        jest.advanceTimersByTime(1500);
        window.dispatchEvent(new Event('resize'));
        jest.advanceTimersByTime(1500);
        expect(indicateur()).not.toBeNull();
    });

    test('la molette ne fait pas planter la mesure', () => {
        zoom.initZoomIndicator();
        expect(() => {
            document.dispatchEvent(new Event('wheel'));
            jest.advanceTimersByTime(1500);
        }).not.toThrow();
    });

    test('l\'élément de mesure temporaire est retiré de la page', () => {
        zoom.initZoomIndicator();
        expect(document.body.querySelectorAll('div[style*="100vw"]')).toHaveLength(0);
    });
});

describe('mode personnalisation', () => {
    let custom;

    beforeEach(async () => {
        jest.useFakeTimers();
        custom = await charger('../js/ui/customization.js');
    });

    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    /* jsdom ne calcule pas de mise en page : getBoundingClientRect() renvoie 0,
       et loadElementPositions() diffère alors l'application de 300 ms. */
    function appliquerPositionsDifferees() {
        jest.advanceTimersByTime(300);
    }

    test('activer le mode marque le corps de page et affiche le bandeau', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        expect(document.body.classList.contains('customization-active')).toBe(true);
        expect(document.getElementById('customization-banner').classList.contains('hidden'))
            .toBe(false);
    });

    test('les éléments déplaçables reçoivent leur poignée', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        const cible = document.getElementById('postit-wrapper');
        expect(cible.classList.contains('draggable-item')).toBe(true);
        expect(cible.querySelector('.resize-handle')).not.toBeNull();
    });

    test('la checklist et les notes de l\'accueil sont déplaçables', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        for (const id of ['checklist-widget', 'notes-widget']) {
            const cible = document.getElementById(id);
            expect(cible.classList.contains('draggable-item')).toBe(true);
            expect(cible.querySelector('.resize-handle')).not.toBeNull();
        }
    });

    test('les fonds redimensionnables reçoivent leur poignée', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        const fond = document.querySelector('.backsplash');
        expect(fond.classList.contains('resizable-bg-item')).toBe(true);
        expect(fond.querySelector('.bg-resize-handle')).not.toBeNull();
    });

    test('quitter le mode retire classes et poignées', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        window.toggleCustomizationMode(false);

        const cible = document.getElementById('postit-wrapper');
        expect(cible.classList.contains('draggable-item')).toBe(false);
        expect(cible.querySelector('.resize-handle')).toBeNull();
        expect(document.body.classList.contains('customization-active')).toBe(false);
        expect(document.getElementById('customization-banner').classList.contains('hidden'))
            .toBe(true);
    });

    test('activer deux fois de suite ne duplique pas les poignées', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        window.toggleCustomizationMode(true);
        expect(document.getElementById('postit-wrapper')
            .querySelectorAll('.resize-handle')).toHaveLength(1);
    });

    test('le bouton du bandeau quitte le mode', () => {
        custom.initCustomizationMode();
        window.toggleCustomizationMode(true);
        document.getElementById('btn-exit-customization').click();
        expect(document.body.classList.contains('customization-active')).toBe(false);
    });

    test('les positions enregistrées sont appliquées au chargement', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            'postit-wrapper': { left: '120px', top: '80px', scaleX: 1, scaleY: 1 }
        }));
        custom.initCustomizationMode();
        appliquerPositionsDifferees();
        const cible = document.getElementById('postit-wrapper');
        expect(cible.style.position).toBe('absolute');
        expect(cible.style.left).toBe('120px');
        expect(cible.style.top).toBe('80px');
    });

    test('une échelle enregistrée est réappliquée', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            'postit-wrapper': { left: '10px', top: '10px', scaleX: 1.5, scaleY: 2 }
        }));
        custom.initCustomizationMode();
        appliquerPositionsDifferees();
        const cible = document.getElementById('postit-wrapper');
        expect(cible.style.transform).toBe('scale(1.5, 2)');
        expect(cible.style.transformOrigin).toBe('top left');
    });

    test('une entrée sans position n\'est pas passée en absolu', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            'postit-wrapper': { minHeight: '300px' }
        }));
        custom.initCustomizationMode();
        expect(document.getElementById('postit-wrapper').style.position).toBe('');
    });

    test('la hauteur d\'un fond redimensionnable est restituée', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            backsplash: { minHeight: '250px', flex: '0 0 auto' }
        }));
        custom.initCustomizationMode();
        const fond = document.querySelector('.backsplash');
        expect(fond.style.minHeight).toBe('250px');
        expect(fond.style.flex).toBe('0 0 auto');
    });

    test('l\'ancienne clé « postit-pos » est migrée puis supprimée', () => {
        localStorage.setItem('postit-pos', JSON.stringify({ left: '5px', top: '6px' }));
        custom.initCustomizationMode();
        const positions = JSON.parse(localStorage.getItem('ui-positions'));
        expect(positions['postit-wrapper']).toEqual({ left: '5px', top: '6px' });
        expect(localStorage.getItem('postit-pos')).toBeNull();
    });

    test('la migration n\'écrase pas une position déjà enregistrée', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            'postit-wrapper': { left: '99px', top: '99px' }
        }));
        localStorage.setItem('postit-pos', JSON.stringify({ left: '5px', top: '6px' }));
        custom.initCustomizationMode();
        expect(JSON.parse(localStorage.getItem('ui-positions'))['postit-wrapper'].left)
            .toBe('99px');
    });

    test('l\'ancienne hauteur du plan de travail est oubliée', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            countertop: { minHeight: '600px', flex: '1' }
        }));
        custom.initCustomizationMode();
        expect(JSON.parse(localStorage.getItem('ui-positions')).countertop).toBeUndefined();
        expect(document.querySelector('.countertop').style.minHeight).toBe('');
    });

    // Une clé « ui-positions » corrompue est remise à zéro au lieu
    // d'interrompre initCustomizationMode() (et toute l'initialisation).
    test('un stockage corrompu ne fait pas planter l\'initialisation', () => {
        localStorage.setItem('ui-positions', '{cassé');
        localStorage.setItem('postit-pos', '{cassé aussi');
        expect(() => custom.initCustomizationMode()).not.toThrow();
        expect(localStorage.getItem('ui-positions')).toBe('{}');
    });

    test('« null » ou une entrée non objet ne bloquent pas non plus', () => {
        localStorage.setItem('ui-positions', 'null');
        expect(() => custom.initCustomizationMode()).not.toThrow();
        localStorage.setItem('ui-positions', JSON.stringify({ x: 'texte', y: null }));
        expect(custom.lirePositions()).toEqual({});
    });

    test('la réinitialisation demande confirmation avant d\'effacer', () => {
        localStorage.setItem('ui-positions', JSON.stringify({ x: 1 }));
        custom.initCustomizationMode();
        const confirmer = jest.spyOn(window, 'confirm').mockReturnValue(false);
        document.getElementById('btn-reset-customization').click();
        expect(localStorage.getItem('ui-positions')).not.toBeNull();
        confirmer.mockRestore();
    });
});
