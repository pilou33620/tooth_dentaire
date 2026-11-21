//! Base de données SQLite de l'outil (stock.db).
//!
//! Le schéma du stock est celui de l'ancienne application PySide6, ce qui permet de reprendre
//! une base existante telle quelle :
//!
//!   produits        : reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton
//!   stock           : une ligne par (reference, espace)
//!   transactions    : historique des mouvements
//!   autoclave       : carnet de maintenance des machines
//!   historique_prix : prix reçus à chaque entrée
//!
//! S'y ajoutent deux tables pour ce qui vivait auparavant dans le navigateur :
//!
//!   contacts        : carnet d'adresses
//!   documents       : documents JSON nommés (planning, tâches, dosimètres, rappels…)
//!
//! AUCUNE donnée propre au cabinet (noms du personnel, contacts…) n'est écrite dans le code :
//! tout est en base, et la base n'est pas versionnée. L'ouverture ne fait qu'ajouter les tables
//! et colonnes manquantes : une base existante se rouvre sans perte.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, RwLock};
use std::time::Duration;

use chrono::NaiveDate;
use rusqlite::types::ValueRef;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};

// ---------------------------------------------------------------------- erreurs

#[derive(Debug)]
pub enum Erreur {
    /// Données envoyées invalides (400).
    Donnees(String),
    /// Ligne ou document modifié entre-temps par un autre poste (409, « conflit »).
    Conflit(String),
    /// Service extérieur injoignable (503).
    Indisponible(String),
    /// Mise à jour refusée ou en échec (409).
    MiseAJour(String),
    /// Corps de requête trop gros (413).
    TropGros,
    /// Erreur interne (500) : le détail reste dans le journal du serveur.
    Interne(String),
}

impl std::fmt::Display for Erreur {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Erreur::Donnees(m) | Erreur::Conflit(m) | Erreur::Indisponible(m) | Erreur::MiseAJour(m) | Erreur::Interne(m) => {
                write!(f, "{m}")
            }
            Erreur::TropGros => write!(f, "Requete trop volumineuse."),
        }
    }
}

impl From<rusqlite::Error> for Erreur {
    fn from(e: rusqlite::Error) -> Self {
        Erreur::Interne(format!("sqlite : {e}"))
    }
}

pub type Res<T> = Result<T, Erreur>;

pub fn donnees<T>(m: impl Into<String>) -> Res<T> {
    Err(Erreur::Donnees(m.into()))
}

// ---------------------------------------------------------------------- documents par défaut

/// Les documents JSON nommés, dans l'ordre où l'interface les reçoit.
pub const CLES: &[&str] = &[
    "planning",
    "planning_couleurs",
    "taches",
    "dosimetres",
    "rappels_mire",
    "rappels_fauteuils",
    "rappel_dosimetres",
    "record_jeu",
    "positions_interface",
    "notes",
    "checklist",
    "meteo_lieu",
    "minuteurs",
];

/// Valeur par défaut d'un document : volontairement neutre (aucun nom).
pub fn defaut(cle: &str) -> Value {
    match cle {
        "planning" => json!({"even": [], "odd": []}),
        "planning_couleurs" => json!({"regles": []}),
        "taches" => json!({"header1": "", "header2": "", "rows": []}),
        "dosimetres" => json!({"manager": "", "generalNote": "", "dosimetres": []}),
        "rappels_mire" | "rappels_fauteuils" | "positions_interface" => json!({}),
        "rappel_dosimetres" => json!({"nextTime": null}),
        "record_jeu" => json!(0),
        // Accueil : notes partagées, checklist du jour, minuteurs
        "notes" => json!({"items": []}),
        "checklist" => json!({
            "modele": [
                {"id": "o1", "moment": "ouverture", "libelle": "Purge des circuits d'eau des units"},
                {"id": "o2", "moment": "ouverture", "libelle": "Test de l'autoclave (Bowie-Dick / Hélix)"},
                {"id": "o3", "moment": "ouverture", "libelle": "Mise en route aspiration et compresseur"},
                {"id": "f1", "moment": "fermeture", "libelle": "Désinfection des fauteuils et surfaces"},
                {"id": "f2", "moment": "fermeture", "libelle": "Nettoyage des aspirations"},
                {"id": "f3", "moment": "fermeture", "libelle": "Évacuation des DASRI"},
                {"id": "f4", "moment": "fermeture", "libelle": "Arrêt aspiration et compresseur"},
            ],
            "jour": "",
            "fait": {},
        }),
        // Commune du cabinet pour la météo du fond (vide : pas de météo)
        "meteo_lieu" => json!({"nom": "", "lat": null, "lon": null}),
        "minuteurs" => json!({
            "actifs": [],
            "preselections": [
                {"libelle": "Bain à ultrasons", "minutes": 10},
                {"libelle": "Trempage", "minutes": 15},
                {"libelle": "Séchage", "minutes": 20},
            ],
        }),
        _ => Value::Null,
    }
}

pub const CHAMPS_CONTACT: [&str; 10] =
    ["nom", "prenom", "entreprise", "email", "tel_fixe", "tel_portable", "adresse", "code_postal", "ville", "note"];

// ---------------------------------------------------------------------- conversions tolérantes

pub static NUL: Value = Value::Null;

/// Nombre fini, sinon rien : un infini ou NaN en base rendrait /api/etat illisible pour les
/// navigateurs. Accepte « 1 234,50 ».
pub fn nombre(val: &Value) -> Option<f64> {
    let n = match val {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.is_empty() => s.replace(' ', "").replace(',', ".").trim().parse::<f64>().ok(),
        _ => None,
    }?;
    n.is_finite().then_some(n)
}

pub fn safe_float(val: &Value, defaut: f64) -> f64 {
    nombre(val).unwrap_or(defaut)
}

/// Entier 64 bits (ce que SQLite accepte), sinon rien.
pub fn entier(val: &Value) -> Option<i64> {
    let f = match val {
        Value::Bool(b) => return Some(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                return Some(i);
            }
            n.as_f64()?
        }
        Value::String(s) if !s.is_empty() => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    let f = f.trunc();
    (f.is_finite() && (-9.223_372_036_854_776e18..9.223_372_036_854_776e18).contains(&f)).then_some(f as i64)
}

pub fn safe_int(val: &Value, defaut: i64) -> i64 {
    entier(val).unwrap_or(defaut)
}

/// str() de Python : "" pour rien, le texte tel quel, le nombre écrit.
pub fn texte(val: &Value) -> String {
    match val {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => (if *b { "True" } else { "False" }).to_string(),
        autre => autre.to_string(),
    }
}

/// Vrai au sens de Python (`if x:`).
pub fn vrai(val: &Value) -> bool {
    match val {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn champ<'a>(m: &'a Map<String, Value>, cle: &str) -> &'a Value {
    m.get(cle).unwrap_or(&NUL)
}

fn exiger_objet(v: &Value) -> Res<&Map<String, Value>> {
    v.as_object().ok_or_else(|| Erreur::Donnees("Format de donnees invalide (objet attendu).".into()))
}

/// json.dumps de Python (séparateurs « , » et « : »), pour écrire en base le même texte que
/// l'ancienne version : une base reste identique, quel que soit le serveur qui l'a écrite.
pub fn json_python(v: &Value) -> String {
    use serde::Serialize;
    struct Format;
    impl serde_json::ser::Formatter for Format {
        fn begin_array_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W, premier: bool) -> std::io::Result<()> {
            if premier { Ok(()) } else { w.write_all(b", ") }
        }
        fn begin_object_key<W: ?Sized + std::io::Write>(&mut self, w: &mut W, premier: bool) -> std::io::Result<()> {
            if premier { Ok(()) } else { w.write_all(b", ") }
        }
        fn begin_object_value<W: ?Sized + std::io::Write>(&mut self, w: &mut W) -> std::io::Result<()> {
            w.write_all(b": ")
        }
    }
    let mut o = Vec::new();
    let mut s = serde_json::Serializer::with_formatter(&mut o, Format);
    // écrire un Value en mémoire n'échoue pas
    let _ = v.serialize(&mut s);
    String::from_utf8(o).unwrap_or_default()
}

/// Une valeur lue en base, telle quelle en JSON.
pub fn valeur(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) | ValueRef::Blob(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
    }
}

/// Les lignes d'une requête, en objets JSON (clés dans l'ordre des colonnes).
fn lignes(conn: &Connection, sql: &str) -> Res<Vec<Value>> {
    let mut st = conn.prepare(sql)?;
    let noms: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let mut rangs = st.query([])?;
    let mut v = Vec::new();
    while let Some(r) = rangs.next()? {
        let mut m = Map::new();
        for (i, n) in noms.iter().enumerate() {
            m.insert(n.clone(), valeur(r.get_ref(i)?));
        }
        v.push(Value::Object(m));
    }
    Ok(v)
}

/// Une valeur d'une ligne de stock (rien si la ligne n'existe pas).
fn valeur_stock(conn: &Connection, colonne: &str, r: &str, e: &str) -> Res<Option<Value>> {
    let sql = format!("SELECT {colonne} FROM stock WHERE reference = ?1 AND utilisateur = ?2");
    Ok(conn.query_row(&sql, params![r, e], |l| Ok(valeur(l.get_ref(0)?))).optional()?)
}

// ---------------------------------------------------------------------- la base

pub struct Base {
    chemin: RwLock<PathBuf>,
    /// Verrou d'écriture : le serveur est multi-fil, SQLite accepte un seul écrivain à la fois.
    verrou: Mutex<()>,
    /// Révision : change à chaque écriture. Les navigateurs la surveillent pour recharger les
    /// données quand un autre poste a modifié quelque chose.
    demarrage: String,
    compteur: AtomicU64,
}

pub fn absolu(p: &Path) -> PathBuf {
    std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf())
}

impl Base {
    /// Ouvre (ou crée) la base et complète son schéma.
    pub fn ouvrir(chemin: &Path) -> Res<Base> {
        let mut o = [0u8; 4];
        let _ = getrandom::getrandom(&mut o);
        let base = Base {
            chemin: RwLock::new(PathBuf::new()),
            verrou: Mutex::new(()),
            demarrage: o.iter().map(|b| format!("{b:02x}")).collect(),
            compteur: AtomicU64::new(0),
        };
        base.definir_chemin(chemin)?;
        Ok(base)
    }

    pub fn chemin(&self) -> PathBuf {
        self.chemin.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn verrouiller(&self) -> MutexGuard<'_, ()> {
        self.verrou.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn revision(&self) -> String {
        format!("{}-{}", self.demarrage, self.compteur.load(Ordering::SeqCst))
    }

    /// Choisit le fichier de base (créé s'il n'existe pas) et l'initialise.
    pub fn definir_chemin(&self, chemin: &Path) -> Res<PathBuf> {
        let chemin = absolu(chemin);
        if let Some(d) = chemin.parent() {
            std::fs::create_dir_all(d).map_err(|e| Erreur::Interne(e.to_string()))?;
        }
        let _g = self.verrouiller();
        init_db(&ouvrir_connexion(&chemin)?)?;
        *self.chemin.write().unwrap_or_else(|e| e.into_inner()) = chemin.clone();
        self.compteur.fetch_add(1, Ordering::SeqCst);
        Ok(chemin)
    }

    pub fn connexion(&self) -> Res<Connection> {
        ouvrir_connexion(&self.chemin())
    }

    /// Exécute `f` dans une transaction, sous verrou, puis révision + 1. Tout ou rien.
    fn ecrire<T>(&self, f: impl FnOnce(&Transaction) -> Res<T>) -> Res<T> {
        let _g = self.verrouiller();
        let mut conn = self.connexion()?;
        let tx = conn.transaction()?;
        let r = f(&tx)?;
        tx.commit()?;
        self.compteur.fetch_add(1, Ordering::SeqCst);
        Ok(r)
    }

    // ------------------------------------------------------------------ lecture complète

    /// Toute la base au format attendu par l'interface.
    pub fn charger_base(&self) -> Res<Value> {
        let conn = self.connexion()?;
        let produits = lignes(
            &conn,
            "SELECT reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton, arrete FROM produits",
        )?;
        let stock = lignes(
            &conn,
            "SELECT reference, utilisateur, quantite, stock_minimum, alerte_active, alerte_peremption_active, \
             delai_peremption, date_peremption, date_import, fournisseur, en_commande, date_commande, lot, \
             prix_unitaire_ht, prix_unitaire_ttc, lots_details, version FROM stock",
        )?;
        let transactions = lignes(
            &conn,
            "SELECT id, date, reference, utilisateur, type_transaction, quantite, lot, peremption_sortie \
             FROM transactions ORDER BY id",
        )?;
        let autoclave = lignes(&conn, "SELECT id, date, machine, utilisateur, commentaire FROM autoclave ORDER BY id")?;
        let historique_prix =
            lignes(&conn, "SELECT id, reference, date, prix_ht, prix_ttc, fournisseur FROM historique_prix ORDER BY id")?;
        let suivant = |l: &[Value]| l.iter().map(|x| x["id"].as_i64().unwrap_or(0)).max().unwrap_or(0) + 1;
        let (tx, auto) = (suivant(transactions.as_slice()), suivant(autoclave.as_slice()));
        Ok(json!({
            "produits": produits,
            "stock": stock,
            "transactions": transactions,
            "autoclave": autoclave,
            "historique_prix": historique_prix,
            "nextTxId": tx,
            "nextAutoId": auto,
        }))
    }

    // ------------------------------------------------------------------ stock

    pub fn update_produit(&self, p: &Value) -> Res<()> {
        self.ecrire(|tx| maj_produit(tx, p))
    }

    pub fn update_stock_item(&self, s: &Value) -> Res<Value> {
        let m = exiger_objet(s)?;
        let ligne = (texte(champ(m, "reference")).trim().to_string(), texte(champ(m, "utilisateur")).trim().to_string());
        self.ecrire(|tx| {
            let avant = photo_peremption(tx, std::slice::from_ref(&ligne))?;
            let r = maj_stock(tx, s, &mut HashSet::new())?;
            refuser_entrees_perimees(tx, std::slice::from_ref(&ligne), &avant)?;
            Ok(r)
        })
    }

    pub fn delete_stock_item(&self, reference: &str, utilisateur: &str) -> Res<()> {
        self.ecrire(|tx| suppr_stock(tx, reference, utilisateur))
    }

    pub fn delete_produit(&self, reference: &str) -> Res<()> {
        self.ecrire(|tx| suppr_produit(tx, reference))
    }

    /// Ajoute une transaction ; l'identifiant est attribué par la base.
    pub fn add_transaction(&self, t: &Value) -> Res<i64> {
        self.ecrire(|tx| ajout_transaction(tx, t))
    }

    pub fn add_autoclave(&self, a: &Value) -> Res<i64> {
        self.ecrire(|tx| ajout_autoclave(tx, a))
    }

    pub fn add_historique_prix(&self, h: &Value) -> Res<i64> {
        self.ecrire(|tx| ajout_historique_prix(tx, h))
    }

    /// Exécute les opérations d'une même action de l'interface (sortie de stock et ses
    /// transactions, transfert…) dans UNE transaction SQL : tout ou rien. Si un autre poste a
    /// modifié entre-temps une ligne de stock concernée : Conflit, et rien n'est enregistré.
    pub fn executer_lot(&self, operations: &Value) -> Res<Vec<Value>> {
        let ops = match operations.as_array() {
            Some(o) if !o.is_empty() => o,
            _ => return donnees("Liste d'operations attendue."),
        };
        self.ecrire(|tx| {
            let touchees = lignes_touchees(tx, ops)?;
            let avant = photo_peremption(tx, &touchees)?;
            let mut deja = HashSet::new();
            let resultats = ops.iter().map(|op| operation(tx, op, &mut deja)).collect::<Res<Vec<_>>>()?;
            refuser_entrees_perimees(tx, &touchees, &avant)?;
            Ok(resultats)
        })
    }

    // ------------------------------------------------------------------ documents

    pub fn lire_document(&self, cle: &str) -> Res<Value> {
        cle_valide(cle)?;
        let v: Option<String> = self
            .connexion()?
            .query_row("SELECT valeur FROM documents WHERE cle = ?1", [cle], |l| Ok(texte(&valeur(l.get_ref(0)?))))
            .optional()?;
        Ok(decoder_document(cle, v.as_deref()))
    }

    /// Tous les documents en une seule requête (appelé à chaque /api/etat).
    pub fn lire_documents(&self) -> Res<Value> {
        let conn = self.connexion()?;
        let mut stockes = std::collections::HashMap::new();
        for l in lignes(&conn, "SELECT cle, valeur FROM documents")? {
            stockes.insert(texte(&l["cle"]), texte(&l["valeur"]));
        }
        let mut m = Map::new();
        for cle in CLES {
            m.insert(cle.to_string(), decoder_document(cle, stockes.get(*cle).map(String::as_str)));
        }
        Ok(Value::Object(m))
    }

    /// Version de chaque document (0 s'il n'a jamais été écrit).
    pub fn versions_documents(&self) -> Res<Value> {
        let conn = self.connexion()?;
        let mut versions = std::collections::HashMap::new();
        for l in lignes(&conn, "SELECT cle, version FROM documents")? {
            versions.insert(texte(&l["cle"]), safe_int(&l["version"], 0));
        }
        let mut m = Map::new();
        for cle in CLES {
            m.insert(cle.to_string(), json!(versions.get(*cle).copied().unwrap_or(0)));
        }
        Ok(Value::Object(m))
    }

    /// Remplace le document. `version` : celle que le poste a lue ; s'il a été réécrit depuis par
    /// un autre poste, Conflit et rien n'est écrit.
    pub fn ecrire_document(&self, cle: &str, v: &Value, version: Option<i64>) -> Res<Value> {
        cle_valide(cle)?;
        if v.is_null() {
            return donnees("Document vide.");
        }
        let texte_json = json_python(v);
        self.ecrire(|tx| {
            let actuelle = tx
                .query_row("SELECT version FROM documents WHERE cle = ?1", [cle], |l| Ok(valeur(l.get_ref(0)?)))
                .optional()?
                .map(|v| safe_int(&v, 0))
                .unwrap_or(0);
            if version.is_some_and(|v| v != actuelle) {
                return Err(Erreur::Conflit("Ces données viennent d'être modifiées depuis un autre poste.".into()));
            }
            tx.execute(
                "INSERT INTO documents (cle, valeur, modifie_le, version) \
                 VALUES (?1, ?2, datetime('now', 'localtime'), ?3) \
                 ON CONFLICT(cle) DO UPDATE SET valeur=excluded.valeur, \
                   modifie_le=excluded.modifie_le, version=excluded.version",
                params![cle, texte_json, actuelle + 1],
            )?;
            Ok(json!({"version": actuelle + 1}))
        })
    }

    pub fn document_present(&self, cle: &str) -> Res<bool> {
        Ok(self.connexion()?.query_row("SELECT 1 FROM documents WHERE cle = ?1", [cle], |_| Ok(())).optional()?.is_some())
    }

    // ------------------------------------------------------------------ contacts

    pub fn lister_contacts(&self) -> Res<Vec<Value>> {
        lignes(&self.connexion()?, &format!("SELECT id, {} FROM contacts ORDER BY id", CHAMPS_CONTACT.join(", ")))
    }

    /// Crée (sans id) ou met à jour (avec id) un contact ; rend le contact.
    pub fn enregistrer_contact(&self, c: &Value) -> Res<Value> {
        let m = exiger_objet(c)?;
        let valeurs: Vec<String> = CHAMPS_CONTACT.iter().map(|k| texte(champ(m, k)).trim().to_string()).collect();
        if valeurs[..3].iter().all(String::is_empty) {
            return donnees("Un nom, un prenom ou une entreprise est obligatoire.");
        }
        let ident = safe_int(champ(m, "id"), 0);
        let nouvel_id = self.ecrire(|tx| {
            let existe = ident != 0 && tx.query_row("SELECT 1 FROM contacts WHERE id = ?1", [ident], |_| Ok(())).optional()?.is_some();
            if existe {
                let pose: Vec<String> = CHAMPS_CONTACT.iter().map(|k| format!("{k} = ?")).collect();
                let mut p: Vec<rusqlite::types::Value> = valeurs.iter().map(|v| v.clone().into()).collect();
                p.push(ident.into());
                tx.execute(&format!("UPDATE contacts SET {} WHERE id = ?", pose.join(", ")), params_from_iter(p.iter()))?;
                return Ok(ident);
            }
            tx.execute(
                &format!("INSERT INTO contacts ({}) VALUES ({})", CHAMPS_CONTACT.join(", "), vec!["?"; CHAMPS_CONTACT.len()].join(", ")),
                params_from_iter(valeurs.iter()),
            )?;
            Ok(tx.last_insert_rowid())
        })?;
        let mut contact = Map::new();
        for (k, v) in CHAMPS_CONTACT.iter().zip(&valeurs) {
            contact.insert(k.to_string(), json!(v));
        }
        contact.insert("id".into(), json!(nouvel_id));
        Ok(Value::Object(contact))
    }

    pub fn supprimer_contact(&self, ident: &Value) -> Res<()> {
        let id = safe_int(ident, 0);
        self.ecrire(|tx| Ok(tx.execute("DELETE FROM contacts WHERE id = ?1", [id]).map(|_| ())?))
    }

    /// Remplace tout le carnet (reprise de l'ancienne appli).
    pub fn remplacer_contacts(&self, contacts: &Value) -> Res<usize> {
        let mut rangs: Vec<(Option<i64>, Vec<String>)> = Vec::new();
        let mut vus = HashSet::new();
        for c in contacts.as_array().map(Vec::as_slice).unwrap_or(&[]) {
            let Some(m) = c.as_object() else { continue };
            let mut ident = entier(champ(m, "id")).filter(|i| *i != 0);
            if ident.is_some_and(|i| vus.contains(&i)) {
                ident = None; // doublon : la base renumérote
            }
            if let Some(i) = ident {
                vus.insert(i);
            }
            rangs.push((ident, CHAMPS_CONTACT.iter().map(|k| texte(champ(m, k)).trim().to_string()).collect()));
        }
        let n = rangs.len();
        self.ecrire(|tx| {
            tx.execute("DELETE FROM contacts", [])?;
            let sql = format!(
                "INSERT INTO contacts (id, {}) VALUES (?, {})",
                CHAMPS_CONTACT.join(", "),
                vec!["?"; CHAMPS_CONTACT.len()].join(", ")
            );
            for (ident, valeurs) in &rangs {
                let mut p: Vec<rusqlite::types::Value> = vec![ident.map_or(rusqlite::types::Value::Null, Into::into)];
                p.extend(valeurs.iter().map(|v| v.clone().into()));
                tx.execute(&sql, params_from_iter(p.iter()))?;
            }
            Ok(())
        })?;
        Ok(n)
    }

    /// Nombre de lignes d'une table du schéma.
    pub fn compter(&self, table: &str) -> Res<i64> {
        let table = ["produits", "stock", "transactions", "autoclave", "historique_prix", "contacts", "documents"]
            .into_iter()
            .find(|t| *t == table)
            .ok_or_else(|| Erreur::Interne(format!("table inconnue : {table}")))?;
        Ok(self.connexion()?.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |l| l.get(0))?)
    }
}

fn ouvrir_connexion(chemin: &Path) -> Res<Connection> {
    if chemin.as_os_str().is_empty() {
        return Err(Erreur::Interne("chemin de la base non défini".into()));
    }
    let conn = Connection::open(chemin)?;
    conn.busy_timeout(Duration::from_secs(15))?;
    Ok(conn)
}

fn ajouter_colonne(conn: &Connection, table: &str, definition: &str) {
    // colonne déjà présente : l'erreur est attendue
    let _ = conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {definition}"), []);
}

/// Crée les tables manquantes et applique les migrations de schéma (jamais destructives).
pub fn init_db(conn: &Connection) -> Res<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS produits (
            reference      TEXT PRIMARY KEY,
            nom            TEXT DEFAULT '',
            groupe         TEXT DEFAULT '',
            ref_scannette  TEXT DEFAULT ''
        )",
    )?;
    for d in ["nom TEXT DEFAULT ''", "groupe TEXT DEFAULT ''", "ref_scannette TEXT DEFAULT ''"] {
        ajouter_colonne(conn, "produits", d);
    }
    ajouter_colonne(conn, "produits", "type_stockage TEXT DEFAULT 'unite'");
    ajouter_colonne(conn, "produits", "quantite_par_carton INTEGER DEFAULT 1");
    // Produit qu'on n'achète plus : hors post-it, alertes et liste de courses
    ajouter_colonne(conn, "produits", "arrete INTEGER DEFAULT 0");

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS stock (
            reference        TEXT NOT NULL,
            utilisateur      TEXT NOT NULL,
            quantite         INTEGER DEFAULT 0,
            stock_minimum    INTEGER DEFAULT 0,
            alerte_active    INTEGER DEFAULT 0,
            date_peremption  TEXT DEFAULT '',
            date_import      TEXT DEFAULT '',
            fournisseur      TEXT DEFAULT '',
            en_commande      INTEGER DEFAULT 0,
            date_commande    TEXT DEFAULT '',
            PRIMARY KEY (reference, utilisateur)
        )",
    )?;
    for d in [
        "quantite INTEGER DEFAULT 0",
        "stock_minimum INTEGER DEFAULT 0",
        "alerte_active INTEGER DEFAULT 0",
        "date_peremption TEXT DEFAULT ''",
        "date_import TEXT DEFAULT ''",
        "fournisseur TEXT DEFAULT ''",
        "en_commande INTEGER DEFAULT 0",
        "date_commande TEXT DEFAULT ''",
        "lot TEXT DEFAULT ''",
        "prix_unitaire_ht REAL DEFAULT 0",
        "prix_unitaire_ttc REAL DEFAULT 0",
        "lots_details TEXT DEFAULT '[]'",
        "alerte_peremption_active INTEGER DEFAULT 0",
        "delai_peremption INTEGER DEFAULT 30",
        // Numéro de version de la ligne : +1 à chaque écriture. Détecte deux postes qui
        // modifient la même ligne.
        "version INTEGER DEFAULT 0",
    ] {
        ajouter_colonne(conn, "stock", d);
    }

    // Une seule fois (user_version) : activer la pré-alerte de péremption sur les lignes
    // antérieures à la colonne qui avaient déjà une date.
    let v: i64 = conn.query_row("PRAGMA user_version", [], |l| l.get(0))?;
    if v < 1 {
        conn.execute(
            "UPDATE stock SET alerte_peremption_active = 1 \
             WHERE date_peremption IS NOT NULL AND date_peremption != '' \
               AND (alerte_peremption_active IS NULL OR alerte_peremption_active = 0)",
            [],
        )?;
        conn.execute_batch("PRAGMA user_version = 1")?;
    }

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS transactions (
            id                INTEGER PRIMARY KEY,
            date              TEXT NOT NULL,
            reference         TEXT NOT NULL,
            utilisateur       TEXT NOT NULL,
            type_transaction  TEXT NOT NULL,
            quantite          INTEGER NOT NULL
        )",
    )?;
    ajouter_colonne(conn, "transactions", "lot TEXT DEFAULT ''");
    ajouter_colonne(conn, "transactions", "peremption_sortie TEXT DEFAULT ''");

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS autoclave (
            id           INTEGER PRIMARY KEY,
            date         TEXT NOT NULL,
            machine      TEXT DEFAULT '',
            utilisateur  TEXT NOT NULL,
            commentaire  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS historique_prix (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            reference    TEXT NOT NULL,
            date         TEXT NOT NULL,
            prix_ht      REAL,
            prix_ttc     REAL,
            fournisseur  TEXT
        );
        CREATE TABLE IF NOT EXISTS contacts (
            id            INTEGER PRIMARY KEY,
            nom           TEXT DEFAULT '',
            prenom        TEXT DEFAULT '',
            entreprise    TEXT DEFAULT '',
            email         TEXT DEFAULT '',
            tel_fixe      TEXT DEFAULT '',
            tel_portable  TEXT DEFAULT '',
            adresse       TEXT DEFAULT '',
            code_postal   TEXT DEFAULT '',
            ville         TEXT DEFAULT '',
            note          TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS documents (
            cle         TEXT PRIMARY KEY,
            valeur      TEXT NOT NULL,
            modifie_le  TEXT DEFAULT (datetime('now', 'localtime'))
        );",
    )?;
    // +1 à chaque écriture : détecte deux postes qui réécrivent le même document
    ajouter_colonne(conn, "documents", "version INTEGER DEFAULT 0");
    Ok(())
}

// ---------------------------------------------------------------------- écritures élémentaires

fn maj_produit(conn: &Connection, p: &Value) -> Res<()> {
    let m = exiger_objet(p)?;
    let r = texte(champ(m, "reference")).trim().to_string();
    if r.is_empty() {
        return donnees("La reference du produit est obligatoire.");
    }
    // « arrete » absent (ancien poste, import de facture) : valeur en base conservée
    let arrete: Option<i64> = match champ(m, "arrete") {
        Value::Null => None,
        v => Some(if safe_int(v, 0) != 0 { 1 } else { 0 }),
    };
    let type_stockage = Some(texte(champ(m, "type_stockage"))).filter(|t| !t.is_empty()).unwrap_or_else(|| "unite".into());
    conn.execute(
        "INSERT INTO produits (reference, nom, groupe, ref_scannette, type_stockage, quantite_par_carton, arrete) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, COALESCE(?7, 0)) \
         ON CONFLICT(reference) DO UPDATE SET \
           nom=excluded.nom, groupe=excluded.groupe, ref_scannette=excluded.ref_scannette, \
           type_stockage=excluded.type_stockage, quantite_par_carton=excluded.quantite_par_carton, \
           arrete=COALESCE(?8, produits.arrete)",
        params![
            r,
            texte(champ(m, "nom")),
            texte(champ(m, "groupe")),
            texte(champ(m, "ref_scannette")),
            type_stockage,
            safe_int(champ(m, "quantite_par_carton"), 1).max(1),
            arrete,
            arrete
        ],
    )?;
    Ok(())
}

/// Refuse l'écriture si la ligne a changé depuis que le poste l'a lue.
///
/// « version » absente : ancien poste, pas de contrôle. null : le poste croit la ligne nouvelle.
/// Une ligne déjà écrite plus tôt dans le même lot n'est contrôlée qu'une fois (le poste ne
/// connaît pas encore sa version).
fn verifier_version(conn: &Connection, r: &str, e: &str, s: &Map<String, Value>, deja: &mut HashSet<(String, String)>) -> Res<()> {
    let cle = (r.to_string(), e.to_string());
    if !s.contains_key("version") || deja.contains(&cle) {
        return Ok(());
    }
    deja.insert(cle);
    let actuelle = valeur_stock(conn, "version", r, e)?.map(|v| safe_int(&v, 0));
    let attendue = champ(s, "version");
    let conflit = if attendue.is_null() { actuelle.is_some() } else { actuelle != Some(safe_int(attendue, -1)) };
    if conflit {
        return Err(Erreur::Conflit(format!("« {r} » ({e}) vient d'être modifié depuis un autre poste.")));
    }
    Ok(())
}

fn maj_stock(conn: &Connection, s: &Value, deja: &mut HashSet<(String, String)>) -> Res<Value> {
    let m = exiger_objet(s)?;
    let r = texte(champ(m, "reference")).trim().to_string();
    let e = texte(champ(m, "utilisateur")).trim().to_string();
    if r.is_empty() || e.is_empty() {
        return donnees("Reference et espace obligatoires.");
    }
    let delai = match champ(m, "delai_peremption") {
        Value::Null => 30,
        Value::String(t) if t.is_empty() => 30,
        v => safe_int(v, 30),
    };
    let lots = match m.get("lots_details") {
        None => "[]".to_string(),
        Some(Value::String(t)) => t.clone(),
        Some(v) => json_python(v),
    };
    let lots = if lots.is_empty() { "[]".to_string() } else { lots };
    let drapeau = |k: &str| if safe_int(champ(m, k), 0) != 0 { 1 } else { 0 };

    verifier_version(conn, &r, &e, m, deja)?;
    conn.execute(
        "INSERT INTO stock (reference, utilisateur, quantite, stock_minimum, alerte_active, \
            alerte_peremption_active, delai_peremption, date_peremption, date_import, \
            fournisseur, en_commande, date_commande, lot, prix_unitaire_ht, \
            prix_unitaire_ttc, lots_details, version) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1) \
         ON CONFLICT(reference, utilisateur) DO UPDATE SET \
           quantite=excluded.quantite, stock_minimum=excluded.stock_minimum, \
           alerte_active=excluded.alerte_active, \
           alerte_peremption_active=excluded.alerte_peremption_active, \
           delai_peremption=excluded.delai_peremption, \
           date_peremption=excluded.date_peremption, date_import=excluded.date_import, \
           fournisseur=excluded.fournisseur, en_commande=excluded.en_commande, \
           date_commande=excluded.date_commande, lot=excluded.lot, \
           prix_unitaire_ht=excluded.prix_unitaire_ht, \
           prix_unitaire_ttc=excluded.prix_unitaire_ttc, \
           lots_details=excluded.lots_details, \
           version=COALESCE(stock.version, 0) + 1",
        params![
            r,
            e,
            safe_int(champ(m, "quantite"), 0).max(0),
            safe_int(champ(m, "stock_minimum"), 0),
            drapeau("alerte_active"),
            drapeau("alerte_peremption_active"),
            delai,
            texte(champ(m, "date_peremption")),
            texte(champ(m, "date_import")),
            texte(champ(m, "fournisseur")),
            drapeau("en_commande"),
            texte(champ(m, "date_commande")),
            texte(champ(m, "lot")),
            safe_float(champ(m, "prix_unitaire_ht"), 0.0),
            safe_float(champ(m, "prix_unitaire_ttc"), 0.0),
            lots
        ],
    )?;
    let version = valeur_stock(conn, "version", &r, &e)?.unwrap_or(Value::Null);
    Ok(json!({"reference": r, "utilisateur": e, "version": version}))
}

fn suppr_stock(conn: &Connection, reference: &str, utilisateur: &str) -> Res<()> {
    conn.execute("DELETE FROM stock WHERE reference = ?1 AND utilisateur = ?2", params![reference, utilisateur])?;
    Ok(())
}

fn suppr_produit(conn: &Connection, reference: &str) -> Res<()> {
    conn.execute("DELETE FROM stock WHERE reference = ?1", [reference])?;
    conn.execute("DELETE FROM produits WHERE reference = ?1", [reference])?;
    Ok(())
}

fn ajout_transaction(conn: &Connection, t: &Value) -> Res<i64> {
    let m = exiger_objet(t)?;
    let x = |k: &str| texte(champ(m, k));
    conn.execute(
        "INSERT INTO transactions (date, reference, utilisateur, type_transaction, quantite, lot, peremption_sortie) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![x("date"), x("reference"), x("utilisateur"), x("type_transaction"), safe_int(champ(m, "quantite"), 0), x("lot"), x("peremption_sortie")],
    )?;
    Ok(conn.last_insert_rowid())
}

fn ajout_autoclave(conn: &Connection, a: &Value) -> Res<i64> {
    let m = exiger_objet(a)?;
    let x = |k: &str| texte(champ(m, k));
    if x("utilisateur").trim().is_empty() || x("commentaire").trim().is_empty() {
        return donnees("Utilisateur et commentaire obligatoires.");
    }
    conn.execute(
        "INSERT INTO autoclave (date, machine, utilisateur, commentaire) VALUES (?1, ?2, ?3, ?4)",
        params![x("date"), x("machine"), x("utilisateur"), x("commentaire")],
    )?;
    Ok(conn.last_insert_rowid())
}

fn ajout_historique_prix(conn: &Connection, h: &Value) -> Res<i64> {
    let m = exiger_objet(h)?;
    let x = |k: &str| texte(champ(m, k));
    conn.execute(
        "INSERT INTO historique_prix (reference, date, prix_ht, prix_ttc, fournisseur) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![x("reference"), x("date"), nombre(champ(m, "prix_ht")), nombre(champ(m, "prix_ttc")), x("fournisseur")],
    )?;
    Ok(conn.last_insert_rowid())
}

// ---------------------------------------------------------------------- produits périmés : aucune entrée en stock

/// Date d'un texte JJ/MM/AAAA ou AAAA-MM-JJ, sinon rien.
pub fn date_peremption(t: &str) -> Option<NaiveDate> {
    let t = t.trim();
    NaiveDate::parse_from_str(t, "%d/%m/%Y").or_else(|_| NaiveDate::parse_from_str(t, "%Y-%m-%d")).ok()
}

fn est_perime(t: &str, aujourdhui: NaiveDate) -> bool {
    date_peremption(t).is_some_and(|d| d < aujourdhui)
}

/// [(lot, date, qte)] ; les lots sans quantité se partagent le reste.
fn lots_quantifies(lots_details: &Value, quantite: i64) -> Vec<(String, String, i64)> {
    let t = match lots_details {
        Value::Null => "[]",
        Value::String(s) if s.is_empty() => "[]",
        Value::String(s) => s.as_str(),
        _ => return Vec::new(),
    };
    let Ok(Value::Array(lots)) = serde_json::from_str::<Value>(t) else { return Vec::new() };
    let lots: Vec<&Map<String, Value>> = lots.iter().filter_map(Value::as_object).collect();
    let sans = |l: &Map<String, Value>| matches!(champ(l, "qte"), Value::Null) || champ(l, "qte") == &json!("");
    let connu = lots.iter().filter(|l| !sans(**l)).fold(0i64, |s, l| s.saturating_add(safe_int(champ(l, "qte"), 0).max(0)));
    let reste = quantite.saturating_sub(connu).max(0);
    let n_sans = lots.iter().filter(|l| sans(**l)).count() as i64;
    let (part, mut extra) = if n_sans > 0 { (reste / n_sans, reste % n_sans) } else { (0, 0) };
    lots.iter()
        .map(|l| {
            let qte = if sans(*l) {
                let q = part + if extra > 0 { 1 } else { 0 };
                extra -= 1;
                q
            } else {
                safe_int(champ(l, "qte"), 0).max(0)
            };
            (texte(champ(l, "lot")).trim().to_string(), texte(champ(l, "date")).trim().to_string(), qte)
        })
        .collect()
}

fn dates_texte(t: &Value) -> Vec<String> {
    texte(t).replace(';', ",").split(',').map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).collect()
}

type Ligne = (String, String);

#[derive(Default)]
struct Photo {
    lots: Vec<(Ligne, i64)>, // (lot, date) -> quantité, dans l'ordre de rencontre
    dates: HashSet<String>,
    quantites: Vec<(Ligne, i64)>, // (référence, espace) -> quantité
}

fn lire(v: &[(Ligne, i64)], cle: &Ligne) -> i64 {
    v.iter().find(|(k, _)| k == cle).map_or(0, |(_, q)| *q)
}

/// Lots et dates de péremption des lignes de stock données (référence, espace).
fn photo_peremption(conn: &Connection, touchees: &[Ligne]) -> Res<Photo> {
    let mut p = Photo::default();
    for (r, e) in touchees {
        let ligne = conn
            .query_row(
                "SELECT quantite, lots_details, date_peremption FROM stock WHERE reference = ?1 AND utilisateur = ?2",
                params![r, e],
                |l| Ok((valeur(l.get_ref(0)?), valeur(l.get_ref(1)?), valeur(l.get_ref(2)?))),
            )
            .optional()?;
        let Some((q, lots, dates)) = ligne else { continue };
        let quantite = safe_int(&q, 0).max(0);
        p.quantites.push(((r.clone(), e.clone()), quantite));
        let detail = lots_quantifies(&lots, quantite);
        for (lot, date, qte) in &detail {
            let cle = (lot.clone(), date.clone());
            match p.lots.iter_mut().find(|(k, _)| *k == cle) {
                Some((_, total)) => *total = total.saturating_add(*qte),
                None => p.lots.push((cle, *qte)),
            }
            p.dates.insert(date.clone());
        }
        if detail.is_empty() {
            p.dates.extend(dates_texte(&dates));
        }
    }
    Ok(p)
}

/// Refuse un lot d'écritures qui fait entrer du stock déjà périmé.
///
/// Comparaison globale avant / après sur les lignes touchées : un transfert ou un déplacement
/// d'espace ne fait rien « entrer », il est accepté ; le stock déjà en place qui a périmé depuis
/// reste modifiable.
fn refuser_entrees_perimees(conn: &Connection, touchees: &[Ligne], avant: &Photo) -> Res<()> {
    let aujourdhui = chrono::Local::now().date_naive();
    let apres = photo_peremption(conn, touchees)?;
    let mut perimes: Vec<Ligne> = apres
        .lots
        .iter()
        .filter(|(cle, qte)| *qte > lire(&avant.lots, cle) && est_perime(&cle.1, aujourdhui))
        .map(|(cle, _)| cle.clone())
        .collect();
    // Lignes sans détail par lot : une date périmée nouvelle avec une quantité en hausse
    for ((r, e), qte) in &apres.quantites {
        if *qte <= lire(&avant.quantites, &(r.clone(), e.clone())) {
            continue;
        }
        let lots = valeur_stock(conn, "lots_details", r, e)?.unwrap_or(Value::Null);
        if !lots_quantifies(&lots, *qte).is_empty() {
            continue;
        }
        let dates = valeur_stock(conn, "date_peremption", r, e)?.unwrap_or(Value::Null);
        for date in dates_texte(&dates) {
            if !avant.dates.contains(&date) && est_perime(&date, aujourdhui) {
                perimes.push((String::new(), date));
            }
        }
    }
    if perimes.is_empty() {
        return Ok(());
    }
    let detail: Vec<String> = perimes
        .iter()
        .map(|(lot, date)| format!("{}périmé le {date}", if lot.is_empty() { String::new() } else { format!("lot {lot}, ") }))
        .collect();
    donnees(format!("Entrée refusée : on ne peut pas mettre en stock un produit déjà périmé ({}).", detail.join(", ")))
}

// ---------------------------------------------------------------------- lot d'écritures

fn operation(conn: &Connection, op: &Value, deja: &mut HashSet<(String, String)>) -> Res<Value> {
    let m = exiger_objet(op)?;
    let d = champ(m, "donnees");
    match champ(m, "action").as_str() {
        Some("updateProduit") => maj_produit(conn, d).map(|_| json!({})),
        Some("updateStockItem") => maj_stock(conn, d, deja),
        Some("deleteStockItem") => {
            let d = exiger_objet(d)?;
            suppr_stock(conn, &texte(champ(d, "reference")), &texte(champ(d, "utilisateur"))).map(|_| json!({}))
        }
        Some("deleteProduit") => suppr_produit(conn, &texte(champ(exiger_objet(d)?, "reference"))).map(|_| json!({})),
        Some("addTransaction") => Ok(json!({"id": ajout_transaction(conn, d)?})),
        Some("addAutoclave") => Ok(json!({"id": ajout_autoclave(conn, d)?})),
        Some("addHistoriquePrix") => Ok(json!({"id": ajout_historique_prix(conn, d)?})),
        _ => {
            let a = champ(m, "action");
            donnees(format!("Action inconnue : {}", if a.is_null() { "None".to_string() } else { texte(a) }))
        }
    }
}

/// Lignes de stock (référence, espace) qu'un lot d'opérations peut modifier.
fn lignes_touchees(conn: &Connection, ops: &[Value]) -> Res<Vec<Ligne>> {
    let mut l = BTreeSet::new();
    for op in ops {
        let Some(d) = op.get("donnees").and_then(Value::as_object) else { continue };
        let r = texte(champ(d, "reference")).trim().to_string();
        match op.get("action").and_then(Value::as_str) {
            Some("updateStockItem") | Some("deleteStockItem") => {
                l.insert((r, texte(champ(d, "utilisateur")).trim().to_string()));
            }
            Some("deleteProduit") => {
                let mut st = conn.prepare("SELECT utilisateur FROM stock WHERE reference = ?1")?;
                let espaces = st.query_map([&r], |x| Ok(texte(&valeur(x.get_ref(0)?))))?;
                for e in espaces {
                    l.insert((r.clone(), e?));
                }
            }
            _ => {}
        }
    }
    Ok(l.into_iter().collect())
}

// ---------------------------------------------------------------------- documents

fn cle_valide(cle: &str) -> Res<()> {
    if CLES.contains(&cle) {
        Ok(())
    } else {
        donnees(format!("Document inconnu : {cle}"))
    }
}

/// Valeur stockée décodée, ou le défaut si absente ou abîmée.
fn decoder_document(cle: &str, v: Option<&str>) -> Value {
    v.and_then(|t| serde_json::from_str(t).ok()).unwrap_or_else(|| defaut(cle))
}

// ---------------------------------------------------------------------- essais

#[cfg(test)]
pub(crate) mod aides {
    use super::*;

    pub fn fusion(mut a: Value, b: Value) -> Value {
        if let (Some(m), Value::Object(n)) = (a.as_object_mut(), b) {
            for (k, v) in n {
                m.insert(k, v);
            }
        }
        a
    }

    pub fn produit(r: &str, autres: Value) -> Value {
        fusion(
            json!({"reference": r, "nom": format!("Produit {r}"), "groupe": "G", "ref_scannette": "123",
                   "type_stockage": "unite", "quantite_par_carton": 1}),
            autres,
        )
    }

    pub fn ligne_stock(r: &str, espace: &str, autres: Value) -> Value {
        fusion(
            json!({"reference": r, "utilisateur": espace, "quantite": 5, "stock_minimum": 2,
                   "alerte_active": 1, "alerte_peremption_active": 1, "delai_peremption": 30,
                   "date_peremption": "", "date_import": "01/10/2026", "fournisseur": "Fournisseur X",
                   "en_commande": 0, "date_commande": "", "lot": "", "prix_unitaire_ht": 1.5,
                   "prix_unitaire_ttc": 1.8, "lots_details": "[]"}),
            autres,
        )
    }

    pub fn ligne(autres: Value) -> Value {
        ligne_stock("REF1", "Commun", autres)
    }

    pub fn base_temp() -> (Base, PathBuf) {
        let chemin = crate::dossier_essai("base").join("stock.db");
        (Base::ouvrir(&chemin).unwrap(), chemin)
    }
}

#[cfg(test)]
mod essais {
    use super::aides::*;
    use super::*;

    fn sql(chemin: &Path, requete: &str) {
        Connection::open(chemin).unwrap().execute_batch(requete).unwrap();
    }

    fn conflit<T: std::fmt::Debug>(r: Res<T>) -> bool {
        matches!(r, Err(Erreur::Conflit(_)))
    }

    fn refus<T: std::fmt::Debug>(r: Res<T>) -> bool {
        matches!(r, Err(Erreur::Donnees(_)))
    }

    #[test]
    fn tables_creees() {
        let (_b, chemin) = base_temp();
        let conn = Connection::open(&chemin).unwrap();
        let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").unwrap();
        let tables: Vec<String> = st.query_map([], |l| l.get(0)).unwrap().map(Result::unwrap).collect();
        for t in ["produits", "stock", "transactions", "autoclave", "historique_prix", "contacts", "documents"] {
            assert!(tables.contains(&t.to_string()), "{t}");
        }
    }

    #[test]
    fn base_vide_chargee() {
        let (b, _) = base_temp();
        let db = b.charger_base().unwrap();
        assert_eq!(db["produits"], json!([]));
        assert_eq!(db["stock"], json!([]));
        assert_eq!((db["nextTxId"].as_i64(), db["nextAutoId"].as_i64()), (Some(1), Some(1)));
    }

    #[test]
    fn reprise_d_une_ancienne_base() {
        // Une base de l'ancienne appli (schéma d'origine) est complétée sans perte.
        let chemin = crate::dossier_essai("ancienne").join("ancienne.db");
        sql(
            &chemin,
            "CREATE TABLE produits (reference TEXT PRIMARY KEY, nom TEXT, groupe TEXT, ref_scannette TEXT);
             CREATE TABLE stock (reference TEXT NOT NULL, utilisateur TEXT NOT NULL,
                quantite INTEGER DEFAULT 0, stock_minimum INTEGER DEFAULT 0,
                alerte_active INTEGER DEFAULT 0, date_peremption TEXT DEFAULT '',
                date_import TEXT DEFAULT '', PRIMARY KEY (reference, utilisateur));
             INSERT INTO produits VALUES ('A1', 'Ancien', '', '');
             INSERT INTO stock (reference, utilisateur, quantite, date_peremption) VALUES ('A1', 'Commun', 3, '31/12/2030');",
        );
        let b = Base::ouvrir(&chemin).unwrap();
        let db = b.charger_base().unwrap();
        assert_eq!(db["produits"][0]["type_stockage"], "unite");
        assert_eq!(db["produits"][0]["nom"], "Ancien");
        assert_eq!(db["stock"][0]["quantite"], 3);
        // Pré-alerte activée une seule fois sur les lignes déjà datées
        assert_eq!(db["stock"][0]["alerte_peremption_active"], 1);
        assert_eq!(db["stock"][0]["delai_peremption"], 30);
    }

    #[test]
    fn pre_alerte_non_reactivee_au_redemarrage() {
        let (b, chemin) = base_temp();
        b.update_stock_item(&ligne(json!({"date_peremption": "31/12/2030", "alerte_peremption_active": 0}))).unwrap();
        init_db(&Connection::open(&chemin).unwrap()).unwrap();
        assert_eq!(b.charger_base().unwrap()["stock"][0]["alerte_peremption_active"], 0);
    }

    #[test]
    fn produit_insere_puis_mis_a_jour() {
        let (b, _) = base_temp();
        b.update_produit(&produit("REF1", json!({}))).unwrap();
        b.update_produit(&produit("REF1", json!({"nom": "Renomme", "type_stockage": "carton", "quantite_par_carton": 10}))).unwrap();
        let p = b.charger_base().unwrap()["produits"].clone();
        assert_eq!(p.as_array().unwrap().len(), 1);
        assert_eq!(p[0]["nom"], "Renomme");
        assert_eq!(p[0]["quantite_par_carton"], 10);
    }

    #[test]
    fn produit_arrete_conserve_si_non_transmis() {
        let (b, _) = base_temp();
        let arrete = |b: &Base| b.charger_base().unwrap()["produits"][0]["arrete"].clone();
        b.update_produit(&produit("REF1", json!({}))).unwrap();
        assert_eq!(arrete(&b), 0);
        b.update_produit(&produit("REF1", json!({"arrete": 1}))).unwrap();
        assert_eq!(arrete(&b), 1);
        // Un poste qui ne connaît pas le champ (import de facture…) ne le remet pas à 0
        b.update_produit(&produit("REF1", json!({"nom": "Renomme"}))).unwrap();
        assert_eq!(arrete(&b), 1);
        b.update_produit(&produit("REF1", json!({"arrete": 0}))).unwrap();
        assert_eq!(arrete(&b), 0);
    }

    #[test]
    fn refus_simples() {
        let (b, _) = base_temp();
        assert!(refus(b.update_produit(&json!({"nom": "Sans ref"}))));
        assert!(refus(b.update_stock_item(&json!(["pas", "un", "objet"]))));
        assert!(refus(b.update_stock_item(&ligne(json!({"utilisateur": ""})))));
        assert!(refus(b.add_autoclave(&json!({"date": "d", "utilisateur": "P", "commentaire": " "}))));
        assert!(refus(b.enregistrer_contact(&json!({"email": "x@y.z"}))));
    }

    #[test]
    fn quantite_par_carton_au_moins_un() {
        let (b, _) = base_temp();
        b.update_produit(&produit("REF1", json!({"quantite_par_carton": 0}))).unwrap();
        assert_eq!(b.charger_base().unwrap()["produits"][0]["quantite_par_carton"], 1);
    }

    #[test]
    fn lignes_de_stock() {
        let (b, _) = base_temp();
        b.update_stock_item(&ligne(json!({}))).unwrap();
        b.update_stock_item(&ligne(json!({"quantite": 9, "fournisseur": "Autre"}))).unwrap();
        let s = b.charger_base().unwrap()["stock"].clone();
        assert_eq!(s.as_array().unwrap().len(), 1);
        assert_eq!((s[0]["quantite"].clone(), s[0]["fournisseur"].clone()), (json!(9), json!("Autre")));
        b.update_stock_item(&ligne_stock("REF1", "Cabinet 1", json!({}))).unwrap();
        assert_eq!(b.charger_base().unwrap()["stock"].as_array().unwrap().len(), 2);
        b.delete_stock_item("REF1", "Commun").unwrap();
        let s = b.charger_base().unwrap()["stock"].clone();
        assert_eq!(s.as_array().unwrap().len(), 1);
        assert_eq!(s[0]["utilisateur"], "Cabinet 1");
    }

    #[test]
    fn conversions_a_l_ecriture() {
        let (b, _) = base_temp();
        b.update_stock_item(&ligne(json!({"quantite": -4, "prix_unitaire_ht": "1 234,50", "prix_unitaire_ttc": "abc", "delai_peremption": ""})))
            .unwrap();
        let s = b.charger_base().unwrap()["stock"][0].clone();
        assert_eq!(s["quantite"], 0);
        assert!((s["prix_unitaire_ht"].as_f64().unwrap() - 1234.5).abs() < 1e-9);
        assert_eq!(s["prix_unitaire_ttc"].as_f64(), Some(0.0));
        assert_eq!(s["delai_peremption"], 30);
    }

    #[test]
    fn json_comme_python() {
        assert_eq!(json_python(&json!([{"lot": "L1", "qte": 5}, "é", null])), r#"[{"lot": "L1", "qte": 5}, "é", null]"#);
        assert_eq!(json_python(&json!({})), "{}");
    }

    #[test]
    fn lots_details_objet_serialise() {
        let (b, _) = base_temp();
        let lots = json!([{"lot": "L1", "date": "01/01/2030", "qte": 5}]);
        b.update_stock_item(&ligne(json!({"lots_details": lots.clone()}))).unwrap();
        let lu: Value = serde_json::from_str(b.charger_base().unwrap()["stock"][0]["lots_details"].as_str().unwrap()).unwrap();
        assert_eq!(lu, lots);
    }

    #[test]
    fn suppression_produit_retire_tout_son_stock() {
        let (b, _) = base_temp();
        b.update_produit(&produit("REF1", json!({}))).unwrap();
        b.update_stock_item(&ligne(json!({}))).unwrap();
        b.update_stock_item(&ligne_stock("REF1", "Cabinet 1", json!({}))).unwrap();
        b.delete_produit("REF1").unwrap();
        let db = b.charger_base().unwrap();
        assert_eq!((db["produits"].clone(), db["stock"].clone()), (json!([]), json!([])));
    }

    #[test]
    fn transactions_maintenance_prix() {
        let (b, _) = base_temp();
        // Deux postes peuvent proposer le même id : la base l'ignore et numérote.
        let t = json!({"id": 7, "date": "2026-10-01T10:00:00Z", "reference": "REF1", "utilisateur": "Salle de chir",
                       "type_transaction": "SORTIE_STOCK", "quantite": 2, "lot": "L42", "peremption_sortie": "01/01/2030"});
        let (id1, id2) = (b.add_transaction(&t).unwrap(), b.add_transaction(&t).unwrap());
        assert_ne!(id1, id2);
        let db = b.charger_base().unwrap();
        assert_eq!(db["nextTxId"], id2 + 1);
        assert_eq!((db["transactions"][0]["lot"].clone(), db["transactions"][0]["peremption_sortie"].clone()), (json!("L42"), json!("01/01/2030")));
        let ident = b.add_autoclave(&json!({"date": "01/10/2026", "machine": "Melag", "utilisateur": "Personne", "commentaire": "Filtre"})).unwrap();
        let a = b.charger_base().unwrap()["autoclave"][0].clone();
        assert_eq!((a["id"].clone(), a["machine"].clone()), (json!(ident), json!("Melag")));
        b.add_historique_prix(&json!({"reference": "R", "date": "d", "prix_ht": "2,5", "prix_ttc": null, "fournisseur": "F"})).unwrap();
        let h = b.charger_base().unwrap()["historique_prix"][0].clone();
        assert_eq!((h["prix_ht"].as_f64(), h["prix_ttc"].clone()), (Some(2.5), Value::Null));
    }

    #[test]
    fn documents() {
        let (b, chemin) = base_temp();
        let docs = b.lire_documents().unwrap();
        assert_eq!(docs.as_object().unwrap().len(), CLES.len());
        assert_eq!(docs["planning"], json!({"even": [], "odd": []}));
        assert_eq!(docs["dosimetres"]["manager"], "");
        b.ecrire_document("planning", &json!({"even": [{"assistant": "A"}], "odd": []}), None).unwrap();
        assert_eq!(b.lire_document("planning").unwrap()["even"][0]["assistant"], "A");
        assert!(b.document_present("planning").unwrap());
        assert!(refus(b.ecrire_document("../etc", &json!({}), None)));
        assert!(refus(b.lire_document("inconnu")));
        assert!(refus(b.ecrire_document("notes", &Value::Null, None)));
        // Document abîmé : retour au défaut, lu ensemble comme un par un
        sql(&chemin, "INSERT INTO documents (cle, valeur) VALUES ('taches', '{casse')");
        assert_eq!(b.lire_document("taches").unwrap(), defaut("taches"));
        let docs = b.lire_documents().unwrap();
        for cle in CLES {
            assert_eq!(docs[*cle], b.lire_document(cle).unwrap());
        }
    }

    #[test]
    fn document_version_perimee_refusee() {
        let (b, _) = base_temp();
        assert_eq!(b.versions_documents().unwrap()["notes"], 0);
        assert_eq!(b.ecrire_document("notes", &json!({"items": ["A"]}), Some(0)).unwrap()["version"], 1);
        assert!(conflit(b.ecrire_document("notes", &json!({"items": ["B"]}), Some(0))));
        assert_eq!(b.lire_document("notes").unwrap(), json!({"items": ["A"]}));
        b.ecrire_document("notes", &json!({"items": ["C"]}), None).unwrap();
        assert_eq!(b.versions_documents().unwrap()["notes"], 2);
    }

    #[test]
    fn contacts() {
        let (b, _) = base_temp();
        let c = b.enregistrer_contact(&json!({"nom": "Labo", "tel_fixe": "01"})).unwrap();
        b.enregistrer_contact(&json!({"id": c["id"], "nom": "Labo", "tel_fixe": "02"})).unwrap();
        let l = b.lister_contacts().unwrap();
        assert_eq!((l.len(), l[0]["tel_fixe"].clone()), (1, json!("02")));
        b.supprimer_contact(&c["id"]).unwrap();
        assert!(b.lister_contacts().unwrap().is_empty());
        // Un id inconnu crée le contact
        let c = b.enregistrer_contact(&json!({"id": 999, "entreprise": "E"})).unwrap();
        assert_eq!(b.lister_contacts().unwrap()[0]["id"], c["id"]);
    }

    #[test]
    fn remplacer_contacts_tolere_les_doublons_d_id() {
        let (b, _) = base_temp();
        let n = b.remplacer_contacts(&json!([{"id": 1, "nom": "A"}, {"id": 1, "nom": "B"}, "pas un contact", {"nom": "C"}])).unwrap();
        assert_eq!(n, 3);
        let mut noms: Vec<String> = b.lister_contacts().unwrap().iter().map(|c| texte(&c["nom"])).collect();
        noms.sort();
        assert_eq!(noms, ["A", "B", "C"]);
    }

    #[test]
    fn revision() {
        let (b, _) = base_temp();
        let r1 = b.revision();
        b.charger_base().unwrap();
        b.lire_documents().unwrap();
        assert_eq!(b.revision(), r1);
        b.update_produit(&produit("REF1", json!({}))).unwrap();
        let r2 = b.revision();
        b.ecrire_document("record_jeu", &json!(12), None).unwrap();
        let r3 = b.revision();
        assert!(r1 != r2 && r2 != r3 && r1 != r3);
        // une écriture en échec ne change pas la révision
        assert!(refus(b.update_produit(&json!({}))));
        assert_eq!(b.revision(), r3);
    }

    #[test]
    fn safe_float_et_safe_int() {
        for (v, a) in [
            (json!(null), 0.0),
            (json!(""), 0.0),
            (json!(3), 3.0),
            (json!("2,5"), 2.5),
            (json!(" 1 000 "), 1000.0),
            (json!("x"), 0.0),
            (json!("1e999"), 0.0),
            (json!("nan"), 0.0),
            (json!(1e300), 1e300),
        ] {
            assert_eq!(safe_float(&v, 0.0), a, "{v}");
        }
        for (v, a) in [
            (json!(null), 0),
            (json!(""), 0),
            (json!("12"), 12),
            (json!(3.9), 3),
            (json!("x"), 0),
            (json!("1e999"), 0),
            (json!("nan"), 0),
            (json!(1e30), 0),
            (json!(i64::MAX), i64::MAX),
            (json!(i64::MIN), i64::MIN),
        ] {
            assert_eq!(safe_int(&v, 0), a, "{v}");
        }
    }

    #[test]
    fn nombres_hors_limites_ne_bloquent_pas_l_ecriture() {
        let (b, _) = base_temp();
        b.update_stock_item(&json!({"reference": "A", "utilisateur": "Reserve", "quantite": "1e999", "stock_minimum": 1e30, "prix_unitaire_ht": "1e999"}))
            .unwrap();
        let l = b.charger_base().unwrap()["stock"][0].clone();
        assert_eq!((l["quantite"].clone(), l["stock_minimum"].clone()), (json!(0), json!(0)));
        assert_eq!(l["prix_unitaire_ht"].as_f64(), Some(0.0));
    }

    // -------------------------------------------------------------- conflits entre postes

    fn version(b: &Base) -> Value {
        b.charger_base().unwrap()["stock"][0]["version"].clone()
    }

    #[test]
    fn versions_et_conflits() {
        let (b, _) = base_temp();
        assert_eq!(b.update_stock_item(&ligne(json!({}))).unwrap()["version"], 1);
        assert_eq!(b.update_stock_item(&ligne(json!({"quantite": 4}))).unwrap()["version"], 2);
        assert_eq!(version(&b), 2);
        // version à jour : acceptée ; périmée : refusée sans rien écrire
        b.update_stock_item(&ligne(json!({"quantite": 8, "version": 2}))).unwrap();
        assert!(conflit(b.update_stock_item(&ligne(json!({"quantite": 7, "version": 2})))));
        let s = b.charger_base().unwrap()["stock"][0].clone();
        assert_eq!((s["quantite"].clone(), s["version"].clone()), (json!(8), json!(3)));
        // ancien poste sans version : pas de contrôle
        b.update_stock_item(&ligne(json!({"quantite": 1}))).unwrap();
        assert_eq!(version(&b), 4);
    }

    #[test]
    fn creation_ou_suppression_ailleurs_refusee() {
        let (b, _) = base_temp();
        b.update_stock_item(&ligne(json!({"version": null}))).unwrap();
        assert!(conflit(b.update_stock_item(&ligne(json!({"version": null})))));
        b.delete_stock_item("REF1", "Commun").unwrap();
        assert!(conflit(b.update_stock_item(&ligne(json!({"version": 1})))));
    }

    #[test]
    fn lot_tout_ou_rien() {
        let (b, _) = base_temp();
        b.update_stock_item(&ligne(json!({}))).unwrap();
        b.update_stock_item(&ligne(json!({"quantite": 9}))).unwrap(); // v2 ailleurs
        let r = b.revision();
        let ops = json!([
            {"action": "addTransaction", "donnees": {"date": "2026-10-04", "reference": "REF1", "utilisateur": "Commun",
                                                     "type_transaction": "SORTIE_STOCK", "quantite": 2}},
            {"action": "updateStockItem", "donnees": ligne(json!({"quantite": 3, "version": 1}))},
        ]);
        assert!(conflit(b.executer_lot(&ops)));
        assert_eq!(b.charger_base().unwrap()["transactions"], json!([]));
        assert_eq!(b.revision(), r);
    }

    #[test]
    fn lot_execute_et_resultats() {
        let (b, _) = base_temp();
        let res = b
            .executer_lot(&json!([
                {"action": "updateProduit", "donnees": produit("REF1", json!({}))},
                {"action": "updateStockItem", "donnees": ligne(json!({"version": null}))},
                {"action": "updateStockItem", "donnees": ligne(json!({"quantite": 2, "version": null}))},
                {"action": "addTransaction", "donnees": {"date": "d", "reference": "REF1", "utilisateur": "Commun",
                                                         "type_transaction": "ENTREE", "quantite": 5}},
            ]))
            .unwrap();
        assert_eq!(res[1], json!({"reference": "REF1", "utilisateur": "Commun", "version": 1}));
        // Même ligne deux fois dans le lot : contrôlée une seule fois
        assert_eq!(res[2]["version"], 2);
        assert_eq!(res[3]["id"], 1);
        b.executer_lot(&json!([
            {"action": "deleteStockItem", "donnees": {"reference": "REF1", "utilisateur": "Commun"}},
            {"action": "deleteProduit", "donnees": {"reference": "REF1"}},
        ]))
        .unwrap();
        assert_eq!(b.charger_base().unwrap()["produits"], json!([]));
    }

    #[test]
    fn lot_invalide_refuse() {
        let (b, _) = base_temp();
        for ops in [json!(null), json!([]), json!("x"), json!([{"action": "inconnue"}]), json!(["x"])] {
            assert!(refus(b.executer_lot(&ops)), "{ops}");
        }
    }

    // -------------------------------------------------------------- produits périmés

    fn jour(n: i64) -> String {
        (chrono::Local::now().date_naive() + chrono::Duration::days(n)).format("%d/%m/%Y").to_string()
    }

    fn lots(l: &[(&str, &str, i64)]) -> String {
        Value::Array(l.iter().map(|(lot, d, q)| json!({"lot": lot, "date": d, "qte": q})).collect()).to_string()
    }

    fn maj(autres: Value) -> Value {
        json!({"action": "updateStockItem", "donnees": ligne(autres)})
    }

    #[test]
    fn dates_de_peremption() {
        let d = |a, m, j| NaiveDate::from_ymd_opt(a, m, j);
        assert_eq!(date_peremption("31/12/2026"), d(2026, 12, 31));
        assert_eq!(date_peremption("2026-12-31"), d(2026, 12, 31));
        assert_eq!(date_peremption("1/2/2027"), d(2027, 2, 1));
        assert_eq!(date_peremption(""), None);
        assert_eq!(date_peremption("bientot"), None);
    }

    #[test]
    fn entree_perimee_refusee() {
        let (b, _) = base_temp();
        let r = b.update_stock_item(&ligne(json!({"quantite": 3, "lots_details": lots(&[("V", jour(-1).as_str(), 3)])})));
        assert!(matches!(&r, Err(Erreur::Donnees(m)) if m.contains("périmé")), "{r:?}");
        assert_eq!(b.charger_base().unwrap()["stock"], json!([]));
        // lot du jour : accepté
        b.update_stock_item(&ligne(json!({"quantite": 3, "lots_details": lots(&[("A", jour(0).as_str(), 3)])}))).unwrap();
    }

    #[test]
    fn stock_deja_perime_reste_modifiable() {
        let (b, chemin) = base_temp();
        b.update_stock_item(&ligne(json!({"quantite": 3, "lots_details": lots(&[("V", jour(5).as_str(), 3)])}))).unwrap();
        // Le lot a périmé depuis : on simule en réécrivant la date directement
        let conn = Connection::open(&chemin).unwrap();
        conn.execute("UPDATE stock SET lots_details = ?1", [lots(&[("V", jour(-2).as_str(), 3)])]).unwrap();
        b.update_stock_item(&ligne(json!({"quantite": 2, "stock_minimum": 9, "lots_details": lots(&[("V", jour(-2).as_str(), 2)])}))).unwrap();
        assert!(refus(b.update_stock_item(&ligne(json!({"quantite": 5, "lots_details": lots(&[("V", jour(-2).as_str(), 5)])})))));
    }

    #[test]
    fn lot_sans_quantite_et_ligne_sans_detail() {
        let (b, _) = base_temp();
        let detail = json!([{"lot": "A", "date": jour(9), "qte": 2}, {"lot": "V", "date": jour(-9)}]).to_string();
        assert!(refus(b.update_stock_item(&ligne(json!({"quantite": 5, "lots_details": detail})))));
        assert!(refus(b.update_stock_item(&ligne(json!({"quantite": 5, "date_peremption": jour(-3)})))));
        b.update_stock_item(&ligne(json!({"quantite": 5, "date_peremption": jour(30)}))).unwrap();
    }

    #[test]
    fn transfert_d_un_lot_perime_accepte() {
        let (b, chemin) = base_temp();
        let vieux = jour(-4);
        let conn = Connection::open(&chemin).unwrap();
        conn.execute(
            "INSERT INTO stock (reference, utilisateur, quantite, lots_details) VALUES ('REF1', 'Reserve', 4, ?1)",
            [lots(&[("V", vieux.as_str(), 4)])],
        )
        .unwrap();
        b.executer_lot(&json!([
            maj(json!({"utilisateur": "Reserve", "quantite": 0, "lots_details": "[]"})),
            maj(json!({"utilisateur": "Salle 1", "quantite": 4, "lots_details": lots(&[("V", vieux.as_str(), 4)])})),
        ]))
        .unwrap();
        // … mais pas une entrée qui en ajoute au passage
        assert!(refus(b.executer_lot(&json!([maj(json!({"utilisateur": "Salle 1", "quantite": 6, "lots_details": lots(&[("V", vieux.as_str(), 6)])}))]))));
    }

    #[test]
    fn lot_refuse_ne_garde_rien() {
        let (b, _) = base_temp();
        assert!(refus(b.executer_lot(&json!([
            {"action": "addTransaction", "donnees": {"date": "d", "reference": "REF1", "utilisateur": "Commun",
                                                     "type_transaction": "ENTREE_LOT", "quantite": 2}},
            maj(json!({"quantite": 2, "lots_details": lots(&[("V", jour(-1).as_str(), 2)])})),
        ]))));
        assert_eq!(b.charger_base().unwrap()["transactions"], json!([]));
    }
}
