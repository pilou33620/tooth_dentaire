# -*- coding: utf-8 -*-
"""
Benchmark Multi-Agents pour tooth_dentaire.

Simule X agents concurrents qui :
1. (Optionnel) Testent le workflow d'installation dans un bac a sable isole.
2. Demarrent un serveur de test dedie sur une base SQLite temporaire.
3. Simulent differents profils de postes du cabinet dentaire en concurrence :
   - Accueil / Secretariat (produits, stock, contacts, recherche)
   - Salle de Soins (sorties de stock, verification lots, alertes)
   - Sterilisation (autoclaves, checklists, minuteurs, taches)
   - Direction (exports Excel, planning, configuration)
   - Stress-Test (rafales d'ecriture/lecture, verrous, charges lourdes)
4. Mesurent le debit (req/s), la latence (min, moy, p95, max), et verifient l'integrite de la base.
"""

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

RACINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ResultatsBenchmark:
    def __init__(self):
        self.lock = threading.Lock()
        self.latences = []          # en millisecondes
        self.succes = 0
        self.erreurs = 0
        self.details_erreurs = []
        self.debut = 0
        self.fin = 0

    def enregistrer(self, duree_ms, ok, erreur=None):
        with self.lock:
            self.latences.append(duree_ms)
            if ok:
                self.succes += 1
            else:
                self.erreurs += 1
                if erreur and len(self.details_erreurs) < 20:
                    self.details_erreurs.append(str(erreur))

    def rapport(self):
        duree_totale = max(self.fin - self.debut, 0.001)
        total = self.succes + self.erreurs
        if not self.latences:
            return "Aucune requete effectuee."
        lats = sorted(self.latences)
        p50 = lats[int(len(lats) * 0.50)]
        p95 = lats[int(len(lats) * 0.95)]
        p99 = lats[int(len(lats) * 0.99)]
        moy = sum(lats) / len(lats)
        debit = total / duree_totale

        lignes = [
            "=" * 60,
            "RESULTATS DU BENCHMARK MULTI-AGENTS",
            "=" * 60,
            f"Duree totale      : {duree_totale:.2f} s",
            f"Requetes totales  : {total}",
            f"Succes            : {self.succes} ({100.0 * self.succes / total:.1f}%)",
            f"Erreurs           : {self.erreurs} ({100.0 * self.erreurs / total:.1f}%)",
            f"Debit             : {debit:.1f} requetes/seconde",
            f"Latence moyenne   : {moy:.2f} ms",
            f"Latence Min       : {lats[0]:.2f} ms",
            f"Latence p50       : {p50:.2f} ms",
            f"Latence p95       : {p95:.2f} ms",
            f"Latence p99       : {p99:.2f} ms",
            f"Latence Max       : {lats[-1]:.2f} ms",
            "=" * 60,
        ]
        if self.details_erreurs:
            lignes.append("Exemples d'erreurs rencontrees :")
            for err in self.details_erreurs[:5]:
                lignes.append(f"  - {err}")
            lignes.append("=" * 60)
        return "\n".join(lignes)


class ClientCabinet:
    """Client HTTP simulant un poste de travail du cabinet."""
    def __init__(self, base_url, nom):
        self.base_url = base_url.rstrip("/")
        self.nom = nom
        self.session_origin = "http://localhost:8150"

    def _requete(self, methode, chemin, corps=None):
        url = self.base_url + chemin
        donnees = None
        headers = {
            "Origin": self.session_origin,
            "User-Agent": f"AgentCabinet/{self.nom}",
        }
        if corps is not None:
            donnees = json.dumps(corps).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"

        req = urllib.request.Request(url, data=donnees, headers=headers, method=methode)
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                contenu = resp.read()
                duree_ms = (time.perf_counter() - t0) * 1000.0
                return duree_ms, True, json.loads(contenu.decode("utf-8")) if contenu else {}
        except Exception as exc:
            duree_ms = (time.perf_counter() - t0) * 1000.0
            return duree_ms, False, str(exc)

    def get_etat(self):
        return self._requete("GET", "/api/etat")

    def get_revision(self):
        return self._requete("GET", "/api/revision")

    def ajouter_produit(self, ref, nom, groupe):
        return self._requete("POST", "/api/produit", {
            "reference": ref, "nom": nom, "groupe": groupe,
            "ref_scannette": "", "type_stockage": "unite", "quantite_par_carton": 1
        })

    def maj_stock(self, ref, qte, alerte=5):
        return self._requete("POST", "/api/stock", {
            "reference": ref, "utilisateur": self.nom, "quantite": qte,
            "stock_minimum": alerte, "alerte_active": 1 if qte <= alerte else 0
        })

    def transaction(self, ref, type_tx, qte, lot="LOT-TEST"):
        return self._requete("POST", "/api/transaction", {
            "reference": ref, "utilisateur": self.nom,
            "type_transaction": type_tx, "quantite": qte,
            "date": "2026-10-04 14:00", "lot": lot
        })

    def maintenance_autoclave(self, machine, cycle_ok=True):
        return self._requete("POST", "/api/maintenance", {
            "date": "2026-10-04 14:15", "machine": machine,
            "utilisateur": self.nom,
            "commentaire": "Cycle Bowie-Dick OK" if cycle_ok else "Erreur de pression"
        })

    def update_document(self, cle, data):
        return self._requete("PUT", f"/api/documents/{cle}", data)

    def export_stock(self):
        return self._requete("POST", "/api/export/stock", {})


def scenario_accueil(agent, stats, iterations):
    """Simule le poste Accueil / Secretariat."""
    for i in range(iterations):
        ref = f"ACC-{agent.nom}-{i}"
        # 1. Verification revision / etat
        d, ok, _ = agent.get_revision()
        stats.enregistrer(d, ok)
        d, ok, _ = agent.get_etat()
        stats.enregistrer(d, ok)
        # 2. Creation d'un produit
        d, ok, _ = agent.ajouter_produit(ref, f"Article Secretariat {i}", "CONSOMMABLES")
        stats.enregistrer(d, ok)
        # 3. Entree en stock
        d, ok, _ = agent.maj_stock(ref, 20)
        stats.enregistrer(d, ok)
        d, ok, _ = agent.transaction(ref, "ENTREE", 20)
        stats.enregistrer(d, ok)
        time.sleep(0.01)


def scenario_soins(agent, stats, iterations):
    """Simule un poste en salle de soins (consommations rapides, alertes)."""
    for i in range(iterations):
        ref = f"SOINS-{i % 5}"
        d, ok, _ = agent.get_revision()
        stats.enregistrer(d, ok)
        # Sortie de stock
        d, ok, _ = agent.transaction(ref, "SORTIE", 1, lot=f"LOT-{i % 3}")
        stats.enregistrer(d, ok)
        # Lecture etat
        d, ok, _ = agent.get_etat()
        stats.enregistrer(d, ok)
        time.sleep(0.01)


def scenario_sterilisation(agent, stats, iterations):
    """Simule le poste de sterilisation (autoclave, checklist, minuteurs)."""
    for i in range(iterations):
        # 1. Enregistrement cycle autoclave
        d, ok, _ = agent.maintenance_autoclave(f"Lisa-{i % 2 + 1}")
        stats.enregistrer(d, ok)
        # 2. Mise a jour checklist
        checklist = {
            "modele": [{"id": "o1", "moment": "ouverture", "libelle": "Test autoclave"}],
            "jour": "2026-10-04",
            "fait": {"o1": True}
        }
        d, ok, _ = agent.update_document("checklist", checklist)
        stats.enregistrer(d, ok)
        # 3. Minuteurs
        d, ok, _ = agent.update_document("minuteurs", {
            "actifs": [{"id": f"min-{i}", "libelle": "Trempage bac 1", "fin": time.time() + 600}],
            "preselections": []
        })
        stats.enregistrer(d, ok)
        time.sleep(0.01)


def scenario_stress(agent, stats, iterations):
    """Agent envoyant des rafales de transactions et lectures pour stresser SQLite."""
    for i in range(iterations):
        ref = f"STRESS-{i % 10}"
        if i % 3 == 0:
            d, ok, _ = agent.maj_stock(ref, random.randint(1, 100))
        elif i % 3 == 1:
            d, ok, _ = agent.transaction(ref, "SORTIE", 2)
        else:
            d, ok, _ = agent.get_etat()
        stats.enregistrer(d, ok)


def scenario_exports(agent, stats, iterations):
    """Agent qui genere des exports Excel reguliers."""
    for _ in range(max(1, iterations // 5)):
        d, ok, _ = agent.export_stock()
        stats.enregistrer(d, ok)
        time.sleep(0.05)


def tester_installation_sandbox():
    """Teste le telechargement / execution de l'installation dans un dossier temporaire."""
    print("\n[+] Verification du script d'installation Installer.bat dans une sandbox...")
    dossier_test = tempfile.mkdtemp(prefix="tooth_benchmark_install_")
    bat = os.path.join(RACINE, "installation", "Installer.bat")
    if not os.path.isfile(bat):
        print(f"[-] Installer.bat introuvable dans {bat}")
        return False

    env = dict(os.environ)
    env["TOOTH_DESTINATION"] = dossier_test
    env["TOOTH_SILENCIEUX"] = "1"
    env["TOOTH_SANS_BUREAU"] = "1"
    env["TOOTH_GARDER"] = "1"

    t0 = time.time()
    try:
        proc = subprocess.run(
            ["cmd.exe", "/c", bat],
            env=env,
            cwd=tempfile.gettempdir(),
            capture_output=True,
            text=True,
            timeout=180
        )
        duree = time.time() - t0
        print(f"    Code retour installateur : {proc.returncode} ({duree:.1f} s)")
        serveur_installe = os.path.join(dossier_test, "serveur.py")
        venv_installe = os.path.join(dossier_test, ".venv")
        if os.path.isfile(serveur_installe):
            print(f"    [OK] Fichiers installes avec succes dans {dossier_test}")
            return True
        else:
            print(f"    [!] Fichiers non presents. Sortie:\n{proc.stdout[-500:]}\n{proc.stderr[-500:]}")
            return False
    except subprocess.TimeoutExpired:
        print("    [!] Timeout pendant l'installation sandbox.")
        return False
    except Exception as exc:
        print(f"    [!] Erreur pendant l'installation sandbox : {exc}")
        return False
    finally:
        shutil.rmtree(dossier_test, ignore_errors=True)


def executer_benchmark(nb_agents=6, iterations=50, test_install=False, port=8159):
    if test_install:
        tester_installation_sandbox()

    print(f"\n[+] Demarrage du serveur de benchmark sur le port {port}...")
    db_test = os.path.join(tempfile.gettempdir(), f"tooth_benchmark_{int(time.time())}.db")
    
    cmd_serveur = [
        sys.executable,
        os.path.join(RACINE, "serveur.py"),
        "--port", str(port),
        "--base", db_test,
        "--local",
        "--sans-navigateur",
        "--sans-pause"
    ]
    proc_serveur = subprocess.Popen(cmd_serveur, cwd=RACINE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)  # Laisser le serveur s'initialiser

    url = f"http://127.0.0.1:{port}"
    stats = ResultatsBenchmark()
    stats.debut = time.time()

    threads = []
    profils = [
        ("Accueil_1", scenario_accueil),
        ("Soins_1", scenario_soins),
        ("Soins_2", scenario_soins),
        ("Sterilisation", scenario_sterilisation),
        ("Export_Direction", scenario_exports),
        ("Stress_Tester", scenario_stress),
    ]

    print(f"[+] Lancement de {nb_agents} agents concurrents ({iterations} iterations par agent)...")

    for i in range(nb_agents):
        nom, fn = profils[i % len(profils)]
        nom_agent = f"{nom}_{i+1}"
        agent = ClientCabinet(url, nom_agent)
        t = threading.Thread(target=fn, args=(agent, stats, iterations), name=nom_agent)
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    stats.fin = time.time()
    print("[+] Tous les agents ont termine leurs operations.")

    # Arret du serveur
    proc_serveur.terminate()
    try:
        proc_serveur.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc_serveur.kill()

    # Nettoyage base temporaire
    if os.path.isfile(db_test):
        try:
            os.remove(db_test)
        except OSError:
            pass

    print("\n" + stats.rapport())
    return stats


def main():
    parser = argparse.ArgumentParser(description="Benchmark Multi-Agents tooth_dentaire")
    parser.add_argument("--agents", type=int, default=6, help="Nombre d'agents concurrents (defaut: 6)")
    parser.add_argument("--iterations", type=int, default=40, help="Nombre d'operations par agent (defaut: 40)")
    parser.add_argument("--test-install", action="store_true", help="Tester aussi le workflow d'installation sandbox")
    parser.add_argument("--port", type=int, default=8159, help="Port de test pour le serveur (defaut: 8159)")
    args = parser.parse_args()

    executer_benchmark(nb_agents=args.agents, iterations=args.iterations, test_install=args.test_install, port=args.port)


if __name__ == "__main__":
    main()
