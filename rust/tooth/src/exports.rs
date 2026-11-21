//! Exports Excel.
//!
//! Chaque export rend {"status": "Succès", "nom_fichier", "contenu_base64", …}, ou
//! {"status": "<message>"} quand il n'y a rien à exporter. C'est le navigateur du poste qui
//! demande l'export qui reçoit le fichier.
//!
//! Les feuilles sont d'abord construites en mémoire (`Feuille`), puis écrites en .xlsx : les
//! essais vérifient le contenu sans relire le fichier.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use base64::Engine;
use chrono::NaiveDate;
use rust_xlsxwriter::{Chart, ChartType, Format, Workbook, XlsxError};
use serde_json::{json, Value};

use crate::base::{texte, vrai, Erreur, Res, NUL};

/// Espace dont les sorties sont extraites pour la traçabilité chirurgie.
/// Doit rester aligné sur ESPACES_SUIVI_LOT dans web/js/core/constants.js
pub const ESPACE_CHIRURGIE: &str = "Salle de chir";

#[derive(Debug, Clone, PartialEq)]
pub enum Cellule {
    Texte(String),
    Nombre(f64),
    Vide,
}

/// Un graphique en colonnes : une ligne de la feuille `source` (colonnes col1..=col2), placé en
/// (ligne_ou, col_ou) de sa feuille. Indices à partir de 0.
#[derive(Debug, Clone)]
pub struct Graphique {
    pub titre: String,
    pub source: String,
    pub ligne: u32,
    pub col1: u16,
    pub col2: u16,
    pub ligne_ou: u32,
    pub col_ou: u16,
}

#[derive(Debug, Default)]
pub struct Feuille {
    pub nom: String,
    pub lignes: Vec<Vec<Cellule>>,
    pub gras: Vec<usize>,
    pub graphiques: Vec<Graphique>,
}

pub enum Sortie {
    Message(String),
    Classeur { nom: String, feuilles: Vec<Feuille>, references: Option<Vec<String>> },
}

/// Neutralise l'injection de formule Excel (CWE-1237) : =, +, -, @, tabulation, retour chariot.
pub fn neutraliser(val: &str) -> String {
    let dangereux = val.starts_with(['=', '+', '-', '@', '\t', '\r']) || val.trim_start().starts_with(['=', '+', '-', '@']);
    if dangereux {
        format!("'{val}")
    } else {
        val.to_string()
    }
}

fn cellule(v: &Value) -> Cellule {
    match v {
        Value::Null => Cellule::Vide,
        Value::Number(n) => Cellule::Nombre(n.as_f64().unwrap_or(0.0)),
        autre => Cellule::Texte(neutraliser(&texte(autre))),
    }
}

fn mot(t: &str) -> Cellule {
    Cellule::Texte(neutraliser(t))
}

fn ligne_titres(titres: &[&str]) -> Vec<Cellule> {
    titres.iter().map(|t| Cellule::Texte(t.to_string())).collect()
}

/// Nombre lu comme le faisait l'export Python (`float(x or 0)`), 0 sinon.
fn flottant(v: &Value) -> f64 {
    let f = match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.trim().parse().unwrap_or(0.0),
        Value::Bool(b) => *b as i64 as f64,
        _ => 0.0,
    };
    if f.is_finite() {
        f
    } else {
        0.0
    }
}

fn entier(v: &Value) -> i64 {
    flottant(v) as i64
}

fn arrondi2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// La valeur d'un champ, ou `defaut` s'il est absent (dict.get(cle, defaut) de Python).
fn lire<'a>(v: &'a Value, cle: &str, defaut: &'a Value) -> &'a Value {
    v.get(cle).unwrap_or(defaut)
}

fn liste<'a>(db: &'a Value, cle: &str) -> &'a [Value] {
    db[cle].as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// 'unite' -> « À l'unité » ; carton de 10, qte 32 -> « 3 cartons de 10 + 2 unité(s) ».
/// Doit rester aligné sur CONDITIONNEMENTS dans web/js/core/constants.js
pub fn describe_conditionnement(type_stockage: &Value, par_contenant: &Value, quantite: i64) -> String {
    let label = match type_stockage.as_str() {
        Some("carton") => "carton",
        Some("boite") => "boîte",
        _ => return "À l'unité".into(),
    };
    let par = match par_contenant {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(1),
        Value::String(s) if !s.is_empty() => s.trim().parse().unwrap_or(1),
        Value::Bool(b) => *b as i64,
        _ => 1,
    };
    if par <= 1 {
        return "À l'unité".into();
    }
    let qte = quantite.max(0);
    let (contenants, vrac) = (qte / par, qte % par);
    let pluriel = if contenants > 1 { "s" } else { "" };
    match (contenants, vrac) {
        (0, v) => format!("{v} unité(s) ({label} de {par})"),
        (c, 0) => format!("{c} {label}{pluriel} de {par}"),
        (c, v) => format!("{c} {label}{pluriel} de {par} + {v} unité(s)"),
    }
}

/// Titre de feuille permis par Excel, unique dans le classeur.
fn titre_feuille(feuilles: &[Feuille], brut: &str, defaut: &str) -> String {
    let t: String = brut.chars().filter(|c| !"[]*?:".contains(*c)).map(|c| if c == '/' || c == '\\' { '_' } else { c }).collect();
    let t: String = t.trim_matches('\'').chars().take(31).collect();
    let mut t = if t.is_empty() { defaut.to_string() } else { t };
    let base = t.clone();
    let mut n = 1;
    while feuilles.iter().any(|f| f.nom.to_lowercase() == t.to_lowercase()) {
        let suffixe = format!("_{n}");
        t = base.chars().take(31 - suffixe.chars().count()).collect::<String>() + &suffixe;
        n += 1;
    }
    t
}

fn xl(e: XlsxError) -> Erreur {
    Erreur::Interne(format!("xlsx : {e}"))
}

/// Le classeur .xlsx des feuilles.
pub fn octets(feuilles: &[Feuille]) -> Res<Vec<u8>> {
    let mut wb = Workbook::new();
    let gras = Format::new().set_bold();
    for f in feuilles {
        let ws = wb.add_worksheet();
        ws.set_name(f.nom.as_str()).map_err(xl)?;
        for (i, ligne) in f.lignes.iter().enumerate() {
            let (r, g) = (i as u32, f.gras.contains(&i));
            for (j, c) in ligne.iter().enumerate() {
                let col = j as u16;
                match c {
                    Cellule::Texte(t) if g => ws.write_string_with_format(r, col, t.as_str(), &gras).map(|_| ()),
                    Cellule::Texte(t) => ws.write_string(r, col, t.as_str()).map(|_| ()),
                    Cellule::Nombre(x) if g => ws.write_number_with_format(r, col, *x, &gras).map(|_| ()),
                    Cellule::Nombre(x) => ws.write_number(r, col, *x).map(|_| ()),
                    Cellule::Vide => Ok(()),
                }
                .map_err(xl)?;
            }
        }
        for g in &f.graphiques {
            let mut chart = Chart::new(ChartType::Column);
            chart
                .add_series()
                .set_values((g.source.as_str(), g.ligne, g.col1, g.ligne, g.col2))
                .set_categories((g.source.as_str(), 0, g.col1, 0, g.col2));
            chart.title().set_name(g.titre.as_str());
            chart.x_axis().set_name("Mois");
            chart.y_axis().set_name("Quantité");
            chart.set_style(13);
            chart.set_width(680).set_height(378); // 18 × 10 cm
            ws.insert_chart(g.ligne_ou, g.col_ou, &chart).map_err(xl)?;
        }
    }
    wb.save_to_buffer().map_err(xl)
}

/// La réponse JSON d'un export.
pub fn rendre(s: Sortie) -> Res<Value> {
    match s {
        Sortie::Message(m) => Ok(json!({"status": m})),
        Sortie::Classeur { nom, feuilles, references } => {
            let contenu = base64::engine::general_purpose::STANDARD.encode(octets(&feuilles)?);
            let mut r = json!({"status": "Succès", "nom_fichier": nom});
            if let Some(refs) = references {
                r["references"] = json!(refs);
            }
            r["contenu_base64"] = json!(contenu);
            Ok(r)
        }
    }
}

fn produits_par_ref(db: &Value) -> HashMap<String, &Value> {
    liste(db, "produits").iter().map(|p| (texte(&p["reference"]), p)).collect()
}

fn noms_par_ref(db: &Value) -> HashMap<String, Value> {
    let vide = json!("");
    liste(db, "produits").iter().map(|p| (texte(&p["reference"]), lire(p, "nom", &vide).clone())).collect()
}

// ---------------------------------------------------------------------- export du stock

/// Un onglet par espace et un récapitulatif.
pub fn export_stock(db: &Value) -> Sortie {
    let produits = produits_par_ref(db);
    let (vide, unite, un) = (json!(""), json!("unite"), json!(1));
    let mut espaces: Vec<(String, Vec<&Value>)> = Vec::new();
    for s in liste(db, "stock") {
        if !vrai(&s["utilisateur"]) {
            continue;
        }
        let e = texte(&s["utilisateur"]);
        match espaces.iter_mut().find(|(n, _)| *n == e) {
            Some((_, l)) => l.push(s),
            None => espaces.push((e, vec![s])),
        }
    }
    let mut feuilles: Vec<Feuille> = Vec::new();
    if espaces.is_empty() {
        feuilles.push(Feuille { nom: "Stock".into(), ..Feuille::default() });
    }
    let entetes = [
        "Référence",
        "Nom",
        "Fournisseur",
        "Quantité",
        "Conditionnement",
        "Prix Unitaire HT",
        "Prix Unitaire TTC",
        "Valeur Totale HT",
        "Valeur Totale TTC",
    ];
    let mut recap: Vec<(String, f64, f64)> = Vec::new();
    let (mut total_ht, mut total_ttc) = (0.0, 0.0);
    for (espace, lignes) in &espaces {
        let mut f = Feuille { nom: titre_feuille(&feuilles, espace, "Espace"), gras: vec![0], ..Feuille::default() };
        f.lignes.push(ligne_titres(&entetes));
        let (mut ht, mut ttc) = (0.0, 0.0);
        for item in lignes {
            let r = lire(item, "reference", &vide);
            let p = produits.get(&texte(r)).copied().unwrap_or(&NUL);
            let qte = entier(&item["quantite"]);
            let (p_ht, p_ttc) = (flottant(&item["prix_unitaire_ht"]), flottant(&item["prix_unitaire_ttc"]));
            let (v_ht, v_ttc) = (p_ht * qte as f64, p_ttc * qte as f64);
            f.lignes.push(vec![
                cellule(r),
                cellule(lire(p, "nom", &vide)),
                cellule(lire(item, "fournisseur", &vide)),
                Cellule::Nombre(qte as f64),
                mot(&describe_conditionnement(lire(p, "type_stockage", &unite), lire(p, "quantite_par_carton", &un), qte)),
                Cellule::Nombre(arrondi2(p_ht)),
                Cellule::Nombre(arrondi2(p_ttc)),
                Cellule::Nombre(arrondi2(v_ht)),
                Cellule::Nombre(arrondi2(v_ttc)),
            ]);
            ht += v_ht;
            ttc += v_ttc;
        }
        recap.push((espace.clone(), ht, ttc));
        total_ht += ht;
        total_ttc += ttc;
        feuilles.push(f);
    }
    let mut f = Feuille { nom: titre_feuille(&feuilles, "Récapitulatif", "Espace"), gras: vec![0, 2], ..Feuille::default() };
    f.lignes.push(vec![Cellule::Texte("TOTAL GÉNÉRAL".into()), Cellule::Nombre(arrondi2(total_ht)), Cellule::Nombre(arrondi2(total_ttc))]);
    f.lignes.push(Vec::new());
    f.lignes.push(ligne_titres(&["Espace", "Valeur Totale HT", "Valeur Totale TTC"]));
    for (espace, ht, ttc) in recap {
        f.lignes.push(vec![mot(&espace), Cellule::Nombre(arrondi2(ht)), Cellule::Nombre(arrondi2(ttc))]);
    }
    feuilles.push(f);
    Sortie::Classeur { nom: "Export_Stock.xlsx".into(), feuilles, references: None }
}

// ---------------------------------------------------------------------- liste de courses

/// Articles en alerte, au minimum ou en dessous, et pas déjà commandés.
pub fn liste_courses(db: &Value) -> Sortie {
    let noms = noms_par_ref(db);
    let arretes: HashSet<String> = liste(db, "produits").iter().filter(|p| entier(&p["arrete"]) != 0).map(|p| texte(&p["reference"])).collect();
    let vide = json!("");
    let mut a_commander: Vec<(String, Vec<Cellule>)> = Vec::new();
    for s in liste(db, "stock") {
        if entier(&s["alerte_active"]) == 0 || entier(&s["en_commande"]) != 0 {
            continue;
        }
        if arretes.contains(&texte(&s["reference"])) {
            continue; // on ne l'achète plus
        }
        if entier(&s["quantite"]) <= entier(&s["stock_minimum"]) {
            let r = texte(lire(s, "reference", &vide));
            if !r.is_empty() && !a_commander.iter().any(|(x, _)| *x == r) {
                let ligne = vec![cellule(lire(s, "fournisseur", &vide)), mot(&r), cellule(noms.get(&r).unwrap_or(&vide))];
                a_commander.push((r, ligne));
            }
        }
    }
    if a_commander.is_empty() {
        return Sortie::Message("Aucun article en rupture ou sous le seuil minimum n'a été trouvé.".into());
    }
    let mut f = Feuille { nom: "Liste de Courses".into(), gras: vec![0], ..Feuille::default() };
    f.lignes.push(ligne_titres(&["Fournisseur", "Référence", "Nom"]));
    let mut references = Vec::new();
    for (r, ligne) in a_commander {
        f.lignes.push(ligne);
        references.push(r);
    }
    Sortie::Classeur { nom: "Liste_de_courses.xlsx".into(), feuilles: vec![f], references: Some(references) }
}

// ---------------------------------------------------------------------- statistiques de consommation

/// Doit rester aligné sur le filtre de l'aperçu (web/settings.js).
pub fn est_consommation(type_tx: &str, qte: i64) -> (bool, i64) {
    let upper = type_tx.to_uppercase();
    if upper.contains("MODIFICATION") || upper.contains("TRANSFERT") {
        return (false, 0);
    }
    // Insensible à la casse : "SORTIE_STOCK", "Sortie (...)", "SORTIE"…
    if upper.contains("SORTIE") {
        return (true, qte);
    }
    if type_tx == "AJUSTEMENT_MANUEL" && qte < 0 {
        return (true, qte.abs());
    }
    (false, 0)
}

/// Le jour d'une transaction (format ISO, AAAA-MM-JJ en tête), ou rien.
pub fn jour(date: &Value) -> Option<NaiveDate> {
    let t: String = texte(date).trim().chars().take(10).collect();
    NaiveDate::parse_from_str(&t, "%Y-%m-%d").ok()
}

pub fn stats_consommation(db: &Value, references: &Value) -> Sortie {
    let demandees: Vec<String> = references.as_array().map(|a| a.iter().map(texte).collect()).unwrap_or_default();
    if demandees.is_empty() {
        return Sortie::Message("Erreur: Aucune référence sélectionnée.".into());
    }
    let mut choix: HashSet<String> = demandees.into_iter().collect();
    if choix.remove("TOUTES") {
        choix.extend(liste(db, "transactions").iter().map(|t| texte(&t["reference"])));
    }
    let inconnu = json!("Inconnu");
    let mut conso: Vec<((String, String), BTreeMap<String, i64>)> = Vec::new();
    for t in liste(db, "transactions") {
        let r = texte(&t["reference"]);
        if !choix.contains(&r) {
            continue;
        }
        let (ok, qte) = est_consommation(&texte(&t["type_transaction"]), entier(&t["quantite"]));
        let Some(mois) = ok.then(|| jour(&t["date"])).flatten().map(|j| j.format("%Y-%m").to_string()) else { continue };
        let cle = (r, texte(lire(t, "utilisateur", &inconnu)));
        let i = match conso.iter().position(|(k, _)| *k == cle) {
            Some(i) => i,
            None => {
                conso.push((cle, BTreeMap::new()));
                conso.len() - 1
            }
        };
        *conso[i].1.entry(mois).or_insert(0) += qte;
    }
    if conso.is_empty() {
        return Sortie::Message("Aucune donnée de consommation pour ces références.".into());
    }
    let noms = noms_par_ref(db);
    let vide = json!("");
    let tous_mois: Vec<String> = conso.iter().flat_map(|(_, d)| d.keys().cloned()).collect::<BTreeSet<_>>().into_iter().collect();
    let source = "Résumé Consommation";
    let mut f = Feuille { nom: source.into(), gras: vec![0], ..Feuille::default() };
    let mut titres = ligne_titres(&["Référence", "Nom", "Espace", "Moyenne Mensuelle"]);
    titres.extend(tous_mois.iter().map(|m| Cellule::Texte(m.clone())));
    f.lignes.push(titres);
    let mut graphiques = Feuille { nom: "Graphiques".into(), ..Feuille::default() };
    for (i, ((r, espace), donnees)) in conso.iter().enumerate() {
        let moyenne = donnees.values().sum::<i64>() as f64 / tous_mois.len() as f64;
        let nom = noms.get(r).unwrap_or(&vide);
        let mut ligne = vec![mot(r), cellule(nom), mot(espace), Cellule::Nombre(arrondi2(moyenne))];
        ligne.extend(tous_mois.iter().map(|m| Cellule::Nombre(*donnees.get(m).unwrap_or(&0) as f64)));
        f.lignes.push(ligne);
        graphiques.graphiques.push(Graphique {
            titre: format!("Consommation - {} ({espace})", if vrai(nom) { texte(nom) } else { r.clone() }),
            source: source.into(),
            ligne: (i + 1) as u32,
            col1: 4,
            col2: (4 + tous_mois.len() - 1) as u16,
            ligne_ou: (1 + (i / 2) * 22) as u32,
            col_ou: if i % 2 == 0 { 1 } else { 11 },
        });
    }
    Sortie::Classeur { nom: "Statistiques_Consommation.xlsx".into(), feuilles: vec![f, graphiques], references: None }
}

// ---------------------------------------------------------------------- extraction chirurgie

pub fn extraction_chirurgie(db: &Value, date_debut: &Value, date_fin: &Value) -> Sortie {
    if !vrai(date_debut) || !vrai(date_fin) {
        return Sortie::Message("Erreur: Dates invalides.".into());
    }
    let lire_date = |v: &Value| v.as_str().and_then(|t| NaiveDate::parse_from_str(t, "%Y-%m-%d").ok());
    let (Some(debut), Some(fin)) = (lire_date(date_debut), lire_date(date_fin)) else {
        return Sortie::Message("Erreur: Format de date invalide.".into());
    };
    let noms = noms_par_ref(db);
    let vide = json!("");
    let mut sorties: Vec<(NaiveDate, &Value, i64)> = Vec::new();
    for t in liste(db, "transactions") {
        if texte(&t["utilisateur"]) != ESPACE_CHIRURGIE {
            continue;
        }
        let qte = entier(&t["quantite"]);
        let type_tx = texte(&t["type_transaction"]).to_uppercase();
        // Un ajustement manuel n'est une sortie que s'il est négatif.
        let est_sortie = (type_tx.starts_with("SORTIE") && !type_tx.contains("MODIFICATION") && !type_tx.contains("TRANSFERT"))
            || (type_tx == "AJUSTEMENT_MANUEL" && qte < 0);
        if !est_sortie {
            continue;
        }
        if let Some(j) = jour(&t["date"]).filter(|j| debut <= *j && *j <= fin) {
            sorties.push((j, t, qte.abs()));
        }
    }
    if sorties.is_empty() {
        return Sortie::Message("Aucun article sorti de la chirurgie sur cette période.".into());
    }
    let mut f = Feuille { nom: "Extraction Chirurgie".into(), gras: vec![0], ..Feuille::default() };
    f.lignes.push(ligne_titres(&["Date", "Référence", "Nom", "Quantité", "Type de transaction", "Numéro de lot", "Date de péremption"]));
    for (j, t, qte) in sorties {
        let r = lire(t, "reference", &vide);
        f.lignes.push(vec![
            mot(&j.format("%d/%m/%Y").to_string()),
            cellule(r),
            cellule(noms.get(&texte(r)).unwrap_or(&vide)),
            Cellule::Nombre(qte as f64),
            cellule(lire(t, "type_transaction", &vide)),
            cellule(lire(t, "lot", &vide)),
            cellule(lire(t, "peremption_sortie", &vide)),
        ]);
    }
    let nom = format!("Extraction_Chirurgie_{}_au_{}.xlsx", texte(date_debut), texte(date_fin));
    Sortie::Classeur { nom, feuilles: vec![f], references: None }
}

#[cfg(test)]
mod essais {
    use super::*;

    fn db_exemple() -> Value {
        json!({
            "produits": [
                {"reference": "A", "nom": "Compresses", "type_stockage": "carton", "quantite_par_carton": 10},
                {"reference": "B", "nom": "=HYPERLINK(\"x\")", "type_stockage": "unite", "quantite_par_carton": 1},
            ],
            "stock": [
                {"reference": "A", "utilisateur": "Commun", "quantite": 32, "prix_unitaire_ht": 1.0,
                 "prix_unitaire_ttc": 1.2, "fournisseur": "F1", "alerte_active": 1, "stock_minimum": 40, "en_commande": 0},
                {"reference": "B", "utilisateur": "Cabinet 1", "quantite": 2, "prix_unitaire_ht": 5,
                 "prix_unitaire_ttc": 6, "fournisseur": "F2", "alerte_active": 1, "stock_minimum": 1, "en_commande": 0},
                {"reference": "A", "utilisateur": "Salle de chir", "quantite": 0, "prix_unitaire_ht": 1,
                 "prix_unitaire_ttc": 1.2, "fournisseur": "F1", "alerte_active": 1, "stock_minimum": 1, "en_commande": 1},
            ],
            "transactions": [
                {"date": "2026-09-01T10:00:00Z", "reference": "A", "utilisateur": "Commun", "type_transaction": "SORTIE_STOCK", "quantite": 3},
                {"date": "2026-09-15T10:00:00Z", "reference": "A", "utilisateur": "Commun", "type_transaction": "AJUSTEMENT_MANUEL", "quantite": -2},
                {"date": "2026-10-01T10:00:00Z", "reference": "A", "utilisateur": "Commun", "type_transaction": "Sortie (Transfert)", "quantite": 5},
                {"date": "2026-10-02T10:00:00Z", "reference": "A", "utilisateur": "Salle de chir", "type_transaction": "SORTIE_STOCK",
                 "quantite": 1, "lot": "L1", "peremption_sortie": "01/01/2030"},
                {"date": "2026-10-02T11:00:00Z", "reference": "A", "utilisateur": "Salle de chir", "type_transaction": "AJUSTEMENT_MANUEL", "quantite": 4},
            ],
        })
    }

    fn classeur(s: Sortie) -> (String, Vec<Feuille>, Option<Vec<String>>) {
        match s {
            Sortie::Classeur { nom, feuilles, references } => (nom, feuilles, references),
            Sortie::Message(m) => panic!("pas de classeur : {m}"),
        }
    }

    fn message(s: Sortie) -> String {
        match s {
            Sortie::Message(m) => m,
            Sortie::Classeur { .. } => panic!("un classeur au lieu d'un message"),
        }
    }

    fn t(s: &str) -> Cellule {
        Cellule::Texte(s.into())
    }

    #[test]
    fn neutralisation_des_formules() {
        for (v, a) in [("=SUM(A1)", "'=SUM(A1)"), ("+33", "'+33"), ("-1", "'-1"), ("@x", "'@x"), ("  =x", "'  =x"), ("normal", "normal"), ("", "")] {
            assert_eq!(neutraliser(v), a);
        }
        assert_eq!(cellule(&json!(12)), Cellule::Nombre(12.0));
    }

    #[test]
    fn conditionnement_lisible() {
        for (ty, par, qte, a) in [
            ("unite", json!(1), 5, "À l'unité"),
            ("carton", json!(10), 32, "3 cartons de 10 + 2 unité(s)"),
            ("carton", json!(10), 10, "1 carton de 10"),
            ("boite", json!(12), 5, "5 unité(s) (boîte de 12)"),
            ("carton", json!(1), 5, "À l'unité"),
            ("carton", json!("x"), 5, "À l'unité"),
        ] {
            assert_eq!(describe_conditionnement(&json!(ty), &par, qte), a);
        }
    }

    #[test]
    fn export_stock_un_onglet_par_espace_et_recap() {
        let (nom, f, _) = classeur(export_stock(&db_exemple()));
        assert_eq!(nom, "Export_Stock.xlsx");
        let noms: Vec<&str> = f.iter().map(|x| x.nom.as_str()).collect();
        assert_eq!(noms, ["Commun", "Cabinet 1", "Salle de chir", "Récapitulatif"]);
        assert_eq!(f[0].lignes[1][4], t("3 cartons de 10 + 2 unité(s)"));
        assert_eq!(f[0].lignes[1][7], Cellule::Nombre(32.0));
        assert_eq!(f[3].lignes[0][0], t("TOTAL GÉNÉRAL"));
        assert_eq!(f[3].lignes[0][1], Cellule::Nombre(42.0));
        // noms dangereux neutralisés
        assert!(matches!(&f[1].lignes[1][1], Cellule::Texte(x) if x.starts_with("'=")));
        // le fichier s'écrit
        let r = rendre(export_stock(&db_exemple())).unwrap();
        let brut = base64::engine::general_purpose::STANDARD.decode(r["contenu_base64"].as_str().unwrap()).unwrap();
        assert!(brut.starts_with(b"PK"));
        assert_eq!(r["status"], "Succès");
    }

    #[test]
    fn export_stock_vide() {
        let (_, f, _) = classeur(export_stock(&json!({"stock": [], "produits": []})));
        assert_eq!(f[0].nom, "Stock");
        assert!(rendre(export_stock(&json!({}))).is_ok());
    }

    #[test]
    fn titres_de_feuilles() {
        let deja = vec![Feuille { nom: "Commun".into(), ..Feuille::default() }];
        assert_eq!(titre_feuille(&deja, "commun", "Espace"), "commun_1");
        assert_eq!(titre_feuille(&deja, "a/b[c]:d", "Espace"), "a_bcd");
        assert_eq!(titre_feuille(&deja, "", "Espace"), "Espace");
        assert_eq!(titre_feuille(&deja, &"x".repeat(40), "Espace").chars().count(), 31);
    }

    #[test]
    fn liste_de_courses() {
        // A en Commun est sous le seuil ; la ligne en commande est ignorée ; B (2 > 1) n'est pas à commander.
        let (nom, f, refs) = classeur(liste_courses(&db_exemple()));
        assert_eq!(nom, "Liste_de_courses.xlsx");
        assert_eq!(refs, Some(vec!["A".to_string()]));
        assert_eq!(f[0].lignes[1][2], t("Compresses"));
        let r = rendre(liste_courses(&db_exemple())).unwrap();
        let cles: Vec<&String> = r.as_object().unwrap().keys().collect();
        assert_eq!(cles, ["status", "nom_fichier", "references", "contenu_base64"]);
        // produit arrêté, ou plus aucune alerte : rien
        let mut db = db_exemple();
        db["produits"][0]["arrete"] = json!(1);
        assert!(message(liste_courses(&db)).contains("Aucun article"));
        let mut db = db_exemple();
        for s in db["stock"].as_array_mut().unwrap() {
            s["alerte_active"] = json!(0);
        }
        assert!(message(liste_courses(&db)).contains("Aucun article"));
    }

    #[test]
    fn stats_consommation_par_mois() {
        let (_, f, _) = classeur(stats_consommation(&db_exemple(), &json!(["TOUTES"])));
        let ws = &f[0];
        assert_eq!(ws.nom, "Résumé Consommation");
        assert_eq!(ws.lignes[0][..4], [t("Référence"), t("Nom"), t("Espace"), t("Moyenne Mensuelle")]);
        let col = |m: &str| ws.lignes[0].iter().position(|c| *c == t(m)).unwrap();
        let commun = ws.lignes.iter().find(|l| l[0] == t("A") && l[2] == t("Commun")).unwrap();
        // Commun : 3 en septembre + 2 (ajustement négatif) ; le transfert est exclu
        assert_eq!(commun[col("2026-09")], Cellule::Nombre(5.0));
        assert_eq!(commun[col("2026-10")], Cellule::Nombre(0.0));
        assert_eq!(f[1].graphiques.len(), ws.lignes.len() - 1);
        assert!(rendre(stats_consommation(&db_exemple(), &json!(["TOUTES"]))).is_ok());
        assert!(message(stats_consommation(&db_exemple(), &json!([]))).starts_with("Erreur"));
        assert!(message(stats_consommation(&db_exemple(), &NUL)).starts_with("Erreur"));
        assert!(message(stats_consommation(&db_exemple(), &json!(["Z"]))).contains("Aucune donnée"));
    }

    #[test]
    fn filtre_de_consommation() {
        for (ty, q, a) in [
            ("SORTIE_STOCK", 3, (true, 3)),
            ("SORTIE", 3, (true, 3)),
            ("Sortie_directe", 3, (true, 3)),
            ("Sortie (Transfert)", 3, (false, 0)),
            ("SORTIE (Modification Réf/Espace)", 3, (false, 0)),
            ("AJUSTEMENT_MANUEL", -2, (true, 2)),
            ("AJUSTEMENT_MANUEL", 2, (false, 0)),
            ("ENTREE_FACTURE", 10, (false, 0)),
        ] {
            assert_eq!(est_consommation(ty, q), a, "{ty}");
        }
    }

    #[test]
    fn extraction_chirurgie_sorties_seules() {
        let (nom, f, _) = classeur(extraction_chirurgie(&db_exemple(), &json!("2026-10-01"), &json!("2026-10-31")));
        // Seule la sortie compte : l'ajustement positif est une entrée
        assert_eq!(f[0].lignes.len(), 2);
        assert_eq!(
            f[0].lignes[1],
            [t("02/10/2026"), t("A"), t("Compresses"), Cellule::Nombre(1.0), t("SORTIE_STOCK"), t("L1"), t("01/01/2030")]
        );
        assert_eq!(nom, "Extraction_Chirurgie_2026-10-01_au_2026-10-31.xlsx");
        assert!(message(extraction_chirurgie(&db_exemple(), &json!("2020-01-01"), &json!("2020-01-31"))).contains("Aucun article"));
        for (d, f) in [("", "2026-01-01"), ("01/01/2026", "2026-01-02")] {
            assert!(message(extraction_chirurgie(&db_exemple(), &json!(d), &json!(f))).starts_with("Erreur"));
        }
    }

    #[test]
    fn lecture_des_dates_de_transaction() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 2);
        for (v, a) in [
            (json!("2026-10-02T09:15:00.000Z"), d),
            (json!("2026-10-02 09:15"), d),
            (json!("2026-10-02"), d),
            (json!("2026-10-02T09:15:00.1234567Z"), d),
            (json!(""), None),
            (json!(null), None),
            (json!("02/10/2026"), None),
        ] {
            assert_eq!(jour(&v), a, "{v}");
        }
    }
}
