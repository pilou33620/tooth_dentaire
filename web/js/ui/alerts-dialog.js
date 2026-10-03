"use strict";

/* ============================================================
   Alerts Dialog - Affichage des alertes
   ============================================================ */

export function showAlertsDialog(title, alerts) {
    document.getElementById("alerts-title").textContent = title;
    const tbody = document.getElementById("alerts-tbody");
    tbody.innerHTML = "";

    let numAlert = 0;
    for (const alert of alerts) {
        numAlert++;
        const tr = document.createElement("tr");

        const tdNum = document.createElement("td");
        tdNum.className = "rownum";
        tdNum.textContent = numAlert;
        tr.appendChild(tdNum);

        const cells = [alert.user, alert.data.reference, alert.data.nom || "", alert.reason];
        cells.forEach((c, i) => {
            const td = document.createElement("td");
            td.textContent = c;
            if (i === 2) { td.className = "td-nom"; td.title = c; }
            tr.appendChild(td);
        });

        const tdQte = document.createElement("td");
        let qteTextAlert = String(alert.data.quantite);
        tdQte.textContent = qteTextAlert;
        tdQte.className = "center";
        tr.appendChild(tdQte);

        const tdAction = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "btn btn-blue btn-small";
        btn.textContent = "Aller";
        btn.addEventListener("click", () => {
            document.getElementById("alerts-overlay").classList.add("hidden");
            if (typeof window.openPlacard === "function") {
                window.openPlacard(alert.user, alert.data.reference);
            }
        });
        tdAction.appendChild(btn);
        tr.appendChild(tdAction);

        tbody.appendChild(tr);
    }

    document.getElementById("alerts-overlay").classList.remove("hidden");
}
