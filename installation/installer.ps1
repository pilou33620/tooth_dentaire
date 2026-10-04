# ==========================================
# Installation de tooth_dentaire sur un poste Windows
# ==========================================
# Lance par Installer.bat (double-clic). Etapes :
#   1. trouve Python 3.8+ deja installe, sinon installe celui place dans ce
#      dossier (python-3.x.x-amd64.exe, sans droits administrateur) ;
#   2. copie l'outil dans le dossier d'installation (donnees/ n'est jamais
#      touche : une reinstallation garde la base) ;
#   3. cree un environnement Python (.venv) et y installe openpyxl et certifi
#      depuis paquets/ (hors ligne), sinon depuis internet ;
#   4. copie l'installateur Python a cote de Lancer.bat et cree un raccourci
#      sur le Bureau ;
#   5. supprime ce dossier d'installation (sauf en cas d'erreur).
#
# Options (pour un usage sans fenetre) :
#   -Destination "D:\tooth_dentaire"   dossier d'installation
#   -Silencieux                        aucune question, aucune pause
#   -SansRaccourci                     pas de raccourci sur le Bureau
#   -GarderInstallation                ne pas supprimer ce dossier a la fin
#
# Messages sans accents : la console Windows PowerShell 5.1 lit ce fichier
# en ANSI.

param(
    [string]$Destination = "",
    [switch]$Silencieux,
    [switch]$SansRaccourci,
    [switch]$GarderInstallation
)

$ErrorActionPreference = "Stop"
$Ici = $PSScriptRoot
$DestinationDefaut = "C:\tooth_dentaire"
$VersionMin = [version]"3.8"
$NomOutil = "tooth_dentaire"

function Etape($texte) { Write-Host ""; Write-Host "== $texte" -ForegroundColor Cyan }
function Ok($texte) { Write-Host "   [OK] $texte" -ForegroundColor Green }
function Info($texte) { Write-Host "   $texte" }
function Attention($texte) { Write-Host "   [!] $texte" -ForegroundColor Yellow }

function Pause-Fin {
    if (-not $Silencieux) {
        Write-Host ""
        Read-Host "Appuyez sur Entree pour fermer" | Out-Null
    }
}

function Echec($texte) {
    Write-Host ""
    Write-Host "[X] $texte" -ForegroundColor Red
    Write-Host "    Le dossier d'installation est conserve : corrigez puis relancez Installer.bat."
    Pause-Fin
    exit 1
}

# --- Python ---------------------------------------------------------------

function Version-Python($exe) {
    # Version de l'interpreteur, ou $null (alias du Microsoft Store, exe absent...).
    if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return $null }
    try {
        $sortie = & $exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $sortie) { return $null }
        return [version]("$sortie".Trim())
    } catch { return $null }
}

function Candidats-Python {
    $liste = @()
    # Installations enregistrees (par utilisateur puis pour tous)
    foreach ($racine in @("HKCU:\Software\Python\PythonCore", "HKLM:\Software\Python\PythonCore",
                          "HKLM:\Software\WOW6432Node\Python\PythonCore")) {
        if (-not (Test-Path $racine)) { continue }
        Get-ChildItem $racine -ErrorAction SilentlyContinue | Sort-Object PSChildName -Descending | ForEach-Object {
            $cle = Join-Path $_.PSPath "InstallPath"
            if (Test-Path $cle) {
                $p = Get-ItemProperty $cle -ErrorAction SilentlyContinue
                if ($p.ExecutablePath) { $liste += $p.ExecutablePath }
                elseif ($p.'(default)') { $liste += (Join-Path $p.'(default)' "python.exe") }
            }
        }
    }
    # Python du PATH (hors alias du Microsoft Store, qui ouvre le Store)
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notlike "*\WindowsApps\*") { $liste += $cmd.Source }
    return $liste | Select-Object -Unique
}

function Trouver-Python {
    foreach ($exe in Candidats-Python) {
        $v = Version-Python $exe
        if ($v -and $v -ge $VersionMin) { return @{ Exe = $exe; Version = $v } }
    }
    return $null
}

# --- Debut ----------------------------------------------------------------

Write-Host "=============================================="
Write-Host "  Installation de $NomOutil"
Write-Host "=============================================="

if (-not (Test-Path -LiteralPath (Join-Path $Ici "outil\serveur.py"))) {
    Echec "Le dossier 'outil' est introuvable a cote de ce script. Utilisez le dossier complet produit par scripts\preparer_installation.py."
}
$InstallateurPython = Get-ChildItem -LiteralPath $Ici -Filter "python-3*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1

# Dossier d'installation
if (-not $Destination) {
    if ($Silencieux) { $Destination = $DestinationDefaut }
    else {
        Write-Host ""
        $reponse = Read-Host "Dossier d'installation [$DestinationDefaut] (Entree pour accepter)"
        $Destination = if ($reponse.Trim()) { $reponse.Trim().Trim('"') } else { $DestinationDefaut }
    }
}
$Destination = [System.IO.Path]::GetFullPath($Destination).TrimEnd("\")
$IciComplet = [System.IO.Path]::GetFullPath($Ici).TrimEnd("\")
if ($Destination -eq $IciComplet -or $Destination.StartsWith($IciComplet + "\", "OrdinalIgnoreCase") -or
    $IciComplet.StartsWith($Destination + "\", "OrdinalIgnoreCase")) {
    Echec "Le dossier d'installation ne doit pas etre dans le dossier de l'installateur (ni l'inverse) : il serait supprime a la fin."
}

# 1. Python
Etape "1/5 Python"
$python = Trouver-Python
if ($python) {
    Ok "Python $($python.Version) deja installe : $($python.Exe)"
} elseif ($InstallateurPython) {
    Info "Installation de $($InstallateurPython.Name) (quelques minutes, sans fenetre)..."
    $proc = Start-Process -FilePath $InstallateurPython.FullName -Wait -PassThru -ArgumentList @(
        "/quiet", "InstallAllUsers=0", "PrependPath=1", "Include_launcher=1",
        "Include_test=0", "Include_doc=0", "Shortcuts=1")
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
        Echec "L'installateur Python a echoue (code $($proc.ExitCode)). Essayez de le lancer a la main par un double-clic."
    }
    $python = Trouver-Python
    if (-not $python) { Echec "Python a ete installe mais reste introuvable. Redemarrez le poste puis relancez Installer.bat." }
    Ok "Python $($python.Version) installe : $($python.Exe)"
} else {
    Echec ("Python $VersionMin ou plus n'est pas installe sur ce poste et aucun installateur n'est present.`n" +
           "    Telechargez 'Windows installer (64-bit)' sur https://www.python.org/downloads/windows/`n" +
           "    et placez le fichier python-3.x.x-amd64.exe dans ce dossier : $Ici")
}

# 2. Fichiers de l'outil
Etape "2/5 Copie de l'outil dans $Destination"
$premiereInstallation = -not (Test-Path -LiteralPath (Join-Path $Destination "serveur.py"))
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
# Le code est remplace en entier (pas de vieux fichiers qui trainent) ; donnees/ et .venv/ restent.
foreach ($dossier in @("web", "python")) {
    $chemin = Join-Path $Destination $dossier
    if (Test-Path -LiteralPath $chemin) { Remove-Item -LiteralPath $chemin -Recurse -Force }
}
& robocopy.exe (Join-Path $Ici "outil") $Destination /E /XD donnees .venv /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Echec "La copie des fichiers a echoue (robocopy code $LASTEXITCODE)." }
Ok ($(if ($premiereInstallation) { "Outil copie" } else { "Outil mis a jour (donnees conservees)" }))

# Base existante a reprendre : stock.db pose dans le dossier d'installation
$baseFournie = Join-Path $Ici "stock.db"
$baseCible = Join-Path $Destination "donnees\stock.db"
if (Test-Path -LiteralPath $baseFournie) {
    if (Test-Path -LiteralPath $baseCible) {
        Attention "stock.db fourni ignore : $baseCible existe deja (rien n'a ete ecrase)."
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $baseCible) | Out-Null
        Copy-Item -LiteralPath $baseFournie -Destination $baseCible
        Ok "Base reprise : $baseCible"
    }
}

# 3. Environnement Python et bibliotheques
Etape "3/5 Bibliotheques Python (openpyxl, certifi)"
$venvPython = Join-Path $Destination ".venv\Scripts\python.exe"
if (-not (Version-Python $venvPython)) {
    $venv = Join-Path $Destination ".venv"
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force }
    & $python.Exe -m venv $venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython)) {
        Echec "Impossible de creer l'environnement Python dans $venv."
    }
}
$exigences = Join-Path $Destination "requirements.txt"
$paquets = Join-Path $Ici "paquets"
function Pip-Installer([string[]]$options) {
    # PowerShell 5.1 transforme la sortie d'erreur de pip en erreur bloquante
    # avec "Stop" : on repasse en "Continue" le temps de l'appel.
    $ErrorActionPreference = "Continue"
    & $venvPython -m pip install --disable-pip-version-check @options -r $exigences 2>&1 |
        ForEach-Object { Info "$_" }
    return ($LASTEXITCODE -eq 0)
}
$installe = $false
if (Test-Path -LiteralPath $paquets) {
    $installe = Pip-Installer @("--no-index", "--find-links", $paquets)
}
if (-not $installe) {
    Info "Installation depuis internet..."
    $installe = Pip-Installer @()
}
if ($installe) { Ok "Bibliotheques installees" }
else { Attention "Bibliotheques non installees : l'outil demarre, mais les exports Excel (et peut-etre la meteo) seront indisponibles." }

# 4. Installateur Python a cote du lanceur + raccourci
Etape "4/5 Lanceur"
if ($InstallateurPython) {
    Copy-Item -LiteralPath $InstallateurPython.FullName -Destination $Destination -Force
    Ok "$($InstallateurPython.Name) garde dans $Destination"
}
$lanceur = Join-Path $Destination "Lancer.bat"
if (-not $SansRaccourci) {
    $bureau = [Environment]::GetFolderPath("Desktop")
    $raccourci = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $bureau "$NomOutil.lnk"))
    $raccourci.TargetPath = $lanceur
    $raccourci.WorkingDirectory = $Destination
    $raccourci.IconLocation = (Join-Path $Destination "web\logo.ico")
    $raccourci.Description = "Gestion du stock du cabinet"
    $raccourci.Save()
    Ok "Raccourci '$NomOutil' cree sur le Bureau"
}
Ok "Pour lancer l'outil : $lanceur"

# 5. Nettoyage
Etape "5/5 Nettoyage"
if ($GarderInstallation) {
    Info "Dossier d'installation conserve (-GarderInstallation)."
} else {
    Info "Le dossier d'installation sera supprime a la fermeture de cette fenetre :"
    Info $IciComplet
}

Write-Host ""
Write-Host "Installation terminee." -ForegroundColor Green
Write-Host "Au premier lancement, Windows demande d'autoriser Python dans le pare-feu :"
Write-Host "accepter pour les reseaux prives (acces depuis les autres postes du cabinet)."
Pause-Fin

if (-not $GarderInstallation) {
    # Suppression differee : ce script et Installer.bat sont encore ouverts. Un
    # PowerShell cache attend leur fermeture puis efface le dossier.
    $cible = $IciComplet.Replace("'", "''")
    $commande = "for (`$i = 0; `$i -lt 30 -and (Test-Path -LiteralPath '$cible'); `$i++) { " +
                "Start-Sleep -Seconds 1; Remove-Item -LiteralPath '$cible' -Recurse -Force -ErrorAction SilentlyContinue }"
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -WorkingDirectory $env:TEMP `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $commande)
}
exit 0
