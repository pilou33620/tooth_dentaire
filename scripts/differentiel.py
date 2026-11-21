# -*- coding: utf-8 -*-
"""
Test différentiel : l'ancien serveur Python (serveur.py) et le nouveau serveur Rust doivent
répondre pareil et laisser la même base.

    python scripts/differentiel.py target/release/tooth[.exe]

1. Une base de test est créée et remplie par python/base.py (toutes les tables, des lots, des
   valeurs nulles, un document, des contacts…), puis copiée deux fois.
2. Les deux serveurs démarrent côte à côte en --local, chacun sur sa copie.
3. La même suite de requêtes leur est envoyée : toutes les routes GET, les écritures POST / PUT /
   DELETE avec X-Tooth, les erreurs (conflits, JSON invalide, corps trop gros, mauvais Host,
   en-tête maison absent…). Codes HTTP et JSON (clés et ordre compris) doivent être identiques ;
   seules les dates et heures du moment, la révision et les dossiers propres à chaque serveur
   sont neutralisés.
4. Les exports Excel sont relus par openpyxl : mêmes feuilles, mêmes valeurs, mêmes graphiques.
5. Les deux bases sont comparées table par table, ligne par ligne ; la base écrite par le Rust
   est ensuite relue et réécrite par python/base.py (retour arrière possible).
6. La copie « avant-rust » de la base existe et contient la base d'origine.

Bilan court : « OK » ou les premières différences. Code de sortie 0 ou 1.
"""

import base64
import datetime
import http.client
import io
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(RACINE, "python"))

import base  # noqa: E402  (python/base.py, celui de l'ancien serveur)

ECARTS = []
MAX_ECARTS = 15


def ecart(texte):
    ECARTS.append(texte if len(texte) < 600 else texte[:600] + "…")


# ---------------------------------------------------------------------- base de test

def hier():
    return (datetime.date.today() - datetime.timedelta(days=1)).strftime("%d/%m/%Y")


def remplir(chemin):
    """Une base créée et remplie par python/base.py, dans chaque table."""
    base.definir_chemin(chemin)
    base.update_produit({"reference": "A", "nom": "Compresses", "groupe": "Soins", "ref_scannette": "111;222",
                         "type_stockage": "carton", "quantite_par_carton": 10})
    base.update_produit({"reference": "B", "nom": '=HYPERLINK("x")', "type_stockage": "unite"})
    base.update_produit({"reference": "C", "nom": "Ancien produit", "arrete": 1})
    base.update_produit({"reference": "É 2", "nom": "Gants nitrile « M »", "type_stockage": "boite",
                         "quantite_par_carton": 12})
    base.update_stock_item({"reference": "A", "utilisateur": "Commun", "quantite": 32, "stock_minimum": 40,
                            "alerte_active": 1, "fournisseur": "F1", "prix_unitaire_ht": "1,5",
                            "prix_unitaire_ttc": 1.8, "lots_details": [
                                {"lot": "L1", "date": "31/12/2030", "qte": 20}, {"lot": "L2", "date": "30/06/2031"}]})
    base.update_stock_item({"reference": "B", "utilisateur": "Cabinet 1", "quantite": 2, "stock_minimum": 1,
                            "alerte_active": 1, "fournisseur": "F2", "prix_unitaire_ht": 5, "prix_unitaire_ttc": 6})
    base.update_stock_item({"reference": "A", "utilisateur": "Salle de chir", "quantite": 5, "stock_minimum": 1,
                            "alerte_active": 1, "en_commande": 1, "date_peremption": "31/12/2030; 2031-06-30"})
    base.update_stock_item({"reference": "C", "utilisateur": "Commun", "quantite": 0, "stock_minimum": 3,
                            "alerte_active": 1})
    base.update_stock_item({"reference": "É 2", "utilisateur": "Réserve", "quantite": 30, "stock_minimum": 5})
    for t in [
        ("2026-09-01T10:00:00Z", "A", "Commun", "SORTIE_STOCK", 3, "", ""),
        ("2026-09-15T10:00:00.000Z", "A", "Commun", "AJUSTEMENT_MANUEL", -2, "", ""),
        ("2026-10-01T10:00:00Z", "A", "Commun", "Sortie (Transfert)", 5, "", ""),
        ("2026-10-02T10:00:00Z", "A", "Salle de chir", "SORTIE_STOCK", 1, "L1", "31/12/2030"),
        ("2026-10-02T11:00:00Z", "A", "Salle de chir", "AJUSTEMENT_MANUEL", 4, "", ""),
        ("2026-10-03 09:15", "É 2", "Réserve", "Sortie_directe", 2, "", ""),
        ("date illisible", "B", "Cabinet 1", "SORTIE_STOCK", 1, "", ""),
    ]:
        base.add_transaction(dict(zip(("date", "reference", "utilisateur", "type_transaction", "quantite", "lot",
                                       "peremption_sortie"), t)))
    base.add_autoclave({"date": "01/10/2026", "machine": "Melag", "utilisateur": "Personne", "commentaire": "Filtre"})
    base.add_autoclave({"date": "02/10/2026", "machine": "", "utilisateur": "Autre", "commentaire": "Joint\nchangé"})
    base.add_historique_prix({"reference": "A", "date": "2026-10-01", "prix_ht": "2,5", "prix_ttc": None, "fournisseur": "F1"})
    base.add_historique_prix({"reference": "B", "date": "2026-10-02", "prix_ht": 5, "prix_ttc": 6, "fournisseur": "F2"})
    base.enregistrer_contact({"nom": "Labo Fictif", "tel_fixe": "00 00", "ville": "Bordeaux"})
    base.enregistrer_contact({"entreprise": "Dépôt dentaire", "email": "x@exemple.invalid", "note": "Ligne 1\nLigne 2"})
    base.ecrire_document("planning", {"even": [{"assistant": "A", "days": {"LUNDI": {"am": "Dr X", "pm": ""}}}], "odd": []})
    base.ecrire_document("notes", {"items": [{"texte": "Commander des gants", "fait": False}]})
    base.ecrire_document("record_jeu", 17)
    conn = sqlite3.connect(chemin)
    # Valeurs inhabituelles mais possibles dans une vieille base : rendues telles quelles
    conn.execute("INSERT INTO produits (reference, nom, quantite_par_carton) VALUES ('NUL', NULL, NULL)")
    conn.execute("INSERT INTO stock (reference, utilisateur, quantite, lots_details) VALUES ('NUL', 'Commun', '7', NULL)")
    conn.execute("INSERT INTO documents (cle, valeur) VALUES ('taches', '{abîmé')")
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------- serveurs

def port_libre():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Serveur:
    def __init__(self, nom, commande, dossier):
        self.nom, self.dossier = nom, dossier
        self.port = port_libre()
        self.journal = os.path.join(dossier, "console.txt")
        env = dict(os.environ, TOOTH_CONFIG=os.path.join(dossier, "config.json"), TOOTH_DENTAIRE_REDEMARRAGE="1",
                   PYTHONIOENCODING="utf-8", WEB_TOOLS_HTTP="1")
        self.fichier = open(self.journal, "wb")
        self.proc = subprocess.Popen(
            commande + ["--port", str(self.port), "--local", "--base", os.path.join(dossier, "stock.db"),
                        "--sans-navigateur", "--sans-pause"],
            cwd=RACINE, env=env, stdin=subprocess.DEVNULL, stdout=self.fichier, stderr=subprocess.STDOUT)
        fin = time.time() + 120
        while time.time() < fin:
            if self.proc.poll() is not None:
                raise RuntimeError("%s s'est arrêté au démarrage :\n%s" % (nom, self.console()))
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=1).close()
                return
            except OSError:
                time.sleep(0.3)
        raise RuntimeError("%s ne répond pas :\n%s" % (nom, self.console()))

    def console(self):
        if not self.fichier.closed:
            self.fichier.flush()
        with open(self.journal, "rb") as f:
            return f.read().decode("utf-8", "replace")[-3000:]

    def arreter(self):
        self.proc.terminate()
        try:
            self.proc.wait(20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(20)
        self.fichier.close()

    def requete(self, methode, chemin, corps=None, entetes=None):
        """(code, type, corps brut)."""
        h = {"Host": "127.0.0.1:%d" % self.port}
        if methode not in ("GET", "HEAD"):
            h["X-Tooth"] = "1"
        h.update(entetes or {})
        h = {k: v for k, v in h.items() if v is not None}
        if isinstance(corps, (dict, list)) or (corps is not None and not isinstance(corps, (bytes, str))):
            corps = json.dumps(corps, ensure_ascii=False)
        if isinstance(corps, str):
            corps = corps.encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            conn.putrequest(methode, chemin, skip_host=True, skip_accept_encoding=True)
            for k, v in h.items():
                conn.putheader(k, v)
            if "Content-Length" not in h:
                conn.putheader("Content-Length", str(len(corps or b"")))
            conn.endheaders(corps or None)
            rep = conn.getresponse()
            brut = rep.read()
            return rep.status, rep.getheader("Content-Type") or "", brut
        except (OSError, http.client.HTTPException) as exc:
            return -1, "", ("connexion : %s" % exc).encode()
        finally:
            conn.close()


# ---------------------------------------------------------------------- comparaison des réponses

DATE_TICKET = re.compile(r"le \d{2}/\d{2}/\d{4} \d{2}:\d{2}")


def neutre(valeur, dossiers, cle=None):
    """Neutralise ce qui dépend du moment ou du dossier du serveur."""
    if isinstance(valeur, dict):
        return {k: neutre(v, dossiers, k) for k, v in valeur.items()}
    if isinstance(valeur, list):
        return [neutre(v, dossiers) for v in valeur]
    if cle in ("revision", "verifie_le", "modifie_le") and valeur is not None:
        return "<moment>"
    if isinstance(valeur, str):
        for d in dossiers:
            valeur = valeur.replace(d, "<DOSSIER>")
        if cle == "body":
            valeur = DATE_TICKET.sub("le <date>", valeur)
            valeur = valeur.split("\n\n<details><summary>Journal du serveur</summary>")[0]
    return valeur


def egal(a, b, chemin="$"):
    """Première différence entre deux JSON (ordre des clés compris), ou None."""
    if isinstance(a, dict) and isinstance(b, dict):
        if list(a) != list(b):
            return "%s : clés %s ≠ %s" % (chemin, list(a), list(b))
        for k in a:
            d = egal(a[k], b[k], "%s.%s" % (chemin, k))
            if d:
                return d
        return None
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return "%s : %d éléments ≠ %d" % (chemin, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            d = egal(x, y, "%s[%d]" % (chemin, i))
            if d:
                return d
        return None
    if isinstance(a, bool) or isinstance(b, bool):
        return None if a is b else "%s : %r ≠ %r" % (chemin, a, b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return None if abs(a - b) <= 1e-9 * max(1.0, abs(a)) else "%s : %r ≠ %r" % (chemin, a, b)
    return None if a == b else "%s : %r ≠ %r" % (chemin, a, b)


def lire_json(brut):
    try:
        return json.loads(brut.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


EXPORTS = []


def squelette(v):
    """La forme d'un JSON (clés et types), sans les valeurs."""
    if isinstance(v, dict):
        return {k: squelette(x) for k, x in v.items()}
    if isinstance(v, list):
        return [squelette(x) for x in v]
    return "nombre" if isinstance(v, (int, float)) and not isinstance(v, bool) else type(v).__name__


def comparer_reponses(nom, rp, rr, dossiers, json_attendu=True, meme_corps=False, meme_type=False, forme_seule=False):
    (cp, tp, bp), (cr, tr, br) = rp, rr
    if cp != cr:
        ecart("%s : code Python %s ≠ Rust %s\n    Python : %s\n    Rust   : %s" % (
            nom, cp, cr, bp[:200].decode("utf-8", "replace"), br[:200].decode("utf-8", "replace")))
        return
    if meme_type and sys.platform != "win32" and tp.split(";")[0] != tr.split(";")[0]:
        ecart("%s : type %r ≠ %r" % (nom, tp, tr))
    if meme_corps and bp != br:
        ecart("%s : contenus différents (%d ≠ %d octets)" % (nom, len(bp), len(br)))
    if not json_attendu:
        return
    jp, jr = lire_json(bp), lire_json(br)
    if jp is None and jr is None:
        return
    if jp is None or jr is None:
        ecart("%s : JSON d'un seul côté\n    Python : %s\n    Rust   : %s" % (nom, bp[:200], br[:200]))
        return
    for j in (jp, jr):
        if isinstance(j, dict) and "contenu_base64" in j:
            EXPORTS.append((nom, j is jp, j.pop("contenu_base64")))
    if forme_seule:
        jp, jr = squelette(jp), squelette(jr)
    d = egal(neutre(jp, dossiers), neutre(jr, dossiers))
    if d:
        ecart("%s : %s" % (nom, d))


def suite(py, rs):
    """La même suite de requêtes envoyée aux deux serveurs ; rend le nombre de requêtes."""
    dossiers = [py.dossier, rs.dossier]
    n = 0

    def les_deux(nom, methode, chemin, corps=None, entetes=None, **options):
        nonlocal n
        n += 1
        comparer_reponses("#%d %s %s (%s)" % (n, methode, chemin, nom), py.requete(methode, chemin, corps, entetes),
                          rs.requete(methode, chemin, corps, entetes), dossiers, **options)

    # --- lectures
    for chemin in ["/api/revision", "/api/etat", "/api/etat/", "/api/info", "/api/contacts", "/api/meteo",
                   "/api/mise-a-jour", "/api/meteo/communes?q=44.84%2C-0.58", "/api/meteo/communes?q=44%2C5",
                   "/api/meteo/communes?q=95%2C%2010", "/api/meteo/communes?q=a", "/api/meteo/communes",
                   "/api/base", "/api/signalements", "/api/rien", "/api/documents/inconnu", "/api/documents/",
                   "/api/documents/../config"]:
        les_deux("lecture", "GET", chemin)
    for cle in base.DOCUMENTS_DEFAUT:
        les_deux("document", "GET", "/api/documents/" + cle)
    les_deux("lecture sans tête", "HEAD", "/api/etat", json_attendu=False)

    # --- fichiers de la page
    for chemin in ["/", "/index.html", "/js/main-init.js", "/js/core/api.js", "/css/style.css",
                   "/vendor/pdf.min.mjs", "/logo.ico", "/html/annuaire.html", "/settings.js", "/package.json"]:
        # type comparé pour html, css, js (l'icône dépend de la table mimetypes du système)
        les_deux("fichier", "GET", chemin, json_attendu=False, meme_corps=True,
                 meme_type=not chemin.endswith((".ico", ".json")))
    les_deux("fichier sans tête", "HEAD", "/index.html", json_attendu=False)
    for chemin in ["/favicon.ico", "/../serveur.py", "/%2e%2e/serveur.py", "/..%2f..%2fserveur.py",
                   "/js/../../python/base.py", "/../donnees/stock.db", "/js/", "/.gitignore", "/absent.html"]:
        les_deux("fichier interdit", "GET", chemin, json_attendu=False)

    # --- sécurité : Host, en-tête maison, routes inconnues
    les_deux("Host inconnu", "GET", "/api/etat", entetes={"Host": "attaquant.example"}, json_attendu=False)
    les_deux("Host IP", "GET", "/api/revision", entetes={"Host": "192.168.1.20:8150"})
    for methode, chemin in [("POST", "/api/produit"), ("PUT", "/api/documents/notes"),
                            ("DELETE", "/api/produit?reference=A")]:
        les_deux("sans X-Tooth", methode, chemin, {"reference": "Z"}, {"X-Tooth": None})
        les_deux("X-Tooth faux", methode, chemin, {"reference": "Z"}, {"X-Tooth": "0"})
    les_deux("route inconnue", "POST", "/api/rien", {})
    les_deux("route inconnue", "PUT", "/api/rien", {})
    les_deux("route inconnue", "DELETE", "/api/rien")
    les_deux("route inconnue", "POST", "/index.html", {})

    # --- corps invalides
    les_deux("JSON invalide", "POST", "/api/stock", b"{pas du json")
    les_deux("pas un objet", "POST", "/api/lot", [1, 2])
    les_deux("texte", "POST", "/api/produit", "\"texte\"")
    for corps in [b'{"items": [], "x": NaN}', b'{"items": [], "x": Infinity}', b'{"x": -Infinity}',
                  b'{"x": 1e999}', b"\xff\xfe"]:
        les_deux("nombre non fini", "PUT", "/api/documents/notes", corps)
    les_deux("trop gros", "POST", "/api/produit", b"", {"Content-Length": str(25 * 1024 * 1024)})
    les_deux("Content-Length illisible", "POST", "/api/produit", b"", {"Content-Length": "abc"})
    les_deux("corps vide", "POST", "/api/produit")
    les_deux("document vide", "PUT", "/api/documents/notes")
    les_deux("document inconnu", "PUT", "/api/documents/inconnu", {})

    # --- produits et stock
    les_deux("produit", "POST", "/api/produit", {"reference": "D", "nom": "Nouveau", "quantite_par_carton": "3"})
    les_deux("produit arrêté", "POST", "/api/produit", {"reference": "D", "nom": "Nouveau", "arrete": True})
    les_deux("produit sans référence", "POST", "/api/produit", {"nom": "sans ref"})
    les_deux("ligne neuve", "POST", "/api/stock", {"reference": "D", "utilisateur": "Commun", "quantite": 3, "version": None})
    les_deux("créée ailleurs", "POST", "/api/stock", {"reference": "D", "utilisateur": "Commun", "quantite": 3, "version": None})
    les_deux("version juste", "POST", "/api/stock", {"reference": "D", "utilisateur": "Commun", "quantite": 4, "version": 1,
                                                    "prix_unitaire_ht": "1 234,5", "delai_peremption": ""})
    les_deux("version périmée", "POST", "/api/stock", {"reference": "D", "utilisateur": "Commun", "quantite": 9, "version": 1})
    les_deux("ancien poste", "POST", "/api/stock", {"reference": "D", "utilisateur": "Commun", "quantite": "1e999",
                                                   "stock_minimum": 10 ** 30})
    les_deux("lot périmé", "POST", "/api/stock", {"reference": "D", "utilisateur": "Salle 2", "quantite": 2,
                                                 "lots_details": [{"lot": "V", "date": hier(), "qte": 2}]})
    les_deux("date périmée", "POST", "/api/stock", {"reference": "D", "utilisateur": "Salle 2", "quantite": 2,
                                                   "date_peremption": hier()})
    les_deux("espace manquant", "POST", "/api/stock", {"reference": "D", "utilisateur": " "})
    les_deux("liste au lieu d'objet", "POST", "/api/stock", [])

    # --- lots d'écritures
    les_deux("lot", "POST", "/api/lot", {"operations": [
        {"action": "updateProduit", "donnees": {"reference": "E", "nom": "Lot"}},
        {"action": "updateStockItem", "donnees": {"reference": "E", "utilisateur": "Commun", "quantite": 5, "version": None}},
        {"action": "updateStockItem", "donnees": {"reference": "E", "utilisateur": "Commun", "quantite": 2, "version": None}},
        {"action": "addTransaction", "donnees": {"date": "2026-10-05T08:00:00Z", "reference": "E",
                                                 "utilisateur": "Commun", "type_transaction": "ENTREE", "quantite": 5}},
        {"action": "addAutoclave", "donnees": {"date": "d", "utilisateur": "U", "commentaire": "C"}},
        {"action": "addHistoriquePrix", "donnees": {"reference": "E", "date": "d", "prix_ht": 1}},
    ]})
    les_deux("lot en conflit", "POST", "/api/lot", {"operations": [
        {"action": "addTransaction", "donnees": {"date": "d", "reference": "E", "utilisateur": "Commun",
                                                 "type_transaction": "SORTIE_STOCK", "quantite": 1}},
        {"action": "updateStockItem", "donnees": {"reference": "E", "utilisateur": "Commun", "quantite": 1, "version": 1}}]})
    les_deux("transfert", "POST", "/api/lot", {"operations": [
        {"action": "updateStockItem", "donnees": {"reference": "A", "utilisateur": "Commun", "quantite": 22, "version": 1,
                                                  "lots_details": [{"lot": "L1", "date": "31/12/2030", "qte": 10},
                                                                   {"lot": "L2", "date": "30/06/2031"}]}},
        {"action": "updateStockItem", "donnees": {"reference": "A", "utilisateur": "Cabinet 1", "quantite": 10,
                                                  "version": None, "lots_details": [{"lot": "L1", "date": "31/12/2030", "qte": 10}]}}]})
    for ops in [None, [], "x", [{"action": "inconnue"}], ["x"], [{"donnees": {}}]]:
        les_deux("lot invalide", "POST", "/api/lot", {"operations": ops})
    les_deux("lot sans opérations", "POST", "/api/lot", {})
    les_deux("suppressions en lot", "POST", "/api/lot", {"operations": [
        {"action": "deleteStockItem", "donnees": {"reference": "E", "utilisateur": "Commun"}},
        {"action": "deleteProduit", "donnees": {"reference": "E"}}]})

    # --- transactions, maintenance, prix, contacts
    les_deux("transaction", "POST", "/api/transaction", {"id": 99, "date": "2026-10-06T08:00:00Z", "reference": "A",
                                                        "utilisateur": "Salle de chir", "type_transaction": "SORTIE_STOCK",
                                                        "quantite": 2, "lot": "L1", "peremption_sortie": "31/12/2030"})
    les_deux("maintenance", "POST", "/api/maintenance", {"date": "03/10/2026", "machine": "Melag", "utilisateur": "P",
                                                        "commentaire": "Test Hélix"})
    les_deux("maintenance incomplète", "POST", "/api/maintenance", {"utilisateur": "P", "commentaire": " "})
    les_deux("prix", "POST", "/api/historique-prix", {"reference": "A", "date": "d", "prix_ht": "abc", "prix_ttc": "3,2"})
    les_deux("contact", "POST", "/api/contacts", {"nom": "Nouveau", "prenom": " Léa ", "id": 999})
    les_deux("contact modifié", "POST", "/api/contacts", {"id": 1, "nom": "Labo Fictif", "tel_fixe": "01 02"})
    les_deux("contact sans nom", "POST", "/api/contacts", {"email": "x@y.z"})

    # --- documents et versions
    les_deux("document v0", "PUT", "/api/documents/notes", {"items": ["A"]}, {"X-Version": "1"})
    les_deux("document périmé", "PUT", "/api/documents/notes", {"items": ["B"]}, {"X-Version": "1"})
    les_deux("version illisible", "PUT", "/api/documents/notes", {"items": ["B"]}, {"X-Version": "abc"})
    les_deux("sans version", "PUT", "/api/documents/notes", {"items": ["C"], "accents": "éè « »"})
    les_deux("nombre seul", "PUT", "/api/documents/record_jeu", 42)
    les_deux("document neuf", "PUT", "/api/documents/checklist", {"modele": [], "jour": "2026-11-21", "fait": {"o1": True}},
             {"X-Version": "0"})

    # --- suppressions
    les_deux("suppression ligne", "DELETE", "/api/stock?reference=B&utilisateur=Cabinet%201")
    les_deux("suppression produit", "DELETE", "/api/produit?reference=C")
    les_deux("suppression absente", "DELETE", "/api/produit")
    les_deux("suppression contact", "DELETE", "/api/contacts?id=2")
    les_deux("suppression contact sans id", "DELETE", "/api/contacts")

    # --- réglages, sauvegardes, signalements, mises à jour
    les_deux("base introuvable", "POST", "/api/base", {"chemin": "absent-differentiel.db"})
    les_deux("base vide", "POST", "/api/base", {"chemin": "  "})
    # nom, date et taille de la copie dépendent de l'instant : seule la forme est comparée
    les_deux("sauvegarde", "POST", "/api/sauvegardes", {}, forme_seule=True)
    les_deux("signalement sans clé", "POST", "/api/signalements", {"type": "bug", "description": "Essai différentiel\nsuite",
                                                                  "auteur": "CI", "journaux": "[x] boum"})
    les_deux("signalement incomplet", "POST", "/api/signalements", {"type": "bug", "description": ""})
    les_deux("signalement inconnu", "POST", "/api/signalements", {"type": "autre", "description": "assez long"})
    les_deux("clé GitHub", "POST", "/api/signalements/cle", {"cle": " essai "})
    les_deux("clé GitHub retirée", "POST", "/api/signalements/cle", {"cle": ""})
    les_deux("vérification", "POST", "/api/mise-a-jour/verifier", {})

    # --- exports
    les_deux("export", "POST", "/api/export/stock", {})
    les_deux("export", "POST", "/api/export/liste-courses", {})
    les_deux("export", "POST", "/api/export/consommation", {"references": ["TOUTES"]})
    les_deux("export", "POST", "/api/export/consommation", {"references": ["A", "Z"]})
    les_deux("export", "POST", "/api/export/consommation", {"references": []})
    les_deux("export", "POST", "/api/export/consommation", {"references": ["Z"]})
    les_deux("export", "POST", "/api/export/chirurgie", {"date_debut": "2026-10-01", "date_fin": "2026-12-31"})
    les_deux("export", "POST", "/api/export/chirurgie", {"date_debut": "2020-01-01", "date_fin": "2020-01-31"})
    les_deux("export", "POST", "/api/export/chirurgie", {"date_debut": "01/10/2026", "date_fin": "2026-12-31"})
    les_deux("export", "POST", "/api/export/chirurgie", {"date_debut": ""})

    # --- état final complet
    les_deux("état final", "GET", "/api/etat")
    les_deux("sauvegardes", "GET", "/api/sauvegardes", forme_seule=True)
    return n


# ---------------------------------------------------------------------- exports Excel

def comparer_exports():
    import openpyxl
    par_nom = {}
    for nom, python, contenu in EXPORTS:
        par_nom.setdefault(nom, {})["python" if python else "rust"] = contenu
    for nom, c in par_nom.items():
        if set(c) != {"python", "rust"}:
            ecart("%s : fichier Excel d'un seul côté" % nom)
            continue
        try:
            wp = openpyxl.load_workbook(io.BytesIO(base64.b64decode(c["python"])))
            wr = openpyxl.load_workbook(io.BytesIO(base64.b64decode(c["rust"])))
        except Exception as exc:                          # noqa: BLE001
            ecart("%s : classeur illisible (%s)" % (nom, exc))
            continue
        if wp.sheetnames != wr.sheetnames:
            ecart("%s : feuilles %s ≠ %s" % (nom, wp.sheetnames, wr.sheetnames))
            continue
        for feuille in wp.sheetnames:
            def lignes(ws):
                v = [list(r) for r in ws.iter_rows(values_only=True)]
                for r in v:
                    while r and r[-1] is None:
                        r.pop()
                while v and not v[-1]:
                    v.pop()
                return v
            d = egal(lignes(wp[feuille]), lignes(wr[feuille]), "%s!%s" % (nom, feuille))
            if d:
                ecart(d)
            gp, gr = len(wp[feuille]._charts), len(wr[feuille]._charts)
            if gp != gr:
                ecart("%s!%s : %d graphique(s) ≠ %d" % (nom, feuille, gp, gr))
    return len(par_nom)


# ---------------------------------------------------------------------- bases

def contenu(chemin):
    """{table: (schéma, lignes)} ; documents : valeur JSON relue, sans l'heure d'écriture."""
    conn = sqlite3.connect(chemin)
    try:
        r = {"$schema": sorted(conn.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall(),
                               key=lambda x: (x[0], x[1])),
             "$user_version": conn.execute("PRAGMA user_version").fetchone()[0],
             "$integrite": conn.execute("PRAGMA integrity_check").fetchone()[0]}
        for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            colonnes = [c[1] for c in conn.execute("PRAGMA table_info(%s)" % table)]
            lignes = []
            for ligne in conn.execute("SELECT * FROM %s ORDER BY rowid" % table):
                d = dict(zip(colonnes, ligne))
                if table == "documents":
                    d.pop("modifie_le", None)
                    try:
                        d["valeur"] = json.loads(d["valeur"])
                    except ValueError:
                        pass
                lignes.append(d)
            r[table] = lignes
        return r
    finally:
        conn.close()


def comparer_bases(p, r, quoi):
    a, b = contenu(p), contenu(r)
    for k in a:
        if k not in b:
            ecart("%s : table %s absente côté Rust" % (quoi, k))
            continue
        d = egal(a[k], b[k], "%s.%s" % (quoi, k))
        if d:
            ecart(d)
    for k in b:
        if k not in a:
            ecart("%s : table %s en trop côté Rust" % (quoi, k))
    return len([k for k in a if not k.startswith("$")])


def retour_arriere(chemin):
    """La base écrite par le Rust se relit et se réécrit avec python/base.py."""
    try:
        base.definir_chemin(chemin)
        base.charger_base()
        base.lire_documents()
        base.versions_documents()
        base.lister_contacts()
        base.update_produit({"reference": "RETOUR", "nom": "Écrit par Python après Rust"})
        base.executer_lot([{"action": "updateStockItem", "donnees": {"reference": "RETOUR", "utilisateur": "Commun",
                                                                      "quantite": 1, "version": None}}])
        base.ecrire_document("notes", {"items": ["retour"]})
        assert base.lire_document("notes") == {"items": ["retour"]}
    except Exception as exc:                              # noqa: BLE001
        ecart("retour arrière : python/base.py ne relit pas la base écrite par le Rust (%r)" % exc)


# ---------------------------------------------------------------------- programme

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    exe = os.path.abspath(sys.argv[1])
    # la comparaison elle-même voit bien une valeur, un ordre de clés ou un type différents
    assert egal({"a": 1, "b": [1, "x"]}, {"a": 1, "b": [1, "y"]}) and egal({"a": 1, "b": 2}, {"b": 2, "a": 1})
    assert egal([True], [1]) and egal({"a": None}, {"a": 0}) and not egal({"a": 1.0}, {"a": 1})
    dossier = tempfile.mkdtemp(prefix="tooth-differentiel-")
    ref = os.path.join(dossier, "reference.db")
    remplir(ref)
    dossiers = {}
    for nom in ("python", "rust"):
        dossiers[nom] = os.path.join(dossier, nom)
        os.makedirs(dossiers[nom])
        shutil.copy2(ref, os.path.join(dossiers[nom], "stock.db"))
    py = rs = None
    try:
        py = Serveur("Python", [sys.executable, os.path.join(RACINE, "serveur.py")], dossiers["python"])
        rs = Serveur("Rust", [exe, "--sans-maj"], dossiers["rust"])
        time.sleep(1.5)  # la sauvegarde du démarrage de chaque serveur
        n = suite(py, rs)
    except Exception as exc:                              # noqa: BLE001
        print("ÉCHEC du test différentiel : %s" % exc)
        return 1
    finally:
        for s in (py, rs):
            if s is not None:
                s.arreter()
    nb_exports = comparer_exports()
    if nb_exports != 5:  # stock, liste de courses, deux consommations, chirurgie
        ecart("exports Excel comparés : %d au lieu de 5" % nb_exports)
    nb_tables = comparer_bases(os.path.join(dossiers["python"], "stock.db"), os.path.join(dossiers["rust"], "stock.db"),
                               "bases finales")
    # copie « avant-rust » : faite une fois, avec la base d'origine
    copies = [f for f in os.listdir(dossiers["rust"]) if re.match(r"stock\.db\.avant-rust-\d{8}-\d{6}$", f)]
    if len(copies) != 1 or not os.path.isfile(os.path.join(dossiers["rust"], "stock.db.avant-rust.fait")):
        ecart("copie avant-rust : %s" % (copies or "absente"))
    else:
        comparer_bases(ref, os.path.join(dossiers["rust"], copies[0]), "copie avant-rust")
    retour_arriere(os.path.join(dossiers["rust"], "stock.db"))

    if ECARTS:
        print("Différentiel Python / Rust : %d ÉCART(S)" % len(ECARTS))
        for e in ECARTS[:MAX_ECARTS]:
            print(" - " + e)
        if len(ECARTS) > MAX_ECARTS:
            print(" … et %d autre(s)" % (len(ECARTS) - MAX_ECARTS))
        print("\n--- console Python (fin) ---\n" + py.console()[-1200:])
        print("\n--- console Rust (fin) ---\n" + rs.console()[-1200:])
        return 1
    print("Différentiel Python / Rust : OK — %d requêtes identiques, %d exports Excel identiques, "
          "%d tables identiques, copie avant-rust et retour arrière vérifiés." % (n, nb_exports, nb_tables))
    shutil.rmtree(dossier, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
