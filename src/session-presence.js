import { newSessionKey } from './chat-engine.js';

/**
 * Which sessions a tab has open now: a session is in use while a tab holds a live changes stream for it
 * (`/api/characters/changes/stream`). Per user (their data root), in this process's memory. A tab is named by its
 * token, which it keeps across reloads, so its own stream from before a reload isn't another tab's.
 */

/** @type {Map<string, Map<string, Map<string, number>>>} root → session → token → live streams */
const live = new Map();
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();

/**
 * Whether a tab other than `token`'s holds the session (`token` undefined: whether any tab does).
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
 * The tab's stream holds the session until the returned function is called.
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
 * The session a tab's stream holds: the one it asks for (`asked`) unless another tab holds that (`held`: the tab
 * forks it and asks again); with none asked, the user's most recent session no tab holds, else a new one at the
 * most recent one's place, else a new one with nothing stored. Two tabs asking at once never get the same one.
 * @param {object} p
 * @param {string} p.root The user's data root.
 * @param {string} p.user The user's handle.
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
 * Runs `claim` after every earlier claim of the user's has settled, so two tabs choosing a session never choose the
 * same one.
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
