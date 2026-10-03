# -*- coding: utf-8 -*-
"""Configuration commune des tests Python."""

import os
import sys

import pytest

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for chemin in (RACINE, os.path.join(RACINE, "python")):
    if chemin not in sys.path:
        sys.path.insert(0, chemin)

import base  # noqa: E402


@pytest.fixture
def base_temp(tmp_path):
    """Base SQLite neuve dans un dossier temporaire."""
    chemin = tmp_path / "stock.db"
    base.definir_chemin(str(chemin))
    return chemin


def produit(ref="REF1", **autres):
    data = {"reference": ref, "nom": "Produit " + ref, "groupe": "G",
            "ref_scannette": "123", "type_stockage": "unite", "quantite_par_carton": 1}
    data.update(autres)
    return data


def ligne_stock(ref="REF1", espace="Commun", **autres):
    data = {"reference": ref, "utilisateur": espace, "quantite": 5, "stock_minimum": 2,
            "alerte_active": 1, "alerte_peremption_active": 1, "delai_peremption": 30,
            "date_peremption": "", "date_import": "01/10/2026", "fournisseur": "Fournisseur X",
            "en_commande": 0, "date_commande": "", "lot": "", "prix_unitaire_ht": 1.5,
            "prix_unitaire_ttc": 1.8, "lots_details": "[]"}
    data.update(autres)
    return data
