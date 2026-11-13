/**
 * The chat box's text as the browser keeps it until the server confirms a save of it: per draft (a chat and what the
 * text responds to) and per tab, the text with the changes from the draft it was written over, as a save carries them.
 * Only text the server hasn't confirmed is kept, so a copy is never a draft of its own: the server merges it into its
 * draft, and merging one already in it changes nothing, so any tab may carry any copy.
 *
 * Each tab writes only its own copies, under its tab token (`tab-session.js`, kept in sessionStorage, so it outlives a
 * reload and a duplicated tab takes a new one).
 */

const COPY = 'ChatBoxCopy:';
const INDEX = 'ChatBoxCopies:';

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ text: string, changes: import('./chat-box-text.js').BoxChange[], change?: string }} Copy
 * @typedef {Copy & { owner: DraftOwner, tab: string }} KeptCopy
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} CopyStorage
 */

/** @param {ChatOf} chat */
const chatId = chat => ('group_id' in chat ? `group:${chat.group_id}` : `card:${chat.avatar_url}`);

/** @param {DraftOwner} owner */
const ownerField = owner => JSON.stringify('message' in owner ? { message: owner.message } : 'root' in owner ? { root: true } : { greeting: owner.greeting, avatar: owner.avatar });

/**
 * Browser storage that is absent or refuses (a private window) reads as empty and keeps nothing
 * @param {() => Storage} storage
 * @returns {CopyStorage}
 */
export function guardedStorage(storage) {
    return {
        getItem(key) {
            try {
                return storage().getItem(key);
            } catch {
                return null;
            }
        },
        setItem(key, value) {
            try {
                storage().setItem(key, value);
            } catch {
                // Not kept: the box still holds the text.
            }
        },
        removeItem(key) {
            try {
                storage().removeItem(key);
            } catch {
                // Nothing to remove.
            }
        },
    };
}

/**
 * @param {CopyStorage} storage
 * @param {string} key
 * @returns {unknown[]}
 */
function readList(storage, key) {
    try {
        const list = JSON.parse(storage.getItem(key) ?? '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

/**
 * @param {CopyStorage} storage
 * @param {string} key
 * @param {unknown[]} list
 */
function writeList(storage, key, list) {
    if (list.length) storage.setItem(key, JSON.stringify(list));
    else storage.removeItem(key);
}

/**
 * @param {CopyStorage} storage
 */
export function boxCopies(storage) {
    /**
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     */
    const keyOf = (chat, owner, tab) => COPY + JSON.stringify([chatId(chat), ownerField(owner), tab]);

    /**
     * @param {ChatOf} chat
     * @returns {[string, string][]} each copy of the chat: what it responds to and its tab
     */
    const indexOf = chat => /** @type {[string, string][]} */ (readList(storage, INDEX + chatId(chat)).filter(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string'));

    /**
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     * @returns {Copy | null}
     */
    const read = (chat, owner, tab) => {
        try {
            const copy = JSON.parse(storage.getItem(keyOf(chat, owner, tab)) ?? 'null');
            return copy && typeof copy.text === 'string' && Array.isArray(copy.changes)
                ? { text: copy.text, changes: copy.changes, ...(typeof copy.change === 'string' ? { change: copy.change } : {}) }
                : null;
        } catch {
            return null;
        }
    };

    /**
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     */
    const remove = (chat, owner, tab) => {
        storage.removeItem(keyOf(chat, owner, tab));
        const field = ownerField(owner);
        writeList(storage, INDEX + chatId(chat), indexOf(chat).filter(([f, t]) => !(f === field && t === tab)));
    };

    /**
     * The text as this tab has it, with the changes from the draft it was written over
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     * @param {Copy} copy
     */
    const write = (chat, owner, tab, copy) => {
        storage.setItem(keyOf(chat, owner, tab), JSON.stringify(copy));
        const field = ownerField(owner);
        const index = indexOf(chat);
        if (!index.some(([f, t]) => f === field && t === tab)) writeList(storage, INDEX + chatId(chat), [...index, [field, tab]]);
    };

    return {
        write,
        read,
        remove,
        /**
         * @param {ChatOf} chat
         * @returns {KeptCopy[]} every copy kept for the chat
         */
        of(chat) {
            return indexOf(chat).flatMap(([field, tab]) => {
                try {
                    const owner = JSON.parse(field);
                    const copy = read(chat, owner, tab);
                    return copy ? [{ owner, tab, ...copy }] : [];
                } catch {
                    return [];
                }
            });
        },
        /**
         * The server keeps a text: a copy of just that text is gone; one written since stays, to be carried again
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @param {string} tab
         * @param {string} text
         */
        confirm(chat, owner, tab, text) {
            if (read(chat, owner, tab)?.text === text) remove(chat, owner, tab);
        },
        /**
         * @param {ChatOf} chat a chat that is gone
         */
        dropChat(chat) {
            for (const [field, tab] of indexOf(chat)) storage.removeItem(COPY + JSON.stringify([chatId(chat), field, tab]));
            storage.removeItem(INDEX + chatId(chat));
        },
        /**
         * Sets this tab's copy for a draft apart from the one the box writes next, so it is carried as it is
         * @param {ChatOf} chat
         * @param {DraftOwner} owner
         * @param {string} tab
         */
        setApart(chat, owner, tab) {
            const copy = read(chat, owner, tab);
            if (!copy) return;
            const field = ownerField(owner);
            const taken = new Set(indexOf(chat).filter(([f]) => f === field).map(([, t]) => t));
            let n = 1;
            while (taken.has(`${tab}~${n}`)) n++;
            write(chat, owner, `${tab}~${n}`, copy);
            remove(chat, owner, tab);
        },
    };
}
