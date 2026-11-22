#!/bin/sh
# Lancement de tooth_dentaire (Linux, macOS, Raspberry Pi) : garde le terminal ouvert en cas d'erreur.
#   ./demarrer_TOOTH_DENTAIRE.sh [--port 8150] [--local] [--sans-navigateur] [--sans-maj] [--base FICHIER]
cd "$(dirname "$0")" || exit 1
# Un seul fichier à cliquer : les lanceurs Windows sont masqués du gestionnaire de fichiers.
ls *.cmd *.bat > .hidden 2>/dev/null
. ./scripts/binaires.sh
# L'outil sort avec le code 75 quand il vient de se mettre à jour : on reprend l'exécutable
# de la nouvelle version, puis on le relance avec les mêmes options.
export TOOTH_DENTAIRE_RELANCEUR=1
while :; do
  obtenir_binaires && bin/tooth "$@"
  code=$?
  [ "$code" -eq 75 ] || break
  export TOOTH_DENTAIRE_DEJA_MAJ=1
done
if [ "$code" -ne 0 ]; then
  echo
  echo "[X] Le démarrage a échoué. La raison est écrite au-dessus."
  echo
  printf "Appuyez sur Entrée pour fermer..."; read -r _
fi
exit "$code"
