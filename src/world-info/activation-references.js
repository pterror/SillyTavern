import { TYPE } from '../library-codes.js';
import { entryObject, SLOT } from '../world-info-engine.js';

/**
 * @typedef {{ book: string, entry: string }} EntryTarget
 * @typedef {Omit<import('./activation-record.js').RecordEntry, 'ref'> & { ref: EntryTarget | null }} ResolvedEntry
 * @typedef {{ entries: ResolvedEntry[], cut: { ref: EntryTarget | null, why: 'budget' | 'chance' | 'group' }[] }} ResolvedActivationRecord
 */

/**
 * The compatibility boundary for persisted activation references. Consumers receive only exact entry targets or null
 * for unavailable entries; card IDs and storage IDs are deliberately resolved here, never by individual UI paths.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {import('./activation-record.js').EntryRef[]} refs
 * @param {string | null} avatar the reply's character, including original_avatar in group chats
 * @returns {Promise<(EntryTarget | null)[]>}
 */
export async function resolveActivationReferences(lib, refs, avatar) {
    /** @type {Map<string, EntryTarget>} */
    const embedded = new Map();
    if (avatar && refs.some(ref => ref && 'card' in ref && typeof ref.card === 'string')) {
        const [character] = await lib.ids(TYPE.character, [avatar]);
        const [book] = character === null ? [null] : await lib.ids(TYPE.ownedBook, [`${character}:${SLOT.characterBook}`]);
        if (book !== null) {
            const stored = await lib.books.storedEntries(book);
            stored.forEach(({ entity }, index) => {
                const entry = entryObject(entity, true);
                const uid = String(entry.id ?? index);
                // The card reader takes the first matching ID as well.
                if (!embedded.has(uid)) embedded.set(uid, { book: String(book), entry: String(entity.id) });
            });
        }
    }
    return Promise.all(refs.map(async ref => {
        if (ref && 'card' in ref) return embedded.get(ref.card) ?? null;
        if (!ref || !('book' in ref) || typeof ref.book !== 'string' || typeof ref.entry !== 'string' ||
            !/^\d+$/u.test(ref.book) || !/^\d+$/u.test(ref.entry)) return null;
        return await lib.books.entryIn(BigInt(ref.book), BigInt(ref.entry)) ? { book: ref.book, entry: ref.entry } : null;
    }));
}

/**
 * Reads a reply's record with every reference resolved through the same compatibility boundary. The saved record is
 * left intact, and missing entries keep their indices so provenance and marked ranges still refer to the right row.
 * @param {Awaited<ReturnType<typeof import('../user-stores.js').userStore>>} store
 * @param {string} message
 * @returns {Promise<ResolvedActivationRecord | null>}
 */
export async function resolvedActivations(store, message) {
    const [id] = await store.chats.messageIds([message]);
    const stored = id === null ? undefined : (await store.chats.stored([id])).get(id);
    if (!stored) return null;
    const [content] = await store.chats.decoded([stored]);
    const record = content?.extra?.activations;
    if (!record || !Array.isArray(record.entries)) return null;
    let avatar = typeof content.original_avatar === 'string' ? content.original_avatar : null;
    if (avatar === null) {
        const [key] = await store.lib.store.libraryKeys([stored.owner]);
        avatar = key && key.type === TYPE.character ? key.key : null;
    }
    const cut = Array.isArray(record.cut) ? record.cut : [];
    const targets = await resolveActivationReferences(store.lib, [...record.entries, ...cut].map(entry => entry.ref), avatar);
    return {
        entries: record.entries.map((entry, index) => ({ ...entry, ref: targets[index] })),
        cut: cut.map((entry, index) => ({ ...entry, ref: targets[record.entries.length + index] })),
    };
}
