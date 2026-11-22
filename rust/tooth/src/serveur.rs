//! Serveur de l'outil de gestion de stock du cabinet dentaire.
//!
//!     tooth                          écoute sur le réseau local, port 8150
//!     tooth --local                  ce poste uniquement
//!     tooth --port 9000
//!     tooth --host 192.168.1.20      écouter sur cette seule adresse du poste
//!     tooth --base D:\stock.db       utiliser une autre base
//!     tooth --importer "C:\…"        reprendre l'ancienne application (--forcer : écraser)
//!     tooth --sans-navigateur        ne pas ouvrir le navigateur
//!
//! Le serveur sert web/ et l'API JSON /api/… ; plusieurs postes du cabinet ouvrent l'outil en
//! même temps. Chaque autre poste saisit une fois le code d'appairage à 6 chiffres affiché dans
//! la console (web_tools_commun). --local coupe l'accès depuis les autres postes.

use std::io::ErrorKind;
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use web_tools_commun::appairage::{self, Garde};
use web_tools_commun::production;
use web_tools_commun::serveur::{decoder_chemin, ErreurCorps, Reponse, Requete, Serveur};

use crate::base::{absolu, safe_int, texte, vrai, Base, Erreur, Res, NUL};
use crate::meteo::Meteo;
use crate::mise_a_jour::{MiseAJour, DELAI_GIT};
use crate::{exports, journal, migration, sauvegarde, signalements};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PORT: u16 = 8150;
pub const CORPS_MAX: usize = 20 * 1024 * 1024; // 20 Mo : un planning ou un carnet complet
/// En-tête maison exigé sur les requêtes qui modifient les données (CSRF) : une page d'un autre
/// site ne peut pas l'ajouter sans pré-vol CORS, jamais accepté ici.
pub const ENTETE_CSRF: &str = "X-Tooth";
/// Posées à la relance qui suit une mise à jour : par demarrer_TOOTH_DENTAIRE, et (la seconde) par
/// les anciens lancer.sh, Lancer.bat et serveur.py.
pub const VARIABLES_REDEMARRAGE: [&str; 2] = ["TOOTH_DENTAIRE_DEJA_MAJ", "TOOTH_DENTAIRE_REDEMARRAGE"];
/// Posée par demarrer_TOOTH_DENTAIRE, qui relance l'outil quand il sort avec le code 75.
pub const RELANCEUR: &str = "TOOTH_DENTAIRE_RELANCEUR";
/// La même, posée par la boucle des anciens lancer.sh et Lancer.bat (avant demarrer_TOOTH_DENTAIRE).
pub const ANCIEN_RELANCEUR: &str = "TOOTH_RELANCEUR";
/// Le dépôt GitHub, dont la publication « binaires » met à jour une copie de production ;
/// TOOTH_DEPOT le remplace (essais de la CI, sur un faux serveur local).
pub const DEPOT: &str = "https://github.com/pilou33620/tooth_dentaire";

/// La racine de l'outil (web/, donnees/) : le dossier courant s'il contient web/index.html, sinon
/// le premier dossier au-dessus de l'exécutable qui le contient.
pub fn racine() -> &'static Path {
    static R: OnceLock<PathBuf> = OnceLock::new();
    R.get_or_init(|| {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let outil = |d: &Path| d.join("web").join("index.html").is_file();
        if outil(&cwd) {
            return cwd;
        }
        let exe = std::env::current_exe().ok().and_then(|e| std::fs::canonicalize(e).ok());
        exe.and_then(|e| e.ancestors().find(|d| outil(d)).map(Path::to_path_buf)).unwrap_or(cwd)
    })
}

pub fn dossier_donnees() -> PathBuf {
    racine().join("donnees")
}

/// TOOTH_CONFIG : autre fichier de réglages (serveurs d'essai, pour ne pas toucher aux réglages
/// de l'installation).
pub fn fichier_config() -> PathBuf {
    std::env::var_os("TOOTH_CONFIG").map(PathBuf::from).unwrap_or_else(|| dossier_donnees().join("config.json"))
}

// ---------------------------------------------------------------------- configuration (chemin de la base, clé GitHub)

pub fn charger_config(f: &Path) -> Map<String, Value> {
    std::fs::read_to_string(f)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Écriture atomique (temporaire puis renommage) ; la clé GitHub y est : lisible par le seul
/// compte qui fait tourner l'outil.
pub fn enregistrer_config(f: &Path, c: &Map<String, Value>) -> Res<()> {
    let io = |e: std::io::Error| Erreur::Interne(e.to_string());
    if let Some(d) = f.parent() {
        std::fs::create_dir_all(d).map_err(io)?;
    }
    let tmp = f.with_extension("json.tmp");
    let t = serde_json::to_string_pretty(c).map_err(|e| Erreur::Interne(e.to_string()))?;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    std::io::Write::write_all(&mut o.open(&tmp).map_err(io)?, t.as_bytes()).map_err(io)?;
    std::fs::rename(&tmp, f).map_err(io)
}

pub fn chemin_base_configure(f: &Path) -> PathBuf {
    match charger_config(f).get("base").and_then(Value::as_str) {
        Some(c) if !c.is_empty() && Path::new(c).is_file() => PathBuf::from(c),
        _ => dossier_donnees().join("stock.db"),
    }
}

// ---------------------------------------------------------------------- l'application

pub struct App {
    pub base: Base,
    pub meteo: Meteo,
    pub maj: Arc<MiseAJour>,
    pub config: PathBuf,
    /// N'écoute que sur ce poste (--local) : pas d'adresse réseau.
    pub local: bool,
    /// --host ADRESSE précise (ni boucle locale, ni 0.0.0.0 / ::) : l'adresse donnée aux autres postes.
    pub hote: Option<IpAddr>,
    pub port: u16,
    pub corps_max: usize,
}

fn route_inconnue() -> Reponse {
    Reponse::json(404, &json!({"status": "error", "message": "Route inconnue."}))
}

fn maintenant_s() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// Le corps JSON (null s'il est vide). NaN / Infinity / 1e999 sont refusés : enregistrés, ils
/// rendraient /api/etat illisible sur tous les postes.
fn lire_json(r: &mut Requete, max: usize) -> Res<Value> {
    let brut = match r.lire_corps(max) {
        Ok(c) => c,
        Err(ErreurCorps::TropGrand) => return Err(Erreur::TropGros),
        Err(ErreurCorps::Invalide) => Vec::new(),
        Err(ErreurCorps::Lecture(_)) => return Err(Erreur::Donnees("JSON invalide.".into())),
    };
    if brut.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&brut).map_err(|_| Erreur::Donnees("JSON invalide.".into()))
}

/// Corps JSON d'une route POST : un objet (ou rien).
fn lire_objet(r: &mut Requete, max: usize) -> Res<Value> {
    let d = lire_json(r, max)?;
    if !d.is_null() && !d.is_object() {
        return Err(Erreur::Donnees("Format de donnees invalide (objet attendu).".into()));
    }
    Ok(d)
}

impl App {
    fn jeton_github(&self) -> String {
        texte(charger_config(&self.config).get("github_token").unwrap_or(&NUL))
    }

    fn dossier_signalements(&self) -> PathBuf {
        self.config.parent().map(Path::to_path_buf).unwrap_or_default()
    }

    fn version_complete(&self) -> String {
        match self.maj.version_locale() {
            c if c.is_empty() => VERSION.to_string(),
            c => format!("{VERSION} ({c})"),
        }
    }

    /// Traduit le résultat d'une action en réponse JSON.
    pub fn executer(&self, r: Res<Value>) -> Reponse {
        match r {
            Ok(v) => {
                let mut m = match v {
                    Value::Object(m) => m,
                    _ => Map::new(),
                };
                if !m.contains_key("status") {
                    m.insert("status".into(), json!("ok"));
                }
                if !m.contains_key("revision") {
                    m.insert("revision".into(), json!(self.base.revision()));
                }
                Reponse::json(200, &Value::Object(m))
            }
            Err(e) => {
                let (code, corps) = match &e {
                    Erreur::TropGros => (413, json!({"status": "error", "message": e.to_string()})),
                    Erreur::Conflit(m) => (409, json!({"status": "error", "conflit": true, "message": m})),
                    Erreur::Donnees(m) => (400, json!({"status": "error", "message": m})),
                    Erreur::Indisponible(m) => (503, json!({"status": "error", "message": m})),
                    Erreur::MiseAJour(m) => (409, json!({"status": "error", "message": m})),
                    Erreur::Interne(detail) => {
                        // le détail (chemins disque…) reste dans le journal du serveur
                        journal::erreur(&format!("[!] Erreur serveur : {detail}"));
                        (500, json!({"status": "error", "message": "Erreur serveur (interne)."}))
                    }
                };
                Reponse::json(code, &corps)
            }
        }
    }

    pub fn info(&self) -> Value {
        let adresses: Vec<String> = if self.local {
            Vec::new()
        } else {
            vec![garde().adresse(&ip_reseau(self.hote), self.port)]
        };
        json!({"version": VERSION, "adresses_reseau": adresses, "commit": self.maj.version_locale()})
    }

    pub fn etat_signalements(&self, local: bool) -> Res<Value> {
        let jeton = self.jeton_github();
        let en_attente = signalements::envoyer_en_attente(&self.dossier_signalements(), &jeton, &signalements::poster_github)?;
        Ok(json!({"cle_configuree": !jeton.is_empty(), "en_attente": en_attente, "cle_modifiable": local}))
    }

    pub fn enregistrer_cle_github(&self, d: &Value, local: bool) -> Res<Value> {
        if !local {
            return Err(Erreur::Donnees("La clé GitHub ne se saisit que sur le poste qui fait tourner le serveur.".into()));
        }
        let cle = if vrai(&d["cle"]) { texte(&d["cle"]).trim().to_string() } else { String::new() };
        let mut c = charger_config(&self.config);
        if cle.is_empty() {
            c.remove("github_token");
        } else {
            c.insert("github_token".into(), json!(cle));
        }
        enregistrer_config(&self.config, &c)?;
        self.etat_signalements(local)
    }

    pub fn sauvegardes(&self) -> Value {
        let dossier = sauvegarde::dossier_sauvegardes(&self.base.chemin());
        let copies = sauvegarde::lister(&dossier);
        json!({
            "dossier": dossier.to_string_lossy(),
            "derniere": copies.first().map(sauvegarde::Copie::json),
            "nombre": copies.len(),
        })
    }

    pub fn changer_base(&self, d: &Value, local: bool) -> Res<Value> {
        if !local {
            return Err(Erreur::Donnees("Le changement de base ne se fait que depuis le poste qui fait tourner le serveur.".into()));
        }
        let saisi = if vrai(&d["chemin"]) { texte(&d["chemin"]) } else { String::new() };
        let saisi = saisi.trim().trim_matches('"');
        if saisi.is_empty() {
            return Err(Erreur::Donnees("Chemin vide.".into()));
        }
        let chemin = absolu(&developper(saisi));
        if !chemin.is_file() {
            return Err(Erreur::Donnees(format!("Fichier introuvable : {}", chemin.display())));
        }
        self.base.definir_chemin(&chemin)?;
        let mut c = charger_config(&self.config);
        c.insert("base".into(), json!(chemin.to_string_lossy()));
        enregistrer_config(&self.config, &c)?;
        Ok(json!({"chemin": chemin.to_string_lossy()}))
    }

    fn get(&self, route: &str, r: &Requete, local: bool) -> Reponse {
        let res: Res<Value> = match route {
            "/api/revision" => return Reponse::json(200, &json!({"revision": self.base.revision()})),
            "/api/etat" => (|| -> Res<Value> {
                Ok(json!({
                    "base": self.base.charger_base()?,
                    "documents": self.base.lire_documents()?,
                    "versions_documents": self.base.versions_documents()?,
                }))
            })(),
            "/api/info" => Ok(self.info()),
            "/api/contacts" => self.base.lister_contacts().map(|c| json!({"contacts": c})),
            "/api/meteo" => self.base.lire_document("meteo_lieu").map(|lieu| self.meteo.meteo_actuelle(&lieu, maintenant_s())),
            "/api/mise-a-jour" => Ok(self.maj.etat()),
            "/api/meteo/communes" => self.meteo.chercher_communes(&r.param("q").unwrap_or_default()).map(|c| json!({"communes": c})),
            "/api/base" => Ok(json!({"chemin": self.base.chemin().to_string_lossy(), "modifiable": local})),
            "/api/sauvegardes" => Ok(self.sauvegardes()),
            "/api/signalements" => self.etat_signalements(local),
            _ => match route.strip_prefix("/api/documents/") {
                Some(cle) => self.base.lire_document(cle).map(|v| json!({"valeur": v})),
                None => return route_inconnue(),
            },
        };
        self.executer(res)
    }

    fn post(&self, route: &str, r: &mut Requete, local: bool) -> Reponse {
        const ROUTES: &[&str] = &[
            "/api/produit",
            "/api/stock",
            "/api/lot",
            "/api/transaction",
            "/api/maintenance",
            "/api/historique-prix",
            "/api/contacts",
            "/api/base",
            "/api/sauvegardes",
            "/api/mise-a-jour/verifier",
            "/api/signalements",
            "/api/signalements/cle",
            "/api/mise-a-jour/installer",
            "/api/export/stock",
            "/api/export/liste-courses",
            "/api/export/consommation",
            "/api/export/chirurgie",
        ];
        if !ROUTES.contains(&route) {
            return route_inconnue();
        }
        let res = (|| -> Res<Value> {
            let d = lire_objet(r, self.corps_max)?;
            let b = &self.base;
            match route {
                "/api/produit" => b.update_produit(&d).map(|_| json!({})),
                "/api/stock" => b.update_stock_item(&d),
                "/api/lot" => Ok(json!({"resultats": b.executer_lot(d.get("operations").unwrap_or(&NUL))?})),
                "/api/transaction" => Ok(json!({"id": b.add_transaction(&d)?})),
                "/api/maintenance" => Ok(json!({"id": b.add_autoclave(&d)?})),
                "/api/historique-prix" => Ok(json!({"id": b.add_historique_prix(&d)?})),
                "/api/contacts" => Ok(json!({"contact": b.enregistrer_contact(&d)?})),
                "/api/base" => self.changer_base(&d, local),
                "/api/sauvegardes" => {
                    let c = sauvegarde::sauvegarder(b, None, sauvegarde::GARDER, sauvegarde::maintenant())?;
                    Ok(json!({"sauvegarde": c.json()}))
                }
                "/api/mise-a-jour/verifier" => Ok(self.maj.verifier(DELAI_GIT)),
                "/api/signalements" => signalements::signaler(
                    &d,
                    &self.dossier_signalements(),
                    &self.jeton_github(),
                    &self.version_complete(),
                    &journal::dernieres_lignes(200, None),
                    &signalements::poster_github,
                ),
                "/api/signalements/cle" => self.enregistrer_cle_github(&d, local),
                "/api/mise-a-jour/installer" => {
                    let resultat = self.maj.installer(DELAI_GIT)?;
                    // Laisser partir la réponse, puis sortir avec le code 75 : demarrer_TOOTH_DENTAIRE reprend
                    // l'exécutable de la nouvelle version et relance l'outil.
                    std::thread::spawn(|| {
                        std::thread::sleep(Duration::from_secs(1));
                        journal::dire("\nMise a jour installee : redemarrage de l'outil...");
                        std::process::exit(75);
                    });
                    Ok(resultat)
                }
                "/api/export/stock" => exports::rendre(exports::export_stock(&b.charger_base()?)),
                "/api/export/liste-courses" => exports::rendre(exports::liste_courses(&b.charger_base()?)),
                "/api/export/consommation" => exports::rendre(exports::stats_consommation(&b.charger_base()?, &d["references"])),
                "/api/export/chirurgie" => {
                    exports::rendre(exports::extraction_chirurgie(&b.charger_base()?, &d["date_debut"], &d["date_fin"]))
                }
                _ => Err(Erreur::Interne(format!("route sans traitement : {route}"))),
            }
        })();
        self.executer(res)
    }

    fn put(&self, route: &str, r: &mut Requete) -> Reponse {
        let Some(cle) = route.strip_prefix("/api/documents/") else { return route_inconnue() };
        // X-Version : version du document lue par le poste ; refus (409) si un autre poste l'a
        // réécrit entre-temps. Absent (ancienne page) : pas de contrôle.
        let version = r.entete("X-Version").map(|v| safe_int(&json!(v), -1));
        let res = lire_json(r, self.corps_max).and_then(|v| self.base.ecrire_document(cle, &v, version));
        self.executer(res)
    }

    fn delete(&self, route: &str, r: &Requete) -> Reponse {
        let p = |k: &str| r.param(k).unwrap_or_default();
        let res = match route {
            "/api/produit" => self.base.delete_produit(&p("reference")),
            "/api/stock" => self.base.delete_stock_item(&p("reference"), &p("utilisateur")),
            "/api/contacts" => self.base.supprimer_contact(&r.param("id").map(Value::String).unwrap_or(Value::Null)),
            _ => return route_inconnue(),
        };
        self.executer(res.map(|_| json!({})))
    }
}

/// « ~/x » -> le dossier personnel.
fn developper(chemin: &str) -> PathBuf {
    match chemin.strip_prefix('~') {
        Some(reste) if reste.is_empty() || reste.starts_with(['/', '\\']) => {
            appairage::dossier_personnel().join(reste.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(chemin),
    }
}

// ---------------------------------------------------------------------- fichiers statiques

fn type_mime(p: &Path) -> Option<&'static str> {
    Some(match p.extension()?.to_str()? {
        // mêmes types que l'ancien serveur Python (mimetypes)
        "html" => "text/html",
        "js" | "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "ico" => "image/vnd.microsoft.icon",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain",
        _ => return None,
    })
}

fn introuvable() -> Reponse {
    Reponse::texte(404, "Fichier introuvable")
}

/// Un fichier de web/ ; rien hors de ce dossier, ni fichier caché, ni extension inconnue.
fn fichier(chemin: &str) -> Reponse {
    if chemin == "/favicon.ico" {
        return Reponse::new(204, "text/plain", Vec::new());
    }
    let rel = if chemin == "/" { "index.html".to_string() } else { decoder_chemin(chemin.trim_start_matches('/')) };
    let p = Path::new(&rel);
    let sur = p.components().all(|c| matches!(c, Component::Normal(n) if !n.to_string_lossy().starts_with('.')));
    let Some(mime) = type_mime(p).filter(|_| sur) else { return introuvable() };
    let web = racine().join("web");
    let f = web.join(p);
    // pas de lien qui sorte de web/
    let dedans = match (std::fs::canonicalize(&f), std::fs::canonicalize(&web)) {
        (Ok(a), Ok(b)) => a.starts_with(b) && a.is_file(),
        _ => false,
    };
    if !dedans {
        return introuvable();
    }
    match std::fs::read(&f) {
        Ok(o) => Reponse::new(200, mime, o),
        Err(_) => introuvable(),
    }
}

// ---------------------------------------------------------------------- service

static GARDE: OnceLock<Garde> = OnceLock::new();

fn garde() -> &'static Garde {
    GARDE.get().expect("garde non initialisée")
}

fn traiter(r: &mut Requete, app: &App) -> Reponse {
    // Host (DNS rebinding), Internet, HTTPS, jeton : avant toute route
    if let Some(rep) = garde().filtrer(r) {
        return rep;
    }
    let chemin = r.chemin().to_string();
    let route = match chemin.trim_end_matches('/') {
        "" => "/".to_string(),
        t => t.to_string(),
    };
    let local = r.client.ip().to_canonical().is_loopback();
    let methode = r.methode.clone();
    match methode.as_str() {
        "GET" | "HEAD" if !route.starts_with("/api/") => fichier(&chemin),
        "HEAD" => Reponse::json(405, &json!({})),
        "GET" => app.get(&route, r, local),
        "POST" | "PUT" | "DELETE" => {
            if r.entete(ENTETE_CSRF) != Some("1") {
                return Reponse::json(403, &json!({"status": "error", "message": "Requête refusée."}));
            }
            match methode.as_str() {
                "POST" => app.post(&route, r, local),
                "PUT" => app.put(&route, r),
                _ => app.delete(&route, r),
            }
        }
        _ => Reponse::texte(405, "Méthode refusée"),
    }
}

/// Journal lisible : ni les fichiers statiques servis, ni la surveillance de révision qui tourne
/// toutes les quelques secondes.
fn journaliser(methode: &str, cible: &str, code: u16) {
    let api = cible.contains("/api/");
    if cible.contains("/api/revision") || (!api && code == 200) || code == 304 {
        return;
    }
    let heure = chrono::Local::now().format("%d/%b/%Y %H:%M:%S");
    journal::erreur(&format!("[{heure}] \"{methode} {}\" {code}", appairage::masquer(cible)));
}

pub fn servir(r: &mut Requete, app: &App) -> Reponse {
    let (methode, cible) = (r.methode.clone(), r.cible.clone());
    // une panique répond 500 sans arrêter le serveur
    let rep = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| traiter(r, app)))
        .unwrap_or_else(|_| Reponse::json(500, &json!({"status": "error", "message": "Erreur serveur (interne)."})));
    journaliser(&methode, &cible, rep.code);
    rep.entete("X-Content-Type-Options", "nosniff").entete("Content-Security-Policy", "frame-ancestors 'self'")
}

// ---------------------------------------------------------------------- lancement

#[derive(Debug, Default)]
pub struct Args {
    pub port: u16,
    pub host: Option<String>,
    pub local: bool,
    pub base: Option<String>,
    pub importer: Option<String>,
    pub forcer: bool,
    pub sans_navigateur: bool,
    pub sans_pause: bool,
    pub sans_maj: bool,
    pub aide: bool,
}

pub const USAGE: &str = "usage: tooth [--port 8150] [--local] [--host ADRESSE] [--base FICHIER] \
[--importer DOSSIER [--forcer]] [--sans-navigateur] [--sans-pause] [--sans-maj]";

pub fn lire_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args { port: PORT, ..Default::default() };
    let mut i = 0;
    while i < argv.len() {
        let x = argv[i].as_str();
        let (cle, val) = match x.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k, Some(v.to_string())),
            _ => (x, None),
        };
        let mut valeur = |val: Option<String>| -> Result<String, String> {
            match val {
                Some(v) => Ok(v),
                None => {
                    i += 1;
                    argv.get(i).cloned().ok_or(format!("{cle} attend une valeur"))
                }
            }
        };
        match cle {
            "--port" => {
                let v = valeur(val)?;
                a.port = v.parse().map_err(|_| format!("port invalide : {v}"))?;
            }
            "--host" => a.host = Some(valeur(val)?),
            "--base" => a.base = Some(valeur(val)?),
            "--importer" => a.importer = Some(valeur(val)?),
            "--local" if val.is_none() => a.local = true,
            "--forcer" if val.is_none() => a.forcer = true,
            "--sans-navigateur" if val.is_none() => a.sans_navigateur = true,
            "--sans-pause" if val.is_none() => a.sans_pause = true,
            "--sans-maj" if val.is_none() => a.sans_maj = true,
            "-h" | "--help" => a.aide = true,
            _ => return Err(format!("option inconnue : {x}")),
        }
        i += 1;
    }
    Ok(a)
}

fn ouvrir_navigateur(url: &str) {
    let r = if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", url]).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    } else if cfg!(target_os = "macos") {
        Command::new("open").arg(url).spawn()
    } else {
        Command::new("xdg-open").arg(url).stdout(Stdio::null()).stderr(Stdio::null()).spawn()
    };
    if r.is_err() {
        journal::dire(&format!("[!] Ouverture du navigateur impossible : ouvrez {url}"));
    }
}

fn boucle_locale(hote: &str) -> bool {
    hote == "localhost" || hote.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|i| i.to_canonical().is_loopback())
}

/// --local / --host : (adresse pour Serveur::ouvrir_sur, mode réseau). Pas d'adresse : l'habituel
/// Serveur::ouvrir (sans --host, ou boucle locale). Hors boucle locale, mode réseau : Garde active.
fn mode_ecoute(args: &Args) -> Result<(Option<IpAddr>, bool), String> {
    let hote = args.host.as_deref().unwrap_or("");
    if args.local || boucle_locale(hote) {
        return Ok((None, false));
    }
    if hote.is_empty() {
        return Ok((None, true));
    }
    let ip: IpAddr = hote
        .trim_matches(['[', ']'])
        .parse()
        .map_err(|_| format!("--host attend une adresse IP de ce poste (par exemple 192.168.1.20), pas « {hote} »"))?;
    Ok((Some(ip), !ip.to_canonical().is_loopback()))
}

/// L'adresse à donner aux autres postes : celle de --host si elle est précise, sinon celle du poste.
fn ip_reseau(precise: Option<IpAddr>) -> String {
    precise.or_else(appairage::adresse_reseau).map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into())
}

/// Vrai si une nouvelle version vient d'être installée : par git sur un clone, par la
/// publication « binaires » sur une copie de production (archive tooth-prod, sans git).
fn maj_au_demarrage(maj: &MiseAJour) -> bool {
    if !production::est_copie_prod(racine()) {
        return maj.au_demarrage();
    }
    let depot = std::env::var("TOOTH_DEPOT").ok().filter(|d| !d.is_empty()).unwrap_or_else(|| DEPOT.to_string());
    journal::dire("[*] Recherche de mises a jour...");
    production::mettre_a_jour(&depot, "tooth", racine(), &|t: &str| journal::dire(t)).unwrap_or_else(|e| {
        journal::dire(&format!("[X] {e}"));
        false
    })
}

/// Lancé par la boucle d'avant demarrer_TOOTH_DENTAIRE (l'ancien lancer.sh ou Lancer.bat, encore en
/// mémoire juste après la mise à jour qui les a remplacés) : la main passe au script de démarrage,
/// avec les mêmes options. Sous Windows, l'outil le lance puis sort aussitôt (code 0 : l'ancienne
/// boucle s'arrête sans pause) pour ne pas garder bin\tooth.exe ouvert : la mise à jour suivante
/// doit pouvoir le remplacer.
fn passer_au_demarrage(argv: &[String]) {
    if std::env::var_os(ANCIEN_RELANCEUR).is_none() || std::env::var_os(RELANCEUR).is_some() {
        return;
    }
    let script = racine().join(if cfg!(windows) { "demarrer_TOOTH_DENTAIRE.cmd" } else { "demarrer_TOOTH_DENTAIRE.sh" });
    if !script.is_file() {
        return;
    }
    journal::dire("[*] Passage au script de demarrage demarrer_TOOTH_DENTAIRE...");
    #[cfg(unix)]
    let erreur = {
        use std::os::unix::process::CommandExt;
        Command::new("sh").arg(&script).args(argv).exec() // ne revient qu'en cas d'échec
    };
    #[cfg(not(unix))]
    let erreur = match Command::new("cmd").arg("/c").arg("call").arg(&script).args(argv).spawn() {
        Ok(_) => std::process::exit(0),
        Err(e) => e,
    };
    journal::dire(&format!("[!] demarrer_TOOTH_DENTAIRE n'a pas pu etre lance ({erreur}) : l'outil demarre quand meme."));
}

fn sortir(code: i32, message: &str) -> ! {
    journal::dire(message);
    std::process::exit(code)
}

pub fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match lire_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{USAGE}\ntooth: {e}");
            std::process::exit(2);
        }
    };
    if args.aide {
        println!("{USAGE}");
        return;
    }
    let (ecoute, reseau) = mode_ecoute(&args).unwrap_or_else(|e| {
        eprintln!("{USAGE}\ntooth: {e}");
        std::process::exit(2);
    });
    let local = !reseau;
    let precise = ecoute.map(|i| i.to_canonical()).filter(|i| !i.is_unspecified());
    let _ = std::env::set_current_dir(racine());
    let config = fichier_config();
    journal::demarrer(config.parent().unwrap_or(Path::new(".")));
    std::panic::set_hook(Box::new(|info| journal::erreur(&format!("[!] {info}"))));

    passer_au_demarrage(&argv);

    // Mise à jour installée avant de démarrer quoi que ce soit ; pas de nouvelle recherche
    // juste après la relance qui la suit. Clone git : git ; copie de production : la publication.
    let maj = Arc::new(MiseAJour::new(racine()));
    let variable = |n: &&str| std::env::var_os(n).is_some();
    let relance = VARIABLES_REDEMARRAGE.iter().any(variable);
    if !relance && !args.sans_maj && maj_au_demarrage(&maj) {
        if [RELANCEUR, ANCIEN_RELANCEUR].iter().any(variable) {
            sortir(production::CODE_MIS_A_JOUR, "Nouvelle version installée : relance de l'outil…");
        }
        journal::dire("[*] Nouvelle version téléchargée : relancez l'outil pour en profiter.");
    }

    let chemin = match &args.base {
        Some(b) => absolu(Path::new(b)),
        None => chemin_base_configure(&config),
    };
    // Première ouverture par la version Rust : copie de la base telle que la version Python
    // l'a laissée, avant toute écriture (ouvrir la base peut compléter son schéma).
    match sauvegarde::copie_avant_rust(&chemin, sauvegarde::maintenant()) {
        Ok(Some(c)) => journal::dire(&format!("[*] Première ouverture par la version Rust : base copiée dans {}", c.display())),
        Ok(None) => {}
        Err(e) => sortir(1, &format!("[X] Copie de sécurité de la base impossible ({e}) : l'outil ne démarre pas, rien n'est modifié.")),
    }
    if let Some(d) = &args.importer {
        match migration::importer(Path::new(d), &chemin, args.forcer) {
            Ok(rapport) => journal::dire(&format!("{rapport}\n")),
            Err(e) => sortir(1, &format!("[X] Import impossible : {e}")),
        }
    }
    let base = Base::ouvrir(&chemin).unwrap_or_else(|e| sortir(1, &format!("[X] Base {} illisible : {e}", chemin.display())));

    // Après une mise à jour, l'ancien serveur libère le port à l'instant : on l'attend un peu
    // plutôt que de partir sur un autre port (les postes ont l'adresse habituelle en favori).
    let attente = Instant::now() + Duration::from_secs(if relance { 20 } else { 0 });
    let ouvrir = |essais: u16| match ecoute {
        Some(ip) => Serveur::ouvrir_sur(ip, args.port, essais),
        None => Serveur::ouvrir(args.port, reseau, essais),
    };
    let absente = |e: &std::io::Error| e.kind() == ErrorKind::AddrNotAvailable;
    let mut srv = ouvrir(1);
    while srv.as_ref().is_err_and(|e| !absente(e)) && Instant::now() < attente {
        std::thread::sleep(Duration::from_millis(500));
        srv = ouvrir(1);
    }
    let srv = srv.or_else(|e| if absente(&e) { Err(e) } else { ouvrir(10) }).unwrap_or_else(|e| {
        if absente(&e) {
            let h = args.host.as_deref().unwrap_or("");
            sortir(1, &format!("[X] --host {h} : cette adresse n'est pas une adresse de ce poste ({e}). Choisir une adresse du poste, ou lancer sans --host."));
        }
        sortir(1, &format!("[X] Impossible de demarrer le serveur : {e}"))
    });
    let port = srv.port();
    if port != args.port {
        journal::dire(&format!("[!] Le port {} est indisponible (le port {} était occupé) : port {port}.", args.port, args.port));
    }

    let afficher: appairage::Afficher = Arc::new(|t: &str| journal::dire(t));
    let _ = GARDE.set(Garde::new("tooth_dentaire", reseau, Some(afficher), None));
    garde().brancher(&srv);
    // écoute sur une seule adresse du poste : 127.0.0.1 n'y répond pas
    let url = match precise {
        Some(ip) => garde().adresse(&ip.to_string(), port),
        None => format!("http://127.0.0.1:{port}/"),
    };
    let ligne = "=".repeat(62);
    journal::dire(&ligne);
    journal::dire(&format!("GESTION DE STOCK - CABINET DENTAIRE  (v{VERSION})"));
    journal::dire(&ligne);
    journal::dire(&format!("  base de donnees : {}", base.chemin().display()));
    journal::dire(&format!("  sauvegardes     : {} (une par jour)", sauvegarde::dossier_sauvegardes(&base.chemin()).display()));
    journal::dire(&format!("  sur ce poste    : {url}"));
    if local {
        journal::dire("  reseau          : desactive (--local)");
    } else {
        journal::dire(&format!("  autres postes   : {}", garde().adresse(&ip_reseau(precise), port)));
        journal::dire("  (au premier lancement, autoriser tooth dans le pare-feu Windows)");
    }
    journal::dire(&ligne);
    garde().annoncer();
    journal::dire("Ctrl+C pour arreter le serveur.\n");

    let app = Arc::new(App {
        base,
        meteo: Meteo::reseau_reel(),
        maj: maj.clone(),
        config,
        local,
        hote: precise,
        port,
        corps_max: CORPS_MAX,
    });
    if !args.sans_navigateur {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(800));
            ouvrir_navigateur(&url);
        });
    }
    maj.demarrer_verifications();
    // une copie de la base au démarrage si besoin, puis chaque jour
    let a = app.clone();
    std::thread::spawn(move || loop {
        sauvegarde::sauvegarder_si_du(&a.base);
        std::thread::sleep(Duration::from_secs(sauvegarde::VERIFICATION));
    });
    // signalements gardés sans internet : renvoyés toutes les 30 minutes
    let a = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(signalements::INTERVALLE_RENVOI));
        if let Err(e) = signalements::envoyer_en_attente(&a.dossier_signalements(), &a.jeton_github(), &signalements::poster_github) {
            journal::dire(&format!("[!] Renvoi des signalements impossible : {e}"));
        }
    });
    srv.servir(Arc::new(move |r: &mut Requete| servir(r, &app)));
}

#[cfg(test)]
mod essais {
    use super::*;
    use crate::base::aides::{ligne, ligne_stock, produit};
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn a(l: &[&str]) -> Vec<String> {
        l.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn ligne_de_commande() {
        // la commande du launcher et toutes les options de l'ancien serveur.py
        let x = lire_args(&a(&["--port", "8150", "--sans-navigateur", "--sans-pause"])).unwrap();
        assert_eq!((x.port, x.sans_navigateur, x.sans_pause, x.local), (8150, true, true, false));
        let x = lire_args(&a(&["--port=9000", "--local", "--host", "0.0.0.0", "--base", "b.db", "--importer", "D", "--forcer", "--sans-maj"])).unwrap();
        assert_eq!((x.port, x.local, x.host.as_deref(), x.base.as_deref(), x.importer.as_deref(), x.forcer, x.sans_maj), (9000, true, Some("0.0.0.0"), Some("b.db"), Some("D"), true, true));
        assert_eq!(lire_args(&[]).unwrap().port, PORT);
        assert!(lire_args(&a(&["--port"])).is_err());
        assert!(lire_args(&a(&["--port", "x"])).is_err());
        assert!(lire_args(&a(&["--inconnu"])).is_err());
        assert!(lire_args(&a(&["--local=1"])).is_err());
        assert!(lire_args(&a(&["-h"])).unwrap().aide);
        assert!(boucle_locale("127.0.0.1") && boucle_locale("::1") && boucle_locale("localhost") && !boucle_locale("0.0.0.0"));
    }

    #[test]
    fn host_ecoute_et_garde() {
        fn mode(l: &[&str]) -> Result<(Option<IpAddr>, bool), String> {
            mode_ecoute(&lire_args(&a(l)).unwrap())
        }
        fn ip(s: &str) -> Option<IpAddr> {
            Some(s.parse().unwrap())
        }
        // boucle locale : l'habituel ouvrir(), sans mode réseau
        let locales: [&[&str]; 7] = [
            &["--local"],
            &["--host", "127.0.0.1"],
            &["--host=::1"],
            &["--host", "[::1]"],
            &["--host", "localhost"],
            &["--host", "::ffff:127.0.0.1"],
            &["--host", "192.168.1.20", "--local"],
        ];
        for l in locales {
            assert_eq!(mode(l), Ok((None, false)), "{l:?}");
        }
        // sans --host : toutes les interfaces, mode réseau
        assert_eq!(mode(&[]), Ok((None, true)));
        assert_eq!(mode(&["--host", ""]), Ok((None, true)));
        // une autre adresse : écoute sur elle seule, et la Garde (jeton, code d'appairage) est active
        assert_eq!(mode(&["--host", "192.168.1.20"]), Ok((ip("192.168.1.20"), true)));
        assert_eq!(mode(&["--host=0.0.0.0"]), Ok((ip("0.0.0.0"), true)));
        assert_eq!(mode(&["--host", "[fd7a:115c:a1e0::1]"]), Ok((ip("fd7a:115c:a1e0::1"), true)));
        assert_eq!(mode(&["--host", "::ffff:192.168.1.20"]), Ok((ip("::ffff:192.168.1.20"), true)));
        assert!(mode(&["--host", "monposte"]).is_err());
        assert_eq!(ip_reseau(ip("192.168.1.20")), "192.168.1.20");
    }

    /// Un serveur d'essai sur un port libre de 127.0.0.1, avec sa base neuve.
    fn demarrer(corps_max: usize) -> (u16, Arc<App>) {
        let _ = GARDE.set(Garde::new("tooth_dentaire", false, None, None));
        let d = crate::dossier_essai("serveur");
        let srv = Serveur::ouvrir(0, false, 1).unwrap();
        let app = Arc::new(App {
            base: Base::ouvrir(&d.join("stock.db")).unwrap(),
            meteo: Meteo::new(Box::new(|_: &str, _: Option<&str>| Err("hors ligne".to_string()))),
            maj: Arc::new(MiseAJour::new(&d)),
            config: d.join("config.json"),
            local: true,
            hote: None,
            port: srv.port(),
            corps_max,
        });
        let a = app.clone();
        srv.servir_en_fond(Arc::new(move |r: &mut Requete| servir(r, &a)));
        (srv.port(), app)
    }

    /// (code, corps JSON ou texte, en-têtes).
    fn http(port: u16, methode: &str, chemin: &str, entetes: &[(&str, &str)], envoi: Option<&str>) -> (u16, Value, String) {
        let mut h: Vec<(String, String)> = vec![("Host".into(), format!("127.0.0.1:{port}"))];
        if methode != "GET" && methode != "HEAD" {
            h.push(("X-Tooth".into(), "1".into()));
        }
        for (k, v) in entetes {
            h.retain(|(x, _)| !x.eq_ignore_ascii_case(k));
            h.push((k.to_string(), v.to_string()));
        }
        let envoi = envoi.unwrap_or("");
        let mut t = format!("{methode} {chemin} HTTP/1.0\r\n");
        for (k, v) in &h {
            t += &format!("{k}: {v}\r\n");
        }
        if !h.iter().any(|(k, _)| k == "Content-Length") {
            t += &format!("Content-Length: {}\r\n", envoi.len());
        }
        t += "\r\n";
        t += envoi;
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(t.as_bytes()).unwrap();
        let mut rep = Vec::new();
        s.read_to_end(&mut rep).unwrap();
        let rep = String::from_utf8_lossy(&rep).into_owned();
        let (tete, corps) = rep.split_once("\r\n\r\n").unwrap_or((rep.as_str(), ""));
        let code = tete.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let v = serde_json::from_str(corps).unwrap_or_else(|_| Value::String(corps.to_string()));
        (code, v, tete.to_string())
    }

    fn get(port: u16, chemin: &str) -> (u16, Value, String) {
        http(port, "GET", chemin, &[], None)
    }

    fn envoyer(port: u16, methode: &str, chemin: &str, corps: &Value) -> (u16, Value) {
        let (c, v, _) = http(port, methode, chemin, &[], Some(&corps.to_string()));
        (c, v)
    }

    #[test]
    fn fichiers_statiques() {
        let (port, _) = demarrer(CORPS_MAX);
        let (c, corps, tete) = get(port, "/");
        assert_eq!(c, 200);
        assert!(corps.as_str().unwrap().contains("<!DOCTYPE html>"));
        assert!(tete.contains("no-store") && tete.contains("nosniff"));
        let (c, _, tete) = get(port, "/js/main-init.js");
        assert_eq!(c, 200);
        assert!(tete.contains("Content-Type: application/javascript"));
        for chemin in ["/../serveur.py", "/%2e%2e/serveur.py", "/../donnees/stock.db", "/..%2f..%2fserveur.py", "/js/../../python/base.py", "/js/", "/.gitignore", "/../Cargo.toml", "/../.git/HEAD"] {
            let (c, corps, _) = get(port, chemin);
            assert_eq!(c, 404, "{chemin}");
            assert!(!corps.to_string().to_lowercase().contains("sqlite"));
        }
    }

    #[test]
    fn host_controle() {
        let (port, _) = demarrer(CORPS_MAX);
        for (hote, attendu) in [
            ("attaquant.example", 403),
            ("100.80.111.121:8150", 200),
            ("100.64.0.1", 200),
            ("192.168.1.20:8150", 200),
            ("[::1]:8150", 200),
            ("piege.example:8150", 403),
        ] {
            assert_eq!(http(port, "GET", "/api/revision", &[("Host", hote)], None).0, attendu, "{hote}");
        }
    }

    #[test]
    fn etat_ecritures_et_revision() {
        let (port, app) = demarrer(CORPS_MAX);
        app.base.update_produit(&produit("REF1", json!({}))).unwrap();
        let (c, d, _) = get(port, "/api/etat");
        assert_eq!((c, d["status"].clone()), (200, json!("ok")));
        assert_eq!(d["base"]["produits"][0]["reference"], "REF1");
        assert_eq!(d["documents"].as_object().unwrap().len(), crate::base::CLES.len());
        assert_eq!(d["revision"], app.base.revision());
        let cles: Vec<&String> = d.as_object().unwrap().keys().collect();
        assert_eq!(cles, ["base", "documents", "versions_documents", "status", "revision"]);

        let (c, d) = envoyer(port, "POST", "/api/stock", &ligne(json!({"quantite": 7})));
        assert_eq!((c, d["status"].clone()), (200, json!("ok")));
        assert_eq!(app.base.charger_base().unwrap()["stock"][0]["quantite"], 7);

        let avant = get(port, "/api/revision").1;
        let (_, d) = envoyer(port, "POST", "/api/produit", &produit("REF1", json!({})));
        assert_ne!(d["revision"], avant["revision"]);

        let (_, d) = envoyer(port, "POST", "/api/transaction", &json!({"date": "d", "reference": "R", "utilisateur": "Commun", "type_transaction": "SORTIE_STOCK", "quantite": 1}));
        assert_eq!(d["id"], app.base.charger_base().unwrap()["transactions"][0]["id"]);
    }

    #[test]
    fn suppressions() {
        let (port, app) = demarrer(CORPS_MAX);
        app.base.update_produit(&produit("A B", json!({}))).unwrap();
        app.base.update_stock_item(&ligne_stock("A B", "Commun", json!({}))).unwrap();
        assert_eq!(http(port, "DELETE", "/api/produit?reference=A%20B", &[], None).0, 200);
        assert_eq!(app.base.charger_base().unwrap()["produits"], json!([]));
        app.base.update_stock_item(&ligne_stock("REF1", "Salle de chir", json!({}))).unwrap();
        http(port, "DELETE", "/api/stock?reference=REF1&utilisateur=Salle%20de%20chir", &[], None);
        assert_eq!(app.base.charger_base().unwrap()["stock"], json!([]));
    }

    #[test]
    fn documents_et_contacts() {
        let (port, app) = demarrer(CORPS_MAX);
        assert_eq!(envoyer(port, "PUT", "/api/documents/taches", &json!({"rows": [{"task": "T"}]})).0, 200);
        assert_eq!(get(port, "/api/documents/taches").1["valeur"]["rows"][0]["task"], "T");
        let (c, d) = envoyer(port, "PUT", "/api/documents/inconnu", &json!({}));
        assert_eq!((c, d["status"].clone()), (400, json!("error")));
        assert_eq!(http(port, "PUT", "/api/documents/notes", &[], None).0, 400); // document vide

        let (_, d) = envoyer(port, "POST", "/api/contacts", &json!({"nom": "Labo"}));
        let ident = d["contact"]["id"].as_i64().unwrap();
        assert_eq!(get(port, "/api/contacts").1["contacts"][0]["nom"], "Labo");
        http(port, "DELETE", &format!("/api/contacts?id={ident}"), &[], None);
        assert!(app.base.lister_contacts().unwrap().is_empty());
    }

    #[test]
    fn document_version_perimee_refusee() {
        let (port, app) = demarrer(CORPS_MAX);
        assert_eq!(get(port, "/api/etat").1["versions_documents"]["notes"], 0);
        let (c, d, _) = http(port, "PUT", "/api/documents/notes", &[("X-Version", "0")], Some(r#"{"items": ["A"]}"#));
        assert_eq!((c, d["version"].clone()), (200, json!(1)));
        // Un second poste qui avait lu la version 0
        let (c, d, _) = http(port, "PUT", "/api/documents/notes", &[("X-Version", "0")], Some(r#"{"items": ["B"]}"#));
        assert_eq!((c, d["conflit"].clone()), (409, json!(true)));
        assert_eq!(app.base.lire_document("notes").unwrap(), json!({"items": ["A"]}));
        // Sans X-Version (ancienne page) : pas de contrôle
        assert_eq!(envoyer(port, "PUT", "/api/documents/notes", &json!({"items": ["C"]})).0, 200);
        assert_eq!(app.base.versions_documents().unwrap()["notes"], 2);
    }

    #[test]
    fn refus_et_erreurs() {
        let (port, app) = demarrer(CORPS_MAX);
        let (c, d) = envoyer(port, "POST", "/api/produit", &json!({"nom": "sans reference"}));
        assert_eq!(c, 400);
        assert!(d["message"].as_str().unwrap().contains("obligatoire"));
        assert_eq!(http(port, "POST", "/api/stock", &[], Some("{pas du json")).0, 400);
        for corps in [r#"{"items": [], "x": NaN}"#, r#"{"items": [], "x": Infinity}"#, r#"{"items": [], "x": -Infinity}"#, r#"{"items": [], "x": 1e999}"#] {
            assert_eq!(http(port, "PUT", "/api/documents/notes", &[], Some(corps)).0, 400, "{corps}");
        }
        assert!(get(port, "/api/etat").1.is_object());
        assert_eq!(get(port, "/api/rien").0, 404);
        assert_eq!(envoyer(port, "POST", "/api/rien", &json!({})).0, 404);
        assert_eq!(http(port, "HEAD", "/api/etat", &[], None).0, 405);
        let (c, d) = envoyer(port, "POST", "/api/lot", &json!([1, 2]));
        assert_eq!(c, 400);
        assert!(d["message"].as_str().unwrap().contains("objet"));
        // 500 sans détail interne
        let rep = app.executer(Err(Erreur::Interne("/chemin/secret/stock.db".into())));
        assert_eq!(rep.code, 500);
        assert!(!String::from_utf8_lossy(&rep.corps).contains("secret"));
    }

    #[test]
    fn ecriture_sans_entete_maison_refusee() {
        let (port, app) = demarrer(CORPS_MAX);
        app.base.update_produit(&produit("X", json!({}))).unwrap();
        for (m, chemin) in [("POST", "/api/produit"), ("PUT", "/api/documents/notes"), ("DELETE", "/api/produit?reference=X")] {
            let (c, _, _) = http(port, m, chemin, &[("X-Tooth", "")], Some(r#"{"items": []}"#));
            assert_eq!(c, 403, "{m} {chemin}");
        }
        assert_eq!(app.base.charger_base().unwrap()["produits"][0]["reference"], "X");
        assert_eq!(app.base.lire_document("notes").unwrap(), crate::base::defaut("notes"));
    }

    #[test]
    fn corps_trop_gros_413() {
        let (port, _) = demarrer(10);
        assert_eq!(envoyer(port, "POST", "/api/produit", &produit("REF1", json!({}))).0, 413);
        let (port, _) = demarrer(CORPS_MAX);
        let (c, _, _) = http(port, "POST", "/api/produit", &[("Content-Length", "999999999")], Some("{}"));
        assert_eq!(c, 413);
    }

    #[test]
    fn info_exports_sauvegardes_lots() {
        let (port, app) = demarrer(CORPS_MAX);
        let d = get(port, "/api/info").1;
        assert_eq!((d["version"].clone(), d["adresses_reseau"].clone()), (json!(VERSION), json!([])));

        app.base.update_produit(&produit("REF1", json!({}))).unwrap();
        app.base.update_stock_item(&ligne(json!({}))).unwrap();
        let (_, d) = envoyer(port, "POST", "/api/export/stock", &json!({}));
        assert_eq!((d["status"].clone(), d["nom_fichier"].clone()), (json!("Succès"), json!("Export_Stock.xlsx")));
        assert!(d["contenu_base64"].as_str().unwrap().starts_with("UEsD")); // « PK\x03 » : un zip
        let (_, d) = envoyer(port, "POST", "/api/export/chirurgie", &json!({"date_debut": "2026-01-01", "date_fin": "2026-01-31"}));
        assert!(d["status"].as_str().unwrap().contains("Aucun article") && d.get("contenu_base64").is_none());

        let d = get(port, "/api/sauvegardes").1;
        assert_eq!((d["derniere"].clone(), d["nombre"].clone()), (Value::Null, json!(0)));
        let (c, d) = envoyer(port, "POST", "/api/sauvegardes", &json!({}));
        assert_eq!(c, 200);
        assert!(d["sauvegarde"]["nom"].as_str().unwrap().starts_with("stock-") && d["sauvegarde"].get("chemin").is_none());
        let d = get(port, "/api/sauvegardes").1;
        assert_eq!(d["nombre"], 1);
        assert!(d["dossier"].as_str().unwrap().ends_with("sauvegardes"));

        let (c, d) = envoyer(port, "POST", "/api/lot", &json!({"operations": [
            {"action": "updateProduit", "donnees": produit("REF2", json!({}))},
            {"action": "updateStockItem", "donnees": ligne_stock("REF2", "Commun", json!({"version": null}))},
        ]}));
        assert_eq!((c, d["resultats"][1]["version"].clone()), (200, json!(1)));
        let (c, d) = envoyer(port, "POST", "/api/lot", &json!({"operations": [
            {"action": "updateStockItem", "donnees": ligne_stock("REF2", "Commun", json!({"version": null}))}]}));
        assert_eq!((c, d["conflit"].clone()), (409, json!(true)));
        assert!(d["message"].as_str().unwrap().contains("autre poste"));

        let (c, d, _) = get(port, "/api/mise-a-jour");
        assert_eq!(c, 200);
        assert!(d.get("disponible").is_some() && d.get("raison").is_some());
        let d = get(port, "/api/meteo").1;
        assert_eq!(d["raison"], "lieu");
        let (c, d, _) = get(port, "/api/meteo/communes?q=Bordeaux");
        assert_eq!(c, 503);
        assert!(d["message"].as_str().unwrap().contains("internet"));
    }

    #[test]
    fn changer_de_base() {
        let (port, app) = demarrer(CORPS_MAX);
        let d = crate::dossier_essai("autre-base");
        let autre = d.join("autre.db");
        std::fs::write(&autre, b"").unwrap();
        let (c, r) = envoyer(port, "POST", "/api/base", &json!({"chemin": autre.to_string_lossy()}));
        assert_eq!((c, r["chemin"].clone()), (200, json!(autre.to_string_lossy())));
        assert_eq!(app.base.chemin(), autre);
        assert_eq!(charger_config(&app.config)["base"], json!(autre.to_string_lossy()));
        assert_eq!(get(port, "/api/base").1["modifiable"], true);
        let (c, r) = envoyer(port, "POST", "/api/base", &json!({"chemin": d.join("absent.db").to_string_lossy()}));
        assert_eq!(c, 400);
        assert!(r["message"].as_str().unwrap().contains("introuvable"));
        // depuis un autre poste : refusé
        assert!(matches!(app.changer_base(&json!({"chemin": autre.to_string_lossy()}), false), Err(Erreur::Donnees(m)) if m.contains("poste")));
    }

    #[test]
    fn chemin_configure() {
        let d = crate::dossier_essai("config");
        let f = d.join("config.json");
        assert_eq!(chemin_base_configure(&f), dossier_donnees().join("stock.db"));
        let existant = d.join("x.db");
        std::fs::write(&existant, b"").unwrap();
        enregistrer_config(&f, json!({"base": existant.to_string_lossy()}).as_object().unwrap()).unwrap();
        assert_eq!(chemin_base_configure(&f), existant);
        enregistrer_config(&f, json!({"base": d.join("disparu.db").to_string_lossy()}).as_object().unwrap()).unwrap();
        assert_eq!(chemin_base_configure(&f), dossier_donnees().join("stock.db"));
    }

    #[test]
    fn cle_github_et_signalement_sans_cle() {
        let (port, app) = demarrer(CORPS_MAX);
        let (c, e, _) = get(port, "/api/signalements");
        assert_eq!((c, e["cle_configuree"].clone(), e["cle_modifiable"].clone()), (200, json!(false), json!(true)));
        // sans clé : le ticket préparé revient au poste (Gmail)
        let (c, r) = envoyer(port, "POST", "/api/signalements", &json!({"type": "bug", "description": "Le placard ne s'ouvre plus"}));
        assert_eq!((c, r["envoye"].clone(), r["cle_configuree"].clone()), (200, json!(false), json!(false)));
        assert_eq!(envoyer(port, "POST", "/api/signalements", &json!({"type": "bug", "description": ""})).0, 400);
        // la clé s'enregistre et ne repart jamais vers les postes (l'envoi des tickets en attente
        // n'est pas tenté : il n'y en a pas)
        let (c, e) = envoyer(port, "POST", "/api/signalements/cle", &json!({"cle": " ghp_secret "}));
        assert_eq!((c, e["cle_configuree"].clone()), (200, json!(true)));
        assert!(!e.to_string().contains("ghp_secret"));
        assert_eq!(charger_config(&app.config)["github_token"], "ghp_secret");
        assert!(matches!(app.enregistrer_cle_github(&json!({"cle": "x"}), false), Err(Erreur::Donnees(m)) if m.contains("poste")));
    }

    /// Les données du cabinet vivent dans la base, jamais dans le navigateur : le stockage du
    /// navigateur n'est permis que pour les préférences propres à un poste.
    #[test]
    fn donnees_du_cabinet_jamais_dans_le_navigateur() {
        const AUTORISES: &[&str] = &[
            "js/ui/customization.js",    // positions des widgets (taille d'écran du poste)
            "js/ui/bonjourr.js",         // apparence de l'accueil et image de fond du poste
            "js/features/checklist.js",  // prénom proposé par défaut sur ce poste
            "js/features/minuteurs.js",  // minuteurs lancés depuis ce poste (pour sonner ici)
            "js/journal.js",             // erreurs récentes de ce poste, jointes aux signalements
            "js/ui/signalement.js",      // lecture des réglages du poste joints aux signalements
        ];
        fn fichiers(d: &Path, rel: &str, v: &mut Vec<(String, PathBuf)>) {
            for e in std::fs::read_dir(d).unwrap().flatten() {
                let nom = e.file_name().to_string_lossy().into_owned();
                let r = if rel.is_empty() { nom.clone() } else { format!("{rel}/{nom}") };
                if e.path().is_dir() {
                    if !["node_modules", "vendor", "tests"].contains(&nom.as_str()) {
                        fichiers(&e.path(), &r, v);
                    }
                } else if nom.ends_with(".js") {
                    v.push((r, e.path()));
                }
            }
        }
        let mut v = Vec::new();
        fichiers(&racine().join("web"), "", &mut v);
        let mot = |l: &str, m: &str| {
            l.match_indices(m).any(|(i, _)| {
                let avant = l[..i].chars().last().map_or(true, |c| !(c.is_alphanumeric() || c == '_'));
                let apres = l[i + m.len()..].chars().next().map_or(true, |c| !(c.is_alphanumeric() || c == '_'));
                avant && apres
            })
        };
        let mut fautifs = Vec::new();
        for (rel, chemin) in &v {
            if AUTORISES.contains(&rel.as_str()) {
                continue;
            }
            for (n, l) in std::fs::read_to_string(chemin).unwrap().lines().enumerate() {
                let code = l.split("//").next().unwrap_or("");
                if ["localStorage", "sessionStorage", "indexedDB"].iter().any(|m| mot(code, m)) {
                    fautifs.push(format!("{rel}:{}", n + 1));
                }
            }
        }
        assert!(fautifs.is_empty(), "Stockage navigateur hors préférences du poste : {fautifs:?}. Enregistrez la donnée dans la base (document).");
        for a in AUTORISES {
            assert!(v.iter().any(|(r, _)| r == a), "{a} n'existe plus : retirez-le de AUTORISES");
        }
    }
}
