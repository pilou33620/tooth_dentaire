@echo off
rem Lance le serveur de l'outil de gestion de stock et ouvre le navigateur.
rem Les autres postes du cabinet ouvrent l'adresse reseau affichee.
rem Utilise l'environnement .venv cree par l'installateur s'il existe.
rem Tout tient dans un seul bloc ( ... exit /b ) : une mise a jour peut
rem remplacer ce fichier pendant que le serveur tourne sans que la console
rem lise ensuite des lignes decalees.
cd /d "%~dp0"
set "PYTHON=python"
if exist ".venv\Scripts\python.exe" set "PYTHON=.venv\Scripts\python.exe"
(
  "%PYTHON%" serveur.py %*
  if errorlevel 1 pause
  exit /b
)
