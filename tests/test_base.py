# -*- coding: utf-8 -*-
"""Tests de la couche base de donnees (python/base.py)."""

import json
import sqlite3

import pytest

import base
from conftest import produit, ligne_stock


# ------------------------------------------------------------------
# Schema
# ------------------------------------------------------------------

def test_tables_creees(base_temp):
    conn = sqlite3.connect(str(base_temp))
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"produits", "stock", "transactions", "autoclave", "historique_prix",
            "contacts", "documents"} <= tables


def test_base_vide_chargee(base_temp):
    db = base.charger_base()
    assert db["produits"] == [] and db["stock"] == [] and db["transactions"] == []
    assert db["nextTxId"] == 1 and db["nextAutoId"] == 1


def test_reprise_d_une_ancienne_base(tmp_path):
    """Une base de l'ancienne appli (schema d'origine) est completee sans perte."""
    chemin = tmp_path / "ancienne.db"
    conn = sqlite3.connect(str(chemin))
    conn.execute("CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT)")
    conn.execute("""CREATE TABLE stock (reference TEXT NOT NULL, utilisateur TEXT NOT NULL,
                    quantite INTEGER DEFAULT 0, stock_minimum INTEGER DEFAULT 0,
                    alerte_active INTEGER DEFAULT 0, date_peremption TEXT DEFAULT '',
                    date_import TEXT DEFAULT '', PRIMARY KEY (reference, utilisateur))""")
    conn.execute("INSERT INTO produits VALUES ('A1', 'Ancien', '', '')")
    conn.execute("INSERT INTO stock (reference, utilisateur, quantite, date_peremption)"
                 " VALUES ('A1', 'Commun', 3, '31/12/2030')")
    conn.commit()
    conn.close()

    base.definir_chemin(str(chemin))
    db = base.charger_base()
    assert db["produits"][0]["type_stockage"] == "unite"
    assert db["stock"][0]["quantite"] == 3
    # Pre-alerte activee une seule fois sur les lignes deja datees
    assert db["stock"][0]["alerte_peremption_active"] == 1
    assert db["stock"][0]["delai_peremption"] == 30


def test_pre_alerte_non_reactivee_au_redemarrage(base_temp):
    base.update_stock_item(ligne_stock(date_peremption="31/12/2030", alerte_peremption_active=0))
    base.init_db()
    assert base.charger_base()["stock"][0]["alerte_peremption_active"] == 0


# ------------------------------------------------------------------
# Produits et stock
# ------------------------------------------------------------------

def test_produit_insere_puis_mis_a_jour(base_temp):
    base.update_produit(produit())
    base.update_produit(produit(nom="Renomme", type_stockage="carton", quantite_par_carton=10))
    produits = base.charger_base()["produits"]
    assert len(produits) == 1
    assert produits[0]["nom"] == "Renomme"
    assert produits[0]["quantite_par_carton"] == 10


def test_produit_sans_reference_refuse(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.update_produit({"nom": "Sans ref"})


def test_donnees_non_objet_refusees(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.update_stock_item(["pas", "un", "objet"])


def test_quantite_par_carton_au_moins_un(base_temp):
    base.update_produit(produit(quantite_par_carton=0))
    assert base.charger_base()["produits"][0]["quantite_par_carton"] == 1


def test_ligne_de_stock_upsert(base_temp):
    base.update_stock_item(ligne_stock())
    base.update_stock_item(ligne_stock(quantite=9, fournisseur="Autre"))
    stock = base.charger_base()["stock"]
    assert len(stock) == 1
    assert stock[0]["quantite"] == 9 and stock[0]["fournisseur"] == "Autre"


def test_meme_reference_dans_deux_espaces(base_temp):
    base.update_stock_item(ligne_stock(espace="Commun"))
    base.update_stock_item(ligne_stock(espace="Cabinet 1"))
    assert len(base.charger_base()["stock"]) == 2


def test_quantite_negative_ramenee_a_zero(base_temp):
    base.update_stock_item(ligne_stock(quantite=-4))
    assert base.charger_base()["stock"][0]["quantite"] == 0


def test_prix_au_format_francais(base_temp):
    base.update_stock_item(ligne_stock(prix_unitaire_ht="1 234,50", prix_unitaire_ttc="abc"))
    s = base.charger_base()["stock"][0]
    assert s["prix_unitaire_ht"] == pytest.approx(1234.5)
    assert s["prix_unitaire_ttc"] == 0


def test_delai_peremption_vide_vaut_30(base_temp):
    base.update_stock_item(ligne_stock(delai_peremption=""))
    assert base.charger_base()["stock"][0]["delai_peremption"] == 30


def test_lots_details_objet_serialise(base_temp):
    lots = [{"lot": "L1", "date": "01/01/2030", "qte": 5}]
    base.update_stock_item(ligne_stock(lots_details=lots))
    assert json.loads(base.charger_base()["stock"][0]["lots_details"]) == lots


def test_reference_et_espace_obligatoires(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.update_stock_item(ligne_stock(utilisateur=""))


def test_suppression_ligne_de_stock(base_temp):
    base.update_stock_item(ligne_stock(espace="Commun"))
    base.update_stock_item(ligne_stock(espace="Cabinet 1"))
    base.delete_stock_item("REF1", "Commun")
    stock = base.charger_base()["stock"]
    assert [s["utilisateur"] for s in stock] == ["Cabinet 1"]


def test_suppression_produit_retire_tout_son_stock(base_temp):
    base.update_produit(produit())
    base.update_stock_item(ligne_stock(espace="Commun"))
    base.update_stock_item(ligne_stock(espace="Cabinet 1"))
    base.delete_produit("REF1")
    db = base.charger_base()
    assert db["produits"] == [] and db["stock"] == []


# ------------------------------------------------------------------
# Transactions, maintenance, prix
# ------------------------------------------------------------------

def test_identifiants_de_transaction_attribues_par_la_base(base_temp):
    # Deux postes peuvent proposer le meme id : la base l'ignore et numerote.
    t = {"id": 7, "date": "2026-10-01T10:00:00Z", "reference": "REF1",
         "utilisateur": "Commun", "type_transaction": "SORTIE_STOCK", "quantite": 2}
    id1 = base.add_transaction(t)
    id2 = base.add_transaction(t)
    assert id1 != id2
    assert len(base.charger_base()["transactions"]) == 2
    assert base.charger_base()["nextTxId"] == id2 + 1


def test_transaction_conserve_lot_et_peremption(base_temp):
    base.add_transaction({"date": "d", "reference": "R", "utilisateur": "Salle de chir",
                          "type_transaction": "SORTIE_STOCK", "quantite": 1,
                          "lot": "L42", "peremption_sortie": "01/01/2030"})
    tx = base.charger_base()["transactions"][0]
    assert tx["lot"] == "L42" and tx["peremption_sortie"] == "01/01/2030"


def test_entree_de_maintenance(base_temp):
    ident = base.add_autoclave({"date": "01/10/2026", "machine": "Melag",
                                "utilisateur": "Personne", "commentaire": "Filtre"})
    entree = base.charger_base()["autoclave"][0]
    assert entree["id"] == ident and entree["machine"] == "Melag"


def test_maintenance_sans_commentaire_refusee(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.add_autoclave({"date": "d", "utilisateur": "P", "commentaire": " "})


def test_historique_des_prix(base_temp):
    base.add_historique_prix({"reference": "R", "date": "d", "prix_ht": "2,5",
                              "prix_ttc": None, "fournisseur": "F"})
    h = base.charger_base()["historique_prix"][0]
    assert h["prix_ht"] == pytest.approx(2.5) and h["prix_ttc"] is None


# ------------------------------------------------------------------
# Documents
# ------------------------------------------------------------------

def test_documents_par_defaut_sans_aucun_nom(base_temp):
    docs = base.lire_documents()
    assert set(docs) == set(base.DOCUMENTS_DEFAUT)
    assert docs["planning"] == {"even": [], "odd": []}
    assert docs["dosimetres"]["manager"] == "" and docs["dosimetres"]["dosimetres"] == []
    assert docs["taches"]["rows"] == []


def test_document_ecrit_puis_relu(base_temp):
    base.ecrire_document("planning", {"even": [{"assistant": "A"}], "odd": []})
    assert base.lire_document("planning")["even"][0]["assistant"] == "A"
    assert base.document_present("planning")


def test_document_inconnu_refuse(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.ecrire_document("../etc", {})
    with pytest.raises(base.ErreurDonnees):
        base.lire_document("inconnu")


def test_valeur_par_defaut_non_partagee(base_temp):
    doc = base.lire_document("planning")
    doc["even"].append("modifie")
    assert base.lire_document("planning") == {"even": [], "odd": []}


def test_document_corrompu_retombe_sur_le_defaut(base_temp):
    conn = sqlite3.connect(str(base_temp))
    conn.execute("INSERT INTO documents (cle, valeur) VALUES ('taches', '{casse')")
    conn.commit()
    conn.close()
    assert base.lire_document("taches") == base.DOCUMENTS_DEFAUT["taches"]


# ------------------------------------------------------------------
# Contacts
# ------------------------------------------------------------------

def test_contact_cree_puis_modifie(base_temp):
    c = base.enregistrer_contact({"nom": "Labo", "tel_fixe": "01"})
    assert c["id"]
    base.enregistrer_contact({"id": c["id"], "nom": "Labo", "tel_fixe": "02"})
    contacts = base.lister_contacts()
    assert len(contacts) == 1 and contacts[0]["tel_fixe"] == "02"


def test_contact_sans_nom_refuse(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.enregistrer_contact({"email": "x@y.z"})


def test_contact_avec_id_inconnu_est_cree(base_temp):
    c = base.enregistrer_contact({"id": 999, "entreprise": "E"})
    contacts = base.lister_contacts()
    assert len(contacts) == 1 and contacts[0]["id"] == c["id"]


def test_suppression_contact(base_temp):
    c = base.enregistrer_contact({"prenom": "P"})
    base.supprimer_contact(c["id"])
    assert base.lister_contacts() == []


def test_remplacer_contacts_tolere_les_doublons_d_id(base_temp):
    n = base.remplacer_contacts([{"id": 1, "nom": "A"}, {"id": 1, "nom": "B"},
                                 "pas un contact", {"nom": "C"}])
    assert n == 3
    assert sorted(c["nom"] for c in base.lister_contacts()) == ["A", "B", "C"]


# ------------------------------------------------------------------
# Revision
# ------------------------------------------------------------------

def test_chaque_ecriture_change_la_revision(base_temp):
    r1 = base.revision()
    base.update_produit(produit())
    r2 = base.revision()
    base.ecrire_document("record_jeu", 12)
    r3 = base.revision()
    assert len({r1, r2, r3}) == 3


def test_lecture_ne_change_pas_la_revision(base_temp):
    r = base.revision()
    base.charger_base()
    base.lire_documents()
    assert base.revision() == r


def test_ecriture_en_echec_ne_change_pas_la_revision(base_temp):
    r = base.revision()
    with pytest.raises(base.ErreurDonnees):
        base.update_produit({})
    assert base.revision() == r


@pytest.mark.parametrize("valeur, attendu", [
    (None, 0.0), ("", 0.0), (3, 3.0), ("2,5", 2.5), (" 1 000 ", 1000.0), ("x", 0.0)])
def test_safe_float(valeur, attendu):
    assert base.safe_float(valeur) == attendu
