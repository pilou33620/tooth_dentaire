Dernier commit audité : a90e97cd74affee022a69820a29362cfcde93af3

# Journal des audits (bugs et sécurité)

## 2026-11-03 — Audit complet (100 fichiers de code analysés)

| Gravité | Type | Fichier:ligne | Description | Statut |
|---|---|---|---|---|
| Basse | Bug | python/signalements.py:150 | Si l'écriture du fichier des signalements en attente échouait (disque plein, droits), le fil de renvoi automatique s'arrêtait pour de bon jusqu'au redémarrage. L'erreur est maintenant affichée et le fil continue. | Corrigé |
| Basse | Bug | python/mise_a_jour.py:163 | Même problème pour la recherche de mises à jour toutes les 4 heures : une erreur inattendue (ex. git sans droit d'exécution) arrêtait définitivement les vérifications. | Corrigé |
| Basse | Sécurité | web/vendor/pdf.min.js | PDF.js 3.11.174 est concerné par la faille CVE-2024-4367 (code exécuté via un PDF piégé). Elle est neutralisée ici par l'option `isEvalSupported: false` (js/parsers/pdf-parser.js:25). Passer à PDF.js 4.2.67 ou plus récent reste conseillé, mais demande de retester l'import de factures. | À valider par Pilou |
| Basse | Sécurité | web/package-lock.json | Dépendances de test seulement (Jest) signalées par `npm audit` : brace-expansion, minimatch, deepmerge (déni de service / pollution d'objet). Non livrées aux postes du cabinet, aucun risque en production. | À valider par Pilou |
| Basse | Bug | web/js/planning/tasks-planning.js:56, settings.js:278, web/js/features/dosimetres.js:94 | Une valeur non textuelle reçue de l'API (nombre au lieu de texte) ferait planter l'aperçu des tâches, l'aperçu d'export ou la recherche des dosimètres. L'interface n'écrit que du texte : risque très faible. | À valider par Pilou |

Points vérifiés sans problème : aucune faille XSS dans l'interface (toutes les données passent par escapeHtml ou textContent), requêtes SQL paramétrées, protection DNS rebinding (Host) et CSRF (Origin), chemins des fichiers statiques confinés à web/, changement de base et clé GitHub réservés au poste serveur, neutralisation des formules dans les exports Excel, JSON NaN/Infinity refusés, taille des requêtes limitée, mises à jour en avance rapide seulement (rien d'écrasé), aucun secret ni donnée du cabinet commités.
