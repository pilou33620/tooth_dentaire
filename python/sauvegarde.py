# -*- coding: utf-8 -*-
"""
Sauvegarde automatique de la base (stock.db).

Une copie par jour dans le dossier « sauvegardes » a cote de la base :

    donnees/stock.db
    donnees/sauvegardes/stock-20261004-083012.db
    ...

La copie passe par l'API de sauvegarde de SQLite (sqlite3.backup) : elle est
coherente meme si un poste enregistre au meme moment, contrairement a une
simple copie du fichier.

Conservation : la copie la plus recente de chacun des GARDER derniers jours,
plus les GARDER_RECENTES dernieres copies. Des clics repetes sur
« Sauvegarder maintenant » ne remplacent donc que des copies du jour : ils ne
peuvent pas effacer l'historique des jours precedents.

Restaurer : arreter le serveur, remplacer stock.db par la copie voulue
(renommee en stock.db), relancer.
"""

import datetime
import os
import re
import sqlite3
import threading

import base

GARDER = 30                              # nombre de jours conserves (une copie par jour)
GARDER_RECENTES = 5                      # dernieres copies gardees en plus, quel que soit le jour
INTERVALLE = 24 * 3600                   # une copie par 24 h
VERIFICATION = 3600                      # le fil se reveille toutes les heures
NOM_DOSSIER = "sauvegardes"
MOTIF = re.compile(r"^stock-(\d{8}-\d{6})\.db$")

_fil = None
_arret = threading.Event()
# Une copie a la fois : le bouton et la copie quotidienne peuvent tomber dans
# la meme seconde, donc sur le meme nom de fichier.
_verrou_copie = threading.Lock()


def dossier_sauvegardes(chemin_base=None):
    chemin_base = chemin_base or base.CHEMIN_BASE
    return os.path.join(os.path.dirname(os.path.abspath(chemin_base)), NOM_DOSSIER)


def lister(dossier=None):
    """Sauvegardes presentes, de la plus recente a la plus ancienne."""
    dossier = dossier or dossier_sauvegardes()
    try:
        noms = os.listdir(dossier)
    except OSError:
        return []
    copies = []
    for nom in noms:
        m = MOTIF.match(nom)
        if not m:
            continue
        chemin = os.path.join(dossier, nom)
        try:
            date = datetime.datetime.strptime(m.group(1), "%Y%m%d-%H%M%S")
            taille = os.path.getsize(chemin)
        except (ValueError, OSError):            # date impossible (stock-99999999-...)
            continue
        copies.append({"nom": nom, "chemin": chemin, "date": date.isoformat(), "taille": taille})
    copies.sort(key=lambda c: c["nom"], reverse=True)
    return copies


def derniere(dossier=None):
    copies = lister(dossier)
    return copies[0] if copies else None


def sauvegarder(chemin_base=None, dossier=None, garder=GARDER, maintenant=None):
    """Copie coherente de la base ; retourne la description de la copie."""
    chemin_base = chemin_base or base.CHEMIN_BASE
    if not chemin_base or not os.path.isfile(chemin_base):
        raise base.ErreurDonnees("Base introuvable : rien a sauvegarder.")
    dossier = dossier or dossier_sauvegardes(chemin_base)
    os.makedirs(dossier, exist_ok=True)

    maintenant = maintenant or datetime.datetime.now()
    nom = "stock-%s.db" % maintenant.strftime("%Y%m%d-%H%M%S")
    final = os.path.join(dossier, nom)
    temporaire = final + ".partiel"

    with _verrou_copie:
        # Sous le verrou d'ecriture : aucun poste n'ecrit pendant la copie (quelques ms).
        with base._VERROU:
            source = sqlite3.connect(chemin_base, timeout=15)
            try:
                cible = sqlite3.connect(temporaire)
                try:
                    source.backup(cible)
                finally:
                    cible.close()
            finally:
                source.close()
        os.replace(temporaire, final)
        _nettoyer(dossier, garder)
        return {"nom": nom, "chemin": final, "date": maintenant.isoformat(),
                "taille": os.path.getsize(final)}


def _nettoyer(dossier, garder):
    """Garde la derniere copie de chacun des `garder` derniers jours, plus les
    min(GARDER_RECENTES, garder) dernieres copies ; supprime le reste."""
    garder = max(1, garder)
    copies = lister(dossier)                     # de la plus recente a la plus ancienne
    gardees = {c["nom"] for c in copies[:min(GARDER_RECENTES, garder)]}
    jours = set()
    for copie in copies:
        jour = copie["nom"][len("stock-"):len("stock-AAAAMMJJ")]
        if jour not in jours and len(jours) < garder:
            jours.add(jour)
            gardees.add(copie["nom"])
    for copie in copies:
        if copie["nom"] in gardees:
            continue
        try:
            os.remove(copie["chemin"])
        except OSError:
            pass


def copie_recente(secondes, maintenant=None, dossier=None):
    """Derniere copie si elle a moins de `secondes` secondes, sinon None."""
    copie = derniere(dossier)
    if copie is None:
        return None
    maintenant = maintenant or datetime.datetime.now()
    age = (maintenant - datetime.datetime.fromisoformat(copie["date"])).total_seconds()
    return copie if 0 <= age < secondes else None


def sauvegarde_due(maintenant=None, dossier=None):
    """Vrai s'il n'existe aucune copie de moins de INTERVALLE secondes."""
    copie = derniere(dossier)
    if copie is None:
        return True
    maintenant = maintenant or datetime.datetime.now()
    age = maintenant - datetime.datetime.fromisoformat(copie["date"])
    return age.total_seconds() >= INTERVALLE or age.total_seconds() < 0


def sauvegarder_si_du():
    if base.CHEMIN_BASE and sauvegarde_due():
        try:
            copie = sauvegarder()
            print("[*] Sauvegarde de la base : %s" % copie["chemin"])
        except Exception as exc:                          # noqa: BLE001
            print("[!] Sauvegarde de la base impossible : %s" % exc)


def _boucle():
    while not _arret.is_set():
        sauvegarder_si_du()
        _arret.wait(VERIFICATION)


def demarrer():
    """Lance le fil de sauvegarde (une copie au demarrage si besoin, puis chaque jour)."""
    global _fil
    if _fil is not None and _fil.is_alive():
        return
    _arret.clear()
    _fil = threading.Thread(target=_boucle, name="sauvegarde", daemon=True)
    _fil.start()


def arreter():
    _arret.set()
