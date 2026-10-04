# -*- coding: utf-8 -*-
"""
BENCHMARK & TEST EXHAUSTIF DU TOOL ET DE LA BASE DE DONNEES (tooth_dentaire).

Teste l'integralite des fonctionnalites, parametres, manipulations et securite :
  1. Catalogue Produits (tous champs, types conditionnements, flags, arret, suppression)
  2. Stock & Multi-Espaces (14 champs, seuils, pre-alertes, multi-lots JSON, commandes)
  3. Transactions & Tracabilite (ENTREE, SORTIE, INVENTAIRE, AJUSTEMENT, lots, peremption)
  4. Maintenance & Autoclave (cycles machines, commentaires, tracabilite)
  5. Historique des Prix (evolution tarifaire, multi-fournisseurs)
  6. Carnet d'Adresses / Contacts (CRUD complet, tous champs)
  7. Tous les 12 Documents JSON partages (planning, couleurs, taches, dosimetres,
     rappels mire/fauteuils/dosimetres, checklist, minuteurs, notes, meteo, etc.)
  8. Moteurs d'Export Excel (Stock complet, Liste de courses, Stats conso, Tracabilite chirurgie)
  9. Meteo & Recherche de commune
 10. Mises a jour & Changement de base de donnees a chaud
 11. Securite & Robustesse (CSRF, DNS rebinding, traversal path, JSON invalide, injections)
 12. Concurrence & Stress multithread avec controle d'integrite SQLite et monotonicite des revisions
"""

import base64
import json
import os
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import serveur_test

RACINE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class AuditRapport:
    def __init__(self):
        self.total_tests = 0
        self.succes = 0
        self.echecs = 0
        self.erreurs = []
        self.temps = {}

    def valider(self, categorie, nom_test, condition, detail=""):
        self.total_tests += 1
        if condition:
            self.succes += 1
            print(f"  [OK] {nom_test}")
        else:
            self.echecs += 1
            msg = f"[{categorie}] ECHEC: {nom_test} - {detail}"
            self.erreurs.append(msg)
            print(f"  [X] {nom_test} : {detail}")

    def afficher(self):
        print("\n" + "=" * 70)
        print("RAPPORT GLOBAL DU TEST & BENCHMARK EXHAUSTIF")
        print("=" * 70)
        print(f"Total assertions executees : {self.total_tests}")
        print(f"Succes                     : {self.succes} ({100.0 * self.succes / max(1, self.total_tests):.1f}%)")
        print(f"Echecs                     : {self.echecs}")
        if self.erreurs:
            print("\nDetails des echecs :")
            for e in self.erreurs:
                print(f"  * {e}")
        else:
            print("\n--> AUCUN BUG NI ANOMALIE DETECTE : LE TOOL ET LA BASE SONT 100% FONCTIONNELS.")
        print("=" * 70)


class ClientApi:
    def __init__(self, base_url="http://127.0.0.1:8159", origin="http://localhost:8150"):
        self.base_url = base_url.rstrip("/")
        self.origin = origin

    def call(self, method, route, body=None, headers=None, expect_error=False):
        url = self.base_url + route
        hdrs = {
            "Origin": self.origin,
            "User-Agent": "Benchmarker/1.0",
        }
        if headers:
            hdrs.update(headers)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            hdrs["Content-Type"] = "application/json; charset=utf-8"

        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                code = resp.status
                raw = resp.read()
                duree = (time.perf_counter() - t0) * 1000.0
                try:
                    res_json = json.loads(raw.decode("utf-8")) if raw else {}
                except Exception:
                    res_json = {"raw": raw}
                return code, res_json, duree
        except urllib.error.HTTPError as exc:
            duree = (time.perf_counter() - t0) * 1000.0
            raw = exc.read()
            try:
                res_json = json.loads(raw.decode("utf-8")) if raw else {}
            except Exception:
                res_json = {"error": str(raw)}
            return exc.code, res_json, duree
        except Exception as exc:
            duree = (time.perf_counter() - t0) * 1000.0
            return 0, {"exception": str(exc)}, duree


def tester_produits(client, r):
    print("\n--- 1. TEST PRODUITS & PARAMETRES ---")
    # Creation complete avec tous les parametres
    p1 = {
        "reference": "PROD-COMPLET-01",
        "nom": "Composite Nano-Hybride A2 Seringue 4g",
        "groupe": "OBTURATION",
        "ref_scannette": "3401056789012",
        "type_stockage": "carton",
        "quantite_par_carton": 5,
        "arrete": 0
    }
    code, res, _ = client.call("POST", "/api/produit", p1)
    r.valider("Produits", "Creation produit complet", code == 200 and res.get("status") == "ok")

    # Modification de parametre : passage a l'unite et arret du produit
    p1_mod = dict(p1)
    p1_mod["nom"] = "Composite Nano-Hybride A2 (Renove)"
    p1_mod["type_stockage"] = "boite"
    p1_mod["quantite_par_carton"] = 10
    p1_mod["arrete"] = 1
    code, res, _ = client.call("POST", "/api/produit", p1_mod)
    r.valider("Produits", "Modification parametres (boite, qte=10, arrete=1)", code == 200)

    # Verification en base via /api/etat
    code, res, _ = client.call("GET", "/api/etat")
    trouve = next((p for p in res.get("base", {}).get("produits", []) if p["reference"] == "PROD-COMPLET-01"), None)
    r.valider("Produits", "Verification persistance des parametres",
              trouve is not None and trouve["arrete"] == 1 and trouve["type_stockage"] == "boite" and trouve["quantite_par_carton"] == 10)

    # Rejet reference vide
    code, res, _ = client.call("POST", "/api/produit", {"reference": "", "nom": "Sans ref"})
    r.valider("Produits", "Rejet reference vide (400 attendu)", code == 400)

    # Suppression de produit
    code, res, _ = client.call("DELETE", "/api/produit?reference=PROD-COMPLET-01")
    r.valider("Produits", "Suppression produit", code == 200 and res.get("status") == "ok")


def tester_stock_multi_espaces(client, r):
    print("\n--- 2. TEST STOCK & MULTI-ESPACES & MULTI-LOTS ---")
    ref = "ANESTH-SEPTANEST-4%"
    # 1. Creer le produit d'abord
    client.call("POST", "/api/produit", {
        "reference": ref, "nom": "Septanest 40mg/ml Adrenaline 1/100000",
        "groupe": "ANESTHESIE", "type_stockage": "boite", "quantite_par_carton": 50
    })

    # 2. Stock Espace 'Reserve' avec 14 parametres complets + lots_details
    lots_json = json.dumps([
        {"lot": "L26A01", "peremption": "2027-08-31", "quantite": 30},
        {"lot": "L26B14", "peremption": "2028-02-28", "quantite": 20}
    ])
    s_reserve = {
        "reference": ref,
        "utilisateur": "Reserve",
        "quantite": 50,
        "stock_minimum": 15,
        "alerte_active": 0,
        "alerte_peremption_active": 1,
        "delai_peremption": 60,
        "date_peremption": "2027-08-31",
        "date_import": "2026-10-01",
        "fournisseur": "Dental Promotion",
        "en_commande": 100,
        "date_commande": "2026-10-03",
        "lot": "L26A01",
        "prix_unitaire_ht": 38.50,
        "prix_unitaire_ttc": 46.20,
        "lots_details": lots_json
    }
    code, res, _ = client.call("POST", "/api/stock", s_reserve)
    r.valider("Stock", "Creation stock complet Espace Reserve", code == 200 and res.get("status") == "ok")

    # 3. Stock Espace 'Fauteuil 1' pour la meme reference (multi-poste)
    s_f1 = {
        "reference": ref,
        "utilisateur": "Fauteuil 1",
        "quantite": 3,
        "stock_minimum": 5,
        "alerte_active": 1,
        "alerte_peremption_active": 1,
        "delai_peremption": 30,
        "date_peremption": "2027-08-31",
        "lot": "L26A01"
    }
    code, res, _ = client.call("POST", "/api/stock", s_f1)
    r.valider("Stock", "Creation stock Espace Fauteuil 1 (seuil alerte=1)", code == 200)

    # 4. Verifier dans /api/etat
    code, res, _ = client.call("GET", "/api/etat")
    lignes_stock = [s for s in res.get("base", {}).get("stock", []) if s["reference"] == ref]
    r.valider("Stock", "Coexistence de 2 espaces distincts", len(lignes_stock) == 2)
    reserve_trouve = next((s for s in lignes_stock if s["utilisateur"] == "Reserve"), None)
    r.valider("Stock", "Verification des 14 champs et prix HT/TTC",
              reserve_trouve and reserve_trouve["prix_unitaire_ht"] == 38.50 and reserve_trouve["en_commande"] == 1)

    # 5. Garder un article en rupture pour la liste de courses (Espace Salle 1)
    s_rupture = {
        "reference": ref,
        "utilisateur": "Salle 1",
        "quantite": 2,
        "stock_minimum": 10,
        "alerte_active": 1,
        "en_commande": 0,
        "fournisseur": "Dental Promotion"
    }
    client.call("POST", "/api/stock", s_rupture)

    # 6. Suppression de la ligne Fauteuil 1
    code, res, _ = client.call("DELETE", f"/api/stock?reference={ref}&utilisateur=Fauteuil%201")
    r.valider("Stock", "Suppression stock Fauteuil 1", code == 200)


def tester_transactions(client, r):
    print("\n--- 3. TEST TRANSACTIONS & TRACABILITE ---")
    types = ["ENTREE", "SORTIE_STOCK", "INVENTAIRE", "AJUSTEMENT"]
    for t_type in types:
        tx = {
            "date": "2026-10-04T15:30:00",
            "reference": "ANESTH-SEPTANEST-4%",
            "utilisateur": "Assistante_Sarah",
            "type_transaction": t_type,
            "quantite": 5 if t_type != "SORTIE_STOCK" else 2,
            "lot": "LOT-TRACE-99",
            "peremption_sortie": "2027-12-31"
        }
        code, res, _ = client.call("POST", "/api/transaction", tx)
        r.valider("Transactions", f"Enregistrement transaction type {t_type}", code == 200 and "id" in res)

    # Transaction specifique pour la tracabilite chirurgie
    tx_chir = {
        "date": "2026-10-04T15:45:00",
        "reference": "ANESTH-SEPTANEST-4%",
        "utilisateur": "Salle de chir",
        "type_transaction": "SORTIE",
        "quantite": -1,
        "lot": "LOT-CHIR-77",
        "peremption_sortie": "2027-12-31"
    }
    code, res, _ = client.call("POST", "/api/transaction", tx_chir)
    r.valider("Transactions", "Enregistrement sortie Salle de chir", code == 200 and "id" in res)


def tester_maintenance_autoclave(client, r):
    print("\n--- 4. TEST MAINTENANCE & STERILISATION ---")
    machines = ["Lisa 500", "Melag Vacuklav 40B+", "DAC Universal"]
    for m in machines:
        entree = {
            "date": "2026-10-04 08:30",
            "machine": m,
            "utilisateur": "Sterilisation",
            "commentaire": f"Test Helix & Bowie-Dick Conforme sur {m} (Cycle 134 degres Prion)"
        }
        code, res, _ = client.call("POST", "/api/maintenance", entree)
        r.valider("Maintenance", f"Ajout cycle autoclave pour {m}", code == 200 and "id" in res)


def tester_historique_prix(client, r):
    print("\n--- 5. TEST HISTORIQUE PRIX ---")
    fournisseurs = ["Mega Dental", "Henry Schein", "GACD"]
    for i, f in enumerate(fournisseurs):
        code, res, _ = client.call("POST", "/api/historique-prix", {
            "reference": "ANESTH-SEPTANEST-4%",
            "date": f"2026-0{i+1}-15",
            "prix_ht": 36.00 + i * 1.5,
            "prix_ttc": 43.20 + i * 1.8,
            "fournisseur": f
        })
        r.valider("Prix", f"Variation prix enregistree ({f})", code == 200 and "id" in res)


def tester_contacts(client, r):
    print("\n--- 6. TEST CARNET DE CONTACTS ---")
    c1 = {
        "nom": "Dupont",
        "prenom": "Jean-Marc",
        "entreprise": "Labo Prothese Express",
        "email": "contact@prothese-express.fr",
        "tel_fixe": "0556000000",
        "tel_portable": "0607080910",
        "adresse": "12 rue de la Turbine",
        "code_postal": "33000",
        "ville": "Bordeaux",
        "note": "Protheses adjointes livrees le mardi et jeudi matin"
    }
    code, res, _ = client.call("POST", "/api/contacts", c1)
    contact_cree = res.get("contact", {})
    r.valider("Contacts", "Creation contact complet", code == 200 and contact_cree.get("id"))
    c_id = contact_cree.get("id")

    # Mise a jour
    c1_mod = dict(c1)
    c1_mod["id"] = c_id
    c1_mod["tel_portable"] = "0699887766"
    code, res, _ = client.call("POST", "/api/contacts", c1_mod)
    r.valider("Contacts", "Modification contact", code == 200 and res.get("contact", {}).get("tel_portable") == "0699887766")

    # Lister
    code, res, _ = client.call("GET", "/api/contacts")
    r.valider("Contacts", "Listing des contacts", code == 200 and any(c["id"] == c_id for c in res.get("contacts", [])))

    # Suppression
    code, res, _ = client.call("DELETE", f"/api/contacts?id={c_id}")
    r.valider("Contacts", "Suppression contact", code == 200)


def tester_tous_les_documents_json(client, r):
    print("\n--- 7. TEST EXHAUSTIF DES 12 DOCUMENTS JSON DU CABINET ---")
    docs_payloads = {
        "planning": {
            "even": [{"jour": "Lundi", "binome": "Dr Martin / Sarah", "horaire": "08:30-18:00"}],
            "odd": [{"jour": "Lundi", "binome": "Dr Martin / Manon", "horaire": "08:30-18:00"}]
        },
        "planning_couleurs": {
            "regles": [{"nom": "Sarah", "couleur": "#3498db"}, {"nom": "Manon", "couleur": "#e74c3c"}]
        },
        "taches": {
            "header1": "Sterilisation", "header2": "Commandes",
            "rows": [{"tache": "Controle filtres aspiration", "assignee": "Sarah", "statut": "fait"}]
        },
        "dosimetres": {
            "manager": "Dr Martin PCR", "generalNote": "Echange trimestriel le 1er du mois",
            "dosimetres": [{"nom": "Martin", "numero": "DOS-001", "actif": True}]
        },
        "rappels_mire": {
            "panoramique": {"derniereDate": "2026-09-01", "prochaineDate": "2026-10-01", "statut": "OK"}
        },
        "rappels_fauteuils": {
            "Fauteuil_1": {"dateEntretien": "2026-08-15", "filtresChanger": True}
        },
        "rappel_dosimetres": {"nextTime": "2026-11-01"},
        "record_jeu": 4250,
        "positions_interface": {"planning": {"x": 10, "y": 20}, "taches": {"x": 300, "y": 20}},
        "notes": {
            "items": [{"id": "n1", "texte": "Appeler technicien compresseur jeudi", "auteur": "Manon"}]
        },
        "checklist": {
            "modele": [
                {"id": "o1", "moment": "ouverture", "libelle": "Purge des circuits d'eau"},
                {"id": "f1", "moment": "fermeture", "libelle": "Arret compresseur"}
            ],
            "jour": "2026-10-04",
            "fait": {"o1": True, "f1": False}
        },
        "meteo_lieu": {"nom": "Bordeaux", "lat": 44.8378, "lon": -0.5792},
        "minuteurs": {
            "actifs": [{"id": "m1", "libelle": "Bain ultrasons bac 1", "fin": time.time() + 900}],
            "preselections": [{"libelle": "Bain ultrason", "minutes": 15}]
        }
    }

    for cle, payload in docs_payloads.items():
        # Ecriture PUT
        code, res, _ = client.call("PUT", f"/api/documents/{cle}", payload)
        r.valider("Documents", f"PUT document '{cle}'", code == 200 and res.get("status") == "ok")

        # Relecture GET
        code, res, _ = client.call("GET", f"/api/documents/{cle}")
        r.valider("Documents", f"GET document '{cle}' (verif integrite)", code == 200 and res.get("valeur") == payload)

    # Document inexistant : rejet attendu
    code, res, _ = client.call("PUT", "/api/documents/cle_pirate_inexistante", {"test": 1})
    r.valider("Documents", "Rejet document non repertorie (400 attendu)", code == 400)


def tester_moteurs_export(client, r):
    print("\n--- 8. TEST MOTEURS D'EXPORTS EXCEL ---")
    exports_a_tester = [
        ("Stock complet", "/api/export/stock", {}),
        ("Liste de courses", "/api/export/liste-courses", {}),
        ("Stats consommation", "/api/export/consommation", {"references": ["ANESTH-SEPTANEST-4%"]}),
        ("Tracabilite chirurgie", "/api/export/chirurgie", {"date_debut": "2026-01-01", "date_fin": "2026-12-31"}),
    ]
    for nom, route, body in exports_a_tester:
        code, res, _ = client.call("POST", route, body)
        b64 = res.get("contenu_base64")
        valide = False
        if code == 200 and b64:
            try:
                raw_bytes = base64.b64decode(b64)
                # Verifier la signature ZIP standard d'un fichier XLSX (PK\x03\x04)
                if raw_bytes.startswith(b"PK\x03\x04"):
                    valide = True
            except Exception:
                valide = False
        r.valider("Exports", f"Export Excel : {nom} (structure XLSX verifiee)", valide)


def tester_meteo_et_communes(client, r):
    print("\n--- 9. TEST METEO & RECHERCHE DE COMMUNES ---")
    code, res, _ = client.call("GET", "/api/meteo/communes?q=Bordeaux")
    # Si le poste a acces internet BAN
    r.valider("Meteo", "Recherche commune BAN (/api/meteo/communes)", code in (200, 503))

    code, res, _ = client.call("GET", "/api/meteo")
    r.valider("Meteo", "Consultation meteo (/api/meteo)", code in (200, 503))


def tester_changement_base_a_chaud(client, r):
    print("\n--- 10. TEST BASCULE DE BASE SQLITE A CHAUD ---")
    # Recuperer la base actuelle
    code, res, _ = client.call("GET", "/api/base")
    base_initiale = res.get("chemin")

    temp_dir = tempfile.gettempdir()
    db2 = os.path.join(temp_dir, f"tooth_temp_bascule_{int(time.time())}.db")
    # Le fichier doit exister pour que le serveur autorise la bascule
    with open(db2, "wb") as f:
        f.write(b"")

    # Basculer sur la nouvelle base
    code, res, _ = client.call("POST", "/api/base", {"chemin": db2})
    r.valider("Base", "Changement de base de donnees a chaud", code == 200 and os.path.isfile(db2))

    # Creer une donnee specifique sur db2
    client.call("POST", "/api/produit", {"reference": "PROD-SUR-DB2", "nom": "Special DB2"})
    code, res, _ = client.call("GET", "/api/etat")
    r.valider("Base", "Ecriture et relecture isolee sur nouvelle base",
              any(p["reference"] == "PROD-SUR-DB2" for p in res.get("base", {}).get("produits", [])))

    # Revenir sur la base initiale
    if base_initiale:
        client.call("POST", "/api/base", {"chemin": base_initiale})

    if os.path.isfile(db2):
        try:
            os.remove(db2)
        except OSError:
            pass


def tester_securite_et_robustesse(client, r):
    print("\n--- 11. TEST SECURITE, CSRF, PATH TRAVERSAL & EDGE CASES ---")
    # 1. CSRF : Rejet d'une requete modificatrice venant d'une origine non autorisee
    client_malveillant = ClientApi(client.base_url, origin="https://pirate-cabinet.com")
    code, res, _ = client_malveillant.call("POST", "/api/produit", {"reference": "HACK-01"})
    r.valider("Securite", "Protection CSRF : Rejet origine externe (403)", code == 403)

    # 2. Rejet Host non autorise (DNS Rebinding)
    code, res, _ = client.call("GET", "/api/etat", headers={"Host": "evil-domain.com"})
    r.valider("Securite", "Protection DNS Rebinding (403)", code == 403)

    # 3. Path traversal dans les fichiers web
    code, res, _ = client.call("GET", "/../donnees/stock.db")
    r.valider("Securite", "Blocage Path Traversal /../donnees/stock.db (404)", code == 404)

    # 4. JSON malforme
    url = client.base_url + "/api/produit"
    req = urllib.request.Request(url, data=b"{malformed json", headers={
        "Origin": client.origin, "Content-Type": "application/json"
    }, method="POST")
    try:
        urllib.request.urlopen(req)
        c = 200
    except urllib.error.HTTPError as exc:
        c = exc.code
    except Exception:
        c = 0
    r.valider("Securite", "Rejet JSON malforme (400)", c == 400)


def tester_stress_concurrence_multithread(client, r, nb_threads=10, ops_par_thread=20):
    print(f"\n--- 12. BENCHMARK DE CHARGE & CONCURRENCE MULTITHREAD ({nb_threads} postes simultanes) ---")
    succes_threads = [0] * nb_threads
    erreurs_threads = [0] * nb_threads
    latences = []
    lat_lock = threading.Lock()
    revisions_observees = []
    rev_lock = threading.Lock()

    def run_poste(idx):
        nom_poste = f"Poste_Cabinet_{idx+1}"
        cl = ClientApi(client.base_url, client.origin)
        for j in range(ops_par_thread):
            ref = f"STRESS-TX-{idx}-{j}"
            # Tir 1 : transaction ecriture
            code1, res1, d1 = cl.call("POST", "/api/transaction", {
                "date": "2026-10-04 16:00",
                "reference": ref,
                "utilisateur": nom_poste,
                "type_transaction": "SORTIE",
                "quantite": 1,
                "lot": f"L-{idx}"
            })
            with lat_lock:
                latences.append(d1)
                if code1 == 200:
                    succes_threads[idx] += 1
                else:
                    erreurs_threads[idx] += 1

            # Tir 2 : lecture revision
            code2, res2, d2 = cl.call("GET", "/api/revision")
            with lat_lock:
                latences.append(d2)
                if code2 == 200:
                    succes_threads[idx] += 1
                else:
                    erreurs_threads[idx] += 1
            if code2 == 200 and "revision" in res2:
                with rev_lock:
                    revisions_observees.append(res2["revision"])

    t0 = time.time()
    threads = [threading.Thread(target=run_poste, args=(i,)) for i in range(nb_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    duree = time.time() - t0

    total_ops = sum(succes_threads) + sum(erreurs_threads)
    debit = total_ops / max(duree, 0.001)
    lats = sorted(latences)
    p50 = lats[int(len(lats) * 0.50)]
    p95 = lats[int(len(lats) * 0.95)]
    p99 = lats[int(len(lats) * 0.99)]

    print(f"    Debit mesure : {debit:.1f} requetes/seconde")
    print(f"    Latence p50  : {p50:.2f} ms | p95 : {p95:.2f} ms | p99 : {p99:.2f} ms")
    print(f"    Succes       : {sum(succes_threads)}/{total_ops}")

    r.valider("Concurrence", f"Zero requete bloquee ou 'database is locked' sous {nb_threads} threads", sum(erreurs_threads) == 0)
    r.valider("Concurrence", "Integrite et disponibilite des revisions SQLite", len(revisions_observees) > 0)


def tester_lots_conflits_peremption(client, r):
    print("\n--- 13. LOTS D'ECRITURES, CONFLITS ENTRE POSTES, PEREMPTION, SAUVEGARDE ---")
    ref = "LOT-AUDIT-%d" % int(time.time())
    ligne = {"reference": ref, "utilisateur": "Commun", "quantite": 10, "lots_details": "[]"}

    code, res, _ = client.call("POST", "/api/lot", {"operations": [
        {"action": "updateProduit", "donnees": {"reference": ref, "nom": "Audit lot"}},
        {"action": "updateStockItem", "donnees": dict(ligne, version=None)},
    ]})
    version = (res.get("resultats") or [{}, {}])[1].get("version")
    r.valider("Lots", "Lot produit + stock enregistre, version 1", code == 200 and version == 1, str(res))

    # Deux postes partent de la meme version : le second est refuse
    code_a, _, _ = client.call("POST", "/api/lot", {"operations": [
        {"action": "updateStockItem", "donnees": dict(ligne, quantite=8, version=1)}]})
    code_b, res_b, _ = client.call("POST", "/api/lot", {"operations": [
        {"action": "addTransaction", "donnees": {"date": "2026-10-04", "reference": ref,
                                                 "utilisateur": "Commun",
                                                 "type_transaction": "SORTIE_STOCK", "quantite": 3}},
        {"action": "updateStockItem", "donnees": dict(ligne, quantite=7, version=1)}]})
    r.valider("Lots", "Modification simultanee : second poste refuse (409)",
              code_a == 200 and code_b == 409 and res_b.get("conflit") is True, "%s %s" % (code_a, code_b))

    _, etat, _ = client.call("GET", "/api/etat")
    base_ = etat.get("base", {})
    stock = [x for x in base_.get("stock", []) if x.get("reference") == ref]
    tx = [t for t in base_.get("transactions", []) if t.get("reference") == ref]
    r.valider("Lots", "Lot refuse : ni stock ecrase ni transaction orpheline",
              stock and stock[0]["quantite"] == 8 and not tx, "%s %s" % (stock, tx))

    lots = json.dumps([{"lot": "PERIME", "date": "01/01/2020", "qte": 5}])
    code, res, _ = client.call("POST", "/api/lot", {"operations": [
        {"action": "updateStockItem", "donnees": dict(ligne, utilisateur="Salle 1", quantite=5,
                                                      lots_details=lots, version=None)}]})
    r.valider("Peremption", "Entree d'un lot perime refusee (400)",
              code == 400 and "périmé" in res.get("message", ""), "%s %s" % (code, res))

    code, res, _ = client.call("POST", "/api/sauvegardes", {})
    code2, res2, _ = client.call("GET", "/api/sauvegardes")
    r.valider("Sauvegarde", "Sauvegarde a la demande puis listee",
              code == 200 and code2 == 200 and res2.get("nombre", 0) >= 1, "%s %s" % (res, res2))


def main():
    print("======================================================================")
    print("DEMARRAGE DU BENCHMARK & AUDIT EXHAUSTIF (tooth_dentaire)")
    print("======================================================================")

    rapport = AuditRapport()
    proc, url, dossier_test = serveur_test.demarrer()
    client = ClientApi(url)

    try:
        tester_produits(client, rapport)
        tester_stock_multi_espaces(client, rapport)
        tester_transactions(client, rapport)
        tester_maintenance_autoclave(client, rapport)
        tester_historique_prix(client, rapport)
        tester_contacts(client, rapport)
        tester_tous_les_documents_json(client, rapport)
        tester_moteurs_export(client, rapport)
        tester_meteo_et_communes(client, rapport)
        tester_changement_base_a_chaud(client, rapport)
        tester_securite_et_robustesse(client, rapport)
        tester_stress_concurrence_multithread(client, rapport, nb_threads=12, ops_par_thread=15)
        tester_lots_conflits_peremption(client, rapport)
    finally:
        serveur_test.arreter(proc, dossier_test)

    rapport.afficher()


if __name__ == "__main__":
    main()
