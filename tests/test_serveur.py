# -*- coding: utf-8 -*-
"""Tests du serveur HTTP (serveur.py) : API, fichiers statiques, securite."""

import base64
import http.client
import io
import json
import threading

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
