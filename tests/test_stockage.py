# -*- coding: utf-8 -*-
"""
Règle de maintenance : toutes les données du cabinet (stock, rappels mires /
fauteuils / dosimètres, maintenance, planning, contacts, notes...) vivent dans
la base (fichier stock.db), jamais dans le navigateur.

Le stockage du navigateur (localStorage) n'est permis que pour les
préférences propres à un poste, listées ci-dessous. Ce test échoue si un
fichier JavaScript s'en sert ailleurs : la donnée doit alors aller dans la
base (getDocument / setDocument, voir js/core/api.js et DOCUMENTS_DEFAUT dans
python/base.py).
"""

import os
import re

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(RACINE, "web")

# fichier -> ce qu'il y garde (préférence du poste, pas une donnée du cabinet)
AUTORISES = {
    "js/ui/customization.js": "positions des widgets (taille d'écran du poste)",
    "js/ui/version-disposition.js": "remise à zéro unique des positions des widgets du poste",
    "js/ui/bonjourr.js": "apparence de l'accueil et image de fond du poste",
    "js/features/checklist.js": "prénom proposé par défaut sur ce poste",
    "js/features/minuteurs.js": "minuteurs lancés depuis ce poste (pour sonner ici)",
}

STOCKAGE_NAVIGATEUR = re.compile(r"\b(localStorage|sessionStorage|indexedDB)\b")


def _fichiers_js():
    for dossier, sous_dossiers, fichiers in os.walk(WEB):
        sous_dossiers[:] = [d for d in sous_dossiers if d not in ("node_modules", "vendor", "tests")]
        for nom in fichiers:
            if nom.endswith(".js"):
                chemin = os.path.join(dossier, nom)
                yield os.path.relpath(chemin, WEB).replace(os.sep, "/"), chemin


def test_donnees_du_cabinet_jamais_dans_le_navigateur():
    fautifs = []
    for relatif, chemin in _fichiers_js():
        if relatif in AUTORISES:
            continue
        with open(chemin, encoding="utf-8") as f:
            for numero, ligne in enumerate(f, 1):
                code = ligne.split("//", 1)[0]
                if STOCKAGE_NAVIGATEUR.search(code):
                    fautifs.append("%s:%d" % (relatif, numero))
    assert not fautifs, (
        "Stockage navigateur hors préférences du poste : %s. Enregistrez la donnée "
        "dans la base (document) pour qu'elle soit dans stock.db." % ", ".join(fautifs))


def test_liste_des_autorises_a_jour():
    presents = dict(_fichiers_js())
    for relatif in AUTORISES:
        assert relatif in presents, "%s n'existe plus : retirez-le de AUTORISES" % relatif
