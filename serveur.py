#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""Transition vers la version Rust de tooth_dentaire.

L'outil n'est plus en Python. Ce petit fichier reste pour ce qui démarre encore
« python serveur.py » : l'ancienne mise à jour automatique (qui relance serveur.py
par son nom juste après avoir installé la nouvelle version) et les raccourcis des
postes. Il passe la main, avec les mêmes options, à demarrer_TOOTH_DENTAIRE.sh
(Linux, macOS, Raspberry Pi) ou .cmd (Windows), qui obtient l'exécutable puis le
lance. Bibliothèque standard seulement.
"""

import os
import subprocess
import sys

ICI = os.path.dirname(os.path.abspath(__file__))


def main():
    options = sys.argv[1:]
    if os.name == "nt":
        return subprocess.call(["cmd", "/c", "call", os.path.join(ICI, "demarrer_TOOTH_DENTAIRE.cmd")] + options,
                               cwd=ICI)
    os.chdir(ICI)
    # même processus : arrêter son groupe de processus arrête aussi l'exécutable
    os.execvp("sh", ["sh", os.path.join(ICI, "demarrer_TOOTH_DENTAIRE.sh")] + options)


if __name__ == "__main__":
    sys.exit(main())
