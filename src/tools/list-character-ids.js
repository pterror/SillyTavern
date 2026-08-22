import { queryCharacters } from '../character-metadata-db.js';

/**
 * Name -> id listing tool (design doc §2.2/§9 phase 4d): once filenames are opaque UUIDv7s instead of the
 * display name, shell-based corpus workflows ("find the character named X, then act on its file") stop working
 * by grepping filenames directly. This is the "look it up, then act" mitigation the doc calls for - a small,
 * scriptable way to answer "what id does this name have" (or the reverse) without hand-writing SQL against
 * character-metadata.sqlite.
 *
 * Built as a standalone CLI rather than an HTTP endpoint: every other admin-ish surface this codebase already
 * has (`/metadata/rescan`, `/search-index/rebuild`, the batch-import pair) exists to be called FROM the running
 * server's own request/response cycle, by something that already holds a session. This tool's whole reason to
 * exist is the opposite case: a human at a shell prompt, composing it with `grep`/`jq`/`xargs` against a corpus
 * the server may not even be running against at the time (the same "shell-based corpus management" scenario
 * phase 4d's own migration script is written for) - that doesn't need auth, a running HTTP server, or a
 * request/response round trip, and forcing one on it would make the exact workflow it exists for slower, not
 * safer. It shares character-metadata-db.js's queryCharacters() with the real server, so its output can never
 * drift from what `/query` would say.
 *
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {number} [options.pageSize] Rows fetched per queryCharacters() call - purely a batching knob, does not
 * affect output.
 * @returns {AsyncGenerator<{id: string, name: string}>} Every character, ordered by id (stable across pages -
 * see queryCharacters()' own "id ASC" tie-break comment) - not by name, so a rename between two calls of this
 * generator can't produce a duplicate-or-skipped row the way paging by a mutable sort key could.
 */
export async function* listCharacterIds(directories, options = {}) {
    const pageSize = options.pageSize ?? 2000;
    let offset = 0;

    while (true) {
        // No sortField: queryCharacters() has no queryable "id" column (QUERYABLE_SORT_COLUMNS doesn't include
        // one - id ordering isn't a feature `/query` exposes), but its own always-present final tie-break
        // ("ORDER BY ... id ASC") still applies with no primary sort key requested, which is exactly the stable
        // id order this generator needs to page through without gaps/duplicates if a rename happens mid-listing.
        const result = await queryCharacters(directories, {
            offset,
            limit: pageSize,
            wantRows: true,
            wantTotal: false,
        });
        if (result === null) {
            throw new Error('Character metadata store is unavailable on this install.');
        }
        const rows = result.rows ?? [];
        for (const row of rows) {
            yield { id: row.avatar, name: row.name };
        }
        if (rows.length < pageSize) return;
        offset += pageSize;
    }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const { initConfig } = await import('../config-init.js');
    const { getUserDirectories } = await import('../users.js');

    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };
    const hasFlag = (name) => args.includes(`--${name}`);

    const dataRoot = getArg('data-root', './data');
    const handle = getArg('handle', 'default-user');
    const configPath = getArg('config', './config.yaml');
    const asJson = hasFlag('json');
    const filterName = getArg('grep', null);

    globalThis.DATA_ROOT = dataRoot;
    initConfig(configPath);

    const directories = getUserDirectories(handle);
    const nameFilter = filterName ? new RegExp(filterName, 'i') : null;

    const matches = [];
    for await (const { id, name } of listCharacterIds(directories)) {
        if (nameFilter && !nameFilter.test(name)) continue;
        if (asJson) {
            matches.push({ id, name });
        } else {
            console.log(`${id}\t${name}`);
        }
    }
    if (asJson) {
        console.log(JSON.stringify(matches, null, 2));
    }
}
