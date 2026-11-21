#!/bin/sh
# tooth_dentaire (Linux, macOS, Raspberry Pi) : obtient l'exécutable (binaires.sh) puis le lance.
#   ./lancer.sh [--port 8150] [--local] [--sans-navigateur] [--sans-pause] [--sans-maj] [--base FICHIER]
cd "$(dirname "$0")" || exit 1
. ./binaires.sh
# L'outil sort avec le code 75 quand il vient de se mettre à jour (git) : on reprend
# l'exécutable de la nouvelle version, puis on le relance avec les mêmes options.
export TOOTH_RELANCEUR=1
while :; do
  obtenir_binaires && bin/tooth "$@"
  code=$?
  [ "$code" -eq 75 ] || break
  # relance après une mise à jour : pas de nouvelle recherche, on attend que le port se libère
  export TOOTH_DENTAIRE_REDEMARRAGE=1
done
exit "$code"
