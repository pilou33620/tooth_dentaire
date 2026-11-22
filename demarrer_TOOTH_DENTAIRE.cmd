@echo off
rem Lancement de tooth_dentaire, a double-cliquer : garde la fenetre ouverte en cas d'erreur.
rem Les autres postes du cabinet ouvrent l'adresse reseau affichee.
rem L'outil sort avec le code 75 quand il vient de se mettre a jour : on reprend l'executable
rem de la nouvelle version, puis on le relance avec les memes options.
rem Tout tient dans un seul bloc ( ... ) : une mise a jour peut remplacer ce fichier pendant
rem que l'outil tourne sans que la console lise ensuite des lignes decalees.
cd /d "%~dp0"
rem Un seul fichier a cliquer : les lanceurs de l'autre systeme (.sh) sont masques.
attrib +h "%~dp0*.sh" >nul 2>nul
set TOOTH_DENTAIRE_RELANCEUR=1
(
  for /l %%i in (1,0,2) do (
    set TOOTH_DENTAIRE_SUITE=
    call scripts\binaires.cmd && bin\tooth.exe %*
    if errorlevel 75 if not errorlevel 76 set TOOTH_DENTAIRE_SUITE=1
    if defined TOOTH_DENTAIRE_SUITE (set TOOTH_DENTAIRE_DEJA_MAJ=1) else (
      if not errorlevel 1 if errorlevel 0 exit /b 0
      echo.
      echo [X] Le demarrage a echoue. La raison est ecrite au-dessus.
      echo.
      pause
      exit /b 1
    )
  )
)
