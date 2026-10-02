/**
 * Sets tag_usage, the tags rows' usage_count, entity_counts and entity_tag_counts to what the store's write path keeps
 * them at, counted from the rows. For a test that writes character_tags, group_tags, characters or groups rows raw:
 * the store counts only the rows it writes itself.
 * @param {import('better-sqlite3').Database} db character-metadata.sqlite
 */
export function recountStoredCounters(db) {
    const filled = (/** @type {string} */ kind, /** @type {string} */ column) =>
        `EXISTS (SELECT 1 FROM entity_count_fill f WHERE f.kind = '${kind}' AND (f.done = 1 OR ${column} <= f.upto))`;
    db.transaction(() => {
        db.exec(`
            DELETE FROM tag_usage;
            INSERT INTO tag_usage (tag_id, count)
                SELECT tag_id, COUNT(*) FROM (SELECT tag_id FROM character_tags UNION ALL SELECT tag_id FROM group_tags) GROUP BY tag_id;
            UPDATE tags SET usage_count = (SELECT count FROM tag_usage WHERE tag_id = tags.id)
                WHERE id IN (SELECT tag_id FROM tag_usage) AND usage_count IS NOT (SELECT count FROM tag_usage WHERE tag_id = tags.id);
            DELETE FROM entity_counts;
            INSERT INTO entity_counts (kind, fav, count)
                SELECT 'character', fav, COUNT(*) FROM characters WHERE ${filled('character', 'id')} GROUP BY fav
                UNION ALL
                SELECT 'group', fav, COUNT(*) FROM groups WHERE ${filled('group', 'id')} GROUP BY fav;
            DELETE FROM entity_tag_counts;
            INSERT INTO entity_tag_counts (tag_id, kind, fav, count)
                SELECT t.tag_id, 'character', c.fav, COUNT(*) FROM character_tags t JOIN characters c ON c.id = t.character_id
                    WHERE ${filled('character', 'c.id')} GROUP BY t.tag_id, c.fav
                UNION ALL
                SELECT t.tag_id, 'group', g.fav, COUNT(*) FROM group_tags t JOIN groups g ON g.id = t.group_id
                    WHERE substr(t.group_id, -4) <> '.png' AND ${filled('group', 'g.id')} GROUP BY t.tag_id, g.fav;
        `);
    })();
}

/**
 * @param {string} tagTable
 * @returns {{ kind: 'character' | 'group', table: string, column: string }}
 */
function sideOf(tagTable) {
    if (tagTable === 'character_tags') return { kind: 'character', table: 'characters', column: 'character_id' };
    if (tagTable === 'group_tags') return { kind: 'group', table: 'groups', column: 'group_id' };
    throw new Error(`Not a tag table: ${tagTable}`);
}

/**
 * A tag row's counter change, as the store's write path makes it (insertTagRowSync() / deleteTagRowSync()).
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagTable
 * @param {string} entityId
 * @param {string} tagId
 * @param {1 | -1} sign
 */
function countTagRow(db, tagTable, entityId, tagId, sign) {
    const { kind, table } = sideOf(tagTable);
    if (sign > 0) db.prepare('INSERT INTO tag_usage (tag_id, count) VALUES (?, 1) ON CONFLICT (tag_id) DO UPDATE SET count = count + 1').run(tagId);
    else db.prepare('UPDATE tag_usage SET count = count - 1 WHERE tag_id = ?').run(tagId);
    db.prepare('UPDATE tags SET usage_count = COALESCE((SELECT count FROM tag_usage WHERE tag_id = ?), 0) WHERE id = ?').run(tagId, tagId);
    if (kind === 'group' && entityId.endsWith('.png')) return;
    if (!db.prepare('SELECT 1 FROM entity_count_fill WHERE kind = ? AND (done = 1 OR ? <= upto)').get(kind, entityId)) return;
    const entity = db.prepare(`SELECT fav FROM ${table} WHERE id = ?`).get(entityId);
    if (!entity) return;
    if (sign > 0) {
        db.prepare('INSERT INTO entity_tag_counts (tag_id, kind, fav, count) VALUES (?, ?, ?, 1) ON CONFLICT (tag_id, kind, fav) DO UPDATE SET count = count + 1').run(tagId, kind, entity.fav);
    } else {
        db.prepare('UPDATE entity_tag_counts SET count = count - 1 WHERE tag_id = ? AND kind = ? AND fav = ?').run(tagId, kind, entity.fav);
        db.prepare('DELETE FROM entity_tag_counts WHERE tag_id = ? AND kind = ? AND fav = ? AND count = 0').run(tagId, kind, entity.fav);
    }
}

/**
 * Inserts a tag row raw and counts it as the store would.
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagTable 'character_tags' or 'group_tags'.
 * @param {string} entityId
 * @param {string} tagId
 * @returns {boolean} Whether it was inserted.
 */
export function insertTagRowRaw(db, tagTable, entityId, tagId) {
    const { column } = sideOf(tagTable);
    if (db.prepare(`INSERT OR IGNORE INTO ${tagTable} (${column}, tag_id) VALUES (?, ?)`).run(entityId, tagId).changes === 0) return false;
    countTagRow(db, tagTable, entityId, tagId, 1);
    return true;
}

/**
 * Deletes a tag row raw and counts it out as the store would.
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagTable 'character_tags' or 'group_tags'.
 * @param {string} entityId
 * @param {string} tagId
 * @returns {boolean} Whether it was deleted.
 */
export function deleteTagRowRaw(db, tagTable, entityId, tagId) {
    const { column } = sideOf(tagTable);
    if (db.prepare(`DELETE FROM ${tagTable} WHERE ${column} = ? AND tag_id = ?`).run(entityId, tagId).changes === 0) return false;
    countTagRow(db, tagTable, entityId, tagId, -1);
    return true;
}

/**
 * A stand-in for a prepared `INSERT INTO <tagTable> (<entity column>, tag_id) VALUES (?, ?)`: `run(entityId, tagId)`
 * inserts the row with insertTagRowRaw().
 * @param {import('better-sqlite3').Database} db
 * @param {string} tagTable
 */
export function rawTagRowInserter(db, tagTable) {
    return { run: (/** @type {string} */ entityId, /** @type {string} */ tagId) => insertTagRowRaw(db, tagTable, entityId, tagId) };
}

/**
 * @param {'character' | 'group'} kind
 */
function entitySide(kind) {
    return kind === 'character'
        ? { table: 'characters', tagTable: 'character_tags', column: 'character_id' }
        : { table: 'groups', tagTable: 'group_tags', column: 'group_id' };
}

/**
 * An entity row's counter change with its tag rows, as the store's write path makes it (countEntityRowSync()).
 * @param {import('better-sqlite3').Database} db
 * @param {'character' | 'group'} kind
 * @param {string} id
 * @param {number} fav
 * @param {1 | -1} sign
 */
function countEntityRow(db, kind, id, fav, sign) {
    if (!db.prepare('SELECT 1 FROM entity_count_fill WHERE kind = ? AND (done = 1 OR ? <= upto)').get(kind, id)) return;
    const { tagTable, column } = entitySide(kind);
    const favValue = fav ? 1 : 0;
    const counters = [['INSERT INTO entity_counts (kind, fav, count) VALUES (?, ?, 1) ON CONFLICT (kind, fav) DO UPDATE SET count = count + 1',
        'UPDATE entity_counts SET count = count - 1 WHERE kind = ? AND fav = ?', 'DELETE FROM entity_counts WHERE kind = ? AND fav = ? AND count = 0', [kind, favValue]]];
    if (kind === 'character' || !id.endsWith('.png')) {
        for (const tagId of db.prepare(`SELECT tag_id FROM ${tagTable} WHERE ${column} = ?`).pluck().all(id)) {
            counters.push(['INSERT INTO entity_tag_counts (tag_id, kind, fav, count) VALUES (?, ?, ?, 1) ON CONFLICT (tag_id, kind, fav) DO UPDATE SET count = count + 1',
                'UPDATE entity_tag_counts SET count = count - 1 WHERE tag_id = ? AND kind = ? AND fav = ?',
                'DELETE FROM entity_tag_counts WHERE tag_id = ? AND kind = ? AND fav = ? AND count = 0', [tagId, kind, favValue]]);
        }
    }
    for (const [add, subtract, removeZero, params] of counters) {
        if (sign > 0) db.prepare(add).run(...params);
        else {
            db.prepare(subtract).run(...params);
            db.prepare(removeZero).run(...params);
        }
    }
}

/**
 * Runs `insert` (which inserts one entity row raw) and counts the row in, with any tag rows it already has.
 * @param {import('better-sqlite3').Database} db
 * @param {'character' | 'group'} kind
 * @param {string} id
 * @param {number} fav
 * @param {() => void} insert
 */
export function insertEntityRaw(db, kind, id, fav, insert) {
    insert();
    countEntityRow(db, kind, id, fav, 1);
}

/**
 * Deletes an entity row and then its tag rows raw, counted as the store's delete counts them.
 * @param {import('better-sqlite3').Database} db
 * @param {'character' | 'group'} kind
 * @param {string} id
 */
export function deleteEntityRaw(db, kind, id) {
    const { table, tagTable, column } = entitySide(kind);
    const stored = db.prepare(`SELECT fav FROM ${table} WHERE id = ?`).get(id);
    if (db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0 && stored) countEntityRow(db, kind, id, stored.fav, -1);
    for (const tagId of db.prepare(`SELECT tag_id FROM ${tagTable} WHERE ${column} = ?`).pluck().all(id)) deleteTagRowRaw(db, tagTable, id, tagId);
}

/**
 * Sets an entity row's fav raw, counted as the store's fav write counts it.
 * @param {import('better-sqlite3').Database} db
 * @param {'character' | 'group'} kind
 * @param {string} id
 * @param {number} fav
 */
export function setFavRaw(db, kind, id, fav) {
    const { table } = entitySide(kind);
    const stored = db.prepare(`SELECT fav FROM ${table} WHERE id = ?`).get(id);
    if (!stored || (stored.fav ? 1 : 0) === (fav ? 1 : 0)) return;
    db.prepare(`UPDATE ${table} SET fav = ? WHERE id = ?`).run(fav ? 1 : 0, id);
    countEntityRow(db, kind, id, stored.fav, -1);
    countEntityRow(db, kind, id, fav, 1);
}
