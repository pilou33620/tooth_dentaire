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

    test('l\'animation est rechargée à l\'affichage (planning de la demi-journée en cours)', () => {
        const reload = jest.fn();
        voile().innerHTML = '<iframe></iframe>';
        Object.defineProperty(voile().querySelector('iframe'), 'contentWindow', { value: { location: { reload } } });
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000);
        expect(reload).toHaveBeenCalledTimes(1);
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

    test('la souris qui continue de bouger ne retarde pas la fin du fondu', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000 + 20);

        for (let i = 0; i < 5; i++) {
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            jest.advanceTimersByTime(200);
        }
        expect(voile().classList.contains('hidden')).toBe(true);
    });

    test('le voile ne bloque plus les clics dès le début du fondu', () => {
        screensaver.initScreensaver();
        jest.advanceTimersByTime(30 * 60 * 1000 + 20);
        expect(voile().style.pointerEvents).toBe('');

        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        expect(voile().style.pointerEvents).toBe('none');
        expect(voile().classList.contains('hidden')).toBe(false);
    });

    test('la veille suivante bloque de nouveau et se referme encore', () => {
        screensaver.initScreensaver();
        for (let i = 0; i < 2; i++) {
            jest.advanceTimersByTime(30 * 60 * 1000 + 20);
            expect(voile().classList.contains('hidden')).toBe(false);
            expect(voile().style.pointerEvents).toBe('');
            document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            jest.advanceTimersByTime(1000);
            expect(voile().classList.contains('hidden')).toBe(true);
        }
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

    test('les anciennes positions en % du journal retrouvent leur place sur la page', () => {
        // Positions réelles d'un poste : trois widgets enregistrés quand la zone
        // faisait 166 px, deux quand elle en faisait 463
        const anciennes = {
            'notes-widget': { left: '-5.55556%', top: '-361.446%', scaleX: '1', scaleY: '1' },
            'postit-wrapper': { left: '86.1111%', top: '-204.819%', scaleX: '1', scaleY: '1' },
            'team-planning-container': { left: '-11.1111%', top: '-34.5572%', scaleX: '1', scaleY: '1' },
            'tasks-planning-container': { left: '76.3889%', top: '-373.494%', scaleX: '1', scaleY: '1' },
            'checklist-widget': { left: '86.1111%', top: '8.63931%', scaleX: '1', scaleY: '1' }
        };
        document.body.innerHTML = `<main class="main-layout"><section class="bj-widgets">
            ${Object.keys(anciennes).map(id => `<div id="${id}"></div>`).join('')}
        </section></main>`;
        localStorage.setItem('ui-positions', JSON.stringify(anciennes));
        const zone = document.querySelector('.bj-widgets');
        // Comme sur la page : la zone est poussée en bas, au-dessous de l'horloge et des boutons
        zone.getBoundingClientRect = () => ({
            top: Math.max(553, 923 - parseFloat(zone.style.height || '0')), left: 240, width: 1440
        });
        document.querySelector('.main-layout').getBoundingClientRect = () => ({ top: 0, left: 0, width: 1920 });

        custom.initCustomizationMode();

        const positions = JSON.parse(localStorage.getItem('ui-positions'));
        expect(positions['tasks-planning-container'].top).toBe('137px');
        expect(positions['notes-widget'].top).toBe('157px');
        expect(positions['postit-wrapper'].top).toBe('417px');
        expect(positions['team-planning-container'].top).toBe('393px');
        expect(positions['checklist-widget'].top).toBe('593px');
        expect(parseFloat(positions['team-planning-container'].left)).toBeCloseTo(4.1667, 3);
        expect(parseFloat(positions['checklist-widget'].left)).toBeCloseTo(77.0833, 3);
        expect(zone.style.height).toBe('');
    });

    test('une position déjà en pixels n\'est pas convertie une seconde fois', () => {
        document.body.innerHTML = `<main class="main-layout"><section class="bj-widgets">
            <div id="notes-widget"></div></section></main>`;
        const position = { left: '20%', top: '157px', scaleX: 1, scaleY: 1 };
        localStorage.setItem('ui-positions', JSON.stringify({ 'notes-widget': position }));
        custom.initCustomizationMode();
        expect(JSON.parse(localStorage.getItem('ui-positions'))['notes-widget']).toEqual(position);
    });

    test('un % hors de la grille reste à l\'écran', () => {
        document.body.innerHTML = `<main class="main-layout"><section class="bj-widgets">
            <div id="notes-widget"></div></section></main>`;
        localStorage.setItem('ui-positions', JSON.stringify({
            'notes-widget': { left: '10%', top: '-333.3%', scaleX: 1, scaleY: 1 }
        }));
        expect(custom.hauteursEnregistrees([-333.3])).toEqual([null]);
        custom.initCustomizationMode();
        expect(JSON.parse(localStorage.getItem('ui-positions'))['notes-widget'].top).toBe('0px');
    });

    test('la hauteur d\'un widget replacé n\'est pas figée avant le chargement de son contenu', () => {
        localStorage.setItem('ui-positions', JSON.stringify({
            'postit-wrapper': { left: '120px', top: '80px', scaleX: 1, scaleY: 1 }
        }));
        const cible = document.getElementById('postit-wrapper');
        Object.defineProperty(cible, 'offsetHeight', { value: 91 });
        Object.defineProperty(cible, 'offsetWidth', { value: 330 });
        custom.initCustomizationMode();
        appliquerPositionsDifferees();
        expect(cible.style.width).toBe('330px');
        expect(cible.style.height).toBe('');
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

    /* DÉFAUT CONNU : loadElementPositions() (customization.js) fait un
       JSON.parse non protégé, contrairement aux deux autres lectures du même
       fichier. Une clé « ui-positions » corrompue interrompt donc
       initCustomizationMode(), et main-init.js s'arrête avec elle : l'accueil
       reste figé. Test marqué en échec attendu ; il passera au vert dès que la
       lecture sera entourée d'un try/catch retombant sur {}. */
    test.failing('un stockage corrompu ne fait pas planter l\'initialisation', () => {
        localStorage.setItem('ui-positions', '{cassé');
        localStorage.setItem('postit-pos', '{cassé aussi');
        expect(() => custom.initCustomizationMode()).not.toThrow();
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
