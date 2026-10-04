# -*- coding: utf-8 -*-
"""Tests des mises à jour depuis GitHub (python/mise_a_jour.py), sur de vrais dépôts git temporaires."""

import os
import shutil
import subprocess

import pytest

import mise_a_jour
from test_serveur import srv, requete  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git absent")

IDENTITE = {"GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.invalid"}


def run(dossier, *args):
    return subprocess.run(["git"] + list(args), cwd=dossier, check=True, capture_output=True,
                          text=True, env=dict(os.environ, **IDENTITE)).stdout.strip()


def ecrire(dossier, nom, texte):
    with open(os.path.join(dossier, nom), "w", encoding="utf-8") as f:
        f.write(texte)


def publier(dev, nom, texte, message):
    """Un développeur pousse un changement sur GitHub (le dépôt « origine »)."""
    ecrire(dev, nom, texte)
    run(dev, "add", nom)
    run(dev, "commit", "-q", "-m", message)
    run(dev, "push", "-q", "origin", "main")


@pytest.fixture
def depots(tmp_path):
    origine = str(tmp_path / "github.git")
    dev = str(tmp_path / "dev")
    poste = str(tmp_path / "cabinet")
    run(str(tmp_path), "init", "-q", "--bare", "-b", "main", origine)
    run(str(tmp_path), "clone", "-q", origine, dev)
    run(dev, "checkout", "-q", "-b", "main")
    ecrire(dev, ".gitignore", "donnees/\n")
    publier(dev, "serveur.py", "v1\n", "Première version")
    run(str(tmp_path), "clone", "-q", origine, poste)
    os.makedirs(os.path.join(poste, "donnees"))
    ecrire(os.path.join(poste, "donnees"), "stock.db", "base du cabinet")
    mise_a_jour.REDEMARRER.clear()
    yield {"dev": dev, "poste": poste}
    mise_a_jour.REDEMARRER.clear()


def test_a_jour(depots):
    etat = mise_a_jour.verifier(depots["poste"])
    assert etat["disponible"] is False
    assert etat["raison"] is None
    assert etat["nombre"] == 0
    assert etat["verifie_le"] is not None


def test_nouvelle_version_detectee(depots):
    publier(depots["dev"], "serveur.py", "v2\n", "Correctif du post-it")
    publier(depots["dev"], "notes.txt", "x\n", "Ne plus commander")
    etat = mise_a_jour.verifier(depots["poste"])
    assert etat["disponible"] is True
    assert etat["nombre"] == 2
    assert etat["nouveautes"] == ["Ne plus commander", "Correctif du post-it"]


def test_installation_avance_la_copie_et_garde_la_base(depots):
    publier(depots["dev"], "serveur.py", "v2\n", "Correctif")
    appels_pip = []
    resultat = mise_a_jour.installer(depots["poste"], pip=appels_pip.append)
    with open(os.path.join(depots["poste"], "serveur.py"), encoding="utf-8") as f:
        assert f.read() == "v2\n"
    with open(os.path.join(depots["poste"], "donnees", "stock.db"), encoding="utf-8") as f:
        assert f.read() == "base du cabinet"
    assert resultat["fichiers"] == 1
    assert appels_pip == []                       # requirements.txt inchangé
    assert mise_a_jour.REDEMARRER.is_set()
    assert mise_a_jour.verifier(depots["poste"])["disponible"] is False


def test_dependances_reinstallees_si_requirements_change(depots):
    publier(depots["dev"], "requirements.txt", "certifi\n", "Nouvelle dépendance")
    appels_pip = []
    mise_a_jour.installer(depots["poste"], pip=appels_pip.append)
    assert appels_pip == [depots["poste"]]


def test_rien_a_installer(depots):
    with pytest.raises(mise_a_jour.MiseAJourImpossible, match="déjà à jour"):
        mise_a_jour.installer(depots["poste"], pip=lambda d: None)
    assert not mise_a_jour.REDEMARRER.is_set()


def test_fichier_modifie_sur_le_poste_bloque_la_mise_a_jour(depots):
    publier(depots["dev"], "serveur.py", "v2\n", "Correctif")
    ecrire(depots["poste"], "serveur.py", "retouche locale\n")
    with pytest.raises(mise_a_jour.MiseAJourImpossible, match="modifiés sur ce poste"):
        mise_a_jour.installer(depots["poste"], pip=lambda d: None)
    with open(os.path.join(depots["poste"], "serveur.py"), encoding="utf-8") as f:
        assert f.read() == "retouche locale\n"
    assert not mise_a_jour.REDEMARRER.is_set()


def test_historique_divergent_non_propose(depots):
    publier(depots["dev"], "serveur.py", "v2\n", "Sur GitHub")
    ecrire(depots["poste"], "local.txt", "x\n")
    run(depots["poste"], "add", "local.txt")
    run(depots["poste"], "commit", "-q", "-m", "Commit fait sur le poste")
    etat = mise_a_jour.verifier(depots["poste"])
    assert etat["disponible"] is False
    assert "à la main" in etat["raison"]


def test_autre_branche_non_proposee(depots):
    run(depots["poste"], "checkout", "-q", "-b", "essai")
    etat = mise_a_jour.verifier(depots["poste"])
    assert etat["disponible"] is False
    assert "essai" in etat["raison"]


def test_dossier_qui_n_est_pas_un_clone(tmp_path):
    etat = mise_a_jour.verifier(str(tmp_path))
    assert etat["disponible"] is False
    assert "clone git" in etat["raison"]


def test_git_portable_prioritaire(tmp_path, monkeypatch):
    portable = tmp_path / "git.exe"
    monkeypatch.setattr(mise_a_jour, "GIT_PORTABLE", str(portable))
    assert mise_a_jour.commande_git() == "git"
    portable.write_bytes(b"")
    assert mise_a_jour.commande_git() == str(portable)


def test_sans_internet(depots):
    run(depots["poste"], "remote", "set-url", "origin", os.path.join(depots["poste"], "introuvable"))
    etat = mise_a_jour.verifier(depots["poste"])
    assert etat["disponible"] is False
    assert etat["raison"]


def test_route_etat(srv):  # noqa: F811
    code, data, _ = requete(srv, "GET", "/api/mise-a-jour")
    assert code == 200
    assert "disponible" in data and "raison" in data


