//! Sauvegarde automatique de la base (stock.db).
//!
//! Une copie par jour dans le dossier « sauvegardes » à côté de la base :
//!
//!     donnees/stock.db
//!     donnees/sauvegardes/stock-20261004-083012.db
//!
//! La copie passe par l'API de sauvegarde de SQLite : elle est cohérente même si un poste
//! enregistre au même moment, contrairement à une simple copie du fichier.
//!
//! Conservation : la copie la plus récente de chacun des GARDER derniers jours, plus les
//! GARDER_RECENTES dernières copies. Des clics répétés sur « Sauvegarder maintenant » ne
//! remplacent donc que des copies du jour : ils n'effacent pas l'historique des jours précédents.
//!
//! Restaurer : arrêter le serveur, remplacer stock.db par la copie voulue (renommée en
//! stock.db), relancer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::NaiveDateTime;
use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde_json::{json, Value};

use crate::base::{absolu, Base, Erreur, Res};
use crate::journal;

pub const GARDER: usize = 30; // jours conservés (une copie par jour)
pub const GARDER_RECENTES: usize = 5; // dernières copies gardées en plus, quel que soit le jour
pub const INTERVALLE: i64 = 24 * 3600; // une copie par 24 h
pub const VERIFICATION: u64 = 3600; // le fil se réveille toutes les heures
pub const NOM_DOSSIER: &str = "sauvegardes";

// Une copie à la fois : le bouton et la copie quotidienne peuvent tomber dans la même seconde,
// donc sur le même nom de fichier.
static VERROU_COPIE: Mutex<()> = Mutex::new(());

pub struct Copie {
    pub nom: String,
    pub chemin: PathBuf,
    pub date: NaiveDateTime,
    pub taille: u64,
}

impl Copie {
    /// La description rendue aux postes : sans le chemin disque.
    pub fn json(&self) -> Value {
        json!({"nom": self.nom, "date": self.date.format("%Y-%m-%dT%H:%M:%S").to_string(), "taille": self.taille})
    }
}

pub fn maintenant() -> NaiveDateTime {
    chrono::Local::now().naive_local()
}

pub fn dossier_sauvegardes(chemin_base: &Path) -> PathBuf {
    absolu(chemin_base).parent().map(Path::to_path_buf).unwrap_or_default().join(NOM_DOSSIER)
}

/// La date d'un nom « stock-AAAAMMJJ-HHMMSS.db », sinon rien.
fn date_du_nom(nom: &str) -> Option<NaiveDateTime> {
    let milieu = nom.strip_prefix("stock-")?.strip_suffix(".db")?;
    let b = milieu.as_bytes();
    let forme = b.len() == 15 && b[8] == b'-' && b.iter().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit());
    if !forme {
        return None;
    }
    NaiveDateTime::parse_from_str(milieu, "%Y%m%d-%H%M%S").ok()
}

/// Sauvegardes présentes, de la plus récente à la plus ancienne.
pub fn lister(dossier: &Path) -> Vec<Copie> {
    let Ok(entrees) = std::fs::read_dir(dossier) else { return Vec::new() };
    let mut copies: Vec<Copie> = entrees
        .flatten()
        .filter_map(|e| {
            let nom = e.file_name().to_string_lossy().into_owned();
            let date = date_du_nom(&nom)?;
            let taille = e.metadata().ok()?.len();
            Some(Copie { chemin: e.path(), nom, date, taille })
        })
        .collect();
    copies.sort_by(|a, b| b.nom.cmp(&a.nom));
    copies
}

/// Copie cohérente de la base ; rend la description de la copie.
pub fn sauvegarder(base: &Base, dossier: Option<&Path>, garder: usize, quand: NaiveDateTime) -> Res<Copie> {
    let chemin_base = base.chemin();
    if !chemin_base.is_file() {
        return Err(Erreur::Donnees("Base introuvable : rien a sauvegarder.".into()));
    }
    let dossier = dossier.map(Path::to_path_buf).unwrap_or_else(|| dossier_sauvegardes(&chemin_base));
    let io = |e: std::io::Error| Erreur::Interne(e.to_string());
    std::fs::create_dir_all(&dossier).map_err(io)?;
    let nom = format!("stock-{}.db", quand.format("%Y%m%d-%H%M%S"));
    let fin = dossier.join(&nom);
    let temporaire = dossier.join(format!("{nom}.partiel"));

    let _copie = VERROU_COPIE.lock().unwrap_or_else(|e| e.into_inner());
    let faite = (|| -> Res<()> {
        {
            // Sous le verrou d'écriture : aucun poste n'écrit pendant la copie (quelques ms).
            let _g = base.verrouiller();
            let source = Connection::open(&chemin_base)?;
            source.busy_timeout(Duration::from_secs(15))?;
            let mut cible = Connection::open(&temporaire)?;
            let copie = Backup::new(&source, &mut cible)?;
            copie.run_to_completion(-1, Duration::ZERO, None)?;
        }
        std::fs::rename(&temporaire, &fin).map_err(io)
    })();
    if let Err(e) = faite {
        // copie interrompue (disque plein…) : pas de fichier partiel laissé
        let _ = std::fs::remove_file(&temporaire);
        return Err(e);
    }
    nettoyer(&dossier, garder);
    let taille = std::fs::metadata(&fin).map(|m| m.len()).unwrap_or(0);
    Ok(Copie { nom, chemin: fin, date: quand, taille })
}

/// Garde la dernière copie de chacun des `garder` derniers jours, plus les
/// min(GARDER_RECENTES, garder) dernières copies ; supprime le reste.
fn nettoyer(dossier: &Path, garder: usize) {
    let garder = garder.max(1);
    let copies = lister(dossier);
    let mut gardees: HashSet<&str> = copies.iter().take(GARDER_RECENTES.min(garder)).map(|c| c.nom.as_str()).collect();
    let mut jours = HashSet::new();
    for c in &copies {
        let jour = &c.nom["stock-".len().."stock-AAAAMMJJ".len()];
        if !jours.contains(jour) && jours.len() < garder {
            jours.insert(jour);
            gardees.insert(c.nom.as_str());
        }
    }
    for c in &copies {
        if !gardees.contains(c.nom.as_str()) {
            let _ = std::fs::remove_file(&c.chemin);
        }
    }
}

/// Vrai s'il n'existe aucune copie de moins de INTERVALLE secondes.
pub fn sauvegarde_due(quand: NaiveDateTime, dossier: &Path) -> bool {
    let Some(c) = lister(dossier).into_iter().next() else { return true };
    let age = (quand - c.date).num_seconds();
    age >= INTERVALLE || age < 0
}

pub fn sauvegarder_si_du(base: &Base) {
    if !sauvegarde_due(maintenant(), &dossier_sauvegardes(&base.chemin())) {
        return;
    }
    match sauvegarder(base, None, GARDER, maintenant()) {
        Ok(c) => journal::dire(&format!("[*] Sauvegarde de la base : {}", c.chemin.display())),
        Err(e) => journal::dire(&format!("[!] Sauvegarde de la base impossible : {e}")),
    }
}

#[cfg(test)]
mod essais {
    use super::*;
    use crate::base::aides::{base_temp, produit};
    use chrono::NaiveDate;

    fn t(a: i32, m: u32, j: u32, h: u32, mi: u32, s: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(a, m, j).unwrap().and_hms_opt(h, mi, s).unwrap()
    }

    fn noms(b: &Base) -> Vec<String> {
        lister(&dossier_sauvegardes(&b.chemin())).into_iter().map(|c| c.nom).collect()
    }

    #[test]
    fn copie_lisible_et_complete() {
        let (b, chemin) = base_temp();
        b.update_produit(&produit("REF1", json!({}))).unwrap();
        let c = sauvegarder(&b, None, GARDER, maintenant()).unwrap();
        assert_eq!(c.chemin.parent().unwrap(), chemin.parent().unwrap().join("sauvegardes"));
        let conn = Connection::open(&c.chemin).unwrap();
        let r: String = conn.query_row("SELECT reference FROM produits", [], |l| l.get(0)).unwrap();
        assert_eq!(r, "REF1");
        let partiels = std::fs::read_dir(c.chemin.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".partiel")).count();
        assert_eq!(partiels, 0);
        assert!(c.json().get("chemin").is_none());
    }

    #[test]
    fn seules_les_plus_recentes_sont_gardees() {
        let (b, _) = base_temp();
        for i in 0..5 {
            sauvegarder(&b, None, 3, t(2026, 1, 1, 8, 0, 0) + chrono::Duration::days(i)).unwrap();
        }
        assert_eq!(noms(&b), ["stock-20260105-080000.db", "stock-20260104-080000.db", "stock-20260103-080000.db"]);
    }

    #[test]
    fn sauvegardes_manuelles_n_effacent_pas_les_jours_precedents() {
        // 30 jours de copies quotidiennes, puis 30 clics « Sauvegarder maintenant »
        let (b, _) = base_temp();
        for i in 0..30 {
            sauvegarder(&b, None, GARDER, t(2026, 9, 1, 8, 0, 0) + chrono::Duration::days(i)).unwrap();
        }
        for i in 0..30 {
            sauvegarder(&b, None, GARDER, t(2026, 10, 8, 9, 0, i)).unwrap();
        }
        let n = noms(&b);
        let jours: HashSet<&str> = n.iter().map(|x| &x[6..14]).collect();
        assert_eq!(jours.len(), 30); // 29 jours d'avant + aujourd'hui
        assert!(jours.contains("20260902") && jours.contains("20261008"));
        let du_jour: Vec<&String> = n.iter().filter(|x| x.starts_with("stock-20261008")).collect();
        let attendus: Vec<String> = (25..30).rev().map(|s| format!("stock-20261008-0900{s:02}.db")).collect();
        assert_eq!(du_jour, attendus.iter().collect::<Vec<_>>());
        assert_eq!(n.len(), 29 + GARDER_RECENTES);
    }

    #[test]
    fn une_copie_par_jour_la_plus_recente() {
        let (b, _) = base_temp();
        for h in [8, 12, 18] {
            sauvegarder(&b, None, 2, t(2026, 1, 1, h, 0, 0)).unwrap();
        }
        for h in [8, 12] {
            sauvegarder(&b, None, 2, t(2026, 1, 2, h, 0, 0)).unwrap();
        }
        sauvegarder(&b, None, 2, t(2026, 1, 3, 8, 0, 0)).unwrap();
        assert_eq!(noms(&b), ["stock-20260103-080000.db", "stock-20260102-120000.db"]);
    }

    #[test]
    fn deux_copies_dans_la_meme_seconde() {
        let (b, _) = base_temp();
        let b = std::sync::Arc::new(b);
        let fils: Vec<_> = (0..4)
            .map(|_| {
                let b = b.clone();
                std::thread::spawn(move || sauvegarder(&b, None, GARDER, t(2026, 1, 1, 8, 0, 0)).is_ok())
            })
            .collect();
        assert!(fils.into_iter().all(|f| f.join().unwrap()));
        assert_eq!(noms(&b), ["stock-20260101-080000.db"]);
    }

    #[test]
    fn fichiers_etrangers_ignores() {
        let (b, _) = base_temp();
        let d = dossier_sauvegardes(&b.chemin());
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a-garder.txt"), "x").unwrap();
        for i in 0..3 {
            sauvegarder(&b, None, 1, t(2026, 1, 1 + i, 0, 0, 0)).unwrap();
        }
        assert!(d.join("a-garder.txt").exists());
        assert_eq!(lister(&d).len(), 1);
    }

    #[test]
    fn sauvegarde_due_une_fois_par_jour() {
        let (b, _) = base_temp();
        let d = dossier_sauvegardes(&b.chemin());
        assert!(sauvegarde_due(maintenant(), &d));
        sauvegarder(&b, None, GARDER, maintenant() - chrono::Duration::hours(25)).unwrap();
        assert!(sauvegarde_due(maintenant(), &d));
        sauvegarder(&b, None, GARDER, maintenant()).unwrap();
        assert!(!sauvegarde_due(maintenant(), &d));
        // Horloge du poste reculée : une copie « dans le futur » ne bloque pas tout
        sauvegarder(&b, None, GARDER, maintenant() + chrono::Duration::days(3)).unwrap();
        assert!(sauvegarde_due(maintenant(), &d));
    }

    #[test]
    fn base_absente_refusee() {
        let (b, chemin) = base_temp();
        std::fs::remove_file(&chemin).unwrap();
        assert!(matches!(sauvegarder(&b, None, GARDER, maintenant()), Err(Erreur::Donnees(_))));
    }
}
