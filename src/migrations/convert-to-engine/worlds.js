import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';

/**
 * The world books in a user's `worlds` folder, in every stored format: the stored one (`sidecar-v2`: a manifest naming
 * each entry's file in `<name>.entries/`), the one before it (`sidecar-v1`: entry uids, each in `<uid>.json`), and
 * upstream's World Info JSON (entries inline). A book is named by its file's stem, as `/api/worldinfo/list` names it.
 */

/**
 * @typedef {{ name: string, file: string, book: Record<string, unknown> } | { name: string, file: string, unread: string }} WorldBook
 */

/**
 * @param {string} worldsDir
 * @returns {Generator<WorldBook>}
 */
export function* worldBooks(worldsDir) {
    if (!fs.existsSync(worldsDir)) return;
    const files = fs.readdirSync(worldsDir, { withFileTypes: true })
        .filter(f => f.isFile() && path.extname(f.name).toLowerCase() === '.json')
        .map(f => f.name)
        .sort();
    for (const file of files) {
        const name = path.parse(file).name;
        const entriesDir = path.join(worldsDir, `${name}.entries`);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(worldsDir, file), 'utf8'));
        } catch (err) {
            yield { name, file, unread: `it can't be read: ${/** @type {Error} */ (err).message}` };
            continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            yield { name, file, unread: 'it isn\'t a JSON object' };
            continue;
        }
        if (parsed.format === 'sidecar-v2' && Array.isArray(parsed.entries)) {
            const { entries: named, ...rest } = parsed;
            delete rest.format;
            /** @type {Record<string, unknown>} */
            const entries = {};
            let problem = null;
            for (const item of named) {
                const file = item?.file;
                if (typeof file !== 'string' || !file.endsWith('.json') || sanitize(file) !== file) {
                    problem = `entry ${String(item?.uid)} names no usable file`;
                    break;
                }
                try {
                    entries[item.uid] = JSON.parse(fs.readFileSync(path.join(entriesDir, file), 'utf8'));
                } catch (err) {
                    problem = `entry ${String(item?.uid)} can't be read: ${/** @type {Error} */ (err).message}`;
                    break;
                }
            }
            if (problem) yield { name, file, unread: problem };
            else yield { name, file, book: { ...rest, entries } };
            continue;
        }
        if (parsed.format === 'sidecar-v1' && Array.isArray(parsed.entries)) {
            const { entries: uids, ...rest } = parsed;
            delete rest.format;
            /** @type {Record<string, unknown>} */
            const entries = {};
            let problem = null;
            for (const uid of uids) {
                const entryFile = `${String(uid)}.json`;
                if (path.basename(entryFile) !== entryFile) {
                    problem = `entry ${uid} has no usable file name`;
                    break;
                }
                try {
                    entries[uid] = JSON.parse(fs.readFileSync(path.join(entriesDir, entryFile), 'utf8'));
                } catch (err) {
                    problem = `entry ${uid} can't be read: ${/** @type {Error} */ (err).message}`;
                    break;
                }
            }
            if (problem) yield { name, file, unread: problem };
            else yield { name, file, book: { ...rest, entries } };
            continue;
        }
        if (!Object.hasOwn(parsed, 'entries')) {
            yield { name, file, unread: 'it has no entries' };
            continue;
        }
        yield { name, file, book: parsed };
    }
}
