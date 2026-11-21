//! Météo du fond de l'accueil.
//!
//! - Prévisions : MET Norway (api.met.no, Locationforecast 2.0). Service public gratuit, usage
//!   professionnel autorisé, sans clé ; il faut s'identifier par l'en-tête User-Agent, respecter
//!   le cache (Expires / Last-Modified) et ne pas envoyer plus de 4 décimales de coordonnées.
//! - Recherche de la commune : Base Adresse Nationale (Géoplateforme IGN), licence Etalab 2.0.
//!
//! C'est le serveur qui interroge ces services (une requête au plus toutes les dix minutes,
//! partagée par tous les postes) : les navigateurs du cabinet n'ont pas besoin d'internet, et
//! seul l'emplacement de la commune quitte le réseau du cabinet. Sans internet, l'accueil garde
//! son fond selon l'heure.

use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::base::{texte, vrai, Erreur, Res};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const URLS_COMMUNES: [&str; 2] = ["https://data.geopf.fr/geocodage/search?", "https://api-adresse.data.gouv.fr/search/?"];
pub const DELAI_RESEAU: u64 = 6; // s
pub const CACHE_MIN: f64 = 10.0 * 60.0; // s : jamais plus d'une requête toutes les 10 min
pub const CACHE_MAX: f64 = 60.0 * 60.0;
pub const ATTENTE_APRES_ECHEC: f64 = 5.0 * 60.0;

pub fn user_agent() -> String {
    format!("tooth_dentaire/{VERSION} (+https://github.com/pilou33620/tooth_dentaire)")
}

#[derive(Clone, Debug, Default)]
pub struct RepHttp {
    pub code: u16,
    pub expires: Option<String>,
    pub modifie: Option<String>,
    pub corps: Vec<u8>,
}

/// GET (url, If-Modified-Since) ; remplacé dans les essais.
pub type Reseau = Box<dyn Fn(&str, Option<&str>) -> Result<RepHttp, String> + Send + Sync>;

/// GET HTTPS. Un 304 n'est pas une erreur.
pub fn ouvrir(url: &str, si_modifie: Option<&str>) -> Result<RepHttp, String> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(DELAI_RESEAU)).user_agent(&user_agent()).build();
    let mut requete = agent.get(url);
    if let Some(m) = si_modifie {
        requete = requete.set("If-Modified-Since", m);
    }
    match requete.call() {
        Ok(rep) => {
            let code = rep.status();
            let expires = rep.header("Expires").map(str::to_string);
            let modifie = rep.header("Last-Modified").map(str::to_string);
            let mut corps = Vec::new();
            rep.into_reader().take(8 * 1024 * 1024).read_to_end(&mut corps).map_err(|e| format!("Service météo injoignable ({e})"))?;
            Ok(RepHttp { code, expires, modifie, corps })
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("Service météo : erreur {code}")),
        Err(e) => Err(format!("Service météo injoignable ({e})")),
    }
}

// ---------------------------------------------------------------------- symboles MET Norway

/// « lightrainshowers_day » -> (« lightrainshowers », « day »).
pub fn decomposer_symbole(symbole: &str) -> (String, String) {
    let s = symbole.trim().to_lowercase();
    for suffixe in ["_day", "_night", "_polartwilight"] {
        if let Some(b) = s.strip_suffix(suffixe) {
            return (b.to_string(), suffixe[1..].to_string());
        }
    }
    (s, String::new())
}

pub fn categorie(symbole: &str) -> Option<&'static str> {
    let (b, _) = decomposer_symbole(symbole);
    Some(match b.as_str() {
        "" => return None,
        x if x.contains("thunder") => "orage",
        x if x.contains("snow") || x.contains("sleet") => "neige",
        x if x.contains("rain") => "pluie",
        "fog" => "brouillard",
        "cloudy" => "couvert",
        "partlycloudy" => "nuageux",
        "fair" => "voile",
        "clearsky" => "clair",
        _ => return None,
    })
}

pub fn intensite(symbole: &str) -> &'static str {
    let (b, _) = decomposer_symbole(symbole);
    if b.starts_with("light") {
        "faible"
    } else if b.starts_with("heavy") {
        "forte"
    } else {
        "moyenne"
    }
}

/// Vrai / faux si le symbole le précise, rien sinon (« cloudy », « rain »…).
pub fn est_nuit(symbole: &str) -> Option<bool> {
    match decomposer_symbole(symbole).1.as_str() {
        "night" => Some(true),
        "day" | "polartwilight" => Some(false),
        _ => None,
    }
}

pub fn libelle(symbole: &str) -> &'static str {
    let (b, _) = decomposer_symbole(symbole);
    let (averse, faible, fort) = (b.contains("showers"), b.starts_with("light"), b.starts_with("heavy"));
    if b.is_empty() {
        ""
    } else if b.contains("thunder") {
        "Orage"
    } else if b.contains("sleet") {
        "Pluie et neige"
    } else if b.contains("snow") {
        if fort {
            "Fortes chutes de neige"
        } else if averse {
            "Averses de neige"
        } else if faible {
            "Neige faible"
        } else {
            "Neige"
        }
    } else if b.contains("rain") {
        match (averse, faible, fort) {
            (true, _, true) => "Fortes averses",
            (true, _, _) => "Averses",
            (_, true, _) => "Pluie faible",
            (_, _, true) => "Forte pluie",
            _ => "Pluie",
        }
    } else {
        match b.as_str() {
            "clearsky" => "Ciel dégagé",
            "fair" => "Plutôt beau",
            "partlycloudy" => "Partiellement nuageux",
            "cloudy" => "Couvert",
            "fog" => "Brouillard",
            _ => "",
        }
    }
}

// ---------------------------------------------------------------------- lecture de la prévision

/// « 2026-10-03T14:00:00Z » -> secondes depuis l'époque.
fn heure_iso(t: &Value) -> Option<f64> {
    let t = t.as_str()?.replace('Z', "");
    chrono::NaiveDateTime::parse_from_str(&t, "%Y-%m-%dT%H:%M:%S").ok().map(|d| d.and_utc().timestamp() as f64)
}

/// La météo actuelle d'une réponse Locationforecast (compact), ou null.
pub fn resumer(donnees: &Value, maintenant: f64) -> Value {
    let Some(serie) = donnees.pointer("/properties/timeseries").and_then(Value::as_array).filter(|s| !s.is_empty()) else {
        return Value::Null;
    };
    // Pas de temps en cours : le dernier qui a commencé (sinon le premier)
    let mut courant = &serie[0];
    for pas in serie {
        match heure_iso(&pas["time"]) {
            Some(d) if d <= maintenant => courant = pas,
            _ => break,
        }
    }
    let data = &courant["data"];
    let details = &data["instant"]["details"];
    let symbole = ["next_1_hours", "next_6_hours", "next_12_hours"]
        .iter()
        .map(|c| data[*c]["summary"]["symbol_code"].as_str().unwrap_or("").to_string())
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let cat = match categorie(&symbole) {
        Some(c) => c,
        // Pas de symbole exploitable : on se rabat sur la couverture nuageuse
        None => match details["cloud_area_fraction"].as_f64() {
            None => return Value::Null,
            Some(n) if n < 20.0 => "clair",
            Some(n) if n < 45.0 => "voile",
            Some(n) if n < 80.0 => "nuageux",
            Some(_) => "couvert",
        },
    };
    let lib = match libelle(&symbole) {
        "" => match cat {
            "clair" => "Ciel dégagé",
            "voile" => "Plutôt beau",
            "nuageux" => "Partiellement nuageux",
            "couvert" => "Couvert",
            _ => "",
        },
        l => l,
    };
    json!({
        "categorie": cat,
        "intensite": intensite(&symbole),
        "nuit": est_nuit(&symbole),
        "symbole": symbole,
        "libelle": lib,
        "temperature": details["air_temperature"].as_f64().map(|t| t.round_ties_even() as i64),
        "nuages": details["cloud_area_fraction"],
        "vent": details["wind_speed"],
        "heure": courant["time"],
    })
}

// ---------------------------------------------------------------------- cache partagé par tous les postes

#[derive(Default)]
struct Cache {
    coords: Option<(f64, f64)>,
    expire: f64,
    echec_jusqua: f64,
    en_cours: bool,
    brut: Option<Value>,
    modifie_le: Option<String>,
    meteo: Value,
}

pub struct Meteo {
    cache: Mutex<Cache>,
    reseau: Reseau,
}

fn arrondi4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

fn flottant(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(*b as i64 as f64),
        _ => None,
    }
}

/// Coordonnées valides, à 4 décimales (MET Norway n'en veut pas plus : environ 10 m).
fn coordonnees(lieu: &Value) -> Option<(f64, f64)> {
    let (lat, lon) = (flottant(&lieu["lat"])?, flottant(&lieu["lon"])?);
    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then(|| (arrondi4(lat), arrondi4(lon)))
}

fn duree_cache(expires: Option<&str>, maintenant: f64) -> f64 {
    expires
        .and_then(|e| chrono::DateTime::parse_from_rfc2822(e).ok())
        .map(|d| (d.timestamp() as f64 - maintenant).clamp(CACHE_MIN, CACHE_MAX))
        .unwrap_or(CACHE_MIN)
}

fn reponse(meteo: Value, raison: Option<&str>, lieu: &str) -> Value {
    json!({"meteo": meteo, "raison": raison, "lieu": lieu})
}

impl Meteo {
    pub fn new(reseau: Reseau) -> Meteo {
        Meteo { cache: Mutex::new(Cache::default()), reseau }
    }

    pub fn reseau_reel() -> Meteo {
        Meteo::new(Box::new(ouvrir))
    }

    /// {"meteo": {…} ou null, "raison": null | "lieu" | "hors-ligne", "lieu": nom}. Ne lève jamais
    /// d'erreur : sans internet, l'accueil garde son fond selon l'heure.
    pub fn meteo_actuelle(&self, lieu: &Value, maintenant: f64) -> Value {
        let nom = if vrai(&lieu["nom"]) { texte(&lieu["nom"]) } else { String::new() };
        let Some(coords) = coordonnees(lieu) else { return reponse(Value::Null, Some("lieu"), &nom) };
        let verrou = || self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let (connu, si_modifie) = {
            let mut c = verrou();
            let meme = c.coords == Some(coords);
            if meme && maintenant < c.expire {
                return reponse(c.meteo.clone(), None, &nom);
            }
            if meme && maintenant < c.echec_jusqua {
                return reponse(c.meteo.clone(), Some("hors-ligne"), &nom);
            }
            if !meme {
                *c = Cache { coords: Some(coords), ..Cache::default() };
            }
            if c.en_cours {
                // Un autre poste interroge déjà le service : on ne l'attend pas, on rend la
                // dernière météo connue.
                return reponse(c.meteo.clone(), None, &nom);
            }
            c.en_cours = true;
            let si = if c.brut.is_some() { c.modifie_le.clone() } else { None };
            (c.brut.clone(), si)
        };

        // Requête hors du verrou : les autres postes ne restent pas bloqués
        let url = format!(
            "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={:.4}&lon={:.4}",
            coords.0, coords.1
        );
        let resultat = (self.reseau)(&url, si_modifie.as_deref()).and_then(|rep| {
            let brut = match (&connu, rep.code) {
                (Some(b), 304) => b.clone(),
                _ => serde_json::from_slice::<Value>(&rep.corps).map_err(|e| e.to_string())?,
            };
            let m = resumer(&brut, maintenant);
            Ok((brut, m, rep))
        });

        let mut c = verrou();
        match resultat {
            Err(_) => {
                if c.coords != Some(coords) {
                    return reponse(Value::Null, Some("hors-ligne"), &nom);
                }
                c.en_cours = false;
                c.echec_jusqua = maintenant + ATTENTE_APRES_ECHEC;
                reponse(c.meteo.clone(), Some("hors-ligne"), &nom)
            }
            Ok((brut, m, rep)) => {
                // La commune a pu changer pendant la requête : on n'écrase pas son cache
                if c.coords == Some(coords) {
                    c.en_cours = false;
                    c.brut = Some(brut);
                    c.expire = maintenant + duree_cache(rep.expires.as_deref(), maintenant);
                    c.modifie_le = rep.modifie;
                    c.meteo = m.clone();
                    c.echec_jusqua = 0.0;
                }
                reponse(m, None, &nom)
            }
        }
    }

    /// Liste de {"nom", "detail", "lat", "lon"}. Accepte aussi des coordonnées saisies à la main
    /// (« 44.84, -0.58 »), utiles hors de France.
    pub fn chercher_communes(&self, saisie: &str) -> Res<Value> {
        let t: String = saisie.trim().chars().take(80).collect();
        if t.chars().count() < 2 {
            return Ok(json!([]));
        }
        if let Some((lat, lon)) = coords_saisies(&t) {
            let lieu = json!({"lat": lat, "lon": lon});
            return Ok(match coordonnees(&lieu) {
                Some(_) => json!([{"nom": format!("{lat:.4}, {lon:.4}"), "detail": "Coordonnées saisies",
                                   "lat": arrondi4(lat), "lon": arrondi4(lon)}]),
                None => json!([]),
            });
        }
        let parametres = format!("q={}&type=municipality&limit=6", web_tools_commun::serveur::encoder_url(&t));
        let mut derniere = String::new();
        let mut donnees = None;
        for base_url in URLS_COMMUNES {
            match (self.reseau)(&format!("{base_url}{parametres}"), None)
                .and_then(|r| serde_json::from_slice::<Value>(&r.corps).map_err(|e| e.to_string()))
            {
                Ok(d) => {
                    donnees = Some(d);
                    break;
                }
                Err(e) => derniere = e,
            }
        }
        let Some(donnees) = donnees else {
            return Err(Erreur::Indisponible(format!("Recherche impossible : le serveur n'a pas accès à internet ({derniere}).")));
        };
        let mut resultats = Vec::new();
        for f in donnees["features"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let coords = f["geometry"]["coordinates"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            if coords.len() < 2 {
                continue;
            }
            let (Some(lon), Some(lat)) = (flottant(&coords[0]), flottant(&coords[1])) else { continue };
            let p = &f["properties"];
            let nom = ["city", "name", "label"].iter().map(|k| &p[*k]).find(|v| vrai(v)).map(texte).unwrap_or_default();
            let detail: Vec<String> = ["postcode", "context"].iter().map(|k| &p[*k]).filter(|v| vrai(v)).map(texte).collect();
            resultats.push(json!({"nom": nom, "detail": detail.join(" · "), "lat": arrondi4(lat), "lon": arrondi4(lon)}));
        }
        Ok(Value::Array(resultats))
    }
}

/// « 44,8378; -0,5792 » -> (44.8378, -0.5792) : deux nombres (2 et 3 chiffres entiers au plus),
/// séparés par « ; », « , » ou une espace.
fn coords_saisies(t: &str) -> Option<(f64, f64)> {
    let c: Vec<char> = t.chars().collect();
    let blancs = |i: &mut usize| {
        while *i < c.len() && c[*i].is_whitespace() {
            *i += 1;
        }
    };
    // un nombre à partir de i ; `decimales` : la partie après « . » ou « , » est prise si présente
    let nombre = |i: &mut usize, max_entiers: usize, decimales: bool| -> Option<f64> {
        let debut = *i;
        if c.get(*i) == Some(&'-') {
            *i += 1;
        }
        let d = *i;
        while *i < c.len() && c[*i].is_ascii_digit() {
            *i += 1;
        }
        if *i == d || *i - d > max_entiers {
            return None;
        }
        if decimales && matches!(c.get(*i), Some('.') | Some(',')) && c.get(*i + 1).is_some_and(|x| x.is_ascii_digit()) {
            *i += 1;
            while *i < c.len() && c[*i].is_ascii_digit() {
                *i += 1;
            }
        }
        c[debut..*i].iter().collect::<String>().replace(',', ".").parse().ok()
    };
    for decimales in [true, false] {
        let mut i = 0;
        blancs(&mut i);
        let Some(lat) = nombre(&mut i, 2, decimales) else { continue };
        let avant = i;
        blancs(&mut i);
        if matches!(c.get(i), Some(';') | Some(',')) {
            i += 1;
        } else if i == avant {
            continue;
        }
        blancs(&mut i);
        let Some(lon) = nombre(&mut i, 3, true) else { continue };
        blancs(&mut i);
        if i == c.len() {
            return Some((lat, lon));
        }
    }
    None
}

#[cfg(test)]
mod essais {
    use super::*;
    use std::sync::Arc;

    const T: f64 = 1_791_122_400.0; // 2026-10-04T14:00:00Z

    fn lieu() -> Value {
        json!({"nom": "Saint-André-de-Cubzac", "lat": 45.123456, "lon": -0.444444})
    }

    fn heure(s: f64) -> String {
        chrono::DateTime::from_timestamp(s as i64, 0).unwrap().format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    /// Réponse Locationforecast minimale : un pas par heure à partir de `debut`.
    fn prevision(symbole: Option<&str>, temp: f64, debut: f64) -> Value {
        let serie: Vec<Value> = (0..3)
            .map(|i| {
                let mut data = json!({"instant": {"details": {"air_temperature": temp + i as f64, "cloud_area_fraction": 60.0, "wind_speed": 3.2}}});
                if let Some(s) = symbole {
                    data["next_1_hours"] = json!({"summary": {"symbol_code": s}});
                }
                json!({"time": heure(debut + i as f64 * 3600.0), "data": data})
            })
            .collect();
        json!({"properties": {"timeseries": serie}})
    }

    fn ok(donnees: &Value, expires: Option<&str>, modifie: Option<&str>) -> Result<RepHttp, String> {
        Ok(RepHttp { code: 200, expires: expires.map(Into::into), modifie: modifie.map(Into::into), corps: donnees.to_string().into_bytes() })
    }

    type Appels = Arc<Mutex<Vec<(String, Option<String>)>>>;

    /// Un faux réseau : rend les réponses préparées dans l'ordre (la dernière se répète).
    fn faux(reponses: Vec<Result<RepHttp, String>>) -> (Meteo, Appels) {
        let appels: Appels = Arc::new(Mutex::new(Vec::new()));
        let file = Mutex::new(reponses);
        let a = appels.clone();
        let m = Meteo::new(Box::new(move |url: &str, si: Option<&str>| {
            a.lock().unwrap().push((url.to_string(), si.map(str::to_string)));
            let mut f = file.lock().unwrap();
            if f.len() > 1 {
                f.remove(0)
            } else {
                f[0].clone()
            }
        }));
        (m, appels)
    }

    fn n(a: &Appels) -> usize {
        a.lock().unwrap().len()
    }

    #[test]
    fn symboles() {
        for (s, c) in [
            ("clearsky_day", Some("clair")),
            ("clearsky_night", Some("clair")),
            ("fair_day", Some("voile")),
            ("partlycloudy_night", Some("nuageux")),
            ("cloudy", Some("couvert")),
            ("fog", Some("brouillard")),
            ("lightrain", Some("pluie")),
            ("heavyrainshowers_day", Some("pluie")),
            ("sleet", Some("neige")),
            ("snowshowers_polartwilight", Some("neige")),
            ("rainandthunder", Some("orage")),
            ("heavysnowshowersandthunder_night", Some("orage")),
            ("", None),
            ("inconnu", None),
        ] {
            assert_eq!(categorie(s), c, "{s}");
        }
        assert_eq!(intensite("lightrain"), "faible");
        assert_eq!(intensite("heavyrainshowers_day"), "forte");
        assert_eq!(intensite("rain"), "moyenne");
        assert_eq!(est_nuit("clearsky_night"), Some(true));
        assert_eq!(est_nuit("fair_day"), Some(false));
        assert_eq!(est_nuit("cloudy"), None);
        assert_eq!(libelle("lightrain"), "Pluie faible");
        assert_eq!(libelle("rainshowers_day"), "Averses");
        assert_eq!(libelle("heavysnow"), "Fortes chutes de neige");
        assert_eq!(libelle("partlycloudy_day"), "Partiellement nuageux");
        assert_eq!(libelle("lightrainandthunder"), "Orage");
    }

    #[test]
    fn resumer_une_prevision() {
        let m = resumer(&prevision(Some("lightrain"), 10.4, T - 3600.0), T + 600.0);
        assert_eq!(m["categorie"], "pluie");
        assert_eq!(m["intensite"], "faible");
        assert_eq!(m["temperature"], 11); // 2e pas : 10.4 + 1, arrondi
        assert_eq!(m["libelle"], "Pluie faible");
        assert_eq!(m["nuit"], Value::Null);
        // sans symbole : la couverture nuageuse
        let m = resumer(&prevision(None, 14.6, T - 3600.0), T);
        assert_eq!((m["categorie"].clone(), m["libelle"].clone()), (json!("nuageux"), json!("Partiellement nuageux")));
        assert_eq!(resumer(&json!({}), T), Value::Null);
        assert_eq!(resumer(&json!({"properties": {"timeseries": []}}), T), Value::Null);
    }

    #[test]
    fn sans_commune_pas_de_requete() {
        let (m, a) = faux(vec![ok(&prevision(Some("partlycloudy_day"), 14.6, T - 3600.0), None, None)]);
        assert_eq!(m.meteo_actuelle(&json!({"nom": "", "lat": null, "lon": null}), T)["raison"], "lieu");
        assert_eq!(m.meteo_actuelle(&json!({"lat": 120, "lon": 0}), T)["raison"], "lieu");
        assert_eq!(m.meteo_actuelle(&json!({"lat": "abc", "lon": 0}), T)["raison"], "lieu");
        assert_eq!(n(&a), 0);
    }

    #[test]
    fn coordonnees_a_4_decimales_et_cache() {
        let (m, a) = faux(vec![ok(&prevision(Some("partlycloudy_day"), 14.6, T - 3600.0), None, None)]);
        let r = m.meteo_actuelle(&lieu(), T);
        assert_eq!(r["raison"], Value::Null);
        assert_eq!(r["meteo"]["categorie"], "nuageux");
        assert!(a.lock().unwrap()[0].0.contains("lat=45.1235&lon=-0.4444"));
        assert!(user_agent().contains("github.com/pilou33620/tooth_dentaire"));
        m.meteo_actuelle(&lieu(), T + 60.0);
        m.meteo_actuelle(&lieu(), T + CACHE_MIN - 1.0);
        assert_eq!(n(&a), 1);
        m.meteo_actuelle(&lieu(), T + CACHE_MIN + 1.0);
        assert_eq!(n(&a), 2);
        // changer de commune relance la requête
        m.meteo_actuelle(&json!({"nom": "Bordeaux", "lat": 44.84, "lon": -0.58}), T + CACHE_MIN + 10.0);
        assert_eq!(n(&a), 3);
    }

    #[test]
    fn expires_du_service_respecte_dans_les_bornes() {
        let expire = chrono::DateTime::from_timestamp((T + 1800.0) as i64, 0).unwrap().format("%a, %d %b %Y %H:%M:%S GMT").to_string();
        let (m, a) = faux(vec![ok(&prevision(Some("fog"), 5.0, T - 3600.0), Some(&expire), None)]);
        m.meteo_actuelle(&lieu(), T);
        m.meteo_actuelle(&lieu(), T + 29.0 * 60.0);
        assert_eq!(n(&a), 1);
        m.meteo_actuelle(&lieu(), T + 31.0 * 60.0);
        assert_eq!(n(&a), 2);
    }

    #[test]
    fn reponse_304_reutilise_la_prevision() {
        let modifie = "Sat, 03 Oct 2026 12:00:00 GMT";
        let (m, a) = faux(vec![
            ok(&prevision(Some("clearsky_day"), 5.0, T - 3600.0), None, Some(modifie)),
            Ok(RepHttp { code: 304, ..RepHttp::default() }),
        ]);
        m.meteo_actuelle(&lieu(), T);
        let r = m.meteo_actuelle(&lieu(), T + CACHE_MAX + 1.0);
        assert_eq!(a.lock().unwrap()[1].1.as_deref(), Some(modifie));
        assert_eq!(r["meteo"]["categorie"], "clair");
    }

    #[test]
    fn hors_ligne_garde_la_derniere_meteo_et_patiente() {
        let (m, a) = faux(vec![ok(&prevision(Some("rain"), 5.0, T - 3600.0), None, None), Err("pas d'internet".into())]);
        m.meteo_actuelle(&lieu(), T);
        let r = m.meteo_actuelle(&lieu(), T + CACHE_MAX + 1.0);
        assert_eq!((r["raison"].clone(), r["meteo"]["categorie"].clone()), (json!("hors-ligne"), json!("pluie")));
        // Pendant l'attente après un échec, on ne réessaie pas
        m.meteo_actuelle(&lieu(), T + CACHE_MAX + 60.0);
        assert_eq!(n(&a), 2);
    }

    #[test]
    fn jamais_d_internet() {
        let (m, _) = faux(vec![Err("x".into())]);
        assert_eq!(m.meteo_actuelle(&lieu(), T), json!({"meteo": null, "raison": "hors-ligne", "lieu": "Saint-André-de-Cubzac"}));
    }

    #[test]
    fn un_poste_n_attend_pas_la_requete_d_un_autre() {
        let (entree_tx, entree_rx) = std::sync::mpsc::channel::<()>();
        let (sortie_tx, sortie_rx) = std::sync::mpsc::channel::<()>();
        let (entree_tx, sortie_rx) = (Mutex::new(entree_tx), Mutex::new(sortie_rx));
        let appels = Mutex::new(0);
        let m = Arc::new(Meteo::new(Box::new(move |_: &str, _: Option<&str>| {
            let mut n = appels.lock().unwrap();
            *n += 1;
            if *n == 1 {
                return ok(&prevision(Some("rain"), 5.0, T - 3600.0), None, None);
            }
            drop(n);
            let _ = entree_tx.lock().unwrap().send(());
            let _ = sortie_rx.lock().unwrap().recv_timeout(Duration::from_secs(5));
            ok(&prevision(Some("clearsky_day"), 5.0, T - 3600.0), None, None)
        })));
        m.meteo_actuelle(&lieu(), T);
        let plus_tard = T + CACHE_MAX + 1.0;
        let m2 = m.clone();
        let fil = std::thread::spawn(move || m2.meteo_actuelle(&lieu(), plus_tard));
        entree_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // Pendant la requête lente, un autre poste a tout de suite la dernière météo
        let debut = std::time::Instant::now();
        let r = m.meteo_actuelle(&lieu(), plus_tard);
        assert!(debut.elapsed() < Duration::from_secs(1));
        assert_eq!(r["meteo"]["categorie"], "pluie");
        sortie_tx.send(()).unwrap();
        fil.join().unwrap();
        assert_eq!(m.meteo_actuelle(&lieu(), plus_tard + 1.0)["meteo"]["categorie"], "clair");
    }

    fn ban() -> Value {
        json!({"features": [
            {"geometry": {"coordinates": [-0.444444, 45.123456]},
             "properties": {"city": "Saint-André-de-Cubzac", "postcode": "33240", "context": "33, Gironde, Nouvelle-Aquitaine"}},
            {"geometry": {"coordinates": []}, "properties": {"city": "Sans coordonnées"}},
        ]})
    }

    #[test]
    fn recherche_de_commune() {
        let (m, a) = faux(vec![ok(&ban(), None, None)]);
        assert_eq!(
            m.chercher_communes("Saint-André").unwrap(),
            json!([{"nom": "Saint-André-de-Cubzac", "detail": "33240 · 33, Gironde, Nouvelle-Aquitaine", "lat": 45.1235, "lon": -0.4444}])
        );
        assert!(a.lock().unwrap()[0].0.contains("type=municipality"));
        // bascule sur l'adresse de secours
        let (m, a) = faux(vec![Err("geopf en panne".into()), ok(&ban(), None, None)]);
        assert_eq!(m.chercher_communes("Saint-André").unwrap().as_array().unwrap().len(), 1);
        assert!(a.lock().unwrap()[1].0.starts_with(URLS_COMMUNES[1]));
        // sans internet
        let (m, _) = faux(vec![Err("x".into())]);
        assert!(matches!(m.chercher_communes("Bordeaux"), Err(Erreur::Indisponible(_))));
    }

    #[test]
    fn coordonnees_saisies_a_la_main() {
        let (m, a) = faux(vec![ok(&ban(), None, None)]);
        assert_eq!(
            m.chercher_communes("44,8378; -0,5792").unwrap()[0],
            json!({"nom": "44.8378, -0.5792", "detail": "Coordonnées saisies", "lat": 44.8378, "lon": -0.5792})
        );
        assert_eq!(m.chercher_communes("44,5").unwrap()[0]["lon"], 5.0);
        assert_eq!(m.chercher_communes("95, 10").unwrap(), json!([]));
        assert_eq!(m.chercher_communes("a").unwrap(), json!([]));
        assert_eq!(n(&a), 0);
    }
}
