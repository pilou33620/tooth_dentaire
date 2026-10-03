# -*- coding: utf-8 -*-
"""
Lecteur LevelDB minimal (bibliotheque standard uniquement).

Sert a une seule chose : relire le localStorage de l'ancienne application
PySide6, que QtWebEngine (Chromium) range dans
webstorage/Local Storage/leveldb. On y trouve le planning, les taches, les
dosimetres, les rappels mire / fauteuils et le carnet d'adresses modifie.

Seule la lecture est geree : tables .ldb (blocs bruts ou compresses Snappy)
et journal .log. Pour chaque cle, la valeur de plus grand numero de sequence
l'emporte ; une suppression efface la cle.
"""

import os
import struct

TYPE_SUPPRESSION = 0
TYPE_VALEUR = 1


class ErreurLevelDB(Exception):
    """Fichier LevelDB illisible ou format inattendu."""


def _varint(data, pos):
    """Lit un entier varint ; renvoie (valeur, position suivante)."""
    resultat = 0
    decalage = 0
    while True:
        if pos >= len(data):
            raise ErreurLevelDB("varint tronque")
        octet = data[pos]
        pos += 1
        resultat |= (octet & 0x7F) << decalage
        if not octet & 0x80:
            return resultat, pos
        decalage += 7


def decompresser_snappy(data):
    """Decompression Snappy (format brut, sans cadre)."""
    taille, pos = _varint(data, 0)
    sortie = bytearray()
    while pos < len(data):
        tag = data[pos]
        pos += 1
        genre = tag & 3
        if genre == 0:                                   # litteral
            longueur = tag >> 2
            if longueur >= 60:
                nb = longueur - 59
                longueur = int.from_bytes(data[pos:pos + nb], "little")
                pos += nb
            longueur += 1
            sortie += data[pos:pos + longueur]
            pos += longueur
            continue
        if genre == 1:
            longueur = 4 + ((tag >> 2) & 7)
            distance = ((tag >> 5) << 8) | data[pos]
            pos += 1
        elif genre == 2:
            longueur = (tag >> 2) + 1
            distance = int.from_bytes(data[pos:pos + 2], "little")
            pos += 2
        else:
            longueur = (tag >> 2) + 1
            distance = int.from_bytes(data[pos:pos + 4], "little")
            pos += 4
        if distance <= 0 or distance > len(sortie):
            raise ErreurLevelDB("copie Snappy hors limites")
        debut = len(sortie) - distance
        for i in range(longueur):                        # recouvrement possible
            sortie.append(sortie[debut + i])
    if len(sortie) != taille:
        raise ErreurLevelDB("taille Snappy incoherente")
    return bytes(sortie)


def _lire_bloc(fichier, offset, taille):
    brut = fichier[offset:offset + taille]
    compression = fichier[offset + taille]
    if compression == 0:
        return brut
    if compression == 1:
        return decompresser_snappy(brut)
    raise ErreurLevelDB("compression de bloc non geree : %d" % compression)


def _entrees_bloc(bloc):
    """Itere (cle, valeur) sur un bloc de table (cles a prefixe partage)."""
    if len(bloc) < 4:
        return
    nb_restarts = struct.unpack("<I", bloc[-4:])[0]
    fin = len(bloc) - 4 - 4 * nb_restarts
    pos = 0
    cle = b""
    while pos < fin:
        partage, pos = _varint(bloc, pos)
        propre, pos = _varint(bloc, pos)
        taille_val, pos = _varint(bloc, pos)
        cle = cle[:partage] + bloc[pos:pos + propre]
        pos += propre
        valeur = bloc[pos:pos + taille_val]
        pos += taille_val
        yield cle, valeur


def lire_table(chemin):
    """Itere (cle_utilisateur, sequence, type, valeur) d'un fichier .ldb."""
    with open(chemin, "rb") as f:
        donnees = f.read()
    if len(donnees) < 48:
        raise ErreurLevelDB("table trop courte : %s" % chemin)
    pied = donnees[-48:]
    _meta_off, p = _varint(pied, 0)
    _meta_taille, p = _varint(pied, p)
    index_off, p = _varint(pied, p)
    index_taille, p = _varint(pied, p)
    index = _lire_bloc(donnees, index_off, index_taille)
    for _cle, poignee in _entrees_bloc(index):
        off, q = _varint(poignee, 0)
        taille, _q = _varint(poignee, q)
        for cle_interne, valeur in _entrees_bloc(_lire_bloc(donnees, off, taille)):
            if len(cle_interne) < 8:
                continue
            trailer = struct.unpack("<Q", cle_interne[-8:])[0]
            yield cle_interne[:-8], trailer >> 8, trailer & 0xFF, valeur


def _enregistrements_journal(donnees):
    """Reassemble les enregistrements logiques d'un journal .log."""
    BLOC = 32768
    pos = 0
    tampon = bytearray()
    while pos + 7 <= len(donnees):
        reste_bloc = BLOC - (pos % BLOC)
        if reste_bloc < 7:
            pos += reste_bloc
            continue
        longueur = struct.unpack("<H", donnees[pos + 4:pos + 6])[0]
        genre = donnees[pos + 6]
        charge = donnees[pos + 7:pos + 7 + longueur]
        pos += 7 + longueur
        if genre == 0 and longueur == 0:                 # remplissage
            continue
        if genre == 1:                                   # FULL
            yield bytes(charge)
            tampon = bytearray()
        elif genre == 2:                                 # FIRST
            tampon = bytearray(charge)
        elif genre == 3:                                 # MIDDLE
            tampon += charge
        elif genre == 4:                                 # LAST
            tampon += charge
            yield bytes(tampon)
            tampon = bytearray()


def lire_journal(chemin):
    """Itere (cle, sequence, type, valeur) des lots d'ecriture d'un .log."""
    with open(chemin, "rb") as f:
        donnees = f.read()
    for lot in _enregistrements_journal(donnees):
        if len(lot) < 12:
            continue
        sequence = struct.unpack("<Q", lot[:8])[0]
        nombre = struct.unpack("<I", lot[8:12])[0]
        pos = 12
        for i in range(nombre):
            if pos >= len(lot):
                break
            genre = lot[pos]
            pos += 1
            taille, pos = _varint(lot, pos)
            cle = lot[pos:pos + taille]
            pos += taille
            valeur = b""
            if genre == TYPE_VALEUR:
                taille, pos = _varint(lot, pos)
                valeur = lot[pos:pos + taille]
                pos += taille
            yield cle, sequence + i, genre, valeur


def lire_base(dossier):
    """Etat final {cle: valeur} d'une base LevelDB (tables puis journaux)."""
    meilleur = {}
    for nom in sorted(os.listdir(dossier)):
        chemin = os.path.join(dossier, nom)
        if nom.endswith(".ldb") or nom.endswith(".sst"):
            source = lire_table(chemin)
        elif nom.endswith(".log") and nom[:1].isdigit():
            source = lire_journal(chemin)
        else:
            continue
        for cle, sequence, genre, valeur in source:
            actuel = meilleur.get(cle)
            if actuel is None or sequence >= actuel[0]:
                meilleur[cle] = (sequence, genre, valeur)
    return {cle: v for cle, (_s, genre, v) in meilleur.items()
            if genre == TYPE_VALEUR}


def _texte_chromium(brut):
    """Decode une chaine Chromium : 1er octet 0 = UTF-16LE, 1 = Latin-1."""
    if not brut:
        return ""
    if brut[0] == 0:
        return brut[1:].decode("utf-16-le", errors="replace")
    if brut[0] == 1:
        return brut[1:].decode("latin-1")
    return brut.decode("utf-8", errors="replace")


def lire_local_storage(dossier, origine=None):
    """
    localStorage d'un profil Chromium : {origine: {cle: valeur}}.

    Les cles de donnees ont la forme « _<origine>\\x00<cle encodee> ».
    `origine` filtre sur une origine precise (ex. « app://local »).
    """
    resultat = {}
    for cle, valeur in lire_base(dossier).items():
        if not cle.startswith(b"_"):
            continue                                     # META:, VERSION...
        sep = cle.find(b"\x00")
        if sep < 0:
            continue
        orig = cle[1:sep].decode("utf-8", errors="replace")
        if origine is not None and orig != origine:
            continue
        resultat.setdefault(orig, {})[_texte_chromium(cle[sep + 1:])] = \
            _texte_chromium(valeur)
    return resultat
