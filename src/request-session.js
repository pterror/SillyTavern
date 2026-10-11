import { newSessionKey } from './chat-engine.js';

/**
 * A request's session (`X-ST-Session`, sent by the page with every request; see public/scripts/tab-session.js) as
 * the chat routes act through it, and what the answer tells the tab of it.
 */

export const SESSION_HEADER = 'X-ST-Session';
export const SESSION_MOVED_HEADER = 'X-ST-Session-Moved';
export const SESSION_GONE_HEADER = 'X-ST-Session-Gone';

/**
 * @param {{ get(name: string): string | undefined }} req
 * @returns {string | undefined} The header's value; undefined for a caller with no tab.
 */
export function sessionHeaderOf(req) {
    const value = req.get(SESSION_HEADER);
    return value === undefined || value === '' ? undefined : value;
}

export class RequestSession {
    /**
     * @param {string | undefined} header
     * @param {string} user The user's handle.
     * @param {{ session: string | null, identifier: string, gone?: true }} resolved
     */
    constructor(header, user, resolved) {
        this.header = header;
        this.user = user;
        this.resolved = resolved;
        /** @type {string | null} A session made for this request's writes. */
        this.made = null;
    }

    /** The UUID of the session upstream's compat identifiers name (`getCurrentChatId()`, `characters[].chat`,
     * `group.chat_id`: its name when it has one, else this). */
    get identifier() {
        return this.made ?? this.resolved.identifier;
    }

    /**
     * Who a write acts as: a tab with no session (or a deleted one's) acts through a new session, which the answer
     * hands the tab.
     * @returns {import('./chat-engine.js').Actor}
     */
    actor() {
        const session = this.resolved.session ?? (this.made ??= newSessionKey());
        return { user: this.user, session };
    }

    /**
     * Who a read acts as: the session landing reads, or none.
     * @returns {import('./chat-engine.js').Actor}
     */
    reader() {
        return { user: this.user, session: this.resolved.session ?? this.made };
    }

    /**
     * Sets the answer's session headers: gone when the request named a deleted session; moved when a session was
     * made for it, or `moved` says its write moved the session. A caller with no tab is told nothing.
     * @param {{ setHeader(name: string, value: string): unknown }} res
     * @param {{ moved?: boolean }} [o]
     */
    answer(res, { moved = false } = {}) {
        if (this.header === undefined) return;
        if (this.resolved.gone) res.setHeader(SESSION_GONE_HEADER, '1');
        const session = this.made ?? (moved ? this.resolved.session : null);
        if (session) res.setHeader(SESSION_MOVED_HEADER, session);
    }
}

/**
 * The request's session in a tree.
 * @param {import('./chat-engine.js').ChatEngine} chats
 * @param {{ get(name: string): string | undefined, user: { profile: { handle: string } } }} req
 * @param {bigint} tree
 */
export async function requestSession(chats, req, tree) {
    const header = sessionHeaderOf(req);
    const user = req.user.profile.handle;
    return new RequestSession(header, user, await chats.resolveSession({ tree, user, header }));
}
