# -*- coding: utf-8 -*-
"""
Mises à jour de l'outil depuis GitHub (dossier installé par « git clone »).

- Toutes les 4 heures, le serveur fait un « git fetch » de la branche suivie
  (main) et retient s'il existe des commits plus récents.
- Les postes demandent l'état (GET /api/mise-a-jour) et proposent la mise à
  jour ; si quelqu'un accepte, le serveur avance la copie locale
  (« git merge --ff-only », jamais de fusion ni d'écrasement), réinstalle les
  dépendances si requirements.txt a changé, puis redémarre.
- La base (dossier donnees/, exclu de git) n'est jamais touchée.

Une installation qui n'est pas un clone git, une autre branche, ou des
fichiers modifiés à la main sur le poste : rien n'est proposé, et la raison
est affichée dans les Réglages.
"""

import os
import subprocess
import sys
import threading
import time

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRANCHE = "main"
DISTANT = "origin"
INTERVALLE = 4 * 60 * 60        # s : une vérification toutes les 4 heures
PREMIERE_VERIFICATION = 60      # s après le démarrage
DELAI_GIT = 120                 # s
# git portable (MinGit) posé par installation/Installer.bat sur les postes
# où git n'est pas installé ; sinon le git du PATH.
GIT_PORTABLE = os.path.join(RACINE, ".mingit", "cmd", "git.exe")

_verrou = threading.Lock()
_etat = {
    "disponible": False,
    "nouveautes": [],           # titres des commits à venir (10 au plus)
    "nombre": 0,
    "version_locale": "",
    "version_distante": "",
    "verifie_le": None,         # secondes depuis l'époque
    "raison": None,             # pourquoi rien n'est proposé (texte), ou None
    "en_cours": False,
}

# Positionné quand une mise à jour vient d'être installée : serveur.py
# arrête alors le serveur et relance le programme.
REDEMARRER = threading.Event()


class MiseAJourImpossible(RuntimeError):
    """Mise à jour refusée ou en échec ; le message s'affiche tel quel."""


# ------------------------------------------------------------------
# git (remplacé dans les tests)
# ------------------------------------------------------------------

def commande_git():
    return GIT_PORTABLE if os.path.isfile(GIT_PORTABLE) else "git"


def git(*args, dossier=None, delai=DELAI_GIT):
    """Lance git et renvoie sa sortie (texte). Lève MiseAJourImpossible en cas d'échec."""
    try:
        sortie = subprocess.run(
            [commande_git()] + list(args), cwd=dossier or RACINE, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=delai,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except FileNotFoundError:
        raise MiseAJourImpossible("git n'est pas installé sur ce poste.")
    except subprocess.TimeoutExpired:
        raise MiseAJourImpossible("git ne répond pas (pas d'internet ?).")
    if sortie.returncode != 0:
        message = (sortie.stderr or sortie.stdout or "").strip().splitlines()
        raise MiseAJourImpossible("git %s : %s" % (args[0], message[-1] if message else "échec"))
    return sortie.stdout.strip()


def _court(sha):
    return (sha or "")[:7]


def _modifications_locales(dossier):
    """Fichiers suivis par git modifiés sur ce poste (la base, ignorée, n'en fait pas partie)."""
    lignes = git("status", "--porcelain", "--untracked-files=no", dossier=dossier).splitlines()
    return [ligne[3:] for ligne in lignes if ligne.strip()]


# ------------------------------------------------------------------
# Vérification
# ------------------------------------------------------------------

def etat():
    with _verrou:
        return dict(_etat, nouveautes=list(_etat["nouveautes"]))


def _maj_etat(**valeurs):
    with _verrou:
        _etat.update(valeurs)


def verifier(dossier=None, maintenant=None):
    """
    Interroge GitHub et met à jour l'état. Ne lève jamais d'exception : sans
    internet, l'outil continue de tourner et réessaiera 4 heures plus tard.
    """
    dossier = dossier or RACINE
    maintenant = time.time() if maintenant is None else maintenant
    try:
        if not os.path.isdir(os.path.join(dossier, ".git")):
            raise MiseAJourImpossible(
                "Ce dossier n'est pas un clone git : mises à jour automatiques indisponibles.")
        branche = git("rev-parse", "--abbrev-ref", "HEAD", dossier=dossier)
        locale = git("rev-parse", "HEAD", dossier=dossier)
        if branche != BRANCHE:
            raise MiseAJourImpossible(
                "L'outil est sur la branche « %s » : seules les mises à jour de « %s » "
                "sont proposées." % (branche, BRANCHE))
        git("fetch", "--quiet", DISTANT, BRANCHE, dossier=dossier)
        distante = git("rev-parse", "%s/%s" % (DISTANT, BRANCHE), dossier=dossier)
        nombre = int(git("rev-list", "--count", "HEAD..%s/%s" % (DISTANT, BRANCHE),
                         dossier=dossier) or 0)
        nouveautes = []
        raison = None
        if nombre:
            titres = git("log", "--format=%s", "-n", "10", "HEAD..%s/%s" % (DISTANT, BRANCHE),
                         dossier=dossier)
            nouveautes = [t for t in titres.splitlines() if t.strip()]
            try:
                git("merge-base", "--is-ancestor", "HEAD", "%s/%s" % (DISTANT, BRANCHE),
                    dossier=dossier)
            except MiseAJourImpossible:
                raison = ("La copie de ce poste contient des changements absents de GitHub : "
                          "mise à jour à faire à la main.")
        _maj_etat(disponible=bool(nombre) and raison is None, nombre=nombre,
                  nouveautes=nouveautes, version_locale=_court(locale),
                  version_distante=_court(distante), verifie_le=maintenant, raison=raison)
    except MiseAJourImpossible as exc:
        _maj_etat(disponible=False, nombre=0, nouveautes=[], verifie_le=maintenant,
                  raison=str(exc))
    return etat()


def version_locale(dossier=None):
    try:
        return _court(git("rev-parse", "HEAD", dossier=dossier or RACINE))
    except MiseAJourImpossible:
        return ""


def demarrer_verifications(intervalle=INTERVALLE, premiere=PREMIERE_VERIFICATION):
    """Thread de fond : une vérification peu après le démarrage, puis toutes les 4 heures."""
    _maj_etat(version_locale=version_locale())

    def boucle():
        time.sleep(premiere)
        while not REDEMARRER.is_set():
            verifier()
            REDEMARRER.wait(intervalle)

    fil = threading.Thread(target=boucle, name="mises-a-jour", daemon=True)
    fil.start()
    return fil


# ------------------------------------------------------------------
# Installation
# ------------------------------------------------------------------

def installer(dossier=None, pip=None):
    """
    Avance la copie locale jusqu'à origin/main puis demande le redémarrage.
    Refuse (MiseAJourImpossible) plutôt que de risquer d'écraser quoi que ce soit.
    """
    dossier = dossier or RACINE
    with _verrou:
        if _etat["en_cours"]:
            raise MiseAJourImpossible("Une mise à jour est déjà en cours.")
        _etat["en_cours"] = True
    try:
        verifier(dossier)
        courant = etat()
        if not courant["disponible"]:
            raise MiseAJourImpossible(courant["raison"] or "L'outil est déjà à jour.")
        modifies = _modifications_locales(dossier)
        if modifies:
            raise MiseAJourImpossible(
                "Des fichiers de l'outil ont été modifiés sur ce poste (%s) : mise à jour "
                "annulée pour ne rien écraser." % ", ".join(modifies[:5]))

        avant = git("rev-parse", "HEAD", dossier=dossier)
        git("merge", "--ff-only", "--quiet", "%s/%s" % (DISTANT, BRANCHE), dossier=dossier)
        apres = git("rev-parse", "HEAD", dossier=dossier)

        changes = git("diff", "--name-only", avant, apres, dossier=dossier).splitlines()
        if "requirements.txt" in changes:
            (pip or installer_dependances)(dossier)

        _maj_etat(disponible=False, nombre=0, nouveautes=[], version_locale=_court(apres),
                  raison=None)
        REDEMARRER.set()
        return {"avant": _court(avant), "apres": _court(apres), "fichiers": len(changes)}
    finally:
        _maj_etat(en_cours=False)


def installer_dependances(dossier):
    """pip install -r requirements.txt ; un échec n'empêche pas le redémarrage."""
    try:
        subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "-r",
                        os.path.join(dossier, "requirements.txt")],
                       cwd=dossier, timeout=600, check=False,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as exc:
        print("[!] Dépendances non mises à jour : %s" % exc)


# ------------------------------------------------------------------
# Redémarrage
# ------------------------------------------------------------------

VARIABLE_REDEMARRAGE = "TOOTH_DENTAIRE_REDEMARRAGE"


def _option(argument, nom):
    """Vrai si argument désigne l'option nom (argparse accepte aussi un préfixe : --import)."""
    option = argument.split("=", 1)[0]
    return len(option) > 2 and nom.startswith(option)


def arguments_relance(argv):
    """
    Options du serveur relancé : les mêmes, sans --importer <dossier> ni
    --forcer (l'import ne doit pas être rejoué sur la base du cabinet), et
    avec --sans-navigateur.
    """
    arguments = []
    sauter = False
    for a in argv:
        if sauter:
            sauter = False
            continue
        if _option(a, "--importer"):
            sauter = "=" not in a                 # « --importer X » : X est sauté aussi
            continue
        if _option(a, "--forcer") or a == "--sans-navigateur":
            continue
        arguments.append(a)
    return arguments + ["--sans-navigateur"]


def relancer(argv):
    """
    Lance le serveur mis à jour (mêmes options, sans rouvrir le navigateur).
    Sous Windows, dans une nouvelle fenêtre : celle-ci se ferme ensuite.
    """
    script = os.path.join(RACINE, "serveur.py")
    arguments = arguments_relance(argv)
    env = dict(os.environ, **{VARIABLE_REDEMARRAGE: "1"})
    if os.name == "nt":
        subprocess.Popen([sys.executable, script] + arguments, cwd=RACINE, env=env,
                         creationflags=subprocess.CREATE_NEW_CONSOLE)
    else:
        os.execve(sys.executable, [sys.executable, script] + arguments, env)
