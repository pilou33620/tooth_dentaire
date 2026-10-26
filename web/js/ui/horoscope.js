"use strict";

/* ============================================================
   Horoscope du jour (pour le plaisir, sans service extérieur)

   Le texte suit la date : Soleil dans le signe (« c'est votre saison »,
   nouvelle lune), Lune dans le signe (pleine lune), élément du signe,
   jour de la semaine et saison de l'année. Positions et phases sont
   calculées (formules simplifiées, à quelques degrés près). Le tirage est le même
   toute la journée sur tous les postes.
   ============================================================ */

export const SIGNES = Object.freeze({
    belier: "♈ Bélier", taureau: "♉ Taureau", gemeaux: "♊ Gémeaux", cancer: "♋ Cancer",
    lion: "♌ Lion", vierge: "♍ Vierge", balance: "♎ Balance", scorpion: "♏ Scorpion",
    sagittaire: "♐ Sagittaire", capricorne: "♑ Capricorne", verseau: "♒ Verseau", poissons: "♓ Poissons"
});

/* Premier jour de chaque signe, en mois × 100 + jour */
const DEBUTS = Object.freeze({
    belier: 321, taureau: 420, gemeaux: 521, cancer: 621, lion: 723, vierge: 823,
    balance: 923, scorpion: 1023, sagittaire: 1122, capricorne: 1222, verseau: 120, poissons: 219
});

const ELEMENTS = Object.freeze({
    belier: "feu", lion: "feu", sagittaire: "feu",
    taureau: "terre", vierge: "terre", capricorne: "terre",
    gemeaux: "air", balance: "air", verseau: "air",
    cancer: "eau", scorpion: "eau", poissons: "eau"
});

export const HOROSCOPE = Object.freeze({
    // Pendant la période du signe
    votreSaison: [
        "C'est votre saison : les astres sont de votre côté, osez demander ce que vous voulez.",
        "Le Soleil traverse votre signe : votre énergie est au plus haut.",
        "Votre anniversaire astral approche : un bon moment pour faire le point.",
        "Le Soleil vous met en lumière : on remarque vos qualités sans que vous ayez à les montrer.",
        "Période faste : vous êtes dans votre élément, au sens propre.",
        "C'est votre mois : une belle occasion de commencer quelque chose de nouveau.",
        "Le Soleil dans votre signe vous donne de l'assurance : profitez-en pour avancer vos projets."
    ],
    lune: {
        // La Lune traverse le signe (deux à trois jours par mois)
        dansVotreSigne: [
            "La Lune traverse votre signe : vos émotions guident vos choix, et elles ont raison.",
            "Avec la Lune chez vous, votre sensibilité est un atout.",
            "La Lune dans votre signe vous rend attentif(ve) aux autres : on vous confie des choses.",
            "Lune dans votre signe : une journée où vous vous sentez pleinement vous-même.",
            "La Lune vous rend visite : votre intuition est infaillible aujourd'hui.",
            "La Lune dans votre signe vous rend magnétique : on recherche votre compagnie.",
            "Avec la Lune chez vous, prenez soin de votre humeur : elle donne le ton à la journée."
        ],
        // Pleine lune dans le signe
        pleine: [
            "Pleine lune : les émotions sont à fleur de peau, gardez votre calme.",
            "La pleine lune éclaire une situation restée floue.",
            "Sous la pleine lune, la fatigue se fait sentir : ménagez-vous.",
            "Pleine lune : c'est le moment de terminer ce qui traîne.",
            "La pleine lune rend tout le monde un peu nerveux : votre sourire fera la différence."
        ],
        // Nouvelle lune dans le signe (donc pendant sa saison)
        nouvelle: [
            "Nouvelle lune : un cycle commence, c'est le bon moment pour les bonnes résolutions.",
            "La nouvelle lune favorise les nouveaux départs.",
            "Nouvelle lune : plantez une graine, elle poussera dans les semaines à venir.",
            "Sous la nouvelle lune, votre intuition est particulièrement juste.",
            "Nouvelle lune : faites le vide pour laisser la place à du neuf."
        ]
    },
    // Le reste du temps, selon l'élément du signe
    elements: {
        feu: [
            "Votre énergie déborde aujourd'hui : canalisez-la dans un projet qui vous tient à cœur.",
            "Mars vous donne de l'élan : vous avancez plus vite que d'habitude.",
            "Votre enthousiasme est communicatif, l'équipe vous suit.",
            "Un brin d'impatience pourrait vous jouer des tours : respirez avant de répondre.",
            "Vous avez envie d'action : une journée idéale pour régler les dossiers en retard.",
            "Votre franchise est appréciée, à condition d'y mettre les formes.",
            "Un défi se présente : vous êtes taillé(e) pour le relever.",
            "Votre bonne humeur réchauffe l'ambiance, même les jours gris.",
            "Le Soleil soutient vos initiatives : lancez-vous.",
            "Vous brillez naturellement aujourd'hui : laissez aussi les autres briller."
        ],
        terre: [
            "Votre sens pratique fait des merveilles : tout ce que vous touchez s'organise.",
            "Saturne vous rend méthodique : c'est le jour des listes et des vérifications.",
            "Journée stable et sereine : vous avancez pas à pas, sûrement.",
            "Votre patience sera récompensée, peut-être plus tôt que prévu.",
            "Vénus vous invite à prendre soin de vous : un petit plaisir est mérité.",
            "Vous êtes le pilier sur lequel l'équipe s'appuie.",
            "Un détail que vous seul(e) avez remarqué évitera un souci.",
            "Le concret vous réussit : moins de discussions, plus de résultats.",
            "Votre fiabilité est remarquée, même si personne ne le dit.",
            "Une journée pour consolider plutôt que pour tout changer."
        ],
        air: [
            "Mercure stimule votre esprit : les idées fusent.",
            "Une conversation inattendue vous ouvre de nouvelles pistes.",
            "Votre diplomatie apaise une petite tension dans l'équipe.",
            "Vous avez mille idées : notez-les avant qu'elles ne s'envolent.",
            "Votre curiosité vous mène vers une bonne surprise.",
            "Les échanges sont fluides aujourd'hui : profitez-en pour clarifier un malentendu.",
            "Un message ou un appel vous apporte une bonne nouvelle.",
            "Votre légèreté fait du bien autour de vous.",
            "Vous voyez les choses sous un angle nouveau, et c'est le bon.",
            "Mercure vous rend persuasif(ve) : défendez vos idées."
        ],
        eau: [
            "Votre intuition est particulièrement juste aujourd'hui : écoutez-la.",
            "La Lune vous rend sensible à l'ambiance : protégez-vous des humeurs des autres.",
            "Votre empathie rassure un patient inquiet.",
            "Vous comprenez sans qu'on ait besoin de vous expliquer : un vrai atout.",
            "Une émotion longtemps gardée trouve enfin les bons mots.",
            "Votre douceur désamorce une situation délicate.",
            "Neptune nourrit votre imagination : laissez parler votre créativité.",
            "Vous avez besoin de calme : accordez-vous un moment rien qu'à vous.",
            "Votre écoute fait la différence pour quelqu'un aujourd'hui.",
            "Vous sentez venir les choses avant les autres : fiez-vous à votre flair."
        ]
    },
    // Travail : listes propres à certains jours (0 = dimanche), sinon liste générale
    jours: {
        1: [
            "Ce lundi démarre doucement : prenez le temps de bien organiser la semaine.",
            "Lundi : faites le tour du stock, la semaine n'en sera que plus simple.",
            "Début de semaine productif : les rendez-vous s'enchaînent sans retard.",
            "Lundi chargé, mais vous avez les ressources pour tout gérer.",
            "Ce lundi, un planning bien préparé vous fera gagner un temps précieux."
        ],
        3: [
            "Milieu de semaine : un bon moment pour faire le point sur les commandes.",
            "Ce mercredi, une tâche reportée trouve enfin sa place.",
            "Mercredi apporte un peu d'air : profitez-en pour avancer sur ce qui traîne.",
            "Mi-semaine : votre organisation porte ses fruits.",
            "Ce mercredi, un échange avec un collègue débloque une situation."
        ],
        5: [
            "Vendredi : finissez la semaine en beauté, le week-end est mérité.",
            "Ce vendredi, rangez votre poste : lundi vous dira merci.",
            "Fin de semaine : vérifiez les péremptions avant de partir.",
            "Vendredi léger et souriant : l'équipe est de bonne humeur.",
            "Ce vendredi, un dernier effort et la semaine sera bouclée."
        ],
        6: [
            "Samedi : une demi-journée efficace et sereine vous attend.",
            "Ce samedi, les patients sont détendus : profitez-en.",
            "Samedi : pensez à vous après le travail, vous l'avez bien mérité.",
            "Ce samedi, prenez le temps de souffler entre deux rendez-vous.",
            "Samedi matin : une ambiance calme pour terminer la semaine."
        ],
        0: [
            "Dimanche : repos bien mérité, les astres vous conseillent de ne rien prévoir.",
            "Ce dimanche est fait pour recharger les batteries.",
            "Dimanche : profitez de vos proches, la semaine attendra.",
            "Journée idéale pour une promenade et un bon repas.",
            "Ce dimanche, déconnectez : votre énergie de la semaine en dépend."
        ]
    },
    travail: [
        "Au travail, l'esprit d'équipe paiera.",
        "Un dossier en attente se débloque enfin.",
        "On appréciera votre efficacité discrète.",
        "Prenez le temps de bien faire : la qualité sera remarquée.",
        "Une idée simple réglera un vieux problème.",
        "Votre calme rassurera les patients les plus anxieux.",
        "Rangez un placard : vous y trouverez ce qui manquait.",
        "Les tâches s'enchaînent sans accroc.",
        "Un collègue aura besoin de votre aide, et vous le rendra.",
        "Vérifiez deux fois les commandes, cela évitera une rupture.",
        "Un patient vous remerciera chaleureusement pour votre gentillesse.",
        "La stérilisation tourne comme une horloge aujourd'hui.",
        "Un retard dans le planning se rattrape mieux que prévu.",
        "Votre précision est votre meilleure arme ce jour.",
        "Une livraison attendue arrive au bon moment.",
        "Un petit changement dans votre façon de faire vous simplifie la journée.",
        "Les rendez-vous s'enchaînent dans la bonne humeur.",
        "Votre sens de l'anticipation évite une rupture de stock.",
        "Un compliment sincère vous fera du bien.",
        "La communication avec le praticien est particulièrement fluide.",
        "On compte sur vous et vous ne décevez pas.",
        "Une journée chargée mais gratifiante.",
        "Prenez un instant pour vérifier le matériel : rien ne vous échappera.",
        "Votre bonne organisation fait gagner du temps à toute l'équipe."
    ],
    // Conseil : selon la saison de l'année, ou général
    saisons: {
        printemps: [
            "Conseil du jour : ouvrez les fenêtres, le printemps vous donne des ailes.",
            "Conseil du jour : profitez des jours qui rallongent pour marcher un peu.",
            "Conseil du jour : un grand rangement de printemps vous libérera l'esprit.",
            "Conseil du jour : les allergies guettent, gardez des mouchoirs à portée de main.",
            "Conseil du jour : semez une idée nouvelle, elle fleurira bientôt.",
            "Conseil du jour : savourez les premiers rayons de soleil à la pause."
        ],
        ete: [
            "Conseil du jour : hydratez-vous, la chaleur fatigue plus qu'on ne croit.",
            "Conseil du jour : profitez de la lumière du soir pour vous détendre.",
            "Conseil du jour : pensez à vos vacances, elles approchent.",
            "Conseil du jour : un fruit frais à la pause et tout ira mieux.",
            "Conseil du jour : protégez-vous du soleil, même entre midi et deux.",
            "Conseil du jour : ralentissez un peu, l'été est fait pour ça."
        ],
        automne: [
            "Conseil du jour : un thé chaud à la pause vous fera le plus grand bien.",
            "Conseil du jour : couvrez-vous, les matins sont frais.",
            "Conseil du jour : la lumière baisse, profitez du soleil dès qu'il pointe.",
            "Conseil du jour : préparez-vous un cocon douillet pour ce soir.",
            "Conseil du jour : faites le plein de vitamines avant l'hiver.",
            "Conseil du jour : une balade parmi les feuilles mortes vous ressourcera."
        ],
        hiver: [
            "Conseil du jour : couvrez-vous bien et pensez à la vitamine D.",
            "Conseil du jour : une soupe chaude ce soir, rien de tel pour se réconforter.",
            "Conseil du jour : les journées sont courtes, accordez-vous du repos.",
            "Conseil du jour : lavez-vous souvent les mains, les virus circulent.",
            "Conseil du jour : un plaid et un bon livre ce soir.",
            "Conseil du jour : sortez prendre la lumière à midi, même quelques minutes."
        ]
    },
    conseils: [
        "Conseil du jour : buvez de l'eau et souriez.",
        "Conseil du jour : une vraie pause à midi.",
        "Conseil du jour : dites merci, ça ne coûte rien.",
        "Conseil du jour : une chose à la fois.",
        "Conseil du jour : quelques pas dehors vous feront du bien.",
        "Conseil du jour : notez tout, votre mémoire vous remerciera.",
        "Conseil du jour : un brin d'humour désamorce tout.",
        "Conseil du jour : écoutez votre intuition.",
        "Conseil du jour : couchez-vous un peu plus tôt ce soir.",
        "Conseil du jour : appelez quelqu'un qui vous manque.",
        "Conseil du jour : n'oubliez pas de vous féliciter pour le travail accompli.",
        "Conseil du jour : redressez-vous, votre dos vous remerciera.",
        "Conseil du jour : prenez trois grandes respirations avant chaque tâche difficile.",
        "Conseil du jour : un compliment sincère illuminera la journée de quelqu'un."
    ]
});

/** Signe dans lequel se trouve le Soleil à cette date (dates usuelles des signes). */
export function signeDeLaDate(date) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    let signe = "capricorne", debut = 0;           // du 1er au 19 janvier : Capricorne
    for (const [s, d] of Object.entries(DEBUTS)) {
        if (d <= md && d > debut) { signe = s; debut = d; }
    }
    return signe;
}

/** "pleine", "nouvelle" ou null : à un jour et demi près de la phase exacte. */
export function phaseLune(date) {
    const LUNAISON = 29.530588853;                 // jours
    const NOUVELLE_LUNE = Date.UTC(2000, 0, 6, 18, 14);
    const midi = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    const age = ((((midi - NOUVELLE_LUNE) / 86400000) % LUNAISON) + LUNAISON) % LUNAISON;
    if (age < 1.5 || age > LUNAISON - 1.5) return "nouvelle";
    if (Math.abs(age - LUNAISON / 2) < 1.5) return "pleine";
    return null;
}

/** Signe dans lequel se trouve la Lune ce jour-là (longitude moyenne + équation du centre). */
export function signeDeLaLune(date) {
    const d = (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const anomalie = (134.963 + 13.064993 * d) * Math.PI / 180;
    const longitude = 218.316 + 13.176396 * d + 6.289 * Math.sin(anomalie);
    return Object.keys(SIGNES)[Math.floor((((longitude % 360) + 360) % 360) / 30)];
}

export function saisonDeLaDate(date) {
    const md = (date.getMonth() + 1) * 100 + date.getDate();
    if (md >= 320 && md < 621) return "printemps";
    if (md >= 621 && md < 923) return "ete";
    if (md >= 923 && md < 1221) return "automne";
    return "hiver";
}

/* Brassage d'un entier (tirage reproductible, sans motif visible d'un jour à l'autre) */
function melanger(n) {
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    return (n ^ (n >>> 16)) >>> 0;
}

/** Horoscope du jour d'un signe : le même toute la journée, différent d'un signe à l'autre. */
export function horoscopeDuJour(date, signe) {
    const jour = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
    const rang = Object.keys(SIGNES).indexOf(signe);
    const tirer = (liste, sel) => liste[melanger(jour * 1000 + rang * 10 + sel) % liste.length];

    const phase = phaseLune(date);
    let ouverture;
    if (signeDeLaDate(date) === signe) {
        ouverture = tirer(phase === "nouvelle" ? HOROSCOPE.lune.nouvelle : HOROSCOPE.votreSaison, 1);
    } else if (signeDeLaLune(date) === signe) {
        ouverture = tirer(phase === "pleine" ? HOROSCOPE.lune.pleine : HOROSCOPE.lune.dansVotreSigne, 1);
    } else {
        ouverture = tirer(HOROSCOPE.elements[ELEMENTS[signe]], 1);
    }
    const travail = tirer(HOROSCOPE.jours[date.getDay()] || HOROSCOPE.travail, 2);
    const conseil = tirer(HOROSCOPE.saisons[saisonDeLaDate(date)].concat(HOROSCOPE.conseils), 3);
    return [ouverture, travail, conseil].join(" ");
}
