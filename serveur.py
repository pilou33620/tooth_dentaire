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
import gzip
import http.server
import ipaddress
import json
import math
import os
import posixpath
import re
import socket
import socketserver
import sqlite3
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import webbrowser

VERSION = "3.0.0"
DEFAULT_PORT = 8150
# 5 Mo : les documents sont limites a 2 Mo (base.TAILLE_MAX_DOCUMENT), un lot
# d'operations reste bien en dessous.
TAILLE_MAX_CORPS = 5 * 1024 * 1024
TAILLE_MIN_GZIP = 2048                     # octets : en dessous, pas de compression
JOURS_ETAT = 400                           # transactions envoyees par /api/etat
DELAI_ENTRE_VERIFICATIONS = 60             # s : bouton « Verifier » des mises a jour
DELAI_ENTRE_SAUVEGARDES = 60               # s : bouton « Sauvegarder maintenant »
ENTETE_SQLITE = b"SQLite format 3\x00"

ROOT = os.path.dirname(os.path.abspath(__file__))
DOSSIER_WEB = os.path.join(ROOT, "web")
DOSSIER_DONNEES = os.path.join(ROOT, "donnees")
# TOOTH_CONFIG : autre fichier de reglages (serveurs de test des benchmarks,
# pour ne pas toucher aux reglages de l'installation).
FICHIER_CONFIG = os.environ.get("TOOTH_CONFIG") or os.path.join(DOSSIER_DONNEES, "config.json")
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
    """Ecriture atomique : un fichier temporaire du meme dossier remplace
    l'ancien (une coupure en cours d'ecriture ne laisse pas un config.json tronque)."""
    dossier = os.path.dirname(os.path.abspath(FICHIER_CONFIG))
    os.makedirs(dossier, exist_ok=True)
    fd, temporaire = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=dossier)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        os.replace(temporaire, FICHIER_CONFIG)
    except BaseException:
        try:
            os.remove(temporaire)
        except OSError:
            pass
        raise


# Base choisie dans les Reglages mais introuvable au demarrage (lecteur reseau
# absent...) : le serveur est parti sur la base par defaut. Affiche par /api/base.
BASE_CONFIGUREE_ABSENTE = None


def chemin_base_configure():
    global BASE_CONFIGUREE_ABSENTE
    chemin = charger_config().get("base", "")
    if not isinstance(chemin, str):
        chemin = ""
    if chemin and os.path.isfile(chemin):
        BASE_CONFIGUREE_ABSENTE = None
        return chemin
    BASE_CONFIGUREE_ABSENTE = chemin or None
    if chemin:
        print("[!] La base choisie dans les Reglages est introuvable : %s. "
              "Base par defaut utilisee : %s" % (chemin, BASE_DEFAUT))
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


def _est_ip(texte):
    try:
        ipaddress.ip_address(texte.split("%")[0])
        return True
    except ValueError:
        return False


_NOMS_HOTE = None


def noms_hote_acceptes():
    """Noms de ce poste acceptes dans l'en-tete Host (calcules une fois :
    getfqdn peut interroger le DNS)."""
    global _NOMS_HOTE
    if _NOMS_HOTE is None:
        noms = {"localhost"}
        try:
            nom = socket.gethostname().lower()
            if nom:
                noms.update((nom, nom + ".local"))
        except OSError:
            pass
        try:
            noms.add(socket.getfqdn().lower())
        except OSError:
            pass
        noms.discard("")
        _NOMS_HOTE = frozenset(noms)
    return _NOMS_HOTE


_HOST = re.compile(r"(?:\[(?P<ip6>[^\]]+)\]|(?P<nom>[^:\[\]]+))(?::(?P<port>[0-9]{1,5}))?")


def hote_autorise(entete):
    """
    Protection DNS rebinding. Le rebinding passe toujours par un nom de
    domaine : toute adresse IP litterale est acceptee (IPv4, IPv6 avec ou sans
    crochets, avec ou sans port) ; un nom ne l'est que s'il designe ce poste.
    Host vide (HTTP/1.0) : accepte.
    """
    hote = (entete or "").strip().lower()
    if not hote or _est_ip(hote):                 # vide, ou IPv6 sans crochets ni port
        return True
    m = _HOST.fullmatch(hote)
    if not m:
        return False
    if m.group("ip6") is not None:
        return _est_ip(m.group("ip6"))
    nom = m.group("nom")
    return _est_ip(nom) or nom in noms_hote_acceptes()


# ------------------------------------------------------------------
# Gestionnaire HTTP
# ------------------------------------------------------------------

def _refuser_constante(nom):
    raise ValueError("valeur non numerique : %s" % nom)


def _nombre_fini(texte):
    nombre = float(texte)
    if not math.isfinite(nombre):            # 1e999 -> infini
        raise ValueError("nombre trop grand : %s" % texte)
    return nombre


def _objet(data):
    """Corps JSON attendu sous forme d'objet (absent : objet vide)."""
    return base._exiger_dict({} if data is None else data)


def _echapper_controles(texte):
    """Caracteres de controle -> \\xNN : une requete ne peut pas injecter de
    fausses lignes (ou des sequences d'echappement) dans la console."""
    return re.sub(r"[\x00-\x1f\x7f]", lambda m: "\\x%02x" % ord(m.group()), texte)


def _heure_ms():
    """Heure du serveur (ms depuis l'epoque) : les postes s'y recalent."""
    return int(time.time() * 1000)


class AccesRefuse(Exception):
    """Action reservee au poste serveur (repondue en 403)."""


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    """Sert web/ sans cache, et l'API JSON /api/*."""

    server_version = "StockCabinet/" + VERSION
    ECOUTE_LOCALE = False                     # fixe par start_server
    # Delai (s) sur chaque lecture du socket : un client qui annonce un corps
    # sans jamais l'envoyer ne bloque pas un fil indefiniment.
    timeout = 30

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DOSSIER_WEB, **kwargs)

    # -- securite ---------------------------------------------------

    def parse_request(self):
        if not super().parse_request():
            return False
        # Protection DNS rebinding : seul un Host connu est accepte.
        if not hote_autorise(self.headers.get("Host")):
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
        texte = _echapper_controles(format % args)
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
        entetes = getattr(self, "headers", None)
        accepte = (entetes.get("Accept-Encoding") or "") if entetes is not None else ""
        compresse = len(corps) > TAILLE_MIN_GZIP and "gzip" in accepte.lower()
        if compresse:                              # /api/etat : plusieurs Mo -> quelques centaines de Ko
            corps = gzip.compress(corps, compresslevel=6)
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if compresse:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
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
        try:
            brut = self.rfile.read(taille) if taille > 0 else b""
        except (socket.timeout, OSError):
            self.close_connection = True
            raise base.ErreurDonnees("Requete incomplete (delai depasse).")
        if not brut:
            return None
        try:
            # NaN / Infinity : acceptes par Python mais pas par les navigateurs ;
            # enregistres, ils rendraient /api/etat illisible sur tous les postes.
            return json.loads(brut.decode("utf-8"), parse_constant=_refuser_constante,
                              parse_float=_nombre_fini)
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
        except base.ErreurConflit as exc:
            reponse = {"status": "error", "conflit": True, "message": str(exc)}
            if exc.version is not None:               # document : version actuelle
                reponse["version"] = exc.version
            self._json(reponse, 409)
        except AccesRefuse as exc:
            self._json({"status": "error", "message": str(exc)}, 403)
        except base.ErreurDonnees as exc:
            self._json({"status": "error", "message": str(exc)}, 400)
        except (exports.ExportIndisponible, meteo.MeteoIndisponible) as exc:
            self._json({"status": "error", "message": str(exc)}, 503)
        except mise_a_jour.MiseAJourImpossible as exc:
            self._json({"status": "error", "message": str(exc)}, 409)
        except Exception:                                 # noqa: BLE001
            # Le detail (chemins, requetes SQL...) reste dans la console du serveur.
            traceback.print_exc()
            self._json({"status": "error", "message":
                        "Erreur interne du serveur (détail dans la console du poste serveur)."},
                       500)

    # -- routes -------------------------------------------------------

    def do_GET(self):
        route = self._route()
        if not route.startswith("/api/"):
            return super().do_GET()
        q = self._query()
        if route == "/api/revision":
            return self._json({"revision": base.revision(), "heure": _heure_ms()})
        if route == "/api/etat":
            return self._executer(self._etat)
        if route == "/api/info":
            return self._executer(self._info)
        if route == "/api/contacts":
            return self._executer(lambda: {"contacts": base.lister_contacts()})
        if route.startswith("/api/documents/"):
            cle = route[len("/api/documents/"):]
            return self._executer(lambda: base.lire_document_et_version(cle))
        if route == "/api/meteo":
            return self._executer(lambda: meteo.meteo_actuelle(base.lire_document("meteo_lieu")))
        if route == "/api/mise-a-jour":
            return self._executer(self._etat_mise_a_jour)
        if route == "/api/meteo/communes":
            return self._executer(lambda: {"communes": meteo.chercher_communes(q.get("q", ""))})
        if route == "/api/base":
            return self._executer(lambda: {
                "chemin": base.CHEMIN_BASE,
                "modifiable": self._client_local(),
                "base_configuree_absente": BASE_CONFIGUREE_ABSENTE,
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
            "/api/lot": lambda d: {"resultats": base.executer_lot(_objet(d).get("operations"))},
            "/api/transaction": lambda d: {"id": base.add_transaction(d)},
            "/api/maintenance": lambda d: {"id": base.add_autoclave(d)},
            "/api/historique-prix": lambda d: {"id": base.add_historique_prix(d)},
            "/api/contacts": lambda d: {"contact": base.enregistrer_contact(d)},
            "/api/base": self._changer_base,
            "/api/sauvegardes": self._sauvegarder,
            "/api/mise-a-jour/verifier": self._verifier_mise_a_jour,
            "/api/mise-a-jour/installer": self._installer_mise_a_jour,
            "/api/export/stock": lambda d: self._export(exports.export_stock(base.charger_base())),
            "/api/export/liste-courses": lambda d: self._export(
                exports.liste_courses(base.charger_base())),
            "/api/export/consommation": lambda d: self._export(exports.stats_consommation(
                base.charger_base(), _objet(d).get("references") or [])),
            "/api/export/chirurgie": lambda d: self._export(exports.extraction_chirurgie(
                base.charger_base(), _objet(d).get("date_debut"), _objet(d).get("date_fin"))),
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
            return self._executer(lambda: self._ecrire_document(cle))
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

    def _etat(self):
        # Transactions et historique des prix limites aux JOURS_ETAT derniers
        # jours ; les exports relisent toute la base.
        documents, versions = base.lire_documents_et_versions()
        return {
            "base": base.charger_base(jours_transactions=JOURS_ETAT),
            "documents": documents,
            "versions_documents": versions,
            "heure": _heure_ms(),
        }

    def _ecrire_document(self, cle):
        valeur = self._lire_json()
        # En-tete absent : ancien poste, ecriture sans controle de version
        brut = self.headers.get("X-Version-Document")
        attendue = None
        if brut is not None:
            if not re.fullmatch(r"\s*-?[0-9]{1,18}\s*", brut):
                raise base.ErreurDonnees("En-tete X-Version-Document invalide.")
            attendue = int(brut)
        return {"version": base.ecrire_document(cle, valeur, attendue)}

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

    def _sauvegarder(self, data):
        # Une copie par minute au plus : des clics repetes ne font pas tourner
        # les copies du jour (et ne chargent pas le disque).
        recente = sauvegarde.copie_recente(DELAI_ENTRE_SAUVEGARDES)
        if recente is not None:
            return {"sauvegarde": self._sans_chemin(recente), "deja_faite": True}
        return {"sauvegarde": self._sans_chemin(sauvegarde.sauvegarder()), "deja_faite": False}

    def _etat_mise_a_jour(self):
        return dict(mise_a_jour.etat(), installable_ici=self._client_local())

    def _verifier_mise_a_jour(self, data):
        # Permis depuis tous les postes, mais pas plus d'un « git fetch » par minute
        etat = mise_a_jour.etat()
        dernier = etat.get("verifie_le")
        if dernier is None or not 0 <= time.time() - dernier < DELAI_ENTRE_VERIFICATIONS:
            etat = mise_a_jour.verifier()
        return dict(etat, installable_ici=self._client_local())

    def _installer_mise_a_jour(self, data):
        # Installer = executer le code publie sur GitHub et redemarrer le
        # serveur : seulement depuis le poste qui le fait tourner.
        if not self._client_local():
            raise AccesRefuse(
                "La mise à jour se lance depuis le poste qui fait tourner le serveur.")
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
        global BASE_CONFIGUREE_ABSENTE
        if not self._client_local():
            raise base.ErreurDonnees(
                "Le changement de base ne se fait que depuis le poste qui fait tourner le serveur.")
        chemin = str(_objet(data).get("chemin") or "").strip().strip('"')
        if not chemin:
            raise base.ErreurDonnees("Chemin vide.")
        chemin = os.path.abspath(os.path.expanduser(chemin))
        if not os.path.isfile(chemin):
            raise base.ErreurDonnees("Fichier introuvable : %s" % chemin)
        # Un fichier vide devient une base neuve ; sinon il doit etre une base
        # SQLite (un autre fichier rendrait toutes les requetes en erreur).
        try:
            with open(chemin, "rb") as f:
                entete = f.read(len(ENTETE_SQLITE))
        except OSError as exc:
            raise base.ErreurDonnees("Fichier illisible : %s (%s)" % (chemin, exc))
        if entete and entete != ENTETE_SQLITE:
            raise base.ErreurDonnees("Ce fichier n'est pas une base SQLite : %s" % chemin)
        try:
            base.definir_chemin(chemin)            # base precedente gardee en cas d'echec
        except sqlite3.DatabaseError as exc:
            raise base.ErreurDonnees(
                "Ce fichier n'est pas une base SQLite utilisable : %s (%s)" % (chemin, exc))
        # Reglages enregistres seulement une fois la base ouverte
        config = charger_config()
        config["base"] = chemin
        enregistrer_config(config)
        BASE_CONFIGUREE_ABSENTE = None
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

    noms_hote_acceptes()                    # getfqdn (DNS) avant la premiere requete
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
