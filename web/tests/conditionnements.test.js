/**
 * Tests unitaires pour les conditionnements (unité / carton / boîte)
 */

import { CONDITIONNEMENTS, estConditionnementGroupe } from '../js/core/constants.js';

describe('Conditionnements', () => {

    test('les trois conditionnements sont disponibles', () => {
        expect(Object.keys(CONDITIONNEMENTS)).toEqual(['unite', 'carton', 'boite']);
    });

    test('chaque conditionnement groupé a ses libellés de saisie', () => {
        for (const cond of Object.values(CONDITIONNEMENTS)) {
            expect(cond.labelCourt).toBeTruthy();
            if (cond.groupe) {
                expect(cond.labelQteParContenant).toBeTruthy();
                expect(cond.labelNbContenants).toBeTruthy();
                expect(cond.labelVrac).toBeTruthy();
            }
        }
    });

    test('estConditionnementGroupe distingue unité et contenants', () => {
        expect(estConditionnementGroupe('unite')).toBe(false);
        expect(estConditionnementGroupe('carton')).toBe(true);
        expect(estConditionnementGroupe('boite')).toBe(true);
    });

    test('estConditionnementGroupe tolère les valeurs inconnues ou vides', () => {
        expect(estConditionnementGroupe('')).toBe(false);
        expect(estConditionnementGroupe(undefined)).toBe(false);
        expect(estConditionnementGroupe('palette')).toBe(false);
    });
});
