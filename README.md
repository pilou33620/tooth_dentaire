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

### Installer sur un poste du cabinet

```bash
python scripts/preparer_installation.py
```

produit `dist/Installation tooth_dentaire/` (et son `.zip`) : l'outil sans les
tests, les bibliothèques en wheels (installation sans internet), `Installer.bat`.
Sur le poste : y placer l'installateur Python (`python-3.x.x-amd64.exe`, inutile si
Python 3.8+ est déjà installé) et éventuellement un `stock.db` à reprendre, puis
double-cliquer sur `Installer.bat`. Il installe Python (sans droits administrateur),
copie l'outil (par défaut dans `C:\tooth_dentaire`) avec un environnement `.venv`,
garde l'installateur Python à côté de `Lancer.bat`, crée un raccourci sur le Bureau
puis supprime le dossier d'installation. Une réinstallation ne touche pas à `donnees/`.

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
- **Tout est dans `stock.db`** : stock, produits arrêtés (« ne plus commander »),
  rappels des mires, fauteuils et dosimètres, maintenance, planning, tâches,
  contacts, notes, checklist, minuteurs, commune météo. Copier ce seul fichier
  suffit à transporter l'outil sur un autre poste.
- Seules des **préférences du poste** restent dans le navigateur, car les écrans
  n'ont pas tous la même taille : positions des widgets, apparence de l'accueil
  (fond, horloge…), prénom proposé dans la checklist, minuteurs qui sonnent sur ce
  poste.
- **Règle pour les évolutions** : une nouvelle donnée du cabinet va dans la base
  (un document : `DOCUMENTS_DEFAUT` dans `python/base.py`, `getDocument` /
  `setDocument` côté navigateur). Le test `tests/test_stockage.py` échoue si du
  code JavaScript écrit dans le navigateur ailleurs que pour ces préférences.

## Mises à jour

Sur un poste installé par `git clone`, le serveur vérifie toutes les 4 heures si
la branche `main` a changé sur GitHub (`python/mise_a_jour.py`). Si oui, un
bandeau propose « Mettre à jour » sur l'accueil : le serveur avance la copie
locale (`git merge --ff-only`, jamais d'écrasement), réinstalle les dépendances
si `requirements.txt` a changé, puis redémarre ; les pages se rechargent seules.
`donnees/` n'est jamais touché. Rien n'est proposé (raison dans Réglages >
Mises à jour) si le dossier n'est pas un clone git, s'il est sur une autre
branche ou si des fichiers de l'outil ont été modifiés sur le poste.

## Interface

L'accueil s'inspire de l'extension [Bonjourr](https://bonjourr.fr) : fond plein écran
qui change avec l'heure (aube, jour, crépuscule, nuit), grande horloge, salutation,
recherche et accès rapides en verre dépoli, widgets planning / tâches / ruptures,
alertes dans le coin haut gauche et citation du jour.

**Réglages ⚙️ > Apparence** (propre à chaque poste) : fond (selon l'heure, paysage,
animation du cabinet, image personnelle ou couleur unie), flou et luminosité du fond, horloge
numérique ou analogique, taille, secondes, salutation et nom, citation, widgets affichés.
`Échap` ferme la fenêtre ouverte.

**Météo** : avec le fond « selon l'heure » ou « paysage », le ciel suit aussi le temps
qu'il fait (soleil, nuages, brouillard, pluie, neige, orage, étoiles la nuit). Le paysage
est un petit décor dessiné (collines, cabinet avec sa dent en enseigne) : fenêtres
allumées le soir et par mauvais temps, toit enneigé, brume et la température
s'affiche à côté de la date. La commune du cabinet se choisit dans Réglages > Apparence
> Météo (la même pour tous les postes). C'est le **serveur** qui interroge
[MET Norway](https://api.met.no) (gratuit, usage professionnel autorisé, sans clé),
au plus une fois toutes les 10 minutes ; la recherche de commune utilise la
[Base Adresse Nationale](https://adresse.data.gouv.fr). Seule la position de la
commune quitte le réseau du cabinet. Sans internet, le fond suit simplement l'heure.

Widgets partagés entre tous les postes (enregistrés en base) :
- **Notes de l'équipe** : petits messages (`**gras**`, tirets en puces), épinglables,
  effaçables avec « Annuler » ;
- **Checklist du jour** : tâches d'ouverture et de fermeture, remises à zéro chaque
  jour, avec le prénom et l'heure de chaque coche (« Modifier la liste » pour l'adapter) ;
- **Minuteurs** (coin haut droit) : préréglages (bain à ultrasons, trempage…) ou durée
  libre (`10`, `2,5`, `1:30`, `1h20`). Visibles sur tous les postes ; la sonnerie
  retentit sur le poste qui a lancé le minuteur.

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
  meteo.py            météo du fond (MET Norway) et recherche de commune (BAN)
  migration.py        reprise de l'ancienne application
  leveldb_lecteur.py  lecture du stockage navigateur de l'ancienne appli
web/                  interface (HTML / CSS / JavaScript, sans framework)
  js/core/api.js      échanges avec le serveur + synchronisation entre postes
  js/ui/bonjourr.js   accueil : horloge, salutation, citation, fond, réglages d'apparence
  css/bonjourr.css    thème de l'interface (chargé après css/style.css)
  js/features/notes.js, checklist.js, minuteurs.js   widgets partagés de l'accueil
  vendor/             PDF.js (lecture des factures, hors ligne)
tests/                tests Python (pytest)
web/tests/            tests JavaScript (Jest)
installation/         modèles de l'installateur (Installer.bat, installer.ps1)
scripts/              tests, préparation du dossier d'installation
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
| GET / PUT | `/api/documents/<cle>` | planning, couleurs, tâches, dosimètres, rappels, notes, checklist, minuteurs… |
| GET / POST / DELETE | `/api/contacts` | carnet d'adresses |
| POST | `/api/export/stock`, `liste-courses`, `consommation`, `chirurgie` | exports Excel (base64) |
| GET / POST | `/api/base` | chemin de la base (changement : poste serveur seulement) |
| GET | `/api/info` | version et adresse réseau |
| GET | `/api/meteo` | météo actuelle de la commune du cabinet (cache 10 min) |
| GET | `/api/meteo/communes?q=` | recherche de commune (ou « lat, lon ») |

## Feuille de route

Voir [A_FAIRE.md](A_FAIRE.md).

## Tests

```bash
python scripts/run_tests.py      # tout
python -m pytest tests           # Python
cd web && npm install && npm test   # JavaScript (Node.js)
```

`run_tests.py` utilise le moteur Node intégré à VS Code si Node.js n'est pas installé.
