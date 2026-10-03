# -*- coding: utf-8 -*-
"""
Reprise des donnees de l'ancienne application (PySide6).

    python serveur.py --importer "C:\\chemin\\vers\\ancienne-appli"

Ce qui est repris :
  - stock.db (produits, stock, transactions, maintenance, historique des prix),
    ou la base choisie dans les reglages de l'ancienne appli
    (%APPDATA%\\GestionStockMedical\\config.json) ;
  - le localStorage du navigateur integre (webstorage/Local Storage/leveldb) :
    planning binomes, taches, dosimetres, rappels mire / fauteuils /
    dosimetres, carnet d'adresses, record du mini-jeu, positions d'interface ;
  - a defaut de localStorage, les valeurs par defaut ecrites dans l'ancien
    code (planning, taches, dosimetres, carnet d'adresses).

Ce module ne contient lui-meme aucune donnee du cabinet : il les LIT dans
l'ancien dossier et les ecrit dans la base.
"""

import datetime
import json
import os
import re
import shutil
import sqlite3

import base
import leveldb_lecteur


class ErreurMigration(Exception):
    pass


TABLES_STOCK = ("produits", "stock", "transactions", "autoclave", "historique_prix")


# ------------------------------------------------------------------
# Litteraux JavaScript -> JSON
# ------------------------------------------------------------------

def _extraire_bloc(texte, debut):
    """Renvoie le litteral {...} ou [...] qui commence a `debut`."""
    ouvrant = texte[debut]
    fermant = {"{": "}", "[": "]"}[ouvrant]
    profondeur = 0
    i = debut
    chaine = None
    while i < len(texte):
        c = texte[i]
        if chaine:
            if c == "\\":
                i += 2
                continue
            if c == chaine:
                chaine = None
        elif c in "\"'`":
            chaine = c
        elif c in "{[":
            profondeur += 1
        elif c in "}]":
            profondeur -= 1
            if profondeur == 0:
                return texte[debut:i + 1]
        i += 1
    raise ValueError("litteral non ferme")


def js_vers_json(litteral):
    """Convertit un litteral objet JS simple en JSON (cles non quotees,
    chaines entre apostrophes, virgules finales, commentaires)."""
    sortie = []
    i = 0
    n = len(litteral)
    while i < n:
        c = litteral[i]
        if c in "\"'":
            j = i + 1
            morceau = []
            while j < n and litteral[j] != c:
                if litteral[j] == "\\":
                    morceau.append(litteral[j:j + 2])
                    j += 2
                    continue
                morceau.append(litteral[j])
                j += 1
            contenu = "".join(morceau)
            if c == "'":
                contenu = contenu.replace("\\'", "'").replace('"', '\\"')
            sortie.append('"%s"' % contenu)
            i = j + 1
            continue
        if litteral.startswith("//", i):
            fin = litteral.find("\n", i)
            i = n if fin < 0 else fin
            continue
        if litteral.startswith("/*", i):
            fin = litteral.find("*/", i)
            i = n if fin < 0 else fin + 2
            continue
        m = re.match(r"[A-Za-z_$][\w$]*", litteral[i:])
        if m:
            mot = m.group(0)
            reste = litteral[i + len(mot):].lstrip()
            if reste.startswith(":"):
                sortie.append('"%s"' % mot)
            else:
                sortie.append(mot)
            i += len(mot)
            continue
        sortie.append(c)
        i += 1
    texte = "".join(sortie)
    texte = re.sub(r",(\s*[}\]])", r"\1", texte)
    return json.loads(texte)


def constante_js(chemin, nom):
    """Valeur de `const <nom> = {...}` (ou `let`) dans un fichier JS / HTML."""
    try:
        with open(chemin, "r", encoding="utf-8") as f:
            texte = f.read()
    except OSError:
        return None
    m = re.search(r"\b(?:const|let|var)\s+%s\s*=\s*" % re.escape(nom), texte)
    if not m:
        return None
    debut = m.end()
    while debut < len(texte) and texte[debut] not in "{[":
        debut += 1
    try:
        return js_vers_json(_extraire_bloc(texte, debut))
    except (ValueError, IndexError):
        return None


def note_taches_html(chemin):
    """Consigne ecrite en dur sous le tableau des taches de l'ancien index.html."""
    try:
        with open(chemin, "r", encoding="utf-8") as f:
            texte = f.read()
    except OSError:
        return ""
    m = re.search(r'<div id="tasks-container"[^>]*>\s*</div>\s*<div[^>]*>(.*?)</div>',
                  texte, re.S)
    if not m or "<" in m.group(1):
        return ""
    return " ".join(m.group(1).split())


# ------------------------------------------------------------------
# Ancienne base SQLite
# ------------------------------------------------------------------

def _base_ancienne(dossier):
    """Base reellement utilisee par l'ancienne appli."""
    candidats = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        config = os.path.join(appdata, "GestionStockMedical", "config.json")
        try:
            with open(config, "r", encoding="utf-8") as f:
                chemin = (json.load(f) or {}).get("db_path", "")
            if chemin:
                candidats.append(chemin)
        except (OSError, ValueError, AttributeError):
            pass
    candidats.append(os.path.join(dossier, "stock.db"))
    for chemin in candidats:
        if chemin and os.path.isfile(chemin):
            return os.path.abspath(chemin)
    return None


def _base_remplie(chemin):
    if not os.path.isfile(chemin):
        return False
    conn = sqlite3.connect(chemin)
    try:
        for table in TABLES_STOCK:
            try:
                if conn.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]:
                    return True
            except sqlite3.OperationalError:
                continue
        return False
    finally:
        conn.close()


# ------------------------------------------------------------------
# localStorage
# ------------------------------------------------------------------

def _local_storage(dossier):
    leveldb = os.path.join(dossier, "webstorage", "Local Storage", "leveldb")
    if not os.path.isdir(leveldb):
        return {}
    par_origine = leveldb_lecteur.lire_local_storage(leveldb)
    # L'appli servait index.html sous app://local (origine notee « app: »).
    # Les anciennes versions passaient par file:// : on ne s'en sert qu'en
    # complement, pour les cles absentes de l'origine actuelle.
    fusion = {}
    for origine in sorted(par_origine, key=lambda o: 0 if o.startswith("app") else 1,
                          reverse=True):
        fusion.update(par_origine[origine])
    return fusion


def _json(valeur, defaut=None):
    try:
        return json.loads(valeur)
    except (TypeError, ValueError):
        return defaut


def _entier(valeur):
    try:
        return int(str(valeur).strip())
    except (TypeError, ValueError):
        return None


def _rappels(ls, cle_groupe, prefixe, legacy=None, legacy_machine=None):
    """Fusionne les rappels par machine (format groupe + cles individuelles)."""
    rappels = _json(ls.get(cle_groupe), {}) or {}
    if not isinstance(rappels, dict):
        rappels = {}
    for cle, valeur in ls.items():
        if cle.startswith(prefixe):
            machine = cle[len(prefixe):]
            temps = _entier(valeur)
            if machine and temps and machine not in rappels:
                rappels[machine] = {"nextTime": temps, "lastDone": None}
    if legacy and legacy_machine and legacy_machine not in rappels:
        temps = _entier(ls.get(legacy))
        if temps:
            rappels[legacy_machine] = {"nextTime": temps, "lastDone": None, "intervalDays": 180}
    return rappels


# ------------------------------------------------------------------
# Import
# ------------------------------------------------------------------

def importer(dossier_ancien, chemin_base, forcer=False):
    dossier_ancien = os.path.abspath(dossier_ancien)
    if not os.path.isdir(dossier_ancien):
        raise ErreurMigration("Dossier introuvable : %s" % dossier_ancien)
    chemin_base = os.path.abspath(chemin_base)
    lignes = ["Import depuis : %s" % dossier_ancien]

    # 1. Base SQLite
    ancienne = _base_ancienne(dossier_ancien)
    if ancienne and os.path.normcase(ancienne) != os.path.normcase(chemin_base):
        if _base_remplie(chemin_base) and not forcer:
            raise ErreurMigration(
                "La base %s contient deja des donnees. Relancer avec --forcer "
                "pour la remplacer (une copie de sauvegarde sera faite)." % chemin_base)
        if os.path.exists(chemin_base):
            sauvegarde = "%s.avant-import-%s" % (
                chemin_base, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
            shutil.copy2(chemin_base, sauvegarde)
            lignes.append("Ancienne base sauvegardee : %s" % sauvegarde)
        os.makedirs(os.path.dirname(chemin_base), exist_ok=True)
        shutil.copy2(ancienne, chemin_base)
        lignes.append("Base de stock reprise : %s" % ancienne)
    elif not ancienne:
        lignes.append("[!] Aucun stock.db trouve : base de stock vide.")
    base.definir_chemin(chemin_base)

    # 2. Donnees du navigateur integre
    ls = _local_storage(dossier_ancien)
    web = os.path.join(dossier_ancien, "web")
    lignes.append("Cles de navigateur trouvees : %d" % len(ls))

    def poser(cle, valeur, origine):
        if valeur is None:
            lignes.append("  - %-20s : rien a reprendre" % cle)
            return
        base.ecrire_document(cle, valeur)
        lignes.append("  - %-20s : %s" % (cle, origine))

    planning = _json(ls.get("teamCalendarData"))
    if isinstance(planning, dict) and "even" in planning:
        poser("planning", planning, "navigateur")
    else:
        poser("planning", constante_js(os.path.join(web, "js", "planning", "team-planning.js"),
                                       "DEFAULT_CALENDAR_DATA"), "valeurs de l'ancien code")

    taches = _json(ls.get("teamTasksData"))
    origine_taches = "navigateur"
    if not (isinstance(taches, dict) and "rows" in taches):
        taches = constante_js(os.path.join(web, "js", "planning", "tasks-planning.js"),
                              "DEFAULT_TASKS_DATA")
        origine_taches = "valeurs de l'ancien code"
    if isinstance(taches, dict) and not taches.get("note"):
        note = note_taches_html(os.path.join(web, "index.html"))
        if note:
            taches["note"] = note
    poser("taches", taches, origine_taches)

    dosimetres = _json(ls.get("dosimetres_data"))
    if isinstance(dosimetres, dict):
        poser("dosimetres", dosimetres, "navigateur")
    else:
        poser("dosimetres", constante_js(os.path.join(web, "js", "features", "dosimetres.js"),
                                         "DEFAULT_DOSIMETRES_DATA"), "valeurs de l'ancien code")

    mire = _rappels(ls, "mireAlertsByCabinet", "mireAlertNextTime_",
                    legacy="mireAlertNextTime", legacy_machine="Radio Panoramique")
    poser("rappels_mire", mire or None, "navigateur")
    fauteuils = _rappels(ls, "fauteuilAlertsByCabinet", "fauteuilAlertNextTime_")
    poser("rappels_fauteuils", fauteuils or None, "navigateur")
    dosi = _entier(ls.get("dosiAlertNextTime"))
    poser("rappel_dosimetres", {"nextTime": dosi} if dosi else None, "navigateur")

    record = _entier(ls.get("toothHighScore"))
    poser("record_jeu", record if record else None, "navigateur")
    positions = _json(ls.get("ui-positions"))
    poser("positions_interface", positions if isinstance(positions, dict) else None,
          "navigateur")

    contacts = _json(ls.get("carnets_adresses_data")) or _json(ls.get("cahier_adresses_data"))
    origine = "navigateur"
    if not isinstance(contacts, list):
        contacts = constante_js(os.path.join(web, "html", "annuaire.html"), "defaultContacts")
        origine = "valeurs de l'ancien code"
    if isinstance(contacts, list):
        n = base.remplacer_contacts(contacts)
        lignes.append("  - %-20s : %d contact(s) (%s)" % ("contacts", n, origine))
    else:
        lignes.append("  - %-20s : rien a reprendre" % "contacts")

    lignes.append("Stock : %d produit(s), %d ligne(s), %d transaction(s)." % (
        base.compter("produits"), base.compter("stock"), base.compter("transactions")))
    lignes.append("Import termine.")
    return "\n".join(lignes)
