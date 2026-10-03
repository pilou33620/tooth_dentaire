# tooth_dentaire

Gestion de stock et du quotidien d'un cabinet dentaire, en version web.

Outil de gestion du cabinet : stock et lots, import de factures PDF, alertes,
maintenance des équipements, rappels mire / fauteuils / dosimètres, planning des
binômes, tâches des assistantes, carnet d'adresses.

Un **serveur Python** (`serveur.py`) tourne sur un poste du cabinet ; l'interface
s'ouvre dans le **navigateur**, sur ce poste comme sur tous les autres postes du
réseau (accueil, stérilisation, tablette…). Toutes les données sont dans une base
SQLite partagée : une modification faite sur un poste apparaît sur les autres en
quelques secondes.

## Démarrage

```bash
pip install -r requirements.txt
python serveur.py
```

Sous Windows, un double-clic sur `Lancer.bat` (ou sur `serveur.py`) suffit.
Le navigateur s'ouvre et la console affiche l'adresse à utiliser depuis les autres
postes, par exemple `http://192.168.1.20:8150/`. Cette adresse est aussi visible
dans **Réglages**.

| Option | Effet |
|---|---|
| `--local` | n'accepte que ce poste (aucun accès réseau) |
| `--port 9000` | change le port (8150 par défaut) |
| `--base D:\stock.db` | utilise une autre base |
| `--importer "C:\...\ancien dossier"` | reprend les données de l'ancienne application |
| `--sans-navigateur` | n'ouvre pas le navigateur |

Au premier lancement en réseau, Windows demande d'autoriser Python dans le
pare-feu : accepter pour les **réseaux privés**.

> Le serveur n'a pas de mot de passe : il est prévu pour le réseau du cabinet
> uniquement. Les requêtes venant d'un autre site web sont refusées, et le
> changement de base ne peut se faire que depuis le poste qui fait tourner le serveur.

## Données et confidentialité

**Aucune donnée du cabinet n'est écrite dans le code.** Noms du personnel, planning,
couleurs du planning, tâches, dosimètres, contacts, rappels, stock : tout est dans
la base (`donnees/stock.db` par défaut), et le dossier `donnees/` est exclu de git
(voir `.gitignore`). Le dépôt peut donc être publié sans rien exposer.

- **Sauvegarde** : copier `donnees/stock.db` (serveur arrêté de préférence).
- **Base ailleurs** (lecteur réseau, dossier synchronisé) : `--base` ou Réglages.
- Seules les **positions de l'interface** (mode personnalisation) restent propres à
  chaque poste, car les écrans n'ont pas tous la même taille.

## Interface

L'accueil s'inspire de l'extension [Bonjourr](https://bonjourr.fr) : fond plein écran
qui change avec l'heure (aube, jour, crépuscule, nuit), grande horloge, salutation,
recherche et accès rapides en verre dépoli, widgets planning / tâches / ruptures,
alertes dans le coin haut gauche et citation du jour.

**Réglages ⚙️ > Apparence** (propre à chaque poste) : fond (selon l'heure, animation du
cabinet, image personnelle ou couleur unie), flou et luminosité du fond, horloge
numérique ou analogique, taille, secondes, salutation et nom, citation, widgets affichés.
`Échap` ferme la fenêtre ouverte.

## Reprise de l'ancienne application (PySide6)

```bash
python serveur.py --importer "C:\chemin\vers\ancienne-appli"
```

Sont repris :
- `stock.db`, ou la base choisie dans les réglages de l'ancienne appli ;
- tout ce que l'ancienne appli gardait dans son navigateur intégré
  (`webstorage/`) : planning, dosimètres, rappels, carnet d'adresses modifié,
  record du mini-jeu, positions de l'interface ;
- à défaut, les valeurs qui étaient écrites dans l'ancien code (tâches,
  consigne sous le tableau des tâches, carnet d'adresses d'origine).

Si la base de destination contient déjà du stock, l'import s'arrête ; `--forcer`
la remplace après en avoir fait une copie (`stock.db.avant-import-AAAAMMJJ-HHMMSS`).

Les **couleurs du planning** étaient calculées dans l'ancien code à partir des
prénoms : elles se règlent désormais dans le planning, onglet **🎨 Couleurs**
(légende + règles « praticien / jour / créneau → couleur »).

## Structure

```
serveur.py            serveur HTTP + API JSON (bibliothèque standard)
python/
  base.py             base SQLite (schéma, lecture, écritures, documents, contacts)
  exports.py          exports Excel (openpyxl)
  migration.py        reprise de l'ancienne application
  leveldb_lecteur.py  lecture du stockage navigateur de l'ancienne appli
web/                  interface (HTML / CSS / JavaScript, sans framework)
  js/core/api.js      échanges avec le serveur + synchronisation entre postes
  js/ui/bonjourr.js   accueil : horloge, salutation, citation, fond, réglages d'apparence
  css/bonjourr.css    thème de l'interface (chargé après css/style.css)
  vendor/             PDF.js (lecture des factures, hors ligne)
tests/                tests Python (pytest)
web/tests/            tests JavaScript (Jest)
donnees/              base et configuration — non versionné
```

### API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/etat` | toute la base + documents |
| GET | `/api/revision` | numéro de révision (surveillance entre postes) |
| POST | `/api/produit`, `/api/stock` | création / mise à jour |
| DELETE | `/api/produit?reference=`, `/api/stock?reference=&utilisateur=` | suppression |
| POST | `/api/transaction`, `/api/maintenance`, `/api/historique-prix` | ajout |
| GET / PUT | `/api/documents/<cle>` | planning, couleurs, tâches, dosimètres, rappels… |
| GET / POST / DELETE | `/api/contacts` | carnet d'adresses |
| POST | `/api/export/stock`, `liste-courses`, `consommation`, `chirurgie` | exports Excel (base64) |
| GET / POST | `/api/base` | chemin de la base (changement : poste serveur seulement) |
| GET | `/api/info` | version et adresse réseau |

## Feuille de route

Voir [A_FAIRE.md](A_FAIRE.md).

## Tests

```bash
python scripts/run_tests.py      # tout
python -m pytest tests           # Python
cd web && npm install && npm test   # JavaScript (Node.js)
```

`run_tests.py` utilise le moteur Node intégré à VS Code si Node.js n'est pas installé.
