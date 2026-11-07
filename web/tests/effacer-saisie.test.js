/**
 * Tests de la croix qui vide la zone de texte active (js/ui/effacer-saisie.js).
 */

import { jest } from '@jest/globals';

describe('croix d\'effacement des zones de texte', () => {
    const croix = () => document.querySelector('button[aria-label="Tout effacer"]');

    function champ(html, largeur = 200) {
        document.body.insertAdjacentHTML('beforeend', html);
        const el = document.body.lastElementChild;
        el.getBoundingClientRect = () => ({ top: 100, right: 300, width: largeur, height: 30 });
        return el;
    }

    beforeEach(async () => {
        document.body.innerHTML = '<div id="screensaver-overlay"></div>';
        jest.resetModules();
        await import('../js/ui/effacer-saisie.js');
    });

    afterEach(() => {
        document.activeElement?.blur();
    });

    test('elle apparaît sur le champ actif seulement s\'il contient du texte', () => {
        const el = champ('<input type="text">');
        el.focus();
        expect(croix().style.display).toBe('none');
        el.value = 'abc';
        el.blur();
        el.focus();
        expect(croix().style.display).toBe('block');
        expect(croix().style.left).toBe('278px');
        el.blur();
        expect(croix().style.display).toBe('none');
    });

    test('elle vide le champ et prévient les filtres et les enregistrements', () => {
        const el = champ('<input type="text" value="abc">');
        const evenements = [];
        el.addEventListener('input', () => evenements.push('input'));
        el.addEventListener('change', () => evenements.push('change'));
        el.focus();
        croix().click();
        expect(el.value).toBe('');
        expect(evenements).toEqual(['input', 'change']);
    });

    test('elle marche aussi sur une zone de plusieurs lignes', () => {
        const el = champ('<textarea>abc</textarea>');
        el.focus();
        croix().click();
        expect(el.value).toBe('');
    });

    test('cliquer sur la croix ne retire pas le focus du champ', () => {
        const appui = new MouseEvent('mousedown', { cancelable: true, bubbles: true });
        croix().dispatchEvent(appui);
        expect(appui.defaultPrevented).toBe(true);
    });

    test.each([
        ['lecture seule', '<input type="text" value="abc" readonly>'],
        ['désactivé', '<input type="text" value="abc" disabled>'],
        ['date', '<input type="date" value="2026-11-07">'],
        ['nombre', '<input type="number" value="3">']
    ])('pas de croix sur un champ %s', (_nom, html) => {
        const el = champ(html);
        el.focus();
        expect(croix().style.display).toBe('none');
    });

    test('pas de croix sur un champ trop étroit', () => {
        const el = champ('<input type="text" value="5">', 50);
        el.focus();
        expect(croix().style.display).toBe('none');
    });

    test('elle reste sous le voile de veille', () => {
        expect(croix().nextElementSibling.id).toBe('screensaver-overlay');
    });
});
