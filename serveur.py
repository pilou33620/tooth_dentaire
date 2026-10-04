#!/usr/bin/python3
# -*- coding: utf-8 -*-
# ==========================================
# VERSIONING
# Version: 3.0.0
# Date: 2026-10-03
# Explication: refonte de l'application PySide6 en serveur Python + interface
#   dans le navigateur (meme methode que les outils web_cao). Le serveur sert
#   web/ et expose la base SQLite par une API JSON /api/... ; plusieurs postes
#   du cabinet peuvent ouvrir l'outil en meme temps. Les donnees qui vivaient
#   dans le navigateur integre (planning, taches, dosimetres, rappels, carnet
#   d'adresses) sont desormais en base. Aucune donnee du cabinet dans le code.
# Fonctions ajoutees/modifiees :
# - CustomHandler (fichiers statiques de web/, API /api/*)
# - start_server, main, lancer
# ==========================================
"""Serveur de l'outil de gestion de stock du cabinet dentaire.

    python serveur.py                    # ecoute sur le reseau local, port 8150
    python serveur.py --local            # ce poste uniquement
    python serveur.py --port 9000
    python serveur.py --base D:\\stock.db  # utiliser une autre base
    python serveur.py --importer "C:\\chemin\\vers\\ancienne-appli"   # reprendre l'ancienne appli
    python serveur.py --sans-navigateur  # ne pas ouvrir le navigateur

Un double-clic suffit sous Windows : le navigateur s'ouvre sur la bonne adresse
et la console reste ouverte. Les autres postes du cabinet ouvrent l'adresse
reseau affichee au demarrage (http://<ip>:8150/).

C'est un serveur sans authentification : a n'utiliser que sur le reseau du
cabinet. --local coupe l'acces depuis les autres postes.
"""

import argparse
import base64
import http.server
import ipaddress
import json
import os
import posixpath
import re
import socket
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
import webbrowser

VERSION = "3.0.0"
DEFAULT_PORT = 8150
TAILLE_MAX_CORPS = 20 * 1024 * 1024        # 20 Mo : un planning ou un carnet complet

ROOT = os.path.dirname(os.path.abspath(__file__))
DOSSIER_WEB = os.path.join(ROOT, "web")
DOSSIER_DONNEES = os.path.join(ROOT, "donnees")
FICHIER_CONFIG = os.path.join(DOSSIER_DONNEES, "config.json")
BASE_DEFAUT = os.path.join(DOSSIER_DONNEES, "stock.db")

DOSSIER_PYTHON = os.path.join(ROOT, "python")
if DOSSIER_PYTHON not in sys.path:
    sys.path.insert(0, DOSSIER_PYTHON)

import base                                   # noqa: E402
import exports                                # noqa: E402
import meteo                                  # noqa: E402
import mise_a_jour                            # noqa: E402
import sauvegarde                             # noqa: E402

# Origines acceptees pour les requetes qui modifient les donnees (CSRF) :
# localhost et les adresses des reseaux prives (postes du cabinet).
ORIGINES = re.compile(
    r"^https?://(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|"
    r"192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$")


# ------------------------------------------------------------------
# Configuration (chemin de la base)
# ------------------------------------------------------------------

def charger_config():
    try:
        with open(FICHIER_CONFIG, "r", encoding="utf-8") as f:
            config = json.load(f)
            return config if isinstance(config, dict) else {}
    except (OSError, ValueError):
        return {}


def enregistrer_config(config):
    os.makedirs(DOSSIER_DONNEES, exist_ok=True)
    with open(FICHIER_CONFIG, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)


def chemin_base_configure():
    chemin = charger_config().get("base", "")
    if chemin and os.path.isfile(chemin):
        return chemin
    return BASE_DEFAUT


# ------------------------------------------------------------------
# Reseau
# ------------------------------------------------------------------

def get_local_ip():
    """Adresse IP de la machine sur le reseau local."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        ip = ""
    finally:
        s.close()
    if ip in ("", "0.0.0.0"):
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except OSError:
            ip = "127.0.0.1"
    return ip


def adresse_locale(host, port):
    if host in ("", "::", "0.0.0.0", "::1"):
        host = "127.0.0.1"
    return "http://%s:%d/" % (host, port)


def est_boucle_locale(adresse):
    try:
        return ipaddress.ip_address(adresse.split("%")[0]).is_loopback
    except ValueError:
        return False


# ------------------------------------------------------------------
# Gestionnaire HTTP
# ------------------------------------------------------------------

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    """Sert web/ sans cache, et l'API JSON /api/*."""

    server_version = "StockCabinet/" + VERSION
    ECOUTE_LOCALE = False                     # fixe par start_server

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOSSIER_WEB, **kwargs)

    # -- securite ---------------------------------------------------

    def parse_request(self):
        if not super().parse_request():
            return False
        # Protection DNS rebinding : seul un Host connu est accepte.
        hote = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if hote:
            permis = {"localhost", "127.0.0.1", "::1", get_local_ip()}
            try:
                permis.add(str(self.server.server_address[0]).split("%")[0])
            except (AttributeError, IndexError):
                pass
            try:
                permis.add(socket.gethostname().lower())
            except OSError:
                pass
            if hote not in permis:
                self.send_error(403, "Host non autorise")
                return False
        return True

    def _origine_valide(self):
        """Rejette les requetes modificatrices venant d'un autre site (CSRF)."""
        origine = self.headers.get("Origin")
        if origine and not ORIGINES.match(origine):
            self._json({"status": "error", "message": "Origine refusee."}, 403)
            return False
        return True

    def _client_local(self):
        return est_boucle_locale(self.client_address[0])

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404, "Fichier introuvable")
        return None

    def send_head(self):
        chemin = urllib.parse.urlsplit(self.path).path
        if chemin == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return None
        cible = os.path.realpath(self.translate_path(posixpath.normpath(chemin)))
        racine = os.path.realpath(DOSSIER_WEB)
        if cible != racine and not cible.startswith(racine + os.sep):
            self.send_error(404, "Fichier introuvable")
            return None
        return super().send_head()

    def guess_type(self, path):
        if path.endswith((".js", ".mjs")):
            return "application/javascript"
        return super().guess_type(path)

    def log_message(self, format, *args):
        # Journal lisible : on n'affiche ni les fichiers statiques ni la
        # surveillance de revision qui tourne toutes les quelques secondes.
        texte = format % args
        if "/api/revision" in texte or ("/api/" not in texte and '" 200 ' in texte) \
                or '" 304 ' in texte:
            return
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), texte))

    # -- utilitaires --------------------------------------------------

    def _route(self):
        return urllib.parse.urlsplit(self.path).path.rstrip("/") or "/"

    def _query(self):
        return {k: v[0] for k, v in urllib.parse.parse_qs(
            urllib.parse.urlsplit(self.path).query).items()}

    def _json(self, charge, code=200):
        corps = json.dumps(charge, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(corps)

    def _lire_json(self):
        try:
            taille = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            taille = 0
        if taille > TAILLE_MAX_CORPS:
            raise base.ErreurDonnees("Requete trop volumineuse.")
        brut = self.rfile.read(taille) if taille > 0 else b""
        if not brut:
            return None
        try:
            return json.loads(brut.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise base.ErreurDonnees("JSON invalide.")

    def _executer(self, action):
        """Execute action() et traduit les erreurs en JSON."""
        try:
            resultat = action()
            if resultat is None:
                resultat = {}
            resultat.setdefault("status", "ok")
            resultat.setdefault("revision", base.revision())
            self._json(resultat)
        except base.ErreurDonnees as exc:
            self._json({"status": "error", "message": str(exc)}, 400)
        except (exports.ExportIndisponible, meteo.MeteoIndisponible) as exc:
            self._json({"status": "error", "message": str(exc)}, 503)
        except mise_a_jour.MiseAJourImpossible as exc:
            self._json({"status": "error", "message": str(exc)}, 409)
        except Exception as exc:                          # noqa: BLE001
            traceback.print_exc()
            self._json({"status": "error", "message": "Erreur serveur : %s" % exc}, 500)

    # -- routes -------------------------------------------------------

    def do_GET(self):
        route = self._route()
        if not route.startswith("/api/"):
            return super().do_GET()
        q = self._query()
        if route == "/api/revision":
            return self._json({"revision": base.revision()})
        if route == "/api/etat":
            return self._executer(lambda: {
                "base": base.charger_base(),
                "documents": base.lire_documents(),
            })
        if route == "/api/info":
            return self._executer(self._info)
        if route == "/api/contacts":
            return self._executer(lambda: {"contacts": base.lister_contacts()})
        if route.startswith("/api/documents/"):
            cle = route[len("/api/documents/"):]
            return self._executer(lambda: {"valeur": base.lire_document(cle)})
        if route == "/api/meteo":
            return self._executer(lambda: meteo.meteo_actuelle(base.lire_document("meteo_lieu")))
        if route == "/api/mise-a-jour":
            return self._executer(mise_a_jour.etat)
        if route == "/api/meteo/communes":
            return self._executer(lambda: {"communes": meteo.chercher_communes(q.get("q", ""))})
        if route == "/api/base":
            return self._executer(lambda: {
                "chemin": base.CHEMIN_BASE,
                "modifiable": self._client_local(),
            })
        if route == "/api/sauvegardes":
            return self._executer(self._sauvegardes)
        self._json({"status": "error", "message": "Route inconnue."}, 404)

    def do_HEAD(self):
        if self._route().startswith("/api/"):
            return self._json({}, 405)
        return super().do_HEAD()

    def do_POST(self):
        route = self._route()
        if not self._origine_valide():
            return
        routes = {
            "/api/produit": lambda d: base.update_produit(d),
            "/api/stock": lambda d: base.update_stock_item(d),
            "/api/transaction": lambda d: {"id": base.add_transaction(d)},
            "/api/maintenance": lambda d: {"id": base.add_autoclave(d)},
            "/api/historique-prix": lambda d: {"id": base.add_historique_prix(d)},
            "/api/contacts": lambda d: {"contact": base.enregistrer_contact(d)},
            "/api/base": self._changer_base,
            "/api/sauvegardes": lambda d: {"sauvegarde": self._sans_chemin(sauvegarde.sauvegarder())},
            "/api/mise-a-jour/verifier": lambda d: mise_a_jour.verifier(),
            "/api/mise-a-jour/installer": self._installer_mise_a_jour,
            "/api/export/stock": lambda d: self._export(exports.export_stock(base.charger_base())),
            "/api/export/liste-courses": lambda d: self._export(
                exports.liste_courses(base.charger_base())),
            "/api/export/consommation": lambda d: self._export(exports.stats_consommation(
                base.charger_base(), (d or {}).get("references") or [])),
            "/api/export/chirurgie": lambda d: self._export(exports.extraction_chirurgie(
                base.charger_base(), (d or {}).get("date_debut"), (d or {}).get("date_fin"))),
        }
        action = routes.get(route)
        if action is None:
            return self._json({"status": "error", "message": "Route inconnue."}, 404)
        self._executer(lambda: action(self._lire_json()))

    def do_PUT(self):
        route = self._route()
        if not self._origine_valide():
            return
        if route.startswith("/api/documents/"):
            cle = route[len("/api/documents/"):]
            return self._executer(lambda: base.ecrire_document(cle, self._lire_json()))
        self._json({"status": "error", "message": "Route inconnue."}, 404)

    def do_DELETE(self):
        route = self._route()
        if not self._origine_valide():
            return
        q = self._query()
        if route == "/api/produit":
            return self._executer(lambda: base.delete_produit(q.get("reference", "")))
        if route == "/api/stock":
            return self._executer(lambda: base.delete_stock_item(
                q.get("reference", ""), q.get("utilisateur", "")))
        if route == "/api/contacts":
            return self._executer(lambda: base.supprimer_contact(q.get("id")))
        self._json({"status": "error", "message": "Route inconnue."}, 404)

    # -- actions ------------------------------------------------------

    def _info(self):
        port = self.server.server_address[1]
        adresses = [] if CustomHandler.ECOUTE_LOCALE else \
            ["http://%s:%d/" % (get_local_ip(), port)]
        return {"version": VERSION, "adresses_reseau": adresses,
                "commit": mise_a_jour.etat()["version_locale"]}

    @staticmethod
    def _sans_chemin(copie):
        return {k: v for k, v in copie.items() if k != "chemin"} if copie else None

    def _sauvegardes(self):
        copies = sauvegarde.lister()
        return {"dossier": sauvegarde.dossier_sauvegardes(),
                "derniere": self._sans_chemin(copies[0] if copies else None),
                "nombre": len(copies)}

    def _installer_mise_a_jour(self, data):
        resultat = mise_a_jour.installer()
        # Laisser partir la réponse, puis arrêter le serveur : lancer() relance
        # le programme mis à jour (voir mise_a_jour.REDEMARRER).
        minuteur = threading.Timer(1.0, self.server.shutdown)
        minuteur.daemon = True
        minuteur.start()
        return resultat

    def _export(self, resultat):
        contenu = resultat.pop("contenu", None)
        if contenu is not None:
            resultat["contenu_base64"] = base64.b64encode(contenu).decode("ascii")
        return resultat

    def _changer_base(self, data):
        if not self._client_local():
            raise base.ErreurDonnees(
                "Le changement de base ne se fait que depuis le poste qui fait tourner le serveur.")
        chemin = str((data or {}).get("chemin") or "").strip().strip('"')
        if not chemin:
            raise base.ErreurDonnees("Chemin vide.")
        chemin = os.path.abspath(os.path.expanduser(chemin))
        if not os.path.isfile(chemin):
            raise base.ErreurDonnees("Fichier introuvable : %s" % chemin)
        base.definir_chemin(chemin)
        config = charger_config()
        config["base"] = chemin
        enregistrer_config(config)
        return {"chemin": chemin}


class ServeurThreade(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def creer_serveur(host, port):
    try:
        return ServeurThreade((host, port), CustomHandler), None
    except OSError as exc:
        return None, exc


def ouvrir_navigateur(url, delai=0.8):
    def _ouvrir():
        try:
            webbrowser.open(url)
        except Exception as exc:                          # noqa: BLE001
            print("[!] Ouverture du navigateur impossible : %s" % exc)
    minuteur = threading.Timer(delai, _ouvrir)
    minuteur.daemon = True
    minuteur.start()


def start_server(host, port, navigateur=True):
    httpd, erreur = creer_serveur(host, port)
    # Après une mise à jour, l'ancien serveur libère le port à l'instant : on
    # l'attend un peu plutôt que de partir sur un autre port (les postes du
    # cabinet ont l'adresse habituelle en favori).
    attente = time.time() + 20 if os.environ.get(mise_a_jour.VARIABLE_REDEMARRAGE) else 0
    while httpd is None and time.time() < attente:
        time.sleep(0.5)
        httpd, erreur = creer_serveur(host, port)
    if httpd is None:
        print("[!] Le port %d est indisponible (%s)." % (port, erreur))
        print("[*] Recherche d'un port libre...")
        httpd, erreur = creer_serveur(host, 0)
    if httpd is None:
        print("[X] Impossible de demarrer le serveur : %s" % erreur)
        return 1

    hote, port_obtenu = httpd.server_address[0], httpd.server_address[1]
    CustomHandler.ECOUTE_LOCALE = est_boucle_locale(hote)
    url = adresse_locale(hote, port_obtenu)

    print("=" * 62)
    print("GESTION DE STOCK - CABINET DENTAIRE  (v%s)" % VERSION)
    print("=" * 62)
    print("  base de donnees : %s" % base.CHEMIN_BASE)
    print("  sauvegardes     : %s (une par jour)" % sauvegarde.dossier_sauvegardes())
    print("  sur ce poste    : %s" % url)
    if CustomHandler.ECOUTE_LOCALE:
        print("  reseau          : desactive (--local)")
    else:
        print("  autres postes   : http://%s:%d/" % (get_local_ip(), port_obtenu))
        print("  (au premier lancement, autoriser Python dans le pare-feu Windows)")
    print("=" * 62)
    print("Ctrl+C pour arreter le serveur.")
    print("")

    if navigateur:
        ouvrir_navigateur(url)
    mise_a_jour.demarrer_verifications()
    sauvegarde.demarrer()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArret du serveur.")
    finally:
        httpd.server_close()
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help="port d'ecoute (defaut : %d)" % DEFAULT_PORT)
    ap.add_argument("--host", default="",
                    help="adresse d'ecoute (defaut : toutes les interfaces)")
    ap.add_argument("--local", action="store_true",
                    help="n'ecouter que sur 127.0.0.1 : aucun acces depuis les autres postes")
    ap.add_argument("--base", default=None, metavar="FICHIER",
                    help="fichier SQLite a utiliser (defaut : donnees/stock.db"
                         " ou celui choisi dans les Reglages)")
    ap.add_argument("--importer", default=None, metavar="DOSSIER",
                    help="reprendre les donnees de l'ancienne application"
                         " (dossier contenant stock.db et webstorage/)")
    ap.add_argument("--forcer", action="store_true",
                    help="avec --importer : ecraser une base deja remplie")
    ap.add_argument("--sans-navigateur", dest="navigateur", action="store_false",
                    help="ne pas ouvrir le navigateur au demarrage")
    ap.add_argument("--sans-pause", action="store_true",
                    help="ne pas attendre Entree a la fermeture (Windows)")
    args = ap.parse_args(argv)

    chemin = os.path.abspath(args.base) if args.base else chemin_base_configure()

    if args.importer:
        import migration
        try:
            print(migration.importer(args.importer, chemin, forcer=args.forcer))
        except migration.ErreurMigration as exc:
            print("[X] Import impossible : %s" % exc)
            return 1
        print("")

    base.definir_chemin(chemin)
    host = "127.0.0.1" if args.local else args.host
    return start_server(host, args.port, args.navigateur)


def lancer(argv=None):
    """Point d'entree double-clic : la fenetre ne se ferme pas sur une erreur."""
    argv = sys.argv[1:] if argv is None else list(argv)
    try:
        code = main(argv)
    except KeyboardInterrupt:
        return 0
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except Exception:                                     # noqa: BLE001
        traceback.print_exc()
        code = 1
    if mise_a_jour.REDEMARRER.is_set():
        print("\nMise a jour installee : redemarrage de l'outil...")
        mise_a_jour.relancer(argv)
        return 0
    muet = {"--sans-pause", "--help", "-h"}.intersection(argv)
    if os.name == "nt" and not muet and sys.stdin is not None and sys.stdin.isatty():
        try:
            input("\nAppuyez sur Entree pour fermer cette fenetre...")
        except (EOFError, KeyboardInterrupt, OSError):
            pass
    return code


if __name__ == "__main__":
    sys.exit(lancer())
