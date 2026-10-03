# -*- coding: utf-8 -*-
"""
Tests de la reprise de l'ancienne application (python/migration.py) et du
lecteur LevelDB (python/leveldb_lecteur.py). Toutes les donnees sont fictives.
"""

import json
import os
import sqlite3
import struct

import pytest

import base
import leveldb_lecteur as L
import migration


# ------------------------------------------------------------------
# Fabrication de fichiers LevelDB minimaux
# ------------------------------------------------------------------

def varint(n):
    sortie = bytearray()
    while True:
        octet = n & 0x7F
        n >>= 7
        if n:
            sortie.append(octet | 0x80)
        else:
            sortie.append(octet)
            return bytes(sortie)


def cle_ls(cle, origine=b"app:"):
    return b"_" + origine + b"\x00\x01" + cle.encode("latin-1")


def valeur_ls(texte):
    try:
        return b"\x01" + texte.encode("latin-1")
    except UnicodeEncodeError:
        return b"\x00" + texte.encode("utf-16-le")


def ecrire_journal(chemin, entrees, sequence=1):
    """entrees : [(cle, valeur ou None pour une suppression)]."""
    lot = struct.pack("<QI", sequence, len(entrees))
    for cle, valeur in entrees:
        if valeur is None:
            lot += b"\x00" + varint(len(cle)) + cle
        else:
            lot += b"\x01" + varint(len(cle)) + cle + varint(len(valeur)) + valeur
    enregistrement = b"\x00\x00\x00\x00" + struct.pack("<H", len(lot)) + b"\x01" + lot
    with open(chemin, "wb") as f:
        f.write(enregistrement)


def bloc(entrees):
    contenu = b""
    for cle, valeur in entrees:
        contenu += varint(0) + varint(len(cle)) + varint(len(valeur)) + cle + valeur
    contenu += struct.pack("<II", 0, 1)              # un point de redemarrage
    return contenu


def ecrire_table(chemin, entrees, sequence=1):
    """Table .ldb non compressee : [(cle_utilisateur, valeur)]."""
    internes = [(cle + struct.pack("<Q", ((sequence + i) << 8) | 1), val)
                for i, (cle, val) in enumerate(sorted(entrees))]
    donnees = bloc(internes)
    fichier = donnees + b"\x00" + b"\x00" * 4
    meta = bloc([])
    meta_off = len(fichier)
    fichier += meta + b"\x00" + b"\x00" * 4
    index = bloc([(internes[-1][0], varint(0) + varint(len(donnees)))])
    index_off = len(fichier)
    fichier += index + b"\x00" + b"\x00" * 4
    poignees = varint(meta_off) + varint(len(meta)) + varint(index_off) + varint(len(index))
    fichier += poignees.ljust(40, b"\x00") + struct.pack("<Q", 0xdb4775248b80fb57)
    with open(chemin, "wb") as f:
        f.write(fichier)


# ------------------------------------------------------------------
# Lecteur LevelDB
# ------------------------------------------------------------------

def test_snappy_litteral_et_copie():
    compresse = b"\x09" + b"\x08abc" + b"\x09\x03"
    assert L.decompresser_snappy(compresse) == b"abcabcabc"


def test_snappy_taille_incoherente():
    with pytest.raises(L.ErreurLevelDB):
        L.decompresser_snappy(b"\x05\x08abc")


def test_journal_valeurs_et_suppressions(tmp_path):
    ecrire_journal(tmp_path / "000003.log", [
        (cle_ls("a"), valeur_ls("1")),
        (cle_ls("b"), valeur_ls("2")),
        (cle_ls("a"), None),
    ])
    assert L.lire_local_storage(str(tmp_path)) == {"app:": {"b": "2"}}


def test_table_puis_journal_plus_recent(tmp_path):
    ecrire_table(tmp_path / "000005.ldb", [(cle_ls("x"), valeur_ls("ancien")),
                                           (cle_ls("y"), valeur_ls("garde"))], sequence=1)
    ecrire_journal(tmp_path / "000006.log", [(cle_ls("x"), valeur_ls("nouveau"))], sequence=50)
    assert L.lire_local_storage(str(tmp_path))["app:"] == {"x": "nouveau", "y": "garde"}


def test_texte_utf16_et_accents(tmp_path):
    ecrire_journal(tmp_path / "000003.log", [
        (cle_ls("latin"), valeur_ls("échange")),
        (cle_ls("utf16"), valeur_ls("emoji 🦷")),
    ])
    ls = L.lire_local_storage(str(tmp_path))["app:"]
    assert ls == {"latin": "échange", "utf16": "emoji 🦷"}


def test_filtre_par_origine_et_cles_techniques(tmp_path):
    ecrire_journal(tmp_path / "000003.log", [
        (cle_ls("k", b"file://"), valeur_ls("v1")),
        (cle_ls("k"), valeur_ls("v2")),
        (b"VERSION", b"1"),
        (b"META:app:", b"\x08\x01"),
    ])
    assert L.lire_local_storage(str(tmp_path), origine="app:") == {"app:": {"k": "v2"}}


# ------------------------------------------------------------------
# Litteraux JavaScript
# ------------------------------------------------------------------

def test_js_vers_json():
    litteral = """{
        // commentaire
        header1: "P1",
        rows: [
            { task: 'L\\'equipe', nature: "Ligne\\nsuivante", col1: "A", },
        ],
        actif: true, vide: null, /* bloc */ nombre: 3,
    }"""
    assert migration.js_vers_json(litteral) == {
        "header1": "P1",
        "rows": [{"task": "L'equipe", "nature": "Ligne\nsuivante", "col1": "A"}],
        "actif": True, "vide": None, "nombre": 3}


def test_constante_js(tmp_path):
    f = tmp_path / "x.js"
    f.write_text('const AUTRE = 1;\nexport const DEFAUT = { a: [1, 2], "b": { c: "}" } };\n',
                 encoding="utf-8")
    assert migration.constante_js(str(f), "DEFAUT") == {"a": [1, 2], "b": {"c": "}"}}
    assert migration.constante_js(str(f), "ABSENTE") is None
    assert migration.constante_js(str(tmp_path / "absent.js"), "DEFAUT") is None


# ------------------------------------------------------------------
# Import complet d'une ancienne installation (fictive)
# ------------------------------------------------------------------

PLANNING = {"even": [{"assistant": "Assistante A", "days": {"LUNDI": {"am": "Dr X", "pm": ""}}}],
            "odd": []}


@pytest.fixture
def ancienne(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))   # pas de config reelle
    dossier = tmp_path / "ancienne"
    (dossier / "web" / "js" / "planning").mkdir(parents=True)
    leveldb = dossier / "webstorage" / "Local Storage" / "leveldb"
    leveldb.mkdir(parents=True)

    conn = sqlite3.connect(str(dossier / "stock.db"))
    conn.execute("CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT)")
    conn.execute("CREATE TABLE stock (reference TEXT NOT NULL, utilisateur TEXT NOT NULL,"
                 " quantite INTEGER DEFAULT 0, PRIMARY KEY (reference, utilisateur))")
    conn.execute("INSERT INTO produits VALUES ('P1', 'Produit', '', '')")
    conn.execute("INSERT INTO stock VALUES ('P1', 'Commun', 4)")
    conn.commit()
    conn.close()

    contacts = [{"id": 1, "nom": "Labo Fictif", "tel_fixe": "00 00"}]
    ecrire_journal(leveldb / "000003.log", [
        (cle_ls("teamCalendarData"), valeur_ls(json.dumps(PLANNING))),
        (cle_ls("dosimetres_data"), valeur_ls(json.dumps(
            {"manager": "Responsable Z", "generalNote": "", "dosimetres": []}))),
        (cle_ls("carnets_adresses_data"), valeur_ls(json.dumps(contacts))),
        (cle_ls("dosiAlertNextTime"), valeur_ls("1800000000000")),
        (cle_ls("mireAlertNextTime"), valeur_ls("1700000000000")),
        (cle_ls("fauteuilAlertNextTime_Fauteuil Test"), valeur_ls("1750000000000")),
        (cle_ls("toothHighScore"), valeur_ls("28")),
        (cle_ls("ui-positions"), valeur_ls('{"action-area": {"left": "10%"}}')),
    ])
    (dossier / "web" / "js" / "planning" / "tasks-planning.js").write_text(
        "const DEFAULT_TASKS_DATA = {\n  header1: \"P1\",\n  rows: [\n"
        "    { task: \"Tache\", nature: \"N\", col1: \"Assistante A\", col2: \"\" }\n  ]\n};\n",
        encoding="utf-8")
    (dossier / "web" / "index.html").write_text(
        '<div id="tasks-container" class="calendar-wrapper active"></div>\n'
        '<div style="font-style: italic;">\n   Consigne   du matin.\n</div>', encoding="utf-8")
    return dossier


def test_import_complet(ancienne, tmp_path):
    rapport = migration.importer(str(ancienne), str(tmp_path / "nouvelle" / "stock.db"))
    assert "Import termine" in rapport

    db = base.charger_base()
    assert [p["reference"] for p in db["produits"]] == ["P1"]
    assert db["stock"][0]["quantite"] == 4

    assert base.lire_document("planning") == PLANNING
    assert base.lire_document("dosimetres")["manager"] == "Responsable Z"
    assert base.lire_document("rappel_dosimetres") == {"nextTime": 1800000000000}
    assert base.lire_document("rappels_mire")["Radio Panoramique"]["nextTime"] == 1700000000000
    assert base.lire_document("rappels_fauteuils")["Fauteuil Test"]["nextTime"] == 1750000000000
    assert base.lire_document("record_jeu") == 28
    assert base.lire_document("positions_interface") == {"action-area": {"left": "10%"}}
    assert [c["nom"] for c in base.lister_contacts()] == ["Labo Fictif"]

    # Taches absentes du navigateur : reprises de l'ancien code, avec la consigne
    taches = base.lire_document("taches")
    assert taches["rows"][0]["col1"] == "Assistante A"
    assert taches["note"] == "Consigne du matin."


def test_import_refuse_d_ecraser_une_base_remplie(ancienne, tmp_path):
    cible = tmp_path / "nouvelle.db"
    base.definir_chemin(str(cible))
    base.update_produit({"reference": "EXISTANT"})
    with pytest.raises(migration.ErreurMigration):
        migration.importer(str(ancienne), str(cible))


def test_import_force_sauvegarde_l_ancienne_base(ancienne, tmp_path):
    cible = tmp_path / "nouvelle.db"
    base.definir_chemin(str(cible))
    base.update_produit({"reference": "EXISTANT"})
    rapport = migration.importer(str(ancienne), str(cible), forcer=True)
    assert "sauvegardee" in rapport
    sauvegardes = [f for f in os.listdir(tmp_path) if f.startswith("nouvelle.db.avant-import-")]
    assert len(sauvegardes) == 1
    assert [p["reference"] for p in base.charger_base()["produits"]] == ["P1"]


def test_import_sans_navigateur_ni_base(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    vide = tmp_path / "vide"
    vide.mkdir()
    rapport = migration.importer(str(vide), str(tmp_path / "n.db"))
    assert "Aucun stock.db" in rapport
    assert base.lire_document("planning") == {"even": [], "odd": []}


def test_import_dossier_introuvable(tmp_path):
    with pytest.raises(migration.ErreurMigration):
        migration.importer(str(tmp_path / "absent"), str(tmp_path / "n.db"))


def test_base_choisie_dans_les_reglages_de_l_ancienne_appli(ancienne, tmp_path, monkeypatch):
    autre = tmp_path / "ailleurs.db"
    conn = sqlite3.connect(str(autre))
    conn.execute("CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT)")
    conn.execute("INSERT INTO produits VALUES ('DEPUIS_CONFIG', '', '', '')")
    conn.commit()
    conn.close()
    config = tmp_path / "appdata" / "GestionStockMedical"
    config.mkdir(parents=True)
    (config / "config.json").write_text(json.dumps({"db_path": str(autre)}), encoding="utf-8")

    migration.importer(str(ancienne), str(tmp_path / "n.db"))
    assert [p["reference"] for p in base.charger_base()["produits"]] == ["DEPUIS_CONFIG"]
