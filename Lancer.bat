@echo off
rem Lance tooth_dentaire : obtient lexecutable (binaires.cmd) puis le lance.
rem Les autres postes du cabinet ouvrent ladresse reseau affichee.
rem Loutil sort avec le code 75 quand il vient de se mettre a jour (git) : on reprend
rem lexecutable de la nouvelle version, puis on le relance avec les memes options.
rem Tout tient dans un seul bloc ( ... ) : une mise a jour peut remplacer ce fichier
rem pendant que loutil tourne sans que la console lise ensuite des lignes decalees.
cd /d "%~dp0"
set TOOTH_RELANCEUR=1
(
  for /l %%i in (1,0,2) do (
    call binaires.cmd || (pause & exit /b 1)
    bin\tooth.exe %*
    if errorlevel 76 (pause & exit /b 1)
    if errorlevel 75 (set TOOTH_DENTAIRE_REDEMARRAGE=1) else (
      if errorlevel 1 pause
      exit /b
    )
  )
)
