//! tooth_dentaire : stock et quotidien du cabinet dentaire.
//!
//! Le serveur (`serveur`) sert la page `web/` et l'API JSON `/api/…` ; toutes les données
//! du cabinet vivent dans la base SQLite `donnees/stock.db` (`base`).

pub mod base;
pub mod exports;
pub mod journal;
pub mod leveldb;
pub mod meteo;
pub mod migration;
pub mod mise_a_jour;
pub mod sauvegarde;
pub mod serveur;
pub mod signalements;

/// Un dossier neuf et vide pour un essai.
#[cfg(test)]
pub(crate) fn dossier_essai(nom: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("tooth-{}-{}-{}", nom, std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
