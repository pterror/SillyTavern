import { newSessionKey } from './chat-engine.js';

/** @type {Map<string, Map<string, Map<string, number>>>} */
const live = new Map();
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * @param {string} root
 * @param {string} session
 * @param {string} [token]
 */
export function heldByOther(root, session, token) {
    const tokens = live.get(root)?.get(session);
    if (!tokens) return false;
    for (const t of tokens.keys()) if (t !== token) return true;
    return false;
}

/**
 * @param {string} root
 * @param {string} session
 * @param {string} token
 * @returns {() => void}
 */
export function hold(root, session, token) {
    let sessions = live.get(root);
    if (!sessions) live.set(root, sessions = new Map());
    let tokens = sessions.get(session);
    if (!tokens) sessions.set(session, tokens = new Map());
    tokens.set(token, (tokens.get(token) ?? 0) + 1);
    let held = true;
    return () => {
        if (!held) return;
        held = false;
        const n = (tokens.get(token) ?? 1) - 1;
        if (n > 0) tokens.set(token, n);
        else tokens.delete(token);
        if (tokens.size === 0 && sessions.get(session) === tokens) sessions.delete(session);
        if (sessions.size === 0 && live.get(root) === sessions) live.delete(root);
    };
}

/**
 * @param {object} p
 * @param {string} p.root
 * @param {string} p.user
 * @param {import('./chat-engine.js').ChatEngine} p.chats
 * @param {string | null} p.asked
 * @param {string} p.token
 * @returns {Promise<{ session: string, held: boolean, reused: boolean, release: () => void }>}
 */
export function claimTabSession({ root, user, chats, asked, token }) {
    return claimSerialized(root, async () => {
        if (asked !== null) {
            if (heldByOther(root, asked, token)) return { session: asked, held: true, reused: false, release: () => {} };
            return { session: asked, held: false, reused: false, release: hold(root, asked, token) };
        }
        const limit = 64;
        /** @type {bigint | null} */
        let newest = null;
        /** @type {bigint | undefined} */
        let before;
        for (;;) {
            const page = await chats.recentSessionKeys({ before, limit });
            for (const row of page) {
                if (row.session === null) continue;
                newest ??= row.id;
                if (!heldByOther(root, row.session)) return { session: row.session, held: false, reused: true, release: hold(root, row.session, token) };
            }
            if (page.length < limit) break;
            before = page[page.length - 1].position;
        }
        const session = newest === null ? newSessionKey() : await chats.sessionAt(newest, user);
        return { session, held: false, reused: false, release: hold(root, session, token) };
    });
}

/**
 * @template T
 * @param {string} root
 * @param {() => Promise<T>} claim
 * @returns {Promise<T>}
 */
export function claimSerialized(root, claim) {
    const run = (queues.get(root) ?? Promise.resolve()).then(claim, claim);
    const settled = run.catch(() => undefined);
    queues.set(root, settled);
    settled.then(() => {
        if (queues.get(root) === settled) queues.delete(root);
    });
    return run;
}
