# -*- coding: utf-8 -*-
"""
Signalements de bug et idées d'amélioration envoyés depuis les Réglages.

Chaque signalement devient un ticket (issue) GitHub du dépôt de l'outil. La
clé GitHub (jeton « Issues : lecture et écriture » limité à ce dépôt) est
saisie une fois dans les Réglages du poste qui fait tourner le serveur ; elle
reste dans donnees/config.json, jamais dans le code ni renvoyée aux postes.

Sans internet, le signalement est gardé dans
donnees/signalements_en_attente.json et renvoyé plus tard : à l'envoi suivant
et toutes les 30 minutes. Sans clé, le ticket préparé est rendu au poste, qui
ouvre Gmail avec le message prêt à envoyer (js/ui/signalement.js).

Les journaux (navigateur du poste et serveur) sont joints au ticket.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request

import meteo

DEPOT = "pilou33620/tooth_dentaire"
URL_API = "https://api.github.com/repos/%s/issues" % DEPOT
DELAI = 15                       # s
INTERVALLE_RENVOI = 30 * 60      # s
TYPES = {"bug": ("Bug", "bug"), "idee": ("Idée", "enhancement")}
LONGUEUR_MAX = 5000
JOURNAUX_MAX = 20000             # caractères par journal (GitHub accepte 65536 au total)

_verrou = threading.Lock()


class SignalementInvalide(ValueError):
    """Formulaire incomplet ; le message s'affiche tel quel."""


def _fichier_attente(dossier):
    return os.path.join(dossier, "signalements_en_attente.json")


def _lire_attente(dossier):
    try:
        with open(_fichier_attente(dossier), "r", encoding="utf-8") as f:
            donnees = json.load(f)
            return donnees if isinstance(donnees, list) else []
    except (OSError, ValueError):
        return []


def _ecrire_attente(dossier, liste):
    os.makedirs(dossier, exist_ok=True)
    chemin = _fichier_attente(dossier)
    with open(chemin + ".tmp", "w", encoding="utf-8") as f:
        json.dump(liste, f, indent=2, ensure_ascii=False)
    os.replace(chemin + ".tmp", chemin)


def _bloc_journal(titre, texte):
    texte = str(texte or "").strip()[-JOURNAUX_MAX:]
    # Clôture à 4 accents graves : un ``` dans le journal ne la ferme pas
    return "\n\n<details><summary>%s</summary>\n\n````\n%s\n````\n</details>" % (titre, texte) if texte else ""


def preparer(data, version="", maintenant=None, journal_serveur=""):
    """Valide le formulaire et construit le ticket {title, body, labels}."""
    data = data if isinstance(data, dict) else {}
    genre = data.get("type")
    if genre not in TYPES:
        raise SignalementInvalide("Choisir « Bug » ou « Idée ».")
    description = str(data.get("description") or "").strip()
    if len(description) < 5:
        raise SignalementInvalide("Décrire le problème ou l'idée en quelques mots.")
    description = description[:LONGUEUR_MAX]
    auteur = str(data.get("auteur") or "").strip()[:40]
    libelle, etiquette = TYPES[genre]
    premiere_ligne = description.splitlines()[0][:80]
    quand = time.strftime("%d/%m/%Y %H:%M", time.localtime(maintenant or time.time()))
    corps = "%s\n\n---\n_Envoyé depuis l'outil du cabinet le %s%s — version %s._" % (
        description, quand, (" par " + auteur) if auteur else "", version or "inconnue")
    corps += _bloc_journal("Journal du navigateur", data.get("journaux"))
    corps += _bloc_journal("Journal du serveur", journal_serveur)
    return {"title": "[%s] %s" % (libelle, premiere_ligne), "body": corps, "labels": [etiquette]}


def _poster(ticket, jeton, ouvrir=None):
    """Crée le ticket sur GitHub ; renvoie son adresse. Lève OSError en cas d'échec."""
    if ouvrir is not None:          # remplacé dans les tests
        return ouvrir(ticket, jeton)
    requete = urllib.request.Request(
        URL_API, data=json.dumps(ticket).encode("utf-8"), method="POST",
        headers={"Authorization": "Bearer " + jeton,
                 "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json",
                 "User-Agent": "tooth_dentaire"})
    try:
        with urllib.request.urlopen(requete, timeout=DELAI, context=meteo._CONTEXTE_SSL) as rep:
            return json.loads(rep.read().decode("utf-8")).get("html_url", "")
    except urllib.error.HTTPError as exc:
        raise OSError("GitHub a répondu %s" % exc.code)
    except (urllib.error.URLError, ValueError) as exc:
        raise OSError(str(exc))


def envoyer_en_attente(dossier, jeton, ouvrir=None):
    """Renvoie les signalements gardés ; renvoie le nombre de ceux qui restent."""
    with _verrou:
        restants = _lire_attente(dossier)
        if not restants or not jeton:
            return len(restants)
        while restants:
            try:
                _poster(restants[0], jeton, ouvrir)
            except OSError:
                break
            restants.pop(0)
            _ecrire_attente(dossier, restants)
        return len(restants)


def signaler(data, dossier, jeton, version="", ouvrir=None, journal_serveur=""):
    """
    Envoie un signalement. Renvoie {"envoye": True, "url"} ; sans internet,
    {"envoye": False, "en_attente": n} : rien n'est perdu ; sans clé,
    {"envoye": False, "ticket"} : le poste l'envoie par Gmail.
    """
    ticket = preparer(data, version, journal_serveur=journal_serveur)
    if not jeton:
        return {"envoye": False, "cle_configuree": False, "ticket": ticket}
    envoyer_en_attente(dossier, jeton, ouvrir)
    try:
        return {"envoye": True, "url": _poster(ticket, jeton, ouvrir)}
    except OSError:
        pass
    with _verrou:
        attente = _lire_attente(dossier) + [ticket]
        _ecrire_attente(dossier, attente)
    return {"envoye": False, "en_attente": len(attente), "cle_configuree": True}


def demarrer_renvois(dossier, lire_jeton, intervalle=INTERVALLE_RENVOI):
    """Thread de fond : renvoie les signalements en attente toutes les 30 minutes."""
    def boucle():
        while True:
            time.sleep(intervalle)
            envoyer_en_attente(dossier, lire_jeton())

    fil = threading.Thread(target=boucle, name="signalements", daemon=True)
    fil.start()
    return fil
