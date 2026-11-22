<# :
@echo off
rem ============================================================
rem  Installation de tooth_dentaire : double-cliquer sur ce fichier.
rem  Ce fichier est a la fois un .bat et un script PowerShell (la
rem  suite du fichier est lue par PowerShell).
rem ============================================================
set "INSTALLATEUR=%~f0"
cd /d "%TEMP%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([IO.File]::ReadAllText($env:INSTALLATEUR)))"
if errorlevel 1 pause
exit /b
#>

# ==========================================
# Installation de tooth_dentaire sur un poste Windows
# ==========================================
#   1. git : celui du poste, sinon MinGit (git portable officiel, empreinte
#      verifiee) dans <outil>\.mingit ;
#   2. l'outil est clone depuis GitHub (branche main) dans C:\tooth_dentaire :
#      c'est ce qui permet au serveur de proposer les mises a jour ensuite ;
#      donnees\ n'est jamais touche (reinstaller garde la base) ;
#   3. l'executable bin\tooth.exe (publication "binaires" du depot, empreinte
#      SHA-256 verifiee par binaires.cmd) : plus besoin de Python ;
#   4. lanceur "Lancer tooth_dentaire" dans ce dossier (et sur le Bureau),
#      puis ce fichier d'installation se supprime ;
#   5. pare-feu : lance en administrateur, regle entrante "Tooth Dentaire" pour
#      bin\tooth.exe (reseaux prives et domaine) ; sinon un message dit comment
#      relancer en administrateur, et ce fichier est garde pour cela.
# En cas d'erreur, rien n'est supprime : relancer apres correction.
#
# Variables d'environnement (usage avance, tests) :
#   TOOTH_DESTINATION   dossier d'installation (defaut C:\tooth_dentaire)
#   TOOTH_SILENCIEUX=1  aucune pause
#   TOOTH_SANS_BUREAU=1 pas de raccourci sur le Bureau
#   TOOTH_GARDER=1      ne pas supprimer l'installateur a la fin
#
# Messages sans accents : la console Windows PowerShell 5.1 les afficherait mal.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"     # sinon Invoke-WebRequest est tres lent
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor
    [Net.SecurityProtocolType]::Tls12

$NomOutil = "tooth_dentaire"
$Depot = "https://github.com/pilou33620/tooth_dentaire.git"
$Branche = "main"

$Installateur = $env:INSTALLATEUR
$Ici = Split-Path -Parent $Installateur
$Destination = if ($env:TOOTH_DESTINATION) { $env:TOOTH_DESTINATION } else { "C:\tooth_dentaire" }
$Destination = [System.IO.Path]::GetFullPath($Destination).TrimEnd("\")
$Silencieux = [bool]$env:TOOTH_SILENCIEUX
$Arm = ($env:PROCESSOR_ARCHITECTURE -eq "ARM64")

function Etape($texte) { Write-Host ""; Write-Host "== $texte" -ForegroundColor Cyan }
function Ok($texte) { Write-Host "   [OK] $texte" -ForegroundColor Green }
function Info($texte) { Write-Host "   $texte" }
function Attention($texte) { Write-Host "   [!] $texte" -ForegroundColor Yellow }

function Pause-Fin {
    if (-not $Silencieux) { Write-Host ""; Read-Host "Appuyez sur Entree pour fermer" | Out-Null }
}

function Echec($texte) {
    Write-Host ""
    Write-Host "[X] $texte" -ForegroundColor Red
    Write-Host "    Rien n'a ete supprime : corrigez puis relancez Installer.bat."
    Pause-Fin
    exit 1
}

function Telecharger($url, $fichier) {
    Info "Telechargement de $url"
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $fichier }
    catch { Echec "Telechargement impossible ($($_.Exception.Message)). Ce poste a-t-il acces a internet ?" }
}

# --- git ------------------------------------------------------------------

$GitPortable = Join-Path $Destination ".mingit\cmd\git.exe"

function Git([string[]]$arguments) {
    # PowerShell 5.1 + "Stop" : la sortie d'erreur de git deviendrait une erreur bloquante.
    $ErrorActionPreference = "Continue"
    & $GitExe -C $Destination @arguments 2>&1 | ForEach-Object { Info "$_" }
    if ($LASTEXITCODE -ne 0) { Echec "git $($arguments[0]) a echoue (code $LASTEXITCODE)." }
}

# --- Debut ----------------------------------------------------------------

Write-Host "=============================================="
Write-Host "  Installation de $NomOutil"
Write-Host "  dans $Destination"
Write-Host "=============================================="

# 1. git
Etape "1/5 git"
$gitPoste = Get-Command git.exe -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $GitPortable) {
    $GitExe = $GitPortable
    Ok "git portable deja present"
} elseif ($gitPoste) {
    $GitExe = $gitPoste.Source
    Ok "git deja installe : $GitExe"
} else {
    try {
        $version = Invoke-RestMethod -UseBasicParsing "https://api.github.com/repos/git-for-windows/git/releases/latest"
    } catch { Echec "Impossible de joindre GitHub ($($_.Exception.Message)). Ce poste a-t-il acces a internet ?" }
    $motif = if ($Arm) { '^MinGit-[\d.]+-arm64\.zip$' } else { '^MinGit-[\d.]+-64-bit\.zip$' }
    $archive = $version.assets | Where-Object { $_.name -match $motif } | Select-Object -First 1
    if (-not $archive) { Echec "MinGit introuvable dans la derniere version de Git for Windows." }
    $zip = Join-Path $env:TEMP $archive.name
    Telecharger $archive.browser_download_url $zip
    if ($archive.digest -like "sha256:*") {
        $attendu = $archive.digest.Substring(7)
        $obtenu = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
        if ($obtenu -ne $attendu) {
            Remove-Item -LiteralPath $zip -Force
            Echec "MinGit telecharge est corrompu (empreinte SHA-256 differente)."
        }
    }
    $dossierGit = Split-Path (Split-Path $GitPortable)
    New-Item -ItemType Directory -Force -Path $dossierGit | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $dossierGit -Force
    Remove-Item -LiteralPath $zip -Force
    $GitExe = $GitPortable
    Ok "git portable installe ($($archive.name))"
}

# 2. L'outil, depuis GitHub
Etape "2/5 Telechargement de l'outil depuis GitHub"
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $Destination ".git"))) {
    # init + checkout plutot que clone : fonctionne aussi dans un dossier deja
    # rempli (ancienne installation, donnees\ deja la).
    Git @("init", "--quiet")
    Git @("remote", "add", "origin", $Depot)
}
Git @("fetch", "--quiet", "origin", $Branche)
Git @("checkout", "--quiet", "--force", "-B", $Branche, "origin/$Branche")
Git @("branch", "--quiet", "--set-upstream-to=origin/$Branche", $Branche)
if (-not (Test-Path -LiteralPath (Join-Path $Destination "Lancer.bat"))) { Echec "Lancer.bat absent apres le telechargement." }
Ok "Outil a jour (branche $Branche) ; donnees\ conserve"

# 3. L'executable
Etape "3/5 Executable de l'outil"
& cmd.exe /c "cd /d `"$Destination`" && binaires.cmd"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $Destination "bin\tooth.exe"))) {
    Echec "Executable bin\tooth.exe non telecharge."
}
Ok "Executable pret : $(Join-Path $Destination "bin\tooth.exe")"


# 4. Lanceur
Etape "4/5 Lanceur"
function Raccourci($dossier) {
    $lien = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $dossier "Lancer $NomOutil.lnk"))
    $lien.TargetPath = Join-Path $Destination "Lancer.bat"
    $lien.WorkingDirectory = $Destination
    $lien.IconLocation = Join-Path $Destination "web\logo.ico"
    $lien.Description = "Gestion du stock du cabinet"
    $lien.Save()
    Ok "Lanceur cree : $(Join-Path $dossier "Lancer $NomOutil.lnk")"
}
Raccourci $Ici
$bureau = [Environment]::GetFolderPath("Desktop")
if (-not $env:TOOTH_SANS_BUREAU -and $bureau -and ($bureau.TrimEnd("\") -ne $Ici.TrimEnd("\"))) { Raccourci $bureau }

# 5. Pare-feu : sans regle, Windows demande d'autoriser tooth.exe au premier lancement
# reseau, et un compte sans droits d'administrateur ne peut pas accepter (les autres
# postes ne se connectent pas). Jamais de demande d'elevation : on le dit seulement.
Etape "5/5 Pare-feu Windows"
$NomRegle = "Tooth Dentaire"
$Exe = Join-Path $Destination "bin\tooth.exe"
$RegleOk = $false
$Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Admin) {
    $ErrorActionPreference = "Continue"     # netsh : un code de retour, pas d'exception
    $regle = (& netsh.exe advfirewall firewall show rule "name=$NomRegle" verbose 2>&1 | Out-String)
    if ($LASTEXITCODE -eq 0 -and $regle.Contains($Exe)) {
        Ok "Regle de pare-feu deja presente ($NomRegle)"
        $RegleOk = $true
    } else {
        # regle d'une autre installation (autre dossier) : remplacee, jamais en double
        if ($LASTEXITCODE -eq 0) { & netsh.exe advfirewall firewall delete rule "name=$NomRegle" 2>&1 | Out-Null }
        & netsh.exe advfirewall firewall add rule "name=$NomRegle" dir=in action=allow "program=$Exe" enable=yes profile=private,domain 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Ok "Regle de pare-feu creee : $NomRegle (reseaux prives et domaine)"
            $RegleOk = $true
        } else { Attention "Regle de pare-feu non creee (netsh code $LASTEXITCODE)." }
    }
    $ErrorActionPreference = "Stop"
} else {
    Attention "Sans droits d'administrateur, la regle de pare-feu n'a pas ete creee."
}
if (-not $RegleOk) {
    Info "Les autres postes risquent de ne pas pouvoir se connecter a ce poste."
    Info "Sur le poste qui fait tourner le serveur : clic droit sur Installer.bat,"
    Info "puis 'Executer en tant qu'administrateur' (base conservee). Ce fichier est garde pour cela."
}
$Garder = [bool]$env:TOOTH_GARDER -or -not $RegleOk

Write-Host ""
Write-Host "Installation terminee." -ForegroundColor Green
Write-Host "Le serveur verifie lui-meme les mises a jour sur GitHub et les propose sur l'accueil."
if (-not $Garder) { Write-Host "Ce fichier d'installation va se supprimer." }
Pause-Fin

if (-not $Garder) {
    # Seuls les fichiers d'installation sont effaces (jamais le dossier : il
    # garde le lanceur). Installer.bat est encore ouvert par la console : un
    # PowerShell cache attend qu'elle se ferme.
    $aEffacer = @($Installateur)
    $liste = ($aEffacer | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ","
    $commande = "foreach (`$i in 1..30) { `$reste = @($liste) | Where-Object { Test-Path -LiteralPath `$_ }; " +
                "if (-not `$reste) { break }; Start-Sleep -Seconds 1; " +
                "`$reste | ForEach-Object { Remove-Item -LiteralPath `$_ -Force -ErrorAction SilentlyContinue } }"
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -WorkingDirectory $env:TEMP `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $commande)
}
exit 0
