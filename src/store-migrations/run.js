import fs from 'node:fs';
import path from 'node:path';

import { STORE_DIR, closeUserStore, gateUserStore, migratingStore } from '../user-stores.js';
import { MIGRATIONS, doneRecords, pendingMigrations, stateKey } from './registry.js';
import { pruneSnapshots, readMarker, snapshotStore, writeMarker } from './snapshot.js';

/**
 * Runs each user's pending migrations at start (docs/design/install-and-update.md, "Data migrations, run by the
 * server"), and keeps the user's routes answering their progress until they're done.
 *
 * @typedef {{ state: 'checking' } | { state: 'running', id: string, description: string, done: number, total: number }
 *   | { state: 'failed', id: string, description: string, error: string } | { state: 'done' }} MigrationState
 */

const LOG_PREFIX = '[migrations]';

/** @type {Map<string, MigrationState>} By the user's root directory. */
const states = new Map();

/**
 * @param {{ root: string }} directories
 * @returns {MigrationState}
 */
export function migrationStateOf(directories) {
    return states.get(path.resolve(directories.root)) ?? { state: 'done' };
}

/**
 * Starts every user's migrations, not awaited: `userStore()` for a user waits for that user's, and the user's routes
 * answer the progress meanwhile (`migrationGateMiddleware`).
 * @param {import('../users.js').UserDirectoryList[]} directoriesList
 * @param {readonly import('./registry.js').Migration[]} [migrations] The registered ones; tests give their own.
 * @returns {Promise<void>[]} Each user's run (for tests); a failed one is logged and its user's state says why.
 */
export function startStoreMigrations(directoriesList, migrations = MIGRATIONS) {
    return directoriesList.map(directories => {
        const key = path.resolve(directories.root);
        states.set(key, { state: 'checking' });
        const run = migrateUser(directories, state => states.set(key, state), migrations);
        gateUserStore(directories, run);
        return run.then(() => {
            states.set(key, { state: 'done' });
        }, () => {});
    });
}

/**
 * A user's pending migrations, run in order: the store snapshotted first (once per run, kept when a stop cuts it
 * short), each recorded done as it ends.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(state: MigrationState) => void} report
 * @param {readonly import('./registry.js').Migration[]} [migrations]
 */
export async function migrateUser(directories, report, migrations = MIGRATIONS) {
    const root = directories.root;
    const handle = path.basename(root);
    // No store yet: the one made later is made with every migration done.
    if (!fs.existsSync(path.join(root, STORE_DIR))) return;
    let store = await migratingStore(directories, handle);
    const pending = await pendingMigrations(store.lib.store, migrations);
    if (pending.length === 0) return;
    if (!readMarker(root)) {
        await closeUserStore(directories);
        const snapshot = snapshotStore(root, pending.map(m => m.id), STORE_DIR);
        writeMarker(root, { snapshot, pending: pending.map(m => m.id) });
        console.log(`${LOG_PREFIX} ${handle}: store snapshotted as ${snapshot} before ${pending.map(m => m.id).join(', ')}`);
        store = await migratingStore(directories, handle);
    }
    for (const migration of pending) {
        const { id, description } = migration;
        report({ state: 'running', id, description, done: 0, total: 0 });
        console.log(`${LOG_PREFIX} ${handle}: ${id}: ${description}`);
        try {
            const [saved] = await store.lib.store.meta([stateKey(id)]);
            const { run } = await migration.load();
            await run({
                store,
                directories,
                handle,
                // As its metaValue record holds it: JSON text.
                saved: saved == null ? null : JSON.parse(saved),
                save: async state => {
                    await store.lib.store.commit([{ kind: 'metaValue', key: stateKey(id), json: JSON.stringify(state) }]);
                },
                progress: (done, total) => report({ state: 'running', id, description, done, total }),
                log: line => console.log(`${LOG_PREFIX} ${handle}: ${id}: ${line}`),
            });
            await store.lib.store.commit([...doneRecords([id]), { kind: 'metaValue', key: stateKey(id), json: 'null' }]);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            report({ state: 'failed', id, description, error });
            console.error(`${LOG_PREFIX} ${handle}: ${id} failed, this user's data isn't served until it runs; the store before it is in store-snapshots/${readMarker(root)?.snapshot}:`, err);
            throw err;
        }
    }
    writeMarker(root, null);
    pruneSnapshots(root);
    console.log(`${LOG_PREFIX} ${handle}: done`);
}

/** The page shown while a user's data is migrated: polls the status, reloads when done. */
const PROGRESS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Updating your data</title>
<style>
:root { color-scheme: light dark; --bg: #f6f6f4; --fg: #222; --muted: #666; --bar: #4a7; --error: #b33; }
@media (prefers-color-scheme: dark) { :root { --bg: #1b1b1d; --fg: #ddd; --muted: #999; --bar: #5b8; --error: #e66; } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { width: min(32rem, calc(100vw - 32px)); }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
p { margin: .25rem 0; color: var(--muted); }
progress { width: 100%; height: .5rem; accent-color: var(--bar); }
.error { color: var(--error); white-space: pre-wrap; }
</style>
</head>
<body>
<main>
<h1 id="title">Updating your data</h1>
<p id="what">Checking what needs updating…</p>
<progress id="bar"></progress>
<p id="detail"></p>
</main>
<script>
const show = (s) => {
    const what = document.getElementById('what');
    const bar = document.getElementById('bar');
    const detail = document.getElementById('detail');
    if (s.state === 'done') { location.reload(); return false; }
    if (s.state === 'failed') {
        document.getElementById('title').textContent = 'Updating your data failed';
        what.textContent = s.description + ' (' + s.id + ')';
        detail.className = 'error';
        detail.textContent = s.error + '\\n\\nYour data from before the update is kept. The server log has the details; the next start tries again.';
        bar.hidden = true;
        return false;
    }
    if (s.state === 'running') {
        what.textContent = s.description;
        if (s.total > 0) { bar.max = s.total; bar.value = s.done; detail.textContent = s.done + ' of ' + s.total; }
        else { bar.removeAttribute('value'); detail.textContent = ''; }
    }
    return true;
};
const poll = async () => {
    try {
        const response = await fetch('/api/migrations/status', { cache: 'no-store' });
        if (response.ok && !show(await response.json())) return;
    } catch { /* the server restarting: try again */ }
    setTimeout(poll, 1000);
};
poll();
</script>
</body>
</html>`;

/**
 * For a user whose migrations aren't done: `/api/migrations/status` answers their state, any other `/api/` 503 with
 * it, and a page load the progress page; other files (scripts, styles, images) are served as usual. Requests with no
 * user (the login page) go on.
 * @type {import('express').RequestHandler}
 */
export function migrationGateMiddleware(request, response, next) {
    const directories = /** @type {any} */ (request).user?.directories;
    const state = directories ? migrationStateOf(directories) : { state: 'done' };
    if (request.path === '/api/migrations/status' && request.method === 'GET') return response.send(state);
    if (state.state === 'done') return next();
    if (request.path.startsWith('/api/')) return response.status(503).send({ error: true, reason: 'migrating', migration: state });
    // A page load: the browser asks for HTML first (a script, style or image asks for its own kind, or anything).
    const page = request.method === 'GET' && (request.path === '/' || request.path.endsWith('.html') || /^text\/html/.test(request.get('accept') ?? ''));
    if (page) return response.status(503).set('Retry-After', '2').type('html').send(PROGRESS_PAGE);
    return next();
}
