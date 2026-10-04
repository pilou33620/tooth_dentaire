# -*- coding: utf-8 -*-
"""
Prépare le dossier d'installation à copier sur un poste du cabinet.

    python scripts/preparer_installation.py
    python scripts/preparer_installation.py --python "C:\\...\\python-3.12.9-amd64.exe"

Produit dist/Installation tooth_dentaire/ (et le même dossier en .zip) :

    Installer.bat, installer.ps1, LISEZMOI.txt   (modèles de installation/)
    outil/      serveur.py, Lancer.bat, python/, web/ (sans tests ni node_modules)
    paquets/    openpyxl, certifi... en wheels, pour installer sans internet
    python-3.x.x-amd64.exe                       (si --python est donné)

Aucune donnée du cabinet n'y est copiée (pas de donnees/ ni de *.db).
"""

import argparse
import os
import shutil
import subprocess
import sys

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELES = os.path.join(RACINE, "installation")
DIST = os.path.join(RACINE, "dist")
NOM = "Installation tooth_dentaire"

FICHIERS_OUTIL = ["serveur.py", "Lancer.bat", "README.md"]
DOSSIERS_OUTIL = ["python", "web"]
# Ce qui ne sert qu'au développement (tests JavaScript, caches)
IGNORES = shutil.ignore_patterns(
    "__pycache__", "*.pyc", "node_modules", "tests", "coverage",
    "package.json", "package-lock.json", "*.db", "*.db-*")
# Bibliothèques de requirements.txt qui ne servent qu'aux tests
PAQUETS_TESTS = {"pytest"}


def exigences_outil():
    """Lignes de requirements.txt utiles au serveur (sans les outils de test)."""
    lignes = []
    with open(os.path.join(RACINE, "requirements.txt"), encoding="utf-8") as f:
        for ligne in f:
            ligne = ligne.strip()
            if not ligne or ligne.startswith("#"):
                continue
            nom = ligne.split(";")[0]
            for sep in "<>=!~[ ":
                nom = nom.split(sep)[0]
            if nom.lower() not in PAQUETS_TESTS:
                lignes.append(ligne)
    return lignes


def telecharger_paquets(exigences, dossier):
    """Wheels des bibliothèques (pur Python : valables pour toute version 3.8+)."""
    os.makedirs(dossier, exist_ok=True)
    cmd = [sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
           "--only-binary=:all:", "--dest", dossier] + exigences
    if subprocess.call(cmd) != 0:
        print("[!] Téléchargement des paquets impossible : l'installateur les prendra sur internet.")
        shutil.rmtree(dossier, ignore_errors=True)
        return False
    return True


def preparer(python_exe=None, avec_zip=True):
    cible = os.path.join(DIST, NOM)
    if os.path.isdir(cible):
        shutil.rmtree(cible)
    os.makedirs(cible)

    for nom in ("Installer.bat", "installer.ps1", "LISEZMOI.txt"):
        shutil.copy2(os.path.join(MODELES, nom), cible)

    outil = os.path.join(cible, "outil")
    os.makedirs(outil)
    for nom in FICHIERS_OUTIL:
        shutil.copy2(os.path.join(RACINE, nom), outil)
    for nom in DOSSIERS_OUTIL:
        shutil.copytree(os.path.join(RACINE, nom), os.path.join(outil, nom), ignore=IGNORES)

    exigences = exigences_outil()
    with open(os.path.join(outil, "requirements.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(exigences) + "\n")
    telecharger_paquets(exigences, os.path.join(cible, "paquets"))

    if python_exe:
        shutil.copy2(python_exe, cible)

    print("\nDossier prêt : %s" % cible)
    if avec_zip:
        archive = shutil.make_archive(cible, "zip", DIST, NOM)
        print("Archive      : %s" % archive)
    if not python_exe:
        print("Pensez à y placer l'installateur Python (python-3.x.x-amd64.exe)"
              " si Python n'est pas installé sur le poste.")
    return cible


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--python", metavar="EXE",
                    help="installateur Python à joindre (python-3.x.x-amd64.exe)")
    ap.add_argument("--sans-zip", action="store_true", help="ne pas produire le .zip")
    args = ap.parse_args(argv)
    if args.python and not os.path.isfile(args.python):
        ap.error("installateur Python introuvable : %s" % args.python)
    preparer(args.python, avec_zip=not args.sans_zip)
    return 0


if __name__ == "__main__":
    sys.exit(main())
