//! Signalements de bug et idées d'amélioration envoyés depuis les Réglages.
//!
//! Chaque signalement devient un ticket (issue) GitHub du dépôt de l'outil. La clé GitHub (jeton
//! « Issues : lecture et écriture » limité à ce dépôt) est saisie une fois dans les Réglages du
//! poste qui fait tourner le serveur ; elle reste dans donnees/config.json, jamais dans le code
//! ni renvoyée aux postes.
//!
//! Sans internet, le signalement est gardé dans donnees/signalements_en_attente.json et renvoyé
//! plus tard : à l'envoi suivant et toutes les 30 minutes. Sans clé, le ticket préparé est rendu
//! au poste, qui ouvre Gmail avec le message prêt à envoyer (js/ui/signalement.js).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::base::{texte, vrai, Erreur, Res};

pub const DEPOT: &str = "pilou33620/tooth_dentaire";
pub const DELAI: u64 = 15; // s
pub const INTERVALLE_RENVOI: u64 = 30 * 60; // s
pub const LONGUEUR_MAX: usize = 5000;
pub const JOURNAUX_MAX: usize = 20000; // caractères par journal (GitHub accepte 65536 au total)

static VERROU: Mutex<()> = Mutex::new(());

/// Crée le ticket (ticket, clé) ; rend son adresse. Remplacé dans les essais.
pub type Poster<'a> = &'a dyn Fn(&Value, &str) -> Result<String, String>;

fn fichier_attente(dossier: &Path) -> PathBuf {
    dossier.join("signalements_en_attente.json")
}

fn lire_attente(dossier: &Path) -> Vec<Value> {
    std::fs::read_to_string(fichier_attente(dossier))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn ecrire_attente(dossier: &Path, liste: &[Value]) -> Res<()> {
    let io = |e: std::io::Error| Erreur::Interne(e.to_string());
    std::fs::create_dir_all(dossier).map_err(io)?;
    let chemin = fichier_attente(dossier);
    let tmp = chemin.with_extension("json.tmp");
    let t = serde_json::to_string_pretty(liste).map_err(|e| Erreur::Interne(e.to_string()))?;
    std::fs::write(&tmp, t).map_err(io)?;
    std::fs::rename(&tmp, &chemin).map_err(io)
}

/// Texte d'un champ du formulaire (`str(x or "")` de Python).
fn champ(data: &Value, cle: &str) -> String {
    if vrai(&data[cle]) {
        texte(&data[cle])
    } else {
        String::new()
    }
}

fn debut(t: &str, n: usize) -> String {
    t.chars().take(n).collect()
}

fn bloc_journal(titre: &str, t: &str) -> String {
    let t = t.trim();
    let n = t.chars().count();
    let t: String = t.chars().skip(n.saturating_sub(JOURNAUX_MAX)).collect();
    // Clôture à 4 accents graves : un ``` dans le journal ne la ferme pas
    if t.is_empty() {
        String::new()
    } else {
        format!("\n\n<details><summary>{titre}</summary>\n\n````\n{t}\n````\n</details>")
    }
}

/// Valide le formulaire et construit le ticket {title, body, labels}.
pub fn preparer(data: &Value, version: &str, quand: Option<chrono::DateTime<chrono::Local>>, journal_serveur: &str) -> Res<Value> {
    let (libelle, etiquette) = match data["type"].as_str() {
        Some("bug") => ("Bug", "bug"),
        Some("idee") => ("Idée", "enhancement"),
        _ => return Err(Erreur::Donnees("Choisir « Bug » ou « Idée ».".into())),
    };
    let description = champ(data, "description").trim().to_string();
    if description.chars().count() < 5 {
        return Err(Erreur::Donnees("Décrire le problème ou l'idée en quelques mots.".into()));
    }
    let description = debut(&description, LONGUEUR_MAX);
    let auteur = debut(champ(data, "auteur").trim(), 40);
    let premiere_ligne = debut(description.lines().next().unwrap_or(""), 80);
    let quand = quand.unwrap_or_else(chrono::Local::now).format("%d/%m/%Y %H:%M");
    let par = if auteur.is_empty() { String::new() } else { format!(" par {auteur}") };
    let version = if version.is_empty() { "inconnue" } else { version };
    let mut corps = format!("{description}\n\n---\n_Envoyé depuis l'outil du cabinet le {quand}{par} — version {version}._");
    corps += &bloc_journal("Journal du navigateur", &champ(data, "journaux"));
    corps += &bloc_journal("Journal du serveur", journal_serveur);
    Ok(json!({"title": format!("[{libelle}] {premiere_ligne}"), "body": corps, "labels": [etiquette]}))
}

/// Crée le ticket sur GitHub ; rend son adresse.
pub fn poster_github(ticket: &Value, jeton: &str) -> Result<String, String> {
    let rep = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(DELAI))
        .build()
        .post(&format!("https://api.github.com/repos/{DEPOT}/issues"))
        .set("Authorization", &format!("Bearer {jeton}"))
        .set("Accept", "application/vnd.github+json")
        .set("Content-Type", "application/json")
        .set("User-Agent", "tooth_dentaire")
        .send_string(&ticket.to_string());
    match rep {
        Ok(r) => {
            let v: Value = serde_json::from_str(&r.into_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            Ok(texte(&v["html_url"]))
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("GitHub a répondu {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Renvoie les signalements gardés ; rend le nombre de ceux qui restent.
pub fn envoyer_en_attente(dossier: &Path, jeton: &str, poster: Poster) -> Res<usize> {
    let _g = VERROU.lock().unwrap_or_else(|e| e.into_inner());
    let mut restants = lire_attente(dossier);
    if restants.is_empty() || jeton.is_empty() {
        return Ok(restants.len());
    }
    while !restants.is_empty() {
        if poster(&restants[0], jeton).is_err() {
            break;
        }
        restants.remove(0);
        ecrire_attente(dossier, &restants)?;
    }
    Ok(restants.len())
}

/// Envoie un signalement. {"envoye": true, "url"} ; sans internet, {"envoye": false,
/// "en_attente": n} : rien n'est perdu ; sans clé, {"envoye": false, "ticket"} : le poste
/// l'envoie par Gmail.
pub fn signaler(data: &Value, dossier: &Path, jeton: &str, version: &str, journal_serveur: &str, poster: Poster) -> Res<Value> {
    let ticket = preparer(data, version, None, journal_serveur)?;
    if jeton.is_empty() {
        return Ok(json!({"envoye": false, "cle_configuree": false, "ticket": ticket}));
    }
    envoyer_en_attente(dossier, jeton, poster)?;
    if let Ok(url) = poster(&ticket, jeton) {
        return Ok(json!({"envoye": true, "url": url}));
    }
    let _g = VERROU.lock().unwrap_or_else(|e| e.into_inner());
    let mut attente = lire_attente(dossier);
    attente.push(ticket);
    ecrire_attente(dossier, &attente)?;
    Ok(json!({"envoye": false, "en_attente": attente.len(), "cle_configuree": true}))
}

#[cfg(test)]
mod essais {
    use super::*;
    use std::cell::RefCell;

    fn bug() -> Value {
        json!({"type": "bug", "description": "Le placard ne s'ouvre plus\nquand on scanne", "auteur": "Léa"})
    }

    #[test]
    fn ticket_prepare() {
        let t = preparer(&bug(), "3.0.0 (abc1234)", None, "").unwrap();
        assert_eq!(t["title"], "[Bug] Le placard ne s'ouvre plus");
        assert_eq!(t["labels"], json!(["bug"]));
        let corps = t["body"].as_str().unwrap();
        assert!(corps.contains("par Léa") && corps.contains("3.0.0 (abc1234)"));
        let idee = preparer(&json!({"type": "idee", "description": "Un mode sombre"}), "", None, "").unwrap();
        assert!(idee["title"].as_str().unwrap().starts_with("[Idée]"));
        assert_eq!(idee["labels"], json!(["enhancement"]));
    }

    #[test]
    fn formulaire_incomplet_refuse() {
        for d in [json!(null), json!({"type": "x", "description": "assez long"}), json!({"type": "bug", "description": "  "})] {
            assert!(matches!(preparer(&d, "", None, ""), Err(Erreur::Donnees(_))), "{d}");
        }
    }

    #[test]
    fn envois() {
        let d = crate::dossier_essai("signalements");
        let envoyes = RefCell::new(Vec::new());
        let github = |t: &Value, j: &str| -> Result<String, String> {
            envoyes.borrow_mut().push((t.clone(), j.to_string()));
            Ok(format!("https://github.com/x/issues/{}", envoyes.borrow().len()))
        };
        let en_panne = |_: &Value, _: &str| Err::<String, String>("pas d'internet".into());
        // envoi direct
        let r = signaler(&bug(), &d, "cle", "", "", &github).unwrap();
        assert_eq!(r, json!({"envoye": true, "url": "https://github.com/x/issues/1"}));
        assert_eq!(envoyes.borrow()[0].1, "cle");
        // sans internet : gardé, puis renvoyé avec le suivant, dans l'ordre
        let r = signaler(&bug(), &d, "cle", "", "", &en_panne).unwrap();
        assert_eq!((r["envoye"].clone(), r["en_attente"].clone()), (json!(false), json!(1)));
        envoyes.borrow_mut().clear();
        let r = signaler(&json!({"type": "idee", "description": "Une idée"}), &d, "cle", "", "", &github).unwrap();
        assert_eq!(r["envoye"], true);
        let etiquettes: Vec<Value> = envoyes.borrow().iter().map(|(t, _)| t["labels"].clone()).collect();
        assert_eq!(etiquettes, [json!(["bug"]), json!(["enhancement"])]);
        assert_eq!(envoyer_en_attente(&d, "cle", &en_panne).unwrap(), 0);
    }

    #[test]
    fn sans_cle_ticket_rendu_pour_gmail() {
        let d = crate::dossier_essai("signalements");
        let r = signaler(&bug(), &d, "", "", "", &|_: &Value, _: &str| Ok(String::new())).unwrap();
        assert_eq!((r["envoye"].clone(), r["cle_configuree"].clone()), (json!(false), json!(false)));
        assert_eq!(r["ticket"]["title"], "[Bug] Le placard ne s'ouvre plus");
        // Parti par Gmail : rien gardé, sinon il partirait aussi sur GitHub le jour d'une clé
        assert_eq!(envoyer_en_attente(&d, "cle", &|_: &Value, _: &str| Ok(String::new())).unwrap(), 0);
    }

    #[test]
    fn journaux_joints_et_bornes() {
        let mut d = bug();
        d["journaux"] = json!(format!("[erreur] boum ``` fin\n{}", "x".repeat(30000)));
        let corps = preparer(&d, "", None, "GET /api/etat 500").unwrap()["body"].as_str().unwrap().to_string();
        assert!(corps.contains("<summary>Journal du navigateur</summary>") && corps.contains(&"x".repeat(100)));
        assert!(corps.contains("<summary>Journal du serveur</summary>") && corps.contains("GET /api/etat 500"));
        assert!(corps.chars().count() < 2 * JOURNAUX_MAX + 1000);
        // Sans journaux, pas de bloc vide
        assert!(!preparer(&bug(), "", None, "").unwrap()["body"].as_str().unwrap().contains("<details>"));
    }
}
