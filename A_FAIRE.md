# tooth_dentaire — Liste des besoins et fonctionnalités

## À faire
- [ ] Placard ménage
- [ ] Montant du stock : remonter les totaux tout en haut
- [ ] ⚠️ Date de péremption déjà passée à l'ajout d'un produit : vérifier par rapport à la date du jour et **interdire** l'entrée en stock d'un produit périmé (aujourd'hui : simple avertissement)
- [ ] Fenêtre « Ajouter un produit » au format paysage (rectangle horizontal)

## Mise en place
- [ ] Installer sur le PC serveur du cabinet (`pip install -r requirements.txt`, autoriser Python dans le pare-feu)
- [ ] Reprendre les données réelles du cabinet (`python serveur.py --importer "<ancien dossier>"`), puis vérifier les couleurs du planning (onglet 🎨)
- [ ] Mettre en place une sauvegarde régulière de `donnees/stock.db`

## Idées d'amélioration
- [ ] Écran de consultation de l'historique des prix (déjà enregistré en base)
- [ ] Mot de passe d'accès (si le réseau n'est pas réservé à l'équipe)
- [ ] Protection contre deux modifications simultanées de la même ligne de stock

## Fait
- [x] Version web : serveur Python + interface dans le navigateur, accessible depuis tous les postes du cabinet
- [x] Toutes les données (personnel, planning, contacts, dosimètres, rappels) en base, aucune dans le code
- [x] Couleurs du planning réglables (onglet 🎨 Couleurs)
- [x] Mise à jour possible du planning binômes
- [x] Dosimètres : nombre, utilisateur, note et personne responsable
- [x] Fiche par cabinet avec radio + mire (alertes indépendantes par cabinet, date sur chaque icône, notification sur l'accueil avec le nom du cabinet)
- [x] Rappel maintenance des fauteuils avec date choisie et notification sur l'accueil
- [x] Notifications de péremption avec choix du délai
- [x] Quantité par n° de lot (entrée et sortie par lot, sortie FEFO par défaut)
- [x] Plusieurs références scannette (codes-barres) par produit
