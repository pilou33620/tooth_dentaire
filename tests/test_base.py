# -*- coding: utf-8 -*-
"""Tests de la couche base de donnees (python/base.py)."""

import datetime
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


def test_produit_arrete_conserve_si_non_transmis(base_temp):
    base.update_produit(produit())
    assert base.charger_base()["produits"][0]["arrete"] == 0
    base.update_produit(dict(produit(), arrete=1))
    assert base.charger_base()["produits"][0]["arrete"] == 1
    # Un poste qui ne connait pas le champ (import de facture...) ne le remet pas a 0
    base.update_produit(produit(nom="Renomme"))
    assert base.charger_base()["produits"][0]["arrete"] == 1
    base.update_produit(dict(produit(), arrete=0))
    assert base.charger_base()["produits"][0]["arrete"] == 0


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


def test_documents_lus_ensemble_comme_un_par_un(base_temp):
    base.ecrire_document("planning", {"even": [{"assistant": "A"}], "odd": []})
    conn = sqlite3.connect(str(base_temp))
    conn.execute("INSERT INTO documents (cle, valeur) VALUES ('taches', '{casse')")
    conn.commit()
    conn.close()
    docs = base.lire_documents()
    assert docs == {cle: base.lire_document(cle) for cle in base.DOCUMENTS_DEFAUT}
    assert docs["planning"]["even"][0]["assistant"] == "A"
    assert docs["taches"] == base.DOCUMENTS_DEFAUT["taches"]


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
    (None, 0.0), ("", 0.0), (3, 3.0), ("2,5", 2.5), (" 1 000 ", 1000.0), ("x", 0.0),
    ("1e999", 0.0), (float("inf"), 0.0), ("nan", 0.0), (10 ** 400, 0.0)])
def test_safe_float(valeur, attendu):
    assert base.safe_float(valeur) == attendu


@pytest.mark.parametrize("valeur, attendu", [
    (None, 0), ("", 0), ("12", 12), (3.9, 3), ("x", 0), ("1e999", 0), (float("inf"), 0),
    ("nan", 0), (10 ** 30, 0), (2 ** 63 - 1, 2 ** 63 - 1), (-2 ** 63, -2 ** 63)])
def test_safe_int(valeur, attendu):
    assert base.safe_int(valeur) == attendu


def test_prix_hors_limites_ne_bloquent_pas_l_ecriture(base_temp):
    base.update_stock_item({"reference": "A", "utilisateur": "Reserve", "quantite": "x",
                            "prix_unitaire_ht": "1e999"})
    ligne = base.charger_base()["stock"][0]
    assert ligne["quantite"] == 0 and ligne["prix_unitaire_ht"] == 0


@pytest.mark.parametrize("champ, valeur", [
    ("quantite", "1e999"), ("quantite", 2 ** 53), ("stock_minimum", 10 ** 30),
    ("stock_minimum", -2 ** 53), ("delai_peremption", 1e16)])
def test_entiers_inexacts_en_javascript_refuses(base_temp, champ, valeur):
    # Le navigateur les arrondirait : refus plutot qu'une valeur fausse
    with pytest.raises(base.ErreurDonnees, match="trop grand"):
        base.update_stock_item(ligne_stock(**{champ: valeur}))
    assert base.charger_base()["stock"] == []


def test_plus_grand_entier_exact_accepte(base_temp):
    base.update_stock_item(ligne_stock(quantite=2 ** 53 - 1, stock_minimum=-(2 ** 53 - 1)))
    ligne = base.charger_base()["stock"][0]
    assert ligne["quantite"] == 2 ** 53 - 1 and ligne["stock_minimum"] == -(2 ** 53 - 1)


def test_quantite_de_transaction_trop_grande_refusee(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.add_transaction({"date": "d", "reference": "R", "utilisateur": "Commun",
                              "type_transaction": "SORTIE_STOCK", "quantite": -2 ** 60})
    assert base.charger_base()["transactions"] == []


@pytest.mark.parametrize("valeur, attendu", [
    (0, 1), ("", 1), (None, 1), ("abc", 1), (1, 1), (12, 12), ("24", 24), (100000, 100000)])
def test_quantite_par_carton_acceptee(base_temp, valeur, attendu):
    base.update_produit(produit(quantite_par_carton=valeur))
    assert base.charger_base()["produits"][0]["quantite_par_carton"] == attendu


@pytest.mark.parametrize("valeur", [100001, -3, 10 ** 30, "1e999"])
def test_quantite_par_carton_hors_bornes_refusee(base_temp, valeur):
    with pytest.raises(base.ErreurDonnees):
        base.update_produit(produit(quantite_par_carton=valeur))
    assert base.charger_base()["produits"] == []


@pytest.mark.parametrize("fonction, donnees", [
    ("update_produit", produit(nom={"a": 1})),
    ("update_produit", produit(reference=["REF1"])),
    ("update_stock_item", ligne_stock(fournisseur=["F"])),
    ("update_stock_item", ligne_stock(reference={"x": 1})),
    ("add_transaction", {"date": {}, "reference": "R", "utilisateur": "Commun",
                         "type_transaction": "SORTIE_STOCK", "quantite": 1}),
    ("add_autoclave", {"date": "d", "utilisateur": "P", "commentaire": ["c"]}),
    ("add_historique_prix", {"reference": "R", "date": "d", "fournisseur": {"nom": "F"}}),
    ("enregistrer_contact", {"nom": "Labo", "note": ["x"]}),
])
def test_objet_ou_liste_dans_un_champ_texte_refuse(base_temp, fonction, donnees):
    with pytest.raises(base.ErreurDonnees, match="texte attendu"):
        getattr(base, fonction)(donnees)


@pytest.mark.parametrize("lots", ["{}", "pas du json", '{"lot": "A"}', {"lot": "A"}, 12])
def test_lots_details_doit_etre_un_tableau(base_temp, lots):
    with pytest.raises(base.ErreurDonnees, match="lots_details"):
        base.update_stock_item(ligne_stock(lots_details=lots))


@pytest.mark.parametrize("lots", [None, "", "[]"])
def test_lots_details_vide_accepte(base_temp, lots):
    base.update_stock_item(ligne_stock(lots_details=lots))
    assert base.charger_base()["stock"][0]["lots_details"] == "[]"


def test_lots_details_texte_stocke_dans_la_base_toujours_tolere(base_temp):
    # _texte reste tolerant pour le JSON deja en base (_lots_quantifies)
    assert base._lots_quantifies("{casse", 3) == []
    assert base._lots_quantifies('{"lot": "A"}', 3) == []


# ------------------------------------------------------------------
# Lots d'ecritures et conflits entre postes
# ------------------------------------------------------------------

def _version(ref="REF1", espace="Commun"):
    return [s for s in base.charger_base()["stock"]
            if s["reference"] == ref and s["utilisateur"] == espace][0]["version"]


def test_version_incrementee_a_chaque_ecriture(base_temp):
    assert base.update_stock_item(ligne_stock())["version"] == 1
    assert base.update_stock_item(ligne_stock(quantite=4))["version"] == 2
    assert _version() == 2


def test_ecriture_sur_version_a_jour_acceptee(base_temp):
    base.update_stock_item(ligne_stock())
    base.update_stock_item(ligne_stock(quantite=3, version=1))
    assert _version() == 2


def test_ecriture_sur_version_perimee_refusee(base_temp):
    base.update_stock_item(ligne_stock())                       # v1
    base.update_stock_item(ligne_stock(quantite=8, version=1))  # poste A -> v2
    with pytest.raises(base.ErreurConflit):
        base.update_stock_item(ligne_stock(quantite=7, version=1))  # poste B, lu en v1
    stock = base.charger_base()["stock"][0]
    assert stock["quantite"] == 8 and stock["version"] == 2


def test_creation_d_une_ligne_deja_creee_ailleurs_refusee(base_temp):
    base.update_stock_item(ligne_stock(version=None))
    with pytest.raises(base.ErreurConflit):
        base.update_stock_item(ligne_stock(version=None))


def test_ligne_supprimee_ailleurs_refusee(base_temp):
    base.update_stock_item(ligne_stock())
    base.delete_stock_item("REF1", "Commun")
    with pytest.raises(base.ErreurConflit):
        base.update_stock_item(ligne_stock(version=1))


def test_ancien_poste_sans_version_non_controle(base_temp):
    base.update_stock_item(ligne_stock())
    base.update_stock_item(ligne_stock(quantite=1))
    assert _version() == 2


def test_lot_tout_ou_rien(base_temp):
    base.update_stock_item(ligne_stock())
    base.update_stock_item(ligne_stock(quantite=9))             # v2 ailleurs
    revision = base.revision()
    with pytest.raises(base.ErreurConflit):
        base.executer_lot([
            {"action": "addTransaction", "donnees": {"date": "2026-10-04", "reference": "REF1",
                                                     "utilisateur": "Commun",
                                                     "type_transaction": "SORTIE_STOCK",
                                                     "quantite": 2}},
            {"action": "updateStockItem", "donnees": ligne_stock(quantite=3, version=1)},
        ])
    # La transaction n'a pas ete gardee sans sa mise a jour de stock
    assert base.charger_base()["transactions"] == []
    assert base.revision() == revision


def test_lot_execute_et_resultats(base_temp):
    resultats = base.executer_lot([
        {"action": "updateProduit", "donnees": produit()},
        {"action": "updateStockItem", "donnees": ligne_stock(version=None)},
        {"action": "updateStockItem", "donnees": ligne_stock(quantite=2, version=None)},
        {"action": "addTransaction", "donnees": {"date": "d", "reference": "REF1",
                                                 "utilisateur": "Commun",
                                                 "type_transaction": "ENTREE", "quantite": 5}},
    ])
    assert resultats[1] == {"reference": "REF1", "utilisateur": "Commun", "version": 1}
    # Meme ligne deux fois dans le lot : controlee une seule fois
    assert resultats[2]["version"] == 2
    assert resultats[3]["id"] == 1
    base.executer_lot([{"action": "deleteStockItem",
                        "donnees": {"reference": "REF1", "utilisateur": "Commun"}},
                       {"action": "deleteProduit", "donnees": {"reference": "REF1"}}])
    assert base.charger_base()["produits"] == []


@pytest.mark.parametrize("operations", [None, [], "x", [{"action": "inconnue"}], ["x"]])
def test_lot_invalide_refuse(base_temp, operations):
    with pytest.raises(base.ErreurDonnees):
        base.executer_lot(operations)


# ------------------------------------------------------------------
# Produits perimes
# ------------------------------------------------------------------

def _jour(n):
    return (datetime.date.today() + datetime.timedelta(days=n)).strftime("%d/%m/%Y")


def _lots(*lots):
    return json.dumps([{"lot": l, "date": d, "qte": q} for l, d, q in lots])


def _maj(**autres):
    return {"action": "updateStockItem", "donnees": ligne_stock(**autres)}


@pytest.mark.parametrize("texte, attendu", [
    ("31/12/2026", datetime.date(2026, 12, 31)), ("2026-12-31", datetime.date(2026, 12, 31)),
    ("1/2/2027", datetime.date(2027, 2, 1)), ("", None), ("bientot", None), (None, None),
    ("5/3/2027", datetime.date(2027, 3, 5)), (" 05/03/2027 ", datetime.date(2027, 3, 5)),
    # JJ/MM/AA : an 2000 + AA
    ("05/03/27", datetime.date(2027, 3, 5)), ("5/3/27", datetime.date(2027, 3, 5)),
    # Mois seul : dernier jour du mois
    ("05/2024", datetime.date(2024, 5, 31)), ("2/2028", datetime.date(2028, 2, 29)),
    ("2027-02", datetime.date(2027, 2, 28)), ("2026-4", datetime.date(2026, 4, 30)),
    ("2026-1-5", datetime.date(2026, 1, 5)),
    # Dates impossibles ou formats refuses
    ("31/02/2027", None), ("2027-02-30", None), ("13/2027", None), ("2027-13", None),
    ("00/2027", None), ("0/0/27", None), ("05/03/027", None), ("2027/03/05", None),
    ("05-03-2027", None), ("5/3/2027 10:00", None), ("2027", None),
])
def test_date_peremption(texte, attendu):
    assert base.date_peremption(texte) == attendu


def test_entree_datee_d_un_mois_passe_refusee(base_temp):
    with pytest.raises(base.ErreurDonnees, match="périmé le 05/2024"):
        base.update_stock_item(ligne_stock(quantite=3, date_peremption="05/2024"))
    with pytest.raises(base.ErreurDonnees, match="périmé"):
        base.update_stock_item(ligne_stock(quantite=3, lots_details=_lots(("L", "05/2024", 3))))
    assert base.charger_base()["stock"] == []


def test_entree_datee_du_mois_en_cours_acceptee(base_temp):
    mois = datetime.date.today().strftime("%m/%Y")
    base.update_stock_item(ligne_stock(quantite=3, date_peremption=mois))


def test_entree_d_un_lot_perime_refusee(base_temp):
    with pytest.raises(base.ErreurDonnees, match="périmé"):
        base.update_stock_item(ligne_stock(quantite=3, lots_details=_lots(("V", _jour(-1), 3))))
    assert base.charger_base()["stock"] == []


def test_entree_d_un_lot_du_jour_acceptee(base_temp):
    base.update_stock_item(ligne_stock(quantite=3, lots_details=_lots(("A", _jour(0), 3))))


def test_stock_deja_perime_reste_modifiable(base_temp):
    base.update_stock_item(ligne_stock(quantite=3, lots_details=_lots(("V", _jour(5), 3))))
    # Le lot a perime depuis : on simule en recrivant la date directement
    conn = sqlite3.connect(str(base_temp))
    conn.execute("UPDATE stock SET lots_details = ?", (_lots(("V", _jour(-2), 3)),))
    conn.commit()
    conn.close()
    base.update_stock_item(ligne_stock(quantite=2, stock_minimum=9,
                                       lots_details=_lots(("V", _jour(-2), 2))))
    with pytest.raises(base.ErreurDonnees):
        base.update_stock_item(ligne_stock(quantite=5, lots_details=_lots(("V", _jour(-2), 5))))


def test_lot_sans_quantite_qui_recoit_le_reste(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.update_stock_item(ligne_stock(quantite=5, lots_details=json.dumps(
            [{"lot": "A", "date": _jour(9), "qte": 2}, {"lot": "V", "date": _jour(-9)}])))


def test_ligne_sans_detail_par_lot(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.update_stock_item(ligne_stock(quantite=5, date_peremption=_jour(-3)))
    base.update_stock_item(ligne_stock(quantite=5, date_peremption=_jour(30)))


def test_transfert_d_un_lot_perime_accepte(base_temp):
    vieux = ("V", _jour(-4), 4)
    conn = sqlite3.connect(str(base_temp))
    conn.execute("INSERT INTO stock (reference, utilisateur, quantite, lots_details)"
                 " VALUES ('REF1', 'Reserve', 4, ?)", (_lots(vieux),))
    conn.commit()
    conn.close()
    base.executer_lot([
        _maj(espace="Reserve", quantite=0, lots_details="[]"),
        _maj(espace="Salle 1", quantite=4, lots_details=_lots(vieux)),
    ])
    # ... mais pas une entree qui en ajoute au passage
    with pytest.raises(base.ErreurDonnees):
        base.executer_lot([_maj(espace="Salle 1", quantite=6,
                                lots_details=_lots(("V", vieux[1], 6)))])


def test_lot_refuse_ne_garde_rien(base_temp):
    with pytest.raises(base.ErreurDonnees):
        base.executer_lot([
            {"action": "addTransaction", "donnees": {"date": "d", "reference": "REF1",
                                                     "utilisateur": "Commun",
                                                     "type_transaction": "ENTREE_LOT",
                                                     "quantite": 2}},
            _maj(quantite=2, lots_details=_lots(("V", _jour(-1), 2))),
        ])
    assert base.charger_base()["transactions"] == []


# ------------------------------------------------------------------
# Versions et validation des documents
# ------------------------------------------------------------------

def test_document_facture_importees_par_defaut(base_temp):
    assert base.lire_document("factures_importees") == {"empreintes": []}


def test_version_de_document_incrementee(base_temp):
    assert base.lire_document_et_version("notes") == {"valeur": {"items": []}, "version": 0}
    assert base.ecrire_document("notes", {"items": ["a"]}) == 1
    assert base.ecrire_document("notes", {"items": ["b"]}, version_attendue=1) == 2
    assert base.lire_document_et_version("notes") == {"valeur": {"items": ["b"]}, "version": 2}
    docs, versions = base.lire_documents_et_versions()
    assert set(versions) == set(base.DOCUMENTS_DEFAUT)
    assert versions["notes"] == 2 and versions["planning"] == 0
    assert docs["notes"] == {"items": ["b"]}


def test_document_modifie_ailleurs_refuse(base_temp):
    base.ecrire_document("notes", {"items": ["poste A"]})
    base.ecrire_document("notes", {"items": ["poste B"]}, version_attendue=1)
    r = base.revision()
    with pytest.raises(base.ErreurConflit) as erreur:
        base.ecrire_document("notes", {"items": ["poste A encore"]}, version_attendue=1)
    assert erreur.value.version == 2 and "autre poste" in str(erreur.value)
    assert base.lire_document("notes") == {"items": ["poste B"]}
    assert base.revision() == r


def test_document_jamais_ecrit_attendu_en_version_0(base_temp):
    with pytest.raises(base.ErreurConflit):
        base.ecrire_document("taches", {"rows": []}, version_attendue=3)
    assert base.ecrire_document("taches", {"rows": []}, version_attendue=0) == 1


def test_ancienne_table_documents_completee(tmp_path):
    chemin = tmp_path / "ancienne.db"
    conn = sqlite3.connect(str(chemin))
    conn.execute("CREATE TABLE documents (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL,"
                 " modifie_le TEXT)")
    conn.execute("""INSERT INTO documents (cle, valeur) VALUES ('notes', '{"items": [1]}')""")
    conn.commit()
    conn.close()
    base.definir_chemin(str(chemin))
    assert base.lire_document_et_version("notes") == {"valeur": {"items": [1]}, "version": 0}
    assert base.ecrire_document("notes", {"items": []}, version_attendue=0) == 1


@pytest.mark.parametrize("cle, valeur", [
    ("record_jeu", 0), ("record_jeu", 12), ("record_jeu", 3.5),
    ("planning", {"even": [], "odd": []}), ("planning", {}),
    ("notes", {"items": [{"texte": "x"}]}), ("minuteurs", {"actifs": [], "preselections": []}),
    ("checklist", {"modele": [], "jour": "", "fait": {}}), ("dosimetres", {"dosimetres": []}),
    ("taches", {"rows": []}), ("rappels_mire", {}), ("rappel_dosimetres", {"nextTime": None}),
    ("factures_importees", {"empreintes": ["abc"]}),
])
def test_document_valide_accepte(base_temp, cle, valeur):
    base.ecrire_document(cle, valeur)
    assert base.lire_document(cle) == valeur


@pytest.mark.parametrize("cle, valeur", [
    ("record_jeu", -1), ("record_jeu", True), ("record_jeu", "12"), ("record_jeu", None),
    ("record_jeu", {}), ("record_jeu", float("inf")), ("record_jeu", float("nan")),
    ("planning", []), ("planning", {"even": {}, "odd": []}), ("planning", {"even": [], "odd": None}),
    ("notes", {"items": "x"}), ("minuteurs", {"actifs": {}}), ("minuteurs", {"preselections": 1}),
    ("checklist", {"modele": "x"}), ("dosimetres", {"dosimetres": {}}), ("taches", {"rows": None}),
    ("rappels_mire", []), ("meteo_lieu", "Bordeaux"), ("positions_interface", None),
    ("notes", {"items": [], "x": float("nan")}),
])
def test_document_au_mauvais_format_refuse(base_temp, cle, valeur):
    with pytest.raises(base.ErreurDonnees, match="Format invalide pour le document « %s »" % cle):
        base.ecrire_document(cle, valeur)
    assert not base.document_present(cle)


def test_document_trop_volumineux_refuse(base_temp):
    with pytest.raises(base.ErreurDonnees, match="trop volumineux"):
        base.ecrire_document("notes", {"items": ["é" * (1024 * 1024 + 10)]})
    base.ecrire_document("notes", {"items": ["x" * (1024 * 1024)]})


# ------------------------------------------------------------------
# Reponse /api/etat allegee
# ------------------------------------------------------------------

def _tx(date, quantite=1):
    return {"date": date, "reference": "R", "utilisateur": "Commun",
            "type_transaction": "SORTIE_STOCK", "quantite": quantite}


def test_charger_base_limite_aux_derniers_jours(base_temp):
    recent = (datetime.date.today() - datetime.timedelta(days=10)).isoformat() + "T10:00:00Z"
    limite = (datetime.date.today() - datetime.timedelta(days=400)).isoformat()
    vieux = (datetime.date.today() - datetime.timedelta(days=401)).isoformat()
    for date in (vieux + "T08:00:00Z", recent, "date illisible", limite, vieux):
        base.add_transaction(_tx(date))
    base.add_historique_prix({"reference": "R", "date": vieux, "prix_ht": 1})
    base.add_historique_prix({"reference": "R", "date": recent, "prix_ht": 2})
    complet = base.charger_base()
    assert len(complet["transactions"]) == 5 and len(complet["historique_prix"]) == 2
    leger = base.charger_base(jours_transactions=400)
    assert [t["date"] for t in leger["transactions"]] == [recent, "date illisible", limite]
    assert [h["prix_ht"] for h in leger["historique_prix"]] == [2]
    # Identifiants suivants calcules sur toute la table
    assert leger["nextTxId"] == complet["nextTxId"] == complet["transactions"][-1]["id"] + 1


def test_identifiant_suivant_apres_la_derniere_transaction_filtree(base_temp):
    vieux = (datetime.date.today() - datetime.timedelta(days=900)).isoformat()
    ident = base.add_transaction(_tx(vieux))
    leger = base.charger_base(jours_transactions=400)
    assert leger["transactions"] == [] and leger["nextTxId"] == ident + 1


# ------------------------------------------------------------------
# Changement de base et migrations de schema
# ------------------------------------------------------------------

def test_fichier_non_sqlite_ne_remplace_pas_la_base(base_temp, tmp_path):
    base.update_produit(produit())
    faux = tmp_path / "faux.db"
    faux.write_bytes(b"ceci n'est pas une base SQLite, juste du texte" * 10)
    with pytest.raises(sqlite3.DatabaseError):
        base.definir_chemin(str(faux))
    assert base.CHEMIN_BASE == str(base_temp)
    assert base.charger_base()["produits"][0]["reference"] == "REF1"


def test_ajout_de_colonne_ne_masque_que_les_doublons(base_temp):
    conn = sqlite3.connect(str(base_temp))
    try:
        cur = conn.cursor()
        base._ajouter_colonne(cur, "produits", "nom TEXT DEFAULT ''")        # deja presente
        with pytest.raises(sqlite3.OperationalError, match="no such table"):
            base._ajouter_colonne(cur, "table_absente", "x TEXT")
    finally:
        conn.close()
