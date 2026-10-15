# -*- coding: utf-8 -*-
"""Tests des signalements de bug / idées (python/signalements.py), sans appel réel à GitHub."""

import json

import pytest

import serveur
import signalements
from test_serveur import srv, requete  # noqa: F401  (fixture)

BUG = {"type": "bug", "description": "Le placard ne s'ouvre plus\nquand on scanne", "auteur": "Léa"}


def faux_github(envoyes, en_panne=False):
    def ouvrir(ticket, jeton):
        if en_panne:
            raise OSError("pas d'internet")
        envoyes.append((ticket, jeton))
        return "https://github.com/x/issues/%d" % len(envoyes)
    return ouvrir


def test_ticket_prepare():
    ticket = signalements.preparer(BUG, "3.0.0 (abc1234)", maintenant=0)
    assert ticket["title"] == "[Bug] Le placard ne s'ouvre plus"
    assert ticket["labels"] == ["bug"]
    assert "par Léa" in ticket["body"] and "3.0.0 (abc1234)" in ticket["body"]
    idee = signalements.preparer({"type": "idee", "description": "Un mode sombre"})
    assert idee["title"].startswith("[Idée]") and idee["labels"] == ["enhancement"]


@pytest.mark.parametrize("data", [None, {"type": "x", "description": "assez long"},
                                  {"type": "bug", "description": "  "}])
def test_formulaire_incomplet_refuse(data):
    with pytest.raises(signalements.SignalementInvalide):
        signalements.preparer(data)


def test_envoi_direct(tmp_path):
    envoyes = []
    r = signalements.signaler(BUG, str(tmp_path), "cle", ouvrir=faux_github(envoyes))
    assert r == {"envoye": True, "url": "https://github.com/x/issues/1"}
    assert envoyes[0][1] == "cle"


def test_sans_internet_garde_puis_renvoie(tmp_path):
    r = signalements.signaler(BUG, str(tmp_path), "cle", ouvrir=faux_github([], en_panne=True))
    assert r["envoye"] is False and r["en_attente"] == 1
    # Le suivant part, et le premier avec lui, dans l'ordre
    envoyes = []
    r = signalements.signaler({"type": "idee", "description": "Une idée"}, str(tmp_path), "cle",
                              ouvrir=faux_github(envoyes))
    assert r["envoye"] is True
    assert [t["labels"] for t, _ in envoyes] == [["bug"], ["enhancement"]]
    assert signalements.envoyer_en_attente(str(tmp_path), "cle") == 0


def test_sans_cle_rien_n_est_perdu(tmp_path):
    r = signalements.signaler(BUG, str(tmp_path), "")
    assert r == {"envoye": False, "en_attente": 1, "cle_configuree": False}
    envoyes = []
    assert signalements.envoyer_en_attente(str(tmp_path), "cle", faux_github(envoyes)) == 0
    assert len(envoyes) == 1


# --- Routes du serveur ---

@pytest.fixture
def config_temp(tmp_path, monkeypatch):
    monkeypatch.setattr(serveur, "FICHIER_CONFIG", str(tmp_path / "config.json"))
    return tmp_path


def test_route_cle_et_signalement(srv, config_temp, monkeypatch):  # noqa: F811
    envoyes = []
    monkeypatch.setattr(signalements, "_poster",
                        lambda ticket, jeton, ouvrir=None: faux_github(envoyes)(ticket, jeton))
    code, etat, _ = requete(srv, "GET", "/api/signalements")
    assert code == 200 and etat["cle_configuree"] is False and etat["cle_modifiable"] is True

    code, etat, _ = requete(srv, "POST", "/api/signalements/cle", {"cle": " ghp_secret "})
    assert code == 200 and etat["cle_configuree"] is True
    assert "ghp_secret" not in json.dumps(etat)          # la clé ne repart jamais vers les postes
    assert json.loads((config_temp / "config.json").read_text("utf-8"))["github_token"] == "ghp_secret"

    code, r, _ = requete(srv, "POST", "/api/signalements", BUG)
    assert code == 200 and r["envoye"] is True
    assert envoyes[0][1] == "ghp_secret"

    code, r, _ = requete(srv, "POST", "/api/signalements", {"type": "bug", "description": ""})
    assert code == 400


def test_cle_refusee_depuis_un_autre_poste(srv, config_temp, monkeypatch):  # noqa: F811
    monkeypatch.setattr(serveur.CustomHandler, "_client_local", lambda self: False)
    code, data, _ = requete(srv, "POST", "/api/signalements/cle", {"cle": "x"})
    assert code == 400 and "poste" in data["message"]
    assert not (config_temp / "config.json").exists()
