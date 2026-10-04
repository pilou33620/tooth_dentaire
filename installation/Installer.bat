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
#   1. Python 3.8+ : celui du poste, sinon Python 3.14.8 telecharge sur
#      python.org (signature verifiee), installe sans droits administrateur ;
#   2. git : celui du poste, sinon MinGit (git portable officiel, empreinte
#      verifiee) dans <outil>\.mingit ;
#   3. l'outil est clone depuis GitHub (branche main) dans C:\tooth_dentaire :
#      c'est ce qui permet au serveur de proposer les mises a jour ensuite ;
#      donnees\ n'est jamais touche (reinstaller garde la base) ;
#   4. environnement .venv avec les bibliotheques de requirements.txt ;
#   5. lanceur "Lancer tooth_dentaire" dans ce dossier (et sur le Bureau),
#      puis ce fichier d'installation se supprime.
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
$VersionPython = "3.14.8"
$VersionMin = [version]"3.8"

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

# --- Python ---------------------------------------------------------------

function Version-Python($exe) {
    # Version de l'interpreteur, ou $null (exe absent, alias du Microsoft Store...).
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }
    try {
        $sortie = & $exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $sortie) { return $null }
        return [version]("$sortie".Trim())
    } catch { return $null }
}

function Trouver-Python {
    $candidats = @()
    foreach ($racine in @("HKCU:\Software\Python\PythonCore", "HKLM:\Software\Python\PythonCore",
                          "HKLM:\Software\WOW6432Node\Python\PythonCore")) {
        if (-not (Test-Path $racine)) { continue }
        Get-ChildItem $racine -ErrorAction SilentlyContinue | Sort-Object PSChildName -Descending | ForEach-Object {
            $cle = Join-Path $_.PSPath "InstallPath"
            if (Test-Path $cle) {
                $p = Get-ItemProperty $cle -ErrorAction SilentlyContinue
                if ($p.ExecutablePath) { $candidats += $p.ExecutablePath }
                elseif ($p.'(default)') { $candidats += (Join-Path $p.'(default)' "python.exe") }
            }
        }
    }
    # Python du PATH, hors alias du Microsoft Store (qui ouvre le Store)
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notlike "*\WindowsApps\*") { $candidats += $cmd.Source }
    foreach ($exe in ($candidats | Select-Object -Unique)) {
        $v = Version-Python $exe
        if ($v -and $v -ge $VersionMin) { return @{ Exe = $exe; Version = $v } }
    }
    return $null
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

# 1. Python
Etape "1/5 Python"
$python = Trouver-Python
$pythonTelecharge = $null
if ($python) {
    Ok "Python $($python.Version) deja installe : $($python.Exe)"
} else {
    $nom = "python-$VersionPython-$(if ($Arm) { 'arm64' } else { 'amd64' }).exe"
    $local = Get-ChildItem -LiteralPath $Ici -Filter "python-3*.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($local) {
        $exePython = $local.FullName
        Info "Installateur trouve a cote : $($local.Name)"
    } else {
        $exePython = Join-Path $env:TEMP $nom
        Telecharger "https://www.python.org/ftp/python/$VersionPython/$nom" $exePython
        $pythonTelecharge = $exePython
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $exePython
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike "*Python Software Foundation*") {
        Echec "L'installateur Python n'est pas signe par la Python Software Foundation : installation annulee."
    }
    Info "Installation de Python (quelques minutes, sans fenetre)..."
    $proc = Start-Process -FilePath $exePython -Wait -PassThru -ArgumentList @(
        "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_launcher=1",
        "Include_test=0", "Include_doc=0")
    if ($pythonTelecharge) { Remove-Item -LiteralPath $pythonTelecharge -Force -ErrorAction SilentlyContinue }
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        Echec "L'installation de Python a echoue (code $($proc.ExitCode))."
    }
    $python = Trouver-Python
    if (-not $python) { Echec "Python a ete installe mais reste introuvable. Redemarrez le poste puis relancez Installer.bat." }
    Ok "Python $($python.Version) installe : $($python.Exe)"
}

# 2. git
Etape "2/5 git"
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

# 3. L'outil, depuis GitHub
Etape "3/5 Telechargement de l'outil depuis GitHub"
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
if (-not (Test-Path -LiteralPath (Join-Path $Destination "serveur.py"))) { Echec "serveur.py absent apres le telechargement." }
Ok "Outil a jour (branche $Branche) ; donnees\ conserve"

# 4. Environnement Python et bibliotheques
Etape "4/5 Bibliotheques Python"
$venv = Join-Path $Destination ".venv"
$venvPython = Join-Path $venv "Scripts\python.exe"
if (-not (Version-Python $venvPython)) {
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force }
    & $python.Exe -m venv $venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
        Echec "Impossible de creer l'environnement Python dans $venv."
    }
}
& {
    $ErrorActionPreference = "Continue"
    & $venvPython -m pip install --disable-pip-version-check --quiet -r (Join-Path $Destination "requirements.txt") 2>&1 |
        ForEach-Object { Info "$_" }
}
if ($LASTEXITCODE -eq 0) { Ok "Bibliotheques installees" }
else { Attention "Bibliotheques non installees : l'outil demarre, mais les exports Excel (et peut-etre la meteo) seront indisponibles." }

# 5. Lanceur
Etape "5/5 Lanceur"
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

Write-Host ""
Write-Host "Installation terminee." -ForegroundColor Green
Write-Host "Le serveur verifie lui-meme les mises a jour sur GitHub et les propose sur l'accueil."
Write-Host "Au premier lancement, Windows demande d'autoriser Python dans le pare-feu :"
Write-Host "accepter pour les reseaux prives (acces depuis les autres postes du cabinet)."
if (-not $env:TOOTH_GARDER) { Write-Host "Ce fichier d'installation va se supprimer." }
Pause-Fin

if (-not $env:TOOTH_GARDER) {
    # Seuls les fichiers d'installation sont effaces (jamais le dossier : il
    # garde le lanceur). Installer.bat est encore ouvert par la console : un
    # PowerShell cache attend qu'elle se ferme.
    $aEffacer = @($Installateur) + @(Get-ChildItem -LiteralPath $Ici -Filter "python-3*.exe" -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.FullName })
    $liste = ($aEffacer | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ","
    $commande = "foreach (`$i in 1..30) { `$reste = @($liste) | Where-Object { Test-Path -LiteralPath `$_ }; " +
                "if (-not `$reste) { break }; Start-Sleep -Seconds 1; " +
                "`$reste | ForEach-Object { Remove-Item -LiteralPath `$_ -Force -ErrorAction SilentlyContinue } }"
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -WorkingDirectory $env:TEMP `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $commande)
}
exit 0
