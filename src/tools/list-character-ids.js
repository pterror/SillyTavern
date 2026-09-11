import { queryCharacters } from '../character-metadata-db.js';

/**
 * CLI helper for shell-based corpus workflows (character filenames are opaque UUIDs, not names) -
 * standalone so it doesn't need a running server or auth. Shares queryCharacters() with the server so
 * output can't drift from `/query`.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @returns {AsyncGenerator<{id: string, name: string}>} Ordered by id, stable across pages even if a
 * rename happens mid-listing.
 */
export async function* listCharacterIds(directories, options = {}) {
    const pageSize = options.pageSize ?? 2000;
    let offset = 0;

    while (true) {
        // No sortField: queryCharacters()'s implicit "ORDER BY ... id ASC" tie-break still applies,
        // giving the stable paging order this generator needs.
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
