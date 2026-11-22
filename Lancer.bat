@echo off
rem Ancien point d'entree (raccourcis des postes) : passe la main a demarrer_TOOTH_DENTAIRE.cmd,
rem avec les memes options.
rem Tout tient dans un seul bloc ( ... ) : une mise a jour peut remplacer ce fichier pendant
rem que l'outil tourne sans que la console lise ensuite des lignes decalees.
(
  call "%~dp0demarrer_TOOTH_DENTAIRE.cmd" %*
  exit /b
)
