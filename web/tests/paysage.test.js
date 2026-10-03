/**
 * Tests du fond « Paysage » (js/ui/paysage.js) : choix du décor selon
 * le moment et la météo, dessin SVG, et mise à jour sur la page.
 */

import { decor, dessinerPaysage, etatCourant, majPaysage, MOMENTS, METEOS } from '../js/ui/paysage.js';

const ds = () => document.documentElement.dataset;

function poser(attributs) {
    for (const cle of ['bjFond', 'bjPhase', 'bjMeteo', 'bjMeteoNuit', 'bjMeteoFond']) delete ds()[cle];
    Object.assign(ds(), attributs);
}

beforeEach(() => {
    document.body.innerHTML = '<div id="bj-paysage"></div>';
    poser({});
    majPaysage(); // remet à zéro la mémoire du dernier décor
});

describe('choix du décor', () => {
    test('beau temps de jour : soleil, pas d\'étoiles, fenêtres éteintes', () => {
        const d = decor('jour', 'clair');
        expect(d.astre).toBe('soleil');
        expect(d.etoiles).toBe(false);
        expect(d.fenetresAllumees).toBe(false);
    });

    test('nuit claire : lune et étoiles, fenêtres allumées', () => {
        const d = decor('nuit', 'clair');
        expect(d.astre).toBe('lune');
        expect(d.etoiles).toBe(true);
        expect(d.fenetresAllumees).toBe(true);
    });

    test('le soir, les fenêtres s\'allument', () => {
        expect(decor('crepuscule', 'clair').fenetresAllumees).toBe(true);
        expect(decor('aube', 'voile').fenetresAllumees).toBe(true);
    });

    test('mauvais temps : ni soleil ni lune', () => {
        for (const m of ['couvert', 'brouillard', 'pluie', 'neige', 'orage']) {
            expect(decor('jour', m).astre).toBeNull();
        }
    });

    test('la pluie et l\'orage allument les fenêtres en pleine journée', () => {
        expect(decor('jour', 'pluie').fenetresAllumees).toBe(true);
        expect(decor('jour', 'orage').fenetresAllumees).toBe(true);
        expect(decor('jour', 'couvert').fenetresAllumees).toBe(false);
    });

    test('neige : toit enneigé et collines claires', () => {
        const d = decor('jour', 'neige');
        expect(d.toitEnneige).toBe(true);
        expect(d.collines).not.toEqual(decor('jour', 'clair').collines);
    });

    test('brouillard', () => {
        expect(decor('aube', 'brouillard').brouillard).toBe(true);
        expect(decor('aube', 'pluie').brouillard).toBe(false);
    });

    test('la nuit selon la météo l\'emporte sur l\'heure', () => {
        expect(decor('crepuscule', 'clair', true).astre).toBe('lune');
        expect(decor('nuit', 'clair', false).astre).toBe('soleil');
    });

    test('valeurs inconnues : journée de beau temps', () => {
        const d = decor('minuit', 'tempete');
        expect(d.moment).toBe('jour');
        expect(d.meteo).toBe('clair');
    });

    test('toutes les combinaisons donnent un décor complet', () => {
        for (const moment of MOMENTS) {
            for (const meteo of METEOS) {
                const d = decor(moment, meteo);
                expect(d.ciel).toHaveLength(3);
                expect(d.collines).toHaveLength(3);
                expect(dessinerPaysage(d)).toMatch(/^<svg[\s\S]*<\/svg>$/);
            }
        }
    });
});

describe('dessin', () => {
    const dessin = (moment, meteo, nuit) => {
        document.body.innerHTML = `<div id="x">${dessinerPaysage(decor(moment, meteo, nuit))}</div>`;
        return document.getElementById('x');
    };

    test('le sol reste en bas de l\'écran', () => {
        expect(dessin('jour', 'clair').querySelector('svg').getAttribute('preserveAspectRatio')).toBe('xMidYMax slice');
    });

    test('éléments du décor', () => {
        expect(dessin('jour', 'clair').querySelector('.bj-p-soleil')).not.toBeNull();
        expect(dessin('nuit', 'clair').querySelector('.bj-p-lune')).not.toBeNull();
        expect(dessin('nuit', 'clair').querySelector('.bj-p-etoiles')).not.toBeNull();
        expect(dessin('jour', 'clair').querySelectorAll('.bj-p-derive')).toHaveLength(0);
        expect(dessin('jour', 'nuageux').querySelectorAll('.bj-p-derive')).toHaveLength(3);
        expect(dessin('jour', 'orage').querySelectorAll('.bj-p-derive')).toHaveLength(5);
        expect(dessin('jour', 'brouillard').querySelector('.bj-p-brume')).not.toBeNull();
        expect(dessin('jour', 'clair').querySelector('.bj-p-cabinet')).not.toBeNull();
    });

    test('fenêtres allumées avec leur lueur', () => {
        expect(dessin('nuit', 'clair').querySelectorAll('.bj-p-fenetre-allumee')).toHaveLength(2);
        expect(dessin('jour', 'clair').querySelectorAll('.bj-p-fenetre-allumee')).toHaveLength(0);
    });
});

describe('mise à jour sur la page', () => {
    test('rien n\'est dessiné si le fond « Paysage » n\'est pas choisi', () => {
        poser({ bjFond: 'dynamique', bjPhase: 'jour' });
        expect(etatCourant()).toBeNull();
        expect(majPaysage()).toBe(false);
        expect(document.getElementById('bj-paysage').innerHTML).toBe('');
    });

    test('le décor suit le moment et la météo posés sur la page', () => {
        poser({ bjFond: 'paysage', bjPhase: 'jour', bjMeteo: 'pluie', bjMeteoNuit: 'non' });
        expect(majPaysage()).toBe(true);
        expect(etatCourant()).toMatchObject({ moment: 'jour', meteo: 'pluie', nuit: false });
        expect(document.querySelector('#bj-paysage svg')).not.toBeNull();
    });

    test('pas de redessin si rien n\'a changé', () => {
        poser({ bjFond: 'paysage', bjPhase: 'jour', bjMeteo: 'clair' });
        expect(majPaysage()).toBe(true);
        const svg = document.querySelector('#bj-paysage svg');
        expect(majPaysage()).toBe(false);
        expect(document.querySelector('#bj-paysage svg')).toBe(svg);
        ds().bjPhase = 'crepuscule';
        expect(majPaysage()).toBe(true);
    });

    test('météo désactivée : le décor ne suit que l\'heure', () => {
        poser({ bjFond: 'paysage', bjPhase: 'jour', bjMeteo: 'orage', bjMeteoFond: 'non' });
        expect(etatCourant().meteo).toBe('clair');
    });

    test('sans météo connue : beau temps', () => {
        poser({ bjFond: 'paysage', bjPhase: 'nuit', bjMeteo: '' });
        expect(etatCourant()).toMatchObject({ meteo: 'clair', nuit: true, astre: 'lune' });
    });

    test('changer de fond efface le paysage', () => {
        poser({ bjFond: 'paysage', bjPhase: 'jour' });
        majPaysage();
        ds().bjFond = 'uni';
        majPaysage();
        expect(document.getElementById('bj-paysage').innerHTML).toBe('');
    });

    test('sans calque dans la page, rien ne plante', () => {
        document.body.innerHTML = '';
        poser({ bjFond: 'paysage', bjPhase: 'jour' });
        expect(majPaysage()).toBe(false);
    });
});
