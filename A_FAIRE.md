# tooth_dentaire — Liste des besoins et fonctionnalités

## À faire
- [ ] Placard ménage
- [ ] Montant du stock : remonter les totaux tout en haut

## Mise en place
- [ ] Installer sur le PC serveur du cabinet (`pip install -r requirements.txt`, autoriser Python dans le pare-feu)
- [ ] Reprendre les données réelles du cabinet (`python serveur.py --importer "<ancien dossier>"`), puis vérifier les couleurs du planning (onglet 🎨)
- [ ] Copier régulièrement `donnees/sauvegardes/` hors du poste serveur (clé USB, NAS)

## Idées d'amélioration
- [ ] Écran de consultation de l'historique des prix (déjà enregistré en base)
- [ ] Mot de passe d'accès (si le réseau n'est pas réservé à l'équipe)

## Fait
- [x] Fenêtre « Ajouter un produit » au format paysage : 4 colonnes côte à côte, tient sans défilement en 1280×720, boutons toujours visibles
- [x] Entrée en stock d'un produit périmé **interdite** (fiche produit, entrée par lot, import de facture, et contrôle côté serveur) ; le stock déjà en place qui a périmé reste modifiable et les transferts restent possibles
- [x] Protection contre deux modifications simultanées de la même ligne de stock (version par ligne, écritures groupées tout ou rien)
- [x] Sauvegarde automatique quotidienne de la base (`donnees/sauvegardes/`, 30 copies gardées)
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
