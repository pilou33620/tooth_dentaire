# -*- coding: utf-8 -*-
"""Tests de la sauvegarde automatique de la base (python/sauvegarde.py)."""

import datetime
import os
import sqlite3

import pytest

import base
import sauvegarde
from conftest import produit


def test_copie_lisible_et_complete(base_temp):
    base.update_produit(produit("REF1"))
    copie = sauvegarde.sauvegarder()
    assert os.path.dirname(copie["chemin"]) == str(base_temp.parent / "sauvegardes")
    conn = sqlite3.connect(copie["chemin"])
    try:
        assert conn.execute("SELECT reference FROM produits").fetchall() == [("REF1",)]
    finally:
        conn.close()
    assert not any(n.endswith(".partiel") for n in os.listdir(os.path.dirname(copie["chemin"])))


def test_seules_les_plus_recentes_sont_gardees(base_temp):
    debut = datetime.datetime(2026, 1, 1, 8, 0, 0)
    for i in range(5):
        sauvegarde.sauvegarder(garder=3, maintenant=debut + datetime.timedelta(days=i))
    noms = [c["nom"] for c in sauvegarde.lister()]
    assert noms == ["stock-20260105-080000.db", "stock-20260104-080000.db",
                    "stock-20260103-080000.db"]


def test_sauvegardes_manuelles_n_effacent_pas_les_jours_precedents(base_temp):
    # 30 jours de copies quotidiennes, puis 30 clics « Sauvegarder maintenant »
    debut = datetime.datetime(2026, 9, 1, 8, 0, 0)
    for i in range(30):
        sauvegarde.sauvegarder(maintenant=debut + datetime.timedelta(days=i))
    for i in range(30):
        sauvegarde.sauvegarder(maintenant=datetime.datetime(2026, 10, 8, 9, 0, i))
    noms = [c["nom"] for c in sauvegarde.lister()]
    jours = {n[len("stock-"):len("stock-AAAAMMJJ")] for n in noms}
    assert len(jours) == 30                      # 29 jours d'avant + aujourd'hui
    assert "20260902" in jours and "20261008" in jours
    # Les copies du jour gardées : les plus récentes seulement
    du_jour = [n for n in noms if n.startswith("stock-20261008")]
    assert du_jour == ["stock-20261008-0900%02d.db" % s for s in range(29, 24, -1)]
    assert len(noms) == 29 + sauvegarde.GARDER_RECENTES


def test_une_copie_par_jour_la_plus_recente(base_temp):
    for heure in (8, 12, 18):
        sauvegarde.sauvegarder(garder=2, maintenant=datetime.datetime(2026, 1, 1, heure))
    for heure in (8, 12):
        sauvegarde.sauvegarder(garder=2, maintenant=datetime.datetime(2026, 1, 2, heure))
    sauvegarde.sauvegarder(garder=2, maintenant=datetime.datetime(2026, 1, 3, 8))
    assert [c["nom"] for c in sauvegarde.lister()] == [
        "stock-20260103-080000.db", "stock-20260102-120000.db"]


def test_deux_copies_dans_la_meme_seconde(base_temp):
    import threading
    instant = datetime.datetime(2026, 1, 1, 8, 0, 0)
    erreurs = []

    def copier():
        try:
            sauvegarde.sauvegarder(maintenant=instant)
        except Exception as exc:                          # noqa: BLE001
            erreurs.append(exc)
    fils = [threading.Thread(target=copier) for _ in range(4)]
    for f in fils:
        f.start()
    for f in fils:
        f.join()
    assert erreurs == []
    assert [c["nom"] for c in sauvegarde.lister()] == ["stock-20260101-080000.db"]
    assert not any(n.endswith(".partiel") for n in os.listdir(sauvegarde.dossier_sauvegardes()))


def test_fichiers_etrangers_ignores(base_temp):
    dossier = sauvegarde.dossier_sauvegardes()
    os.makedirs(dossier)
    with open(os.path.join(dossier, "a-garder.txt"), "w") as f:
        f.write("x")
    for i in range(3):
        sauvegarde.sauvegarder(garder=1, maintenant=datetime.datetime(2026, 1, 1 + i))
    assert os.path.exists(os.path.join(dossier, "a-garder.txt"))
    assert len(sauvegarde.lister()) == 1


def test_sauvegarde_due_une_fois_par_jour(base_temp):
    assert sauvegarde.sauvegarde_due()
    hier = datetime.datetime.now() - datetime.timedelta(hours=25)
    sauvegarde.sauvegarder(maintenant=hier)
    assert sauvegarde.sauvegarde_due()
    sauvegarde.sauvegarder()
    assert not sauvegarde.sauvegarde_due()
    # Horloge du poste reculee : une copie « dans le futur » ne bloque pas tout
    sauvegarde.sauvegarder(maintenant=datetime.datetime.now() + datetime.timedelta(days=3))
    assert sauvegarde.sauvegarde_due()


def test_base_absente_refusee(tmp_path):
    with pytest.raises(base.ErreurDonnees):
        sauvegarde.sauvegarder(chemin_base=str(tmp_path / "absente.db"))
