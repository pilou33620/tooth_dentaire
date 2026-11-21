//! Reprise des données de l'ancienne application (PySide6).
//!
//!     tooth --importer "C:\chemin\vers\ancienne-appli"
//!
//! Ce qui est repris :
//!   - stock.db (produits, stock, transactions, maintenance, historique des prix), ou la base
//!     choisie dans les réglages de l'ancienne appli (%APPDATA%\GestionStockMedical\config.json) ;
//!   - le localStorage du navigateur intégré (webstorage/Local Storage/leveldb) : planning,
//!     tâches, dosimètres, rappels mire / fauteuils / dosimètres, carnet d'adresses, record du
//!     mini-jeu, positions d'interface ;
//!   - à défaut de localStorage, les valeurs par défaut écrites dans l'ancien code.
//!
//! Ce module ne contient lui-même aucune donnée du cabinet : il les LIT dans l'ancien dossier et
//! les écrit dans la base.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::base::{absolu, vrai, Base};
use crate::leveldb;

pub const TABLES_STOCK: [&str; 5] = ["produits", "stock", "transactions", "autoclave", "historique_prix"];

// ---------------------------------------------------------------------- littéraux JavaScript -> JSON

/// Le littéral {…} ou […] qui commence à `debut`.
fn extraire_bloc(t: &[char], debut: usize) -> Option<String> {
    if !matches!(t.get(debut), Some('{') | Some('[')) {
        return None;
    }
    let (mut profondeur, mut i, mut chaine) = (0i32, debut, None);
    while i < t.len() {
        let c = t[i];
        if let Some(q) = chaine {
            if c == '\\' {
                i += 2;
                continue;
            }
            if c == q {
                chaine = None;
            }
        } else if c == '"' || c == '\'' || c == '`' {
            chaine = Some(c);
        } else if c == '{' || c == '[' {
            profondeur += 1;
        } else if c == '}' || c == ']' {
            profondeur -= 1;
            if profondeur == 0 {
                return Some(t[debut..=i].iter().collect());
            }
        }
        i += 1;
    }
    None // littéral non fermé
}

fn est_mot(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Convertit un littéral objet JS simple en JSON (clés non quotées, chaînes entre apostrophes,
/// virgules finales, commentaires).
pub fn js_vers_json(litteral: &str) -> Option<Value> {
    let l: Vec<char> = litteral.chars().collect();
    let n = l.len();
    let mut s = String::new();
    let mut i = 0;
    let commence = |i: usize, motif: &str| motif.chars().enumerate().all(|(k, m)| l.get(i + k) == Some(&m));
    while i < n {
        let c = l[i];
        if c == '"' || c == '\'' {
            let mut j = i + 1;
            let mut morceau = String::new();
            while j < n && l[j] != c {
                if l[j] == '\\' {
                    morceau.extend(l[j..(j + 2).min(n)].iter());
                    j += 2;
                    continue;
                }
                morceau.push(l[j]);
                j += 1;
            }
            if c == '\'' {
                morceau = morceau.replace("\\'", "'").replace('"', "\\\"");
            }
            s.push('"');
            s.push_str(&morceau);
            s.push('"');
            i = j + 1;
            continue;
        }
        if commence(i, "//") {
            i = (i..n).find(|k| l[*k] == '\n').unwrap_or(n);
            continue;
        }
        if commence(i, "/*") {
            i = (i + 2..n.saturating_sub(1)).find(|k| l[*k] == '*' && l[*k + 1] == '/').map_or(n, |k| k + 2);
            continue;
        }
        if c.is_alphabetic() || c == '_' || c == '$' {
            let fin = (i..n).find(|k| !est_mot(l[*k])).unwrap_or(n);
            let mot: String = l[i..fin].iter().collect();
            let reste = (fin..n).find(|k| !l[*k].is_whitespace());
            if reste.is_some_and(|k| l[k] == ':') {
                s.push('"');
                s.push_str(&mot);
                s.push('"');
            } else {
                s.push_str(&mot);
            }
            i = fin;
            continue;
        }
        s.push(c);
        i += 1;
    }
    serde_json::from_str(&sans_virgules_finales(&s)).ok()
}

/// « ,  } » -> «   } » et « , ] » -> « ] ».
fn sans_virgules_finales(t: &str) -> String {
    let c: Vec<char> = t.chars().collect();
    let mut s = String::new();
    for (i, x) in c.iter().enumerate() {
        if *x == ',' {
            let suivant = c[i + 1..].iter().find(|y| !y.is_whitespace());
            if matches!(suivant, Some('}') | Some(']')) {
                continue;
            }
        }
        s.push(*x);
    }
    s
}

/// Valeur de `const <nom> = {…}` (ou `let`, `var`) dans un fichier JS / HTML.
pub fn constante_js(chemin: &Path, nom: &str) -> Option<Value> {
    let texte = std::fs::read_to_string(chemin).ok()?;
    let t: Vec<char> = texte.chars().collect();
    let cible: Vec<char> = nom.chars().collect();
    for i in 0..t.len().saturating_sub(cible.len() - 1) {
        if t[i..i + cible.len()] != cible[..] {
            continue;
        }
        // avant : « const|let|var » puis au moins un blanc, précédé d'un non-mot
        let mut a = i;
        while a > 0 && t[a - 1].is_whitespace() {
            a -= 1;
        }
        let mot_cle = ["const", "let", "var"].iter().any(|m| {
            let k: Vec<char> = m.chars().collect();
            a < i && a >= k.len() && t[a - k.len()..a] == k[..] && (a == k.len() || !est_mot(t[a - k.len() - 1]))
        });
        // après : des blancs puis « = »
        let mut b = i + cible.len();
        while b < t.len() && t[b].is_whitespace() {
            b += 1;
        }
        if !mot_cle || t.get(b) != Some(&'=') {
            continue;
        }
        let debut = (b + 1..t.len()).find(|k| t[*k] == '{' || t[*k] == '[')?;
        return extraire_bloc(&t, debut).and_then(|l| js_vers_json(&l));
    }
    None
}

/// Consigne écrite en dur sous le tableau des tâches de l'ancien index.html.
pub fn note_taches_html(chemin: &Path) -> String {
    let Ok(t) = std::fs::read_to_string(chemin) else { return String::new() };
    let trouve = (|| {
        let a = t.find("<div id=\"tasks-container\"")?;
        let a = a + t[a..].find('>')? + 1;
        let reste = t[a..].trim_start().strip_prefix("</div>")?.trim_start().strip_prefix("<div")?;
        let reste = &reste[reste.find('>')? + 1..];
        Some(reste[..reste.find("</div>")?].to_string())
    })();
    match trouve {
        Some(g) if !g.contains('<') => g.split_whitespace().collect::<Vec<_>>().join(" "),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------- ancienne base SQLite

/// Base réellement utilisée par l'ancienne appli.
fn base_ancienne(dossier: &Path, appdata: Option<&OsString>) -> Option<PathBuf> {
    let mut candidats = Vec::new();
    if let Some(a) = appdata {
        let config = Path::new(a).join("GestionStockMedical").join("config.json");
        let chemin = std::fs::read_to_string(config).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if let Some(c) = chemin.as_ref().and_then(|v| v["db_path"].as_str()).filter(|c| !c.is_empty()) {
            candidats.push(PathBuf::from(c));
        }
    }
    candidats.push(dossier.join("stock.db"));
    candidats.into_iter().find(|c| c.is_file()).map(|c| absolu(&c))
}

fn base_remplie(chemin: &Path) -> bool {
    if !chemin.is_file() {
        return false;
    }
    let Ok(conn) = Connection::open(chemin) else { return false };
    TABLES_STOCK
        .iter()
        .any(|t| conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |l| l.get::<_, i64>(0)).is_ok_and(|n| n > 0))
}

fn meme_fichier(a: &Path, b: &Path) -> bool {
    let (a, b) = (a.to_string_lossy(), b.to_string_lossy());
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

// ---------------------------------------------------------------------- localStorage

fn local_storage(dossier: &Path) -> Result<BTreeMap<String, String>, String> {
    let ldb = dossier.join("webstorage").join("Local Storage").join("leveldb");
    if !ldb.is_dir() {
        return Ok(BTreeMap::new());
    }
    // L'appli servait index.html sous app://local (origine notée « app: »). Les anciennes
    // versions passaient par file:// : on ne s'en sert qu'en complément.
    let par_origine = leveldb::lire_local_storage(&ldb, None)?;
    let mut fusion = BTreeMap::new();
    let (autres, app): (Vec<_>, Vec<_>) = par_origine.into_iter().partition(|(o, _)| !o.starts_with("app"));
    for (_, valeurs) in autres.into_iter().chain(app) {
        fusion.extend(valeurs);
    }
    Ok(fusion)
}

fn json_de(v: Option<&String>) -> Value {
    v.and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
}

fn entier(v: Option<&String>) -> Option<i64> {
    v.and_then(|t| t.trim().parse().ok())
}

/// Fusionne les rappels par machine (format groupe + clés individuelles).
fn rappels(ls: &BTreeMap<String, String>, cle_groupe: &str, prefixe: &str, ancien: Option<(&str, &str)>) -> Map<String, Value> {
    let mut r = match json_de(ls.get(cle_groupe)) {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for (cle, valeur) in ls {
        let Some(machine) = cle.strip_prefix(prefixe) else { continue };
        if let Some(temps) = entier(Some(valeur)).filter(|t| *t != 0) {
            if !machine.is_empty() && !r.contains_key(machine) {
                r.insert(machine.to_string(), json!({"nextTime": temps, "lastDone": null}));
            }
        }
    }
    if let Some((cle, machine)) = ancien {
        if !r.contains_key(machine) {
            if let Some(temps) = entier(ls.get(cle)).filter(|t| *t != 0) {
                r.insert(machine.to_string(), json!({"nextTime": temps, "lastDone": null, "intervalDays": 180}));
            }
        }
    }
    r
}

// ---------------------------------------------------------------------- import

pub fn importer(dossier_ancien: &Path, chemin_base: &Path, forcer: bool) -> Result<String, String> {
    importer_avec(dossier_ancien, chemin_base, forcer, std::env::var_os("APPDATA").as_ref())
}

pub fn importer_avec(dossier_ancien: &Path, chemin_base: &Path, forcer: bool, appdata: Option<&OsString>) -> Result<String, String> {
    let dossier = absolu(dossier_ancien);
    if !dossier.is_dir() {
        return Err(format!("Dossier introuvable : {}", dossier.display()));
    }
    let chemin_base = absolu(chemin_base);
    let mut lignes = vec![format!("Import depuis : {}", dossier.display())];
    let e = |x: std::io::Error| x.to_string();

    // 1. Base SQLite
    let ancienne = base_ancienne(&dossier, appdata);
    match &ancienne {
        Some(a) if !meme_fichier(a, &chemin_base) => {
            if base_remplie(&chemin_base) && !forcer {
                return Err(format!(
                    "La base {} contient deja des donnees. Relancer avec --forcer pour la remplacer \
                     (une copie de sauvegarde sera faite).",
                    chemin_base.display()
                ));
            }
            if chemin_base.exists() {
                let copie = format!("{}.avant-import-{}", chemin_base.display(), chrono::Local::now().format("%Y%m%d-%H%M%S"));
                std::fs::copy(&chemin_base, &copie).map_err(e)?;
                lignes.push(format!("Ancienne base sauvegardee : {copie}"));
            }
            if let Some(p) = chemin_base.parent() {
                std::fs::create_dir_all(p).map_err(e)?;
            }
            std::fs::copy(a, &chemin_base).map_err(e)?;
            lignes.push(format!("Base de stock reprise : {}", a.display()));
        }
        Some(_) => {}
        None => lignes.push("[!] Aucun stock.db trouve : base de stock vide.".into()),
    }
    let base = Base::ouvrir(&chemin_base).map_err(|x| x.to_string())?;

    // 2. Données du navigateur intégré
    let ls = local_storage(&dossier)?;
    let web = dossier.join("web");
    lignes.push(format!("Cles de navigateur trouvees : {}", ls.len()));

    let mut poser = |cle: &str, v: Option<Value>, origine: &str| -> Result<(), String> {
        match v {
            None => lignes.push(format!("  - {cle:<20} : rien a reprendre")),
            Some(v) => {
                base.ecrire_document(cle, &v, None).map_err(|x| x.to_string())?;
                lignes.push(format!("  - {cle:<20} : {origine}"));
            }
        }
        Ok(())
    };

    let planning = json_de(ls.get("teamCalendarData"));
    if planning.get("even").is_some() {
        poser("planning", Some(planning), "navigateur")?;
    } else {
        poser("planning", constante_js(&web.join("js").join("planning").join("team-planning.js"), "DEFAULT_CALENDAR_DATA"), "valeurs de l'ancien code")?;
    }

    let mut taches = json_de(ls.get("teamTasksData"));
    let mut origine_taches = "navigateur";
    if taches.get("rows").is_none() || !taches.is_object() {
        taches = constante_js(&web.join("js").join("planning").join("tasks-planning.js"), "DEFAULT_TASKS_DATA").unwrap_or(Value::Null);
        origine_taches = "valeurs de l'ancien code";
    }
    if taches.is_object() && !vrai(&taches["note"]) {
        let note = note_taches_html(&web.join("index.html"));
        if !note.is_empty() {
            taches["note"] = json!(note);
        }
    }
    poser("taches", Some(taches).filter(|t| !t.is_null()), origine_taches)?;

    let dosimetres = json_de(ls.get("dosimetres_data"));
    if dosimetres.is_object() {
        poser("dosimetres", Some(dosimetres), "navigateur")?;
    } else {
        poser("dosimetres", constante_js(&web.join("js").join("features").join("dosimetres.js"), "DEFAULT_DOSIMETRES_DATA"), "valeurs de l'ancien code")?;
    }

    let mire = rappels(&ls, "mireAlertsByCabinet", "mireAlertNextTime_", Some(("mireAlertNextTime", "Radio Panoramique")));
    poser("rappels_mire", Some(Value::Object(mire)).filter(vrai), "navigateur")?;
    let fauteuils = rappels(&ls, "fauteuilAlertsByCabinet", "fauteuilAlertNextTime_", None);
    poser("rappels_fauteuils", Some(Value::Object(fauteuils)).filter(vrai), "navigateur")?;
    let dosi = entier(ls.get("dosiAlertNextTime")).filter(|t| *t != 0);
    poser("rappel_dosimetres", dosi.map(|d| json!({"nextTime": d})), "navigateur")?;

    let record = entier(ls.get("toothHighScore")).filter(|t| *t != 0);
    poser("record_jeu", record.map(|r| json!(r)), "navigateur")?;
    let positions = json_de(ls.get("ui-positions"));
    poser("positions_interface", Some(positions).filter(Value::is_object), "navigateur")?;
    drop(poser);

    let mut contacts = json_de(ls.get("carnets_adresses_data"));
    if !vrai(&contacts) {
        contacts = json_de(ls.get("cahier_adresses_data"));
    }
    let mut origine = "navigateur";
    if !contacts.is_array() {
        contacts = constante_js(&web.join("html").join("annuaire.html"), "defaultContacts").unwrap_or(Value::Null);
        origine = "valeurs de l'ancien code";
    }
    if contacts.is_array() {
        let n = base.remplacer_contacts(&contacts).map_err(|x| x.to_string())?;
        lignes.push(format!("  - {:<20} : {n} contact(s) ({origine})", "contacts"));
    } else {
        lignes.push(format!("  - {:<20} : rien a reprendre", "contacts"));
    }

    let compte = |t: &str| base.compter(t).map_err(|x| x.to_string());
    lignes.push(format!(
        "Stock : {} produit(s), {} ligne(s), {} transaction(s).",
        compte("produits")?,
        compte("stock")?,
        compte("transactions")?
    ));
    lignes.push("Import termine.".into());
    Ok(lignes.join("\n"))
}

#[cfg(test)]
mod essais {
    use super::*;
    use crate::leveldb::fabrique::{cle_ls, ecrire_journal, valeur_ls};

    #[test]
    fn litteral_js_en_json() {
        let l = "{
            // commentaire
            header1: \"P1\",
            rows: [
                { task: 'L\\'equipe', nature: \"Ligne\\nsuivante\", col1: \"A\", },
            ],
            actif: true, vide: null, /* bloc */ nombre: 3,
        }";
        assert_eq!(
            js_vers_json(l).unwrap(),
            json!({"header1": "P1", "rows": [{"task": "L'equipe", "nature": "Ligne\nsuivante", "col1": "A"}],
                   "actif": true, "vide": null, "nombre": 3})
        );
    }

    #[test]
    fn constante_dans_un_fichier() {
        let d = crate::dossier_essai("js");
        let f = d.join("x.js");
        std::fs::write(&f, "const AUTRE = 1;\nexport const DEFAUT = { a: [1, 2], \"b\": { c: \"}\" } };\n").unwrap();
        assert_eq!(constante_js(&f, "DEFAUT").unwrap(), json!({"a": [1, 2], "b": {"c": "}"}}));
        assert_eq!(constante_js(&f, "ABSENTE"), None);
        assert_eq!(constante_js(&d.join("absent.js"), "DEFAUT"), None);
    }

    fn planning() -> Value {
        json!({"even": [{"assistant": "Assistante A", "days": {"LUNDI": {"am": "Dr X", "pm": ""}}}], "odd": []})
    }

    fn sql(chemin: &Path, requete: &str) {
        Connection::open(chemin).unwrap().execute_batch(requete).unwrap();
    }

    /// Une ancienne installation fictive ; rend (racine des essais, dossier ancien).
    fn ancienne() -> (PathBuf, PathBuf) {
        let racine = crate::dossier_essai("migration");
        let d = racine.join("ancienne");
        std::fs::create_dir_all(d.join("web").join("js").join("planning")).unwrap();
        let ldb = d.join("webstorage").join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&ldb).unwrap();
        sql(
            &d.join("stock.db"),
            "CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT);
             CREATE TABLE stock (reference TEXT NOT NULL, utilisateur TEXT NOT NULL, quantite INTEGER DEFAULT 0, PRIMARY KEY (reference, utilisateur));
             INSERT INTO produits VALUES ('P1', 'Produit', '', '');
             INSERT INTO stock VALUES ('P1', 'Commun', 4);",
        );
        let contacts = json!([{"id": 1, "nom": "Labo Fictif", "tel_fixe": "00 00"}]);
        let e = |k: &str, v: &str| (cle_ls(k, b"app:"), Some(valeur_ls(v)));
        ecrire_journal(
            &ldb.join("000003.log"),
            &[
                e("teamCalendarData", &planning().to_string()),
                e("dosimetres_data", &json!({"manager": "Responsable Z", "generalNote": "", "dosimetres": []}).to_string()),
                e("carnets_adresses_data", &contacts.to_string()),
                e("dosiAlertNextTime", "1800000000000"),
                e("mireAlertNextTime", "1700000000000"),
                e("fauteuilAlertNextTime_Fauteuil Test", "1750000000000"),
                e("toothHighScore", "28"),
                e("ui-positions", "{\"action-area\": {\"left\": \"10%\"}}"),
            ],
            1,
        );
        std::fs::write(
            d.join("web").join("js").join("planning").join("tasks-planning.js"),
            "const DEFAULT_TASKS_DATA = {\n  header1: \"P1\",\n  rows: [\n    { task: \"Tache\", nature: \"N\", col1: \"Assistante A\", col2: \"\" }\n  ]\n};\n",
        )
        .unwrap();
        std::fs::write(
            d.join("web").join("index.html"),
            "<div id=\"tasks-container\" class=\"calendar-wrapper active\"></div>\n<div style=\"font-style: italic;\">\n   Consigne   du matin.\n</div>",
        )
        .unwrap();
        (racine, d)
    }

    fn sans_appdata(racine: &Path) -> OsString {
        racine.join("appdata").into_os_string()
    }

    #[test]
    fn import_complet() {
        let (racine, d) = ancienne();
        let cible = racine.join("nouvelle").join("stock.db");
        let rapport = importer_avec(&d, &cible, false, Some(&sans_appdata(&racine))).unwrap();
        assert!(rapport.contains("Import termine"), "{rapport}");
        let b = Base::ouvrir(&cible).unwrap();
        let db = b.charger_base().unwrap();
        assert_eq!(db["produits"][0]["reference"], "P1");
        assert_eq!(db["stock"][0]["quantite"], 4);
        assert_eq!(b.lire_document("planning").unwrap(), planning());
        assert_eq!(b.lire_document("dosimetres").unwrap()["manager"], "Responsable Z");
        assert_eq!(b.lire_document("rappel_dosimetres").unwrap(), json!({"nextTime": 1800000000000i64}));
        assert_eq!(b.lire_document("rappels_mire").unwrap()["Radio Panoramique"]["nextTime"], 1700000000000i64);
        assert_eq!(b.lire_document("rappels_fauteuils").unwrap()["Fauteuil Test"]["nextTime"], 1750000000000i64);
        assert_eq!(b.lire_document("record_jeu").unwrap(), 28);
        assert_eq!(b.lire_document("positions_interface").unwrap(), json!({"action-area": {"left": "10%"}}));
        assert_eq!(b.lister_contacts().unwrap()[0]["nom"], "Labo Fictif");
        // Tâches absentes du navigateur : reprises de l'ancien code, avec la consigne
        let taches = b.lire_document("taches").unwrap();
        assert_eq!(taches["rows"][0]["col1"], "Assistante A");
        assert_eq!(taches["note"], "Consigne du matin.");
    }

    #[test]
    fn import_refuse_d_ecraser_une_base_remplie_sauf_force() {
        let (racine, d) = ancienne();
        let cible = racine.join("nouvelle.db");
        Base::ouvrir(&cible).unwrap().update_produit(&json!({"reference": "EXISTANT"})).unwrap();
        assert!(importer_avec(&d, &cible, false, Some(&sans_appdata(&racine))).is_err());
        let rapport = importer_avec(&d, &cible, true, Some(&sans_appdata(&racine))).unwrap();
        assert!(rapport.contains("sauvegardee"));
        let copies = std::fs::read_dir(&racine).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("nouvelle.db.avant-import-")).count();
        assert_eq!(copies, 1);
        assert_eq!(Base::ouvrir(&cible).unwrap().charger_base().unwrap()["produits"][0]["reference"], "P1");
    }

    #[test]
    fn import_sans_navigateur_ni_base() {
        let racine = crate::dossier_essai("migration");
        let vide = racine.join("vide");
        std::fs::create_dir_all(&vide).unwrap();
        let rapport = importer_avec(&vide, &racine.join("n.db"), false, Some(&sans_appdata(&racine))).unwrap();
        assert!(rapport.contains("Aucun stock.db"));
        assert_eq!(Base::ouvrir(&racine.join("n.db")).unwrap().lire_document("planning").unwrap(), json!({"even": [], "odd": []}));
        assert!(importer_avec(&racine.join("absent"), &racine.join("n.db"), false, None).is_err());
    }

    #[test]
    fn base_choisie_dans_les_reglages_de_l_ancienne_appli() {
        let (racine, d) = ancienne();
        let autre = racine.join("ailleurs.db");
        sql(
            &autre,
            "CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT);
             INSERT INTO produits VALUES ('DEPUIS_CONFIG', '', '', '');",
        );
        let config = racine.join("appdata").join("GestionStockMedical");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(config.join("config.json"), json!({"db_path": autre.to_string_lossy()}).to_string()).unwrap();
        importer_avec(&d, &racine.join("n.db"), false, Some(&sans_appdata(&racine))).unwrap();
        assert_eq!(Base::ouvrir(&racine.join("n.db")).unwrap().charger_base().unwrap()["produits"][0]["reference"], "DEPUIS_CONFIG");
    }
}
