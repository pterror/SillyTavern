import { FILTER_ITEMS_SHOWN, MENTIONS_PER_PAGE } from '@st/worldbuilding/protocol';
import { wordRuns } from '../draft-merge.js';
import { FIELD, TYPE } from '../library-codes.js';
import { thumbnailsOf } from '../thumbnail-urls.js';
import { entryAsWorld, keysOfEntry } from '../world-info-engine.js';
import { parseRegexFromString } from './key-matching.js';
import { lookImageUrl } from '@st/looks/look';
import { newWorldInfoEntryDefinition, newWorldInfoEntryTemplate } from '../../public/scripts/world-info-entry-defaults.js';

export const SENTENCE_SIDE_CHARACTERS = 200;
const SENTENCE_WINDOW = 4 * SENTENCE_SIDE_CHARACTERS;

const NOT_PLACEMENT = new Set(['key', 'comment', 'content', 'characterFilterNames', 'characterFilterTags', 'characterFilterExclude']);

/** @type {Readonly<Record<string, unknown>>} */
export const PLACEMENT_DEFAULTS = Object.freeze({
    ...Object.fromEntries(Object.entries(newWorldInfoEntryDefinition).filter(([field]) => !NOT_PLACEMENT.has(field)).map(([field, { default: value }]) => [field, value])),
    characterFilter: { isExclude: false, names: [], tags: [] },
});

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} one
 * @param {unknown} other
 * @returns {boolean}
 */
function sameValue(one, other) {
    if (Array.isArray(one) && Array.isArray(other)) return one.length === other.length && one.every((v, i) => sameValue(v, other[i]));
    if (isPlainObject(one) && isPlainObject(other)) {
        const [a, b] = [(one), /** @type {Record<string, unknown>} */ (other)];
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        return [...keys].every(k => sameValue(a[k], b[k]));
    }
    return Object.is(one, other);
}

/**
 * The entry's placement fields as stored, each missing one at upstream's default.
 * @param {Record<string, unknown>} entry
 * @returns {{ placement: Record<string, unknown>, differs: boolean }}
 */
export function placementOf(entry) {
    /** @type {Record<string, unknown>} */
    const placement = {};
    let differs = false;
    for (const [field, fallback] of Object.entries(PLACEMENT_DEFAULTS)) {
        const value = entry[field] === undefined ? structuredClone(fallback) : entry[field];
        placement[field] = value;
        if (!sameValue(value, fallback)) differs = true;
    }
    return { placement, differs };
}

/**
 * @param {string} text
 * @param {number} side
 */
const lastCharacters = (text, side) => {
    const characters = Array.from(text);
    if (characters.length <= side) return text;
    const cut = characters.slice(-side).join('');
    const word = cut.search(/\s/u);
    return word === -1 ? cut : cut.slice(word + 1);
};

/**
 * @param {string} text
 * @param {number} side
 */
const firstCharacters = (text, side) => {
    const characters = Array.from(text);
    if (characters.length <= side) return text;
    const cut = characters.slice(0, side).join('');
    const word = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'), cut.lastIndexOf('\t'));
    return word <= 0 ? cut : cut.slice(0, word);
};

/**
 * The sentence a mention stands in: from the sentence's start to the mention, the mention, and from the mention to the
 * sentence's end, each side at most SENTENCE_SIDE_CHARACTERS, cut at a word.
 * @param {string} text
 * @param {[number, number] | undefined} span
 * @returns {{ before: string, mention: string, after: string }}
 */
export function sentenceAround(text, span) {
    const [from, to] = span ?? [0, 0];
    const start = Math.max(0, from - SENTENCE_WINDOW);
    const end = Math.min(text.length, to + SENTENCE_WINDOW);
    const window = text.slice(start, end);
    const [at, until] = [from - start, to - start];
    let sentenceStart = 0;
    let sentenceEnd = window.length;
    for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(window)) {
        if (index <= at) sentenceStart = index;
        if (index + segment.length >= until && index + segment.length > at) {
            sentenceEnd = index + segment.length;
            break;
        }
    }
    return {
        before: lastCharacters(window.slice(sentenceStart, at).trimStart(), SENTENCE_SIDE_CHARACTERS),
        mention: window.slice(at, until),
        after: firstCharacters(window.slice(until, sentenceEnd).trimEnd(), SENTENCE_SIDE_CHARACTERS),
    };
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {unknown}
 */
const namesOf = entry => (isPlainObject(entry.extensions) ? /** @type {Record<string, unknown>} */ (entry.extensions).names : undefined);

/**
 * @param {Record<string, unknown>} entry
 * @param {string[]} keys
 * @param {string} key
 * @param {'name' | 'trigger'} as
 */
function withKeyAs(entry, keys, key, as) {
    const stored = namesOf(entry);
    const names = Array.isArray(stored) ? stored.filter(name => typeof name === 'string') : [];
    if (as === 'trigger' && !names.includes(key)) return { ...entry, key: keys };
    const next = as === 'name' ? [...names.filter(name => name !== key), key] : names.filter(name => name !== key);
    const extensions = isPlainObject(entry.extensions) ? /** @type {Record<string, unknown>} */ (entry.extensions) : {};
    return { ...entry, key: keys, extensions: { ...extensions, names: next } };
}

const NO_SUCH_KEY = 'That entry has no such key.';
const NOT_A_NAME = 'A pattern can only be a trigger, not a name.';
const KEY_TAKEN = 'That entry already has that key.';

/** @param {string} key */
const isPattern = key => parseRegexFromString(key) !== null;

/**
 * The key stays where it is in the list and stays a name if it was one; other entries' keys are not touched.
 * @param {Record<string, unknown>} entry
 * @param {string[]} keys
 * @param {string} key
 * @param {string} to
 * @returns {Record<string, unknown> | { refused: string }}
 */
function renamedKey(entry, keys, key, to) {
    if (!keys.includes(key)) return { refused: NO_SUCH_KEY };
    if (to === key) return entry;
    if (keys.includes(to)) return { refused: KEY_TAKEN };
    const stored = namesOf(entry);
    const isName = Array.isArray(stored) && stored.includes(key);
    if (isName && isPattern(to)) return { refused: NOT_A_NAME };
    const renamed = { ...entry, key: keys.map(k => (k === key ? to : k)) };
    if (!isName) return renamed;
    const extensions = /** @type {Record<string, unknown>} */ (entry.extensions);
    return { ...renamed, extensions: { ...extensions, names: /** @type {string[]} */ (stored).map(name => (name === key ? to : name)) } };
}
export const CARD_ENTRY_STAYS = 'An entry doesn\'t move into or out of a character\'s own lorebook.';

/**
 * @param {Record<string, unknown>} current
 * @param {import('@st/worldbuilding/server').EntryEdit} edit
 * @returns {Record<string, unknown> | { refused: string }}
 */
export function editedEntry(current, edit) {
    const keys = keysOfEntry(current);
    switch (edit.change) {
        case 'text':
            return { ...current, content: edit.text };
        case 'title':
            return { ...current, comment: edit.title };
        case 'addKeys': {
            if (edit.as === 'name' && edit.keys.some(isPattern)) return { refused: NOT_A_NAME };
            const added = [...new Set(edit.keys)];
            const all = [...keys, ...added.filter(key => !keys.includes(key))];
            return added.reduce((entry, key) => withKeyAs(entry, all, key, edit.as), current);
        }
        case 'renameKey':
            return renamedKey(current, keys, edit.key, edit.to);
        case 'setKeyAs':
            if (edit.as === 'name' && isPattern(edit.key)) return { refused: NOT_A_NAME };
            return keys.includes(edit.key) ? withKeyAs(current, keys, edit.key, edit.as) : { refused: NO_SUCH_KEY };
        case 'removeKey':
            return keys.includes(edit.key) ? { ...current, key: keys.filter(k => k !== edit.key) } : { refused: NO_SUCH_KEY };
        case 'placement':
            return { ...current, ...edit.fields };
        case 'characterFilter':
            return { ...current, characterFilter: changedFilter(filterOf(current), edit.filter) };
    }
}

/**
 * @param {import('./entry-merge.js').FieldConflict} conflict
 * @returns {import('@st/worldbuilding/protocol').ConflictField}
 */
function conflictShown({ field, mine, theirs, merged }) {
    const diff = merged === null ? null : wordRuns(String(mine ?? ''), String(theirs ?? '')).map(run => ({ text: run.text, in: run.in === 'from' ? 'mine' : run.in === 'to' ? 'theirs' : 'both' }));
    return { field, mine: mine ?? null, theirs: theirs ?? null, merged, diff };
}

/**
 * @param {Record<string, unknown>} entry
 * @returns {{ isExclude: boolean, names: string[], tags: string[] }}
 */
function filterOf(entry) {
    const stored = isPlainObject(entry.characterFilter) ? /** @type {Record<string, unknown>} */ (entry.characterFilter) : {};
    const strings = (/** @type {unknown} */ v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
    return { isExclude: stored.isExclude === true, names: strings(stored.names), tags: strings(stored.tags) };
}

/**
 * @param {{ isExclude: boolean, names: string[], tags: string[] }} filter
 * @param {{ exclude: boolean } | { add: import('@st/worldbuilding/protocol').FilterItem } | { remove: import('@st/worldbuilding/protocol').FilterItem }} change
 */
function changedFilter(filter, change) {
    if ('exclude' in change) return { ...filter, isExclude: change.exclude };
    const item = 'add' in change ? change.add : change.remove;
    const [list, key] = 'character' in item ? /** @type {const} */ (['names', item.character]) : /** @type {const} */ (['tags', item.tag]);
    const without = filter[list].filter(k => k !== key);
    return { ...filter, [list]: 'add' in change ? [...without, key] : without };
}

/**
 * Upstream names a character in a filter by its avatar file's name without the extension; this store keys a
 * character by its avatar file, which a card always has as a PNG.
 * @param {string} key
 */
const avatarOfFilterKey = key => `${key}.png`;

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {Record<string, unknown>} entry
 * @returns {Promise<import('@st/worldbuilding/protocol').CharacterFilterShown>}
 */
async function shownFilter(lib, entry) {
    const filter = filterOf(entry);
    const names = filter.names.slice(0, FILTER_ITEMS_SHOWN);
    const tags = filter.tags.slice(0, Math.max(0, FILTER_ITEMS_SHOWN - names.length));
    const characters = await lib.entities(await lib.ids(TYPE.character, names.map(avatarOfFilterKey)));
    const tagNames = await tagNamesOf(lib, tags);
    return {
        exclude: filter.isExclude,
        characters: names.map((key, i) => ({ key, ...characterShown(characters[i]) })),
        tags: tags.map(key => ({ key, name: tagNames.get(key) ?? null })),
        more: filter.names.length + filter.tags.length - names.length - tags.length,
    };
}

/**
 * A tag merged into another is named by the one it went into.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string[]} keys
 * @returns {Promise<Map<string, string>>}
 */
async function tagNamesOf(lib, keys) {
    if (keys.length === 0) return new Map();
    const { tags, merged } = /** @type {{ tags: Record<string, unknown>[], merged: Record<string, string> }} */ (await lib.tags.byIds(keys));
    const byKey = new Map(tags.flatMap(t => (typeof t.id === 'string' && typeof t.name === 'string' ? [[t.id, t.name]] : [])));
    return new Map(keys.flatMap(key => {
        const name = byKey.get(merged[key] ?? key);
        return name === undefined ? [] : [[key, name]];
    }));
}

/**
 * @param {import('../entity-values.js').StoredEntity | null} entity
 * @returns {{ named: import('@st/protocol/looks').Named | null, picture: string | null }}
 */
function characterShown(entity) {
    if (!entity || entity.type !== TYPE.character) return { named: null, picture: null };
    const value = entity.values.find(v => v.field === FIELD.name);
    const name = value?.text ?? (value?.json === undefined ? '' : JSON.parse(value.json));
    const shown = thumbnailsOf(entity, 'avatar');
    return { named: { thing: String(entity.id), text: typeof name === 'string' ? name : '', shownAs: 'name' }, picture: shown.thumbnail_still ?? shown.thumbnail };
}

/**
 * @typedef {object} EntryPortsWiring
 * @property {(user: import('@st/server-ui').User) => Promise<import('../library-engine.js').LibraryEngine>} libOf
 * @property {(user: import('@st/server-ui').User) => Promise<import('./references.js').References>} referencesOf
 * @property {(user: import('@st/server-ui').User, texts: string[]) => Promise<number[] | null>} countTokens
 */

/**
 * The pictures' URLs of entries of the book, in their order; null for one with no picture or not in the book.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint} book
 * @param {bigint[]} entries
 * @returns {Promise<(string | null)[]>}
 */
async function picturesOf(lib, book, entries) {
    if (entries.length === 0) return [];
    /** @type {(string | null)[]} */
    const read = await lib.store.worldRead('worldbuildingPictures', { book, entities: entries });
    return read.map(id => (id === null ? null : lookImageUrl(id)));
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {bigint} book
 * @returns {Promise<string | null>}
 */
async function worldKey(lib, book) {
    const [entity] = await lib.entities([book]);
    return entity && entity.type === TYPE.book ? entity.key : null;
}

/**
 * The entry actions and the entry view of the worldbuilding area, over the store.
 * @param {EntryPortsWiring} wiring
 * @returns {Pick<import('@st/worldbuilding/server').Ports, 'readEntry' | 'readFacts' | 'findCharacters' | 'readKeySharers' | 'readKeySuggestions' | 'editEntry' | 'createEntry' | 'deleteEntry' | 'restoreEntry' | 'moveEntryToWorld' | 'copyEntryToWorld' | 'duplicateEntry' | 'applySortAsOrder' | 'placeInWorldOrder'>}
 */
export function worldbuildingEntryPorts({ libOf, referencesOf, countTokens }) {
    const actorOf = (/** @type {import('@st/worldbuilding/server').Who} */ who) => ({ user: who.user.handle, session: who.session });

    /**
     * The run of pages of what mentions the entry: the page at `from`, then each page after the one before, looking
     * through at most `checks` entries in all; the run ends at the page that reaches it.
     * @param {import('@st/server-ui').User} user
     * @param {bigint} book
     * @param {bigint} entry
     * @param {import('@st/worldbuilding/server').PagesRun} run
     * @param {number} checks
     * @returns {Promise<import('@st/worldbuilding/protocol').MentionedIn>}
     */
    const mentionsOf = async (user, book, entry, { from, pages }, checks) => {
        const references = await referencesOf(user);
        /** @type {{ cursor: string | null, found: { entry: bigint, text: string, span: [number, number] | undefined }[], next: string | null, lookedThrough: number, stoppedForBound: boolean }[]} */
        const read = [];
        /** @type {string | null} */
        let cursor = from;
        let checksLeft = checks;
        while (read.length < pages) {
            const page = await references.to(book, entry, { ...(cursor === null ? {} : { cursor }), limit: MENTIONS_PER_PAGE, withText: true, checksAtMost: checksLeft });
            if (!page) break;
            const found = page.references.map(reference => ({ entry: reference.entry, text: reference.text ?? '', span: reference.spans[0] }));
            read.push({ cursor, found, next: page.next, lookedThrough: page.lookedThrough, stoppedForBound: page.stoppedForBound });
            checksLeft -= page.checked;
            if (page.next === null || page.stoppedForBound) break;
            cursor = page.next;
        }
        const sources = read.flatMap(page => page.found.map(found => found.entry));
        const lib = await libOf(user);
        /** @type {(import('@st/worldbuilding/protocol').Named | null)[]} */
        const labels = sources.length === 0 ? [] : await lib.store.worldRead('worldbuildingLabels', { book, entities: sources });
        const pictures = await picturesOf(lib, book, sources);
        let at = 0;
        return {
            pages: read.map(({ cursor: readAt, found, next, lookedThrough, stoppedForBound }) => ({
                cursor: readAt,
                entries: found.flatMap(({ text, span }) => {
                    const picture = pictures[at];
                    const source = labels[at++];
                    return source ? [{ from: source, picture, sentence: sentenceAround(text, span) }] : [];
                }),
                next,
                lookedThrough,
                stoppedForBound,
            })),
        };
    };

    /**
     * @param {import('@st/worldbuilding/server').Who} who
     * @param {string} book
     * @param {string} entry
     * @param {string} toBook
     * @param {boolean} keep the entry stays where it is and a copy is made
     */
    const transferEntry = async (who, book, entry, toBook, keep) => {
        const lib = await libOf(who.user);
        const [from, to] = [await worldKey(lib, BigInt(book)), await worldKey(lib, BigInt(toBook))];
        if (from === null) return (await lib.books.bookForm(BigInt(book))) === null ? 'missing' : { refused: CARD_ENTRY_STAYS };
        if (to === null) return (await lib.books.bookForm(BigInt(toBook))) === null ? { refused: 'That world no longer exists.' } : { refused: CARD_ENTRY_STAYS };
        const e = await lib.books.entryIn(BigInt(book), BigInt(entry));
        if (!e) return 'no entry';
        const moved = await lib.books.transplant({ source: from, target: to, uid: e.key.slice(e.key.indexOf(':') + 1), deleteOriginal: !keep }, actorOf(who));
        if (moved === 'no source') return 'missing';
        if (moved === 'no entry') return 'no entry';
        if (moved === 'no target') return { refused: 'That world no longer exists.' };
        if (moved === 'full') return { refused: 'That world has no free entry number left.' };
        return { entry: String(moved.id), unreachedLoops: moved.unreachedLoops };
    };
    return {
        async readFacts(user, book, entries, tokens) {
            const lib = await libOf(user);
            const b = BigInt(book);
            const form = await lib.books.bookForm(b);
            /** @type {bigint[]} */
            const versions = await lib.store.worldRead('lastChanges', { entities: entries.map(BigInt) });
            const stored = await Promise.all(entries.map(entry => lib.books.entryIn(b, BigInt(entry))));
            const worlds = stored.map(one => (one && form ? entryAsWorld(one, form.form) : null));
            const counts = tokens ? await countTokens(user, worlds.flatMap(world => (world ? [String(world.content ?? '')] : []))) : null;
            let counted = 0;
            return worlds.map((world, at) => {
                if (!world) return null;
                const { placement } = placementOf(world);
                const chance = placement.useProbability && Number(placement.probability) < 100 ? Number(placement.probability) : null;
                return {
                    version: String(versions[at]),
                    comesIn: placement.disable ? 'never' : placement.constant ? 'always' : 'broughtUp',
                    keysecondary: /** @type {string[]} */ (placement.keysecondary),
                    selectiveLogic: /** @type {import('@st/worldbuilding/protocol').Placement['selectiveLogic']} */ (placement.selectiveLogic),
                    position: /** @type {import('@st/worldbuilding/protocol').Placement['position']} */ (placement.position),
                    depth: Number(placement.depth),
                    order: Number(placement.order),
                    chance,
                    tokens: counts ? counts[counted++] ?? null : null,
                };
            });
        },
        async readEntry(user, book, entry, { mentions, mentionChecks, textLinkReads }) {
            const lib = await libOf(user);
            const [b, e] = [BigInt(book), BigInt(entry)];
            const read = await lib.store.worldRead('worldbuildingEntry', { book: b, entry: e });
            if (read === null) return null;
            if (read.deleted) return { deleted: true };
            const [stored, form] = await Promise.all([lib.books.entryIn(b, e), lib.books.bookForm(b)]);
            const asWorld = stored && form ? entryAsWorld(stored, form.form) : {};
            const { placement, differs } = placementOf(asWorld);
            const counts = await countTokens(user, [read.text]);
            const found = (await (await referencesOf(user)).links(b, e, read.text, { readsAtMost: textLinkReads })) ?? { links: [], complete: true };
            const linked = [...new Set(found.links.map(link => link.entry))];
            const linkedPictures = new Map((await picturesOf(lib, b, linked)).map((picture, i) => [linked[i], picture]));
            return {
                ...read,
                version: String(read.version),
                picture: read.picture === null ? null : lookImageUrl(read.picture),
                links: found.links.map(link => ({ ...link, entry: String(link.entry), picture: linkedPictures.get(link.entry) ?? null })),
                linksComplete: found.complete,
                placement: /** @type {import('@st/worldbuilding/protocol').Placement} */ (placement),
                placementDiffersFromDefaults: differs,
                tokens: counts?.[0] ?? null,
                characterFilter: await shownFilter(lib, asWorld),
                mentionedIn: await mentionsOf(user, b, e, mentions, mentionChecks),
            };
        },
        async findCharacters(user, { query, limit }) {
            const lib = await libOf(user);
            const found = await lib.query({ search: query, limit, includeGroups: false, wantTotal: false, sortField: 'search', tieSortField: 'name', tieSortOrder: 'asc' });
            const rows = found === 'invalid-cursor' ? [] : /** @type {{ type?: unknown, id?: unknown }[]} */ (found.rows ?? []);
            const avatars = rows.flatMap(r => (r.type === 'character' && typeof r.id === 'string' && r.id.endsWith('.png') ? [r.id] : []));
            const entities = await lib.entities(await lib.ids(TYPE.character, avatars));
            const tags = await lib.tags.query({ sort: 'alphabetical', pageSize: limit, search: query });
            const tagRows = tags === 'invalid-cursor' ? [] : tags.rows;
            return {
                characters: avatars.map((avatar, i) => ({ key: avatar.slice(0, -'.png'.length), ...characterShown(entities[i]) })),
                tags: tagRows.flatMap(t => (typeof t.id === 'string' && typeof t.name === 'string' ? [{ key: t.id, name: t.name }] : [])),
            };
        },
        async readKeySuggestions(user, { book, typed, limit }) {
            const lib = await libOf(user);
            return lib.store.worldRead('worldbuildingKeySuggestions', { book: BigInt(book), typed, limit });
        },
        async readKeySharers(user, { book, entry, key, limit }) {
            const lib = await libOf(user);
            return lib.store.worldRead('worldbuildingKeySharers', { book: BigInt(book), entry: BigInt(entry), key, limit });
        },
        async editEntry(who, book, entry, edit, version) {
            const lib = await libOf(who.user);
            const done = await lib.books.editEntryById(BigInt(book), BigInt(entry), current => editedEntry(current, edit), actorOf(who), version === null ? null : BigInt(version));
            if (typeof done !== 'object' || !('conflict' in done)) return done;
            return { conflict: { book, entry, version: String(done.conflict.version), fields: done.conflict.fields.map(conflictShown) } };
        },
        async createEntry(who, book, { after, name, relation }, loopCheckLimit) {
            const lib = await libOf(who.user);
            const entry = { ...structuredClone(newWorldInfoEntryTemplate), ...(name === null ? {} : { key: [name], extensions: { names: [name] } }) };
            const made = await lib.books.createEntryIn(BigInt(book), {
                after: after === null ? null : BigInt(after),
                entry,
                relation: relation === null ? null : { kind: Number(relation.kind), target: BigInt(relation.target) },
            }, loopCheckLimit, actorOf(who));
            if (made === 'missing' || 'refused' in made) return made;
            return { entry: String(made.entry), unreachedLoops: made.unreachedLoops };
        },
        async deleteEntry(who, book, entry) {
            const lib = await libOf(who.user);
            const [b, e] = [BigInt(book), BigInt(entry)];
            if ((await lib.books.bookForm(b)) === null) return 'missing';
            /** @type {(import('@st/worldbuilding/protocol').Named | null)[]} */
            const [label] = await lib.store.worldRead('worldbuildingLabels', { book: b, entities: [e] });
            if (!label) return 'no entry';
            const set = await lib.books.newDeleteSet();
            const done = await lib.books.deleteEntryById(b, e, actorOf(who), set);
            if (typeof done === 'string' || 'refused' in done) return done;
            return { label, set: String(set), unreachedLoops: done.unreachedLoops };
        },
        async restoreEntry(who, book, entry) {
            const lib = await libOf(who.user);
            const done = await lib.books.restoreIn(BigInt(book), BigInt(entry), actorOf(who));
            if (done === 'full') return { refused: 'This world has no free entry number left.' };
            if (typeof done === 'string') return done;
            return { unreachedLoops: done.unreachedLoops };
        },
        moveEntryToWorld: (who, book, entry, toBook) => transferEntry(who, book, entry, toBook, false),
        copyEntryToWorld: (who, book, entry, toBook) => transferEntry(who, book, entry, toBook, true),
        async placeInWorldOrder(who, book, entry, after) {
            const lib = await libOf(who.user);
            return lib.books.placeInWorldOrder(BigInt(book), BigInt(entry), after === null ? null : BigInt(after));
        },
        async applySortAsOrder(who, book, sort, numbering) {
            const lib = await libOf(who.user);
            return lib.books.applySortAsOrder(BigInt(book), sort, numbering, actorOf(who));
        },
        async duplicateEntry(who, book, entry, loopCheckLimit) {
            const lib = await libOf(who.user);
            const made = await lib.books.duplicateIn(BigInt(book), BigInt(entry), loopCheckLimit, actorOf(who));
            if (typeof made === 'string' || 'refused' in made) return made;
            return { entry: String(made.entry), unreachedLoops: made.unreachedLoops };
        },
    };
}
