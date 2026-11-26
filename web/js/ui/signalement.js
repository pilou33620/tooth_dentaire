"use strict";

/* ============================================================
   Signaler un bug / proposer une idée (Réglages)

   Le serveur en fait un ticket GitHub (rust/tooth/src/signalements.rs). Sans
   internet, il le garde et le renvoie plus tard. Sans clé GitHub (saisie
   seulement sur le poste serveur), il rend le ticket préparé et ce poste
   ouvre Gmail avec le message prêt pour le développeur ; ce qui ne tient pas
   dans l'adresse Gmail est copié, à coller d'un Ctrl+V (une page ne peut pas
   écrire dans Gmail elle-même).
   Infos du poste et journal du navigateur (js/journal.js) sont joints.
   ============================================================ */

import { api } from '../core/api.js';

const $ = (id) => document.getElementById(id);

const DESTINATAIRE = "pilou33620@gmail.com";
// shortcut: Gmail refuse les adresses trop longues ; au-delà, message coupé et
// la suite copiée pour un Ctrl+V. Monter si Gmail l'accepte.
const URL_MAX = 7000;

// La clé se saisit sur le poste serveur ; tant qu'il n'y en a pas, le guide
// de création est affiché (au premier signalement notamment).
let etatCle = { cle_configuree: true, cle_modifiable: false };

function afficherEtat(texte) {
    const zone = $("signalement-etat");
    if (zone) zone.textContent = texte;
}

function decrireEtat(etat) {
    if (!etat.cle_configuree) return "";
    return etat.en_attente ? `${etat.en_attente} signalement(s) en attente d'envoi (pas d'internet ?).` : "";
}

async function rafraichir() {
    try {
        etatCle = await api("GET", "/api/signalements");
        afficherCle();
        afficherEtat(decrireEtat(etatCle));
    } catch (e) {
        afficherEtat(e.message);
    }
}

function afficherCle() {
    $("signalement-cle")?.classList.toggle("hidden", !etatCle.cle_modifiable);
    $("signalement-cle-guide")?.classList.toggle("hidden", etatCle.cle_configuree);
}

/** Ce qui aide à comprendre un bug : poste, widgets, réglages et erreurs récentes. */
export function journaux(doc = document) {
    const widgets = [...doc.querySelectorAll(".bj-widget")].map(el => {
        const r = el.getBoundingClientRect();
        const masque = el.classList.contains("bj-widget-masque") ? " masqué" : "";
        return `${el.dataset.widget} ${Math.round(r.width)}x${Math.round(r.height)}${masque}`;
    });
    const local = cle => { try { return localStorage.getItem(cle) || "-"; } catch (e) { return "?"; } };
    return [
        `Navigateur : ${navigator.userAgent}`,
        `Écran : ${screen.width}x${screen.height}, fenêtre ${innerWidth}x${innerHeight}, zoom ${devicePixelRatio}`,
        `Adresse : ${location.href}`,
        `Widgets : ${widgets.join(", ") || "aucun"}`,
        `Apparence : ${local("bj-apparence")}`,
        `Positions : ${local("ui-positions")}`,
        "",
        typeof window.lireJournal === "function" ? window.lireJournal() : "(journal indisponible)"
    ].join("\n");
}

export const SUITE_A_COLLER =
    "\n\n⚠️ SUITE DU RAPPORT : elle est déjà copiée. Cliquez à la fin de cette ligne puis appuyez sur Ctrl+V (⌘+V sur Mac) → ";
const SUITE_JOINTE = "\n\n[… suite dans le fichier joint]";

/** Adresse Gmail « nouveau message » remplie ; coupe = message raccourci pour tenir, reste = la partie retirée. */
export function lienGmail(ticket, max = URL_MAX, suite = SUITE_A_COLLER) {
    const debut = "https://mail.google.com/mail/?view=cm&fs=1" +
        `&to=${encodeURIComponent(DESTINATAIRE)}&su=${encodeURIComponent(ticket.title)}&body=`;
    let corps = ticket.body;
    let coupe = false;
    const tient = (t, marge) => debut.length + encodeURIComponent(t).length <= max - marge;
    const marge = tient(corps, 0) ? 0 : encodeURIComponent(suite).length;
    while (corps && !tient(corps, marge)) {
        // sans couper un emoji en deux : encodeURIComponent refuse une moitié seule
        corps = corps.slice(0, Math.floor(corps.length * 0.9)).replace(/[\uD800-\uDBFF]$/, "");
        coupe = true;
    }
    const reste = ticket.body.slice(corps.length);
    if (coupe) corps += suite;
    return { url: debut + encodeURIComponent(corps), coupe, reste };
}

/** Met le texte dans le presse-papiers ; false si le navigateur refuse. */
async function copier(texte, doc = document) {
    try {
        await navigator.clipboard.writeText(texte);
        return true;
    } catch (e) {
        // navigator.clipboard n'existe qu'en HTTPS ou sur le poste serveur : repli pour les autres postes
        const zone = doc.createElement("textarea");
        zone.value = texte;
        zone.style.position = "fixed";
        zone.style.opacity = "0";
        doc.body.appendChild(zone);
        zone.select();
        let ok = false;
        try { ok = doc.execCommand("copy"); } catch (err) { ok = false; }
        zone.remove();
        return ok;
    }
}

function telecharger(nom, texte) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([texte], { type: "text/plain;charset=utf-8" }));
    a.download = nom;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function envoyerParGmail(ticket) {
    let { url, coupe, reste } = lienGmail(ticket);
    const copie = coupe && await copier(reste);
    const nom = `signalement-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-")}.txt`;
    if (coupe && !copie) {
        // presse-papiers refusé : repli sur le fichier à joindre
        url = lienGmail(ticket, URL_MAX, SUITE_JOINTE).url;
        telecharger(nom, `${ticket.title}\n\n${ticket.body}`);
    }
    // Lien gardé à l'écran : un bloqueur de fenêtres peut empêcher l'ouverture automatique
    const lien = $("signalement-gmail");
    if (lien) {
        lien.href = url;
        lien.classList.remove("hidden");
    }
    window.open(url, "_blank", "noopener");
    afficherEtat(!coupe
        ? "📧 Gmail s'ouvre avec le message prêt : il ne reste qu'à cliquer « Envoyer »."
        : copie
            ? "📧 Gmail s'ouvre. Le rapport est trop long : la fin est déjà copiée. Dans Gmail, cliquez à la fin du message, faites Ctrl+V (⌘+V sur Mac), puis « Envoyer »."
            : `📧 Gmail s'ouvre avec le message prêt : joindre le fichier téléchargé (${nom}) puis cliquer « Envoyer ».`);
}

function basculerFormulaire(ouvert) {
    $("signalement-form")?.classList.toggle("hidden", !ouvert);
    $("signalement-ouvrir")?.classList.toggle("hidden", ouvert);
    if (ouvert) {
        $("signalement-gmail")?.classList.add("hidden");
        $("signalement-description")?.focus();
    }
}

async function envoyer(e) {
    e.preventDefault();
    const bouton = $("signalement-envoyer");
    bouton.disabled = true;
    try {
        const r = await api("POST", "/api/signalements", {
            type: $("signalement-type").value,
            description: $("signalement-description").value,
            auteur: $("signalement-auteur").value,
            journaux: journaux()
        });
        $("signalement-description").value = "";
        basculerFormulaire(false);
        if (r.ticket) return envoyerParGmail(r.ticket);
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
        etatCle = etat;
        afficherCle();
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
