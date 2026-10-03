import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { openNativeDatabase } from '../endpoints/sqlite-engine.js';
import { createMessageStatsTableSync, restartMessageStatsFillSync } from '../message-stats.js';
import { setTreeMetaSync } from '../message-tree-meta.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Brings one user's message-tree.sqlite to the current message stats layout. A one-off: run once on the existing
 * data with the server stopped, then deleted.
 *
 * 1. Drops the four triggers that kept the stats counters before the write path did (they would count every write a
 *    second time).
 * 2. A store whose `message_stats_version` isn't the current one gets its counters table dropped and created again,
 *    and every owner recounted by the server's message stats fill on its next start.
 *
 * Dry run (read-only open, writes nothing, may run while the server is running):
 *   node src/migrations/upgrade-message-stats.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * Real run (the server must be stopped):
 *   node src/migrations/upgrade-message-stats.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[upgrade-message-stats]';

export const OLD_TRIGGERS = Object.freeze(['message_stats_insert', 'message_stats_delete', 'message_stats_content', 'message_stats_move']);
export const VERSION_KEY = 'message_stats_version';
export const CURRENT_VERSION = '1';

/**
 * What the real run would change.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {{ triggers: string[], version: string | null, rebuild: boolean }} triggers: the old triggers present.
 */
export function planUpgrade(db) {
    const triggers = OLD_TRIGGERS.filter(name => db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'trigger\' AND name = ?', [name]));
    const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = ?', [VERSION_KEY]));
    const version = row?.value ?? null;
    return { triggers, version, rebuild: version !== CURRENT_VERSION };
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} options.serverStopped
 * @param {any} options.Database better-sqlite3 constructor, or null when the native binding isn't usable.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} Process exit code: 0 done (or nothing to do), 1 refused.
 */
export async function runUpgrade(options) {
    const { dataRoot, handle, apply, serverStopped, Database } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const treePath = path.join(dataRoot, handle, 'message-tree.sqlite');

    log(`${LOG_PREFIX} ${apply ? 'real run' : 'dry run'} for ${treePath}`);
    if (!Database) {
        warn(`${LOG_PREFIX} REFUSED: native better-sqlite3 is not available; this script never opens these databases with the wasm engine`);
        return 1;
    }
    if (apply) {
        if (!serverStopped) {
            warn(`${LOG_PREFIX} REFUSED: the real run needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
            return 1;
        }
        const probe = await probeServer();
        probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
        if (probe.running) {
            warn(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
            return 1;
        }
    }
    if (!fs.existsSync(treePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${treePath} does not exist`);
        return 1;
    }

    const db = openNativeDatabase(Database, treePath, { readonly: !apply });
    try {
        const plan = planUpgrade(db);
        const verb = apply ? 'dropping' : 'would drop';
        log(`${LOG_PREFIX} old stats triggers: ${plan.triggers.length > 0 ? `${verb} ${plan.triggers.join(', ')}` : 'none'}`);
        log(`${LOG_PREFIX} stats version: ${plan.version ?? 'none'}; ${plan.rebuild ? `${apply ? 'rebuilding' : 'would rebuild'} the counters table, recounted by the server's next start` : 'current'}`);
        if (!apply) {
            log(`${LOG_PREFIX} dry run: nothing was written.`);
            return 0;
        }
        if (plan.triggers.length === 0 && !plan.rebuild) {
            log(`${LOG_PREFIX} nothing to change; nothing was written.`);
            return 0;
        }
        db.transaction(() => {
            for (const name of planUpgrade(db).triggers) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
            if (planUpgrade(db).rebuild) {
                db.exec('DROP TABLE IF EXISTS owner_message_stats');
                restartMessageStatsFillSync(db);
                createMessageStatsTableSync(db);
                setTreeMetaSync(db, VERSION_KEY, CURRENT_VERSION);
            }
        });
        log(`${LOG_PREFIX} done.`);
        return 0;
    } finally {
        db.close();
    }
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, dryRun: boolean, apply: boolean, serverStopped: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, serverStopped: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if (arg === '--server-stopped') out.serverStopped = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[{ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg]] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

/**
 * @param {string[]} argv
 * @param {object} deps
 * @param {any} deps.Database
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [deps.probeServer]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        warn(`${LOG_PREFIX} usage: --dry-run | --apply --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        if (args.unknown.length > 0) warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        return 2;
    }
    return runUpgrade({ ...deps, dataRoot: args.dataRoot, handle: args.handle, apply: args.apply, serverStopped: args.serverStopped });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
    const Database = await getBetterSqlite3();
    process.exitCode = await main(process.argv.slice(2), { Database });
}
