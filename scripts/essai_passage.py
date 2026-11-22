# -*- coding: utf-8 -*-
"""
Essais de démarrage d'un poste du cabinet par demarrer_TOOTH_DENTAIRE (CI, job « passage »).

    python scripts/essai_passage.py --depart SHA --publication DOSSIER [--exe-depart DOSSIER]
    python scripts/essai_passage.py --prod --publication DOSSIER

DOSSIER de publication : les archives de ce commit faites par scripts/archives.sh, servies par
un faux serveur local comme la publication « binaires » de GitHub (TOOTH_DEPOT ; sous Linux et
macOS, un faux curl y renvoie aussi l'ancien binaires.sh, dont l'adresse est écrite en dur).

--depart : un poste sans cargo resté sur le commit SHA, avec une base écrite par l'ancien
serveur Python (et, pour un départ Rust, l'exécutable de ce départ dans bin/, --exe-depart),
démarre comme sur le PC du cabinet : Lancer.bat sous Windows (comme son raccourci), sinon
serveur.py (départ Python) ou lancer.sh (départ Rust). Vérifie qu'il se met à jour seul jusqu'à
ce commit et arrive sur l'exécutable de ce commit, lancé par demarrer_TOOTH_DENTAIRE, sur la même
base, avec une seule copie « avant-rust », sans pause ; que l'arrêt (fermer sa fenêtre ou son
terminal : tout l'arbre) arrête l'exécutable ; qu'un nouveau démarrage par l'ancien point
d'entrée marche ; et qu'une mise à jour suivante passe encore (lanceurs masqués compris).

--prod : l'archive tooth-prod décompressée dans un dossier vide (sans git ni sources) démarre
par demarrer_TOOTH_DENTAIRE, puis se met à jour seule quand une nouvelle archive est publiée,
sans toucher à donnees/ ni aux *.local.json.

Bilan court ; code de sortie 0 ou 1.
"""

import argparse
import functools
import glob
import hashlib
import http.client
import http.server
import io
import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import zipfile

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WINDOWS = os.name == "nt"
EXE = "tooth.exe" if WINDOWS else "tooth"
ANCIEN_PYTHON = "d3469e8"  # dernier commit Python pur : son python/base.py écrit la base du poste
GITHUB = "https://github.com/pilou33620/tooth_dentaire/releases/download/binaires/"
PAUSES = ("Appuyez sur", "Press any key")
SYSTEME = {"nt": "Windows", "posix": sys.platform}[os.name]


def git(*args, dossier=RACINE):
    return subprocess.run(["git"] + list(args), cwd=dossier, check=True, capture_output=True,
                          text=True).stdout.strip()


def port_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def demander(port, chemin="/api/etat"):
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


def lire(chemin):
    try:
        with open(chemin, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def empreinte(chemin):
    with open(chemin, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# ------------------------------------------------------------------ faux GitHub

class Silencieux(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def fausse_publication(tmp):
    """Un faux GitHub local : (dossier de la publication « binaires », adresse du dépôt)."""
    site = os.path.join(tmp, "site")
    binaires = os.path.join(site, "releases", "download", "binaires")
    os.makedirs(binaires)
    serveur = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Silencieux, directory=site))
    threading.Thread(target=serveur.serve_forever, daemon=True).start()
    return binaires, "http://127.0.0.1:%d" % serveur.server_address[1]


def publier(archive, binaires):
    shutil.copy(archive, binaires)
    with open(os.path.join(binaires, os.path.basename(archive) + ".sha256"), "w") as f:
        f.write(empreinte(archive) + "\n")


def faux_curl(tmp, depot):
    """Linux, macOS : l'ancien binaires.sh (encore en mémoire après la mise à jour) télécharge à une
    adresse écrite en dur ; ce faux curl la renvoie au faux GitHub. Rend le dossier à mettre en tête
    du PATH, ou None (Windows : seuls les nouveaux scripts, qui lisent TOOTH_DEPOT, téléchargent)."""
    vrai = shutil.which("curl")
    if WINDOWS or not vrai:
        return None
    dossier = os.path.join(tmp, "faux")
    os.makedirs(dossier)
    chemin = os.path.join(dossier, "curl")
    with open(chemin, "w") as f:
        f.write('#!/bin/sh\nfor a do\n  shift\n  case "$a" in %s*) a="%s/releases/download/binaires/${a##*/}" ;; esac\n'
                '  set -- "$@" "$a"\ndone\nexec "%s" "$@"\n' % (GITHUB, depot, vrai))
    os.chmod(chemin, 0o755)
    return dossier


def environnement(depot, faux=None):
    """Un poste sans cargo, qui prend la publication sur le faux GitHub."""
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("TOOTH_", "CARGO", "RUSTUP"))}
    # aucun dossier qui contienne cargo (~/.cargo/bin, mais aussi Homebrew sous macOS)
    chemins = [p for p in env.get("PATH", "").split(os.pathsep)
               if p and not any(os.path.isfile(os.path.join(p, c)) for c in ("cargo", "cargo.exe"))]
    env["PATH"] = os.pathsep.join(([faux] if faux else []) + chemins)
    if not shutil.which("git", path=env["PATH"]):
        raise SystemExit("git introuvable une fois cargo retiré du PATH : %s" % env["PATH"])
    env["PYTHONIOENCODING"] = "utf-8"
    env["TOOTH_DEPOT"] = depot
    return env


# ------------------------------------------------------------------ processus

def processus():
    """[(pid, ppid, ligne de commande)] de tous les processus du poste."""
    if WINDOWS:
        cmd = ["powershell", "-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object "
               "{ '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CommandLine }"]
    else:
        cmd = ["ps", "-eo", "pid=,ppid=,args="]
    sortie = subprocess.run(cmd, capture_output=True, text=True, errors="replace").stdout
    liste = []
    for ligne in sortie.splitlines():
        p = ligne.strip().split(None, 2)
        if len(p) == 3 and p[0].isdigit() and p[1].isdigit():
            liste.append((int(p[0]), int(p[1]), p[2]))
    return liste


def chaine(port):
    """Les processus de l'outil lancé sur ce port : tous ont reçu « --port P --local »."""
    marque = "--port %d --local" % port
    return [p for p in processus() if marque in p[2]]


def est_executable(commande):
    premier = commande.split()[0].strip('"').replace("\\", "/") if commande.split() else ""
    return os.path.basename(premier) in ("tooth", "tooth.exe")


def lance_par_demarrer(port, erreurs):
    """Un seul exécutable de l'outil en marche, dont le parent exécute demarrer_TOOTH_DENTAIRE."""
    liste = chaine(port)
    exes = [p for p in liste if est_executable(p[2])]
    if len(exes) != 1:
        erreurs.append("%d exécutable(s) de l'outil en marche au lieu d'un : %s" % (len(exes), liste))
        return
    parent = [p for p in liste if p[0] == exes[0][1]]
    if not parent or "demarrer_TOOTH_DENTAIRE" not in parent[0][2]:
        erreurs.append("l'exécutable n'est pas lancé par demarrer_TOOTH_DENTAIRE (parent : %s)" % parent)


def lancer(commande, dossier, env, journal):
    return subprocess.Popen(commande, cwd=dossier, env=env, stdin=subprocess.DEVNULL, stdout=journal,
                            stderr=subprocess.STDOUT, start_new_session=not WINDOWS)


def arreter(proc, port, erreurs):
    """Arrête l'outil comme on ferme sa fenêtre (Windows) ou son terminal : tout l'arbre, depuis le
    haut de la chaîne encore en vie. Vérifie que l'exécutable s'arrête avec."""
    if WINDOWS:
        liste = chaine(port)
        pids = {p[0] for p in liste}
        for pid, ppid, _ in liste:
            if ppid not in pids:
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except OSError:
            pass
    try:
        proc.wait(20)
    except subprocess.TimeoutExpired:
        pass
    fin = time.time() + 30
    while time.time() < fin:
        if not chaine(port) and demander(port) is None:
            return
        time.sleep(1)
    erreurs.append("l'arrêt n'a pas arrêté l'outil : %s" % chaine(port))
    for pid, _, _ in chaine(port):  # ménage pour la suite de l'essai
        if WINDOWS:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)
        else:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def attendre_rust(port, condition=lambda: True, delai=600):
    """Le corps de /api/etat dès que le serveur Rust répond et que condition() est vraie, ou None."""
    fin = time.time() + delai
    while time.time() < fin:
        r = demander(port)
        if r and "StockCabinet" not in r[0] and condition():
            return r[1]
        time.sleep(1)
    return None


def bilan(titre, erreurs, tmp, journaux):
    if not erreurs:
        print("%s (%s) : OK" % (titre, SYSTEME))
        shutil.rmtree(tmp, ignore_errors=True)
        return 0
    print("%s (%s) : ÉCHEC" % (titre, SYSTEME))
    for e in erreurs:
        print(" - " + e)
    for j in journaux:
        with open(j, "rb") as f:
            lignes = [l for l in f.read().decode("utf-8", "replace").splitlines() if '"GET /api/' not in l]
        texte = "\n".join(lignes)
        print("\n--- %s ---\n%s" % (os.path.basename(j), texte if len(texte) < 6000 else
                                       texte[:3000] + "\n[...]\n" + texte[-3000:]))
    return 1


def pauses(journal):
    with open(journal, "rb") as f:
        texte = f.read().decode("utf-8", "replace")
    return [p for p in PAUSES if p in texte]


# ------------------------------------------------------------------ passage d'un poste

def creer_base(tmp, poste):
    """Une base existante, écrite par l'ancien serveur Python."""
    ancien = os.path.join(tmp, "python-ancien")
    flux = subprocess.run(["git", "archive", ANCIEN_PYTHON, "python"], cwd=RACINE, check=True,
                          capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(flux)) as t:
        t.extractall(ancien, filter="data")
    subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0, sys.argv[1]); import base; "
                    "base.definir_chemin('donnees/stock.db'); base.update_produit({'reference': 'AVANT-RUST'})",
                    os.path.join(ancien, "python")], cwd=poste, check=True)


def passage(depart, publication, exe_depart):
    tmp = tempfile.mkdtemp(prefix="tooth-passage-")
    github, poste = os.path.join(tmp, "github.git"), os.path.join(tmp, "cabinet")
    depart = git("rev-parse", depart + "^{commit}")
    nouveau = git("rev-parse", "HEAD")
    titre = "Passage %s -> %s" % (depart[:7], nouveau[:7])
    git("init", "-q", "--bare", "-b", "main", github, dossier=tmp)
    git("push", "-q", github, "HEAD:refs/heads/main")
    git("clone", "-q", github, poste, dossier=tmp)
    git("reset", "-q", "--hard", depart, dossier=poste)
    ancien_python = os.path.isdir(os.path.join(poste, "python"))
    creer_base(tmp, poste)
    bin_poste = os.path.join(poste, "bin")
    if not ancien_python:
        # départ Rust : son exécutable est déjà dans bin/, pour ce commit
        if not exe_depart:
            print("%s : --exe-depart manque pour un départ Rust" % titre)
            return 1
        os.makedirs(bin_poste)
        shutil.copy(os.path.join(exe_depart, EXE), bin_poste)
        with open(os.path.join(bin_poste, "commit"), "w") as f:
            f.write(depart + "\n")

    binaires, depot = fausse_publication(tmp)
    for a in glob.glob(os.path.join(publication, "tooth-*")):
        if not os.path.basename(a).startswith("tooth-prod-") and not a.endswith(".sha256"):
            publier(a, binaires)
    env = environnement(depot, faux_curl(tmp, depot))
    port = port_libre()
    options = ["--port", str(port), "--local", "--sans-navigateur", "--sans-pause"]
    if WINDOWS:
        commande = ["cmd", "/c", os.path.join(poste, "Lancer.bat")] + options
    elif ancien_python:
        commande = [sys.executable, os.path.join(poste, "serveur.py")] + options
    else:
        commande = ["sh", os.path.join(poste, "lancer.sh")] + options
    erreurs, journaux = [], [os.path.join(tmp, "console.txt"), os.path.join(tmp, "console-relance.txt")]
    exe = os.path.join(bin_poste, EXE)
    commit_exe = lambda: lire(os.path.join(bin_poste, "commit"))

    # 1. le démarrage habituel : mise à jour, puis demarrer_TOOTH_DENTAIRE
    with open(journaux[0], "wb") as journal:
        proc = lancer(commande, poste, env, journal)
        etat = attendre_rust(port, lambda: commit_exe() == nouveau)
        if etat is None:
            erreurs.append("l'exécutable de ce commit ne répond pas sur le port %d après 10 minutes "
                           "(bin/commit : %s)" % (port, commit_exe()[:7] or "absent"))
        else:
            refs = [p["reference"] for p in etat["base"]["produits"]]
            if "AVANT-RUST" not in refs:
                erreurs.append("la base existante n'a pas été reprise (produits : %s)" % refs)
            lance_par_demarrer(port, erreurs)
        arreter(proc, port, erreurs)
    if git("rev-parse", "HEAD", dossier=poste) != nouveau:
        erreurs.append("la copie du poste n'a pas avancé jusqu'à ce commit")
    if not os.path.isfile(exe):
        erreurs.append("exécutable %s absent" % exe)
    donnees = os.listdir(os.path.join(poste, "donnees"))
    copies = [f for f in donnees if f.startswith("stock.db.avant-rust-")]
    if len(copies) != 1:
        erreurs.append("%d copie(s) avant-rust au lieu d'une : %s" % (len(copies), donnees))
    if WINDOWS:
        attributs = os.stat(os.path.join(poste, "lancer.sh")).st_file_attributes
        if not attributs & stat.FILE_ATTRIBUTE_HIDDEN:
            erreurs.append("lancer.sh n'est pas masqué : demarrer_TOOTH_DENTAIRE.cmd n'a pas tourné")
    elif "demarrer_TOOTH_DENTAIRE.cmd" not in lire(os.path.join(poste, ".hidden")):
        erreurs.append(".hidden ne masque pas demarrer_TOOTH_DENTAIRE.cmd : demarrer_TOOTH_DENTAIRE.sh n'a pas tourné")
    if pauses(journaux[0]):
        erreurs.append("une fenêtre a attendu une touche : %s" % pauses(journaux[0]))

    # 2. le démarrage suivant (demain soir, après-demain) : par l'ancien point d'entrée
    relance = (["cmd", "/c", os.path.join(poste, "Lancer.bat")] if WINDOWS
               else ["sh", os.path.join(poste, "lancer.sh")]) + options
    with open(journaux[1], "wb") as journal:
        proc = lancer(relance, poste, env, journal)
        if attendre_rust(port, delai=120) is None:
            erreurs.append("le démarrage suivant par %s ne répond pas" % os.path.basename(relance[-len(options) - 1]))
        arreter(proc, port, erreurs)
    if pauses(journaux[1]):
        erreurs.append("le démarrage suivant a attendu une touche : %s" % pauses(journaux[1]))

    # 3. une mise à jour suivante touche les lanceurs (masqués sous Windows) : elle doit passer
    dev = os.path.join(tmp, "dev")
    git("clone", "-q", github, dev, dossier=tmp)
    for f in ("demarrer_TOOTH_DENTAIRE.sh", "lancer.sh", "demarrer_TOOTH_DENTAIRE.cmd", "Lancer.bat"):
        with open(os.path.join(dev, f), "ab") as h:
            h.write(b"\n# essai\n" if f.endswith(".sh") else b"\nrem essai\n")
    git("-c", "user.name=essai", "-c", "user.email=essai@example.invalid", "commit", "-qam", "essai", dossier=dev)
    git("push", "-q", "origin", "HEAD:main", dossier=dev)
    try:
        git("fetch", "-q", "origin", "main", dossier=poste)
        git("merge", "--ff-only", "-q", "origin/main", dossier=poste)
    except subprocess.CalledProcessError as e:
        erreurs.append("la mise à jour suivante échoue : %s" % e.stderr.strip())
    if git("status", "--porcelain", "--untracked-files=no", dossier=poste):
        erreurs.append("fichiers suivis modifiés sur le poste : la mise à jour suivante serait bloquée")
    return bilan(titre, erreurs, tmp, journaux)


# ------------------------------------------------------------------ copie de production

def extraire(archive, dossier):
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            z.extractall(dossier)
    else:
        subprocess.run(["tar", "-xzf", archive, "-C", dossier], check=True)


def version_suivante(archive, neuve):
    """La même archive, avec un fichier de plus : une « nouvelle version » publiée."""
    ajout, contenu = "tooth_dentaire/web/essai-maj.txt", b"nouvelle version\n"
    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as zin, zipfile.ZipFile(neuve, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                zout.writestr(info, zin.read(info))
            zout.writestr(ajout, contenu)
    else:
        with tarfile.open(archive, "r:gz") as tin, tarfile.open(neuve, "w:gz") as tout:
            for m in tin.getmembers():
                tout.addfile(m, tin.extractfile(m) if m.isfile() else None)
            info = tarfile.TarInfo(ajout)
            info.size, info.mode, info.mtime = len(contenu), 0o644, time.time()
            tout.addfile(info, io.BytesIO(contenu))


def production(publication):
    archives = [a for a in glob.glob(os.path.join(publication, "tooth-prod-*")) if not a.endswith(".sha256")]
    if len(archives) != 1:
        print("Copie de production : une archive tooth-prod attendue dans %s, trouvé %s" % (publication, archives))
        return 1
    archive = archives[0]
    tmp = tempfile.mkdtemp(prefix="tooth-prod-")
    vide = os.path.join(tmp, "dossier")
    os.makedirs(vide)
    extraire(archive, vide)
    copie = os.path.join(vide, "tooth_dentaire")
    erreurs, journaux = [], [os.path.join(tmp, "console-1.txt"), os.path.join(tmp, "console-2.txt")]
    for absent in (".git", "Cargo.toml", "rust", "donnees"):
        if os.path.exists(os.path.join(copie, absent)):
            erreurs.append("l'archive contient %s" % absent)
    if not os.path.isfile(os.path.join(copie, "bin", EXE)):
        erreurs.append("l'archive n'a pas bin/%s" % EXE)
    # les données du cabinet, que la mise à jour ne doit jamais toucher
    temoins = {os.path.join(copie, "donnees", "temoin.txt"): "à moi\n",
               os.path.join(copie, "reglages.local.json"): '{"a": 1}\n'}
    os.makedirs(os.path.join(copie, "donnees"))
    for chemin, texte in temoins.items():
        with open(chemin, "w", encoding="utf-8") as f:
            f.write(texte)

    binaires, depot = fausse_publication(tmp)
    publier(archive, binaires)
    env = environnement(depot)
    port = port_libre()
    options = ["--port", str(port), "--local", "--sans-navigateur"]
    commande = (["cmd", "/c", os.path.join(copie, "demarrer_TOOTH_DENTAIRE.cmd")] if WINDOWS
                else ["sh", os.path.join(copie, "demarrer_TOOTH_DENTAIRE.sh")]) + options
    prod = os.path.join(copie, "bin", "prod.sha256")
    neuve = os.path.join(tmp, os.path.basename(archive))
    version_suivante(archive, neuve)
    etapes = ((archive, "démarrage de l'archive décompressée"), (neuve, "mise à jour vers une nouvelle archive publiée"))
    for (publiee, quoi), journal_ in zip(etapes, journaux):
        publier(publiee, binaires)
        attendu = empreinte(publiee)
        with open(journal_, "wb") as journal:
            proc = lancer(commande, copie, env, journal)
            if attendre_rust(port, lambda: lire(prod) == attendu, delai=180) is None:
                erreurs.append("%s : l'outil ne répond pas, ou bin/prod.sha256 n'est pas celle de l'archive publiée (%s)"
                               % (quoi, lire(prod)[:12] or "absente"))
            else:
                lance_par_demarrer(port, erreurs)
            arreter(proc, port, erreurs)
        if pauses(journal_):
            erreurs.append("%s : une fenêtre a attendu une touche" % quoi)
    if not os.path.isfile(os.path.join(copie, "web", "essai-maj.txt")):
        erreurs.append("la nouvelle version n'a pas été recopiée (web/essai-maj.txt absent)")
    for chemin, texte in temoins.items():
        if lire(chemin) != texte.strip():
            erreurs.append("%s a été modifié par la mise à jour" % os.path.relpath(chemin, copie))
    if not os.path.isfile(os.path.join(copie, "donnees", "stock.db")):
        erreurs.append("pas de base donnees/stock.db après le démarrage")
    if os.path.exists(os.path.join(copie, ".maj")):
        erreurs.append("le dossier de travail .maj/ est resté")
    return bilan("Copie de production %s" % os.path.basename(archive), erreurs, tmp, journaux)


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--publication", required=True, help="archives de ce commit (scripts/archives.sh)")
    ap.add_argument("--depart", help="commit où le poste est resté")
    ap.add_argument("--exe-depart", help="dossier avec l'exécutable du départ Rust")
    ap.add_argument("--prod", action="store_true", help="essai de la copie de production")
    args = ap.parse_args()
    publication = os.path.abspath(args.publication)
    if args.prod:
        return production(publication)
    if not args.depart:
        ap.error("--depart ou --prod")
    return passage(args.depart, publication, args.exe_depart and os.path.abspath(args.exe_depart))


if __name__ == "__main__":
    sys.exit(main())
