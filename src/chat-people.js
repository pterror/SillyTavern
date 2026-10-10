import { FIELD, TYPE } from './library-codes.js';

/**
 * Who speaks in chats, from the library on the engine: characters by entity id and by avatar, each with its name
 * now (`ChatEngine`'s `People`); and the tree a character or group's messages are in, which is its entity id.
 * @param {import('./library-engine.js').LibraryEngine} lib
 */
export function libraryPeople(lib) {
    /**
     * @param {import('./library-engine.js').StoredEntity | null} e
     * @returns {import('./chat-codec.js').Speaker | null}
     */
    const speakerOf = e => {
        if (!e || e.type !== TYPE.character) return null;
        const name = e.values.find(v => v.field === FIELD.name);
        const value = name === undefined ? '' : name.text !== undefined ? name.text : JSON.parse(/** @type {string} */ (name.json));
        return { id: e.id, name: value, avatar: e.key };
    };
    return {
        /** @param {bigint[]} ids */
        async speakers(ids) {
            const found = await lib.entities(ids);
            /** @type {Map<bigint, import('./chat-codec.js').Speaker>} */
            const out = new Map();
            found.forEach((e, i) => {
                const s = speakerOf(e);
                if (s) out.set(ids[i], s);
            });
            return out;
        },
        /** @param {string[]} avatars */
        async byAvatar(avatars) {
            const found = await lib.entities(await lib.ids(TYPE.character, avatars));
            /** @type {Map<string, import('./chat-codec.js').Speaker>} */
            const out = new Map();
            found.forEach((e, i) => {
                const s = speakerOf(e);
                if (s) out.set(avatars[i], s);
            });
            return out;
        },
        /**
         * The tree of each character (by avatar) or group (by id), or null when there is none.
         * @param {{ avatar?: string, group?: string }[]} owners
         * @returns {Promise<(bigint | null)[]>}
         */
        async trees(owners) {
            const characters = owners.map(o => o.avatar).filter(a => typeof a === 'string');
            const groups = owners.map(o => o.group).filter(g => typeof g === 'string');
            const [c, g] = await Promise.all([lib.ids(TYPE.character, characters), lib.ids(TYPE.group, groups)]);
            let ci = 0;
            let gi = 0;
            return owners.map(o => (typeof o.avatar === 'string' ? c[ci++] : typeof o.group === 'string' ? g[gi++] : null));
        },
    };
}
