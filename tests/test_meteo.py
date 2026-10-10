# -*- coding: utf-8 -*-
"""Tests de la météo du fond (python/meteo.py) et de ses routes."""

import json
import time

import pytest

import base
import meteo
from test_serveur import srv, requete  # noqa: F401  (fixture)

LIEU = {"nom": "Saint-André-de-Cubzac", "lat": 45.123456, "lon": -0.444444}
T = 1791122400  # 2026-10-04T14:00:00Z


def prevision(symbole="partlycloudy_day", temp=14.6, debut=T - 3600, pas=3):
    """Réponse Locationforecast minimale : un pas par heure à partir de `debut`."""
    serie = []
    for i in range(pas):
        serie.append({
            "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(debut + i * 3600)),
            "data": {
                "instant": {"details": {"air_temperature": temp + i, "cloud_area_fraction": 60.0,
                                        "wind_speed": 3.2}},
                "next_1_hours": {"summary": {"symbol_code": symbole}},
            },
        })
    return {"properties": {"timeseries": serie}}


class FauxReseau:
    """Remplace meteo.ouvrir : enregistre les appels, renvoie des réponses préparées."""

    def __init__(self, *reponses):
        self.reponses = list(reponses)
        self.appels = []

    def __call__(self, url, entetes=None, delai=None):
        self.appels.append((url, dict(entetes or {})))
        rep = self.reponses.pop(0) if len(self.reponses) > 1 else self.reponses[0]
        if isinstance(rep, Exception):
            raise rep
        return rep


def ok(donnees, entetes=None):
    return 200, dict(entetes or {}), json.dumps(donnees).encode("utf-8")


@pytest.fixture(autouse=True)
def cache_vide():
    meteo.vider_cache()
    yield
    meteo.vider_cache()


# ------------------------------------------------------------------
# Symboles
# ------------------------------------------------------------------

@pytest.mark.parametrize("symbole,cat", [
    ("clearsky_day", "clair"), ("clearsky_night", "clair"), ("fair_day", "voile"),
    ("partlycloudy_night", "nuageux"), ("cloudy", "couvert"), ("fog", "brouillard"),
    ("lightrain", "pluie"), ("heavyrainshowers_day", "pluie"), ("sleet", "neige"),
    ("snowshowers_polartwilight", "neige"), ("rainandthunder", "orage"),
    ("heavysnowshowersandthunder_night", "orage"), ("", None), ("inconnu", None),
])
def test_categorie(symbole, cat):
    assert meteo.categorie(symbole) == cat


def test_intensite_nuit_libelle():
    assert meteo.intensite("lightrain") == "faible"
    assert meteo.intensite("heavyrainshowers_day") == "forte"
    assert meteo.intensite("rain") == "moyenne"
    assert meteo.est_nuit("clearsky_night") is True
    assert meteo.est_nuit("fair_day") is False
    assert meteo.est_nuit("cloudy") is None
    assert meteo.libelle("lightrain") == "Pluie faible"
    assert meteo.libelle("rainshowers_day") == "Averses"
    assert meteo.libelle("heavysnow") == "Fortes chutes de neige"
    assert meteo.libelle("partlycloudy_day") == "Partiellement nuageux"
    assert meteo.libelle("lightrainandthunder") == "Orage"


# ------------------------------------------------------------------
# Lecture d'une prévision
# ------------------------------------------------------------------

def test_resumer_prend_le_pas_en_cours():
    m = meteo.resumer(prevision("lightrain", temp=10.4), maintenant=T + 600)
    assert m["categorie"] == "pluie"
    assert m["intensite"] == "faible"
    assert m["temperature"] == 11          # 2e pas : 10.4 + 1, arrondi
    assert m["libelle"] == "Pluie faible"
    assert m["nuit"] is None


def test_resumer_sans_symbole_utilise_la_couverture_nuageuse():
    donnees = prevision()
    for pas in donnees["properties"]["timeseries"]:
        del pas["data"]["next_1_hours"]
    m = meteo.resumer(donnees, maintenant=T)
    assert m["categorie"] == "nuageux"     # 60 % de nuages
    assert m["libelle"] == "Partiellement nuageux"


def test_resumer_reponse_vide():
    assert meteo.resumer({}) is None
    assert meteo.resumer({"properties": {"timeseries": []}}) is None


# ------------------------------------------------------------------
# Cache et accès réseau
# ------------------------------------------------------------------

def test_sans_commune_pas_de_requete(monkeypatch):
    reseau = FauxReseau(ok(prevision()))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    assert meteo.meteo_actuelle({"nom": "", "lat": None, "lon": None})["raison"] == "lieu"
    assert reseau.appels == []


def test_coordonnees_a_4_decimales_et_identification(monkeypatch):
    reseau = FauxReseau(ok(prevision()))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    rep = meteo.meteo_actuelle(LIEU, maintenant=T)
    assert rep["raison"] is None
    assert rep["meteo"]["categorie"] == "nuageux"
    assert "lat=45.1235&lon=-0.4444" in reseau.appels[0][0]
    assert "github.com/pilou33620/tooth_dentaire" in meteo.USER_AGENT


def test_une_seule_requete_pendant_la_duree_du_cache(monkeypatch):
    reseau = FauxReseau(ok(prevision()))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    meteo.meteo_actuelle(LIEU, maintenant=T)
    meteo.meteo_actuelle(LIEU, maintenant=T + 60)
    meteo.meteo_actuelle(LIEU, maintenant=T + meteo.CACHE_MIN - 1)
    assert len(reseau.appels) == 1
    meteo.meteo_actuelle(LIEU, maintenant=T + meteo.CACHE_MIN + 1)
    assert len(reseau.appels) == 2


def test_expires_du_service_respecte_dans_les_bornes(monkeypatch):
    expire = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(T + 30 * 60))
    reseau = FauxReseau(ok(prevision(), {"Expires": expire}))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    meteo.meteo_actuelle(LIEU, maintenant=T)
    meteo.meteo_actuelle(LIEU, maintenant=T + 29 * 60)
    assert len(reseau.appels) == 1
    meteo.meteo_actuelle(LIEU, maintenant=T + 31 * 60)
    assert len(reseau.appels) == 2


def test_reponse_304_reutilise_la_prevision(monkeypatch):
    reseau = FauxReseau(ok(prevision("clearsky_day"), {"Last-Modified": "Sat, 03 Oct 2026 12:00:00 GMT"}),
                        (304, {}, b""))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    meteo.meteo_actuelle(LIEU, maintenant=T)
    rep = meteo.meteo_actuelle(LIEU, maintenant=T + meteo.CACHE_MAX + 1)
    assert reseau.appels[1][1]["If-Modified-Since"] == "Sat, 03 Oct 2026 12:00:00 GMT"
    assert rep["meteo"]["categorie"] == "clair"


def test_hors_ligne_garde_la_derniere_meteo_et_patiente(monkeypatch):
    reseau = FauxReseau(ok(prevision("rain")), meteo.MeteoIndisponible("pas d'internet"))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    meteo.meteo_actuelle(LIEU, maintenant=T)
    rep = meteo.meteo_actuelle(LIEU, maintenant=T + meteo.CACHE_MAX + 1)
    assert rep["raison"] == "hors-ligne"
    assert rep["meteo"]["categorie"] == "pluie"
    # Pendant l'attente après un échec, on ne réessaie pas
    meteo.meteo_actuelle(LIEU, maintenant=T + meteo.CACHE_MAX + 60)
    assert len(reseau.appels) == 2


def test_un_poste_n_attend_pas_la_requete_d_un_autre(monkeypatch):
    import threading
    entree, sortie = threading.Event(), threading.Event()
    premier = FauxReseau(ok(prevision("rain")))
    monkeypatch.setattr(meteo, "ouvrir", premier)
    meteo.meteo_actuelle(LIEU, maintenant=T)

    def reseau_lent(url, entetes=None, delai=None):
        entree.set()
        sortie.wait(5)
        return ok(prevision("clearsky_day"))

    monkeypatch.setattr(meteo, "ouvrir", reseau_lent)
    plus_tard = T + meteo.CACHE_MAX + 1
    fil = threading.Thread(target=meteo.meteo_actuelle, args=(LIEU, plus_tard))
    fil.start()
    assert entree.wait(5)
    # Pendant la requête lente, un autre poste a tout de suite la dernière météo
    debut = time.monotonic()
    rep = meteo.meteo_actuelle(LIEU, maintenant=plus_tard)
    assert time.monotonic() - debut < 1
    assert rep["meteo"]["categorie"] == "pluie"
    sortie.set()
    fil.join(5)
    assert meteo.meteo_actuelle(LIEU, maintenant=plus_tard + 1)["meteo"]["categorie"] == "clair"


def test_jamais_d_internet(monkeypatch):
    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(meteo.MeteoIndisponible("x")))
    rep = meteo.meteo_actuelle(LIEU, maintenant=T)
    assert rep == {"meteo": None, "raison": "hors-ligne", "lieu": LIEU["nom"]}


def test_changer_de_commune_relance_la_requete(monkeypatch):
    reseau = FauxReseau(ok(prevision()))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    meteo.meteo_actuelle(LIEU, maintenant=T)
    meteo.meteo_actuelle({"nom": "Bordeaux", "lat": 44.84, "lon": -0.58}, maintenant=T + 10)
    assert len(reseau.appels) == 2


def test_coordonnees_invalides():
    assert meteo.meteo_actuelle({"lat": 120, "lon": 0})["raison"] == "lieu"
    assert meteo.meteo_actuelle({"lat": "abc", "lon": 0})["raison"] == "lieu"


# ------------------------------------------------------------------
# Recherche de commune
# ------------------------------------------------------------------

BAN = {"features": [
    {"geometry": {"coordinates": [-0.444444, 45.123456]},
     "properties": {"city": "Saint-André-de-Cubzac", "postcode": "33240", "context": "33, Gironde, Nouvelle-Aquitaine"}},
    {"geometry": {"coordinates": []}, "properties": {"city": "Sans coordonnées"}},
]}


def test_recherche_de_commune(monkeypatch):
    reseau = FauxReseau(ok(BAN))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    res = meteo.chercher_communes("Saint-André")
    assert res == [{"nom": "Saint-André-de-Cubzac", "detail": "33240 · 33, Gironde, Nouvelle-Aquitaine",
                    "lat": 45.1235, "lon": -0.4444}]
    assert "type=municipality" in reseau.appels[0][0]


def test_recherche_bascule_sur_l_adresse_de_secours(monkeypatch):
    reseau = FauxReseau(meteo.MeteoIndisponible("geopf en panne"), ok(BAN))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    assert len(meteo.chercher_communes("Saint-André")) == 1
    assert reseau.appels[1][0].startswith(meteo.URLS_COMMUNES[1])


def test_recherche_sans_internet(monkeypatch):
    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(meteo.MeteoIndisponible("x")))
    with pytest.raises(meteo.MeteoIndisponible):
        meteo.chercher_communes("Bordeaux")


def test_coordonnees_saisies_a_la_main(monkeypatch):
    reseau = FauxReseau(ok(BAN))
    monkeypatch.setattr(meteo, "ouvrir", reseau)
    assert meteo.chercher_communes("44,8378; -0,5792")[0] == {
        "nom": "44.8378, -0.5792", "detail": "Coordonnées saisies", "lat": 44.8378, "lon": -0.5792}
    assert meteo.chercher_communes("95, 10") == []
    assert meteo.chercher_communes("a") == []
    assert reseau.appels == []


# ------------------------------------------------------------------
# Routes
# ------------------------------------------------------------------

def test_route_meteo(srv, monkeypatch):  # noqa: F811
    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(ok(prevision("fog", debut=time.time() - 1800))))
    statut, data, _ = requete(srv, "GET", "/api/meteo")
    assert statut == 200 and data["raison"] == "lieu"

    base.ecrire_document("meteo_lieu", LIEU)
    statut, data, _ = requete(srv, "GET", "/api/meteo")
    assert statut == 200
    assert data["meteo"]["categorie"] == "brouillard"
    assert data["lieu"] == LIEU["nom"]


def test_route_recherche(srv, monkeypatch):  # noqa: F811
    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(ok(BAN)))
    statut, data, _ = requete(srv, "GET", "/api/meteo/communes?q=Saint-Andr%C3%A9")
    assert statut == 200 and data["communes"][0]["nom"] == "Saint-André-de-Cubzac"

    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(meteo.MeteoIndisponible("x")))
    statut, data, _ = requete(srv, "GET", "/api/meteo/communes?q=Bordeaux")
    assert statut == 503 and "internet" in data["message"]


# ------------------------------------------------------------------
# Réponses de service mal formées
# ------------------------------------------------------------------

@pytest.mark.parametrize("nuages", ["60", None, [60], {"v": 60}, True])
def test_resumer_couverture_nuageuse_non_numerique(nuages):
    donnees = prevision()
    for pas in donnees["properties"]["timeseries"]:
        del pas["data"]["next_1_hours"]
        pas["data"]["instant"]["details"]["cloud_area_fraction"] = nuages
    assert meteo.resumer(donnees, maintenant=T) is None


@pytest.mark.parametrize("temperature", ["14", None, [14], {"t": 1}, float("nan"), float("inf")])
def test_resumer_temperature_non_numerique(temperature):
    donnees = prevision()
    for pas in donnees["properties"]["timeseries"]:
        pas["data"]["instant"]["details"]["air_temperature"] = temperature
        pas["data"]["instant"]["details"]["wind_speed"] = float("nan")
    m = meteo.resumer(donnees, maintenant=T)
    assert m["categorie"] == "nuageux" and m["temperature"] is None and m["vent"] is None


def test_recherche_ignore_les_coordonnees_non_numeriques(monkeypatch):
    reponse = {"features": [
        {"geometry": {"coordinates": ["-0.44", "45.12"]}, "properties": {"city": "Texte"}},
        {"geometry": {"coordinates": [None, 45.1]}, "properties": {"city": "Nulle"}},
        {"geometry": {"coordinates": [{"x": 1}, [2]]}, "properties": {"city": "Objets"}},
        {"geometry": {"coordinates": "-0.44,45.12"}, "properties": {"city": "Chaîne"}},
        "pas un objet",
        BAN["features"][0],
    ]}
    monkeypatch.setattr(meteo, "ouvrir", FauxReseau(ok(reponse)))
    assert [c["nom"] for c in meteo.chercher_communes("Saint-André")] == ["Saint-André-de-Cubzac"]
