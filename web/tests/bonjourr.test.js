/**
 * Tests de l'accueil façon Bonjourr (js/ui/bonjourr.js) :
 * réglages d'apparence, salutation, moments de la journée, horloge,
 * citation et application des réglages à la page.
 */

import { jest } from '@jest/globals';
import {
    DEFAUTS, CLE_OPTIONS, CLE_IMAGE, CITATIONS,
    normaliserOptions, lireOptions, ecrireOptions,
    salutation, phaseDuJour, formaterDate, anglesAiguilles, citationDuJour,
    dimensionsReduites, majHorloge, afficherCitation, appliquerOptions, initBonjourr
} from '../js/ui/bonjourr.js';

const MARKUP = `
    <div id="bj-fond">
        <div class="bj-fond-degrade"></div>
        <div class="bj-fond-image"></div>
        <div id="background-animation"><iframe data-src="html/cabinet-dentaire.html"></iframe></div>
    </div>
    <time id="bj-heure-num"><span class="bj-hm"></span><span class="bj-sec"></span></time>
    <svg id="bj-heure-analog" class="hidden">
        <line id="bj-aiguille-h"></line><line id="bj-aiguille-m"></line><line id="bj-aiguille-s"></line>
    </svg>
    <p id="bj-date"></p>
    <h1 id="bj-salutation"></h1>
    <figure id="bj-citation"><blockquote id="bj-citation-texte"></blockquote><figcaption id="bj-citation-auteur"></figcaption></figure>
    <div class="bj-widget" data-widget="planning"></div>
    <div class="bj-widget" data-widget="taches"></div>
    <div class="bj-widget" data-widget="ruptures"></div>
    <button id="btn-annuaire"></button>
    <div id="annuaire-overlay" class="overlay hidden"><iframe></iframe></div>
    <div id="msg-overlay" class="overlay hidden"><button class="dialog-close" data-close="msg-overlay"></button></div>
    <select id="bj-opt-fond">
        <option value="dynamique"></option><option value="cabinet"></option>
        <option value="image"></option><option value="uni"></option>
    </select>
    <div data-si-fond="image"></div>
    <div data-si-fond="uni"></div>
    <div data-si-fond="dynamique paysage"></div>
    <input type="checkbox" id="bj-opt-secondes">
    <input type="text" id="bj-opt-nom">
    <input type="checkbox" data-bj-widget="taches">
    <button id="bj-opt-defaut"></button>
`;

// Samedi 3 octobre 2026, 14:05:30 (heure locale)
const SAMEDI = new Date(2026, 9, 3, 14, 5, 30);

function stockageMemoire(initial = {}) {
    const d = { ...initial };
    return {
        getItem: k => (k in d ? d[k] : null),
        setItem: (k, v) => { d[k] = String(v); },
        removeItem: k => { delete d[k]; },
        donnees: d
    };
}

beforeEach(() => {
    document.body.innerHTML = MARKUP;
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.bjPhase;
    localStorage.clear();
});

describe('réglages d\'apparence', () => {
    test('un réglage absent ou illisible reprend la valeur par défaut', () => {
        const o = normaliserOptions(null);
        expect(o.fond).toBe(DEFAUTS.fond);
        expect(o.horloge).toBe('numerique');
        expect(o.widgets).toEqual({
            planning: true, taches: true, ruptures: true, notes: true, checklist: true, minuteurs: true
        });
    });

    test('les valeurs inconnues sont rejetées et les nombres bornés', () => {
        const o = normaliserOptions({ fond: 'plage', horloge: 'sablier', flou: 999, luminosite: -5, taille: '120', couleur: 'rouge' });
        expect(o.fond).toBe('dynamique');
        expect(o.horloge).toBe('numerique');
        expect(o.flou).toBe(40);
        expect(o.luminosite).toBe(30);
        expect(o.taille).toBe(120);
        expect(o.couleur).toBe(DEFAUTS.couleur);
    });

    test('météo sur le fond et température : actives par défaut, désactivables', () => {
        expect(normaliserOptions({})).toMatchObject({ meteoFond: true, meteoTexte: true });
        expect(normaliserOptions({ meteoFond: false, meteoTexte: 'non' })).toMatchObject({ meteoFond: false, meteoTexte: true });
        appliquerOptions(normaliserOptions({ meteoFond: false, meteoTexte: false }));
        expect(document.documentElement.dataset.bjMeteoFond).toBe('non');
        expect(document.documentElement.dataset.bjMeteoTexte).toBe('non');
    });

    test('le fond « Paysage » est un choix valide', () => {
        expect(normaliserOptions({ fond: 'paysage' }).fond).toBe('paysage');
    });

    test('le nom est nettoyé et limité', () => {
        expect(normaliserOptions({ nom: '   l\'équipe  ' }).nom).toBe('l\'équipe');
        expect(normaliserOptions({ nom: 'x'.repeat(100) }).nom).toHaveLength(40);
    });

    test('un widget n\'est masqué que s\'il est explicitement décoché', () => {
        const o = normaliserOptions({ widgets: { taches: false, ruptures: 'oui', minuteurs: false, inconnu: false } });
        expect(o.widgets).toEqual({
            planning: true, taches: false, ruptures: true, notes: true, checklist: true, minuteurs: false
        });
    });

    test('écriture puis lecture redonnent les mêmes réglages', () => {
        const s = stockageMemoire();
        ecrireOptions({ fond: 'uni', couleur: '#112233', secondes: true }, s);
        const o = lireOptions(s);
        expect(o.fond).toBe('uni');
        expect(o.couleur).toBe('#112233');
        expect(o.secondes).toBe(true);
    });

    test('un enregistrement corrompu ne bloque pas l\'accueil', () => {
        const s = stockageMemoire({ [CLE_OPTIONS]: '{pas du json' });
        expect(lireOptions(s)).toEqual(normaliserOptions({}));
    });

    test('un stockage plein ne fait pas planter l\'enregistrement', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const plein = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
        expect(() => ecrireOptions({ fond: 'uni' }, plein)).not.toThrow();
        warn.mockRestore();
    });
});

describe('salutation et moment de la journée', () => {
    const a = h => new Date(2026, 9, 3, h, 0, 0);

    test.each([
        [5, 'Bonjour'], [11, 'Bonjour'], [12, 'Bon après-midi'], [17, 'Bon après-midi'],
        [18, 'Bonsoir'], [21, 'Bonsoir'], [22, 'Bonne nuit'], [2, 'Bonne nuit']
    ])('à %ih : « %s »', (h, attendu) => {
        expect(salutation(a(h))).toBe(attendu);
    });

    test('le nom suit la salutation', () => {
        expect(salutation(a(9), 'l\'équipe')).toBe('Bonjour, l\'équipe');
        expect(salutation(a(9), '   ')).toBe('Bonjour');
    });

    test.each([
        [7, 'aube'], [12, 'jour'], [17, 'jour'], [19, 'crepuscule'], [23, 'nuit'], [4, 'nuit']
    ])('à %ih le fond est « %s »', (h, phase) => {
        expect(phaseDuJour(a(h))).toBe(phase);
    });

    test('la bascule jour → crépuscule se fait à 17h30', () => {
        expect(phaseDuJour(new Date(2026, 9, 3, 17, 29))).toBe('jour');
        expect(phaseDuJour(new Date(2026, 9, 3, 17, 30))).toBe('crepuscule');
    });
});

describe('date et horloge', () => {
    test('la date est en toutes lettres avec le numéro de semaine', () => {
        expect(formaterDate(SAMEDI)).toBe('samedi 3 octobre · semaine 40');
    });

    test('angles des aiguilles', () => {
        expect(anglesAiguilles(new Date(2026, 0, 1, 3, 0, 0))).toEqual({ h: 90, m: 0, s: 0 });
        const a = anglesAiguilles(new Date(2026, 0, 1, 15, 30, 15));
        expect(a.h).toBeCloseTo(105.125);
        expect(a.m).toBeCloseTo(181.5);
        expect(a.s).toBe(90);
    });

    test('l\'horloge numérique affiche heures et minutes, et les secondes si demandé', () => {
        majHorloge(SAMEDI, normaliserOptions({}));
        expect(document.querySelector('.bj-hm').textContent).toBe('14:05');
        expect(document.querySelector('.bj-sec').textContent).toBe('');

        majHorloge(SAMEDI, normaliserOptions({ secondes: true }));
        expect(document.querySelector('.bj-sec').textContent).toBe('30');
    });

    test('date, salutation et moment de la journée sont mis à jour', () => {
        majHorloge(SAMEDI, normaliserOptions({ nom: 'Pilou' }));
        expect(document.getElementById('bj-date').textContent).toBe('samedi 3 octobre · semaine 40');
        expect(document.getElementById('bj-salutation').textContent).toBe('Bon après-midi, Pilou');
        expect(document.documentElement.dataset.bjPhase).toBe('jour');
    });

    test('l\'horloge analogique fait tourner les aiguilles', () => {
        majHorloge(new Date(2026, 0, 1, 3, 0, 0), normaliserOptions({ horloge: 'analogique' }));
        expect(document.getElementById('bj-aiguille-h').getAttribute('transform')).toBe('rotate(90.00 50 50)');
    });

    test('l\'horloge fonctionne même sans ses éléments dans la page', () => {
        document.body.innerHTML = '';
        expect(() => majHorloge(SAMEDI, normaliserOptions({ horloge: 'analogique' }))).not.toThrow();
    });
});

describe('citation du jour', () => {
    test('la même citation toute la journée', () => {
        const matin = citationDuJour(new Date(2026, 9, 3, 8, 0));
        const soir = citationDuJour(new Date(2026, 9, 3, 22, 0));
        expect(soir).toBe(matin);
    });

    test('elle change d\'un jour à l\'autre et le décalage passe à la suivante', () => {
        const auj = citationDuJour(SAMEDI);
        const demain = citationDuJour(new Date(2026, 9, 4, 12, 0));
        expect(demain).not.toBe(auj);
        expect(citationDuJour(SAMEDI, 1)).toBe(demain);
    });

    test('le décalage boucle sur la liste dans les deux sens', () => {
        expect(citationDuJour(SAMEDI, CITATIONS.length)).toBe(citationDuJour(SAMEDI));
        expect(citationDuJour(SAMEDI, -1)).toBe(citationDuJour(new Date(2026, 9, 2, 12, 0)));
    });

    test('affichage du texte et de l\'auteur', () => {
        afficherCitation(SAMEDI);
        const c = citationDuJour(SAMEDI);
        expect(document.getElementById('bj-citation-texte').textContent).toBe(c.texte);
        expect(document.getElementById('bj-citation-auteur').textContent).toBe(c.auteur);
    });
});

describe('application des réglages à la page', () => {
    const racine = () => document.documentElement;

    test('variables du fond et choix du fond', () => {
        appliquerOptions(normaliserOptions({ fond: 'uni', couleur: '#102030', flou: 10, luminosite: 70, taille: 120 }));
        expect(racine().dataset.bjFond).toBe('uni');
        expect(racine().style.getPropertyValue('--bj-flou')).toBe('10px');
        expect(racine().style.getPropertyValue('--bj-echelle')).toBe('1.05');
        expect(racine().style.getPropertyValue('--bj-luminosite')).toBe('0.7');
        expect(racine().style.getPropertyValue('--bj-couleur-unie')).toBe('#102030');
        expect(racine().style.getPropertyValue('--bj-taille')).toBe('1.2');
    });

    test('l\'animation du cabinet n\'est chargée que si elle sert de fond', () => {
        const iframe = document.querySelector('#background-animation iframe');
        appliquerOptions(normaliserOptions({}));
        expect(iframe.hasAttribute('src')).toBe(false);

        appliquerOptions(normaliserOptions({ fond: 'cabinet' }));
        expect(iframe.getAttribute('src')).toBe('html/cabinet-dentaire.html');

        appliquerOptions(normaliserOptions({ fond: 'dynamique' }));
        expect(iframe.hasAttribute('src')).toBe(false);
    });

    test('l\'image personnelle est posée sur son calque', () => {
        const s = stockageMemoire({ [CLE_IMAGE]: 'data:image/jpeg;base64,AAAA' });
        appliquerOptions(normaliserOptions({ fond: 'image' }), document, s);
        expect(document.querySelector('.bj-fond-image').style.backgroundImage).toContain('data:image/jpeg;base64,AAAA');
        expect(racine().dataset.bjImage).toBe('oui');
    });

    test('fond « image » sans image enregistrée : on garde le dégradé', () => {
        appliquerOptions(normaliserOptions({ fond: 'image' }), document, stockageMemoire());
        expect(document.querySelector('.bj-fond-image').style.backgroundImage).toBe('');
        expect(racine().dataset.bjImage).toBe('non');
    });

    test('choix de l\'horloge, des secondes, de la salutation et de la citation', () => {
        appliquerOptions(normaliserOptions({ horloge: 'analogique', secondes: false, salutation: false, citation: false }));
        expect(document.getElementById('bj-heure-num').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('bj-heure-analog').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('bj-aiguille-s').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('bj-salutation').classList.contains('hidden')).toBe(true);
        expect(document.getElementById('bj-citation').classList.contains('hidden')).toBe(true);
    });

    test('un widget décoché est masqué, les autres restent', () => {
        appliquerOptions(normaliserOptions({ widgets: { ruptures: false } }));
        const masque = nom => document.querySelector(`[data-widget="${nom}"]`).classList.contains('bj-widget-masque');
        expect(masque('ruptures')).toBe(true);
        expect(masque('planning')).toBe(false);
        expect(masque('taches')).toBe(false);
    });
});

describe('image personnelle', () => {
    test('réduite au plus long côté demandé, proportions conservées', () => {
        expect(dimensionsReduites(4000, 3000, 1920)).toEqual({ largeur: 1920, hauteur: 1440 });
        expect(dimensionsReduites(1080, 1920, 1920)).toEqual({ largeur: 1080, hauteur: 1920 });
    });

    test('une petite image n\'est pas agrandie', () => {
        expect(dimensionsReduites(800, 600)).toEqual({ largeur: 800, hauteur: 600 });
    });

    test('dimensions inconnues', () => {
        expect(dimensionsReduites(0, 600)).toEqual({ largeur: 0, hauteur: 0 });
    });
});

describe('initialisation', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('les réglages enregistrés sont appliqués et reportés dans le panneau', () => {
        localStorage.setItem(CLE_OPTIONS, JSON.stringify({ fond: 'uni', secondes: true, nom: 'Pilou', widgets: { taches: false } }));
        initBonjourr();
        expect(document.documentElement.dataset.bjFond).toBe('uni');
        expect(document.getElementById('bj-opt-fond').value).toBe('uni');
        expect(document.getElementById('bj-opt-secondes').checked).toBe(true);
        expect(document.getElementById('bj-opt-nom').value).toBe('Pilou');
        expect(document.querySelector('[data-bj-widget="taches"]').checked).toBe(false);
        expect(document.querySelector('[data-si-fond="uni"]').classList.contains('hidden')).toBe(false);
        expect(document.querySelector('[data-si-fond="dynamique paysage"]').classList.contains('hidden')).toBe(true);
        expect(document.querySelector('[data-si-fond="image"]').classList.contains('hidden')).toBe(true);
    });

    test('une option liée à plusieurs fonds s\'affiche pour chacun d\'eux', () => {
        localStorage.setItem(CLE_OPTIONS, JSON.stringify({ fond: 'paysage' }));
        initBonjourr();
        expect(document.querySelector('[data-si-fond="dynamique paysage"]').classList.contains('hidden')).toBe(false);
        expect(document.querySelector('[data-si-fond="uni"]').classList.contains('hidden')).toBe(true);
    });

    test('changer un réglage l\'applique et l\'enregistre aussitôt', () => {
        initBonjourr();
        const select = document.getElementById('bj-opt-fond');
        select.value = 'cabinet';
        select.dispatchEvent(new Event('change'));
        expect(document.documentElement.dataset.bjFond).toBe('cabinet');
        expect(JSON.parse(localStorage.getItem(CLE_OPTIONS)).fond).toBe('cabinet');

        const coche = document.querySelector('[data-bj-widget="taches"]');
        coche.checked = false;
        coche.dispatchEvent(new Event('change'));
        expect(document.querySelector('[data-widget="taches"]').classList.contains('bj-widget-masque')).toBe(true);
    });

    test('« Apparence par défaut » efface les réglages et l\'image', () => {
        localStorage.setItem(CLE_OPTIONS, JSON.stringify({ fond: 'image' }));
        localStorage.setItem(CLE_IMAGE, 'data:image/jpeg;base64,AAAA');
        initBonjourr();
        document.getElementById('bj-opt-defaut').click();
        expect(localStorage.getItem(CLE_IMAGE)).toBeNull();
        expect(JSON.parse(localStorage.getItem(CLE_OPTIONS)).fond).toBe('dynamique');
    });

    test('l\'horloge avance toute seule', () => {
        jest.setSystemTime(new Date(2026, 9, 3, 9, 59, 59));
        initBonjourr();
        expect(document.querySelector('.bj-hm').textContent).toBe('09:59');
        jest.advanceTimersByTime(1000);
        expect(document.querySelector('.bj-hm').textContent).toBe('10:00');
    });

    test('un clic sur la citation en propose une autre', () => {
        initBonjourr();
        const avant = document.getElementById('bj-citation-texte').textContent;
        document.getElementById('bj-citation').click();
        expect(document.getElementById('bj-citation-texte').textContent).not.toBe(avant);
    });

    test('le carnet d\'adresses s\'ouvre depuis son lien', () => {
        initBonjourr();
        document.getElementById('btn-annuaire').click();
        expect(document.getElementById('annuaire-overlay').classList.contains('hidden')).toBe(false);
    });

    test('Échap ferme la fenêtre ouverte', () => {
        initBonjourr();
        const overlay = document.getElementById('msg-overlay');
        overlay.classList.remove('hidden');
        const fermer = overlay.querySelector('.dialog-close');
        fermer.addEventListener('click', () => overlay.classList.add('hidden'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(overlay.classList.contains('hidden')).toBe(true);
    });
});
