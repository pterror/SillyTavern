import { FIELD, NAME_HISTORY, TYPE, renamesOf } from './library-codes.js';
import { storedValues } from './entity-values.js';

const ONLY = { fields: [FIELD.name], lists: [NAME_HISTORY] };

/**
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
        const history = storedValues(e).lists.get(NAME_HISTORY);
        return { id: e.id, name: value, avatar: e.key, ...(history === undefined ? {} : { renames: renamesOf(history) }) };
    };
    return {
        /** @param {bigint[]} ids */
        async speakers(ids) {
            const found = await lib.entities(ids, ONLY);
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
            const found = await lib.entities(await lib.ids(TYPE.character, avatars), ONLY);
            /** @type {Map<string, import('./chat-codec.js').Speaker>} */
            const out = new Map();
            found.forEach((e, i) => {
                const s = speakerOf(e);
                if (s) out.set(avatars[i], s);
            });
            return out;
        },
        /**
         * @param {bigint[]} ids
         */
        async owners(ids) {
            const found = await lib.entities(ids, ONLY);
            /** @type {Map<bigint, { group: boolean, name: string, created: number }>} */
            const out = new Map();
            found.forEach((e, i) => {
                if (!e || (e.type !== TYPE.character && e.type !== TYPE.group)) return;
                const v = e.values.find(x => x.field === FIELD.name);
                const name = v === undefined ? '' : v.text !== undefined ? v.text : JSON.parse(/** @type {string} */ (v.json));
                out.set(ids[i], { group: e.type === TYPE.group, name: typeof name === 'string' ? name : '', created: e.type === TYPE.group ? e.added : (e.createMs ?? e.added) });
            });
            return out;
        },
        /** @type {import('./chat-engine.js').Books} */
        books: {
            lane: (keys, fn) => lib.books.lane(keys, fn),
            find: async key => (await lib.ids(TYPE.book, [key]))[0],
            newId: () => lib.nextId++,
            resolved: ids => lib.store.worldRead('resolved', { ids }),
        },
        /**
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
