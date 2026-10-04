# -*- coding: utf-8 -*-
"""
Simulation Multi-Agents Diversifiee - tooth_dentaire.

Simule 9 agents aux profils et responsabilites metier totalement differents
pour explorer l'integralite des fonctionnalites et parametres de l'outil :

1. Agent Approvisionneur : Commandes, receptions multi-lots, historique prix
2. Agent Assistante Soins : Sorties rapides FEFO, suivi peremption, alertes rupture
3. Agent Sterilisation : Autoclaves, Bowie-Dick, checklist hygiene, minuteurs
4. Agent Radioprotection (PCR) : Dosimetres, rappels mires, conformite radio
5. Agent Secretariat : Planning binomes, couleurs, carnet contacts, meteo
6. Agent Chirurgien : Tracabilite chirurgie, implants, extraction reglementaire
7. Agent Logistique : Transferts inter-espaces, inventaires, arret d'articles
8. Agent Direction & Compta : Exports Excel, valorisation stock, stats conso
9. Agent Cas Limites / Fuzzing : Caracteres speciaux, conversion virgules, robustesse
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class JournalSimulation:
    def __init__(self):
        self.lock = threading.Lock()
        self.actions = []
        self.succes = 0
        self.erreurs = 0

    def noter(self, agent_nom, action, ok, detail=""):
        with self.lock:
            statut = "OK" if ok else "ERREUR"
            if ok:
                self.succes += 1
            else:
                self.erreurs += 1
            msg = f"[{agent_nom}] {action} -> [{statut}] {detail}".strip()
            self.actions.append(msg)
            print(f"  {msg}")


class ClientCabinet:
    def __init__(self, base_url, nom):
        self.base_url = base_url.rstrip("/")
        self.nom = nom
        self.origin = "http://localhost:8150"

    def req(self, methode, chemin, corps=None):
        url = self.base_url + chemin
        headers = {
            "Origin": self.origin,
            "User-Agent": f"AgentCabinet/{self.nom}",
        }
        data = None
        if corps is not None:
            data = json.dumps(corps).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        t0 = time.perf_counter()
        r = urllib.request.Request(url, data=data, headers=headers, method=methode)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                duree = (time.perf_counter() - t0) * 1000.0
                raw = resp.read()
                return resp.status, json.loads(raw.decode("utf-8")) if raw else {}, duree
        except urllib.error.HTTPError as exc:
            duree = (time.perf_counter() - t0) * 1000.0
            raw = exc.read()
            try:
                data = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                data = {"error": str(raw)}
            return exc.code, data, duree
        except Exception as exc:
            duree = (time.perf_counter() - t0) * 1000.0
            return 0, {"exception": str(exc)}, duree


# =====================================================================
# SCENARIOS DES 9 AGENTS METIER
# =====================================================================

def scenario_approvisionneur(client, log):
    """Agent 1 : Gestion des commandes, receptions et suivi des prix fournisseurs."""
    nom = "Agent_Approvisionneur"
    time.sleep(0.05)

    # 1. Creer un produit en carton
    ref = "COMP-A2-SERINGUE"
    c, res, _ = client.req("POST", "/api/produit", {
        "reference": ref,
        "nom": "Composite Universel Seringue 4g Teinte A2",
        "groupe": "RESTAURATION",
        "type_stockage": "carton",
        "quantite_par_carton": 10,
        "ref_scannette": "4012345678901",
        "arrete": 0
    })
    log.noter(nom, f"Creation produit {ref}", c == 200)

    # 2. Noter une commande en cours
    c, res, _ = client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Reserve",
        "quantite": 5, "stock_minimum": 15, "alerte_active": 1,
        "fournisseur": "Mega Dental", "en_commande": 1,
        "date_commande": "2026-10-04", "prix_unitaire_ht": 28.50, "prix_unitaire_ttc": 34.20
    })
    log.noter(nom, "Commande en cours chez Mega Dental (5 en stock, seuil 15)", c == 200)

    # 3. Reception de marchandise avec 2 lots distincts (Multi-lots)
    lots_reception = json.dumps([
        {"lot": "LOT-2026A", "peremption": "2027-06-30", "quantite": 20},
        {"lot": "LOT-2026B", "peremption": "2028-01-31", "quantite": 20}
    ])
    c, res, _ = client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Reserve",
        "quantite": 45, "stock_minimum": 15, "alerte_active": 0,
        "fournisseur": "Mega Dental", "en_commande": 0,
        "date_import": "2026-10-04", "date_peremption": "2027-06-30",
        "lots_details": lots_reception, "prix_unitaire_ht": 27.90, "prix_unitaire_ttc": 33.48
    })
    log.noter(nom, "Reception livraison : +40 unites en 2 lots distincts", c == 200)

    # 4. Transaction d'entree
    c, res, _ = client.req("POST", "/api/transaction", {
        "date": "2026-10-04T10:15:00", "reference": ref,
        "utilisateur": "Reserve", "type_transaction": "ENTREE",
        "quantite": 40, "lot": "LOT-2026A / LOT-2026B"
    })
    log.noter(nom, "Enregistrement transaction ENTREE", c == 200)

    # 5. Historique de prix multi-fournisseurs (comparateur)
    for fourn, prix in [("Mega Dental", 27.90), ("Henry Schein", 29.50), ("GACD", 28.20)]:
        client.req("POST", "/api/historique-prix", {
            "reference": ref, "date": "2026-10-04",
            "prix_ht": prix, "prix_ttc": prix * 1.20, "fournisseur": fourn
        })
    log.noter(nom, "Enregistrement comparatif prix (Mega Dental, Schein, GACD)", True)


def scenario_assistante_soins(client, log):
    """Agent 2 : Sorties de stock au fauteuil, gestion FEFO et alertes de rupture."""
    nom = "Agent_Assistante_Soins"
    time.sleep(0.1)

    ref = "ANESTH-UBISTESIN-FORTE"
    # 1. Produit anesthésique
    client.req("POST", "/api/produit", {
        "reference": ref, "nom": "Ubistesin Forte 4% Adrenaline 1/100000",
        "groupe": "ANESTHESIE", "type_stockage": "boite", "quantite_par_carton": 50
    })

    # 2. Stock initial au Fauteuil 1 (proche de la rupture)
    client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Fauteuil 1",
        "quantite": 4, "stock_minimum": 5, "alerte_active": 1,
        "alerte_peremption_active": 1, "delai_peremption": 30,
        "date_peremption": "2026-11-15", "lot": "LOT-FEFO-01"
    })
    log.noter(nom, "Initialisation stock Fauteuil 1 avec lot perimant bientot", True)

    # 3. Consommation au fauteuil (Sortie FEFO)
    c, res, _ = client.req("POST", "/api/transaction", {
        "date": "2026-10-04T10:30:00", "reference": ref,
        "utilisateur": "Fauteuil 1", "type_transaction": "SORTIE_STOCK",
        "quantite": 2, "lot": "LOT-FEFO-01", "peremption_sortie": "2026-11-15"
    })
    log.noter(nom, "Sortie rapide de 2 cartouches pour soin", c == 200)

    # 4. Mise a jour stock suite a la sortie (reste 2, alerte rupture active)
    c, res, _ = client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Fauteuil 1",
        "quantite": 2, "stock_minimum": 5, "alerte_active": 1
    })
    log.noter(nom, "Verification declenchement alerte rupture (stock=2 < seuil=5)", c == 200)


def scenario_sterilisation(client, log):
    """Agent 3 : Autoclaves, validation Bowie-Dick, checklists hygiène, minuteurs."""
    nom = "Agent_Sterilisation"
    time.sleep(0.08)

    # 1. Validation de cycles de sterilisation sur 3 machines
    cycles = [
        ("Lisa 500", "Cycle 1 : Test Bowie-Dick / Helix conforme (2.1 bar, 134 degres)", True),
        ("Melag 40B+", "Cycle 1 : Prion 134 degres - Charge instruments chirurgie OK", True),
        ("DAC Universal", "Cycle 1 : Lubrification et sterilisation contre-angles OK", True)
    ]
    for mach, com, ok in cycles:
        c, res, _ = client.req("POST", "/api/maintenance", {
            "date": "2026-10-04T08:15:00", "machine": mach,
            "utilisateur": "Sarah_Sté", "commentaire": com
        })
        log.noter(nom, f"Validation cycle autoclave {mach}", c == 200)

    # 2. Remplir la checklist d'ouverture et fermeture du jour
    c, res, _ = client.req("PUT", "/api/documents/checklist", {
        "modele": [
            {"id": "o1", "moment": "ouverture", "libelle": "Purge circuits eau units"},
            {"id": "o2", "moment": "ouverture", "libelle": "Test autoclave Bowie-Dick"},
            {"id": "f1", "moment": "fermeture", "libelle": "Nettoyage bacs et arret aspiration"}
        ],
        "jour": "2026-10-04",
        "fait": {"o1": True, "o2": True, "f1": False}
    })
    log.noter(nom, "Mise a jour checklist d'hygiene du jour", c == 200)

    # 3. Lancement de 2 minuteurs de decontamination
    c, res, _ = client.req("PUT", "/api/documents/minuteurs", {
        "actifs": [
            {"id": "m_ultra", "libelle": "Bain ultrasons instruments", "fin": time.time() + 600},
            {"id": "m_tremp", "libelle": "Trempage Aniosyme bac 2", "fin": time.time() + 900}
        ],
        "preselections": [
            {"libelle": "Ultrasons", "minutes": 10},
            {"libelle": "Trempage", "minutes": 15},
            {"libelle": "Sechage", "minutes": 20}
        ]
    })
    log.noter(nom, "Demarrage minuteurs de decontamination en cours", c == 200)

    # 4. Affectation des taches de la semaine
    c, res, _ = client.req("PUT", "/api/documents/taches", {
        "header1": "Matin", "header2": "Apres-midi",
        "rows": [
            {"tache": "Entretien compresseur", "assignee": "Sarah", "statut": "fait"},
            {"tache": "Reception cartons", "assignee": "Manon", "statut": "en_cours"}
        ]
    })
    log.noter(nom, "Mise a jour du tableau des taches assistantes", c == 200)


def scenario_radioprotection(client, log):
    """Agent 4 : PCR, dosimètres, contrôle de qualité des mires radiologiques."""
    nom = "Agent_Radioprotection_PCR"
    time.sleep(0.12)

    # 1. Gestion des dosimètres passifs
    c, res, _ = client.req("PUT", "/api/documents/dosimetres", {
        "manager": "Dr Thomas (PCR agree)",
        "generalNote": "Echange trimestriel obligatoire CPO / IRSN",
        "dosimetres": [
            {"nom": "Dr Thomas", "numero": "DOS-001", "actif": True},
            {"nom": "Dr Martin", "numero": "DOS-002", "actif": True},
            {"nom": "Sarah (Assistante)", "numero": "DOS-003", "actif": True},
            {"nom": "Manon (Assistante)", "numero": "DOS-004", "actif": True}
        ]
    })
    log.noter(nom, "Mise a jour registre PCR & 4 porteurs de dosimetres", c == 200)

    # 2. Date de prochaine relève dosimètre
    client.req("PUT", "/api/documents/rappel_dosimetres", {"nextTime": "2026-11-01"})
    log.noter(nom, "Programmation alerte echange trimestriel dosimetres", True)

    # 3. Controle des mires radiologiques (capteurs retro-alveolaires et panoramique)
    c, res, _ = client.req("PUT", "/api/documents/rappels_mire", {
        "panoramique": {"derniereDate": "2026-09-15", "prochaineDate": "2026-10-15", "statut": "Conforme"},
        "capteur_salle_1": {"derniereDate": "2026-09-20", "prochaineDate": "2026-10-20", "statut": "Conforme"}
    })
    log.noter(nom, "Enregistrement controle qualite mires radio", c == 200)

    # 4. Maintenance preventive fauteuils
    client.req("PUT", "/api/documents/rappels_fauteuils", {
        "fauteuil_1": {"dateEntretien": "2026-08-10", "technicien": "Adec Maintenance", "statut": "OK"}
    })
    log.noter(nom, "Mise a jour carnet d'entretien fauteuils", True)


def scenario_secretariat(client, log):
    """Agent 5 : Planning binômes, règles de couleurs, carnet d'adresses, météo et notes."""
    nom = "Agent_Secretariat"
    time.sleep(0.06)

    # 1. Planning des binômes praticien-assistante (semaines paires et impaires)
    c, res, _ = client.req("PUT", "/api/documents/planning", {
        "even": [
            {"jour": "Lundi", "praticien": "Dr Thomas", "assistante": "Sarah", "horaires": "08:30 - 18:30"},
            {"jour": "Mardi", "praticien": "Dr Martin", "assistante": "Manon", "horaires": "09:00 - 19:00"}
        ],
        "odd": [
            {"jour": "Lundi", "praticien": "Dr Thomas", "assistante": "Manon", "horaires": "08:30 - 18:30"},
            {"jour": "Mardi", "praticien": "Dr Martin", "assistante": "Sarah", "horaires": "09:00 - 19:00"}
        ]
    })
    log.noter(nom, "Configuration du planning des binomes (Semaines Paires & Impaires)", c == 200)

    # 2. Regles de coloration par personne
    client.req("PUT", "/api/documents/planning_couleurs", {
        "regles": [
            {"nom": "Dr Thomas", "couleur": "#2980b9"},
            {"nom": "Dr Martin", "couleur": "#27ae60"},
            {"nom": "Sarah", "couleur": "#8e44ad"},
            {"nom": "Manon", "couleur": "#e67e22"}
        ]
    })
    log.noter(nom, "Personnalisation des couleurs du planning", True)

    # 3. Post-it et notes d'accueil
    client.req("PUT", "/api/documents/notes", {
        "items": [
            {"id": "n1", "texte": "Livraison colis Henry Schein attendue a 14h", "auteur": "Accueil"},
            {"id": "n2", "texte": "Reunion d'equipe vendredi 12h30", "auteur": "Dr Thomas"}
        ]
    })
    log.noter(nom, "Publication de post-it partages sur l'accueil", True)

    # 4. Carnet d'adresses
    contacts = [
        {"nom": "Dental Ouest", "entreprise": "Fournisseur consommables", "tel_fixe": "0299000000", "email": "contact@dentalouest.fr"},
        {"nom": "Labo Prothese Moderne", "entreprise": "Protheses ceramique", "tel_portable": "0601020304", "ville": "Nantes"}
    ]
    for ct in contacts:
        c, res, _ = client.req("POST", "/api/contacts", ct)
        log.noter(nom, f"Ajout contact ({ct['entreprise']})", c == 200)

    # 5. Configuration meteo de la commune du cabinet
    client.req("PUT", "/api/documents/meteo_lieu", {"nom": "Nantes", "lat": 47.2184, "lon": -1.5536})
    log.noter(nom, "Reglage commune meteo du fond d'ecran", True)


def scenario_chirurgien(client, log):
    """Agent 6 : Traçabilité chirurgie, biomatériaux, extraction médico-légale."""
    nom = "Agent_Chirurgien"
    time.sleep(0.15)

    ref_impl = "IMPLANT-NOBEL-ACTIVE-4.3"
    # 1. Creer l'implant dans le catalogue
    client.req("POST", "/api/produit", {
        "reference": ref_impl, "nom": "Implant NobelActive RP 4.3 x 11.5mm",
        "groupe": "CHIRURGIE_IMPLANTS", "type_stockage": "unite"
    })

    # 2. Stock en Salle de Chirurgie
    client.req("POST", "/api/stock", {
        "reference": ref_impl, "utilisateur": "Salle de chir",
        "quantite": 8, "stock_minimum": 3, "lot": "LOT-NOB-8891",
        "date_peremption": "2029-12-31"
    })
    log.noter(nom, "Mise en place stock implants en Salle de chir", True)

    # 3. Pose chirurgicale d'un implant (sortie de stock avec tracabilite stricte)
    c, res, _ = client.req("POST", "/api/transaction", {
        "date": "2026-10-04T11:00:00", "reference": ref_impl,
        "utilisateur": "Salle de chir", "type_transaction": "SORTIE_STOCK",
        "quantite": -1, "lot": "LOT-NOB-8891", "peremption_sortie": "2029-12-31"
    })
    log.noter(nom, "Pose d'implant : sortie avec lot et peremption", c == 200)

    # 4. Generation de l'extraction reglementaire Excel de chirurgie
    c, res, _ = client.req("POST", "/api/export/chirurgie", {
        "date_debut": "2026-01-01", "date_fin": "2026-12-31"
    })
    ok_xlsx = c == 200 and res.get("contenu_base64")
    log.noter(nom, "Generation du registre de tracabilite chirurgie (.xlsx)", ok_xlsx)


def scenario_logistique(client, log):
    """Agent 7 : Transfert de stock inter-espaces, inventaires et arrêt de produits."""
    nom = "Agent_Logistique"
    time.sleep(0.09)

    ref = "COMP-A2-SERINGUE"
    # 1. Transfert de stock : Reserve -> Salle 1
    # Sortie de la Reserve
    client.req("POST", "/api/transaction", {
        "date": "2026-10-04T11:30:00", "reference": ref,
        "utilisateur": "Reserve", "type_transaction": "SORTIE_STOCK",
        "quantite": -5, "lot": "LOT-2026A"
    })
    client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Reserve", "quantite": 40
    })
    # Entree dans Salle 1
    client.req("POST", "/api/transaction", {
        "date": "2026-10-04T11:30:00", "reference": ref,
        "utilisateur": "Salle 1", "type_transaction": "ENTREE",
        "quantite": 5, "lot": "LOT-2026A"
    })
    client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Salle 1", "quantite": 5, "stock_minimum": 2
    })
    log.noter(nom, "Transfert logistique : 5 compules de Reserve vers Salle 1", True)

    # 2. Inventaire et ajustement manuel (constat d'une casse ou perte)
    client.req("POST", "/api/transaction", {
        "date": "2026-10-04T11:45:00", "reference": ref,
        "utilisateur": "Salle 1", "type_transaction": "AJUSTEMENT_MANUEL",
        "quantite": -1, "lot": "LOT-2026A"
    })
    client.req("POST", "/api/stock", {
        "reference": ref, "utilisateur": "Salle 1", "quantite": 4
    })
    log.noter(nom, "Inventaire physique : ajustement suite a seringue defectueuse", True)

    # 3. Arret d'un produit (obsolete / remplace)
    client.req("POST", "/api/produit", {
        "reference": "VIEUX-COMPOSITE-OBSOLETE",
        "nom": "Ancien composite micro-charge (ne plus commander)",
        "arrete": 1
    })
    log.noter(nom, "Passage d'un ancien produit en statut 'ARRETE'", True)


def scenario_direction_compta(client, log):
    """Agent 8 : Bilan financier, exports Excel multiples et valorisation générale."""
    nom = "Agent_Direction_Compta"
    time.sleep(0.18)

    # 1. Export Excel de tout le stock avec valorisation HT et TTC
    c, res, _ = client.req("POST", "/api/export/stock", {})
    b64 = res.get("contenu_base64")
    valide = False
    if c == 200 and b64:
        raw = base64.b64decode(b64)
        valide = raw.startswith(b"PK\x03\x04")  # Signature ZIP XLSX
    log.noter(nom, "Calcul et export Excel de la valeur du stock total (HT & TTC)", valide)

    # 2. Export Excel de la liste de courses (reapprovisionnement)
    c, res, _ = client.req("POST", "/api/export/liste-courses", {})
    b64 = res.get("contenu_base64")
    valide_courses = False
    if c == 200 and b64:
        raw = base64.b64decode(b64)
        valide_courses = raw.startswith(b"PK\x03\x04")
    log.noter(nom, "Generation du bon de reapprovisionnement / courses (.xlsx)", valide_courses)

    # 3. Statistiques de consommation avec graphiques integres
    c, res, _ = client.req("POST", "/api/export/consommation", {"references": ["TOUTES"]})
    b64 = res.get("contenu_base64")
    valide_conso = False
    if c == 200 and b64:
        raw = base64.b64decode(b64)
        valide_conso = raw.startswith(b"PK\x03\x04")
    log.noter(nom, "Graphiques d'analyse de consommation mensuelle (.xlsx)", valide_conso)


def scenario_cas_limites(client, log):
    """Agent 9 : Cas limites, tolérance, injections et caractères spéciaux."""
    nom = "Agent_Cas_Limites"
    time.sleep(0.04)

    # 1. Produit avec caracteres speciaux, accents, apostrophes et quotes
    ref_special = "SPEC-L'ÉCRAN-D'HÉMOSTATIQUE#99"
    c, res, _ = client.req("POST", "/api/produit", {
        "reference": ref_special,
        "nom": "Éponge hémostatique d'origine porcine (10x10mm) & gelée d'alginate",
        "groupe": "CHIRURGIE / HÉMOSTASE",
        "quantite_par_carton": "12",  # Nombre passe en string
        "type_stockage": "boite"
    })
    log.noter(nom, "Creation produit avec accents, apostrophes et quantite='12'", c == 200)

    # 2. Stock avec prix ayant une virgule francaise (ex: "14,75")
    c, res, _ = client.req("POST", "/api/stock", {
        "reference": ref_special, "utilisateur": "Armoire chir",
        "quantite": "24", "stock_minimum": "6",
        "prix_unitaire_ht": "14,75", "prix_unitaire_ttc": "17,70"
    })
    log.noter(nom, "Conversion automatique de prix a virgule francaise ('14,75')", c == 200)

    # 3. Tentative de reference produit vide (rejet propre 400 attendu)
    c, res, _ = client.req("POST", "/api/produit", {"reference": "   ", "nom": "Vide"})
    log.noter(nom, "Verification rejet reference blanche/vide (400)", c == 400)

    # 4. Tentative de lecture d'un document non autorise
    c, res, _ = client.req("GET", "/api/documents/document_inexistant")
    log.noter(nom, "Rejet cle de document inconnue (400)", c == 400)


def executer_simulation_complete():
    print("=" * 70)
    print("LANCEMENT DE LA SIMULATION MULTI-AGENTS DIVERSIFIEE DU CABINET")
    print("=" * 70)

    port = 8175
    db_test = os.path.join(tempfile.gettempdir(), f"tooth_simul_{int(time.time())}.db")

    cmd = [
        sys.executable,
        os.path.join(RACINE, "serveur.py"),
        "--port", str(port),
        "--base", db_test,
        "--local",
        "--sans-navigateur",
        "--sans-pause"
    ]
    proc = subprocess.Popen(cmd, cwd=RACINE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.8)

    journal = JournalSimulation()
    base_url = f"http://127.0.0.1:{port}"

    agents = [
        ("Agent_Approvisionneur", scenario_approvisionneur),
        ("Agent_Assistante_Soins", scenario_assistante_soins),
        ("Agent_Sterilisation", scenario_sterilisation),
        ("Agent_Radioprotection_PCR", scenario_radioprotection),
        ("Agent_Secretariat", scenario_secretariat),
        ("Agent_Chirurgien", scenario_chirurgien),
        ("Agent_Logistique", scenario_logistique),
        ("Agent_Direction_Compta", scenario_direction_compta),
        ("Agent_Cas_Limites", scenario_cas_limites),
    ]

    threads = []
    print("\n[+] Deploiement simultane des 9 agents metier distincts :\n")
    for nom_agent, scenario_fn in agents:
        cl = ClientCabinet(base_url, nom_agent)
        t = threading.Thread(target=scenario_fn, args=(cl, journal), name=nom_agent)
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    print("\n[+] Verification finale de la coherence et integrite globale de la base...")
    client_audit = ClientCabinet(base_url, "Auditeur_Final")
    c, etat, _ = client_audit.req("GET", "/api/etat")
    nb_produits = len(etat.get("base", {}).get("produits", []))
    nb_stock = len(etat.get("base", {}).get("stock", []))
    nb_tx = len(etat.get("base", {}).get("transactions", []))
    nb_auto = len(etat.get("base", {}).get("autoclave", []))
    nb_docs = len(etat.get("documents", {}))

    print(f"    - Produits au catalogue     : {nb_produits}")
    print(f"    - Lignes de stock ventilees : {nb_stock}")
    print(f"    - Transactions enregistrees : {nb_tx}")
    print(f"    - Cycles d'autoclave valides: {nb_auto}")
    print(f"    - Documents metier remplis  : {nb_docs}")

    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()

    if os.path.isfile(db_test):
        try:
            os.remove(db_test)
        except OSError:
            pass

    print("\n" + "=" * 70)
    print("SYNTHESE DE LA SIMULATION METIER DIVERSIFIEE")
    print("=" * 70)
    print(f"Total actions metier simulees : {journal.succes + journal.erreurs}")
    print(f"Actions validees avec succes  : {journal.succes}")
    print(f"Erreurs / Anomalies           : {journal.erreurs}")
    print("=" * 70)


if __name__ == "__main__":
    executer_simulation_complete()
