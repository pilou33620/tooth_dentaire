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

import json
import os
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
    "minuteurs": {
        "actifs": [],
        "preselections": [
            {"libelle": "Bain à ultrasons", "minutes": 10},
            {"libelle": "Trempage", "minutes": 15},
            {"libelle": "Séchage", "minutes": 20},
        ],
    },
}

CHAMPS_CONTACT = ("nom", "prenom", "entreprise", "email", "tel_fixe",
                  "tel_portable", "adresse", "code_postal", "ville", "note")


class ErreurDonnees(ValueError):
    """Donnees envoyees invalides (repondues en 400 par le serveur)."""


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
        CHEMIN_BASE = chemin
        init_db()
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
    except sqlite3.OperationalError:
        pass                                   # colonne deja presente


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
                           "delai_peremption INTEGER DEFAULT 30"):
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

def safe_float(val, default=0.0):
    if val is None or val == "":
        return default
    if isinstance(val, (int, float)):
        return float(val)
    try:
        return float(str(val).replace(" ", "").replace(",", ".").strip())
    except (ValueError, TypeError):
        return default


def safe_int(val, default=0):
    if val is None or val == "":
        return default
    try:
        return int(float(val))
    except (ValueError, TypeError):
        return default


def _texte(val):
    return "" if val is None else str(val)


def _exiger_dict(data):
    if not isinstance(data, dict):
        raise ErreurDonnees("Format de donnees invalide (objet attendu).")
    return data


# ------------------------------------------------------------------
# Lecture complete
# ------------------------------------------------------------------

def charger_base():
    """Toute la base au format attendu par l'interface (ancien app.js)."""
    conn = connexion()
    try:
        cur = conn.cursor()
        produits = [dict(r) for r in cur.execute(
            "SELECT reference, nom, groupe, ref_scannette, type_stockage,"
            " quantite_par_carton FROM produits")]
        stock = [dict(r) for r in cur.execute(
            "SELECT reference, utilisateur, quantite, stock_minimum, alerte_active,"
            " alerte_peremption_active, delai_peremption, date_peremption, date_import,"
            " fournisseur, en_commande, date_commande, lot, prix_unitaire_ht,"
            " prix_unitaire_ttc, lots_details FROM stock")]
        transactions = [dict(r) for r in cur.execute(
            "SELECT id, date, reference, utilisateur, type_transaction, quantite,"
            " lot, peremption_sortie FROM transactions ORDER BY id")]
        autoclave = [dict(r) for r in cur.execute(
            "SELECT id, date, machine, utilisateur, commentaire FROM autoclave ORDER BY id")]
        historique_prix = [dict(r) for r in cur.execute(
            "SELECT id, reference, date, prix_ht, prix_ttc, fournisseur"
            " FROM historique_prix ORDER BY id")]
    finally:
        conn.close()
    return {
        "produits": produits,
        "stock": stock,
        "transactions": transactions,
        "autoclave": autoclave,
        "historique_prix": historique_prix,
        "nextTxId": max((t["id"] or 0 for t in transactions), default=0) + 1,
        "nextAutoId": max((a["id"] or 0 for a in autoclave), default=0) + 1,
    }


# ------------------------------------------------------------------
# Stock
# ------------------------------------------------------------------

def update_produit(p):
    p = _exiger_dict(p)
    ref = _texte(p.get("reference")).strip()
    if not ref:
        raise ErreurDonnees("La reference du produit est obligatoire.")

    def faire(cur):
        cur.execute("""
            INSERT INTO produits (reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(reference) DO UPDATE SET
              nom=excluded.nom, groupe=excluded.groupe, ref_scannette=excluded.ref_scannette,
              type_stockage=excluded.type_stockage, quantite_par_carton=excluded.quantite_par_carton
        """, (ref, _texte(p.get("nom")), _texte(p.get("groupe")),
              _texte(p.get("ref_scannette")),
              _texte(p.get("type_stockage")) or "unite",
              max(1, safe_int(p.get("quantite_par_carton"), 1))))
    _ecrire(faire)


def update_stock_item(s):
    s = _exiger_dict(s)
    ref = _texte(s.get("reference")).strip()
    espace = _texte(s.get("utilisateur")).strip()
    if not ref or not espace:
        raise ErreurDonnees("Reference et espace obligatoires.")
    delai = s.get("delai_peremption")
    delai = 30 if delai is None or delai == "" else safe_int(delai, 30)
    lots = s.get("lots_details", "[]")
    if not isinstance(lots, str):
        lots = json.dumps(lots, ensure_ascii=False)

    def faire(cur):
        cur.execute("""
            INSERT INTO stock (reference, utilisateur, quantite, stock_minimum, alerte_active,
                alerte_peremption_active, delai_peremption, date_peremption, date_import,
                fournisseur, en_commande, date_commande, lot, prix_unitaire_ht,
                prix_unitaire_ttc, lots_details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              lots_details=excluded.lots_details
        """, (ref, espace,
              max(0, safe_int(s.get("quantite"))), safe_int(s.get("stock_minimum")),
              1 if safe_int(s.get("alerte_active")) else 0,
              1 if safe_int(s.get("alerte_peremption_active")) else 0,
              delai,
              _texte(s.get("date_peremption")), _texte(s.get("date_import")),
              _texte(s.get("fournisseur")),
              1 if safe_int(s.get("en_commande")) else 0,
              _texte(s.get("date_commande")), _texte(s.get("lot")),
              safe_float(s.get("prix_unitaire_ht")), safe_float(s.get("prix_unitaire_ttc")),
              lots or "[]"))
    _ecrire(faire)


def delete_stock_item(reference, utilisateur):
    _ecrire(lambda cur: cur.execute(
        "DELETE FROM stock WHERE reference = ? AND utilisateur = ?",
        (_texte(reference), _texte(utilisateur))))


def delete_produit(reference):
    def faire(cur):
        cur.execute("DELETE FROM stock WHERE reference = ?", (_texte(reference),))
        cur.execute("DELETE FROM produits WHERE reference = ?", (_texte(reference),))
    _ecrire(faire)


def add_transaction(t):
    """Ajoute une transaction ; l'identifiant est attribue par la base."""
    t = _exiger_dict(t)

    def faire(cur):
        cur.execute("""
            INSERT INTO transactions (date, reference, utilisateur, type_transaction,
                                      quantite, lot, peremption_sortie)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (_texte(t.get("date")), _texte(t.get("reference")),
              _texte(t.get("utilisateur")), _texte(t.get("type_transaction")),
              safe_int(t.get("quantite")), _texte(t.get("lot")),
              _texte(t.get("peremption_sortie"))))
        return cur.lastrowid
    return _ecrire(faire)


def add_autoclave(a):
    a = _exiger_dict(a)
    if not _texte(a.get("utilisateur")).strip() or not _texte(a.get("commentaire")).strip():
        raise ErreurDonnees("Utilisateur et commentaire obligatoires.")

    def faire(cur):
        cur.execute("""
            INSERT INTO autoclave (date, machine, utilisateur, commentaire)
            VALUES (?, ?, ?, ?)
        """, (_texte(a.get("date")), _texte(a.get("machine")),
              _texte(a.get("utilisateur")), _texte(a.get("commentaire"))))
        return cur.lastrowid
    return _ecrire(faire)


def add_historique_prix(h):
    h = _exiger_dict(h)

    def faire(cur):
        cur.execute("""
            INSERT INTO historique_prix (reference, date, prix_ht, prix_ttc, fournisseur)
            VALUES (?, ?, ?, ?, ?)
        """, (_texte(h.get("reference")), _texte(h.get("date")),
              safe_float(h.get("prix_ht"), None), safe_float(h.get("prix_ttc"), None),
              _texte(h.get("fournisseur"))))
        return cur.lastrowid
    return _ecrire(faire)


# ------------------------------------------------------------------
# Documents JSON nommes
# ------------------------------------------------------------------

def _cle_valide(cle):
    if cle not in DOCUMENTS_DEFAUT:
        raise ErreurDonnees("Document inconnu : %s" % cle)
    return cle


def lire_document(cle):
    _cle_valide(cle)
    conn = connexion()
    try:
        ligne = conn.execute("SELECT valeur FROM documents WHERE cle = ?", (cle,)).fetchone()
    finally:
        conn.close()
    if ligne is None:
        return json.loads(json.dumps(DOCUMENTS_DEFAUT[cle]))
    try:
        return json.loads(ligne["valeur"])
    except ValueError:
        return json.loads(json.dumps(DOCUMENTS_DEFAUT[cle]))


def lire_documents():
    return {cle: lire_document(cle) for cle in DOCUMENTS_DEFAUT}


def ecrire_document(cle, valeur):
    _cle_valide(cle)
    texte = json.dumps(valeur, ensure_ascii=False)
    _ecrire(lambda cur: cur.execute("""
        INSERT INTO documents (cle, valeur, modifie_le) VALUES (?, ?, datetime('now', 'localtime'))
        ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur, modifie_le=excluded.modifie_le
    """, (cle, texte)))


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
    valeurs = [_texte(c.get(champ)).strip() for champ in CHAMPS_CONTACT]
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
