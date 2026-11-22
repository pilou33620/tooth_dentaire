# tooth_dentaire

Gestion de stock et du quotidien d'un cabinet dentaire, en version web.

Outil de gestion du cabinet : stock et lots, import de factures PDF, alertes,
maintenance des équipements, rappels mire / fauteuils / dosimètres, planning des
binômes, tâches des assistantes, carnet d'adresses.

Un **serveur** (`bin/tooth`, écrit en Rust) tourne sur un poste du cabinet ; l'interface
s'ouvre dans le **navigateur**, sur ce poste comme sur tous les autres postes du
réseau (accueil, stérilisation, tablette…). Toutes les données sont dans une base
SQLite partagée : une modification faite sur un poste apparaît sur les autres en
quelques secondes.

## Installation

### Le plus simple : l'archive de production (sans git, sans rien installer)

Dans la [publication « binaires »](https://github.com/pilou33620/tooth_dentaire/releases/tag/binaires),
prendre **une seule archive**, celle du système :

| Système | Archive |
|---|---|
| Windows | `tooth-prod-windows-x86_64.zip` |
| Linux x86_64 | `tooth-prod-linux-x86_64.tar.gz` |
| Raspberry Pi (64 bits) | `tooth-prod-linux-aarch64.tar.gz` |
| macOS (Apple) | `tooth-prod-macos-aarch64.tar.gz` |

La décompresser où l'on veut (par exemple `C:\`) : elle donne un seul dossier `tooth_dentaire/`
(l'exécutable, les pages, les scripts de démarrage), puis double-cliquer sur
`demarrer_TOOTH_DENTAIRE.cmd` (Windows) ou lancer `./demarrer_TOOTH_DENTAIRE.sh`.

**Mises à jour sans git** : à chaque démarrage, l'outil compare l'empreinte de l'archive publiée
à celle de l'installation (`bin/prod.sha256`) ; si elle a changé, il télécharge l'archive (empreinte
SHA-256 vérifiée), la recopie par-dessus et redémarre. Au tout premier démarrage, il retélécharge
une fois la même archive (il n'en connaît pas encore l'empreinte). `donnees/` (la base, les
sauvegardes, la configuration) et les fichiers `*.local.json` ne sont jamais touchés : seuls les
fichiers de l'archive sont écrits.

### Pour développer, ou un poste installé par git

Prérequis : git. `demarrer_TOOTH_DENTAIRE` prend l'exécutable dans `bin/` : avec Rust (`cargo`)
sur le poste, il est compilé ici ; sinon il est téléchargé depuis la publication « binaires »
(compilée par la CI à chaque envoi sur `main`, empreinte SHA-256 vérifiée), une fois par version.

```
git clone https://github.com/pilou33620/tooth_dentaire.git
```

Sous Windows, [`installation/Installer.bat`](installation/Installer.bat) fait tout (voir
ci-dessous). À la racine, un seul fichier à cliquer par système : le premier lancement masque
celui de l'autre (`.sh` sous Windows ; `.cmd` et `.bat` sous Linux). Les autres scripts sont
dans `scripts/` (`binaires.sh`, `binaires.cmd`).

## Démarrage

```bash
./demarrer_TOOTH_DENTAIRE.sh       # Linux, macOS, Raspberry Pi
demarrer_TOOTH_DENTAIRE.cmd        :: Windows (double-clic)
```

Le navigateur s'ouvre et la console affiche l'adresse à utiliser depuis les autres postes, par
exemple `http://192.168.1.20:8150/`. Cette adresse est aussi visible dans **Réglages**. En cas
d'erreur, la fenêtre reste ouverte avec la raison. Après une mise à jour, l'outil sort avec le
code 75 et le script reprend l'exécutable de la nouvelle version, puis le relance.

| Option | Effet |
|---|---|
| `--port 9000` (ou `--port=9000`) | change le port (8150 par défaut ; port suivant libre sinon) |
| `--local` | n'accepte que ce poste (aucun accès réseau) |
| `--host ADRESSE` | écoute sur cette seule adresse du poste (`192.168.1.20`, ou une IPv6) : `127.0.0.1` vaut `--local`, `0.0.0.0` toutes les interfaces IPv4 ; une adresse absente du poste est refusée. Le poste serveur passe alors lui aussi par cette adresse (code d'appairage ; base et clé GitHub non modifiables) |
| `--base D:\stock.db` | utilise une autre base |
| `--importer "C:\...\ancien dossier"` (`--forcer`) | reprend les données de l'ancienne application |
| `--sans-navigateur` | n'ouvre pas le navigateur |
| `--sans-pause` | accepté (la pause sur erreur est faite par `demarrer_TOOTH_DENTAIRE`) |
| `--sans-maj` | pas de mise à jour au démarrage |

**Anciens points d'entrée** : `Lancer.bat` (et les raccourcis qui le visent), `lancer.sh` et
`serveur.py` (`python serveur.py …`, ancienne mise à jour automatique) restent, comme relais qui
passent la main à `demarrer_TOOTH_DENTAIRE` avec les mêmes options. `binaires.cmd` à la racine
sert la boucle de l'ancien `Lancer.bat`, encore en mémoire juste après la mise à jour qui l'a
remplacé ; l'exécutable lancé par cette ancienne boucle passe lui aussi la main à
`demarrer_TOOTH_DENTAIRE`.

### Installer sur un poste du cabinet (Windows, par git)

Un seul fichier à donner : [`installation/Installer.bat`](installation/Installer.bat).
Double-clic, sans question, il faut seulement internet (les droits d'administrateur ne
servent qu'au pare-feu, étape 5) :

1. git : celui du poste, sinon **MinGit** (git portable officiel, empreinte SHA-256
   vérifiée) dans `.mingit/` ;
2. **clone** de ce dépôt (branche `main`) dans `C:\tooth_dentaire` : c'est ce qui
   permet les mises à jour automatiques ; `donnees/` n'est jamais touché ;
3. l'exécutable `bin\tooth.exe` (publication « binaires », empreinte vérifiée) ;
4. raccourci « Lancer tooth_dentaire » vers `demarrer_TOOTH_DENTAIRE.cmd`, dans le dossier de
   l'installateur (et sur le Bureau), puis **l'installateur se supprime** : il ne reste que le
   lanceur ;
5. **pare-feu** : lancé en administrateur (clic droit sur `Installer.bat`, « Exécuter en
   tant qu'administrateur »), il crée la règle entrante « Tooth Dentaire » pour
   `bin\tooth.exe` (réseaux privés et domaine), sans doublon si elle existe déjà. Sans ces
   droits, il le dit, n'insiste pas, et **se garde** pour qu'on puisse le relancer en
   administrateur.

En cas d'erreur, rien n'est supprimé. Relancer `Installer.bat` sur un poste déjà
installé répare l'installation (code remis sur `main`, base conservée). Pour
reprendre une base existante : copier son `stock.db` dans `C:\tooth_dentaire\donnees\`.

**Pare-feu.** Seul le poste qui fait tourner le serveur en a besoin. Sans la règle,
Windows demande d'autoriser `tooth.exe` au premier lancement en réseau : accepter pour les
**réseaux privés**. Sur un compte sans droits d'administrateur, cette fenêtre ne peut pas
être acceptée et les autres postes ne se connectent pas : relancer `Installer.bat` en
administrateur (clic droit, « Exécuter en tant qu'administrateur » ; base conservée), ou
créer la règle dans une invite de commandes administrateur, depuis le dossier de l'outil
(`C:\tooth_dentaire`, ou celui où l'archive de production a été décompressée) :

```bat
netsh advfirewall firewall add rule name="Tooth Dentaire" dir=in action=allow program="%CD%\bin\tooth.exe" profile=private,domain
```

**Antivirus.** Si l'antivirus met `bin\tooth.exe` en quarantaine (exécutable récent, peu
connu de lui), l'outil ne démarre plus ou se retélécharge à chaque lancement. Restaurer le
fichier depuis la quarantaine, puis ajouter une **exclusion du dossier**
`C:\tooth_dentaire\bin` (Windows Defender : Sécurité Windows > Protection contre les virus
et menaces > Gérer les paramètres > Exclusions). L'exécutable vient de la publication
« binaires » du dépôt et son empreinte SHA-256 est vérifiée à chaque téléchargement.

### Utiliser depuis un autre poste (code d'appairage)

La première fois, un autre poste (ou une tablette) qui ouvre l'adresse réseau
arrive sur une page qui demande un **code à 6 chiffres** : il est affiché dans
la console du serveur (`Code d'appairage … : 123 456`, valable 10 minutes, usage
unique). Le bon code donne au navigateur un cookie valable un an ; le poste qui
fait tourner le serveur n'a jamais besoin de code. Le jeton est dans
`~/.web_tools/jeton-reseau.txt` (le supprimer oblige tous les postes à refaire le code).

Si la commande `openssl` existe sur le poste serveur (Git pour Windows, Linux),
le réseau passe en **HTTPS** : chaque poste installe une fois la CA du poste
(`/appairage/ca.pem`, adresse affichée dans la console). Sans `openssl`, ou avec
la variable `WEB_TOOLS_HTTP=1`, tout reste en HTTP et la console le dit.

Autres protections : un appareil d'Internet ou un nom d'hôte inconnu (DNS
rebinding) est refusé ; une écriture doit porter l'en-tête `X-Tooth: 1` (une page
d'un autre site ne peut pas l'ajouter) ; deux postes qui modifient le même
document (planning, notes, checklist…) ne s'écrasent plus : le second est prévenu
et l'écran est rechargé. Le changement de base et la clé GitHub ne se règlent
que depuis le poste qui fait tourner le serveur.

## Données et confidentialité

**Aucune donnée du cabinet n'est écrite dans le code.** Noms du personnel, planning,
couleurs du planning, tâches, dosimètres, contacts, rappels, stock : tout est dans
la base (`donnees/stock.db` par défaut), et le dossier `donnees/` est exclu de git
(voir `.gitignore`). Le dépôt peut donc être publié sans rien exposer.

- **Sauvegarde automatique** : une copie par jour (au démarrage du serveur, puis
  toutes les 24 h) dans `donnees/sauvegardes/stock-AAAAMMJJ-HHMMSS.db`. Sont
  gardées : la dernière copie de chacun des 30 derniers jours, plus les 5 copies
  les plus récentes (des clics répétés sur « Sauvegarder maintenant » n'effacent
  donc jamais les jours précédents). Réglages → Sauvegardes affiche la dernière
  copie et permet d'en faire une tout de suite. Pour une copie hors du poste, copier ce
  dossier (clé USB, NAS). **Restaurer** : arrêter le serveur, remplacer
  `donnees/stock.db` par la copie voulue renommée en `stock.db`, relancer.
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
  (un document : `CLES` et `defaut()` dans `rust/tooth/src/base.rs`, `getDocument` /
  `setDocument` côté navigateur). L'essai `donnees_du_cabinet_jamais_dans_le_navigateur`
  (`cargo test`) échoue si du
  code JavaScript écrit dans le navigateur ailleurs que pour ces préférences.

## Mises à jour

Copie de production (archive `tooth-prod`) : voir *Installation* ; elle se met à jour au
démarrage seulement, depuis la publication « binaires ».

Sur un poste installé par `Installer.bat` (ou `git clone`), **au démarrage**,
avant de lancer le serveur et l'interface, l'outil installe d'office la nouvelle
version de `main` s'il y en a une, puis se relance (sans internet, il démarre
normalement après 20 s au plus). Ensuite, le serveur vérifie toutes les 4 heures si
la branche `main` a changé sur GitHub (`rust/tooth/src/mise_a_jour.rs`). Si oui, un
bandeau propose « Mettre à jour » sur l'accueil : le serveur avance la copie
locale (`git merge --ff-only`, jamais d'écrasement), puis redémarre ; les pages se rechargent seules.
`donnees/` n'est jamais touché. Rien n'est proposé (raison dans Réglages >
Mises à jour) si le dossier n'est pas un clone git, s'il est sur une autre
branche ou si des fichiers de l'outil ont été modifiés sur le poste.

## Signaler un bug / proposer une idée

Réglages > « Signaler un bug ou proposer une idée » : le serveur en fait un
ticket (issue) GitHub du dépôt (`rust/tooth/src/signalements.rs`), étiqueté `bug` ou
`enhancement`, avec la version de l'outil. **Le dépôt est public** : le
formulaire rappelle de n'y mettre aucun nom de patient. Sans internet ou sans
clé, le signalement est gardé (`donnees/signalements_en_attente.json`) et
renvoyé toutes les 30 minutes.

Clé à saisir une fois, dans les Réglages **du poste qui fait tourner le serveur**
(elle est enregistrée dans `donnees/config.json` et jamais renvoyée aux postes) :
GitHub > Settings > Developer settings > Personal access tokens > Fine-grained
tokens > *Generate new token* ; *Repository access* : seulement `tooth_dentaire` ;
*Permissions* : **Issues : Read and write** (rien d'autre). Une clé expire (un an
au plus) : en saisir une nouvelle à ce moment-là.

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
./demarrer_TOOTH_DENTAIRE.sh --importer "C:\chemin\vers\ancienne-appli"
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
rust/tooth/src/
  serveur.rs          serveur HTTP + API JSON, options, lancement
  base.rs             base SQLite (schéma, lecture, écritures, documents, contacts)
  exports.rs          exports Excel
  meteo.rs            météo du fond (MET Norway) et recherche de commune (BAN)
  migration.rs        reprise de l'ancienne application
  leveldb.rs          lecture du stockage navigateur de l'ancienne appli
  sauvegarde.rs       sauvegarde automatique quotidienne de la base
  mise_a_jour.rs      mises à jour depuis GitHub
  signalements.rs     signalements de bug (tickets GitHub)
demarrer_TOOTH_DENTAIRE.sh, .cmd   lancement (et relance après une mise à jour)
Lancer.bat, lancer.sh, serveur.py, binaires.cmd   anciens points d'entrée : relais
scripts/binaires.sh, .cmd   exécutable compilé ici ou téléchargé (publication « binaires »)
scripts/archives.sh   archives de la publication (exécutable seul ; production)
web/                  interface (HTML / CSS / JavaScript, sans framework)
  js/core/api.js      échanges avec le serveur + synchronisation entre postes
  js/ui/bonjourr.js   accueil : horloge, salutation, citation, fond, réglages d'apparence
  css/bonjourr.css    thème de l'interface (chargé après css/style.css)
  js/features/notes.js, checklist.js, minuteurs.js   widgets partagés de l'accueil
  vendor/             PDF.js (lecture des factures, hors ligne)
web/tests/            tests JavaScript (Jest)
installation/         Installer.bat (installateur d'un poste, fichier unique)
scripts/essai_passage.py   essais de passage d'un poste et de la copie de production (CI)
donnees/              base et configuration — non versionné
```

### API

L'interface envoie chaque action (sortie de stock et ses transactions, transfert,
fiche produit…) en un seul lot `POST /api/lot`, exécuté dans une seule transaction
SQL. Chaque ligne de stock porte un numéro de `version` : si un autre poste l'a
modifiée depuis qu'elle a été lue, le lot entier est refusé (409), l'écran est
rechargé et l'utilisateur est invité à recommencer, au lieu d'écraser
silencieusement la modification de l'autre poste.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/etat` | toute la base + documents |
| GET | `/api/revision` | numéro de révision (surveillance entre postes) |
| POST | `/api/lot` | écritures d'une action de l'interface, tout ou rien (409 si conflit) |
| POST | `/api/produit`, `/api/stock` | création / mise à jour |
| DELETE | `/api/produit?reference=`, `/api/stock?reference=&utilisateur=` | suppression |
| POST | `/api/transaction`, `/api/maintenance`, `/api/historique-prix` | ajout |
| GET / PUT | `/api/documents/<cle>` | planning, couleurs, tâches, dosimètres, rappels, notes, checklist, minuteurs… |
| GET / POST / DELETE | `/api/contacts` | carnet d'adresses |
| POST | `/api/export/stock`, `liste-courses`, `consommation`, `chirurgie` | exports Excel (base64) |
| GET / POST | `/api/sauvegardes` | dernière sauvegarde / sauvegarder maintenant |
| GET / POST | `/api/base` | chemin de la base (changement : poste serveur seulement) |
| GET | `/api/info` | version et adresse réseau |
| GET | `/api/meteo` | météo actuelle de la commune du cabinet (cache 10 min) |
| GET | `/api/meteo/communes?q=` | recherche de commune (ou « lat, lon ») |

## Feuille de route

Voir [A_FAIRE.md](A_FAIRE.md).

## Tests

```bash
cargo test -p tooth                 # base, conflits, péremption, exports, météo, sauvegardes, mises à jour, serveur
cd web && npm install && npm test   # interface (Jest, Node.js)
```

La CI (`.github/workflows/ci.yml`) lance `cargo test --locked` sous Linux, Windows et macOS, et
`scripts/essai_passage.py` (job `passage`, sur les trois systèmes) : un poste sans cargo resté
sur l'ancien Python (`d3469e8`, `1b3fb88`) ou sur le Rust lancé par `lancer.sh` / `Lancer.bat`
(`7878af4`), démarré comme d'habitude (`Lancer.bat` sous Windows), se met à jour tout seul et
arrive sur l'exécutable du commit lancé par `demarrer_TOOTH_DENTAIRE`, sur la même base ;
l'arrêt arrête l'exécutable. Et la copie de production décompressée démarre, puis se met à jour
seule depuis une fausse publication locale. Le Raspberry Pi n'ayant pas
cargo, les vérifications se lisent dans la CI (`gh run list`).

Sauvegarde de passage : à sa première ouverture d'une base, le serveur Rust la copie dans
`stock.db.avant-rust-AAAAMMJJ-HHMMSS` (une seule fois, témoin `stock.db.avant-rust.fait`).
