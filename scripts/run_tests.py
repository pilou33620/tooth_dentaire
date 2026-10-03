# -*- coding: utf-8 -*-
"""
Lance tous les tests : Python (pytest) puis JavaScript (Jest).

    python scripts/run_tests.py

Les tests JavaScript demandent Node.js et les dépendances de web/
(cd web && npm install). Si Node n'est pas installé mais que VS Code l'est,
son moteur Node intégré est utilisé à la place (ELECTRON_RUN_AS_NODE).
"""

import os
import shutil
import subprocess
import sys
import tempfile

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(RACINE, "web")


def moteur_node():
    """Commande et environnement pour exécuter Node, ou (None, None)."""
    node = shutil.which("node")
    if node:
        return [node], dict(os.environ)
    code = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs",
                        "Microsoft VS Code", "Code.exe")
    if os.path.isfile(code):
        env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
        return [code], env
    return None, None


def tests_python():
    print("=" * 60 + "\nTests Python\n" + "=" * 60)
    return subprocess.call([sys.executable, "-m", "pytest", "tests", "-q"], cwd=RACINE)


def tests_javascript():
    print("=" * 60 + "\nTests JavaScript\n" + "=" * 60)
    commande, env = moteur_node()
    if commande is None:
        print("[!] Node.js introuvable : tests JavaScript ignorés.")
        return 0
    jest = os.path.join(WEB, "node_modules", "jest", "bin", "jest.js")
    if not os.path.isfile(jest):
        print("[!] Dépendances absentes : lancer « npm install » dans web/.")
        return 0
    # Le moteur de VS Code n'écrit pas dans la console : on passe par un fichier.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as sortie:
        code = subprocess.call(commande + ["--experimental-vm-modules", jest, "--ci"],
                               cwd=WEB, env=env, stdout=sortie, stderr=subprocess.STDOUT)
        sortie.seek(0)
        for ligne in sortie:
            if ligne.startswith(("PASS", "FAIL", "Tests:", "Test Suites:", "  ●")):
                print(ligne.rstrip())
    return code


def main():
    codes = [tests_python(), tests_javascript()]
    ok = all(c == 0 for c in codes)
    print("\n" + ("Tous les tests passent." if ok else "Des tests échouent."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
