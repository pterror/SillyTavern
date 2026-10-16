import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * Moves one user's saved views from `<user>/character-metadata.sqlite` (table `saved_views`) into the user's store,
 * in their order, each under its own id, then drops the `saved_views` table. A one-off: run once with the server
 * stopped, then deleted with its test (and `better-sqlite3`, when nothing else needs it).
 *
 *   node src/migrations/convert-saved-views-to-engine.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/convert-saved-views-to-engine.js --apply [the same]
 *
 * Both refuse while the configured port can't be bound. Before writing, it stops (listing the ids) when a view's
 * JSON doesn't parse, when the store holds a view under the same id with other content, or when it holds a view
 * that isn't in the table; views already there and equal are kept. Each view's dropped `updated_at`, and each part
 * of a view that doesn't fit a view's shape (left out), is listed. After writing, every view is read back and
 * compared with the table; the table is dropped only when all are equal. The dry run writes nothing.
 */

const LOG_PREFIX = '[convert-saved-views-to-engine]';
const FILE = 'character-metadata.sqlite';
const TABLE = 'saved_views';
/** Views per commit, and rows per read of the table. */
const BATCH = 100;

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<string>} 'free', 'in-use', 'unavailable' (no such address here), or the error.
 */
function probeBind(host, port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', err => {
            const code = /** @type {any} */ (err).code;
            if (code === 'EADDRINUSE') resolve('in-use');
            else if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') resolve('unavailable');
            else resolve(`error ${code ?? err.message}`);
        });
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve('free')));
    });
}

/**
 * Binds the configured port on the addresses the server listens on.
 * @returns {Promise<{ running: boolean, lines: string[] }>} `running` unless each address is free or not on this machine.
 */
export async function probeConfiguredServer() {
    const port = getConfigValue('port', 8000, 'number');
    const listen = getConfigValue('listen', false, 'boolean');
    const v4 = String(getConfigValue('listenAddress.ipv4', '0.0.0.0'));
    const v6 = String(getConfigValue('listenAddress.ipv6', '[::]')).replace(/^\[|\]$/g, '');
    const hosts = [
        listen ? (net.isIPv4(v4) ? v4 : '0.0.0.0') : '127.0.0.1',
        listen ? (net.isIPv6(v6) ? v6 : '::') : '::1',
    ];
    const lines = [];
    let running = false;
    for (const host of hosts) {
        const result = await probeBind(host, port);
        lines.push(`port probe ${host.includes(':') ? `[${host}]` : host}:${port}: ${result}`);
        if (result !== 'free' && result !== 'unavailable') running = true;
    }
    return { running, lines };
}

/**
 * @typedef {{ id: string, name: string, view_json: string, position: number, updated_at: number }} Row
 */

/**
 * The table's rows in order, BATCH at a time, each batch read with no statement left open.
 * @param {any} db
 * @returns {Generator<Row[]>}
 */
function* batches(db) {
    const first = db.prepare(`SELECT id, name, view_json, position, updated_at FROM ${TABLE} ORDER BY position, id LIMIT ${BATCH}`);
    const next = db.prepare(`SELECT id, name, view_json, position, updated_at FROM ${TABLE} WHERE position > @p OR (position = @p AND id > @id) ORDER BY position, id LIMIT ${BATCH}`);
    /** @type {Row | null} */
    let last = null;
    for (;;) {
        /** @type {Row[]} */
        const rows = [];
        for (const row of (last ? next.iterate({ p: last.position, id: last.id }) : first.iterate())) rows.push(row);
        if (rows.length === 0) return;
        yield rows;
        if (rows.length < BATCH) return;
        last = rows[rows.length - 1];
    }
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {() => Promise<any>} options.engine Loads the engine binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} The exit code: 0 done (or nothing to do), 1 refused, stopped or failed.
 */
export async function runConvert(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    // Its imports read config when they load: after the config path is set.
    const { STORE_DIR } = await import('../user-stores.js');
    const { LibraryEngine } = await import('../library-engine.js');
    const { TYPE } = await import('../library-codes.js');
    const { POSITION_GAP } = await import('../entity-values.js');
    const views = await import('../saved-views.js');
    const { canonicalStringify } = await import('../../public/scripts/hash-utils.js');
    const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');

    const root = path.join(options.dataRoot, options.handle);
    const file = path.join(root, FILE);
    const storeDir = path.join(root, STORE_DIR);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!fs.existsSync(storeDir)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${storeDir} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    log(`${LOG_PREFIX} (a server started with a --port override isn't seen by the probe: make sure none runs)`);
    if (!fs.existsSync(file)) {
        log(`${LOG_PREFIX} no ${FILE}: nothing to do`);
        return 0;
    }

    const Database = await getBetterSqlite3();
    // A read-only open of a WAL database makes its -wal and -shm files: those it made are removed after.
    const sidecars = ['-wal', '-shm'].map(x => file + x).filter(f => !fs.existsSync(f));
    const db = new Database(file, { readonly: true, fileMustExist: true });
    /** @type {any} */
    let lib = null;
    try {
        if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(TABLE)) {
            log(`${LOG_PREFIX} ${FILE} has no ${TABLE} table: nothing to do`);
            return 0;
        }
        lib = await LibraryEngine.open(await options.engine(), storeDir);
        await lib.store.ready();

        /**
         * A row as it is written: its canonical name and view, and what of it doesn't fit.
         * @param {Row} row
         */
        const sourceOf = row => {
            const parsed = JSON.parse(row.view_json);
            const { view, problems } = views.canonicalView(parsed);
            return { name: row.name, view, problems, parsed };
        };
        /** @param {{ name: string, view: object }} v */
        const same = v => canonicalStringify({ name: v.name, view: v.view });

        // ---- checks, before anything is written ----
        let rows = 0;
        let present = 0;
        /** @type {string[]} */
        const unparsed = [];
        /** @type {string[]} */
        const conflicts = [];
        for (const batch of batches(db)) {
            /** @type {{ row: Row, source: ReturnType<typeof sourceOf> }[]} */
            const sources = [];
            for (const row of batch) {
                rows++;
                warnLine(`${LOG_PREFIX} dropped updated_at: view ${row.id} "${row.name}": ${row.updated_at}`);
                let source;
                try {
                    source = sourceOf(row);
                } catch {
                    unparsed.push(row.id);
                    continue;
                }
                for (const p of source.problems) {
                    const m = /^conditions\[(\d+)\]/.exec(p);
                    const raw = m ? ` ${JSON.stringify(source.parsed.conditions[Number(m[1])])}` : '';
                    warnLine(`${LOG_PREFIX} left out of view ${row.id} "${row.name}": ${p}${raw}`);
                }
                sources.push({ row, source });
            }
            const ids = await lib.ids(TYPE.view, sources.map(s => s.row.id));
            const stored = await views.storedViews(lib, ids.filter(id => id !== null));
            const byKey = new Map(stored.filter(s => s !== null).map(s => [s.key, s]));
            for (const { row, source } of sources) {
                const s = byKey.get(row.id);
                if (!s) continue;
                if (same(views.assembleView(s)) === same(source)) {
                    present++;
                } else {
                    conflicts.push(row.id);
                }
            }
        }
        // A view the store holds that isn't in the table.
        /** @type {string[]} */
        const foreign = [];
        const holder = await views.viewHolder(lib);
        if (holder !== null) {
            const inTable = db.prepare(`SELECT 1 FROM ${TABLE} WHERE id = ?`);
            let after = null;
            for (;;) {
                const page = await views.viewPlaces(lib, holder, { after, limit: BATCH });
                const keys = await lib.store.libraryKeys(page.entries.map(e => e.id));
                for (const k of keys) if (k && !inTable.get(k.key)) foreign.push(k.key);
                if (!page.more || page.entries.length === 0) break;
                after = page.entries[page.entries.length - 1].position;
            }
        }
        log(`${LOG_PREFIX} views in ${TABLE}: ${rows}; already in the store and equal: ${present}`);
        if (unparsed.length || conflicts.length || foreign.length) {
            if (unparsed.length) warnLine(`${LOG_PREFIX} STOPPED: these views' JSON doesn't parse: ${unparsed.join(', ')}`);
            if (conflicts.length) warnLine(`${LOG_PREFIX} STOPPED: the store holds these views with other content: ${conflicts.join(', ')}`);
            if (foreign.length) warnLine(`${LOG_PREFIX} STOPPED: the store holds these views that aren't in ${TABLE}: ${foreign.join(', ')}`);
            log(`${LOG_PREFIX} nothing was written`);
            return 1;
        }
        if (!options.apply) {
            log(`${LOG_PREFIX} views the apply would write: ${rows - present}`);
            log(`${LOG_PREFIX} dry run done; nothing was written`);
            return 0;
        }

        // ---- writes: each view in order, BATCH to a commit ----
        let written = 0;
        let index = 0;
        let list = holder;
        for (const batch of batches(db)) {
            const records = [];
            // Those already there were found equal above.
            const there = await lib.ids(TYPE.view, batch.map(row => row.id));
            for (const [i, row] of batch.entries()) {
                const position = POSITION_GAP * ++index;
                if (there[i] !== null) continue;
                const source = sourceOf(row);
                const made = views.createRecords(lib, { holder: list, key: row.id, name: source.name, view: source.view, position });
                list = made.holder;
                for (const r of made.records) records.push(r);
                written++;
            }
            if (records.length > 0) await lib.store.commit(records);
        }
        log(`${LOG_PREFIX} views written: ${written}`);

        // ---- read back: count, order, name and view ----
        /** @type {string[]} */
        const mismatches = [];
        let read = 0;
        let after = null;
        let more = list !== null;
        /** @type {{ key: string, name: string, view: object }[]} */
        let back = [];
        const nextBack = async () => {
            if (back.length === 0 && more && list !== null) {
                const page = await views.viewPlaces(lib, list, { after, limit: BATCH });
                const stored = await views.storedViews(lib, page.entries.map(e => e.id));
                back = stored.map(s => (s ? { key: s.key, ...views.assembleView(s) } : { key: '?', name: '', view: {} }));
                more = page.more && page.entries.length > 0;
                if (page.entries.length) after = page.entries[page.entries.length - 1].position;
            }
            return back.shift() ?? null;
        };
        for (const batch of batches(db)) {
            for (const row of batch) {
                const got = await nextBack();
                read++;
                if (!got) {
                    mismatches.push(`${row.id}: not read back (the store has fewer views)`);
                    continue;
                }
                if (got.key !== row.id) mismatches.push(`${row.id}: read back ${got.key} in its place`);
                else if (same(got) !== same(sourceOf(row))) mismatches.push(`${row.id}: reads back differently`);
            }
        }
        for (let extra = await nextBack(); extra; extra = await nextBack()) mismatches.push(`${extra.key}: in the store, not in ${TABLE}`);
        if (mismatches.length) {
            for (const m of mismatches) warnLine(`${LOG_PREFIX} MISMATCH: ${m}`);
            warnLine(`${LOG_PREFIX} FAILED: ${mismatches.length} views don't read back as ${TABLE} holds them; ${TABLE} is kept`);
            return 1;
        }
        log(`${LOG_PREFIX} read back: ${read} views, all equal`);
    } finally {
        db.close();
        for (const f of sidecars) fs.rmSync(f, { force: true });
        if (lib) await lib.close();
    }

    const rw = new Database(file, { fileMustExist: true });
    try {
        rw.exec(`DROP TABLE ${TABLE}`);
    } finally {
        rw.close();
    }
    log(`${LOG_PREFIX} dropped ${TABLE} from ${FILE}; done`);
    return 0;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[/** @type {'dataRoot' | 'handle' | 'config'} */ ({ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg])] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        process.exitCode = await runConvert({
            ...args,
            engine: async () => {
                // The server builds the engine for this checkout when it starts; the server is stopped here.
                const { ensureEngine } = await import('../../engine/fetch.js');
                await ensureEngine();
                const { loadEngine } = await import('../../engine/load.js');
                return loadEngine().binding;
            },
        });
    }
}
