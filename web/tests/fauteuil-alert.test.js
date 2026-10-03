/**
 * Tests unitaires pour le module fauteuil-alert.js
 */

import { jest } from '@jest/globals';
import {
    FAUTEUILS,
    getFauteuilConfig,
    formatDateFR,
    formatDateInput,
    parseDateInput,
    getAllFauteuilData,
    getFauteuilDataForMachine,
    saveFauteuilDataForMachine,
    getFauteuilStatus,
    setFauteuilSnoozed
} from '../js/machines/fauteuil-alert.js';
import { chargerEtat } from '../js/core/api.js';
import { installerServeurFactice } from './helpers/serveur-factice.js';

describe('Fauteuil Alert Module Tests', () => {

    beforeEach(async () => {
        // Échéances en base : chaque test repart d'un serveur vierge
        installerServeurFactice();
        await chargerEtat();
        setFauteuilSnoozed(false);
    });

    describe('Configuration des fauteuils', () => {
        test('doit contenir les 5 fauteuils des 5 cabinets', () => {
            expect(FAUTEUILS).toHaveLength(5);
            const machines = FAUTEUILS.map(f => f.machine);
            expect(machines).toContain("Fauteuil Sinius");
            expect(machines).toContain("Fauteuil Planmeca compact");
            expect(machines).toContain("Fauteuil Anthos");
            expect(machines).toContain("Fauteuil OVIS");
            expect(machines).toContain("Fauteuil Planmeca");
        });

        test('associe chaque fauteuil au bon cabinet', () => {
            const sinius = getFauteuilConfig("Fauteuil Sinius");
            expect(sinius.cabinet).toBe("Cabinet 1");

            const planmecaCompact = getFauteuilConfig("Cabinet 2");
            expect(planmecaCompact.machine).toBe("Fauteuil Planmeca compact");

            const anthos = getFauteuilConfig("Cabinet 4");
            expect(anthos.machine).toBe("Fauteuil Anthos");

            const ovis = getFauteuilConfig("Cabinet 5");
            expect(ovis.machine).toBe("Fauteuil OVIS");

            const chir = getFauteuilConfig("Salle de chirurgie");
            expect(chir.machine).toBe("Fauteuil Planmeca");
        });

        test('retourne une config par défaut pour une machine inconnue', () => {
            const unknown = getFauteuilConfig("Fauteuil Inconnu");
            expect(unknown.machine).toBe("Fauteuil Inconnu");
            expect(unknown.defaultDays).toBe(180);
        });
    });

    describe('Formatage et parsing des dates', () => {
        test('formatDateFR formate correctement un timestamp', () => {
            const ts = new Date(2026, 11, 25).getTime(); // 25 décembre 2026
            expect(formatDateFR(ts)).toBe("25/12/2026");
        });

        test('formatDateFR gère les valeurs nulles ou invalides', () => {
            expect(formatDateFR(null)).toBe("Non définie");
            expect(formatDateFR(undefined)).toBe("Non définie");
            expect(formatDateFR("invalid")).toBe("Non définie");
        });

        test('formatDateInput formate en YYYY-MM-DD', () => {
            const ts = new Date(2026, 8, 15).getTime(); // 15 septembre 2026
            expect(formatDateInput(ts)).toBe("2026-09-15");
        });

        test('parseDateInput parse correctement une chaîne YYYY-MM-DD', () => {
            const parsed = parseDateInput("2026-10-31");
            expect(parsed).not.toBeNull();
            const d = new Date(parsed);
            expect(d.getFullYear()).toBe(2026);
            expect(d.getMonth()).toBe(9); // Octobre = 9
            expect(d.getDate()).toBe(31);
        });

        test('parseDateInput gère les formats invalides', () => {
            expect(parseDateInput("")).toBeNull();
            expect(parseDateInput(null)).toBeNull();
            expect(parseDateInput("invalide")).toBeNull();
        });
    });

    describe('Persistance des données en base', () => {
        test('sauvegarde et récupère les données pour un fauteuil', () => {
            const targetTime = Date.now() + 180 * 24 * 60 * 60 * 1000;
            saveFauteuilDataForMachine("Fauteuil Sinius", targetTime, 180, "Révision annuelle");

            const data = getFauteuilDataForMachine("Fauteuil Sinius");
            expect(data.nextTime).toBe(targetTime);
            expect(data.intervalDays).toBe(180);
            expect(data.note).toBe("Révision annuelle");
        });

        test('getAllFauteuilData retourne un objet vide par défaut', () => {
            expect(getAllFauteuilData()).toEqual({});
        });

        test('sauvegarde plusieurs fauteuils de manière indépendante', () => {
            const time1 = Date.now() + 30 * 24 * 60 * 60 * 1000;
            const time2 = Date.now() + 90 * 24 * 60 * 60 * 1000;

            saveFauteuilDataForMachine("Fauteuil Sinius", time1, 30, "Cab 1");
            saveFauteuilDataForMachine("Fauteuil OVIS", time2, 90, "Cab 5");

            const all = getAllFauteuilData();
            expect(all["Fauteuil Sinius"].nextTime).toBe(time1);
            expect(all["Fauteuil OVIS"].nextTime).toBe(time2);
        });
    });

    describe('Statut d\'échéance de maintenance', () => {
        test('indique que la maintenance est due si aucune date n\'est définie', () => {
            const status = getFauteuilStatus("Fauteuil Sinius");
            expect(status.isDue).toBe(true);
            expect(status.dateStr).toBe("Non définie");
        });

        test('indique que la maintenance est due si la date est dépassée', () => {
            const pastTime = Date.now() - 5 * 24 * 60 * 60 * 1000; // Il y a 5 jours
            saveFauteuilDataForMachine("Fauteuil Sinius", pastTime, 180);

            const status = getFauteuilStatus("Fauteuil Sinius");
            expect(status.isDue).toBe(true);
            expect(status.dateStr).not.toBe("Non définie");
        });

        test('indique que la maintenance est à jour (non due) si la date est dans le futur', () => {
            const futureTime = Date.now() + 60 * 24 * 60 * 60 * 1000; // Dans 60 jours
            saveFauteuilDataForMachine("Fauteuil Sinius", futureTime, 180);

            const status = getFauteuilStatus("Fauteuil Sinius");
            expect(status.isDue).toBe(false);
            expect(status.dateStr).not.toBe("Non définie");
        });
    });
});
