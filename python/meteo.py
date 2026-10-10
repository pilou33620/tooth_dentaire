# -*- coding: utf-8 -*-
"""
Météo du fond de l'accueil.

- Prévisions : MET Norway (api.met.no, Locationforecast 2.0). Service public
  gratuit, usage professionnel autorisé, sans clé ; il faut s'identifier par
  l'en-tête User-Agent, respecter le cache (Expires / Last-Modified) et ne
  pas envoyer plus de 4 décimales de coordonnées.
- Recherche de la commune : Base Adresse Nationale (Géoplateforme IGN),
  licence ouverte Etalab 2.0.

C'est le serveur qui interroge ces services (une requête au plus toutes les
dix minutes, partagée par tous les postes) : les navigateurs du cabinet
n'ont pas besoin d'accès à internet, et seul l'emplacement de la commune
quitte le réseau du cabinet. Sans internet, l'accueil garde son fond
selon l'heure.
"""

import calendar
import email.utils
import json
import math
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "3.0.0"
USER_AGENT = "tooth_dentaire/%s (+https://github.com/pilou33620/tooth_dentaire)" % VERSION

URL_PREVISION = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat}&lon={lon}"
URLS_COMMUNES = (
    "https://data.geopf.fr/geocodage/search?",
    "https://api-adresse.data.gouv.fr/search/?",
)

DELAI_RESEAU = 6            # s
CACHE_MIN = 10 * 60         # s : jamais plus d'une requête toutes les 10 min
CACHE_MAX = 60 * 60         # s
ATTENTE_APRES_ECHEC = 5 * 60

CATEGORIES = ("clair", "voile", "nuageux", "couvert", "brouillard", "pluie", "neige", "orage")


class MeteoIndisponible(RuntimeError):
    """Service extérieur injoignable (pas d'internet, service en panne...)."""


# ------------------------------------------------------------------
# Accès réseau (remplacé dans les tests)
# ------------------------------------------------------------------

def _contexte_ssl():
    """
    Certificats de Windows + ceux de certifi s'il est installé.

    Windows n'installe certaines autorités racines (dont HARICA, qui signe
    api.met.no) qu'à la première visite avec un navigateur ; Python ne lit que
    celles déjà présentes et refusait donc la connexion. certifi les fournit.
    """
    contexte = ssl.create_default_context()
    try:
        import certifi
        contexte.load_verify_locations(certifi.where())
    except (ImportError, OSError, ssl.SSLError):
        pass
    return contexte


_CONTEXTE_SSL = _contexte_ssl()


def ouvrir(url, entetes=None, delai=DELAI_RESEAU):
    """GET HTTP. Renvoie (code, en-têtes, corps en octets). Un 304 n'est pas une erreur."""
    requete = urllib.request.Request(url, headers=dict(entetes or {}, **{"User-Agent": USER_AGENT}))
    try:
        with urllib.request.urlopen(requete, timeout=delai, context=_CONTEXTE_SSL) as rep:
            return rep.status, dict(rep.headers.items()), rep.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return 304, dict(exc.headers.items()), b""
        raise MeteoIndisponible("Service météo : erreur %s" % exc.code)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise MeteoIndisponible("Service météo injoignable (%s)" % exc)


# ------------------------------------------------------------------
# Symboles MET Norway -> catégories de l'interface
# ------------------------------------------------------------------

def decomposer_symbole(symbole):
    """'lightrainshowers_day' -> ('lightrainshowers', 'day')."""
    s = str(symbole or "").strip().lower()
    for suffixe in ("_day", "_night", "_polartwilight"):
        if s.endswith(suffixe):
            return s[: -len(suffixe)], suffixe[1:]
    return s, ""


def categorie(symbole):
    base_, _ = decomposer_symbole(symbole)
    if not base_:
        return None
    if "thunder" in base_:
        return "orage"
    if "snow" in base_ or "sleet" in base_:
        return "neige"
    if "rain" in base_:
        return "pluie"
    if base_ == "fog":
        return "brouillard"
    if base_ == "cloudy":
        return "couvert"
    if base_ == "partlycloudy":
        return "nuageux"
    if base_ == "fair":
        return "voile"
    if base_ == "clearsky":
        return "clair"
    return None


def intensite(symbole):
    base_, _ = decomposer_symbole(symbole)
    if base_.startswith("light"):
        return "faible"
    if base_.startswith("heavy"):
        return "forte"
    return "moyenne"


def est_nuit(symbole):
    """True / False si le symbole le précise, None sinon (« cloudy », « rain »...)."""
    _, suffixe = decomposer_symbole(symbole)
    if suffixe == "night":
        return True
    if suffixe in ("day", "polartwilight"):
        return False
    return None


def libelle(symbole):
    base_, _ = decomposer_symbole(symbole)
    if not base_:
        return ""
    averse = "showers" in base_
    if "thunder" in base_:
        return "Orage"
    if "sleet" in base_:
        return "Pluie et neige"
    if "snow" in base_:
        if base_.startswith("heavy"):
            return "Fortes chutes de neige"
        return "Averses de neige" if averse else ("Neige faible" if base_.startswith("light") else "Neige")
    if "rain" in base_:
        if averse:
            return "Fortes averses" if base_.startswith("heavy") else "Averses"
        if base_.startswith("light"):
            return "Pluie faible"
        return "Forte pluie" if base_.startswith("heavy") else "Pluie"
    return {
        "clearsky": "Ciel dégagé",
        "fair": "Plutôt beau",
        "partlycloudy": "Partiellement nuageux",
        "cloudy": "Couvert",
        "fog": "Brouillard",
    }.get(base_, "")


# ------------------------------------------------------------------
# Lecture de la prévision
# ------------------------------------------------------------------

def _nombre(val):
    """Nombre fini, sinon None (valeur absente, texte, NaN... dans la réponse du service)."""
    if isinstance(val, bool) or not isinstance(val, (int, float)):
        return None
    return val if math.isfinite(val) else None


def _heure_iso(texte):
    """'2026-10-03T14:00:00Z' -> secondes depuis l'époque."""
    try:
        return calendar.timegm(time.strptime(texte.replace("Z", ""), "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, AttributeError, TypeError):
        return None


def resumer(donnees, maintenant=None):
    """Extrait la météo actuelle d'une réponse Locationforecast (compact)."""
    maintenant = time.time() if maintenant is None else maintenant
    serie = (((donnees or {}).get("properties") or {}).get("timeseries")) or []
    if not serie:
        return None

    # Pas de temps en cours : le dernier qui a commencé (sinon le premier)
    courant = serie[0]
    for pas in serie:
        debut = _heure_iso(pas.get("time"))
        if debut is not None and debut <= maintenant:
            courant = pas
        else:
            break

    data = courant.get("data") or {}
    details = (data.get("instant") or {}).get("details") or {}
    symbole = ""
    for cle in ("next_1_hours", "next_6_hours", "next_12_hours"):
        symbole = ((data.get(cle) or {}).get("summary") or {}).get("symbol_code") or ""
        if symbole:
            break
    cat = categorie(symbole)
    if cat is None:
        # Pas de symbole exploitable : on se rabat sur la couverture nuageuse
        nuages = _nombre(details.get("cloud_area_fraction"))
        if nuages is None:
            return None
        cat = "clair" if nuages < 20 else "voile" if nuages < 45 else "nuageux" if nuages < 80 else "couvert"

    temperature = _nombre(details.get("air_temperature"))
    return {
        "categorie": cat,
        "intensite": intensite(symbole),
        "nuit": est_nuit(symbole),
        "symbole": symbole,
        "libelle": libelle(symbole) or {
            "clair": "Ciel dégagé", "voile": "Plutôt beau", "nuageux": "Partiellement nuageux",
            "couvert": "Couvert"}.get(cat, ""),
        "temperature": round(temperature) if temperature is not None else None,
        "nuages": _nombre(details.get("cloud_area_fraction")),
        "vent": _nombre(details.get("wind_speed")),
        "heure": courant.get("time"),
    }


# ------------------------------------------------------------------
# Cache partagé par tous les postes
# ------------------------------------------------------------------

_verrou = threading.Lock()
_cache = {}


def vider_cache():
    with _verrou:
        _cache.clear()


def _coordonnees(lieu):
    try:
        lat = float((lieu or {}).get("lat"))
        lon = float((lieu or {}).get("lon"))
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    # MET Norway demande au plus 4 décimales (environ 10 m)
    return round(lat, 4), round(lon, 4)


def _duree_cache(entetes, maintenant):
    expire = entetes.get("Expires") or entetes.get("expires")
    if expire:
        try:
            date = email.utils.parsedate_to_datetime(expire).timestamp()
            return min(CACHE_MAX, max(CACHE_MIN, date - maintenant))
        except (TypeError, ValueError):
            pass
    return CACHE_MIN


def meteo_actuelle(lieu, maintenant=None):
    """
    {"meteo": {...} ou None, "raison": None | "lieu" | "hors-ligne", "lieu": nom}
    Ne lève jamais d'exception : sans internet, l'accueil garde son fond selon l'heure.
    """
    maintenant = time.time() if maintenant is None else maintenant
    coords = _coordonnees(lieu)
    nom = (lieu or {}).get("nom") or ""
    if coords is None:
        return {"meteo": None, "raison": "lieu", "lieu": nom}

    with _verrou:
        meme_lieu = _cache.get("coords") == coords
        if meme_lieu and maintenant < _cache.get("expire", 0):
            return {"meteo": _cache.get("meteo"), "raison": None, "lieu": nom}
        if meme_lieu and maintenant < _cache.get("echec_jusqua", 0):
            return {"meteo": _cache.get("meteo"), "raison": "hors-ligne", "lieu": nom}
        if not meme_lieu:
            _cache.clear()
            _cache["coords"] = coords
        if _cache.get("en_cours"):
            # Un autre poste interroge déjà le service : on ne l'attend pas
            # (jusqu'à DELAI_RESEAU secondes), on rend la dernière météo connue.
            return {"meteo": _cache.get("meteo"), "raison": None, "lieu": nom}
        _cache["en_cours"] = True
        brut_connu = _cache.get("brut")
        entetes = {}
        if _cache.get("modifie_le") and brut_connu is not None:
            entetes["If-Modified-Since"] = _cache["modifie_le"]

    # Requête hors du verrou : les autres postes ne restent pas bloqués
    try:
        code, reponse, corps = ouvrir(
            URL_PREVISION.format(lat="%.4f" % coords[0], lon="%.4f" % coords[1]), entetes)
        if code == 304 and brut_connu is not None:
            brut = brut_connu
        else:
            brut = json.loads(corps.decode("utf-8"))
        resultat = resumer(brut, maintenant)
    except (MeteoIndisponible, ValueError, UnicodeDecodeError):
        with _verrou:
            if _cache.get("coords") != coords:
                return {"meteo": None, "raison": "hors-ligne", "lieu": nom}
            _cache.pop("en_cours", None)
            _cache["echec_jusqua"] = maintenant + ATTENTE_APRES_ECHEC
            return {"meteo": _cache.get("meteo"), "raison": "hors-ligne", "lieu": nom}
    except BaseException:
        with _verrou:
            if _cache.get("coords") == coords:
                _cache.pop("en_cours", None)
        raise

    with _verrou:
        # La commune a pu changer pendant la requête : on n'écrase pas son cache
        if _cache.get("coords") == coords:
            _cache.pop("en_cours", None)
            _cache["brut"] = brut
            _cache["modifie_le"] = reponse.get("Last-Modified") or reponse.get("last-modified")
            _cache["meteo"] = resultat
            _cache["expire"] = maintenant + _duree_cache(reponse, maintenant)
            _cache.pop("echec_jusqua", None)
    return {"meteo": resultat, "raison": None, "lieu": nom}


# ------------------------------------------------------------------
# Recherche de la commune du cabinet
# ------------------------------------------------------------------

_COORDS_SAISIES = re.compile(r"^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[;, ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$")


def chercher_communes(texte, limite=6):
    """
    Liste de {"nom", "detail", "lat", "lon"}. Accepte aussi des coordonnées
    saisies à la main (« 44.84, -0.58 »), utiles hors de France.
    """
    texte = str(texte or "").strip()[:80]
    if len(texte) < 2:
        return []
    m = _COORDS_SAISIES.match(texte)
    if m:
        lat, lon = (float(v.replace(",", ".")) for v in m.groups())
        if _coordonnees({"lat": lat, "lon": lon}):
            return [{"nom": "%.4f, %.4f" % (lat, lon), "detail": "Coordonnées saisies",
                     "lat": round(lat, 4), "lon": round(lon, 4)}]
        return []

    parametres = urllib.parse.urlencode({"q": texte, "type": "municipality", "limit": limite})
    derniere_erreur = None
    for base_url in URLS_COMMUNES:
        try:
            code, _, corps = ouvrir(base_url + parametres)
            donnees = json.loads(corps.decode("utf-8"))
            break
        except (MeteoIndisponible, ValueError, UnicodeDecodeError) as exc:
            derniere_erreur = exc
    else:
        raise MeteoIndisponible(
            "Recherche impossible : le serveur n'a pas accès à internet (%s)." % derniere_erreur)

    resultats = []
    for f in (donnees.get("features") if isinstance(donnees, dict) else None) or []:
        if not isinstance(f, dict):
            continue
        coords = ((f.get("geometry") or {}).get("coordinates")) or []
        props = f.get("properties") or {}
        # Coordonnées qui ne sont pas des nombres : commune ignorée
        if not isinstance(coords, list) or len(coords) < 2 \
                or _nombre(coords[0]) is None or _nombre(coords[1]) is None:
            continue
        nom = props.get("city") or props.get("name") or props.get("label") or ""
        detail = " · ".join(v for v in (props.get("postcode"), props.get("context")) if v)
        resultats.append({"nom": nom, "detail": detail,
                          "lat": round(float(coords[1]), 4), "lon": round(float(coords[0]), 4)})
    return resultats
