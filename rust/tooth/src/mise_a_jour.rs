//! Mises à jour de l'outil depuis GitHub (dossier installé par « git clone »).
//!
//! - Au démarrage, avant que le serveur ne se lance, la mise à jour éventuelle est installée
//!   d'office ; l'outil sort alors avec le code 75 et `lancer.sh` (ou `Lancer.bat`) reprend
//!   l'exécutable de la nouvelle version puis le relance.
//! - Ensuite, toutes les 4 heures, le serveur fait un « git fetch » de la branche suivie (main)
//!   et retient s'il existe des commits plus récents.
//! - Les postes demandent l'état (GET /api/mise-a-jour) et proposent la mise à jour ; si
//!   quelqu'un accepte, le serveur avance la copie locale (« git merge --ff-only », jamais de
//!   fusion ni d'écrasement), puis redémarre.
//! - La base (dossier donnees/, exclu de git) n'est jamais touchée.
//!
//! Une installation qui n'est pas un clone git, une autre branche, ou des fichiers modifiés à la
//! main sur le poste : rien n'est proposé, et la raison est affichée dans les Réglages.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::base::{Erreur, Res};
use crate::journal;

pub const BRANCHE: &str = "main";
pub const DISTANT: &str = "origin";
pub const INTERVALLE: u64 = 4 * 60 * 60; // s : une vérification toutes les 4 heures
pub const PREMIERE_VERIFICATION: u64 = 60; // s après le démarrage
pub const DELAI_GIT: u64 = 120; // s
pub const DELAI_DEMARRAGE: u64 = 20; // s : sans internet, l'outil démarre quand même vite

#[derive(Clone, Default)]
struct Etat {
    disponible: bool,
    nouveautes: Vec<String>, // titres des commits à venir (10 au plus)
    nombre: u64,
    version_locale: String,
    version_distante: String,
    verifie_le: Option<f64>, // secondes depuis l'époque
    raison: Option<String>,  // pourquoi rien n'est proposé, ou rien
    en_cours: bool,
}

pub struct MiseAJour {
    racine: PathBuf,
    etat: Mutex<Etat>,
    /// Une mise à jour vient d'être installée : l'outil doit redémarrer.
    pub redemarrer: AtomicBool,
}

fn maintenant() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn court(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn refus<T>(m: impl Into<String>) -> Res<T> {
    Err(Erreur::MiseAJour(m.into()))
}

impl MiseAJour {
    pub fn new(racine: &Path) -> MiseAJour {
        MiseAJour { racine: racine.to_path_buf(), etat: Mutex::new(Etat::default()), redemarrer: AtomicBool::new(false) }
    }

    fn lire(&self) -> std::sync::MutexGuard<'_, Etat> {
        self.etat.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// git portable (MinGit) posé par installation/Installer.bat sur les postes Windows sans git ;
    /// sinon le git du PATH.
    pub fn commande_git(&self) -> PathBuf {
        let portable = self.racine.join(".mingit").join("cmd").join("git.exe");
        if portable.is_file() {
            portable
        } else {
            PathBuf::from("git")
        }
    }

    /// Lance git et rend sa sortie. Jamais d'attente sans fin : au-delà de `delai`, git est arrêté.
    pub fn git(&self, args: &[&str], delai: u64) -> Res<String> {
        let mut enfant = match Command::new(self.commande_git())
            .args(args)
            .current_dir(&self.racine)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return refus("git n'est pas installé sur ce poste."),
            Err(e) => return refus(format!("git {} : {e}", args[0])),
        };
        let lire = |flux: Option<Box<dyn Read + Send>>| {
            std::thread::spawn(move || {
                let mut t = Vec::new();
                if let Some(mut f) = flux {
                    let _ = f.read_to_end(&mut t);
                }
                String::from_utf8_lossy(&t).into_owned()
            })
        };
        let sortie = lire(enfant.stdout.take().map(|f| Box::new(f) as Box<dyn Read + Send>));
        let erreurs = lire(enfant.stderr.take().map(|f| Box::new(f) as Box<dyn Read + Send>));
        let fin = Instant::now() + Duration::from_secs(delai);
        let statut = loop {
            match enfant.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if Instant::now() < fin => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = enfant.kill();
                    let _ = enfant.wait();
                    break None;
                }
            }
        };
        let (sortie, erreurs) = (sortie.join().unwrap_or_default(), erreurs.join().unwrap_or_default());
        match statut {
            None => refus("git ne répond pas (pas d'internet ?)."),
            Some(s) if s.success() => Ok(sortie.trim().to_string()),
            Some(_) => {
                let message = if erreurs.trim().is_empty() { &sortie } else { &erreurs };
                let derniere = message.trim().lines().last().unwrap_or("échec").to_string();
                refus(format!("git {} : {derniere}", args[0]))
            }
        }
    }

    /// Fichiers suivis par git modifiés sur ce poste (la base, ignorée, n'en fait pas partie).
    fn modifications_locales(&self) -> Res<Vec<String>> {
        let l = self.git(&["status", "--porcelain", "--untracked-files=no"], DELAI_GIT)?;
        Ok(l.lines().filter(|x| !x.trim().is_empty()).map(|x| x.get(3..).unwrap_or("").to_string()).collect())
    }

    pub fn etat(&self) -> Value {
        let e = self.lire();
        json!({
            "disponible": e.disponible,
            "nouveautes": e.nouveautes,
            "nombre": e.nombre,
            "version_locale": e.version_locale,
            "version_distante": e.version_distante,
            "verifie_le": e.verifie_le,
            "raison": e.raison,
            "en_cours": e.en_cours,
        })
    }

    pub fn version_locale(&self) -> String {
        self.lire().version_locale.clone()
    }

    /// Interroge GitHub et met à jour l'état. Ne rend jamais d'erreur : sans internet, l'outil
    /// continue de tourner et réessaiera 4 heures plus tard.
    pub fn verifier(&self, delai: u64) -> Value {
        let quand = maintenant();
        let distante = format!("{DISTANT}/{BRANCHE}");
        let entre = format!("HEAD..{distante}");
        let r = (|| -> Res<()> {
            if !self.racine.join(".git").exists() {
                return refus("Ce dossier n'est pas un clone git : mises à jour automatiques indisponibles.");
            }
            let branche = self.git(&["rev-parse", "--abbrev-ref", "HEAD"], DELAI_GIT)?;
            let locale = self.git(&["rev-parse", "HEAD"], DELAI_GIT)?;
            if branche != BRANCHE {
                return refus(format!(
                    "L'outil est sur la branche « {branche} » : seules les mises à jour de « {BRANCHE} » sont proposées."
                ));
            }
            self.git(&["fetch", "--quiet", DISTANT, BRANCHE], delai)?;
            let dist = self.git(&["rev-parse", &distante], DELAI_GIT)?;
            let nombre: u64 = self.git(&["rev-list", "--count", &entre], DELAI_GIT)?.parse().unwrap_or(0);
            let mut nouveautes = Vec::new();
            let mut raison = None;
            if nombre > 0 {
                let titres = self.git(&["log", "--format=%s", "-n", "10", &entre], DELAI_GIT)?;
                nouveautes = titres.lines().filter(|t| !t.trim().is_empty()).map(str::to_string).collect();
                if self.git(&["merge-base", "--is-ancestor", "HEAD", &distante], DELAI_GIT).is_err() {
                    raison = Some("La copie de ce poste contient des changements absents de GitHub : mise à jour à faire à la main.".to_string());
                }
            }
            let mut e = self.lire();
            e.disponible = nombre > 0 && raison.is_none();
            e.nombre = nombre;
            e.nouveautes = nouveautes;
            e.version_locale = court(&locale);
            e.version_distante = court(&dist);
            e.verifie_le = Some(quand);
            e.raison = raison;
            Ok(())
        })();
        if let Err(err) = r {
            let mut e = self.lire();
            e.disponible = false;
            e.nombre = 0;
            e.nouveautes = Vec::new();
            e.verifie_le = Some(quand);
            e.raison = Some(err.to_string());
        }
        self.etat()
    }

    /// Thread de fond : une vérification peu après le démarrage, puis toutes les 4 heures.
    pub fn demarrer_verifications(self: Arc<Self>) {
        let v = self.git(&["rev-parse", "HEAD"], DELAI_GIT).map(|s| court(&s)).unwrap_or_default();
        self.lire().version_locale = v;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(PREMIERE_VERIFICATION));
            while !self.redemarrer.load(Ordering::SeqCst) {
                self.verifier(DELAI_GIT);
                std::thread::sleep(Duration::from_secs(INTERVALLE));
            }
        });
    }

    /// Avance la copie locale jusqu'à origin/main puis demande le redémarrage. Refuse plutôt que
    /// de risquer d'écraser quoi que ce soit.
    pub fn installer(&self, delai: u64) -> Res<Value> {
        {
            let mut e = self.lire();
            if e.en_cours {
                return refus("Une mise à jour est déjà en cours.");
            }
            e.en_cours = true;
        }
        let r = (|| -> Res<Value> {
            let courant = self.verifier(delai);
            if courant["disponible"] != true {
                return refus(courant["raison"].as_str().unwrap_or("L'outil est déjà à jour.").to_string());
            }
            let modifies = self.modifications_locales()?;
            if !modifies.is_empty() {
                let liste: Vec<&str> = modifies.iter().take(5).map(String::as_str).collect();
                return refus(format!(
                    "Des fichiers de l'outil ont été modifiés sur ce poste ({}) : mise à jour annulée pour ne rien écraser.",
                    liste.join(", ")
                ));
            }
            let distante = format!("{DISTANT}/{BRANCHE}");
            let avant = self.git(&["rev-parse", "HEAD"], DELAI_GIT)?;
            self.git(&["merge", "--ff-only", "--quiet", &distante], DELAI_GIT)?;
            let apres = self.git(&["rev-parse", "HEAD"], DELAI_GIT)?;
            let changes = self.git(&["diff", "--name-only", &avant, &apres], DELAI_GIT)?;
            {
                let mut e = self.lire();
                e.disponible = false;
                e.nombre = 0;
                e.nouveautes = Vec::new();
                e.version_locale = court(&apres);
                e.raison = None;
            }
            self.redemarrer.store(true, Ordering::SeqCst);
            Ok(json!({"avant": court(&avant), "apres": court(&apres), "fichiers": changes.lines().count()}))
        })();
        self.lire().en_cours = false;
        r
    }

    /// Installe la mise à jour éventuelle avant le démarrage du serveur. Vrai si une version a
    /// été installée ; sans internet, ou si rien n'est à faire, l'outil démarre normalement.
    pub fn au_demarrage(&self) -> bool {
        journal::dire("[*] Recherche de mises a jour...");
        match self.installer(DELAI_DEMARRAGE) {
            Ok(r) => {
                journal::dire(&format!("[*] Mise a jour installee ({} -> {}).", texte(&r["avant"]), texte(&r["apres"])));
                true
            }
            Err(e) => {
                journal::dire(&format!("[*] Mise a jour : {e}"));
                false
            }
        }
    }
}

fn texte(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

#[cfg(test)]
mod essais {
    use super::*;

    fn run(dossier: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(args)
            .current_dir(dossier)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?} : {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// Un développeur pousse un changement sur GitHub (le dépôt « origine »).
    fn publier(dev: &Path, nom: &str, t: &str, message: &str) {
        std::fs::write(dev.join(nom), t).unwrap();
        run(dev, &["add", nom]);
        run(dev, &["commit", "-q", "-m", message]);
        run(dev, &["push", "-q", "origin", "main"]);
    }

    /// (dev, poste) : un dépôt « GitHub » nu, la copie du développeur, celle du cabinet.
    fn depots() -> (PathBuf, PathBuf) {
        let d = crate::dossier_essai("maj");
        let origine = d.join("github.git");
        let (dev, poste) = (d.join("dev"), d.join("cabinet"));
        run(&d, &["init", "-q", "--bare", "-b", "main", origine.to_str().unwrap()]);
        run(&d, &["clone", "-q", origine.to_str().unwrap(), dev.to_str().unwrap()]);
        run(&dev, &["checkout", "-q", "-b", "main"]);
        std::fs::write(dev.join(".gitignore"), "donnees/\n").unwrap();
        run(&dev, &["add", ".gitignore"]);
        publier(&dev, "serveur.txt", "v1\n", "Première version");
        run(&d, &["clone", "-q", origine.to_str().unwrap(), poste.to_str().unwrap()]);
        std::fs::create_dir_all(poste.join("donnees")).unwrap();
        std::fs::write(poste.join("donnees").join("stock.db"), "base du cabinet").unwrap();
        (dev, poste)
    }

    fn lire(p: &Path) -> String {
        std::fs::read_to_string(p).unwrap()
    }

    #[test]
    fn a_jour() {
        let (_, poste) = depots();
        let e = MiseAJour::new(&poste).verifier(DELAI_GIT);
        assert_eq!((e["disponible"].clone(), e["raison"].clone(), e["nombre"].clone()), (json!(false), Value::Null, json!(0)));
        assert!(e["verifie_le"].is_number());
    }

    #[test]
    fn nouvelle_version_detectee() {
        let (dev, poste) = depots();
        publier(&dev, "serveur.txt", "v2\n", "Correctif du post-it");
        publier(&dev, "notes.txt", "x\n", "Ne plus commander");
        let e = MiseAJour::new(&poste).verifier(DELAI_GIT);
        assert_eq!((e["disponible"].clone(), e["nombre"].clone()), (json!(true), json!(2)));
        assert_eq!(e["nouveautes"], json!(["Ne plus commander", "Correctif du post-it"]));
    }

    #[test]
    fn installation_avance_la_copie_et_garde_la_base() {
        let (dev, poste) = depots();
        publier(&dev, "serveur.txt", "v2\n", "Correctif");
        let m = MiseAJour::new(&poste);
        let r = m.installer(DELAI_GIT).unwrap();
        assert_eq!(lire(&poste.join("serveur.txt")), "v2\n");
        assert_eq!(lire(&poste.join("donnees").join("stock.db")), "base du cabinet");
        assert_eq!(r["fichiers"], 1);
        assert!(m.redemarrer.load(Ordering::SeqCst));
        assert_eq!(m.verifier(DELAI_GIT)["disponible"], false);
    }

    #[test]
    fn rien_a_installer() {
        let (_, poste) = depots();
        let m = MiseAJour::new(&poste);
        assert!(matches!(m.installer(DELAI_GIT), Err(Erreur::MiseAJour(t)) if t.contains("déjà à jour")));
        assert!(!m.redemarrer.load(Ordering::SeqCst));
        assert!(!m.au_demarrage());
    }

    #[test]
    fn fichier_modifie_sur_le_poste_bloque_la_mise_a_jour() {
        let (dev, poste) = depots();
        publier(&dev, "serveur.txt", "v2\n", "Correctif");
        std::fs::write(poste.join("serveur.txt"), "retouche locale\n").unwrap();
        let m = MiseAJour::new(&poste);
        assert!(matches!(m.installer(DELAI_GIT), Err(Erreur::MiseAJour(t)) if t.contains("modifiés sur ce poste")));
        assert_eq!(lire(&poste.join("serveur.txt")), "retouche locale\n");
        assert!(!m.redemarrer.load(Ordering::SeqCst));
    }

    #[test]
    fn historique_divergent_ou_autre_branche_non_proposes() {
        let (dev, poste) = depots();
        publier(&dev, "serveur.txt", "v2\n", "Sur GitHub");
        std::fs::write(poste.join("local.txt"), "x\n").unwrap();
        run(&poste, &["add", "local.txt"]);
        run(&poste, &["commit", "-q", "-m", "Commit fait sur le poste"]);
        let e = MiseAJour::new(&poste).verifier(DELAI_GIT);
        assert_eq!(e["disponible"], false);
        assert!(e["raison"].as_str().unwrap().contains("à la main"));
        run(&poste, &["checkout", "-q", "-b", "essai"]);
        let e = MiseAJour::new(&poste).verifier(DELAI_GIT);
        assert_eq!(e["disponible"], false);
        assert!(e["raison"].as_str().unwrap().contains("essai"));
    }

    #[test]
    fn dossier_qui_n_est_pas_un_clone() {
        let e = MiseAJour::new(&crate::dossier_essai("pas-git")).verifier(DELAI_GIT);
        assert_eq!(e["disponible"], false);
        assert!(e["raison"].as_str().unwrap().contains("clone git"));
    }

    #[test]
    fn git_portable_prioritaire() {
        let d = crate::dossier_essai("mingit");
        let m = MiseAJour::new(&d);
        assert_eq!(m.commande_git(), PathBuf::from("git"));
        std::fs::create_dir_all(d.join(".mingit").join("cmd")).unwrap();
        std::fs::write(d.join(".mingit").join("cmd").join("git.exe"), "").unwrap();
        assert_eq!(m.commande_git(), d.join(".mingit").join("cmd").join("git.exe"));
    }

    #[test]
    fn sans_internet() {
        let (_, poste) = depots();
        let ailleurs = poste.join("introuvable");
        run(&poste, &["remote", "set-url", "origin", ailleurs.to_str().unwrap()]);
        let m = MiseAJour::new(&poste);
        let e = m.verifier(DELAI_GIT);
        assert_eq!(e["disponible"], false);
        assert!(e["raison"].as_str().is_some_and(|r| !r.is_empty()));
        assert!(!m.au_demarrage());
    }

    #[test]
    fn au_demarrage_installe_la_nouvelle_version() {
        let (dev, poste) = depots();
        publier(&dev, "serveur.txt", "v2\n", "Correctif");
        let m = MiseAJour::new(&poste);
        assert!(m.au_demarrage());
        assert_eq!(lire(&poste.join("serveur.txt")), "v2\n");
        assert!(m.redemarrer.load(Ordering::SeqCst));
    }
}
