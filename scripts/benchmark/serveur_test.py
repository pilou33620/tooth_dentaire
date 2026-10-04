# -*- coding: utf-8 -*-
"""Serveur de test des benchmarks : base temporaire, port libre, arret propre."""

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def port_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def demarrer(port=0, delai=20):
    """Lance serveur.py sur une base neuve ; retourne (processus, url, dossier).

    Attend que le serveur reponde : s'il ne demarre pas (port pris...), on
    s'arrete au lieu de mesurer des requetes qui echouent toutes.
    """
    port = port or port_libre()
    dossier = tempfile.mkdtemp(prefix="tooth_benchmark_")
    cmd = [sys.executable, os.path.join(RACINE, "serveur.py"),
           "--port", str(port), "--base", os.path.join(dossier, "stock.db"),
           "--local", "--sans-navigateur", "--sans-pause"]
    # Reglages propres au test : l'audit change de base a chaud, ce qui ne
    # doit pas modifier donnees/config.json de l'installation.
    env = dict(os.environ, TOOTH_CONFIG=os.path.join(dossier, "config.json"))
    proc = subprocess.Popen(cmd, cwd=RACINE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = "http://127.0.0.1:%d" % port
    fin = time.time() + delai
    while time.time() < fin:
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen(url + "/api/info", timeout=2) as rep:
                if rep.status == 200:
                    return proc, url, dossier
        except OSError:
            time.sleep(0.2)
    arreter(proc, dossier)
    raise RuntimeError("Le serveur de test ne repond pas sur %s." % url)


def arreter(proc, dossier):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    shutil.rmtree(dossier, ignore_errors=True)
