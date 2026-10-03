@echo off
rem Lance le serveur de l'outil de gestion de stock et ouvre le navigateur.
rem Les autres postes du cabinet ouvrent l'adresse reseau affichee.
cd /d "%~dp0"
python serveur.py %*
if errorlevel 1 pause
