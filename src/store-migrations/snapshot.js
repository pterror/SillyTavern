import fs from 'node:fs';
import path from 'node:path';

/**
 * Snapshots of a user's store, taken with it closed before migrations run (docs/design/install-and-update.md,
 * "Snapshots"). The engine's files are its log (`log-*.blk`: only the newest is appended to) and its runs
 * (`runs/*.run`: written once, renamed into place, only ever removed), so a snapshot hard-links every file but the
 * newest log file, which it copies. A file the engine removes later stays in the snapshot.
 */

export const SNAPSHOTS_DIR = 'store-snapshots';
/** The run a stop cut short: the snapshot it took and the migrations it was running. */
const MARKER = 'migrating.json';
/** How many snapshots a user keeps. */
const KEEP = 2;

/**
 * @param {string} root The user's directory.
 */
function snapshotsOf(root) {
    return path.join(root, SNAPSHOTS_DIR);
}

/**
 * Links `from` to `to`, or copies it where a link isn't possible (another filesystem, no links there).
 * @param {string} from
 * @param {string} to
 */
function linkOrCopy(from, to) {
    try {
        fs.linkSync(from, to);
    } catch {
        fs.copyFileSync(from, to);
    }
}

/**
 * Every file of a store directory, relative to it.
 * @param {string} dir
 * @returns {string[]}
 */
function filesOf(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
        ? filesOf(path.join(dir, e.name)).map(f => path.join(e.name, f))
        : [e.name]);
}

/**
 * Copies a closed store directory's files into `to`: the newest log file copied, the rest linked.
 * @param {string} from
 * @param {string} to
 */
function cloneStore(from, to) {
    const files = filesOf(from);
    const newestLog = files.filter(f => /^log-[0-9a-f]+\.blk$/.test(f)).sort().at(-1);
    for (const f of files) {
        fs.mkdirSync(path.dirname(path.join(to, f)), { recursive: true });
        if (f === newestLog) fs.copyFileSync(path.join(from, f), path.join(to, f));
        else linkOrCopy(path.join(from, f), path.join(to, f));
    }
}

/**
 * Snapshots a user's closed store (`<root>/store`).
 * @param {string} root
 * @param {string[]} pending The migrations about to run.
 * @param {string} storeDir The store's directory name under `root`.
 * @returns {string} The snapshot's name.
 */
export function snapshotStore(root, pending, storeDir) {
    const now = new Date();
    const name = `${now.toISOString().replace(/[:.]/g, '-')}-before-${pending[0]}`;
    const dir = path.join(snapshotsOf(root), name);
    const partial = `${dir}.tmp`;
    fs.rmSync(partial, { recursive: true, force: true });
    cloneStore(path.join(root, storeDir), path.join(partial, storeDir));
    fs.writeFileSync(path.join(partial, 'snapshot.json'), JSON.stringify({ pending, time: now.getTime() }, null, 4));
    fs.renameSync(partial, dir);
    return name;
}

/**
 * Puts a snapshot back as the user's store, with the server stopped: the store there goes aside
 * (`<storeDir>.replaced-<time>`), never deleted.
 * @param {string} root
 * @param {string} name
 * @param {string} storeDir
 * @returns {string} Where the replaced store went.
 */
export function restoreStoreSnapshot(root, name, storeDir) {
    const from = path.join(snapshotsOf(root), name, storeDir);
    if (!fs.existsSync(from)) throw new Error(`no snapshot ${name} in ${snapshotsOf(root)}`);
    const aside = path.join(root, `${storeDir}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const current = path.join(root, storeDir);
    if (fs.existsSync(current)) fs.renameSync(current, aside);
    cloneStore(from, current);
    return aside;
}

/**
 * The run a stop cut short, or null.
 * @param {string} root
 * @returns {{ snapshot: string, pending: string[] } | null}
 */
export function readMarker(root) {
    const file = path.join(snapshotsOf(root), MARKER);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * @param {string} root
 * @param {{ snapshot: string, pending: string[] } | null} marker Null removes it.
 */
export function writeMarker(root, marker) {
    const file = path.join(snapshotsOf(root), MARKER);
    if (marker === null) {
        fs.rmSync(file, { force: true });
        return;
    }
    fs.mkdirSync(snapshotsOf(root), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker, null, 4));
    fs.renameSync(`${file}.tmp`, file);
}

/**
 * Removes all but the newest snapshots.
 * @param {string} root
 */
export function pruneSnapshots(root) {
    if (!fs.existsSync(snapshotsOf(root))) return;
    const names = fs.readdirSync(snapshotsOf(root), { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.endsWith('.tmp'))
        .map(e => e.name)
        .sort();
    for (const name of names.slice(0, -KEEP)) fs.rmSync(path.join(snapshotsOf(root), name), { recursive: true, force: true });
}
