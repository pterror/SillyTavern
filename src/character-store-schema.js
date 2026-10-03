/**
 * The `characters` table of the fields layout, and what every connection to a store in that layout needs. The card itself is in the card tables (character-card-reader.js), split by
 * character-card-storage.js.
 *
 * `name`, `creator`, `character_version`, `world` and `create_date_raw` hold the card's own values raw (NULL when the
 * card has none, or has a value of another type, which is in `card_extra`). `create_date` is that date as epoch ms,
 * the sort key. `version` is the seq of the `changes` row that last changed the row: a page caches a list row by
 * (id, version), and a seq is never handed out twice, so a character deleted and made again under the same id never
 * reads as unchanged.
 */

/** The SQL function the name sort folds names with: lower case, compatibility-decomposed, combining marks dropped. */
export const NAME_FOLD_FUNCTION = 'st_fold';

/** The name sort key, as every statement and index spells it (an expression index is used only by the same text). */
export const NAME_FOLD_SQL = `${NAME_FOLD_FUNCTION}(name)`;

/**
 * NFKD-normalizes and strips combining marks so "É"/"e" sort and prefix-match the same as "é"/"e".
 * @param {unknown} name
 * @returns {string}
 */
export function foldName(name) {
    return String(name ?? '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '');
}

/**
 * Registers the functions the store's indexes and triggers call. Every connection that writes `characters` needs
 * them, or the write fails.
 * @param {{ defineFunction: (name: string, fn: (...args: any[]) => any) => void }} db
 */
export function defineCharacterStoreFunctions(db) {
    db.defineFunction(NAME_FOLD_FUNCTION, value => foldName(value));
}

export const FIELDS_CHARACTERS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS characters (
        id                    TEXT PRIMARY KEY,
        name                  TEXT,
        fav                   INTEGER NOT NULL,
        date_added            INTEGER NOT NULL,
        create_date           INTEGER,
        create_date_raw,
        date_last_chat        INTEGER NOT NULL,
        chat_size             INTEGER NOT NULL,
        data_size             INTEGER NOT NULL,
        world                 TEXT,
        creator               TEXT,
        character_version     TEXT,
        active_chat           TEXT,
        allow_global_styles   INTEGER,
        version               INTEGER NOT NULL,
        content_hash          TEXT,
        content_identity_hash TEXT,
        avatar_identity_hash  TEXT,
        import_poisoned       INTEGER NOT NULL DEFAULT 1
    );
`;

/** The sort keys /query orders characters by, as SQL over the row, each with a `(fav, key, id)` index. */
export const CHARACTER_SORT_KEYS = Object.freeze([
    { column: 'name_fold', sql: NAME_FOLD_SQL },
    { column: 'date_added', sql: 'date_added' },
    { column: 'date_last_chat', sql: 'date_last_chat' },
    { column: 'create_date', sql: 'create_date' },
    { column: 'data_size', sql: 'data_size' },
    { column: 'chat_size', sql: 'chat_size' },
]);

/** Every index on the fields layout's `characters`: the sort indexes, the world filter and the import dedup lookups. */
export const FIELDS_CHARACTER_INDEXES = Object.freeze([
    ...CHARACTER_SORT_KEYS.map(({ column, sql }) => ({
        name: `idx_characters_sort_fav_${column}_asc`,
        sql: `CREATE INDEX IF NOT EXISTS idx_characters_sort_fav_${column}_asc ON characters(fav, ${sql} ASC, id ASC)`,
    })),
    { name: 'idx_characters_world', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_world ON characters(world)' },
    { name: 'idx_characters_content_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_content_hash ON characters(content_hash)' },
    { name: 'idx_characters_content_identity_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_content_identity_hash ON characters(content_identity_hash)' },
    { name: 'idx_characters_avatar_identity_hash', sql: 'CREATE INDEX IF NOT EXISTS idx_characters_avatar_identity_hash ON characters(avatar_identity_hash)' },
]);

/**
 * The derived tables a store builds when they are first needed rather than at the conversion, and the meta
 * keys that say how far they are built. The conversion writes neither, so the passes that build them start over.
 * `random_ranks` is kept for the whole list and each fav value: the default random view reads them at once.
 */
export const BUILT_ON_NEED = Object.freeze({
    tables: Object.freeze(['character_tag_sort', 'group_tag_sort']),
    metaKeys: Object.freeze(['tag_sort_tables_filled', 'random_ranks_filled']),
    metaKeyPrefixes: Object.freeze(['tag_sort_fill_upto_', 'random_ranks_fill_upto_']),
    randomSpacesKept: Object.freeze(['a', 'f0', 'f1']),
});

/**
 * @param {string} key
 * @returns {boolean} Whether a meta row under `key` describes a structure built on need.
 */
export function isBuiltOnNeedMetaKey(key) {
    return BUILT_ON_NEED.metaKeys.includes(key) || BUILT_ON_NEED.metaKeyPrefixes.some(prefix => key.startsWith(prefix));
}
