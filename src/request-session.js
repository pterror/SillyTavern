import { newSessionKey } from './chat-engine.js';

export const SESSION_HEADER = 'X-ST-Session';
export const SESSION_MOVED_HEADER = 'X-ST-Session-Moved';
export const SESSION_GONE_HEADER = 'X-ST-Session-Gone';

/**
 * @param {{ get(name: string): string | undefined }} req
 * @returns {string | undefined}
 */
export function sessionHeaderOf(req) {
    const value = req.get(SESSION_HEADER);
    return value === undefined || value === '' ? undefined : value;
}

export class RequestSession {
    /**
     * @param {string | undefined} header
     * @param {string} user
     * @param {{ session: string | null, identifier: string, gone?: true }} resolved
     */
    constructor(header, user, resolved) {
        this.header = header;
        this.user = user;
        this.resolved = resolved;
        /** @type {string | null} */
        this.made = null;
    }

    get identifier() {
        return this.made ?? this.resolved.identifier;
    }

    /**
     * @returns {import('./chat-engine.js').Actor}
     */
    actor() {
        const session = this.resolved.session ?? (this.made ??= newSessionKey());
        return { user: this.user, session };
    }

    /**
     * @returns {import('./chat-engine.js').Actor}
     */
    reader() {
        return { user: this.user, session: this.resolved.session ?? this.made };
    }

    /**
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
 * @param {import('./chat-engine.js').ChatEngine} chats
 * @param {{ get(name: string): string | undefined, user: { profile: { handle: string } } }} req
 * @param {bigint} tree
 */
export async function requestSession(chats, req, tree) {
    const header = sessionHeaderOf(req);
    const user = req.user.profile.handle;
    return new RequestSession(header, user, await chats.resolveSession({ tree, user, header }));
}
