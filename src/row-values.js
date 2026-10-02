/**
 * Whether two values SQLite would store identically. Numbers and numeric strings compare by value (a column with
 * numeric affinity stores '5' as 5); Buffers by their bytes; everything else strictly.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function sameSqlValue(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
    if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    if (typeof a === 'bigint' || typeof b === 'bigint') return String(a) === String(b);
    if (typeof a === 'number' || typeof b === 'number') {
        const x = Number(a);
        const y = Number(b);
        return Number.isFinite(x) && Number.isFinite(y) && x === y && String(a).trim() !== '' && String(b).trim() !== '';
    }
    return false;
}

/**
 * The entries of `next` whose value differs from `current`'s.
 * @param {Record<string, any>} current A stored row, holding at least every key of `next`.
 * @param {Record<string, any>} next
 * @returns {Record<string, any>} Empty when nothing differs.
 */
export function changedValues(current, next) {
    /** @type {Record<string, any>} */
    const changed = {};
    for (const [column, value] of Object.entries(next)) {
        if (!sameSqlValue(current[column], value)) changed[column] = value;
    }
    return changed;
}

/**
 * Writes `values` to the row of `table` that `key` names, only the columns whose stored value differs; with
 * `insert`, adds the row when there is none. A write that would change nothing writes nothing. A caller that has
 * just read the row passes it as `current`, and it isn't read again.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} table
 * @param {Record<string, any>} key Primary-key columns and their values.
 * @param {Record<string, any>} values
 * @param {{ insert?: boolean, current?: Record<string, any> }} [options] `current`: the stored row, holding at least
 *   every column of `values` (one it lacks counts as changed).
 * @returns {boolean} Whether anything was written.
 */
export function writeRowIfChanged(db, table, key, values, { insert = false, current } = {}) {
    const keyColumns = Object.keys(key);
    const where = keyColumns.map(column => `${column} = @${column}`).join(' AND ');
    /** @type {Record<string, any>} */
    const keyParams = {};
    for (const column of keyColumns) keyParams[column] = key[column];
    const columns = Object.keys(values);
    const stored = current ?? /** @type {Record<string, any> | undefined} */ (db.get(
        `SELECT ${columns.length > 0 ? columns.join(', ') : '1 AS present'} FROM ${table} WHERE ${where}`, keyParams));
    if (!stored) {
        if (!insert) return false;
        const row = { ...key, ...values };
        const names = Object.keys(row);
        // An upsert, so a row another connection added since the read above still ends up holding these values.
        const onConflict = columns.length > 0
            ? `ON CONFLICT(${keyColumns.join(', ')}) DO UPDATE SET ${columns.map(c => `${c} = excluded.${c}`).join(', ')}`
            : `ON CONFLICT(${keyColumns.join(', ')}) DO NOTHING`;
        db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(n => `@${n}`).join(', ')}) ${onConflict}`, row);
        return true;
    }
    const changed = changedValues(stored, values);
    const changedColumns = Object.keys(changed);
    if (changedColumns.length === 0) return false;
    /** @type {Record<string, any>} */
    const params = { ...keyParams };
    for (const column of changedColumns) params[`v_${column}`] = changed[column];
    db.run(`UPDATE ${table} SET ${changedColumns.map(c => `${c} = @v_${c}`).join(', ')} WHERE ${where}`, params);
    return true;
}
