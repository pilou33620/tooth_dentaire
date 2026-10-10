# -*- coding: utf-8 -*-
"""
Base de donnees SQLite de l'outil (stock.db).

Le schema du stock est celui de l'ancienne application PySide6, ce qui permet
de reprendre une base existante telle quelle :

  produits        : reference, nom, groupe, ref_scannette, type_stockage,
                    quantite_par_carton
  stock           : une ligne par (reference, espace)
  transactions    : historique des mouvements
  autoclave       : carnet de maintenance des machines
  historique_prix : prix recus a chaque entree

S'y ajoutent deux tables pour ce qui vivait auparavant dans le navigateur :

  contacts        : carnet d'adresses
  documents       : documents JSON nommes (planning, taches, dosimetres,
                    rappels mire / fauteuils / dosimetres, record du jeu...)

AUCUNE donnee propre au cabinet (noms du personnel, contacts...) n'est ecrite
dans le code : tout est en base, et la base n'est pas versionnee.
"""

import calendar
import datetime
import json
import math
import os
import re
import sqlite3
import threading
import uuid

# Verrou d'ecriture : le serveur est multi-thread, SQLite accepte un seul
# ecrivain a la fois. Serialiser ici evite les « database is locked ».
_VERROU = threading.RLock()

# Revision : change a chaque ecriture. Les navigateurs la surveillent pour
# recharger les donnees quand un autre poste a modifie quelque chose.
_DEMARRAGE = uuid.uuid4().hex[:8]
_compteur = 0

CHEMIN_BASE = None

# Valeurs par defaut des documents : volontairement neutres (aucun nom).
DOCUMENTS_DEFAUT = {
    "planning": {
        "even": [],
        "odd": [],
    },
    "planning_couleurs": {"regles": []},
    "taches": {"header1": "", "header2": "", "rows": []},
    "dosimetres": {"manager": "", "generalNote": "", "dosimetres": []},
    "rappels_mire": {},
    "rappels_fauteuils": {},
    "rappel_dosimetres": {"nextTime": None},
    "record_jeu": 0,
    "positions_interface": {},
    # Accueil : notes partagées, checklist du jour, minuteurs
    "notes": {"items": []},
    "checklist": {
        "modele": [
            {"id": "o1", "moment": "ouverture", "libelle": "Purge des circuits d'eau des units"},
            {"id": "o2", "moment": "ouverture", "libelle": "Test de l'autoclave (Bowie-Dick / Hélix)"},
            {"id": "o3", "moment": "ouverture", "libelle": "Mise en route aspiration et compresseur"},
            {"id": "f1", "moment": "fermeture", "libelle": "Désinfection des fauteuils et surfaces"},
            {"id": "f2", "moment": "fermeture", "libelle": "Nettoyage des aspirations"},
            {"id": "f3", "moment": "fermeture", "libelle": "Évacuation des DASRI"},
            {"id": "f4", "moment": "fermeture", "libelle": "Arrêt aspiration et compresseur"},
        ],
        "jour": "",
        "fait": {},
    },
    # Commune du cabinet pour la météo du fond (vide : pas de météo)
    "meteo_lieu": {"nom": "", "lat": None, "lon": None},
    "minuteurs": {
        "actifs": [],
        "preselections": [
            {"libelle": "Bain à ultrasons", "minutes": 10},
            {"libelle": "Trempage", "minutes": 15},
            {"libelle": "Séchage", "minutes": 20},
        ],
    },
    # Empreintes des factures PDF deja importees (alerte en cas de re-import)
    "factures_importees": {"empreintes": []},
}

# Taille maximale d'un document (JSON serialise)
TAILLE_MAX_DOCUMENT = 2 * 1024 * 1024

# Champs qui doivent etre des listes quand ils sont presents (controle simple,
# pas de schema complet : evite qu'un poste enregistre un document illisible
# pour tous les autres).
LISTES_DOCUMENTS = {
    "planning": ("even", "odd"),
    "notes": ("items",),
    "minuteurs": ("actifs", "preselections"),
    "checklist": ("modele",),
    "dosimetres": ("dosimetres",),
    "taches": ("rows",),
}

CHAMPS_CONTACT = ("nom", "prenom", "entreprise", "email", "tel_fixe",
                  "tel_portable", "adresse", "code_postal", "ville", "note")


class ErreurDonnees(ValueError):
    """Donnees envoyees invalides (repondues en 400 par le serveur)."""


class ErreurConflit(ErreurDonnees):
    """Ligne modifiee entre-temps par un autre poste (repondue en 409).

    version : version actuelle d'un document en conflit (renvoyee au poste),
    None pour une ligne de stock.
    """

    def __init__(self, message, version=None):
        super().__init__(message)
        self.version = version


# ------------------------------------------------------------------
# Revision
# ------------------------------------------------------------------

def revision():
    return "%s-%d" % (_DEMARRAGE, _compteur)


def _incrementer_revision():
    global _compteur
    _compteur += 1


# ------------------------------------------------------------------
# Connexion / schema
# ------------------------------------------------------------------

def definir_chemin(chemin):
    """Choisit le fichier de base (cree s'il n'existe pas) et l'initialise."""
    global CHEMIN_BASE
    chemin = os.path.abspath(chemin)
    dossier = os.path.dirname(chemin)
    if dossier:
        os.makedirs(dossier, exist_ok=True)
    with _VERROU:
        precedent = CHEMIN_BASE
        CHEMIN_BASE = chemin
        try:
            init_db()
        except Exception:
            # Fichier inutilisable (pas une base SQLite...) : on garde l'ancienne
            # base, sinon toutes les requetes suivantes echoueraient.
            CHEMIN_BASE = precedent
            raise
        _incrementer_revision()
    return chemin


def connexion():
    if not CHEMIN_BASE:
        raise RuntimeError("Chemin de la base non defini (base.definir_chemin).")
    conn = sqlite3.connect(CHEMIN_BASE, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _ajouter_colonne(cur, table, definition):
    try:
        cur.execute("ALTER TABLE %s ADD COLUMN %s" % (table, definition))
    except sqlite3.OperationalError as exc:
        if "duplicate column name" not in str(exc).lower():
            raise                              # base verrouillee, en lecture seule...
        # colonne deja presente


def init_db():
    """Cree les tables manquantes et applique les migrations de schema."""
    conn = connexion()
    try:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS produits (
                reference      TEXT PRIMARY KEY,
                nom            TEXT DEFAULT '',
                groupe         TEXT DEFAULT '',
                ref_scannette  TEXT DEFAULT ''
            )""")
        for definition in ("nom TEXT DEFAULT ''", "groupe TEXT DEFAULT ''",
                           "ref_scannette TEXT DEFAULT ''"):
            _ajouter_colonne(cur, "produits", definition)
        _ajouter_colonne(cur, "produits", "type_stockage TEXT DEFAULT 'unite'")
        _ajouter_colonne(cur, "produits", "quantite_par_carton INTEGER DEFAULT 1")
        # Produit qu'on n'achete plus : hors post-it, alertes et liste de courses
        _ajouter_colonne(cur, "produits", "arrete INTEGER DEFAULT 0")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS stock (
                reference        TEXT NOT NULL,
                utilisateur      TEXT NOT NULL,
                quantite         INTEGER DEFAULT 0,
                stock_minimum    INTEGER DEFAULT 0,
                alerte_active    INTEGER DEFAULT 0,
                date_peremption  TEXT DEFAULT '',
                date_import      TEXT DEFAULT '',
                fournisseur      TEXT DEFAULT '',
                en_commande      INTEGER DEFAULT 0,
                date_commande    TEXT DEFAULT '',
                PRIMARY KEY (reference, utilisateur)
            )""")
        for definition in ("quantite INTEGER DEFAULT 0",
                           "stock_minimum INTEGER DEFAULT 0",
                           "alerte_active INTEGER DEFAULT 0",
                           "date_peremption TEXT DEFAULT ''",
                           "date_import TEXT DEFAULT ''",
                           "fournisseur TEXT DEFAULT ''",
                           "en_commande INTEGER DEFAULT 0",
                           "date_commande TEXT DEFAULT ''",
                           "lot TEXT DEFAULT ''",
                           "prix_unitaire_ht REAL DEFAULT 0",
                           "prix_unitaire_ttc REAL DEFAULT 0",
                           "lots_details TEXT DEFAULT '[]'",
                           "alerte_peremption_active INTEGER DEFAULT 0",
                           "delai_peremption INTEGER DEFAULT 30",
                           # Numero de version de la ligne : +1 a chaque ecriture.
                           # Detecte deux postes qui modifient la meme ligne.
                           "version INTEGER DEFAULT 0"):
            _ajouter_colonne(cur, "stock", definition)

        # Une seule fois (user_version) : activer la pre-alerte de peremption
        # sur les lignes anterieures a la colonne qui avaient deja une date.
        if cur.execute("PRAGMA user_version").fetchone()[0] < 1:
            cur.execute("""
                UPDATE stock SET alerte_peremption_active = 1
                WHERE date_peremption IS NOT NULL AND date_peremption != ''
                  AND (alerte_peremption_active IS NULL OR alerte_peremption_active = 0)""")
            cur.execute("PRAGMA user_version = 1")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id                INTEGER PRIMARY KEY,
                date              TEXT NOT NULL,
                reference         TEXT NOT NULL,
                utilisateur       TEXT NOT NULL,
                type_transaction  TEXT NOT NULL,
                quantite          INTEGER NOT NULL
            )""")
        _ajouter_colonne(cur, "transactions", "lot TEXT DEFAULT ''")
        _ajouter_colonne(cur, "transactions", "peremption_sortie TEXT DEFAULT ''")

        cur.execute("""
            CREATE TABLE IF NOT EXISTS autoclave (
                id           INTEGER PRIMARY KEY,
                date         TEXT NOT NULL,
                machine      TEXT DEFAULT '',
                utilisateur  TEXT NOT NULL,
                commentaire  TEXT NOT NULL
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS historique_prix (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                reference    TEXT NOT NULL,
                date         TEXT NOT NULL,
                prix_ht      REAL,
                prix_ttc     REAL,
                fournisseur  TEXT
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS contacts (
                id            INTEGER PRIMARY KEY,
                nom           TEXT DEFAULT '',
                prenom        TEXT DEFAULT '',
                entreprise    TEXT DEFAULT '',
                email         TEXT DEFAULT '',
                tel_fixe      TEXT DEFAULT '',
                tel_portable  TEXT DEFAULT '',
                adresse       TEXT DEFAULT '',
                code_postal   TEXT DEFAULT '',
                ville         TEXT DEFAULT '',
                note          TEXT DEFAULT ''
            )""")
        cur.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                cle         TEXT PRIMARY KEY,
                valeur      TEXT NOT NULL,
                modifie_le  TEXT DEFAULT (datetime('now', 'localtime'))
            )""")
        # Numero de version du document : +1 a chaque ecriture (conflits entre postes)
        _ajouter_colonne(cur, "documents", "version INTEGER DEFAULT 0")
        conn.commit()
    finally:
        conn.close()


def _ecrire(fonction):
    """Execute fonction(cur) dans une transaction, sous verrou, puis revision++."""
    with _VERROU:
        conn = connexion()
        try:
            resultat = fonction(conn.cursor())
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        _incrementer_revision()
        return resultat


# ------------------------------------------------------------------
# Conversions tolerantes
# ------------------------------------------------------------------

# Entiers acceptes par SQLite (64 bits)
ENTIER_MIN, ENTIER_MAX = -2 ** 63, 2 ** 63 - 1


def safe_float(val, default=0.0):
    """Nombre fini, sinon default : un infini ou NaN en base rendrait la
    reponse /api/etat illisible pour les navigateurs (JSON invalide)."""
    if val is None or val == "":
        return default
    try:
        if isinstance(val, (int, float)):
            nombre = float(val)
        else:
            nombre = float(str(val).replace(" ", "").replace(",", ".").strip())
    except (ValueError, TypeError, OverflowError):
        return default
    return nombre if math.isfinite(nombre) else default


def safe_int(val, default=0):
    if val is None or val == "":
        return default
    try:
        nombre = int(val) if isinstance(val, int) else int(float(val))
    except (ValueError, TypeError, OverflowError):
        return default
    return nombre if ENTIER_MIN <= nombre <= ENTIER_MAX else default


def _texte(val):
    return "" if val is None else str(val)


def _champ_texte(d, cle):
    """Champ texte recu d'un poste. Un objet ou une liste est refuse : str()
    l'enregistrerait sous la forme « {'a': 1} »."""
    val = d.get(cle)
    if isinstance(val, (dict, list)):
        raise ErreurDonnees("Champ « %s » invalide (texte attendu)." % cle)
    return _texte(val)


# Entiers exacts en JavaScript (Number.MAX_SAFE_INTEGER)
ENTIER_JS_MAX = 2 ** 53 - 1


def _entier_js(d, cle, default=0):
    """Entier recu d'un poste (comme safe_int) ; au-dela de ±(2**53-1), le
    navigateur l'arrondirait : ErreurDonnees."""
    val = d.get(cle)
    if isinstance(val, int):
        trop_grand = abs(val) > ENTIER_JS_MAX
    elif isinstance(val, (float, str)):
        try:
            trop_grand = abs(float(val)) > ENTIER_JS_MAX        # "1e999" -> infini
        except ValueError:
            trop_grand = False
    else:
        trop_grand = False
    if trop_grand:
        raise ErreurDonnees("Champ « %s » : nombre trop grand." % cle)
    return safe_int(val, default)


QUANTITE_PAR_CARTON_MAX = 100000


def _quantite_par_carton(p):
    quantite = _entier_js(p, "quantite_par_carton", 1)
    if quantite == 0:
        quantite = 1                    # 0, vide ou illisible : 1 (comportement historique)
    if not 1 <= quantite <= QUANTITE_PAR_CARTON_MAX:
        raise ErreurDonnees("La quantité par carton doit être comprise entre 1 et %d."
                            % QUANTITE_PAR_CARTON_MAX)
    return quantite


def _lots_details(s):
    """lots_details : tableau JSON (liste, ou texte qui en contient une)."""
    lots = s.get("lots_details")
    if lots is None or lots == "":
        return "[]"
    if isinstance(lots, str):
        try:
            valide = isinstance(json.loads(lots), list)
        except ValueError:
            valide = False
        if valide:
            return lots
    elif isinstance(lots, list):
        return json.dumps(lots, ensure_ascii=False)
    raise ErreurDonnees("Champ « lots_details » invalide (tableau attendu).")


def _exiger_dict(data):
    if not isinstance(data, dict):
        raise ErreurDonnees("Format de donnees invalide (objet attendu).")
    return data


# ------------------------------------------------------------------
# Lecture complete
# ------------------------------------------------------------------

def _date_recente(texte, limite):
    """Vrai si la date ISO (AAAA-MM-JJ...) est >= limite ; une date illisible est gardee."""
    texte = _texte(texte).strip()
    try:
        datetime.datetime.strptime(texte[:10], "%Y-%m-%d")
    except ValueError:
        return True
    return texte[:10] >= limite


def charger_base(jours_transactions=None):
    """Toute la base au format attendu par l'interface (ancien app.js).

    jours_transactions : ne renvoyer que les transactions et l'historique des
    prix des N derniers jours (reponse /api/etat plus legere). Les exports
    appellent charger_base() sans limite.
    """
    conn = connexion()
    try:
        cur = conn.cursor()
        produits = [dict(r) for r in cur.execute(
            "SELECT reference, nom, groupe, ref_scannette, type_stockage,"
            " quantite_par_carton, arrete FROM produits")]
        stock = [dict(r) for r in cur.execute(
            "SELECT reference, utilisateur, quantite, stock_minimum, alerte_active,"
            " alerte_peremption_active, delai_peremption, date_peremption, date_import,"
            " fournisseur, en_commande, date_commande, lot, prix_unitaire_ht,"
            " prix_unitaire_ttc, lots_details, version FROM stock")]
        transactions = [dict(r) for r in cur.execute(
            "SELECT id, date, reference, utilisateur, type_transaction, quantite,"
            " lot, peremption_sortie FROM transactions ORDER BY id")]
        autoclave = [dict(r) for r in cur.execute(
            "SELECT id, date, machine, utilisateur, commentaire FROM autoclave ORDER BY id")]
        historique_prix = [dict(r) for r in cur.execute(
            "SELECT id, reference, date, prix_ht, prix_ttc, fournisseur"
            " FROM historique_prix ORDER BY id")]
        # Sur toute la table, meme quand les transactions sont filtrees
        next_tx = cur.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM transactions").fetchone()[0]
        next_auto = cur.execute("SELECT COALESCE(MAX(id), 0) + 1 FROM autoclave").fetchone()[0]
    finally:
        conn.close()
    if jours_transactions is not None:
        limite = (datetime.date.today()
                  - datetime.timedelta(days=jours_transactions)).isoformat()
        transactions = [t for t in transactions if _date_recente(t["date"], limite)]
        historique_prix = [h for h in historique_prix if _date_recente(h["date"], limite)]
    return {
        "produits": produits,
        "stock": stock,
        "transactions": transactions,
        "autoclave": autoclave,
        "historique_prix": historique_prix,
        "nextTxId": next_tx,
        "nextAutoId": next_auto,
    }


# ------------------------------------------------------------------
# Stock
# ------------------------------------------------------------------

def _maj_produit(cur, p):
    p = _exiger_dict(p)
    ref = _champ_texte(p, "reference").strip()
    if not ref:
        raise ErreurDonnees("La reference du produit est obligatoire.")

    # « arrete » absent (ancien poste, import de facture) : valeur en base conservee
    arrete = None if p.get("arrete") is None else (1 if safe_int(p.get("arrete")) else 0)
    cur.execute("""
        INSERT INTO produits (reference, nom, groupe, ref_scannette, type_stockage,
                              quantite_par_carton, arrete)
        VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, 0))
        ON CONFLICT(reference) DO UPDATE SET
          nom=excluded.nom, groupe=excluded.groupe, ref_scannette=excluded.ref_scannette,
          type_stockage=excluded.type_stockage, quantite_par_carton=excluded.quantite_par_carton,
          arrete=COALESCE(?, produits.arrete)
    """, (ref, _champ_texte(p, "nom"), _champ_texte(p, "groupe"),
          _champ_texte(p, "ref_scannette"),
          _champ_texte(p, "type_stockage") or "unite",
          _quantite_par_carton(p), arrete, arrete))


def _verifier_version(cur, ref, espace, s, deja_verifiees):
    """Refuse l'ecriture si la ligne a change depuis que le poste l'a lue.

    s["version"] absent : ancien poste, pas de controle. None : le poste
    croit la ligne nouvelle. Une ligne deja ecrite plus tot dans le meme lot
    n'est controlee qu'une fois (le poste ne connait pas encore sa version).
    """
    if "version" not in s or (ref, espace) in deja_verifiees:
        return
    deja_verifiees.add((ref, espace))
    ligne = cur.execute("SELECT version FROM stock WHERE reference = ? AND utilisateur = ?",
                        (ref, espace)).fetchone()
    attendue = s.get("version")
    actuelle = None if ligne is None else safe_int(ligne["version"])
    if attendue is None:
        conflit = ligne is not None
    else:
        conflit = actuelle is None or actuelle != safe_int(attendue, -1)
    if conflit:
        raise ErreurConflit(
            "« %s » (%s) vient d'être modifié depuis un autre poste." % (ref, espace))


def _maj_stock(cur, s, deja_verifiees=None):
    s = _exiger_dict(s)
    ref = _champ_texte(s, "reference").strip()
    espace = _champ_texte(s, "utilisateur").strip()
    if not ref or not espace:
        raise ErreurDonnees("Reference et espace obligatoires.")
    delai = _entier_js(s, "delai_peremption", 30)
    lots = _lots_details(s)

    _verifier_version(cur, ref, espace, s, set() if deja_verifiees is None else deja_verifiees)
    cur.execute("""
        INSERT INTO stock (reference, utilisateur, quantite, stock_minimum, alerte_active,
            alerte_peremption_active, delai_peremption, date_peremption, date_import,
            fournisseur, en_commande, date_commande, lot, prix_unitaire_ht,
            prix_unitaire_ttc, lots_details, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(reference, utilisateur) DO UPDATE SET
          quantite=excluded.quantite, stock_minimum=excluded.stock_minimum,
          alerte_active=excluded.alerte_active,
          alerte_peremption_active=excluded.alerte_peremption_active,
          delai_peremption=excluded.delai_peremption,
          date_peremption=excluded.date_peremption, date_import=excluded.date_import,
          fournisseur=excluded.fournisseur, en_commande=excluded.en_commande,
          date_commande=excluded.date_commande, lot=excluded.lot,
          prix_unitaire_ht=excluded.prix_unitaire_ht,
          prix_unitaire_ttc=excluded.prix_unitaire_ttc,
          lots_details=excluded.lots_details,
          version=COALESCE(stock.version, 0) + 1
    """, (ref, espace,
          max(0, _entier_js(s, "quantite")), _entier_js(s, "stock_minimum"),
          1 if safe_int(s.get("alerte_active")) else 0,
          1 if safe_int(s.get("alerte_peremption_active")) else 0,
          delai,
          _champ_texte(s, "date_peremption"), _champ_texte(s, "date_import"),
          _champ_texte(s, "fournisseur"),
          1 if safe_int(s.get("en_commande")) else 0,
          _champ_texte(s, "date_commande"), _champ_texte(s, "lot"),
          safe_float(s.get("prix_unitaire_ht")), safe_float(s.get("prix_unitaire_ttc")),
          lots))
    version = cur.execute("SELECT version FROM stock WHERE reference = ? AND utilisateur = ?",
                          (ref, espace)).fetchone()["version"]
    return {"reference": ref, "utilisateur": espace, "version": version}


def _suppr_stock(cur, reference, utilisateur):
    cur.execute("DELETE FROM stock WHERE reference = ? AND utilisateur = ?",
                (_texte(reference), _texte(utilisateur)))


def _suppr_produit(cur, reference):
    cur.execute("DELETE FROM stock WHERE reference = ?", (_texte(reference),))
    cur.execute("DELETE FROM produits WHERE reference = ?", (_texte(reference),))


def _ajout_transaction(cur, t):
    t = _exiger_dict(t)
    cur.execute("""
        INSERT INTO transactions (date, reference, utilisateur, type_transaction,
                                  quantite, lot, peremption_sortie)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (_champ_texte(t, "date"), _champ_texte(t, "reference"),
          _champ_texte(t, "utilisateur"), _champ_texte(t, "type_transaction"),
          _entier_js(t, "quantite"), _champ_texte(t, "lot"),
          _champ_texte(t, "peremption_sortie")))
    return cur.lastrowid


def _ajout_autoclave(cur, a):
    a = _exiger_dict(a)
    utilisateur, commentaire = _champ_texte(a, "utilisateur"), _champ_texte(a, "commentaire")
    if not utilisateur.strip() or not commentaire.strip():
        raise ErreurDonnees("Utilisateur et commentaire obligatoires.")
    cur.execute("""
        INSERT INTO autoclave (date, machine, utilisateur, commentaire)
        VALUES (?, ?, ?, ?)
    """, (_champ_texte(a, "date"), _champ_texte(a, "machine"), utilisateur, commentaire))
    return cur.lastrowid


def _ajout_historique_prix(cur, h):
    h = _exiger_dict(h)
    cur.execute("""
        INSERT INTO historique_prix (reference, date, prix_ht, prix_ttc, fournisseur)
        VALUES (?, ?, ?, ?, ?)
    """, (_champ_texte(h, "reference"), _champ_texte(h, "date"),
          safe_float(h.get("prix_ht"), None), safe_float(h.get("prix_ttc"), None),
          _champ_texte(h, "fournisseur")))
    return cur.lastrowid


def update_produit(p):
    _ecrire(lambda cur: _maj_produit(cur, p))


def update_stock_item(s):
    s = _exiger_dict(s)
    ligne = (_texte(s.get("reference")).strip(), _texte(s.get("utilisateur")).strip())

    def faire(cur):
        avant = _photo_peremption(cur, [ligne])
        resultat = _maj_stock(cur, s)
        _refuser_entrees_perimees(cur, [ligne], avant)
        return resultat
    return _ecrire(faire)


def delete_stock_item(reference, utilisateur):
    _ecrire(lambda cur: _suppr_stock(cur, reference, utilisateur))


def delete_produit(reference):
    _ecrire(lambda cur: _suppr_produit(cur, reference))


def add_transaction(t):
    """Ajoute une transaction ; l'identifiant est attribue par la base."""
    return _ecrire(lambda cur: _ajout_transaction(cur, t))


def add_autoclave(a):
    return _ecrire(lambda cur: _ajout_autoclave(cur, a))


def add_historique_prix(h):
    return _ecrire(lambda cur: _ajout_historique_prix(cur, h))


# ------------------------------------------------------------------
# Produits perimes : aucune entree en stock
# ------------------------------------------------------------------

# Formats de date de peremption ; doit rester aligne sur l'interface (JavaScript).
_DATE_JMA = re.compile(r"([0-9]{1,2})/([0-9]{1,2})/([0-9]{4}|[0-9]{2})")   # JJ/MM/AAAA, JJ/MM/AA
_DATE_AMJ = re.compile(r"([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})")            # AAAA-MM-JJ
_DATE_MA = re.compile(r"([0-9]{1,2})/([0-9]{4})")                         # MM/AAAA
_DATE_AM = re.compile(r"([0-9]{4})-([0-9]{1,2})")                         # AAAA-MM


def date_peremption(texte):
    """Date d'un texte JJ/MM/AAAA, JJ/MM/AA (an 2000 + AA), AAAA-MM-JJ, ou
    MM/AAAA, AAAA-MM (dernier jour du mois : un produit etiquete d'un mois
    perime a la fin de ce mois). Jour et mois sur 1 ou 2 chiffres.
    None si le texte est illisible ou la date impossible (31/02)."""
    texte = _texte(texte).strip()
    try:
        m = _DATE_JMA.fullmatch(texte)
        if m:
            annee = int(m.group(3)) + (2000 if len(m.group(3)) == 2 else 0)
            return datetime.date(annee, int(m.group(2)), int(m.group(1)))
        m = _DATE_AMJ.fullmatch(texte)
        if m:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = _DATE_MA.fullmatch(texte) or _DATE_AM.fullmatch(texte)
        if m:
            mois, annee = (int(m.group(1)), int(m.group(2))) if "/" in texte \
                else (int(m.group(2)), int(m.group(1)))
            return datetime.date(annee, mois, calendar.monthrange(annee, mois)[1])
    except (ValueError, calendar.IllegalMonthError):
        pass
    return None


def _est_perime(texte, aujourdhui):
    d = date_peremption(texte)
    return d is not None and d < aujourdhui


def _lots_quantifies(lots_details, quantite):
    """[(lot, date, qte)] ; les lots sans quantite se partagent le reste."""
    try:
        lots = json.loads(lots_details or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(lots, list):
        return []
    lots = [l for l in lots if isinstance(l, dict)]
    sans = [l for l in lots if l.get("qte") in (None, "")]
    connu = sum(max(0, safe_int(l.get("qte"))) for l in lots if l not in sans)
    reste = max(0, quantite - connu)
    part, extra = (divmod(reste, len(sans)) if sans else (0, 0))
    resultat = []
    for l in lots:
        if l in sans:
            qte = part + (1 if extra > 0 else 0)
            extra -= 1
        else:
            qte = max(0, safe_int(l.get("qte")))
        resultat.append((_texte(l.get("lot")).strip(), _texte(l.get("date")).strip(), qte))
    return resultat


def _photo_peremption(cur, lignes):
    """Lots et dates de peremption des lignes de stock donnees (ref, espace)."""
    lots, dates, quantites = {}, set(), {}
    for ref, espace in lignes:
        r = cur.execute("SELECT quantite, lots_details, date_peremption FROM stock"
                        " WHERE reference = ? AND utilisateur = ?", (ref, espace)).fetchone()
        if r is None:
            continue
        quantite = max(0, safe_int(r["quantite"]))
        quantites[(ref, espace)] = quantite
        detail = _lots_quantifies(r["lots_details"], quantite)
        for lot, date, qte in detail:
            lots[(lot, date)] = lots.get((lot, date), 0) + qte
            dates.add(date)
        if not detail:
            dates.update(d.strip() for d in _texte(r["date_peremption"]).replace(";", ",").split(",")
                         if d.strip())
    return {"lots": lots, "dates": dates, "quantites": quantites}


def _refuser_entrees_perimees(cur, lignes, avant):
    """Refuse un lot d'ecritures qui fait entrer du stock deja perime.

    Comparaison globale avant / apres sur les lignes touchees : un transfert
    ou un deplacement d'espace ne fait rien « entrer », il est accepte ; le
    stock deja en place qui a perime depuis reste modifiable.
    """
    aujourdhui = datetime.date.today()
    apres = _photo_peremption(cur, lignes)
    perimes = [(lot, date) for (lot, date), qte in apres["lots"].items()
               if qte > avant["lots"].get((lot, date), 0) and _est_perime(date, aujourdhui)]
    # Lignes sans detail par lot : une date perimee nouvelle avec une quantite en hausse
    for (ref, espace), qte in apres["quantites"].items():
        if qte <= avant["quantites"].get((ref, espace), 0):
            continue
        r = cur.execute("SELECT lots_details, date_peremption FROM stock"
                        " WHERE reference = ? AND utilisateur = ?", (ref, espace)).fetchone()
        if _lots_quantifies(r["lots_details"], qte):
            continue
        for date in _texte(r["date_peremption"]).replace(";", ",").split(","):
            date = date.strip()
            if date and date not in avant["dates"] and _est_perime(date, aujourdhui):
                perimes.append(("", date))
    if perimes:
        detail = ", ".join("%s%s" % ("lot %s, " % lot if lot else "", "périmé le %s" % date)
                           for lot, date in perimes)
        raise ErreurDonnees(
            "Entrée refusée : on ne peut pas mettre en stock un produit déjà périmé (%s)." % detail)


# ------------------------------------------------------------------
# Lot d'ecritures (une operation de l'interface = un lot)
# ------------------------------------------------------------------

def _operation(cur, op, deja_verifiees):
    op = _exiger_dict(op)
    action = op.get("action")
    d = op.get("donnees")
    if action == "updateProduit":
        _maj_produit(cur, d)
        return {}
    if action == "updateStockItem":
        return _maj_stock(cur, d, deja_verifiees)
    if action == "deleteStockItem":
        d = _exiger_dict(d)
        _suppr_stock(cur, d.get("reference"), d.get("utilisateur"))
        return {}
    if action == "deleteProduit":
        _suppr_produit(cur, _exiger_dict(d).get("reference"))
        return {}
    if action == "addTransaction":
        return {"id": _ajout_transaction(cur, d)}
    if action == "addAutoclave":
        return {"id": _ajout_autoclave(cur, d)}
    if action == "addHistoriquePrix":
        return {"id": _ajout_historique_prix(cur, d)}
    raise ErreurDonnees("Action inconnue : %s" % action)


def executer_lot(operations):
    """Execute les operations d'une meme action de l'interface (sortie de stock
    et ses transactions, transfert...) dans UNE transaction SQL : tout ou rien.

    Si un autre poste a modifie entre-temps une ligne de stock concernee,
    ErreurConflit est levee et rien n'est enregistre.
    """
    if not isinstance(operations, list) or not operations:
        raise ErreurDonnees("Liste d'operations attendue.")

    def faire(cur):
        lignes = _lignes_touchees(cur, operations)
        avant = _photo_peremption(cur, lignes)
        deja_verifiees = set()
        resultats = [_operation(cur, op, deja_verifiees) for op in operations]
        _refuser_entrees_perimees(cur, lignes, avant)
        return resultats
    return _ecrire(faire)


def _lignes_touchees(cur, operations):
    """Lignes de stock (ref, espace) qu'un lot d'operations peut modifier."""
    lignes = set()
    for op in operations:
        d = op.get("donnees") if isinstance(op, dict) else None
        if not isinstance(d, dict):
            continue
        ref = _texte(d.get("reference")).strip()
        action = op.get("action")
        if action in ("updateStockItem", "deleteStockItem"):
            lignes.add((ref, _texte(d.get("utilisateur")).strip()))
        elif action == "deleteProduit":
            lignes.update((ref, r["utilisateur"]) for r in cur.execute(
                "SELECT utilisateur FROM stock WHERE reference = ?", (ref,)))
    return sorted(lignes)


# ------------------------------------------------------------------
# Documents JSON nommes
# ------------------------------------------------------------------

def _cle_valide(cle):
    if cle not in DOCUMENTS_DEFAUT:
        raise ErreurDonnees("Document inconnu : %s" % cle)
    return cle


def _decoder_document(cle, valeur):
    """Valeur stockee decodee, ou copie du defaut si absente ou corrompue."""
    if valeur is not None:
        try:
            return json.loads(valeur)
        except ValueError:
            pass
    return json.loads(json.dumps(DOCUMENTS_DEFAUT[cle]))


def lire_document_et_version(cle):
    """{"valeur": ..., "version": int} lus ensemble (0 : jamais enregistre)."""
    _cle_valide(cle)
    conn = connexion()
    try:
        ligne = conn.execute("SELECT valeur, version FROM documents WHERE cle = ?",
                             (cle,)).fetchone()
    finally:
        conn.close()
    return {"valeur": _decoder_document(cle, ligne["valeur"] if ligne else None),
            "version": safe_int(ligne["version"]) if ligne else 0}


def lire_document(cle):
    return lire_document_et_version(cle)["valeur"]


def lire_documents_et_versions():
    """(documents, versions) de tous les documents, en une seule requete
    (appele a chaque /api/etat, donc par chaque poste a chaque rechargement).
    Lus ensemble : une version ne peut pas etre plus recente que sa valeur."""
    conn = connexion()
    try:
        lignes = {r["cle"]: r for r in conn.execute("SELECT cle, valeur, version FROM documents")}
    finally:
        conn.close()
    documents, versions = {}, {}
    for cle in DOCUMENTS_DEFAUT:
        ligne = lignes.get(cle)
        documents[cle] = _decoder_document(cle, ligne["valeur"] if ligne else None)
        versions[cle] = safe_int(ligne["version"]) if ligne else 0
    return documents, versions


def lire_documents():
    return lire_documents_et_versions()[0]


def _valider_document(cle, valeur):
    """Controle simple du document avant ecriture ; renvoie le JSON serialise."""
    invalide = ErreurDonnees("Format invalide pour le document « %s »." % cle)
    if cle == "record_jeu":
        if isinstance(valeur, bool) or not isinstance(valeur, (int, float)) or valeur < 0 \
                or (isinstance(valeur, float) and not math.isfinite(valeur)) \
                or valeur > ENTIER_JS_MAX:
            raise invalide
    elif not isinstance(valeur, dict) or any(
            champ in valeur and not isinstance(valeur[champ], list)
            for champ in LISTES_DOCUMENTS.get(cle, ())):
        raise invalide
    try:
        texte = json.dumps(valeur, ensure_ascii=False, allow_nan=False)
    except ValueError:                         # NaN / infini
        raise invalide
    if len(texte.encode("utf-8")) > TAILLE_MAX_DOCUMENT:
        raise ErreurDonnees("Document trop volumineux (2 Mo au maximum).")
    return texte


def ecrire_document(cle, valeur, version_attendue=None):
    """Enregistre le document et renvoie sa nouvelle version.

    version_attendue : version que le poste a lue. Si le document a ete
    modifie depuis, ErreurConflit (avec la version actuelle) et rien n'est
    ecrit. None : ecriture sans controle (anciens postes, import).
    """
    _cle_valide(cle)
    texte = _valider_document(cle, valeur)

    def faire(cur):
        ligne = cur.execute("SELECT version FROM documents WHERE cle = ?", (cle,)).fetchone()
        actuelle = safe_int(ligne["version"]) if ligne else 0
        if version_attendue is not None and version_attendue != actuelle:
            raise ErreurConflit("Ce document vient d'être modifié depuis un autre poste.",
                                version=actuelle)
        cur.execute("""
            INSERT INTO documents (cle, valeur, modifie_le, version)
            VALUES (?, ?, datetime('now', 'localtime'), ?)
            ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur,
              modifie_le=excluded.modifie_le, version=excluded.version
        """, (cle, texte, actuelle + 1))
        return actuelle + 1
    return _ecrire(faire)


def document_present(cle):
    conn = connexion()
    try:
        return conn.execute("SELECT 1 FROM documents WHERE cle = ?", (cle,)).fetchone() is not None
    finally:
        conn.close()


# ------------------------------------------------------------------
# Contacts
# ------------------------------------------------------------------

def lister_contacts():
    conn = connexion()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT id, %s FROM contacts ORDER BY id" % ", ".join(CHAMPS_CONTACT))]
    finally:
        conn.close()


def enregistrer_contact(c):
    """Cree (sans id) ou met a jour (avec id) un contact ; renvoie le contact."""
    c = _exiger_dict(c)
    valeurs = [_champ_texte(c, champ).strip() for champ in CHAMPS_CONTACT]
    if not any(valeurs[:3]):
        raise ErreurDonnees("Un nom, un prenom ou une entreprise est obligatoire.")
    ident = safe_int(c.get("id"), 0)

    def faire(cur):
        if ident and cur.execute("SELECT 1 FROM contacts WHERE id = ?", (ident,)).fetchone():
            cur.execute("UPDATE contacts SET %s WHERE id = ?" % ", ".join(
                "%s = ?" % champ for champ in CHAMPS_CONTACT), valeurs + [ident])
            return ident
        cur.execute("INSERT INTO contacts (%s) VALUES (%s)" % (
            ", ".join(CHAMPS_CONTACT), ", ".join("?" * len(CHAMPS_CONTACT))), valeurs)
        return cur.lastrowid
    nouvel_id = _ecrire(faire)
    contact = dict(zip(CHAMPS_CONTACT, valeurs))
    contact["id"] = nouvel_id
    return contact


def supprimer_contact(ident):
    _ecrire(lambda cur: cur.execute("DELETE FROM contacts WHERE id = ?", (safe_int(ident),)))


def remplacer_contacts(contacts):
    """Remplace tout le carnet (utilise par l'import depuis l'ancienne appli)."""
    lignes = []
    vus = set()
    for c in contacts or []:
        if not isinstance(c, dict):
            continue
        ident = safe_int(c.get("id"), None) or None
        if ident in vus:
            ident = None                       # doublon : la base renumerote
        if ident is not None:
            vus.add(ident)
        lignes.append([ident] + [_texte(c.get(champ)).strip() for champ in CHAMPS_CONTACT])

    def faire(cur):
        cur.execute("DELETE FROM contacts")
        cur.executemany("INSERT INTO contacts (id, %s) VALUES (?, %s)" % (
            ", ".join(CHAMPS_CONTACT), ", ".join("?" * len(CHAMPS_CONTACT))), lignes)
    _ecrire(faire)
    return len(lignes)


def compter(table):
    conn = connexion()
    try:
        return conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
    finally:
        conn.close()
