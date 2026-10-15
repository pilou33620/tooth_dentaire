"use strict";

/* ============================================================
   Signaler un bug / proposer une idée (Réglages)

   Le serveur en fait un ticket GitHub (python/signalements.py). Sans
   internet ou sans clé GitHub, il le garde et le renvoie plus tard.
   La clé se saisit seulement sur le poste qui fait tourner le serveur.
   ============================================================ */

import { api } from '../core/api.js';

const $ = (id) => document.getElementById(id);

function afficherEtat(texte) {
    const zone = $("signalement-etat");
    if (zone) zone.textContent = texte;
}

function decrireEtat(etat) {
    if (!etat.cle_configuree) {
        return "Clé GitHub non saisie : les signalements sont gardés sur le serveur et partiront une fois la clé saisie sur le poste serveur.";
    }
    return etat.en_attente ? `${etat.en_attente} signalement(s) en attente d'envoi (pas d'internet ?).` : "";
}

async function rafraichir() {
    try {
        const etat = await api("GET", "/api/signalements");
        $("signalement-cle")?.classList.toggle("hidden", !etat.cle_modifiable);
        afficherEtat(decrireEtat(etat));
    } catch (e) {
        afficherEtat(e.message);
    }
}

function basculerFormulaire(ouvert) {
    $("signalement-form")?.classList.toggle("hidden", !ouvert);
    $("signalement-ouvrir")?.classList.toggle("hidden", ouvert);
    if (ouvert) $("signalement-description")?.focus();
}

async function envoyer(e) {
    e.preventDefault();
    const bouton = $("signalement-envoyer");
    bouton.disabled = true;
    try {
        const r = await api("POST", "/api/signalements", {
            type: $("signalement-type").value,
            description: $("signalement-description").value,
            auteur: $("signalement-auteur").value
        });
        $("signalement-description").value = "";
        basculerFormulaire(false);
        afficherEtat(r.envoye
            ? "✅ Merci ! Le signalement a bien été envoyé."
            : "✅ Merci ! Le signalement est enregistré ; il partira dès que possible.");
    } catch (err) {
        afficherEtat("❌ " + err.message);
    } finally {
        bouton.disabled = false;
    }
}

async function enregistrerCle() {
    const champ = $("signalement-cle-saisie");
    try {
        const etat = await api("POST", "/api/signalements/cle", { cle: champ.value });
        champ.value = "";
        afficherEtat(etat.cle_configuree
            ? "✅ Clé GitHub enregistrée. " + decrireEtat(etat)
            : decrireEtat(etat));
    } catch (err) {
        afficherEtat("❌ " + err.message);
    }
}

export function initSignalement() {
    if (!$("signalement-form")) return;
    $("signalement-ouvrir").addEventListener("click", () => basculerFormulaire(true));
    $("signalement-annuler").addEventListener("click", () => basculerFormulaire(false));
    $("signalement-form").addEventListener("submit", envoyer);
    $("signalement-cle-enregistrer").addEventListener("click", enregistrerCle);
    $("btn-settings")?.addEventListener("click", rafraichir);
    rafraichir();
}
