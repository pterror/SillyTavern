/**
 * The chat box's text as the browser keeps it until the server confirms a save of it: per draft (a chat and what the
 * text responds to) and per tab, the text with the changes from the draft it was written over, as a save carries them.
 * Only text the server hasn't confirmed is kept, so a copy is never a draft of its own: the server merges it into its
 * draft, and merging one already in it changes nothing, so any tab may carry any copy, of any chat.
 *
 * Each tab writes only its own copies, under its tab token (`tab-session.js`, kept in sessionStorage, so it outlives a
 * reload and a duplicated tab takes a new one). A tab that is gone never confirms its copies, so whichever tab opens a
 * chat next carries every copy there is (`all`), and they last until then.
 */

const COPY = 'ChatBoxCopy:';
const INDEX = 'ChatBoxCopies';

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ text: string, changes: import('./chat-box-text.js').BoxChange[], change?: string }} Copy
 * @typedef {Copy & { owner: DraftOwner, tab: string }} KeptCopy
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} CopyStorage
 */

/** @param {ChatOf} chat */
const chatId = chat => ('group_id' in chat ? `group:${chat.group_id}` : `card:${chat.avatar_url}`);

/**
 * @param {string} id
 * @returns {ChatOf | null}
 */
const chatOfId = id => (id.startsWith('group:') ? { group_id: id.slice(6) } : id.startsWith('card:') ? { avatar_url: id.slice(5) } : null);

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
     * @param {string} chat its id
     * @param {string} field its owner, as kept
     * @param {string} tab
     */
    const keyOf = (chat, field, tab) => COPY + JSON.stringify([chat, field, tab]);

    /** @returns {[string, string, string][]} each copy kept: its chat, what it responds to and its tab */
    const index = () => /** @type {[string, string, string][]} */ (readList(storage, INDEX).filter(e => Array.isArray(e) && e.length === 3 && e.every(part => typeof part === 'string')));

    /**
     * @param {string} chat
     * @param {string} field
     * @param {string} tab
     * @returns {Copy | null}
     */
    const readKept = (chat, field, tab) => {
        try {
            const copy = JSON.parse(storage.getItem(keyOf(chat, field, tab)) ?? 'null');
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
     * @returns {Copy | null}
     */
    const read = (chat, owner, tab) => readKept(chatId(chat), ownerField(owner), tab);

    /**
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     */
    const remove = (chat, owner, tab) => {
        const [id, field] = [chatId(chat), ownerField(owner)];
        storage.removeItem(keyOf(id, field, tab));
        writeList(storage, INDEX, index().filter(([c, f, t]) => !(c === id && f === field && t === tab)));
    };

    /**
     * The text as this tab has it, with the changes from the draft it was written over
     * @param {ChatOf} chat
     * @param {DraftOwner} owner
     * @param {string} tab
     * @param {Copy} copy
     */
    const write = (chat, owner, tab, copy) => {
        const [id, field] = [chatId(chat), ownerField(owner)];
        storage.setItem(keyOf(id, field, tab), JSON.stringify(copy));
        const kept = index();
        if (!kept.some(([c, f, t]) => c === id && f === field && t === tab)) writeList(storage, INDEX, [...kept, [id, field, tab]]);
    };

    return {
        write,
        read,
        remove,
        /**
         * @returns {(KeptCopy & { chat: ChatOf })[]} every copy kept, of every chat
         */
        all() {
            return index().flatMap(([id, field, tab]) => {
                const chat = chatOfId(id);
                const copy = chat ? readKept(id, field, tab) : null;
                if (!chat || !copy) return [];
                try {
                    return [{ chat, owner: JSON.parse(field), tab, ...copy }];
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
            const id = chatId(chat);
            const kept = index();
            for (const [c, f, t] of kept) if (c === id) storage.removeItem(keyOf(c, f, t));
            writeList(storage, INDEX, kept.filter(([c]) => c !== id));
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
            const [id, field] = [chatId(chat), ownerField(owner)];
            const taken = new Set(index().filter(([c, f]) => c === id && f === field).map(([, , t]) => t));
            let n = 1;
            while (taken.has(`${tab}~${n}`)) n++;
            write(chat, owner, `${tab}~${n}`, copy);
            remove(chat, owner, tab);
        },
    };
}
