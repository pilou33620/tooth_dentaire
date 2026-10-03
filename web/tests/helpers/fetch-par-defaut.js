/**
 * fetch() de repli pour les tests qui n'installent pas de serveur factice :
 * les écritures envoyées au serveur réussissent sans rien faire.
 * (Voir serveur-factice.js pour les tests qui vérifient les requêtes.)
 */
globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: "ok", revision: "test-0" })
});
