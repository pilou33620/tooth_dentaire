#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""Transition vers la version Rust de tooth_dentaire.

L'outil n'est plus en Python. Ce petit fichier reste pour ce qui démarre encore
« python serveur.py » : l'ancienne mise à jour automatique (qui relance serveur.py
par son nom juste après avoir installé la nouvelle version), web_launcher et les
raccourcis des postes. Il passe la main, avec les mêmes options, à lancer.sh
(Linux, macOS, Raspberry Pi) ou à Lancer.bat (Windows), qui obtiennent
l'exécutable puis le lancent. Bibliothèque standard seulement.
"""

import os
import subprocess
import sys

ICI = os.path.dirname(os.path.abspath(__file__))


def main():
    options = sys.argv[1:]
    if os.name == "nt":
        return subprocess.call(["cmd", "/c", "call", os.path.join(ICI, "Lancer.bat")] + options, cwd=ICI)
    os.chdir(ICI)
    # même processus : web_launcher arrête l'outil par SIGTERM sur ce numéro de processus
    os.execvp("sh", ["sh", os.path.join(ICI, "lancer.sh")] + options)


if __name__ == "__main__":
    sys.exit(main())
