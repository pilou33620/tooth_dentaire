//! Journal du serveur : ce que l'outil affiche dans la console (démarrage, requêtes en erreur,
//! plantages) est aussi écrit dans donnees/journal_serveur.log, pour être joint aux signalements
//! de bug même après un redémarrage. Au-delà de 1 Mo, l'ancien journal devient
//! journal_serveur.log.1 (un seul gardé).

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub const TAILLE_MAX: u64 = 1024 * 1024;
pub const NOM: &str = "journal_serveur.log";

static FICHIER: OnceLock<(PathBuf, Mutex<File>)> = OnceLock::new();

/// Copie la console dans le journal. Sans écriture possible, la console seule reste.
pub fn demarrer(dossier: &Path) {
    if FICHIER.get().is_some() || std::fs::create_dir_all(dossier).is_err() {
        return;
    }
    let chemin = dossier.join(NOM);
    if std::fs::metadata(&chemin).is_ok_and(|m| m.is_file() && m.len() > TAILLE_MAX) {
        let _ = std::fs::rename(&chemin, dossier.join(format!("{NOM}.1")));
    }
    if let Ok(f) = OpenOptions::new().create(true).append(true).open(&chemin) {
        let _ = FICHIER.set((chemin, Mutex::new(f)));
    }
}

fn copier(texte: &str) {
    if let Some((_, f)) = FICHIER.get() {
        let mut f = f.lock().unwrap_or_else(|e| e.into_inner());
        let _ = writeln!(f, "{texte}");
    }
}

/// Affiche une ligne (stdout, vidé tout de suite : le launcher lit le code d'appairage) et la
/// copie dans le journal.
pub fn dire(texte: &str) {
    println!("{texte}");
    let _ = std::io::stdout().flush();
    copier(texte);
}

/// Idem sur la sortie d'erreur.
pub fn erreur(texte: &str) {
    eprintln!("{texte}");
    copier(texte);
}

/// Les n dernières lignes du journal ("" s'il n'y en a pas).
pub fn dernieres_lignes(n: usize, chemin: Option<&Path>) -> String {
    let Some(chemin) = chemin.map(Path::to_path_buf).or_else(|| FICHIER.get().map(|(c, _)| c.clone())) else {
        return String::new();
    };
    let Ok(mut f) = File::open(&chemin) else { return String::new() };
    // les 64 derniers Ko suffisent
    let taille = f.seek(SeekFrom::End(0)).unwrap_or(0);
    if f.seek(SeekFrom::Start(taille.saturating_sub(64 * 1024))).is_err() {
        return String::new();
    }
    let mut brut = Vec::new();
    if f.read_to_end(&mut brut).is_err() {
        return String::new();
    }
    let texte = String::from_utf8_lossy(&brut);
    let lignes: Vec<&str> = texte.lines().collect();
    lignes[lignes.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod essais {
    use super::*;

    #[test]
    fn journal_serveur_garde_la_fin() {
        let d = crate::dossier_essai("journal");
        let chemin = d.join(NOM);
        let texte: String = (0..500).map(|i| format!("ligne {i}\n")).collect();
        std::fs::write(&chemin, texte).unwrap();
        assert_eq!(dernieres_lignes(3, Some(&chemin)), "ligne 497\nligne 498\nligne 499");
        assert_eq!(dernieres_lignes(3, Some(&d.join("absent.log"))), "");
    }
}
