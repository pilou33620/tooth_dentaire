#!/bin/sh
# Les deux archives de la publication « binaires » pour un système, faites à la racine du dépôt :
#   sh scripts/archives.sh DOSSIER_DES_EXECUTABLES NOM
#   (par exemple target/x86_64-pc-windows-msvc/release windows-x86_64)
# - tooth-NOM : l'exécutable seul et le commit dont il vient, que scripts/binaires.* prennent sur
#   un clone git sans cargo ;
# - tooth-prod-NOM : la production, sans git ni sources, dans un dossier de tête tooth_dentaire/ :
#   bin/, les pages (web/, sans leurs essais), les scripts de démarrage et le README. Ni base ni
#   réglages : donnees/ et *.local.json ne sont jamais dans l'archive.
# .zip sous Windows (7z), .tar.gz ailleurs ; chacune avec son empreinte SHA-256 (fichier .sha256).
# Appelé par binaires.yml (publication) et par le job « passage » de ci.yml (essais).
set -e
exes=$1
nom=$2
t=.archives  # chemins relatifs : 7z (Windows) ne lit pas les chemins à la Unix de bash
rm -rf "$t"
mkdir -p "$t/bin" "$t/prod/tooth_dentaire/scripts"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) windows=1 ;; *) windows= ;; esac
if [ -n "$windows" ]; then
  cp "$exes"/*.exe "$t/bin/"
else
  find "$exes" -maxdepth 1 -type f -perm -u+x -exec cp {} "$t/bin/" \;
fi
git rev-parse HEAD > "$t/bin/commit"

P=$t/prod/tooth_dentaire
cp -r "$t/bin" "$P/"
cp demarrer_TOOTH_DENTAIRE.sh demarrer_TOOTH_DENTAIRE.cmd README.md "$P/"
cp scripts/binaires.sh scripts/binaires.cmd "$P/scripts/"
# les pages suivies par git seulement (ni node_modules ni essais)
git archive HEAD -- web ':!web/tests' ':!web/package.json' ':!web/package-lock.json' | tar -xf - -C "$P"

if [ -n "$windows" ]; then
  (cd "$t/bin" && 7z a -bso0 "../../tooth-$nom.zip" .)
  (cd "$t/prod" && 7z a -bso0 "../../tooth-prod-$nom.zip" tooth_dentaire)
  archives="tooth-$nom.zip tooth-prod-$nom.zip"
else
  tar -czf "tooth-$nom.tar.gz" -C "$t/bin" .
  tar -czf "tooth-prod-$nom.tar.gz" -C "$t/prod" tooth_dentaire
  archives="tooth-$nom.tar.gz tooth-prod-$nom.tar.gz"
fi
for f in $archives; do
  (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d" " -f1 > "$f.sha256"
done
rm -rf "$t"
echo "Archives : $archives"
