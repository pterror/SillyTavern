/**
 * The codes the library's records name entities and values by, shared by the library's modules.
 */

/** Entity types: a world book (or a name a lorebook link holds that no book has), a book a character or a world
 * book owns (a card's `character_book`, a book's `originalData`), a book's entry, an unowned tree (messages whose
 * character or group is gone, keyed by the old owner key: an avatar's stem or a group's id), a user's saved views
 * (src/saved-views.js): their list, a view, a view's condition and a view's range, and a user's settings
 * (src/settings-engine.js): their holder and its parts. */
export const TYPE = Object.freeze({
    character: 0, group: 1, tag: 2, book: 3, ownedBook: 4, entry: 5, tree: 6, viewList: 7, view: 8, condition: 9, range: 10,
    settings: 11, settingsPart: 12,
});

/** Field codes; the engine reads NAME, WORLD, FOLDER_TYPE and DEFINED itself. */
export const FIELD = Object.freeze({
    name: 1,
    creator: 2,
    character_version: 3,
    world: 4,
    create_date: 5,
    description: 10,
    personality: 11,
    scenario: 12,
    first_mes: 13,
    mes_example: 14,
    creator_notes: 15,
    system_prompt: 16,
    post_history_instructions: 17,
    nickname: 18,
    creation_date: 19,
    modification_date: 20,
    allow_global_styles: 30,
    folder_type: 40,
    /** A tag's definition marker (empty JSON): without it, the tag is a key only assignments name. */
    defined: 41,
});

/** A tag's keys other than its name and folder type are stored by key. */
export const TAG_KEY_PREFIX = 'tag:';

/**
 * The `metaValue` name of a file in `characters/` the conversion converted, whose value is `[size, mtimeMs]` as it
 * was then: `/metadata/rescan` doesn't import it again (the conversion leaves the old store's PNGs there).
 * @param {string} name The file's name in `characters/`.
 */
export const convertedFileKey = name => `converted.characters.${name}`;

/**
 * The `metaValue` name of the per-chat prompt itemization files (`<user>/itemized prompts/`) the conversion placed
 * none or not all of the entries of, each kept on disk as it is: a list of `{ file, reason, entries }`, `entries`
 * being how many of its entries weren't placed.
 */
export const KEPT_ITEMIZATION_FILES = 'itemized prompts.kept';

/**
 * The list code of a character's rename history: one item per entry (`renameItem()`), oldest first. A message sent
 * before an entry's `until` (ms) shows its `name`, the first such entry's, when the rename that ended it kept past
 * chats as they were. It is the store's, never the card's: card writes keep it, and cards are read without it.
 */
export const NAME_HISTORY = 3;

/**
 * A rename history entry as its list item's text: `until`, a space, then the name (which may hold spaces).
 * @param {{ until: number, name: string }} entry
 */
export const renameItem = entry => `${entry.until} ${entry.name}`;

/**
 * The rename history entries of their list items' texts.
 * @param {string[] | undefined} items
 * @returns {{ until: number, name: string }[]}
 */
export const renamesOf = items => (items ?? []).map(text => {
    const space = text.indexOf(' ');
    return { until: Number(text.slice(0, space)), name: text.slice(space + 1) };
});
