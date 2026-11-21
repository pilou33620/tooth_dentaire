# -*- coding: utf-8 -*-
"""
Essai de passage d'un poste du cabinet, de l'ancien serveur Python au serveur Rust (CI).

    python scripts/essai_passage.py

Simule un poste resté sur la dernière version Python de main, lancé directement
(« python serveur.py », comme Lancer.bat, un raccourci ou web_launcher), sans cargo :
1. un faux « GitHub » (dépôt nu local) dont main est la version Rust (ce commit) ;
2. le poste : un clone remis sur l'ancien commit Python, avec une base existante
   écrite par l'ancien python/base.py ;
3. l'ancien serveur.py démarre : sa mise à jour automatique avance la copie, puis le
   relance par son nom ; le petit serveur.py de transition passe la main à lancer.sh
   (ou Lancer.bat), qui télécharge l'exécutable (publication « binaires ») et le lance.
Vérifie que c'est bien le serveur Rust qui répond, sur la même base, et que la copie
« avant-rust » de la base a été faite. Bilan court ; code de sortie 0 ou 1.
"""

import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOWS = os.name == "nt"


def git(*args, dossier=RACINE):
    return subprocess.run(["git"] + list(args), cwd=dossier, check=True, capture_output=True,
                          text=True).stdout.strip()


def port_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def demander(port, chemin):
    """(en-tête Server, corps JSON) ou None si personne ne répond."""
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", chemin, headers={"Host": "127.0.0.1:%d" % port})
        rep = conn.getresponse()
        corps = rep.read()
        conn.close()
        return rep.getheader("Server") or "", json.loads(corps.decode("utf-8"))
    except (OSError, ValueError, http.client.HTTPException):
        return None


def arreter_rust():
    if WINDOWS:
        subprocess.run(["taskkill", "/F", "/T", "/IM", "tooth.exe"], capture_output=True)
    else:
        subprocess.run(["pkill", "-f", "bin/tooth"], capture_output=True)


def main():
    tmp = tempfile.mkdtemp(prefix="tooth-passage-")
    github, poste = os.path.join(tmp, "github.git"), os.path.join(tmp, "cabinet")
    ancien = git("merge-base", "HEAD", "origin/main")
    nouveau = git("rev-parse", "HEAD")
    git("init", "-q", "--bare", "-b", "main", github, dossier=tmp)
    git("push", "-q", github, "HEAD:refs/heads/main")
    git("clone", "-q", github, poste, dossier=tmp)
    git("reset", "-q", "--hard", ancien, dossier=poste)
    if not os.path.isfile(os.path.join(poste, "python", "base.py")):
        print("ÉCHEC : le commit %s de main n'est pas l'ancienne version Python" % ancien[:7])
        return 1
    # une base existante, écrite par l'ancien serveur
    subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, 'python'); import base; "
                    "base.definir_chemin('donnees/stock.db'); base.update_produit({'reference': 'AVANT-RUST'})"],
                   cwd=poste, check=True)

    # un poste sans cargo : l'exécutable vient de la publication « binaires »
    env = {k: v for k, v in os.environ.items() if not k.startswith(("TOOTH_", "CARGO", "RUSTUP"))}
    env["PATH"] = os.pathsep.join(p for p in env.get("PATH", "").split(os.pathsep) if ".cargo" not in p)
    env["PYTHONIOENCODING"] = "utf-8"
    port = port_libre()
    console = open(os.path.join(tmp, "console.txt"), "wb")
    proc = subprocess.Popen([sys.executable, "serveur.py", "--port", str(port), "--local", "--sans-navigateur",
                             "--sans-pause"], cwd=poste, env=env, stdin=subprocess.DEVNULL, stdout=console,
                            stderr=subprocess.STDOUT)
    exe = os.path.join(poste, "bin", "tooth.exe" if WINDOWS else "tooth")
    erreurs, reponse = [], None
    try:
        fin = time.time() + 600
        while time.time() < fin:
            r = demander(port, "/api/etat")
            if r and "StockCabinet" not in r[0]:
                reponse = r[1]
                break
            time.sleep(1)
        if reponse is None:
            erreurs.append("aucun serveur Rust ne répond sur le port %d après 10 minutes" % port)
        else:
            refs = [p["reference"] for p in reponse["base"]["produits"]]
            if "AVANT-RUST" not in refs:
                erreurs.append("la base existante n'a pas été reprise (produits : %s)" % refs)
        if git("rev-parse", "HEAD", dossier=poste) != nouveau:
            erreurs.append("la copie du poste n'a pas avancé jusqu'à la version Rust")
        if not os.path.isfile(exe):
            erreurs.append("exécutable %s absent" % exe)
        donnees = os.path.join(poste, "donnees")
        if not any(f.startswith("stock.db.avant-rust-") for f in os.listdir(donnees)):
            erreurs.append("pas de copie avant-rust dans %s" % os.listdir(donnees))
        if git("status", "--porcelain", "--untracked-files=no", dossier=poste):
            erreurs.append("fichiers suivis modifiés sur le poste : la mise à jour suivante serait bloquée")
    finally:
        arreter_rust()
        try:
            proc.terminate()
            proc.wait(20)
        except (OSError, subprocess.TimeoutExpired):
            pass
        console.close()
    systeme = {"nt": "Windows", "posix": sys.platform}[os.name]
    if erreurs:
        print("Passage Python -> Rust (%s) : ÉCHEC" % systeme)
        for e in erreurs:
            print(" - " + e)
        with open(os.path.join(tmp, "console.txt"), "rb") as f:
            print("\n--- console du poste (fin) ---\n" + f.read().decode("utf-8", "replace")[-2500:])
        return 1
    print("Passage Python -> Rust (%s) : OK — %s -> %s par l'ancienne mise à jour, serveur Rust téléchargé et "
          "lancé sur la même base, copie avant-rust faite." % (systeme, ancien[:7], nouveau[:7]))
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
