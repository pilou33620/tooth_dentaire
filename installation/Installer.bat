@echo off
rem Installe tooth_dentaire sur ce poste (double-clic).
rem Placer l'installateur Python (python-3.x.x-amd64.exe) dans ce dossier si
rem Python n'est pas deja installe. Le dossier est supprime a la fin.
rem Le dossier courant passe dans %TEMP% pour ne pas bloquer cette suppression.
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer.ps1" %*
exit
