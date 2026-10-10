/* Carnet d'adresses : les contacts sont en base, lus et écrits par
   l'API du serveur (/api/contacts). Aucun contact dans le code. */
let contacts = [];

async function appelApi(methode, route, corps) {
    const options = { method: methode, headers: {} };
    if (corps !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(corps);
    }
    let reponse;
    try {
        reponse = await fetch(route, options);
    } catch (e) {
        throw new Error("Serveur injoignable.");
    }
    const data = await reponse.json().catch(() => ({}));
    if (!reponse.ok || data.status === 'error') {
        throw new Error(data.message || ('Erreur ' + reponse.status));
    }
    return data;
}

async function rechargerContacts() {
    try {
        const data = await appelApi('GET', '/api/contacts');
        contacts = data.contacts || [];
        renderList();
    } catch (e) {
        const listEl = document.getElementById('contact-list');
        if (listEl) {
            const li = document.createElement('li');
            li.className = 'contact-item';
            li.textContent = e.message;
            listEl.replaceChildren(li);
        }
    }
}
window.rechargerContacts = rechargerContacts;

function filterContacts() {
    renderList();
}

function renderList() {
    const listEl = document.getElementById('contact-list');
    listEl.innerHTML = '';

    const searchInput = document.getElementById('search-input');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    contacts.filter(contact => {
        if (!searchTerm) return true;
        const searchString = `${contact.nom || ''} ${contact.prenom || ''} ${contact.entreprise || ''} ${contact.ville || ''} ${contact.email || ''} ${contact.tel_fixe || ''} ${contact.tel_portable || ''}`.toLowerCase();
        return searchString.includes(searchTerm);
    }).sort((a, b) => {
        let nameA = (a.nom || a.entreprise || '').trim();
        let nameB = (b.nom || b.entreprise || '').trim();
        return nameA.localeCompare(nameB);
    }).forEach(contact => {
        const li = document.createElement('li');
        li.className = 'contact-item fade-content';
        let displayName = (contact.nom || contact.prenom) ? `${contact.nom || ''} ${contact.prenom || ''}`.trim() : (contact.entreprise || 'Contact sans nom');
        const span = document.createElement('span');
        span.textContent = displayName;
        li.appendChild(span);
        li.appendChild(document.createTextNode(' \u270D'));
        li.onclick = () => showEditForm(contact.id);
        listEl.appendChild(li);
    });
}

function triggerPageFlip(callback) {
    const flipEl = document.getElementById('page-flip');
    flipEl.style.display = 'block';

    void flipEl.offsetWidth; 
    flipEl.classList.add('flipped');

    setTimeout(() => {
        callback(); 
        flipEl.style.display = 'none';
        flipEl.classList.remove('flipped');
    }, 250); 
}

function showAddForm() {
    triggerPageFlip(() => {
        const rightPage = document.getElementById('right-page-content');
        const template = document.getElementById('form-template');
        rightPage.innerHTML = template.innerHTML;

        document.getElementById('form-title').innerText = "Nouveau Contact";
        document.getElementById('contact-id').value = '';
        document.getElementById('btn-delete').style.display = 'none';
    });
}

function showEditForm(id) {
    const contact = contacts.find(c => c.id === id);
    if (!contact) return;

    triggerPageFlip(() => {
        const rightPage = document.getElementById('right-page-content');
        const template = document.getElementById('form-template');
        rightPage.innerHTML = template.innerHTML;

        document.getElementById('form-title').innerText = "Modifier Contact";
        document.getElementById('contact-id').value = contact.id;
        document.getElementById('contact-prenom').value = contact.prenom || '';
        document.getElementById('contact-nom').value = contact.nom || '';
        document.getElementById('contact-entreprise').value = contact.entreprise || '';
        document.getElementById('contact-email').value = contact.email || '';
        document.getElementById('contact-tel-fixe').value = contact.tel_fixe || '';
        document.getElementById('contact-tel-portable').value = contact.tel_portable || '';
        document.getElementById('contact-adresse').value = contact.adresse || '';
        document.getElementById('contact-cp').value = contact.code_postal || '';
        document.getElementById('contact-ville').value = contact.ville || '';
        document.getElementById('contact-note').value = contact.note || '';

        document.getElementById('btn-delete').style.display = 'block';
    });
}

async function saveContact() {
    const id = document.getElementById('contact-id').value;
    const newContact = {
        id: id ? parseInt(id, 10) : null,
        prenom: document.getElementById('contact-prenom').value.trim(),
        nom: document.getElementById('contact-nom').value.trim(),
        entreprise: document.getElementById('contact-entreprise').value.trim(),
        email: document.getElementById('contact-email').value.trim(),
        tel_fixe: document.getElementById('contact-tel-fixe').value.trim(),
        tel_portable: document.getElementById('contact-tel-portable').value.trim(),
        adresse: document.getElementById('contact-adresse').value.trim(),
        code_postal: document.getElementById('contact-cp').value.trim(),
        ville: document.getElementById('contact-ville').value.trim(),
        note: document.getElementById('contact-note').value.trim()
    };

    if (!newContact.nom && !newContact.prenom && !newContact.entreprise) {
        alert("Veuillez renseigner au moins un nom, prénom ou une entreprise.");
        return;
    }

    try {
        const data = await appelApi('POST', '/api/contacts', newContact);
        const enregistre = data.contact;
        const index = contacts.findIndex(c => c.id === enregistre.id);
        if (index !== -1) contacts[index] = enregistre;
        else contacts.push(enregistre);
    } catch (e) {
        alert("Enregistrement impossible : " + e.message);
        return;
    }

    renderList();
    resetRightPage();
}

async function deleteContact() {
    if(confirm("Voulez-vous vraiment supprimer ce contact ?")) {
        const id = parseInt(document.getElementById('contact-id').value, 10);
        try {
            await appelApi('DELETE', '/api/contacts?id=' + encodeURIComponent(id));
        } catch (e) {
            alert("Suppression impossible : " + e.message);
            return;
        }
        contacts = contacts.filter(c => c.id !== id);
        renderList();
        resetRightPage();
    }
}

function resetRightPage() {
    triggerPageFlip(() => {
        const rightPage = document.getElementById('right-page-content');
        rightPage.innerHTML = `
            <div class="empty-state fade-content">
                Sélectionnez un contact ou ajoutez-en un nouveau.
            </div>
        `;
    });
}

rechargerContacts();

/* Écouteurs (aucun gestionnaire en ligne dans la page : la politique de
   sécurité CSP interdit tout script en ligne). */
document.getElementById('search-input')?.addEventListener('input', filterContacts);
document.getElementById('btn-nouveau-contact')?.addEventListener('click', showAddForm);
document.addEventListener('click', e => {
    const bouton = e.target.closest('[data-action]');
    if (!bouton) return;
    const actions = { enregistrer: saveContact, supprimer: deleteContact, annuler: resetRightPage };
    const action = actions[bouton.dataset.action];
    if (action) action();
});
