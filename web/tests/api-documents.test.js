/**
 * Documents partagés (notes, planning...) : chaque écriture porte la version
 * lue ; si un autre poste a enregistré entre-temps, le serveur refuse (409),
 * l'écran est rechargé et l'utilisateur est prévenu (sauf écriture de fond).
 */

import { jest } from '@jest/globals';
import { chargerEtat, getDocument, setDocument, getVersionDocument } from '../js/core/api.js';
import { installerServeurFactice, attendreEcritures, appelsVers } from './helpers/serveur-factice.js';

let serveur;

beforeEach(async () => {
    serveur = installerServeurFactice({ documents: { notes: { items: ["serveur"] } } });
    serveur.versions.notes = 4;
    window.alert = jest.fn();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await chargerEtat();
});

afterEach(() => jest.restoreAllMocks());

test('envoie la version lue puis la suivante, et l\'en-tête anti-CSRF', async () => {
    setDocument("notes", { items: ["a"] });
    setDocument("notes", { items: ["a", "b"] });
    await attendreEcritures();
    const puts = appelsVers(serveur, "PUT", "/api/documents/notes");
    expect(puts.map(a => a.entetes["X-Version"])).toEqual(["4", "5"]);
    expect(puts[0].entetes["X-Tooth"]).toBe("1");
    expect(getVersionDocument("notes")).toBe(6);
    expect(window.alert).not.toHaveBeenCalled();
});

test('conflit : rien n\'est écrasé, l\'écran est rechargé, la suite en file est abandonnée', async () => {
    serveur.versions.notes = 7;                       // un autre poste a enregistré
    serveur.documents.notes = { items: ["autre poste"] };
    setDocument("notes", { items: ["moi"] });
    setDocument("notes", { items: ["moi", "encore"] });
    await attendreEcritures();
    expect(appelsVers(serveur, "PUT", "/api/documents/notes")).toHaveLength(1);
    expect(serveur.documents.notes).toEqual({ items: ["autre poste"] });
    expect(getDocument("notes")).toEqual({ items: ["autre poste"] });
    expect(window.alert).toHaveBeenCalledTimes(1);
});

test('version d\'ouverture d\'un éditeur : refus si le document a changé depuis', async () => {
    const ouverture = getVersionDocument("notes");
    await chargerEtat();                              // rechargement pendant la saisie
    serveur.versions.notes = 5;
    await chargerEtat();
    setDocument("notes", { items: ["vieux brouillon"] }, { version: ouverture });
    await attendreEcritures();
    expect(serveur.documents.notes).toEqual({ items: ["serveur"] });
});

test('écriture de fond silencieuse : pas de message en cas de conflit', async () => {
    serveur.versions.notes = 9;
    setDocument("notes", { items: [] }, { silencieux: true });
    await attendreEcritures();
    expect(window.alert).not.toHaveBeenCalled();
});
