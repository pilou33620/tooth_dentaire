#!/bin/sh
# Ancien point d'entrée : passe la main à demarrer_TOOTH_DENTAIRE.sh, avec les mêmes options.
exec sh "$(dirname "$0")/demarrer_TOOTH_DENTAIRE.sh" "$@"
