//! Lecteur LevelDB minimal.
//!
//! Sert à une seule chose : relire le localStorage de l'ancienne application PySide6, que
//! QtWebEngine (Chromium) range dans webstorage/Local Storage/leveldb. On y trouve le planning,
//! les tâches, les dosimètres, les rappels mire / fauteuils et le carnet d'adresses.
//!
//! Seule la lecture est gérée : tables .ldb (blocs bruts ou compressés Snappy) et journal .log.
//! Pour chaque clé, la valeur de plus grand numéro de séquence l'emporte ; une suppression
//! efface la clé.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub const TYPE_SUPPRESSION: u8 = 0;
pub const TYPE_VALEUR: u8 = 1;

pub type Resultat<T> = Result<T, String>;

/// d[a..a+n], borné à la fin des données (comme une tranche Python).
fn tranche(d: &[u8], a: usize, n: usize) -> &[u8] {
    let a = a.min(d.len());
    &d[a..a.saturating_add(n).min(d.len())]
}

fn octet(d: &[u8], i: usize) -> Resultat<u8> {
    d.get(i).copied().ok_or_else(|| "données LevelDB tronquées".to_string())
}

fn petit_boutiste(d: &[u8]) -> u64 {
    d.iter().rev().fold(0u64, |v, b| (v << 8) | *b as u64)
}

/// Lit un entier varint ; rend (valeur, position suivante).
fn varint(d: &[u8], mut pos: usize) -> Resultat<(u64, usize)> {
    let (mut v, mut decalage) = (0u64, 0u32);
    loop {
        let b = d.get(pos).copied().ok_or("varint tronqué")?;
        pos += 1;
        if decalage < 64 {
            v |= ((b & 0x7F) as u64) << decalage;
        }
        if b & 0x80 == 0 {
            return Ok((v, pos));
        }
        decalage += 7;
    }
}

fn varint_usize(d: &[u8], pos: usize) -> Resultat<(usize, usize)> {
    let (v, p) = varint(d, pos)?;
    Ok((usize::try_from(v).map_err(|_| "varint trop grand")?, p))
}

/// Décompression Snappy (format brut, sans cadre).
pub fn decompresser_snappy(d: &[u8]) -> Resultat<Vec<u8>> {
    let (taille, mut pos) = varint_usize(d, 0)?;
    let mut sortie: Vec<u8> = Vec::with_capacity(taille.min(64 * 1024 * 1024));
    while pos < d.len() {
        let tag = d[pos];
        pos += 1;
        let (longueur, distance) = match tag & 3 {
            0 => {
                // littéral
                let mut longueur = (tag >> 2) as usize;
                if longueur >= 60 {
                    let nb = longueur - 59;
                    longueur = petit_boutiste(tranche(d, pos, nb)) as usize;
                    pos += nb;
                }
                longueur += 1;
                sortie.extend_from_slice(tranche(d, pos, longueur));
                pos += longueur;
                continue;
            }
            1 => {
                let l = 4 + ((tag >> 2) & 7) as usize;
                let dist = (((tag >> 5) as usize) << 8) | octet(d, pos)? as usize;
                pos += 1;
                (l, dist)
            }
            2 => {
                let dist = petit_boutiste(tranche(d, pos, 2)) as usize;
                pos += 2;
                ((tag >> 2) as usize + 1, dist)
            }
            _ => {
                let dist = petit_boutiste(tranche(d, pos, 4)) as usize;
                pos += 4;
                ((tag >> 2) as usize + 1, dist)
            }
        };
        if distance == 0 || distance > sortie.len() {
            return Err("copie Snappy hors limites".into());
        }
        let debut = sortie.len() - distance;
        for i in 0..longueur {
            // recouvrement possible
            let b = sortie[debut + i];
            sortie.push(b);
        }
    }
    if sortie.len() != taille {
        return Err("taille Snappy incohérente".into());
    }
    Ok(sortie)
}

fn lire_bloc(fichier: &[u8], offset: usize, taille: usize) -> Resultat<Vec<u8>> {
    let brut = tranche(fichier, offset, taille);
    match octet(fichier, offset.saturating_add(taille))? {
        0 => Ok(brut.to_vec()),
        1 => decompresser_snappy(brut),
        c => Err(format!("compression de bloc non gérée : {c}")),
    }
}

/// (clé, valeur) d'un bloc de table (clés à préfixe partagé).
fn entrees_bloc(bloc: &[u8]) -> Resultat<Vec<(Vec<u8>, Vec<u8>)>> {
    if bloc.len() < 4 {
        return Ok(Vec::new());
    }
    let nb_restarts = petit_boutiste(&bloc[bloc.len() - 4..]) as usize;
    let fin = (bloc.len() - 4).saturating_sub(nb_restarts.saturating_mul(4));
    let (mut pos, mut cle, mut v) = (0, Vec::new(), Vec::new());
    while pos < fin {
        let (partage, p) = varint_usize(bloc, pos)?;
        let (propre, p) = varint_usize(bloc, p)?;
        let (taille_val, p) = varint_usize(bloc, p)?;
        cle.truncate(partage);
        cle.extend_from_slice(tranche(bloc, p, propre));
        pos = p.saturating_add(propre);
        let valeur = tranche(bloc, pos, taille_val).to_vec();
        pos = pos.saturating_add(taille_val);
        v.push((cle.clone(), valeur));
    }
    Ok(v)
}

type Entree = (Vec<u8>, u64, u8, Vec<u8>); // (clé utilisateur, séquence, type, valeur)

/// Les entrées d'un fichier .ldb.
pub fn lire_table(chemin: &Path) -> Resultat<Vec<Entree>> {
    let d = std::fs::read(chemin).map_err(|e| e.to_string())?;
    if d.len() < 48 {
        return Err(format!("table trop courte : {}", chemin.display()));
    }
    let pied = &d[d.len() - 48..];
    let (_meta_off, p) = varint_usize(pied, 0)?;
    let (_meta_taille, p) = varint_usize(pied, p)?;
    let (index_off, p) = varint_usize(pied, p)?;
    let (index_taille, _) = varint_usize(pied, p)?;
    let mut v = Vec::new();
    for (_cle, poignee) in entrees_bloc(&lire_bloc(&d, index_off, index_taille)?)? {
        let (off, q) = varint_usize(&poignee, 0)?;
        let (taille, _) = varint_usize(&poignee, q)?;
        for (interne, valeur) in entrees_bloc(&lire_bloc(&d, off, taille)?)? {
            if interne.len() < 8 {
                continue;
            }
            let trailer = petit_boutiste(&interne[interne.len() - 8..]);
            v.push((interne[..interne.len() - 8].to_vec(), trailer >> 8, (trailer & 0xFF) as u8, valeur));
        }
    }
    Ok(v)
}

/// Réassemble les enregistrements logiques d'un journal .log.
fn enregistrements_journal(d: &[u8]) -> Vec<Vec<u8>> {
    const BLOC: usize = 32768;
    let (mut pos, mut tampon, mut v) = (0, Vec::new(), Vec::new());
    while pos + 7 <= d.len() {
        let reste_bloc = BLOC - (pos % BLOC);
        if reste_bloc < 7 {
            pos += reste_bloc;
            continue;
        }
        let longueur = petit_boutiste(&d[pos + 4..pos + 6]) as usize;
        let genre = d[pos + 6];
        let charge = tranche(d, pos + 7, longueur);
        pos += 7 + longueur;
        match genre {
            0 if longueur == 0 => continue, // remplissage
            1 => {
                v.push(charge.to_vec()); // FULL
                tampon.clear();
            }
            2 => tampon = charge.to_vec(),          // FIRST
            3 => tampon.extend_from_slice(charge), // MIDDLE
            4 => {
                tampon.extend_from_slice(charge); // LAST
                v.push(std::mem::take(&mut tampon));
            }
            _ => {}
        }
    }
    v
}

/// Les entrées des lots d'écriture d'un .log.
pub fn lire_journal(chemin: &Path) -> Resultat<Vec<Entree>> {
    let d = std::fs::read(chemin).map_err(|e| e.to_string())?;
    let mut v = Vec::new();
    for lot in enregistrements_journal(&d) {
        if lot.len() < 12 {
            continue;
        }
        let sequence = petit_boutiste(&lot[..8]);
        let nombre = petit_boutiste(&lot[8..12]);
        let mut pos = 12;
        for i in 0..nombre {
            if pos >= lot.len() {
                break;
            }
            let genre = lot[pos];
            pos += 1;
            let (taille, p) = varint_usize(&lot, pos)?;
            let cle = tranche(&lot, p, taille).to_vec();
            pos = p.saturating_add(taille);
            let mut valeur = Vec::new();
            if genre == TYPE_VALEUR {
                let (taille, p) = varint_usize(&lot, pos)?;
                valeur = tranche(&lot, p, taille).to_vec();
                pos = p.saturating_add(taille);
            }
            v.push((cle, sequence.wrapping_add(i), genre, valeur));
        }
    }
    Ok(v)
}

/// État final {clé: valeur} d'une base LevelDB (tables puis journaux).
pub fn lire_base(dossier: &Path) -> Resultat<HashMap<Vec<u8>, Vec<u8>>> {
    let mut noms: Vec<String> = std::fs::read_dir(dossier)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    noms.sort();
    let mut meilleur: HashMap<Vec<u8>, (u64, u8, Vec<u8>)> = HashMap::new();
    for nom in noms {
        let chemin = dossier.join(&nom);
        let source = if nom.ends_with(".ldb") || nom.ends_with(".sst") {
            lire_table(&chemin)?
        } else if nom.ends_with(".log") && nom.starts_with(|c: char| c.is_ascii_digit()) {
            lire_journal(&chemin)?
        } else {
            continue;
        };
        for (cle, sequence, genre, valeur) in source {
            if meilleur.get(&cle).map_or(true, |a| sequence >= a.0) {
                meilleur.insert(cle, (sequence, genre, valeur));
            }
        }
    }
    Ok(meilleur.into_iter().filter(|(_, (_, g, _))| *g == TYPE_VALEUR).map(|(k, (_, _, v))| (k, v)).collect())
}

/// Décode une chaîne Chromium : 1er octet 0 = UTF-16LE, 1 = Latin-1.
fn texte_chromium(brut: &[u8]) -> String {
    match brut.first() {
        None => String::new(),
        Some(0) => {
            let unites: Vec<u16> = brut[1..].chunks(2).map(|c| if c.len() == 2 { u16::from_le_bytes([c[0], c[1]]) } else { 0xFFFD }).collect();
            char::decode_utf16(unites).map(|r| r.unwrap_or('\u{FFFD}')).collect()
        }
        Some(1) => brut[1..].iter().map(|b| *b as char).collect(),
        _ => String::from_utf8_lossy(brut).into_owned(),
    }
}

/// localStorage d'un profil Chromium : {origine: {clé: valeur}}.
///
/// Les clés de données ont la forme « _<origine>\x00<clé encodée> ». `origine` filtre sur une
/// origine précise (ex. « app: »).
pub fn lire_local_storage(dossier: &Path, origine: Option<&str>) -> Resultat<BTreeMap<String, BTreeMap<String, String>>> {
    let mut r: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for (cle, valeur) in lire_base(dossier)? {
        if !cle.starts_with(b"_") {
            continue; // META:, VERSION…
        }
        let Some(sep) = cle.iter().position(|b| *b == 0) else { continue };
        let orig = String::from_utf8_lossy(&cle[1..sep]).into_owned();
        if origine.is_some_and(|o| o != orig) {
            continue;
        }
        r.entry(orig).or_default().insert(texte_chromium(&cle[sep + 1..]), texte_chromium(&valeur));
    }
    Ok(r)
}

#[cfg(test)]
pub(crate) mod fabrique {
    //! Fabrication de fichiers LevelDB minimaux pour les essais.
    use std::path::Path;

    pub fn varint(mut n: u64) -> Vec<u8> {
        let mut s = Vec::new();
        loop {
            let b = (n & 0x7F) as u8;
            n >>= 7;
            if n > 0 {
                s.push(b | 0x80);
            } else {
                s.push(b);
                return s;
            }
        }
    }

    pub fn cle_ls(cle: &str, origine: &[u8]) -> Vec<u8> {
        let mut v = vec![b'_'];
        v.extend_from_slice(origine);
        v.extend_from_slice(b"\x00\x01");
        v.extend(cle.chars().map(|c| c as u8));
        v
    }

    pub fn valeur_ls(t: &str) -> Vec<u8> {
        if t.chars().all(|c| (c as u32) < 256) {
            let mut v = vec![1];
            v.extend(t.chars().map(|c| c as u8));
            v
        } else {
            let mut v = vec![0];
            v.extend(t.encode_utf16().flat_map(u16::to_le_bytes));
            v
        }
    }

    /// entrées : [(clé, valeur ou rien pour une suppression)].
    pub fn ecrire_journal(chemin: &Path, entrees: &[(Vec<u8>, Option<Vec<u8>>)], sequence: u64) {
        let mut lot = sequence.to_le_bytes().to_vec();
        lot.extend((entrees.len() as u32).to_le_bytes());
        for (cle, valeur) in entrees {
            match valeur {
                None => {
                    lot.push(0);
                    lot.extend(varint(cle.len() as u64));
                    lot.extend(cle);
                }
                Some(v) => {
                    lot.push(1);
                    lot.extend(varint(cle.len() as u64));
                    lot.extend(cle);
                    lot.extend(varint(v.len() as u64));
                    lot.extend(v);
                }
            }
        }
        let mut e = vec![0, 0, 0, 0];
        e.extend((lot.len() as u16).to_le_bytes());
        e.push(1);
        e.extend(lot);
        std::fs::write(chemin, e).unwrap();
    }

    fn bloc(entrees: &[(Vec<u8>, Vec<u8>)]) -> Vec<u8> {
        let mut c = Vec::new();
        for (cle, v) in entrees {
            c.extend(varint(0));
            c.extend(varint(cle.len() as u64));
            c.extend(varint(v.len() as u64));
            c.extend(cle);
            c.extend(v);
        }
        c.extend(0u32.to_le_bytes());
        c.extend(1u32.to_le_bytes()); // un point de redémarrage
        c
    }

    /// Table .ldb non compressée : [(clé utilisateur, valeur)].
    pub fn ecrire_table(chemin: &Path, entrees: &[(Vec<u8>, Vec<u8>)], sequence: u64) {
        let mut triees = entrees.to_vec();
        triees.sort();
        let internes: Vec<(Vec<u8>, Vec<u8>)> = triees
            .into_iter()
            .enumerate()
            .map(|(i, (mut cle, v))| {
                cle.extend((((sequence + i as u64) << 8) | 1).to_le_bytes());
                (cle, v)
            })
            .collect();
        let donnees = bloc(&internes);
        let mut f = donnees.clone();
        f.extend([0u8; 5]);
        let meta = bloc(&[]);
        let meta_off = f.len();
        f.extend(&meta);
        f.extend([0u8; 5]);
        let mut poignee = varint(0);
        poignee.extend(varint(donnees.len() as u64));
        let index = bloc(&[(internes.last().unwrap().0.clone(), poignee)]);
        let index_off = f.len();
        f.extend(&index);
        f.extend([0u8; 5]);
        let mut p = varint(meta_off as u64);
        p.extend(varint(meta.len() as u64));
        p.extend(varint(index_off as u64));
        p.extend(varint(index.len() as u64));
        p.resize(40, 0);
        f.extend(p);
        f.extend(0xdb4775248b80fb57u64.to_le_bytes());
        std::fs::write(chemin, f).unwrap();
    }
}

#[cfg(test)]
mod essais {
    use super::fabrique::*;
    use super::*;

    fn ls(d: &Path) -> BTreeMap<String, String> {
        lire_local_storage(d, None).unwrap().remove("app:").unwrap_or_default()
    }

    fn carte(l: &[(&str, &str)]) -> BTreeMap<String, String> {
        l.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn snappy_litteral_et_copie() {
        assert_eq!(decompresser_snappy(b"\x09\x08abc\x09\x03").unwrap(), b"abcabcabc");
        assert!(decompresser_snappy(b"\x05\x08abc").is_err());
    }

    #[test]
    fn journal_valeurs_et_suppressions() {
        let d = crate::dossier_essai("leveldb");
        ecrire_journal(
            &d.join("000003.log"),
            &[(cle_ls("a", b"app:"), Some(valeur_ls("1"))), (cle_ls("b", b"app:"), Some(valeur_ls("2"))), (cle_ls("a", b"app:"), None)],
            1,
        );
        let r = lire_local_storage(&d, None).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(ls(&d), carte(&[("b", "2")]));
    }

    #[test]
    fn table_puis_journal_plus_recent() {
        let d = crate::dossier_essai("leveldb");
        ecrire_table(&d.join("000005.ldb"), &[(cle_ls("x", b"app:"), valeur_ls("ancien")), (cle_ls("y", b"app:"), valeur_ls("garde"))], 1);
        ecrire_journal(&d.join("000006.log"), &[(cle_ls("x", b"app:"), Some(valeur_ls("nouveau")))], 50);
        assert_eq!(ls(&d), carte(&[("x", "nouveau"), ("y", "garde")]));
    }

    #[test]
    fn texte_utf16_et_accents() {
        let d = crate::dossier_essai("leveldb");
        ecrire_journal(
            &d.join("000003.log"),
            &[(cle_ls("latin", b"app:"), Some(valeur_ls("échange"))), (cle_ls("utf16", b"app:"), Some(valeur_ls("emoji 🦷")))],
            1,
        );
        assert_eq!(ls(&d), carte(&[("latin", "échange"), ("utf16", "emoji 🦷")]));
    }

    #[test]
    fn filtre_par_origine_et_cles_techniques() {
        let d = crate::dossier_essai("leveldb");
        ecrire_journal(
            &d.join("000003.log"),
            &[
                (cle_ls("k", b"file://"), Some(valeur_ls("v1"))),
                (cle_ls("k", b"app:"), Some(valeur_ls("v2"))),
                (b"VERSION".to_vec(), Some(b"1".to_vec())),
                (b"META:app:".to_vec(), Some(b"\x08\x01".to_vec())),
            ],
            1,
        );
        let r = lire_local_storage(&d, Some("app:")).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r["app:"], carte(&[("k", "v2")]));
    }
}
