# -*- coding: utf-8 -*-
"""
Journal du serveur : tout ce qui s'affiche dans la console (requêtes en
erreur, plantages, messages de démarrage) est aussi écrit dans
donnees/journal_serveur.log, pour être joint aux signalements de bug même
après un redémarrage de l'outil. Au-delà de 1 Mo, l'ancien journal devient
journal_serveur.log.1 (un seul gardé).
"""

import os
import sys
import threading

TAILLE_MAX = 1024 * 1024          # octets
NOM = "journal_serveur.log"

_verrou = threading.Lock()
_chemin = None


class _Copie:
    """Flux qui écrit dans la console d'origine et dans le fichier journal."""

    def __init__(self, flux, fichier):
        self._flux = flux
        self._fichier = fichier

    def write(self, texte):
        if self._flux is not None:
            try:
                self._flux.write(texte)
            except (OSError, ValueError, UnicodeError):
                pass
        with _verrou:
            try:
                self._fichier.write(texte)
                self._fichier.flush()
            except (OSError, ValueError):
                pass
        return len(texte)

    def flush(self):
        if self._flux is not None:
            try:
                self._flux.flush()
            except (OSError, ValueError):
                pass

    def isatty(self):
        return bool(self._flux is not None and self._flux.isatty())

    def __getattr__(self, nom):
        return getattr(self._flux, nom)


def demarrer(dossier):
    """Copie stdout et stderr dans le journal. Sans écriture possible, la console seule reste."""
    global _chemin
    if _chemin is not None:
        return
    try:
        os.makedirs(dossier, exist_ok=True)
        chemin = os.path.join(dossier, NOM)
        if os.path.isfile(chemin) and os.path.getsize(chemin) > TAILLE_MAX:
            os.replace(chemin, chemin + ".1")
        fichier = open(chemin, "a", encoding="utf-8", errors="replace")
    except OSError:
        return
    _chemin = chemin
    sys.stdout = _Copie(sys.stdout, fichier)
    sys.stderr = _Copie(sys.stderr, fichier)


def dernieres_lignes(n=200, chemin=None):
    """Les n dernières lignes du journal ("" s'il n'y en a pas)."""
    chemin = chemin or _chemin
    if not chemin:
        return ""
    try:
        with open(chemin, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 64 * 1024))   # les 64 derniers Ko suffisent
            lignes = f.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    return "\n".join(lignes[-n:])
