@echo off
rem Met l'executable de l'outil dans bin\ (appele par lancer.bat, depuis la racine).
rem Avec cargo sur le poste : compile ici, toujours a jour avec les sources.
rem Sinon : telecharge depuis GitHub (publication "binaires", compilee par la CI a chaque
rem envoi sur main), une fois par version : bin\commit dit de quelle version il vient.
setlocal
if not exist bin mkdir bin
where cargo >nul 2>nul
if not errorlevel 1 (
  cargo build --release -p tooth --bins || exit /b 1
  copy /y target\release\*.exe bin\ >nul 2>nul
  exit /b 0
)
set ICI=
for /f %%c in ('git rev-parse HEAD 2^>nul') do set ICI=%%c
set LA=
if exist bin\commit set /p LA=<bin\commit
if exist bin\tooth.exe if defined ICI if "%ICI%"=="%LA%" exit /b 0
echo   Telechargement de tooth (windows-x86_64)...
curl -fsSL -o bin\.archive.zip https://github.com/pilou33620/tooth_dentaire/releases/download/binaires/tooth-windows-x86_64.zip || goto echec
curl -fsSL -o bin\.empreinte https://github.com/pilou33620/tooth_dentaire/releases/download/binaires/tooth-windows-x86_64.zip.sha256 || goto echec
rem l'archive doit avoir l'empreinte SHA-256 publiee avec elle : tronquee ou alteree en route, elle est refusee
set ATTENDU=
set /p ATTENDU=<bin\.empreinte
set RECU=
for /f "skip=1 delims=" %%h in ('certutil -hashfile bin\.archive.zip SHA256') do if not defined RECU set RECU=%%h
set RECU=%RECU: =%
if /i not "%RECU%"=="%ATTENDU%" (
  echo   [!] Empreinte de l'archive incorrecte : archive refusee.
  goto echec
)
tar -xf bin\.archive.zip -C bin || goto echec
del bin\.archive.zip bin\.empreinte >nul 2>nul
exit /b 0
:echec
del bin\.archive.zip bin\.empreinte >nul 2>nul
if exist bin\tooth.exe (
  echo   [!] Telechargement impossible : on garde l'executable deja present.
  exit /b 0
)
echo [X] Telechargement de tooth impossible.
echo     Installer Rust (https://rustup.rs) puis relancer : il sera compile ici.
exit /b 1
