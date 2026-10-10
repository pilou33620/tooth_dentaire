# -*- coding: utf-8 -*-
"""Tests du serveur HTTP (serveur.py) : API, fichiers statiques, securite."""

import base64
import datetime
import gzip
import http.client
import io
import json
import os
import socket
import threading
import time

import openpyxl
import pytest

import base
import serveur
from conftest import produit, ligne_stock


@pytest.fixture
def srv(base_temp):
    httpd = serveur.ServeurThreade(("127.0.0.1", 0), serveur.CustomHandler)
    serveur.CustomHandler.ECOUTE_LOCALE = True
    fil = threading.Thread(target=httpd.serve_forever, daemon=True)
    fil.start()
    yield httpd.server_address[1]
    httpd.shutdown()
    httpd.server_close()


def requete(port, methode, chemin, corps=None, entetes=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"Host": "127.0.0.1:%d" % port}
    h.update(entetes or {})
    donnees = None
    if corps is not None:
        donnees = json.dumps(corps).encode("utf-8")
        h["Content-Type"] = "application/json"
    conn.request(methode, chemin, body=donnees, headers=h)
    rep = conn.getresponse()
    brut = rep.read()
    conn.close()
    try:
        return rep.status, json.loads(brut.decode("utf-8")), rep
    except ValueError:
        return rep.status, brut, rep


# ------------------------------------------------------------------
# Fichiers statiques
# ------------------------------------------------------------------

def test_page_d_accueil_servie(srv):
    code, corps, rep = requete(srv, "GET", "/")
    assert code == 200 and b"<!DOCTYPE html>" in corps
    assert "no-store" in rep.getheader("Cache-Control")


def test_javascript_servi_en_module(srv):
    code, _, rep = requete(srv, "GET", "/js/main-init.js")
    assert code == 200 and rep.getheader("Content-Type").startswith("application/javascript")


@pytest.mark.parametrize("chemin", [
    "/../serveur.py", "/%2e%2e/serveur.py", "/../donnees/stock.db",
    "/..%2f..%2fserveur.py", "/js/../../python/base.py"])
def test_rien_n_est_servi_hors_du_dossier_web(srv, chemin):
    code, corps, _ = requete(srv, "GET", chemin)
    assert code == 404
    assert b"sqlite" not in (corps if isinstance(corps, bytes) else b"").lower()


def test_pas_de_listage_de_dossier(srv):
    code, _, _ = requete(srv, "GET", "/js/")
    assert code == 404


def test_host_inconnu_refuse(srv):
    code, _, _ = requete(srv, "GET", "/api/revision", entetes={"Host": "attaquant.example"})
    assert code == 403


# ------------------------------------------------------------------
# API
# ------------------------------------------------------------------

def test_etat_complet(srv):
    base.update_produit(produit())
    code, data, _ = requete(srv, "GET", "/api/etat")
    assert code == 200 and data["status"] == "ok"
    assert data["base"]["produits"][0]["reference"] == "REF1"
    assert set(data["documents"]) == set(base.DOCUMENTS_DEFAUT)
    assert data["revision"] == base.revision()


def test_ecriture_stock_puis_lecture(srv):
    code, data, _ = requete(srv, "POST", "/api/stock", ligne_stock(quantite=7))
    assert code == 200 and data["status"] == "ok"
    assert base.charger_base()["stock"][0]["quantite"] == 7


def test_ecriture_change_la_revision(srv):
    _, avant, _ = requete(srv, "GET", "/api/revision")
    _, data, _ = requete(srv, "POST", "/api/produit", produit())
    assert data["revision"] != avant["revision"]


def test_transaction_renvoie_son_identifiant(srv):
    _, data, _ = requete(srv, "POST", "/api/transaction", {
        "date": "d", "reference": "R", "utilisateur": "Commun",
        "type_transaction": "SORTIE_STOCK", "quantite": 1})
    assert data["id"] == base.charger_base()["transactions"][0]["id"]


def test_suppression_produit(srv):
    base.update_produit(produit("A B"))
    base.update_stock_item(ligne_stock("A B"))
    code, _, _ = requete(srv, "DELETE", "/api/produit?reference=A%20B")
    assert code == 200 and base.charger_base()["produits"] == []


def test_suppression_ligne_de_stock(srv):
    base.update_stock_item(ligne_stock(espace="Salle de chir"))
    requete(srv, "DELETE", "/api/stock?reference=REF1&utilisateur=Salle%20de%20chir")
    assert base.charger_base()["stock"] == []


def test_documents(srv):
    code, _, _ = requete(srv, "PUT", "/api/documents/taches", {"rows": [{"task": "T"}]})
    assert code == 200
    _, data, _ = requete(srv, "GET", "/api/documents/taches")
    assert data["valeur"]["rows"][0]["task"] == "T"


def test_document_inconnu_400(srv):
    code, data, _ = requete(srv, "PUT", "/api/documents/inconnu", {})
    assert code == 400 and data["status"] == "error"


def test_contacts(srv):
    _, data, _ = requete(srv, "POST", "/api/contacts", {"nom": "Labo"})
    ident = data["contact"]["id"]
    _, liste, _ = requete(srv, "GET", "/api/contacts")
    assert [c["nom"] for c in liste["contacts"]] == ["Labo"]
    requete(srv, "DELETE", "/api/contacts?id=%d" % ident)
    assert base.lister_contacts() == []


def test_donnees_invalides_400(srv):
    code, data, _ = requete(srv, "POST", "/api/produit", {"nom": "sans reference"})
    assert code == 400 and "obligatoire" in data["message"]


def test_json_invalide_400(srv):
    conn = http.client.HTTPConnection("127.0.0.1", srv, timeout=10)
    conn.request("POST", "/api/stock", body=b"{pas du json",
                 headers={"Host": "127.0.0.1", "Content-Type": "application/json"})
    rep = conn.getresponse()
    assert rep.status == 400
    conn.close()


@pytest.mark.parametrize("corps", [
    b'{"items": [], "x": NaN}', b'{"items": [], "x": Infinity}', b'{"items": [], "x": -Infinity}',
    b'{"items": [], "x": 1e999}'])
def test_nombres_non_finis_refuses(srv, corps):
    # Enregistrés, ils rendraient /api/etat illisible pour les navigateurs
    conn = http.client.HTTPConnection("127.0.0.1", srv, timeout=10)
    conn.request("PUT", "/api/documents/notes", body=corps,
                 headers={"Host": "127.0.0.1", "Content-Type": "application/json"})
    rep = conn.getresponse()
    assert rep.status == 400
    conn.close()
    code, data, rep = requete(srv, "GET", "/api/etat")
    assert code == 200 and isinstance(data, dict)


def test_route_inconnue_404(srv):
    assert requete(srv, "GET", "/api/rien")[0] == 404
    assert requete(srv, "POST", "/api/rien", {})[0] == 404


def test_info_version(srv):
    _, data, _ = requete(srv, "GET", "/api/info")
    assert data["version"] == serveur.VERSION
    assert data["adresses_reseau"] == []        # ecoute locale dans les tests


# ------------------------------------------------------------------
# CSRF : origine des requetes qui modifient les donnees
# ------------------------------------------------------------------

@pytest.mark.parametrize("origine", ["https://attaquant.example", "http://evil.com:8150"])
def test_origine_externe_refusee(srv, origine):
    code, _, _ = requete(srv, "POST", "/api/produit", produit(), {"Origin": origine})
    assert code == 403
    assert base.charger_base()["produits"] == []


@pytest.mark.parametrize("origine", [
    "http://127.0.0.1:8150", "http://localhost:8150", "http://192.168.1.20:8150",
    "http://10.0.0.5:8150", "http://172.16.3.4:8150"])
def test_origine_du_reseau_local_acceptee(srv, origine):
    code, _, _ = requete(srv, "POST", "/api/produit", produit(), {"Origin": origine})
    assert code == 200


# ------------------------------------------------------------------
# Exports
# ------------------------------------------------------------------

def test_export_stock_en_base64(srv):
    base.update_produit(produit())
    base.update_stock_item(ligne_stock())
    _, data, _ = requete(srv, "POST", "/api/export/stock", {})
    assert data["status"] == "Succès" and data["nom_fichier"] == "Export_Stock.xlsx"
    wb = openpyxl.load_workbook(io.BytesIO(base64.b64decode(data["contenu_base64"])))
    assert "Commun" in wb.sheetnames


def test_export_chirurgie_sans_donnee(srv):
    _, data, _ = requete(srv, "POST", "/api/export/chirurgie",
                         {"date_debut": "2026-01-01", "date_fin": "2026-01-31"})
    assert "Aucun article" in data["status"] and "contenu_base64" not in data


def test_export_indisponible_503(srv, monkeypatch):
    import exports
    monkeypatch.setattr(exports, "openpyxl", None)
    code, data, _ = requete(srv, "POST", "/api/export/stock", {})
    assert code == 503 and "openpyxl" in data["message"]


# ------------------------------------------------------------------
# Changement de base
# ------------------------------------------------------------------

def test_changer_de_base(srv, tmp_path, monkeypatch):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    autre = tmp_path / "autre.db"
    autre.write_bytes(b"")
    code, data, _ = requete(srv, "POST", "/api/base", {"chemin": str(autre)})
    assert code == 200 and data["chemin"] == str(autre)
    assert base.CHEMIN_BASE == str(autre)
    assert json.loads((tmp_path / "config.json").read_text(encoding="utf-8"))["base"] == str(autre)


def test_changer_de_base_fichier_introuvable(srv, tmp_path):
    code, data, _ = requete(srv, "POST", "/api/base", {"chemin": str(tmp_path / "absent.db")})
    assert code == 400 and "introuvable" in data["message"]


def test_changer_de_base_refuse_depuis_un_autre_poste(srv, monkeypatch, tmp_path):
    monkeypatch.setattr(serveur.CustomHandler, "_client_local", lambda self: False)
    code, data, _ = requete(srv, "POST", "/api/base", {"chemin": str(tmp_path)})
    assert code == 400 and "poste" in data["message"]
    _, info, _ = requete(srv, "GET", "/api/base")
    assert info["modifiable"] is False


def test_chemin_configure(tmp_path, monkeypatch):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    assert serveur.chemin_base_configure() == serveur.BASE_DEFAUT
    existant = tmp_path / "x.db"
    existant.write_bytes(b"")
    serveur.enregistrer_config({"base": str(existant)})
    assert serveur.chemin_base_configure() == str(existant)
    serveur.enregistrer_config({"base": str(tmp_path / "disparu.db")})
    assert serveur.chemin_base_configure() == serveur.BASE_DEFAUT


# ------------------------------------------------------------------
# Sauvegardes
# ------------------------------------------------------------------

def test_sauvegarde_depuis_les_reglages(srv):
    code, corps, _ = requete(srv, "GET", "/api/sauvegardes")
    assert code == 200 and corps["derniere"] is None and corps["nombre"] == 0
    code, corps, _ = requete(srv, "POST", "/api/sauvegardes", {})
    assert code == 200 and corps["sauvegarde"]["nom"].startswith("stock-")
    assert "chemin" not in corps["sauvegarde"]
    code, corps, _ = requete(srv, "GET", "/api/sauvegardes")
    assert corps["nombre"] == 1 and corps["dossier"].endswith("sauvegardes")


# ------------------------------------------------------------------
# Lots d'ecritures
# ------------------------------------------------------------------

def test_lot_enregistre(srv):
    code, corps, _ = requete(srv, "POST", "/api/lot", {"operations": [
        {"action": "updateProduit", "donnees": produit()},
        {"action": "updateStockItem", "donnees": ligne_stock(version=None)},
    ]})
    assert code == 200 and corps["resultats"][1]["version"] == 1


def test_lot_en_conflit_repond_409(srv):
    requete(srv, "POST", "/api/lot", {"operations": [
        {"action": "updateStockItem", "donnees": ligne_stock(version=None)}]})
    code, corps, _ = requete(srv, "POST", "/api/lot", {"operations": [
        {"action": "updateStockItem", "donnees": ligne_stock(version=None)}]})
    assert code == 409 and corps["conflit"] is True and "autre poste" in corps["message"]


# ------------------------------------------------------------------
# Versions des documents (conflits entre postes)
# ------------------------------------------------------------------

def test_etat_donne_les_versions_des_documents_et_l_heure(srv):
    base.ecrire_document("notes", {"items": ["x"]})
    avant = int(time.time() * 1000)
    _, data, _ = requete(srv, "GET", "/api/etat")
    assert data["versions_documents"] == dict(
        {cle: 0 for cle in base.DOCUMENTS_DEFAUT}, notes=1)
    assert data["documents"]["factures_importees"] == {"empreintes": []}
    assert isinstance(data["heure"], int) and abs(data["heure"] - avant) < 60000


def test_revision_donne_l_heure_du_serveur(srv):
    _, data, _ = requete(srv, "GET", "/api/revision")
    assert data["revision"] == base.revision()
    assert isinstance(data["heure"], int) and abs(data["heure"] - time.time() * 1000) < 60000


def test_document_lu_avec_sa_version(srv):
    _, data, _ = requete(srv, "GET", "/api/documents/notes")
    assert data["valeur"] == {"items": []} and data["version"] == 0
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["a"]})
    assert code == 200 and data["version"] == 1
    _, data, _ = requete(srv, "GET", "/api/documents/notes")
    assert data["valeur"] == {"items": ["a"]} and data["version"] == 1


def test_document_ecrit_sur_la_version_lue(srv):
    requete(srv, "PUT", "/api/documents/notes", {"items": ["a"]})
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["b"]},
                            {"X-Version-Document": "1"})
    assert code == 200 and data["version"] == 2
    assert base.lire_document("notes") == {"items": ["b"]}


def test_document_modifie_depuis_un_autre_poste_409(srv):
    requete(srv, "PUT", "/api/documents/notes", {"items": ["poste A"]})
    requete(srv, "PUT", "/api/documents/notes", {"items": ["poste B"]})
    _, avant, _ = requete(srv, "GET", "/api/revision")
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["perdu"]},
                            {"X-Version-Document": "1"})
    assert code == 409
    assert data == {"status": "error", "conflit": True,
                    "message": "Ce document vient d'être modifié depuis un autre poste.",
                    "version": 2}
    assert base.lire_document("notes") == {"items": ["poste B"]}
    assert requete(srv, "GET", "/api/revision")[1]["revision"] == avant["revision"]


def test_document_sans_en_tete_de_version_ecrit_sans_controle(srv):
    base.ecrire_document("notes", {"items": ["a"]})
    base.ecrire_document("notes", {"items": ["b"]})
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["ancien poste"]})
    assert code == 200 and data["version"] == 3


@pytest.mark.parametrize("valeur", ["", "abc", "1.0", "1_0", "0x1", "99999999999999999999"])
def test_en_tete_de_version_invalide_400(srv, valeur):
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["x"]},
                            {"X-Version-Document": valeur})
    assert code == 400 and "X-Version-Document" in data["message"]
    assert not base.document_present("notes")


def test_document_au_mauvais_format_400(srv):
    code, data, _ = requete(srv, "PUT", "/api/documents/planning", {"even": "x", "odd": []})
    assert code == 400 and data["message"] == "Format invalide pour le document « planning »."
    code, data, _ = requete(srv, "PUT", "/api/documents/record_jeu", "12")
    assert code == 400
    code, data, _ = requete(srv, "PUT", "/api/documents/record_jeu", 12)
    assert code == 200 and base.lire_document("record_jeu") == 12


def test_document_trop_volumineux_400(srv):
    code, data, _ = requete(srv, "PUT", "/api/documents/notes", {"items": ["x" * (3 * 1024 * 1024)]})
    assert code == 400 and "trop volumineux" in data["message"]


def test_corps_de_plus_de_5_mo_refuse_sans_le_lire(srv):
    conn = http.client.HTTPConnection("127.0.0.1", srv, timeout=10)
    conn.putrequest("PUT", "/api/documents/notes", skip_host=True)
    conn.putheader("Host", "127.0.0.1")
    conn.putheader("Content-Length", str(serveur.TAILLE_MAX_CORPS + 1))
    conn.endheaders()
    rep = conn.getresponse()
    assert rep.status == 400 and "volumineuse" in json.loads(rep.read())["message"]
    conn.close()
    assert serveur.TAILLE_MAX_CORPS == 5 * 1024 * 1024


# ------------------------------------------------------------------
# Reponse /api/etat : transactions recentes et compression
# ------------------------------------------------------------------

def test_etat_limite_aux_transactions_recentes(srv):
    vieux = (datetime.date.today() - datetime.timedelta(days=500)).isoformat() + "T08:00:00Z"
    recent = datetime.date.today().isoformat() + "T08:00:00Z"
    for date in (recent, vieux):
        base.add_transaction({"date": date, "reference": "R", "utilisateur": "Commun",
                              "type_transaction": "SORTIE_STOCK", "quantite": 1})
    _, data, _ = requete(srv, "GET", "/api/etat")
    assert [t["date"] for t in data["base"]["transactions"]] == [recent]
    assert data["base"]["nextTxId"] == 3
    assert len(base.charger_base()["transactions"]) == 2         # exports : tout


def test_reponse_json_compressee_si_le_navigateur_l_accepte(srv):
    for i in range(50):
        base.update_produit(produit("REF%d" % i))
    conn = http.client.HTTPConnection("127.0.0.1", srv, timeout=10)
    conn.request("GET", "/api/etat", headers={"Host": "127.0.0.1",
                                               "Accept-Encoding": "gzip, deflate, br"})
    rep = conn.getresponse()
    brut = rep.read()
    conn.close()
    assert rep.getheader("Content-Encoding") == "gzip"
    assert rep.getheader("Vary") == "Accept-Encoding"
    assert int(rep.getheader("Content-Length")) == len(brut)
    data = json.loads(gzip.decompress(brut).decode("utf-8"))
    assert len(data["base"]["produits"]) == 50
    # Sans Accept-Encoding : JSON en clair
    code, data, rep = requete(srv, "GET", "/api/etat")
    assert rep.getheader("Content-Encoding") is None and len(data["base"]["produits"]) == 50


def test_petite_reponse_non_compressee(srv):
    code, data, rep = requete(srv, "GET", "/api/revision", entetes={"Accept-Encoding": "gzip"})
    assert code == 200 and rep.getheader("Content-Encoding") is None and data["revision"]


# ------------------------------------------------------------------
# Mises a jour : installation depuis le poste serveur seulement
# ------------------------------------------------------------------

def test_installation_refusee_depuis_un_autre_poste(srv, monkeypatch):
    import mise_a_jour
    monkeypatch.setattr(serveur.CustomHandler, "_client_local", lambda self: False)
    monkeypatch.setattr(mise_a_jour, "installer", lambda: pytest.fail("installation lancee"))
    code, data, _ = requete(srv, "POST", "/api/mise-a-jour/installer", {})
    assert code == 403
    assert data == {"status": "error", "message":
                    "La mise à jour se lance depuis le poste qui fait tourner le serveur."}
    _, etat, _ = requete(srv, "GET", "/api/mise-a-jour")
    assert etat["installable_ici"] is False


def test_installation_permise_depuis_le_poste_serveur(srv, monkeypatch):
    import mise_a_jour
    appels = []

    def installer():
        appels.append(1)
        raise mise_a_jour.MiseAJourImpossible("L'outil est déjà à jour.")
    monkeypatch.setattr(mise_a_jour, "installer", installer)
    code, data, _ = requete(srv, "POST", "/api/mise-a-jour/installer", {})
    assert code == 409 and appels == [1]
    _, etat, _ = requete(srv, "GET", "/api/mise-a-jour")
    assert etat["installable_ici"] is True


def test_verification_limitee_a_une_par_minute(srv, monkeypatch):
    import mise_a_jour
    appels = []

    def verifier():
        appels.append(1)
        mise_a_jour._maj_etat(verifie_le=time.time())
        return mise_a_jour.etat()
    monkeypatch.setattr(mise_a_jour, "verifier", verifier)
    monkeypatch.setitem(mise_a_jour._etat, "verifie_le", time.time() - 120)
    code, data, _ = requete(srv, "POST", "/api/mise-a-jour/verifier", {})
    assert code == 200 and appels == [1] and "disponible" in data
    # Depuis un autre poste, juste apres : etat courant, sans git
    monkeypatch.setattr(serveur.CustomHandler, "_client_local", lambda self: False)
    code, data, _ = requete(srv, "POST", "/api/mise-a-jour/verifier", {})
    assert code == 200 and appels == [1] and data["verifie_le"] is not None
    monkeypatch.setitem(mise_a_jour._etat, "verifie_le", time.time() - 61)
    requete(srv, "POST", "/api/mise-a-jour/verifier", {})
    assert appels == [1, 1]


# ------------------------------------------------------------------
# Sauvegarde manuelle : une par minute
# ------------------------------------------------------------------

def test_sauvegarde_manuelle_limitee_a_une_par_minute(srv):
    _, premiere, _ = requete(srv, "POST", "/api/sauvegardes", {})
    assert premiere["deja_faite"] is False
    code, seconde, _ = requete(srv, "POST", "/api/sauvegardes", {})
    assert code == 200 and seconde["deja_faite"] is True
    assert seconde["sauvegarde"]["nom"] == premiere["sauvegarde"]["nom"]
    assert "chemin" not in seconde["sauvegarde"]
    assert requete(srv, "GET", "/api/sauvegardes")[1]["nombre"] == 1


# ------------------------------------------------------------------
# Base configuree introuvable, changement de base
# ------------------------------------------------------------------

def test_base_configuree_absente_signalee(srv, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    monkeypatch.setattr(serveur, "BASE_CONFIGUREE_ABSENTE", None)
    _, data, _ = requete(srv, "GET", "/api/base")
    assert data["base_configuree_absente"] is None
    disparu = str(tmp_path / "lecteur-reseau" / "stock.db")
    serveur.enregistrer_config({"base": disparu})
    assert serveur.chemin_base_configure() == serveur.BASE_DEFAUT
    assert "[!] La base choisie dans les Reglages est introuvable : %s" % disparu \
        in capsys.readouterr().out
    _, data, _ = requete(srv, "GET", "/api/base")
    assert data["base_configuree_absente"] == disparu
    # Une base choisie ensuite dans les Reglages efface l'alerte
    autre = tmp_path / "autre.db"
    autre.write_bytes(b"")
    requete(srv, "POST", "/api/base", {"chemin": str(autre)})
    assert requete(srv, "GET", "/api/base")[1]["base_configuree_absente"] is None


def test_chemin_configure_non_texte_ignore(tmp_path, monkeypatch):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    monkeypatch.setattr(serveur, "BASE_CONFIGUREE_ABSENTE", None)
    serveur.enregistrer_config({"base": 0})              # 0 : descripteur de fichier !
    assert serveur.chemin_base_configure() == serveur.BASE_DEFAUT


@pytest.mark.parametrize("contenu", [
    b"pas une base", b"<html>page web</html>" * 100,
    b"SQLite format 3\x00" + b"\xff" * 2000])
def test_changer_pour_un_fichier_qui_n_est_pas_une_base(srv, tmp_path, monkeypatch, contenu):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    base.update_produit(produit())
    avant = base.CHEMIN_BASE
    faux = tmp_path / "faux.db"
    faux.write_bytes(contenu)
    code, data, _ = requete(srv, "POST", "/api/base", {"chemin": str(faux)})
    assert code == 400 and "n'est pas une base SQLite" in data["message"]
    assert base.CHEMIN_BASE == avant
    assert not (tmp_path / "config.json").exists()
    # Le serveur continue de fonctionner sur l'ancienne base
    _, etat, _ = requete(srv, "GET", "/api/etat")
    assert etat["base"]["produits"][0]["reference"] == "REF1"


def test_enregistrer_config_atomique(tmp_path, monkeypatch):
    chemin = tmp_path / "config.json"
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(chemin))
    serveur.enregistrer_config({"base": "a.db"})
    assert json.loads(chemin.read_text(encoding="utf-8")) == {"base": "a.db"}

    def coupure(*args, **kwargs):
        raise OSError("disque plein")
    monkeypatch.setattr(serveur.json, "dump", coupure)
    with pytest.raises(OSError):
        serveur.enregistrer_config({"base": "b.db"})
    assert json.loads(chemin.read_text(encoding="utf-8")) == {"base": "a.db"}
    assert os.listdir(str(tmp_path)) == ["config.json"]


# ------------------------------------------------------------------
# Robustesse : erreurs, delais, journal, Host
# ------------------------------------------------------------------

def test_erreur_interne_sans_detail(srv, monkeypatch):
    def panne(*args, **kwargs):
        raise RuntimeError("C:\\secret\\stock.db : detail interne")
    monkeypatch.setattr(base, "lire_documents_et_versions", panne)
    code, data, _ = requete(srv, "GET", "/api/etat")
    assert code == 500
    assert data["message"] == \
        "Erreur interne du serveur (détail dans la console du poste serveur)."


def test_client_qui_n_envoie_pas_son_corps(srv, monkeypatch):
    assert serveur.CustomHandler.timeout == 30
    monkeypatch.setattr(serveur.CustomHandler, "timeout", 0.5)
    sock = socket.create_connection(("127.0.0.1", srv), timeout=10)
    try:
        sock.sendall(b"PUT /api/documents/notes HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     b"Content-Length: 100\r\n\r\n{")
        debut = time.time()
        reponse = sock.recv(65536)
    finally:
        sock.close()
    assert reponse.startswith(b"HTTP/1.0 400") and time.time() - debut < 5
    assert not base.document_present("notes")


def test_corps_qui_n_est_pas_un_objet_400(srv):
    for route in ("/api/lot", "/api/export/consommation", "/api/export/chirurgie", "/api/base"):
        code, _, _ = requete(srv, "POST", route, [1, 2])
        assert code == 400, route


def test_exports_aux_parametres_mal_types(srv):
    _, data, _ = requete(srv, "POST", "/api/export/consommation", {"references": "REF1"})
    assert data["status"] == "Erreur: Aucune référence sélectionnée."
    _, data, _ = requete(srv, "POST", "/api/export/chirurgie",
                         {"date_debut": 20260101, "date_fin": ["2026-01-31"]})
    assert data["status"] == "Erreur: Dates invalides."


def test_journal_sans_caracteres_de_controle(capsys):
    gestionnaire = object.__new__(serveur.CustomHandler)
    gestionnaire.log_message('"%s" %s %s', "GET /api/x\r\n[faux] Arret\x1b[2J\x7f HTTP/1.1",
                             "400", "-")
    sortie = capsys.readouterr().err
    assert sortie.count("\n") == 1
    assert "\\x0d\\x0a[faux] Arret\\x1b[2J\\x7f" in sortie and "\x1b" not in sortie


@pytest.mark.parametrize("hote", [
    "", "127.0.0.1", "127.0.0.1:8150", "192.168.1.50:8150", "10.0.0.7", "[::1]:8150", "[::1]",
    "::1", "[fe80::1%25eth0]:8150", "localhost", "LOCALHOST:8150"])
def test_host_adresse_ip_ou_localhost_accepte(hote):
    assert serveur.hote_autorise(hote)


@pytest.mark.parametrize("hote", [
    "attaquant.example", "attaquant.example:8150", "localhost.attaquant.example",
    "127.0.0.1.nip.io", "[pas-une-ip]:8150", "[::1]:port", "localhost:8150:80", "a b"])
def test_host_nom_inconnu_refuse(hote):
    assert not serveur.hote_autorise(hote)


def test_host_noms_du_poste_acceptes(monkeypatch):
    monkeypatch.setattr(serveur, "_NOMS_HOTE", None)
    monkeypatch.setattr(serveur.socket, "gethostname", lambda: "Poste-Accueil")
    monkeypatch.setattr(serveur.socket, "getfqdn", lambda: "Poste-Accueil.cabinet.lan")
    for hote in ("poste-accueil", "POSTE-ACCUEIL:8150", "poste-accueil.local:8150",
                 "poste-accueil.cabinet.lan"):
        assert serveur.hote_autorise(hote), hote
    assert not serveur.hote_autorise("autre-poste:8150")
    # Calcule une seule fois
    monkeypatch.setattr(serveur.socket, "getfqdn", lambda: pytest.fail("DNS interroge"))
    assert serveur.hote_autorise("poste-accueil.local")
    monkeypatch.setattr(serveur, "_NOMS_HOTE", None)


def test_host_ip_du_reseau_acceptee_en_http(srv):
    code, _, _ = requete(srv, "GET", "/api/revision", entetes={"Host": "192.168.1.77:8150"})
    assert code == 200
